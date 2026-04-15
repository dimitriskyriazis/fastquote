/**
 * Serialization utilities for persisting AG Grid filter/sort/quick-search
 * state in URL query parameters.
 *
 * URL param schema:
 *   f  – filter model  (compact text format, see below)
 *   s  – sort model    (ColId:asc,ColId2:desc)
 *   q  – quick search  (plain text)
 *
 * Compact filter format (`.` separates columns, `~` separates parts):
 *   Text:     ColName~T~cn~searchterm
 *   Set:      ColName~S~val1,val2
 *   Number:   ColName~N~gt~100       or  ColName~N~ir~100~200
 *   Date:     ColName~D~gt~2024-01-01
 *   Blank:    ColName~T~bl
 *   Compound: ColName~T~&~cn~hello!eq~world   (! separates conditions)
 *
 * When a `namespace` is provided the params become f_<ns>, s_<ns>, q_<ns>.
 *
 * All encode/decode operations are **synchronous** so that filters can be
 * applied before the grid's first server-side fetch fires.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FILTER_PARAM_LENGTH = 1500;

// Delimiter characters (all URL-safe, no percent-encoding needed)
const COL_SEP = '.';   // between columns
const PART_SEP = '~';  // between parts within a column
const SET_SEP = ',';   // between set values
const COND_SEP = '!';  // between conditions in compound filters

// ---------------------------------------------------------------------------
// Short codes for filter types and operators
// ---------------------------------------------------------------------------

const FT_TO_SHORT: Record<string, string> = {
  text: 'T', number: 'N', date: 'D', set: 'S',
};
const SHORT_TO_FT: Record<string, string> = {};
for (const [long, short] of Object.entries(FT_TO_SHORT)) SHORT_TO_FT[short] = long;

const OP_TO_SHORT: Record<string, string> = {
  contains: 'cn', equals: 'eq', notEqual: 'ne',
  startsWith: 'sw', endsWith: 'ew',
  blank: 'bl', notBlank: 'nb',
  lessThan: 'lt', greaterThan: 'gt',
  lessThanOrEqual: 'le', greaterThanOrEqual: 'ge',
  inRange: 'ir',
};
const SHORT_TO_OP: Record<string, string> = {};
for (const [long, short] of Object.entries(OP_TO_SHORT)) SHORT_TO_OP[short] = long;

const COMPOUND_TO_SHORT: Record<string, string> = { AND: '&', OR: '|' };
const SHORT_TO_COMPOUND: Record<string, string> = { '&': 'AND', '|': 'OR' };

// ---------------------------------------------------------------------------
// Value escaping (protect our delimiters inside user data)
// ---------------------------------------------------------------------------

function escapeValue(s: string): string {
  // Percent-encode our delimiter characters so they don't break parsing
  return s
    .replace(/%/g, '%25')
    .replace(/\./g, '%2E')
    .replace(/~/g, '%7E')
    .replace(/,/g, '%2C')
    .replace(/!/g, '%21');
}

function unescapeValue(s: string): string {
  return s
    .replace(/%21/gi, '!')
    .replace(/%2C/gi, ',')
    .replace(/%7E/gi, '~')
    .replace(/%2E/gi, '.')
    .replace(/%25/g, '%');
}

// ---------------------------------------------------------------------------
// Encode a single column's filter descriptor → compact string
// ---------------------------------------------------------------------------

function encodeCondition(
  ft: string,
  desc: Record<string, unknown>,
): string | null {
  const rawType = (desc.type ?? '') as string;
  const tp = OP_TO_SHORT[rawType] ?? rawType;

  // blank / notBlank have no value
  if (tp === 'bl' || tp === 'nb') return tp;

  // Get value and optional range end
  let val: string;
  let valTo: string | undefined;

  if (ft === 'D') {
    val = String(desc.dateFrom ?? desc.filter ?? '');
    const dt = desc.dateTo;
    if (dt !== undefined && dt !== null && dt !== '') valTo = String(dt);
  } else if (ft === 'N') {
    val = String(desc.filter ?? '');
    const fto = desc.filterTo;
    if (fto !== undefined && fto !== null && fto !== '') valTo = String(fto);
  } else {
    val = String(desc.filter ?? '');
  }

  let result = `${tp}${PART_SEP}${escapeValue(val)}`;
  if (valTo !== undefined) result += `${PART_SEP}${escapeValue(valTo)}`;
  return result;
}

function encodeColumnFilter(descriptor: Record<string, unknown>): string | null {
  const rawFt = (descriptor.filterType ?? '') as string;
  const ft = FT_TO_SHORT[rawFt] ?? rawFt;

  // Set filter
  if (ft === 'S') {
    const values = descriptor.values as unknown[] | undefined;
    if (!values || !Array.isArray(values)) return `S`;
    return `S${PART_SEP}${values.map(v => escapeValue(String(v))).join(SET_SEP)}`;
  }

  // Compound filter (operator + conditions)
  const rawOp = (descriptor.operator ?? '') as string;
  if (rawOp) {
    const op = COMPOUND_TO_SHORT[rawOp] ?? rawOp;
    // Modern: conditions array
    const conditions = descriptor.conditions as Record<string, unknown>[] | undefined;
    // Legacy: condition1 / condition2
    const c1 = descriptor.condition1 as Record<string, unknown> | undefined;
    const c2 = descriptor.condition2 as Record<string, unknown> | undefined;
    const condList = conditions ?? [c1, c2].filter(Boolean) as Record<string, unknown>[];

    const encodedConds = condList
      .map(c => encodeCondition(ft, c))
      .filter(Boolean);
    if (encodedConds.length === 0) return null;
    return `${ft}${PART_SEP}${op}${PART_SEP}${encodedConds.join(COND_SEP)}`;
  }

  // Single condition
  const cond = encodeCondition(ft, descriptor);
  if (!cond) return null;
  return `${ft}${PART_SEP}${cond}`;
}

// ---------------------------------------------------------------------------
// Decode a single column's compact string → filter descriptor
// ---------------------------------------------------------------------------

function decodeConditionParts(
  ft: string,
  parts: string[],
): Record<string, unknown> | null {
  // parts = [operator, value?, valueTo?]
  if (parts.length === 0) return null;
  const tp = SHORT_TO_OP[parts[0]] ?? parts[0];
  const fullFt = SHORT_TO_FT[ft] ?? ft;

  if (tp === 'blank' || tp === 'notBlank') {
    return { filterType: fullFt, type: tp };
  }

  const val = parts.length > 1 ? unescapeValue(parts[1]) : '';
  const valTo = parts.length > 2 ? unescapeValue(parts[2]) : undefined;

  const result: Record<string, unknown> = { filterType: fullFt, type: tp };
  if (fullFt === 'date') {
    result.dateFrom = val;
    if (valTo) result.dateTo = valTo;
  } else if (fullFt === 'number') {
    result.filter = val === '' ? null : Number(val);
    if (valTo) result.filterTo = Number(valTo);
  } else {
    result.filter = val;
  }
  return result;
}

function decodeColumnFilter(encoded: string): Record<string, unknown> | null {
  const parts = encoded.split(PART_SEP);
  if (parts.length < 1) return null;

  const ft = parts[0]; // short filter type: T, N, D, S
  const fullFt = SHORT_TO_FT[ft] ?? ft;

  // Set filter: S~val1,val2
  if (ft === 'S') {
    const values = parts.length > 1
      ? parts[1].split(SET_SEP).map(unescapeValue)
      : [];
    return { filterType: 'set', values };
  }

  // Compound filter: T~&~cn~hello!eq~world
  if (parts.length >= 3 && (parts[1] === '&' || parts[1] === '|')) {
    const op = SHORT_TO_COMPOUND[parts[1]] ?? parts[1];
    // Everything after the operator is condition data, joined back and split by COND_SEP
    const condStr = parts.slice(2).join(PART_SEP);
    const condChunks = condStr.split(COND_SEP);
    const conditions: Record<string, unknown>[] = [];
    for (const chunk of condChunks) {
      const condParts = chunk.split(PART_SEP);
      const cond = decodeConditionParts(ft, condParts);
      if (cond) {
        // Remove filterType from individual conditions (it's on the parent)
        delete cond.filterType;
        conditions.push(cond);
      }
    }
    return { filterType: fullFt, operator: op, conditions };
  }

  // Single condition: T~cn~hello  or  N~ir~100~200
  const cond = decodeConditionParts(ft, parts.slice(1));
  return cond;
}

// ---------------------------------------------------------------------------
// Legacy base64 format support (for old bookmarked URLs)
// ---------------------------------------------------------------------------

function toUrlBase64(text: string): string {
  return btoa(unescape(encodeURIComponent(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromUrlBase64(encoded: string): string {
  let base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) base64 += '=';
  return decodeURIComponent(escape(atob(base64)));
}

/** Detect legacy base64-encoded JSON format. */
function isLegacyBase64(encoded: string): boolean {
  // base64 of '{"' starts with 'ey', or old prefixed formats
  return encoded.startsWith('ey') || encoded.startsWith('c.') || encoded.startsWith('p.');
}

