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
import { clearPartModelNumberUpper, stripXBetweenDigitsSql } from '../../../../../../lib/partModelNumber';
import { realtimeEvents } from '../../../../../../lib/realtimeEvents';
import { requirePermission } from '../../../../../../lib/authz';
import { performRerank, type RerankCandidate } from '../../../../../../lib/rerank';
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
  // Raw requested product spec for inline LLM reranking on the first page.
  // When present (and offset===0 with a Description chip), the server calls
  // performRerank() with the top 50 keyword-ranked rows as candidates and
  // reorders the returned page by LLM judgment before responding.  Kills
  // the old grid→/rerank→grid double-fetch cycle the client used to run.
  requested?: {
    brand?: string | null;
    partNumber?: string | null;
    modelNumber?: string | null;
    description?: string | null;
    description2?: string | null;
    description3?: string | null;
  } | null;
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
// Uses the existing PartNumberCleared and ModelNumberCleared columns for better performance.
// Strips x/X between digits at query time to avoid backfilling stored cleared values.
const partModelNumberSql = (expr: string) => {
  if (expr.includes('.PartNumber')) {
    return stripXBetweenDigitsSql(`UPPER(ISNULL(${expr.replace('.PartNumber', '.PartNumberCleared')}, ''))`);
  }
  if (expr.includes('.ModelNumber')) {
    return stripXBetweenDigitsSql(`UPPER(ISNULL(${expr.replace('.ModelNumber', '.ModelNumberCleared')}, ''))`);
  }
  return stripXBetweenDigitsSql(`UPPER(ISNULL(${expr}, ''))`);
};

const buildBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NULL)`;

const buildNotBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NOT NULL)`;

