import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import sql from 'mssql';
import type { Request as SqlRequest } from 'mssql';
import { getPool } from '../../../lib/sql';
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from '../../../lib/gridFilters';
import { KnownFilterModel } from '../../../lib/filterTypes';
import { processFilter } from '../../../lib/filterProcessing';

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type OfferDetailRow = {
  OfferDetailID: number | null;
  ProductID: number | null;
  PriceListID: number | null;
  BrandID: number | null;
  OfferID: number | null;
  OfferTitle: string | null;
  OfferDescription: string | null;
  OfferVersion: number | null;
  OfferStatus: string | null;
  CustomerName: string | null;
  CustomerGroup: string | null;
  ERPFWCProjectShortName: string | null;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  Origin: string | null;
  ProductDescription: string | null;
  Quantity: number | null;
  ListPrice: number | null;
  CustomerDiscount: number | null;
  NetUnitPrice: number | null;
  TotalPrice: number | null;
  TotalNet: number | null;
  TelmacoDiscount: number | null;
  NetCostOtherCurrency: number | null;
  OtherCurrencyName: string | null;
  CurrencyCostModifier: number | null;
  NetCost: number | null;
  TotalCost: number | null;
  Margin: number | null;
  GrossProfit: number | null;
  Delivery: string | null;
  Warranty: number | null;
  TelmacoWarranty: number | null;
  OfferDate: string | null;
  OfferDeadlineDate: string | null;
  Probability: number | null;
  CreatedOn: string | null;
  ModifiedOn: string | null;
};

type OfferDetailRowWithCount = OfferDetailRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  OfferDetailID: 'od.ID',
  ProductID: 'od.ProductID',
  PriceListID: 'od.PriceListID',
  BrandID: 'od.BrandID',
  OfferID: 'od.OfferID',
  OfferTitle: 'o.Title',
  OfferDescription: 'o.Description',
  OfferVersion: 'o.OfferVersion',
  OfferStatus: 'os.Name',
  CustomerName: 'c.Name',
  CustomerGroup: 'cg.Name',
  ERPFWCProjectShortName: 'fwc.ShortName',
  PartNumber: 'od.PartNumber',
  ModelNumber: 'od.ModelNumber',
  BrandName: 'b.Name',
  Origin: 'p.Origin',
  ProductDescription: 'od.ProductDescription',
  Quantity: 'od.Quantity',
  ListPrice: 'od.ListPrice',
  CustomerDiscount: 'od.CustomerDiscount',
  NetUnitPrice: 'od.NetUnitPrice',
  TotalPrice: 'od.TotalPrice',
  TotalNet: 'od.TotalNet',
  TelmacoDiscount: 'od.TelmacoDiscount',
  NetCostOtherCurrency: 'od.NetCostOtherCurrency',
  OtherCurrencyName: 'oc.Name',
  CurrencyCostModifier: 'od.CurrencyCostModifier',
  NetCost: 'od.NetCost',
  TotalCost: 'od.TotalCost',
  Margin: 'od.Margin',
  GrossProfit: 'od.GrossProfit',
  Delivery: 'od.Delivery',
  Warranty: 'od.Warranty',
  TelmacoWarranty: 'od.TelmacoWarranty',
  OfferDate: 'o.OfferDate',
  OfferDeadlineDate: 'o.OfferDeadlineDate',
  Probability: 'o.Probability',
  CreatedOn: 'od.CreatedOn',
  ModifiedOn: 'od.ModifiedOn',
};

const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

