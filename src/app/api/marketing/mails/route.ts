import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import {
  buildFieldChanges,
  logDeleteAuditDetails,
  logEditAuditDetails,
  type FieldUpdate,
} from "../../../../lib/mutationAudit";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../../lib/gridFilters";
import { requirePermission } from "../../../../lib/authz";
import { checkDeletePermission } from "../../../../lib/deletePermissions";
import { KnownFilterModel } from "../../../../lib/filterTypes";
import { processFilter } from "../../../../lib/filterProcessing";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type MailField =
  | "MailID"
  | "Date"
  | "Description"
  | "Note"
  | "UsedForFax"
  | "IsPresent"
  | "Locked";

const COLUMN_EXPRESSIONS: Record<MailField, string> = {
  MailID: "dbo.Mails.ID",
  Date: "dbo.Mails.Date",
  Description: "dbo.Mails.Description",
  Note: "dbo.Mails.Note",
  UsedForFax: "dbo.Mails.UsedForFax",
  IsPresent: "dbo.Mails.IsPresent",
  Locked: "dbo.Mails.Locked",
};
const COLUMN_EXPRESSIONS_BY_ID = COLUMN_EXPRESSIONS as Record<string, string>;

const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

type MailUpdateInput = {
  MailID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedMailUpdate = {
  mailId: number;
  field: MailField;
  value: unknown;
};

type MailDeleteBody = {
  MailIDs?: Array<number | string | null>;
};

const normalizeMailId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "1") return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return true;
  }
  return false;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const trimNullableText = (value: string | null | undefined): string | null =>
  typeof value === "string" ? value.trim() : null;

const normalizeBooleanOutput = (value: unknown): boolean | null => {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return null;
};

type MailAuditRow = {
  MailID: number;
  Date: string | null;
  Description: string | null;
  Note: string | null;
  IsPresent: boolean | number | null;
};

const fetchMailAuditRows = async (
  pool: Awaited<ReturnType<typeof getPool>>,
  ids: number[],
): Promise<Map<number, MailAuditRow>> => {
  const rowsById = new Map<number, MailAuditRow>();
  if (ids.length === 0) return rowsById;

  const request = pool.request();
  ids.forEach((id, idx) => {
    request.input(`auditId${idx}`, sql.Int, id);
  });
  const result = await request.query<MailAuditRow>(`
    SELECT
      ID AS MailID,
      Date,
      Description,
      Note,
      IsPresent
    FROM dbo.Mails
    WHERE ID IN (${ids.map((_, idx) => `@auditId${idx}`).join(", ")})
  `);

  for (const row of result.recordset ?? []) {
    rowsById.set(row.MailID, row);
  }

  return rowsById;
};

