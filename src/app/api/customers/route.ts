import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";
import { requirePermission } from "../../../lib/authz";
import { checkDeletePermission } from "../../../lib/deletePermissions";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { logDeleteAuditDetails } from "../../../lib/mutationAudit";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../lib/gridFilters";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";
import { normalizeId } from '../../../lib/normalize';
import { BATCH_DELETE_SIZE } from '../../../lib/constants';
import { sqlBracketId, sqlSortDirection } from '../../../lib/sqlIdentifier';

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | number | boolean | null>;
};

type CustomerRow = {
  CustomerID: number | null;
  CustomerName: string | null;
  BrandName: string | null;
  TaxID: string | null;
  IsParent: boolean | number | null;
  ParentCustomer: string | null;
  PricingPolicy: string | null;
  CustomerGroup: string | null;
  Importance: string | null;
  Country: string | null;
  City: string | null;
  Enabled: boolean | number | null;
};

type CustomerRowWithCount = CustomerRow & { __totalCount: number | bigint | null };

const collectCustomerIds = (values: unknown): number[] => {
  if (!Array.isArray(values)) return [];
  const normalized = new Set<number>();
  values.forEach((value) => {
    const id = normalizeId(value);
    if (id != null) normalized.add(id);
  });
  return Array.from(normalized);
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  CustomerID: "dbo.Customers.ID",
  CustomerName: "dbo.Customers.Name",
  BrandName: "dbo.Customers.BrandName",
  TaxID: "dbo.Customers.TaxID",
  IsParent: "dbo.Customers.IsParent",
  ParentCustomer: "parentCustomer.Name",
  PricingPolicy: "dbo.PricingPolicies.Name",
  CustomerGroup: "customerGroup.Name",
  Importance: "dbo.Customers.Importance",
  Country: "country.Name",
  City: "dbo.Customers.City",
  Enabled: "dbo.Customers.Enabled",
};

const ALLOWED_ROW_GROUP_FIELDS = new Set(["IsParent", "PricingPolicy", "ParentCustomer", "CustomerGroup", "Importance"]);
const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? sqlBracketId(col);

    // Use centralized filter processor
    const result = processFilter(fm, {
      columnExpression,
      columnId: col,
      paramBase: pBase,
    });

    if (result.clause) {
      parts.push(result.clause);
      params.push(...result.params);
    }
  });

  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return { where, params };
}

