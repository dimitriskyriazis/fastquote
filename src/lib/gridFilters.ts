import { clearPartModelNumberUpper } from "./partModelNumber";

export type QueryParam = { key: string; value: string | number | boolean };

export type QuickFilterColumn = { colId: string; expression: string };

// Normalize part/model numbers by removing special characters
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

// Derive the LegacyPartNoCleaned SQL expression from a PartNumber expression
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
  return `UPPER(COALESCE(CAST(${expression} AS NVARCHAR(MAX)), ''))`;
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

const buildSubsequenceLikePattern = (value: string): string => {
  if (!value) return '%';
  return `%${value.split('').join('%')}%`;
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

type TextMatchMode = 'contains' | 'equals' | 'startsWith' | 'endsWith' | 'notEqual';

export const buildTextMatchPredicate = (
  expression: string,
  term: string,
  options: { paramKey: string; mode?: TextMatchMode; enablePhonetic?: boolean; enableFuzzy?: boolean },
): { clause: string; params: QueryParam[] } => {
  const mode = options.mode ?? 'contains';
  const enableFuzzy = options.enableFuzzy ?? true;
  const trimmed = term.trim();
  const upper = trimmed.toUpperCase();
  const safeExpr = `LTRIM(RTRIM(COALESCE(CAST(${expression} AS NVARCHAR(MAX)), '')))`;
  const ciExpr = `UPPER(${safeExpr})`;
  const params: QueryParam[] = [];

  let value = upper;
  if (mode === 'contains') value = `%${upper}%`;
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
  } else {
    clause = `${ciExpr} LIKE @${paramKey}`;
  }

  const extraClauses: string[] = [];

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

    // Omitted-character subsequence match with the same positional guardrails.
    for (let i = 0; i < upperTerm.length; i += 1) {
      if (i < 2 || i >= upperTerm.length - 1) continue;
      const remainder = `${upperTerm.slice(0, i)}${upperTerm.slice(i + 1)}`;
      if (remainder.length < 4) continue;
      const key = `${paramKey}_seq${i}`;
      params.push({ key, value: buildSubsequenceLikePattern(remainder) });
      extraClauses.push(`(${ciExpr} LIKE @${key})`);
    }
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
  options?: { enableFuzzyText?: boolean },
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
        const legacyExpr = legacyPartNoClearedSql(expr);
        const legacyClause = legacyExpr ? ` OR ${legacyExpr} LIKE @${paramKey}` : '';
        likeParts.push(
          `(${partModelNumberSql(expr)} LIKE @${paramKey} OR ${partModelNumberSql(modelNumberColumn.expression)} LIKE @${paramKey}${legacyClause})`,
        );
        processedColumns.add('partmodel');
        processedColumns.add(expr);
        processedColumns.add(modelNumberColumn.expression);
      } else if (isModelNumber && hasPartModelCrossSearch && !processedColumns.has('partmodel')) {
        // When searching ModelNumber, also search PartNumber and LegacyPartNoCleaned
        const paramKey = `${paramPrefix}_${termIdx}_partmodel`;
        params.push({ key: paramKey, value: `%${normalizedTerm}%` });
        const legacyExpr = legacyPartNoClearedSql(partNumberColumn.expression);
        const legacyClause = legacyExpr ? ` OR ${legacyExpr} LIKE @${paramKey}` : '';
        likeParts.push(
          `(${partModelNumberSql(partNumberColumn.expression)} LIKE @${paramKey} OR ${partModelNumberSql(expr)} LIKE @${paramKey}${legacyClause})`,
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
            { paramKey, mode: 'contains', enablePhonetic: !sensitive, enableFuzzy: enableFuzzyText },
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
