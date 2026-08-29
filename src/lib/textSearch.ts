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
 * Punctuation-insensitive text search — the second half of "type it however you
 * like and still find it", alongside {@link SEARCH_COLLATION}.
 *
 * Company names carry punctuation that nobody types when searching: "P.A.
 * Solutions", "A.E." / "S.A." legal suffixes (19% of stored customer names hold
 * a dot), "AT&T", "Coca-Cola", "Telmaco (Hellas)". A plain LIKE treats those
 * marks as letters, so "PA Solutions" never finds "P.A. Solutions".
 *
 * Folding drops the marks on BOTH sides of the comparison, so it works whichever
 * side has them: typing "PA" finds "P.A.", and typing "P.A." finds "PA".
 *
 * Whitespace is deliberately NOT folded. Dropping it as well would let a term
 * match across a word boundary ("aso" hitting "Alpha Solutions"), and — because
 * almost every stored value contains a space — it would also defeat the cheap
 * has-punctuation guard that keeps {@link foldPunctuationSql} affordable.
 */
// Kept deliberately short — the SQL fold below is a REPLACE per character, so
// every entry is paid on every candidate row. These sixteen are the marks that
// actually occur in the stored names, codes and places (a survey of Customers,
// Contacts and Brands); the ones left out — '?', '\', the typographic quotes,
// the em dash — appear in single digits or not at all.
const SEARCH_PUNCTUATION = [
  '.', ',', ';', ':', '!',
  "'", '’', '"',
  '–', '_',
  '/', '&', '+', '(', ')',
  '-',
] as const;

// '-' sits last in the set, so the character class reads it as a literal rather
// than the start of a range.
const SEARCH_PUNCTUATION_REGEX = new RegExp(`[${SEARCH_PUNCTUATION.join('')}]`, 'g');

/**
 * Strips search punctuation: "P.A. Solutions" → "PA Solutions", "AT&T" → "ATT".
 * The JS counterpart of {@link foldPunctuationSql} — the two must stay in sync,
 * because a term folded here is compared against a column folded there.
 */
export const foldPunctuation = (value: string): string =>
  value.replace(SEARCH_PUNCTUATION_REGEX, '');

/**
 * SQL mirror of {@link foldPunctuation}: a nested REPLACE chain.
 *
 * REPLACE rather than TRANSLATE — TRANSLATE costs ~15x a plain LIKE on this
 * data (it is O(rows x charset)), while the whole REPLACE chain costs ~4x, and
 * the guard below removes most of even that.
 */
export const foldPunctuationSql = (expression: string): string =>
  SEARCH_PUNCTUATION.reduce(
    (expr, ch) => `REPLACE(${expr}, N'${ch === "'" ? "''" : ch}', N'')`,
    expression,
  );

// Derived from the same set so the guard can never fall behind the fold: '-'
// moves last so LIKE reads it as a literal rather than a range, and the
// apostrophe is doubled for the surrounding SQL string literal. Brackets are
// not in the set — T-SQL cannot express a literal ']' inside a LIKE class
// without an ESCAPE clause.
const SEARCH_PUNCTUATION_LIKE_CLASS = `${SEARCH_PUNCTUATION
  .filter((ch) => ch !== '-')
  .map((ch) => (ch === "'" ? "''" : ch))
  .join('')}-`;

/**
 * Cheap "is this row even affected by folding?" test, used to skip the REPLACE
 * chain for the rows that hold no punctuation at all (~70% of customer names).
 */
export const hasPunctuationSql = (expression: string): string =>
  `${expression} LIKE N'%[${SEARCH_PUNCTUATION_LIKE_CLASS}]%'`;

/**
 * Everything the browser side folds before comparing: accents, case, Greek final
 * sigma and punctuation. The JS twin of the grid's SQL predicate, and the single
 * definition behind both {@link searchIncludes} and AG Grid's client-side text
 * filters — so a search box and a column filter never disagree.
 */
/**
 * Everything the browser side folds before comparing: accents, case, Greek final
 * sigma and punctuation. The JS twin of the grid's SQL predicate, and the single
 * definition behind both {@link searchIncludes} and AG Grid's client-side text
 * filters — so a search box and a column filter never disagree.
 *
 * Deliberately does NOT fold Latin/Greek homoglyphs, so 'ote' does not match
 * 'ΟΤΕ' here. That was built and measured on the live data, and reverted: with
 * substring matching, folding the two alphabets together floods short queries.
 * 'kapa' went from 3 hits to 70, of which 67 were Greek 'Καρα-' surnames
 * (Καραγιάννης, Καραχάλιος, Καραμπάτζου...) and none was the 'Kapa Studios' the
 * user wanted; 'ote' picked up Αριστοτέλειο, Ελληνοτεχνική, ΒΙΟΤΕΡ. The real
 * cross-script cases are acronyms — ΟΤΕ, ΔΕΗ, ΕΡΤ — so making it pay would need
 * whole-word anchoring, which in T-SQL LIKE means character classes spanning
 * both alphabets in the hottest query path in the app.
 *
 * Where cross-script matching genuinely earns its keep — deciding whether two
 * CUSTOMERS are the same company — it lives in lib/customerDuplicates.ts, which
 * compares whole tokens rather than substrings and so does not have this
 * problem.
 */
export const foldForSearch = (value: unknown): string =>
  foldPunctuation(normalizeSearchText(value));

/**
 * Accent-, case- AND punctuation-insensitive substring test. Drop-in
 * replacement for `haystack.toLowerCase().includes(needle.toLowerCase())` in
 * search boxes: "pa solutions" finds "P.A. Solutions".
 */
export const searchIncludes = (haystack: unknown, needle: unknown): boolean => {
  const term = foldForSearch(needle);
  if (!term) return true;
  return foldForSearch(haystack).includes(term);
};

/**
 * Accent- and case-insensitive equality, for resolving a typed value to exactly
 * one entry of a known list (dropdown options, set-filter entries). Deliberately
 * NOT punctuation-insensitive, for the same reason set filters are not: this
 * decides which single option a value IS, and folding "St. Kitts" onto
 * "St Kitts" would let it answer for a row it does not represent.
 */
export const searchEquals = (a: unknown, b: unknown): boolean =>
  normalizeSearchText(a) === normalizeSearchText(b);

