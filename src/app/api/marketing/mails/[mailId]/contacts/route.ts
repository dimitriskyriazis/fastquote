import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../lib/sql";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../../../../lib/gridFilters";
import { requirePermission } from "../../../../../../lib/authz";
import { KnownFilterModel } from "../../../../../../lib/filterTypes";
import { processFilter } from "../../../../../../lib/filterProcessing";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  MailContactID: "mc.ID",
  ContactID: "c.ID",
  CustomerName: "cust.Name",
  Title: "t.Name",
  LastName: "c.LastName",
  FirstName: "c.FirstName",
  Email: "c.Email",
  Fax: "c.Fax",
  Importance: "mc.Importance",
  Note: "mc.Note",
  Sent: "mc.Sent",
  FaxSent: "mc.FaxSent",
};

const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

function buildWhereAndParams(filterModel: GridRequest["filterModel"], extraWhere: string) {
  const parts: string[] = extraWhere ? [extraWhere] : [];
  const params: QueryParam[] = [];

  if (filterModel && Object.keys(filterModel).length > 0) {
    const typed = filterModel as Record<string, KnownFilterModel>;
    Object.entries(typed).forEach(([col, fm], idx) => {
      const pBase = `${col}_${idx}`;
      const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
      const result = processFilter(fm, { columnExpression, columnId: col, paramBase: pBase });
      if (result.clause) {
        parts.push(result.clause);
        params.push(...result.params);
      }
    });
  }

  return {
    where: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params,
  };
}

const IMPORTANCE_SORT_COLUMNS = new Set(["Importance"]);

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((entry) => {
    const expr = COLUMN_EXPRESSIONS[entry.colId] ?? `[${entry.colId}]`;
    if (IMPORTANCE_SORT_COLUMNS.has(entry.colId)) {
      return `CASE ${expr} WHEN 'High' THEN 1 WHEN 'Med' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ${entry.sort.toUpperCase()}`;
    }
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

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]/contacts');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { mailId: rawMailId } = await params;
    const mailId = Number.parseInt(rawMailId, 10);
    if (!Number.isFinite(mailId)) {
      return NextResponse.json({ ok: false, error: "Invalid mail ID" }, { status: 400 });
    }

    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));

    const { where, params: whereParams } = buildWhereAndParams(
      gridRequest.filterModel,
      "mc.MailID = @mailId",
    );
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY c.LastName, c.FirstName";

    const selectSql = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        mc.ID AS MailContactID,
        c.ID AS ContactID,
        cust.Name AS CustomerName,
        t.Name AS Title,
        c.LastName,
        c.FirstName,
        c.Email,
        c.Fax,
        mc.Importance,
        mc.Note,
        mc.Sent,
        mc.FaxSent
      FROM dbo.MailContacts mc
      INNER JOIN dbo.Contacts c ON c.ID = mc.ContactID
      LEFT JOIN dbo.Titles t ON t.ID = c.TitleID
      LEFT JOIN dbo.Customers cust ON cust.ID = c.CustomerID
      ${combinedWhere}
      ${orderClause}
      OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY
    `;

    const pool = await getPool();
    const request = pool.request();
    request.input("mailId", sql.Int, mailId);
    request.input("__offset", sql.Int, startRow);
    request.input("__limit", sql.Int, pageSize);
    combinedParams.forEach((param) => request.input(param.key, param.value));

    type RowWithCount = Record<string, unknown> & { __totalCount?: number | bigint | null };
    const dataRes = await request.query<RowWithCount>(selectSql);
    const rowsWithCount = dataRes.recordset ?? [];
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]/contacts');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    await params;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: Array<Record<string, unknown>> } | null)?.updates)
      ? ((body as { updates: Array<Record<string, unknown>> }).updates)
      : [];

    if (updates.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates" }, { status: 400 });
    }

    const pool = await getPool();
    for (const update of updates) {
      const mcId = Number(update.MailContactID);
      if (!Number.isFinite(mcId)) continue;
      const field = String(update.field ?? "");
      const value = update.value;

      const request = pool.request();
      request.input("mcId", sql.Int, mcId);

      if (field === "Importance") {
        request.input("value", sql.NVarChar(50), value != null ? String(value).trim() : null);
        await request.query(`UPDATE dbo.MailContacts SET Importance = @value WHERE ID = @mcId`);
      } else if (field === "Note") {
        request.input("value", sql.NVarChar(sql.MAX), value != null ? String(value).trim() : null);
        await request.query(`UPDATE dbo.MailContacts SET Note = @value WHERE ID = @mcId`);
      } else if (field === "Sent" || field === "FaxSent") {
        const boolVal = value === true || value === 1 || value === "true" || value === "Yes";
        request.input("value", sql.Bit, boolVal ? 1 : 0);
        await request.query(`UPDATE dbo.MailContacts SET [${field}] = @value WHERE ID = @mcId`);
      }
    }

    return NextResponse.json({ ok: true, updated: updates.length });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]/contacts');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    await params;

    const body = (await req.json().catch(() => null)) as { MailContactIDs?: Array<number | string> } | null;
    const rawIds = Array.isArray(body?.MailContactIDs) ? body.MailContactIDs : [];
    const ids = rawIds
      .map((v) => (typeof v === "number" ? v : Number.parseInt(String(v), 10)))
      .filter((v) => Number.isFinite(v));

    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No IDs provided" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    ids.forEach((id, idx) => request.input(`id${idx}`, sql.Int, id));
    await request.query(`
      DELETE FROM dbo.MailContacts
      WHERE ID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})
    `);

    return NextResponse.json({ ok: true, deleted: ids.length });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
