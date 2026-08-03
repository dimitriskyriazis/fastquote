import { describe, expect, it } from 'vitest';
import {
  buildOfferProductTemplateExportRows,
  ceilMoney,
  computeDisplayOrderingMap,
  computeNetPriceRescale,
  findDuplicateTreeOrderings,
  floorTo,
  formatOfferItemNoDisplay,
  getCurrentStartingItemNo,
  planStartingItemNoShift,
  planTreeOrderingEdit,
  PRICE_DECIMALS,
  roundMoney,
  type NetRescaleEntry,
} from './offerProductsUtils';
import type { OfferExportRow } from './offerProductsPanelTypes';
import { roundPriceByMagnitude } from '../../../lib/pricing';

type Row = Record<string, unknown>;

let nextOfferDetailId = 1;
const newId = () => nextOfferDetailId++;

const product = (treeOrdering: string, extra: Row = {}): Row => ({
  OfferDetailID: newId(),
  TreeOrdering: treeOrdering,
  PartNumber: 'PN-' + treeOrdering,
  ...extra,
});

const category = (treeOrdering: string, extra: Row = {}): Row => ({
  OfferDetailID: newId(),
  TreeOrdering: treeOrdering,
  IsCategory: 1,
  ...extra,
});

const printableComment = (treeOrdering: string): Row => ({
  OfferDetailID: newId(),
  TreeOrdering: treeOrdering,
  IsComment: 1,
  IsPrintable: 1,
});

const nonPrintableComment = (treeOrdering: string): Row => ({
  OfferDetailID: newId(),
  TreeOrdering: treeOrdering,
  IsComment: 1,
  IsPrintable: 0,
});

const requestedProduct = (treeOrdering: string): Row => ({
  OfferDetailID: newId(),
  TreeOrdering: treeOrdering,
  RequestedPartNo: 'REQ-' + treeOrdering,
  __isRequestedRow: 1,
});

// The display map is keyed by OfferDetailID (so duplicate-path rows each
// get their own entry); look up by ID, not by TreeOrdering.
const display = (rows: Row[]) => {
  const map = computeDisplayOrderingMap(rows);
  return rows
    .filter((r) => r.TreeOrdering != null && map.has(String(r.OfferDetailID)))
    .map((r) => [r.TreeOrdering, map.get(String(r.OfferDetailID))] as const);
};

// Test helper: look up a row's display value via its TreeOrdering. With
// duplicate paths returns the first match — tests that use this don't
// exercise duplicate-path scenarios.
const byTree = (rows: Row[], map: Map<string, string>, tree: string) => {
  const row = rows.find((r) => String(r.TreeOrdering) === tree);
  return row ? map.get(String(row.OfferDetailID)) : undefined;
};

