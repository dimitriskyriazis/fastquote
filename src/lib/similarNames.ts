/**
 * "Similar name" warnings for the create forms: customer, supplier, brand, and
 * contact (indexed as 'FirstName LastName', so a swapped pair of fields, a
 * Latin spelling of a Greek name and a typo are all handled by the same rules).
 *
 * This answers a different question from lib/customerDuplicates. That module
 * asks which EXISTING records duplicate each other; this one asks whether the
 * name a user is typing right now looks like something already on file. It
 * borrows that module's normalisation and word matching wholesale (the parts
 * that were measured against this customer base: Greek/Latin homoglyphs, dotted
 * initialisms, legal-form stopwords, typo tolerance) and adds the two things a
 * one-against-many lookup needs on top. An inverted index, so a check is a few
 * map lookups instead of 11,800 comparisons. And word weights, so that sharing a
 * distinctive word ('MEDIAKIND') counts for more than sharing a generic one
 * ('UK').
 *
 * Why this is not done in SQL. The previous implementation asked SQL Server for
 * candidates with LIKE, SOUNDEX and DIFFERENCE, took TOP 50 with no ORDER BY,
 * and filtered in JavaScript. SOUNDEX only understands Latin letters: every
 * Greek name hashes to '0000', so DIFFERENCE(Name, @name) >= 3 held for all
 * 6,691 Greek-named customers and the "candidates" were 50 arbitrary rows.
 * Latin names fared little better. 'MediaKind UK' matched 154 rows, 145 of them
 * on DIFFERENCE alone, and the arbitrary 50 contained 'Media' twice but not the
 * customer actually named 'MediaKind'.
 */
import {
  RARE_TOKEN_MAX_DF,
  jaccard,
  norm,
  tokens,
  tokensMatch,
  translit,
  translitTokens,
} from './customerDuplicates';

export type NameEntry = {
  id: number;
  name: string | null;
  /** Customers only: the official-name column, compared as a second spelling. */
  brandName?: string | null;
  taxId?: string | null;
  enabled?: boolean | null;
  /** Contacts only: the customer the contact belongs to. */
  customerId?: number | null;
  customerName?: string | null;
};

export type SimilarName = {
  id: number;
  name: string;
  taxId: string | null;
  enabled: boolean | null;
  customerId: number | null;
  customerName: string | null;
  /**
   * Set when the match came through the entry's official-name column rather
   * than its name, so the warning can say why '102 FM' is similar to 'ΕΡΤ ΑΕ'.
   */
  officialName: string | null;
  /** 0 to 1, where 1 is the same name once folded. */
  score: number;
};

export type FindOptions = {
  /** Most matches to return; the best-scoring ones win. Infinity for all. */
  limit?: number;
  /** Lowest score worth showing. */
  minScore?: number;
};

export type SimilarNameSearch = {
  /** The best matches, at most `limit` of them. */
  matches: SimilarName[];
  /** How many entries matched before the limit was applied. */
  total: number;
};

export type SimilarNameIndex = {
  /** How many entries were indexed (rows with an empty name are skipped). */
  size: number;
  find: (needle: string, options?: FindOptions) => SimilarName[];
  /** Like find, but also says how many matches the limit hid. */
  search: (needle: string, options?: FindOptions) => SimilarNameSearch;
};

/**
 * Lowest score worth showing.
 *
 * The score is mostly weighted containment (see `overlap`), so the case this
 * exists for, 'MediaKind UK' against an existing 'MediaKind USA', lands between
 * 0.5 and 0.6 depending on how many other customers carry 'UK' and 'USA'. Names
 * that share only generic words never get this far: they are cut by the
 * evidence rule before any score is computed.
 */
export const SIMILAR_NAME_THRESHOLD = 0.4;

const DEFAULT_LIMIT = 10;

/**
 * Two names whose significant words are identical once the spaces are removed:
 * 'DataTechnica' and 'Data Technica'. Almost certainly the same company, but
 * not quite the same name.
 */
const SQUASHED_MATCH_SCORE = 0.95;

/**
 * A match through the official-name column is one step removed: the entry is
 * called something else. Scores through it are scaled down so that, for the
 * same words, a customer actually NAMED that way ranks first. Measured case:
 * typing 'ΕΡΤ' found 30 regional radio stations whose official name is
 * 'ΕΡΤ Α.Ε' at 1.0, and the customer named 'ΕΡΤ Α.Ε.' (also 1.0) fell outside
 * the ten rows shown because it lost the alphabetical tie-break to 'ΕΡΑ ...'.
 * At 0.9 the stations still show, after every name that contains 'ΕΡΤ' plus
 * one other word (those land between 0.90 and 0.95), which is the order a
 * person would put them in.
 */
const OFFICIAL_NAME_FACTOR = 0.9;

