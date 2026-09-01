import {clearPartModelNumberUpper} from "./partModelNumber";
import { collateSearch, foldPunctuation, foldPunctuationSql, hasPunctuationSql } from "./textSearch";

export type QueryParam = { key: string; value: string | number | boolean };

export type QuickFilterColumn = { colId: string; expression: string };

/**
 * Longest value a text filter compares. Casting to NVARCHAR(MAX) makes every
 * downstream UPPER/LIKE a LOB operation, which measured ~45% of the CPU of a
 * quick search across the app; the penalty is purely MAX-vs-not, with
 * NVARCHAR(4000) exactly as fast as NVARCHAR(400). 4000 clears the longest
 * value in every searchable column in the database except the ones
 * {@link holdsUnboundedText} keeps on MAX.
 */
const TEXT_MATCH_MAX_CHARS = 4000;

// Normalize part/model numbers by removing special characters
const normalizePartModelNumber = (value: string): string => {
  return clearPartModelNumberUpper(value);
};

// Helper to get the cleared column name for part/model numbers
// Uses the existing PartNumberCleared and ModelNumberCleared columns for better performance.
// Strips x/X between digits at query time so stored cleared values do not need backfill
// (cable specs like "2x250" / "2x2x250" match users typing "2250" / "22250").
const partModelNumberSql = (expr: string) => {
  if (expr.includes('.PartNumber')) {
    return `UPPER(ISNULL(${expr.replace('.PartNumber', '.PartNumberCleared')}, ''))`;
  }
  if (expr.includes('.ModelNumber')) {
    return `UPPER(ISNULL(${expr.replace('.ModelNumber', '.ModelNumberCleared')}, ''))`;
  }
  return `UPPER(ISNULL(${expr}, ''))`;
};

const legacyPartNoClearedSql = (expr: string): string | null => {
  if (expr.includes('.PartNumber')) {
    return `UPPER(ISNULL(${expr.replace('.PartNumber', '.LegacyPartNoCleaned')}, ''))`;
  }
  return null;
};

const buildColumnQuickFilterExpression = (expression: string) => {
  // Check if this is a PartNumber or ModelNumber column
  const isPartModelNumber = /\.(PartNumber|ModelNumber)/i.test(expression);
  if (isPartModelNumber) {
    // Use normalized expression for part/model numbers
    return partModelNumberSql(expression);
  }
  // Default behavior for other columns
  return `UPPER(COALESCE(CAST(${expression} AS NVARCHAR(${TEXT_MATCH_MAX_CHARS})), ''))`;
};

const hasDigits = (value: string): boolean => /\d/.test(value);

const buildAdjacentSwapVariants = (value: string): string[] => {
  if (value.length < 2) return [];
  const variants = new Set<string>();
  for (let i = 0; i < value.length - 1; i += 1) {
    const chars = value.split('');
    const tmp = chars[i];
    chars[i] = chars[i + 1];
    chars[i + 1] = tmp;
    variants.add(chars.join(''));
  }
  return Array.from(variants);
};

export const isSensitiveColumn = (colId: string): boolean => {
  if (!colId) return true;
  const normalized = colId.trim();
  if (!normalized) return true;
  const lower = normalized.toLowerCase();
  if (['partnumber', 'modelnumber', 'erpcode', 'weblink'].includes(lower)) return true;
  if (/description/i.test(normalized)) return true;
  if (/(^|[^a-z])id$/i.test(normalized)) return true;
  if (/code/i.test(normalized)) return true;
  if (/number/i.test(normalized)) return true;
  if (/price/i.test(normalized)) return true;
  if (/cost/i.test(normalized)) return true;
  if (/date/i.test(normalized)) return true;
  if (/link/i.test(normalized)) return true;
  if (/url/i.test(normalized)) return true;
  return false;
};

/**
 * Whether folding punctuation out of a column (see {@link foldPunctuationSql})
 * is worth what it costs there.
 *
 * The fold is a per-row REPLACE chain, so its price scales with rows x text
 * length. On name-shaped columns that is roughly +150ms over a table of tens of
 * thousands of rows — worth it, because names are exactly where the punctuation
 * users omit lives ("P.A. Solutions", "A.E.", "AT&T"). On the free-text and
 * part-number columns excluded below it runs to several SECONDS over
 * dbo.Products, buying almost nothing: prose does not hide identity behind a
 * dot, and part/model numbers already match through their pre-cleared columns.
 */