const ALLOWED_ROW_GROUP_FIELDS = new Set([
  'CustomerName',
  'CustomerGroup',
  'OfferStatus',
  'BrandName',
  'OfferID',
  'ERPFWCProjectShortName',
  'Origin',
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

function buildWhereAndParams(filterModel: GridRequest['filterModel']) {
  if (!filterModel || Object.keys(filterModel).length === 0) return { where: '', params: [] as QueryParam[] };

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;

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

async function readGridRequest(req: NextRequest): Promise<{ request: GridRequest }> {
  try {
    const payload = await req.json();
    if (payload && typeof payload === 'object') {
      const inner = (payload as { request?: GridRequest }).request;
      if (inner && typeof inner === 'object') {
        return { request: inner };
      }
      return { request: { startRow: 0, endRow: 100 } };
    }
  } catch {
    /* fall back to defaults */
  }
  return { request: { startRow: 0, endRow: 100 } };
}

const selectClause = `
  SELECT
    COUNT_BIG(1) OVER () AS __totalCount,
    od.ID AS OfferDetailID,
    od.ProductID,
    od.OfferID,
    o.Title AS OfferTitle,
    o.Description AS OfferDescription,
    o.OfferVersion,
    os.Name AS OfferStatus,
    c.Name AS CustomerName,
    cg.Name AS CustomerGroup,
    fwc.ShortName AS ERPFWCProjectShortName,
    od.PartNumber,
    od.ModelNumber,
    b.Name AS BrandName,
    p.Origin AS Origin,
    od.ProductDescription,
    od.Quantity,
    od.PriceListID,
    od.BrandID,
    od.ListPrice,
    od.CustomerDiscount,
    od.NetUnitPrice,
    od.TotalPrice,
    od.TotalNet,
    od.TelmacoDiscount,
    od.NetCostOtherCurrency,
    oc.Name AS OtherCurrencyName,
    od.CurrencyCostModifier,
    od.NetCost,
    od.TotalCost,
    od.Margin,
    od.GrossProfit,
    od.Delivery,
    od.Warranty,
    od.TelmacoWarranty,
    o.OfferDate,
    o.OfferDeadlineDate,
    o.Probability,
    od.CreatedOn,
    od.ModifiedOn
`;

const fromClause = `
  FROM dbo.OfferDetails od
    INNER JOIN dbo.Offer o ON od.OfferID = o.ID
    INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
    LEFT JOIN dbo.CustomerGroups cg ON c.CustomerGroupID = cg.ID
    LEFT JOIN dbo.Brands b ON od.BrandID = b.ID
    LEFT JOIN dbo.OfferStatus os ON o.StatusID = os.ID
    LEFT JOIN dbo.Currencies oc ON od.OtherCurrencyID = oc.ID
    LEFT JOIN dbo.Products p ON od.ProductID = p.ID
    LEFT JOIN dbo.FWCs fwc ON fwc.ID = o.ERPFWCProjectID
`;

const baseFilter = `
  ISNULL(od.IsCategory, 0) = 0
  AND ISNULL(od.IsComment, 0) = 0
  AND od.ProductID IS NOT NULL
  AND ISNULL(o.Enabled, 0) = 1
  AND ISNULL(o.IsStandardPackage, 0) = 0
`;

export async function POST(req: NextRequest) {
  logRequest(req, '/api/offered-products');
  try {
    const { request: gridRequest } = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = Math.max(0, startRow);

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedWhereWithBase = mergeWhereClauses(combinedWhere, `AND ${baseFilter}`);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const defaultOrder = 'ORDER BY o.ID DESC, od.ID';
    const paging = 'OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY';

    const groupingFields = resolveGroupingFields(gridRequest.rowGroupCols);
    const rawGroupKeys = Array.isArray(gridRequest.groupKeys) ? gridRequest.groupKeys : [];
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
      const groupWhere = combineWhereClauses(combinedWhereWithBase, parentFilter.clause);
      const countReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      const countSql = `
        SELECT COUNT(DISTINCT ${groupingFields[groupLevel].expression}) AS __groupCount
        ${fromClause}
        ${groupWhere}
      `;
      const countRes = await countReq.query<{ __groupCount: number }>(countSql);
      const totalGroupCount = Number(countRes.recordset?.[0]?.__groupCount ?? 0);

      const groupReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
      groupReq.input('__offset', sql.Int, offset);
      groupReq.input('__limit', sql.Int, pageSize);
      const groupExpr = groupingFields[groupLevel].expression;
      const groupField = groupingFields[groupLevel].field;
      const groupSql = `
        SELECT
          ${groupExpr} AS [${groupField}],
          COUNT(1) AS __childCount
        ${fromClause}
        ${groupWhere}
        GROUP BY ${groupExpr}
        ORDER BY ${groupExpr}
        ${paging}
      `;
      const groupRes = await groupReq.query<Record<string, unknown>>(groupSql);
      const rows = (groupRes.recordset ?? []).map((row) => ({ ...row }));
      return NextResponse.json({ ok: true, rows, rowCount: totalGroupCount });
    }

    const appliedWhere = combineWhereClauses(combinedWhereWithBase, parentFilter.clause);
    const orderClause = buildOrder(gridRequest.sortModel) || defaultOrder;

    const dataReq = bindParams(pool.request(), [...combinedParams, ...parentFilter.params]);
    dataReq.input('__offset', sql.Int, offset);
    dataReq.input('__limit', sql.Int, pageSize);
    const dataSql = `${selectClause} ${fromClause} ${appliedWhere} ${orderClause} ${paging}`;
    const dataRes = await dataReq.query<OfferDetailRowWithCount>(dataSql);
    const rawRows = dataRes.recordset ?? [];
    const totalCount = rawRows.length > 0 ? Number(rawRows[0].__totalCount ?? 0) : 0;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const rows = rawRows.map(({ __totalCount, ...rest }) => rest);

    return NextResponse.json({ ok: true, rows, rowCount: totalCount });
  } catch (error) {
    console.error('Failed to load offered products', error);
    return NextResponse.json(
      { ok: false, error: 'Unable to fetch offered products' },
      { status: 500 },
    );
  }
}
