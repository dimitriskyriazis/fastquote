import { describe, expect, it } from 'vitest';
import {
  acronym,
  findDuplicateGroups,
  isPlaceholderTaxId,
  norm,
  normalizeTaxId,
  tokens,
  tokensMatch,
  translit,
  type DuplicateScanCustomer,
} from '../customerDuplicates';
import { contactDuplicateKey } from '../../app/customers/merge/customerMergeTypes';

let nextId = 1;
const customer = (
  overrides: Partial<DuplicateScanCustomer> & { Name: string },
): DuplicateScanCustomer => ({
  CustomerID: nextId++,
  BrandName: null,
  TaxID: null,
  ERPID: null,
  City: null,
  Email: null,
  Phone: null,
  Enabled: 1,
  IsParent: 0,
  OfferCount: 0,
  ContactCount: 0,
  ...overrides,
});

describe('norm', () => {
  it('folds Latin homoglyphs into Greek so both spellings compare equal', () => {
    // 'OTE' typed on a Latin keyboard vs 'ΟΤΕ' on a Greek one.
    expect(norm('OTE')).toBe(norm('ΟΤΕ'));
    expect(norm('KAPA')).toBe(norm('ΚΑΡΑ'.replace('Ρ', 'P')));
  });

  it('strips Greek accents and punctuation', () => {
    expect(norm('  spaced   out  ')).toBe(norm('SPACED OUT'));
  });

  it('rejoins dotted initialisms so the dots stop mattering', () => {
    expect(norm('P.A. SOLUTIONS')).toBe(norm('PA SOLUTIONS'));
    expect(norm('Ο.Τ.Ε ΑΕ')).toBe(norm('ΟΤΕ ΑΕ'));
    expect(norm('Ελλάς Α.Ε.')).toBe('ΕΛΛΑΣ ΑΕ');
  });

  it('leaves an isolated single letter alone', () => {
    expect(norm('Γ. Καραγιάννης')).toBe('Γ ΚΑΡΑΓΙΑΝΝΗΣ');
  });

  it('returns empty for nullish input', () => {
    expect(norm(null)).toBe('');
    expect(norm(undefined)).toBe('');
  });
});

describe('tokens', () => {
  it('drops Greek legal forms and filler words', () => {
    expect(Array.from(tokens('Καραγιάννης ΑΕ και ΣΙΑ'))).toEqual(['ΚΑΡΑΓΙΑΝΝΗΣ']);
  });

  it('drops LATIN legal forms too, despite homoglyph folding', () => {
    // norm() folds Latin T onto Greek tau, so these only match the stopword list
    // once the list itself is normalised. Getting this wrong left 'LTD' scoring
    // as a real word in 306 customers.
    expect(Array.from(tokens('SOLUTIONS LTD'))).toEqual(Array.from(tokens('SOLUTIONS')));
    expect(tokens('ACME INC').size).toBe(1);
    expect(tokens('ACME GMBH').size).toBe(1);
    expect(tokens('ACME LIMITED').size).toBe(1);
  });

  it('keeps two-letter initialisms, which distinguish one company from another', () => {
    expect(tokens('P.A. SOLUTIONS').has(norm('PA'))).toBe(true);
    expect(tokens('C&S Solutions').has(norm('CS'))).toBe(true);
  });

  it('drops single letters and Greek articles', () => {
    expect(tokens('Γ. Καραγιάννης').size).toBe(1);
    expect(Array.from(tokens('Το Χαμόγελο Του Παιδιού'))).toEqual(['ΧΑΜΟΓΕΛΟ', 'ΠΑΙΔΙΟΥ']);
  });
});

describe('translit', () => {
  it('connects a Greek spelling to its Latin one', () => {
    expect(translit('ΜΙΡΑΒΟΞ')).toBe('MIRAVOX');
  });
});

describe('acronym', () => {
  it('builds initials from significant words only', () => {
    expect(acronym('Ελληνική Ομοσπονδία Καλαθοσφαίρισης')).toBe('ΕΟΚ');
  });
});