const IMPORTANCE_SORT_COLUMNS = new Set(["Importance"]);

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? sqlBracketId(s.colId);
    if (IMPORTANCE_SORT_COLUMNS.has(s.colId)) {
      return `CASE ${expression} WHEN 'High' THEN 1 WHEN 'Med' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ${sqlSortDirection(s.sort)}`;
    }
    return `${expression} ${sqlSortDirection(s.sort)}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
}

async function readGridRequest(req: NextRequest): Promise<GridRequest> {
  try {
    const payload = await req.json();
    if (payload && typeof payload === "object" && "request" in payload) {
      const inner = (payload as { request?: GridRequest }).request;
      if (inner && typeof inner === "object") return inner;
    }
  } catch {
    /* noop */
  }
  return { startRow: 0, endRow: 100 };
}

type GroupField = {
  field: string;
  expression: string;
};

const combineWhereClauses = (...clauses: Array<string | undefined>) => {
  const cleaned = clauses
    .map((clause) => clause?.trim())
    .filter((clause): clause is string => typeof clause === "string" && clause.length > 0)
    .map((clause) => clause.replace(/^\s*WHERE\s+/i, "").trim())
    .filter((clause) => clause.length > 0);
  if (cleaned.length === 0) return "";
  return `WHERE ${cleaned.join(" AND ")}`;
};

const resolveGroupingFields = (rowGroupCols?: GridRequest["rowGroupCols"]): GroupField[] => {
  if (!Array.isArray(rowGroupCols) || rowGroupCols.length === 0) return [];
  const resolved: GroupField[] = [];
  for (const col of rowGroupCols) {
    const candidate =
      (typeof col.field === "string" && col.field.length > 0 && col.field) ??
      (typeof col.colId === "string" && col.colId.length > 0 && col.colId) ??
      null;
    if (!candidate || !ALLOWED_ROW_GROUP_FIELDS.has(candidate)) {
      return [];
    }
    const expression = COLUMN_EXPRESSIONS[candidate] ?? sqlBracketId(candidate);
    resolved.push({ field: candidate, expression });
  }
  return resolved;
};

const normalizeBooleanGroupKeyValue = (value: unknown): number | null => {
  if (value === 1 || value === true || value === "1") return 1;
  if (value === 0 || value === false || value === "0") return 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return 1;
    if (["false", "no", "n"].includes(normalized)) return 0;
  }
  return null;
};

const normalizeGroupKeyValue = (fieldName: string, key: unknown) => {
  if (key == null) return null;
  if (fieldName === "IsParent") {
    const normalizedBoolean = normalizeBooleanGroupKeyValue(key);
    if (normalizedBoolean !== null) return normalizedBoolean;
  }
  return typeof key === "string" ? key : String(key);
};

const buildGroupKeyFilter = (
  fields: GroupField[],
  keys: Array<string | number | boolean | null>,
) => {
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  for (let idx = 0; idx < keys.length && idx < fields.length; idx += 1) {
    const rawKey = keys[idx];
    const expression = fields[idx].expression;
    const normalizedKey = normalizeGroupKeyValue(fields[idx].field, rawKey);
    if (normalizedKey === null) {
      clauses.push(`${expression} IS NULL`);
      continue;
    }
    const paramName = `__group_key_${idx}`;
    clauses.push(`${expression} = @${paramName}`);
    params.push({ key: paramName, value: normalizedKey });
  }
  if (clauses.length === 0) {
    return { clause: "", params };
  }
  return { clause: `WHERE ${clauses.join(" AND ")}`, params };
};


export async function POST(req: NextRequest) {
  logRequest(req, '/api/customers');
  try {
    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Customers.ID AS CustomerID,
        dbo.Customers.Name AS CustomerName,
        dbo.Customers.BrandName,
        dbo.Customers.TaxID,
        dbo.Customers.IsParent,
        parentCustomer.Name AS ParentCustomer,
        dbo.PricingPolicies.Name AS PricingPolicy,
        customerGroup.Name AS CustomerGroup,
        dbo.Customers.Importance,
        country.Name AS Country,
        dbo.Customers.City,
        dbo.Customers.Enabled
    `;

    const from = `
      FROM dbo.Customers
      LEFT OUTER JOIN dbo.PricingPolicies ON dbo.Customers.PricingPolicyID = dbo.PricingPolicies.ID
      LEFT OUTER JOIN dbo.Customers AS parentCustomer ON dbo.Customers.ParentCustomerID = parentCustomer.ID
      LEFT OUTER JOIN dbo.CustomerGroups AS customerGroup ON dbo.Customers.CustomerGroupID = customerGroup.ID
      LEFT OUTER JOIN dbo.Countries AS country ON dbo.Customers.CountryID = country.ID
    `;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.Customers.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const groupingFields = resolveGroupingFields(requestPayload.rowGroupCols);
    const rawGroupKeys = Array.isArray(requestPayload.groupKeys) ? requestPayload.groupKeys : [];
    const groupKeys = rawGroupKeys.slice(0, groupingFields.length);
    const parentFilter =
      groupingFields.length > 0
        ? buildGroupKeyFilter(groupingFields, groupKeys)
        : { clause: "", params: [] as QueryParam[] };
    const groupLevel = Math.min(groupKeys.length, groupingFields.length);

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    if (groupingFields.length > 0 && groupLevel < groupingFields.length) {
      const groupWhere = combineWhereClauses(combinedWhere, parentFilter.clause);
      const levelField = groupingFields[groupLevel];

      const countReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${levelField.expression}) AS __groupCount
        ${from}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(countSql);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      groupReq.input("__offset", sql.Int, offset);
      groupReq.input("__limit", sql.Int, pageSize);
      const groupSql = `
        SELECT DISTINCT ${levelField.expression} AS GroupValue
        ${from}
        ${groupWhere}
        ORDER BY ${levelField.expression}
        ${paging}
      `;
      const groupRes = await groupReq.query<{ GroupValue: string | number | boolean | null }>(groupSql);
      const rows = (groupRes.recordset ?? []).map((row) => {
        const value = row.GroupValue ?? null;
        return {
          group: true,
          key: value === null ? null : String(value),
          field: levelField.field,
          [levelField.field]: value,
        };
      });

      return NextResponse.json({ ok: true, rows, rowCount: totalGroupCount });
    }

    const appliedWhere =
      groupingFields.length > 0 ? combineWhereClauses(combinedWhere, parentFilter.clause) : combinedWhere;
    const appliedParams = [...combinedParams, ...parentFilter.params];

    const dataSql = `${select} ${from} ${appliedWhere} ${orderClause} ${paging}`;
    const dataReq = bindParams(pool.request(), appliedParams);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    const dataRes = await dataReq.query<CustomerRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row: CustomerRowWithCount) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/customers');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const ids = collectCustomerIds((body as { CustomerIDs?: unknown } | null)?.CustomerIDs ?? []);
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No customers selected for deletion" }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, ids.length, 'generic', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    let deleted = 0;
    const deletedRows: Array<{ id: number; name: string | null }> = [];

    for (let idx = 0; idx < ids.length; idx += BATCH_DELETE_SIZE) {
      const chunk = ids.slice(idx, idx + BATCH_DELETE_SIZE);
      if (chunk.length === 0) continue;
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const request = transaction.request();
        const paramNames: string[] = [];
        chunk.forEach((value, chunkIdx) => {
          const paramName = `customer_${chunkIdx}`;
          paramNames.push(paramName);
          request.input(paramName, sql.Int, value);
        });
        const placeholders = paramNames.map((name) => `@${name}`).join(", ");

        await request.query(`
          DELETE FROM dbo.Contacts
          WHERE CustomerID IN (${placeholders});
        `);
        await request.query(`
          DELETE od
          FROM dbo.OfferDetails AS od
          INNER JOIN dbo.Offer AS o ON od.OfferID = o.ID
          WHERE o.CustomerID IN (${placeholders});
        `);
        await request.query(`
          DELETE FROM dbo.Offer
          WHERE CustomerID IN (${placeholders});
        `);
        const deleteResult = await request.query<{ CustomerID: number; Name: string | null }>(`
          DELETE FROM dbo.Customers
          OUTPUT DELETED.ID AS CustomerID, DELETED.Name
          WHERE ID IN (${placeholders});
        `);
        await transaction.commit();
        const rows = deleteResult.recordset ?? [];
        deleted += rows.length;
        rows.forEach((row) => {
          deletedRows.push({ id: row.CustomerID, name: row.Name ?? null });
        });
      } catch (chunkErr) {
        await transaction.rollback().catch(() => {});
        throw chunkErr;
      }
    }

    logDeleteAuditDetails({
      endpoint: '/api/customers',
      requestId,
      userId,
      targetEntity: 'customers',
      requestedIds: ids,
      deletedRows,
      message: 'Customers deleted',
    });

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