describe('computeDisplayOrderingMap', () => {
  it('numbers a contiguous flat list 1..N', () => {
    const rows = [product('1'), product('2'), product('3')];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
    ]);
  });

  it('closes gaps left by a delete (e.g. 1,2,4 → 1,2,3)', () => {
    const rows = [product('1'), product('2'), product('4'), product('5')];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '2'],
      ['4', '3'],
      ['5', '4'],
    ]);
  });

  it('handles a non-contiguous insertion at the end', () => {
    const rows = [product('1'), product('2'), product('7')];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '2'],
      ['7', '3'],
    ]);
  });

  it('non-printable comments display as "<prevSibling>np" and don\'t advance the count', () => {
    const rows = [
      product('1'),
      nonPrintableComment('2'),
      product('3'),
      product('4'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '1np'],
      ['3', '2'],
      ['4', '3'],
    ]);
  });

  it('counts printable comments as visible siblings', () => {
    const rows = [product('1'), printableComment('2'), product('3')];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
    ]);
  });

  it('anchors a comment on the immediately preceding visible row, even across parents', () => {
    // Layout: cat 1, then leaf 1.1 inside it, then cat 2 with leaves 2.1
    // 2.2, then a non-printable comment at root level. The comment's raw
    // path makes it a sibling of "1" / "2", but visually it follows "2.2"
    // — the display should be "2.2C" to match what's right above it.
    const rows = [
      category('1'),
      product('1.1'),
      category('2'),
      product('2.1'),
      product('2.2'),
      nonPrintableComment('3'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['2', '2'],
      ['2.1', '2.1'],
      ['2.2', '2.2'],
      ['3', '2.2np'],
    ]);
  });

  it('numbers nested category children independently', () => {
    const rows = [
      category('1'),
      product('1.1'),
      product('1.2'),
      category('2'),
      product('2.1'),
      product('2.2'),
      product('3'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['1.2', '1.2'],
      ['2', '2'],
      ['2.1', '2.1'],
      ['2.2', '2.2'],
      ['3', '3'],
    ]);
  });

  it('renumbers correctly after a row exits a category', () => {
    // Started as: cat 1 / [1.1, 1.2, 1.3], cat 2.
    // The middle child (1.2) was moved out to root, ending up as raw "3"
    // (a non-contiguous insert at root); cat 2 stays at "2".
    const rows = [
      category('1'),
      product('1.1'),
      product('1.3'), // gap from removed 1.2
      category('2'),
      product('3'), // the row that exited the category
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['1.3', '1.2'],
      ['2', '2'],
      ['3', '3'],
    ]);
  });

  it('renumbers after deleting from inside a category', () => {
    // cat 1 had children 1.1, 1.2, 1.3, 1.4; deleted 1.2.
    const rows = [
      category('1'),
      product('1.1'),
      product('1.3'),
      product('1.4'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['1.3', '1.2'],
      ['1.4', '1.3'],
    ]);
  });

  it('handles a deep gap-and-skip combination', () => {
    // rootStart = 2. Non-printable comments display as "<prevSibling>C" and
    // don't take a sibling slot, so products stay sequential.
    const rows = [
      product('2'),
      nonPrintableComment('3'),
      category('5'), // real gap (deleted "4") still closes
      product('5.2'),
      nonPrintableComment('5.3'),
      product('5.5'),
      product('7'),
    ];
    expect(display(rows)).toEqual([
      ['2', '2'],
      ['3', '2np'],
      ['5', '3'],
      ['5.2', '3.1'],
      ['5.3', '3.1np'],
      ['5.5', '3.2'],
      ['7', '4'],
    ]);
  });

  it('treats requested rows as regular numbered siblings', () => {
    const rows = [
      product('1'),
      requestedProduct('2'),
      product('4'), // a delete happened between
      requestedProduct('5'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '2'],
      ['4', '3'],
      ['5', '4'],
    ]);
  });

  it('handles requested rows mixed inside a category with gaps', () => {
    const rows = [
      category('1'),
      requestedProduct('1.1'),
      product('1.3'), // gap from removed 1.2
      requestedProduct('1.4'),
      product('2'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['1.3', '1.2'],
      ['1.4', '1.3'],
      ['2', '2'],
    ]);
  });

  it('handles a specific-position insert in the middle (sentinel 0)', () => {
    // User added a row between 6.3.4 and 6.3.5. Server may store it as
    // 6.3.0 (sentinel) before resequencing — display should still order it
    // by raw TreeOrdering, with all siblings counted 1..N.
    const rows = [
      category('6'),
      category('6.3'),
      product('6.3.0'), // sentinel: not yet resequenced
      product('6.3.1'),
      product('6.3.2'),
      product('6.3.3'),
    ];
    const map = computeDisplayOrderingMap(rows);
    // rootStart = 6 (lowest stored root). Sentinel sorts before "1"
    // numerically, so it becomes the first child under 6.1.
    expect(byTree(rows, map, '6.3.0')).toBe('6.1.1');
    expect(byTree(rows, map, '6.3.1')).toBe('6.1.2');
    expect(byTree(rows, map, '6.3.2')).toBe('6.1.3');
    expect(byTree(rows, map, '6.3.3')).toBe('6.1.4');
  });

  it('handles a deep 4-level tree', () => {
    const rows = [
      category('1'),
      category('1.1'),
      category('1.1.1'),
      product('1.1.1.1'),
      product('1.1.1.2'),
      product('1.1.1.4'), // gap
      category('1.1.2'),
      product('1.1.2.1'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['1.1.1', '1.1.1'],
      ['1.1.1.1', '1.1.1.1'],
      ['1.1.1.2', '1.1.1.2'],
      ['1.1.1.4', '1.1.1.3'],
      ['1.1.2', '1.1.2'],
      ['1.1.2.1', '1.1.2.1'],
    ]);
  });

  it('preserves bespoke high-numbered roots (rootStart from data)', () => {
    // When the lowest stored root is 6 (e.g. user shifted Starting Item No
    // to 6), auto mode keeps roots at 6+ and only collapses gaps within
    // each parent group. Sub-levels still renumber from 1.
    const rows = [
      category('6'),
      category('6.2'),
      product('6.2.8'),
      category('6.3'),
      product('6.3.1'),
      product('6.3.2'),
    ];
    const map = computeDisplayOrderingMap(rows);
    expect(byTree(rows, map, '6')).toBe('6');
    expect(byTree(rows, map, '6.2')).toBe('6.1');
    expect(byTree(rows, map, '6.2.8')).toBe('6.1.1');
    expect(byTree(rows, map, '6.3')).toBe('6.2');
    expect(byTree(rows, map, '6.3.1')).toBe('6.2.1');
    expect(byTree(rows, map, '6.3.2')).toBe('6.2.2');
  });

  it('renumbers a heavily edited offer (many deletes + inserts) cleanly', () => {
    // Simulating ~25 visible products under one category after lots of churn:
    // raw segments are scattered (12, 17, 19, 25, 30, ...) but display 1..N.
    const rawSegments = [3, 7, 12, 17, 19, 25, 30, 31, 32, 40, 41, 50, 51, 60, 61, 62, 70, 71, 80, 81, 90, 91, 92, 93, 100];
    const rows: Row[] = [category('1')];
    rawSegments.forEach((seg) => rows.push(product(`1.${seg}`)));
    const map = computeDisplayOrderingMap(rows);
    rawSegments.forEach((seg, idx) => {
      expect(byTree(rows, map, `1.${seg}`)).toBe(`1.${idx + 1}`);
    });
  });

  it('a long run of non-printable comments all anchor on the same prev sibling', () => {
    const rows = [
      product('1'),
      nonPrintableComment('2'),
      nonPrintableComment('3'),
      nonPrintableComment('4'),
      nonPrintableComment('5'),
      product('6'),
      product('7'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '1np'],
      ['3', '1np'],
      ['4', '1np'],
      ['5', '1np'],
      ['6', '2'],
      ['7', '3'],
    ]);
  });

  it('numbers a category that has no visible children', () => {
    // After deleting all products from a category, the category itself
    // still gets a number; nothing under it is in the display map.
    const rows = [category('1'), category('2'), product('3')];
    const map = computeDisplayOrderingMap(rows);
    expect(byTree(rows, map, '1')).toBe('1');
    expect(byTree(rows, map, '2')).toBe('2');
    expect(byTree(rows, map, '3')).toBe('3');
  });

  it('starts root numbering from the lowest stored root segment', () => {
    // Roots stored at 7..11 (e.g. after a Starting Item No shift) display
    // as 7,8,9,10 — counting up from 7 with the gap closed.
    const rows = [
      requestedProduct('7'),
      requestedProduct('8'),
      requestedProduct('9'),
      requestedProduct('11'), // gap from delete
    ];
    expect(display(rows)).toEqual([
      ['7', '7'],
      ['8', '8'],
      ['9', '9'],
      ['11', '10'],
    ]);
  });

  it('handles requested rows mixed with regular products and a non-printable note', () => {
    const rows = [
      category('1'),
      product('1.1'),
      requestedProduct('1.2'),
      nonPrintableComment('1.3'),
      requestedProduct('1.5'), // gap from delete + skipped non-printable
      product('1.6'),
      printableComment('1.7'),
      product('2'),
      requestedProduct('5'), // root-level requested with big gap
    ];
    // Sub-level under "1": 1.1 product → "1.1", 1.2 requested → "1.2",
    // 1.3 NULL comment → "1.2C" (doesn't take a slot), then real gap from
    // 1.4 deletion closes → 1.5 → "1.3", 1.6 → "1.4", 1.7 printable
    // comment counts as a sibling → "1.5".
    // Root level: real gap between "2" and "5" closes → "5" → "3".
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['1.2', '1.2'],
      ['1.3', '1.2np'],
      ['1.5', '1.3'],
      ['1.6', '1.4'],
      ['1.7', '1.5'],
      ['2', '2'],
      ['5', '3'],
    ]);
  });

  it('returns an empty map for empty input', () => {
    expect(computeDisplayOrderingMap([]).size).toBe(0);
  });

  it('skips rows with null/missing TreeOrdering', () => {
    const rows: Row[] = [
      product('1'),
      { PartNumber: 'orphan' }, // no TreeOrdering
      { TreeOrdering: null, PartNumber: 'also-orphan' },
      product('2'),
    ];
    const map = computeDisplayOrderingMap(rows);
    expect(byTree(rows, map, '1')).toBe('1');
    expect(byTree(rows, map, '2')).toBe('2');
    expect(map.size).toBe(2);
  });

  it('handles a single root row (preserves its raw segment)', () => {
    const rows = [product('5')];
    const map = computeDisplayOrderingMap(rows);
    expect(byTree(rows, map, '5')).toBe('5');
  });

  it('handles a moved-out subtree (category demoted to sibling)', () => {
    // Original: 1 / [1.1, 1.2 (cat) / [1.2.1, 1.2.2], 1.3]
    // User moved 1.2 (with children) to root level — server gives it
    // root segment "2", original parent renumbered.
    const rows = [
      category('1'),
      product('1.1'),
      product('1.2'), // (was 1.3, now 1.2 after the move)
      category('2'), // ex 1.2 moved to root
      product('2.1'),
      product('2.2'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['1.1', '1.1'],
      ['1.2', '1.2'],
      ['2', '2'],
      ['2.1', '2.1'],
      ['2.2', '2.2'],
    ]);
  });

  describe('manual mode', () => {
    it('shows raw TreeOrdering verbatim — no gap closing, no renumbering', () => {
      const rows = [
        category('6'),
        category('6.3'),
        product('6.3.1'),
        product('6.3.4'), // raw gap preserved in manual
      ];
      const map = computeDisplayOrderingMap(rows, { manualMode: true });
      expect(byTree(rows, map, '6')).toBe('6');
      expect(byTree(rows, map, '6.3')).toBe('6.3');
      expect(byTree(rows, map, '6.3.1')).toBe('6.3.1');
      expect(byTree(rows, map, '6.3.4')).toBe('6.3.4');
    });

    it('preserves bespoke segments instead of renumbering them', () => {
      const rows = [category('6'), category('6.2'), product('6.2.8')];
      const map = computeDisplayOrderingMap(rows, { manualMode: true });
      expect(byTree(rows, map, '6')).toBe('6');
      expect(byTree(rows, map, '6.2')).toBe('6.2');
      expect(byTree(rows, map, '6.2.8')).toBe('6.2.8');
    });

    it('non-printable comments still render with the np suffix in manual mode', () => {
      const rows = [
        product('1'),
        nonPrintableComment('2'),
        product('3'),
      ];
      const map = computeDisplayOrderingMap(rows, { manualMode: true });
      expect(byTree(rows, map, '1')).toBe('1');
      expect(byTree(rows, map, '2')).toBe('1np');
      // Manual: raw value, no compression — product stays at "3" not "2".
      expect(byTree(rows, map, '3')).toBe('3');
    });

    it('still renumbers in auto mode (manualMode: false explicit)', () => {
      const rows = [product('1'), product('4'), product('5')];
      const map = computeDisplayOrderingMap(rows, { manualMode: false });
      expect(byTree(rows, map, '1')).toBe('1');
      expect(byTree(rows, map, '4')).toBe('2');
      expect(byTree(rows, map, '5')).toBe('3');
    });
  });

  it('is order-independent (input ordering does not matter)', () => {
    const rows = [
      product('1.3'),
      category('1'),
      product('2'),
      product('1.1'),
    ];
    const result = display(rows);
    // sorted by TreeOrdering server-side — verify by key, not array order
    const map = new Map(result.map(([k, v]) => [k, v]));
    expect(map.get('1')).toBe('1');
    expect(map.get('1.1')).toBe('1.1');
    expect(map.get('1.3')).toBe('1.2');
    expect(map.get('2')).toBe('2');
  });
});

