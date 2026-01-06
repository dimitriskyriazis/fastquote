import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import type { Request as SqlRequest } from 'mssql';
import { getPool } from '../../../lib/sql';
import { buildQuickFilterClause, mergeWhereClauses, QueryParam } from '../../../lib/gridFilters';

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

type DateFilterModel = {
  filterType: 'date';
  type?: 'equals' | 'notEqual' | 'lessThan' | 'greaterThan' | 'inRange';
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
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
  // rowGroupCols, pivotCols, etc. available if enabling them later
};

type DeleteRequest = {
  OfferIDs?: Array<number | string | null | undefined>;
};

type OfferRow = {
  Description: string | null;
  Title: string | null;
  Comments: string | null;
  CustomerName: string | null;
  PricingPolicyName: string | null;
  SalesMarket: string | null;
  SalesDivision: string | null;
  SalesPerson: string | null;
  OfferStatus: string | null;
  ProjectID: number | null;
  offerId: number | null;
  CustomerRef: string | null;
  ProtocolNo: number | null;
  OfferContact: string | null;
  OfferVersion: number | null;
  Enabled: boolean | number | null;
  OfferDate: string | null;
  ModifiedOn: string | null;
};

type OfferRowWithCount = OfferRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  Description: 'dbo.Offer.Description',
  Title: 'dbo.Offer.Title',
  Comments: 'dbo.Offer.Comments',
  CustomerName: 'dbo.Customers.Name',
  PricingPolicyName: 'dbo.PricingPolicies.Name',
  SalesMarket: 'dbo.Markets.Name',
  SalesDivision: 'dbo.SalesDivision.Name',
  SalesPerson: 'dbo.AspNetUsers.FullName',
  OfferStatus: 'dbo.OfferStatus.Name',
  ProjectID: 'dbo.Offer.ProjectID',
  offerId: 'dbo.Offer.ID',
  CustomerRef: 'dbo.Offer.CustomerRef',
  ProtocolNo: 'dbo.Offer.ProtocolNo',
  OfferContact: 'dbo.Offer.OfferContact',
  OfferVersion: 'dbo.Offer.OfferVersion',
  Enabled: 'dbo.Offer.Enabled',
  OfferDate: 'dbo.Offer.OfferDate',
  ModifiedOn: 'dbo.Offer.ModifiedOn',
};
const QUICK_FILTER_COLUMNS = Object.values(COLUMN_EXPRESSIONS);

const ALLOWED_ROW_GROUP_FIELDS = new Set([
  'CustomerName',
  'PricingPolicyName',
  'SalesMarket',
  'SalesDivision',
  'SalesPerson',
  'OfferStatus',
]);

type GroupField = {
  field: string;
  expression: string;
};

const combineWhereClauses = (...clauses: Array<string | undefined>) => {
  const cleaned = clauses
    .map((clause) => clause?.trim())
    .filter((clause): clause is string => typeof clause === 'string' && clause.length > 0)
    .map((clause) => clause.replace(/^\s*WHERE\s+/i, '').trim())
    .filter((clause) => clause.length > 0);
  if (cleaned.length === 0) return '';
  return `WHERE ${cleaned.join(' AND ')}`;
};

const resolveGroupingFields = (rowGroupCols?: GridRequest['rowGroupCols']): GroupField[] => {
  if (!Array.isArray(rowGroupCols) || rowGroupCols.length === 0) return [];
  const resolved: GroupField[] = [];
  for (const col of rowGroupCols) {
    const candidate = typeof col.field === 'string' && col.field.length > 0
      ? col.field
      : typeof col.colId === 'string' && col.colId.length > 0
        ? col.colId
        : null;
    if (!candidate || !ALLOWED_ROW_GROUP_FIELDS.has(candidate)) {
      return [];
    }
    const expression = COLUMN_EXPRESSIONS[candidate] ?? `[${candidate}]`;
    resolved.push({ field: candidate, expression });
  }
  return resolved;
};

