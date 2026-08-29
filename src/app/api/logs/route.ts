import { NextRequest, NextResponse } from "next/server";
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


const COLUMN_EXPRESSIONS: Record<string, string> = {
  ID: "dbo.Logs.ID",
  Timestamp: "dbo.Logs.Timestamp",
  Level: "dbo.Logs.Level",
  Message: "dbo.Logs.Message",
  Category: "dbo.Logs.Category",
  UserId: "dbo.Logs.UserId",
  UserName: "u.UserName",
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
  try {
    const auth = await requirePermission(req, "manageUsers");
    if (!auth.ok) return auth.response;

    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    // No fuzzy variants here. They exist to forgive typos in names; on a
    // diagnostics grid you search for exact strings — an endpoint path, a request
    // id, an error message — so the swap/insertion/substitution patterns only add
    // false matches, and at 203k rows they cost ~30% of the search.
    const quickFilterClause = buildQuickFilterClause(
      gridRequest.quickFilterText,
      QUICK_FILTER_COLUMNS,
      undefined,
      { enableFuzzyText: false },
    );
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY dbo.Logs.Timestamp DESC";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    // No COUNT_BIG(1) OVER (): that windowed count made every page materialize all
    // 200k+ rows before returning, and because Details is an nvarchar(max) holding
    // ~110MB in total it dragged every log payload through the spool too. The
    // unfiltered first page went from 2.0s to 5ms once it was gone. End-of-data is
    // inferred the way the products grid does it — a full page means "there is
    // more" (len+1), a short page is the true end.
    const select = `
      SELECT
        dbo.Logs.ID,
        dbo.Logs.Timestamp,
        dbo.Logs.Level,
        dbo.Logs.Message,
        dbo.Logs.Category,
        dbo.Logs.UserId,
        u.UserName,
        dbo.Logs.Method,
        dbo.Logs.Endpoint,
        dbo.Logs.RequestId,
        dbo.Logs.Details
      FROM dbo.Logs
      LEFT JOIN dbo.AspNetUsers u ON u.Id = dbo.Logs.UserId
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
    const dataRes = await dataReq.query<LogRow>(dataSql);

    const rows = dataRes.recordset ?? [];
    const fetched = rows.length;
    const rowCount = fetched < pageSize ? offset + fetched : offset + fetched + 1;

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
