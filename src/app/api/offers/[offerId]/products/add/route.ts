import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import { logger } from '../../../../../../lib/logger';
import sql from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { buildAuditContext } from '../../../../../../lib/auditTrail';
import {
  buildQuickFilterClause,
  buildTextMatchPredicate,
  isSensitiveColumn,
  mergeWhereClauses,
  QueryParam,
} from '../../../../../../lib/gridFilters';
import { clearPartModelNumberUpper } from '../../../../../../lib/partModelNumber';
import { requirePermission } from '../../../../../../lib/authz';
import type {
  TextCondition as TextFilterModel,
  CompoundTextFilter as CompoundTextFilterModel,
  NumberCondition as NumberFilterModel,
  CompoundNumberFilter as CompoundNumberFilterModel,
  KnownFilterModel,
} from '../../../../../../lib/filterTypes';

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: 'asc' | 'desc' }>;
};

type GridRequestEnvelope = {
  request?: GridRequest;
  action?: string | null;
};

const TREE_ORDERING_RAW_EXPRESSION = 'NULLIF(LTRIM(RTRIM(od.TreeOrdering)), \'\')';
const TREE_ORDERING_HIERARCHY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    ELSE TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/'))
  END
`;

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

async function readBody(req: NextRequest): Promise<GridRequestEnvelope & Record<string, unknown>> {
  try {
    const payload = (await req.json()) as GridRequestEnvelope & Record<string, unknown>;
    if (payload && typeof payload === 'object') return payload;
  } catch {
    /* noop */
  }
  return {};
}

function readGridRequest(body: GridRequestEnvelope): GridRequest {
  if (body && typeof body === 'object' && body.request && typeof body.request === 'object') {
    return body.request;
  }
  return { startRow: 0, endRow: 100 };
}

const DEFAULT_PRODUCT_ORDER = 'ORDER BY bp.BrandName, bp.ModelNumber, bp.ProductID';

// Normalize part/model numbers by removing special characters and uppercasing.
const normalizePartModelNumber = (value: string): string => {
  return clearPartModelNumberUpper(value);
};

// Helper to get the cleared column name for part/model numbers
// Uses the existing PartNumberCleared and ModelNumberCleared columns for better performance
const partModelNumberSql = (expr: string) => {
  // Replace PartNumber/ModelNumber with their cleared versions
  if (expr.includes('.PartNumber')) {
    return `UPPER(ISNULL(${expr.replace('.PartNumber', '.PartNumberCleared')}, ''))`;
  }
  if (expr.includes('.ModelNumber')) {
    return `UPPER(ISNULL(${expr.replace('.ModelNumber', '.ModelNumberCleared')}, ''))`;
  }
  // Fallback for edge cases
  return `UPPER(ISNULL(${expr}, ''))`;
};

const buildBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NULL)`;

const buildNotBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NOT NULL)`;

const buildWhereClauses = (filterModel: GridRequest['filterModel'], columnExpressions: Record<string, string>) => {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { clauses: [] as string[], params: [] as QueryParam[] };
  }
  const clauses: string[] = [];
  const params: QueryParam[] = [];
  const typedModel = filterModel as Record<string, KnownFilterModel>;
  const isCompoundTextFilter = (filter: KnownFilterModel): filter is CompoundTextFilterModel => (
    filter.filterType === 'text'
    && 'operator' in filter
    && Array.isArray((filter as { conditions?: unknown }).conditions)
  );
  const isCompoundNumberFilter = (filter: KnownFilterModel): filter is CompoundNumberFilterModel => (
    filter.filterType === 'number'
    && 'operator' in filter
    && Array.isArray((filter as { conditions?: unknown }).conditions)
  );

  Object.entries(typedModel).forEach(([col, fm], idx) => {
    if (!fm) return;
    const paramBase = `${col}_${idx}`;
    const columnExpression = columnExpressions[col] ?? `[${col}]`;
    const isPartNumber = col === 'PartNumber';
    const isModelNumber = col === 'ModelNumber';
    const isPartOrModel = isPartNumber || isModelNumber;
    const otherColumnExpression = isPartNumber
      ? columnExpressions.ModelNumber
      : isModelNumber
        ? columnExpressions.PartNumber
        : null;

    switch (fm.filterType) {
      case 'text': {
        const buildTextConditionClause = (condition: TextFilterModel, conditionParamBase: string) => {
          const type = condition.type;

          if (type === 'blank') {
            return { clause: buildBlankClause(columnExpression), params: [] as QueryParam[] };
          }
          if (type === 'notBlank') {
            return { clause: buildNotBlankClause(columnExpression), params: [] as QueryParam[] };
          }

          const value = String(condition.filter ?? '');
          if (!value) return { clause: '', params: [] as QueryParam[] };

          if (isPartOrModel) {
            const searchVal = normalizePartModelNumber(value);
            const expr = partModelNumberSql(columnExpression);
            // Also search LegacyPartNoCleaned when filtering by PartNumber
            const legacyExpr = columnExpression.includes('.PartNumber')
              ? `UPPER(ISNULL(${columnExpression.replace('.PartNumber', '.LegacyPartNoCleaned')}, ''))`
              : null;
            const legacyOr = legacyExpr ? ` OR ${legacyExpr}` : '';
            if (type === 'equals') {
              if (otherColumnExpression) {
                return {
                  clause: `(${expr} = @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} = @${conditionParamBase}${legacyOr ? `${legacyOr} = @${conditionParamBase}` : ''})`,
                  params: [{ key: conditionParamBase, value: searchVal }],
                };
              }
              return {
                clause: legacyExpr ? `(${expr} = @${conditionParamBase}${legacyOr} = @${conditionParamBase})` : `${expr} = @${conditionParamBase}`,
                params: [{ key: conditionParamBase, value: searchVal }],
              };
            }
            if (type === 'notEqual') {
              return {
                clause: `${expr} <> @${conditionParamBase}`,
                params: [{ key: conditionParamBase, value: searchVal }],
              };
            }
            if (type === 'startsWith') {
              if (otherColumnExpression) {
                return {
                  clause: `(${expr} LIKE @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${conditionParamBase}${legacyOr ? `${legacyOr} LIKE @${conditionParamBase}` : ''})`,
                  params: [{ key: conditionParamBase, value: `${searchVal}%` }],
                };
              }
              return {
                clause: legacyExpr ? `(${expr} LIKE @${conditionParamBase}${legacyOr} LIKE @${conditionParamBase})` : `${expr} LIKE @${conditionParamBase}`,
                params: [{ key: conditionParamBase, value: `${searchVal}%` }],
              };
            }
            if (type === 'endsWith') {
              if (otherColumnExpression) {
                return {
                  clause: `(${expr} LIKE @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${conditionParamBase}${legacyOr ? `${legacyOr} LIKE @${conditionParamBase}` : ''})`,
                  params: [{ key: conditionParamBase, value: `%${searchVal}` }],
                };
              }
              return {
                clause: legacyExpr ? `(${expr} LIKE @${conditionParamBase}${legacyOr} LIKE @${conditionParamBase})` : `${expr} LIKE @${conditionParamBase}`,
                params: [{ key: conditionParamBase, value: `%${searchVal}` }],
              };
            }
            if (otherColumnExpression) {
              return {
                clause: `(${expr} LIKE @${conditionParamBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${conditionParamBase}${legacyOr ? `${legacyOr} LIKE @${conditionParamBase}` : ''})`,
                params: [{ key: conditionParamBase, value: `%${searchVal}%` }],
              };
            }
            return {
              clause: legacyExpr ? `(${expr} LIKE @${conditionParamBase}${legacyOr} LIKE @${conditionParamBase})` : `${expr} LIKE @${conditionParamBase}`,
              params: [{ key: conditionParamBase, value: `%${searchVal}%` }],
            };
          }

          const mode = (type ?? 'contains') as 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'notEqual';
          return buildTextMatchPredicate(columnExpression, value, {
            paramKey: conditionParamBase,
            mode,
            enablePhonetic: !isSensitiveColumn(col),
            enableFuzzy: false,
          });
        };

        if (isCompoundTextFilter(fm)) {
          const operator = fm.operator === 'OR' ? 'OR' : 'AND';
          const conditionResults = fm.conditions
            .map((condition, conditionIdx) => (
              buildTextConditionClause(condition, `${paramBase}_c${conditionIdx}`)
            ))
            .filter((result) => result.clause);
          if (conditionResults.length === 0) break;
          if (conditionResults.length === 1) {
            clauses.push(conditionResults[0].clause);
          } else {
            clauses.push(`(${conditionResults.map((result) => result.clause).join(` ${operator} `)})`);
          }
          conditionResults.forEach((result) => result.params.forEach((p) => params.push(p)));
          break;
        }

        const single = buildTextConditionClause(fm as TextFilterModel, paramBase);
        if (single.clause) {
          clauses.push(single.clause);
          single.params.forEach((p) => params.push(p));
        }
        break;
      }
      case 'number': {
        const buildNumberConditionClause = (condition: NumberFilterModel, conditionParamBase: string) => {
          const type = condition.type;

          if (type === 'blank') {
            return { clause: buildBlankClause(columnExpression), params: [] as QueryParam[] };
          }
          if (type === 'notBlank') {
            return { clause: buildNotBlankClause(columnExpression), params: [] as QueryParam[] };
          }

          const val = condition.filter !== undefined ? Number(condition.filter) : Number.NaN;
          const valTo = condition.filterTo !== undefined ? Number(condition.filterTo) : undefined;
          if (Number.isNaN(val)) return { clause: '', params: [] as QueryParam[] };
          const conditionParams: QueryParam[] = [{ key: conditionParamBase, value: val }];
          let clause = '';
          if (type === 'equals') clause = `${columnExpression} = @${conditionParamBase}`;
          if (type === 'notEqual') clause = `${columnExpression} <> @${conditionParamBase}`;
          if (type === 'lessThan') clause = `${columnExpression} < @${conditionParamBase}`;
          if (type === 'greaterThan') clause = `${columnExpression} > @${conditionParamBase}`;
          if (type === 'lessThanOrEqual') clause = `${columnExpression} <= @${conditionParamBase}`;
          if (type === 'greaterThanOrEqual') clause = `${columnExpression} >= @${conditionParamBase}`;
          if (type === 'inRange' && valTo !== undefined) {
            clause = `(${columnExpression} BETWEEN @${conditionParamBase} AND @${conditionParamBase}_to)`;
            conditionParams.push({ key: `${conditionParamBase}_to`, value: valTo });
          }
          return { clause, params: conditionParams };
        };

        if (isCompoundNumberFilter(fm)) {
          const operator = fm.operator === 'OR' ? 'OR' : 'AND';
          const conditionResults = fm.conditions
            .map((condition, conditionIdx) => (
              buildNumberConditionClause(condition, `${paramBase}_c${conditionIdx}`)
            ))
            .filter((result) => result.clause);
          if (conditionResults.length === 0) break;
          if (conditionResults.length === 1) {
            clauses.push(conditionResults[0].clause);
          } else {
            clauses.push(`(${conditionResults.map((result) => result.clause).join(` ${operator} `)})`);
          }
          conditionResults.forEach((result) => result.params.forEach((p) => params.push(p)));
          break;
        }

        const single = buildNumberConditionClause(fm as NumberFilterModel, paramBase);
        if (single.clause) {
          clauses.push(single.clause);
          single.params.forEach((p) => params.push(p));
        }
        break;
      }
      default:
        break;
    }
  });

  return { clauses, params };
};

const buildOrderSql = (sortModel: GridRequest['sortModel'], columnExpressions: Record<string, string>, defaultOrder: string) => {
  if (!sortModel || sortModel.length === 0) return defaultOrder;
  const parts = sortModel
    .filter((entry): entry is { colId: string; sort: 'asc' | 'desc' } => Boolean(entry?.colId && entry?.sort))
    .map((entry) => {
      const expression = columnExpressions[entry.colId] ?? `[${entry.colId}]`;
      const direction = entry.sort === 'desc' ? 'DESC' : 'ASC';
      return `${expression} ${direction}`;
    });
  const hasProductId = sortModel.some((entry) => entry?.colId === 'ProductID');
  if (!hasProductId) {
    parts.push(`${columnExpressions.ProductID ?? '[ProductID]'} ASC`);
  }
  return parts.length ? `ORDER BY ${parts.join(', ')}` : defaultOrder;
};

type CategoryGridRow = {
  __totalCount: number | bigint | null;
  OfferDetailID: number;
  TreeOrdering: string | null;
  Description: string | null;
  ModifiedOn: Date | string | null;
  ModifiedBy: string | null;
  TreeOrderingHierarchy?: unknown;
};

async function handleCategoryGrid(
  offerId: number,
  body: GridRequestEnvelope,
) {
  const gridRequest = readGridRequest(body);
  const startRow = gridRequest.startRow ?? 0;
  const endRow = gridRequest.endRow ?? startRow + 100;
  const windowSize = endRow > startRow ? endRow - startRow : 100;
  const pageSize = Math.max(1, Math.min(400, windowSize));
  const offset = Math.max(0, startRow);

  const columnExpressions: Record<string, string> = {
    TreeOrdering: 'od.TreeOrdering',
    Description: 'od.ProductDescription',
    ModifiedOn: 'od.ModifiedOn',
    ModifiedBy: 'od.ModifiedBy',
  };

  const { clauses, params } = buildWhereClauses(gridRequest.filterModel, columnExpressions);
  const whereSql = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const quickFilterColumns = Object.entries(columnExpressions).map(([colId, expression]) => ({
    colId,
    expression,
  }));
  const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, quickFilterColumns);
  const combinedWhereSql = mergeWhereClauses(whereSql, quickFilterClause.clause);
  const combinedParams = [...params, ...quickFilterClause.params];

  const orderSql = buildOrderSql(
    gridRequest.sortModel,
    columnExpressions,
    'ORDER BY TreeOrderingHierarchy, od.TreeOrdering',
  );

  const pool = await getPool();
  const request = pool.request();
  request.input('__offerId', sql.Int, offerId);
  request.input('__offset', sql.Int, offset);
  request.input('__limit', sql.Int, pageSize);
  combinedParams.forEach((param) => request.input(param.key, param.value));

  const query = `
    SELECT
      COUNT_BIG(1) OVER () AS __totalCount,
      od.ID AS OfferDetailID,
      od.TreeOrdering,
      od.ProductDescription AS Description,
      od.ModifiedOn,
      od.ModifiedBy,
      ${TREE_ORDERING_HIERARCHY_EXPRESSION} AS TreeOrderingHierarchy
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND ISNULL(od.IsCategory, 0) = 1
      ${combinedWhereSql}
    ${orderSql}
    OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY;
  `;

  const result = await request.query<CategoryGridRow>(query);
  const rows = result.recordset ?? [];
  const rowCount = rows.length > 0 ? Number(rows[0].__totalCount ?? 0) : 0;
  const mappedRows = rows.map((row) => {
    const { __totalCount, TreeOrderingHierarchy, ...rest } = row;
    void __totalCount;
    void TreeOrderingHierarchy;
    return rest;
  });

  return NextResponse.json({ ok: true, rows: mappedRows, rowCount });
}

type ProductGridRow = {
  __totalCount: number | bigint | null;
  ProductID: number;
  PartNumber: string | null;
  Description: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  PriceListItemID: number | null;
  PriceListID: number | null;
  PriceListName: string | null;
  ListPrice: number | null;
  UnitPrice: number | null;
  PriceListValidFromDate: Date | string | null;
  PriceListValidToDate: Date | string | null;
  PriceListEnabled: boolean | number | null;
};

async function handleProductGrid(
  offerId: number,
  body: GridRequestEnvelope & Record<string, unknown>,
) {
  const gridRequest = readGridRequest(body);
  const highlightProductId = normalizeProductId(body?.newProductId ?? null);
  const startRow = gridRequest.startRow ?? 0;
  const endRow = gridRequest.endRow ?? startRow + 100;
  const windowSize = endRow > startRow ? endRow - startRow : 100;
  const pageSize = Math.max(1, Math.min(400, windowSize));
  const offset = Math.max(0, startRow);

  const columnExpressions: Record<string, string> = {
    ProductID: 'bp.ProductID',
    PartNumber: 'bp.PartNumber',
    Description: 'bp.Description',
    ModelNumber: 'bp.ModelNumber',
    BrandName: 'bp.BrandName',
    PriceListName: 'price.PriceListName',
    ListPrice: 'price.ListPrice',
    UnitPrice: 'price.ListPrice',
  };

  const { clauses, params } = buildWhereClauses(gridRequest.filterModel, columnExpressions);
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const quickFilterColumns = Object.entries(columnExpressions).map(([colId, expression]) => ({
    colId,
    expression,
  }));
  const quickFilterClause = buildQuickFilterClause(
    gridRequest.quickFilterText,
    quickFilterColumns,
    'quickFilter',
    { enableFuzzyText: false },
  );
  const combinedWhereSql = quickFilterClause.clause
    ? `${whereSql} ${quickFilterClause.clause}`.trim()
    : whereSql;
  const combinedParams = [...params, ...quickFilterClause.params];
  const defaultOrder = DEFAULT_PRODUCT_ORDER;
  const baseOrderSql = buildOrderSql(
    gridRequest.sortModel,
    columnExpressions,
    defaultOrder,
  );
  // If we have a highlightProductId, prioritize it at the top, then use the rest of the order
  const orderSql = highlightProductId != null
    ? baseOrderSql.replace(/^ORDER BY /i, 'ORDER BY CASE WHEN bp.ProductID = @__highlightProductId THEN 0 ELSE 1 END, ')
    : baseOrderSql;

  const pool = await getPool();

  // Look up the offer's pricing policy so we can prefer matching pricelists
  const policyLookup = pool.request();
  policyLookup.input('__offerId', sql.Int, offerId);
  const policyResult = await policyLookup.query<{ PricingPolicyID: number | null }>(`
    SELECT TOP (1) o.PricingPolicyID
    FROM dbo.Offer o
    WHERE o.ID = @__offerId
  `);
  const offerPricingPolicyId = policyResult.recordset?.[0]?.PricingPolicyID ?? null;

  const request = pool.request();
  request.input('__offset', sql.Int, offset);
  request.input('__limit', sql.Int, pageSize);
  request.input('__pricingPolicyId', sql.Int, offerPricingPolicyId);
  combinedParams.forEach((param) => request.input(param.key, param.value));
  if (highlightProductId != null) {
    request.input('__highlightProductId', sql.Int, highlightProductId);
  }

  const query = `
    WITH BaseProducts AS (
      SELECT
        p.ID AS ProductID,
        p.PartNumber,
        p.PartNumberCleared,
        p.Description,
        p.ModelNumber,
        p.ModelNumberCleared,
        p.LegacyPartNoCleaned,
        b.Name AS BrandName
      FROM dbo.Products p
        LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
    )
    SELECT
      COUNT_BIG(1) OVER () AS __totalCount,
      bp.ProductID,
      bp.PartNumber,
      bp.Description,
      bp.ModelNumber,
      bp.BrandName,
      price.PriceListItemID,
      price.PriceListID,
      price.PriceListName,
      price.ListPrice,
      price.ListPrice AS UnitPrice,
      price.PriceListValidFromDate,
      price.PriceListValidToDate,
      price.PriceListEnabled
    FROM BaseProducts bp
      OUTER APPLY (
        SELECT TOP (1)
          pli.ID AS PriceListItemID,
          pli.PriceListID,
          pl.Name AS PriceListName,
          pli.ListPrice,
          pl.ValidFromDate AS PriceListValidFromDate,
          pl.ValidToDate AS PriceListValidToDate,
          pl.Enabled AS PriceListEnabled
        FROM dbo.PriceListItems pli
          INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
          LEFT JOIN dbo.PriceListPricingPolicy plpp ON plpp.PriceListID = pl.ID AND plpp.PricingPolicyID = @__pricingPolicyId
        WHERE pl.Enabled = 1
          AND (
            pli.ProductID = bp.ProductID
            OR EXISTS (
              SELECT 1
              FROM dbo.Products p_match
              WHERE p_match.ID = pli.ProductID
                AND p_match.LegacyPartNoCleaned = bp.PartNumberCleared
                AND p_match.LegacyPartNoCleaned IS NOT NULL
                AND p_match.LegacyPartNoCleaned <> ''
            )
          )
        ORDER BY
          CASE WHEN pli.ProductID = bp.ProductID THEN 0 ELSE 1 END,
          CASE WHEN plpp.ID IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
          pl.ValidToDate,
          pl.ValidFromDate DESC,
          pli.ID DESC
      ) price
    ${combinedWhereSql}
    ${orderSql}
    OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY;
  `;

  const result = await request.query<ProductGridRow>(query);
  const rows = result.recordset ?? [];
  const rowCount = rows.length > 0 ? Number(rows[0].__totalCount ?? 0) : 0;
  const mappedRows = rows.map((row) => {
    const { __totalCount, ...rest } = row;
    void __totalCount;
    return rest;
  });

  return NextResponse.json({ ok: true, rows: mappedRows, rowCount });
}

type ProductSelection = { productId: number; sequence: number };

const normalizeSelectionPayload = (raw: unknown): ProductSelection[] => {
  if (!Array.isArray(raw)) return [];
  const mapped = raw
    .map((entry, idx) => {
      if (entry == null) return null;
      if (typeof entry === 'number' || typeof entry === 'string') {
        const productId = normalizeProductId(entry);
        if (productId == null) return null;
        return { productId, sequence: idx + 1 };
      }
      if (typeof entry === 'object') {
        const obj = entry as { productId?: unknown; ProductID?: unknown; sequence?: unknown; Sequence?: unknown };
        const productId = normalizeProductId(obj.productId ?? obj.ProductID ?? null);
        if (productId == null) return null;
        const seqRaw = obj.sequence ?? obj.Sequence;
        const seq = typeof seqRaw === 'number' && Number.isFinite(seqRaw) ? seqRaw : idx + 1;
        return { productId, sequence: seq };
      }
      return null;
    })
    .filter((entry): entry is ProductSelection => Boolean(entry));

  const seen = new Set<number>();
  const deduped: ProductSelection[] = [];
  mapped.forEach((entry) => {
    if (seen.has(entry.productId)) return;
    seen.add(entry.productId);
    deduped.push(entry);
  });
  return deduped;
};

async function handleAddProducts(
  offerId: number,
  body: Record<string, unknown>,
  auditUserId: string | number | null,
) {
  const categoryId = normalizeOfferDetailId(
    body?.categoryId ?? (body as { CategoryID?: unknown })?.CategoryID ?? null,
);
  const selections = normalizeSelectionPayload((body as { products?: unknown })?.products ?? null);
  if (selections.length === 0) {
    return NextResponse.json({ ok: false, error: 'No products selected' }, { status: 400 });
  }
  const addCommentRaw = body?.comment ?? (body as { Comment?: unknown })?.Comment ?? null;
  const addCommentValue = typeof addCommentRaw === 'string' && selections.length === 1 ? addCommentRaw.trim() || null : null;

  try {
  const pool = await getPool();

  let parentTreeOrdering: string | null = null;

  if (categoryId != null) {
    const lookup = pool.request();
    lookup.input('__offerId', sql.Int, offerId);
    lookup.input('__categoryId', sql.Int, categoryId);
    const categoryResult = await lookup.query<{
      TreeOrdering: string | null;
    }>(`
      SELECT TOP (1)
        NULLIF(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), '') AS TreeOrdering
      FROM dbo.OfferDetails od
      WHERE od.ID = @__categoryId
        AND od.OfferID = @__offerId
        AND ISNULL(od.IsComment, 0) = 0
        AND ISNULL(od.ProductID, 0) = 0
    `);

    parentTreeOrdering = categoryResult.recordset?.[0]?.TreeOrdering ?? null;
    if (!parentTreeOrdering) {
      return NextResponse.json({ ok: false, error: 'Invalid category selection' }, { status: 400 });
    }
  }

  const request = pool.request();
  request.timeout = 120000; // 2 min – this batch is heavy (legacy resolution + pricing + insert)
  request.input('__offerId', sql.Int, offerId);
  request.input('__categoryId', sql.Int, categoryId);
  request.input('__parentTree', sql.NVarChar(255), parentTreeOrdering);
  request.input('__createdBy', sql.Int, auditUserId);
  request.input('__modifiedBy', sql.Int, auditUserId);
  request.input('__addComment', sql.NVarChar(sql.MAX), addCommentValue);

  const valueClauses: string[] = [];
  selections.forEach((entry, idx) => {
    const pidParam = `pid_${idx}`;
    const seqParam = `seq_${idx}`;
    request.input(pidParam, sql.Int, entry.productId);
    request.input(seqParam, sql.Int, entry.sequence);
    valueClauses.push(`(@${pidParam}, @${seqParam})`);
  });

  const query = `
  DECLARE @parentTree NVARCHAR(255) = NULLIF(LTRIM(RTRIM(@__parentTree)), '');
  DECLARE @prefix NVARCHAR(260);
  DECLARE @targetSegments INT;
  DECLARE @maxChild INT;
  DECLARE @pricingPolicyId INT;

  SELECT @pricingPolicyId = o.PricingPolicyID
  FROM dbo.Offer o
  WHERE o.ID = @__offerId;

  IF @parentTree IS NULL
  BEGIN
    -- No category selected: find max top-level TreeOrdering
    SELECT @maxChild =
      MAX(
        TRY_CONVERT(
          INT,
          NULLIF(LTRIM(RTRIM(od.TreeOrdering)), '')
        )
      )
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId;

    SET @maxChild = ISNULL(@maxChild, 0);
  END
  ELSE
  BEGIN
    SET @prefix = CONCAT(@parentTree, '.');
    SET @targetSegments = (LEN(@parentTree) - LEN(REPLACE(@parentTree, '.', '')) + 2);

    SELECT @maxChild =
      MAX(
        TRY_CONVERT(INT, RIGHT(t.TreeOrderingTrimmed, CHARINDEX('.', REVERSE(t.TreeOrderingTrimmed) + '.') - 1))
      )
    FROM (
      SELECT LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))) AS TreeOrderingTrimmed
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
    ) AS t
    WHERE t.TreeOrderingTrimmed <> ''
      AND t.TreeOrderingTrimmed LIKE CONCAT(@prefix, '%')
      AND (LEN(t.TreeOrderingTrimmed) - LEN(REPLACE(t.TreeOrderingTrimmed, '.', '')) + 1) = @targetSegments;

    SET @maxChild = ISNULL(@maxChild, 0);
  END;

  DECLARE @nextOrdering INT =
    (
      SELECT ISNULL(MAX(ISNULL(od.Ordering, 0)), 0) + 1
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
    );

  DECLARE @ProvidedProducts TABLE (
    ProductID INT NOT NULL,
    Seq INT NOT NULL
  );

  INSERT INTO @ProvidedProducts (ProductID, Seq)
  SELECT DISTINCT v.ProductID, v.Seq
  FROM (VALUES ${valueClauses.join(', ')}) AS v (ProductID, Seq);

  -- Resolve legacy products: if product has no enabled pricelist items
  -- but another product's legacy part number matches, use that product instead
  UPDATE pp
  SET pp.ProductID = resolved.NewProductID
  FROM @ProvidedProducts pp
  CROSS APPLY (
    SELECT TOP (1) p_new.ID AS NewProductID
    FROM dbo.Products pr
    INNER JOIN dbo.Products p_new
      ON p_new.LegacyPartNoCleaned = pr.PartNumberCleared
      AND p_new.LegacyPartNoCleaned IS NOT NULL
      AND p_new.LegacyPartNoCleaned <> ''
      AND p_new.ID <> pr.ID
    WHERE pr.ID = pp.ProductID
      AND NOT EXISTS (
        SELECT 1 FROM dbo.PriceListItems pli_chk
        INNER JOIN dbo.PriceLists pl_chk ON pli_chk.PriceListID = pl_chk.ID AND pl_chk.Enabled = 1
        WHERE pli_chk.ProductID = pr.ID
      )
      AND EXISTS (
        SELECT 1 FROM dbo.PriceListItems pli_chk2
        INNER JOIN dbo.PriceLists pl_chk2 ON pli_chk2.PriceListID = pl_chk2.ID AND pl_chk2.Enabled = 1
        WHERE pli_chk2.ProductID = p_new.ID
      )
    ORDER BY p_new.ID DESC
  ) resolved
  OPTION (RECOMPILE);

  DECLARE @ProductData TABLE (
    ProductID INT NOT NULL,
    Seq INT NOT NULL,
    Description NVARCHAR(MAX) NULL,
    BrandID INT NULL,
    PartNumber NVARCHAR(255) NULL,
    ModelNumber NVARCHAR(255) NULL,
    WarrantyValue INT NOT NULL,
    PriceListID INT NULL,
    PriceListItemID INT NULL,
    ListPrice DECIMAL(18, 4) NULL,
    CostPrice DECIMAL(18, 4) NULL,
    OtherCurrencyID INT NULL,
    CurrencyCostModifier DECIMAL(18, 8) NULL
  );

  INSERT INTO @ProductData (
    ProductID,
    Seq,
    Description,
    BrandID,
    PartNumber,
    ModelNumber,
    WarrantyValue,
    PriceListID,
    PriceListItemID,
    ListPrice,
    CostPrice,
    OtherCurrencyID,
    CurrencyCostModifier
  )
  SELECT
    p.ProductID,
    p.Seq,
    pr.Description,
    pr.BrandID,
    pr.PartNumber,
    pr.ModelNumber,
    0 AS WarrantyValue,
    price.PriceListID,
    price.PriceListItemID,
    price.ListPrice,
    price.CostPrice,
    price.OtherCurrencyID,
    price.CurrencyCostModifier
  FROM @ProvidedProducts p
    INNER JOIN dbo.Products pr ON pr.ID = p.ProductID
    OUTER APPLY (
      SELECT TOP (1)
        pli.ID AS PriceListItemID,
        pli.PriceListID,
        pli.ListPrice,
        pli.CostPrice,
        COALESCE(pl.CostCurrencyID, pl.CurrencyId) AS OtherCurrencyID,
        COALESCE(pl.CurrencyCostModifier, 1) AS CurrencyCostModifier
      FROM dbo.PriceListItems pli
        INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
        LEFT JOIN dbo.PriceListPricingPolicy plpp ON plpp.PriceListID = pl.ID AND plpp.PricingPolicyID = @pricingPolicyId
      WHERE pli.ProductID = p.ProductID
        AND pl.Enabled = 1
      ORDER BY
        CASE WHEN plpp.ID IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN pli.CostPrice IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
        pl.ValidToDate,
        pl.ValidFromDate DESC,
        pli.ID DESC
    ) price
  OPTION (RECOMPILE);

  -- Pricing policy rules are optional: when no matching rule exists, discounts default to 0.
    INSERT INTO dbo.OfferDetails (
      OfferID,
      ParentOfferDetailID,
      TreeOrdering,
      Ordering,
      IsPrintable,
      IsComment,
      IsCategory,
      ProductID,
      BrandID,
      PartNumber,
      ModelNumber,
      ProductDescription,
      TelmacoWarranty,
      Warranty,
      Quantity,
      ListPrice,
      NetUnitPrice,
      TotalPrice,
      TotalNet,
      TelmacoDiscount,
      CustomerDiscount,
      NetCostOtherCurrency,
      OtherCurrencyID,
      CurrencyCostModifier,
      NetCost,
      Margin,
      GrossProfit,
      TotalCost,
      PriceListID,
      PriceListItemID,
      Comment,
      CreatedOn,
      CreatedBy,
      ModifiedOn,
      ModifiedBy
    )
    OUTPUT INSERTED.ID AS OfferDetailID, INSERTED.TreeOrdering
    SELECT
      @__offerId,
      CASE WHEN @parentTree IS NULL THEN NULL ELSE @__categoryId END,
      CASE
        WHEN @parentTree IS NULL THEN CONVERT(NVARCHAR(255), @maxChild + ROW_NUMBER() OVER (ORDER BY p.Seq))
        ELSE CONCAT(@parentTree, '.', @maxChild + ROW_NUMBER() OVER (ORDER BY p.Seq))
      END,
      @nextOrdering + ROW_NUMBER() OVER (ORDER BY p.Seq) - 1,

      NULL,
      0,
      0,
      p.ProductID,
      p.BrandID,
      p.PartNumber,
      p.ModelNumber,
      p.Description,
      COALESCE(discounts.TelmacoWarrantyYears, 0),
      COALESCE(discounts.CustomerWarrantyYears, 0),
      1,
      p.ListPrice,
      computed.ComputedNetUnitPrice,
      CASE WHEN p.ListPrice IS NULL THEN NULL ELSE p.ListPrice END,
      computed.ComputedNetUnitPrice,
      CASE
        -- Case 2: If cost price exists, calculate Telmaco discount from cost price
        WHEN p.CostPrice IS NOT NULL AND p.ListPrice IS NOT NULL AND p.ListPrice <> 0
          THEN ROUND(
            (CAST(1 AS DECIMAL(18, 8))
              - (CAST(p.CostPrice * p.CurrencyCostModifier AS DECIMAL(18, 8))
                / CAST(p.ListPrice AS DECIMAL(18, 8))
              )
            ) * 100,
            4
          )
        -- Case 1: If no cost price, use discount from pricing policy rule
        ELSE COALESCE(discounts.TelmacoDiscountPercentage, 0)
      END,
      COALESCE(discounts.CustomerDiscountPercentage, 0),
      p.CostPrice,
      p.OtherCurrencyID,
      p.CurrencyCostModifier,
      COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice),
      CASE
        WHEN computed.ComputedNetUnitPrice IS NULL
          OR computed.ComputedNetUnitPrice = 0
          OR COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) IS NULL
          THEN NULL
        ELSE ROUND(
          (CAST(1 AS DECIMAL(18, 8))
            - (CAST(COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) AS DECIMAL(18, 8))
              / CAST(computed.ComputedNetUnitPrice AS DECIMAL(18, 8))
            )
          ) * 100,
          4
        )
      END,
      CASE
        WHEN computed.ComputedNetUnitPrice IS NULL
          OR COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) IS NULL
          THEN NULL
        ELSE ROUND(
          computed.ComputedNetUnitPrice
          - COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice),
          4
        )
      END,
      COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice),
      p.PriceListID,
      p.PriceListItemID,
      @__addComment,
      SYSUTCDATETIME(),
      @__createdBy,
      SYSUTCDATETIME(),
      @__modifiedBy
    FROM @ProductData p
    OUTER APPLY (
      SELECT TOP (1)
        ppr.TelmacoDiscountPercentage,
        ppr.CustomerDiscountPercentage,
        ppr.TelmacoWarrantyYears,
        ppr.CustomerWarrantyYears
      FROM (
        -- Priority 1: Use rules from policy specified in PriceListPricingPolicy
        SELECT TOP (1)
          ppr.TelmacoDiscountPercentage,
          ppr.CustomerDiscountPercentage,
          ppr.TelmacoWarrantyYears,
          ppr.CustomerWarrantyYears,
          1 AS Priority
        FROM dbo.PriceListPricingPolicy plpp
        INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyID = ppr.PricingPolicyID
        WHERE plpp.PriceListID = p.PriceListID
          AND plpp.PricingPolicyID = @pricingPolicyId
          AND (ppr.BrandID = p.BrandID OR ppr.BrandID IS NULL)
        ORDER BY
          CASE WHEN ppr.BrandID = p.BrandID THEN 0 ELSE 1 END,
          ppr.ID DESC

        UNION ALL

        -- Priority 2: Fall back to Offer's PricingPolicyID
        SELECT TOP (1)
          ppr.TelmacoDiscountPercentage,
          ppr.CustomerDiscountPercentage,
          ppr.TelmacoWarrantyYears,
          ppr.CustomerWarrantyYears,
          2 AS Priority
        FROM dbo.PricingPolicyRules ppr
        WHERE ppr.PricingPolicyID = @pricingPolicyId
          AND (ppr.BrandID = p.BrandID OR ppr.BrandID IS NULL)
        ORDER BY
          CASE WHEN ppr.BrandID = p.BrandID THEN 0 ELSE 1 END,
          ppr.ID DESC
      ) ppr
      ORDER BY ppr.Priority
    ) AS discounts
    OUTER APPLY (
      SELECT
        CASE
          WHEN p.ListPrice IS NULL THEN NULL
          ELSE ROUND(
            p.ListPrice
            * (
              CAST(1 AS DECIMAL(18, 8))
              - (CAST(COALESCE(discounts.CustomerDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
            ),
            4
          )
        END AS ComputedNetUnitPrice,
        CASE
          -- Case 2: If cost price exists, use cost price (with currency modifier) as NetCost
          WHEN p.CostPrice IS NOT NULL THEN p.CostPrice * p.CurrencyCostModifier
          -- Case 1: If no cost price, calculate from Telmaco discount percentage
          WHEN p.ListPrice IS NULL THEN NULL
          ELSE ROUND(
            p.ListPrice
            * (
              CAST(1 AS DECIMAL(18, 8))
              - (CAST(COALESCE(discounts.TelmacoDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
            ),
            4
          )
        END AS ComputedNetCost
    ) AS computed
    ORDER BY p.Seq
    OPTION (RECOMPILE);
  `;

  const result = await request.query(query);
  const inserted = result.rowsAffected?.[0] ?? 0;
  const insertedOfferDetailIds = Array.isArray(result.recordset)
    ? result.recordset
      .map((row) => normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
      .filter((id): id is number => id != null)
    : [];
  return NextResponse.json({ ok: true, inserted, insertedOfferDetailIds });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    logger.error(
      `[add-products] offerId=${offerId} categoryId=${categoryId} count=${selections.length}: ${message}`,
      { endpoint: `/api/offers/${offerId}/products/add`, method: 'POST', category: 'mutation' },
      err instanceof Error ? err : undefined,
    );
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

const requestedRowCondition = `
      (
        NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') IS NOT NULL
        OR NULLIF(LTRIM(RTRIM(od.RequestedBrand)), '') IS NOT NULL
        OR NULLIF(LTRIM(RTRIM(od.RequestedModelNo)), '') IS NOT NULL
        OR NULLIF(LTRIM(RTRIM(od.RequestedPartNo)), '') IS NOT NULL
        OR NULLIF(LTRIM(RTRIM(od.RequestedWebLink)), '') IS NOT NULL
        OR NULLIF(LTRIM(RTRIM(od.RequestedDescription)), '') IS NOT NULL
        OR NULLIF(LTRIM(RTRIM(od.RequestedDescription2)), '') IS NOT NULL
        OR od.RequestedQuantity IS NOT NULL
      )
`;

async function handleUnassignRequestedRows(
  offerId: number,
  body: Record<string, unknown>,
  auditUserId: string | number | null,
) {
  const rawIds = body?.offerDetailIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Missing offerDetailIds' },
      { status: 400 },
    );
  }
  const ids = rawIds
    .map((v) => normalizeOfferDetailId(v))
    .filter((v): v is number => v != null);
  if (ids.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'No valid offerDetailIds provided' },
      { status: 400 },
    );
  }

  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('__offerId', sql.Int, offerId);
    request.input('__modifiedBy', sql.Int, auditUserId);

    // Build parameterised IN list
    const idParams = ids.map((id, i) => {
      const paramName = `__id${i}`;
      request.input(paramName, sql.Int, id);
      return `@${paramName}`;
    });

    const query = `
      UPDATE od
      SET
        od.ProductID = NULL,
        od.BrandID = NULL,
        od.PartNumber = NULL,
        od.ModelNumber = NULL,
        od.ProductDescription = NULL,
        od.ListPrice = NULL,
        od.NetUnitPrice = NULL,
        od.TotalPrice = NULL,
        od.TotalNet = NULL,
        od.TelmacoDiscount = NULL,
        od.CustomerDiscount = NULL,
        od.NetCost = NULL,
        od.NetCostOtherCurrency = NULL,
        od.OtherCurrencyID = NULL,
        od.CurrencyCostModifier = NULL,
        od.Margin = NULL,
        od.GrossProfit = NULL,
        od.TotalCost = NULL,
        od.PriceListID = NULL,
        od.PriceListItemID = NULL,
        od.Quantity = 0,
        od.TelmacoWarranty = 0,
        od.Warranty = 0,
        od.IsCategory = 0,
        od.IsComment = 0,
        od.IsPrintable = NULL,
        od.Comment = NULL,
        od.ModifiedOn = SYSUTCDATETIME(),
        od.ModifiedBy = @__modifiedBy
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
        AND od.ID IN (${idParams.join(', ')})
        AND ${requestedRowCondition};
    `;

    const result = await request.query(query);
    const rowsAffected = result.rowsAffected?.[0] ?? 0;

    return NextResponse.json({ ok: true, cleared: rowsAffected });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    logger.error(
      `[unassign-requested] offerId=${offerId} ids=${ids.join(',')}: ${message}`,
      { endpoint: `/api/offers/${offerId}/products/add`, method: 'POST', category: 'mutation' },
      err instanceof Error ? err : undefined,
    );
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

async function handleAssignProductToRequestedRow(
  offerId: number,
  body: Record<string, unknown>,
  auditUserId: string | number | null,
) {
  const requestedRowId = normalizeOfferDetailId(
    body?.requestedRowId ?? (body as { requestedRowID?: unknown })?.requestedRowID ?? null,
  );
  const productId = normalizeProductId(
    body?.productId ?? (body as { productID?: unknown })?.productID ?? null,
  );
  const categoryId = normalizeOfferDetailId(
    body?.categoryId ?? (body as { CategoryID?: unknown })?.CategoryID ?? null,
  );
  const commentRaw = body?.comment ?? (body as { Comment?: unknown })?.Comment ?? null;
  const commentValue = typeof commentRaw === 'string' ? commentRaw.trim() || null : null;

  if (requestedRowId == null || productId == null) {
    return NextResponse.json(
      { ok: false, error: 'Missing requested row or product' },
      { status: 400 },
    );
  }

  try {
  const pool = await getPool();
  let categoryTreeOrdering: string | null = null;
  if (categoryId != null) {
    const lookup = pool.request();
    lookup.input('__offerId', sql.Int, offerId);
    lookup.input('__categoryId', sql.Int, categoryId);
    const lookupResult = await lookup.query<{ TreeOrdering: string | null }>(`
      SELECT TOP (1)
        NULLIF(LTRIM(RTRIM(od.TreeOrdering)), '') AS TreeOrdering
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
        AND od.ID = @__categoryId
    `);
    categoryTreeOrdering = lookupResult.recordset?.[0]?.TreeOrdering ?? null;
  }
  const request = pool.request();
  request.input('__offerId', sql.Int, offerId);
  request.input('__rowId', sql.Int, requestedRowId);
  request.input('__productId', sql.Int, productId);
  request.input('__categoryId', sql.Int, categoryId);
  request.input('__categoryTree', sql.NVarChar(255), categoryTreeOrdering);
  request.input('__modifiedBy', sql.Int, auditUserId);
  request.input('__comment', sql.NVarChar(sql.MAX), commentValue);

  const query = `
    DECLARE @pricingPolicyId INT;

    SELECT @pricingPolicyId = o.PricingPolicyID
    FROM dbo.Offer o
    WHERE o.ID = @__offerId;

    -- Resolve legacy product: if product has no enabled pricelist items
    -- but another product's legacy part number matches, use that product instead
    DECLARE @resolvedProductId INT = @__productId;
    IF NOT EXISTS (
      SELECT 1 FROM dbo.PriceListItems pli
      INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID AND pl.Enabled = 1
      WHERE pli.ProductID = @__productId
    )
    BEGIN
      SELECT TOP (1) @resolvedProductId = p_new.ID
      FROM dbo.Products pr
      INNER JOIN dbo.Products p_new
        ON p_new.LegacyPartNoCleaned = pr.PartNumberCleared
        AND p_new.LegacyPartNoCleaned IS NOT NULL
        AND p_new.LegacyPartNoCleaned <> ''
        AND p_new.ID <> pr.ID
      WHERE pr.ID = @__productId
        AND EXISTS (
          SELECT 1 FROM dbo.PriceListItems pli_chk
          INNER JOIN dbo.PriceLists pl_chk ON pli_chk.PriceListID = pl_chk.ID AND pl_chk.Enabled = 1
          WHERE pli_chk.ProductID = p_new.ID
        )
      ORDER BY p_new.ID DESC;
    END;

    DECLARE @ProductData TABLE (
      ProductID INT NOT NULL,
      Description NVARCHAR(MAX) NULL,
      BrandID INT NULL,
      PartNumber NVARCHAR(255) NULL,
      ModelNumber NVARCHAR(255) NULL,
      WarrantyValue INT NOT NULL,
      PriceListID INT NULL,
      PriceListItemID INT NULL,
      ListPrice DECIMAL(18, 4) NULL,
      CostPrice DECIMAL(18, 4) NULL,
      OtherCurrencyID INT NULL,
      CurrencyCostModifier DECIMAL(18, 8) NULL
    );
    DECLARE @UpdatedRowPricing TABLE (
      OfferDetailID INT NOT NULL,
      Quantity DECIMAL(18, 4) NULL,
      CustomerDiscount DECIMAL(18, 4) NULL,
      TelmacoDiscount DECIMAL(18, 4) NULL
    );

    INSERT INTO @ProductData (
      ProductID,
      Description,
      BrandID,
      PartNumber,
      ModelNumber,
      WarrantyValue,
      PriceListID,
      PriceListItemID,
      ListPrice,
      CostPrice,
      OtherCurrencyID,
      CurrencyCostModifier
    )
    SELECT
      pr.ID AS ProductID,
      pr.Description,
      pr.BrandID,
      pr.PartNumber,
      pr.ModelNumber,
      0 AS WarrantyValue,
      price.PriceListID,
      price.PriceListItemID,
      price.ListPrice,
      price.CostPrice,
      price.OtherCurrencyID,
      price.CurrencyCostModifier
    FROM dbo.Products pr
    OUTER APPLY (
      SELECT TOP (1)
        pli.ID AS PriceListItemID,
        pli.PriceListID,
        pli.ListPrice,
        pli.CostPrice,
        COALESCE(pl.CostCurrencyID, pl.CurrencyId) AS OtherCurrencyID,
        COALESCE(pl.CurrencyCostModifier, 1) AS CurrencyCostModifier
      FROM dbo.PriceListItems pli
        INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
        LEFT JOIN dbo.PriceListPricingPolicy plpp ON plpp.PriceListID = pl.ID AND plpp.PricingPolicyID = @pricingPolicyId
      WHERE pli.ProductID = pr.ID
        AND pl.Enabled = 1
      ORDER BY
        CASE WHEN plpp.ID IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN pli.CostPrice IS NOT NULL THEN 0 ELSE 1 END,
        CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
        pl.ValidToDate,
        pl.ValidFromDate DESC,
        pli.ID DESC
    ) price
    WHERE pr.ID = @resolvedProductId;
    -- Pricing policy rules are optional: when no matching rule exists, discounts default to 0.
    UPDATE od
    SET
      od.TreeOrdering = CASE
        WHEN NULLIF(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), '') IS NULL
          THEN NULLIF(LTRIM(RTRIM(ISNULL(od.RequestedItemNo, ''))), '')
        ELSE od.TreeOrdering
      END,
      od.IsPrintable = NULL,
      od.IsComment = 0,
      od.IsCategory = 0,
      od.ProductID = p.ProductID,
      od.BrandID = p.BrandID,
      od.PartNumber = p.PartNumber,
      od.ModelNumber = p.ModelNumber,
      od.ProductDescription = COALESCE(
        NULLIF(p.Description, ''),
        NULLIF(od.ProductDescription, '')
      ),
      od.TelmacoWarranty = COALESCE(discounts.TelmacoWarrantyYears, 0),
      od.Warranty = COALESCE(discounts.CustomerWarrantyYears, 0),
      od.Quantity = q.Quantity,
      od.ListPrice = p.ListPrice,
      od.NetUnitPrice = computed.ComputedNetUnitPrice,
      od.TotalPrice = CASE WHEN p.ListPrice IS NULL THEN NULL ELSE p.ListPrice * q.Quantity END,
      od.TotalNet = CASE
        WHEN computed.ComputedNetUnitPrice IS NULL THEN NULL
        ELSE computed.ComputedNetUnitPrice * q.Quantity
      END,
      od.TelmacoDiscount = CASE
        WHEN p.CostPrice IS NOT NULL AND p.ListPrice IS NOT NULL AND p.ListPrice <> 0
          THEN ROUND(
            (CAST(1 AS DECIMAL(18, 8))
              - (CAST(p.CostPrice * p.CurrencyCostModifier AS DECIMAL(18, 8))
                / CAST(p.ListPrice AS DECIMAL(18, 8))
              )
            ) * 100,
            4
          )
        ELSE COALESCE(discounts.TelmacoDiscountPercentage, 0)
      END,
      od.CustomerDiscount = COALESCE(discounts.CustomerDiscountPercentage, 0),
      od.NetCostOtherCurrency = p.CostPrice,
      od.OtherCurrencyID = p.OtherCurrencyID,
      od.CurrencyCostModifier = p.CurrencyCostModifier,
      od.NetCost = COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice),
      od.Margin = CASE
        WHEN computed.ComputedNetUnitPrice IS NULL
          OR computed.ComputedNetUnitPrice = 0
          OR COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) IS NULL
          THEN NULL
        ELSE ROUND(
          (CAST(1 AS DECIMAL(18, 8))
            - (CAST(COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) AS DECIMAL(18, 8))
              / CAST(computed.ComputedNetUnitPrice AS DECIMAL(18, 8))
            )
          ) * 100,
          4
        )
      END,
      od.GrossProfit = CASE
        WHEN computed.ComputedNetUnitPrice IS NULL
          OR COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) IS NULL
          THEN NULL
        ELSE ROUND(
          (computed.ComputedNetUnitPrice
            - COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice)
          ) * q.Quantity,
          4
        )
      END,
      od.TotalCost = CASE
        WHEN COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) IS NULL
          THEN NULL
        ELSE COALESCE(computed.ComputedNetCost, p.CostPrice * p.CurrencyCostModifier, p.ListPrice) * q.Quantity
      END,
      od.PriceListID = p.PriceListID,
      od.PriceListItemID = p.PriceListItemID,
      od.Comment = @__comment,
      od.ModifiedOn = SYSUTCDATETIME(),
      od.ModifiedBy = @__modifiedBy
    OUTPUT
      inserted.ID,
      inserted.Quantity,
      inserted.CustomerDiscount,
      inserted.TelmacoDiscount
    INTO @UpdatedRowPricing (
      OfferDetailID,
      Quantity,
      CustomerDiscount,
      TelmacoDiscount
    )
    FROM dbo.OfferDetails od
      CROSS JOIN @ProductData p
      CROSS APPLY (
        SELECT CASE
          WHEN od.RequestedQuantity IS NOT NULL AND od.RequestedQuantity <> 0
            THEN od.RequestedQuantity
          ELSE 1
        END AS Quantity
      ) q
      OUTER APPLY (
        SELECT TOP (1)
          ppr.TelmacoDiscountPercentage,
          ppr.CustomerDiscountPercentage,
          ppr.TelmacoWarrantyYears,
          ppr.CustomerWarrantyYears
        FROM (
          -- Priority 1: Use rules from policy specified in PriceListPricingPolicy
          SELECT TOP (1)
            ppr.TelmacoDiscountPercentage,
            ppr.CustomerDiscountPercentage,
            ppr.TelmacoWarrantyYears,
            ppr.CustomerWarrantyYears,
            1 AS Priority
          FROM dbo.PriceListPricingPolicy plpp
          INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyID = ppr.PricingPolicyID
          WHERE plpp.PriceListID = p.PriceListID
            AND plpp.PricingPolicyID = @pricingPolicyId
            AND (ppr.BrandID = p.BrandID OR ppr.BrandID IS NULL)
          ORDER BY
            CASE WHEN ppr.BrandID = p.BrandID THEN 0 ELSE 1 END,
            ppr.ID DESC

          UNION ALL

          -- Priority 2: Fall back to Offer's PricingPolicyID
          SELECT TOP (1)
            ppr.TelmacoDiscountPercentage,
            ppr.CustomerDiscountPercentage,
            ppr.TelmacoWarrantyYears,
            ppr.CustomerWarrantyYears,
            2 AS Priority
          FROM dbo.PricingPolicyRules ppr
          WHERE ppr.PricingPolicyID = @pricingPolicyId
            AND (ppr.BrandID = p.BrandID OR ppr.BrandID IS NULL)
          ORDER BY
            CASE WHEN ppr.BrandID = p.BrandID THEN 0 ELSE 1 END,
            ppr.ID DESC
        ) ppr
        ORDER BY ppr.Priority
      ) AS discounts
      OUTER APPLY (
        SELECT
          CASE
            WHEN p.ListPrice IS NULL THEN NULL
            ELSE ROUND(
              p.ListPrice
              * (
                CAST(1 AS DECIMAL(18, 8))
                - (CAST(COALESCE(discounts.CustomerDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
              ),
              4
            )
          END AS ComputedNetUnitPrice,
          CASE
            WHEN p.CostPrice IS NOT NULL THEN p.CostPrice * p.CurrencyCostModifier
            WHEN p.ListPrice IS NULL THEN NULL
            ELSE ROUND(
              p.ListPrice
              * (
                CAST(1 AS DECIMAL(18, 8))
                - (CAST(COALESCE(discounts.TelmacoDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
              ),
              4
            )
          END AS ComputedNetCost
      ) AS computed
    WHERE od.OfferID = @__offerId
      AND od.ID = @__rowId
      AND (
        @__categoryId IS NULL
        OR od.ParentOfferDetailID = @__categoryId
        OR (
          @__categoryTree IS NOT NULL
          AND od.TreeOrdering LIKE CONCAT(@__categoryTree, '.%')
        )
      )
      AND ${requestedRowCondition};
    SELECT TOP (1)
      urp.OfferDetailID,
      urp.Quantity,
      urp.CustomerDiscount,
      urp.TelmacoDiscount
    FROM @UpdatedRowPricing urp;
  `;

  const result = await request.query(query);
  const rowsAffected = result.rowsAffected?.[0] ?? 0;
  if (rowsAffected === 0) {
    return NextResponse.json(
      { ok: false, error: 'Unable to assign product to requested row' },
      { status: 400 },
    );
  }

  const pricingRow = (result.recordset?.[0] ?? null) as {
    OfferDetailID?: number | null;
    Quantity?: number | null;
    CustomerDiscount?: number | null;
    TelmacoDiscount?: number | null;
  } | null;

  return NextResponse.json({
    ok: true,
    updated: rowsAffected,
    pricing: pricingRow
      ? {
          offerDetailId: pricingRow.OfferDetailID ?? null,
          quantity: pricingRow.Quantity ?? null,
          customerDiscount: pricingRow.CustomerDiscount ?? null,
          telmacoDiscount: pricingRow.TelmacoDiscount ?? null,
        }
      : null,
  });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    logger.error(
      `[assign-requested] offerId=${offerId} requestedRowId=${requestedRowId} productId=${productId} categoryId=${categoryId}: ${message}`,
      { endpoint: `/api/offers/${offerId}/products/add`, method: 'POST', category: 'mutation' },
      err instanceof Error ? err : undefined,
    );
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products/add');
  try {
    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    const offerId = normalizeOfferId(normalizedId);
    if (offerId == null) {
      return NextResponse.json({ ok: false, error: 'Invalid offer id' }, { status: 400 });
    }

    const body = await readBody(req);
    const actionRaw = typeof body.action === 'string' ? body.action.trim().toLowerCase() : null;

    if (actionRaw === 'categories') {
      return handleCategoryGrid(offerId, body);
    }
    const audit = buildAuditContext(req);
    if (actionRaw === 'unassign-requested') {
      const auth = await requirePermission(req, "editOffers");
      if (!auth.ok) return auth.response;
      return handleUnassignRequestedRows(offerId, body, audit.userId);
    }
    if (actionRaw === 'assign-requested') {
      const auth = await requirePermission(req, "editOffers");
      if (!auth.ok) return auth.response;
      return handleAssignProductToRequestedRow(offerId, body, audit.userId);
    }
    if (actionRaw === 'add') {
      const auth = await requirePermission(req, "editOffers");
      if (!auth.ok) return auth.response;
      return handleAddProducts(offerId, body, audit.userId);
    }

    return handleProductGrid(offerId, body);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    const errNumber =
      err && typeof err === 'object' && 'number' in err && typeof (err as { number?: unknown }).number === 'number'
        ? (err as { number: number }).number
        : null;
    const status = errNumber === 50000 ? 400 : 500;
    logger.error(
      `[products/add] ${message}`,
      { endpoint: '/api/offers/[offerId]/products/add', method: 'POST', category: 'mutation' },
      err instanceof Error ? err : undefined,
    );
    return NextResponse.json({ ok: false, error: message, rows: [], rowCount: 0 }, { status });
  }
}
