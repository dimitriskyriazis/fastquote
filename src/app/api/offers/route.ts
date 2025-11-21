import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';

type TextFilterModel = {
  filterType: 'text';
  type?: 'contains' | 'equals' | 'notEqual' | 'startsWith' | 'endsWith';
  filter?: string;
};

type NumberFilterModel = {
  filterType: 'number';
  type?:
    | 'equals'
    | 'notEqual'
    | 'lessThan'
    | 'greaterThan'
    | 'lessThanOrEqual'
    | 'greaterThanOrEqual'
    | 'inRange';
  filter?: number;
  filterTo?: number;
};

type SetFilterModel = {
  filterType: 'set';
  values?: Array<string | number | boolean>;
};

/*
Not using dates yet
type DateFilterModel = {
  filterType: 'date';
  type?: 'equals' | 'notEqual' | 'lessThan' | 'greaterThan' | 'inRange';
  dateFrom?: string;
  dateTo?: string;
  filter?: string;
};
*/

type KnownFilterModel = TextFilterModel | NumberFilterModel | SetFilterModel; 
// | DateFilterModel;

type GridRequest = {
  startRow: number;
  endRow: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
  // rowGroupCols, pivotCols, etc. available if enabling them later
};

type DeleteRequest = {
  OfferIDs?: Array<number | string | null | undefined>;
};

type QueryParam = { key: string; value: string | number | boolean };

type OfferRow = {
  Description: string | null;
  Title: string | null;
  CustomerName: string | null;
  PricingPolicyName: string | null;
  SalesMarket: string | null;
  SalesDivision: string | null;
  SalesPerson: string | null;
  OfferStatus: string | null;
  ProjectID: number | null;
  oID: number | null;
  CustomerRef: string | null;
  ProtocolNo: number | null;
  OfferContact: string | null;
  OfferVersion: number | null;
  Enabled: boolean | number | null;
};

type OfferRowWithCount = OfferRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  Description: 'dbo.Offer.Description',
  Title: 'dbo.Offer.Title',
  CustomerName: 'dbo.Customers.Name',
  PricingPolicyName: 'dbo.PricingPolicies.Name',
  SalesMarket: 'dbo.Markets.Name',
  SalesDivision: 'dbo.SalesDivision.Name',
  SalesPerson: 'dbo.AspNetUsers.FullName',
  OfferStatus: 'dbo.OfferStatus.Name',
  ProjectID: 'dbo.Offer.ProjectID',
  oID: 'dbo.Offer.ID',
  CustomerRef: 'dbo.Offer.CustomerRef',
  ProtocolNo: 'dbo.Offer.ProtocolNo',
  OfferContact: 'dbo.Offer.OfferContact',
  OfferVersion: 'dbo.Offer.OfferVersion',
  Enabled: 'dbo.Offer.Enabled',
};

// Map a basic AG Grid filter model to SQL WHERE snippets (parameterized)
function buildWhereAndParams(filterModel: GridRequest['filterModel']) {
  if (!filterModel || Object.keys(filterModel).length === 0) return { where: '', params: [] as QueryParam[] };

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    // Handle Text, Number, Date basic ops
    switch (fm.filterType) {
      case 'text': {
        const type = fm.type; // contains, equals, notEqual, startsWith, endsWith
        const val = String(fm.filter ?? '');
        if (!val) break;
        if (type === 'contains') {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}%` });
        } else if (type === 'equals') {
          parts.push(`${columnExpression} = @${pBase}`);
          params.push({ key: pBase, value: val });
        } else if (type === 'startsWith') {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `${val}%` });
        } else if (type === 'endsWith') {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}` });
        }
        break;
      }
      case 'number': {
        const type = fm.type; // equals, notEqual, lessThan, greaterThan, inRange, etc.
        const val = fm.filter !== undefined ? Number(fm.filter) : Number.NaN;
        const valTo = fm.filterTo !== undefined ? Number(fm.filterTo) : undefined;
        if (Number.isNaN(val)) break;
        if (type === 'equals') parts.push(`${columnExpression} = @${pBase}`);
        if (type === 'notEqual') parts.push(`${columnExpression} <> @${pBase}`);
        if (type === 'lessThan') parts.push(`${columnExpression} < @${pBase}`);
        if (type === 'greaterThan') parts.push(`${columnExpression} > @${pBase}`);
        if (type === 'lessThanOrEqual') parts.push(`${columnExpression} <= @${pBase}`);
        if (type === 'greaterThanOrEqual') parts.push(`${columnExpression} >= @${pBase}`);
        if (type === 'inRange' && valTo !== undefined) {
          parts.push(`(${columnExpression} BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      case 'set': {
        const rawValues = fm.values ?? [];
        if (rawValues.length === 0) break;

        const normalize = (value: string | number | boolean) => {
          if (value === true || value === 'true') return 1;
          if (value === false || value === 'false') return 0;
          return value;
        };

        const placeholders = rawValues.map((value, valueIdx) => {
          const key = `${pBase}_${valueIdx}`;
          params.push({ key, value: normalize(value) });
          return `@${key}`;
        });

        parts.push(`${columnExpression} IN (${placeholders.join(', ')})`);
        break;
      }

      /*
      Not using dates yet
      case 'date': {
        // Expecting YYYY-MM-DD from AG Grid date filter
        const type = fm.type;
        const val = fm.dateFrom || fm.filter;
        const valTo = fm.dateTo;
        if (!val) break;
        if (type === 'equals') parts.push(`CAST(${columnExpression} AS date) = @${pBase}`);
        if (type === 'notEqual') parts.push(`CAST(${columnExpression} AS date) <> @${pBase}`);
        if (type === 'lessThan') parts.push(`CAST(${columnExpression} AS date) < @${pBase}`);
        if (type === 'greaterThan') parts.push(`CAST(${columnExpression} AS date) > @${pBase}`);
        if (type === 'inRange' && valTo) {
          parts.push(`(CAST(${columnExpression} AS date) BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      default:
        // Additional filter types can be handled here
        break;
      */
    }
  });

  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  return { where, params };
}