// The Item No the grid renders — and, since the export resolver shares this
// helper, exactly what an Excel/CSV export writes for the Item No column.
describe('formatOfferItemNoDisplay', () => {
  const itemNo = (rows: Row[], tree: string, options?: { manualMode?: boolean }) => {
    const map = computeDisplayOrderingMap(rows, options);
    const row = rows.find((r) => String(r.TreeOrdering) === tree);
    return formatOfferItemNoDisplay(row, map);
  };

  it('renders the renumbered value for ordinary rows', () => {
    const rows = [product('1'), product('2'), product('4')];
    expect(itemNo(rows, '4')).toBe('3');
  });

  it('suffixes non-printable comments with np, anchored on the row above', () => {
    const rows = [product('1'), nonPrintableComment('2'), product('3')];
    expect(itemNo(rows, '2')).toBe('1np');
    // The product after a non-printable comment keeps the next visible number.
    expect(itemNo(rows, '3')).toBe('2');
  });

  it('suffixes options with o', () => {
    const rows = [product('1'), product('2', { IsOption: 1 }), product('3')];
    expect(itemNo(rows, '2')).toBe('2o');
  });

  it('renders a non-printable comment marked as an option as "no", not "npo"', () => {
    const rows = [
      product('1'),
      { ...nonPrintableComment('2'), IsOption: 1 },
      product('3'),
    ];
    expect(itemNo(rows, '2')).toBe('1no');
  });

  it('keeps the suffixes in manual mode, on top of the raw value', () => {
    const rows = [
      product('6.3.1'),
      { ...nonPrintableComment('6.3.2'), IsOption: 1 },
      product('6.3.4', { IsOption: 1 }),
    ];
    expect(itemNo(rows, '6.3.1', { manualMode: true })).toBe('6.3.1');
    expect(itemNo(rows, '6.3.2', { manualMode: true })).toBe('6.3.1no');
    expect(itemNo(rows, '6.3.4', { manualMode: true })).toBe('6.3.4o');
  });

  it('falls back to the raw TreeOrdering when the row is not in the map', () => {
    const row = product('7', { IsOption: 1 });
    expect(formatOfferItemNoDisplay(row, new Map())).toBe('7o');
    expect(formatOfferItemNoDisplay(product('7'), new Map())).toBe('7');
  });

  it('returns an empty string for a missing row or a blank TreeOrdering', () => {
    expect(formatOfferItemNoDisplay(null, new Map())).toBe('');
    expect(formatOfferItemNoDisplay({ OfferDetailID: 1, TreeOrdering: '  ' }, new Map())).toBe('');
    // An option with no number stays blank rather than becoming a bare "o".
    expect(formatOfferItemNoDisplay({ OfferDetailID: 1, IsOption: 1 }, new Map())).toBe('');
  });
});

const idOf = (row: Row) => row.OfferDetailID as number;

