import type {
  CellValueChangedEvent,
  DefaultMenuItem,
  GridApi,
  MenuItemDef,
  ValueFormatterParams,
  ValueGetterParams,
} from 'ag-grid-community';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment } from '../../../lib/offerProductRows';
import { priceListStatusClassRules } from '../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../lib/localeNumber';
import type { RequestedProductMatchEntry } from './products/MatchRequestedProductsModal';

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const decimalFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const DEFAULT_ROW_HEIGHT = 32;
export const MAX_CATEGORY_DEPTH = 3;
export const ADD_WEBLINK_MAX_PRODUCTS = 200;
export const ENHANCE_DESC_MAX_PRODUCTS = 200;

const COLLAPSED_CATEGORIES_COOKIE_NAME = 'offer_products_collapsed';

export function readCollapsedCategoryPathsFromCookie(offerId: string): Set<string> {
  if (typeof document === 'undefined' || !offerId) return new Set();
  try {
    const raw = document.cookie
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COLLAPSED_CATEGORIES_COOKIE_NAME}=`));
    if (!raw) return new Set();
    const value = raw.slice(COLLAPSED_CATEGORIES_COOKIE_NAME.length + 1).trim();
    const decoded = value ? decodeURIComponent(value) : '';
    const parsed = JSON.parse(decoded) as Record<string, string[] | undefined>;
    const paths = parsed[offerId];
    return Array.isArray(paths) ? new Set(paths) : new Set();
  } catch {
    return new Set();
  }
}

type FuzzyTextCondition = {
  filterType: 'text';
  type: 'contains';
  filter: string;
  // Optional relevance-score multiplier.  Server multiplies this into the
  // base weight (filter-value length) when ranking.  Left undefined for
  // conditions that should use the default (1x).
  weight?: number;
};
type FuzzyCompoundTextFilter = {
  filterType: 'text';
  operator: 'OR';
  conditions: FuzzyTextCondition[];
};
export type FuzzyTextFilter = FuzzyTextCondition | FuzzyCompoundTextFilter;

export type FuzzyMode = 'partNumber' | 'description' | 'brand';

// Static synonym dictionary — short, high-confidence equivalences consulted
// automatically during filter building.  Keys are lowercased & stripped of
// punctuation; values are display forms that will be used in LIKE clauses.
// Matches are bidirectional: looking up any one of ["hp", "hewlettpackard"]
// returns every other form in the same group.
const SYNONYM_GROUPS: string[][] = [
  ['hp', 'hewlett packard', 'hewlett-packard'],
  ['ibm', 'international business machines'],
  ['ge', 'general electric'],
  ['jvc', 'victor company of japan'],
  ['lg', 'lg electronics', 'lucky goldstar'],
  ['db', 'd&b', 'd&b audiotechnik'],
  ['cat5', 'cat 5', 'category 5'],
  ['cat5e', 'cat 5e', 'category 5e'],
  ['cat6', 'cat 6', 'category 6'],
  ['cat6a', 'cat 6a', 'category 6a'],
  ['cat7', 'cat 7', 'category 7'],
  ['cat8', 'cat 8', 'category 8'],
  ['sftp', 's/ftp', 's-ftp', 'shielded'],
  ['utp', 'u/utp', 'unshielded'],
  ['ftp', 'f/utp', 'foiled'],
  ['usb-c', 'usbc', 'type-c', 'typec'],
  ['usb-a', 'usba', 'type-a', 'typea'],
  ['usb-b', 'usbb', 'type-b', 'typeb'],
  ['rj45', 'rj-45', '8p8c'],
  ['rj11', 'rj-11'],
  ['hdmi', 'high definition multimedia interface'],
  ['vga', 'video graphics array', 'd-sub'],
  ['dp', 'displayport', 'display port'],
  ['dvi', 'digital visual interface'],
  ['ethernet', 'lan', 'network cable', 'patch cord', 'patch cable'],
  ['ssd', 'solid state drive'],
  ['hdd', 'hard disk drive', 'hard drive'],
  ['nvme', 'm.2 nvme'],
  ['psu', 'power supply'],
  ['ups', 'uninterruptible power supply'],
  ['kvm', 'keyboard video mouse'],
  ['poe', 'power over ethernet'],
  ['wifi', 'wi-fi', 'wireless'],
  ['tv', 'television'],
  ['monitor', 'display', 'screen'],
  ['pc', 'desktop', 'computer'],
  ['laptop', 'notebook'],
  ['inch', 'inches', '"', "''"],
];

const normalizeSynonymKey = (value: string): string =>
  value.toLowerCase().replace(/[\s\-_.]+/g, '');

const SYNONYM_LOOKUP: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    const normalizedGroup = group.map((term) => ({ term, key: normalizeSynonymKey(term) }));
    for (const { key } of normalizedGroup) {
      if (!key) continue;
      const existing = map.get(key) ?? [];
      for (const { term } of normalizedGroup) {
        if (!existing.includes(term)) existing.push(term);
      }
      map.set(key, existing);
    }
  }
  return map;
})();

export function expandWithSynonyms(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    const up = t.toUpperCase();
    if (seen.has(up)) return;
    seen.add(up);
    out.push(t);
  };
  tokens.forEach((token) => {
    push(token);
    const synonyms = SYNONYM_LOOKUP.get(normalizeSynonymKey(token));
    if (synonyms) synonyms.forEach(push);
  });
  return out;
}

const UNKNOWN_BRAND_MARKERS = new Set([
  'idk',
  'unknown',
  'n/a',
  'na',
  'none',
  'tbd',
  '?',
  '??',
  '-',
  '--',
  'any',
  'various',
]);

export function isUnknownBrand(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[.\s]+/g, '');
  return UNKNOWN_BRAND_MARKERS.has(normalized)
    || UNKNOWN_BRAND_MARKERS.has(value.trim().toLowerCase());
}

// Split a brand value on multi-brand separators so "Apple/Samsung" or
// "Apple, Samsung" or "Apple or Samsung" each become two tokens OR'd together.
export function tokenizeBrand(value: string): string[] {
  const withSpaceSeparators = value
    .replace(/\s+(?:or|and|\/|&|\+)\s+/gi, '|')
    .replace(/[/\\,;|&+]+/g, '|');
  return withSpaceSeparators
    .split('|')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// Split a requested part/model number into meaningful tokens so that noise
// prefixes like "VX 5308813" still match a product whose actual part number
// is "5308813".  Prefer tokens containing digits (typically the real number);
// otherwise fall back to all tokens of length >= 3.
export function tokenizePartModelNumber(value: string): string[] {
  const parts = value
    .split(/[\s,;|/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (parts.length <= 1) return parts;
  const withDigits = parts.filter((p) => /\d/.test(p));
  if (withDigits.length > 0) return withDigits;
  return parts.filter((p) => p.length >= 3);
}

// Split a description into word-level tokens so that each meaningful word
// is OR'd independently.  Threshold >= 3 keeps short-but-meaningful words
// (LG, TV, USB, HP, CAT, VGA); the occasional 3-char false positive
// (indi[cat]or matching "cat") is tolerated because the length-weighted
// relevance score buries low-weight hits at the bottom.  Additionally,
// emit adjacent letter↔digit pair joins ("Cat 7" → "Cat7", "RJ 45" → "RJ45")
// so products written without the space still match.
export function tokenizeDescription(value: string): string[] {
  const words = value
    .split(/[\s,;|/()[\]"'.!?:=<>+*]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  const tokens = words.filter((t) => t.length >= 3);
  for (let i = 0; i < words.length - 1; i += 1) {
    const a = words[i];
    const b = words[i + 1];
    const hasLetterThenDigit = /[A-Za-z]/.test(a) && /^\d+$/.test(b);
    const hasDigitThenLetter = /^\d+$/.test(a) && /[A-Za-z]/.test(b);
    if (hasLetterThenDigit || hasDigitThenLetter) {
      const joined = a + b;
      if (joined.length >= 3) tokens.push(joined);
    }
  }
  return tokens;
}

// Build a combined fuzzy filter from multiple source strings (e.g. requested
// descriptions 1/2/3 on a single line).  Each source contributes its raw
// phrase AND its tokens; duplicates across sources are dropped.  The result
// is a single compound-OR filter that the grid applies to one column —
// unlike picking just the shortest description, every unique word from every
// description is available for matching and scoring.
// Priority weights applied to sources by array position (desc1 > desc2 > desc3).
// Winners keep their stronger match boost even when later descriptions contain
// longer strings.
const DEFAULT_PRIORITY_WEIGHTS = [3, 2, 1];

export function buildMultiFuzzyContainsFilter(
  values: Array<string | null | undefined>,
  options?: { mode?: FuzzyMode | null; priorityWeights?: number[] },
): FuzzyTextFilter | null {
  const mode = options?.mode ?? null;
  const priorityWeights = options?.priorityWeights ?? DEFAULT_PRIORITY_WEIGHTS;
  // Preserve each source's original index so we can look up its priority weight
  // even after empties are dropped.
  const trimmedSources = values
    .map((v, idx) => ({ value: typeof v === 'string' ? v.trim() : '', idx }))
    .filter((entry) => entry.value.length > 0);
  if (trimmedSources.length === 0) return null;
  if (trimmedSources.length === 1) return buildFuzzyContainsFilter(trimmedSources[0].value, options);

  const weightFor = (sourceIdx: number): number =>
    priorityWeights[sourceIdx] ?? priorityWeights[priorityWeights.length - 1] ?? 1;

  // No fuzzy mode requested — build a plain OR of the raw phrases, priority-weighted.
  if (!mode) {
    const seen = new Map<string, FuzzyTextCondition>();
    trimmedSources.forEach((src) => {
      const key = src.value.toUpperCase();
      const w = weightFor(src.idx);
      const existing = seen.get(key);
      if (existing) {
        if ((existing.weight ?? 1) < w) existing.weight = w;
        return;
      }
      seen.set(key, { filterType: 'text', type: 'contains', filter: src.value, weight: w });
    });
    const conditions = Array.from(seen.values());
    if (conditions.length === 1) return conditions[0];
    return { filterType: 'text', operator: 'OR', conditions };
  }

  if (mode === 'brand') {
    const anyUnknown = trimmedSources.every((s) => isUnknownBrand(s.value));
    if (anyUnknown) return null;
  }

  // Dedupe across sources, but track the HIGHEST priority weight per token
  // so a phrase that appears in both desc1 and desc3 keeps the desc1 boost.
  const weighted = new Map<string, { value: string; weight: number }>();
  const push = (t: string, w: number) => {
    const key = t.toUpperCase();
    const existing = weighted.get(key);
    if (existing) {
      if (existing.weight < w) existing.weight = w;
      return;
    }
    weighted.set(key, { value: t, weight: w });
  };
  trimmedSources.forEach((src) => {
    if (mode === 'brand' && isUnknownBrand(src.value)) return;
    const w = weightFor(src.idx);
    const tokens =
      mode === 'partNumber' ? tokenizePartModelNumber(src.value)
      : mode === 'description' ? tokenizeDescription(src.value)
      : tokenizeBrand(src.value);
    const expanded = expandWithSynonyms(tokens);
    // For brand mode, don't include the raw multi-brand string — see the
    // single-value builder below for the rationale.
    if (!(mode === 'brand' && expanded.length > 1)) push(src.value, w);
    expanded.forEach((t) => push(t, w));
  });
  if (weighted.size === 0) return null;
  const all = Array.from(weighted.values());
  if (all.length === 1) {
    return { filterType: 'text', type: 'contains', filter: all[0].value, weight: all[0].weight };
  }
  return {
    filterType: 'text',
    operator: 'OR',
    conditions: all.map((w) => ({ filterType: 'text', type: 'contains', filter: w.value, weight: w.weight })),
  };
}

export function buildFuzzyContainsFilter(
  value: string | null | undefined,
  options?: { mode?: FuzzyMode | null },
): FuzzyTextFilter | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  const mode = options?.mode ?? null;
  if (!mode) return { filterType: 'text', type: 'contains', filter: trimmed };
  if (mode === 'brand' && isUnknownBrand(trimmed)) return null;
  let tokens: string[];
  if (mode === 'partNumber') tokens = tokenizePartModelNumber(trimmed);
  else if (mode === 'description') tokens = tokenizeDescription(trimmed);
  else tokens = tokenizeBrand(trimmed);
  // Expand tokens with static synonyms/abbreviations (e.g. HP ↔ Hewlett Packard,
  // Cat6 ↔ Category 6, TV ↔ television).  Applied for all modes: brand synonyms
  // cover manufacturer abbreviations, description and part modes cover technical
  // shorthand that shows up in both fields.
  tokens = expandWithSynonyms(tokens);
  // For brand mode, when multiple tokens survive the separator split we only
  // want the tokens themselves — NOT the raw multi-brand string (which would
  // never match a single-brand product row).
  const baseValues = mode === 'brand' && tokens.length > 1 ? tokens : [trimmed, ...tokens];
  const seen = new Set<string>();
  const values: string[] = [];
  baseValues.forEach((t) => {
    const up = t.toUpperCase();
    if (seen.has(up)) return;
    seen.add(up);
    values.push(t);
  });
  if (values.length <= 1) {
    return { filterType: 'text', type: 'contains', filter: values[0] ?? trimmed };
  }
  return {
    filterType: 'text',
    operator: 'OR',
    conditions: values.map((t) => ({ filterType: 'text', type: 'contains', filter: t })),
  };
}

export type FilterExpansions = {
  brand?: string[];
  partNumber?: string[];
  modelNumber?: string[];
  description?: string[];
};

// Merge AI-supplied expansion tokens into an existing filter model as extra
// OR conditions.  Existing conditions are preserved; tokens that duplicate
// something already present (case-insensitive) are skipped.
export function mergeExpansionsIntoFilterModel(
  currentModel: Record<string, FuzzyTextFilter> | null,
  expansions: FilterExpansions,
): Record<string, FuzzyTextFilter> {
  const out: Record<string, FuzzyTextFilter> = { ...(currentModel ?? {}) };
  const apply = (colId: string, tokens: string[] | undefined) => {
    if (!tokens || tokens.length === 0) return;
    const cleaned = tokens.map((t) => t.trim()).filter((t) => t.length > 0);
    if (cleaned.length === 0) return;
    const existing = out[colId] ?? null;
    const existingValues: string[] = [];
    if (existing) {
      if ('conditions' in existing) {
        existing.conditions.forEach((c) => { if (c.filter) existingValues.push(c.filter); });
      } else if (existing.filter) {
        existingValues.push(existing.filter);
      }
    }
    const seen = new Set(existingValues.map((v) => v.toUpperCase()));
    const merged = [...existingValues];
    cleaned.forEach((t) => {
      const key = t.toUpperCase();
      if (seen.has(key)) return;
      seen.add(key);
      merged.push(t);
    });
    if (merged.length === 1) {
      out[colId] = { filterType: 'text', type: 'contains', filter: merged[0] };
    } else {
      out[colId] = {
        filterType: 'text',
        operator: 'OR',
        conditions: merged.map((t) => ({ filterType: 'text', type: 'contains', filter: t })),
      };
    }
  };
  apply('BrandName', expansions.brand);
  apply('PartNumber', expansions.partNumber);
  apply('ModelNumber', expansions.modelNumber);
  apply('Description', expansions.description);
  return out;
}

export function writeCollapsedCategoryPathsToCookie(offerId: string, paths: Set<string>): void {
  if (typeof document === 'undefined' || !offerId) return;
  try {
    let all: Record<string, string[]> = {};
    const existing = document.cookie
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COLLAPSED_CATEGORIES_COOKIE_NAME}=`));
    if (existing) {
      const value = existing.slice(COLLAPSED_CATEGORIES_COOKIE_NAME.length + 1).trim();
      const decoded = value ? decodeURIComponent(value) : '{}';
      all = JSON.parse(decoded) as Record<string, string[]>;
    }
    if (paths.size === 0) {
      delete all[offerId];
    } else {
      all[offerId] = Array.from(paths);
    }
    const encoded = encodeURIComponent(JSON.stringify(all));
    const maxAge = 60 * 60 * 24 * 365; // 1 year
    document.cookie = `${COLLAPSED_CATEGORIES_COOKIE_NAME}=${encoded}; path=/; max-age=${maxAge}; SameSite=Lax`;
  } catch {
    // ignore
  }
}

