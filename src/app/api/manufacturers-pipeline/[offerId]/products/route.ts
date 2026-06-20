import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../../../lib/apiHelpers";
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../../../lib/gridFilters";
import { requirePermission } from "../../../../../lib/authz";
import { KnownFilterModel } from "../../../../../lib/filterTypes";
import { processFilter } from "../../../../../lib/filterProcessing";
import { sqlBracketId, sqlSortDirection } from "../../../../../lib/sqlIdentifier";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type Payload = {
  request?: GridRequest;
  brandId?: number | string | null;
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  OfferDetailID: "od.ID",
  BrandName: "b.Name",
  PartNumber: "od.PartNumber",
  ModelNumber: "od.ModelNumber",
  Description: "od.ProductDescription",
  ListPrice: "od.ListPrice",
  CustomerDiscount: "od.CustomerDiscount",
  NetUnitPrice: "od.NetUnitPrice",
  Quantity: "od.Quantity",
  TotalPrice: "od.TotalPrice",
  TotalNet: "od.TotalNet",
  TotalCost: "od.TotalCost",
  TelmacoDiscount: "od.TelmacoDiscount",
  NetCost: "od.NetCost",
  Margin: "od.Margin",
  GrossProfit: "od.GrossProfit",
  Comment: "od.[Comment]",
  Delivery: "od.Delivery",
  Warranty: "od.Warranty",
  TelmacoWarranty: "od.TelmacoWarranty",
};

const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(
  ([colId, expression]) => ({ colId, expression }),
);

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];

  Object.entries(filterModel as Record<string, KnownFilterModel>).forEach(([col, fm], idx) => {
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

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "ORDER BY od.Ordering, od.ID";
  const parts = sortModel.map((entry) => {
    const expr = COLUMN_EXPRESSIONS[entry.colId] ?? sqlBracketId(entry.colId);
    return `${expr} ${sqlSortDirection(entry.sort)}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
}

function normalizeId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, "/api/manufacturers-pipeline/[offerId]/products");
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    const { offerId: rawOfferId } = await params;
    const offerId = normalizeId(rawOfferId);
    if (offerId == null) {
      return NextResponse.json({ ok: false, error: "Invalid offer ID" }, { status: 400 });
    }

    let payload: Payload = {};
    try {
      payload = (await req.json()) as Payload;
    } catch {
      /* noop */
    }

    const gridRequest: GridRequest = payload.request ?? { startRow: 0, endRow: 100 };
    const brandId = normalizeId(payload.brandId);
    if (brandId == null) {
      return NextResponse.json({ ok: true, rows: [], rowCount: 0 });
    }

    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = Math.max(0, startRow);

    const { where: filterWhere, params: filterParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(filterWhere, quickFilterClause.clause);
    const combinedParams = [...filterParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel);

    const baseWhere = `
      WHERE od.OfferID = @__offerId
        AND od.BrandID = @__brandId
        AND ISNULL(od.IsCategory, 0) = 0
        AND ISNULL(od.IsComment, 0) = 0
    `;
    const fullWhere = mergeWhereClauses(baseWhere, combinedWhere.replace(/^\s*WHERE\s+/i, "AND "));

    const query = `
      SELECT
        COUNT_BIG(1) OVER() AS __totalCount,
        od.ID AS OfferDetailID,
        b.Name AS BrandName,
        od.PartNumber,
        od.ModelNumber,
        od.ProductDescription AS Description,
        od.ListPrice,
        od.CustomerDiscount,
        od.NetUnitPrice,
        od.Quantity,
        od.TotalPrice,
        od.TotalNet,
        od.TotalCost,
        od.TelmacoDiscount,
        od.NetCost,
        od.Margin,
        od.GrossProfit,
        od.[Comment],
        od.Delivery,
        od.Warranty,
        od.TelmacoWarranty
      FROM dbo.OfferDetails od
        LEFT JOIN dbo.Brands b ON od.BrandID = b.ID
      ${fullWhere}
      ${orderClause}
      OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY
    `;

    const pool = await getPool();
    const dataReq = pool.request();
    combinedParams.forEach((p) => dataReq.input(p.key, p.value));
    dataReq.input("__offerId", sql.Int, offerId);
    dataReq.input("__brandId", sql.Int, brandId);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);

    const result = await dataReq.query<Record<string, unknown>>(query);
    const recordset = result.recordset ?? [];
    const rowCount = recordset.length > 0 ? Number(recordset[0].__totalCount ?? 0) : 0;
    const rows = recordset.map((row) => {
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
