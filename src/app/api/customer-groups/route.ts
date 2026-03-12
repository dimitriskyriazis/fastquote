import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { buildAuditContext } from "../../../lib/auditTrail";
import { fetchUserRoles } from "../../../lib/authz";
import { checkDeletePermission } from "../../../lib/deletePermissions";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam } from "../../../lib/gridFilters";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";
import { BATCH_DELETE_SIZE } from '../../../lib/constants';










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
  Enabled: boolean | number | null;
  CreatedOn: string | Date | null;
};

type CustomerGroupRowWithCount = CustomerGroupRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  CustomerGroupID: "dbo.CustomerGroups.ID",
  Name: "dbo.CustomerGroups.Name",
  Enabled: "dbo.CustomerGroups.Enabled",
  CreatedOn: "dbo.CustomerGroups.CreatedOn" };
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
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;

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
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    return `${expression} ${s.sort.toUpperCase()}`;
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
  field: "Name" | "Enabled";
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
        dbo.CustomerGroups.Enabled,
        dbo.CustomerGroups.CreatedOn
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
          (field !== "Name" && field !== "Enabled")
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

    const deleteCheck = checkDeletePermission(roles, ids.length, 'generic', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    let deleted = 0;

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
        const deleteSql = `
          DELETE FROM dbo.CustomerGroups
          WHERE ID IN (${placeholders.join(", ")});
        `;
        const result = await request.query(deleteSql);
        await transaction.commit();
        deleted += result.rowsAffected?.[0] ?? 0;
      } catch (chunkErr) {
        await transaction.rollback().catch(() => {});
        throw chunkErr;
      }
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
