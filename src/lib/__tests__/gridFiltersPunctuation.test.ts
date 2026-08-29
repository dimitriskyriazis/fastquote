import { describe, it, expect } from 'vitest';
import {
  buildQuickFilterClause,
  buildTextMatchPredicate,
  supportsPunctuationFolding,
} from '../gridFilters';
import { processFilter } from '../filterProcessing';
import {
  foldPunctuation,
  foldPunctuationSql,
  hasPunctuationSql,
  searchEquals,
  searchIncludes,
} from '../textSearch';
import { splitTopLevel } from './sqlClauseTestUtils';

const NAME_CTX = { columnExpression: 'dbo.Customers.Name', columnId: 'CustomerName', paramBase: 'p' };
const textFilter = (type: string, filter: string) => ({ filterType: 'text', type, filter }) as never;
const isFolded = (clause: string) => clause.includes('REPLACE(');
const paramValue = (params: Array<{ key: string; value: unknown }>, key: string) =>
  params.find((p) => p.key === key)?.value;

describe('foldPunctuation', () => {
  it('drops the marks users omit, on either side of the comparison', () => {
    expect(foldPunctuation('P.A. Solutions')).toBe('PA Solutions');
    expect(foldPunctuation('A.E.')).toBe('AE');
    expect(foldPunctuation('AT&T')).toBe('ATT');
    expect(foldPunctuation('Coca-Cola')).toBe('CocaCola');
    expect(foldPunctuation('ΔΙ.3748')).toBe('ΔΙ3748');
  });

  it('keeps whitespace, so a term cannot match across a word boundary', () => {
    // "aso" must not reach into "Alpha Solutions"; only "P.A." collapses.
    expect(foldPunctuation('Alpha Solutions')).toBe('Alpha Solutions');
    expect(foldPunctuation('P. A. Solutions')).toBe('P A Solutions');
  });

  it('leaves letters, digits and accents to the collation', () => {
    expect(foldPunctuation('Ελλάς 2026')).toBe('Ελλάς 2026');
  });

  it('folds the same characters in JS and in SQL', () => {
    // The term is folded in JS and compared against a column folded in SQL, so
    // the two sets have to agree character for character.
    const sql = foldPunctuationSql('COL');
    const guard = hasPunctuationSql('COL');
    for (const ch of '.,;:!?\'’"“”-–—_/\\&+()[]{}<>|~^*#@=`·«»') {
      const escaped = ch === "'" ? "''" : ch;
      const foldedInSql = sql.includes(`, N'${escaped}', N''`);
      expect(foldPunctuation(ch) === '').toBe(foldedInSql);
      // Anything the fold removes must also trip the guard, or rows carrying
      // only that character would skip the fold and silently not match.
      if (foldedInSql) expect(guard).toContain(escaped);
    }
  });
});

describe('supportsPunctuationFolding', () => {
  it('folds name-shaped columns', () => {
    for (const colId of [
      'CustomerName', 'BrandName', 'City', 'Country', 'ERPCode', 'TaxOffice',
      'dbo.Brands.Name', 'Madrid',
    ]) {
      expect(supportsPunctuationFolding(colId)).toBe(true);
    }
  });

  it('skips the columns where the fold costs seconds and buys nothing', () => {
    for (const colId of [
      'Description', 'Description2', 'Comments', 'Notes', 'dbo.Products.Description',
      'WebLink', 'Email', 'Website',
      'PartNumber', 'ModelNumber', 'LegacyPartNo',
      'ProductID', 'CustomerID', 'customerId', 'ERPID', 'TaxID',
      'ListPrice', 'TotalCost', 'CreatedDate', 'Enabled', 'IsParent',
      '',
    ]) {
      expect(supportsPunctuationFolding(colId)).toBe(false);
    }
  });
});

describe('buildTextMatchPredicate punctuation folding', () => {
  it('is off unless the caller asks for it', () => {
    const { clause, params } = buildTextMatchPredicate('c.Name', 'PA Solutions', { paramKey: 'p' });
    expect(isFolded(clause)).toBe(false);
    expect(params).toHaveLength(1);
  });

  it('reuses the base parameter when the term holds no punctuation', () => {
    const { clause, params } = buildTextMatchPredicate('c.Name', 'PA Solutions', {
      paramKey: 'p',
      enablePunctuationFolding: true,
    });
    // Nothing to fold out of the term, so the guarded folded column is the only
    // thing added — no second pattern to bind.
    expect(params).toEqual([{ key: 'p', value: '%PA SOLUTIONS%' }]);
    expect(isFolded(clause)).toBe(true);
    // ...and the fold is reached only through the has-punctuation guard.
    expect(clause).toContain(hasPunctuationSql('X').replace('X ', ''));
  });

  it('binds a folded pattern as well when the term holds punctuation', () => {
    const { clause, params } = buildTextMatchPredicate('c.Name', 'P.A. Solutions', {
      paramKey: 'p',
      enablePunctuationFolding: true,
    });
    expect(paramValue(params, 'p')).toBe('%P.A. SOLUTIONS%');
    expect(paramValue(params, 'p_pf')).toBe('%PA SOLUTIONS%');
    // The folded term is also tried against the RAW column, for the reverse
    // case: "P.A." typed, "PA Solutions" stored.
    const [base, foldedMatch] = splitTopLevel(clause, ' OR ');
    expect(base).toContain('@p');
    expect(isFolded(base)).toBe(false);
    expect(splitTopLevel(foldedMatch, ' OR ').some((d) => !isFolded(d) && d.includes('@p_pf'))).toBe(true);
  });

  it('shapes the folded pattern to match the mode', () => {
    const folded = (mode: 'equals' | 'startsWith' | 'endsWith' | 'contains') =>
      paramValue(
        buildTextMatchPredicate('c.Name', 'P.A.', { paramKey: 'p', mode, enablePunctuationFolding: true }).params,
        'p_pf',
      );
    expect(folded('equals')).toBe('PA');
    expect(folded('startsWith')).toBe('PA%');
    expect(folded('endsWith')).toBe('%PA');
    expect(folded('contains')).toBe('%PA%');
  });

  it('ANDs the fold into negated modes so they still exclude the row', () => {
    for (const mode of ['notContains', 'notEqual'] as const) {
      const { clause } = buildTextMatchPredicate('c.Name', 'AE', {
        paramKey: 'p',
        mode,
        enablePunctuationFolding: true,
      });
      // "does not contain AE" has to reject "A.E." too: AND NOT, never OR.
      expect(splitTopLevel(clause, ' AND ')).toHaveLength(2);
      expect(splitTopLevel(clause, ' OR ')).toHaveLength(1);
      expect(clause).toContain('AND NOT (');
    }
  });

  it('adds nothing when the term is punctuation only', () => {
    // Folding "..." leaves an empty pattern, which as %% would match every row.
    const { clause } = buildTextMatchPredicate('c.Name', '...', {
      paramKey: 'p',
      enablePunctuationFolding: true,
    });
    expect(isFolded(clause)).toBe(false);
  });
});