export const plainNumberFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export const parseFlexibleNumber = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const numericPortion = trimmed.replace(/[^\d.,+-]/g, '');
  if (!numericPortion) return null;

  const commaCount = (numericPortion.match(/,/g) ?? []).length;
  const dotCount = (numericPortion.match(/\./g) ?? []).length;

  let normalized = numericPortion;
  if (commaCount > 0 && dotCount > 0) {
    const lastComma = numericPortion.lastIndexOf(',');
    const lastDot = numericPortion.lastIndexOf('.');
    if (lastComma > lastDot) {
      normalized = numericPortion.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = numericPortion.replace(/,/g, '');
    }
  } else if (commaCount > 0) {
    normalized = numericPortion.replace(/,/g, '.');
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

export const coerceNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    return parseFlexibleNumber(value);
  }
  return null;
};

export const formatPercentageValue = (value: unknown) => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  return `${decimalFormatter.format(num)} %`;
};

export const formatCurrencyValue = (value: unknown, symbol = '€') => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  const formatted = decimalFormatter.format(num);
  return symbol === '$' ? `${symbol} ${formatted}` : `${formatted} ${symbol}`;
};

export const formatEuroValue = (value: unknown) => formatCurrencyValue(value, '€');

type FormatterParams = ValueFormatterParams<Record<string, unknown>, unknown>;
export const percentageFormatter = ({ value }: FormatterParams) => formatPercentageValue(value);
export const euroFormatter = ({ value }: FormatterParams) => formatEuroValue(value);
export const buildCurrencyFormatter = (symbol: string) =>
  ({ value }: FormatterParams) => formatCurrencyValue(value, symbol);
