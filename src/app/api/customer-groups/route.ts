import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
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
};

type QueryParam = { key: string; value: string | number | boolean };

type CustomerGroupRow = {
  Name: string | null;
  Enabled: boolean | number | null;
  CreatedOn: string | Date | null;
};

type CustomerGroupRowWithCount = CustomerGroupRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  Name: "dbo.CustomerGroups.Name",
  Enabled: "dbo.CustomerGroups.Enabled",
  CreatedOn: "dbo.CustomerGroups.CreatedOn",
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
        const val = String(fm.filter ?? "");
        if (!val) break;
        if (fm.type === "contains") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}%` });
        } else if (fm.type === "equals") {
          parts.push(`${columnExpression} = @${pBase}`);
          params.push({ key: pBase, value: val });
        } else if (fm.type === "startsWith") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `${val}%` });
        } else if (fm.type === "endsWith") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}` });
        }
        break;
      }
      case "number": {
        const val = fm.filter !== undefined ? Number(fm.filter) : Number.NaN;
        const valTo = fm.filterTo !== undefined ? Number(fm.filterTo) : undefined;
        if (Number.isNaN(val)) break;
        if (fm.type === "equals") parts.push(`${columnExpression} = @${pBase}`);
        if (fm.type === "notEqual") parts.push(`${columnExpression} <> @${pBase}`);
        if (fm.type === "lessThan") parts.push(`${columnExpression} < @${pBase}`);
        if (fm.type === "greaterThan") parts.push(`${columnExpression} > @${pBase}`);
        if (fm.type === "lessThanOrEqual") parts.push(`${columnExpression} <= @${pBase}`);
        if (fm.type === "greaterThanOrEqual") parts.push(`${columnExpression} >= @${pBase}`);
        if (fm.type === "inRange" && valTo !== undefined) {
          parts.push(`(${columnExpression} BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      case "set": {
        const rawValues = fm.values ?? [];
        if (rawValues.length === 0) break;
        const normalize = (value: string | number | boolean) => {
          if (value === true || value === "true") return 1;
          if (value === false || value === "false") return 0;
          return value;
        };
        const placeholders = rawValues.map((value, valueIdx) => {
          const key = `${pBase}_${valueIdx}`;
          params.push({ key, value: normalize(value) });
          return `@${key}`;
        });
        parts.push(`${columnExpression} IN (${placeholders.join(", ")})`);
        break;
      }
      case "date": {
        const val = fm.dateFrom || fm.filter;
        const valTo = fm.dateTo;
        if (!val) break;
        const dateExpression = `CAST(${columnExpression} AS date)`;
        if (fm.type === "equals") parts.push(`${dateExpression} = @${pBase}`);
        if (fm.type === "notEqual") parts.push(`${dateExpression} <> @${pBase}`);
        if (fm.type === "lessThan") parts.push(`${dateExpression} < @${pBase}`);
        if (fm.type === "greaterThan") parts.push(`${dateExpression} > @${pBase}`);
        if (fm.type === "lessThanOrEqual") parts.push(`${dateExpression} <= @${pBase}`);
        if (fm.type === "greaterThanOrEqual") parts.push(`${dateExpression} >= @${pBase}`);
        if (fm.type === "inRange" && valTo) {
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
    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const normalizedFilterModel = ensureEnabledFilterModel(requestPayload.filterModel);
    const { where, params: whereParams } = buildWhereAndParams(normalizedFilterModel);
    const orderClause = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.CustomerGroups.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.CustomerGroups.Name,
        dbo.CustomerGroups.Enabled,
        dbo.CustomerGroups.CreatedOn
      FROM dbo.CustomerGroups
      ${where}
      ${orderClause}
      ${paging}
    `;

    const pool = await getPool();
    const request = pool.request();
    whereParams.forEach((param) => request.input(param.key, param.value));
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
