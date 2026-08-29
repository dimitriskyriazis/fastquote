/**
 * Duplicate-customer detection for the admin merge tool.
 *
 * The text-matching core here is a faithful TypeScript port of the matcher in
 * scripts/sql/payment-terms-match-lib.cjs, which was written for — and proven
 * against — this exact customer base (Greek names, mixed Greek/Latin homoglyphs,
 * ERP-imported spellings). Do not "improve" the normalisation without re-checking
 * it against that script: the two are meant to agree.
 *
 * The problem shape is different in one important way, though. That script maps
 * an EXTERNAL row onto a FastQuote customer (source -> target). Here both sides
 * are dbo.Customers, so it is a self-join: every pair is a candidate, which is
 * ~70 million comparisons over 11,814 customers if done naively. It is instead
 * done with blocking (only compare customers that share a rare token, a tax id,
 * an ERP id, or an exact normalised name), then the surviving pairs are scored
 * and clustered.
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Latin letters that are visually identical to Greek ones. The customer base
 * mixes them freely (TE vs ΤΕ, KK vs ΚΚ, OT vs ΟΤ) — usually because a name was
 * typed on a Greek keyboard layout by one person and a Latin one by another —
 * so Latin is folded INTO Greek before anything is compared.
 */
const HOMOGLYPH: Record<string, string> = {
  A: 'Α', B: 'Β', E: 'Ε', H: 'Η', I: 'Ι', K: 'Κ', M: 'Μ',
  N: 'Ν', O: 'Ο', P: 'Ρ', T: 'Τ', X: 'Χ', Y: 'Υ', Z: 'Ζ',
};

/** Combining diacritics plus the standalone Greek tonos/dialytika marks. */
const COMBINING_MARKS = /[̀-ͯ΄΅]/g;

/**
 * Joins runs of consecutive single-character words back into one word, so that
 * dotted initials survive punctuation stripping: 'P.A. SOLUTIONS' becomes
 * 'PA SOLUTIONS' rather than 'P A SOLUTIONS', and 'Α.Ε.' becomes 'ΑΕ' (which the
 * legal-form stopword list can then recognise).
 *
 * Without this, 'P.A. SOLUTIONS LTD' and 'PA SOLUTIONS' normalise differently
 * and share no comparable initials — a real pair in this database that went
 * undetected. An ISOLATED single letter is left exactly as it was: only a run of
 * two or more is an initialism.
 */
const collapseInitialRuns = (words: readonly string[]): string[] => {
  const out: string[] = [];
  let run: string[] = [];
  const flush = () => {
    if (run.length === 0) return;
    out.push(run.length > 1 ? run.join('') : run[0]);
    run = [];
  };
  for (const word of words) {
    if (word.length === 1) {
      run.push(word);
      continue;
    }
    flush();
    out.push(word);
  }
  flush();
  return out;
};

/**
 * Canonical comparison form: uppercased, accent-stripped, homoglyph-folded,
 * reduced to letters/digits separated by single spaces, with dotted initialisms
 * rejoined.
 */
export const norm = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  let text = String(value).toUpperCase();
  text = text.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
  text = text.replace(/Ί/g, 'Ι').replace(/Ϊ/g, 'Ι').replace(/Ϋ/g, 'Υ');
  text = Array.from(text).map((ch) => HOMOGLYPH[ch] ?? ch).join('');
  const words = text.replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return collapseInitialRuns(words).join(' ');
};

/** Legal-form and filler words that carry no identifying signal. */
const STOPWORDS = new Set([
  'ΑΕ', 'ΑΕΒΕ', 'ΕΠΕ', 'ΙΚΕ', 'ΟΕ', 'ΕΕ', 'ΑΤΕ', 'ΜΕΠΕ',
  'ΜΟΝΟΠΡΟΣΩΠΗ', 'ΑΝΩΝΥΜΗ', 'ΑΝΩΝΥΜΟΣ', 'ΕΤΑΙΡΕΙΑ', 'ΕΤΑΙΡΙΑ',
  'ΙΔΙΩΤΙΚΗ', 'ΚΕΦΑΛΑΙΟΥΧΙΚΗ', 'ΚΑΙ', 'ΣΙΑ', 'ΤΟΥ', 'ΤΗΣ',
  'LTD', 'LIMITED', 'SA', 'THE', 'OF', 'AND', 'GMBH', 'BV', 'SPA',
  'SRL', 'INC', 'PLC', 'CO', 'DOO',

  // Further legal forms seen in the BrandName column, which in this database is
  // as often a description of the entity as it is an official name. Without
  // these, three unrelated non-profits filed as 'Αστική μη κερδοσκοπική'
  // matched each other on their legal form alone.
  'ΑΣΤΙΚΗ', 'ΚΕΡΔΟΣΚΟΠΙΚΗ', 'ΜΚΟ', 'ΣΥΝΕΤΑΙΡΙΣΜΟΣ',
  // 'Ιδιώτης' (= private individual) is a category the BrandName column is used
  // to record, not a name: two unrelated people both filed under it matched.
  'ΙΔΙΩΤΗΣ', 'ΙΔΙΩΤΕΣ',

  // Articles, particles and prepositions. These only became significant when
  // MIN_TOKEN_LENGTH dropped to 2 to let initialisms through, which promoted
  // every two-letter Greek article into a matchable "word". Latin homoglyphs
  // fold into Greek before the lookup, so 'TO' and 'ΤΟ' need only one entry.
  'ΤΟ', 'ΤΑ', 'ΟΙ', 'ΤΗ', 'ΤΗΝ', 'ΤΟΝ', 'ΤΩΝ', 'ΣΤΟ', 'ΣΤΑ', 'ΣΤΗ', 'ΣΤΗΝ',
  'ΣΤΟΝ', 'ΣΤΩΝ', 'ΓΙΑ', 'ΜΕ', 'ΜΗ', 'ΑΠΟ', 'ΠΡΟΣ', 'ΕΝΑ', 'ΜΙΑ',
  'IN', 'ON', 'AT', 'FOR', 'BY', 'DE', 'LA', 'EL', 'DEL', 'VAN', 'DER',
]);

