export type QueryParam = { key: string; value: string | number | boolean };

const buildColumnQuickFilterExpression = (expression: string) =>
  `UPPER(COALESCE(CAST(${expression} AS NVARCHAR(MAX)), ''))`;

export const buildQuickFilterClause = (
  quickFilterText: string | null | undefined,
  columnExpressions: string[],
  paramPrefix = "quickFilter",
): { clause: string; params: QueryParam[] } => {
  const normalized = typeof quickFilterText === "string" ? quickFilterText.trim() : "";
  if (!normalized) return { clause: "", params: [] };
  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => term.toUpperCase());
  if (terms.length === 0) return { clause: "", params: [] };
  const columns = Array.from(new Set(columnExpressions.filter((expr) => typeof expr === "string" && expr.length > 0)));
  if (columns.length === 0) return { clause: "", params: [] };

  const parts: string[] = [];
  const params: QueryParam[] = [];

  terms.forEach((term, termIdx) => {
    const likeParts = columns.map((expr, colIdx) => {
      const paramKey = `${paramPrefix}_${termIdx}_${colIdx}`;
      params.push({ key: paramKey, value: `%${term}%` });
      return `${buildColumnQuickFilterExpression(expr)} LIKE @${paramKey}`;
    });
    parts.push(`(${likeParts.join(" OR ")})`);
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