describe('tokensMatch', () => {
  it('forgives a typo in a long enough word', () => {
    // The live case: 'PA Solutions Cypurs' vs 'P.A. SOLUTIONS LTD - Cyprus'.
    // A transposition, which plain Levenshtein would score as 2 and miss.
    expect(tokensMatch('CYPURS', 'CYPRUS')).toBe(true);
    expect(tokensMatch('SOLUTIONS', 'SOLUTIONS')).toBe(true);
    expect(tokensMatch('ΘΕΣΣΑΛΟΝΙΚΗ', 'ΘΕΣΑΛΟΝΙΚΗ')).toBe(true);
  });

  it('will not conflate short words that merely rhyme', () => {
    // Five-letter Greek words one vowel apart are different words, not typos.
    expect(tokensMatch('ΠΑΤΡΑ', 'ΠΕΤΡΑ')).toBe(false);
    expect(tokensMatch('ΜΑΡΙΑ', 'ΜΑΡΙΟΣ')).toBe(false);
    expect(tokensMatch('ΡΑ', 'ΡΒ')).toBe(false);
    expect(tokensMatch('SOUND', 'ROUND')).toBe(false);
  });

  it('will not conflate genuinely different words', () => {
    expect(tokensMatch('ΑΘΗΝΑ', 'ΘΕΣΣΑΛΟΝΙΚΗ')).toBe(false);
    expect(tokensMatch('ΠΑΝΕΠΙΣΤΗΜΙΟ', 'ΕΠΙΜΕΛΗΤΗΡΙΟ')).toBe(false);
  });
});

describe('normalizeTaxId', () => {
  it('treats a dropped leading zero as the same tax id', () => {
    // Both spellings genuinely exist in the live customer table.
    expect(normalizeTaxId('090000045')).toBe(normalizeTaxId('90000045'));
    expect(normalizeTaxId('094019245')).toBe(normalizeTaxId('94019245'));
  });

  it('ignores separators and rejects anything too short to identify a company', () => {
    expect(normalizeTaxId('094-019-245')).toBe('94019245');
    expect(normalizeTaxId('12345')).toBe('');
    expect(normalizeTaxId(null)).toBe('');
  });
});

describe('isPlaceholderTaxId', () => {
  it('flags repeated-digit placeholders and nothing else', () => {
    expect(isPlaceholderTaxId('999999999')).toBe(true);
    expect(isPlaceholderTaxId('000000000')).toBe(true);
    expect(isPlaceholderTaxId('094019245')).toBe(false);
  });
});

