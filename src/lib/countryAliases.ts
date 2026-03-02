/**
 * Maps English country name fragments to their Greek equivalents
 * so users can type e.g. "Greece" and find "Ελλάδα".
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
    set.add(country);
  }
}

/**
 * Returns true if `countryName` matches `search` either directly
 * or through a known English alias.
 *
 * Both parameters should be pre-trimmed; the function lowercases internally.
 */
export function matchesCountrySearch(countryName: string, search: string): boolean {
  const nameLower = countryName.toLowerCase();
  const searchLower = search.toLowerCase();

  // Direct substring match
  if (nameLower.includes(searchLower)) return true;

  // Check if the search term matches any alias whose canonical country matches this name
  for (const [alias, countrySet] of aliasToCountry) {
    if (alias.includes(searchLower) && countrySet.has(nameLower)) return true;
  }

  return false;
}