function decodeLegacyBase64(encoded: string): Record<string, unknown> | null {
  try {
    const payload = encoded.startsWith('c.') || encoded.startsWith('p.')
      ? encoded.slice(2)
      : encoded;
    const json = fromUrlBase64(payload);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public: Filter model encode / decode
// ---------------------------------------------------------------------------

export function encodeFilterModel(
  model: Record<string, unknown> | null,
): string | null {
  if (!model || Object.keys(model).length === 0) return null;
  try {
    const segments: string[] = [];
    for (const [col, descriptor] of Object.entries(model)) {
      if (!descriptor || typeof descriptor !== 'object') continue;
      const encoded = encodeColumnFilter(descriptor as Record<string, unknown>);
      if (encoded === null) {
        // Fallback: base64 the whole model if any column can't be compactly encoded
        const json = JSON.stringify(model);
        const b64 = toUrlBase64(json);
        return b64.length <= MAX_FILTER_PARAM_LENGTH ? b64 : null;
      }
      segments.push(`${escapeValue(col)}${PART_SEP}${encoded}`);
    }
    const result = segments.join(COL_SEP);
    if (result.length > MAX_FILTER_PARAM_LENGTH) return null;
    return result;
  } catch {
    return null;
  }
}

export function decodeFilterModel(
  encoded: string,
): Record<string, unknown> | null {
  if (!encoded) return null;
  try {
    // Legacy base64 format
    if (isLegacyBase64(encoded)) {
      return decodeLegacyBase64(encoded);
    }
    // Compact text format
    const result: Record<string, unknown> = {};
    const columns = encoded.split(COL_SEP);
    for (const colStr of columns) {
      if (!colStr) continue;
      const firstSep = colStr.indexOf(PART_SEP);
      if (firstSep < 1) continue;
      const colName = unescapeValue(colStr.slice(0, firstSep));
      const filterStr = colStr.slice(firstSep + 1);
      const descriptor = decodeColumnFilter(filterStr);
      if (descriptor) result[colName] = descriptor;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sort model
// ---------------------------------------------------------------------------

type SortEntry = { colId: string; sort: 'asc' | 'desc' };

export function encodeSortModel(model: SortEntry[] | null): string | null {
  if (!model || model.length === 0) return null;
  return model.map((e) => `${e.colId}:${e.sort}`).join(',');
}

export function decodeSortModel(encoded: string): SortEntry[] | null {
  if (!encoded) return null;
  try {
    const entries: SortEntry[] = [];
    for (const part of encoded.split(',')) {
      const idx = part.lastIndexOf(':');
      if (idx < 1) continue;
      const colId = part.slice(0, idx);
      const sort = part.slice(idx + 1);
      if (sort !== 'asc' && sort !== 'desc') continue;
      entries.push({ colId, sort });
    }
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// URL assembly / parsing
// ---------------------------------------------------------------------------

function paramKey(base: string, namespace?: string): string {
  return namespace ? `${base}_${namespace}` : base;
}

export function hasGridStateInUrl(
  search: string,
  namespace?: string,
): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(search);
  return (
    params.has(paramKey('f', namespace)) ||
    params.has(paramKey('s', namespace)) ||
    params.has(paramKey('q', namespace))
  );
}

export function parseGridSearchParams(
  search: string,
  namespace?: string,
): {
  filterModel: Record<string, unknown> | null;
  sortModel: SortEntry[] | null;
  quickSearch: string | null;
} {
  const params = new URLSearchParams(search);
  const fKey = paramKey('f', namespace);
  const sKey = paramKey('s', namespace);
  const qKey = paramKey('q', namespace);

  const filterModel = params.has(fKey)
    ? decodeFilterModel(params.get(fKey)!)
    : null;
  const sortModel = params.has(sKey)
    ? decodeSortModel(params.get(sKey)!)
    : null;
  const quickSearch = params.has(qKey)
    ? (params.get(qKey) ?? null)
    : null;

  return { filterModel, sortModel, quickSearch };
}

export function writeGridStateToUrl(
  state: {
    filterModel?: Record<string, unknown> | null;
    sortModel?: SortEntry[] | null;
    quickSearch?: string | null;
  },
  namespace?: string,
): void {
  if (typeof window === 'undefined') return;

  const url = new URL(window.location.href);
  const fKey = paramKey('f', namespace);
  const sKey = paramKey('s', namespace);
  const qKey = paramKey('q', namespace);

  url.searchParams.delete(fKey);
  url.searchParams.delete(sKey);
  url.searchParams.delete(qKey);

  if (state.filterModel !== undefined) {
    const encoded = encodeFilterModel(state.filterModel);
    if (encoded) url.searchParams.set(fKey, encoded);
  }

  if (state.sortModel !== undefined) {
    const encoded = encodeSortModel(state.sortModel);
    if (encoded) url.searchParams.set(sKey, encoded);
  }

  if (state.quickSearch !== undefined && state.quickSearch && state.quickSearch.trim()) {
    url.searchParams.set(qKey, state.quickSearch.trim());
  }

  window.history.replaceState(window.history.state, '', url.toString());
}