export const supportsPunctuationFolding = (colId: string): boolean => {
  const normalized = (colId ?? '').trim();
  if (!normalized) return false;
  // Free text: long values, and no "P.A." problem to solve.
  if (/description|comment|note|remark|summary|content|body|message|html/i.test(normalized)) return false;
  // Punctuation IS the content here — folding it is meaningless and expensive.
  if (/weblink|website|url|link|domain|email|mail$/i.test(normalized)) return false;
  // Already folded at rest via PartNumberCleared / ModelNumberCleared.
  if (/part\s*(number|no)|model\s*(number|no)/i.test(normalized)) return false;
  // Non-text columns: the fold would only pay to CAST a number or a flag to
  // text and change nothing about it. The id test is case-SENSITIVE on purpose,
  // so it catches the camel/upper boundary in "ProductID" / "customerId"
  // without also swallowing words that merely end in "id" ("Madrid", "Valid").
  if (/(?:ID|Id)$/.test(normalized) || /^id$/i.test(normalized)) return false;
  if (/price|cost|amount|total|margin|discount|qty|quantity|percent|date|time$/i.test(normalized)) return false;
  if (/^is[A-Z]|enabled|disabled|active|deleted|archived|visible/i.test(normalized)) return false;
  return true;
};


/**
 * Columns that really can run past {@link TEXT_MATCH_MAX_CHARS} and would
 * therefore lose matches if their tail were cut off — log payloads and the like,
 * where the string you are hunting for may sit 50,000 characters in. They keep
 * the slower NVARCHAR(MAX) cast.
 */
export const holdsUnboundedText = (colId: string): boolean =>
  /details|payload|stack|trace|exception|body|html|json|xml|raw/i.test((colId ?? '').trim());

const buildSafeTextExpression = (expression: string, unbounded?: boolean): string => {
  const size = unbounded ? 'MAX' : String(TEXT_MATCH_MAX_CHARS);
  return `LTRIM(RTRIM(COALESCE(CAST(${expression} AS NVARCHAR(${size})), '')))`;
};

type TextMatchMode = 'contains' | 'notContains' | 'equals' | 'startsWith' | 'endsWith' | 'notEqual';

