import { NextRequest, NextResponse } from "next/server";
import { logRequest } from "../../../lib/apiHelpers";
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../lib/gridFilters";
import { requirePermission } from "../../../lib/authz";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type BrandOffersPayload = {
  request?: GridRequest;
  brandId?: number | string | null;
  view?: "summary" | "detail";
  offerId?: number | string | null;
};

// --- Summary view ---

const SUMMARY_COLUMN_EXPRESSIONS: Record<string, string> = {
  OfferID: "OfferID",
  Description: "Description",
  CustomerName: "CustomerName",
  Probability: "Probability",
  OfferDate: "OfferDate",
  PossibleOrderDate: "PossibleOrderDate",
  SalesMarket: "SalesMarket",
  SalesPerson: "SalesPerson",
  TotalOfferValue: "TotalOfferValue",
  TotalCostValue: "TotalCostValue",
  TotalListValue: "TotalListValue",
};

const SUMMARY_QUICK_FILTER_COLUMNS = Object.entries(SUMMARY_COLUMN_EXPRESSIONS).map(
  ([colId, expression]) => ({ colId, expression }),
);

// --- Detail view ---

const DETAIL_COLUMN_EXPRESSIONS: Record<string, string> = {
  OfferID: "o.ID",
  OfferDescription: "o.Description",
  CustomerName: "c.Name",
  Probability: "o.Probability",
  OfferDate: "o.OfferDate",
  PossibleOrderDate: "o.PossibleOrderDate",
  SalesMarket: "m.Name",
  SalesPerson: "u.FullName",
  ModelNumber: "od.ModelNumber",
  PartNumber: "od.PartNumber",
  Description: "od.ProductDescription",
  Quantity: "od.Quantity",
  TotalCost: "od.TotalCost",
  TotalList: "(od.ListPrice * od.Quantity)",
  TotalOffer: "od.TotalPrice",
};

const DETAIL_QUICK_FILTER_COLUMNS = Object.entries(DETAIL_COLUMN_EXPRESSIONS).map(
  ([colId, expression]) => ({ colId, expression }),
);

function buildWhereAndParams(
  filterModel: GridRequest["filterModel"],
  columnExpressions: Record<string, string>,
) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typed = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typed).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = columnExpressions[col] ?? `[${col}]`;

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