/**
 * Below this, a Greek/Latin spelling match is treated as coincidence. Mirrors
 * the transliteration floor in customerDuplicates.scoreSignature.
 */
const TRANSLIT_MIN_JACCARD = 0.6;
const TRANSLIT_MAX_SCORE = 0.88;

/**
 * Typo budget for a near-miss between two words. customerDuplicates allows two
 * edits on words of eight letters or more, which is right for a merge
 * suggestion a person reviews but not for a warning that pops up while typing:
 * on the live data it offered 'SHOWLUTIONS' for 'Solutions', 'Soluciones' for
 * 'Solutions' and 'Δήμος Θηβαίων' for 'Δήμος Αθηναίων'. One edit still covers
 * the cases that matter (CYPURS/CYPRUS, ΘΕΣΑΛΟΝΙΚΗ/ΘΕΣΣΑΛΟΝΙΚΗ, Telmako/Telmaco).
 */
const MAX_TYPO_EDITS = 1;

/**
 * A word matched with a typo counts a little less than the same word matched
 * exactly, so that 'Κυριαζής Κυριαζής' outranks 'Κυριάκης Κυριάκης' when
 * 'Κυριαζής' is typed. Without this both scored 1.0 and sorted alphabetically.
 * Scaled by the share of the matched words that needed the typo budget.
 */
const NEAR_MISS_PENALTY = 0.1;

/**
 * A word this short cannot be the only thing two names share. 'PA' is rare as
 * a word, and it is what 'P.A. Solutions' and 'ΔΗ.ΡΑ.Λ' have in common once
 * initials are rejoined and homoglyphs folded.
 */
const MIN_ALONE_LENGTH = 3;

/**
 * Words that pass the rarity test in this customer base (only a handful of
 * customers carry 'UK' or 'USA') but name a place or a corporate structure,
 * not a company. They still count towards the overlap of two names; they just
 * cannot be the ONLY thing two names have in common. 'MediaKind UK' must not
 * offer 'Ikegami Electronics UK Ltd'. Kept in both spellings the index uses:
 * run through norm() (Latin folded into Greek homoglyphs) for the plain path,
 * and through translit() (Greek turned into Latin) for the transliterated
 * path. A set built for one path never matches words from the other.
 */
const WEAK_ALONE_WORDS = [
  'UK', 'USA', 'US', 'GB', 'EU', 'UAE', 'EUROPE', 'EUROPEAN', 'INTERNATIONAL',
  'GLOBAL', 'WORLDWIDE', 'GROUP', 'HOLDING', 'HOLDINGS', 'HELLAS', 'HELLENIC',
  'GREECE', 'GREEK', 'CYPRUS', 'ATHENS',
  'ΕΛΛΑΣ', 'ΕΛΛΑΔΑ', 'ΕΛΛΑΔΟΣ', 'ΕΛΛΗΝΙΚΗ', 'ΕΛΛΗΝΙΚΟ', 'ΕΛΛΗΝΙΚΟΣ', 'ΚΥΠΡΟΣ',
  'ΚΥΠΡΟΥ', 'ΑΘΗΝΑ', 'ΑΘΗΝΩΝ', 'ΘΕΣΣΑΛΟΝΙΚΗ', 'ΘΕΣΣΑΛΟΝΙΚΗΣ', 'ΒΟΡΕΙΟΥ',
];
const WEAK_ALONE = new Set(WEAK_ALONE_WORDS.map(norm));
const WEAK_ALONE_TRANSLIT = new Set(WEAK_ALONE_WORDS.map(translit));

type Indexed = {
  entry: NameEntry;
  normName: string;
  /** Significant words run together, for the 'Data Technica' case. */
  squashed: string;
  nameTokens: Set<string>;
  brandTokens: Set<string>;
  nameTranslit: Set<string>;
};

type Pair = [needleToken: string, entryToken: string];

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V): void => {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
};

/**
 * Matches each word of the needle to at most one word of the entry. Exact
 * matches are claimed first so that a typo variant can never steal the word an
 * exact match needed.
 */
const pairTokens = (needle: ReadonlySet<string>, entry: ReadonlySet<string>): Pair[] => {
  const pairs: Pair[] = [];
  const taken = new Set<string>();
  const unmatched: string[] = [];
  for (const a of needle) {
    if (entry.has(a) && !taken.has(a)) {
      taken.add(a);
      pairs.push([a, a]);
    } else {
      unmatched.push(a);
    }
  }
  for (const a of unmatched) {
    for (const b of entry) {
      if (taken.has(b) || !tokensMatch(a, b, MAX_TYPO_EDITS)) continue;
      taken.add(b);
      pairs.push([a, b]);
      break;
    }
  }
  return pairs;
};