// Weight a text condition by the length of its search value — super-linear
// (length^1.6) so specific phrases *dominate*, not just outscore, generic
// short-word matches.  Linear weighting made a row matching many short tokens
// like "panel" + "port" + "cat" (5 + 4 + 3 = 12) beat a row matching one
// strong token like "patch panel" (11) — Riedel SmartPanel/Intercom products
// kept winning over actual Rittal patch panels for a "Lanberg PATCH PANEL
// 24 PORT CAT.7" query because they matched more weak tokens.  With 1.6:
//   "cat"         (3)  → 6
//   "panel"       (5)  → 13
//   "patch panel" (11) → 41
//   full desc     (70) → 918
// Now long/specific tokens contribute 3–4× what a pile of short generics
// ever can, so the row actually containing the query phrase wins.
// Priority multiplier (e.g. 20 for visible PartNumber/ModelNumber chips) is
// still applied linearly on top — those remain the definitive signal.
const computeTextWeight = (value: unknown, priority: unknown = 1): number => {
  const baseLen = value == null ? 1 : Math.max(1, String(value).trim().length);
  const mult = typeof priority === 'number' && Number.isFinite(priority) && priority > 0
    ? priority
    : 1;
  return Math.max(1, Math.round(Math.pow(baseLen, 1.6) * mult));
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
              ? stripXBetweenDigitsSql(`UPPER(ISNULL(${tablePrefixMatch[1]}.LegacyPartNoCleaned, ''))`)
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

// Stage-1 "quick match": before firing the full smart-search machinery
// (fuzzy, synonyms, hidden tokens, phrase scoring, category penalties, LLM
// rerank), try a narrow exact-ish lookup across Part, Model, and Description
// for the entry's Part/Model codes.  If ANY rows match, we treat that as the
// definitive answer and skip the rest — a Part that literally exists in the
// catalog is the user's answer, no need to rerank against 50 keyword
// neighbors or call the LLM.
//
// Returns the raw rows on a hit, or null on a miss (callers must fall
// through to stage 2 — the full smart search).  Only applicable on the
// first page (offset === 0) with a non-empty Part or Model in `requested`;
// also skipped when the user has started typing their own filter (the
// client omits `requested` in that case, and `userTouchedFilters` flips).
async function tryStage1QuickMatch(
  pool: Awaited<ReturnType<typeof getPool>>,
  offerPricingPolicyId: number | null,
  pageSize: number,
  highlightProductId: number | null,
  requestedPartNumber: string | null,
  requestedModelNumber: string | null,
): Promise<ProductGridRow[] | null> {
  const partClean = requestedPartNumber ? normalizePartModelNumber(requestedPartNumber) : null;
  const modelClean = requestedModelNumber ? normalizePartModelNumber(requestedModelNumber) : null;
  if (!partClean && !modelClean) return null;

  const codes: Array<{ key: string; cleanValue: string; rawValue: string }> = [];
  if (partClean && requestedPartNumber) {
    codes.push({ key: 's1_part', cleanValue: partClean, rawValue: requestedPartNumber });
  }
  if (modelClean && requestedModelNumber && modelClean !== partClean) {
    codes.push({ key: 's1_model', cleanValue: modelClean, rawValue: requestedModelNumber });
  }
  if (codes.length === 0) return null;

  // For each code, OR across PartCleared / ModelCleared / LegacyPartNoCleaned
  // (all already normalized/upper-cased) and plain Description (raw, with
  // UPPER + ISNULL to handle nulls).  LIKE '%<code>%' on cleared columns is
  // index-friendly enough for 56k rows; Description LIKE is a scan but only
  // fires once per code, so typical total is <100ms.
  const partClearedX = stripXBetweenDigitsSql(`UPPER(ISNULL(p.PartNumberCleared, ''))`);
  const modelClearedX = stripXBetweenDigitsSql(`UPPER(ISNULL(p.ModelNumberCleared, ''))`);
  const legacyClearedX = stripXBetweenDigitsSql(`UPPER(ISNULL(p.LegacyPartNoCleaned, ''))`);

  const orGroups: string[] = [];
  codes.forEach(({ key }) => {
    orGroups.push(
      `(${partClearedX} LIKE '%' + @${key}_clean + '%'`
      + ` OR ${modelClearedX} LIKE '%' + @${key}_clean + '%'`
      + ` OR ${legacyClearedX} LIKE '%' + @${key}_clean + '%'`
      + ` OR UPPER(ISNULL(p.Description, '')) LIKE '%' + @${key}_raw + '%')`,
    );
  });
  const whereSql = `WHERE ${orGroups.join(' OR ')}`;

  // Rank: exact Part match first, then exact Model match, then LIKE matches.
  // Within each tier, newer products (ProductID DESC) first.
  const scoreParts: string[] = [];
  codes.forEach(({ key }) => {
    scoreParts.push(`CASE WHEN ${partClearedX} = @${key}_clean THEN 1000 ELSE 0 END`);
    scoreParts.push(`CASE WHEN ${modelClearedX} = @${key}_clean THEN 900 ELSE 0 END`);
    scoreParts.push(`CASE WHEN ${legacyClearedX} = @${key}_clean THEN 800 ELSE 0 END`);
  });
  const scoreExpr = scoreParts.length > 0 ? scoreParts.join(' + ') : '0';
  const highlightOrderClause = highlightProductId != null
    ? 'CASE WHEN p.ID = @__highlightProductId THEN 0 ELSE 1 END, '
    : '';
  const orderSql = `ORDER BY ${highlightOrderClause}(${scoreExpr}) DESC, p.ID DESC`;

  const request = pool.request();
  request.input('__limit', sql.Int, pageSize);
  request.input('__pricingPolicyId', sql.Int, offerPricingPolicyId);
  codes.forEach(({ key, cleanValue, rawValue }) => {
    request.input(`${key}_clean`, sql.NVarChar(255), cleanValue);
    request.input(`${key}_raw`, sql.NVarChar(255), rawValue.trim().toUpperCase());
  });
  if (highlightProductId != null) {
    request.input('__highlightProductId', sql.Int, highlightProductId);
  }

  const query = `
    WITH PagedBase AS (
      SELECT TOP (@__limit)
        p.ID AS ProductID,
        p.PartNumber,
        p.Description,
        p.ModelNumber,
        p.WebLink,
        b.Name AS BrandName
      FROM dbo.Products p
        LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
      ${whereSql}
      ${orderSql}
    )
    SELECT
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
    FROM PagedBase bp
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
    ${orderSql.replace(/\bp\.ID\b/g, 'bp.ProductID')};
  `;

  try {
    const result = await request.query<ProductGridRow>(query);
    const rows = result.recordset ?? [];
    return rows.length > 0 ? rows : null;
  } catch (err) {
    console.warn('[productGrid stage1] SQL failed — falling through to stage 2', err);
    return null;
  }
}

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

  // BrandName expression is NORMALIZED on both sides: lowercase + all
  // whitespace and common separator punctuation stripped.  This is how
  // "TVOne" matches catalog "TV one", how "biamp" matches "Biamp", and how
  // "LG " with a trailing space matches "LG".  Slightly slower than a raw
  // LIKE (index-unfriendly), but brand filters typically produce narrow
  // match sets anyway.  The buildTextMatchPredicate function will wrap the
  // search value in `%...%` and pre-normalize it identically on the param
  // side, so both sides meet in the middle.
  const NORMALIZED_BRAND_EXPR = "REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(ISNULL(bp.BrandName, '')), ' ', ''), '-', ''), '_', ''), '.', ''), '/', '')";
  const columnExpressions: Record<string, string> = {
    ProductID: 'bp.ProductID',
    PartNumber: 'bp.PartNumber',
    Description: 'bp.Description',
    ModelNumber: 'bp.ModelNumber',
    BrandName: NORMALIZED_BRAND_EXPR,
    PriceListName: 'price.PriceListName',
    ListPrice: 'price.ListPrice',
    CostPrice: 'price.CostPrice',
  };

  // Pre-normalize any BrandName filter values so they meet the normalized
  // column expression halfway: both sides lowercased and stripped of spaces,
  // hyphens, underscores, periods, slashes.  Without this the normalized
  // expression would pattern-match against a raw "TVOne" param and miss
  // catalog "TV one" just as before.
  const normalizeBrandForMatch = (raw: string): string =>
    raw.toLowerCase().replace(/[\s\-_./]/g, '');
  const normalizedFilterModel = (() => {
    const fm = gridRequest.filterModel;
    if (!fm || typeof fm !== 'object') return fm;
    const brand = (fm as Record<string, unknown>).BrandName as
      | { filter?: unknown; conditions?: Array<{ filter?: unknown }> }
      | undefined;
    if (!brand) return fm;
    const normalizeCond = (c: { filter?: unknown }) => {
      if (typeof c?.filter === 'string') {
        return { ...c, filter: normalizeBrandForMatch(c.filter) };
      }
      return c;
    };
    const next: Record<string, unknown> = { ...fm };
    if (Array.isArray(brand.conditions)) {
      next.BrandName = { ...brand, conditions: brand.conditions.map(normalizeCond) };
    } else if (typeof brand.filter === 'string') {
      next.BrandName = { ...brand, filter: normalizeBrandForMatch(brand.filter) };
    }
    return next as typeof gridRequest.filterModel;
  })();

  const { clauses, scoreClauses, params } = buildWhereClauses(normalizedFilterModel, columnExpressions);

  // Phrase-match scoring: extract consecutive 2-grams from the visible
  // Description chip and add a HIGH-weight score clause for each literal
  // phrase that appears in the catalog row.  This fixes the "Riedel
  // Artist client card beats Rittal patch panel" problem: a row that
  // contains the phrase "PATCH PANEL" literally scores much higher than
  // a row that matches scattered "PANEL" + "PORT" + "CAT" tokens in
  // different positions.  Weight = length × 50 so "PATCH PANEL" (11
  // chars) contributes ~550 score to a matching row — enough to push
  // real-category products past keyword-noise rows even when those
  // match 5+ weaker single-token clauses.
  (() => {
    const fm = normalizedFilterModel as Record<string, { filter?: unknown; conditions?: Array<{ filter?: unknown }> }> | null | undefined;
    const descEntry = fm?.Description;
    const descValue = typeof descEntry?.filter === 'string'
      ? descEntry.filter
      : (Array.isArray(descEntry?.conditions) && typeof descEntry.conditions[0]?.filter === 'string'
          ? descEntry.conditions[0].filter
          : null);
    if (!descValue) return;
    // Tokenize on whitespace and common punctuation, drop very short /
    // fluff words so phrases like "1U 19" or "OF THE" don't get the
    // phrase-weight boost.
    const STOPWORDS = new Set(['WITH', 'AND', 'OR', 'THE', 'FOR', 'FROM', 'TO', 'OF', 'IN', 'ON', 'BY', 'A', 'AN']);
    const tokens = descValue
      .split(/[\s,;/|()[\]"':=<>+*]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t.toUpperCase()));
    const colExpr = columnExpressions.Description;
    const seenPhrases = new Set<string>();
    // Register both the spaced variant ("patch cord") and the concatenated
    // variant ("patchcord").  Our catalog is inconsistent — some rows have
    // "patchcord" as a single token, others "patch cord" as two tokens.
    // Without both variants a "Cat 7 patch cord" query only hits the space
    // form and silently misses the single-word catalog rows.
    const pushPhraseClause = (phrase: string, idKey: string) => {
      const key = phrase.toUpperCase();
      if (seenPhrases.has(key)) return;
      seenPhrases.add(key);
      const { clause, params: phraseParams } = buildTextMatchPredicate(colExpr, phrase, {
        paramKey: idKey,
        mode: 'contains',
        enableFuzzy: false,
      });
      if (!clause) return;
      phraseParams.forEach((p) => params.push(p));
      // High weight — length × 50.  "PATCH PANEL" (11 chars) → 550, which
      // dominates any sum of scattered single-token matches.
      const weight = phrase.length * 50;
      scoreClauses.push({ clause, weight });
    };
    for (let i = 0; i < tokens.length - 1; i += 1) {
      const spaced = `${tokens[i]} ${tokens[i + 1]}`;
      pushPhraseClause(spaced, `phrase_${i}`);
      // Concatenated variant to match single-word catalog forms like
      // "patchcord", "patchpanel", "hdmicable".  Only generate when both
      // halves are plain word-characters (letters only) so we don't produce
      // garbage joins like "24portCat7" or "RJ45keystone" that would never
      // appear as a single catalog token.
      if (/^[A-Za-z]+$/.test(tokens[i]) && /^[A-Za-z]+$/.test(tokens[i + 1])) {
        const joined = `${tokens[i]}${tokens[i + 1]}`;
        pushPhraseClause(joined, `phrase_join_${i}`);
      }
    }

    // Category-mismatch penalty.  For each CATEGORY_SIGNAL keyword the user
    // actually typed, penalize rows whose Description contains a KNOWN
    // WRONG-CATEGORY keyword without also containing the right one.  This
    // is what was missing: even when the rerank pool contains correct
    // patchcords for a "patch cord" query, the LLM was still ranking
    // patch panels (same family, overlapping words) at positions 1-10.
    // A deterministic -2000 SQL-side penalty makes the correct-category
    // row's ordinal score dominate the rerank even before the LLM runs.
    //
    // Kept small and conservative: a few well-known AV/cabling confusions.
    // Adding more is cheap (one line each) when we see them fail in logs.
    type Confusion = { want: string; wrong: string[] };
    const CONFUSIONS: Confusion[] = [
      // Query mentions "cord" / "cable" → penalize rack-mount panels etc.
      { want: 'cord', wrong: ['panel', 'organizer', 'bracket'] },
      { want: 'cable', wrong: ['panel', 'organizer', 'bracket'] },
      // Query mentions "panel" → penalize accessories/cable-management rows.
      { want: 'panel', wrong: ['organizer', 'bracket', 'tool', 'carrying'] },
      // Query mentions "connector" / "keystone" / "jack" → penalize panels.
      { want: 'connector', wrong: ['panel', 'organizer'] },
      { want: 'keystone', wrong: ['panel', 'organizer'] },
      { want: 'jack', wrong: ['panel', 'organizer'] },
    ];
    const upperTokens = new Set(tokens.map((t) => t.toUpperCase()));
    CONFUSIONS.forEach((conf, confIdx) => {
      if (!upperTokens.has(conf.want.toUpperCase())) return;
      conf.wrong.forEach((bad, badIdx) => {
        // Skip if the user actually typed the "wrong" word too — then it's
        // not a mismatch signal (e.g. "patch panel cable organizer" query).
        if (upperTokens.has(bad.toUpperCase())) return;
        const paramKey = `confusion_${confIdx}_${badIdx}`;
        const { clause, params: p } = buildTextMatchPredicate(colExpr, bad, {
          paramKey,
          mode: 'contains',
          enableFuzzy: false,
        });
        if (!clause) return;
        // Also require the row NOT contain the wanted word, so rows that
        // say "patch cord / patch panel bundle" aren't penalized unfairly.
        const wantParamKey = `confusion_want_${confIdx}_${badIdx}`;
        const { clause: wantClause, params: wantParams } = buildTextMatchPredicate(colExpr, conf.want, {
          paramKey: wantParamKey,
          mode: 'contains',
          enableFuzzy: false,
        });
        p.forEach((pp) => params.push(pp));
        wantParams.forEach((pp) => params.push(pp));
        const guardedClause = wantClause ? `(${clause} AND NOT (${wantClause}))` : clause;
        // -2000 dominates any positive phrase score (max ~900 from the
        // phrase-match block); moves category-wrong rows below all
        // category-right rows even when keyword overlap is high.
        scoreClauses.push({ clause: guardedClause, weight: -2000 });
      });
    });
  })();

  // Hidden per-column tokens from the request payload (AI expansions, fuzzy
  // sidecar, etc.) split into two roles:
  //
  //   Description column: tokens go to BOTH WHERE and score.  Description is
  //   where broad textual recall lives; a row that matches any meaningful
  //   description token should be eligible even if PartNumber/ModelNumber
  //   chips don't match verbatim.  Description LIKE terms are also what
  //   makes the semantic-only path not-too-restrictive — catalog entries
  //   with different SKU formats (e.g. "PPS7 1024B" vs "PPS7-1024-B") still
  //   surface via description keywords.
  //
  //   PartNumber / ModelNumber / BrandName columns: tokens go to SCORE ONLY.
  //   These columns already have an explicit visible chip from the requested
  //   entry; piling on LIKE variants just adds noise (weak tokens like
  //   "panel" on PartNumber match garbage) and inflates SQL cost without
  //   improving recall.
  const HIDDEN_TOKEN_MAX_PER_COLUMN = 10;
  // Reject hidden tokens longer than 40 chars — at that length they're
  // truncated description sentences, not search substrings.  LIKE '%<long
  // phrase>%' almost never matches a catalog row and inflates the SQL cost
  // for zero recall benefit.
  const HIDDEN_TOKEN_MAX_LEN = 40;
  const DESCRIPTION_RECALL_COLS = new Set(['Description']);
  const hiddenTokens = body?.hiddenFilterTokens;
  if (hiddenTokens && typeof hiddenTokens === 'object' && !Array.isArray(hiddenTokens)) {
    Object.entries(hiddenTokens).forEach(([colId, tokens]) => {
      if (!Array.isArray(tokens) || tokens.length === 0) return;
      const colExpr = columnExpressions[colId];
      if (!colExpr) return;
      const contributesToWhere = DESCRIPTION_RECALL_COLS.has(colId);
      const tokenClauses: string[] = [];
      const cappedTokens = tokens.slice(0, HIDDEN_TOKEN_MAX_PER_COLUMN);
      cappedTokens.forEach((token, idx) => {
        if (!token || typeof token.filter !== 'string') return;
        let value = token.filter.trim();
        if (!value) return;
        if (value.length > HIDDEN_TOKEN_MAX_LEN) return;
        // Brand hidden tokens go through the same normalization as the
        // visible brand chip — strip spaces/case so "TVOne" matches "TV
        // one" on both sides of the LIKE.
        if (colId === 'BrandName') value = normalizeBrandForMatch(value);
        if (!value) return;
        const paramKey = `hidden_${colId}_${idx}`;
        const { clause, params: tokenParams } = buildTextMatchPredicate(colExpr, value, {
          paramKey,
          mode: 'contains',
          enableFuzzy: false,
        });
        if (!clause) return;
        tokenParams.forEach((p) => params.push(p));
        scoreClauses.push({ clause, weight: computeTextWeight(value, token.weight) });
        if (contributesToWhere) tokenClauses.push(clause);
      });
      if (!contributesToWhere || tokenClauses.length === 0) return;
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

  // Requested-brand boost.  The visible Brand chip already filters via
  // orFilterColumns, but in expand mode that's an OR — rows from other brands
  // can still surface (and outscore the requested brand) when their
  // Description tokens add up to more weight.  This boost re-asserts brand
  // priority: a row whose BrandName matches the requested entry's brand gets
  // a flat bonus large enough to dominate per-token differences within the
  // same product family.  Only fires in expand mode (when `requested` is on
  // the payload) — plain mode has the chips ANDed together so it doesn't
  // need this.
  const requestedObj = body?.requested && typeof body.requested === 'object' && !Array.isArray(body.requested)
    ? body.requested as Record<string, unknown>
    : null;
  const requestedBrandRaw = requestedObj && typeof requestedObj.brand === 'string'
    ? requestedObj.brand.trim()
    : '';
  if (requestedBrandRaw) {
    const normalizedRequestedBrand = normalizeBrandForMatch(requestedBrandRaw);
    if (normalizedRequestedBrand) {
      const brandExpr = columnExpressions.BrandName;
      if (brandExpr) {
        const paramKey = 'requested_brand_match';
        params.push({ key: paramKey, value: normalizedRequestedBrand });
        const normalizedColExpr = `REPLACE(REPLACE(UPPER(COALESCE(CAST(${brandExpr} AS NVARCHAR(MAX)), '')), ' ', ''), '-', '')`;
        const normalizedParam = `REPLACE(REPLACE(UPPER(@${paramKey}), ' ', ''), '-', '')`;
        // CHARINDEX > 0 handles both directions: catalog row "Televic"
        // matches requested "Televic Audio Technologies" and vice versa, so
        // brand synonyms / variants still pick up the boost.
        const clause = `((CHARINDEX(${normalizedParam}, ${normalizedColExpr}) > 0 OR CHARINDEX(${normalizedColExpr}, ${normalizedParam}) > 0) AND LEN(${normalizedColExpr}) > 0)`;
        // 2000 dominates per-token Description scoring (typical row totals
        // 200-1500 per the rerank debug logs) so brand-correct rows surface
        // first within each product family.
        scoreClauses.push({ clause, weight: 2000 });
      }
    }
  }

  // Requested-identifier boost.  When a token from the requested description /
  // partNumber / modelNumber exactly equals a row's PartNumberCleared or
  // ModelNumberCleared, that row is almost certainly THE product the user is
  // looking for — even if some other row scores higher on bag-of-words
  // description overlap.  Example: requested description "TEL152 Headphones"
  // contains the token "TEL152"; the catalog row whose ModelNumber is
  // exactly "TEL152" should rank #1 above generic headphone rows.
  //
  // Weight is set higher than the brand boost (2000) so a model match wins
  // even when the catalog row is from a different brand (rebrands, OEM
  // distributors).
  if (requestedObj) {
    const collectIdTokens = (value: unknown): string[] => {
      if (typeof value !== 'string') return [];
      return value.split(/[\s,/;]+/).map((t) => t.trim()).filter(Boolean);
    };
    const rawTokens: string[] = [
      ...collectIdTokens((requestedObj as { description?: unknown }).description),
      ...collectIdTokens((requestedObj as { description2?: unknown }).description2),
      ...collectIdTokens((requestedObj as { description3?: unknown }).description3),
      ...collectIdTokens((requestedObj as { partNumber?: unknown }).partNumber),
      ...collectIdTokens((requestedObj as { modelNumber?: unknown }).modelNumber),
    ];
    const seen = new Set<string>();
    const cleared: string[] = [];
    rawTokens.forEach((tok) => {
      const c = clearPartModelNumberUpper(tok);
      // Require length >= 3 and at least one digit — short alphabetic tokens
      // ("for", "the", "kit") match too many spurious model numbers; an
      // identifier almost always contains a digit (TEL152, M4250, 16085).
      if (c.length < 3) return;
      if (!/\d/.test(c)) return;
      if (seen.has(c)) return;
      seen.add(c);
      cleared.push(c);
    });
    if (cleared.length > 0) {
      const partExpr = partModelNumberSql(columnExpressions.PartNumber ?? 'bp.PartNumber');
      const modelExpr = partModelNumberSql(columnExpressions.ModelNumber ?? 'bp.ModelNumber');
      const paramNames: string[] = [];
      cleared.forEach((tok, idx) => {
        const key = `requested_id_match_${idx}`;
        params.push({ key, value: tok });
        paramNames.push(`@${key}`);
      });
      const inList = paramNames.join(', ');
      const clause = `((${partExpr} IN (${inList}) OR ${modelExpr} IN (${inList})) AND (LEN(${partExpr}) > 0 OR LEN(${modelExpr}) > 0))`;
      scoreClauses.push({ clause, weight: 5000 });
    }
  }

  const orCols = new Set(Array.isArray(body?.orFilterColumns) ? body.orFilterColumns : []);
  const orClauses = clauses.filter((c) => orCols.has(c.colId)).map((c) => c.clause);
  const andClauses = clauses.filter((c) => !orCols.has(c.colId)).map((c) => c.clause);
  const finalClauses = [...andClauses];
  if (orClauses.length > 0) {
    finalClauses.push(orClauses.length === 1 ? orClauses[0] : `(${orClauses.join(' OR ')})`);
  }
  if (body?.serviceOnly === true) {
    finalClauses.push(`EXISTS (SELECT 1 FROM dbo.PriceListItems pli_svc INNER JOIN dbo.PriceLists pl_svc ON pli_svc.PriceListID = pl_svc.ID WHERE pli_svc.ProductID = bp.ProductID AND ISNULL(pl_svc.IsService, 0) = 1 AND pl_svc.Enabled = 1)`);
  } else if (body?.excludeServices === true) {
    finalClauses.push(`NOT EXISTS (SELECT 1 FROM dbo.PriceListItems pli_svc INNER JOIN dbo.PriceLists pl_svc ON pli_svc.PriceListID = pl_svc.ID WHERE pli_svc.ProductID = bp.ProductID AND ISNULL(pl_svc.IsService, 0) = 1 AND pl_svc.Enabled = 1)`);
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
  let orderSql = highlightProductId != null
    ? orderSqlWithScore.replace(/^ORDER BY /i, 'ORDER BY CASE WHEN bp.ProductID = @__highlightProductId THEN 0 ELSE 1 END, ')
    : orderSqlWithScore;

  // Rerank override: client has called /rerank and now wants rows returned in
  // the LLM-determined order.  Build a ranked-position CASE expression that
  // prepends the order, so those IDs surface first in the exact order the
  // LLM returned.  Rows not in the rerank list keep the score-based order
  // below them.  Only honored on the first page (offset === 0) — server-
  // side pagination for later blocks keeps the natural sort.
  const rawRerankOrder = Array.isArray(body?.rerankOrder) ? body.rerankOrder : [];
  const rerankIds: number[] = [];
  rawRerankOrder.forEach((pid) => {
    if (typeof pid === 'number' && Number.isFinite(pid)) rerankIds.push(Math.trunc(pid));
  });
  if (rerankIds.length > 0 && offset === 0) {
    const rerankCaseBranches: string[] = [];
    rerankIds.forEach((pid, rank) => {
      const paramKey = `__rerank_${rank}`;
      combinedParams.push({ key: paramKey, value: pid });
      rerankCaseBranches.push(`WHEN @${paramKey} THEN ${rank}`);
    });
    const rerankCase = `CASE bp.ProductID ${rerankCaseBranches.join(' ')} ELSE ${rerankIds.length} END`;
    orderSql = orderSql.replace(/^ORDER BY /i, `ORDER BY (${rerankCase}) ASC, `);
  }

  const pool = await getPool();

  // Look up the offer's pricing policy and services location
  const policyLookup = pool.request();
  policyLookup.input('__offerId', sql.Int, offerId);
  const policyResult = await policyLookup.query<{ PricingPolicyID: number | null; ServicesLocation: string | null }>(`
    SELECT TOP (1) o.PricingPolicyID, o.ServicesLocation
    FROM dbo.Offer o
    WHERE o.ID = @__offerId
  `);
  const offerPricingPolicyId = policyResult.recordset?.[0]?.PricingPolicyID ?? null;
  const offerServicesLocation = policyResult.recordset?.[0]?.ServicesLocation ?? null;

  // Stage 1: if the entry has a Part or Model code, try a narrow exact-ish
  // lookup across Part/Model/Description before firing the full smart query.
  // When the code exists in the catalog this is the right answer — no need
  // for fuzzy expansion, hidden tokens, or LLM rerank.  Gated on offset 0,
  // rerankIds empty (no client-supplied ordering), and `requested` being
  // present (the client omits it once the user starts typing filters, so
  // manual-search mode bypasses stage 1 entirely).
  {
    const reqBody = body?.requested;
    const stage1Part = reqBody && typeof reqBody === 'object' && typeof reqBody.partNumber === 'string'
      ? reqBody.partNumber.trim() || null
      : null;
    const stage1Model = reqBody && typeof reqBody === 'object' && typeof reqBody.modelNumber === 'string'
      ? reqBody.modelNumber.trim() || null
      : null;
    if (offset === 0 && rerankIds.length === 0 && (stage1Part || stage1Model)) {
      const stage1Start = Date.now();
      const stage1Rows = await tryStage1QuickMatch(
        pool,
        offerPricingPolicyId,
        pageSize,
        highlightProductId,
        stage1Part,
        stage1Model,
      );
      if (stage1Rows && stage1Rows.length > 0) {
        const mapped = stage1Rows.map((row) => {
          const { __totalCount, ...rest } = row;
          void __totalCount;
          return rest;
        });
        const rowCount = mapped.length < pageSize
          ? mapped.length
          : mapped.length + 1;
        console.log('[productGrid stage1]', JSON.stringify({
          offerId,
          latencyMs: Date.now() - stage1Start,
          part: stage1Part,
          model: stage1Model,
          matched: mapped.length,
        }));
        return NextResponse.json({ ok: true, rows: mapped, rowCount });
      }
    }
  }

  const request = pool.request();
  request.input('__offset', sql.Int, offset);
  request.input('__limit', sql.Int, pageSize);
  request.input('__pricingPolicyId', sql.Int, offerPricingPolicyId);
  combinedParams.forEach((param) => request.input(param.key, param.value));
  if (highlightProductId != null) {
    request.input('__highlightProductId', sql.Int, highlightProductId);
  }

  // Two key perf structure choices here:
  //   1. Paginate the base filter FIRST (PagedBase CTE), then OUTER APPLY the
  //      per-row price lookup.  Otherwise a broad WHERE match (many LIKE
  //      tokens) fires a price subquery for every matching product — enough
  //      to hit the 30s MSSQL timeout.
  //   2. No COUNT_BIG() OVER ().  The exact total row count forces SQL Server
  //      to evaluate the WHERE against every row in the catalog; for the
  //      matcher modal we don't need it — AG Grid infers end-of-data from a
  //      short last page.  We signal "more available" by adding 1 to rowCount
  //      whenever the page came back full.
  //
  // __score is materialized on PagedBase so the debug log below can show why
  // each returned row ranks where it does.  Stripped from the client response.
  const scoreColumnSql = scoreExpr ? `(${scoreExpr}) AS __score` : `CAST(0 AS INT) AS __score`;
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
    ),
    PagedBase AS (
      SELECT bp.*, ${scoreColumnSql}
      FROM BaseProducts bp
      ${combinedWhereSql}
      ${orderSql}
      OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY
    )
    SELECT
      bp.ProductID,
      bp.PartNumber,
      bp.WebLink,
      bp.Description,
      bp.ModelNumber,
      bp.BrandName,
      bp.__score,
      price.PriceListItemID,
      price.PriceListID,
      price.PriceListName,
      price.ListPrice,
      price.CostPrice,
      price.PriceListValidFromDate,
      price.PriceListValidToDate,
      price.PriceListEnabled
    FROM PagedBase bp
      OUTER APPLY (
        SELECT TOP (1)
          pli.ID AS PriceListItemID,
          pli.PriceListID,
          pl.Name AS PriceListName,
          ${body?.serviceOnly === true
            ? offerServicesLocation === 'GR'
              ? 'COALESCE(pli.ServicePriceGR, pli.ListPrice)'
              : offerServicesLocation === 'outGR'
                ? 'COALESCE(pli.ServicePriceOutGR, pli.ListPrice)'
                : 'pli.ListPrice'
            : 'pli.ListPrice'} AS ListPrice,
          pli.CostPrice,
          pl.ValidFromDate AS PriceListValidFromDate,
          pl.ValidToDate AS PriceListValidToDate,
          pl.Enabled AS PriceListEnabled
        FROM dbo.PriceListItems pli
          INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
          LEFT JOIN dbo.PriceListPricingPolicy plpp ON plpp.PriceListID = pl.ID AND plpp.PricingPolicyID = @__pricingPolicyId
        WHERE pl.Enabled = 1
          AND pli.ProductID = bp.ProductID
          ${body?.serviceOnly === true ? 'AND ISNULL(pl.IsService, 0) = 1' : ''}
        ORDER BY
          CASE WHEN plpp.ID IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
          pl.ValidToDate,
          pl.ValidFromDate DESC,
          pli.ID DESC
      ) price
    ${orderSql};
  `;

  const result = await request.query<ProductGridRow & { __score?: number }>(query);
  let rows = result.recordset ?? [];

  // Inline LLM rerank on the first page.  Previously the client did this
  // as a separate roundtrip (fetch grid → POST /rerank → refetch grid with
  // rerankOrder), which caused a visible reshuffle and a second SQL round-
  // trip.  Running it here instead returns already-ordered rows in a single
  // response.  Gated on offset===0 and the presence of a Description to
  // rerank against; rerankOrder (client-supplied order for back-compat) is
  // skipped — that path bypasses this branch via the ORDER BY CASE above.
  if (
    offset === 0
    && rerankIds.length === 0
    && rows.length > 1
    && body?.requested
    && typeof body.requested === 'object'
    && typeof body.requested.description === 'string'
    && body.requested.description.trim().length > 0
  ) {
    const req = body.requested;
    const candidates: RerankCandidate[] = rows.slice(0, 50).map((r) => ({
      productId: r.ProductID,
      brand: r.BrandName,
      partNumber: r.PartNumber,
      modelNumber: r.ModelNumber,
      description: r.Description,
    }));
    // 12s ceiling — typical rerank latency is 3-6s, so this catches a
    // pathological stall without letting the user wait 30+s.  On timeout
    // we just return keyword-ordered rows; the grid still works, just
    // without the LLM's reordering.
    const rerankTimeout = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), 12_000);
    });
    try {
      const ranked = await Promise.race([
        performRerank({
          requestedBrand: req.brand,
          requestedPartNumber: req.partNumber,
          requestedModelNumber: req.modelNumber,
          requestedDescription: req.description,
          requestedDescription2: req.description2,
          requestedDescription3: req.description3,
          candidates,
        }),
        rerankTimeout,
      ]);
      if (ranked && ranked.length > 0) {
        const orderIndex = new Map<number, number>();
        ranked.forEach((r, idx) => { orderIndex.set(r.productId, idx); });
        const UNRANKED = Number.MAX_SAFE_INTEGER;
        rows = [...rows].sort((a, b) => {
          const ai = orderIndex.get(a.ProductID) ?? UNRANKED;
          const bi = orderIndex.get(b.ProductID) ?? UNRANKED;
          return ai - bi;
        });
      }
    } catch (err) {
      console.warn('[productGrid] inline rerank failed — returning keyword order', err);
    }
  }

  // Debug: log how the top rows ranked and why.  Only fires on first-page
  // requests (offset === 0) so scrolling doesn't spam.  Shows the scored
  // inputs (visible filter model + hidden-token + semantic counts) and the
  // top 15 rows' scores + brand + description snippets so bad ranking is
  // immediately diagnosable from the server console.
  if (offset === 0) {
    const visibleFilterEntries = Object.entries(gridRequest.filterModel ?? {}).map(([col, v]) => {
      const entry = v as { filter?: unknown; conditions?: Array<{ filter?: unknown }> } | null | undefined;
      if (!entry) return `${col}=<null>`;
      if (Array.isArray(entry.conditions)) {
        return `${col}=[${entry.conditions.map((c) => c?.filter ?? '').join('|')}]`;
      }
      return `${col}=${String(entry.filter ?? '').slice(0, 60)}`;
    });
    const hiddenSummary = hiddenTokens && typeof hiddenTokens === 'object' && !Array.isArray(hiddenTokens)
      ? Object.fromEntries(
          Object.entries(hiddenTokens as Record<string, Array<{ filter?: unknown }>>).map(([col, toks]) => [
            col,
            (Array.isArray(toks) ? toks : []).slice(0, 10).map((t) => t?.filter ?? '').filter(Boolean),
          ]),
        )
      : {};
    const topRows = rows.slice(0, 15).map((r) => ({
      score: typeof r.__score === 'number' ? r.__score : null,
      id: r.ProductID,
      brand: r.BrandName,
      part: r.PartNumber,
      desc: typeof r.Description === 'string' ? r.Description.slice(0, 80) : null,
    }));
    console.log('[productGrid debug]', JSON.stringify({
      offerId,
      visibleFilter: visibleFilterEntries,
      hiddenTokens: hiddenSummary,
      scoreClauseCount: scoreClauses.length,
      rowsReturned: rows.length,
      topRows,
    }, null, 2));
  }

  const mappedRows = rows.map((row) => {
    const { __totalCount, __score, ...rest } = row;
    void __totalCount;
    void __score;
    return rest;
  });
  // Without COUNT_BIG we don't know the real total.  If this page was full,
  // signal "more available" by claiming one extra row; if it came back short,
  // the absolute row count is exactly what we returned.  AG Grid converts this
  // into correct scroll + end-of-data behavior.
  const rowCount = mappedRows.length < pageSize
    ? offset + mappedRows.length
    : offset + mappedRows.length + 1;

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
  const isPrintableRaw = body?.isPrintable;
  const isPrintableValue = isPrintableRaw === true ? 1 : isPrintableRaw === false ? 0 : null;

  try {
  const pool = await getPool();

  // Pre-flight: check if any selected products come from a service pricelist
  // and the offer has no ServicesLocation set. If so, ask the client to set it first.
  {
    const productIds = selections.map((s) => s.productId);
    const checkReq = pool.request();
    checkReq.input('__offerId', sql.Int, offerId);
    productIds.forEach((pid, idx) => checkReq.input(`__pid_${idx}`, sql.Int, pid));
    const pidList = productIds.map((_, idx) => `@__pid_${idx}`).join(', ');
    const checkResult = await checkReq.query<{ hasServiceProducts: number; hasLocation: number }>(`
      SELECT
        (SELECT CASE WHEN EXISTS (
          SELECT 1
          FROM dbo.Products p
          INNER JOIN dbo.PriceListItems pli ON pli.ProductID = p.ID
          INNER JOIN dbo.PriceLists pl ON pl.ID = pli.PriceListID AND pl.Enabled = 1 AND ISNULL(pl.IsService, 0) = 1
          WHERE p.ID IN (${pidList})
        ) THEN 1 ELSE 0 END) AS hasServiceProducts,
        (SELECT CASE WHEN ServicesLocation IS NOT NULL THEN 1 ELSE 0 END
         FROM dbo.Offer WHERE ID = @__offerId) AS hasLocation
    `);
    const row = checkResult.recordset?.[0];
    if (row && row.hasServiceProducts === 1 && row.hasLocation === 0) {
      return NextResponse.json(
        { ok: false, requiresServicesLocation: true, error: 'Services Location is required for this offer to add service products.' },
        { status: 400 },
      );
    }
  }

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
  request.input('__isPrintable', sql.Bit, isPrintableValue);

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
  DECLARE @servicesLocation NVARCHAR(10);

  SELECT
    @pricingPolicyId = o.PricingPolicyID,
    @offerCurrencyId = o.CurrencyID,
    @offerCurrencyModifier = o.CurrencyModifier,
    @servicesLocation = o.ServicesLocation
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
    ComputedNetCost DECIMAL(18, 4) NULL,
    IsService BIT NULL,
    ServiceType NVARCHAR(20) NULL
  );

  -- Step 1: Base product data + best price
  INSERT INTO #PD (
    ProductID, Seq, Description, BrandID, PartNumber, ModelNumber,
    PriceListID, PriceListItemID, ListPrice, CostPrice,
    OtherCurrencyID, CurrencyCostModifier, IsService, ServiceType
  )
  SELECT
    p.ProductID, p.Seq, pr.Description, pr.BrandID, pr.PartNumber, pr.ModelNumber,
    price.PriceListID, price.PriceListItemID, price.ListPrice, price.CostPrice,
    price.OtherCurrencyID, price.CurrencyCostModifier, price.IsService, price.ServiceType
  FROM #PP p
    INNER JOIN dbo.Products pr ON pr.ID = p.ProductID
    OUTER APPLY (
      SELECT TOP (1)
        pli.ID AS PriceListItemID,
        pli.PriceListID,
        CASE
          WHEN ISNULL(COALESCE(pl.IsService, pr.IsService), 0) = 1 THEN
            CASE @servicesLocation
              WHEN 'GR'    THEN ISNULL(pli.ServicePriceGR,    pli.ListPrice)
              WHEN 'outGR' THEN ISNULL(pli.ServicePriceOutGR, pli.ListPrice)
              ELSE pli.ListPrice
            END
          WHEN pl.CurrencyId = @offerCurrencyId THEN pli.ListPrice
          ELSE pli.ListPrice * COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1)
        END AS ListPrice,
        pli.CostPrice,
        CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
             ELSE COALESCE(pl.CostCurrencyID, pl.CurrencyId) END AS OtherCurrencyID,
        CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
             ELSE COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1) END AS CurrencyCostModifier,
        COALESCE(pl.IsService, pr.IsService) AS IsService,
        COALESCE(pli.ServiceType, pr.ServiceType) AS ServiceType
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
    IsPrintable, IsComment, IsCategory, IsService, ServiceType,
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
    CASE WHEN p.IsService = 1 THEN @__isPrintable ELSE NULL END, 0, 0, p.IsService, p.ServiceType,
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
  const applyToSimilar = body?.applyToSimilar === true;

  // Instrumentation: assignment-accuracy metrics from the match-requested
  // modal.  Tagged with "tag: assignment-metrics" in the log context (the
  // category enum is fixed at view|mutation|delete) so you can grep the
  // logs / query the LogEvents table later to compute MRR / top-K accuracy
  // and tell whether retrieval changes (semantic, rerank, embedding model,
  // etc.) actually moved the needle against real user behavior.
  if (requestedRowId != null && productId != null
      && body?.metrics && typeof body.metrics === 'object' && !Array.isArray(body.metrics)) {
    try {
      logger.info('[assignment metrics]', {
        endpoint: `/api/offers/${offerId}/products/add`,
        method: 'POST',
        category: 'mutation',
        tag: 'assignment-metrics',
        offerId,
        requestedRowId,
        productId,
        ...(body.metrics as Record<string, unknown>),
      });
    } catch { /* logging must never break assignment */ }
  }

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
  request.input('__applyToSimilar', sql.Bit, applyToSimilar ? 1 : 0);

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

    -- Capture the requested fields from the original row.  When
    -- @__applyToSimilar = 1 the UPDATE also assigns the same product to any
    -- other unassigned rows in this offer with identical requested data;
    -- otherwise only the row matching @__rowId is updated.  We always count
    -- matching unassigned rows so the client can prompt the user.
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
          @__applyToSimilar = 1
          AND od.ProductID IS NULL
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

    -- Count any other unassigned rows in this offer with identical requested
    -- data so the client can ask the user whether to fill them too.
    DECLARE @similarUnassignedCount INT = 0;
    SELECT @similarUnassignedCount = COUNT(*)
    FROM dbo.OfferDetails od
    WHERE od.OfferID = @__offerId
      AND od.ID <> @__rowId
      AND od.ProductID IS NULL
      AND ISNULL(od.IsCategory, 0) = 0
      AND ISNULL(od.IsComment, 0) = 0
      AND ISNULL(LTRIM(RTRIM(od.RequestedBrand)),       N'') = ISNULL(LTRIM(RTRIM(@reqBrand)), N'')
      AND ISNULL(LTRIM(RTRIM(od.RequestedModelNo)),     N'') = ISNULL(LTRIM(RTRIM(@reqModel)), N'')
      AND ISNULL(LTRIM(RTRIM(od.RequestedPartNo)),      N'') = ISNULL(LTRIM(RTRIM(@reqPart)),  N'')
      AND ISNULL(LTRIM(RTRIM(od.RequestedDescription)), N'') = ISNULL(LTRIM(RTRIM(@reqDesc1)), N'')
      AND ISNULL(LTRIM(RTRIM(od.RequestedDescription2)),N'') = ISNULL(LTRIM(RTRIM(@reqDesc2)), N'')
      AND ISNULL(LTRIM(RTRIM(od.RequestedDescription3)),N'') = ISNULL(LTRIM(RTRIM(@reqDesc3)), N'');

    SELECT TOP (1)
      urp.OfferDetailID,
      urp.Quantity,
      urp.CustomerDiscount,
      urp.TelmacoDiscount,
      @similarUnassignedCount AS SimilarUnassignedCount
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
    SimilarUnassignedCount?: number | null;
  } | null;

  const similarUnassignedCount = typeof pricingRow?.SimilarUnassignedCount === 'number'
    ? pricingRow.SimilarUnassignedCount
    : 0;

  realtimeEvents.emit(
    `offer:${offerId}:products`,
    'rows-refresh',
    { reason: 'assign-requested', requestedRowId, productId, applyToSimilar, updatedBy: auditUserId ?? null },
  );

  return NextResponse.json({
    ok: true,
    updated: rowsAffected,
    similarUnassignedCount,
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