describe('planTreeOrderingEdit', () => {
  it('rewrites a category and all its descendants on prefix change', () => {
    const cat = category('1');
    const rows = [
      cat,
      product('1.1'),
      product('1.2'),
      category('1.3'),
      product('1.3.1'),
      product('1.3.2'),
      product('5'),
    ];
    const result = planTreeOrderingEdit(rows, idOf(cat), '2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.updates.map((u) => [u.OfferDetailID, u.TreeOrdering]));
    expect(byId.get(idOf(rows[0]))).toBe('2');
    expect(byId.get(idOf(rows[1]))).toBe('2.1');
    expect(byId.get(idOf(rows[2]))).toBe('2.2');
    expect(byId.get(idOf(rows[3]))).toBe('2.3');
    expect(byId.get(idOf(rows[4]))).toBe('2.3.1');
    expect(byId.get(idOf(rows[5]))).toBe('2.3.2');
    // Sibling outside the moved subtree is untouched.
    expect(byId.has(idOf(rows[6]))).toBe(false);
  });

  it('rewrites a sub-category prefix recursively', () => {
    const sub = category('1.2');
    const rows = [
      category('1'),
      product('1.1'),
      sub,
      product('1.2.1'),
      product('1.2.2'),
      product('1.3'),
    ];
    const result = planTreeOrderingEdit(rows, idOf(sub), '1.5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.updates.map((u) => [u.OfferDetailID, u.TreeOrdering]));
    expect(byId.get(idOf(sub))).toBe('1.5');
    expect(byId.get(idOf(rows[3]))).toBe('1.5.1');
    expect(byId.get(idOf(rows[4]))).toBe('1.5.2');
  });

  it('returns no updates when the value did not change', () => {
    const cat = category('3');
    const rows = [cat, product('3.1')];
    const result = planTreeOrderingEdit(rows, idOf(cat), '3');
    expect(result).toEqual({ ok: true, updates: [] });
  });

  it('does NOT sweep along a duplicate at the same path — only the target moves', () => {
    // Reproduces the bug where editing one of two rows sharing path "1"
    // applied to BOTH rows. Setup: 14800 and 14802 both at "1" (the
    // duplicate state after a manual edit). Editing 14800 → "3" must
    // change 14800 only; 14802 stays at "1".
    const dupA = product('1');                  // 14800-equivalent
    const middle = product('2');                // 14801-equivalent
    const dupB = product('1');                  // 14802-equivalent
    const rows = [dupA, middle, dupB];
    const result = planTreeOrderingEdit(rows, idOf(dupA), '3');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updates).toEqual([
      { OfferDetailID: idOf(dupA), TreeOrdering: '3' },
    ]);
  });

  it('allows an edit even if the new path collides with an existing row', () => {
    // Manual mode permits temporary duplicates. The leaving-manual-mode
    // toggle re-validates and refuses to switch back if any remain.
    const cat = category('1');
    const rows = [cat, product('1.1'), product('2'), product('2.1')];
    const result = planTreeOrderingEdit(rows, idOf(cat), '2');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.updates.map((u) => [u.OfferDetailID, u.TreeOrdering]));
    // Edited cat now collides with existing root "2".
    expect(byId.get(idOf(cat))).toBe('2');
    // Descendant cascaded too — collides with existing "2.1".
    expect(byId.get(idOf(rows[1]))).toBe('2.1');
  });

  it('allows a descendant cascade even when it collides', () => {
    // Moving "1" → "3" means children "1.1" → "3.1". An existing "3.1"
    // outside the moved subtree no longer blocks the edit; the duplicate
    // is permitted in manual mode and surfaced on toggle-back.
    const cat = category('1');
    const rows = [cat, product('1.1'), product('3'), product('3.1')];
    const result = planTreeOrderingEdit(rows, idOf(cat), '3');
    expect(result.ok).toBe(true);
  });

  it('rejects empty / malformed values', () => {
    const cat = category('1');
    const rows = [cat];
    expect(planTreeOrderingEdit(rows, idOf(cat), '').ok).toBe(false);
    expect(planTreeOrderingEdit(rows, idOf(cat), '   ').ok).toBe(false);
    expect(planTreeOrderingEdit(rows, idOf(cat), 'abc').ok).toBe(false);
    expect(planTreeOrderingEdit(rows, idOf(cat), '1..2').ok).toBe(false);
    expect(planTreeOrderingEdit(rows, idOf(cat), '.1').ok).toBe(false);
    expect(planTreeOrderingEdit(rows, idOf(cat), '1.').ok).toBe(false);
  });

  it('accepts deep dotted values', () => {
    const cat = category('1');
    const rows = [cat, product('5.7.9.2')];
    const result = planTreeOrderingEdit(rows, idOf(cat), '4.2.1');
    expect(result.ok).toBe(true);
  });

  it('rejects when the row cannot be found', () => {
    const rows = [product('1')];
    const result = planTreeOrderingEdit(rows, 99999, '2');
    expect(result.ok).toBe(false);
  });

  it('moving a leaf product just rewrites the single row', () => {
    const leaf = product('2.5');
    const rows = [category('1'), product('1.1'), category('2'), product('2.1'), leaf];
    const result = planTreeOrderingEdit(rows, idOf(leaf), '2.9');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.updates).toEqual([{ OfferDetailID: idOf(leaf), TreeOrdering: '2.9' }]);
  });

  it('handles the screenshot-style case: bumping category 6.3 to 6.5', () => {
    const cat = category('6.3');
    const rows = [
      category('6'),
      cat,
      product('6.3.1'),
      product('6.3.2'),
      product('6.3.5'),
      product('6.4'), // sibling, untouched
    ];
    const result = planTreeOrderingEdit(rows, idOf(cat), '6.5');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.updates.map((u) => [u.OfferDetailID, u.TreeOrdering]));
    expect(byId.get(idOf(cat))).toBe('6.5');
    expect(byId.get(idOf(rows[2]))).toBe('6.5.1');
    expect(byId.get(idOf(rows[3]))).toBe('6.5.2');
    expect(byId.get(idOf(rows[4]))).toBe('6.5.5');
    expect(byId.has(idOf(rows[0]))).toBe(false);
    expect(byId.has(idOf(rows[5]))).toBe(false);
  });
});

describe('getCurrentStartingItemNo', () => {
  it('returns the lowest root segment', () => {
    const rows = [product('3'), product('1'), product('2.5')];
    expect(getCurrentStartingItemNo(rows)).toBe(1);
  });

  it('uses only the root segment, not deeper ones', () => {
    const rows = [product('5.1'), product('5.2'), product('7')];
    expect(getCurrentStartingItemNo(rows)).toBe(5);
  });

  it('returns null for empty input', () => {
    expect(getCurrentStartingItemNo([])).toBeNull();
  });

  it('skips rows without a TreeOrdering', () => {
    const rows: Row[] = [{ OfferDetailID: 1, PartNumber: 'x' }, product('4')];
    expect(getCurrentStartingItemNo(rows)).toBe(4);
  });
});

