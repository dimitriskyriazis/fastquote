import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { buildAuditContext } from "../../../../../lib/auditTrail";
import { fetchUserRoles } from "../../../../../lib/authz";
import { checkDeletePermission } from "../../../../../lib/deletePermissions";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam } from "../../../../../lib/gridFilters";
import { KnownFilterModel } from "../../../../../lib/filterTypes";
import { processFilter } from "../../../../../lib/filterProcessing";
import { BATCH_DELETE_SIZE } from '../../../../../lib/constants';

type ContactRow = {
  ContactID: number;
  FirstName: string | null;
  LastName: string | null;
  FullName: string | null;
};










type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type CustomerContactRow = {
  ContactID: number | null;
  Title: string | null;
  LastName: string | null;
  FirstName: string | null;
  Position: string | null;
  CustomerName: string | null;
  Email: string | null;
  SecondEmail: string | null;
  Phone: string | null;
  Mobile: string | null;
  Importance: string | null;
  Enabled: boolean | number | null;
};

type CustomerContactRowWithCount = CustomerContactRow & { __totalCount: number | bigint | null };

const normalizeContactId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const collectContactIds = (values: unknown): number[] => {
  if (!Array.isArray(values)) return [];
  const normalized = new Set<number>();
  values.forEach((item) => {
    const id = normalizeContactId(item);
    if (id != null) {
      normalized.add(id);
    }
  });
  return Array.from(normalized);
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ContactID: "dbo.Contacts.ID",
  Title: "t.Name",
  LastName: "dbo.Contacts.LastName",
  FirstName: "dbo.Contacts.FirstName",
  Position: "dbo.Contacts.Position",
  CustomerName: "dbo.Customers.Name",
  Email: "dbo.Contacts.Email",
  SecondEmail: "dbo.Contacts.SecondEmail",
  Phone: "dbo.Contacts.Phone",
  Mobile: "dbo.Contacts.Mobile",
  Importance: "dbo.Contacts.Importance",
  Enabled: "dbo.Contacts.Enabled" };
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


const buildOrder = (sortModel: GridRequest["sortModel"]) => {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    return `${expression} ${s.sort.toUpperCase()}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
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

const normalizeCustomerId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  logRequest(_req, '/api/customers/[customerId]/contacts');
  try {
    const { customerId } = await params;
    const normalized = normalizeCustomerId(decodeURIComponent(customerId ?? ""));
    if (!normalized) {
      return NextResponse.json({ ok: false, error: "Invalid customer id" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("customerId", sql.Int, normalized);
    const result = await request.query<ContactRow>(`
      SELECT
        cnt.ID AS ContactID,
        cnt.FirstName,
        cnt.LastName,
        LTRIM(RTRIM(CONCAT(
          ISNULL(cnt.FirstName, ''),
          CASE WHEN cnt.FirstName IS NOT NULL AND cnt.LastName IS NOT NULL THEN ' ' ELSE '' END,
        ISNULL(cnt.LastName, '')
      ))) AS FullName
      FROM dbo.Contacts AS cnt
      WHERE cnt.CustomerID = @customerId
      ORDER BY cnt.LastName, cnt.FirstName
    `);

    const contacts = (result.recordset ?? []).map((contact) => {
      const full = contact.FullName?.trim();
      const fallback = [contact.FirstName, contact.LastName]
        .map((value) => value?.trim())
        .filter(Boolean)
        .join(" ");
      return {
        ContactID: contact.ContactID,
        FirstName: contact.FirstName,
        LastName: contact.LastName,
        FullName: full && full.length > 0 ? full : fallback || "Contact" };
    });

    return NextResponse.json({ ok: true, contacts });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  logRequest(req, '/api/customers/[customerId]/contacts');
  try {
    const { customerId } = await params;
    const normalized = normalizeCustomerId(decodeURIComponent(customerId ?? ""));
    if (!normalized) {
      return NextResponse.json({ ok: false, error: "Invalid customer id" }, { status: 400 });
    }

    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause =
      buildOrder(requestPayload.sortModel) || "ORDER BY dbo.Contacts.LastName, dbo.Contacts.FirstName";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Contacts.ID AS ContactID,
        t.Name AS Title,
        dbo.Contacts.LastName,
        dbo.Contacts.FirstName,
        dbo.Contacts.Position,
        dbo.Customers.Name AS CustomerName,
        dbo.Contacts.Email,
        dbo.Contacts.SecondEmail,
        dbo.Contacts.Phone,
        dbo.Contacts.Mobile,
        dbo.Contacts.Importance,
        dbo.Contacts.Enabled
      FROM dbo.Contacts
      INNER JOIN dbo.Customers ON dbo.Contacts.CustomerID = dbo.Customers.ID
      LEFT OUTER JOIN dbo.Titles AS t ON dbo.Contacts.TitleID = t.ID
    `;

    const appliedWhere = combineWhereClauses("WHERE dbo.Customers.ID = @__customerId", combinedWhere);
    const dataSql = `${select} ${appliedWhere} ${orderClause} ${paging}`;

    const pool = await getPool();
    const dataReq = pool.request();
    dataReq.input("__customerId", sql.Int, normalized);
    combinedParams.forEach((param) => dataReq.input(param.key, param.value));
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);

    const dataRes = await dataReq.query<CustomerContactRowWithCount>(dataSql);
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

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  logRequest(req, '/api/customers/[customerId]/contacts');
  try {
    const { customerId } = await params;
    const normalizedCustomerId = normalizeCustomerId(decodeURIComponent(customerId ?? ""));
    if (!normalizedCustomerId) {
      return NextResponse.json({ ok: false, error: "Invalid customer id" }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const ids = collectContactIds((body as { ContactIDs?: unknown } | null)?.ContactIDs ?? []);
    if (ids.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No contacts selected for deletion" },
        { status: 400 },
      );
    }

    const audit = buildAuditContext(req);
    const roles = await fetchUserRoles(audit.userId);
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
        request.input("__customerId", sql.Int, normalizedCustomerId);
        const placeholders: string[] = [];
        chunk.forEach((value, chunkIdx) => {
          const paramName = `contact_${chunkIdx}`;
          request.input(paramName, sql.Int, value);
          placeholders.push(`@${paramName}`);
        });
        const deleteSql = `
          DELETE FROM dbo.Contacts
          WHERE ID IN (${placeholders.join(", ")})
            AND CustomerID = @__customerId;
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
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
