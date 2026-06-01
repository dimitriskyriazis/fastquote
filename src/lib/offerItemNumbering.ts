// Shared, dependency-light "Item No" (TreeOrdering) numbering logic.
//
// Extracted from the offer products grid so the SAME renumbering is used by
// both the client grid and the server-side PDF generator — guaranteeing the
// printed "No" column always matches what the user sees in the grid.
//
// Pure module: no ag-grid, React, or browser APIs. Safe to import on the server.
import { resolveOfferProductRowType } from './offerProductRows';

// Numeric-aware collator so "2" sorts before "10" and "1.2" before "1.10".
const treeOrderingCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const compareTreeOrderingValues = (a: unknown, b: unknown) => {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa && !sb) return 0;  // both empty/null
  if (!sa) return -1;        // empty/null first
  if (!sb) return 1;
  return treeOrderingCollator.compare(sa, sb);
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

const normalizePath = (value: unknown): string => String(value ?? '').trim();

export const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

// Lowest visible root segment across all rows. Used to seed the
// "Starting Item No" input and to compute the offset on commit. Non-printable
// comments are skipped because the user can't see them in the grid, so they
// would mismatch the user's mental model of where numbering starts. Returns
// null when there are no visible rows with a parseable TreeOrdering.
export function getCurrentStartingItemNo(rows: Record<string, unknown>[]): number | null {
  let min: number | null = null;
  for (const row of rows) {
    if (resolveOfferProductRowType(row) === 'non-printable-comment') continue;
    const path = parseTreeOrderingPath(normalizePath(row.TreeOrdering));
    if (path.length === 0) continue;
    const root = path[0];
    if (!Number.isFinite(root)) continue;
    if (min == null || root < min) min = root;
  }
  return min;
}

// Map key = OfferDetailID (as string). Keying by OfferDetailID instead of
// TreeOrdering means rows with duplicate raw paths each get their own
// disambiguated display value — so corrupted offers with two rows at "6.4"
// don't collapse to a single overwritten entry.
//
// Display rules:
// - AUTO mode: products/categories renumber 1..N within each parent (root
//   level starts at the lowest stored root); non-printable comments render
//   as "<prev display>C" and don't take a slot.
// - MANUAL mode: products/categories show their RAW TreeOrdering verbatim
//   — the user is editing and any auto-shift would be confusing. Editing
//   one row never alters another row's display. Non-printable comments
//   still render as "<prev raw>C" so they read naturally without an Item
//   No of their own. Auto-renumbering kicks in only after the user
//   leaves manual mode.
export function computeDisplayOrderingMap(
  rows: Record<string, unknown>[],
  options: { manualMode?: boolean } = {},
): Map<string, string> {
  const manualMode = options.manualMode === true;

  const sorted = rows
    .filter((row): row is Record<string, unknown> => row != null && row.TreeOrdering != null)
    .sort((a, b) => compareTreeOrderingValues(a.TreeOrdering, b.TreeOrdering));

  const rootStart = getCurrentStartingItemNo(sorted) ?? 1;

  const result = new Map<string, string>();
  const lastDisplayByActualKey = new Map<string, string>();
  let lastVisibleDisplay = '';
  const visibleCountByParent = new Map<string, number>();

  for (const row of sorted) {
    const id = normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
    if (id == null) continue;
    const actualKey = String(row.TreeOrdering ?? '').trim();
    if (!actualKey) continue;
    const path = parseTreeOrderingPath(actualKey);
    if (path.length === 0) continue;

    const actualParentKey = path.slice(0, -1).join('.');
    const isRoot = path.length === 1;

    const rowType = resolveOfferProductRowType(row);
    if (rowType === 'non-printable-comment') {
      // Comments anchor on the previous visible row's display. In manual
      // mode "lastVisibleDisplay" is the previous row's RAW value; in auto
      // mode it's the renumbered display. Either way the comment reads
      // naturally as "<rowAbove>np".
      result.set(String(id), `${lastVisibleDisplay}np`);
      continue;
    }
    if (rowType === 'non-printable-service') {
      result.set(String(id), `${lastVisibleDisplay}np`);
      continue;
    }

    if (manualMode) {
      // No auto-renumbering — show the row's raw stored TreeOrdering.
      // Edits to one row never alter another row's display.
      result.set(String(id), actualKey);
      lastDisplayByActualKey.set(actualKey, actualKey);
      lastVisibleDisplay = actualKey;
      continue;
    }

    const nextIndex = (visibleCountByParent.get(actualParentKey) ?? 0) + 1;
    visibleCountByParent.set(actualParentKey, nextIndex);
    const parentDisplayKey = isRoot
      ? ''
      : (lastDisplayByActualKey.get(actualParentKey) ?? actualParentKey);
    const segmentValue = isRoot ? rootStart + nextIndex - 1 : nextIndex;
    const displayKey = parentDisplayKey
      ? `${parentDisplayKey}.${segmentValue}`
      : String(segmentValue);
    result.set(String(id), displayKey);
    lastDisplayByActualKey.set(actualKey, displayKey);
    lastVisibleDisplay = displayKey;
  }

  return result;
}
