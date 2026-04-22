import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import { logger } from '../../../../../../lib/logger';
import { logAddAuditDetails } from '../../../../../../lib/mutationAudit';
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
import { realtimeEvents } from '../../../../../../lib/realtimeEvents';
import { requirePermission } from '../../../../../../lib/authz';
import {
  buildTreeFromRows,
  collectResequencedUpdates,
  TreeOrderingRow,
  TreeOrderingUpdateInput,
} from '../treeOrdering';
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

type HiddenFilterToken = { filter: string; weight?: number };

type GridRequestEnvelope = {
  request?: GridRequest;
  action?: string | null;
  orFilterColumns?: string[];
  // Per-column extra LIKE tokens the client wants OR'd into the WHERE clause
  // and relevance score — without AG Grid's filter popup exposing them.
  // Used to keep the filter-pill UI clean (one phrase visible) while the
  // real query still ORs a broad set of synonyms/word-tokens/cross-folds.
  hiddenFilterTokens?: Record<string, HiddenFilterToken[]>;
  // Anti-intent tokens from the LLM — rows whose target columns match these
  // LIKE tokens are DEPRIORITIZED (subtracted from relevance score) but not
  // excluded.  Lets accessories / spare parts / carrying cases sink below
  // real matches without over-filtering when the LLM mis-classifies.
  negativeHiddenTokens?: Record<string, HiddenFilterToken[]>;
  // Product IDs returned by the semantic (vector) search for the current
  // query — products whose embeddings are nearest to the user's prompt.
  // Applied as a ranking bonus only (does NOT filter rows out), so keyword
  // matches still drive inclusion while semantic neighbors bubble to the top
  // when the user's phrasing doesn't appear literally in the description.
  semanticCandidates?: number[];
};

const TREE_ORDERING_RAW_EXPRESSION = 'NULLIF(LTRIM(RTRIM(od.TreeOrdering)), \'\')';
const TREE_ORDERING_HIERARCHY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    ELSE TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/'))
  END
`;
const TREE_ORDERING_SORT_PRIORITY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN 1
    WHEN TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/')) IS NOT NULL THEN 0
    ELSE 2
  END
`;

const TREE_ORDERING_UPDATE_CHUNK_SIZE = 200;

