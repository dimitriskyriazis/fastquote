import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../../lib/sql";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../../lib/gridFilters";
import { requirePermission } from "../../../../lib/authz";
import { KnownFilterModel } from "../../../../lib/filterTypes";
import { processFilter } from "../../../../lib/filterProcessing";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type BrandRow = {
  BrandID: number | null;
  Name: string | null;
  Enabled: boolean | number | null;
  Comment: string | null;
  SoftOneID: number | null;
  SoftOneCode: string | null;
};

type BrandRowWithCount = BrandRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  BrandID: "dbo.Brands.ID",
  Name: "dbo.Brands.Name",
  Enabled: "dbo.Brands.Enabled",
  Comment: "dbo.Brands.Comment",
  SoftOneID: "dbo.Brands.SoftOneID",
  SoftOneCode: "dbo.Brands.SoftOneCode",
};

const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

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
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const normalizedFilterModel = ensureEnabledFilterModel(gridRequest.filterModel);
    const { where, params: whereParams } = buildWhereAndParams(normalizedFilterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY dbo.Brands.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Brands.ID AS BrandID,
        dbo.Brands.Name,
        dbo.Brands.Enabled,
        dbo.Brands.Comment,
        dbo.Brands.SoftOneID,
        dbo.Brands.SoftOneCode
      FROM dbo.Brands
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
    const dataRes = await dataReq.query<BrandRowWithCount>(dataSql);

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
