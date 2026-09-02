import { describe, expect, it } from 'vitest';
import {
  SIMILAR_NAME_THRESHOLD,
  buildSimilarNameIndex,
  type NameEntry,
} from '../similarNames';

let nextId = 1;
const entry = (name: string, overrides: Partial<NameEntry> = {}): NameEntry => ({
  id: nextId++,
  name,
  brandName: null,
  taxId: null,
  enabled: true,
  ...overrides,
});

/**
 * A believable slice of the customer base: a few one-off companies, plus
 * enough carriers of the generic words ('Media', 'Alpha', 'Hellas') that those
 * are NOT rare. 'UK' and 'USA' are deliberately left rare, as they are in the
 * live data, because the weak-word rule exists for exactly that.
 */
const filler = (word: string, count: number): NameEntry[] =>
  Array.from({ length: count }, (_, i) => entry(`${word} Filler ${i + 1}`));

const base: NameEntry[] = [
  entry('MediaKind'),
  entry('MediaKind USA', { taxId: '12345678' }),
  entry('Ikegami Electronics UK Ltd'),
  entry('Arup Acoustics USA'),
  entry('Media'),
  entry('Media'),
  entry('Metron Media'),
  entry('Alpha Bank'),
  entry('Alpha'),
  entry('Telmaco SA'),
  entry('Telmaco International Ltd'),
  entry('Tellas'),
  entry('DataTechnica ΕΠΕ'),
  entry('P.A. SOLUTIONS LTD'),
  entry('ΔΗ.ΡΑ.Λ'),
  entry('SHOWLUTIONS'),
  entry('ΜΙΡΑΒΟΞ ΑΕ'),
  entry('Ελληνική Ραδιοφωνία Τηλεόραση Α.Ε.'),
  entry('102 FM', { brandName: 'ΕΡΤ ΑΕ' }),
  entry('VK Records', { brandName: 'Ε ΚΑΠΠΟΣ ΜΟΝΟΠΡΟΣΩΠΗ ΙΚΕ' }),
  entry('Δήμος Αθηναίων'),
  entry('Δήμος Θηβαίων'),
  entry('Panasonic Technics'),
  entry('Old Telmaco Branch', { enabled: false }),
  ...filler('Media', 20),
  ...filler('Alpha', 12),
  ...filler('Hellas', 40),
  ...filler('Solutions', 12),
  ...filler('Δήμος', 12),
];

const index = buildSimilarNameIndex(base);
const names = (needle: string) => index.find(needle).map((m) => m.name);

describe('buildSimilarNameIndex', () => {
  it('skips rows without a usable name', () => {
    const small = buildSimilarNameIndex([entry(''), entry('   '), entry('Real')]);
    expect(small.size).toBe(1);
  });
});

describe('find: the reported case', () => {
  it("finds every MediaKind when typing 'MediaKind UK', best first", () => {
    const result = names('MediaKind UK');
    expect(result[0]).toBe('MediaKind');
    expect(result).toContain('MediaKind USA');
  });

  it("does not offer 'Media' for 'MediaKind UK'", () => {
    // 'Media' is a different word, not a typo of 'MediaKind', and it is common.
    expect(names('MediaKind UK')).not.toContain('Media');
    expect(names('MediaKind UK')).not.toContain('Metron Media');
  });

  it('still finds MediaKind under a longer typed name', () => {
    expect(names('MediaKind UK Broadcast Services')).toContain('MediaKind');
  });

  it('does not let a rare place word carry a match on its own', () => {
    // Only two names here carry 'UK' and two carry 'USA', so both words pass
    // the rarity test; they are still not what makes two companies the same.
    expect(names('MediaKind UK')).not.toContain('Ikegami Electronics UK Ltd');
    expect(names('MediaKind USA')).not.toContain('Arup Acoustics USA');
  });
});

describe('find: exact and near-exact', () => {
  it('scores the same name 1.0 regardless of case, accents and punctuation', () => {
    const [top] = index.find('ελληνικη ραδιοφωνια τηλεοραση αε');
    expect(top.name).toBe('Ελληνική Ραδιοφωνία Τηλεόραση Α.Ε.');
    expect(top.score).toBe(1);
  });

  it('ignores legal forms', () => {
    expect(names('Telmaco')).toContain('Telmaco SA');
    expect(names('Telmaco Ltd')[0]).toBe('Telmaco SA');
  });

  it('matches across a missing or extra space', () => {
    expect(names('Data Technica')).toContain('DataTechnica ΕΠΕ');
  });

  it('matches dotted initials against undotted ones', () => {
    expect(names('PA Solutions')[0]).toBe('P.A. SOLUTIONS LTD');
  });

  it('forgives one typo when the word is the whole of both names', () => {
    expect(names('Telmako')).toContain('Telmaco SA');
  });

  it('does not let a lone near-miss carry a match under a longer name', () => {
    expect(names('Telmako')).not.toContain('Telmaco International Ltd');
    expect(names('Data Technica')).not.toContain('Panasonic Technics');
  });

  it('matches a Greek name typed in Latin letters, whole word only', () => {
    expect(names('Miravox')).toContain('ΜΙΡΑΒΟΞ ΑΕ');
  });
});

