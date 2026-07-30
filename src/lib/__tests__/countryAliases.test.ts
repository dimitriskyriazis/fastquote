import { describe, it, expect } from 'vitest';
import { matchesCountrySearch } from '../countryAliases';

describe('matchesCountrySearch', () => {
  it('matches the accented country name typed without accents', () => {
    // The stored names are 'Ελλάδα' / 'Κύπρος'; users routinely type them flat.
    expect(matchesCountrySearch('Ελλάδα', 'Ελλαδα')).toBe(true);
    expect(matchesCountrySearch('Ελλάδα', 'ελλαδα')).toBe(true);
    expect(matchesCountrySearch('Κύπρος', 'Κυπρος')).toBe(true);
    expect(matchesCountrySearch('Κύπρος', 'κυπρος')).toBe(true);
  });

  it('still matches the exact accented spelling', () => {
    expect(matchesCountrySearch('Ελλάδα', 'Ελλάδα')).toBe(true);
    expect(matchesCountrySearch('Κύπρος', 'Κύπρος')).toBe(true);
  });

  it('matches on a partial accent-free prefix', () => {
    expect(matchesCountrySearch('Ελλάδα', 'ελλ')).toBe(true);
    expect(matchesCountrySearch('Κύπρος', 'κυπ')).toBe(true);
  });

  it('still resolves the English aliases', () => {
    expect(matchesCountrySearch('Ελλάδα', 'greece')).toBe(true);
    expect(matchesCountrySearch('Ελλάδα', 'Greece')).toBe(true);
    expect(matchesCountrySearch('Ελλάδα', 'hellas')).toBe(true);
    expect(matchesCountrySearch('Κύπρος', 'cyprus')).toBe(true);
  });

  it('does not match unrelated countries', () => {
    expect(matchesCountrySearch('Ελλάδα', 'Γερμανια')).toBe(false);
    expect(matchesCountrySearch('Κύπρος', 'greece')).toBe(false);
    expect(matchesCountrySearch('Ελλάδα', 'cyprus')).toBe(false);
  });
});
