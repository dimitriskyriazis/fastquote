import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import type { ConnectionPool, Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam } from "../../../lib/gridFilters";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";
import { BATCH_DELETE_SIZE } from '../../../lib/constants';
import { requirePermission } from "../../../lib/authz";
import { checkDeletePermission } from "../../../lib/deletePermissions";
import { toDropdownOptions, type DropdownOption } from "../../../lib/dropdownOptions";
import { IMPORTANCE_VALUES, fetchCustomers } from "../../customers/[customerId]/customerBasicDataLookups";


type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type ContactRow = {
  ContactID: number | null;
  Title: string | null;
  LastName: string | null;
  FirstName: string | null;
  Position: string | null;
  CustomerName: string | null;
  Email: string | null;
  EmailStatus: string | null;
  SecondEmail: string | null;
  SecondEmailStatus: string | null;
  Phone: string | null;
  Mobile: string | null;
  Importance: string | null;
  Enabled: boolean | number | null;
};

type ContactRowWithCount = ContactRow & { __totalCount: number | bigint | null };
type LookupRow = { ID: number | string | null; Name: string | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ContactID: "dbo.Contacts.ID",
  Title: "t.Name",
  LastName: "dbo.Contacts.LastName",
  FirstName: "dbo.Contacts.FirstName",
  Position: "dbo.Contacts.Position",
  CustomerName: "dbo.Customers.Name",
  Email: "dbo.Contacts.Email",
  EmailStatus: "es1.Name",
  SecondEmail: "dbo.Contacts.SecondEmail",
  SecondEmailStatus: "es2.Name",
  Phone: "dbo.Contacts.Phone",
  Mobile: "dbo.Contacts.Mobile",
  Importance: "dbo.Contacts.Importance",
  Enabled: "dbo.Contacts.Enabled" };
const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression }));

const ALLOWED_ROW_GROUP_FIELDS = new Set(["CustomerName", "Importance"]);

type ContactUpdateDefinition =
  | { kind: "contact-text"; column: string }
  | { kind: "contact-boolean"; column: string }
  | { kind: "status"; column: "EmailStatusID" | "SecondEmailStatusID" }
  | { kind: "customer-name" }
  | { kind: "title" };

const CONTACT_UPDATE_DEFINITIONS: Record<string, ContactUpdateDefinition> = {
  Title: { kind: "title" },
  LastName: { kind: "contact-text", column: "LastName" },
  FirstName: { kind: "contact-text", column: "FirstName" },
  Position: { kind: "contact-text", column: "Position" },
  CustomerName: { kind: "customer-name" },
  Email: { kind: "contact-text", column: "Email" },
  SecondEmail: { kind: "contact-text", column: "SecondEmail" },
  Phone: { kind: "contact-text", column: "Phone" },
  Mobile: { kind: "contact-text", column: "Mobile" },
  Importance: { kind: "contact-text", column: "Importance" },
  EmailStatus: { kind: "status", column: "EmailStatusID" },
  SecondEmailStatus: { kind: "status", column: "SecondEmailStatusID" },
  Enabled: { kind: "contact-boolean", column: "Enabled" } };

type ContactUpdateInput = {
  ContactID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedContactUpdate = {
  contactId: number;
  field: keyof typeof CONTACT_UPDATE_DEFINITIONS;
  value: unknown;
};

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

const IMPORTANCE_SORT_COLUMNS = new Set(["Importance"]);

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    if (IMPORTANCE_SORT_COLUMNS.has(s.colId)) {
      return `CASE ${expression} WHEN 'High' THEN 1 WHEN 'Med' THEN 2 WHEN 'Low' THEN 3 ELSE 4 END ${s.sort.toUpperCase()}`;
    }
    return `${expression} ${s.sort.toUpperCase()}`;
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
    const expression = COLUMN_EXPRESSIONS[candidate] ?? `[${candidate}]`;
    resolved.push({ field: candidate, expression });
  }
  return resolved;
};

const buildGroupKeyFilter = (fields: GroupField[], keys: Array<string | null>) => {
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  for (let idx = 0; idx < keys.length && idx < fields.length; idx += 1) {
    const key = keys[idx];
    const expression = fields[idx].expression;
    if (key === null) {
      clauses.push(`${expression} IS NULL`);
      continue;
    }
    const paramName = `__group_key_${idx}`;
    clauses.push(`${expression} = @${paramName}`);
    params.push({ key: paramName, value: key });
  }
  if (clauses.length === 0) {
    return { clause: "", params };
  }
  return { clause: `WHERE ${clauses.join(" AND ")}`, params };
};