export const zeroBlankNumberFormatter = ({ value }: FormatterParams) => {
  const num = coerceNumber(value);
  if (num == null) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
  }
  if (Object.is(num, 0)) return '';
  return plainNumberFormatter.format(num);
};

export type RequestedFieldKey =
  | 'RequestedItemNo'
  | 'RequestedBrand'
  | 'RequestedPartNo'
  | 'RequestedModelNo'
  | 'RequestedWebLink'
  | 'RequestedDescription'
  | 'RequestedDescription2'
  | 'RequestedDescription3'
  | 'RequestedQuantity';

export type RequestedDisplayFieldKey = Exclude<RequestedFieldKey, 'RequestedItemNo'>;
export const REQUESTED_DISPLAY_FIELD_KEYS: RequestedDisplayFieldKey[] = [
  'RequestedBrand',
  'RequestedPartNo',
  'RequestedModelNo',
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
  'RequestedQuantity',
];

export const REQUESTED_FIELD_LABELS: Record<RequestedFieldKey, string> = {
  RequestedItemNo: 'requested item number',
  RequestedBrand: 'requested brand',
  RequestedPartNo: 'requested part number',
  RequestedModelNo: 'requested model number',
  RequestedWebLink: 'requested web link',
  RequestedDescription: 'requested description',
  RequestedDescription2: 'requested description 2',
  RequestedDescription3: 'requested description 3',
  RequestedQuantity: 'requested quantity',
};