describe('findDuplicateGroups', () => {
  it('groups on a shared tax id with high confidence', () => {
    const groups = findDuplicateGroups([
      customer({ Name: 'ΟΤΕ Α.Ε.', TaxID: '094019245', OfferCount: 22 }),
      customer({ Name: 'Μουσείο ΟΤΕ Α.Ε.', TaxID: '94019245' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('high');
    expect(groups[0].members).toHaveLength(2);
    expect(groups[0].reasons.some((r) => r.startsWith('same tax id'))).toBe(true);
  });

  it('will NOT call a tax-id match high when the names disagree', () => {
    // The merge that had to be undone: 999005192 is a shared/placeholder AFM,
    // and these are two unrelated ΟΕs. Still reported — the tax id might be
    // right — but never as a certainty.
    const groups = findDuplicateGroups([
      customer({ Name: 'Μάριος Αλεξέλλης και ΣΙΑ ΟΕ', TaxID: '999005192' }),
      customer({ Name: 'Β ΚΑΡΥΠΙΑΔΗΣ ΚΑΙ ΣΙΑ ΟΕ', TaxID: '999005192' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('medium');
    expect(groups[0].reasons.some((r) => r.includes('nothing in common'))).toBe(true);
  });

  it('will not call one organisation with many accounts a certainty either', () => {
    // 90153025 is shared by the Army, the Air Force and the Navy.
    const groups = findDuplicateGroups([
      customer({ Name: 'Στρατός Ξηράς -ΑΣΔΕΝ', TaxID: '090153025' }),
      customer({ Name: '110 Πτέρυγα Μάχης/Μ.Ε.Υ', TaxID: '090153025' }),
      customer({ Name: 'ΠΟΛΕΜΙΚΟ ΝΑΥΤΙΚΟ ( ΝΚΕ )', TaxID: '090153025' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('medium');
  });

  it('still calls a tax-id match high when the names DO agree', () => {
    // 94019245 is every ΟΤΕ record — the corroborated case must not regress.
    const groups = findDuplicateGroups([
      customer({ Name: 'ΟΤΕ Α.Ε.', TaxID: '094019245' }),
      customer({ Name: 'Μουσείο ΟΤΕ Α.Ε.', TaxID: '94019245' }),
      customer({ Name: 'ΟΤΕ Δνση Διαχείρισης', TaxID: '094019245' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('high');
  });

  it('never groups on a placeholder tax id', () => {
    const groups = findDuplicateGroups([
      customer({ Name: 'Foreign Buyer One', TaxID: '999999999' }),
      customer({ Name: 'Unrelated Company Two', TaxID: '999999999' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('groups identical names even when they have no significant tokens', () => {
    // Greek 'α' folds onto Latin 'a', and both are too short to tokenise.
    const groups = findDuplicateGroups([
      customer({ Name: 'A' }),
      customer({ Name: 'α' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].reasons).toContain('identical name');
  });

  it('demotes a name repeated across many records with nothing else in common', () => {
    // 'Αρχιτέκτονας-Διακοσμητής' is a PROFESSION typed into the name field of a
    // dozen unrelated customers. It must be reported, but never as high.
    const groups = findDuplicateGroups(
      Array.from({ length: 12 }, () => customer({ Name: 'Αρχιτέκτονας-Διακοσμητής' })),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('medium');
    expect(groups[0].reasons.some((r) => r.includes('repeated across many records'))).toBe(true);
  });

  it('does not link two names that share only one significant word', () => {
    // The regression that collapsed 3,296 live customers into one group: with a
    // single shared token the containment bonus fired and chained everything.
    const groups = findDuplicateGroups([
      customer({ Name: 'Διογένης Α.Ε.' }),
      customer({ Name: 'Διογένης Κωνσταντίνου & Σια Ο.Ε.' }),
      customer({ Name: 'Διογένης Ταξιδιωτικές Υπηρεσίες Μονοπρόσωπη' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('does not chain A~B and B~C into one group', () => {
    const groups = findDuplicateGroups([
      customer({ Name: 'Alpha Beta Productions' }),
      customer({ Name: 'Alpha Beta Gamma Productions' }),
      customer({ Name: 'Beta Gamma Delta Productions' }),
    ]);
    // Whatever pairs survive, none may fold all three together: only tax id,
    // ERP id and an identical name are allowed to build a multi-member group.
    groups.forEach((group) => expect(group.members.length).toBeLessThanOrEqual(2));
  });

  it('matches across dotted initials and a trailing legal form', () => {
    // The reported miss: these are the same company in the live data, but the
    // dots split 'P.A.' into unusable single letters and 'LTD' survived the
    // stopword list as a significant word, dragging Jaccard to 0.5.
    const groups = findDuplicateGroups([
      customer({ Name: 'P.A. SOLUTIONS LTD' }),
      customer({ Name: 'PA SOLUTIONS' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(2);
  });

  it('puts all three spellings on one card despite a typo in one of them', () => {
    // Reported from the live page: these arrived as two separate pairs, each
    // pairing the short name with one Cyprus record, because 'Cypurs' and
    // 'Cyprus' are different words — so no clique could hold all three.
    const groups = findDuplicateGroups([
      customer({ Name: 'P.A. Solutions' }),
      customer({ Name: 'P.A. Solutions Cypurs' }),
      customer({ Name: 'P.A. SOLUTIONS LTD - Cyprus', TaxID: '60038695' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(3);
  });

  it('still separates two companies whose initials differ', () => {
    const groups = findDuplicateGroups([
      customer({ Name: 'PA SOLUTIONS' }),
      customer({ Name: 'C&S Solutions LTD' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('does not let a junk official name bury a real name match', () => {
    // BrandName is often a free-text description here. Pooling it with the name
    // dropped a perfect match to a Jaccard of 1/7.
    const groups = findDuplicateGroups([
      customer({
        Name: 'P.A. SOLUTIONS LTD',
        BrandName: 'Εγκατάσταση-Ενοικίαση-Πώληση Ηχητικού & Φωτιστικού Εξοπλισμού',
      }),
      customer({ Name: 'PA SOLUTIONS' }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('matches a customer whose OFFICIAL name is the other one’s name', () => {
    const groups = findDuplicateGroups([
      customer({ Name: 'Ζέπου Αμαλία' }),
      customer({ Name: 'DOC 3 PRODUCTIONS', BrandName: 'Αμαλία Ζέπου & ΣΙΑ Ο.Ε.' }),
    ]);
    expect(groups).toHaveLength(1);
  });

  it('ignores a single shared word that half the database uses', () => {
    // Two unrelated magazines both filed as 'Περιοδικό'. One shared word is only
    // evidence when the word is distinctive, so this needs a corpus where it is
    // demonstrably not.
    const filler = Array.from({ length: 30 }, (_, i) =>
      customer({ Name: `Unrelated Magazine ${i} Alpha${i}`, BrandName: 'Περιοδικό' }));
    const groups = findDuplicateGroups([
      customer({ Name: 'ΣΥΝΕΔΡΙΟ', BrandName: 'Περιοδικό' }),
      customer({ Name: 'Connecting', BrandName: 'Περιοδικό' }),
      ...filler,
    ]);
    const offending = groups.filter((g) => {
      const names = g.members.map((m) => m.Name);
      return names.includes('ΣΥΝΕΔΡΙΟ') && names.includes('Connecting');
    });
    expect(offending).toHaveLength(0);
  });

  it('treats a shared legal form in the official name as no evidence at all', () => {
    const groups = findDuplicateGroups([
      customer({ Name: 'Καλλιτεχνική Εταιρεία ΑΞΑΝΑ', BrandName: 'Αστική μη κερδοσκοπική' }),
      customer({ Name: 'Ινστιτούτο Καινοτομίας', BrandName: 'Αστική μη κερδοσκοπική Εταιρία' }),
      customer({ Name: 'Ρούσσος Νικόλαος', BrandName: 'Ιδιώτης' }),
      customer({ Name: 'Πάλλας Ιωάννης', BrandName: 'Ιδιώτης' }),
    ]);
    expect(groups).toHaveLength(0);
  });

  it('matches a Greek name against its Latin transliteration', () => {
    const groups = findDuplicateGroups([
      customer({ Name: 'ΜΙΡΑΒΟΞ ΕΠΕ' }),
      customer({ Name: 'MIRAVOX' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].reasons.some((r) => r.includes('Greek/Latin'))).toBe(true);
  });

  it('suggests the record carrying the most history as the survivor', () => {
    const busy = customer({ Name: 'Cosmote', TaxID: '38729353', OfferCount: 12, ContactCount: 54 });
    const empty = customer({ Name: 'COSMOTE', TaxID: '38729353' });
    const groups = findDuplicateGroups([empty, busy]);
    expect(groups[0].suggestedPrimaryId).toBe(busy.CustomerID);
  });

  it('skips disabled customers and group headers by default', () => {
    const rows = [
      customer({ Name: 'Repeated Name Ltd', TaxID: '094019245' }),
      customer({ Name: 'Repeated Name Ltd', TaxID: '094019245', Enabled: 0 }),
      customer({ Name: 'Repeated Name Ltd', TaxID: '094019245', IsParent: 1 }),
    ];
    expect(findDuplicateGroups(rows)).toHaveLength(0);
    const all = findDuplicateGroups(rows, { enabledOnly: false, excludeParents: false });
    expect(all[0].members).toHaveLength(3);
  });

  it('is stable: the same input yields the same group keys', () => {
    const rows = [
      customer({ Name: 'AVID', TaxID: '099999123' }),
      customer({ Name: 'Avid', TaxID: '99999123' }),
    ];
    expect(findDuplicateGroups(rows)[0].key).toBe(findDuplicateGroups(rows)[0].key);
  });
});

describe('contactDuplicateKey', () => {
  it('prefers email, case-insensitively', () => {
    expect(contactDuplicateKey({ Email: 'A.Papas@x.gr' }))
      .toBe(contactDuplicateKey({ Email: 'a.papas@x.gr', LastName: 'Other' }));
  });

  it('falls back to name plus mobile, never name alone', () => {
    expect(contactDuplicateKey({ LastName: 'Παπαδόπουλος', FirstName: 'Γιώργος' })).toBe('');
    expect(contactDuplicateKey({ LastName: 'Παπαδόπουλος', FirstName: 'Γιώργος', Mobile: '69 7000 0000' }))
      .toBe(contactDuplicateKey({ LastName: 'Παπαδόπουλος', FirstName: 'Γιώργος', Mobile: '6970000000' }));
  });

  it('returns empty when there is nothing distinctive to match on', () => {
    expect(contactDuplicateKey({})).toBe('');
  });
});
