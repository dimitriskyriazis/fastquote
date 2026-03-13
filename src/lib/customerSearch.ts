import sql from 'mssql';
import type { ConnectionPool } from 'mssql';

export type CustomerMatch = {
  TRDR: number;
  CODE: string | null;
  NAME: string | null;
};

/**
 * Latin-to-Greek transliteration map for common business name words.
 * Covers uppercase Greek equivalents that SoftOne ERP typically stores.
 */
const LATIN_TO_GREEK: Record<string, string> = {
  'motor': 'ΜΟΤΟΡ',
  'oil': 'ΟΪΛ',
  'hellas': 'ΕΛΛΑΣ',
  'greece': 'ΕΛΛΑΔ',
  'electric': 'ΗΛΕΚΤΡΙΚ',
  'energy': 'ΕΝΕΡΓΕΙΑ',
  'tech': 'ΤΕΚ',
  'system': 'ΣΥΣΤΗΜ',
  'service': 'ΣΕΡΒΙΣ',
  'group': 'ΓΚΡΟΥΠ',
  'international': 'ΙΝΤΕΡΝΑΣΙΟΝΑΛ',
};

/**
 * Strips Greek diacritical marks (accents) from a string.
 * E.g., "Ελλάς" → "Ελλας", "ΕΝΈΡΓΕΙΑ" → "ΕΝΕΡΓΕΙΑ"
 */
function stripGreekAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Generates fuzzy search terms from a customer name.
 * Includes original words, accent-stripped variants, uppercase versions,
 * and Latin-to-Greek transliterations.
 */
export function buildFuzzyTerms(customerName: string): string[] {
  const words = customerName.split(/[\s,.]+/).filter(w => w.length > 2);
  const terms = new Set<string>();

  for (const word of words.slice(0, 4)) {
    // Original word
    terms.add(word);
    // Uppercase
    terms.add(word.toUpperCase());
    // Accent-stripped
    const stripped = stripGreekAccents(word);
    terms.add(stripped);
    terms.add(stripped.toUpperCase());
    // Latin-to-Greek transliteration
    const greekEquiv = LATIN_TO_GREEK[word.toLowerCase()];
    if (greekEquiv) {
      terms.add(greekEquiv);
    }
  }

  // Deduplicate and return (Set handles it)
  return Array.from(terms);
}

/**
 * Fuzzy customer search on dbo.TRDR using LIKE with multiple terms.
 * Tries each term separately and deduplicates results by TRDR.
 */
export async function fuzzyCustomerSearch(
  erpPool: ConnectionPool,
  customerName: string,
): Promise<CustomerMatch[]> {
  const terms = buildFuzzyTerms(customerName);
  const seen = new Set<number>();
  const matches: CustomerMatch[] = [];

  for (const term of terms) {
    if (matches.length >= 20) break;
    const result = await erpPool
      .request()
      .input('FuzzyTerm', sql.NVarChar(200), `%${term}%`)
      .query<CustomerMatch>(`
        SELECT TOP (10) TRDR, CODE, NAME
        FROM dbo.TRDR
        WHERE NAME LIKE @FuzzyTerm
        ORDER BY NAME
      `);
    for (const row of result.recordset ?? []) {
      if (!seen.has(row.TRDR)) {
        seen.add(row.TRDR);
        matches.push(row);
      }
    }
  }

  return matches;
}