describe('grid filters wire folding per column', () => {
  it('folds a column filter on a name', () => {
    const { clause } = processFilter(textFilter('contains', 'PA Solutions'), NAME_CTX);
    expect(isFolded(clause)).toBe(true);
  });

  it('leaves free-text and part-number columns on the cheap predicate', () => {
    for (const [columnId, columnExpression] of [
      ['Description', 'dbo.Products.Description'],
      ['PartNumber', 'dbo.Products.PartNumber'],
    ]) {
      const { clause } = processFilter(textFilter('contains', 'cable'), {
        columnExpression,
        columnId,
        paramBase: 'p',
      });
      expect(isFolded(clause)).toBe(false);
    }
  });

  it('leaves blank / notBlank alone', () => {
    for (const type of ['blank', 'notBlank'] as const) {
      const { clause } = processFilter({ filterType: 'text', type } as never, NAME_CTX);
      expect(isFolded(clause)).toBe(false);
    }
  });

  it('folds the quick filter per column and keeps parameter names unique', () => {
    const { clause, params } = buildQuickFilterClause('PA', [
      { colId: 'CustomerName', expression: 'dbo.Customers.Name' },
      { colId: 'Description', expression: 'dbo.Products.Description' },
    ]);
    const [nameSide, descriptionSide] = splitTopLevel(clause.replace(/^AND /, ''), ' OR ');
    expect(isFolded(nameSide)).toBe(true);
    expect(isFolded(descriptionSide)).toBe(false);
    const keys = params.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the guarded rewrite means what the plain fold means', () => {
  // The SQL says `col LIKE @f OR (col has punctuation AND folded(col) LIKE @f)`
  // instead of folding every row. That is only allowed because the two are
  // exactly equivalent — this pins the equivalence down over real-shaped values.
  const VALUES = [
    'P.A. SOLUTIONS LTD', 'PA Solutions', 'Alpha Solutions', 'A.E.', 'AE',
    'AT&T', 'Coca-Cola', 'Telmaco (Hellas)', 'ΔΙ.3748', 'plain name', '',
  ];
  const TERMS = ['PA', 'PA SOLUTIONS', 'AE', 'ATT', 'COCACOLA', 'HELLAS', 'ΔΙ3748', 'SOLUTIONS'];

  const asRewritten = (value: string, term: string) => {
    const upper = value.toUpperCase();
    const hasPunctuation = foldPunctuation(upper) !== upper;
    return upper.includes(term) || (hasPunctuation && foldPunctuation(upper).includes(term));
  };

  it.each(TERMS)('rewrites "contains %s" without changing which rows match', (term) => {
    for (const value of VALUES) {
      expect(asRewritten(value, term)).toBe(foldPunctuation(value.toUpperCase()).includes(term));
    }
  });

  it('finds the row the user could not find before', () => {
    expect(asRewritten('P.A. SOLUTIONS LTD', 'PA SOLUTIONS')).toBe(true);
    expect(asRewritten('Alpha Solutions', 'PA SOLUTIONS')).toBe(false);
  });
});

describe('browser-side search matches the server', () => {
  it('ignores punctuation in either direction', () => {
    expect(searchIncludes('P.A. Solutions Ltd', 'pa solutions')).toBe(true);
    expect(searchIncludes('PA Solutions Ltd', 'p.a. solutions')).toBe(true);
    expect(searchIncludes('Ελλάς Α.Ε.', 'ελλας αε')).toBe(true);
    expect(searchIncludes('Alpha Solutions', 'pa solutions')).toBe(false);
  });

  it('keeps equality strict, so a typed value still resolves to one option', () => {
    expect(searchEquals('St. Kitts', 'St Kitts')).toBe(false);
    expect(searchEquals('Ελλάς', 'ΕΛΛΑΣ')).toBe(true);
  });
});
