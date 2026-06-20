import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../lib/gridFilters";
import { requirePermission } from "../../../lib/authz";
import { checkDeletePermission } from "../../../lib/deletePermissions";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { logDeleteAuditDetails } from "../../../lib/mutationAudit";
import { sqlBracketId, sqlSortDirection } from "../../../lib/sqlIdentifier";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type DeleteRequest = {
  PriceListIDs?: Array<number | string | null | undefined>;
};

type PriceListRow = {
  PriceListID: number | null;
  Name: string | null;
  BrandName: string | null;
  ValidFromDate: string | Date | null;
  ValidToDate: string | Date | null;
  Enabled: boolean | number | null;
  SupplierName: string | null;
  ResponsibleUserId: string | null;
  ResponsibleUserName: string | null;
  ValidityComment: string | null;
  CreatedBy: string | null;
  CreatedOn: string | Date | null;
  FilePath: string | null;
  PricingPolicies: string | null;
};

type PriceListRowWithCount = PriceListRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  PriceListID: "dbo.PriceLists.ID",
  Name: "dbo.PriceLists.Name",
  BrandName: "dbo.Brands.Name",
  ValidFromDate: "dbo.PriceLists.ValidFromDate",
  ValidToDate: "dbo.PriceLists.ValidToDate",
  Enabled: "dbo.PriceLists.Enabled",
  SupplierName: "dbo.Suppliers.Name",
  ResponsibleUserName: "COALESCE(NULLIF(LTRIM(RTRIM(responsible.FullName)), ''), responsible.UserName)",
  ValidityComment: "dbo.PriceLists.ValidityComment",
  CreatedBy: "COALESCE(NULLIF(LTRIM(RTRIM(created.FullName)), ''), NULLIF(LTRIM(RTRIM(created.UserName)), ''), CAST(dbo.PriceLists.CreatedBy AS NVARCHAR(450)))",
  CreatedOn: "dbo.PriceLists.CreatedOn",
};
const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) return { where: "", params: [] as QueryParam[] };

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

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? sqlBracketId(s.colId);
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
    /* swallow, use defaults */
  }
  return { startRow: 0, endRow: 100 };
}

const normalizePriceListId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

type GroupField = {
  field: string;
  expression: string;
};

const ALLOWED_ROW_GROUP_FIELD = "SupplierName";

const combineWhereClauses = (...clauses: Array<string | undefined>) => {
  const cleaned = clauses
    .map((clause) => clause?.trim())
    .filter((clause): clause is string => typeof clause === "string" && clause.length > 0)
    .map((clause) => clause.replace(/^\s*WHERE\s+/i, "").trim())
    .filter((clause) => clause.length > 0);
  if (cleaned.length === 0) return "";
  return `WHERE ${cleaned.join(" AND ")}`;
};

const resolveGroupingField = (rowGroupCols?: GridRequest["rowGroupCols"]): GroupField | null => {
  if (!Array.isArray(rowGroupCols) || rowGroupCols.length === 0) return null;
  const first = rowGroupCols[0];
  const candidate =
    (typeof first.field === "string" && first.field.length > 0 && first.field) ??
    (typeof first.colId === "string" && first.colId.length > 0 && first.colId) ??
    null;
  if (!candidate || candidate !== ALLOWED_ROW_GROUP_FIELD) return null;
  const expression = COLUMN_EXPRESSIONS[ALLOWED_ROW_GROUP_FIELD] ?? `[${ALLOWED_ROW_GROUP_FIELD}]`;
  return { field: ALLOWED_ROW_GROUP_FIELD, expression };
};

const buildGroupKeyFilter = (field: GroupField, key: string | null) => {
  if (key === null) {
    return { clause: `WHERE ${field.expression} IS NULL`, params: [] as QueryParam[] };
  }
  return {
    clause: `WHERE ${field.expression} = @__group_key`,
    params: [{ key: "__group_key", value: key }],
  };
};


