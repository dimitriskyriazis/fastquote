import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { buildAuditContext, resolveAuditUserId } from "../../../lib/auditTrail";
import { fetchUserRoles } from "../../../lib/authz";
import { checkDeletePermission } from "../../../lib/deletePermissions";
import { getRequestId } from "../../../lib/requestId";
import { logDeleteAuditDetails } from "../../../lib/mutationAudit";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam } from "../../../lib/gridFilters";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";
import { BATCH_DELETE_SIZE } from '../../../lib/constants';
import { sqlBracketId, sqlSortDirection } from '../../../lib/sqlIdentifier';










type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type CustomerGroupRow = {
  CustomerGroupID: number | null;
  Name: string | null;
  Code: string | null;
  CustomerCount: number | null;
  Enabled: boolean | number | null;
};

type CustomerGroupRowWithCount = CustomerGroupRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  CustomerGroupID: "dbo.CustomerGroups.ID",
  Name: "dbo.CustomerGroups.Name",
  Code: "dbo.CustomerGroups.Code",
  Enabled: "dbo.CustomerGroups.Enabled",
};
const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression }));

const buildWhereAndParams = (filterModel: GridRequest["filterModel"]) => {
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
};

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? sqlBracketId(s.colId);
    return `${expression} ${sqlSortDirection(s.sort)}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
}


const normalizeGroupId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const collectCustomerGroupIds = (values: unknown): number[] => {
  if (!Array.isArray(values)) return [];
  const normalized = new Set<number>();
  values.forEach((value) => {
    const id = normalizeGroupId(value);
    if (id != null) {
      normalized.add(id);
    }
  });
  return Array.from(normalized);
};

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "1") return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
  }
  return false;
};

const normalizeGroupText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

type GroupUpdateInput = {
  CustomerGroupID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedGroupUpdate = {
  groupId: number;
  field: "Name" | "Code" | "Enabled";
  value: unknown;
};

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

export async function POST(req: NextRequest) {
  logRequest(req, '/api/customer-groups');
  try {
    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.CustomerGroups.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.CustomerGroups.ID AS CustomerGroupID,
        dbo.CustomerGroups.Name,
        dbo.CustomerGroups.Code,
        (SELECT COUNT(*) FROM dbo.Customers c WHERE c.CustomerGroupID = dbo.CustomerGroups.ID) AS CustomerCount,
        dbo.CustomerGroups.Enabled
      FROM dbo.CustomerGroups
      ${combinedWhere}
      ${orderClause}
      ${paging}
    `;

    const pool = await getPool();
    const request = pool.request();
    combinedParams.forEach((param) => request.input(param.key, param.value));
    request.input("__offset", sql.Int, offset);
    request.input("__limit", sql.Int, pageSize);

    const result = await request.query<CustomerGroupRowWithCount>(select);
    const rowsWithCount = result.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/customer-groups');
  try {
    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: GroupUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: GroupUpdateInput[] }).updates ?? [])
      : [];
    const normalized: NormalizedGroupUpdate[] = updates
      .map((entry) => {
        const groupId = normalizeGroupId(entry?.CustomerGroupID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (
          groupId == null ||
          !field ||
          (field !== "Name" && field !== "Code" && field !== "Enabled")
        ) {
          return null;
        }
        return {
          groupId,
          field,
          value: entry?.value } as NormalizedGroupUpdate;
      })
      .filter((entry): entry is NormalizedGroupUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    for (const entry of normalized) {
      const request = pool.request();
      request.input("groupId", sql.Int, entry.groupId);
      if (entry.field === "Name") {
        request.input("value", sql.NVarChar, normalizeGroupText(entry.value));
        await request.query(`
          UPDATE dbo.CustomerGroups
          SET Name = @value
          WHERE ID = @groupId
        `);
      } else if (entry.field === "Code") {
        const codeVal = normalizeGroupText(entry.value);
        request.input("value", sql.NVarChar, codeVal || null);
        await request.query(`
          UPDATE dbo.CustomerGroups
          SET Code = @value
          WHERE ID = @groupId
        `);
      } else {
        request.input("value", sql.Bit, normalizeBooleanInput(entry.value) ? 1 : 0);
        await request.query(`
          UPDATE dbo.CustomerGroups
          SET Enabled = @value
          WHERE ID = @groupId
        `);
      }
    }

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/customer-groups');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const audit = buildAuditContext(req);
    const roles = await fetchUserRoles(audit.userId);

    const body = await req.json().catch(() => null);
    const ids = collectCustomerGroupIds(
      (body as { CustomerGroupIDs?: unknown } | null)?.CustomerGroupIDs ?? [],
    );
    if (ids.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No customer groups selected for deletion" },
        { status: 400 },
      );
    }

    const deleteCheck = checkDeletePermission(roles, ids.length, 'generic', 'manageCustomersContacts');
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    let deleted = 0;
    const deletedRows: Array<{ CustomerGroupID: number; Name: string | null; Code: string | null; Enabled: boolean | null }> = [];

    for (let idx = 0; idx < ids.length; idx += BATCH_DELETE_SIZE) {
      const chunk = ids.slice(idx, idx + BATCH_DELETE_SIZE);
      if (chunk.length === 0) continue;
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const request = transaction.request();
        const placeholders: string[] = [];
        chunk.forEach((value, chunkIdx) => {
          const paramName = `group_${chunkIdx}`;
          request.input(paramName, sql.Int, value);
          placeholders.push(`@${paramName}`);
        });
        const result = await request.query<{ CustomerGroupID: number; Name: string | null; Code: string | null; Enabled: boolean | null }>(`
          DELETE FROM dbo.CustomerGroups
          OUTPUT DELETED.ID AS CustomerGroupID, DELETED.Name, DELETED.Code, DELETED.Enabled
          WHERE ID IN (${placeholders.join(", ")});
        `);
        await transaction.commit();
        deleted += result.recordset?.length ?? 0;
        deletedRows.push(...(result.recordset ?? []));
      } catch (chunkErr) {
        await transaction.rollback().catch(() => {});
        throw chunkErr;
      }
    }

    logDeleteAuditDetails({
      endpoint: '/api/customer-groups',
      requestId,
      userId,
      targetEntity: 'customerGroups',
      requestedIds: ids,
      deletedRows: deletedRows.map((row) => ({ id: row.CustomerGroupID, name: row.Name ?? null })),
      message: 'Customer groups deleted',
    });

    return NextResponse.json({ ok: true, deleted, deletedRows });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
