import {
  TextFilterModel,
  NumberFilterModel,
  DateFilterModel,
  SetFilterModel,
  KnownFilterModel,
  isCompoundFilter,
  getCompoundFilterConditions,
  TextCondition,
  NumberCondition,
  DateCondition,
} from './filterTypes';
import {
  buildTextMatchPredicate,
  isSensitiveColumn,
  QueryParam,
  holdsUnboundedText,
  supportsPunctuationFolding,
} from './gridFilters';

export type FilterContext = {
  columnExpression: string;
  columnId: string;
  paramBase: string;
  /** When true, date filters compare the full datetime instead of CAST to date */
  preserveTime?: boolean;
};

const buildBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NULL)`;

const buildNotBlankClause = (columnExpression: string): string =>
  `(NULLIF(LTRIM(RTRIM(COALESCE(CAST(${columnExpression} AS NVARCHAR(MAX)), ''))), '') IS NOT NULL)`;

/**
 * Process a text filter (single or compound) and return SQL clause + params
 */
export function processTextFilter(
  filter: TextFilterModel,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  if (isCompoundFilter(filter)) {
    const conditions = getCompoundFilterConditions(filter) as TextCondition[];
    const operator = filter.operator;

    // Process all conditions
    const results = conditions
      .map((condition, idx) =>
        processSingleTextCondition(condition, {
          ...context,
          paramBase: `${context.paramBase}_c${idx}`,
        })
      )
      .filter(result => result.clause); // Filter out empty clauses

    // If no valid conditions, return empty
    if (results.length === 0) {
      return { clause: '', params: [] };
    }

    // If only one valid condition, return it directly
    if (results.length === 1) {
      return results[0];
    }

    // Combine all valid conditions with the operator
    const combinedClause = `(${results.map(r => r.clause).join(` ${operator} `)})`;
    const combinedParams = results.flatMap(r => r.params);

    return { clause: combinedClause, params: combinedParams };
  } else {
    // Single condition - backward compatible
    return processSingleTextCondition(filter, context);
  }
}

function processSingleTextCondition(
  condition: TextCondition,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  if (condition.type === 'blank') {
    return { clause: buildBlankClause(context.columnExpression), params: [] };
  }
  if (condition.type === 'notBlank') {
    return { clause: buildNotBlankClause(context.columnExpression), params: [] };
  }

  const val = String(condition.filter ?? '');
  if (!val) return { clause: '', params: [] };

  const mode = (condition.type ?? 'contains') as
    'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'notEqual';

  return buildTextMatchPredicate(context.columnExpression, val, {
    paramKey: context.paramBase,
    mode,
    enablePhonetic: !isSensitiveColumn(context.columnId),
    enablePunctuationFolding: supportsPunctuationFolding(context.columnId),
    unboundedText: holdsUnboundedText(context.columnId),
  });
}

/**
 * Process a number filter (single or compound)
 */
export function processNumberFilter(
  filter: NumberFilterModel,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  if (isCompoundFilter(filter)) {
    const conditions = getCompoundFilterConditions(filter) as NumberCondition[];
    const operator = filter.operator;

    // Process all conditions
    const results = conditions
      .map((condition, idx) =>
        processSingleNumberCondition(condition, {
          ...context,
          paramBase: `${context.paramBase}_c${idx}`,
        })
      )
      .filter(result => result.clause); // Filter out empty clauses

    // If no valid conditions, return empty
    if (results.length === 0) {
      return { clause: '', params: [] };
    }

    // If only one valid condition, return it directly
    if (results.length === 1) {
      return results[0];
    }

    // Combine all valid conditions with the operator
    const combinedClause = `(${results.map(r => r.clause).join(` ${operator} `)})`;
    const combinedParams = results.flatMap(r => r.params);

    return { clause: combinedClause, params: combinedParams };
  } else {
    return processSingleNumberCondition(filter, context);
  }
}

function processSingleNumberCondition(
  condition: NumberCondition,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  if (condition.type === 'blank') {
    return { clause: buildBlankClause(context.columnExpression), params: [] };
  }
  if (condition.type === 'notBlank') {
    return { clause: buildNotBlankClause(context.columnExpression), params: [] };
  }

  const val = condition.filter !== undefined ? Number(condition.filter) : Number.NaN;
  if (Number.isNaN(val)) return { clause: '', params: [] };

  const { columnExpression, paramBase } = context;
  const params: QueryParam[] = [];
  let clause = '';

  switch (condition.type) {
    case 'equals':
      clause = `${columnExpression} = @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'notEqual':
      clause = `${columnExpression} <> @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'lessThan':
      clause = `${columnExpression} < @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'greaterThan':
      clause = `${columnExpression} > @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'lessThanOrEqual':
      clause = `${columnExpression} <= @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'greaterThanOrEqual':
      clause = `${columnExpression} >= @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'inRange': {
      const valTo = condition.filterTo !== undefined ? Number(condition.filterTo) : undefined;
      if (valTo !== undefined && !Number.isNaN(valTo)) {
        clause = `(${columnExpression} BETWEEN @${paramBase} AND @${paramBase}_to)`;
        params.push({ key: paramBase, value: val });
        params.push({ key: `${paramBase}_to`, value: valTo });
      }
      break;
    }
  }

  return { clause, params };
}

/**
 * Process a date filter (single or compound)
 */
export function processDateFilter(
  filter: DateFilterModel,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  if (isCompoundFilter(filter)) {
    const conditions = getCompoundFilterConditions(filter) as DateCondition[];
    const operator = filter.operator;

    // Process all conditions
    const results = conditions
      .map((condition, idx) =>
        processSingleDateCondition(condition, {
          ...context,
          paramBase: `${context.paramBase}_c${idx}`,
        })
      )
      .filter(result => result.clause); // Filter out empty clauses

    // If no valid conditions, return empty
    if (results.length === 0) {
      return { clause: '', params: [] };
    }

    // If only one valid condition, return it directly
    if (results.length === 1) {
      return results[0];
    }

    // Combine all valid conditions with the operator
    const combinedClause = `(${results.map(r => r.clause).join(` ${operator} `)})`;
    const combinedParams = results.flatMap(r => r.params);

    return { clause: combinedClause, params: combinedParams };
  } else {
    return processSingleDateCondition(filter, context);
  }
}

function processSingleDateCondition(
  condition: DateCondition,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  if (condition.type === 'blank') {
    return { clause: buildBlankClause(context.columnExpression), params: [] };
  }
  if (condition.type === 'notBlank') {
    return { clause: buildNotBlankClause(context.columnExpression), params: [] };
  }

  const val = condition.dateFrom || condition.filter;
  if (!val) return { clause: '', params: [] };

  const { columnExpression, paramBase } = context;
  const isMidnight = (v: string) => v.endsWith(' 00:00:00');
  const valHasTime = context.preserveTime && !isMidnight(val);
  const dateExpr = valHasTime
    ? columnExpression
    : `CAST(${columnExpression} AS date)`;
  const params: QueryParam[] = [];
  let clause = '';

  switch (condition.type) {
    case 'equals':
      clause = `${dateExpr} = @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'notEqual':
      clause = `${dateExpr} <> @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'lessThan':
      clause = `${dateExpr} < @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'greaterThan':
      clause = `${dateExpr} > @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'lessThanOrEqual':
      clause = `${dateExpr} <= @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'greaterThanOrEqual':
      clause = `${dateExpr} >= @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'inRange': {
      const valTo = condition.dateTo;
      if (valTo) {
        const rangeHasTime = context.preserveTime && (!isMidnight(val) || !isMidnight(valTo));
        const rangeExpr = rangeHasTime
          ? columnExpression
          : `CAST(${columnExpression} AS date)`;
        clause = `(${rangeExpr} BETWEEN @${paramBase} AND @${paramBase}_to)`;
        params.push({ key: paramBase, value: val });
        params.push({ key: `${paramBase}_to`, value: valTo });
      }
      break;
    }
  }

  return { clause, params };
}

/**
 * Process a set filter (unchanged - no compound support needed)
 */
export function processSetFilter(
  filter: SetFilterModel,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  const rawValues = filter.values ?? [];
  if (rawValues.length === 0) return { clause: '', params: [] };

  const params: QueryParam[] = [];
  const normalize = (value: string | number | boolean) => {
    if (value === true || value === 'true') return 1;
    if (value === false || value === 'false') return 0;
    return value;
  };

  const placeholders = rawValues.map((value, valueIdx) => {
    const key = `${context.paramBase}_${valueIdx}`;
    params.push({ key, value: normalize(value) });
    return `@${key}`;
  });

  const clause = `${context.columnExpression} IN (${placeholders.join(', ')})`;
  return { clause, params };
}

/**
 * Main entry point: process any filter type
 */
export function processFilter(
  filter: KnownFilterModel,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  switch (filter.filterType) {
    case 'text':
      return processTextFilter(filter as TextFilterModel, context);
    case 'number':
      return processNumberFilter(filter as NumberFilterModel, context);
    case 'date':
      return processDateFilter(filter as DateFilterModel, context);
    case 'set':
      return processSetFilter(filter as SetFilterModel, context);
    default:
      return { clause: '', params: [] };
  }
}

/**
 * Condition types that mean "does NOT match". When one filter is spread over
 * several columns these have to be ANDed rather than ORed, so the columns keep
 * behaving like a single virtual value: "not contains X" must exclude the row
 * when EITHER column contains X, and "blank" only passes when both are blank.
 */
const NEGATED_CONDITION_TYPES = new Set(['notContains', 'notEqual', 'blank']);

const isNegatedCondition = (filter: KnownFilterModel): boolean => {
  const type = (filter as { type?: unknown }).type;
  return typeof type === 'string' && NEGATED_CONDITION_TYPES.has(type);
};

export type CrossColumnTarget = {
  columnExpression: string;
  columnId: string;
};

/**
 * Apply one column's filter to several columns at once, so a term typed into a
 * column also searches its aliases (e.g. Customer Name <-> Official Name).
 *
 * Compound filters are split first and each condition spread over the targets
 * individually. Spreading the whole model per column instead would give
 * "contains X AND notContains Y" the wrong meaning, because the two conditions
 * would then have to be satisfied by the same column.
 *
 * With a single target this is exactly processFilter().
 */
export function processFilterAcrossColumns(
  filter: KnownFilterModel,
  targets: CrossColumnTarget[],
  options: { paramBase: string; preserveTime?: boolean }
): { clause: string; params: QueryParam[] } {
  if (targets.length === 0) return { clause: '', params: [] };
  if (targets.length === 1) {
    return processFilter(filter, {
      columnExpression: targets[0].columnExpression,
      columnId: targets[0].columnId,
      paramBase: options.paramBase,
      preserveTime: options.preserveTime,
    });
  }

  const compound = isCompoundFilter(filter);
  const conditions: KnownFilterModel[] = compound ? getCompoundFilterConditions(filter) : [filter];
  const operator = compound ? filter.operator : 'AND';

  // Conditions coming from older grid payloads can omit filterType; inherit the
  // parent's so processFilter still routes them to the right processor.
  const withParentFilterType = (condition: KnownFilterModel): KnownFilterModel =>
    (condition as { filterType?: unknown }).filterType
      ? condition
      : ({ ...condition, filterType: filter.filterType } as KnownFilterModel);

  const conditionClauses: string[] = [];
  const params: QueryParam[] = [];

  conditions.forEach((condition, conditionIdx) => {
    const resolved = withParentFilterType(condition);
    const results = targets
      .map((target, targetIdx) =>
        processFilter(resolved, {
          columnExpression: target.columnExpression,
          columnId: target.columnId,
          paramBase: `${options.paramBase}_c${conditionIdx}_x${targetIdx}`,
          preserveTime: options.preserveTime,
        })
      )
      .filter(result => result.clause);

    if (results.length === 0) return;
    results.forEach(result => params.push(...result.params));
    const joiner = isNegatedCondition(resolved) ? ' AND ' : ' OR ';
    conditionClauses.push(
      results.length === 1 ? results[0].clause : `(${results.map(r => r.clause).join(joiner)})`
    );
  });

  if (conditionClauses.length === 0) return { clause: '', params: [] };
  if (conditionClauses.length === 1) return { clause: conditionClauses[0], params };
  return { clause: `(${conditionClauses.join(` ${operator} `)})`, params };
}