const normalizeContactId = (value: unknown): number | null => {
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

const collectContactIds = (values: unknown): number[] => {
  if (!Array.isArray(values)) return [];
  const normalized = new Set<number>();
  values.forEach((value) => {
    const id = normalizeContactId(value);
    if (id != null) {
      normalized.add(id);
    }
  });
  return Array.from(normalized);
};

const fetchEmailStatuses = async (): Promise<string[]> => {
  const pool = await getPool();
  const result = await pool.request().query<{ Name: string | null }>(`
    SELECT Name
    FROM dbo.EmailStatuses
    ORDER BY Name
  `);
  const rows = result.recordset ?? [];
  const unique = new Set<string>();
  rows.forEach((row) => {
    const name = row.Name?.trim();
    if (name) unique.add(name);
  });
  return Array.from(unique);
};

const fetchTitles = async (): Promise<DropdownOption[]> => {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Titles
    ORDER BY Name
  `);
  return toDropdownOptions(result.recordset);
};

const normalizeStatusName = (value: unknown): string => {
  if (typeof value === "string") return value.trim();
  return "";
};

const resolveBooleanInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "1") return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
  }
  if (value === "true" || value === "Yes" || value === "YES") return true;
  return false;
};

class ContactUpdateError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
    this.name = "ContactUpdateError";
  }
}

const applyContactUpdate = async (
  pool: ConnectionPool,
  contactId: number,
  def: ContactUpdateDefinition,
  rawValue: unknown,
) => {
  if (def.kind === "contact-text") {
    const request = pool.request();
    request.input("contactId", sql.Int, contactId);
    request.input("value", sql.NVarChar, normalizeTextValue(rawValue));
    await request.query(`
      UPDATE dbo.Contacts
      SET ${def.column} = @value
      WHERE ID = @contactId
    `);
    return;
  }
  if (def.kind === "contact-boolean") {
    const request = pool.request();
    request.input("contactId", sql.Int, contactId);
    request.input("value", sql.Bit, resolveBooleanInput(rawValue) ? 1 : 0);
    await request.query(`
      UPDATE dbo.Contacts
      SET ${def.column} = @value
      WHERE ID = @contactId
    `);
    return;
  }
  if (def.kind === "status") {
    const statusName = normalizeStatusName(rawValue);
    let statusId: number | null = null;
    if (statusName) {
      const statusLookup = pool.request();
      statusLookup.input("statusName", sql.NVarChar, statusName);
      const statusResult = await statusLookup.query<{ ID: number }>(`
        SELECT TOP 1 ID
        FROM dbo.EmailStatuses
        WHERE Name = @statusName
        ORDER BY ID
      `);
      statusId = statusResult.recordset?.[0]?.ID ?? null;
      if (statusId == null) {
        throw new ContactUpdateError(`Email status "${statusName}" not found`, 400);
      }
    }
    const updateReq = pool.request();
    updateReq.input("contactId", sql.Int, contactId);
    updateReq.input("statusId", sql.Int, statusId);
    await updateReq.query(`
      UPDATE dbo.Contacts
      SET ${def.column} = @statusId
      WHERE ID = @contactId
    `);
    return;
  }
  if (def.kind === "title") {
    const titleName = normalizeTextValue(rawValue);
    let titleId: number | null = null;
    if (titleName) {
      const titleLookup = pool.request();
      titleLookup.input("titleName", sql.NVarChar, titleName);
      const titleResult = await titleLookup.query<{ ID: number }>(`
        SELECT TOP 1 ID
        FROM dbo.Titles
        WHERE Name = @titleName
        ORDER BY ID
      `);
      titleId = titleResult.recordset?.[0]?.ID ?? null;
      if (titleId == null) {
        throw new ContactUpdateError(`Title "${titleName}" not found`, 400);
      }
    }
    const updateReq = pool.request();
    updateReq.input("contactId", sql.Int, contactId);
    updateReq.input("titleId", sql.Int, titleId);
    await updateReq.query(`
      UPDATE dbo.Contacts
      SET TitleID = @titleId
      WHERE ID = @contactId
    `);
    return;
  }
  if (def.kind === "customer-name") {
    const request = pool.request();
    request.input("contactId", sql.Int, contactId);
    request.input("value", sql.NVarChar, normalizeTextValue(rawValue));
    await request.query(`
      UPDATE customers
      SET customers.Name = @value
      FROM dbo.Customers AS customers
      INNER JOIN dbo.Contacts AS contacts ON contacts.CustomerID = customers.ID
      WHERE contacts.ID = @contactId
    `);
  }
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/customer-contacts');
  try {
    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Contacts.ID AS ContactID,
        dbo.Contacts.CustomerID,
        t.Name AS Title,
        dbo.Contacts.LastName,
        dbo.Contacts.FirstName,
        dbo.Contacts.Position,
        dbo.Customers.Name AS CustomerName,
        dbo.Contacts.Email,
        es1.Name AS EmailStatus,
        dbo.Contacts.SecondEmail,
        es2.Name AS SecondEmailStatus,
        dbo.Contacts.Phone,
        dbo.Contacts.Mobile,
        dbo.Contacts.Importance,
        dbo.Contacts.Enabled
    `;

    const from = `
      FROM dbo.Contacts
      INNER JOIN dbo.Customers ON dbo.Contacts.CustomerID = dbo.Customers.ID
      LEFT OUTER JOIN dbo.Titles AS t ON dbo.Contacts.TitleID = t.ID
      LEFT OUTER JOIN dbo.EmailStatuses AS es1 ON dbo.Contacts.EmailStatusID = es1.ID
      LEFT OUTER JOIN dbo.EmailStatuses AS es2 ON dbo.Contacts.SecondEmailStatusID = es2.ID
    `;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause =
      buildOrder(requestPayload.sortModel) || "ORDER BY dbo.Contacts.LastName, dbo.Contacts.FirstName";
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
      const groupRes = await groupReq.query<{ GroupValue: string | null }>(groupSql);
      const rows = (groupRes.recordset ?? []).map((row) => {
        const value = row.GroupValue ?? null;
        return {
          group: true,
          key: value === null ? null : String(value),
          field: levelField.field,
          [levelField.field]: value };
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
    const dataRes = await dataReq.query<ContactRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row: ContactRowWithCount) => {
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

export async function GET(req: NextRequest) {
  logRequest(req, '/api/customer-contacts');
  try {
    const mode = req.nextUrl.searchParams.get("mode");
    if (mode !== "lookups") {
      return NextResponse.json({ ok: false, error: "Unsupported mode" }, { status: 400 });
    }

    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const [statuses, customers, titles] = await Promise.all([
      fetchEmailStatuses(),
      fetchCustomers(),
      fetchTitles(),
    ]);

    return NextResponse.json({
      ok: true,
      lookups: {
        statuses,
        customers,
        titles,
        importances: IMPORTANCE_VALUES,
      },
    });
  } catch (err) {
    console.error("Failed to load contact lookups", err);
    const message = err instanceof Error ? err.message : "Unable to load contact lookups.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/customer-contacts');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: ContactUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: ContactUpdateInput[] }).updates ?? [])
      : [];
    const normalized: NormalizedContactUpdate[] = updates
      .map((entry) => {
        const contactId = normalizeContactId(entry?.ContactID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (contactId == null || !field || !(field in CONTACT_UPDATE_DEFINITIONS)) {
          return null;
        }
        return {
          contactId,
          field: field as keyof typeof CONTACT_UPDATE_DEFINITIONS,
          value: entry?.value };
      })
      .filter((entry): entry is NormalizedContactUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    for (const entry of normalized) {
      const def = CONTACT_UPDATE_DEFINITIONS[entry.field];
      await applyContactUpdate(pool, entry.contactId, def, entry.value);
    }

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    console.error(err);
    if (err instanceof ContactUpdateError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/customer-contacts');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const ids = collectContactIds((body as { ContactIDs?: unknown } | null)?.ContactIDs ?? []);
    if (ids.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No contacts selected for deletion" },
        { status: 400 },
      );
    }

    const deleteCheck = checkDeletePermission(auth.roles, ids.length, 'generic', null);
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
          const paramName = `contact_${chunkIdx}`;
          request.input(paramName, sql.Int, value);
          placeholders.push(`@${paramName}`);
        });
        const deleteSql = `
          DELETE FROM dbo.Contacts
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
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
