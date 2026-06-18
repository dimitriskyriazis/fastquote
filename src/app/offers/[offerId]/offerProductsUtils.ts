import type {
  CellValueChangedEvent,
  DefaultMenuItem,
  GridApi,
  MenuItemDef,
  ValueFormatterParams,
  ValueGetterParams,
} from 'ag-grid-community';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment, isOfferProductService, isOfferProductOption, isNonPrintableComment } from '../../../lib/offerProductRows';
import { roundPriceByMagnitude } from '../../../lib/pricing';
import { priceListStatusClassRules } from '../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../lib/localeNumber';
import type { RequestedProductMatchEntry } from './products/MatchRequestedProductsModal';
import type { OfferExportRow, OfferProductsTemplateExportRow } from './offerProductsPanelTypes';
// Item No numbering lives in a shared, server-safe module so the grid and the
// PDF generator produce identical Item No values. Imported here (for internal
// use) and re-exported so existing call sites keep importing from this file.
import {
  compareTreeOrderingValues,
  parseTreeOrderingPath,
  getCurrentStartingItemNo,
  computeDisplayOrderingMap,
  normalizeOfferDetailId,
} from '../../../lib/offerItemNumbering';

export {
  compareTreeOrderingValues,
  parseTreeOrderingPath,
  getCurrentStartingItemNo,
  computeDisplayOrderingMap,
  normalizeOfferDetailId,
};

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
  ['mic', 'mics', 'microphone', 'microphones'],
  ['speaker', 'speakers', 'loudspeaker', 'loudspeakers'],
  ['headphone', 'headphones', 'headset', 'headsets'],
  ['camera', 'cameras', 'cam', 'cams'],
  ['stand', 'stands', 'tripod', 'tripods'],
  ['cable', 'cables', 'lead', 'leads', 'cord', 'cords'],
  ['keyboard', 'keyboards'],
  ['mouse', 'mice'],
  ['adapter', 'adapters', 'adaptor', 'adaptors'],
  ['converter', 'converters'],
  ['light', 'lights', 'lamp', 'lamps'],
  ['projector', 'projectors', 'projection'],
  ['connector', 'connectors'],
  ['box', 'boxes'],
  ['child', 'children'],
  ['receiver', 'receivers', 'reception'],
  ['transmitter', 'transmitters', 'transmission'],
  ['switcher', 'switchers', 'switching'],
  ['mixer', 'mixers', 'mixing'],
  ['recorder', 'recorders', 'recording'],
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

// Generic plural/singular expansion — adds the opposite form so LIKE
// predicates hit both.  Without this, a catalog row "microphone stand"
// doesn't match a user-typed "stands" (no 's' at end of "stand" in the
// catalog), and vice versa.
//
// Only applied to plain English words.  Skipped for tokens that look like
// SKUs / codes / abbreviations — "HDMI" → "HDMIs" / "HDMIes", "TVOne" →
// "TVOnes" / "TVOnees", "NJR-CTB" → "NJR-CTBs" are nonsense variants that
// never match catalog text, they just bloat the scoreClause count.
function expandPluralVariants(token: string): string[] {
  const variants: string[] = [];
  if (token.length < 4) return variants;
  // Contains a digit → treat as SKU / technical spec (HDMI2.0, 4K60, 1U).
  if (/\d/.test(token)) return variants;
  // Contains hyphen, slash, underscore, period, or other punctuation → SKU-
  // shaped (NJR-CTB, CM2-HDMI-4K-4IN, Tesira_sec-4).
  if (/[-_/.\\+]/.test(token)) return variants;
  // ALL-CAPS short words are usually acronyms/abbreviations (HDMI, USB, RJ,
  // LG, CAT) — their plural isn't a real English word either.
  if (token.length <= 5 && token === token.toUpperCase()) return variants;
  // CamelCase multi-word compounds (TVOne, SmartPanel, CORIOmaster) — the
  // pluralizer would produce garbage.  Detect via inner capital letter.
  if (/^[A-Z][a-z]+[A-Z]/.test(token)) return variants;
  const lower = token.toLowerCase();
  if (lower.endsWith('ies') && token.length >= 5) {
    variants.push(`${token.slice(0, -3)}y`);
    variants.push(token.slice(0, -1));
  } else if (lower.endsWith('es') && token.length >= 5) {
    variants.push(token.slice(0, -2));
    variants.push(token.slice(0, -1));
  } else if (lower.endsWith('s')) {
    variants.push(token.slice(0, -1));
  } else {
    variants.push(`${token}s`);
    // Skip -es except for legit -es pluralized English words.  The old
    // code added -es unconditionally, producing "inputes", "Under-deskes",
    // "connectiones" which match nothing.
    if (/(s|x|z|ch|sh)$/i.test(token)) {
      variants.push(`${token}es`);
    }
  }
  return variants;
}

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
    expandPluralVariants(token).forEach(push);
  });
  return out;
}

