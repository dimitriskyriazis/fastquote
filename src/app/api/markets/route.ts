import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import type { ConnectionPool, Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";

type TextFilterModel = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith";
  filter?: string;
};

type SetFilterModel = {
  filterType: "set";
  values?: Array<string | number | boolean>;
};

type KnownFilterModel = TextFilterModel | SetFilterModel;

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type QueryParam = { key: string; value: string | number | boolean };

type MarketRow = {
  MarketID: number | null;
  Name: string | null;
  SalesDivision: string | null;
  Enabled: boolean | number | null;
};

type MarketRowWithCount = MarketRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  MarketID: "dbo.Markets.ID",
  Name: "dbo.Markets.Name",
  SalesDivision: "dbo.SalesDivision.Name",
  Enabled: "dbo.Markets.Enabled",
};

const ALLOWED_ROW_GROUP_FIELDS = new Set(["SalesDivision"]);

type MarketUpdateInput = {
  MarketID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedMarketUpdate = {
  marketId: number;
  field: "Name" | "SalesDivision" | "Enabled";
  value: unknown;
};

class MarketUpdateError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "MarketUpdateError";
    this.status = status;
  }
}

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typed = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typed).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    if (fm.filterType === "text") {
      const val = String((fm as TextFilterModel).filter ?? "");
      if (!val) return;
      const type = (fm as TextFilterModel).type;
      if (type === "equals") {
        parts.push(`${columnExpression} = @${pBase}`);
        params.push({ key: pBase, value: val });
      } else if (type === "startsWith") {
        parts.push(`${columnExpression} LIKE @${pBase}`);
        params.push({ key: pBase, value: `${val}%` });
      } else if (type === "endsWith") {
        parts.push(`${columnExpression} LIKE @${pBase}`);
        params.push({ key: pBase, value: `%${val}` });
      } else {
        parts.push(`${columnExpression} LIKE @${pBase}`);
        params.push({ key: pBase, value: `%${val}%` });
      }
    } else if (fm.filterType === "set") {
      const values = Array.isArray(fm.values) ? fm.values : [];
      if (values.length === 0) return;
      const placeholders = values.map((value, valueIdx) => {
        const key = `${pBase}_${valueIdx}`;
        params.push({ key, value });
        return `@${key}`;
      });
      parts.push(`${columnExpression} IN (${placeholders.join(", ")})`);
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
    const expr = COLUMN_EXPRESSIONS[entry.colId] ?? `[${entry.colId}]`;
    return `${expr} ${entry.sort.toUpperCase()}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
}

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

const normalizeMarketId = (value: unknown): number | null => {
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
    if (["false", "no", "n", "0"].includes(normalized)) return false;
  }
  return false;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const applyMarketUpdate = async (
  pool: ConnectionPool,
  update: NormalizedMarketUpdate,
) => {
  if (update.field === "Name") {
    const request = pool.request();
    request.input("marketId", sql.Int, update.marketId);
    request.input("value", sql.NVarChar, normalizeTextValue(update.value));
    await request.query(`
      UPDATE dbo.Markets
      SET Name = @value
      WHERE ID = @marketId
    `);
    return;
  }
  if (update.field === "Enabled") {
    const request = pool.request();
    request.input("marketId", sql.Int, update.marketId);
    request.input("value", sql.Bit, normalizeBooleanInput(update.value) ? 1 : 0);
    await request.query(`
      UPDATE dbo.Markets
      SET Enabled = @value
      WHERE ID = @marketId
    `);
    return;
  }
  const desiredDivision = normalizeTextValue(update.value);
  if (!desiredDivision) {
    const request = pool.request();
    request.input("marketId", sql.Int, update.marketId);
    request.input("divisionId", sql.Int, null);
    await request.query(`
      UPDATE dbo.Markets
      SET SalesDivisionID = @divisionId
      WHERE ID = @marketId
    `);
    return;
  }
  const lookup = pool.request();
  lookup.input("divisionName", sql.NVarChar, desiredDivision);
  const lookupResult = await lookup.query<{ ID: number }>(`
    SELECT TOP 1 ID
    FROM dbo.SalesDivision
    WHERE Name = @divisionName
    ORDER BY ID
  `);
  const divisionId = lookupResult.recordset?.[0]?.ID ?? null;
  if (divisionId == null) {
    throw new MarketUpdateError(`Sales division "${desiredDivision}" not found`, 400);
  }
  const request = pool.request();
  request.input("marketId", sql.Int, update.marketId);
  request.input("divisionId", sql.Int, divisionId);
  await request.query(`
    UPDATE dbo.Markets
    SET SalesDivisionID = @divisionId
    WHERE ID = @marketId
  `);
};
type GroupField = {
  field: string;
  expression: string;
};

const resolveGroupingFields = (rowGroupCols?: GridRequest["rowGroupCols"]): GroupField[] => {
  if (!Array.isArray(rowGroupCols) || rowGroupCols.length === 0) return [];
  const results: GroupField[] = [];
  for (const col of rowGroupCols) {
    const candidate =
      (typeof col.field === "string" && col.field.length > 0 && col.field) ??
      (typeof col.colId === "string" && col.colId.length > 0 && col.colId) ??
      null;
    if (!candidate || !ALLOWED_ROW_GROUP_FIELDS.has(candidate)) {
      return [];
    }
    const expression = COLUMN_EXPRESSIONS[candidate] ?? `[${candidate}]`;
    results.push({ field: candidate, expression });
  }
  return results;
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

const buildGroupKeyFilter = (fields: GroupField[], keys: Array<string | null>) => {
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  keys.slice(0, fields.length).forEach((key, idx) => {
    const expression = fields[idx].expression;
    if (key === null) {
      clauses.push(`${expression} IS NULL`);
      return;
    }
    const paramName = `__group_key_${idx}`;
    clauses.push(`${expression} = @${paramName}`);
    params.push({ key: paramName, value: key });
  });
  if (clauses.length === 0) return { clause: "", params };
  return { clause: `WHERE ${clauses.join(" AND ")}`, params };
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
  try {
    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const normalizedFilterModel = ensureEnabledFilterModel(gridRequest.filterModel);
    const { where, params: whereParams } = buildWhereAndParams(normalizedFilterModel);
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY dbo.Markets.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Markets.ID AS MarketID,
        dbo.Markets.Name,
        dbo.SalesDivision.Name AS SalesDivision,
        dbo.Markets.Enabled
      FROM dbo.Markets
      INNER JOIN dbo.SalesDivision ON dbo.Markets.SalesDivisionID = dbo.SalesDivision.ID
    `;

    const groupingFields = resolveGroupingFields(gridRequest.rowGroupCols);
    const groupKeys = Array.isArray(gridRequest.groupKeys) ? gridRequest.groupKeys : [];
    const parentFilter =
      groupingFields.length > 0 ? buildGroupKeyFilter(groupingFields, groupKeys) : { clause: "", params: [] };
    const groupLevel = Math.min(groupKeys.length, groupingFields.length);

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    if (groupingFields.length > 0 && groupLevel < groupingFields.length) {
      const levelField = groupingFields[groupLevel];
      const groupWhere = combineWhereClauses(where, parentFilter.clause);

      const countReq = bindParams(pool.request(), [...whereParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${levelField.expression}) AS __groupCount
        ${select.replace(/SELECT[\s\S]+?FROM/, "FROM")}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(countSql);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...whereParams, ...parentFilter.params]);
      groupReq.input("__offset", sql.Int, offset);
      groupReq.input("__limit", sql.Int, pageSize);
      const groupSql = `
        SELECT DISTINCT ${levelField.expression} AS GroupValue
        ${select.replace(/SELECT[\s\S]+?FROM/, "FROM")}
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

    const appliedWhere = combineWhereClauses(where, parentFilter.clause);
    const appliedParams = [...whereParams, ...parentFilter.params];

    const dataSql = `${select} ${appliedWhere} ${orderClause} ${paging}`;
    const dataReq = bindParams(pool.request(), appliedParams);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    const dataRes = await dataReq.query<MarketRowWithCount>(dataSql);

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

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: MarketUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: MarketUpdateInput[] }).updates ?? [])
      : [];
    const normalized: NormalizedMarketUpdate[] = updates
      .map((entry) => {
        const marketId = normalizeMarketId(entry?.MarketID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (
          marketId == null ||
          !field ||
          (field !== "Name" && field !== "SalesDivision" && field !== "Enabled")
        ) {
          return null;
        }
        return {
          marketId,
          field,
          value: entry?.value,
        } as NormalizedMarketUpdate;
      })
      .filter((entry): entry is NormalizedMarketUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    for (const entry of normalized) {
      await applyMarketUpdate(pool, entry);
    }

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    console.error(err);
    if (err instanceof MarketUpdateError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
