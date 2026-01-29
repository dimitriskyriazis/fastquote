import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";
import { buildQuickFilterClause, mergeWhereClauses, QueryParam } from "../../../lib/gridFilters";

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
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type GridRequestResult = {
  request: GridRequest;
  highlightProductId: number | null;
};

type ProductRow = {
  ProductID: number | null;
  Brand: string | null;
  ModelNumber: string | null;
  PartNumber: string | null;
  ERPCode: string | null;
  Description: string | null;
  Category: string | null;
  SubCategory: string | null;
  Type: string | null;
  WebLink: string | null;
};

type ProductRowWithCount = ProductRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ProductID: "dbo.Products.ID",
  Brand: "dbo.Brands.Name",
  ModelNumber: "dbo.Products.ModelNumber",
  PartNumber: "dbo.Products.PartNumber",
  ERPCode: "dbo.Products.ERPCode",
  Description: "dbo.Products.Description",
  Category: "dbo.ProductCategories.Name",
  SubCategory: "dbo.ProductSubCategories.Name",
  Type: "dbo.ProductTypes.Name",
  WebLink: "dbo.Products.WebLink",
};
const QUICK_FILTER_COLUMNS = Object.values(COLUMN_EXPRESSIONS);
const DEFAULT_PRODUCT_ORDER = "ORDER BY dbo.Brands.Name, dbo.Products.ModelNumber";

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const collectProductIds = (values: unknown): number[] => {
  if (!Array.isArray(values)) return [];
  const normalized = new Set<number>();
  values.forEach((value) => {
    const id = normalizeProductId(value);
    if (id != null) {
      normalized.add(id);
    }
  });
  return Array.from(normalized);
};

const PRODUCT_DELETE_BATCH = 200;

