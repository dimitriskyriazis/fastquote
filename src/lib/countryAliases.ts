import { normalizeSearchText } from './textSearch';

/**
 * Maps English country name fragments to their Greek equivalents
 * so users can type e.g. "Greece" and find "Ελλάδα".
 *
 * The Greek keys are accented, so all matching below goes through
 * normalizeSearchText — otherwise typing "Ελλαδα" or "Κυπρος" (the usual
 * accent-free spelling) would match nothing.
 */
const COUNTRY_ALIASES: Record<string, string[]> = {
  'ελλάδα': ['greece', 'hellas'],
  'κύπρος': ['cyprus'],
};

// Build a reverse lookup: alias fragment → set of canonical (lowercase) country names
const aliasToCountry = new Map<string, Set<string>>();
for (const [country, aliases] of Object.entries(COUNTRY_ALIASES)) {
  for (const alias of aliases) {
    let set = aliasToCountry.get(alias);
    if (!set) {
      set = new Set();
      aliasToCountry.set(alias, set);
    }
    set.add(normalizeSearchText(country));
  }
}

/**
 * Returns true if `countryName` matches `search` either directly
 * or through a known English alias.
 *
 * Both parameters should be pre-trimmed; the function lowercases and folds
 * accents internally.
 */
export function matchesCountrySearch(countryName: string, search: string): boolean {
  const name = normalizeSearchText(countryName);
  const term = normalizeSearchText(search);

  // Direct substring match
  if (name.includes(term)) return true;

  // Check if the search term matches any alias whose canonical country matches this name
  for (const [alias, countrySet] of aliasToCountry) {
    if (alias.includes(term) && countrySet.has(name)) return true;
  }

  return false;
}