describe('planStartingItemNoShift', () => {
  it('shifts every root segment by (newStart - currentStart)', () => {
    // currentStart = 1, newStart = 6 → delta = 5.
    const rows = [
      category('1'),
      product('1.1'),
      product('1.2.3'),
      category('2'),
      product('2.1'),
      product('3'),
    ];
    const result = planStartingItemNoShift(rows, 6);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.updates.map((u) => [u.OfferDetailID, u.TreeOrdering]));
    expect(byId.get(idOf(rows[0]))).toBe('6');
    expect(byId.get(idOf(rows[1]))).toBe('6.1');
    expect(byId.get(idOf(rows[2]))).toBe('6.2.3');
    expect(byId.get(idOf(rows[3]))).toBe('7');
    expect(byId.get(idOf(rows[4]))).toBe('7.1');
    expect(byId.get(idOf(rows[5]))).toBe('8');
  });

  it('handles a negative shift (currentStart > newStart)', () => {
    // currentStart = 5, newStart = 2 → delta = -3.
    const rows = [product('5'), product('5.1'), product('7'), product('9')];
    const result = planStartingItemNoShift(rows, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byId = new Map(result.updates.map((u) => [u.OfferDetailID, u.TreeOrdering]));
    expect(byId.get(idOf(rows[0]))).toBe('2');
    expect(byId.get(idOf(rows[1]))).toBe('2.1');
    expect(byId.get(idOf(rows[2]))).toBe('4');
    expect(byId.get(idOf(rows[3]))).toBe('6');
  });

  it('returns no updates when the value is unchanged', () => {
    const rows = [product('1'), product('2')];
    expect(planStartingItemNoShift(rows, 1)).toEqual({ ok: true, updates: [] });
  });

  it('returns no updates for an empty offer', () => {
    expect(planStartingItemNoShift([], 5)).toEqual({ ok: true, updates: [] });
  });

  it('rejects when the shift would push a row to a non-positive root', () => {
    const rows = [product('1'), product('2')];
    const result = planStartingItemNoShift(rows, 0);
    expect(result.ok).toBe(false);
  });

  it('rejects non-integer or < 1 inputs', () => {
    const rows = [product('1')];
    expect(planStartingItemNoShift(rows, 0).ok).toBe(false);
    expect(planStartingItemNoShift(rows, -3).ok).toBe(false);
    expect(planStartingItemNoShift(rows, 1.5).ok).toBe(false);
    expect(planStartingItemNoShift(rows, Number.NaN).ok).toBe(false);
  });
});

describe('findDuplicateTreeOrderings', () => {
  it('returns no duplicates for a clean offer', () => {
    const rows = [product('1'), product('2'), product('2.1')];
    expect(findDuplicateTreeOrderings(rows)).toEqual([]);
  });

  it('reports each duplicated path with the colliding rows', () => {
    const a = product('2');
    const b = product('2'); // duplicate of a
    const c = product('1.5');
    const d = product('1.5'); // duplicate of c
    const e = product('1.5'); // 3rd occurrence
    const rows = [a, b, c, d, e, product('3')];
    const dups = findDuplicateTreeOrderings(rows);
    expect(dups).toHaveLength(2);
    const byPath = new Map(dups.map((g) => [g.treeOrdering, g.rows.length]));
    expect(byPath.get('2')).toBe(2);
    expect(byPath.get('1.5')).toBe(3);
  });

  it('ignores rows without TreeOrdering or OfferDetailID', () => {
    const rows: Row[] = [
      product('1'),
      { TreeOrdering: '1' }, // no OfferDetailID — should be ignored
      { OfferDetailID: 999 }, // no TreeOrdering — should be ignored
      product('1'), // valid duplicate
    ];
    const dups = findDuplicateTreeOrderings(rows);
    expect(dups).toHaveLength(1);
    expect(dups[0].rows).toHaveLength(2);
  });
});

/* ── computeNetPriceRescale ──────────────────────────────────────────── */

