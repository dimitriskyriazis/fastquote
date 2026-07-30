/**
 * Accent-insensitive text search — shared by the SQL and the browser side.
 *
 * The FastQuote database collation is Greek_CI_AS: case-INsensitive but accent
 * SENSITIVE. Every `LIKE` / `=` on human-language text therefore treats 'έ' and
 * 'ε' as different letters, so searching "ΕΛΛΑΣ" never finds "Ελλάς Μεταφορές"
 * and "ενεργεια" never finds "ΕΝΈΡΓΕΙΑ". SQL's UPPER() does not help — it keeps
 * the accent (UPPER(N'ελλάς') = N'ΕΛΛΆΣ').
 *
 * Greek accents are optional in practice: they are dropped in all-caps writing,
 * omitted on keyboards without a dead key, and inconsistent in imported ERP
 * data. Matching on them makes filters feel broken.
 */

/**
 * Collation used for user-facing text comparisons.
 *
 * Greek_CI_AI folds Greek accents and dialytika (έ=ε, ΐ=ι, ΰ=υ) and final sigma
 * (ς=σ, already covered by CI), while keeping the Greek and Latin alphabets
 * distinct — Greek 'ΑΒΕ' still does not equal Latin 'ABE', so no cross-script
 * false positives. Latin accents fold too (CAFÉ = CAFE).
 */
export const SEARCH_COLLATION = 'Greek_CI_AI';

/**
 * Wraps a SQL text expression so comparisons against it ignore accents.
 *
 * An explicit COLLATE on one operand sets the collation for the whole
 * comparison, so the bound parameter does not need collating as well:
 *   UPPER(ISNULL(p.Description, '')) COLLATE Greek_CI_AI LIKE @term
 *
 * Only for NVARCHAR/NCHAR expressions holding human-language text. Applying it
 * to part numbers, ERP codes or SKUs is harmless but pointless (they are Latin
 * letters and digits), and it must not be applied to non-text expressions.
 */
export const collateSearch = (expression: string): string =>
  `${expression} COLLATE ${SEARCH_COLLATION}`;

/**
 * Strips combining diacritical marks: "Ελλάς" → "Ελλας", "αϊβάλι" → "αιβαλι",
 * "CAFÉ" → "CAFE". Decomposes first so precomposed characters (ά, ΐ, ΰ, é) split
 * into base letter + mark before the marks are removed.
 */
export const foldAccents = (value: string): string =>
  value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Canonical form for comparing two strings in the browser — the JS counterpart
 * of {@link SEARCH_COLLATION}. Folds accents, lowercases, and normalises Greek
 * final sigma so "ΕΛΛΑΣ", "Ελλάς" and "ελλας" all collapse to "ελλασ".
 *
 * Final sigma is normalised explicitly rather than relying on toLowerCase()'s
 * conditional Final_Sigma mapping, which only applies at word boundaries.
 */
export const normalizeSearchText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return foldAccents(String(value)).toLowerCase().replace(/ς/g, 'σ');
};

/**
 * Accent- and case-insensitive substring test. Drop-in replacement for
 * `haystack.toLowerCase().includes(needle.toLowerCase())` in search boxes.
 */
export const searchIncludes = (haystack: unknown, needle: unknown): boolean => {
  const term = normalizeSearchText(needle);
  if (!term) return true;
  return normalizeSearchText(haystack).includes(term);
};

/**
 * Accent- and case-insensitive equality, for matching a typed value against a
 * known list (dropdown options, set-filter entries).
 */
export const searchEquals = (a: unknown, b: unknown): boolean =>
  normalizeSearchText(a) === normalizeSearchText(b);
