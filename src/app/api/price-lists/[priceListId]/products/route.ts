import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { buildTextMatchPredicate, isSensitiveColumn } from "../../../../../lib/gridFilters";

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

type KnownFilterModel =
  | TextFilterModel
  | NumberFilterModel
  | SetFilterModel
  | DateFilterModel;

type GridRequest = {
  startRow: number;
  endRow: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type QueryParam = { key: string; value: string | number | boolean };

type PriceListProductRow = {
  ProductID: number | null;
  Description: string | null;
  ListPrice: string | number | null;
  CostPrice: string | number | null;
  Warning: string | number | boolean | null;
  Enabled: boolean | number | null;
  PartNumber: string | null;
  ModelNumber: string | null;
  PriceListID: number | null;
  PriceListItemID: number | null;
};

type PriceListProductRowWithCount = PriceListProductRow & {
  __totalCount: number | bigint | null;
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ProductID: "dbo.Products.ID",
  Description: "dbo.Products.Description",
  ModelNumber: "dbo.Products.ModelNumber",
  ListPrice: "dbo.PriceListItems.ListPrice",
  // Display cost in EUR by applying the price list's currency cost modifier.
  // PriceListItems.CostPrice stores the supplier cost in the price list's cost currency.
  CostPrice: "(dbo.PriceListItems.CostPrice * COALESCE(pl.CurrencyCostModifier, 1))",
  Warning: "dbo.PriceListItems.Warning",
  Enabled: "dbo.PriceListItems.Enabled",
  PartNumber: "dbo.Products.PartNumber",
  PriceListID: "dbo.PriceListItems.PriceListID",
  PriceListItemID: "dbo.PriceListItems.ID",
};

// Normalize part/model numbers by removing special characters
const normalizePartModelNumber = (value: string): string => {
  // Remove common special characters: dashes, underscores, spaces, periods, etc.
  return value.replace(/[-_\s.]+/g, '');
};

// Helper to get the cleared column name for part/model numbers
// Uses the existing PartNumberCleared and ModelNumberCleared columns for better performance
const partModelNumberSql = (expr: string) => {
  // Replace PartNumber/ModelNumber with their cleared versions
  if (expr.includes('.PartNumber')) {
    return `ISNULL(${expr.replace('.PartNumber', '.PartNumberCleared')}, '')`;
  }
  if (expr.includes('.ModelNumber')) {
    return `ISNULL(${expr.replace('.ModelNumber', '.ModelNumberCleared')}, '')`;
  }
  // Fallback for edge cases
  return `ISNULL(${expr}, '')`;
};

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0)
    return { where: "", params: [] as QueryParam[] };

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    const isPartNumber = col === "PartNumber";
    const isModelNumber = col === "ModelNumber";
    const isPartOrModel = isPartNumber || isModelNumber;
    
    switch (fm.filterType) {
      case "text": {
        const type = fm.type;
        const val = String(fm.filter ?? "");
        if (!val) break;

        if (isPartOrModel) {
          // Normalize the search value for part/model numbers
          const normalizedVal = normalizePartModelNumber(val);
          const searchVal = normalizedVal;

          // Get the other field for cross-search (PartNumber <-> ModelNumber)
          const otherColumnExpression = isPartNumber
            ? COLUMN_EXPRESSIONS["ModelNumber"]
            : isModelNumber
            ? COLUMN_EXPRESSIONS["PartNumber"]
            : null;

          if (type === "contains") {
            if (otherColumnExpression) {
              // Cross-search: search both PartNumber and ModelNumber
              parts.push(
                `(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase})`,
              );
              params.push({ key: pBase, value: `%${searchVal}%` });
            } else {
              parts.push(`${partModelNumberSql(columnExpression)} LIKE @${pBase}`);
              params.push({ key: pBase, value: `%${searchVal}%` });
            }
          } else if (type === "equals") {
            if (otherColumnExpression) {
              // Cross-search: search both PartNumber and ModelNumber
              parts.push(
                `(${partModelNumberSql(columnExpression)} = @${pBase} OR ${partModelNumberSql(otherColumnExpression)} = @${pBase})`,
              );
              params.push({ key: pBase, value: searchVal });
            } else {
              parts.push(`${partModelNumberSql(columnExpression)} = @${pBase}`);
              params.push({ key: pBase, value: searchVal });
            }
          } else if (type === "startsWith") {
            if (otherColumnExpression) {
              // Cross-search: search both PartNumber and ModelNumber
              parts.push(
                `(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase})`,
              );
              params.push({ key: pBase, value: `${searchVal}%` });
            } else {
              parts.push(`${partModelNumberSql(columnExpression)} LIKE @${pBase}`);
              params.push({ key: pBase, value: `${searchVal}%` });
            }
          } else if (type === "endsWith") {
            if (otherColumnExpression) {
              // Cross-search: search both PartNumber and ModelNumber
              parts.push(
                `(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase})`,
              );
              params.push({ key: pBase, value: `%${searchVal}` });
            } else {
              parts.push(`${partModelNumberSql(columnExpression)} LIKE @${pBase}`);
              params.push({ key: pBase, value: `%${searchVal}` });
            }
          }
        } else {
          const mode = (type ?? "contains") as "contains" | "equals" | "startsWith" | "endsWith" | "notEqual";
          const { clause, params: clauseParams } = buildTextMatchPredicate(columnExpression, val, {
            paramKey: pBase,
            mode,
            enablePhonetic: !isSensitiveColumn(col),
          });
          parts.push(clause);
          clauseParams.forEach((p) => params.push(p));
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
    /* ignore */
  }
  return { startRow: 0, endRow: 100 };
}

type DeleteRequest = {
  PriceListItemIDs?: Array<number | string | null | undefined>;
};

const normalizePriceListItemId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  try {
    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? "")).trim();
    if (!normalizedId) {
      return NextResponse.json(
        { ok: false, error: "Missing price list id", rows: [], rowCount: 0 },
        { status: 400 },
      );
    }
    const idValue = Number(normalizedId);
    if (!Number.isFinite(idValue) || !Number.isInteger(idValue)) {
      return NextResponse.json(
        { ok: false, error: "Invalid price list id", rows: [], rowCount: 0 },
        { status: 400 },
      );
    }

    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = Math.max(0, startRow);

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Products.ID AS ProductID,
        dbo.Products.Description,
        dbo.Products.ModelNumber,
        dbo.PriceListItems.ListPrice,
        (dbo.PriceListItems.CostPrice * COALESCE(pl.CurrencyCostModifier, 1)) AS CostPrice,
        dbo.PriceListItems.Warning,
        dbo.PriceListItems.Enabled,
        dbo.Products.PartNumber,
        dbo.PriceListItems.ID AS PriceListItemID,
        dbo.PriceListItems.PriceListID
    `;

    const from = `
      FROM dbo.PriceListItems
      INNER JOIN dbo.PriceLists pl ON dbo.PriceListItems.PriceListID = pl.ID
      INNER JOIN dbo.Products ON dbo.PriceListItems.ProductID = dbo.Products.ID
    `;

    const baseWhere = "WHERE dbo.PriceListItems.PriceListID = @__priceListId";
    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const trimmedWhere = where.trim().replace(/^WHERE\s+/i, "");
    const combinedWhere = trimmedWhere
      ? `${baseWhere} AND ${trimmedWhere}`
      : baseWhere;
    const order = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.Products.Description";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const query = `${select} ${from} ${combinedWhere} ${order} ${paging}`;

    const pool = await getPool();
    const sqlRequest = pool.request();
    sqlRequest.input("__priceListId", sql.Int, idValue);
    whereParams.forEach((p) => sqlRequest.input(p.key, p.value));
    sqlRequest.input("__offset", sql.Int, offset);
    sqlRequest.input("__limit", sql.Int, pageSize);

    const result = await sqlRequest.query<PriceListProductRowWithCount>(query);
    const rowsWithCount = result.recordset ?? [];
    const rowCount =
      rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json(
      { ok: false, error: message, rows: [], rowCount: 0 },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  try {
    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? "")).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: "Missing price list id" }, { status: 400 });
    }
    const idValue = Number(normalizedId);
    if (!Number.isFinite(idValue) || !Number.isInteger(idValue)) {
      return NextResponse.json({ ok: false, error: "Invalid price list id" }, { status: 400 });
    }

    let body: DeleteRequest | null = null;
    try {
      body = (await req.json()) as DeleteRequest;
    } catch {
      body = null;
    }

    const rawIds = Array.isArray(body?.PriceListItemIDs) ? (body?.PriceListItemIDs ?? []) : [];
    const normalizedIds = Array.from(
      new Set(
        rawIds
          .map((value) => normalizePriceListItemId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows selected for deletion" }, { status: 400 });
    }

    const pool = await getPool();
    const chunkSize = 200;
    let deleted = 0;

    for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
      const chunk = normalizedIds.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;
      const request = pool.request();
      request.input("__priceListId", sql.Int, idValue);
      const paramNames: string[] = [];
      chunk.forEach((id, chunkIdx) => {
        const paramName = `pli_${chunkIdx}`;
        request.input(paramName, sql.Int, id);
        paramNames.push(`@${paramName}`);
      });
      const query = `
        DELETE FROM dbo.PriceListItems
        WHERE PriceListID = @__priceListId
          AND ID IN (${paramNames.join(", ")})
      `;
      const result = await request.query(query);
      deleted += result.rowsAffected?.[0] ?? 0;
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