describe('computeNetPriceRescale', () => {
  const mkEntries = (items: Array<[oldNet: number, quantity: number]>): NetRescaleEntry[] =>
    items.map(([oldNet, quantity], i) => ({ OfferDetailID: i + 1, oldNet, quantity, newNet: oldNet }));

  // The offer total the server will actually report: SUM of each line's stored
  // TotalNet, which is net × qty rounded to the DECIMAL(18,4) column scale.
  const sumStoredTotal = (entries: NetRescaleEntry[]) =>
    roundMoney(entries.reduce((s, e) => s + roundMoney(e.newNet * e.quantity, PRICE_DECIMALS), 0), PRICE_DECIMALS);

  // Same total in integer cents. Note it rounds the SUM, not each price: the
  // closing passes deliberately park the last fraction of a cent inside the
  // prices, where the 2-decimal displays never show it but the stored 4-decimal
  // line totals still add up.
  const sumCents = (entries: NetRescaleEntry[]) => Math.round(sumStoredTotal(entries) * 100);

  // What the user actually reads in the grid: the price rounded to 2 decimals.
  const asDisplayed = (price: number) => roundMoney(price, 2);

  // Identical prices move in lockstep, so the offer total only ever shifts in
  // multiples of gcd(line quantities) cents. That step is the hard floor on how
  // precisely any target can be hit, and the fuzz cases below bound themselves by
  // it rather than pretending a coarse offer can land on an arbitrary figure.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  const quantityGridCents = (items: Array<[number, number]>) => {
    const byPrice = new Map<number, number>();
    for (const [price, qty] of items) byPrice.set(price, (byPrice.get(price) ?? 0) + qty);
    return [...byPrice.values()].reduce((g, q) => gcd(g, q));
  };

  const isBandRounded = (price: number) => Math.abs(roundPriceByMagnitude(price) - price) < 1e-9;

  // The magnitude band step for a price, in cents — mirrors roundPriceByMagnitude.
  const bandStepCents = (price: number) => {
    const abs = Math.abs(price);
    if (abs < 10) return 1;
    if (abs < 100) return 10;
    if (abs < 1000) return 100;
    if (abs < 100000) return 1000;
    return 10000;
  };

  // Deterministic PRNG so the fuzz cases are reproducible.
  const mulberry32 = (seed: number) => () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  describe('cents mode (legacy exact rescale)', () => {
    it('hits the target total exactly', () => {
      const entries = mkEntries([[123.45, 3], [67.89, 2], [9.99, 7], [4500, 1]]);
      const achieved = computeNetPriceRescale(entries, 6000, {});
      expect(achieved).toBe(600000);
      expect(sumCents(entries)).toBe(600000);
    });

    it('keeps identical old prices identical after rescale', () => {
      const entries = mkEntries([[250, 1], [250, 3], [99.5, 2], [250, 5]]);
      computeNetPriceRescale(entries, 3100, {});
      const same = entries.filter((e) => e.oldNet === 250).map((e) => e.newNet);
      expect(new Set(same).size).toBe(1);
      expect(sumCents(entries)).toBe(310000);
    });
  });

  describe('magnitude mode (Total Margin edit)', () => {
    it('keeps every price band-rounded', () => {
      const entries = mkEntries([[0.5, 40], [8.2, 10], [55, 4], [820, 2], [12500, 1], [250000, 1]]);
      computeNetPriceRescale(entries, 320000, { magnitudeRounding: true });
      for (const e of entries) {
        expect(isBandRounded(e.newNet), `price ${e.newNet} not band-rounded`).toBe(true);
      }
    });

    it('single row: price is the band-rounded scaled value, no nudge that worsens the gap', () => {
      const entries = mkEntries([[100, 1]]);
      const achieved = computeNetPriceRescale(entries, 646.67, { magnitudeRounding: true });
      expect(entries[0].newNet).toBe(647); // whole-unit band
      expect(achieved).toBe(64700);
    });

    it('lands close to the target (residual bounded by the finest band coin)', () => {
      const entries = mkEntries([[3.17, 5], [42.6, 3], [510, 2], [7300, 1]]);
      const target = 9876.54;
      const achieved = computeNetPriceRescale(entries, target, { magnitudeRounding: true });
      // Finest coin: the 3.17 group steps in cents × qty 5 = 5 cents.
      expect(Math.abs(achieved - Math.round(target * 100))).toBeLessThanOrEqual(5);
      for (const e of entries) {
        expect(isBandRounded(e.newNet), `price ${e.newNet} not band-rounded`).toBe(true);
      }
    });
  });

  describe('magnitude + exactTotal mode (Total Net edit)', () => {
    it('hits the target exactly while keeping most prices band-rounded', () => {
      const entries = mkEntries([[3.17, 5], [42.6, 3], [510, 2], [7300, 1], [1, 1]]);
      const target = 9876.54;
      const achieved = computeNetPriceRescale(entries, target, { magnitudeRounding: true, exactTotal: true });
      expect(achieved).toBe(987654);
      expect(sumCents(entries)).toBe(987654);
    });

    it('single row: cent finisher restores exactness', () => {
      const entries = mkEntries([[100, 1]]);
      computeNetPriceRescale(entries, 646.67, { magnitudeRounding: true, exactTotal: true });
      expect(entries[0].newNet).toBe(646.67);
    });
  });

  // Whole cents cannot compose every gap. Identical products move in lockstep, so
  // the offer total only shifts in multiples of the line quantities: an offer whose
  // quantities all share a factor can be left an odd cent away from a target and no
  // combination of cent moves will land on it. The closing passes stop at the cent
  // regardless — a price is always a figure the grid can show, so the visible
  // column always adds up — and cross the target rather than fall short of it.
  describe('whole-cent residual closing', () => {
    it('never puts a sub-cent price on a row', () => {
      const cases: Array<Array<[number, number]>> = [
        [[10, 2], [20, 2]], [[10, 4], [20, 4]], [[3.17, 5], [42.6, 3], [510, 2]],
        [[123.45, 3], [67.89, 2], [9.99, 7], [4500, 1]],
      ];
      for (const items of cases) {
        for (const target of [61.01, 123.45, 999.99, 12345.67]) {
          const entries = mkEntries(items);
          computeNetPriceRescale(entries, target, { magnitudeRounding: true, exactTotal: true });
          for (const e of entries) {
            expect(asDisplayed(e.newNet), `price ${e.newNet} carries sub-cent decimals`).toBe(e.newNet);
          }
        }
      }
    });

    it('closes gaps no single group can, by stepping one group up and another down', () => {
      // Quantities 4 and 6 share a factor of 2, so neither group on its own can
      // move the total by two cents — only 4-up-against-6-down can.
      for (let k = 0; k < 40; k++) {
        const entries = mkEntries([[10, 4], [20, 6]]);
        const target = roundMoney(200 + k * 0.02, 2);
        computeNetPriceRescale(entries, target, { magnitudeRounding: true, exactTotal: true });
        expect(sumStoredTotal(entries), `target ${target}`).toBe(target);
      }
    });

    it('gets within a cent when the quantities cannot compose the target', () => {
      // Every quantity even, so an odd number of cents is simply unreachable.
      const entries = mkEntries([[10, 2], [20, 2]]);
      computeNetPriceRescale(entries, 61.01, { magnitudeRounding: true, exactTotal: true });
      expect(Math.abs(sumStoredTotal(entries) - 61.01)).toBeLessThanOrEqual(0.01);
    });

    it('keeps lockstep while closing', () => {
      const entries = mkEntries([[10, 2], [10, 4], [20, 2]]);
      computeNetPriceRescale(entries, 187.53, { magnitudeRounding: true, exactTotal: true });
      const tens = new Set(entries.filter((e) => e.oldNet === 10).map((e) => e.newNet));
      expect(tens.size).toBe(1);
      expect(Math.abs(sumStoredTotal(entries) - 187.53)).toBeLessThanOrEqual(0.02);
    });

    it('crosses rather than falls short when atLeastTarget is set', () => {
      for (let cents = 6000; cents <= 6200; cents++) {
        const target = cents / 100;
        const entries = mkEntries([[10, 2], [20, 4], [7.5, 6]]);
        computeNetPriceRescale(entries, target, {
          magnitudeRounding: true, exactTotal: true, atLeastTarget: true,
        });
        const achieved = sumStoredTotal(entries);
        expect(achieved, `target ${target} → ${achieved}`).toBeGreaterThanOrEqual(target - 1e-9);
        expect(achieved - target, `target ${target} overshot by ${achieved - target}`).toBeLessThanOrEqual(0.06);
      }
    });
  });

  // The user-facing contract for the Total Margin / Total Markup totals-row
  // edits: the percentage the totals bar reads back must be the one that was
  // typed. Cost is untouched by a rescale, so any net total in
  // [cost/(1 − m), cost/(1 − m − 0.01)) displays as exactly m — the accept window.
  // Handing the whole window to the rescale lets it stop while the prices are
  // still round figures instead of shaving a cent off one to hit a single point.
  describe('margin / markup targets round-trip exactly', () => {
    const marginOf = (net: number, cost: number) => (1 - cost / net) * 100;
    const markupOf = (net: number, cost: number) => net / cost;
    const marginWindow = (cost: number, m: number) =>
      ({ min: cost / (1 - m / 100), max: cost / (1 - (m + 0.01) / 100) });

    // Real numbers from offer "401 Γ.Σ.Ν.Α. TEST": thirteen product and service
    // lines plus a 400,00 printable comment (counted in the offer total, never
    // rescaled) against a 7.636,35 cost and a typed 57 %.
    //
    // Two complaints came out of this offer and they pull against each other. A
    // net-exact target made prices like 4.749,99 / 633,99 / 162,99 — the closing
    // pass paying for the total by knocking a cent off round figures. Paying out
    // of sub-cent slack instead kept the prices round but left the visible column
    // no longer adding up to the visible total. The window resolves it: every net
    // in it displays as 57 %, and the band-rounded prices already land inside.
    it('stops inside the margin window with every price still a round figure', () => {
      const cost = 7636.35;
      const comment = 400;
      const nets = [636, 4750, 3050, 162, 1780, 1320, 1310, 162, 1320, 1320, 162, 651, 736];
      const entries = mkEntries(nets.map((net) => [net, 1] as [number, number]));
      const window = marginWindow(cost, 57);
      computeNetPriceRescale(entries, ceilMoney(window.min, 2) - comment, {
        magnitudeRounding: true,
        exactTotal: true,
        atLeastTarget: true,
        acceptWindow: { min: window.min - comment, max: window.max - comment },
      });

      // Not one price moved, and none of them left its round figure.
      expect(entries.map((e) => e.newNet)).toEqual(nets);
      // The visible column adds up to the visible total…
      const offerNet = roundMoney(sumStoredTotal(entries) + comment, PRICE_DECIMALS);
      expect(offerNet).toBe(17759);
      expect(asDisplayed(offerNet)).toBe(offerNet);
      // …and the totals bar reads back the typed 57 %.
      expect(floorTo(marginOf(offerNet, cost), 2)).toBe(57);
    });

    // The cent-rounded net target that produced the reported 56,99: half a cent of
    // net is a ten-millionth of a percentage point here, and a ten-millionth under
    // the boundary floors a whole hundredth down. The window's low edge is ceiled
    // to the cent for exactly this reason.
    it('never lands on the wrong side of the margin boundary', () => {
      const cost = 7636.35;
      expect(floorTo(marginOf(roundMoney(cost / (1 - 57 / 100), 2), cost), 2)).toBe(56.99);
      expect(floorTo(marginOf(ceilMoney(cost / (1 - 57 / 100), 2), cost), 2)).toBe(57);
    });

    it('a typed markup reads back unchanged after the rescale', () => {
      const entries = mkEntries([[500, 2], [125.5, 4]]);
      const cost = 900;
      const typedMarkup = 1.37;
      computeNetPriceRescale(entries, ceilMoney(cost * typedMarkup, 2), {
        magnitudeRounding: true,
        exactTotal: true,
        atLeastTarget: true,
        acceptWindow: { min: cost * typedMarkup, max: cost * (typedMarkup + 0.01) },
      });
      expect(floorTo(markupOf(sumStoredTotal(entries), cost), 2)).toBe(typedMarkup);
    });

    it('fuzz: every typed margin survives the round-trip, floored display included', () => {
      const rand = mulberry32(20260803);
      for (let run = 0; run < 250; run++) {
        const rowCount = 1 + Math.floor(rand() * 8);
        const items: Array<[number, number]> = [];
        for (let i = 0; i < rowCount; i++) {
          const magnitude = 10 ** Math.floor(rand() * 4);
          const price = Math.round(magnitude * (0.5 + rand() * 9.5) * 100) / 100;
          // Deliberately no quantity-1 row: shared factors are exactly the case
          // whole cents cannot close.
          const qty = 2 * (1 + Math.floor(rand() * 6));
          items.push([price, qty]);
        }
        const entries = mkEntries(items);
        const basis = items.reduce((s, [p, q]) => s + p * q, 0);
        // Cost below the basis so the implied margin is positive and sane, and the
        // offer big enough that a hundredth of a percent is worth over a cent —
        // below that no cent-priced offer can express a 2-decimal margin at all.
        const cost = roundMoney(Math.max(basis * (0.3 + rand() * 0.4), 200), PRICE_DECIMALS);
        const typedMargin = Math.round((5 + rand() * 60) * 100) / 100;
        const window = marginWindow(cost, typedMargin);
        computeNetPriceRescale(entries, ceilMoney(window.min, 2), {
          magnitudeRounding: true, exactTotal: true, atLeastTarget: true, acceptWindow: window,
        });
        const achieved = sumStoredTotal(entries);
        // The window is only reachable if it is at least as wide as the step the
        // line quantities move the total in. A hundredth of a percent is worth
        // net x 0.0001 / (1 - margin), so a coarse, small offer can have no total
        // at all that displays as the typed figure; those land on the nearest
        // reachable point instead, which is the best any lockstep pricing can do.
        const gridCents = quantityGridCents(items);
        if ((window.max - window.min) * 100 >= gridCents) {
          expect(
            floorTo(marginOf(achieved, cost), 2),
            `run ${run}: cost ${cost} margin ${typedMargin} → net ${achieved}`,
          ).toBe(typedMargin);
        } else {
          expect(Math.abs(achieved - window.min), `run ${run}: drifted off a coarse offer`)
            .toBeLessThanOrEqual(gridCents / 100);
        }
        for (const e of entries) {
          expect(asDisplayed(e.newNet), `run ${run}: price ${e.newNet} is sub-cent`).toBe(e.newNet);
        }
      }
    });
  });
  describe('ceilMoney', () => {
    it('rounds up onto the 4-decimal price grid', () => {
      expect(ceilMoney(1295.33678756)).toBe(1295.3368);
      expect(ceilMoney(0.00001)).toBe(0.0001);
    });

    it('leaves a value already on the grid alone', () => {
      expect(ceilMoney(1295.3368)).toBe(1295.3368);
      expect(ceilMoney(10)).toBe(10);
      // 0.1 * 3 is 0.30000000000000004 — float dust must not cost a whole step.
      expect(ceilMoney(0.1 * 3)).toBe(0.3);
    });
  });

  // Services are quoted in days, so a per-unit '-Day' line can carry 0.5 or
  // 0.25. That used to be rounded away by `Math.round(entry.quantity)`, which
  // silently rescaled against the wrong basis.
  describe('fractional service quantities (days)', () => {
    it('weights a half-day line by 0.5, not by a rounded 1', () => {
      // 100 x 0.5 = 50 today; doubling the target to 100 must double the price.
      const entries = mkEntries([[100, 0.5]]);
      computeNetPriceRescale(entries, 100, {});
      expect(entries[0].newNet).toBe(200);
    });

    it('rescales a mixed product + half-day offer off the true basis', () => {
      // 200x1 + 80x0.5 = 240. Halving the target to 120 halves both prices.
      const entries = mkEntries([[200, 1], [80, 0.5]]);
      computeNetPriceRescale(entries, 120, {});
      expect(entries[0].newNet).toBe(100);
      expect(entries[1].newNet).toBe(40);
      expect(sumCents(entries)).toBe(12000);
    });

    it('still closes to the cent when the fractions can compose the residual', () => {
      const entries = mkEntries([[33.33, 0.5], [10, 2]]);
      const achieved = computeNetPriceRescale(entries, 100, {});
      expect(achieved).toBe(10000);
      expect(sumCents(entries)).toBe(10000);
    });

    it('gets within a cent when the quantities cannot land exactly', () => {
      // A lone 0.25 line moves the total in quarter-cent steps, so an exact
      // cent match is not always reachable — it must still come close.
      const entries = mkEntries([[10, 0.25]]);
      const achieved = computeNetPriceRescale(entries, 7.77, {});
      expect(Math.abs(achieved - 777)).toBeLessThanOrEqual(1);
    });

    it('leaves whole-quantity offers byte-identical to the old behaviour', () => {
      const entries = mkEntries([[123.45, 3], [67.89, 2], [9.99, 7], [4500, 1]]);
      expect(computeNetPriceRescale(entries, 6000, {})).toBe(600000);
      expect(sumCents(entries)).toBe(600000);
    });
  });

  describe('fuzz: random offers stay consistent (seeded, reproducible)', () => {
    it('exact modes always add up to the cent; magnitude mode stays band-rounded and close', () => {
      const rand = mulberry32(20260610);
      for (let run = 0; run < 300; run++) {
        const rowCount = 1 + Math.floor(rand() * 25);
        const items: Array<[number, number]> = [];
        for (let i = 0; i < rowCount; i++) {
          // Prices across all bands: 0.05 € … ~150.000 €
          const magnitude = 10 ** Math.floor(rand() * 6 - 1);
          const price = Math.round(magnitude * (0.5 + rand() * 9.5) * 100) / 100;
          const qty = 1 + Math.floor(rand() * 12);
          items.push([price, qty]);
        }
        const baseTotal = items.reduce((s, [p, q]) => s + p * q, 0);
        const target = Math.round(baseTotal * (0.5 + rand()) * 100) / 100;
        const targetCents = Math.round(target * 100);

        // cents mode: exact, or a single cent out when the line quantities share a
        // factor that cannot compose the last cent (no quantity-1 row is planted
        // here, so that case does come up). Prices never go below the cent, which
        // is what keeps the visible column agreeing with the visible total.
        const centsEntries = mkEntries(items);
        computeNetPriceRescale(centsEntries, target, {});
        const gridCents = quantityGridCents(items);
        expect(Math.abs(sumCents(centsEntries) - targetCents), `run ${run}: cents mode missed target`)
          .toBeLessThanOrEqual(gridCents);
        for (const e of centsEntries) {
          expect(asDisplayed(e.newNet), `run ${run}: price ${e.newNet} is sub-cent`).toBe(e.newNet);
        }

        // magnitude + exact: exact, lockstep, AND every price still reads round.
        // No quantity-1 row is planted here (it used to be, so the cent finisher
        // could always close): with lockstep the total only moves in multiples of
        // gcd(quantities), so an all-even offer can be a fraction of a cent short
        // of a 4-decimal target. Exact to the cent — the precision everything is
        // displayed, exported and printed at — always holds.
        const exactEntries = mkEntries(items);
        computeNetPriceRescale(exactEntries, target, { magnitudeRounding: true, exactTotal: true });
        expect(Math.abs(sumCents(exactEntries) - targetCents), `run ${run}: magnitude+exact missed target`)
          .toBeLessThanOrEqual(gridCents);
        for (const e of exactEntries) {
          expect(asDisplayed(e.newNet), `run ${run}: price ${e.newNet} is sub-cent`).toBe(e.newNet);
        }
        const byOldNet = new Map<number, Set<number>>();
        for (const e of exactEntries) {
          const set = byOldNet.get(e.oldNet) ?? new Set<number>();
          set.add(e.newNet);
          byOldNet.set(e.oldNet, set);
        }
        for (const [oldNet, prices] of byOldNet) {
          expect(prices.size, `run ${run}: group ${oldNet} broke lockstep`).toBe(1);
        }

        // magnitude only (no exact total): every price stays on its band, and the
        // total lands within the finest move any group can make — the band step of
        // the cheapest group times its quantity. That is the whole reason the
        // exact modes above exist.
        const magEntries = mkEntries(items);
        const achieved = computeNetPriceRescale(magEntries, target, { magnitudeRounding: true });
        for (const e of magEntries) {
          expect(isBandRounded(e.newNet), `run ${run}: price ${e.newNet} not band-rounded`).toBe(true);
        }
        const finestCoinCents = Math.min(...magEntries.map((e) => bandStepCents(e.newNet) * e.quantity));
        expect(Math.abs(achieved - targetCents), `run ${run}: magnitude drifted beyond its finest step`)
          .toBeLessThanOrEqual(Math.max(finestCoinCents, Math.round(targetCents * 0.005)));
      }
    });
  });
});