const UNKNOWN_BRAND_MARKERS = new Set([
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
  // Anti-intent tokens from the LLM — terms that strongly suggest the row
  // is the WRONG kind of product (accessories, spare parts, carrying cases).
  // Server subtracts matches from the relevance score rather than filtering.
  negativeDescription?: string[];
};

// AI-supplied classification of a free-text prompt into column-specific
// fragments.  When present, each non-null value is the verbatim substring of
// the user's query that belongs in that column — e.g. "Samsung TV 55 inch"
// → { brand: "Samsung", description: "TV 55 inch" }.  Lets the visible filter
// chip land on the correct column instead of dumping everything into
// Description.  Optional priceMin/priceMax populate a ListPrice number
// filter when the prompt includes a price hint ("tv around 5000$",
// "projector under 10k", "camera 3000-5000€").
export type PromptRouting = {
  brand: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  priceMin: number | null;
  priceMax: number | null;
};

export type HiddenFilterTokens = Record<string, Array<{ filter: string; weight?: number }>>;

// Brand tiering: primary (user-specified) brand tokens get this much of a
// score boost over synonym expansions, so rows whose BrandName matches the
// exact requested brand rank above rows matching only a synonym.  Synonym
// matches still appear — they just fall to the bottom when primary-brand
// hits exist.
const BRAND_PRIMARY_WEIGHT = 10;
const BRAND_SYNONYM_WEIGHT = 1;

// Split the compound brand filter into:
//   - one visible BrandName chip showing the raw primary brand (unchanged UX), and
//   - a hidden-tokens list carrying ALL brand conditions including the primary,
//     with primary tokens weight-10 and synonym expansions weight-1.
// The duplicated-in-hidden primary is intentional: the visible filter clause
// carries no weight multiplier server-side, so stashing the primary in hidden
// with a high weight is how we inject the tiered score.
function splitBrandFilterWithTiering(
  filters: Record<string, FuzzyTextFilter>,
  hidden: HiddenFilterTokens,
  compound: FuzzyTextFilter | null,
  rawBrand: string | null,
): void {
  if (!compound) return;
  const rawTrimmed = typeof rawBrand === 'string' ? rawBrand.trim() : '';
  const primaryTokens = new Set(
    rawTrimmed ? tokenizeBrand(rawTrimmed).map((t) => t.toUpperCase()) : [],
  );
  if (rawTrimmed) primaryTokens.add(rawTrimmed.toUpperCase());
  const allConditions = 'conditions' in compound ? compound.conditions : [compound];
  const rawUpper = rawTrimmed.toUpperCase();
  const visibleCond = allConditions.find((c) => c.filter.toUpperCase() === rawUpper)
    ?? allConditions.find((c) => primaryTokens.has(c.filter.toUpperCase()))
    ?? allConditions[0];
  if (!visibleCond) return;
  filters.BrandName = { filterType: 'text', type: 'contains', filter: visibleCond.filter };
  const brandHidden = allConditions.map((c) => ({
    filter: c.filter,
    weight: primaryTokens.has(c.filter.toUpperCase()) ? BRAND_PRIMARY_WEIGHT : BRAND_SYNONYM_WEIGHT,
  }));
  if (brandHidden.length > 0) hidden.BrandName = brandHidden;
}

// Split a compound OR-fuzzy filter into a single visible condition (the primary
// value, or the first condition if that's not present) and a hidden-tokens list
// carrying every remaining condition for the same column.  Keeps AG Grid's
// filter popup to one chip per column while preserving the full match coverage
// server-side via the hidden-tokens sidecar.  Optional visibleWeight is
// serialized onto the visible filter model so the server boosts its score
// above incidental brand-only matches.
function splitCompoundIntoVisibleAndHidden(
  filters: Record<string, FuzzyTextFilter>,
  hidden: HiddenFilterTokens,
  colId: string,
  compound: FuzzyTextFilter | null,
  primaryValue: string | null,
  visibleWeight?: number,
  hiddenWeight?: number,
): void {
  if (!compound) return;
  const primaryTrimmed = typeof primaryValue === 'string' ? primaryValue.trim() : '';
  const allConditions = 'conditions' in compound ? compound.conditions : [compound];
  const primaryUpper = primaryTrimmed.toUpperCase();
  const visibleCond =
    allConditions.find((c) => c.filter.toUpperCase() === primaryUpper) ?? allConditions[0];
  if (!visibleCond) return;
  filters[colId] = {
    filterType: 'text',
    type: 'contains',
    filter: visibleCond.filter,
    ...(visibleWeight != null ? { weight: visibleWeight } : {}),
  };
  const visibleUpper = visibleCond.filter.toUpperCase();
  const extras = allConditions
    .filter((c) => c.filter.toUpperCase() !== visibleUpper)
    .map((c) => ({
      filter: c.filter,
      weight: hiddenWeight ?? c.weight,
    }));
  if (extras.length > 0) hidden[colId] = extras;
}

// Weight multiplier applied to the visible PartNumber / ModelNumber filter
// chip.  A substring match on those columns is almost always the definitive
// signal that the user wants that specific product.
const VISIBLE_CODE_WEIGHT = 20;
// Weight multiplier for hidden PartNumber / ModelNumber tokens.  A
// requested part number like "50cm Mike PLM502F , 71.98.0095" tokenizes
// into ["50cm", "PLM502F", "71.98.0095"], each of which is a strong match
// signal when it appears in a product's part-number cell.  Default weight 1
// buries those hits under incidental brand-only matches, so we boost all
// tokenized parts to the same tier as the visible primary.
const HIDDEN_CODE_WEIGHT = 15;

// Append tokens to the hidden-tokens map for one column, deduping (case-
// insensitive) against both the visible-filter value and tokens already stashed
// for the same column.  Accepts pre-weighted tokens or plain strings.
function addHiddenTokens(
  filters: Record<string, FuzzyTextFilter>,
  hidden: HiddenFilterTokens,
  colId: string,
  tokens: Array<{ filter: string; weight?: number }> | string[] | undefined,
): void {
  if (!tokens || tokens.length === 0) return;
  const normalized = (tokens as Array<unknown>).map((t) =>
    typeof t === 'string' ? { filter: t } : (t as { filter: string; weight?: number }),
  );
  const existing = hidden[colId] ?? [];
  const visibleFilter = filters[colId];
  const seen = new Set<string>([
    ...(visibleFilter && 'filter' in visibleFilter ? [visibleFilter.filter.toUpperCase()] : []),
    ...existing.map((t) => t.filter.toUpperCase()),
  ]);
  const merged = [...existing];
  normalized.forEach((t) => {
    const key = t.filter.trim().toUpperCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    merged.push(t);
  });
  if (merged.length > 0) hidden[colId] = merged;
}

// SKU-shaped substring test: >= 5 chars with >= 2 digits.  Catches part
// numbers embedded in descriptions without matching plain English words.
function looksLikeCode(token: string): boolean {
  if (token.length < 5) return false;
  let digits = 0;
  for (const ch of token) { if (ch >= '0' && ch <= '9') digits += 1; }
  return digits >= 2;
}

// Treat a value as prose (belongs in Description, not in a code column) when
// it contains whitespace AND no digits.  Part and model numbers are nearly
// always alphanumeric codes — something like "oGx Frame" has a space and no
// digits, so it's almost certainly description text that accidentally landed
// in the Part Number column.  Leaving it on PartNumber gives its tokens
// outsized weight against every row whose Description contains "frame".
export function looksLikeProse(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  const hasWhitespace = /\s/.test(trimmed);
  if (!hasWhitespace) return false;
  // "Model X" / "Series 5" / "Type 7" / "V 2" — one descriptive word followed
  // by a short alphanumeric version identifier.  Keep these as PartNumber
  // codes (not prose) because they DO identify a product code in many
  // catalogs; the short back half isn't fluff the way "frame" is.
  if (/^[A-Za-z]{2,8}\s+[A-Za-z]?\d+[A-Za-z]?$/.test(trimmed)) return false;
  const hasDigit = /[0-9]/.test(trimmed);
  return !hasDigit;
}

function harvestCodeTokens(sources: Array<string | null | undefined>): string[] {
  const codeTokens = new Set<string>();
  sources.forEach((src) => {
    if (typeof src !== 'string') return;
    const trimmed = src.trim();
    if (!trimmed) return;
    trimmed.split(/[\s,;|/()[\]"'.!?:=<>+*]+/).forEach((raw) => {
      const t = raw.trim();
      if (looksLikeCode(t)) codeTokens.add(t);
    });
  });
  return Array.from(codeTokens);
}

// Build the visible filter model + hidden-tokens sidecar for a requested-product
// context.  One-stop shop for the semantics shared between the Add-Products and
// Match-Requested modals:
//   - One visible chip per column (raw primary value); fuzzy + synonym tokens
//     ride along hidden.
//   - Cross-field leakage: requested part/model/brand → hidden on Description
//     (catches rows where a manufacturer name or code is embedded in the
//     description of a rebranded product).
//   - Reverse leakage: code-looking tokens from descriptions → hidden on
//     PartNumber and ModelNumber.
//   - Optional folding of pre-fetched AI expansions into the sidecar (so the
//     grid issues one query with the expanded filter already applied).
export function buildRequestedFilterState(input: {
  requestedBrand?: string | null;
  requestedPartNumber?: string | null;
  requestedModelNumber?: string | null;
  requestedDescriptions?: Array<string | null | undefined>;
  prefetchedExpansion?: FilterExpansions | null;
}): {
  visibleModel: Record<string, FuzzyTextFilter> | null;
  hiddenTokens: HiddenFilterTokens | null;
} {
  // Sanitize: reject single-character brand/part/model values that are LLM
  // parsing artifacts (e.g. brand:"d" when the user typed "d&b speaker").
  // A LIKE '%d%' predicate matches virtually every brand name and produces
  // noise.  Strip non-alphanumeric chars and require at least 2 to remain.
  const rejectShortValue = (v: string | null | undefined): string | null => {
    if (!v) return null;
    return v.replace(/[^a-z0-9]/gi, '').length >= 2 ? v : null;
  };
  // Rebuild input with sanitized brand (create a new local to avoid mutating)
  const safeInput = {
    ...input,
    requestedBrand: rejectShortValue(input.requestedBrand),
    requestedPartNumber: rejectShortValue(input.requestedPartNumber),
    requestedModelNumber: rejectShortValue(input.requestedModelNumber),
  };

  const filters: Record<string, FuzzyTextFilter> = {};
  const hidden: HiddenFilterTokens = {};

  const descriptions = safeInput.requestedDescriptions ?? [];
  // Use the first description (desc1) as the visible primary — matches prior
  // behavior for both single-description and desc1/2/3 callers.
  const primaryDescription = descriptions.length > 0 && typeof descriptions[0] === 'string'
    ? descriptions[0]
    : null;
  const descriptionFilter = buildMultiFuzzyContainsFilter(descriptions, { mode: 'description' });
  splitCompoundIntoVisibleAndHidden(filters, hidden, 'Description', descriptionFilter, primaryDescription ?? null);

  splitBrandFilterWithTiering(
    filters, hidden,
    buildFuzzyContainsFilter(safeInput.requestedBrand, { mode: 'brand' }),
    safeInput.requestedBrand ?? null,
  );
  // Demote prose-looking values out of Part/Model code fields.  An entry
  // like "oGx Frame" in the Part Number column is really description text
  // (whitespace, no digits) — letting it ride as a PartNumber chip gives
  // it outsized weight on rows that happen to contain "frame" anywhere,
  // which is exactly the Skaarhoj/oGx failure mode.  In that case we skip
  // the visible chip + hidden tokens on Part/Model and reroute the phrase
  // into Description instead so the signal isn't lost.
  const partLooksLikeProse = looksLikeProse(safeInput.requestedPartNumber);
  const modelLooksLikeProse = looksLikeProse(safeInput.requestedModelNumber);
  if (!partLooksLikeProse) {
    splitCompoundIntoVisibleAndHidden(
      filters, hidden, 'PartNumber',
      buildFuzzyContainsFilter(safeInput.requestedPartNumber, { mode: 'partNumber' }),
      safeInput.requestedPartNumber ?? null,
      VISIBLE_CODE_WEIGHT,
      HIDDEN_CODE_WEIGHT,
    );
  }
  if (!modelLooksLikeProse) {
    splitCompoundIntoVisibleAndHidden(
      filters, hidden, 'ModelNumber',
      buildFuzzyContainsFilter(safeInput.requestedModelNumber, { mode: 'partNumber' }),
      safeInput.requestedModelNumber ?? null,
      VISIBLE_CODE_WEIGHT,
      HIDDEN_CODE_WEIGHT,
    );
  }

  const partTrimmed = typeof safeInput.requestedPartNumber === 'string' ? safeInput.requestedPartNumber.trim() : '';
  const modelTrimmed = typeof safeInput.requestedModelNumber === 'string' ? safeInput.requestedModelNumber.trim() : '';
  const brandTrimmed = typeof safeInput.requestedBrand === 'string' ? safeInput.requestedBrand.trim() : '';
  if (partTrimmed) addHiddenTokens(filters, hidden, 'Description', [{ filter: partTrimmed, weight: 1 }]);
  if (modelTrimmed) addHiddenTokens(filters, hidden, 'Description', [{ filter: modelTrimmed, weight: 1 }]);
  if (brandTrimmed && !isUnknownBrand(brandTrimmed)) {
    addHiddenTokens(filters, hidden, 'Description', [{ filter: brandTrimmed, weight: 1 }]);
  }

  const codeTokens = harvestCodeTokens(descriptions);
  if (codeTokens.length > 0) {
    const arr = codeTokens.map((t) => ({ filter: t, weight: 1 }));
    addHiddenTokens(filters, hidden, 'PartNumber', arr);
    addHiddenTokens(filters, hidden, 'ModelNumber', arr);
  }

  if (input.prefetchedExpansion) {
    addHiddenTokens(filters, hidden, 'BrandName', input.prefetchedExpansion.brand);
    addHiddenTokens(filters, hidden, 'PartNumber', input.prefetchedExpansion.partNumber);
    addHiddenTokens(filters, hidden, 'ModelNumber', input.prefetchedExpansion.modelNumber);
    addHiddenTokens(filters, hidden, 'Description', input.prefetchedExpansion.description);
  }

  return {
    visibleModel: Object.keys(filters).length > 0 ? filters : null,
    hiddenTokens: Object.keys(hidden).length > 0 ? hidden : null,
  };
}

// Build the filter state when the user has turned "Smart filtering" OFF.
// BrandName, PartNumber and ModelNumber chips are produced — no Description,
// no fuzzy expansion, no hidden-token sidecar.  All three use `contains` so
// minor spelling / punctuation variants still match.  The server still
// cross-searches part/model/legacy columns automatically whenever either
// filter is present.
// Translate the LLM's negativeDescription array into the same HiddenFilterTokens
// shape the server already understands.  Each term becomes a Description
// LIKE token; the server applies them as negative score contributions (not
// WHERE filters) so rows matching them sink but aren't hidden entirely —
// preserves graceful behavior when the LLM over-negates.
//
// Optional `positiveTokens` argument: any token already present in the
// positive hidden-tokens sidecar is silently dropped from the negative list
// so the LLM can't both boost and penalize the same word (which would
// cancel out on-score and confuse future debugging).
export function buildNegativeHiddenTokens(
  expansion: FilterExpansions | null | undefined,
  positiveTokens?: HiddenFilterTokens | null,
): HiddenFilterTokens | null {
  const terms = expansion?.negativeDescription;
  if (!Array.isArray(terms) || terms.length === 0) return null;
  const positiveSet = new Set<string>();
  if (positiveTokens && typeof positiveTokens === 'object') {
    Object.values(positiveTokens).forEach((list) => {
      list.forEach((token) => {
        const raw = typeof token?.filter === 'string' ? token.filter.trim().toLowerCase() : '';
        if (raw) positiveSet.add(raw);
      });
    });
  }
  const tokens = terms
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter((t) => t.length >= 2)
    .filter((t) => !positiveSet.has(t.toLowerCase()))
    .map((t) => ({ filter: t, weight: 1 }));
  if (tokens.length === 0) return null;
  return { Description: tokens };
}

export function buildBasicRequestedFilterState(input: {
  requestedBrand?: string | null;
  requestedPartNumber?: string | null;
  requestedModelNumber?: string | null;
}): {
  visibleModel: Record<string, FuzzyTextFilter> | null;
} {
  const filters: Record<string, FuzzyTextFilter> = {};
  const brand = typeof input.requestedBrand === 'string' ? input.requestedBrand.trim() : '';
  const part = typeof input.requestedPartNumber === 'string' ? input.requestedPartNumber.trim() : '';
  const model = typeof input.requestedModelNumber === 'string' ? input.requestedModelNumber.trim() : '';
  if (brand) {
    filters.BrandName = { filterType: 'text', type: 'contains', filter: brand } as unknown as FuzzyTextFilter;
  }
  if (part) {
    filters.PartNumber = { filterType: 'text', type: 'contains', filter: part } as unknown as FuzzyTextFilter;
  }
  if (model) {
    filters.ModelNumber = { filterType: 'text', type: 'contains', filter: model } as unknown as FuzzyTextFilter;
  }
  return { visibleModel: Object.keys(filters).length > 0 ? filters : null };
}

// Build a ListPrice number filter from an optional min/max pair.  Returns a
// shape that matches AG Grid's server-side number filter model so the grid's
// request pipeline picks it up without any custom server code.  Returns null
// when neither bound is supplied.
export function buildListPriceFilter(
  priceMin: number | null | undefined,
  priceMax: number | null | undefined,
): unknown | null {
  const hasMin = typeof priceMin === 'number' && Number.isFinite(priceMin) && priceMin > 0;
  const hasMax = typeof priceMax === 'number' && Number.isFinite(priceMax) && priceMax > 0;
  if (!hasMin && !hasMax) return null;
  if (hasMin && hasMax) {
    return { filterType: 'number', type: 'inRange', filter: priceMin, filterTo: priceMax };
  }
  if (hasMax) {
    return { filterType: 'number', type: 'lessThanOrEqual', filter: priceMax };
  }
  return { filterType: 'number', type: 'greaterThanOrEqual', filter: priceMin };
}

// Build the filter state produced when the user submits a free-text prompt
// ("TV 55 inches Samsung").
//
// Preferred path — the AI returned a `routed` classification: treat each
// routed fragment like a requested-row column (Samsung → BrandName chip, "TV
// 55 inch" → Description chip), fuzzy-expanded with synonyms, plus the AI
// expansion tokens folded into the hidden sidecar.  This gives a visible
// filter that actually matches something, per-column, instead of dumping the
// raw phrase into Description.
//
// Fallback — no routing: keep the legacy behavior of a single Description
// chip with the raw prompt text.  Only hit when the AI classifier declined.
export function buildPromptFilterState(
  promptText: string,
  expansions: FilterExpansions,
  routed?: PromptRouting | null,
): {
  visibleModel: Record<string, FuzzyTextFilter>;
  hiddenTokens: HiddenFilterTokens | null;
} {
  // Sanitize routed fields — reject single-character brand/part/model values
  // that are LLM parsing artifacts (e.g. brand:"d" for a "d&b speaker" query).
  // These create LIKE '%d%' predicates that match virtually every catalog row.
  const sanitizeRoutedValue = (v: string | null | undefined): string | null => {
    if (!v) return null;
    const alphanum = v.replace(/[^a-z0-9]/gi, '');
    return alphanum.length >= 2 ? v : null;
  };
  const cleanRouted = routed ? {
    ...routed,
    brand: sanitizeRoutedValue(routed.brand),
    partNumber: sanitizeRoutedValue(routed.partNumber),
    modelNumber: sanitizeRoutedValue(routed.modelNumber),
  } : null;

  if (cleanRouted && (
    cleanRouted.brand
    || cleanRouted.partNumber
    || cleanRouted.modelNumber
    || cleanRouted.description
    || cleanRouted.priceMin != null
    || cleanRouted.priceMax != null
  )) {
    const { visibleModel, hiddenTokens } = buildRequestedFilterState({
      requestedBrand: cleanRouted.brand,
      requestedPartNumber: cleanRouted.partNumber,
      requestedModelNumber: cleanRouted.modelNumber,
      requestedDescriptions: cleanRouted.description ? [cleanRouted.description] : [],
      prefetchedExpansion: expansions,
    });
    const filters: Record<string, FuzzyTextFilter> = { ...(visibleModel ?? {}) };
    // Price range → ListPrice number filter.  AG Grid's server-side filter
    // processor picks up the standard number-filter shape so no custom
    // server code is needed.
    const priceFilter = buildListPriceFilter(cleanRouted.priceMin, cleanRouted.priceMax);
    if (priceFilter) {
      (filters as unknown as Record<string, unknown>).ListPrice = priceFilter;
    }
    // Cross-score: always weight description expansion tokens against BrandName.
    // When routing extracts a brand (e.g. "barco") correctly, description
    // tokens like "QDX" or "d&b audiotechnik" give an extra boost to rows
    // whose BrandName also matches — putting true brand matches above rows
    // that merely mention the brand in their Description body.  Crucially,
    // this also handles cases where routing returns a junk single-char brand
    // (e.g. "d" for "d&b") that gets sanitized away in buildRequestedFilterState:
    // the description tokens ("d&b audiotechnik") still land in BrandName
    // scoring and lift real d&b audiotechnik rows to the top.
    let finalHidden = hiddenTokens;
    if (expansions.description && expansions.description.length > 0) {
      const updatedHidden: HiddenFilterTokens = {};
      Object.entries(finalHidden ?? {}).forEach(([k, v]) => { updatedHidden[k] = [...v]; });
      addHiddenTokens(filters, updatedHidden, 'BrandName',
        expansions.description.map((t) => ({ filter: t, weight: 2 })),
      );
      finalHidden = Object.keys(updatedHidden).length > 0 ? updatedHidden : null;
    }
    return {
      visibleModel: filters,
      hiddenTokens: finalHidden,
    };
  }

  const trimmed = promptText.trim();
  const promptFuzzy = buildFuzzyContainsFilter(trimmed, { mode: 'description' });
  const promptUpper = trimmed.toUpperCase();
  const promptHidden: Array<{ filter: string; weight?: number }> = [];
  if (promptFuzzy) {
    const conds = 'conditions' in promptFuzzy ? promptFuzzy.conditions : [promptFuzzy];
    conds.forEach((c) => {
      if (c.filter.toUpperCase() !== promptUpper) {
        promptHidden.push({ filter: c.filter, weight: c.weight });
      }
    });
  }
  const filters: Record<string, FuzzyTextFilter> = {
    Description: { filterType: 'text', type: 'contains', filter: trimmed },
  };
  const hidden: HiddenFilterTokens = {};
  if (promptHidden.length > 0) addHiddenTokens(filters, hidden, 'Description', promptHidden);
  addHiddenTokens(filters, hidden, 'BrandName', expansions.brand);
  addHiddenTokens(filters, hidden, 'PartNumber', expansions.partNumber);
  addHiddenTokens(filters, hidden, 'ModelNumber', expansions.modelNumber);
  addHiddenTokens(filters, hidden, 'Description', expansions.description);
  // Cross-score: also weight description expansion tokens against BrandName
  // so brand-matching rows rank above rows that merely mention the brand
  // in their description text (handles the case where the AI places a brand
  // name such as "barco" into description tokens instead of brand tokens).
  if (expansions.description && expansions.description.length > 0) {
    addHiddenTokens(filters, hidden, 'BrandName',
      expansions.description.map((t) => ({ filter: t, weight: 2 })),
    );
  }
  return {
    visibleModel: filters,
    hiddenTokens: Object.keys(hidden).length > 0 ? hidden : null,
  };
}

// Merge AI-supplied expansion tokens into an existing hidden-tokens payload.
// Returns a fresh object — does not mutate the input.
export function mergeExpansionsIntoHiddenTokens(
  prev: HiddenFilterTokens | null,
  expansions: FilterExpansions,
): HiddenFilterTokens | null {
  const base: HiddenFilterTokens = {};
  Object.entries(prev ?? {}).forEach(([k, v]) => { base[k] = [...v]; });
  const filtersDummy: Record<string, FuzzyTextFilter> = {};
  addHiddenTokens(filtersDummy, base, 'BrandName', expansions.brand);
  addHiddenTokens(filtersDummy, base, 'PartNumber', expansions.partNumber);
  addHiddenTokens(filtersDummy, base, 'ModelNumber', expansions.modelNumber);
  addHiddenTokens(filtersDummy, base, 'Description', expansions.description);
  return Object.keys(base).length > 0 ? base : null;
}

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
  return symbol === '$' || symbol === '£' ? `${symbol} ${formatted}` : `${formatted} ${symbol}`;
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

export const buildTreeOrderingKey = (segments: number[]) => segments.join('.');

export type TreeOrderingEditUpdate = {
  OfferDetailID: number;
  TreeOrdering: string;
};

export type TreeOrderingEditResult =
  | { ok: true; updates: TreeOrderingEditUpdate[] }
  | { ok: false; error: string };

const TREE_ORDERING_VALUE_PATTERN = /^\d+(\.\d+)*$/;

const normalizePath = (value: unknown): string => String(value ?? '').trim();

// Plans the row-level updates needed when a manual-mode user edits a row's
// TreeOrdering. Pure: no mutation, no I/O. Caller persists the returned
// updates and refreshes the grid.
//
// Behavior:
// - The edited row's TreeOrdering changes to `newTreeOrdering`.
// - Every descendant (TreeOrdering starting with `oldPath + "."`) gets its
//   prefix rewritten to `newTreeOrdering`.
// - If any other row (outside the moved subtree) already has a TreeOrdering
//   that would collide with one of the new paths, the edit is rejected.
export function planTreeOrderingEdit(
  rows: Record<string, unknown>[],
  targetOfferDetailId: number,
  newTreeOrderingRaw: string,
): TreeOrderingEditResult {
  const newTreeOrdering = normalizePath(newTreeOrderingRaw);
  if (!newTreeOrdering) {
    return { ok: false, error: 'Item No cannot be empty.' };
  }
  if (!TREE_ORDERING_VALUE_PATTERN.test(newTreeOrdering)) {
    return { ok: false, error: 'Item No must be digits separated by dots (e.g. 1.2.3).' };
  }

  const target = rows.find((row) => normalizeOfferDetailId(
    (row as { OfferDetailID?: unknown }).OfferDetailID ?? null,
  ) === targetOfferDetailId);
  if (!target) {
    return { ok: false, error: 'Could not find the row to update.' };
  }

  const oldPath = normalizePath(target.TreeOrdering);
  if (!oldPath) {
    return { ok: false, error: 'The row has no current Item No to change.' };
  }
  if (oldPath === newTreeOrdering) {
    return { ok: true, updates: [] };
  }

  // The moved subtree is the target plus everything whose TreeOrdering
  // starts with `oldPath + "."`. The cascade is path-prefix based, but the
  // assignment loop below is identity-based for the target row, so a
  // duplicate at the same path is NOT swept along by the edit.
  const oldPrefix = `${oldPath}.`;
  const newPrefix = `${newTreeOrdering}.`;

  // Manual mode intentionally permits duplicate Item No values: the user
  // can stage a temporary clash and resolve it later. The "Manual Mode off"
  // toggle re-validates the whole offer before allowing the switch, so any
  // surviving duplicates surface as a blocking error there.

  const updates: TreeOrderingEditUpdate[] = [];
  for (const row of rows) {
    const id = normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
    if (id == null) continue;
    const path = normalizePath(row.TreeOrdering);

    // Only the row with matching OfferDetailID gets the new path. Other
    // rows that happen to share the same raw TreeOrdering (duplicates that
    // exist transiently in manual mode) MUST NOT be rewritten — that would
    // turn a single edit into a multi-row change.
    if (id === targetOfferDetailId) {
      if (path !== newTreeOrdering) {
        updates.push({ OfferDetailID: id, TreeOrdering: newTreeOrdering });
      }
      continue;
    }

    // Descendants of the target are still cascaded by path prefix. With
    // duplicate descendants this is intentionally permissive — every row
    // whose stored path starts with `oldPath + "."` is treated as a
    // descendant of the moved subtree.
    if (path && path !== oldPath && path.startsWith(oldPrefix)) {
      const next = newPrefix + path.slice(oldPrefix.length);
      if (next !== path) {
        updates.push({ OfferDetailID: id, TreeOrdering: next });
      }
    }
  }
  return { ok: true, updates };
}

// Find rows that share the same TreeOrdering path within the offer.
// Returns one entry per duplicated path with the colliding rows. Used by
// the manual → auto mode toggle to refuse leaving manual mode while the
// offer still has duplicate Item Nos.
export type TreeOrderingDuplicateGroup = {
  treeOrdering: string;
  rows: Array<{ OfferDetailID: number; description: string | null }>;
};

export function findDuplicateTreeOrderings(
  rows: Record<string, unknown>[],
): TreeOrderingDuplicateGroup[] {
  const byPath = new Map<string, Array<{ OfferDetailID: number; description: string | null }>>();
  for (const row of rows) {
    const id = normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
    if (id == null) continue;
    const path = normalizePath(row.TreeOrdering);
    if (!path) continue;
    const description = (() => {
      const raw = (row as { Description?: unknown; ProductDescription?: unknown }).ProductDescription
        ?? (row as { Description?: unknown }).Description
        ?? null;
      if (raw == null) return null;
      return typeof raw === 'string' ? raw : String(raw);
    })();
    const bucket = byPath.get(path);
    if (bucket) bucket.push({ OfferDetailID: id, description });
    else byPath.set(path, [{ OfferDetailID: id, description }]);
  }
  const result: TreeOrderingDuplicateGroup[] = [];
  for (const [treeOrdering, list] of byPath) {
    if (list.length > 1) result.push({ treeOrdering, rows: list });
  }
  result.sort((a, b) => compareTreeOrderingValues(a.treeOrdering, b.treeOrdering));
  return result;
}

// Plans the row updates for shifting every root segment by
// (newStart - currentStart). Children follow because their path's first
// segment also shifts. Pure: caller persists the returned updates.
export function planStartingItemNoShift(
  rows: Record<string, unknown>[],
  newStart: number,
): TreeOrderingEditResult {
  if (!Number.isInteger(newStart) || newStart < 1) {
    return { ok: false, error: 'Starting Item No must be a whole number ≥ 1.' };
  }
  const currentStart = getCurrentStartingItemNo(rows);
  if (currentStart == null) {
    return { ok: true, updates: [] };
  }
  const delta = newStart - currentStart;
  if (delta === 0) return { ok: true, updates: [] };

  const updates: TreeOrderingEditUpdate[] = [];
  for (const row of rows) {
    const id = normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
    if (id == null) continue;
    const path = parseTreeOrderingPath(normalizePath(row.TreeOrdering));
    if (path.length === 0) continue;
    const nextRoot = path[0] + delta;
    if (nextRoot < 1) {
      return {
        ok: false,
        error: `Cannot shift: row "${row.TreeOrdering}" would land at a non-positive Item No.`,
      };
    }
    const nextPath = [nextRoot, ...path.slice(1)].join('.');
    updates.push({ OfferDetailID: id, TreeOrdering: nextPath });
  }
  return { ok: true, updates };
}

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
  const existing = requestedHistoryLookupInflight.get(cacheKey);
  if (existing) return existing;
  const promise = (async (): Promise<number | null> => {
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
  })();
  requestedHistoryLookupInflight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    requestedHistoryLookupInflight.delete(cacheKey);
  }
};

