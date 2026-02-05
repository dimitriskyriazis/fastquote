export type QueryParam = { key: string; value: string | number | boolean };

export type QuickFilterColumn = { colId: string; expression: string };

// Normalize part/model numbers by removing special characters
const normalizePartModelNumber = (value: string): string => {
  // Remove common special characters: dashes, underscores, spaces, periods, etc.
  return value.replace(/[-_\s.]+/g, '').toUpperCase();
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
  options: { paramKey: string; mode?: TextMatchMode; enablePhonetic?: boolean },
): { clause: string; params: QueryParam[] } => {
  const mode = options.mode ?? 'contains';
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

  if (mode === 'contains' && trimmed.length >= 4 && trimmed.length <= 6 && !hasDigits(trimmed)) {
    const upperTerm = trimmed.toUpperCase();
    const firstLetterGuard = `LEFT(${ciExpr}, 1) = LEFT(UPPER(@${paramKey}_first), 1)`;
    params.push({ key: `${paramKey}_first`, value: upperTerm });
    const variants = buildAdjacentSwapVariants(trimmed).filter((v) => v !== trimmed);
    variants.forEach((variant, idx) => {
      const key = `${paramKey}_sw${idx}`;
      params.push({ key, value: `%${variant.toUpperCase()}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key} AND ${firstLetterGuard})`);
    });

    const insertionPatterns: string[] = [];
    for (let i = 0; i <= upperTerm.length; i += 1) {
      insertionPatterns.push(`${upperTerm.slice(0, i)}%${upperTerm.slice(i)}`);
    }
    insertionPatterns.forEach((pattern, idx) => {
      const key = `${paramKey}_ins${idx}`;
      params.push({ key, value: `%${pattern}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key} AND ${firstLetterGuard})`);
    });

    const substitutionPatterns: string[] = [];
    for (let i = 0; i < upperTerm.length; i += 1) {
      substitutionPatterns.push(`${upperTerm.slice(0, i)}%${upperTerm.slice(i + 1)}`);
    }
    substitutionPatterns.forEach((pattern, idx) => {
      const key = `${paramKey}_sub${idx}`;
      params.push({ key, value: `%${pattern}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key} AND ${firstLetterGuard})`);
    });
  } else if (mode === 'contains' && trimmed.length >= 7 && trimmed.length <= 9 && !hasDigits(trimmed)) {
    // For longer terms, keep only mild typo tolerance to avoid noisy matches.
    const upperTerm = trimmed.toUpperCase();
    const firstLetterGuard = `LEFT(${ciExpr}, 1) = LEFT(UPPER(@${paramKey}_first), 1)`;
    const lastLetterGuard = `RIGHT(${ciExpr}, 1) = RIGHT(UPPER(@${paramKey}_last), 1)`;
    params.push({ key: `${paramKey}_first`, value: upperTerm });
    params.push({ key: `${paramKey}_last`, value: upperTerm });

    const variants = buildAdjacentSwapVariants(trimmed).filter((v) => v !== trimmed);
    variants.forEach((variant, idx) => {
      const key = `${paramKey}_sw${idx}`;
      params.push({ key, value: `%${variant.toUpperCase()}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key} AND ${firstLetterGuard} AND ${lastLetterGuard})`);
    });

    const insertionPatterns: string[] = [];
    for (let i = 0; i <= upperTerm.length; i += 1) {
      insertionPatterns.push(`${upperTerm.slice(0, i)}%${upperTerm.slice(i)}`);
    }
    insertionPatterns.forEach((pattern, idx) => {
      const key = `${paramKey}_ins${idx}`;
      params.push({ key, value: `%${pattern}%` });
      extraClauses.push(`(${ciExpr} LIKE @${key} AND ${firstLetterGuard} AND ${lastLetterGuard})`);
    });
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
): { clause: string; params: QueryParam[] } => {
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
      
      // For PartNumber and ModelNumber, add cross-search
      if (isPartNumber && hasPartModelCrossSearch && !processedColumns.has('partmodel')) {
        // When searching PartNumber, also search ModelNumber
        const paramKey = `${paramPrefix}_${termIdx}_partmodel`;
        params.push({ key: paramKey, value: `%${normalizedTerm}%` });
        likeParts.push(
          `(${partModelNumberSql(expr)} LIKE @${paramKey} OR ${partModelNumberSql(modelNumberColumn.expression)} LIKE @${paramKey})`,
        );
        processedColumns.add('partmodel');
        processedColumns.add(expr);
        processedColumns.add(modelNumberColumn.expression);
      } else if (isModelNumber && hasPartModelCrossSearch && !processedColumns.has('partmodel')) {
        // When searching ModelNumber, also search PartNumber
        const paramKey = `${paramPrefix}_${termIdx}_partmodel`;
        params.push({ key: paramKey, value: `%${normalizedTerm}%` });
        likeParts.push(
          `(${partModelNumberSql(partNumberColumn.expression)} LIKE @${paramKey} OR ${partModelNumberSql(expr)} LIKE @${paramKey})`,
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
            { paramKey, mode: 'contains', enablePhonetic: !sensitive },
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
  return { clause: `AND (${parts.join(" OR ")})`, params };
};

export const mergeWhereClauses = (baseWhere: string, clause: string): string => {
  const trimmedBase = baseWhere.trim();
  if (!clause.trim()) return trimmedBase;
  if (trimmedBase.length === 0) {
    return clause.replace(/^\s*AND/i, "WHERE").trim();
  }
  return `${trimmedBase} ${clause}`.trim();
};
