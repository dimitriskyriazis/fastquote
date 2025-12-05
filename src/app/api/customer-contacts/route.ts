import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import type { ConnectionPool, Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";

type TextFilterModel = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith";
  filter?: string;
};

type NumberFilterModel = {
  filterType: "number";
  type?:
    | "equals"
    | "notEqual"
    | "lessThan"
    | "greaterThan"
    | "lessThanOrEqual"
    | "greaterThanOrEqual"
    | "inRange";
  filter?: number;
  filterTo?: number;
};

type SetFilterModel = {
  filterType: "set";
  values?: Array<string | number | boolean>;
};

type DateFilterModel = {
  filterType: "date";
  type?:
    | "equals"
    | "notEqual"
    | "lessThan"
    | "greaterThan"
    | "lessThanOrEqual"
    | "greaterThanOrEqual"
    | "inRange";
  dateFrom?: string;
  dateTo?: string;
  filter?: string;
};

type KnownFilterModel = TextFilterModel | NumberFilterModel | SetFilterModel | DateFilterModel;

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type QueryParam = { key: string; value: string | number | boolean };

type ContactRow = {
  ContactID: number | null;
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

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ContactID: "dbo.Contacts.ID",
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
  Enabled: "dbo.Contacts.Enabled",
};

const ALLOWED_ROW_GROUP_FIELDS = new Set(["CustomerName", "Importance"]);

type ContactUpdateDefinition =
  | { kind: "contact-text"; column: string }
  | { kind: "contact-boolean"; column: string }
  | { kind: "status"; column: "EmailStatusID" | "SecondEmailStatusID" }
  | { kind: "customer-name" };

const CONTACT_UPDATE_DEFINITIONS: Record<string, ContactUpdateDefinition> = {
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
  Enabled: { kind: "contact-boolean", column: "Enabled" },
};

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

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    switch (fm.filterType) {
      case "text": {
        const type = fm.type;
        const val = String(fm.filter ?? "");
        if (!val) break;
        if (type === "contains") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}%` });
        } else if (type === "equals") {
          parts.push(`${columnExpression} = @${pBase}`);
          params.push({ key: pBase, value: val });
        } else if (type === "startsWith") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `${val}%` });
        } else if (type === "endsWith") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}` });
        }
        break;
      }
      case "number": {
        const type = fm.type;
        const val = fm.filter !== undefined ? Number(fm.filter) : Number.NaN;
        const valTo = fm.filterTo !== undefined ? Number(fm.filterTo) : undefined;
        if (Number.isNaN(val)) break;
        if (type === "equals") parts.push(`${columnExpression} = @${pBase}`);
        if (type === "notEqual") parts.push(`${columnExpression} <> @${pBase}`);
        if (type === "lessThan") parts.push(`${columnExpression} < @${pBase}`);
        if (type === "greaterThan") parts.push(`${columnExpression} > @${pBase}`);
        if (type === "lessThanOrEqual") parts.push(`${columnExpression} <= @${pBase}`);
        if (type === "greaterThanOrEqual") parts.push(`${columnExpression} >= @${pBase}`);
        if (type === "inRange" && valTo !== undefined) {
          parts.push(`(${columnExpression} BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      case "set": {
        const rawValues = fm.values ?? [];
        if (rawValues.length === 0) break;

        const placeholders = rawValues.map((value, valueIdx) => {
          const key = `${pBase}_${valueIdx}`;
          params.push({ key, value });
          return `@${key}`;
        });
        parts.push(`${columnExpression} IN (${placeholders.join(", ")})`);
        break;
      }
      case "date": {
        const type = fm.type;
        const val = fm.dateFrom || fm.filter;
        const valTo = fm.dateTo;
        if (!val) break;
        const dateExpression = `CAST(${columnExpression} AS date)`;
        if (type === "equals") parts.push(`${dateExpression} = @${pBase}`);
        if (type === "notEqual") parts.push(`${dateExpression} <> @${pBase}`);
        if (type === "lessThan") parts.push(`${dateExpression} < @${pBase}`);
        if (type === "greaterThan") parts.push(`${dateExpression} > @${pBase}`);
        if (type === "lessThanOrEqual") parts.push(`${dateExpression} <= @${pBase}`);
        if (type === "greaterThanOrEqual") parts.push(`${dateExpression} >= @${pBase}`);
        if (type === "inRange" && valTo) {
          parts.push(`(${dateExpression} BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      default:
        break;
    }
  });

  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return { where, params };
}

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
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

const ensureEnabledFilterModel = (
  filterModel: GridRequest["filterModel"],
): Record<string, KnownFilterModel> => {
  const base =
    (filterModel && typeof filterModel === "object" ? { ...filterModel } : {}) as Record<
      string,
      KnownFilterModel
    >;
  if ("Enabled" in base) {
    return base;
  }
  base.Enabled = { filterType: "set", values: ["true"] };
  return base;
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
      LEFT OUTER JOIN dbo.EmailStatuses AS es1 ON dbo.Contacts.EmailStatusID = es1.ID
      LEFT OUTER JOIN dbo.EmailStatuses AS es2 ON dbo.Contacts.SecondEmailStatusID = es2.ID
    `;

    const normalizedFilterModel = ensureEnabledFilterModel(requestPayload.filterModel);
    const { where, params: whereParams } = buildWhereAndParams(normalizedFilterModel);
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
      const groupWhere = combineWhereClauses(where, parentFilter.clause);
      const levelField = groupingFields[groupLevel];

      const countReq = bindParams(pool.request(), [...whereParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${levelField.expression}) AS __groupCount
        ${from}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(countSql);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...whereParams, ...parentFilter.params]);
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
          [levelField.field]: value,
        };
      });

      return NextResponse.json({ ok: true, rows, rowCount: totalGroupCount });
    }

    const appliedWhere = groupingFields.length > 0 ? combineWhereClauses(where, parentFilter.clause) : where;
    const appliedParams = [...whereParams, ...parentFilter.params];

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

export async function PATCH(req: NextRequest) {
  try {
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
          value: entry?.value,
        };
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
