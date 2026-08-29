/**
 * Helpers for asserting on generated SQL without being brittle about the shape
 * of the predicates inside it.
 *
 * The filter builders nest AND/OR inside a single column's predicate (the
 * punctuation fold is `guard AND folded LIKE ...`, for instance), so a plain
 * `clause.includes(' AND ')` no longer says anything about how the columns
 * themselves were joined. These split at the top level instead, skipping over
 * both nested parentheses and the parentheses that live inside SQL string
 * literals — `REPLACE(x, N'(', N'')` is full of them.
 */

const isWrappedInParens = (clause: string): boolean => {
  if (!clause.startsWith('(') || !clause.endsWith(')')) return false;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < clause.length; i += 1) {
    const ch = clause[i];
    if (ch === "'") {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      // Closed the opening paren before the end: not one wrapped group.
      if (depth === 0 && i < clause.length - 1) return false;
    }
  }
  return true;
};

/**
 * Splits one clause on the given joiner, but only where it joins at the
 * outermost level. Returns a single element when the joiner never appears
 * there, so `.length` reads directly as "how many operands were joined".
 */
export const splitTopLevel = (clause: string, joiner: ' AND ' | ' OR '): string[] => {
  // Peel every redundant layer — the builders wrap per condition and again per
  // column, so a single-operand clause can arrive doubly parenthesised.
  let body = clause;
  while (isWrappedInParens(body)) body = body.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "'") {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    else if (depth === 0 && body.startsWith(joiner, i)) {
      parts.push(body.slice(start, i));
      i += joiner.length - 1;
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
};

const PARAM_COMPARISON = /(?:NOT LIKE|LIKE|<>|=) @\w+/g;

/** Every comparison in the clause that reads a bound parameter. */
export const paramComparisons = (clause: string): string[] => clause.match(PARAM_COMPARISON) ?? [];

/** Those of them whose left-hand side carries an explicit COLLATE. */
export const collatedParamComparisons = (clause: string, collation: string): string[] =>
  clause.match(new RegExp(`COLLATE ${collation} (?:NOT LIKE|LIKE|<>|=) @\\w+`, 'g')) ?? [];