const buildGroupKeyFilter = (fields: GroupField[], keys: Array<string | null>) => {
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  for (let idx = 0; idx < keys.length && idx < fields.length; idx += 1) {
    const key = keys[idx];
    const expression = fields[idx].expression;
    if (key === null) {
      clauses.push(`${expression} IS NULL`);
      continue;
    }
    const paramName = `__group_key_${idx}`;
    clauses.push(`${expression} = @${paramName}`);
    params.push({ key: paramName, value: key });
  }
  if (clauses.length === 0) {
    return { clause: '', params };
  }
  return { clause: `WHERE ${clauses.join(' AND ')}`, params };
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
    const offset = Math.max(0, startRow);

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Offer.ID AS OfferPK,
        dbo.Offer.Description,
        dbo.Offer.Title,
        dbo.Offer.Comments,
        dbo.Customers.Name AS CustomerName,
        dbo.PricingPolicies.Name AS PricingPolicyName,
        dbo.Markets.Name AS SalesMarket,
        dbo.SalesDivision.Name AS SalesDivision,
        dbo.AspNetUsers.FullName AS SalesPerson,
        dbo.OfferStatus.Name AS OfferStatus,
        dbo.Offer.ProjectID,
        dbo.Offer.ID AS offerId,
        dbo.Offer.CustomerRef,
        dbo.Offer.ProtocolNo,
        dbo.Offer.OfferContact,
        dbo.Offer.OfferVersion,
        dbo.Offer.Enabled,
        dbo.Offer.OfferDate,
        dbo.Offer.ModifiedOn
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
    const quickFilterClause = buildQuickFilterClause(requestPayload.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const defaultOrder = 'ORDER BY dbo.Offer.Description';
    const orderClause = buildOrder(requestPayload.sortModel) || defaultOrder;
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const groupingFields = resolveGroupingFields(requestPayload.rowGroupCols);
    const rawGroupKeys = Array.isArray(requestPayload.groupKeys) ? requestPayload.groupKeys : [];
    const groupKeys = rawGroupKeys.slice(0, groupingFields.length);
    const parentFilter = groupingFields.length > 0
      ? buildGroupKeyFilter(groupingFields, groupKeys)
      : { clause: '', params: [] };
    const groupLevel = Math.min(groupKeys.length, groupingFields.length);

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    if (groupingFields.length > 0 && groupLevel < groupingFields.length) {
      const groupWhere = combineWhereClauses(combinedWhere, parentFilter.clause);
      const countReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${groupingFields[groupLevel].expression}) AS __groupCount
        ${from}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(countSql);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      groupReq.input('__offset', sql.Int, offset);
      groupReq.input('__limit', sql.Int, pageSize);
      const groupSql = `
        SELECT DISTINCT ${groupingFields[groupLevel].expression} AS GroupValue
        ${from}
        ${groupWhere}
        ORDER BY ${groupingFields[groupLevel].expression}
        ${paging}
      `;
      const groupRes = await groupReq.query<{ GroupValue: string | null }>(groupSql);
      const rows = (groupRes.recordset ?? []).map((row) => {
        const value = row.GroupValue ?? null;
        return {
          group: true,
          key: value === null ? null : String(value),
          field: groupingFields[groupLevel].field,
          [groupingFields[groupLevel].field]: value,
        };
      });

      return NextResponse.json({ ok: true, rows, rowCount: totalGroupCount });
    }

    const appliedWhere = groupingFields.length > 0
      ? combineWhereClauses(combinedWhere, parentFilter.clause)
      : combinedWhere;
    const appliedParams = [...combinedParams, ...parentFilter.params];

    const dataSql = `${select} ${from} ${appliedWhere} ${orderClause} ${paging}`;
    const dataReq = bindParams(pool.request(), appliedParams);
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
      const transaction = new sql.Transaction(pool);
      await transaction.begin();

      try {
        const paramNames: string[] = [];
        chunk.forEach((offerId, chunkIdx) => {
          const paramName = `offer_${chunkIdx}`;
          paramNames.push(`@${paramName}`);
        });
        const idsSql = paramNames.join(', ');

        const bindParams = (request: SqlRequest) => {
          chunk.forEach((offerId, chunkIdx) => {
            request.input(`offer_${chunkIdx}`, sql.Int, offerId);
          });
          return request;
        };

        await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.OfferDetails
          WHERE OfferID IN (${idsSql});
        `);

        const deleteOffersResult = await bindParams(new sql.Request(transaction)).query(`
          DELETE FROM dbo.Offer
          WHERE ID IN (${idsSql});
        `);

        await transaction.commit();
        deleted += deleteOffersResult.rowsAffected?.[0] ?? 0;
      } catch (chunkErr) {
        await transaction.rollback().catch(() => {});
        throw chunkErr;
      }
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