async function resequenceTreeOrdering(
  pool: Awaited<ReturnType<typeof getPool>>,
  offerId: number,
  userId: number | null,
): Promise<number> {
  const readReq = pool.request();
  readReq.input('__offerId', sql.Int, offerId);
  const readResult = await readReq.query<TreeOrderingRow>(`
    SELECT od.ID AS OfferDetailID, od.TreeOrdering
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND ${TREE_ORDERING_RAW_EXPRESSION} IS NOT NULL
    ORDER BY ${TREE_ORDERING_SORT_PRIORITY_EXPRESSION}, ${TREE_ORDERING_HIERARCHY_EXPRESSION}, od.TreeOrdering;
  `);
  const rows = readResult.recordset ?? [];
  const roots = buildTreeFromRows(rows);
  const updates = collectResequencedUpdates(roots);
  if (updates.length === 0) return 0;

  let rowsAffected = 0;
  for (let idx = 0; idx < updates.length; idx += TREE_ORDERING_UPDATE_CHUNK_SIZE) {
    const chunk = updates.slice(idx, idx + TREE_ORDERING_UPDATE_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const req = pool.request();
    req.input('__offerId', sql.Int, offerId);
    req.input('__modifiedBy', sql.Int, userId);
    const valueClauses: string[] = [];
    chunk.forEach((entry: TreeOrderingUpdateInput, chunkIdx: number) => {
      const idParam = `odid_${chunkIdx}`;
      const orderingParam = `ordering_${chunkIdx}`;
      req.input(idParam, sql.Int, entry.OfferDetailID);
      req.input(orderingParam, sql.NVarChar(255), entry.TreeOrdering);
      valueClauses.push(`(@${idParam}, @${orderingParam})`);
    });
    const updateQuery = `
      WITH PendingUpdates (OfferDetailID, TreeOrdering) AS (
        SELECT v.OfferDetailID, v.TreeOrdering
        FROM (VALUES ${valueClauses.join(', ')}) AS v (OfferDetailID, TreeOrdering)
      )
      UPDATE od
      SET od.TreeOrdering = PendingUpdates.TreeOrdering,
          od.ModifiedOn = SYSUTCDATETIME(),
          od.ModifiedBy = @__modifiedBy
      FROM dbo.OfferDetails od
        INNER JOIN PendingUpdates ON od.ID = PendingUpdates.OfferDetailID
      WHERE od.OfferID = @__offerId;
    `;
    const result = await req.query(updateQuery);
    rowsAffected += result.rowsAffected?.[0] ?? 0;
  }
  return rowsAffected;
}

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

// Weight a text condition by the length of its search value so specific
// phrases dominate generic single-word matches when ranking relevance.
// A product row matching "Cat 7 SFTP RJ45 patch cord" (27 chars → weight 27)
// now outranks one matching just "Cat" (3 chars → weight 3) nine to one.
// When the client tags a condition with an explicit `weight` (e.g. priority
// weight for desc1 vs desc3), that value multiplies the base length weight.
const computeTextWeight = (value: unknown, priority: unknown = 1): number => {
  const baseLen = value == null ? 1 : Math.max(1, String(value).trim().length);
  const mult = typeof priority === 'number' && Number.isFinite(priority) && priority > 0
    ? priority
    : 1;
  return Math.max(1, Math.round(baseLen * mult));
};

const buildWhereClauses = (filterModel: GridRequest['filterModel'], columnExpressions: Record<string, string>) => {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return {
      clauses: [] as Array<{ colId: string; clause: string }>,
      scoreClauses: [] as Array<{ clause: string; weight: number }>,
      params: [] as QueryParam[],
    };
  }
  const clauses: Array<{ colId: string; clause: string }> = [];
  const scoreClauses: Array<{ clause: string; weight: number }> = [];
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
            // Always search LegacyPartNoCleaned alongside PartNumber / ModelNumber.
            // Resolve the alias (`bp` / `p`) from whichever column expression
            // was supplied so the legacy column uses the same table prefix.
            const tablePrefixMatch = /^([a-zA-Z_]\w*)\.(PartNumber|ModelNumber)$/.exec(columnExpression);
            const legacyExpr = tablePrefixMatch
              ? `UPPER(ISNULL(${tablePrefixMatch[1]}.LegacyPartNoCleaned, ''))`
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
            .map((condition, conditionIdx) => ({
              condition,
              result: buildTextConditionClause(condition, `${paramBase}_c${conditionIdx}`),
            }))
            .filter((entry) => entry.result.clause);
          if (conditionResults.length === 0) break;
          if (conditionResults.length === 1) {
            clauses.push({ colId: col, clause: conditionResults[0].result.clause });
          } else {
            clauses.push({ colId: col, clause: `(${conditionResults.map(({ result }) => result.clause).join(` ${operator} `)})` });
          }
          conditionResults.forEach(({ condition, result }) => {
            scoreClauses.push({
              clause: result.clause,
              weight: computeTextWeight(condition.filter, (condition as { weight?: unknown }).weight),
            });
            result.params.forEach((p) => params.push(p));
          });
          break;
        }

        const single = buildTextConditionClause(fm as TextFilterModel, paramBase);
        if (single.clause) {
          clauses.push({ colId: col, clause: single.clause });
          scoreClauses.push({
            clause: single.clause,
            weight: computeTextWeight(
              (fm as TextFilterModel).filter,
              (fm as { weight?: unknown }).weight,
            ),
          });
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
            clauses.push({ colId: col, clause: conditionResults[0].clause });
          } else {
            clauses.push({ colId: col, clause: `(${conditionResults.map((result) => result.clause).join(` ${operator} `)})` });
          }
          conditionResults.forEach((result) => {
            scoreClauses.push({ clause: result.clause, weight: 1 });
            result.params.forEach((p) => params.push(p));
          });
          break;
        }

        const single = buildNumberConditionClause(fm as NumberFilterModel, paramBase);
        if (single.clause) {
          clauses.push({ colId: col, clause: single.clause });
          scoreClauses.push({ clause: single.clause, weight: 1 });
          single.params.forEach((p) => params.push(p));
        }
        break;
      }
      default:
        break;
    }
  });

  return { clauses, scoreClauses, params };
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
  const orCols = new Set(Array.isArray(body?.orFilterColumns) ? body.orFilterColumns : []);
  const orClauses = clauses.filter((c) => orCols.has(c.colId)).map((c) => c.clause);
  const andClauses = clauses.filter((c) => !orCols.has(c.colId)).map((c) => c.clause);
  const finalClauses = [...andClauses];
  if (orClauses.length > 0) {
    finalClauses.push(orClauses.length === 1 ? orClauses[0] : `(${orClauses.join(' OR ')})`);
  }
  const whereSql = finalClauses.length ? `AND ${finalClauses.join(' AND ')}` : '';
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
  WebLink: string | null;
  Description: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  PriceListItemID: number | null;
  PriceListID: number | null;
  PriceListName: string | null;
  ListPrice: number | null;
  CostPrice: number | null;
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
    CostPrice: 'price.CostPrice',
  };

  const { clauses, scoreClauses, params } = buildWhereClauses(gridRequest.filterModel, columnExpressions);

  // Fold in hidden per-column tokens from the request payload.  These are
  // extra LIKE predicates the client wants applied without polluting AG Grid's
  // filter popup (e.g. desc2/desc3/synonym expansions).  Each token OR'd into
  // the column's existing clause and also contributes a weighted score term.
  const hiddenTokens = body?.hiddenFilterTokens;
  if (hiddenTokens && typeof hiddenTokens === 'object' && !Array.isArray(hiddenTokens)) {
    Object.entries(hiddenTokens).forEach(([colId, tokens]) => {
      if (!Array.isArray(tokens) || tokens.length === 0) return;
      const colExpr = columnExpressions[colId];
      if (!colExpr) return;
      const tokenClauses: string[] = [];
      tokens.forEach((token, idx) => {
        if (!token || typeof token.filter !== 'string') return;
        const value = token.filter.trim();
        if (!value) return;
        const paramKey = `hidden_${colId}_${idx}`;
        const { clause, params: tokenParams } = buildTextMatchPredicate(colExpr, value, {
          paramKey,
          mode: 'contains',
          enableFuzzy: false,
        });
        if (!clause) return;
        tokenClauses.push(clause);
        tokenParams.forEach((p) => params.push(p));
        scoreClauses.push({ clause, weight: computeTextWeight(value, token.weight) });
      });
      if (tokenClauses.length === 0) return;
      const existingIdx = clauses.findIndex((c) => c.colId === colId);
      if (existingIdx >= 0) {
        const merged = `(${clauses[existingIdx].clause} OR ${tokenClauses.join(' OR ')})`;
        clauses[existingIdx] = { colId, clause: merged };
      } else {
        clauses.push({
          colId,
          clause: tokenClauses.length === 1 ? tokenClauses[0] : `(${tokenClauses.join(' OR ')})`,
        });
      }
    });
  }

  // Negative hidden tokens: LLM-derived anti-intent words.  Each matched
  // token subtracts from the relevance score so accessories / spare parts /
  // carrying cases rank below true product matches.  We do NOT add these
  // to the WHERE clauses — rows matching only negatives still appear, they
  // just sink.  The per-token penalty is scaled to the token's own length
  // so a strong signal like "carrying case" outweighs a weak one like "kit".
  const negativeTokens = body?.negativeHiddenTokens;
  if (negativeTokens && typeof negativeTokens === 'object' && !Array.isArray(negativeTokens)) {
    Object.entries(negativeTokens).forEach(([colId, tokens]) => {
      if (!Array.isArray(tokens) || tokens.length === 0) return;
      const colExpr = columnExpressions[colId];
      if (!colExpr) return;
      tokens.forEach((token, idx) => {
        if (!token || typeof token.filter !== 'string') return;
        const value = token.filter.trim();
        if (!value) return;
        const paramKey = `neg_${colId}_${idx}`;
        const { clause, params: tokenParams } = buildTextMatchPredicate(colExpr, value, {
          paramKey,
          mode: 'contains',
          enableFuzzy: false,
        });
        if (!clause) return;
        tokenParams.forEach((p) => params.push(p));
        // Negative weight scaled by value length × 4 so a matched negative
        // cancels roughly four times that word's positive contribution.
        // That's enough to bump accessories below real matches without
        // zeroing them out entirely.
        const basePenalty = Math.max(4, value.length * 4);
        scoreClauses.push({ clause, weight: -basePenalty });
      });
    });
  }

  // Semantic candidates: rank-ordered ProductIDs from the vector search.
  // Applied as a pure score boost (not a WHERE filter) so that keyword
  // matches still drive inclusion but semantically similar products bubble
  // up even when the user's phrasing doesn't appear literally.  The weight
  // decays linearly with rank — top candidate scores ~100, 50th scores ~2.
  const rawSemanticCandidates = Array.isArray(body?.semanticCandidates) ? body.semanticCandidates : [];
  const SEMANTIC_MAX_WEIGHT = 100;
  let seenSemanticIds = 0;
  rawSemanticCandidates.forEach((pid, rank) => {
    if (typeof pid !== 'number' || !Number.isFinite(pid)) return;
    const paramKey = `__sem_${seenSemanticIds}`;
    params.push({ key: paramKey, value: Math.trunc(pid) });
    const weight = Math.max(2, SEMANTIC_MAX_WEIGHT - rank * 2);
    scoreClauses.push({ clause: `bp.ProductID = @${paramKey}`, weight });
    seenSemanticIds += 1;
  });

  const orCols = new Set(Array.isArray(body?.orFilterColumns) ? body.orFilterColumns : []);
  const orClauses = clauses.filter((c) => orCols.has(c.colId)).map((c) => c.clause);
  const andClauses = clauses.filter((c) => !orCols.has(c.colId)).map((c) => c.clause);
  const finalClauses = [...andClauses];
  if (orClauses.length > 0) {
    finalClauses.push(orClauses.length === 1 ? orClauses[0] : `(${orClauses.join(' OR ')})`);
  }
  const whereSql = finalClauses.length ? `WHERE ${finalClauses.join(' AND ')}` : '';
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
  // Relevance score: weighted sum over matching atomic filter conditions.
  // Each condition's weight is the length of its search string — "Cat 7 SFTP
  // RJ45 patch cord" (27) beats "Cat" (3) 9:1, so rows that hit the full
  // requested phrase crowd out rows that only hit a stray generic token.
  const scoreExpr = scoreClauses.length > 0
    ? scoreClauses.map((c) => `(CASE WHEN ${c.clause} THEN ${c.weight} ELSE 0 END)`).join(' + ')
    : null;
  const userSortActive = Array.isArray(gridRequest.sortModel) && gridRequest.sortModel.length > 0;
  // When relevance score is active but the user hasn't picked a sort column,
  // avoid the generic BrandName/ModelNumber default — it tends to surface
  // alphabetically-first rows (often numeric/prefix noise) within score ties.
  // ProductID DESC is a cleaner tiebreaker: newer products first, fully
  // deterministic, and score stays dominant.
  const defaultOrder = scoreExpr && !userSortActive
    ? 'ORDER BY bp.ProductID DESC'
    : DEFAULT_PRODUCT_ORDER;
  const baseOrderSql = buildOrderSql(
    gridRequest.sortModel,
    columnExpressions,
    defaultOrder,
  );
  // Prepend match-score DESC so the closest match wins, then the user's sort
  // (if any), then the highlight pin.
  const orderSqlWithScore = scoreExpr
    ? baseOrderSql.replace(/^ORDER BY /i, `ORDER BY (${scoreExpr}) DESC, `)
    : baseOrderSql;
  const orderSql = highlightProductId != null
    ? orderSqlWithScore.replace(/^ORDER BY /i, 'ORDER BY CASE WHEN bp.ProductID = @__highlightProductId THEN 0 ELSE 1 END, ')
    : orderSqlWithScore;

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
        p.WebLink,
        b.Name AS BrandName
      FROM dbo.Products p
        LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
    )
    SELECT
      COUNT_BIG(1) OVER () AS __totalCount,
      bp.ProductID,
      bp.PartNumber,
      bp.WebLink,
      bp.Description,
      bp.ModelNumber,
      bp.BrandName,
      price.PriceListItemID,
      price.PriceListID,
      price.PriceListName,
      price.ListPrice,
      price.CostPrice,
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
          pli.CostPrice,
          pl.ValidFromDate AS PriceListValidFromDate,
          pl.ValidToDate AS PriceListValidToDate,
          pl.Enabled AS PriceListEnabled
        FROM dbo.PriceListItems pli
          INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
          LEFT JOIN dbo.PriceListPricingPolicy plpp ON plpp.PriceListID = pl.ID AND plpp.PricingPolicyID = @__pricingPolicyId
        WHERE pl.Enabled = 1
          AND pli.ProductID = bp.ProductID
        ORDER BY
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
  -- Safety: drop leftover temp tables from previous pooled-connection usage
  IF OBJECT_ID('tempdb..#PP') IS NOT NULL DROP TABLE #PP;
  IF OBJECT_ID('tempdb..#PD') IS NOT NULL DROP TABLE #PD;

  DECLARE @parentTree NVARCHAR(255) = NULLIF(LTRIM(RTRIM(@__parentTree)), '');
  DECLARE @prefix NVARCHAR(260);
  DECLARE @targetSegments INT;
  DECLARE @maxChild INT;
  DECLARE @pricingPolicyId INT;
  DECLARE @offerCurrencyId INT;
  DECLARE @offerCurrencyModifier DECIMAL(18, 8);

  SELECT
    @pricingPolicyId = o.PricingPolicyID,
    @offerCurrencyId = o.CurrencyID,
    @offerCurrencyModifier = o.CurrencyModifier
  FROM dbo.Offer o
  WHERE o.ID = @__offerId;

  DECLARE @euroCurrencyId INT;
  SELECT TOP 1 @euroCurrencyId = ID
  FROM dbo.Currencies
  WHERE Name = N'€' OR LOWER(Name) LIKE '%eur%'
  ORDER BY
    CASE WHEN Name = N'€' THEN 0
         WHEN LOWER(Name) LIKE '%eur%' THEN 1
         WHEN LOWER(Name) LIKE '%euro%' THEN 2
         ELSE 3
    END;

  IF @offerCurrencyId IS NULL SET @offerCurrencyId = @euroCurrencyId;

  IF @parentTree IS NULL
  BEGIN
    SELECT @maxChild =
      MAX(TRY_CONVERT(INT, NULLIF(LTRIM(RTRIM(od.TreeOrdering)), '')))
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId;
    SET @maxChild = ISNULL(@maxChild, 0);
  END
  ELSE
  BEGIN
    SET @prefix = CONCAT(@parentTree, '.');
    SET @targetSegments = (LEN(@parentTree) - LEN(REPLACE(@parentTree, '.', '')) + 2);
    SELECT @maxChild =
      MAX(TRY_CONVERT(INT, RIGHT(t.TreeOrderingTrimmed, CHARINDEX('.', REVERSE(t.TreeOrderingTrimmed) + '.') - 1)))
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

  DECLARE @nextOrdering INT = (
    SELECT ISNULL(MAX(ISNULL(od.Ordering, 0)), 0) + 1
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
  );

  -- Temp table with clustered index (proper statistics, unlike table variables)
  CREATE TABLE #PP (
    ProductID INT NOT NULL PRIMARY KEY CLUSTERED,
    Seq INT NOT NULL
  );
  INSERT INTO #PP (ProductID, Seq)
  SELECT DISTINCT v.ProductID, v.Seq
  FROM (VALUES ${valueClauses.join(', ')}) AS v (ProductID, Seq);

  -- Resolve legacy products: if product has no enabled pricelist items
  -- but another product's legacy part number matches, use that product instead
  UPDATE pp
  SET pp.ProductID = resolved.NewProductID
  FROM #PP pp
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
  ) resolved;

  -- Full product data with pricing, discounts, and computed values pre-calculated
  CREATE TABLE #PD (
    ProductID INT NOT NULL PRIMARY KEY CLUSTERED,
    Seq INT NOT NULL,
    Description NVARCHAR(MAX) NULL,
    BrandID INT NULL,
    PartNumber NVARCHAR(255) NULL,
    ModelNumber NVARCHAR(255) NULL,
    PriceListID INT NULL,
    PriceListItemID INT NULL,
    ListPrice DECIMAL(18, 4) NULL,
    CostPrice DECIMAL(18, 4) NULL,
    OtherCurrencyID INT NULL,
    CurrencyCostModifier DECIMAL(18, 8) NULL,
    TelmacoWarrantyYears INT NOT NULL DEFAULT 0,
    CustomerWarrantyYears INT NOT NULL DEFAULT 0,
    TelmacoDiscountPct DECIMAL(18, 4) NOT NULL DEFAULT 0,
    CustomerDiscountPct DECIMAL(18, 4) NOT NULL DEFAULT 0,
    ComputedTelmacoDiscount DECIMAL(18, 4) NOT NULL DEFAULT 0,
    ComputedNetUnitPrice DECIMAL(18, 4) NULL,
    ComputedNetCost DECIMAL(18, 4) NULL
  );

  -- Step 1: Base product data + best price
  INSERT INTO #PD (
    ProductID, Seq, Description, BrandID, PartNumber, ModelNumber,
    PriceListID, PriceListItemID, ListPrice, CostPrice,
    OtherCurrencyID, CurrencyCostModifier
  )
  SELECT
    p.ProductID, p.Seq, pr.Description, pr.BrandID, pr.PartNumber, pr.ModelNumber,
    price.PriceListID, price.PriceListItemID, price.ListPrice, price.CostPrice,
    price.OtherCurrencyID, price.CurrencyCostModifier
  FROM #PP p
    INNER JOIN dbo.Products pr ON pr.ID = p.ProductID
    OUTER APPLY (
      SELECT TOP (1)
        pli.ID AS PriceListItemID,
        pli.PriceListID,
        CASE WHEN pl.CurrencyId = @offerCurrencyId THEN pli.ListPrice
             ELSE pli.ListPrice * COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1)
        END AS ListPrice,
        pli.CostPrice,
        CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
             ELSE COALESCE(pl.CostCurrencyID, pl.CurrencyId) END AS OtherCurrencyID,
        CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
             ELSE COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1) END AS CurrencyCostModifier
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
    ) price;

  -- Step 2: Apply pricing policy discount rules
  UPDATE pd SET
    pd.TelmacoWarrantyYears = COALESCE(discounts.TelmacoWarrantyYears, 0),
    pd.CustomerWarrantyYears = COALESCE(discounts.CustomerWarrantyYears, 0),
    pd.TelmacoDiscountPct = COALESCE(discounts.TelmacoDiscountPercentage, 0),
    pd.CustomerDiscountPct = COALESCE(discounts.CustomerDiscountPercentage, 0)
  FROM #PD pd
  OUTER APPLY (
    SELECT TOP (1)
      ppr.TelmacoDiscountPercentage,
      ppr.CustomerDiscountPercentage,
      ppr.TelmacoWarrantyYears,
      ppr.CustomerWarrantyYears
    FROM (
      SELECT TOP (1)
        ppr.TelmacoDiscountPercentage,
        ppr.CustomerDiscountPercentage,
        ppr.TelmacoWarrantyYears,
        ppr.CustomerWarrantyYears,
        1 AS Priority
      FROM dbo.PriceListPricingPolicy plpp
      INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyID = ppr.PricingPolicyID
      WHERE plpp.PriceListID = pd.PriceListID
        AND plpp.PricingPolicyID = @pricingPolicyId
        AND (ppr.BrandID = pd.BrandID OR ppr.BrandID IS NULL)
      ORDER BY
        CASE WHEN ppr.BrandID = pd.BrandID THEN 0 ELSE 1 END,
        ppr.ID DESC

      UNION ALL

      SELECT TOP (1)
        ppr.TelmacoDiscountPercentage,
        ppr.CustomerDiscountPercentage,
        ppr.TelmacoWarrantyYears,
        ppr.CustomerWarrantyYears,
        2 AS Priority
      FROM dbo.PricingPolicyRules ppr
      WHERE ppr.PricingPolicyID = @pricingPolicyId
        AND (ppr.BrandID = pd.BrandID OR ppr.BrandID IS NULL)
      ORDER BY
        CASE WHEN ppr.BrandID = pd.BrandID THEN 0 ELSE 1 END,
        ppr.ID DESC
    ) ppr
    ORDER BY ppr.Priority
  ) AS discounts;

  -- Step 3: Compute derived pricing values
  UPDATE pd SET
    pd.ComputedNetUnitPrice = CASE
      WHEN pd.ListPrice IS NULL THEN NULL
      ELSE ROUND(
        pd.ListPrice
        * (CAST(1 AS DECIMAL(18, 8)) - (CAST(pd.CustomerDiscountPct AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))),
        4
      )
    END,
    pd.ComputedNetCost = CASE
      WHEN pd.CostPrice IS NOT NULL AND pd.CurrencyCostModifier IS NOT NULL THEN pd.CostPrice * pd.CurrencyCostModifier
      WHEN pd.CostPrice IS NOT NULL THEN pd.CostPrice
      WHEN pd.ListPrice IS NULL THEN NULL
      ELSE ROUND(
        pd.ListPrice
        * (CAST(1 AS DECIMAL(18, 8)) - (CAST(pd.TelmacoDiscountPct AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))),
        4
      )
    END,
    pd.ComputedTelmacoDiscount = CASE
      WHEN pd.CostPrice IS NOT NULL AND pd.ListPrice IS NOT NULL AND pd.ListPrice <> 0
        THEN ROUND(
          (CAST(1 AS DECIMAL(18, 8))
            - (CAST(pd.CostPrice * COALESCE(pd.CurrencyCostModifier, 1) AS DECIMAL(18, 8))
              / CAST(pd.ListPrice AS DECIMAL(18, 8))
            )
          ) * 100,
          4
        )
      ELSE pd.TelmacoDiscountPct
    END
  FROM #PD pd;

  -- Step 4: Simple INSERT from pre-computed data (no OUTER APPLYs)
  INSERT INTO dbo.OfferDetails (
    OfferID, ParentOfferDetailID, TreeOrdering, Ordering,
    IsPrintable, IsComment, IsCategory,
    ProductID, BrandID, PartNumber, ModelNumber, ProductDescription,
    TelmacoWarranty, Warranty, Quantity,
    ListPrice, NetUnitPrice, TotalPrice, TotalNet,
    TelmacoDiscount, CustomerDiscount,
    NetCostOtherCurrency, OtherCurrencyID, CurrencyCostModifier,
    NetCost, Margin, GrossProfit, TotalCost,
    PriceListID, PriceListItemID,
    Comment,
    CreatedOn, CreatedBy, ModifiedOn, ModifiedBy
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
    NULL, 0, 0,
    p.ProductID, p.BrandID, p.PartNumber, p.ModelNumber, p.Description,
    p.TelmacoWarrantyYears,
    p.CustomerWarrantyYears,
    1,
    p.ListPrice,
    p.ComputedNetUnitPrice,
    CASE WHEN p.ListPrice IS NULL THEN NULL ELSE p.ListPrice END,
    p.ComputedNetUnitPrice,
    p.ComputedTelmacoDiscount,
    p.CustomerDiscountPct,
    CASE WHEN p.OtherCurrencyID IS NULL THEN NULL ELSE p.CostPrice END,
    p.OtherCurrencyID,
    p.CurrencyCostModifier,
    COALESCE(p.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice),
    CASE
      WHEN p.ComputedNetUnitPrice IS NULL
        OR p.ComputedNetUnitPrice = 0
        OR COALESCE(p.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) IS NULL
        THEN NULL
      ELSE ROUND(
        (CAST(1 AS DECIMAL(18, 8))
          - (CAST(COALESCE(p.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) AS DECIMAL(18, 8))
            / CAST(p.ComputedNetUnitPrice AS DECIMAL(18, 8))
          )
        ) * 100,
        4
      )
    END,
    CASE
      WHEN p.ComputedNetUnitPrice IS NULL
        OR COALESCE(p.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) IS NULL
        THEN NULL
      ELSE ROUND(
        p.ComputedNetUnitPrice
        - COALESCE(p.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice),
        4
      )
    END,
    COALESCE(p.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice),
    p.PriceListID,
    p.PriceListItemID,
    @__addComment,
    SYSUTCDATETIME(),
    @__createdBy,
    SYSUTCDATETIME(),
    @__modifiedBy
  FROM #PD p
  ORDER BY p.Seq;

  -- Cleanup temp tables (important for connection pooling)
  DROP TABLE #PP;
  DROP TABLE #PD;
  `;

  const result = await request.query(query);
  const inserted = result.rowsAffected?.[0] ?? 0;
  const insertedOfferDetailIds = Array.isArray(result.recordset)
    ? result.recordset
      .map((row) => normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
      .filter((id): id is number => id != null)
    : [];

  // Resequence tree ordering to close any gaps
  if (inserted > 0) {
    try {
      await resequenceTreeOrdering(pool, offerId, typeof auditUserId === 'number' ? auditUserId : null);
    } catch (reseqErr) {
      logger.error(
        `[add-products] resequence failed for offerId=${offerId}`,
        { endpoint: `/api/offers/${offerId}/products/add`, method: 'POST', category: 'mutation' },
        reseqErr instanceof Error ? reseqErr : undefined,
      );
    }

    realtimeEvents.emit(
      `offer:${offerId}:products`,
      'rows-refresh',
      { reason: 'add-products', inserted, updatedBy: auditUserId ?? null },
    );

    const createdRows = selections.map((entry, idx) => ({
      id: insertedOfferDetailIds[idx] ?? `seq-${entry.sequence}`,
      productId: entry.productId,
      offerDetailId: insertedOfferDetailIds[idx] ?? null,
    }));
    logAddAuditDetails({
      endpoint: `/api/offers/${offerId}/products/add`,
      method: 'POST',
      userId: auditUserId != null ? String(auditUserId) : null,
      targetEntity: 'offerProducts',
      createdRows,
      message: `Added ${inserted} product${inserted === 1 ? '' : 's'} to offer ${offerId} (productIds: ${selections.map((s) => s.productId).join(', ')})`,
      extra: { offerId, categoryId, productIds: selections.map((s) => s.productId) },
    });
  }

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

    // Build parameterised IN list
    const idParamEntries = ids.map((id, i) => ({ name: `__id${i}`, value: id }));
    const idParamNames = idParamEntries.map((e) => `@${e.name}`).join(', ');

    // Pre-fetch rows that will be cleared so the client can undo
    const prefetchReq = pool.request();
    prefetchReq.input('__offerId', sql.Int, offerId);
    for (const entry of idParamEntries) {
      prefetchReq.input(entry.name, sql.Int, entry.value);
    }
    const prefetchResult = await prefetchReq.query<Record<string, unknown>>(`
      SELECT od.ID AS OfferDetailID,
             od.ProductID, od.BrandID, od.PartNumber, od.ModelNumber,
             od.ProductDescription, od.ListPrice, od.NetUnitPrice, od.TotalPrice, od.TotalNet,
             od.TelmacoDiscount, od.CustomerDiscount, od.NetCost, od.NetCostOtherCurrency,
             od.OtherCurrencyID, od.CurrencyCostModifier,
             od.Margin, od.GrossProfit, od.TotalCost,
             od.PriceListID, od.PriceListItemID,
             od.Quantity, od.TelmacoWarranty, od.Warranty,
             od.IsCategory, od.IsComment, od.IsPrintable, od.Comment
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
        AND od.ID IN (${idParamNames})
        AND ${requestedRowCondition}
    `);
    const previousRows = prefetchResult.recordset ?? [];

    const request = pool.request();
    request.input('__offerId', sql.Int, offerId);
    request.input('__modifiedBy', sql.Int, auditUserId);
    for (const entry of idParamEntries) {
      request.input(entry.name, sql.Int, entry.value);
    }

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
        AND od.ID IN (${idParamNames})
        AND ${requestedRowCondition};
    `;

    const result = await request.query(query);
    const rowsAffected = result.rowsAffected?.[0] ?? 0;

    if (rowsAffected > 0) {
      realtimeEvents.emit(
        `offer:${offerId}:products`,
        'rows-refresh',
        { reason: 'unassign-requested', cleared: rowsAffected, offerDetailIds: ids, updatedBy: auditUserId ?? null },
      );
    }

    return NextResponse.json({ ok: true, cleared: rowsAffected, previousRows });
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

async function handleSnapshotRows(offerId: number, body: Record<string, unknown>) {
  const rawIds = body?.offerDetailIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    return NextResponse.json({ ok: true, rows: [] });
  }
  const ids = rawIds
    .map((v) => normalizeOfferDetailId(v))
    .filter((v): v is number => v != null);
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, rows: [] });
  }

  try {
    const pool = await getPool();
    const idParamEntries = ids.map((id, i) => ({ name: `__sid${i}`, value: id }));
    const idParamNames = idParamEntries.map((e) => `@${e.name}`).join(', ');

    const req = pool.request();
    req.input('__offerId', sql.Int, offerId);
    for (const entry of idParamEntries) {
      req.input(entry.name, sql.Int, entry.value);
    }
    const result = await req.query<Record<string, unknown>>(`
      SELECT od.ID AS OfferDetailID,
             od.ProductID, od.BrandID, od.PartNumber, od.ModelNumber,
             od.ProductDescription, od.ListPrice, od.NetUnitPrice, od.TotalPrice, od.TotalNet,
             od.TelmacoDiscount, od.CustomerDiscount, od.NetCost, od.NetCostOtherCurrency,
             od.OtherCurrencyID, od.CurrencyCostModifier,
             od.Margin, od.GrossProfit, od.TotalCost,
             od.PriceListID, od.PriceListItemID,
             od.Quantity, od.TelmacoWarranty, od.Warranty,
             od.IsCategory, od.IsComment, od.IsPrintable, od.Comment
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
        AND od.ID IN (${idParamNames})
    `);
    return NextResponse.json({ ok: true, rows: result.recordset ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    logger.error(
      `[snapshot-rows] offerId=${offerId}: ${message}`,
      { endpoint: `/api/offers/${offerId}/products/add`, method: 'POST', category: 'mutation' },
      err instanceof Error ? err : undefined,
    );
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

async function handleRestoreRows(offerId: number, body: Record<string, unknown>) {
  const rawRows = body?.rows;
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return NextResponse.json({ ok: true, restored: 0 });
  }

  try {
    const pool = await getPool();
    let restored = 0;

    for (const rawRow of rawRows) {
      const row = rawRow as Record<string, unknown>;
      const id = normalizeOfferDetailId(row?.OfferDetailID ?? null);
      if (id == null) continue;

      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      request.input('__id', sql.Int, id);
      request.input('ProductID', sql.Int, row.ProductID != null ? Number(row.ProductID) : null);
      request.input('BrandID', sql.Int, row.BrandID != null ? Number(row.BrandID) : null);
      request.input('PartNumber', sql.NVarChar(255), row.PartNumber != null ? String(row.PartNumber) : null);
      request.input('ModelNumber', sql.NVarChar(255), row.ModelNumber != null ? String(row.ModelNumber) : null);
      request.input('ProductDescription', sql.NVarChar(sql.MAX), row.ProductDescription != null ? String(row.ProductDescription) : null);
      request.input('ListPrice', sql.Decimal(18, 4), row.ListPrice != null ? Number(row.ListPrice) : null);
      request.input('NetUnitPrice', sql.Decimal(18, 4), row.NetUnitPrice != null ? Number(row.NetUnitPrice) : null);
      request.input('TelmacoDiscount', sql.Decimal(18, 4), row.TelmacoDiscount != null ? Number(row.TelmacoDiscount) : null);
      request.input('CustomerDiscount', sql.Decimal(18, 4), row.CustomerDiscount != null ? Number(row.CustomerDiscount) : null);
      request.input('NetCost', sql.Decimal(18, 4), row.NetCost != null ? Number(row.NetCost) : null);
      request.input('NetCostOtherCurrency', sql.Decimal(18, 4), row.NetCostOtherCurrency != null ? Number(row.NetCostOtherCurrency) : null);
      request.input('OtherCurrencyID', sql.Int, row.OtherCurrencyID != null ? Number(row.OtherCurrencyID) : null);
      request.input('CurrencyCostModifier', sql.Decimal(18, 4), row.CurrencyCostModifier != null ? Number(row.CurrencyCostModifier) : null);
      request.input('Margin', sql.Decimal(18, 4), row.Margin != null ? Number(row.Margin) : null);
      request.input('GrossProfit', sql.Decimal(18, 4), row.GrossProfit != null ? Number(row.GrossProfit) : null);
      request.input('TotalCost', sql.Decimal(18, 4), row.TotalCost != null ? Number(row.TotalCost) : null);
      request.input('PriceListID', sql.Int, row.PriceListID != null ? Number(row.PriceListID) : null);
      request.input('PriceListItemID', sql.Int, row.PriceListItemID != null ? Number(row.PriceListItemID) : null);
      request.input('Quantity', sql.Decimal(18, 4), row.Quantity != null ? Number(row.Quantity) : null);
      request.input('TelmacoWarranty', sql.NVarChar(255), row.TelmacoWarranty != null ? String(row.TelmacoWarranty) : null);
      request.input('Warranty', sql.NVarChar(255), row.Warranty != null ? String(row.Warranty) : null);
      request.input('IsCategory', sql.Bit, row.IsCategory ? 1 : 0);
      request.input('IsComment', sql.Bit, row.IsComment ? 1 : 0);
      request.input('IsPrintable', sql.Bit, row.IsPrintable ? 1 : 0);
      request.input('Comment', sql.NVarChar(sql.MAX), row.Comment != null ? String(row.Comment) : null);

      await request.query(`
        UPDATE dbo.OfferDetails SET
          ProductID            = @ProductID,
          BrandID              = @BrandID,
          PartNumber           = @PartNumber,
          ModelNumber          = @ModelNumber,
          ProductDescription   = @ProductDescription,
          ListPrice            = @ListPrice,
          NetUnitPrice         = @NetUnitPrice,
          TelmacoDiscount      = @TelmacoDiscount,
          CustomerDiscount     = @CustomerDiscount,
          NetCost              = @NetCost,
          NetCostOtherCurrency = @NetCostOtherCurrency,
          OtherCurrencyID      = @OtherCurrencyID,
          CurrencyCostModifier = @CurrencyCostModifier,
          Margin               = @Margin,
          GrossProfit          = @GrossProfit,
          TotalCost            = @TotalCost,
          PriceListID          = @PriceListID,
          PriceListItemID      = @PriceListItemID,
          Quantity             = @Quantity,
          TelmacoWarranty      = @TelmacoWarranty,
          Warranty             = @Warranty,
          IsCategory           = @IsCategory,
          IsComment            = @IsComment,
          IsPrintable          = @IsPrintable,
          Comment              = @Comment
        WHERE ID = @__id AND OfferID = @__offerId
      `);
      restored++;
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Server error';
    logger.error(
      `[restore-rows] offerId=${offerId}: ${message}`,
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
    DECLARE @offerCurrencyId INT;
    DECLARE @offerCurrencyModifier DECIMAL(18, 8);

    SELECT
      @pricingPolicyId = o.PricingPolicyID,
      @offerCurrencyId = o.CurrencyID,
      @offerCurrencyModifier = o.CurrencyModifier
    FROM dbo.Offer o
    WHERE o.ID = @__offerId;

    -- Capture the requested fields from the original row so we can also assign
    -- the same product to any other unassigned rows in this offer with identical
    -- requested data.
    DECLARE @reqBrand NVARCHAR(MAX);
    DECLARE @reqModel NVARCHAR(MAX);
    DECLARE @reqPart NVARCHAR(MAX);
    DECLARE @reqDesc1 NVARCHAR(MAX);
    DECLARE @reqDesc2 NVARCHAR(MAX);
    DECLARE @reqDesc3 NVARCHAR(MAX);
    SELECT
      @reqBrand = od.RequestedBrand,
      @reqModel = od.RequestedModelNo,
      @reqPart  = od.RequestedPartNo,
      @reqDesc1 = od.RequestedDescription,
      @reqDesc2 = od.RequestedDescription2,
      @reqDesc3 = od.RequestedDescription3
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND od.ID = @__rowId;

    DECLARE @euroCurrencyId INT;
    SELECT TOP 1 @euroCurrencyId = ID
    FROM dbo.Currencies
    WHERE Name = N'€' OR LOWER(Name) LIKE '%eur%'
    ORDER BY
      CASE WHEN Name = N'€' THEN 0
           WHEN LOWER(Name) LIKE '%eur%' THEN 1
           WHEN LOWER(Name) LIKE '%euro%' THEN 2
           ELSE 3
      END;

    IF @offerCurrencyId IS NULL SET @offerCurrencyId = @euroCurrencyId;

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
        CASE WHEN pl.CurrencyId = @offerCurrencyId THEN pli.ListPrice
             ELSE pli.ListPrice * COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1)
        END AS ListPrice,
        pli.CostPrice,
        CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
             ELSE COALESCE(pl.CostCurrencyID, pl.CurrencyId) END AS OtherCurrencyID,
        CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
             ELSE COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1) END AS CurrencyCostModifier
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
              - (CAST(p.CostPrice * COALESCE(p.CurrencyCostModifier, 1) AS DECIMAL(18, 8))
                / CAST(p.ListPrice AS DECIMAL(18, 8))
              )
            ) * 100,
            4
          )
        ELSE COALESCE(discounts.TelmacoDiscountPercentage, 0)
      END,
      od.CustomerDiscount = COALESCE(discounts.CustomerDiscountPercentage, 0),
      od.NetCostOtherCurrency = CASE WHEN p.OtherCurrencyID IS NULL THEN NULL ELSE p.CostPrice END,
      od.OtherCurrencyID = p.OtherCurrencyID,
      od.CurrencyCostModifier = p.CurrencyCostModifier,
      od.NetCost = COALESCE(computed.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice),
      od.Margin = CASE
        WHEN computed.ComputedNetUnitPrice IS NULL
          OR computed.ComputedNetUnitPrice = 0
          OR COALESCE(computed.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) IS NULL
          THEN NULL
        ELSE ROUND(
          (CAST(1 AS DECIMAL(18, 8))
            - (CAST(COALESCE(computed.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) AS DECIMAL(18, 8))
              / CAST(computed.ComputedNetUnitPrice AS DECIMAL(18, 8))
            )
          ) * 100,
          4
        )
      END,
      od.GrossProfit = CASE
        WHEN computed.ComputedNetUnitPrice IS NULL
          OR COALESCE(computed.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) IS NULL
          THEN NULL
        ELSE ROUND(
          (computed.ComputedNetUnitPrice
            - COALESCE(computed.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice)
          ) * q.Quantity,
          4
        )
      END,
      od.TotalCost = CASE
        WHEN COALESCE(computed.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) IS NULL
          THEN NULL
        ELSE COALESCE(computed.ComputedNetCost, p.CostPrice * COALESCE(p.CurrencyCostModifier, 1), p.ListPrice) * q.Quantity
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
      AND (
        od.ID = @__rowId
        OR (
          od.ProductID IS NULL
          AND ISNULL(od.IsCategory, 0) = 0
          AND ISNULL(od.IsComment, 0) = 0
          AND ISNULL(LTRIM(RTRIM(od.RequestedBrand)),       N'') = ISNULL(LTRIM(RTRIM(@reqBrand)), N'')
          AND ISNULL(LTRIM(RTRIM(od.RequestedModelNo)),     N'') = ISNULL(LTRIM(RTRIM(@reqModel)), N'')
          AND ISNULL(LTRIM(RTRIM(od.RequestedPartNo)),      N'') = ISNULL(LTRIM(RTRIM(@reqPart)),  N'')
          AND ISNULL(LTRIM(RTRIM(od.RequestedDescription)), N'') = ISNULL(LTRIM(RTRIM(@reqDesc1)), N'')
          AND ISNULL(LTRIM(RTRIM(od.RequestedDescription2)),N'') = ISNULL(LTRIM(RTRIM(@reqDesc2)), N'')
          AND ISNULL(LTRIM(RTRIM(od.RequestedDescription3)),N'') = ISNULL(LTRIM(RTRIM(@reqDesc3)), N'')
        )
      );
    SELECT TOP (1)
      urp.OfferDetailID,
      urp.Quantity,
      urp.CustomerDiscount,
      urp.TelmacoDiscount
    FROM @UpdatedRowPricing urp
    ORDER BY CASE WHEN urp.OfferDetailID = @__rowId THEN 0 ELSE 1 END;
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

  realtimeEvents.emit(
    `offer:${offerId}:products`,
    'rows-refresh',
    { reason: 'assign-requested', requestedRowId, productId, updatedBy: auditUserId ?? null },
  );

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
    if (actionRaw === 'snapshot-rows') {
      const auth = await requirePermission(req, 'editOffers');
      if (!auth.ok) return auth.response;
      return handleSnapshotRows(offerId, body);
    }
    if (actionRaw === 'restore-rows') {
      const auth = await requirePermission(req, 'editOffers');
      if (!auth.ok) return auth.response;
      return handleRestoreRows(offerId, body);
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
