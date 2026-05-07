import { describe, expect, it } from 'vitest';
import {
  computeDisplayOrderingMap,
  findDuplicateTreeOrderings,
  getCurrentStartingItemNo,
  planStartingItemNoShift,
  planTreeOrderingEdit,
} from './offerProductsUtils';

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

  it('non-printable comments display as "<prevSibling>C" and don\'t advance the count', () => {
    const rows = [
      product('1'),
      nonPrintableComment('2'),
      product('3'),
      product('4'),
    ];
    expect(display(rows)).toEqual([
      ['1', '1'],
      ['2', '1C'],
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
      ['3', '2.2C'],
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
      ['3', '2C'],
      ['5', '3'],
      ['5.2', '3.1'],
      ['5.3', '3.1C'],
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
      ['2', '1C'],
      ['3', '1C'],
      ['4', '1C'],
      ['5', '1C'],
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
      ['1.3', '1.2C'],
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

    it('non-printable comments still render with the C suffix in manual mode', () => {
      const rows = [
        product('1'),
        nonPrintableComment('2'),
        product('3'),
      ];
      const map = computeDisplayOrderingMap(rows, { manualMode: true });
      expect(byTree(rows, map, '1')).toBe('1');
      expect(byTree(rows, map, '2')).toBe('1C');
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