describe('buildOfferProductTemplateExportRows — ServLot quantity', () => {
  // A lump-sum service quoted as 27 lots: the offer charges 27 x 410.
  const servLot = (extra: Row = {}): Row => ({
    OfferDetailID: newId(),
    TreeOrdering: '1',
    PartNumber: 'Install-Lot',
    IsService: 1,
    ServiceType: 'ServLot',
    Quantity: 27,
    ListPrice: 410,
    NetCost: 205,
    ...extra,
  });

  const build = (rows: Row[], options?: { collapseServLotQty?: boolean }) =>
    buildOfferProductTemplateExportRows(rows as unknown as OfferExportRow[], options);

  it('keeps the real quantity by default (AVC4 pairs Qty with a per-unit price)', () => {
    const [row] = build([servLot()]);
    expect(row.qty).toBe(27);
    // The price side stays per-unit — the template has no extended-total field,
    // so the receiving workbook multiplies these two itself.
    expect(row.unitPrice).toBe(410);
    expect(row.cost).toBe(205);
  });

  it('collapses to a single unit only when asked (EP LINC request sheet)', () => {
    const [row] = build([servLot()], { collapseServLotQty: true });
    expect(row.qty).toBe(1);
    expect(row.unitPrice).toBe(410);
  });

  it('never collapses ServPerUnit day-rate lines, whatever the option says', () => {
    const perUnit = { ServiceType: 'ServPerUnit', PartNumber: 'Comm-Day', Quantity: 4 };
    expect(build([servLot(perUnit)])[0].qty).toBe(4);
    expect(build([servLot(perUnit)], { collapseServLotQty: true })[0].qty).toBe(4);
  });

  it('leaves ordinary product lines alone', () => {
    const plain = { IsService: undefined, ServiceType: undefined, PartNumber: 'PN-1', Quantity: 3 };
    expect(build([servLot(plain)])[0].qty).toBe(3);
    expect(build([servLot(plain)], { collapseServLotQty: true })[0].qty).toBe(3);
  });
});
