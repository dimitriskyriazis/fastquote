import { describe, it, expect } from 'vitest';
import { processFilter, processFilterAcrossColumns } from '../filterProcessing';
import type { KnownFilterModel } from '../filterTypes';
import { splitTopLevel } from './sqlClauseTestUtils';

const NAME = { columnId: 'CustomerName', columnExpression: 'dbo.Customers.Name' };
const BRAND = { columnId: 'BrandName', columnExpression: 'dbo.Customers.BrandName' };
const BOTH = [NAME, BRAND];

const contains = (filter: string): KnownFilterModel => ({ filterType: 'text', type: 'contains', filter });

// mssql throws when the same parameter name is bound twice, so every clause the
// helper builds has to keep its keys distinct.
const expectUniqueParams = (params: Array<{ key: string }>) => {
  const keys = params.map((p) => p.key);
  expect(new Set(keys).size).toBe(keys.length);
};

describe('processFilterAcrossColumns', () => {
  it('is exactly processFilter for a single target', () => {
    const filter = contains('kapa');
    const single = processFilterAcrossColumns(filter, [NAME], { paramBase: 'p' });
    const direct = processFilter(filter, { ...NAME, paramBase: 'p' });
    expect(single).toEqual(direct);
  });

  it('returns nothing when there are no targets', () => {
    expect(processFilterAcrossColumns(contains('kapa'), [], { paramBase: 'p' })).toEqual({
      clause: '',
      params: [],
    });
  });

  it('ORs a positive match across both columns', () => {
    const { clause, params } = processFilterAcrossColumns(contains('kapa'), BOTH, { paramBase: 'p' });
    expect(clause).toContain('dbo.Customers.Name');
    expect(clause).toContain('dbo.Customers.BrandName');
    // One operand per column, joined by OR at the top level. A single column's
    // predicate may hold its own AND inside (the punctuation fold is guarded),
    // which is why this splits at depth 0 rather than searching for ' AND '.
    expect(splitTopLevel(clause, ' OR ')).toHaveLength(2);
    expect(splitTopLevel(clause, ' AND ')).toHaveLength(1);
    expectUniqueParams(params);
  });

  it('searches the same term the same way whichever column it was typed into', () => {
    const typedInName = processFilterAcrossColumns(contains('kapa'), [NAME, BRAND], { paramBase: 'p' });
    const typedInBrand = processFilterAcrossColumns(contains('kapa'), [BRAND, NAME], { paramBase: 'p' });
    // Same predicates; only the side order and the target index baked into the
    // parameter names differ.
    const sides = (clause: string) =>
      clause.replace(/^\(|\)$/g, '').replace(/_x\d+/g, '_x').split(' OR ').sort();
    expect(sides(typedInBrand.clause)).toEqual(sides(typedInName.clause));
    expect(typedInBrand.params.length).toBe(typedInName.params.length);
  });

  it('ANDs a negated match so either column matching excludes the row', () => {
    const { clause, params } = processFilterAcrossColumns(
      { filterType: 'text', type: 'notContains', filter: 'test' },
      BOTH,
      { paramBase: 'p' },
    );
    expect(clause).toContain('dbo.Customers.Name');
    expect(clause).toContain('dbo.Customers.BrandName');
    expect(clause).toContain(' AND ');
    expect(clause).not.toContain(' OR ');
    expectUniqueParams(params);
  });

  it('treats the pair as one value for blank / notBlank', () => {
    const blank = processFilterAcrossColumns({ filterType: 'text', type: 'blank' }, BOTH, { paramBase: 'p' });
    expect(blank.clause).toContain(' AND ');
    expect(blank.clause).not.toContain(' OR ');

    const notBlank = processFilterAcrossColumns({ filterType: 'text', type: 'notBlank' }, BOTH, { paramBase: 'p' });
    expect(notBlank.clause).toContain(' OR ');
    expect(notBlank.clause).not.toContain(' AND ');
  });

  it('spreads each condition of a compound filter separately', () => {
    // "contains kapa AND notContains studio" must mean
    //   (name~kapa OR brand~kapa) AND (name!~studio AND brand!~studio)
    // — not "one column satisfies both conditions on its own".
    const { clause, params } = processFilterAcrossColumns(
      {
        filterType: 'text',
        operator: 'AND',
        conditions: [
          { filterType: 'text', type: 'contains', filter: 'kapa' },
          { filterType: 'text', type: 'notContains', filter: 'studio' },
        ],
      } as KnownFilterModel,
      BOTH,
      { paramBase: 'p' },
    );
    const [positive, negative] = splitTopLevel(clause, ' AND ');
    expect(negative).toBeDefined();
    // The positive condition spreads over the columns with OR, the negated one
    // with AND — so "not contains" excludes the row when either column matches.
    expect(splitTopLevel(positive, ' OR ')).toHaveLength(2);
    expect(splitTopLevel(negative, ' AND ')).toHaveLength(2);
    // Both columns appear on both sides of the compound.
    for (const side of [positive, negative]) {
      expect(side).toContain('dbo.Customers.Name');
      expect(side).toContain('dbo.Customers.BrandName');
    }
    expectUniqueParams(params);
  });

  it('keeps parameter names unique across fuzzy variants of both columns', () => {
    // A 4-9 char alphabetic term also generates swap/insertion/substitution
    // variants, i.e. many parameters per column.
    const { params } = processFilterAcrossColumns(contains('kapatel'), BOTH, { paramBase: 'CustomerName_0' });
    expect(params.length).toBeGreaterThan(4);
    expectUniqueParams(params);
  });

  it('drops conditions with no value instead of matching everything', () => {
    const { clause } = processFilterAcrossColumns(
      { filterType: 'text', type: 'contains', filter: '' },
      BOTH,
      { paramBase: 'p' },
    );
    expect(clause).toBe('');
  });

  it('spreads set filters across both columns', () => {
    const { clause, params } = processFilterAcrossColumns(
      { filterType: 'set', values: ['Kapa Studios'] },
      BOTH,
      { paramBase: 'p' },
    );
    expect(clause).toContain('dbo.Customers.Name IN');
    expect(clause).toContain('dbo.Customers.BrandName IN');
    expect(clause).toContain(' OR ');
    expectUniqueParams(params);
  });
});