const requestedHistoryLookupInflight = new Map<string, Promise<number | null>>();

export type ProductSummary = {
  ProductID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  Description: string | null;
};

export const productSummaryCache = new Map<number, ProductSummary | null>();
const productSummaryInflight = new Map<number, Promise<ProductSummary | null>>();

export const fetchProductSummary = async (productId: number): Promise<ProductSummary | null> => {
  if (productSummaryCache.has(productId)) {
    return productSummaryCache.get(productId) ?? null;
  }
  const existing = productSummaryInflight.get(productId);
  if (existing) return existing;
  const promise = (async (): Promise<ProductSummary | null> => {
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
  })();
  productSummaryInflight.set(productId, promise);
  try {
    return await promise;
  } finally {
    productSummaryInflight.delete(productId);
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
  isOfferProductProduct(row) || isOfferProductComment(row) || isOfferProductService(row);

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
    // Option rows are excluded from category totals — they are optional items
    // and should not inflate the category or offer totals.
    if (isOfferProductOption(candidateData)) return;
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

// Floor — never round up. Used for margin displays so the shown margin never
// overstates the achieved one (22.796% must read 22.79, not 22.80). The
// epsilon absorbs float noise so an exact value like 22.8 doesn't floor to 22.79.
export const floorTo = (value: number, places = 2) => {
  const factor = 10 ** places;
  return Math.floor(value * factor + 1e-7) / factor;
};

/* ── Totals-row rescale (Total Net Price / Total Margin edits) ───────── */

export type NetRescaleEntry = { OfferDetailID: number; oldNet: number; quantity: number; newNet: number };

export type NetRescaleOptions = {
  // Snap each rescaled price with roundPriceByMagnitude (instead of cents)
  // and close the residual in band steps, so prices stay "nice".
  magnitudeRounding?: boolean;
  // Additionally close the leftover with cent steps so the achieved total
  // equals the target exactly. Implied when magnitudeRounding is off.
  exactTotal?: boolean;
};

/**
 * Pure core of the totals-row rescale: scales every entry's net price so the
 * summed total approaches/matches `targetTotal`. Entries that share the same
 * old net price move in lockstep (identical products keep identical prices).
 * Mutates each entry's `newNet` and returns the achieved total in cents.
 *
 * Residual closing: magnitude mode nudges groups by whole band steps (coarse
 * groups close the bulk, cheap rows are the small change); cents mode — and
 * magnitude mode with `exactTotal` — finishes with 1-cent steps.
 */
export const computeNetPriceRescale = (
  entries: NetRescaleEntry[],
  targetTotal: number,
  opts?: NetRescaleOptions,
): number => {
  const useMagnitude = opts?.magnitudeRounding === true;
  const requireExact = opts?.exactTotal === true || !useMagnitude;
  const recomputedTotal = entries.reduce((s, e) => s + e.oldNet * e.quantity, 0);
  const scale = targetTotal / recomputedTotal;

  type PriceGroup = { entries: NetRescaleEntry[]; newNet: number; totalQty: number };
  const groupMap = new Map<number, PriceGroup>();
  for (const entry of entries) {
    let group = groupMap.get(entry.oldNet);
    if (!group) {
      group = {
        entries: [],
        newNet: useMagnitude ? roundPriceByMagnitude(entry.oldNet * scale) : roundMoney(entry.oldNet * scale, 2),
        totalQty: 0,
      };
      groupMap.set(entry.oldNet, group);
    }
    group.entries.push(entry);
    group.totalQty += Math.round(entry.quantity);
    entry.newNet = group.newNet;
  }
  const groups = [...groupMap.values()];

  const toUnits = (x: number) => Math.round(x * 100);
  const fromUnits = (u: number) => u / 100;
  const setGroupNet = (group: PriceGroup, unitValue: number) => {
    group.newNet = fromUnits(unitValue);
    for (const e of group.entries) e.newNet = group.newNet;
  };
  const targetUnits = toUnits(targetTotal);
  const achievedUnits = () => groups.reduce((s, g) => s + toUnits(g.newNet) * g.totalQty, 0);
  let diffUnits = targetUnits - achievedUnits();

  if (diffUnits !== 0 && useMagnitude) {
    // The rounding band step for a group's current price, in cents.
    const stepUnits = (g: PriceGroup): number => {
      const abs = Math.abs(g.newNet);
      if (abs < 10) return 1;        // 0.01
      if (abs < 100) return 10;      // 0.10
      if (abs < 1000) return 100;    // 1
      if (abs < 100000) return 1000; // 10
      return 10000;                  // 100
    };
    // Pass 1: biggest movers first (band step × quantity), whole steps
    // toward the target — coarse groups close the bulk of the gap.
    const byCoinDesc = groups.filter((g) => g.totalQty > 0)
      .sort((a, b) => stepUnits(b) * b.totalQty - stepUnits(a) * a.totalQty);
    for (const g of byCoinDesc) {
      if (diffUnits === 0) break;
      const coin = stepUnits(g) * g.totalQty;
      const steps = diffUnits > 0 ? Math.floor(diffUnits / coin) : Math.ceil(diffUnits / coin);
      if (steps === 0) continue;
      setGroupNet(g, toUnits(g.newNet) + steps * stepUnits(g));
      // A multi-step jump can carry the price across its band boundary
      // (99.9 + 10×0.1 = 100.9), where the old step no longer matches the
      // new band's grid — re-snap and recompute the residual from scratch.
      const snapped = roundPriceByMagnitude(g.newNet);
      if (snapped !== g.newNet) setGroupNet(g, toUnits(snapped));
      diffUnits = targetUnits - achievedUnits();
    }
    // Pass 2: polish with the finest movers — cheap rows are the small
    // change. Take one step wherever it shrinks the remaining gap.
    if (diffUnits !== 0) {
      const byCoinAsc = groups.filter((g) => g.totalQty > 0)
        .sort((a, b) => stepUnits(a) * a.totalQty - stepUnits(b) * b.totalQty);
      for (const g of byCoinAsc) {
        if (diffUnits === 0) break;
        const dir = diffUnits > 0 ? 1 : -1;
        const delta = dir * stepUnits(g) * g.totalQty;
        if (Math.abs(diffUnits - delta) < Math.abs(diffUnits)) {
          setGroupNet(g, toUnits(g.newNet) + dir * stepUnits(g));
          diffUnits -= delta;
        }
      }
    }
  }
  // Cent-level passes: the only rounding for cents mode; for magnitude mode
  // with `exactTotal`, the finisher that closes the band-step leftover so the
  // total hits the target to the cent.
  if (diffUnits !== 0 && requireExact) {
    // Pass 1: largest-quantity groups first, take whole steps.
    const byQtyDesc = groups.filter((g) => g.totalQty > 0).sort((a, b) => b.totalQty - a.totalQty);
    for (const g of byQtyDesc) {
      if (diffUnits === 0) break;
      const steps = diffUnits > 0 ? Math.floor(diffUnits / g.totalQty) : Math.ceil(diffUnits / g.totalQty);
      if (steps === 0) continue;
      setGroupNet(g, toUnits(g.newNet) + steps);
      diffUnits -= steps * g.totalQty;
    }
    // Pass 2: prefer the most expensive group for the residual. Skip groups
    // whose totalQty would overshoot (equal-price rule means a totalQty=2
    // group moves the total by 2 cents per step, so it can't close a 1-cent
    // gap — the guard below auto-skips to the next most expensive group).
    if (diffUnits !== 0) {
      const byPriceDesc = groups.filter((g) => g.totalQty > 0).sort((a, b) => b.newNet - a.newNet);
      for (const g of byPriceDesc) {
        if (diffUnits === 0) break;
        const dir = diffUnits > 0 ? 1 : -1;
        const delta = dir * g.totalQty;
        if (Math.abs(diffUnits - delta) < Math.abs(diffUnits)) {
          setGroupNet(g, toUnits(g.newNet) + dir);
          diffUnits -= delta;
        }
      }
    }
  }

  return achievedUnits();
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
  'AdditionalCustomerDiscount',
  'NetCost',
  'Comment',
  'Delivery',
  'IsPrintable',
  'IsComment',
  'IsCategory',
  'IsOption',
  'IsService',
  'ServiceType',
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

// Single source of truth for turning raw offer-export rows (as returned by the
// products API with OFFER_PRODUCTS_EXPORT_FIELDS) into the flat shape consumed
// by ExportOfferProductsModal. Shared by every "Fill <template>" button so the
// row set, Item-No numbering and unmatched-row skipping stay identical across
// templates — each template just selects which of these fields it writes.
export function buildOfferProductTemplateExportRows(
  rows: OfferExportRow[],
): OfferProductsTemplateExportRow[] {
  const displayMap = computeDisplayOrderingMap(rows as unknown as Record<string, unknown>[]);
  const included = rows.filter((row) => {
    const rowType = resolveOfferProductRowType(row as unknown as Record<string, unknown>);
    return rowType === 'product' || rowType === 'category' || rowType === 'printable-comment' || rowType === 'printable-service';
  });

  return included.map((row): OfferProductsTemplateExportRow => {
    const rowType = resolveOfferProductRowType(row as unknown as Record<string, unknown>);
    const model = (row.ModelNumber ?? '').toString().trim();
    const description = (row.Description ?? '').toString().trim();
    const descriptionType = [model, description].filter((part) => part.length > 0).join(' ').trim();
    const rawQty = coerceNumber(row.Quantity);
    const isServLot = row.ServiceType === 'ServLot';
    const qty = isServLot ? 1 : rawQty;
    const listPrice = coerceNumber(row.ListPrice);
    const additionalDiscount = coerceNumber(row.AdditionalCustomerDiscount);
    const cost = coerceNumber(row.NetCost);
    // Blank delivery stays blank in the export (no 'unknown' placeholder).
    const deliveryValue = row.Delivery == null ? '' : String(row.Delivery).trim();
    const isUnmatchedProduct = rowType === 'product'
      && !row.PartNumber?.toString().trim()
      && !row.BrandName?.toString().trim()
      && !model
      && !description
      && listPrice == null;
    const actualKey = String(row.TreeOrdering ?? '').trim();
    const noBase = normalizeNoForExport(displayMap.get(actualKey) ?? row.TreeOrdering);
    const noWithOption = isOfferProductOption(row as unknown as Record<string, unknown>) && noBase !== ''
      ? `${noBase} (Option)`
      : noBase;
    return {
      no: noWithOption,
      productReference: row.PartNumber?.toString().trim() ?? '',
      manufacturer: (row.AVC4BrandName?.toString().trim() || row.BrandName?.toString().trim()) ?? '',
      descriptionType,
      qty: qty != null && !Object.is(qty, 0) ? qty : '',
      unitPrice: listPrice ?? '',
      additionalDiscount: additionalDiscount ?? '',
      cost: cost ?? '',
      delayForDelivery: deliveryValue,
      comments: row.Comment?.toString() ?? '',
      ...(isUnmatchedProduct ? { skipRow: true } : undefined),
    };
  });
}

export const recalcProductTotals = (
  event: CellValueChangedEvent<Record<string, unknown>>,
  quantityOverride?: number | null,
) => {
  const node = event.node;
  const data = event.data;
  if (!node || !data) return;

  const rawQuantity = quantityOverride ?? coerceNumber((data as { Quantity?: unknown }).Quantity) ?? 0;
  // Non-printable comments are single cost lines with no real quantity (they
  // default to 0). Treat a blank/zero quantity as 1 so editing a per-unit value
  // (e.g. Net Cost) flows through to the matching total (e.g. Total Cost).
  const quantity = rawQuantity === 0 && isNonPrintableComment(data) ? 1 : rawQuantity;
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
  // Non-printable services carry no list price, so the price-list status
  // colouring (active/expiring/expired/edited) doesn't apply to them.
  (isOfferProductProduct(params.data) || resolveOfferProductRowType(params.data) === 'printable-service')
    ? params.data
    : null,
);

export const totalPriceCellClassRules = {
  ...productAccentCellClassRules,
  ...productPriceListClassRules,
};

export const PRICING_FIELD_LABELS: Record<string, string> = {
  CustomerDiscount: 'Customer Discount',
  AdditionalCustomerDiscount: 'Add. Customer Discount',
  NetUnitPrice: 'Net Unit Price',
  TelmacoDiscount: 'Telmaco Discount',
  NetCostOtherCurrency: 'Cost (Other Currency)',
  CurrencyCostModifier: 'Cost Modifier',
  NetCost: 'Net Cost',
  Margin: 'Margin',
  ListPrice: 'List Price',
};

export const PRICING_EDITABLE_FIELDS = new Set(Object.keys(PRICING_FIELD_LABELS));

// Fields whose value can be propagated to other rows of the same product within
// the same offer when the user confirms. Excludes per-row identifiers
// (Requested*), product-level fields (Origin), and product identifiers
// (PartNumber/ModelNumber).
export const PROPAGATABLE_FIELD_LABELS: Record<string, string> = {
  ...PRICING_FIELD_LABELS,
  Description: 'Description',
  ProductDescription: 'Description',
  Comment: 'Comment',
  Delivery: 'Delivery',
  Quantity: 'Quantity',
  Installation: 'Installation Hours',
  ElInstalation: 'Electrical Installation Hours',
  Commissioning: 'Commissioning Hours',
};

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
  'Add Service',
  'Add Printable Service',
  'Add Non Printable Service',
  'Add Requested Products',
  'New Category',
  'New Printable Comment',
  'New Non Printable Comment',
  'New Printable Service',
  'New Non Printable Service',
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
  'Installation',
  'ElInstalation',
  'Commissioning',
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
