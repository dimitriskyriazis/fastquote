import { describe, it, expect } from 'vitest';
import {
  SEARCH_COLLATION,
  collateSearch,
  foldAccents,
  normalizeSearchText,
  searchIncludes,
  searchEquals,
} from '../textSearch';

describe('foldAccents', () => {
  it('strips Greek accents', () => {
    expect(foldAccents('Ελλάς')).toBe('Ελλας');
    expect(foldAccents('ΕΝΈΡΓΕΙΑ')).toBe('ΕΝΕΡΓΕΙΑ');
    expect(foldAccents('ΚΩΝΣΤΑΝΤΊΝΟΥ')).toBe('ΚΩΝΣΤΑΝΤΙΝΟΥ');
  });

  it('strips dialytika, including the combined accent+dialytika forms', () => {
    expect(foldAccents('αϊβάλι')).toBe('αιβαλι');
    expect(foldAccents('ΑΪΒΑΛΙ')).toBe('ΑΙΒΑΛΙ');
    expect(foldAccents('ΰ')).toBe('υ');
    expect(foldAccents('ΐ')).toBe('ι');
  });

  it('strips Latin accents too', () => {
    expect(foldAccents('CAFÉ')).toBe('CAFE');
    expect(foldAccents('Müller')).toBe('Muller');
  });

  it('leaves unaccented text untouched', () => {
    expect(foldAccents('ΕΛΛΑΣ')).toBe('ΕΛΛΑΣ');
    expect(foldAccents('Extron DTP')).toBe('Extron DTP');
    expect(foldAccents('')).toBe('');
  });
});

describe('normalizeSearchText', () => {
  it('collapses every spelling of the same Greek word to one form', () => {
    const forms = ['Ελλάς', 'ΕΛΛΑΣ', 'ελλας', 'ΕΛΛΆΣ', 'ελλάς'];
    const normalized = forms.map(normalizeSearchText);
    expect(new Set(normalized).size).toBe(1);
    expect(normalized[0]).toBe('ελλασ');
  });

  it('normalizes final sigma mid-string, not just at word boundaries', () => {
    expect(normalizeSearchText('ΟΔΟΣ')).toBe(normalizeSearchText('οδός'));
    expect(normalizeSearchText('ς')).toBe('σ');
    expect(normalizeSearchText('ςς')).toBe('σσ');
  });

  it('handles null, undefined and non-strings', () => {
    expect(normalizeSearchText(null)).toBe('');
    expect(normalizeSearchText(undefined)).toBe('');
    expect(normalizeSearchText(42)).toBe('42');
  });

  it('keeps the Greek and Latin alphabets distinct', () => {
    // Greek ΑΒΕ and Latin ABE look identical but must not match.
    expect(normalizeSearchText('ΑΒΕ')).not.toBe(normalizeSearchText('ABE'));
  });
});

describe('searchIncludes', () => {
  it('finds accented data from an unaccented search term', () => {
    expect(searchIncludes('Ελλάς Μεταφορές', 'ΕΛΛΑΣ')).toBe(true);
    expect(searchIncludes('ΕΝΈΡΓΕΙΑ ΑΕ', 'ενεργεια')).toBe(true);
    expect(searchIncludes('Abbott Laboratories (Ελλάς) Α.Β.Ε.Ε.', 'ελλας')).toBe(true);
  });

  it('finds unaccented data from an accented search term', () => {
    expect(searchIncludes('ΕΛΛΑΣ ΑΕ', 'Ελλάς')).toBe(true);
    expect(searchIncludes('Ενεργεια ΑΕ', 'ΕΝΈΡΓΕΙΑ')).toBe(true);
  });

  it('still rejects genuinely different words', () => {
    expect(searchIncludes('ΕΛΛΑΣ ΑΕ', 'ΕΝΕΡΓΕΙΑ')).toBe(false);
    expect(searchIncludes('Ελλάς', 'Γερμανία')).toBe(false);
  });

  it('treats an empty term as matching everything', () => {
    expect(searchIncludes('anything', '')).toBe(true);
    expect(searchIncludes('anything', null)).toBe(true);
  });

  it('handles null haystacks', () => {
    expect(searchIncludes(null, 'ελλας')).toBe(false);
  });
});

describe('searchEquals', () => {
  it('equates accent variants', () => {
    expect(searchEquals('Ελλάς', 'ΕΛΛΑΣ')).toBe(true);
    expect(searchEquals('Οδός', 'ΟΔΟΣ')).toBe(true);
  });

  it('does not equate different words', () => {
    expect(searchEquals('Ελλάς', 'Ελλάδα')).toBe(false);
  });
});

describe('collateSearch', () => {
  it('appends the accent-insensitive collation to a SQL expression', () => {
    expect(collateSearch("UPPER(ISNULL(p.Description, ''))")).toBe(
      "UPPER(ISNULL(p.Description, '')) COLLATE Greek_CI_AI",
    );
  });

  it('uses an accent-insensitive collation', () => {
    // Guards against someone "fixing" this to an _AS collation, which would
    // silently restore the bug.
    expect(SEARCH_COLLATION).toMatch(/_AI$/);
  });
});