describe('find: the official-name column', () => {
  it("matches the customer's official name and says so", () => {
    const hit = index.find('Ε. Κάππος ΙΚΕ').find((m) => m.name === 'VK Records');
    expect(hit?.officialName).toBe('Ε ΚΑΠΠΟΣ ΜΟΝΟΠΡΟΣΩΠΗ ΙΚΕ');
    const ert = index.find('ΕΡΤ ΑΕ').find((m) => m.name === '102 FM');
    expect(ert?.officialName).toBe('ΕΡΤ ΑΕ');
  });

  it('leaves officialName empty when the name itself matched', () => {
    const [top] = index.find('MediaKind');
    expect(top.name).toBe('MediaKind');
    expect(top.officialName).toBeNull();
  });
});

describe('find: what must NOT match', () => {
  it('does not treat one shared common word as similarity', () => {
    // 'Alpha' is in 14 names here. 'Alpha Bank' is not 'Alpha' and is not a
    // filler; the one-word customer 'Alpha' is not offered for it either.
    expect(names('Alpha Bank Cyprus')).toEqual(['Alpha Bank']);
    expect(names('Alpha Bank')).not.toContain('Alpha');
  });

  it('does offer the one-word name when that IS the whole typed name', () => {
    expect(names('Alpha SA')).toContain('Alpha');
  });

  it('does not let a two-letter initialism carry a match on its own', () => {
    // 'P.A.' and 'ΔΗ.ΡΑ.Λ' share the rejoined, homoglyph-folded word 'ΡΑ'.
    expect(names('P.A. Solutions')).not.toContain('ΔΗ.ΡΑ.Λ');
  });

  it('does not stretch a common word two edits to reach a rare one', () => {
    expect(names('P.A. Solutions')).not.toContain('SHOWLUTIONS');
    expect(names('Vodafone Hellas')).not.toContain('Tellas');
  });

  it('does not treat a two-edit near-miss as a typo', () => {
    // ΑΘΗΝΑΙΩΝ and ΘΗΒΑΙΩΝ are two edits apart; the merge tool would allow it.
    expect(names('Δήμος Αθηναίων')).not.toContain('Δήμος Θηβαίων');
  });

  it('returns nothing for names made only of legal forms or filler', () => {
    expect(index.find('ΑΕ')).toEqual([]);
    expect(index.find('Ltd')).toEqual([]);
    expect(index.find('')).toEqual([]);
    expect(index.find('   ')).toEqual([]);
  });

  it('does not match on a shared substring that is not a word', () => {
    expect(names('Med')).toEqual([]);
  });
});

describe('find: output shape', () => {
  it('carries tax id and enabled state through', () => {
    const usa = index.find('MediaKind USA').find((m) => m.name === 'MediaKind USA');
    expect(usa?.taxId).toBe('12345678');
    expect(usa?.enabled).toBe(true);
    expect(usa?.score).toBe(1);
  });

  it('reports disabled records, after live ones of the same score', () => {
    const result = index.find('Telmaco');
    const live = result.findIndex((m) => m.name === 'Telmaco SA');
    const dead = result.findIndex((m) => m.name === 'Old Telmaco Branch');
    expect(live).toBeGreaterThanOrEqual(0);
    expect(dead).toBeGreaterThan(live);
    expect(result[dead].enabled).toBe(false);
  });

  it('honours limit and minScore', () => {
    expect(index.find('Media Filler', { limit: 3 })).toHaveLength(3);
    expect(index.find('MediaKind UK', { minScore: 0.99 }).map((m) => m.name)).toEqual([]);
    expect(index.find('MediaKind', { minScore: 0.99 }).map((m) => m.name)).toEqual(['MediaKind']);
  });

  it('never returns anything below the default threshold', () => {
    for (const needle of ['MediaKind UK', 'Alpha Bank Cyprus', 'Telmako', 'Hellas Media']) {
      for (const match of index.find(needle)) {
        expect(match.score).toBeGreaterThanOrEqual(SIMILAR_NAME_THRESHOLD);
      }
    }
  });
});