function buildOrder(
  sortModel: GridRequest["sortModel"],
  columnExpressions: Record<string, string>,
  defaultOrder: string,
) {
  if (!sortModel || sortModel.length === 0) return defaultOrder;
  const parts = sortModel.map((entry) => {
    const expr = columnExpressions[entry.colId] ?? `[${entry.colId}]`;
    return `${expr} ${entry.sort.toUpperCase()}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
}

function normalizeBrandId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
  paramsList.forEach((param) => request.input(param.key, param.value));
  return request;
};

export async function POST(req: NextRequest) {
  logRequest(req, "/api/manufacturers-pipeline");
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    let payload: BrandOffersPayload = {};
    try {
      payload = (await req.json()) as BrandOffersPayload;
    } catch {
      /* noop */
    }

    const gridRequest: GridRequest = payload.request ?? { startRow: 0, endRow: 100 };
    const brandId = normalizeBrandId(payload.brandId);
    const view = payload.view === "detail" ? "detail" : "summary";
    const offerId = normalizeBrandId(payload.offerId);

    if (brandId == null) {
      return NextResponse.json({ ok: true, rows: [], rowCount: 0 });
    }

    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = Math.max(0, startRow);

    const pool = await getPool();

    if (view === "summary") {
      // Summary: one row per offer, aggregates computed in CTE
      const { where: filterWhere, params: filterParams } = buildWhereAndParams(
        gridRequest.filterModel,
        SUMMARY_COLUMN_EXPRESSIONS,
      );
      const quickFilterClause = buildQuickFilterClause(
        gridRequest.quickFilterText,
        SUMMARY_QUICK_FILTER_COLUMNS,
      );
      const combinedWhere = mergeWhereClauses(filterWhere, quickFilterClause.clause);
      const combinedParams = [...filterParams, ...quickFilterClause.params];
      const orderClause = buildOrder(
        gridRequest.sortModel,
        SUMMARY_COLUMN_EXPRESSIONS,
        "ORDER BY OfferDate DESC",
      );
      const paging = "OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY";

      const query = `
        ;WITH OfferSummary AS (
          SELECT
            o.ID AS OfferID,
            o.Description,
            c.Name AS CustomerName,
            o.Probability,
            o.OfferDate,
            o.PossibleOrderDate,
            m.Name AS SalesMarket,
            u.FullName AS SalesPerson,
            SUM(ISNULL(od.TotalPrice, 0)) AS TotalOfferValue,
            SUM(ISNULL(od.TotalCost, 0)) AS TotalCostValue,
            SUM(ISNULL(od.ListPrice, 0) * ISNULL(od.Quantity, 0)) AS TotalListValue
          FROM dbo.OfferDetails od
            INNER JOIN dbo.Offer o ON od.OfferID = o.ID
            INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
            INNER JOIN dbo.Markets m ON o.MarketID = m.ID
            INNER JOIN dbo.AspNetUsers u ON o.SalesPersonId = u.Id
          WHERE od.BrandID = @__brandId
            AND o.Enabled = 1
            AND ISNULL(od.IsCategory, 0) = 0
            AND ISNULL(od.IsComment, 0) = 0
          GROUP BY o.ID, o.Description, c.Name, o.Probability,
                   o.OfferDate, o.PossibleOrderDate, m.Name, u.FullName
        )
        SELECT COUNT_BIG(1) OVER() AS __totalCount, *
        FROM OfferSummary
        ${combinedWhere}
        ${orderClause}
        ${paging}
      `;

      const dataReq = bindParams(pool.request(), combinedParams);
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
    }

    // Detail: one row per offer product line
    const { where: filterWhere, params: filterParams } = buildWhereAndParams(
      gridRequest.filterModel,
      DETAIL_COLUMN_EXPRESSIONS,
    );
    const quickFilterClause = buildQuickFilterClause(
      gridRequest.quickFilterText,
      DETAIL_QUICK_FILTER_COLUMNS,
    );
    const combinedWhere = mergeWhereClauses(filterWhere, quickFilterClause.clause);
    const combinedParams = [...filterParams, ...quickFilterClause.params];
    const orderClause = buildOrder(
      gridRequest.sortModel,
      DETAIL_COLUMN_EXPRESSIONS,
      "ORDER BY o.OfferDate DESC, o.ID, od.ID",
    );
    const paging = "OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY";

    const offerIdClause = offerId != null ? `AND o.ID = @__offerId` : "";
    const baseWhere = `
      WHERE od.BrandID = @__brandId
        AND o.Enabled = 1
        AND ISNULL(od.IsCategory, 0) = 0
        AND ISNULL(od.IsComment, 0) = 0
        ${offerIdClause}
    `;
    const fullWhere = mergeWhereClauses(baseWhere, combinedWhere.replace(/^\s*WHERE\s+/i, "AND "));

    const query = `
      SELECT
        COUNT_BIG(1) OVER() AS __totalCount,
        o.ID AS OfferID,
        o.Description AS OfferDescription,
        c.Name AS CustomerName,
        o.Probability,
        o.OfferDate,
        o.PossibleOrderDate,
        m.Name AS SalesMarket,
        u.FullName AS SalesPerson,
        od.ModelNumber,
        od.PartNumber,
        od.ProductDescription AS Description,
        od.Quantity,
        od.TotalCost,
        (ISNULL(od.ListPrice, 0) * ISNULL(od.Quantity, 0)) AS TotalList,
        od.TotalPrice AS TotalOffer
      FROM dbo.OfferDetails od
        INNER JOIN dbo.Offer o ON od.OfferID = o.ID
        INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
        INNER JOIN dbo.Markets m ON o.MarketID = m.ID
        INNER JOIN dbo.AspNetUsers u ON o.SalesPersonId = u.Id
      ${fullWhere}
      ${orderClause}
      ${paging}
    `;

    const dataReq = bindParams(pool.request(), combinedParams);
    dataReq.input("__brandId", sql.Int, brandId);
    if (offerId != null) dataReq.input("__offerId", sql.Int, offerId);
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
