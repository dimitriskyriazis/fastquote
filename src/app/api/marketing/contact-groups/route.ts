import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import {
  logDeleteAuditDetails,
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
import { sqlBracketId, sqlSortDirection } from "../../../../lib/sqlIdentifier";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ContactGroupID: "cg.ID",
  Description: "cg.Description",
  Division: "sd.Name",
  GroupImportance: "cg.GroupImportance",
  SalespersonID: "cg.SalespersonID",
  Note: "cg.Note",
  Enabled: "cg.Enabled",
  TotalCount: "(SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID)",
  Importance1: "(SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID AND Importance = 'High')",
  Importance2: "(SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID AND Importance = 'Med')",
  Importance3: "(SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID AND Importance = 'Low')",
};

const QUICK_FILTER_COLUMNS = [
  { colId: "Description", expression: "cg.Description" },
  { colId: "Division", expression: "sd.Name" },
  { colId: "Note", expression: "cg.Note" },
];

type UpdateInput = {
  ContactGroupID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

const normalizeId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "1") return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return true;
  }
  return false;
};

const trimNullableText = (value: string | null | undefined): string | null =>
  typeof value === "string" ? value.trim() : null;

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typed = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typed).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? sqlBracketId(col);
    const result = processFilter(fm, { columnExpression, columnId: col, paramBase: pBase });
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