export const REQUESTED_FIELD_SET = new Set<RequestedFieldKey>([
  'RequestedItemNo',
  'RequestedBrand',
  'RequestedPartNo',
  'RequestedModelNo',
  'RequestedWebLink',
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
  'RequestedQuantity',
]);

export const isRequestedFieldKey = (value: string | null | undefined): value is RequestedFieldKey =>
  typeof value === 'string' && REQUESTED_FIELD_SET.has(value as RequestedFieldKey);

export const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export const compareTreeOrderingValues = (a: unknown, b: unknown) => {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa && !sb) return 0;  // both empty/null
  if (!sa) return -1;        // empty/null first
  if (!sb) return 1;
  return collator.compare(sa, sb);
};

export const parseTreeOrderingPath = (value: unknown): number[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
};

export const buildTreeOrderingKey = (segments: number[]) => segments.join('.');

export function computeDisplayOrderingMap(rows: Record<string, unknown>[]): Map<string, string> {
  const sorted = rows
    .filter((row): row is Record<string, unknown> => row != null && row.TreeOrdering != null)
    .sort((a, b) => compareTreeOrderingValues(a.TreeOrdering, b.TreeOrdering));

  const result = new Map<string, string>();

  for (const row of sorted) {
    const actualKey = String(row.TreeOrdering ?? '').trim();
    if (!actualKey) continue;
    const path = parseTreeOrderingPath(actualKey);
    if (path.length === 0) continue;

    if (resolveOfferProductRowType(row) === 'non-printable-comment') continue;

    const lastSegment = path[path.length - 1];
    const actualParentKey = path.slice(0, -1).join('.');
    const parentDisplayKey = path.length === 1 ? '' : (result.get(actualParentKey) ?? actualParentKey);
    const displayKey = parentDisplayKey ? `${parentDisplayKey}.${lastSegment}` : String(lastSegment);
    result.set(actualKey, displayKey);
  }

  return result;
}

export const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export const resolveRowLabel = (row: Record<string, unknown> | null | undefined, fallback: string) => {
  if (!row) return fallback;
  const partNumberRaw = (row as { PartNumber?: unknown }).PartNumber;
  const descriptionRaw = (row as { Description?: unknown }).Description;
  const brandRaw = (row as { BrandName?: unknown }).BrandName;
  const normalize = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const partNumber = normalize(partNumberRaw);
  const description = normalize(descriptionRaw);
  if (partNumber && description) return `${partNumber} – ${description}`;
  if (partNumber) return partNumber;
  if (description) return description;
  const brand = normalize(brandRaw);
  return brand || fallback;
};

export const resolveOfferProductTypeLabel = (row: Record<string, unknown> | null | undefined) => {
  const rowType = resolveOfferProductRowType(row);
  if (rowType === 'category') return 'category';
  if (rowType === 'product') return 'product';
  if (rowType === 'printable-comment' || rowType === 'non-printable-comment') return 'comment';
  return 'record';
};

