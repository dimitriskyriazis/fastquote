import {
  TextFilterModel,
  NumberFilterModel,
  DateFilterModel,
  SetFilterModel,
  KnownFilterModel,
  isCompoundFilter,
  TextCondition,
  NumberCondition,
  DateCondition,
} from './filterTypes';
import { buildTextMatchPredicate, isSensitiveColumn, QueryParam } from './gridFilters';

export type FilterContext = {
  columnExpression: string;
  columnId: string;
  paramBase: string;
};

/**
 * Process a text filter (single or compound) and return SQL clause + params
 */
export function processTextFilter(
  filter: TextFilterModel,
  context: FilterContext
): { clause: string; params: QueryParam[] } {
  if (isCompoundFilter(filter)) {
    const { conditions, operator } = filter;

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
  const val = String(condition.filter ?? '');
  if (!val) return { clause: '', params: [] };

  const mode = (condition.type ?? 'contains') as
    'contains' | 'equals' | 'startsWith' | 'endsWith' | 'notEqual';

  return buildTextMatchPredicate(context.columnExpression, val, {
    paramKey: context.paramBase,
    mode,
    enablePhonetic: !isSensitiveColumn(context.columnId),
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
    const { conditions, operator } = filter;

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
    case 'blank':
      clause = `(${columnExpression} IS NULL)`;
      break;
    case 'notBlank':
      clause = `(${columnExpression} IS NOT NULL)`;
      break;
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
    const { conditions, operator } = filter;

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
  const val = condition.dateFrom || condition.filter;
  if (!val) return { clause: '', params: [] };

  const { columnExpression, paramBase } = context;
  const dateExpression = `CAST(${columnExpression} AS date)`;
  const params: QueryParam[] = [];
  let clause = '';

  switch (condition.type) {
    case 'equals':
      clause = `${dateExpression} = @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'notEqual':
      clause = `${dateExpression} <> @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'lessThan':
      clause = `${dateExpression} < @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'greaterThan':
      clause = `${dateExpression} > @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'lessThanOrEqual':
      clause = `${dateExpression} <= @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'greaterThanOrEqual':
      clause = `${dateExpression} >= @${paramBase}`;
      params.push({ key: paramBase, value: val });
      break;
    case 'inRange': {
      const valTo = condition.dateTo;
      if (valTo) {
        clause = `(${dateExpression} BETWEEN @${paramBase} AND @${paramBase}_to)`;
        params.push({ key: paramBase, value: val });
        params.push({ key: `${paramBase}_to`, value: valTo });
      }
      break;
    }
    case 'blank':
      clause = `(${columnExpression} IS NULL)`;
      break;
    case 'notBlank':
      clause = `(${columnExpression} IS NOT NULL)`;
      break;
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