export const buildTextMatchPredicate = (
  expression: string,
  term: string,
  options: {
    paramKey: string;
    mode?: TextMatchMode;
    enablePhonetic?: boolean;
    enableFuzzy?: boolean;
    /**
     * Also match with punctuation folded out of both sides ("PA Solutions"
     * finds "P.A. Solutions"). Off unless asked for: it adds a per-row REPLACE
     * chain, so callers on hot paths keep the cheap predicate. The grid entry
     * points below turn it on per column via {@link supportsPunctuationFolding}.
     */
    enablePunctuationFolding?: boolean;
    /**
     * Keep the NVARCHAR(MAX) cast for a column whose values can exceed
     * {@link TEXT_MATCH_MAX_CHARS}. Off by default — see {@link holdsUnboundedText}.
     */
    unboundedText?: boolean;
  },
): { clause: string; params: QueryParam[] } => {
  const mode = options.mode ?? 'contains';
  const enableFuzzy = options.enableFuzzy ?? true;
  const trimmed = term.trim();
  const upper = trimmed.toUpperCase();
  const safeExpr = buildSafeTextExpression(expression, options.unboundedText);
  // Accent-insensitive: the database collation is accent-sensitive, so without this
  // a user typing "ΕΛΛΑΣ" would not match stored "Ελλάς" (and vice versa). Covers
  // every mode below plus the fuzzy variant clauses, which all reuse ciExpr.
  const ciExpr = collateSearch(`UPPER(${safeExpr})`);
  const params: QueryParam[] = [];

  let value = upper;
  if (mode === 'contains' || mode === 'notContains') value = `%${upper}%`;
  if (mode === 'startsWith') value = `${upper}%`;
  if (mode === 'endsWith') value = `%${upper}`;

  const paramKey = options.paramKey;
  if (mode === 'equals') {
    params.push({ key: paramKey, value: upper });
  } else if (mode === 'notEqual') {
    params.push({ key: paramKey, value: upper });
  } else {
    params.push({ key: paramKey, value });
  }

  let clause = '';
  if (mode === 'equals') {
    clause = `${ciExpr} = @${paramKey}`;
  } else if (mode === 'notEqual') {
    clause = `${ciExpr} <> @${paramKey}`;
  } else if (mode === 'notContains') {
    clause = `${ciExpr} NOT LIKE @${paramKey}`;
  } else {
    clause = `${ciExpr} LIKE @${paramKey}`;
  }

  const extraClauses: string[] = [];

  // Punctuation-insensitive twin of the clause above: "PA Solutions" finds
  // "P.A. Solutions", "ATT" finds "AT&T", "ΔΙ3748" finds "ΔΙ.3748".
  //
  // `folded(col) LIKE @f` is written out as `col LIKE @f OR (col has
  // punctuation AND folded(col) LIKE @f)` rather than folding every row. The
  // two forms are exactly equivalent — a punctuation-free needle that occurs in
  // the raw value survives folding intact, so the first disjunct can only be
  // true when the second would be — and the guard lets SQL Server skip the
  // REPLACE chain on rows with no punctuation to fold.
  //
  // When the TERM carries the punctuation and the column does not ("P.A."
  // typed, "PA Solutions" stored), the raw probe is the disjunct that matches;
  // when the term is already clean it duplicates the base clause and is
  // dropped, reusing its parameter.
  const foldedTerm = options.enablePunctuationFolding ? foldPunctuation(upper) : '';
  if (foldedTerm) {
    const foldedOperator = mode === 'equals' || mode === 'notEqual' ? '=' : 'LIKE';
    const termIsAlreadyFolded = foldedTerm === upper;
    const foldedKey = termIsAlreadyFolded ? paramKey : `${paramKey}_pf`;
    if (!termIsAlreadyFolded) {
      let foldedValue = foldedTerm;
      if (mode === 'contains' || mode === 'notContains') foldedValue = `%${foldedTerm}%`;
      if (mode === 'startsWith') foldedValue = `${foldedTerm}%`;
      if (mode === 'endsWith') foldedValue = `%${foldedTerm}`;
      params.push({ key: foldedKey, value: foldedValue });
    }
    const foldedExpr = collateSearch(foldPunctuationSql(`UPPER(${safeExpr})`));
    const guardedFold = `(${hasPunctuationSql(ciExpr)} AND ${foldedExpr} ${foldedOperator} @${foldedKey})`;
    const foldedMatch = termIsAlreadyFolded
      ? guardedFold
      : `(${ciExpr} ${foldedOperator} @${foldedKey} OR ${guardedFold})`;

    if (mode === 'notContains' || mode === 'notEqual') {
      // "does not contain" has to exclude the folded match too, so it stays a
      // single virtual value: AND, never OR.
      clause = `(${clause} AND NOT ${foldedMatch})`;
    } else {
      extraClauses.push(foldedMatch);
    }
  }

  if (enableFuzzy && mode === 'contains' && trimmed.length >= 4 && trimmed.length <= 9 && !hasDigits(trimmed)) {
    const upperTerm = trimmed.toUpperCase();

    // Swap variants: keep first letter intact, limit to 2
    const variants = buildAdjacentSwapVariants(trimmed)
      .filter((v) => v !== trimmed && v[0].toUpperCase() === upperTerm[0])
      .slice(0, 2);
    variants.forEach((variant, idx) => {
      const key = `${paramKey}_sw${idx}`;
      params.push({ key, value: `%${variant.toUpperCase()}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key})`);
    });

    // Insertion: both fragments >= 3 (kicks in at 6+ char terms)
    for (let i = 0; i <= upperTerm.length; i += 1) {
      const left = upperTerm.slice(0, i);
      const right = upperTerm.slice(i);
      if (left.length < 3 || right.length < 3) continue;
      const key = `${paramKey}_ins${i}`;
      params.push({ key, value: `%${left}%${right}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key})`);
    }

    // Substitution: keep the first two and last characters stable to reduce false positives.
    // This avoids broad matches like "extron" -> "xrestron" while still allowing
    // omissions in the middle (e.g. "exron" -> "crestron").
    for (let i = 0; i < upperTerm.length; i += 1) {
      if (i < 2 || i >= upperTerm.length - 1) continue;
      const left = upperTerm.slice(0, i);
      const right = upperTerm.slice(i + 1);
      if (left.length < 1 || right.length < 1) continue;
      if (Math.max(left.length, right.length) < 3) continue;
      const key = `${paramKey}_sub${i}`;
      params.push({ key, value: `%${left}%${right}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key})`);
    }

    // Subsequence matching removed — patterns like %T%E%L%M%A%C%O% are too
    // broad and produce excessive false positives on text columns (e.g.
    // "telmaco" matching "Byte Computer Applications Ltd").
  }

  // Phonetic matching disabled due to frequent false positives in UI searches.

  if (extraClauses.length > 0) {
    clause = `(${[clause, ...extraClauses].join(' OR ')})`;
  }

  return { clause, params };
};

export const buildQuickFilterClause = (
  quickFilterText: string | null | undefined,
  columnExpressions: Array<QuickFilterColumn | string>,
  paramPrefix = "quickFilter",
  options?: { enableFuzzyText?: boolean; legacyPartNoExpression?: string; partNumberClearedExpression?: string; modelNumberClearedExpression?: string },
): { clause: string; params: QueryParam[] } => {
  const enableFuzzyText = options?.enableFuzzyText ?? true;
  const normalized = typeof quickFilterText === "string" ? quickFilterText.trim() : "";
  if (!normalized) return { clause: "", params: [] };
  // Split into terms first, then normalize each term for part/model numbers
  const rawTerms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (rawTerms.length === 0) return { clause: "", params: [] };
  const normalizedColumns = columnExpressions
    .map((col) => {
      if (typeof col === "string") {
        return { colId: col, expression: col };
      }
      if (col && typeof col.expression === "string" && col.expression.length > 0) {
        const colId = typeof col.colId === "string" && col.colId.length > 0 ? col.colId : col.expression;
        return { colId, expression: col.expression };
      }
      return null;
    })
    .filter((col): col is QuickFilterColumn => Boolean(col));
  const columns = Array.from(
    new Map(normalizedColumns.map((col) => [col.expression, col])).values(),
  );
  if (columns.length === 0) return { clause: "", params: [] };

  const parts: string[] = [];
  const params: QueryParam[] = [];

  // Find PartNumber and ModelNumber column expressions
  const partNumberColumn = columns.find(
    (col) => col.colId === "PartNumber" || /\.PartNumber/i.test(col.expression),
  );
  const modelNumberColumn = columns.find(
    (col) => col.colId === "ModelNumber" || /\.ModelNumber/i.test(col.expression),
  );
  const hasPartModelCrossSearch = partNumberColumn && modelNumberColumn;

  // When override expressions are provided, use them instead of deriving from the column expression
  // This is needed when PartNumber/ModelNumber come from a table without Cleared columns (e.g. OfferDetails)
  const resolvePartNumberSql = (expr: string) =>
    options?.partNumberClearedExpression && /\.PartNumber/i.test(expr)
      ? `UPPER(ISNULL(${options.partNumberClearedExpression}, ''))`
      : partModelNumberSql(expr);
  const resolveModelNumberSql = (expr: string) =>
    options?.modelNumberClearedExpression && /\.ModelNumber/i.test(expr)
      ? `UPPER(ISNULL(${options.modelNumberClearedExpression}, ''))`
      : partModelNumberSql(expr);
  const resolvePartModelSql = (expr: string) => {
    if (/\.PartNumber/i.test(expr)) return resolvePartNumberSql(expr);
    if (/\.ModelNumber/i.test(expr)) return resolveModelNumberSql(expr);
    return partModelNumberSql(expr);
  };

  rawTerms.forEach((term, termIdx) => {
    // Normalize term for part/model number searches
    const normalizedTerm = normalizePartModelNumber(term).toUpperCase();
    const likeParts: string[] = [];
    const processedColumns = new Set<string>();

    columns.forEach((col, colIdx) => {
      const expr = col.expression;
      const isPartNumber = partNumberColumn && expr === partNumberColumn.expression;
      const isModelNumber = modelNumberColumn && expr === modelNumberColumn.expression;

      // For PartNumber and ModelNumber, add cross-search (also searches LegacyPartNoCleaned)
      if (isPartNumber && hasPartModelCrossSearch && !processedColumns.has('partmodel')) {
        // When searching PartNumber, also search ModelNumber and LegacyPartNoCleaned
        const paramKey = `${paramPrefix}_${termIdx}_partmodel`;
        params.push({ key: paramKey, value: `%${normalizedTerm}%` });
        const legacyExpr = options?.legacyPartNoExpression
          ? `UPPER(ISNULL(${options.legacyPartNoExpression}, ''))`
          : legacyPartNoClearedSql(expr);
        const legacyClause = legacyExpr ? ` OR ${legacyExpr} LIKE @${paramKey}` : '';
        likeParts.push(
          `(${resolvePartModelSql(expr)} LIKE @${paramKey} OR ${resolvePartModelSql(modelNumberColumn.expression)} LIKE @${paramKey}${legacyClause})`,
        );
        processedColumns.add('partmodel');
        processedColumns.add(expr);
        processedColumns.add(modelNumberColumn.expression);
      } else if (isModelNumber && hasPartModelCrossSearch && !processedColumns.has('partmodel')) {
        // When searching ModelNumber, also search PartNumber and LegacyPartNoCleaned
        const paramKey = `${paramPrefix}_${termIdx}_partmodel`;
        params.push({ key: paramKey, value: `%${normalizedTerm}%` });
        const legacyExpr = options?.legacyPartNoExpression
          ? `UPPER(ISNULL(${options.legacyPartNoExpression}, ''))`
          : legacyPartNoClearedSql(partNumberColumn.expression);
        const legacyClause = legacyExpr ? ` OR ${legacyExpr} LIKE @${paramKey}` : '';
        likeParts.push(
          `(${resolvePartModelSql(partNumberColumn.expression)} LIKE @${paramKey} OR ${resolvePartModelSql(expr)} LIKE @${paramKey}${legacyClause})`,
        );
        processedColumns.add('partmodel');
        processedColumns.add(expr);
        processedColumns.add(partNumberColumn.expression);
      } else if (!processedColumns.has(expr)) {
        // Regular column search
        const paramKey = `${paramPrefix}_${termIdx}_${colIdx}`;
        const searchValue = (isPartNumber || isModelNumber) ? normalizedTerm : term;
        if (isPartNumber || isModelNumber) {
          params.push({ key: paramKey, value: `%${searchValue}%` });
          likeParts.push(`${buildColumnQuickFilterExpression(expr)} LIKE @${paramKey}`);
        } else {
          const sensitive = isSensitiveColumn(col.colId);
          const { clause, params: clauseParams } = buildTextMatchPredicate(
            expr,
            searchValue,
            {
              paramKey,
              mode: 'contains',
              enablePhonetic: !sensitive,
              enableFuzzy: enableFuzzyText,
              enablePunctuationFolding: supportsPunctuationFolding(col.colId),
              unboundedText: holdsUnboundedText(col.colId),
            },
          );
          likeParts.push(clause);
          clauseParams.forEach((p) => params.push(p));
        }
        processedColumns.add(expr);
      }
    });
    
    if (likeParts.length > 0) {
      parts.push(`(${likeParts.join(" OR ")})`);
    }
  });

  if (parts.length === 0) return { clause: "", params };
  return { clause: `AND (${parts.join(" AND ")})`, params };
};

export const mergeWhereClauses = (baseWhere: string, clause: string): string => {
  const trimmedBase = baseWhere.trim();
  if (!clause.trim()) return trimmedBase;
  if (trimmedBase.length === 0) {
    return clause.replace(/^\s*AND/i, "WHERE").trim();
  }
  return `${trimmedBase} ${clause}`.trim();
};