const resolveMailFieldValue = (
  row: MailAuditRow | undefined,
  field: MailField,
): unknown => {
  if (!row) return null;
  if (field === "IsPresent") return normalizeBooleanOutput(row.IsPresent);
  return (row as Record<string, unknown>)[field === "MailID" ? "MailID" : field];
};

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typed = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typed).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS_BY_ID[col] ?? `[${col}]`;

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

  return {
    where: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params,
  };
}

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((entry) => {
    const expr = COLUMN_EXPRESSIONS_BY_ID[entry.colId] ?? `[${entry.colId}]`;
    return `${expr} ${entry.sort.toUpperCase()}`;
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

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/mails');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY dbo.Mails.Date DESC";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Mails.ID AS MailID,
        dbo.Mails.Date,
        dbo.Mails.Description,
        dbo.Mails.Note,
        dbo.Mails.UsedForFax,
        dbo.Mails.IsPresent,
        dbo.Mails.Locked
      FROM dbo.Mails
    `;

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    const dataSql = `${select} ${combinedWhere} ${orderClause} ${paging}`;
    const dataReq = bindParams(pool.request(), combinedParams);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    type RowWithCount = Record<string, unknown> & { __totalCount?: number | bigint | null };
    const dataRes = await dataReq.query<RowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return {
        ...rest,
        Description: trimNullableText(rest.Description as string | null),
        Note: trimNullableText(rest.Note as string | null),
      };
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/marketing/mails');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: MailUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: MailUpdateInput[] }).updates ?? [])
      : [];
    const normalized: NormalizedMailUpdate[] = updates
      .map((entry) => {
        const mailId = normalizeMailId(entry?.MailID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (mailId == null || !field || !(field in COLUMN_EXPRESSIONS)) {
          return null;
        }
        return { mailId, field: field as MailField, value: entry?.value } as NormalizedMailUpdate;
      })
      .filter((entry): entry is NormalizedMailUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);
    const targetMailIds = Array.from(new Set(normalized.map((entry) => entry.mailId)));
    const beforeById = await fetchMailAuditRows(pool, targetMailIds);

    for (const update of normalized) {
      const request = pool.request();
      request.input("mailId", sql.Int, update.mailId);

      if (update.field === "IsPresent" || update.field === "UsedForFax" || update.field === "Locked") {
        request.input("value", sql.Bit, normalizeBooleanInput(update.value) ? 1 : 0);
        await request.query(`
          UPDATE dbo.Mails SET [${update.field}] = @value WHERE ID = @mailId
        `);
      } else if (update.field === "Date") {
        const dateValue = update.value ? new Date(String(update.value)) : null;
        request.input("value", sql.DateTime2, dateValue);
        await request.query(`UPDATE dbo.Mails SET [Date] = @value WHERE ID = @mailId`);
      } else {
        request.input("value", sql.NVarChar, normalizeTextValue(update.value));
        await request.query(`
          UPDATE dbo.Mails SET [${update.field}] = @value WHERE ID = @mailId
        `);
      }
    }

    const afterById = await fetchMailAuditRows(pool, targetMailIds);
    const changes = buildFieldChanges({
      updates: normalized.map(
        (entry) =>
          ({ targetId: entry.mailId, field: entry.field }) satisfies FieldUpdate<MailField, number>,
      ),
      beforeById,
      afterById,
      getFieldValue: resolveMailFieldValue,
      getTargetName: (before, after) => after?.Description ?? before?.Description ?? null,
    });
    if (changes.length > 0) {
      logEditAuditDetails({
        endpoint: "/api/marketing/mails",
        method: "PATCH",
        userId: auditUserId,
        targetEntity: "mails",
        targetIds: targetMailIds,
        changes,
        message: "Mail fields updated",
      });
    }

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/marketing/mails');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as MailDeleteBody | null;
    const rawIds = Array.isArray(body?.MailIDs) ? body.MailIDs : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((entry) => {
            if (typeof entry === "number" && Number.isFinite(entry)) return Math.trunc(entry);
            if (typeof entry === "string") {
              const parsed = Number.parseInt(entry, 10);
              if (Number.isFinite(parsed)) return parsed;
            }
            return null;
          })
          .filter((value): value is number => value != null),
      ),
    );
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No mails provided" }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, ids.length, 'generic', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const request = pool.request();
    ids.forEach((value, idx) => {
      request.input(`id${idx}`, sql.Int, value);
    });

    // Delete related MailContactGroups and MailContacts first
    await request.query(`
      DELETE FROM dbo.MailContactGroups WHERE MailID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})
    `);
    const request2 = pool.request();
    ids.forEach((value, idx) => {
      request2.input(`id${idx}`, sql.Int, value);
    });
    await request2.query(`
      DELETE FROM dbo.MailContacts WHERE MailID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})
    `);

    const request3 = pool.request();
    ids.forEach((value, idx) => {
      request3.input(`id${idx}`, sql.Int, value);
    });
    const deleteResult = await request3.query(`
      DELETE FROM dbo.Mails
      OUTPUT DELETED.ID AS MailID, DELETED.[Date], DELETED.Description, DELETED.Note, DELETED.UsedForFax, DELETED.IsPresent, DELETED.Locked
      WHERE ID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})
    `);

    type DeletedRow = { MailID: number; Date: Date | string | null; Description: string | null; Note: string | null; UsedForFax: boolean | null; IsPresent: boolean | null; Locked: boolean | null };
    const rawDeletedRows = (deleteResult.recordset ?? []) as DeletedRow[];
    const auditRows = rawDeletedRows.map((row) => ({
      id: row.MailID,
      name: trimNullableText(row.Description),
    }));

    const auditUserId = resolveAuditUserId(req);
    logDeleteAuditDetails({
      endpoint: "/api/marketing/mails",
      userId: auditUserId,
      targetEntity: "mails",
      requestedIds: ids,
      deletedRows: auditRows,
      message: "Mails deleted",
    });

    return NextResponse.json({ ok: true, deleted: rawDeletedRows.length, deletedRows: rawDeletedRows });
  } catch (err) {
    console.error("Failed to delete mails", err);
    const message = err instanceof Error ? err.message : "Unable to delete mails.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