export async function GET(req: NextRequest) {
  logRequest(req, '/api/price-lists');
  try {
    const pool = await getPool();
    const result = await pool.request().query<{ MaxCount: number | null }>(`
      SELECT ISNULL(MAX(cnt), 0) AS MaxCount FROM (
        SELECT PriceListID, COUNT(DISTINCT PricingPolicyID) AS cnt
        FROM dbo.PriceListPricingPolicy
        GROUP BY PriceListID
      ) t
    `);
    const maxPricingPolicies = Number(result.recordset?.[0]?.MaxCount ?? 0);
    return NextResponse.json({ ok: true, maxPricingPolicies });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  logRequest(req, '/api/price-lists');
  try {
    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.PriceLists.ID AS PriceListID,
        dbo.PriceLists.Name,
        dbo.PriceLists.BrandID,
        dbo.Brands.Name AS BrandName,
        dbo.PriceLists.ValidFromDate,
        dbo.PriceLists.ValidToDate,
        dbo.PriceLists.Enabled,
        dbo.Suppliers.Name AS SupplierName,
        dbo.PriceLists.ResponsibleUserId,
        COALESCE(NULLIF(LTRIM(RTRIM(responsible.FullName)), ''), responsible.UserName) AS ResponsibleUserName,
        dbo.PriceLists.ValidityComment,
        COALESCE(NULLIF(LTRIM(RTRIM(created.FullName)), ''), NULLIF(LTRIM(RTRIM(created.UserName)), ''), CAST(dbo.PriceLists.CreatedBy AS NVARCHAR(450))) AS CreatedBy,
        dbo.PriceLists.CreatedOn,
        dbo.PriceLists.FilePath,
        (
          SELECT STRING_AGG(pp.Name, CHAR(31)) WITHIN GROUP (
            ORDER BY
              CASE WHEN pp.Name = 'Default Pricing Policy' THEN 0 ELSE 1 END,
              pp.Name
          )
          FROM (
            SELECT DISTINCT plpp.PricingPolicyID
            FROM dbo.PriceListPricingPolicy plpp
            WHERE plpp.PriceListID = dbo.PriceLists.ID
          ) d
          INNER JOIN dbo.PricingPolicies pp ON d.PricingPolicyID = pp.ID
        ) AS PricingPolicies
    `;

    const from = `
      FROM dbo.PriceLists
      LEFT OUTER JOIN dbo.Suppliers ON dbo.PriceLists.SupplierID = dbo.Suppliers.ID
      LEFT OUTER JOIN dbo.Brands ON dbo.PriceLists.BrandID = dbo.Brands.ID
      LEFT OUTER JOIN dbo.AspNetUsers AS responsible ON dbo.PriceLists.ResponsibleUserId = responsible.Id
      LEFT OUTER JOIN dbo.AspNetUsers AS created ON dbo.PriceLists.CreatedBy = created.Id
    `;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const order = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.PriceLists.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const groupingField = resolveGroupingField(requestPayload.rowGroupCols);
    const rawGroupKeys = Array.isArray(requestPayload.groupKeys) ? requestPayload.groupKeys : [];
    const groupKey = rawGroupKeys.length > 0 ? rawGroupKeys[0] : null;
    const parentFilter =
      groupingField && rawGroupKeys.length > 0
        ? buildGroupKeyFilter(groupingField, groupKey)
        : { clause: "", params: [] as QueryParam[] };
    const groupLevel = groupingField ? Math.min(rawGroupKeys.length, 1) : 0;

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    if (groupingField && groupLevel < 1) {
      const groupWhere = combineWhereClauses(combinedWhere, parentFilter.clause);

      const countReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${groupingField.expression}) AS __groupCount
        ${from}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(countSql);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      groupReq.input("__offset", sql.Int, offset);
      groupReq.input("__limit", sql.Int, pageSize);
      const groupSql = `
        SELECT DISTINCT ${groupingField.expression} AS GroupValue
        ${from}
        ${groupWhere}
        ORDER BY ${groupingField.expression}
        ${paging}
      `;
      const groupRes = await groupReq.query<{ GroupValue: string | null }>(groupSql);
      const groupRows = (groupRes.recordset ?? []).map((row) => {
        const value = row.GroupValue ?? null;
        return {
          group: true,
          key: value,
          field: groupingField.field,
          [groupingField.field]: value,
        };
      });

      return NextResponse.json({ ok: true, rows: groupRows, rowCount: totalGroupCount });
    }

    const appliedWhere = combineWhereClauses(combinedWhere, parentFilter.clause);
    const appliedParams = [...combinedParams, ...parentFilter.params];
    const dataSql = `${select} ${from} ${appliedWhere} ${order} ${paging}`;

    const dataReq = bindParams(pool.request(), appliedParams);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    const dataRes = await dataReq.query<PriceListRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row: PriceListRowWithCount) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/price-lists');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    let body: DeleteRequest | null = null;
    try {
      body = (await req.json()) as DeleteRequest;
    } catch {
      body = null;
    }

    const rawIds = Array.isArray(body?.PriceListIDs) ? body.PriceListIDs : [];
    const normalizedIds = Array.from(
      new Set(
        rawIds
          .map((value) => normalizePriceListId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No price lists selected for deletion" }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, normalizedIds.length, 'pricelists', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const chunkSize = 200;
    let deleted = 0;
    const deletedRows: Array<{ id: number; name: string | null }> = [];

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
        const chunk = normalizedIds.slice(idx, idx + chunkSize);
        if (chunk.length === 0) continue;

        const params = chunk.map((id, chunkIdx) => ({ name: `pl_${chunkIdx}`, value: id }));
        const paramNames = params.map((p) => `@${p.name}`);

        const deletePoliciesReq = new sql.Request(transaction);
        params.forEach((p) => deletePoliciesReq.input(p.name, sql.Int, p.value));
        await deletePoliciesReq.query(`
          DELETE FROM dbo.PriceListPricingPolicy
          WHERE PriceListID IN (${paramNames.join(", ")})
        `);

        const deleteItemsReq = new sql.Request(transaction);
        params.forEach((p) => deleteItemsReq.input(p.name, sql.Int, p.value));
        await deleteItemsReq.query(`
          DELETE FROM dbo.PriceListItems
          WHERE PriceListID IN (${paramNames.join(", ")})
        `);

        const deletePriceListsReq = new sql.Request(transaction);
        params.forEach((p) => deletePriceListsReq.input(p.name, sql.Int, p.value));
        const result = await deletePriceListsReq.query<{ PriceListID: number; Name: string | null }>(`
          DELETE dbo.PriceLists
          OUTPUT DELETED.ID AS PriceListID, DELETED.Name
          WHERE ID IN (${paramNames.join(", ")})
        `);

        deleted += result.rowsAffected?.[0] ?? 0;
        (result.recordset ?? []).forEach((row) => {
          deletedRows.push({ id: row.PriceListID, name: row.Name?.trim() || null });
        });
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    logDeleteAuditDetails({
      endpoint: "/api/price-lists",
      requestId,
      userId,
      targetEntity: "priceLists",
      requestedIds: normalizedIds,
      deletedRows,
      message: "Price lists deleted",
    });

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