export const isRequestedRow = (row: Record<string, unknown> | null | undefined) =>
  Boolean((row as { __isRequestedRow?: number | null })?.__isRequestedRow === 1);

export const hasAssignedProductId = (row: Record<string, unknown> | null | undefined): boolean => {
  const raw = (row as { ProductID?: unknown } | null | undefined)?.ProductID;
  if (raw == null) return false;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0;
  if (typeof raw === 'string') return raw.trim().length > 0;
  return false;
};

// Requested-only row that hasn't been matched to a real product yet.
// Editing actual product columns (Description, prices, qty, ...) on these
// rows is misleading because there is no product behind the cell.
export const isUnassignedRequestedRow = (row: Record<string, unknown> | null | undefined): boolean =>
  isRequestedRow(row) && !hasAssignedProductId(row);

export const isRequestedDescriptionField = (field: string | null | undefined): field is 'RequestedDescription' | 'RequestedDescription2' | 'RequestedDescription3' =>
  field === 'RequestedDescription' || field === 'RequestedDescription2' || field === 'RequestedDescription3';

export const canEditRequestedField = (field: RequestedFieldKey, row: Record<string, unknown> | null | undefined) => {
  if (isRequestedRow(row)) return true;
  if (isRequestedDescriptionField(field) && isOfferProductCategory(row)) {
    return true;
  }
  return false;
};

export const normalizeDescriptionValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const REQUESTED_DESCRIPTION_FIELD_KEYS = [
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
] as const;
export type RequestedDescriptionFieldKey = (typeof REQUESTED_DESCRIPTION_FIELD_KEYS)[number];

export const getNormalizedRequestedDescriptionValues = (row: Record<string, unknown> | null | undefined): string[] => {
  if (!row || typeof row !== 'object') return [];
  const values: string[] = [];
  REQUESTED_DESCRIPTION_FIELD_KEYS.forEach((key) => {
    const normalized = normalizeDescriptionValue((row as Record<RequestedDescriptionFieldKey, unknown>)[key] ?? null);
    if (normalized != null) {
      values.push(normalized);
    }
  });
  return values;
};

export const normalizeRequestedItemNoValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const REQUESTED_HISTORY_LOOKUP_ENDPOINT = '/api/products/resolve';
export const requestedHistoryLookupCache = new Map<string, number | null>();

export const normalizeRequestedLookupValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const getExactTextValue = (value: unknown): string | null => {
  if (value == null) return null;
  return typeof value === 'string' ? value : String(value);
};

export const normalizeRequestedQuantityValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
};

export const sanitizeDetailValue = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const buildRequestedProductMatchEntry = (
  data: Record<string, unknown>,
  offerDetailId: number,
): RequestedProductMatchEntry => {
  const requestedBrand = normalizeRequestedLookupValue(
    (data as { RequestedBrand?: unknown }).RequestedBrand ?? null,
  );
  const requestedModel = normalizeRequestedLookupValue(
    (data as { RequestedModelNo?: unknown }).RequestedModelNo ?? null,
  );
  const requestedPart = normalizeRequestedLookupValue(
    (data as { RequestedPartNo?: unknown }).RequestedPartNo ?? null,
  );
  const requestedWebLink = normalizeRequestedLookupValue(
    (data as { RequestedWebLink?: unknown }).RequestedWebLink ?? null,
  );
  const requestedDescription = normalizeDescriptionValue(
    (data as { RequestedDescription?: unknown }).RequestedDescription ?? null,
  );
  const requestedDescription2 = normalizeDescriptionValue(
    (data as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
  );
  const requestedDescription3 = normalizeDescriptionValue(
    (data as { RequestedDescription3?: unknown }).RequestedDescription3 ?? null,
  );
  const requestedItemNo = normalizeRequestedItemNoValue(
    (data as { RequestedItemNo?: unknown }).RequestedItemNo ?? null,
  );
  const treeOrderingRaw = (data as { TreeOrdering?: unknown }).TreeOrdering;
  const treeOrdering = typeof treeOrderingRaw === 'string' && treeOrderingRaw.trim()
    ? treeOrderingRaw.trim()
    : null;
  const labelCandidates = [
    requestedDescription,
    requestedDescription2,
    requestedDescription3,
    requestedPart,
    requestedModel,
    requestedBrand,
    requestedItemNo,
    treeOrdering,
  ];
  const label = labelCandidates.find((item) => typeof item === 'string' && item.trim()) ?? 'Requested item';
  const parentCategoryId = normalizeOfferDetailId(
    (data as { ParentOfferDetailID?: unknown }).ParentOfferDetailID ?? null,
  );
  const detailEntries: Array<{ label: string; value: string }> = [];
  const addDetail = (detailLabel: string, detailValue: string | null | undefined) => {
    const sanitized = sanitizeDetailValue(detailValue);
    if (sanitized) {
      detailEntries.push({ label: detailLabel, value: sanitized });
    }
  };
  addDetail('Brand', requestedBrand);
  addDetail('Model', requestedModel);
  addDetail('Part number', requestedPart);
  addDetail('Web link', requestedWebLink);
  addDetail('Requested item number', requestedItemNo);
  addDetail('Tree ordering', treeOrdering);
  addDetail('Requested description', requestedDescription);
  addDetail('Requested description 2', requestedDescription2);
  addDetail('Requested description 3', requestedDescription3);
  return {
    offerDetailId,
    parentCategoryId,
    label,
    quantity: normalizeRequestedQuantityValue(
      (data as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
    ),
    details: detailEntries,
    requestedBrand,
    requestedModelNumber: requestedModel,
    requestedPartNumber: requestedPart,
    requestedWebLink,
    requestedDescription,
    requestedDescription2,
    requestedDescription3,
  };
};

export const hasRequestedLookupIdentifiers = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  const part = normalizeRequestedLookupValue((row as { RequestedPartNo?: unknown }).RequestedPartNo ?? null);
  const model = normalizeRequestedLookupValue((row as { RequestedModelNo?: unknown }).RequestedModelNo ?? null);
  const brand = normalizeRequestedLookupValue((row as { RequestedBrand?: unknown }).RequestedBrand ?? null);
  const webLink = normalizeRequestedLookupValue((row as { RequestedWebLink?: unknown }).RequestedWebLink ?? null);
  return Boolean(part || model || brand || webLink);
};

export const hasRequestedRowData = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  if (hasRequestedLookupIdentifiers(row)) return true;
  const quantity = normalizeRequestedQuantityValue(
    (row as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
  );
  if (quantity != null && !Object.is(quantity, 0)) return true;
  const actualQuantity = coerceNumber((row as { Quantity?: unknown }).Quantity ?? null);
  if (actualQuantity != null && !Object.is(actualQuantity, 0)) return true;
  return false;
};

export const hasRequestedPseudoFields = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  return hasRequestedRowData(row);
};