function buildOrder(sortModel: GridRequest['sortModel']) {
  if (!sortModel || sortModel.length === 0) return '';
  const parts = sortModel.map(s => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    return `${expression} ${s.sort.toUpperCase()}`;
  });
  return `ORDER BY ${parts.join(', ')}`;
}

async function readGridRequest(req: NextRequest): Promise<GridRequest> {
  try {
    const payload = await req.json();
    if (payload && typeof payload === 'object' && 'request' in payload) {
      const inner = (payload as { request?: GridRequest }).request;
      if (inner && typeof inner === 'object') return inner;
    }
  } catch {
    /* no-op, will fall back to defaults */
  }
  return { startRow: 0, endRow: 100 };
}

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function POST(req: NextRequest) {
  try {
    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;


    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Offer.ID AS OfferPK,
        dbo.Offer.Description,
        dbo.Offer.Title,
        dbo.Customers.Name AS CustomerName,
        dbo.PricingPolicies.Name AS PricingPolicyName,
        dbo.Markets.Name AS SalesMarket,
        dbo.SalesDivision.Name AS SalesDivision,
        dbo.AspNetUsers.FullName AS SalesPerson,
        dbo.OfferStatus.Name AS OfferStatus,
        dbo.Offer.ProjectID,
        dbo.Offer.ID AS oID,
        dbo.Offer.CustomerRef,
        dbo.Offer.ProtocolNo,
        dbo.Offer.OfferContact,
        dbo.Offer.OfferVersion,
        dbo.Offer.Enabled
    `;

    const from = `
      FROM
        dbo.Offer
        INNER JOIN dbo.Customers ON dbo.Offer.CustomerID = dbo.Customers.ID
        INNER JOIN dbo.PricingPolicies ON dbo.Offer.PricingPolicyID = dbo.PricingPolicies.ID
        INNER JOIN dbo.Markets ON dbo.Offer.MarketID = dbo.Markets.ID
        INNER JOIN dbo.SalesDivision ON dbo.Offer.SalesDivitionID = dbo.SalesDivision.ID
        INNER JOIN dbo.AspNetUsers ON dbo.Offer.SalesPersonId = dbo.AspNetUsers.Id
        INNER JOIN dbo.OfferStatus ON dbo.Offer.StatusID = dbo.OfferStatus.ID
    `;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const order = buildOrder(requestPayload.sortModel) || 'ORDER BY dbo.Offer.Description'; // default sort
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const dataSql = `${select} ${from} ${where} ${order} ${paging}`;

    const pool = await getPool();
    const dataReq = pool.request();
    whereParams.forEach(p => dataReq.input(p.key, p.value));
    dataReq.input('__offset', sql.Int, offset);
    dataReq.input('__limit', sql.Int, pageSize);
    const dataRes = await dataReq.query<OfferRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0
      ? Number(rowsWithCount[0].__totalCount ?? 0)
      : 0;
    const rows = rowsWithCount.map((row: OfferRowWithCount) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    let body: DeleteRequest | null = null;
    try {
      body = (await req.json()) as DeleteRequest;
    } catch {
      body = null;
    }

    const rawIds = Array.isArray(body?.OfferIDs) ? body.OfferIDs : [];
    const normalizedIds = Array.from(
      new Set(
        rawIds
          .map((value) => normalizeOfferId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: 'No offers selected for deletion' }, { status: 400 });
    }

    const pool = await getPool();
    const chunkSize = 200;
    let deleted = 0;

    for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
      const chunk = normalizedIds.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;
      const request = pool.request();
      const paramNames: string[] = [];
      chunk.forEach((offerId, chunkIdx) => {
        const paramName = `offer_${chunkIdx}`;
        request.input(paramName, sql.Int, offerId);
        paramNames.push(`@${paramName}`);
      });
      const query = `
        DELETE dbo.Offer
        WHERE ID IN (${paramNames.join(', ')})
      `;
      const result = await request.query(query);
      deleted += result.rowsAffected?.[0] ?? 0;
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
