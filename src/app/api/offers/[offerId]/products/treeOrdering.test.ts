import { describe, it, expect } from 'vitest';
import {
  buildTreeFromRows,
  collectResequencedUpdates,
  type TreeOrderingRow,
} from './treeOrdering';

const rows = (...pairs: Array<[number, string]>): TreeOrderingRow[] =>
  pairs.map(([OfferDetailID, TreeOrdering]) => ({ OfferDetailID, TreeOrdering }));

// Resolve the resequenced TreeOrdering for a given OfferDetailID. When the
// function emits no update for an id, the stored value is unchanged.
const finalOrdering = (
  input: TreeOrderingRow[],
  options: Parameters<typeof collectResequencedUpdates>[1],
): Map<number, string> => {
  const updates = collectResequencedUpdates(buildTreeFromRows(input), options);
  const result = new Map<number, string>();
  input.forEach((row) => {
    if (row.TreeOrdering != null) result.set(row.OfferDetailID, row.TreeOrdering.trim());
  });
  updates.forEach((u) => result.set(u.OfferDetailID, String(u.TreeOrdering ?? '')));
  return result;
};

describe('collectResequencedUpdates — forceRenumber', () => {
  it('closes a gap left by deleting a middle root (start stays 1)', () => {
    // Had 1,2,3; deleted 2; remaining stored roots are 1 and 3.
    const final = finalOrdering(rows([10, '1'], [30, '3']), { forceRenumber: true });
    expect(final.get(10)).toBe('1');
    expect(final.get(30)).toBe('2');
  });

  it('WITHOUT override, deleting the top root leaves the start at the new min (the bug)', () => {
    // Had 1,2,3; deleted 1; remaining stored roots are 2 and 3. With no
    // override the start is inferred as min(2,3)=2, so the gap is NOT closed.
    const final = finalOrdering(rows([20, '2'], [30, '3']), { forceRenumber: true });
    expect(final.get(20)).toBe('2');
    expect(final.get(30)).toBe('3');
  });

  it('WITH pre-deletion override=1, deleting the top root closes the gap to 1', () => {
    const final = finalOrdering(rows([20, '2'], [30, '3']), {
      forceRenumber: true,
      rootStartOverride: 1,
    });
    expect(final.get(20)).toBe('1');
    expect(final.get(30)).toBe('2');
  });

  it('preserves a deliberate Starting Item No of 6 when its top row is deleted', () => {
    // Roots were 6,7,8 (user shifted start to 6); deleted 6; remaining 7,8.
    // Pre-deletion min was 6, so numbering closes back to 6,7.
    const final = finalOrdering(rows([70, '7'], [80, '8']), {
      forceRenumber: true,
      rootStartOverride: 6,
    });
    expect(final.get(70)).toBe('6');
    expect(final.get(80)).toBe('7');
  });

  it('renumbers nested children from 1 regardless of root override', () => {
    // Root 6 with children 6.2, 6.4 (gaps from deletes) → 6, 6.1, 6.2.
    const final = finalOrdering(rows([1, '6'], [2, '6.2'], [3, '6.4']), {
      forceRenumber: true,
      rootStartOverride: 6,
    });
    expect(final.get(1)).toBe('6');
    expect(final.get(2)).toBe('6.1');
    expect(final.get(3)).toBe('6.2');
  });

  it('ignores an invalid (non-positive) override and falls back to data min', () => {
    const final = finalOrdering(rows([20, '2'], [30, '3']), {
      forceRenumber: true,
      rootStartOverride: 0,
    });
    expect(final.get(20)).toBe('2');
    expect(final.get(30)).toBe('3');
  });
});