export const buildSimilarNameIndex = (entries: readonly NameEntry[]): SimilarNameIndex => {
  const indexed: Indexed[] = [];
  const byNorm = new Map<string, number[]>();
  const bySquashed = new Map<string, number[]>();
  /** Word (from the name or the official name) to the entries carrying it. */
  const plain = new Map<string, number[]>();
  /** Transliterated word to the entries carrying it. */
  const translit = new Map<string, number[]>();

  for (const entry of entries) {
    const normName = norm(entry.name);
    if (!normName) continue;
    const nameTokens = tokens(entry.name);
    const brandTokens = tokens(entry.brandName);
    const nameTranslit = translitTokens(entry.name);
    const squashed = Array.from(nameTokens).join('');
    const position = indexed.length;
    indexed.push({ entry, normName, squashed, nameTokens, brandTokens, nameTranslit });

    pushTo(byNorm, normName, position);
    if (squashed) pushTo(bySquashed, squashed, position);
    for (const token of new Set([...nameTokens, ...brandTokens])) pushTo(plain, token, position);
    for (const token of nameTranslit) pushTo(translit, token, position);
  }

  // Grouped by length so a typo scan only visits words that could be within
  // the edit budget, instead of the whole vocabulary.
  const vocabularyByLength = new Map<number, string[]>();
  for (const token of plain.keys()) pushTo(vocabularyByLength, token.length, token);

  const total = indexed.length;

  /** How many entries use a word. The bucket size IS the corpus statistic. */
  const df = (token: string): number => plain.get(token)?.length ?? 0;
  const translitDf = (token: string): number => translit.get(token)?.length ?? 0;

  /**
   * Inverse document frequency. A word nobody else uses weighs the most, which
   * is also what a word the user typed and no entry has should weigh: it is a
   * distinctive word that the entry lacks.
   */
  const weight = (token: string): number => Math.log(1 + total / Math.max(1, df(token)));

  /**
   * Whether the words two names share are enough to say they might be the same
   * company. Two shared words are always enough: the combination is the
   * evidence. One shared word is enough when it is the whole of both names
   * ('Alpha' against 'Alpha SA'), or when it is a real, distinctive word: long
   * enough, not a place or a legal structure, and rare. One shared COMMON word
   * with more on the NEEDLE side is not: typing 'Alpha Bank' is not a warning
   * about the one-word customer 'Alpha', nor about the other 44 names that
   * reuse the word.
   *
   * The other way round, one shared word that is the whole of what was typed,
   * is enough even when the word is common, as long as it is exact and a real
   * word (same length and place/structure tests as above). This is a warning
   * shown while typing: someone who has typed 'ANTENNA' should see 'Antenna
   * TV' and 'ANTENNA Internet S.A.' now, not only the three one-word Antenna
   * customers. Before this rule the answer depended on how many customers
   * carried the word: 'Vodafone' (7 of them) listed every Vodafone office,
   * 'ANTENNA' (19) and 'ΕΡΤ' (41) listed almost nothing.
   *
   * A lone near-miss is only enough when it is the whole of both names
   * ('Telmako' against 'TELMACO AE'). Under a longer name it is not: on the
   * live data 'Data Technica' pulled in 'Panasonic Technics', 'FISCOP-TECNICA'
   * and four 'Technical' companies, each on one fuzzy word that happened to be
   * rare. The real 'DataTechnica' still matches, as an exact word.
   */
  const carriesEvidence = (
    pairs: readonly Pair[],
    needleSize: number,
    entrySize: number,
    rarity: (token: string) => number,
    weak: ReadonlySet<string>,
  ): boolean => {
    if (pairs.length >= 2) return true;
    if (pairs.length !== 1) return false;
    if (needleSize === 1 && entrySize === 1) return true;
    const [a, b] = pairs[0];
    if (a !== b) return false;
    if (b.length < MIN_ALONE_LENGTH || weak.has(b)) return false;
    if (needleSize === 1) return true;
    return rarity(b) <= RARE_TOKEN_MAX_DF;
  };

  /**
   * Weighted overlap of two word sets, 0 to 1.
   *
   * Mostly containment (how much of the shorter name's weight the other name
   * covers) because that is what a warning is for: typing 'MediaKind UK
   * Broadcast Services' when 'MediaKind' is on file should warn, even though
   * Jaccard would call them one word in four. A little Jaccard is blended in so
   * that, among names that fully contain what was typed, the one with nothing
   * extra ranks first.
   */
  const overlap = (needle: ReadonlySet<string>, entry: ReadonlySet<string>): number => {
    if (!needle.size || !entry.size) return 0;
    const pairs = pairTokens(needle, entry);
    if (!carriesEvidence(pairs, needle.size, entry.size, df, WEAK_ALONE)) return 0;

    const matchedNeedle = new Set(pairs.map(([a]) => a));
    let shared = 0;
    for (const [, b] of pairs) shared += weight(b);
    let needleTotal = shared;
    for (const a of needle) if (!matchedNeedle.has(a)) needleTotal += weight(a);
    let entryTotal = 0;
    for (const b of entry) entryTotal += weight(b);

    const containment = Math.max(shared / needleTotal, shared / entryTotal);
    const weightedJaccard = shared / (needleTotal + entryTotal - shared);
    const nearMisses = pairs.filter(([a, b]) => a !== b).length;
    return (0.85 * containment + 0.15 * weightedJaccard) * (1 - (NEAR_MISS_PENALTY * nearMisses) / pairs.length);
  };

  /**
   * The same company spelt in the other alphabet: 'Miravox' against
   * 'ΜΙΡΑΒΟΞ'. Whole words only, which is what keeps this from the flood that
   * sank cross-script substring search (see lib/textSearch foldForSearch).
   */
  const translitOverlap = (needle: ReadonlySet<string>, entry: ReadonlySet<string>): number => {
    if (!needle.size || !entry.size) return 0;
    const pairs = pairTokens(needle, entry);
    if (!carriesEvidence(pairs, needle.size, entry.size, translitDf, WEAK_ALONE_TRANSLIT)) return 0;
    const j = jaccard(needle, entry);
    // Everything typed is in the entry ('Kyriazis' against 'Δημήτρης
    // Κυριαζής'): enough on its own, as it is for the plain path. Otherwise the
    // two names must mostly agree.
    if (pairs.length === needle.size) return Math.min(TRANSLIT_MAX_SCORE, 0.85 + 0.15 * j);
    return j >= TRANSLIT_MIN_JACCARD ? Math.min(TRANSLIT_MAX_SCORE, j) : 0;
  };

  /** Words in the vocabulary that are a typo away from the given one. */
  const typoVariants = (token: string): string[] => {
    const variants: string[] = [];
    for (let length = token.length - MAX_TYPO_EDITS; length <= token.length + MAX_TYPO_EDITS; length += 1) {
      for (const candidate of vocabularyByLength.get(length) ?? []) {
        if (candidate !== token && tokensMatch(token, candidate, MAX_TYPO_EDITS)) variants.push(candidate);
      }
    }
    return variants;
  };

  const search = (needle: string, options: FindOptions = {}): SimilarNameSearch => {
    const limit = options.limit ?? DEFAULT_LIMIT;
    const minScore = options.minScore ?? SIMILAR_NAME_THRESHOLD;

    const needleNorm = norm(needle);
    if (!needleNorm) return { matches: [], total: 0 };
    const needleTokens = tokens(needle);
    const needleSquashed = Array.from(needleTokens).join('');
    const needleTranslit = translitTokens(needle);

    // --- blocking: only entries that share something with the needle --------
    const candidates = new Set<number>();
    const gather = (positions: number[] | undefined) => {
      if (positions) for (const position of positions) candidates.add(position);
    };
    gather(byNorm.get(needleNorm));
    if (needleSquashed) gather(bySquashed.get(needleSquashed));
    for (const token of needleTokens) {
      gather(plain.get(token));
      for (const variant of typoVariants(token)) gather(plain.get(variant));
    }
    for (const token of needleTranslit) gather(translit.get(token));

    // --- scoring ------------------------------------------------------------
    const results: SimilarName[] = [];
    for (const position of candidates) {
      const item = indexed[position];
      let score: number;
      let officialName: string | null = null;
      if (item.normName === needleNorm) {
        score = 1;
      } else {
        score = needleSquashed && item.squashed === needleSquashed ? SQUASHED_MATCH_SCORE : 0;
        score = Math.max(score, overlap(needleTokens, item.nameTokens));
        if (item.brandTokens.size) {
          const viaOfficialName = OFFICIAL_NAME_FACTOR * overlap(needleTokens, item.brandTokens);
          if (viaOfficialName > score) {
            score = viaOfficialName;
            officialName = item.entry.brandName ?? null;
          }
        }
        const viaTranslit = translitOverlap(needleTranslit, item.nameTranslit);
        if (viaTranslit > score) {
          score = viaTranslit;
          officialName = null;
        }
      }
      if (score < minScore) continue;
      results.push({
        id: item.entry.id,
        name: item.entry.name ?? '',
        taxId: item.entry.taxId ?? null,
        enabled: item.entry.enabled ?? null,
        customerId: item.entry.customerId ?? null,
        customerName: item.entry.customerName ?? null,
        officialName,
        score,
      });
    }

    // Best first; among equals, live records before disabled ones.
    results.sort((a, b) =>
      b.score - a.score
      || Number(b.enabled !== false) - Number(a.enabled !== false)
      || a.name.localeCompare(b.name),
    );
    return { matches: results.slice(0, limit), total: results.length };
  };

  const find = (needle: string, options?: FindOptions): SimilarName[] => search(needle, options).matches;

  return { size: total, find, search };
};
