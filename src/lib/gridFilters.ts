export type QueryParam = { key: string; value: string | number | boolean };

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

export const buildQuickFilterClause = (
  quickFilterText: string | null | undefined,
  columnExpressions: string[],
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
  const columns = Array.from(new Set(columnExpressions.filter((expr) => typeof expr === "string" && expr.length > 0)));
  if (columns.length === 0) return { clause: "", params: [] };

  const parts: string[] = [];
  const params: QueryParam[] = [];

  // Find PartNumber and ModelNumber column expressions
  const partNumberExpr = columns.find((expr) => /\.PartNumber/i.test(expr));
  const modelNumberExpr = columns.find((expr) => /\.ModelNumber/i.test(expr));
  const hasPartModelCrossSearch = partNumberExpr && modelNumberExpr;

  rawTerms.forEach((term, termIdx) => {
    // Normalize term for part/model number searches
    const normalizedTerm = normalizePartModelNumber(term).toUpperCase();
    const likeParts: string[] = [];
    const processedColumns = new Set<string>();
    
    columns.forEach((expr, colIdx) => {
      const isPartNumber = partNumberExpr && expr === partNumberExpr;
      const isModelNumber = modelNumberExpr && expr === modelNumberExpr;
      
      // For PartNumber and ModelNumber, add cross-search
      if (isPartNumber && hasPartModelCrossSearch && !processedColumns.has('partmodel')) {
        // When searching PartNumber, also search ModelNumber
        const paramKey = `${paramPrefix}_${termIdx}_partmodel`;
        params.push({ key: paramKey, value: `%${normalizedTerm}%` });
        likeParts.push(`(${partModelNumberSql(expr)} LIKE @${paramKey} OR ${partModelNumberSql(modelNumberExpr)} LIKE @${paramKey})`);
        processedColumns.add('partmodel');
        processedColumns.add(expr);
        processedColumns.add(modelNumberExpr);
      } else if (isModelNumber && hasPartModelCrossSearch && !processedColumns.has('partmodel')) {
        // When searching ModelNumber, also search PartNumber
        const paramKey = `${paramPrefix}_${termIdx}_partmodel`;
        params.push({ key: paramKey, value: `%${normalizedTerm}%` });
        likeParts.push(`(${partModelNumberSql(partNumberExpr)} LIKE @${paramKey} OR ${partModelNumberSql(expr)} LIKE @${paramKey})`);
        processedColumns.add('partmodel');
        processedColumns.add(expr);
        processedColumns.add(partNumberExpr);
      } else if (!processedColumns.has(expr)) {
        // Regular column search
        const paramKey = `${paramPrefix}_${termIdx}_${colIdx}`;
        const searchValue = (isPartNumber || isModelNumber) ? normalizedTerm : term.toUpperCase();
        params.push({ key: paramKey, value: `%${searchValue}%` });
        likeParts.push(`${buildColumnQuickFilterExpression(expr)} LIKE @${paramKey}`);
        processedColumns.add(expr);
      }
    });
    
    if (likeParts.length > 0) {
      parts.push(`(${likeParts.join(" OR ")})`);
    }
  });

  if (parts.length === 0) return { clause: "", params };
  return { clause: `AND ${parts.join(" AND ")}`, params };
};

export const mergeWhereClauses = (baseWhere: string, clause: string): string => {
  const trimmedBase = baseWhere.trim();
  if (!clause.trim()) return trimmedBase;
  if (trimmedBase.length === 0) {
    return clause.replace(/^\s*AND/i, "WHERE").trim();
  }
  return `${trimmedBase} ${clause}`.trim();
};