const ALLOWED_ROW_GROUP_FIELDS = new Set(["Brand", "Category", "SubCategory", "Type"]);

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
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

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
        
        // Normalize the search value for part/model numbers
        const normalizedVal = isPartOrModel ? normalizePartModelNumber(val) : val;
        const searchVal = normalizedVal;
        
        // Get the other field for cross-search (PartNumber <-> ModelNumber)
        const otherColumnExpression = isPartNumber 
          ? COLUMN_EXPRESSIONS["ModelNumber"] 
          : isModelNumber 
          ? COLUMN_EXPRESSIONS["PartNumber"] 
          : null;
        
        if (type === "contains") {
          if (isPartOrModel && otherColumnExpression) {
            // Cross-search: search both PartNumber and ModelNumber
            parts.push(`(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase})`);
            params.push({ key: pBase, value: `%${searchVal}%` });
          } else {
            const expr = isPartOrModel ? partModelNumberSql(columnExpression) : columnExpression;
            parts.push(`${expr} LIKE @${pBase}`);
            params.push({ key: pBase, value: `%${searchVal}%` });
          }
        } else if (type === "equals") {
          if (isPartOrModel && otherColumnExpression) {
            // Cross-search: search both PartNumber and ModelNumber
            parts.push(`(${partModelNumberSql(columnExpression)} = @${pBase} OR ${partModelNumberSql(otherColumnExpression)} = @${pBase})`);
            params.push({ key: pBase, value: searchVal });
          } else {
            const expr = isPartOrModel ? partModelNumberSql(columnExpression) : columnExpression;
            parts.push(`${expr} = @${pBase}`);
            params.push({ key: pBase, value: searchVal });
          }
        } else if (type === "startsWith") {
          if (isPartOrModel && otherColumnExpression) {
            // Cross-search: search both PartNumber and ModelNumber
            parts.push(`(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase})`);
            params.push({ key: pBase, value: `${searchVal}%` });
          } else {
            const expr = isPartOrModel ? partModelNumberSql(columnExpression) : columnExpression;
            parts.push(`${expr} LIKE @${pBase}`);
            params.push({ key: pBase, value: `${searchVal}%` });
          }
        } else if (type === "endsWith") {
          if (isPartOrModel && otherColumnExpression) {
            // Cross-search: search both PartNumber and ModelNumber
            parts.push(`(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase})`);
            params.push({ key: pBase, value: `%${searchVal}` });
          } else {
            const expr = isPartOrModel ? partModelNumberSql(columnExpression) : columnExpression;
            parts.push(`${expr} LIKE @${pBase}`);
            params.push({ key: pBase, value: `%${searchVal}` });
          }
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

const combineWhereClauses = (...clauses: Array<string | undefined>) => {
  const cleaned = clauses
    .map((clause) => clause?.trim())
    .filter((clause): clause is string => typeof clause === "string" && clause.length > 0)
    .map((clause) => clause.replace(/^\s*WHERE\s+/i, "").trim())
    .filter((clause) => clause.length > 0);
  if (cleaned.length === 0) return "";
  return `WHERE ${cleaned.join(" AND ")}`;
};

const resolveGroupingField = (rowGroupCols?: GridRequest["rowGroupCols"]) => {
  if (!Array.isArray(rowGroupCols) || rowGroupCols.length === 0) return null;
  const first = rowGroupCols[0];
  const candidate =
    (typeof first.field === "string" && first.field.length > 0 && first.field) ??
    (typeof first.colId === "string" && first.colId.length > 0 && first.colId) ??
    null;
  if (!candidate || !ALLOWED_ROW_GROUP_FIELDS.has(candidate)) return null;
  const expression = COLUMN_EXPRESSIONS[candidate] ?? `[${candidate}]`;
  return { field: candidate, expression };
};

const buildGroupKeyFilter = (field: { field: string; expression: string }, key: string | null) => {
  if (key === null) {
    return { clause: `WHERE ${field.expression} IS NULL`, params: [] as QueryParam[] };
  }
  return {
    clause: `WHERE ${field.expression} = @__group_key`,
    params: [{ key: "__group_key", value: key }],
  };
};

async function readGridRequest(req: NextRequest): Promise<GridRequestResult> {
  try {
    const payload = await req.json();
    const highlightProductId = normalizeProductId(
      payload && typeof payload === "object" ? (payload as { newProductId?: unknown }).newProductId ?? null : null,
    );
    if (payload && typeof payload === "object" && "request" in payload) {
      const inner = (payload as { request?: GridRequest }).request;
      if (inner && typeof inner === "object") {
        return { request: inner, highlightProductId };
      }
    }
    return { request: { startRow: 0, endRow: 100 }, highlightProductId };
  } catch {
    /* swallow, use defaults */
  }
  return { request: { startRow: 0, endRow: 100 }, highlightProductId: null };
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const ids = collectProductIds((body as { ProductIDs?: unknown } | null)?.ProductIDs ?? []);
    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No products selected for deletion" }, { status: 400 });
    }

    const pool = await getPool();
    let deleted = 0;

    for (let idx = 0; idx < ids.length; idx += PRODUCT_DELETE_BATCH) {
      const chunk = ids.slice(idx, idx + PRODUCT_DELETE_BATCH);
      if (chunk.length === 0) continue;
      const transaction = new sql.Transaction(pool);
      await transaction.begin();
      try {
        const request = transaction.request();
        const placeholders: string[] = [];
        chunk.forEach((value, chunkIdx) => {
          const paramName = `product_${chunkIdx}`;
          request.input(paramName, sql.Int, value);
          placeholders.push(`@${paramName}`);
        });
        const deleteSql = `
          DELETE FROM dbo.Products
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

export async function POST(req: NextRequest) {
  try {
    const { request: requestPayload, highlightProductId } = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Products.ID AS ProductID,
        dbo.Brands.Name AS Brand,
        dbo.Products.ModelNumber,
        dbo.Products.PartNumber,
        dbo.Products.ERPCode,
        dbo.Products.Description,
        dbo.ProductCategories.Name AS Category,
        dbo.ProductSubCategories.Name AS SubCategory,
        dbo.ProductTypes.Name AS Type,
        dbo.Products.WebLink
    `;

    const from = `
    FROM            
      dbo.ProductSubCategories RIGHT OUTER JOIN
      dbo.ProductCategories RIGHT OUTER JOIN
      dbo.ProductTypes RIGHT OUTER JOIN
      dbo.Brands INNER JOIN
      dbo.Products ON dbo.Brands.ID = dbo.Products.BrandID ON dbo.ProductTypes.ID = dbo.Products.TypeID ON dbo.ProductCategories.ID = dbo.Products.CategoryID ON 
      dbo.ProductSubCategories.ID = dbo.Products.SubCategoryID
    `;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const baseOrderClause = buildOrder(requestPayload.sortModel) || DEFAULT_PRODUCT_ORDER;
    const sanitizedOrderClause = baseOrderClause.replace(/^\s*ORDER BY\s+/i, "").trim();
    const fallbackOrderClause = sanitizedOrderClause.length > 0 ? sanitizedOrderClause : "dbo.Products.ID DESC";
    const highlightPrefix =
      highlightProductId != null ? "CASE WHEN dbo.Products.ID = @__highlightProductId THEN 0 ELSE 1 END, " : "";
    const orderClause = `ORDER BY ${highlightPrefix}${fallbackOrderClause}`;
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const groupingField = resolveGroupingField(requestPayload.rowGroupCols);
    const rawGroupKeys = Array.isArray(requestPayload.groupKeys) ? requestPayload.groupKeys : [];
    const groupKey = rawGroupKeys.length > 0 ? rawGroupKeys[0] : null;
    const parentFilter =
      groupingField && rawGroupKeys.length > 0
        ? buildGroupKeyFilter(groupingField, groupKey)
        : { clause: "", params: [] as QueryParam[] };
    const groupLevel = groupingField ? Math.min(rawGroupKeys.length, 1) : 0;

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    if (groupingField && groupLevel < 1) {
      const groupWhere = combineWhereClauses(combinedWhere, parentFilter.clause);

      const countReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${groupingField.expression}) AS __groupCount
        ${from}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(countSql);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      groupReq.input("__offset", sql.Int, offset);
      groupReq.input("__limit", sql.Int, pageSize);
      const groupSql = `
        SELECT DISTINCT ${groupingField.expression} AS GroupValue
        ${from}
        ${groupWhere}
        ORDER BY ${groupingField.expression}
        ${paging}
      `;
      const groupRes = await groupReq.query<{ GroupValue: string | null }>(groupSql);
      const groupRows = (groupRes.recordset ?? []).map((row) => {
        const value = row.GroupValue ?? null;
        return {
          group: true,
          key: value,
          field: groupingField.field,
          [groupingField.field]: value,
        };
      });

      return NextResponse.json({ ok: true, rows: groupRows, rowCount: totalGroupCount });
    }

    const appliedWhere = combineWhereClauses(combinedWhere, parentFilter.clause);
    const appliedParams = [...combinedParams, ...parentFilter.params];
    const dataSql = `${select} ${from} ${appliedWhere} ${orderClause} ${paging}`;

    const dataReq = bindParams(pool.request(), appliedParams);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    if (highlightProductId != null) {
      dataReq.input("__highlightProductId", sql.Int, highlightProductId);
    }
    const dataRes = await dataReq.query<ProductRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount =
      rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : rowsWithCount.length;
    const rows = rowsWithCount.map((row) => {
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