export type RequestedLookupInfo = {
  partNumber: string | null;
  modelNumber: string | null;
  brand: string | null;
};

export const buildRequestedLookupInfo = (row: Record<string, unknown> | null | undefined): RequestedLookupInfo => {
  if (!row || typeof row !== 'object') {
    return { partNumber: null, modelNumber: null, brand: null };
  }
  const requestedPart = normalizeRequestedLookupValue((row as { RequestedPartNo?: unknown }).RequestedPartNo ?? (row as { PartNumber?: unknown }).PartNumber);
  const requestedModel = normalizeRequestedLookupValue((row as { RequestedModelNo?: unknown }).RequestedModelNo ?? (row as { ModelNumber?: unknown }).ModelNumber);
  const requestedBrand = normalizeRequestedLookupValue((row as { RequestedBrand?: unknown }).RequestedBrand ?? (row as { BrandName?: unknown }).BrandName);
  return {
    partNumber: requestedPart,
    modelNumber: requestedModel,
    brand: requestedBrand,
  };
};

export const resolveProductIdFromRequestedInfo = async (info: RequestedLookupInfo): Promise<number | null> => {
  const { partNumber, modelNumber, brand } = info;
  if (!partNumber && !modelNumber) return null;
  const normalizedBrand = brand
    ? brand.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim()
    : null;
  const brandKey = normalizedBrand
    ? normalizedBrand.replace(/\s+/g, '').toLowerCase()
    : null;
  const params = new URLSearchParams();
  if (partNumber) params.set('partNumber', partNumber);
  if (modelNumber) params.set('modelNumber', modelNumber);
  if (normalizedBrand) params.set('brand', normalizedBrand);
  const cacheKey = `${partNumber ?? ''}|${modelNumber ?? ''}|${brandKey ?? ''}`;
  if (requestedHistoryLookupCache.has(cacheKey)) {
    return requestedHistoryLookupCache.get(cacheKey) ?? null;
  }
  try {
    const response = await fetch(`${REQUESTED_HISTORY_LOOKUP_ENDPOINT}?${params.toString()}`);
    if (!response.ok) {
      requestedHistoryLookupCache.set(cacheKey, null);
      return null;
    }
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; productId?: number | null } | null;
    const productId =
      payload?.ok && typeof payload.productId === 'number' && Number.isInteger(payload.productId)
        ? payload.productId
        : null;
    requestedHistoryLookupCache.set(cacheKey, productId);
    return productId;
  } catch (err) {
    console.error('Failed to resolve product for requested row', err);
    requestedHistoryLookupCache.set(cacheKey, null);
    return null;
  }
};

export type ProductSummary = {
  ProductID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  Description: string | null;
};

export const productSummaryCache = new Map<number, ProductSummary | null>();

