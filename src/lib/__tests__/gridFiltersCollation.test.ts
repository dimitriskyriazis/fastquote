import { describe, it, expect } from 'vitest';
import { buildTextMatchPredicate, buildQuickFilterClause } from '../gridFilters';
import { processFilter } from '../filterProcessing';
import { SEARCH_COLLATION } from '../textSearch';
import { collatedParamComparisons, paramComparisons } from './sqlClauseTestUtils';

// Every comparison that reads a bound parameter has to sit on a collated
// expression. Counting COLLATE occurrences instead would miss the point now
// that one predicate can carry several (the punctuation fold adds a guard and a
// folded expression alongside the plain one, sharing a single parameter).
const expectEveryComparisonCollated = (clause: string) => {
  const comparisons = paramComparisons(clause);
  expect(comparisons.length).toBeGreaterThan(0);
  expect(collatedParamComparisons(clause, SEARCH_COLLATION)).toHaveLength(comparisons.length);
};

const COLLATE = `COLLATE ${SEARCH_COLLATION}`;
const ctx = { columnExpression: 'c.Name', columnId: 'Name', paramBase: 'p' };

describe('text filter accent-insensitivity', () => {
  const MODES = ['contains', 'notContains', 'equals', 'notEqual', 'startsWith', 'endsWith'] as const;

  it.each(MODES)('collates the column side for mode "%s"', (mode) => {
    const { clause } = buildTextMatchPredicate('c.Name', 'Ελλας', { paramKey: 'p', mode });
    expect(clause).toContain(COLLATE);
  });

  it('collates every clause when fuzzy variants are generated', () => {
    // A 4–9 char term with no digits also produces swap/insertion/substitution
    // variants; each one gets its own predicate and must be collated too.
    const { clause, params } = buildTextMatchPredicate('c.Name', 'ενεργεια', { paramKey: 'p' });
    expect(params.length).toBeGreaterThan(1);
    expectEveryComparisonCollated(clause);
  });

  it('collates compound (AND/OR) conditions on both sides', () => {
    const { clause } = processFilter(
      {
        filterType: 'text',
        operator: 'OR',
        conditions: [
          { filterType: 'text', type: 'equals', filter: 'Ελλάς' },
          { filterType: 'text', type: 'equals', filter: 'Ενέργεια' },
        ],
      } as never,
      ctx,
    );
    expect(clause).toContain('@p_c0');
    expect(clause).toContain('@p_c1');
    expectEveryComparisonCollated(clause);
  });

  it('collates the quick filter', () => {
    const { clause } = buildQuickFilterClause('ελλας', [{ colId: 'Name', expression: 'c.Name' }]);
    expect(clause).toContain(COLLATE);
  });

  it('leaves blank / notBlank alone — they compare against NULL, not text', () => {
    for (const type of ['blank', 'notBlank'] as const) {
      const { clause } = processFilter({ filterType: 'text', type } as never, ctx);
      expect(clause).not.toContain(COLLATE);
    }
  });
});

describe('non-search comparisons stay accent-sensitive', () => {
  it('does not collate set filters', () => {
    // Set-filter values come from a DISTINCT list of stored values, so each
    // checkbox must match exactly the rows it represents. Folding accents here
    // would make two accent-variant checkboxes return each other's rows.
    const { clause } = processFilter(
      { filterType: 'set', values: ['Ελλάς', 'Ελλας'] } as never,
      ctx,
    );
    expect(clause).not.toContain(COLLATE);
    expect(clause).toContain('IN (');
  });

  it('does not collate number or date filters', () => {
    expect(processFilter({ filterType: 'number', type: 'equals', filter: 5 } as never, ctx).clause)
      .not.toContain(COLLATE);
    expect(processFilter({ filterType: 'date', type: 'equals', dateFrom: '2026-01-01' } as never, ctx).clause)
      .not.toContain(COLLATE);
  });
});