/** Legal forms as they come out of transliteration (ΑΕ -> AE, ΕΠΕ -> EPE, ...). */
const LATIN_STOPWORDS = new Set([
  'AE', 'AEVE', 'EPE', 'IKE', 'OE', 'EE', 'ATE', 'MEPE', 'MONOPROSOPI',
  'MONOPROSOPPI', 'ANONYMI', 'ANONYMOS', 'ETAIREIA', 'ETAIRIA', 'IDIOTIKI',
  'KEFALAIOYCHIKI', 'KAI', 'SIA', 'LTD', 'LIMITED', 'THE', 'AND',
]);

/**
 * The stopword list as it looks AFTER norm() has run.
 *
 * This matters and is easy to miss: norm() folds Latin homoglyphs into Greek, so
 * 'LTD' normalises to 'LΤD' with a Greek tau — which never equalled the Latin
 * 'LTD' literal in STOPWORDS. Every Latin legal form was therefore silently
 * kept as a significant word: 'LTD' was scoring as a real token in 306
 * customers, which is what stopped 'P.A. SOLUTIONS LTD' from matching
 * 'PA SOLUTIONS'. Normalising the list itself fixes all of them at once.
 */
const NORMALIZED_STOPWORDS = new Set(Array.from(STOPWORDS, (word) => norm(word)));

/**
 * Shortest word treated as significant. Two characters rather than three so
 * that an initialism survives — 'PA', 'CS', 'ΟΤΕ' — because after
 * collapseInitialRuns those carry most of what distinguishes 'PA Solutions'
 * from 'C&S Solutions'.
 */
const MIN_TOKEN_LENGTH = 2;

/** Significant words of a name: long enough to matter, and not a legal form. */
export const tokens = (value: unknown): Set<string> =>
  new Set(
    norm(value)
      .split(' ')
      .filter((w) => w.length >= MIN_TOKEN_LENGTH && !NORMALIZED_STOPWORDS.has(w)),
  );

export const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
};

/** Fraction of a's tokens present in b. Asymmetric on purpose. */
export const containment = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  if (!a.size) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  return intersection / a.size;
};

/**
 * 'United Nations Economic Commission For Africa' -> 'UNECA'.
 *
 * Deliberately keeps the 3-character floor that tokens() relaxed: an acronym
 * built from two-letter words ('PA Solutions' -> 'PS') is noise, not a name.
 */
export const acronym = (value: unknown): string =>
  norm(value)
    .split(' ')
    .filter((w) => w.length > 2 && !NORMALIZED_STOPWORDS.has(w))
    .map((w) => w[0])
    .join('');

/**
 * Greek -> Latin sound transliteration. A different problem from homoglyphs:
 * folding look-alike letters cannot connect 'ΜΙΡΑΒΟΞ' to 'MIRAVOX' (Β=V, Ρ=R,
 * Ξ=X). Collisions (Η/Ι -> I, Ο/Ω -> O) are fine and even helpful here.
 */
const GREEK_TO_LATIN: Record<string, string> = {
  Α: 'A', Β: 'V', Γ: 'G', Δ: 'D', Ε: 'E', Ζ: 'Z', Η: 'I', Θ: 'TH', Ι: 'I',
  Κ: 'K', Λ: 'L', Μ: 'M', Ν: 'N', Ξ: 'X', Ο: 'O', Π: 'P', Ρ: 'R', Σ: 'S',
  Τ: 'T', Υ: 'Y', Φ: 'F', Χ: 'CH', Ψ: 'PS', Ω: 'O', ς: 'S',
};

/**
 * Works from the RAW string, not from norm() — norm folds Latin into Greek,
 * which would undo the point of transliterating the other way.
 */