const IMPORTANCE_SORT_COLUMNS = new Set(["GroupImportance"]);

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((entry) => {
    const expr = COLUMN_EXPRESSIONS[entry.colId] ?? sqlBracketId(entry.colId);
    if (IMPORTANCE_SORT_COLUMNS.has(entry.colId)) {
      const dir = sqlSortDirection(entry.sort);
      return `CASE cg.GroupImportance WHEN 'High' THEN 1 WHEN 'Med' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ${dir}`;
    }
    return `${expr} ${sqlSortDirection(entry.sort)}`;
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

export async function GET(req: NextRequest) {
  logRequest(req, '/api/marketing/contact-groups');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const pool = await getPool();
    const result = await pool.request().query(`
      SELECT ID, Description
      FROM dbo.ContactGroups
      WHERE Enabled = 1
      ORDER BY Description
    `);
    const rows = (result.recordset ?? []) as Array<{ ID: number; Description: string | null }>;
    const options = rows.map((r) => ({ value: String(r.ID), label: (r.Description ?? '').trim() || String(r.ID) }));
    return NextResponse.json({ ok: true, options });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/contact-groups');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY cg.Description";

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        cg.ID AS ContactGroupID,
        cg.Description,
        sd.Name AS Division,
        cg.GroupImportance,
        cg.SalespersonID,
        cg.Note,
        cg.Enabled,
        (SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID) AS TotalCount,
        (SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID AND Importance = 'High') AS Importance1,
        (SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID AND Importance = 'Med') AS Importance2,
        (SELECT COUNT(*) FROM dbo.ContactsGroupLists WHERE ContactGroupID = cg.ID AND Importance = 'Low') AS Importance3
      FROM dbo.ContactGroups cg
      LEFT JOIN dbo.SalesDivision sd ON sd.ID = cg.SalesDivisionID
    `;

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    const dataSql = `${select} ${combinedWhere} ${orderClause} OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;
    const dataReq = bindParams(pool.request(), combinedParams);
    dataReq.input("__offset", sql.Int, startRow);
    dataReq.input("__limit", sql.Int, pageSize);
    type RowWithCount = Record<string, unknown> & { __totalCount?: number | bigint | null };
    const dataRes = await dataReq.query<RowWithCount>(dataSql);

    const rowsWithCount: RowWithCount[] = dataRes.recordset ?? [];
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
  logRequest(req, '/api/marketing/contact-groups');
  try {
    const auth = await requirePermission(req, "manageMarketing");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: UpdateInput[] } | null)?.updates)
      ? ((body as { updates?: UpdateInput[] }).updates ?? [])
      : [];

    const normalized = updates
      .map((entry) => {
        const id = normalizeId(entry?.ContactGroupID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (id == null || !field) return null;
        return { id, field, value: entry?.value };
      })
      .filter((entry): entry is { id: number; field: string; value: unknown } => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates" }, { status: 400 });
    }

    const pool = await getPool();

    for (const update of normalized) {
      const request = pool.request();
      request.input("id", sql.Int, update.id);

      if (update.field === "Enabled") {
        request.input("value", sql.Bit, normalizeBooleanInput(update.value) ? 1 : 0);
        await request.query(`UPDATE dbo.ContactGroups SET Enabled = @value WHERE ID = @id`);
      } else if (update.field === "Description" || update.field === "Note") {
        request.input("value", sql.NVarChar(sql.MAX), normalizeTextValue(update.value));
        await request.query(`UPDATE dbo.ContactGroups SET [${update.field}] = @value WHERE ID = @id`);
      } else if (update.field === "GroupImportance") {
        const imp = normalizeTextValue(update.value);
        request.input("value", sql.NVarChar(255), imp || null);
        await request.query(`UPDATE dbo.ContactGroups SET GroupImportance = @value WHERE ID = @id`);
      } else if (update.field === "SalespersonID") {
        const spId = normalizeTextValue(update.value);
        request.input("value", sql.NVarChar(450), spId || null);
        await request.query(`UPDATE dbo.ContactGroups SET SalespersonID = @value WHERE ID = @id`);
      } else if (update.field === "Division") {
        // Look up SalesDivisionID by name
        const divName = normalizeTextValue(update.value);
        if (!divName) {
          request.input("divId", sql.Int, null);
          await request.query(`UPDATE dbo.ContactGroups SET SalesDivisionID = @divId WHERE ID = @id`);
        } else {
          const lookup = pool.request();
          lookup.input("divName", sql.NVarChar, divName);
          const lookupResult = await lookup.query<{ ID: number }>(`
            SELECT TOP 1 ID FROM dbo.SalesDivision WHERE Name = @divName ORDER BY ID
          `);
          const divId = lookupResult.recordset?.[0]?.ID ?? null;
          request.input("divId", sql.Int, divId);
          await request.query(`UPDATE dbo.ContactGroups SET SalesDivisionID = @divId WHERE ID = @id`);
        }
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
  logRequest(req, '/api/marketing/contact-groups');
  try {
    const auth = await requirePermission(req, "manageMarketing");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { ContactGroupIDs?: Array<number | string> } | null;
    const rawIds = Array.isArray(body?.ContactGroupIDs) ? body.ContactGroupIDs : [];
    const ids = Array.from(new Set(
      rawIds
        .map((v) => (typeof v === "number" ? v : Number.parseInt(String(v), 10)))
        .filter((v) => Number.isFinite(v)),
    ));

    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No IDs provided" }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, ids.length, 'generic', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();

    // Delete members first
    const req1 = pool.request();
    ids.forEach((id, idx) => req1.input(`id${idx}`, sql.Int, id));
    await req1.query(`DELETE FROM dbo.ContactsGroupLists WHERE ContactGroupID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})`);

    // Delete mail associations
    const req2 = pool.request();
    ids.forEach((id, idx) => req2.input(`id${idx}`, sql.Int, id));
    await req2.query(`DELETE FROM dbo.MailContactGroups WHERE ContactGroupID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})`);

    // Delete groups
    const req3 = pool.request();
    ids.forEach((id, idx) => req3.input(`id${idx}`, sql.Int, id));
    const deleteResult = await req3.query(`
      DELETE FROM dbo.ContactGroups
      OUTPUT DELETED.ID AS ContactGroupID, DELETED.Description, DELETED.SalesDivisionID, DELETED.SalespersonID, DELETED.GroupImportance, DELETED.Note, DELETED.Enabled
      WHERE ID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})
    `);

    type DeletedContactGroupRow = { ContactGroupID: number; Description: string | null; SalesDivisionID: number | null; SalespersonID: number | null; GroupImportance: string | null; Note: string | null; Enabled: boolean | null };
    const rawDeletedRows = (deleteResult.recordset ?? []) as DeletedContactGroupRow[];
    const auditRows = rawDeletedRows.map((row) => ({
      id: row.ContactGroupID,
      name: trimNullableText(row.Description),
    }));

    const auditUserId = resolveAuditUserId(req);
    logDeleteAuditDetails({
      endpoint: "/api/marketing/contact-groups",
      userId: auditUserId,
      targetEntity: "contactGroups",
      requestedIds: ids,
      deletedRows: auditRows,
      message: "Contact groups deleted",
    });

    return NextResponse.json({ ok: true, deleted: rawDeletedRows.length, deletedRows: rawDeletedRows });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