export const fetchProductSummary = async (productId: number): Promise<ProductSummary | null> => {
  if (productSummaryCache.has(productId)) {
    return productSummaryCache.get(productId) ?? null;
  }
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(String(productId))}`);
    if (!res.ok) {
      productSummaryCache.set(productId, null);
      return null;
    }
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; product?: ProductSummary } | null;
    const product = payload?.ok && payload.product ? payload.product : null;
    productSummaryCache.set(productId, product);
    return product;
  } catch (err) {
    console.error('Failed to fetch product summary', err);
    productSummaryCache.set(productId, null);
    return null;
  }
};

export const isFarnellBrand = (brand: string | null | undefined): boolean => {
  if (!brand || typeof brand !== 'string') return false;
  return brand.replace(/\u00A0/g, ' ').trim().toLowerCase() === 'farnell';
};

export type FarnellLookupResult = {
  sku: string;
  displayName: string;
  manufacturerPartNumber: string | null;
  brandName: string | null;
  description: string | null;
  productURL: string | null;
  stock: number | null;
  prices: { from: number; to: number; cost: number }[];
  matchedPrice: number | null;
};

export type FarnellLookupResponse = {
  product: FarnellLookupResult;
  farnellBrandId: number | null;
};

export type AssignedRequestedPricing = {
  quantity: number | null;
  customerDiscount: number | null;
  telmacoDiscount: number | null;
};

export const fetchFarnellLookup = async (
  sku: string,
  quantity?: number,
  searchType: 'id' | 'manuPartNum' = 'id',
): Promise<FarnellLookupResponse | null> => {
  try {
    const params = new URLSearchParams({ sku });
    if (quantity != null && quantity > 0) {
      params.set('quantity', String(Math.trunc(quantity)));
    }
    if (searchType !== 'id') {
      params.set('searchType', searchType);
    }
    const res = await fetch(`/api/farnell/lookup?${params.toString()}`);
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      product?: FarnellLookupResult;
      farnellBrandId?: number | null;
    } | null;
    if (!payload?.ok || !payload.product) return null;
    return {
      product: payload.product,
      farnellBrandId: typeof payload.farnellBrandId === 'number' ? payload.farnellBrandId : null,
    };
  } catch (err) {
    console.error('Failed to fetch Farnell product', err);
    return null;
  }
};

export const fetchFarnellSearchProducts = async (
  term: string,
  quantity?: number,
  searchType: 'auto' | 'keyword' | 'ai' = 'auto',
  signal?: AbortSignal,
): Promise<{ products: FarnellLookupResult[]; farnellBrandId: number | null }> => {
  try {
    const params = new URLSearchParams({ sku: term, searchType });
    if (quantity != null && quantity > 0) {
      params.set('quantity', String(Math.trunc(quantity)));
    }
    const res = await fetch(`/api/farnell/lookup?${params.toString()}`, { signal });
    if (!res.ok) return { products: [], farnellBrandId: null };
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      product?: FarnellLookupResult;
      products?: FarnellLookupResult[];
      farnellBrandId?: number | null;
    } | null;
    if (!payload?.ok) return { products: [], farnellBrandId: null };
    const products = Array.isArray(payload.products)
      ? payload.products
      : payload.product
        ? [payload.product]
        : [];
    const farnellBrandId = typeof payload.farnellBrandId === 'number' ? payload.farnellBrandId : null;
    return { products, farnellBrandId };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { products: [], farnellBrandId: null };
    }
    console.error('Failed to fetch Farnell search products', err);
    return { products: [], farnellBrandId: null };
  }
};

export const resolveFarnellProductByPartNumber = async (
  partNumber: string,
): Promise<number | null> => {
  try {
    const params = new URLSearchParams({
      partNumber,
      brand: 'Farnell',
    });
    const res = await fetch(`/api/products/resolve?${params.toString()}`);
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      productId?: number;
      match?: string;
    } | null;
    // Only accept brand-matched results - reject fallback matches from other brands.
    if (payload?.ok && typeof payload.productId === 'number' && payload.match !== 'fallbackNoBrand') {
      return payload.productId;
    }
    return null;
  } catch {
    return null;
  }
};

export const createFarnellProduct = async (
  farnellBrandId: number,
  farnellProduct: FarnellLookupResult,
  sku: string,
): Promise<number | null> => {
  try {
    const rawDescription = farnellProduct.description ?? farnellProduct.displayName ?? null;

    // Shorten description to max 60 characters via AI
    let description = rawDescription;
    if (rawDescription && rawDescription.length > 60) {
      try {
        const shortenRes = await fetch('/api/products/shorten-description', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: rawDescription,
            brand: farnellProduct.brandName ?? undefined,
            partNumber: sku,
          }),
        });
        if (shortenRes.ok) {
          const { shortened } = (await shortenRes.json()) as { shortened: string | null };
          if (shortened) description = shortened;
        }
      } catch {
        // Fall back to raw description on failure
      }
    }

    const res = await fetch('/api/products/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandId: farnellBrandId,
        partNumber: sku,
        modelNumber: farnellProduct.manufacturerPartNumber ?? null,
        erpCode: null,
        description,
        weblink: `https://be.farnell.com/en-BE/search?st=${encodeURIComponent(sku)}`,
        comments: null,
        typeId: null,
        categoryId: null,
        subCategoryId: null,
      }),
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; productId?: number } | null;
    return payload?.ok && typeof payload.productId === 'number' ? payload.productId : null;
  } catch (err) {
    console.error('Failed to create Farnell product', err);
    return null;
  }
};

export const buildFarnellPricingPatch = (
  offerDetailId: number,
  listPrice: number,
  pricing: AssignedRequestedPricing | null,
): Record<string, unknown> | null => {
  if (!Number.isFinite(listPrice) || listPrice <= 0) return null;
  const customerDiscount = pricing?.customerDiscount ?? 0;
  const telmacoDiscount = pricing?.telmacoDiscount ?? 0;

  return {
    OfferDetailID: offerDetailId,
    ListPrice: listPrice,
    CustomerDiscount: customerDiscount,
    TelmacoDiscount: telmacoDiscount,
  };
};

export const isOfferProductCommentOrProduct = (row: Record<string, unknown> | null | undefined) =>
  isOfferProductProduct(row) || isOfferProductComment(row);

export const buildCategoryAggregateGetter = (field: 'TotalPrice' | 'TotalNet' | 'TotalCost') => (
  params: ValueGetterParams<Record<string, unknown>, unknown>,
) => {
  const rowData = params.data ?? null;
  if (!isOfferProductCategory(rowData)) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  const path = parseTreeOrderingPath((rowData as { TreeOrdering?: string | null })?.TreeOrdering);
  if (path.length === 0 || !params.api) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  let sum = 0;
  let count = 0;
  params.api.forEachNode((node) => {
    if (!node?.data || node === params.node) return;
    const candidateData = node.data as Record<string, unknown>;
    if (!isOfferProductCommentOrProduct(candidateData)) return;
    const candidatePath = parseTreeOrderingPath((candidateData as { TreeOrdering?: string | null }).TreeOrdering);
    if (candidatePath.length <= path.length) return;
    const isDescendant = path.every((segment, idx) => candidatePath[idx] === segment);
    if (!isDescendant) return;
    const value = coerceNumber((candidateData as Record<string, unknown>)[field]);
    if (value == null) return;
    sum += value;
    count += 1;
  });
  if (count === 0) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  return sum;
};