export const translit = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  let text = String(value).toUpperCase();
  text = text.normalize('NFD').replace(COMBINING_MARKS, '').normalize('NFC');
  text = Array.from(text).map((ch) => GREEK_TO_LATIN[ch] ?? ch).join('');
  const words = text.replace(/[^A-Z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  return collapseInitialRuns(words).join(' ');
};

/**
 * The stopword lists as they look AFTER translit() has run — the mirror of
 * NORMALIZED_STOPWORDS for the other alphabet. A Greek legal form comes out of
 * transliteration in Latin letters ('ΑΣΤΙΚΗ' -> 'ASTIKI', 'ΙΔΙΩΤΗΣ' ->
 * 'IDIOTIS'), so matching the raw Greek list here would never fire and the
 * transliterated path would happily match two companies on their legal form.
 */
const TRANSLIT_STOPWORDS = new Set([
  ...Array.from(STOPWORDS, (word) => translit(word)),
  ...Array.from(LATIN_STOPWORDS, (word) => translit(word)),
]);

export const translitTokens = (value: unknown): Set<string> =>
  new Set(
    translit(value)
      .split(' ')
      .filter((w) => w.length >= MIN_TOKEN_LENGTH && !TRANSLIT_STOPWORDS.has(w)),
  );

export const digitsOnly = (value: unknown): string => String(value ?? '').replace(/\D/g, '');

/**
 * Canonical tax id for comparison.
 *
 * Leading zeros are dropped because the same Greek ΑΦΜ is stored both ways in
 * this database — '090000045' and '90000045' are both present and are the same
 * entity, as are '094019245' and '94019245'. Returns '' for anything too short
 * to identify a company.
 */
export const normalizeTaxId = (value: unknown): string => {
  const digits = digitsOnly(value).replace(/^0+/, '');
  return digits.length >= 7 ? digits : '';
};

/**
 * Soft1 uses repeated-digit placeholders (999999999, 000000000) for foreign and
 * institutional accounts. Every such account shares the value, so matching on
 * one would merge unrelated customers.
 */
export const isPlaceholderTaxId = (value: unknown): boolean => {
  const digits = digitsOnly(value);
  return digits.length >= 7 && new Set(digits).size === 1;
};

// ---------------------------------------------------------------------------
// Input / output shapes
// ---------------------------------------------------------------------------

export type DuplicateScanCustomer = {
  CustomerID: number;
  Name: string | null;
  BrandName: string | null;
  TaxID: string | null;
  ERPID: number | null;
  City: string | null;
  Email: string | null;
  Phone: string | null;
  Enabled: boolean | number | null;
  IsParent: boolean | number | null;
  OfferCount: number;
  ContactCount: number;
};

export type DuplicateConfidence = 'high' | 'medium' | 'low';

export type DuplicateGroup = {
  /** Stable identity for the group, derived from its member ids. */
  key: string;
  confidence: DuplicateConfidence;
  /** Best pair score inside the group, 0..1. */
  score: number;
  reasons: string[];
  /** Suggested survivor, first; the rest are suggested secondaries. */
  suggestedPrimaryId: number;
  members: DuplicateScanCustomer[];
};

export type DuplicateScanOptions = {
  /**
   * Skip customers already disabled. On by default: merging disables the
   * secondary, so leaving them in would resurface every completed merge as a
   * fresh suggestion forever.
   */
  enabledOnly?: boolean;
  /**
   * Skip IsParent group headers ('OTE Group' and friends). On by default —
   * a header legitimately shares its name with its children and is never the
   * same record as one of them.
   */
  excludeParents?: boolean;
  /** Minimum pair score for a fuzzy name match to be reported at all. */
  minScore?: number;
  /** Hard cap on reported groups, best-scoring first. */
  limit?: number;
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Fuzzy-name floor, matching FUZZY_THRESHOLD in the payment-terms matcher. */
export const FUZZY_THRESHOLD = 0.6;

/** Score at or above which a fuzzy name match is treated as medium confidence. */
const MEDIUM_THRESHOLD = 0.8;

/**
 * A token appearing in more customers than this is treated as non-identifying
 * for BLOCKING purposes only ('ΠΑΝΕΠΙΣΤΗΜΙΟ', 'ΕΛΛΑΣ', 'GROUP'). It still counts
 * in the score once a pair is on the table — it just cannot be the reason the
 * pair was considered. Without this, common words alone produce millions of
 * worthless candidate pairs.
 */
const MAX_BLOCKING_DF = 120;

/**
 * An exact-name group at least this big, whose members do not corroborate each
 * other with a shared tax id, is reported for review rather than as a confident
 * duplicate set. Both things that look like this in the real data deserve that
 * treatment: 'Αριστοτέλειο Πανεπιστήμιο Θεσσαλονίκης' (12 records, genuinely one
 * university) and 'Αρχιτέκτονας-Διακοσμητής' (12 records, a PROFESSION typed
 * into the name field of unrelated customers).
 */
const GENERIC_NAME_GROUP_SIZE = 8;

/**
 * Sanity cap on a hard-linked group. Tax-id groups in the live data top out at
 * 7 members, so this never fires today; it exists so that a junk default value
 * imported into thousands of rows tomorrow surfaces as a flagged anomaly rather
 * than as a merge suggestion spanning half the customer base.
 */
const MAX_GROUP_SIZE = 25;

/** One comparable spelling of a company: its plain and transliterated words. */
type Signature = { t: Set<string>; tl: Set<string> };

type Enriched = DuplicateScanCustomer & {
  /** Name and BrandName kept apart — see the comment on scorePair. */
  name: Signature;
  brand: Signature;
  /** Union of both, used only to decide which pairs are worth comparing. */
  t: Set<string>;
  tl: Set<string>;
  acr: string;
  normName: string;
  taxKey: string;
};

type PairScore = { score: number; reasons: string[] };

const enrich = (customer: DuplicateScanCustomer): Enriched => {
  const name: Signature = {
    t: tokens(customer.Name),
    tl: translitTokens(customer.Name),
  };
  const brand: Signature = {
    t: tokens(customer.BrandName),
    tl: translitTokens(customer.BrandName),
  };
  return {
    ...customer,
    name,
    brand,
    t: new Set([...name.t, ...brand.t]),
    tl: new Set([...name.tl, ...brand.tl]),
    acr: acronym(customer.Name),
    normName: norm(customer.Name),
    taxKey: isPlaceholderTaxId(customer.TaxID) ? '' : normalizeTaxId(customer.TaxID),
  };
};

/**
 * How many customers a word has to be confined to before a match resting on
 * that word ALONE is believable.
 *
 * One shared word is only evidence when the word is distinctive. 'ΣΥΝΕΔΡΙΟ' and
 * 'Connecting' are unrelated magazines that both carry the official name
 * 'Περιοδικό' (= "magazine"); 'ΤΕΧΝΙΚΗ Α.Τ.Ε.' and 'Δ. ΣΥΚΑΣ Α.Ε.' meet only on
 * 'ΤΕΧΝΙΚΗ' (= "technical"). Both scored a perfect 1.0 on a single generic word.
 * Two or more shared words need no such test — the combination is the evidence.
 */
const RARE_TOKEN_MAX_DF = 8;

/**
 * How widely a word is used across the customer base. Defaults to treating
 * every word as distinctive, which is the right behaviour for a caller scoring
 * one pair in isolation with no corpus to measure against.
 */
export type TokenRarity = {
  isRarePlain: (token: string) => boolean;
  isRareTranslit: (token: string) => boolean;
};

const EVERYTHING_RARE: TokenRarity = {
  isRarePlain: () => true,
  isRareTranslit: () => true,
};

/** Do the words these two spellings share actually identify a company? */
const carriesEvidence = (
  shared: readonly string[],
  isRare: (token: string) => boolean,
): boolean => shared.length >= 2 || (shared.length === 1 && isRare(shared[0]));

/** Scores one spelling of a company against one spelling of another. */
const scoreSignature = (a: Signature, b: Signature, rarity: TokenRarity): PairScore => {
  const reasons: string[] = [];
  const sharedPlain = [...a.t].filter((t) => b.t.has(t));
  const plainCarries = carriesEvidence(sharedPlain, rarity.isRarePlain);
  const j = plainCarries ? jaccard(a.t, b.t) : 0;
  let score = j;

  // The containment bonus needs at least two shared significant words.
  //
  // With one, it is actively harmful: 2,911 of the ~11,800 customers have a name
  // with a single significant word ('Tempo', 'PPV', 'Διογένης'), and a
  // one-word name is contained in every longer name that happens to reuse that
  // word. Rewarding that put unrelated companies at 0.85 and chained thousands
  // of them into a single "duplicate group". Below two shared words, plain
  // Jaccard decides — which for 1-of-3 words is 0.33 and correctly falls out.
  if (sharedPlain.length >= 2) {
    const covA = containment(a.t, b.t);
    const covB = containment(b.t, a.t);
    if (covA === 1 || covB === 1) {
      score = Math.max(score, covA === 1 && covB === 1 ? 0.9 : 0.85);
      reasons.push(covA === 1 && covB === 1 ? 'same significant words' : 'one name contained in the other');
    }
  }

  const sharedTl = [...a.tl].filter((t) => b.tl.has(t));
  if (a.tl.size && b.tl.size && carriesEvidence(sharedTl, rarity.isRareTranslit)) {
    const jt = jaccard(a.tl, b.tl);
    if (jt === 1) {
      score = Math.max(score, 0.92);
      reasons.push('same name, Greek/Latin spelling');
    } else if (jt >= 0.6) {
      score = Math.max(score, Math.min(0.88, jt));
      reasons.push('Greek/Latin spelling overlap');
    }
  }

  if (j >= 0.6) reasons.push('strong word overlap');
  else if (j >= 0.3) reasons.push('partial word overlap');

  return { score, reasons };
};

/**
 * Symmetric adaptation of scoreCandidate() from the payment-terms matcher. The
 * original is asymmetric (source vs target); here neither side is privileged,
 * so the two containment bonuses are folded into one.
 *
 * Name and BrandName are scored as SEPARATE spellings and the best pairing
 * wins, rather than being poured into one bag of words. BrandName is nominally
 * the official name, but in this database it is often a free-text description
 * instead — 'P.A. SOLUTIONS LTD' carries
 * 'Εγκατάσταση-Ενοικίαση-Πώληση Ηχ.& Φωτ. Εξοπλησμου'. Unioned, those five
 * description words dropped a perfect name match to a Jaccard of 1/7 = 0.14 and
 * the pair was never reported.
 *
 * Three of the four possible pairings are used. Cross pairings — one record's
 * name against the other's official name — are the most productive of all, and
 * find duplicates nothing else can: 'Ζέπου Αμαλία' against the customer named
 * 'DOC 3 PRODUCTIONS' whose official name is 'Αμαλία Ζέπου & ΣΙΑ Ο.Ε.'.
 *
 * BrandName against BrandName is deliberately NOT compared. That column is
 * where this database keeps whatever did not fit elsewhere — a legal form
 * ('Αστική μη κερδοσκοπική'), a category ('Ιδιώτης', 'Περιοδικό'), even an
 * import marker ('Κατάλογος Canford', stamped on dozens of unrelated
 * customers). Matching two records on that alone produced enormous groups of
 * strangers — 300 of them pinned at the size cap — and not one true duplicate
 * that the other three pairings missed.
 */
export const scorePair = (
  a: Enriched,
  b: Enriched,
  rarity: TokenRarity = EVERYTHING_RARE,
): PairScore => {
  const pairings: Array<[Signature, Signature]> = [[a.name, b.name]];
  if (b.brand.t.size || b.brand.tl.size) pairings.push([a.name, b.brand]);
  if (a.brand.t.size || a.brand.tl.size) pairings.push([a.brand, b.name]);

  let best: PairScore = { score: 0, reasons: [] };
  for (const [left, right] of pairings) {
    const result = scoreSignature(left, right, rarity);
    if (result.score > best.score) best = result;
  }

  if (a.acr && a.acr.length >= 3 && (a.acr === b.acr || a.acr === b.normName || b.acr === a.normName)) {
    if (best.score < 0.95) {
      best = { score: 0.95, reasons: [...best.reasons, 'acronym of the same name'] };
    }
  }

  return best;
};

// ---------------------------------------------------------------------------
// Union-find, for collapsing pairs into groups
// ---------------------------------------------------------------------------

class UnionFind {
  private parent = new Map<number, number>();

  find(x: number): number {
    let root = this.parent.get(x);
    if (root === undefined) {
      this.parent.set(x, x);
      return x;
    }
    while (root !== x) {
      x = root;
      root = this.parent.get(x) ?? x;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

// ---------------------------------------------------------------------------
// Primary suggestion
// ---------------------------------------------------------------------------

/**
 * The record most likely to be the one worth keeping: the one carrying the most
 * history. Offers first because repointing them is the whole cost of getting
 * this wrong, then contacts, then how complete the record is, then age.
 */
const primaryRank = (c: DuplicateScanCustomer): number[] => [
  c.OfferCount,
  c.ContactCount,
  c.ERPID != null ? 1 : 0,
  normalizeTaxId(c.TaxID) ? 1 : 0,
  c.Email ? 1 : 0,
  -c.CustomerID, // oldest id wins the final tie
];

const pickPrimary = (members: DuplicateScanCustomer[]): number => {
  let best = members[0];
  let bestRank = primaryRank(best);
  for (const candidate of members.slice(1)) {
    const rank = primaryRank(candidate);
    for (let i = 0; i < rank.length; i += 1) {
      if (rank[i] === bestRank[i]) continue;
      if (rank[i] > bestRank[i]) {
        best = candidate;
        bestRank = rank;
      }
      break;
    }
  }
  return best.CustomerID;
};

// ---------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER: Record<DuplicateConfidence, number> = { high: 0, medium: 1, low: 2 };

const GENERIC_NAME_REASON =
  'identical name repeated across many records, with nothing else in common — verify before merging';

const pairKey = (a: number, b: number): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Strips the derived matching fields back off before the group leaves this module. */
const stripDerived = (c: Enriched): DuplicateScanCustomer => {
  const { t, tl, name, brand, acr, normName, taxKey, ...rest } = c;
  void t; void tl; void name; void brand; void acr; void normName; void taxKey;
  return rest;
};

const buildGroup = (
  members: Enriched[],
  confidence: DuplicateConfidence,
  score: number,
  reasons: ReadonlySet<string>,
): DuplicateGroup => {
  const ordered = [...members].sort((a, b) => a.CustomerID - b.CustomerID);
  return {
    key: ordered.map((m) => m.CustomerID).join('-'),
    confidence,
    score: Math.min(1, score),
    reasons: Array.from(reasons),
    suggestedPrimaryId: pickPrimary(ordered),
    members: ordered.map(stripDerived),
  };
};

/**
 * Finds groups of customers that look like the same company.
 *
 * Blocking keys, in order of how much they are trusted:
 *   1. normalised tax id (leading zeros dropped, all-same-digit placeholders excluded)
 *   2. ERP id
 *   3. exact normalised name
 *   4. shared rare token, in either the Greek or the transliterated alphabet
 *
 * Pairs from 1-3 are HIGH confidence and are unioned into groups. Fuzzy pairs
 * are unioned only at MEDIUM and above, so a chain of weak similarities cannot
 * silently glue two unrelated clusters together; weak pairs are still reported
 * on their own.
 */
export const findDuplicateGroups = (
  customers: readonly DuplicateScanCustomer[],
  options: DuplicateScanOptions = {},
): DuplicateGroup[] => {
  const {
    enabledOnly = true,
    excludeParents = true,
    minScore = FUZZY_THRESHOLD,
    limit = 500,
  } = options;

  const pool = customers.filter((c) => {
    if (enabledOnly && !(c.Enabled === true || c.Enabled === 1)) return false;
    if (excludeParents && (c.IsParent === true || c.IsParent === 1)) return false;
    return true;
  });

  const enriched = pool.map(enrich);
  const byId = new Map(enriched.map((c) => [c.CustomerID, c]));

  // --- build the blocking indexes -----------------------------------------
  const byTax = new Map<string, Enriched[]>();
  const byErp = new Map<number, Enriched[]>();
  const byName = new Map<string, Enriched[]>();
  const inverted = new Map<string, Enriched[]>();

  const push = <K>(map: Map<K, Enriched[]>, key: K, value: Enriched) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(value);
    else map.set(key, [value]);
  };

  for (const c of enriched) {
    if (c.taxKey) push(byTax, c.taxKey, c);
    if (c.ERPID != null) push(byErp, c.ERPID, c);
    if (c.normName) push(byName, c.normName, c);
    for (const token of c.t) push(inverted, token, c);
    // Transliterated tokens share the index under a '~' prefix so they can never
    // be confused with a real Greek token.
    for (const token of c.tl) push(inverted, `~${token}`, c);
  }

  // The inverted index doubles as the corpus statistic: a word's bucket size IS
  // the number of customers using it, which is what decides whether a one-word
  // match is evidence or a coincidence.
  const rarity: TokenRarity = {
    isRarePlain: (token) => (inverted.get(token)?.length ?? 0) <= RARE_TOKEN_MAX_DF,
    isRareTranslit: (token) => (inverted.get(`~${token}`)?.length ?? 0) <= RARE_TOKEN_MAX_DF,
  };

  // --- hard links: tax id, ERP id, exact name -----------------------------
  //
  // Only these three form multi-member GROUPS. Fuzzy name similarity is
  // deliberately never unioned transitively: A~B and B~C does not make A~C, and
  // treating it as if it did collapsed 3,296 unrelated customers into one
  // "group" on the live data. Fuzzy matches are reported as pairs instead, which
  // is also the only form a human can actually act on.
  const hardPairs = new Map<string, string[]>();
  const uf = new UnionFind();

  const linkHard = (bucket: Enriched[], reason: string, oversizeReason: string) => {
    if (bucket.length < 2) return;
    const label = bucket.length > MAX_GROUP_SIZE ? oversizeReason : reason;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const key = pairKey(bucket[i].CustomerID, bucket[j].CustomerID);
        const reasons = hardPairs.get(key);
        if (reasons) {
          if (!reasons.includes(label)) reasons.push(label);
        } else {
          hardPairs.set(key, [label]);
        }
        uf.union(bucket[i].CustomerID, bucket[j].CustomerID);
      }
    }
  };

  for (const [taxKey, bucket] of byTax) {
    linkHard(
      bucket,
      `same tax id (${taxKey})`,
      `tax id ${taxKey} is shared by ${bucket.length} customers — likely a placeholder, verify`,
    );
  }
  for (const [erpId, bucket] of byErp) {
    linkHard(
      bucket,
      `same ERP id (${erpId})`,
      `ERP id ${erpId} is shared by ${bucket.length} customers — verify`,
    );
  }
  for (const [, bucket] of byName) {
    if (bucket.length < 2) continue;
    // Does anything beyond the name itself corroborate these being one company?
    const taxKeys = bucket.map((c) => c.taxKey).filter(Boolean);
    const corroborated = new Set(taxKeys).size > 0 && taxKeys.length >= 2;
    const suspect = bucket.length >= GENERIC_NAME_GROUP_SIZE && !corroborated;
    linkHard(
      bucket,
      suspect ? GENERIC_NAME_REASON : 'identical name',
      GENERIC_NAME_REASON,
    );
  }

  // --- fuzzy pairs ---------------------------------------------------------
  const fuzzyPairs = new Map<string, PairScore>();
  const seenPair = new Set<string>();

  for (const [, bucket] of inverted) {
    if (bucket.length < 2 || bucket.length > MAX_BLOCKING_DF) continue;
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const a = bucket[i];
        const b = bucket[j];
        const key = pairKey(a.CustomerID, b.CustomerID);
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        // Already hard-linked into the same group — scoring it again would only
        // re-report it as a weaker pair.
        if (uf.find(a.CustomerID) === uf.find(b.CustomerID)) continue;
        const result = scorePair(a, b, rarity);
        if (result.score < minScore) continue;
        fuzzyPairs.set(key, result);
      }
    }
  }

  // --- assemble ------------------------------------------------------------
  //
  // Groups grow by CLIQUE, never by chain: a record joins a group only when it
  // matches EVERY record already in it. So 'A~B, B~C' with no A~C stays two
  // separate pairs, while 'A~B, B~C, A~C' becomes one group of three.
  //
  // This is what puts the three spellings of one company ('PA Solutions',
  // 'PA SOLUTIONS', 'P.A. SOLUTIONS LTD') on a single card instead of splitting
  // them across a hard pair plus two loose fuzzy pairs — without reopening the
  // transitive closure that once collapsed 3,296 customers into one "group".
  // Requiring a link to every existing member is precisely the property that
  // chaining lacks.
  const adjacency = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    const forA = adjacency.get(a) ?? new Set<number>();
    forA.add(b);
    adjacency.set(a, forA);
    const forB = adjacency.get(b) ?? new Set<number>();
    forB.add(a);
    adjacency.set(b, forB);
  };
  const splitKey = (key: string): [number, number] => {
    const [a, b] = key.split(':');
    return [Number(a), Number(b)];
  };
  for (const key of hardPairs.keys()) link(...splitKey(key));
  for (const key of fuzzyPairs.keys()) link(...splitKey(key));

  const matchesEveryMember = (candidate: number, members: ReadonlySet<number>): boolean => {
    const neighbours = adjacency.get(candidate);
    if (!neighbours) return false;
    for (const member of members) {
      if (!neighbours.has(member)) return false;
    }
    return true;
  };

  /**
   * Grows a HARD cluster (identical name / same tax id / same ERP id) by taking
   * in every record that matches the whole of that trustworthy core.
   *
   * The candidates are not required to match each OTHER, which is the one place
   * the strict clique rule is relaxed — and it has to be. Twelve records named
   * 'Αριστοτέλειο Πανεπιστήμιο Θεσσαλονίκης' had two further records that each
   * matched all twelve but not one another; as pure cliques that produced two
   * near-identical 13-record cards differing by a single row. Matching the
   * entire core is evidence enough to sit on the same card, and because the core
   * never grows, nothing chains.
   */
  const absorbAroundCore = (core: ReadonlySet<number>): Set<number> => {
    const members = new Set(core);
    const candidates = new Set<number>();
    for (const member of core) {
      for (const neighbour of adjacency.get(member) ?? []) {
        if (!core.has(neighbour)) candidates.add(neighbour);
      }
    }
    for (const candidate of Array.from(candidates).sort((x, y) => x - y)) {
      if (members.size >= MAX_GROUP_SIZE) break;
      if (matchesEveryMember(candidate, core)) members.add(candidate);
    }
    return members;
  };

  /** Absorbs every record that matches all current members, until none is left. */
  const growClique = (members: Set<number>) => {
    let grew = true;
    while (grew && members.size < MAX_GROUP_SIZE) {
      grew = false;
      const candidates = new Set<number>();
      for (const member of members) {
        for (const neighbour of adjacency.get(member) ?? []) {
          if (!members.has(neighbour)) candidates.add(neighbour);
        }
      }
      // Sorted so the result does not depend on Map iteration order.
      for (const candidate of Array.from(candidates).sort((x, y) => x - y)) {
        if (members.size >= MAX_GROUP_SIZE) break;
        if (!matchesEveryMember(candidate, members)) continue;
        members.add(candidate);
        grew = true;
      }
    }
  };

  const groups: DuplicateGroup[] = [];
  /** Pairs already represented by an emitted group, so nothing is shown twice. */
  const consumed = new Set<string>();

  /** Member sets already shown, so a group wholly inside one is not repeated. */
  const emittedSets: Array<Set<number>> = [];

  const emitGroup = (ids: ReadonlySet<number>) => {
    const members = Array.from(ids)
      .map((id) => byId.get(id))
      .filter((c): c is Enriched => Boolean(c));
    if (members.length < 2) return;

    const idSet = new Set(members.map((m) => m.CustomerID));
    const alreadyCovered = emittedSets.some(
      (shown) => shown.size >= idSet.size && Array.from(idSet).every((id) => shown.has(id)),
    );
    if (alreadyCovered) return;
    emittedSets.push(idSet);

    const reasons = new Set<string>();
    let bestScore = 0;
    let hasHardEdge = false;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const key = pairKey(members[i].CustomerID, members[j].CustomerID);
        consumed.add(key);
        const hard = hardPairs.get(key);
        if (hard) {
          hard.forEach((reason) => reasons.add(reason));
          hasHardEdge = true;
          bestScore = 1;
        }
        const fuzzy = fuzzyPairs.get(key);
        if (fuzzy) {
          fuzzy.reasons.forEach((reason) => reasons.add(reason));
          bestScore = Math.max(bestScore, fuzzy.score);
        }
      }
    }

    const suspect = reasons.has(GENERIC_NAME_REASON) || members.length > MAX_GROUP_SIZE;
    const confidence: DuplicateConfidence = suspect
      ? 'medium'
      : hasHardEdge
        ? 'high'
        : bestScore >= MEDIUM_THRESHOLD
          ? 'medium'
          : 'low';
    groups.push(buildGroup(members, confidence, bestScore, reasons));
  };

  /**
   * Fuses two groups that are plainly about the same company.
   *
   * Different evidence can attach different records to one core without those
   * records resembling each other: twelve rows named 'Αριστοτέλειο Πανεπιστήμιο
   * Θεσσαλονίκης' pick up 'Ειδικός Λογαριασμός Κονδυλίων Έρευνας Α.Π.Θ' through
   * a shared tax id and 'Αριστοτέλειο Πανεπιστήμιο Θεσσαλονίκης - Ιατρική'
   * through its name, while those two have nothing in common with each other.
   * No single clique holds all fourteen, so the university arrived as two
   * near-identical thirteen-row cards.
   *
   * Requiring at least TWO shared records is what separates this from chaining:
   * two pairs that merely share one endpoint (A~B and B~C) overlap by one and
   * are left alone, which is the whole point.
   */
  const OVERLAP_MIN_SHARED = 2;

  const fuseOverlapping = (sets: Array<Set<number>>): Array<Set<number>> => {
    const byMember = new Map<number, number[]>();
    sets.forEach((set, index) => {
      for (const id of set) {
        const holders = byMember.get(id) ?? [];
        holders.push(index);
        byMember.set(id, holders);
      }
    });

    const fusion = new UnionFind();
    const tested = new Set<string>();
    for (const holders of byMember.values()) {
      for (let i = 0; i < holders.length; i += 1) {
        for (let j = i + 1; j < holders.length; j += 1) {
          const key = `${holders[i]}:${holders[j]}`;
          if (tested.has(key)) continue;
          tested.add(key);
          const a = sets[holders[i]];
          const b = sets[holders[j]];
          let shared = 0;
          for (const id of a) if (b.has(id)) shared += 1;
          const smaller = Math.min(a.size, b.size);
          const union = a.size + b.size - shared;
          if (shared >= OVERLAP_MIN_SHARED && shared * 2 >= smaller && union <= MAX_GROUP_SIZE) {
            fusion.union(holders[i], holders[j]);
          }
        }
      }
    }

    const fused = new Map<number, Set<number>>();
    sets.forEach((set, index) => {
      const root = fusion.find(index);
      const target = fused.get(root);
      if (target) for (const id of set) target.add(id);
      else fused.set(root, new Set(set));
    });
    return Array.from(fused.values());
  };

  const candidateSets: Array<Set<number>> = [];
  const markConsumed = (ids: ReadonlySet<number>) => {
    const list = Array.from(ids);
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) consumed.add(pairKey(list[i], list[j]));
    }
  };

  // Hard clusters first, each grown with any fuzzy match that fits the whole
  // group, so a third spelling lands on the card its two siblings are already on.
  const clusters = new Map<number, Set<number>>();
  for (const key of hardPairs.keys()) {
    const [aId, bId] = splitKey(key);
    const root = uf.find(aId);
    const cluster = clusters.get(root);
    if (cluster) {
      cluster.add(aId);
      cluster.add(bId);
    } else {
      clusters.set(root, new Set([aId, bId]));
    }
  }
  for (const cluster of clusters.values()) {
    const members = absorbAroundCore(cluster);
    candidateSets.push(members);
    markConsumed(members);
  }

  // Then whatever fuzzy pairs are still on their own, strongest first, each also
  // grown into a clique so three mutually-similar names make one card.
  const remainingPairs = Array.from(fuzzyPairs.entries())
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]));
  for (const [key] of remainingPairs) {
    if (consumed.has(key)) continue;
    const [aId, bId] = splitKey(key);
    const members = new Set([aId, bId]);
    growClique(members);
    candidateSets.push(members);
    markConsumed(members);
  }

  for (const members of fuseOverlapping(candidateSets)) emitGroup(members);

  groups.sort((a, b) => {
    const byConfidence = CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence];
    if (byConfidence !== 0) return byConfidence;
    if (b.score !== a.score) return b.score - a.score;
    if (b.members.length !== a.members.length) return b.members.length - a.members.length;
    return a.key.localeCompare(b.key);
  });

  return groups.slice(0, limit);
};
