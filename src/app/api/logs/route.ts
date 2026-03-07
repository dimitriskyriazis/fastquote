import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
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

type LogRow = {
  ID: number;
  Timestamp: string;
  Level: string;
  Message: string;
  Category: string | null;
  UserId: string | null;
  UserName: string | null;
  Method: string | null;
  Endpoint: string | null;
  RequestId: string | null;
  Details: string | null;
};

type LogRowWithCount = LogRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ID: "dbo.Logs.ID",
  Timestamp: "dbo.Logs.Timestamp",
  Level: "dbo.Logs.Level",
  Message: "dbo.Logs.Message",
  Category: "dbo.Logs.Category",
  UserId: "dbo.Logs.UserId",
  UserName: "dbo.Logs.UserName",
  Method: "dbo.Logs.Method",
  Endpoint: "dbo.Logs.Endpoint",
  RequestId: "dbo.Logs.RequestId",
  Details: "dbo.Logs.Details",
};

const QUICK_FILTER_COLUMNS = [
  { colId: "Message", expression: COLUMN_EXPRESSIONS.Message },
  { colId: "Endpoint", expression: COLUMN_EXPRESSIONS.Endpoint },
  { colId: "UserId", expression: COLUMN_EXPRESSIONS.UserId },
  { colId: "UserName", expression: COLUMN_EXPRESSIONS.UserName },
  { colId: "Category", expression: COLUMN_EXPRESSIONS.Category },
  { colId: "Level", expression: COLUMN_EXPRESSIONS.Level },
];

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

    const result = processFilter(fm, {
      columnExpression,
      columnId: col,
      paramBase: pBase,
      preserveTime: col === "Timestamp" && fm.filterType === "date",
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
  logRequest(req, '/api/logs');
  try {
    const auth = await requirePermission(req, "manageUsers");
    if (!auth.ok) return auth.response;

    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY dbo.Logs.Timestamp DESC";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Logs.ID,
        dbo.Logs.Timestamp,
        dbo.Logs.Level,
        dbo.Logs.Message,
        dbo.Logs.Category,
        dbo.Logs.UserId,
        dbo.Logs.UserName,
        dbo.Logs.Method,
        dbo.Logs.Endpoint,
        dbo.Logs.RequestId,
        dbo.Logs.Details
      FROM dbo.Logs
    `;

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => {
        if (param.key.startsWith("Timestamp")) {
          request.input(param.key, sql.DateTime2, param.value);
        } else {
          request.input(param.key, param.value);
        }
      });
      return request;
    };

    const dataSql = `${select} ${combinedWhere} ${orderClause} ${paging}`;
    const dataReq = bindParams(pool.request(), combinedParams);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    const dataRes = await dataReq.query<LogRowWithCount>(dataSql);

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
