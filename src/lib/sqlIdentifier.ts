/**
 * SQL Server identifier-safety helpers for AG-Grid sort/filter building.
 *
 * AG-Grid sends `colId` / `sort` values from the client. When a column is not in a
 * route's COLUMN_EXPRESSIONS whitelist, routes fall back to a delimited identifier
 * `[${colId}]`. A `]` in colId would otherwise close the bracket early and inject SQL
 * (e.g. `colId = "x] ; <sql> --"`). `sqlBracketId` doubles every `]`, so the value can
 * never escape the brackets — an unknown column yields an "invalid column" error, never
 * injection. Use it for ANY delimited identifier built from request-derived input.
 */
export const sqlBracketId = (id: string): string =>
  `[${String(id).replace(/]/g, ']]')}]`;

/**
 * Whitelist a SQL sort direction. Never interpolate a client-supplied direction string
 * (e.g. `sortModel[i].sort`) into ORDER BY directly — only ever emit ASC or DESC.
 */
export const sqlSortDirection = (dir: unknown): 'ASC' | 'DESC' =>
  String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
