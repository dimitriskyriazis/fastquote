/**
 * Excel-style manual cell fill for the offer-products grid.
 *
 * The user selects one or more cells (AG Grid cell selection / ranges) and
 * picks a fill colour from the "Fill" toolbar button — a preset swatch, a
 * recently-used colour, or any custom colour via the native colour picker.
 * Painted cells are stored per user + offer in localStorage (a purely visual,
 * personal annotation — it never touches the server) as plain hex strings.
 *
 * Rendering: each painted cell carries the marker class
 * `offer-products-grid__cell--paint` (toggled via cellClassRules) and an inline
 * `--fq-cellpaint` custom property (set via cellStyle) holding the hex. The CSS
 * rule in ag-grid-overrides.css renders that as a solid `background-image`
 * gradient, so the fill paints ABOVE every `background-color` rule (row colour,
 * zebra, selection, hover, pricelist) regardless of selector specificity.
 */

export type CellPaintSwatch = {
  key: string;
  label: string;
  hex: string;
};

/** Preset palette shown first in the picker (Excel-style light fills). */
export const CELL_PAINT_PALETTE: CellPaintSwatch[] = [
  { key: 'yellow', label: 'Yellow', hex: '#fff3a3' },
  { key: 'green', label: 'Green', hex: '#c6efce' },
  { key: 'blue', label: 'Blue', hex: '#bdd7ee' },
  { key: 'red', label: 'Red', hex: '#ffc7ce' },
  { key: 'orange', label: 'Orange', hex: '#ffd8a8' },
  { key: 'purple', label: 'Purple', hex: '#e5d4f1' },
  { key: 'pink', label: 'Pink', hex: '#ffd6e7' },
  { key: 'grey', label: 'Grey', hex: '#dfe3e8' },
];

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const isHexColor = (value: unknown): value is string =>
  typeof value === 'string' && HEX_RE.test(value.trim());

/** Lower-cased canonical hex, or null if not a valid #rgb / #rrggbb colour. */
export const normalizeHexColor = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_RE.test(trimmed) ? trimmed.toLowerCase() : null;
};

// The first iteration of this feature stored named keys ('yellow', …). Map them
// to hex so any already-saved paint survives the switch to arbitrary colours.
const LEGACY_KEY_HEX: Record<string, string> = Object.fromEntries(
  CELL_PAINT_PALETTE.map((swatch) => [swatch.key, swatch.hex]),
);

const normalizeStoredColor = (value: unknown): string | null => {
  const hex = normalizeHexColor(value);
  if (hex) return hex;
  if (typeof value === 'string' && LEGACY_KEY_HEX[value]) return LEGACY_KEY_HEX[value];
  return null;
};

/** Marker class present on every painted cell (drives the CSS overlay). */
export const CELL_PAINT_MARKER_CLASS = 'offer-products-grid__cell--paint';

/**
 * Serialized localStorage shape: { [offerDetailId]: { [colId]: hexColor } }.
 * Keyed by OfferDetailID (the stable row identity — see offerdetails-snapshots).
 */
export type CellPaintMap = Record<string, Record<string, string>>;

const STORAGE_PREFIX = 'fastquote-offer-cell-paint';
const RECENT_PREFIX = 'fastquote-offer-cell-paint-recent';

/** How many recently-used colours to remember (per user, app-wide). */
export const CELL_PAINT_RECENT_LIMIT = 8;

const sanitizeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

export const buildCellPaintStorageKey = (
  userId: string | null | undefined,
  offerId: string,
): string => {
  const user = userId && userId.trim() ? userId.trim() : 'anon';
  return `${STORAGE_PREFIX}:${sanitizeSegment(user)}:${sanitizeSegment(offerId)}`;
};

/** Recent colours are per-user but shared across offers (like Excel). */
export const buildCellPaintRecentStorageKey = (userId: string | null | undefined): string => {
  const user = userId && userId.trim() ? userId.trim() : 'anon';
  return `${RECENT_PREFIX}:${sanitizeSegment(user)}`;
};

/** Parse (and validate) a persisted paint map, discarding unknown colours. */
export const parseCellPaintMap = (raw: string | null): CellPaintMap => {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  const next: CellPaintMap = {};
  for (const [rowId, cols] of Object.entries(parsed as Record<string, unknown>)) {
    if (!cols || typeof cols !== 'object') continue;
    const colorByCol: Record<string, string> = {};
    for (const [colId, color] of Object.entries(cols as Record<string, unknown>)) {
      const hex = normalizeStoredColor(color);
      if (hex) colorByCol[colId] = hex;
    }
    if (Object.keys(colorByCol).length > 0) next[rowId] = colorByCol;
  }
  return next;
};

/** Parse a persisted recent-colours list (most-recent first), validated. */
export const parseRecentColors = (raw: string | null): string[] => {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of parsed) {
    const hex = normalizeHexColor(entry);
    if (hex && !seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
      if (out.length >= CELL_PAINT_RECENT_LIMIT) break;
    }
  }
  return out;
};

/** Push a colour to the front of the recents list (deduped, capped). */
export const addRecentColor = (
  list: string[],
  hex: string,
  limit: number = CELL_PAINT_RECENT_LIMIT,
): string[] => {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return list;
  return [normalized, ...list.filter((c) => c !== normalized)].slice(0, limit);
};

/**
 * True if a fill colour is dark enough that black text would be hard to read,
 * so the cell text should flip to white. Uses perceived luminance.
 */
export const isDarkColor = (hex: string): boolean => {
  const normalized = normalizeHexColor(hex);
  if (!normalized) return false;
  let r: number;
  let g: number;
  let b: number;
  if (normalized.length === 4) {
    r = parseInt(normalized[1] + normalized[1], 16);
    g = parseInt(normalized[2] + normalized[2], 16);
    b = parseInt(normalized[3] + normalized[3], 16);
  } else {
    r = parseInt(normalized.slice(1, 3), 16);
    g = parseInt(normalized.slice(3, 5), 16);
    b = parseInt(normalized.slice(5, 7), 16);
  }
  // Perceived luminance (ITU-R BT.601). < 140 reads as "dark".
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
};

/** Loose params shape shared with AG Grid's CellClassParams (subset we read). */
export type CellPaintRuleParams = {
  data?: Record<string, unknown> | null;
  column?: { getColId?: () => string } | null;
  colDef?: { field?: string } | null;
};

/** Returns the hex colour painted on a cell, or null. */
export type ResolvePaintColor = (params: CellPaintRuleParams) => string | null;
