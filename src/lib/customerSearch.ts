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
 * Drops inactive customers (TRDR.ISACTIVE = 0) and any rows outside the
 * primary company (COMPANY <> 1) from a set of matches. Used to post-filter
 * results returned by stored procedures that don't expose these columns.
 */
export async function filterActiveCustomers(
  erpPool: ConnectionPool,
  matches: CustomerMatch[],
): Promise<CustomerMatch[]> {
  if (matches.length === 0) return matches;
  const ids = Array.from(new Set(matches.map(m => m.TRDR)));
  const placeholders = ids.map((_, i) => `@id${i}`).join(', ');
  const req = erpPool.request();
  ids.forEach((id, i) => req.input(`id${i}`, sql.Int, id));
  const res = await req.query<{ TRDR: number }>(`
    SELECT TRDR FROM dbo.TRDR WHERE ISACTIVE = 1 AND COMPANY = 1 AND TRDR IN (${placeholders})
  `);
  const active = new Set((res.recordset ?? []).map(r => r.TRDR));
  return matches.filter(m => active.has(m.TRDR));
}

/**
 * Unified customer lookup via the ERP stored procedure tlm.FindCustomer.
 * The procedure handles the matching (code / name / tax id); results are then
 * filtered down to active customers in the primary company.
 */
export async function findCustomerViaProc(
  erpPool: ConnectionPool,
  searchValue: string,
): Promise<CustomerMatch[]> {
  const trimmed = searchValue.trim();
  if (!trimmed) return [];

  const result = await erpPool
    .request()
    .input('SearchValue', sql.NVarChar(200), trimmed)
    .query<CustomerMatch>(`EXEC tlm.FindCustomer @SearchValue = @SearchValue`);

  return filterActiveCustomers(erpPool, result.recordset ?? []);
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
        WHERE NAME LIKE @FuzzyTerm AND ISACTIVE = 1 AND COMPANY = 1
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
