// app/api/offers/route.ts
import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';

type GridRequest = {
  startRow: number;
  endRow: number;
  filterModel?: Record<string, any>;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
  // rowGroupCols, pivotCols, etc. available if you enable them later
};

const config: sql.config = {
  server: process.env.SQLSERVER_HOST!,
  port: Number(process.env.SQLSERVER_PORT || 1433),
  database: process.env.SQLSERVER_DB!,
  user: process.env.SQLSERVER_USER!,
  password: process.env.SQLSERVER_PASSWORD!,
  options: { encrypt: false }, // set true if using Azure/SSL
  pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
};

// Map a basic AG Grid filter model to SQL WHERE snippets (parameterized)
function buildWhereAndParams(filterModel: GridRequest['filterModel']) {
  if (!filterModel || Object.keys(filterModel).length === 0) return { where: '', params: [] as { key: string; value: any }[] };

  const parts: string[] = [];
  const params: { key: string; value: any }[] = [];

  Object.entries(filterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    // Handle Text, Number, Date basic ops. Extend as you need (startsWith, endsWith, inRange, etc.)
    switch (fm.filterType) {
      case 'text': {
        const type = fm.type; // contains, equals, notEqual, startsWith, endsWith
        const val = String(fm.filter ?? '');
        if (!val) break;
        if (type === 'contains') {
          parts.push(`[${col}] LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}%` });
        } else if (type === 'equals') {
          parts.push(`[${col}] = @${pBase}`);
          params.push({ key: pBase, value: val });
        } else if (type === 'startsWith') {
          parts.push(`[${col}] LIKE @${pBase}`);
          params.push({ key: pBase, value: `${val}%` });
        } else if (type === 'endsWith') {
          parts.push(`[${col}] LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}` });
        }
        break;
      }
      case 'number': {
        const type = fm.type; // equals, notEqual, lessThan, greaterThan, inRange, etc.
        const val = Number(fm.filter);
        const valTo = fm.filterTo !== undefined ? Number(fm.filterTo) : undefined;
        if (Number.isNaN(val)) break;
        if (type === 'equals') parts.push(`[${col}] = @${pBase}`);
        if (type === 'notEqual') parts.push(`[${col}] <> @${pBase}`);
        if (type === 'lessThan') parts.push(`[${col}] < @${pBase}`);
        if (type === 'greaterThan') parts.push(`[${col}] > @${pBase}`);
        if (type === 'lessThanOrEqual') parts.push(`[${col}] <= @${pBase}`);
        if (type === 'greaterThanOrEqual') parts.push(`[${col}] >= @${pBase}`);
        if (type === 'inRange' && valTo !== undefined) {
          parts.push(`([${col}] BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      case 'date': {
        // Expecting YYYY-MM-DD from AG Grid date filter
        const type = fm.type;
        const val = fm.dateFrom || fm.filter;
        const valTo = fm.dateTo;
        if (!val) break;
        if (type === 'equals') parts.push(`CAST([${col}] AS date) = @${pBase}`);
        if (type === 'notEqual') parts.push(`CAST([${col}] AS date) <> @${pBase}`);
        if (type === 'lessThan') parts.push(`CAST([${col}] AS date) < @${pBase}`);
        if (type === 'greaterThan') parts.push(`CAST([${col}] AS date) > @${pBase}`);
        if (type === 'inRange' && valTo) {
          parts.push(`(CAST([${col}] AS date) BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      default:
        // Set/boolean filters etc. can be added here
        break;
    }
  });

  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  return { where, params };
}

function buildOrder(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  const parts = sortModel.map(s => `[${s.colId}] ${s.sort.toUpperCase()}`);
  return `ORDER BY ${parts.join(', ')}`;
}

export async function POST(req: NextRequest) {
  try {
    const { request } = (await req.json()) as { request: GridRequest };
    const startRow = request.startRow ?? 0;
    const endRow = request.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    // Base table & safe projection. Adjust fields to your schema (Offer table).
    // We alias datetime to ISO 8601 string for the grid.
    const select = `
      SELECT
        ID,
        OfferID,
        CustomerID,
        StatusID,
        Description,
        CreatedOn

      FROM [dbo].[Offer]
    `;

    const { where, params } = buildWhereAndParams(request.filterModel);
    const order = buildOrder(request.sortModel) || 'ORDER BY ID DESC'; // default sort
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const countSql = `SELECT COUNT(1) AS cnt FROM [dbo].[Offer] ${where}`;
    const dataSql = `${select} ${where} ${order} ${paging}`;

    const pool = await sql.connect(config);

    // Count
    const countReq = pool.request();
    params.forEach(p => countReq.input(p.key, p.value));
    const countRes = await countReq.query<{ cnt: number }>(countSql);
    const rowCount = countRes.recordset[0]?.cnt ?? 0;

    // Data
    const dataReq = pool.request();
    params.forEach(p => dataReq.input(p.key, p.value));
    dataReq.input('__offset', sql.Int, offset);
    dataReq.input('__limit', sql.Int, pageSize);
    const dataRes = await dataReq.query(dataSql);

    return NextResponse.json({ ok: true, rows: dataRes.recordset, rowCount });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json(
      { ok: false, error: err?.message || 'Server error' },
      { status: 500 }
    );
  }
}