export const roundMoney = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export const OFFER_PRODUCTS_EXPORT_FIELDS = [
  'TreeOrdering',
  'PartNumber',
  'BrandName',
  'AVC4BrandName',
  'ModelNumber',
  'Description',
  'Quantity',
  'ListPrice',
  'Comment',
  'Delivery',
  'IsPrintable',
  'IsComment',
  'IsCategory',
] as const;

export const normalizeNoForExport = (value: unknown): string | number => {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return trimmed;
};

export const recalcProductTotals = (
  event: CellValueChangedEvent<Record<string, unknown>>,
  quantityOverride?: number | null,
) => {
  const node = event.node;
  const data = event.data;
  if (!node || !data) return;

  const quantity = quantityOverride ?? coerceNumber((data as { Quantity?: unknown }).Quantity) ?? 0;
  const listPrice = coerceNumber((data as { ListPrice?: unknown }).ListPrice);
  const netUnitPrice = coerceNumber((data as { NetUnitPrice?: unknown }).NetUnitPrice);
  const netCost = coerceNumber((data as { NetCost?: unknown }).NetCost);

  const setValue = (field: 'TotalPrice' | 'TotalNet' | 'TotalCost' | 'GrossProfit', value: number | null) => {
    try {
      node.setDataValue(field, value);
    } catch {
      /* noop */
    }
  };

  setValue('TotalPrice', listPrice != null ? roundMoney(listPrice * quantity) : null);
  setValue('TotalNet', netUnitPrice != null ? roundMoney(netUnitPrice * quantity) : null);
  setValue('TotalCost', netCost != null ? roundMoney(netCost * quantity) : null);
  setValue(
    'GrossProfit',
    netUnitPrice != null && netCost != null ? roundMoney((netUnitPrice - netCost) * quantity) : null,
  );
};

export const CATEGORY_TOTAL_COLUMNS: string[] = ['TotalPrice', 'TotalNet', 'TotalCost'];
export const refreshCategoryAggregates = (api?: GridApi<Record<string, unknown>> | null) => {
  if (!api || typeof api.refreshCells !== 'function') return;
  try {
    api.refreshCells({ columns: CATEGORY_TOTAL_COLUMNS, force: true });
  } catch (err) {
    console.warn('Failed to refresh category aggregates', err);
  }
};

export const categoryTotalPriceGetter = buildCategoryAggregateGetter('TotalPrice');
export const categoryTotalNetGetter = buildCategoryAggregateGetter('TotalNet');
export const categoryTotalCostGetter = buildCategoryAggregateGetter('TotalCost');

export const productAccentCellClassRules = {
  'offer-products-grid__cell--product-accent': (params: { data?: Record<string, unknown> | null }) =>
    isOfferProductProduct(params.data),
};

export const productPriceListClassRules = priceListStatusClassRules((params) =>
  isOfferProductProduct(params.data) ? params.data : null,
);

export const totalPriceCellClassRules = {
  ...productAccentCellClassRules,
  ...productPriceListClassRules,
};

export const PRICING_FIELD_LABELS: Record<string, string> = {
  CustomerDiscount: 'Customer Discount',
  NetUnitPrice: 'Net Unit Price',
  TelmacoDiscount: 'Telmaco Discount',
  NetCostOtherCurrency: 'Cost (Other Currency)',
  CurrencyCostModifier: 'Cost Modifier',
  NetCost: 'Net Cost',
  Margin: 'Margin',
  ListPrice: 'List Price',
};

export const PRICING_EDITABLE_FIELDS = new Set(Object.keys(PRICING_FIELD_LABELS));

// UI labels that should never be persisted as product descriptions.
// Guards against accidental clipboard paste from the toolbar area.
export const DESCRIPTION_PASTE_BLOCKLIST = new Set([
  'Populate Offer',
  'Populating...',
  'Update Prices',
  'Updating prices...',
  'Fill AVC4 Offer',
  'Filling...',
  'View Basic Data',
  'Add Products',
  'Add Category',
  'Add Printable Comment',
  'Add Non Printable Comment',
  'Add Requested Products',
  'New Category',
  'New Printable Comment',
  'New Non Printable Comment',
  'Printable',
  'Non Printable',
]);

export const COST_ANALYSIS_COLUMNS = [
  'TelmacoDiscount',
  'NetCostOtherCurrency',
  'CurrencyCostModifier',
  'NetCost',
  'Margin',
  'GrossProfit',
  'TotalCost',
  'TelmacoWarranty',
];

export const STANDARD_PACKAGE_PRODUCTS_FIELDS = [
  'OfferDetailID',
  'ProductID',
  'Quantity',
  'PartNumber',
  'ModelNumber',
  'ProductDescription',
  'Ordering',
  'TreeOrdering',
  'BrandID',
  'Comment',
  'IsCategory',
  'IsComment',
  'IsPrintable',
  'WebLink',
  'Enabled',
  'CreatedOn',
  'CreatedBy',
  'ModifiedOn',
  'ModifiedBy',
];

export const findDeleteMenuItemIndex = (
  items: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string>,
) => items.findIndex((item) => {
  if (!item || typeof item !== 'object') return false;
  const { name } = item as MenuItemDef<Record<string, unknown>>;
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return normalized.startsWith('delete');
});

export const buildEndpointForOffer = (offerId: string) =>
  `/api/offers/${encodeURIComponent(offerId)}/products`;
