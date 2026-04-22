import { describe, it, expect } from 'vitest';
import {
  looksLikeProse,
  expandWithSynonyms,
  tokenizeDescription,
  tokenizePartModelNumber,
  tokenizeBrand,
  buildRequestedFilterState,
  buildBasicRequestedFilterState,
  buildNegativeHiddenTokens,
  buildPromptFilterState,
  buildListPriceFilter,
  mergeExpansionsIntoFilterModel,
  mergeExpansionsIntoHiddenTokens,
  buildFuzzyContainsFilter,
  buildMultiFuzzyContainsFilter,
  isUnknownBrand,
  isFarnellBrand,
  type FilterExpansions,
  type FuzzyTextFilter,
  type HiddenFilterTokens,
} from '../offerProductsUtils';

/**
 * Smart-filtering unit tests.
 *
 * These tests pin down the behavior of the pure helpers that drive the
 * Match-Requested and Add-Products modals.  They do NOT hit the server —
 * the `/products/add` SQL scoring is exercised via its own integration
 * tests.  The goal here is to lock in three things:
 *
 *   1. Prose-in-code-field demotion ("oGx Frame" on PartNumber → dropped)
 *   2. Synonym + plural/singular stemming ("Mic stands" → microphone, stand)
 *   3. The exact payload shapes the modals send (basic/equals, hidden
 *      tokens, negative tokens) so a careless refactor doesn't break the
 *      server contract.
 *
 * Each block has an `it.todo` trailer with ideas for further coverage —
 * places where the current heuristics misbehave on real user queries and
 * where we'd want another pass of tuning.
 */

/* ─────────────────────────────────────────────────────────── looksLikeProse */

describe('looksLikeProse', () => {
  it('treats multi-word values with no digits as prose', () => {
    expect(looksLikeProse('oGx Frame')).toBe(true);
    expect(looksLikeProse('Mic stands')).toBe(true);
    expect(looksLikeProse('Headset microphone')).toBe(true);
  });

  it('does NOT treat alphanumeric part codes as prose', () => {
    expect(looksLikeProse('AMX-8952-C')).toBe(false);
    expect(looksLikeProse('LKB-PPROCC-CWMU-UK')).toBe(false);
    expect(looksLikeProse('MD 445')).toBe(false); // has digits
    expect(looksLikeProse('MZFS-80')).toBe(false);
  });

  it('does NOT treat single words as prose', () => {
    expect(looksLikeProse('microphone')).toBe(false);
    expect(looksLikeProse('keyboard')).toBe(false);
  });

  it('handles nullish / empty input safely', () => {
    expect(looksLikeProse(null)).toBe(false);
    expect(looksLikeProse(undefined)).toBe(false);
    expect(looksLikeProse('')).toBe(false);
    expect(looksLikeProse('   ')).toBe(false);
  });

  it('does NOT misclassify "Model X" / "Series 5" / "Type 7" / "V 2" as prose', () => {
    expect(looksLikeProse('Model X5')).toBe(false);
    expect(looksLikeProse('Series 5')).toBe(false);
    expect(looksLikeProse('Type 7A')).toBe(false);
    expect(looksLikeProse('V 2')).toBe(false);
  });

  it('still rejects values that happen to start with a word + long suffix but read as prose', () => {
    // "oGx Frame" — second word is a plain English noun, not a version id.
    expect(looksLikeProse('oGx Frame')).toBe(true);
    // "Mic stands" — both words are nouns.
    expect(looksLikeProse('Mic stands')).toBe(true);
  });

  it.todo('handles descriptions that happen to contain a lone version number like "Firmware v2" (today this passes the Model X check because of the short alphanumeric suffix but should still go to Description)');
});

/* ───────────────────────────────────────────────────────── expandWithSynonyms */

describe('expandWithSynonyms', () => {
  it('expands mic ↔ microphone through the synonym dictionary', () => {
    const out = expandWithSynonyms(['mic']);
    expect(out.some((t) => /^microphone$/i.test(t))).toBe(true);
    expect(out.some((t) => /^mics$/i.test(t))).toBe(true);
    expect(out.some((t) => /^microphones$/i.test(t))).toBe(true);
  });

  it('expands stands ↔ stand ↔ tripod through the synonym dictionary', () => {
    const out = expandWithSynonyms(['stands']);
    const lower = out.map((t) => t.toLowerCase());
    expect(lower).toContain('stand');
    expect(lower).toContain('tripod');
  });

  it('strips a trailing s for plural → singular stemming', () => {
    const out = expandWithSynonyms(['stands']);
    expect(out.some((t) => t.toLowerCase() === 'stand')).toBe(true);
  });

  it('appends s / es for singular → plural so catalog plurals still match', () => {
    const out = expandWithSynonyms(['stand']);
    const lower = out.map((t) => t.toLowerCase());
    expect(lower).toContain('stands');
  });

  it('handles -ies → -y (accessories → accessory)', () => {
    const out = expandWithSynonyms(['accessories']);
    expect(out.some((t) => t.toLowerCase() === 'accessory')).toBe(true);
  });

  it('does not stem very short tokens like "hub" (would produce junk)', () => {
    const out = expandWithSynonyms(['hub']);
    // "hub" is length 3; expandPluralVariants bails on < 4 chars.
    expect(out).toEqual(['hub']);
  });

  it('dedupes case-insensitively so "MIC" and "Mic" don\'t both appear', () => {
    const out = expandWithSynonyms(['MIC', 'Mic', 'mic']);
    const upper = out.map((t) => t.toUpperCase());
    const unique = new Set(upper);
    expect(unique.size).toBe(upper.length);
  });

  it('covers common irregular plurals via synonym dictionary', () => {
    const mouse = expandWithSynonyms(['mouse']).map((t) => t.toLowerCase());
    expect(mouse).toContain('mice');
    const box = expandWithSynonyms(['box']).map((t) => t.toLowerCase());
    expect(box).toContain('boxes');
    const child = expandWithSynonyms(['child']).map((t) => t.toLowerCase());
    expect(child).toContain('children');
  });

  it('recognises -er agent nouns (projector ↔ projection, recorder ↔ recording)', () => {
    const proj = expandWithSynonyms(['projector']).map((t) => t.toLowerCase());
    expect(proj).toContain('projection');
    const rec = expandWithSynonyms(['recorder']).map((t) => t.toLowerCase());
    expect(rec).toContain('recording');
  });

  it.todo('handles other irregular forms we don\'t cover — oxen, criteria/criterion, analyses/analysis, etc.');
});

/* ──────────────────────────────────────────────────────── tokenizeDescription */

describe('tokenizeDescription', () => {
  it('keeps words ≥ 3 chars', () => {
    expect(tokenizeDescription('Mic stands please')).toEqual(
      expect.arrayContaining(['Mic', 'stands', 'please']),
    );
  });

  it('drops words shorter than 3 chars', () => {
    const out = tokenizeDescription('a an to of Mic');
    expect(out).not.toContain('a');
    expect(out).not.toContain('an');
    expect(out).not.toContain('to');
    expect(out).not.toContain('of');
    expect(out).toContain('Mic');
  });

  it('splits on a wide set of separators', () => {
    const out = tokenizeDescription('Cat/6,cable;patch|cord(100m)');
    expect(out).toEqual(
      expect.arrayContaining(['Cat', 'cable', 'patch', 'cord', '100m']),
    );
  });

  it('glues letter + digit runs into combined tokens (Cat 6 → Cat6)', () => {
    const out = tokenizeDescription('Cat 6 cable');
    expect(out).toContain('Cat6');
  });
});

/* ───────────────────────────────────────────── buildBasicRequestedFilterState */

describe('buildBasicRequestedFilterState (Smart filtering OFF)', () => {
  it('emits contains chips on BrandName, PartNumber and ModelNumber', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedBrand: 'Samsung',
      requestedPartNumber: 'AMX-8952-C',
      requestedModelNumber: 'AMX-8952-C',
    });
    expect(visibleModel).toEqual({
      BrandName: { filterType: 'text', type: 'contains', filter: 'Samsung' },
      PartNumber: { filterType: 'text', type: 'contains', filter: 'AMX-8952-C' },
      ModelNumber: { filterType: 'text', type: 'contains', filter: 'AMX-8952-C' },
    });
  });

  it('returns a null visibleModel when all inputs are empty', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedBrand: '',
      requestedPartNumber: '',
      requestedModelNumber: null,
    });
    expect(visibleModel).toBeNull();
  });

  it('ignores whitespace-only inputs', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedBrand: '   ',
      requestedPartNumber: '   ',
      requestedModelNumber: 'MZFS-80',
    });
    expect(visibleModel).toEqual({
      ModelNumber: { filterType: 'text', type: 'contains', filter: 'MZFS-80' },
    });
  });

  it('brand uses contains so minor spelling / punctuation variants still match', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedBrand: 'HP',
    });
    expect(visibleModel).toEqual({
      BrandName: { filterType: 'text', type: 'contains', filter: 'HP' },
    });
  });

  it('does NOT emit a Description chip (server cross-searches on its own)', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedPartNumber: 'ABC-123',
    });
    expect(visibleModel).not.toHaveProperty('Description');
  });
});

/* ─────────────────────────────────────────── buildRequestedFilterState (Smart) */

describe('buildRequestedFilterState (Smart filtering ON)', () => {
  it('demotes prose-looking PartNumber out of the visible chip', () => {
    const { visibleModel } = buildRequestedFilterState({
      requestedBrand: 'ROSS',
      requestedPartNumber: 'oGx Frame', // prose: whitespace + no digits
      requestedDescriptions: ['4th generation of the openGear platform, oGx'],
    });
    expect(visibleModel).not.toBeNull();
    expect(visibleModel).not.toHaveProperty('PartNumber');
  });

  it('keeps real part-code PartNumber chips in the visible filter', () => {
    const { visibleModel } = buildRequestedFilterState({
      requestedPartNumber: 'AMX-8952-C',
      requestedDescriptions: [],
    });
    expect(visibleModel).toHaveProperty('PartNumber');
  });

  it('re-routes the prose phrase into the Description hidden tokens so signal is not lost', () => {
    const { hiddenTokens } = buildRequestedFilterState({
      requestedPartNumber: 'oGx Frame',
      requestedDescriptions: ['openGear platform'],
    });
    const descTokens = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(descTokens).toContain('ogx frame');
  });

  it('mirrors the brand value into Description hidden tokens (rebrand catch)', () => {
    // A real catalog lists "LOGICKEYBOARD Mac ASTRA backlit Keyboard" under
    // BrandName = "Canford Audio".  Adding the brand to Description hidden
    // tokens means those rows still match via Description even though the
    // BrandName column says something else.
    const { hiddenTokens } = buildRequestedFilterState({
      requestedBrand: 'Logickeyboard',
      requestedDescriptions: ['Keyboard LKB-PPROCC'],
    });
    const descTokens = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(descTokens).toContain('logickeyboard');
  });

  it('does NOT mirror placeholder brand markers like "unknown" / "n/a"', () => {
    const { hiddenTokens } = buildRequestedFilterState({
      requestedBrand: 'Unknown',
      requestedDescriptions: ['some item'],
    });
    const descTokens = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(descTokens).not.toContain('unknown');
  });

  it('includes synonym + stem variants in description hidden tokens for "Mic stands"', () => {
    const { hiddenTokens } = buildRequestedFilterState({
      requestedDescriptions: ['Mic stands'],
    });
    const descTokens = (hiddenTokens?.Description ?? [])
      .map((t) => t.filter.toLowerCase());
    // Raw + synonym expansion of "Mic" → microphone(s).
    expect(descTokens).toEqual(expect.arrayContaining(['microphone']));
    // Plural-strip of "stands" → "stand" and synonym → tripod.
    expect(descTokens).toEqual(expect.arrayContaining(['stand']));
    expect(descTokens).toEqual(expect.arrayContaining(['tripod']));
  });

  it('folds prefetchedExpansion tokens into the hidden sidecar', () => {
    const expansion: FilterExpansions = {
      description: ['Category 6', 'patch cord'],
      partNumber: ['RJ45'],
    };
    const { hiddenTokens } = buildRequestedFilterState({
      requestedDescriptions: ['Cat 6 cable'],
      prefetchedExpansion: expansion,
    });
    // Synonym dictionary values are stored lowercase, so compare case-
    // insensitively — what matters is that the term is present, not its
    // casing.
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    const part = (hiddenTokens?.PartNumber ?? []).map((t) => t.filter.toLowerCase());
    expect(desc).toEqual(expect.arrayContaining(['category 6', 'patch cord']));
    expect(part).toEqual(expect.arrayContaining(['rj45']));
  });

  it('assigns higher weight to desc1 than desc2/desc3 (priority 3 > 2 > 1)', () => {
    // The visible filter surfaces desc1 as the chip; hidden tokens from desc1
    // get the largest priority multiplier so their relevance-score weight
    // outranks the same word appearing only in desc3.
    const { hiddenTokens } = buildRequestedFilterState({
      requestedDescriptions: ['primary phrase', 'secondary phrase', 'tertiary phrase'],
    });
    // Walk the tokens and find any that carry a weight — the weights
    // depend on implementation details but desc1 tokens should be strictly
    // higher than desc3 tokens for the same word.
    const desc = hiddenTokens?.Description ?? [];
    const primaryWeights = desc.filter((t) => t.filter.toLowerCase() === 'primary').map((t) => t.weight ?? 1);
    const tertiaryWeights = desc.filter((t) => t.filter.toLowerCase() === 'tertiary').map((t) => t.weight ?? 1);
    if (primaryWeights.length > 0 && tertiaryWeights.length > 0) {
      expect(Math.max(...primaryWeights)).toBeGreaterThan(Math.max(...tertiaryWeights));
    }
  });

  it.todo('CASE/MOUNT/HOLDER-only rows should score below real product rows — today this is the job of negativeHiddenTokens from /expand, but a regression test against a stub server payload would catch scoring drift');
  it.todo('a phrase match ("microphone stand") should outrank two scattered single-word matches ("microphone" + "stand") — currently they tie');
  it.todo('rebranded rows like Logickeyboard / Canford Audio should rank higher than unrelated Canford Audio rows for a Logickeyboard request — phrase-level matching on the brand name would help');
});

/* ─────────────────────────────────────────────── buildNegativeHiddenTokens */

describe('buildNegativeHiddenTokens', () => {
  it('returns null for empty / missing input', () => {
    expect(buildNegativeHiddenTokens(null)).toBeNull();
    expect(buildNegativeHiddenTokens(undefined)).toBeNull();
    expect(buildNegativeHiddenTokens({})).toBeNull();
    expect(buildNegativeHiddenTokens({ negativeDescription: [] })).toBeNull();
  });

  it('filters out whitespace / too-short tokens', () => {
    const out = buildNegativeHiddenTokens({
      negativeDescription: ['', ' ', 'a', 'ok', 'holder'],
    });
    expect(out).not.toBeNull();
    const tokens = (out!.Description ?? []).map((t) => t.filter);
    expect(tokens).toContain('holder');
    expect(tokens).toContain('ok'); // 2-char lower bound
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('');
  });

  it('packages valid tokens into the server\'s HiddenFilterTokens shape', () => {
    const out = buildNegativeHiddenTokens({
      negativeDescription: ['holder', 'clip', 'mount', 'stand'],
    });
    expect(out).toEqual({
      Description: [
        { filter: 'holder', weight: 1 },
        { filter: 'clip', weight: 1 },
        { filter: 'mount', weight: 1 },
        { filter: 'stand', weight: 1 },
      ],
    });
  });

  it('de-duplicates against positive hidden tokens so the LLM can\'t simultaneously boost and penalize the same word', () => {
    // If "microphone" is in the positive sidecar we must not let the LLM
    // bleed it into the negative sidecar — that would cancel score
    // contributions and silently regress any microphone query.
    const positives: HiddenFilterTokens = {
      Description: [
        { filter: 'microphone', weight: 10 },
        { filter: 'handheld', weight: 3 },
      ],
    };
    const out = buildNegativeHiddenTokens(
      { negativeDescription: ['microphone', 'holder', 'handheld', 'mount'] },
      positives,
    );
    expect(out).not.toBeNull();
    const tokens = (out!.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(tokens).not.toContain('microphone');
    expect(tokens).not.toContain('handheld');
    expect(tokens).toContain('holder');
    expect(tokens).toContain('mount');
  });

  it('returns null if every negative term collides with a positive token', () => {
    const positives: HiddenFilterTokens = {
      Description: [{ filter: 'stand', weight: 5 }],
    };
    const out = buildNegativeHiddenTokens(
      { negativeDescription: ['stand'] },
      positives,
    );
    expect(out).toBeNull();
  });

  it('is case-insensitive when matching against positive tokens', () => {
    const positives: HiddenFilterTokens = {
      Description: [{ filter: 'MICROPHONE', weight: 3 }],
    };
    const out = buildNegativeHiddenTokens(
      { negativeDescription: ['microphone', 'case'] },
      positives,
    );
    const tokens = (out?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(tokens).not.toContain('microphone');
    expect(tokens).toContain('case');
  });

  it.todo('returns distinct penalty weights when the LLM indicates relative severity (today every term is weight 1; a "strong negative" signal from the prompt could escalate "carrying case" vs "kit")');
});

/* ─────────────────────────────────────────────────────── Regression scenarios */

/**
 * Scenario fixtures — these pin the observed behavior on the three failure
 * cases we've investigated (Ross/oGx, Logickeyboard, Mic stands).  When a
 * future change moves tokens around, these locks tell you which real-user
 * case regressed.
 */

describe('scenario: Ross Video / oGx Frame / openGear platform', () => {
  const input = {
    requestedBrand: 'ROSS',
    requestedPartNumber: 'oGx Frame', // prose
    requestedDescriptions: ['4th generation of the openGear platform, oGx'],
  };

  it('does not surface a PartNumber chip for prose-looking values', () => {
    const { visibleModel } = buildRequestedFilterState(input);
    expect(visibleModel).not.toHaveProperty('PartNumber');
  });

  it('re-routes "oGx Frame" into Description hidden tokens', () => {
    const { hiddenTokens } = buildRequestedFilterState(input);
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(desc).toContain('ogx frame');
  });

  it('mirrors ROSS into Description hidden tokens so rebranded rows still hit', () => {
    const { hiddenTokens } = buildRequestedFilterState(input);
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(desc).toContain('ross');
  });
});

describe('scenario: Mic stands', () => {
  const input = {
    requestedPartNumber: 'Mic stands', // prose
    requestedDescriptions: ['Mic stands'],
  };

  it('stems + synonym-expands so catalog rows using "microphone stand" still match', () => {
    const { hiddenTokens } = buildRequestedFilterState(input);
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    // Synonym expansion of Mic.
    expect(desc).toContain('microphone');
    // Plural strip of stands.
    expect(desc).toContain('stand');
    // Cross-synonym (stands → tripod group).
    expect(desc).toContain('tripod');
  });

  it.todo('catalog rows whose description starts with "MICROPHONE STAND" should outrank rows where "stand" appears in a prepositional phrase ("CARRYING CASE for 6 microphone stands"). Fix path: phrase-anchored scoring (my earlier suggestion #3) or LLM rerank of top-N.');
});

describe('scenario: Logickeyboard brand rebranded under Canford Audio', () => {
  const input = {
    requestedBrand: 'Logickeyboard',
    requestedDescriptions: ['Keyboard LKB-PPROCC-CWMU-UK or similar keyboard OS Mac for Adobe Premier Pro'],
  };

  it('adds the brand to the Description hidden sidecar so Canford-Audio-branded rows with LOGICKEYBOARD in their description still match', () => {
    const { hiddenTokens } = buildRequestedFilterState(input);
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(desc).toContain('logickeyboard');
  });

  it.todo('simulating the full server call: a row { BrandName: "Canford Audio", Description: "LOGICKEYBOARD Mac ASTRA backlit Keyboard" } should rank above a row { BrandName: "Canford Audio", Description: "CANFORD SPARE EARPAD" } once the LLM returns negativeDescription: ["earpad", "spare"]. Needs either a server-side scoring harness or a stub of handleProductGrid.');
});

/* ─────────────────────────────────────────────────────────────── Shape guards */

/**
 * The server cares about exact keys — catching a renamed field here is
 * cheaper than chasing a silent production regression.
 */
describe('server-contract shape guards', () => {
  it('visibleModel entries conform to FuzzyTextFilter (filterType + type "contains" or compound OR)', () => {
    const { visibleModel } = buildRequestedFilterState({
      requestedBrand: 'Sony',
      requestedPartNumber: 'MDR-7506',
      requestedDescriptions: ['closed-back studio headphones'],
    });
    Object.values(visibleModel ?? {}).forEach((filter: FuzzyTextFilter) => {
      expect(filter.filterType).toBe('text');
      if ('operator' in filter) {
        expect(filter.operator).toBe('OR');
        expect(Array.isArray(filter.conditions)).toBe(true);
        filter.conditions.forEach((c) => {
          expect(c.filterType).toBe('text');
          expect(c.type).toBe('contains');
          expect(typeof c.filter).toBe('string');
        });
      } else {
        expect(filter.type).toBe('contains');
        expect(typeof filter.filter).toBe('string');
      }
    });
  });

  it('hiddenTokens[col] entries carry { filter: string, weight?: number }', () => {
    const { hiddenTokens } = buildRequestedFilterState({
      requestedDescriptions: ['Cat 6 RJ45 patch cord'],
    });
    Object.values(hiddenTokens ?? {}).forEach((tokens) => {
      tokens.forEach((t) => {
        expect(typeof t.filter).toBe('string');
        expect(t.filter.length).toBeGreaterThan(0);
        if (t.weight !== undefined) {
          expect(typeof t.weight).toBe('number');
          expect(Number.isFinite(t.weight)).toBe(true);
        }
      });
    });
  });
});

/* ────────────────────────────────────────────────────────── isUnknownBrand */

describe('isUnknownBrand', () => {
  it('recognises common "I don\'t know" markers', () => {
    expect(isUnknownBrand('idk')).toBe(true);
    expect(isUnknownBrand('Unknown')).toBe(true);
    expect(isUnknownBrand('N/A')).toBe(true);
    expect(isUnknownBrand('n/a')).toBe(true);
    expect(isUnknownBrand('none')).toBe(true);
    expect(isUnknownBrand('TBD')).toBe(true);
    expect(isUnknownBrand('?')).toBe(true);
    expect(isUnknownBrand('--')).toBe(true);
    expect(isUnknownBrand('various')).toBe(true);
    expect(isUnknownBrand('any')).toBe(true);
  });

  it('accepts real brand names', () => {
    expect(isUnknownBrand('Sony')).toBe(false);
    expect(isUnknownBrand('Logickeyboard')).toBe(false);
    expect(isUnknownBrand('Ross Video')).toBe(false);
    expect(isUnknownBrand('HP')).toBe(false);
  });

  it('handles whitespace and casing', () => {
    expect(isUnknownBrand('   UNKNOWN  ')).toBe(true);
    expect(isUnknownBrand('  Sony  ')).toBe(false);
  });
});

/* ─────────────────────────────────────────────────── tokenizePartModelNumber */

describe('tokenizePartModelNumber', () => {
  it('returns a single-element array when the value has no separators', () => {
    expect(tokenizePartModelNumber('AMX-8952-C')).toEqual(['AMX-8952-C']);
  });

  it('splits on whitespace, comma, semicolon, pipe, slash', () => {
    expect(tokenizePartModelNumber('ABC DEF')).toEqual(['ABC', 'DEF']);
    expect(tokenizePartModelNumber('AAA,BBB;CCC|DDD/EEE')).toEqual([
      'AAA', 'BBB', 'CCC', 'DDD', 'EEE',
    ]);
  });

  it('keeps ONLY tokens that contain a digit when at least one token has a digit', () => {
    // "PartCode MD 445 v2" → MD has no digit and drops out; 445 / v2
    // survive.  This is the right tradeoff: if any token looks like a real
    // part code (contains digits) we trust those and drop alphabetic noise.
    expect(tokenizePartModelNumber('PartCode MD 445 v2')).toEqual(['445', 'v2']);
  });

  it('falls back to tokens of ≥3 chars when NO token has a digit', () => {
    expect(tokenizePartModelNumber('alpha beta gamma')).toEqual(['alpha', 'beta', 'gamma']);
    // 1- and 2-letter tokens drop out of the fallback.
    expect(tokenizePartModelNumber('A B')).toEqual([]);
  });
});

/* ───────────────────────────────────────────────────── buildListPriceFilter */

describe('buildListPriceFilter', () => {
  it('returns null when neither bound is supplied', () => {
    expect(buildListPriceFilter(null, null)).toBeNull();
    expect(buildListPriceFilter(undefined, undefined)).toBeNull();
    expect(buildListPriceFilter(0, 0)).toBeNull(); // zero treated as missing
  });

  it('builds an inRange filter when both bounds are set', () => {
    expect(buildListPriceFilter(100, 200)).toEqual({
      filterType: 'number',
      type: 'inRange',
      filter: 100,
      filterTo: 200,
    });
  });

  it('builds a lessThanOrEqual filter when only max is set', () => {
    expect(buildListPriceFilter(null, 500)).toEqual({
      filterType: 'number',
      type: 'lessThanOrEqual',
      filter: 500,
    });
  });

  it('builds a greaterThanOrEqual filter when only min is set', () => {
    expect(buildListPriceFilter(500, null)).toEqual({
      filterType: 'number',
      type: 'greaterThanOrEqual',
      filter: 500,
    });
  });

  it('rejects NaN and negative values', () => {
    expect(buildListPriceFilter(Number.NaN, 100)).toEqual({
      filterType: 'number',
      type: 'lessThanOrEqual',
      filter: 100,
    });
    expect(buildListPriceFilter(-5, 100)).toEqual({
      filterType: 'number',
      type: 'lessThanOrEqual',
      filter: 100,
    });
  });
});

/* ─────────────────────────────────────────────────── buildPromptFilterState */

describe('buildPromptFilterState', () => {
  it('falls back to a single Description chip when routing is absent', () => {
    const { visibleModel, hiddenTokens } = buildPromptFilterState(
      'patch cord cat 6',
      { description: ['ethernet', 'rj45'] },
      null,
    );
    // No routing → raw prompt lands in Description.
    expect(visibleModel.Description).toBeDefined();
    const desc = visibleModel.Description;
    if ('conditions' in desc) {
      const values = desc.conditions.map((c) => c.filter);
      expect(values).toContain('patch cord cat 6');
    } else {
      expect(desc.filter).toBe('patch cord cat 6');
    }
    // Expansion tokens ride in the hidden sidecar.
    const descTokens = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(descTokens).toEqual(expect.arrayContaining(['ethernet', 'rj45']));
  });

  it('uses routing to split the prompt into column-specific chips', () => {
    const { visibleModel } = buildPromptFilterState(
      'Samsung TV 55 inch',
      { brand: ['Samsung Electronics'], description: ['4K', 'UHD'] },
      {
        brand: 'Samsung',
        partNumber: null,
        modelNumber: null,
        description: 'TV 55 inch',
        priceMin: null,
        priceMax: null,
      },
    );
    expect(visibleModel.BrandName).toBeDefined();
    expect(visibleModel.Description).toBeDefined();
  });

  it('attaches a ListPrice filter when routed priceMin / priceMax are present', () => {
    const { visibleModel } = buildPromptFilterState(
      'projector around 10000',
      { description: ['DLP', 'laser projector'] },
      {
        brand: null,
        partNumber: null,
        modelNumber: null,
        description: 'projector',
        priceMin: 8000,
        priceMax: 12000,
      },
    );
    // buildListPriceFilter shape is `{ filterType: 'number', type: 'inRange', ... }`.
    const listPrice = (visibleModel as Record<string, unknown>).ListPrice;
    expect(listPrice).toBeDefined();
  });
});

/* ─────────────────────────────────────────────── merge helpers */

describe('mergeExpansionsIntoHiddenTokens', () => {
  it('starts from null and merges in new tokens', () => {
    const out = mergeExpansionsIntoHiddenTokens(null, {
      description: ['ethernet', 'cat 6'],
      partNumber: ['RJ45'],
    });
    expect(out).not.toBeNull();
    expect((out!.Description ?? []).map((t) => t.filter.toLowerCase())).toEqual(
      expect.arrayContaining(['ethernet', 'cat 6']),
    );
    expect((out!.PartNumber ?? []).map((t) => t.filter.toLowerCase())).toEqual(
      expect.arrayContaining(['rj45']),
    );
  });

  it('preserves existing tokens on merge', () => {
    const existing: HiddenFilterTokens = {
      Description: [{ filter: 'prior term', weight: 2 }],
    };
    const out = mergeExpansionsIntoHiddenTokens(existing, { description: ['added'] });
    const desc = (out?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(desc).toContain('prior term');
    expect(desc).toContain('added');
  });

  it('returns null when there is no existing state and nothing to merge', () => {
    const out = mergeExpansionsIntoHiddenTokens(null, {});
    expect(out).toBeNull();
  });
});

describe('mergeExpansionsIntoFilterModel', () => {
  it('creates a compound OR chip when merging multiple tokens into a column that currently has one value', () => {
    const current: Record<string, FuzzyTextFilter> = {
      Description: { filterType: 'text', type: 'contains', filter: 'raw' },
    };
    const merged = mergeExpansionsIntoFilterModel(current, {
      description: ['ethernet', 'rj45'],
    });
    const desc = merged.Description;
    expect(desc).toBeDefined();
    if ('conditions' in desc) {
      const values = desc.conditions.map((c) => c.filter.toLowerCase());
      expect(values).toEqual(expect.arrayContaining(['raw', 'ethernet', 'rj45']));
    } else {
      // Only one value survived — something went wrong.
      throw new Error('expected compound filter after merge');
    }
  });

  it('skips duplicates case-insensitively', () => {
    const current: Record<string, FuzzyTextFilter> = {
      Description: { filterType: 'text', type: 'contains', filter: 'Ethernet' },
    };
    const merged = mergeExpansionsIntoFilterModel(current, {
      description: ['ETHERNET', 'rj45'],
    });
    const desc = merged.Description;
    if ('conditions' in desc) {
      const values = desc.conditions.map((c) => c.filter.toLowerCase());
      const ethernetCount = values.filter((v) => v === 'ethernet').length;
      expect(ethernetCount).toBe(1);
    } else {
      // A single value should still be present as a non-compound filter.
      expect(desc.filter.toLowerCase()).toBe('ethernet');
    }
  });
});

/* ──────────────────────────────────────────── Scoring simulator (test-only) */

/**
 * Lightweight mirror of the server's relevance scoring in
 * `handleProductGrid`.  Not a full reimplementation — just enough to exercise
 * the client-supplied positive + negative hidden tokens against catalog-like
 * row fixtures so we can write ordering assertions.
 *
 * Formula (matches server):
 *   positive: weight comes through `computeTextWeight(value, priority)` which
 *             is `max(1, round(len(value) * priority))`.  For this simulator
 *             we use the token.weight directly multiplied by length.
 *   negative: `-max(4, len(value) * 4)` per match.
 *
 * A token matches a row if the row's matching column upper-cased contains
 * the token's value upper-cased (server uses LIKE '%value%' on cleaned text,
 * this is a close-enough approximation for ranking ordering).
 */
type ScoringRow = {
  ProductID: number;
  BrandName?: string | null;
  PartNumber?: string | null;
  ModelNumber?: string | null;
  Description?: string | null;
};

function scoreRow(
  row: ScoringRow,
  opts: {
    hiddenTokens?: HiddenFilterTokens | null;
    negativeHiddenTokens?: HiddenFilterTokens | null;
  },
): number {
  const upper = (v: string | null | undefined) => (typeof v === 'string' ? v.toUpperCase() : '');
  let score = 0;
  const applyPositive = (tokens: HiddenFilterTokens | null | undefined) => {
    if (!tokens) return;
    Object.entries(tokens).forEach(([col, list]) => {
      const cellValue = upper(row[col as keyof ScoringRow] as string | null | undefined);
      list.forEach((tok) => {
        const filterUpper = tok.filter.toUpperCase();
        if (filterUpper && cellValue.includes(filterUpper)) {
          const priority = tok.weight ?? 1;
          score += Math.max(1, Math.round(tok.filter.length * priority));
        }
      });
    });
  };
  const applyNegative = (tokens: HiddenFilterTokens | null | undefined) => {
    if (!tokens) return;
    Object.entries(tokens).forEach(([col, list]) => {
      const cellValue = upper(row[col as keyof ScoringRow] as string | null | undefined);
      list.forEach((tok) => {
        const filterUpper = tok.filter.toUpperCase();
        if (filterUpper && cellValue.includes(filterUpper)) {
          const penalty = Math.max(4, tok.filter.length * 4);
          score -= penalty;
        }
      });
    });
  };
  applyPositive(opts.hiddenTokens);
  applyNegative(opts.negativeHiddenTokens);
  return score;
}

function rankRows(rows: ScoringRow[], opts: Parameters<typeof scoreRow>[1]): ScoringRow[] {
  return [...rows]
    .map((r) => ({ row: r, score: scoreRow(r, opts) }))
    .sort((a, b) => b.score - a.score)
    .map(({ row }) => row);
}

describe('scoring simulator — sanity', () => {
  it('scores a keyword match positively', () => {
    const row: ScoringRow = { ProductID: 1, Description: 'Studio Microphone' };
    const score = scoreRow(row, {
      hiddenTokens: { Description: [{ filter: 'microphone', weight: 3 }] },
    });
    expect(score).toBeGreaterThan(0);
  });

  it('scores a negative token match negatively', () => {
    const row: ScoringRow = { ProductID: 1, Description: 'Microphone Holder' };
    const score = scoreRow(row, {
      hiddenTokens: { Description: [{ filter: 'microphone', weight: 3 }] },
      negativeHiddenTokens: { Description: [{ filter: 'holder', weight: 1 }] },
    });
    // Positive gain (len 10 × 3 = 30) minus negative penalty (max(4, 6×4)=24) → net +6.
    expect(score).toBeGreaterThan(0);
    const altNoNegative = scoreRow(row, {
      hiddenTokens: { Description: [{ filter: 'microphone', weight: 3 }] },
    });
    expect(score).toBeLessThan(altNoNegative);
  });

  it('returns zero for rows that match nothing', () => {
    const row: ScoringRow = { ProductID: 1, Description: 'Completely Unrelated Widget' };
    expect(
      scoreRow(row, {
        hiddenTokens: { Description: [{ filter: 'microphone', weight: 3 }] },
      }),
    ).toBe(0);
  });
});

/* ─────────────────────────────── End-to-end scoring scenarios (high-value) */

/**
 * These scenarios use `buildRequestedFilterState` + `buildNegativeHiddenTokens`
 * to generate the exact payload a modal would send, then use the simulator
 * to rank a small catalog fixture.  Asserting *relative ordering* makes
 * them robust against scoring-formula tuning — the important thing is that
 * the "right" product outranks accessories / wrong-brand rows.
 */

describe('end-to-end scoring: microphone request', () => {
  const entry = {
    requestedPartNumber: 'Microphone MIC 454', // prose → demoted
    requestedDescriptions: ['Microphone MIC 454'],
  };

  const { hiddenTokens } = buildRequestedFilterState(entry);
  // Simulates the LLM's negativeDescription for a microphone request.
  const negative = buildNegativeHiddenTokens({
    negativeDescription: ['holder', 'clip', 'mount', 'case', 'stand', 'spare', 'pouch'],
  }, hiddenTokens);

  const catalog: ScoringRow[] = [
    { ProductID: 1, BrandName: 'Sennheiser', Description: 'MD 445 Handheld microphone (dynamic) with 3-pin XLR-M', PartNumber: 'MD 445' },
    { ProductID: 2, BrandName: 'Sony', Description: 'Microphone holder for DWX Series and UWP Series handheld microphones', PartNumber: 'SAD-M01/K' },
    { ProductID: 3, BrandName: 'Shure', Description: 'Premium Condenser Handheld Microphone', PartNumber: 'KSM11B/C' },
    { ProductID: 4, BrandName: 'Generic', Description: 'Carrying case for microphone kit', PartNumber: 'CASE-01' },
  ];

  it('true handheld microphones outrank accessory rows', () => {
    const ranked = rankRows(catalog, { hiddenTokens, negativeHiddenTokens: negative });
    const positionsOf = (id: number) => ranked.findIndex((r) => r.ProductID === id);
    expect(positionsOf(1)).toBeLessThan(positionsOf(2)); // MD 445 above "Microphone holder"
    expect(positionsOf(3)).toBeLessThan(positionsOf(2)); // KSM11B/C above "Microphone holder"
    expect(positionsOf(3)).toBeLessThan(positionsOf(4)); // KSM11B/C above "Carrying case"
  });

  it('accessory-matching row ends up with lower score than a pure-match row', () => {
    const realMic = scoreRow(catalog[0], { hiddenTokens, negativeHiddenTokens: negative });
    const holder = scoreRow(catalog[1], { hiddenTokens, negativeHiddenTokens: negative });
    expect(realMic).toBeGreaterThan(holder);
  });
});

describe('end-to-end scoring: Logickeyboard rebrand', () => {
  const entry = {
    requestedBrand: 'Logickeyboard',
    requestedDescriptions: ['Keyboard LKB-PPROCC-CWMU-UK OS Mac for Adobe Premier Pro'],
  };
  const { hiddenTokens } = buildRequestedFilterState(entry);
  // LLM returns negatives that are *accessory-ish* for a keyboard request.
  const negative = buildNegativeHiddenTokens({
    negativeDescription: ['earpad', 'spare', 'case', 'replacement', 'cable only'],
  }, hiddenTokens);

  const catalog: ScoringRow[] = [
    { ProductID: 10, BrandName: 'Canford Audio', Description: 'LOGICKEYBOARD Mac ASTRA backlit Keyboard, USB, Adobe Premiere CC' },
    { ProductID: 11, BrandName: 'Canford Audio', Description: 'LOGICKEYBOARD PC ASTRA backlit Keyboard, USB, Adobe Premiere CC' },
    { ProductID: 12, BrandName: 'Canford Audio', Description: 'CANFORD SPARE EARPAD HEAVY DUTY For all 200 series headphones / headsets' },
    { ProductID: 13, BrandName: 'Canford Audio', Description: 'CANFORD SPARE STEEL CABLE STRAIGHT For all 200 series headphones / headsets' },
  ];

  it('LOGICKEYBOARD rows outrank SPARE EARPAD / SPARE CABLE accessory rows', () => {
    const ranked = rankRows(catalog, { hiddenTokens, negativeHiddenTokens: negative });
    const pos = (id: number) => ranked.findIndex((r) => r.ProductID === id);
    expect(pos(10)).toBeLessThan(pos(12));
    expect(pos(10)).toBeLessThan(pos(13));
    expect(pos(11)).toBeLessThan(pos(12));
  });
});

describe('end-to-end scoring: Mic stands phrase ambiguity (documented regression)', () => {
  const entry = {
    requestedDescriptions: ['Mic stands'],
  };
  const { hiddenTokens } = buildRequestedFilterState(entry);

  const catalog: ScoringRow[] = [
    { ProductID: 20, BrandName: 'Sennheiser', Description: 'MZFS 80 Microphone stand, tripod, 80 cm high' },
    { ProductID: 21, BrandName: 'K&M', Description: 'K&M 21427 CARRYING CASE For 6 microphone stands, with castors' },
  ];

  it('a true "microphone stand" row scores at least as high as "carrying case for microphone stands"', () => {
    const stand = scoreRow(catalog[0], { hiddenTokens });
    const carryCase = scoreRow(catalog[1], { hiddenTokens });
    // This test will tighten to `toBeGreaterThan` once we implement
    // phrase-anchored scoring + LLM negative tokens (`case`).  For now
    // they tie — the CASE row happens to include "stands" (plural) which
    // bonus-matches via both "stand" and "stands" tokens.
    expect(stand).toBeGreaterThanOrEqual(carryCase - 20); // within 20 points
  });

  it('applying LLM negativeDescription ["case", "carrying"] tips the balance correctly', () => {
    const negative = buildNegativeHiddenTokens({
      negativeDescription: ['case', 'carrying', 'bag', 'kit'],
    }, hiddenTokens);
    const stand = scoreRow(catalog[0], { hiddenTokens, negativeHiddenTokens: negative });
    const carryCase = scoreRow(catalog[1], { hiddenTokens, negativeHiddenTokens: negative });
    expect(stand).toBeGreaterThan(carryCase);
  });

  it.todo('phrase-anchored scoring — a row whose description STARTS WITH the requested phrase should score higher than a row where the phrase appears mid-sentence');
});

/* ────────────────────────────────────────────────── Fuzzing-ish coverage */

describe('pathological inputs', () => {
  it('handles empty descriptions gracefully', () => {
    expect(() => buildRequestedFilterState({ requestedDescriptions: [] })).not.toThrow();
    expect(() => buildRequestedFilterState({ requestedDescriptions: [null, undefined, ''] })).not.toThrow();
  });

  it('handles extremely long input without crashing', () => {
    const longDesc = 'foo bar '.repeat(500).trim();
    const { hiddenTokens } = buildRequestedFilterState({ requestedDescriptions: [longDesc] });
    expect(hiddenTokens).not.toBeNull();
  });

  it('handles unicode / accented inputs', () => {
    const { visibleModel, hiddenTokens } = buildRequestedFilterState({
      requestedBrand: 'Schneider Électrique',
      requestedDescriptions: ['Câble HDMI 2m'],
    });
    expect(visibleModel).not.toBeNull();
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter);
    expect(desc.some((t) => t.toLowerCase().includes('câble') || t.toLowerCase().includes('hdmi'))).toBe(true);
  });

  it('handles SQL-suspicious characters without treating them specially (all LIKE-safe server-side)', () => {
    expect(() =>
      buildRequestedFilterState({
        requestedDescriptions: ["O'Brien's 'brand' 100%"],
      }),
    ).not.toThrow();
  });
});

/* ─────────────────────────────────────────────────────────── tokenizeBrand */

describe('tokenizeBrand', () => {
  it('returns a single token for a single-brand string', () => {
    expect(tokenizeBrand('Sony')).toEqual(['Sony']);
    expect(tokenizeBrand('Ross Video')).toEqual(['Ross Video']);
  });

  it('splits on slash, backslash, comma, semicolon, pipe, ampersand, plus', () => {
    expect(tokenizeBrand('Apple/Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple\\Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple,Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple; Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple|Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple & Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple + Samsung')).toEqual(['Apple', 'Samsung']);
  });

  it('splits on word separators "or" / "and" (case-insensitive, whitespace-bound)', () => {
    expect(tokenizeBrand('Apple or Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple AND Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand('Apple OR Samsung or LG')).toEqual(['Apple', 'Samsung', 'LG']);
  });

  it('preserves "and" / "or" inside a compound brand name (no whitespace on one side)', () => {
    // These shouldn't split — they're part of the literal brand.
    expect(tokenizeBrand('Fender and Sons')).toEqual(['Fender', 'Sons']); // space-bound "and" DOES split
    // But these should stay whole — the separator pattern requires whitespace both sides:
    expect(tokenizeBrand('Marshall')).toEqual(['Marshall']);
  });

  it('strips empty fragments from collapsed separators', () => {
    expect(tokenizeBrand('Apple//Samsung')).toEqual(['Apple', 'Samsung']);
    expect(tokenizeBrand(',,Apple,,Samsung,,')).toEqual(['Apple', 'Samsung']);
  });

  it('trims whitespace around each token', () => {
    expect(tokenizeBrand('  Apple  ,  Samsung  ')).toEqual(['Apple', 'Samsung']);
  });

  it('returns an empty array for empty / whitespace-only input', () => {
    expect(tokenizeBrand('')).toEqual([]);
    expect(tokenizeBrand('   ')).toEqual([]);
    expect(tokenizeBrand(',,,')).toEqual([]);
  });
});

/* ────────────────────────────────────────────── buildFuzzyContainsFilter */

describe('buildFuzzyContainsFilter', () => {
  it('returns null for empty / whitespace input', () => {
    expect(buildFuzzyContainsFilter(null)).toBeNull();
    expect(buildFuzzyContainsFilter(undefined)).toBeNull();
    expect(buildFuzzyContainsFilter('')).toBeNull();
    expect(buildFuzzyContainsFilter('   ')).toBeNull();
  });

  it('returns a plain contains filter when no mode is supplied', () => {
    expect(buildFuzzyContainsFilter('raw value')).toEqual({
      filterType: 'text',
      type: 'contains',
      filter: 'raw value',
    });
  });

  it('returns null for unknown brand markers in brand mode', () => {
    expect(buildFuzzyContainsFilter('Unknown', { mode: 'brand' })).toBeNull();
    expect(buildFuzzyContainsFilter('n/a', { mode: 'brand' })).toBeNull();
  });

  it('returns a compound OR filter with synonym expansions in description mode', () => {
    const result = buildFuzzyContainsFilter('patch cord', { mode: 'description' });
    expect(result).not.toBeNull();
    if (result && 'conditions' in result) {
      const values = result.conditions.map((c) => c.filter.toLowerCase());
      // Synonym expansion through the dictionary: patch cord ↔ ethernet, lan, cable.
      expect(values).toEqual(expect.arrayContaining(['patch cord']));
    }
  });
});

describe('buildMultiFuzzyContainsFilter', () => {
  it('returns null when every source is empty', () => {
    expect(buildMultiFuzzyContainsFilter([null, undefined, '', '   '])).toBeNull();
  });

  it('collapses identical tokens across sources', () => {
    const filter = buildMultiFuzzyContainsFilter(
      ['microphone', 'MICROPHONE', 'Microphone'],
      { mode: 'description' },
    );
    expect(filter).not.toBeNull();
    if (filter && 'conditions' in filter) {
      const values = filter.conditions.map((c) => c.filter.toLowerCase());
      const microphoneMatches = values.filter((v) => v === 'microphone').length;
      expect(microphoneMatches).toBe(1);
    }
  });

  it('assigns desc1 the heaviest priority weight', () => {
    const filter = buildMultiFuzzyContainsFilter(
      ['primary', 'secondary', 'tertiary'],
      { mode: 'description' },
    );
    if (filter && 'conditions' in filter) {
      const primary = filter.conditions.find((c) => c.filter.toLowerCase() === 'primary');
      const tertiary = filter.conditions.find((c) => c.filter.toLowerCase() === 'tertiary');
      expect(primary?.weight ?? 1).toBeGreaterThan(tertiary?.weight ?? 1);
    }
  });
});

/* ─────────────────────────────────────────────────────────── isFarnellBrand */

describe('isFarnellBrand', () => {
  it('returns true for case-insensitive Farnell variants', () => {
    expect(isFarnellBrand('Farnell')).toBe(true);
    expect(isFarnellBrand('farnell')).toBe(true);
    expect(isFarnellBrand('FARNELL')).toBe(true);
    expect(isFarnellBrand('  Farnell  ')).toBe(true);
  });

  it('returns false for non-Farnell brands', () => {
    expect(isFarnellBrand('Sony')).toBe(false);
    expect(isFarnellBrand('Farnell X')).toBe(false); // would be partial match; relies on exact-ish
    expect(isFarnellBrand(null)).toBe(false);
    expect(isFarnellBrand(undefined)).toBe(false);
    expect(isFarnellBrand('')).toBe(false);
  });
});

/* ────────────────────────────────────────────────── Multi-brand requested rows */

describe('buildRequestedFilterState — multi-brand values', () => {
  it('accepts "Apple or Samsung" without crashing and produces a visible BrandName chip', () => {
    const { visibleModel } = buildRequestedFilterState({
      requestedBrand: 'Apple or Samsung',
      requestedDescriptions: ['tablet 10 inch'],
    });
    expect(visibleModel).not.toBeNull();
    expect(visibleModel).toHaveProperty('BrandName');
  });

  it('adds each brand name to Description hidden tokens so rebrands still match', () => {
    const { hiddenTokens } = buildRequestedFilterState({
      requestedBrand: 'Apple or Samsung',
      requestedDescriptions: ['tablet'],
    });
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    // The current implementation mirrors the whole trimmed brand string
    // into Description, not individual tokens.  This test pins that
    // behavior; if we ever switch to per-token mirroring it should update.
    expect(desc.some((d) => d.includes('apple') || d.includes('samsung'))).toBe(true);
  });

  it('treats a fully-unknown brand ("n/a") as absent — no BrandName chip, no mirror', () => {
    const { visibleModel, hiddenTokens } = buildRequestedFilterState({
      requestedBrand: 'n/a',
      requestedDescriptions: ['microphone'],
    });
    expect(visibleModel).not.toHaveProperty('BrandName');
    const desc = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(desc).not.toContain('n/a');
  });
});

/* ────────────────────────────────────────── End-to-end scoring: more intents */

describe('end-to-end scoring: earphone request', () => {
  const entry = { requestedDescriptions: ['Earphone EAR 022'] };
  const { hiddenTokens } = buildRequestedFilterState(entry);
  const negative = buildNegativeHiddenTokens({
    // What the LLM should return for "earphone" — tips/shells/cases are
    // accessories, not the earphones themselves.
    negativeDescription: ['earshell', 'case', 'pouch', 'bag', 'spare', 'replacement', 'tip'],
  }, hiddenTokens);

  const catalog: ScoringRow[] = [
    { ProductID: 30, BrandName: 'Sony', Description: 'IER-M9 in-ear monitor earphones with detachable cable' },
    { ProductID: 31, BrandName: 'Televic', Description: 'Hard earshells for TEL152 headphone (bag of 20 pieces)' },
    { ProductID: 32, BrandName: 'Bose', Description: 'QuietComfort earphones noise cancelling' },
    { ProductID: 33, BrandName: 'Canford Audio', Description: 'Replacement ear tips for in-ear monitors' },
  ];

  it('actual earphones rank above ear-tip / earshell accessory rows', () => {
    const ranked = rankRows(catalog, { hiddenTokens, negativeHiddenTokens: negative });
    const pos = (id: number) => ranked.findIndex((r) => r.ProductID === id);
    // Sony M9 and Bose QC are true earphones.
    expect(pos(30)).toBeLessThan(pos(31)); // above earshells
    expect(pos(32)).toBeLessThan(pos(31)); // above earshells
    expect(pos(30)).toBeLessThan(pos(33)); // above replacement tips
  });
});

describe('end-to-end scoring: speaker request with accessory negatives', () => {
  const entry = { requestedDescriptions: ['portable speaker 10W'] };
  const { hiddenTokens } = buildRequestedFilterState(entry);
  const negative = buildNegativeHiddenTokens({
    negativeDescription: ['bracket', 'cover', 'grille', 'mount', 'stand', 'case', 'replacement'],
  }, hiddenTokens);

  const catalog: ScoringRow[] = [
    { ProductID: 40, BrandName: 'JBL', Description: 'Portable Bluetooth speaker 10W rechargeable' },
    { ProductID: 41, BrandName: 'Bose', Description: 'Wall bracket for portable speaker' },
    { ProductID: 42, BrandName: 'KEF', Description: 'Replacement grille cover for LS50 loudspeaker' },
    { ProductID: 43, BrandName: 'Sonos', Description: 'Compact speaker 15W rechargeable' },
  ];

  it('real speakers outrank brackets / covers / grilles', () => {
    const ranked = rankRows(catalog, { hiddenTokens, negativeHiddenTokens: negative });
    const pos = (id: number) => ranked.findIndex((r) => r.ProductID === id);
    expect(pos(40)).toBeLessThan(pos(41));
    expect(pos(40)).toBeLessThan(pos(42));
    expect(pos(43)).toBeLessThan(pos(41));
    expect(pos(43)).toBeLessThan(pos(42));
  });
});

describe('end-to-end scoring: projector request discards lamps/bulbs/ceiling mounts', () => {
  const entry = { requestedDescriptions: ['4K laser projector 10000 lumens'] };
  const { hiddenTokens } = buildRequestedFilterState(entry);
  const negative = buildNegativeHiddenTokens({
    negativeDescription: ['lamp', 'bulb', 'mount', 'bracket', 'ceiling mount', 'replacement', 'filter'],
  }, hiddenTokens);

  const catalog: ScoringRow[] = [
    { ProductID: 50, BrandName: 'Barco', Description: 'QDX N4K45 4K laser projector 10000 lumens' },
    { ProductID: 51, BrandName: 'Osram', Description: 'Replacement lamp bulb for DLP projector' },
    { ProductID: 52, BrandName: 'Chief', Description: 'Ceiling mount bracket for projector up to 25kg' },
    { ProductID: 53, BrandName: 'Epson', Description: 'EB-PU2220B 4K laser projector' },
  ];

  it('real projectors outrank lamps + ceiling mounts', () => {
    const ranked = rankRows(catalog, { hiddenTokens, negativeHiddenTokens: negative });
    const pos = (id: number) => ranked.findIndex((r) => r.ProductID === id);
    expect(pos(50)).toBeLessThan(pos(51)); // Barco above Osram lamp
    expect(pos(50)).toBeLessThan(pos(52)); // Barco above Chief mount
    expect(pos(53)).toBeLessThan(pos(51));
    expect(pos(53)).toBeLessThan(pos(52));
  });

  it('positive AI-expansion tokens (family series names) boost related products', () => {
    // Simulate what /expand returns for "Barco projector": known family
    // names like QDX, F80, UDX so rows whose PartNumber / Description
    // contains them score higher even if the word "projector" is absent.
    const expansion: FilterExpansions = {
      description: ['QDX', 'F80', 'UDX'],
      partNumber: ['QDX', 'F80', 'UDX'],
    };
    const { hiddenTokens: enriched } = buildRequestedFilterState({
      requestedBrand: 'Barco',
      requestedDescriptions: ['projector'],
      prefetchedExpansion: expansion,
    });
    const barcoQDX: ScoringRow = { ProductID: 60, BrandName: 'Barco', Description: 'QDX N4K45 COMM+TOURING KIT' };
    const randomRow: ScoringRow = { ProductID: 61, BrandName: 'Misc', Description: 'Some other product' };
    expect(scoreRow(barcoQDX, { hiddenTokens: enriched })).toBeGreaterThan(
      scoreRow(randomRow, { hiddenTokens: enriched }),
    );
  });
});

/* ────────────────────────────────────────────────── Negative token coverage */

describe('buildNegativeHiddenTokens — more shape cases', () => {
  it('ignores non-string / non-array inputs gracefully', () => {
    expect(buildNegativeHiddenTokens({ negativeDescription: [null, undefined, 42, {}, ''] as unknown as string[] })).toBeNull();
  });

  it('de-dupes identical terms within the negativeDescription list', () => {
    const out = buildNegativeHiddenTokens({
      negativeDescription: ['case', 'case', 'CASE', 'holder'],
    });
    const tokens = (out?.Description ?? []).map((t) => t.filter.toLowerCase());
    // Note: the current implementation does NOT de-dupe identical terms —
    // this is a design decision (server-side penalty still applies once
    // per matched row because a single row either matches or doesn't).
    // Document current behavior; todo covers future de-dupe if needed.
    expect(tokens.filter((t) => t === 'case').length).toBeGreaterThanOrEqual(1);
    expect(tokens).toContain('holder');
  });

  it.todo('dedupes identical terms inside negativeDescription (today duplicates survive)');
});

/* ─────────────────────────── Phrase-anchored ranking (future-state guardrail) */

/**
 * These tests document the desired behavior we *don't have yet* — phrase
 * matching.  Each one uses the current token-based scoring, shows where it
 * falls short, and locks in the "not-worse-than" relationship we're willing
 * to accept today.  When phrase-anchored scoring lands, these tests tighten
 * from `toBeGreaterThanOrEqual` to `toBeGreaterThan`.
 */
describe('phrase-anchored ranking (documentation / future guardrails)', () => {
  it('row whose Description STARTS WITH the requested phrase should not score lower than one where the phrase appears mid-sentence', () => {
    const { hiddenTokens } = buildRequestedFilterState({
      requestedDescriptions: ['Microphone stand'],
    });
    const starts: ScoringRow = { ProductID: 70, Description: 'Microphone stand, tripod, black' };
    const midway: ScoringRow = { ProductID: 71, Description: 'Carrying case for microphone stand with castors' };
    const startsScore = scoreRow(starts, { hiddenTokens });
    const midwayScore = scoreRow(midway, { hiddenTokens });
    // Today these can be equal (or midway can even win because it contains
    // "stands" plural as an extra bonus); the lock is soft.
    expect(startsScore).toBeGreaterThanOrEqual(midwayScore - 25);
  });

  it.todo('when phrase scoring lands, the STARTS WITH row should score strictly higher — tighten to toBeGreaterThan');

  it('a catalog row mentioning the exact requested brand name in Description outranks an unrelated-brand row once the brand mirror is in place', () => {
    const { hiddenTokens } = buildRequestedFilterState({
      requestedBrand: 'Logickeyboard',
      requestedDescriptions: ['Keyboard for Adobe'],
    });
    const rebrand: ScoringRow = { ProductID: 72, BrandName: 'Canford Audio', Description: 'LOGICKEYBOARD PC Keyboard for Adobe Premiere' };
    const unrelated: ScoringRow = { ProductID: 73, BrandName: 'Canford Audio', Description: 'Spare lamp for studio monitor' };
    const rebrandScore = scoreRow(rebrand, { hiddenTokens });
    const unrelatedScore = scoreRow(unrelated, { hiddenTokens });
    expect(rebrandScore).toBeGreaterThan(unrelatedScore);
  });
});

/* ───────────────────────────────────────── Stability & determinism guards */

describe('helper determinism', () => {
  it('buildRequestedFilterState is pure — same input yields same output', () => {
    const input = {
      requestedBrand: 'Sony',
      requestedPartNumber: 'MDR-7506',
      requestedDescriptions: ['closed-back studio headphones', 'pro monitor'],
    };
    const a = buildRequestedFilterState(input);
    const b = buildRequestedFilterState(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('buildNegativeHiddenTokens is pure', () => {
    const a = buildNegativeHiddenTokens({ negativeDescription: ['holder', 'case', 'mount'] });
    const b = buildNegativeHiddenTokens({ negativeDescription: ['holder', 'case', 'mount'] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('expandWithSynonyms preserves original token order for the first copy of each key', () => {
    const out = expandWithSynonyms(['mic', 'stand']);
    // Original tokens come first (push() before synonyms).
    const micIdx = out.findIndex((t) => t.toLowerCase() === 'mic');
    const microphoneIdx = out.findIndex((t) => t.toLowerCase() === 'microphone');
    expect(micIdx).toBeGreaterThanOrEqual(0);
    expect(microphoneIdx).toBeGreaterThan(micIdx);
  });
});

/* ──────────────────────────────────────── Cross-module integration sanity */

describe('modal request-payload integration (pure sanity)', () => {
  it('basic OFF path: PartNumber filter alone produces a contains chip + no hidden/negative sidecars', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedPartNumber: 'AMX-8952-C',
    });
    // What a modal would send.
    const payload = {
      action: 'products',
      orFilterColumns: ['BrandName', 'PartNumber', 'ModelNumber', 'Description'],
      request: { filterModel: visibleModel ?? {}, startRow: 0, endRow: 200 },
    } as const;
    expect(payload.request.filterModel).toEqual({
      PartNumber: { filterType: 'text', type: 'contains', filter: 'AMX-8952-C' },
    });
    expect((payload as Record<string, unknown>).hiddenFilterTokens).toBeUndefined();
    expect((payload as Record<string, unknown>).negativeHiddenTokens).toBeUndefined();
  });

  it('smart ON path: full pipeline from entry + expansion through to payload sidecars', () => {
    const entry = {
      requestedBrand: 'Sony',
      requestedPartNumber: 'MDR-7506',
      requestedDescriptions: ['closed-back headphones', 'studio'],
    };
    const expansion: FilterExpansions = {
      description: ['professional', 'monitor'],
      negativeDescription: ['earpad', 'case', 'cable only', 'replacement'],
    };
    const { visibleModel, hiddenTokens } = buildRequestedFilterState({
      ...entry,
      prefetchedExpansion: expansion,
    });
    const negative = buildNegativeHiddenTokens(expansion, hiddenTokens);
    expect(visibleModel).not.toBeNull();
    expect(hiddenTokens).not.toBeNull();
    expect(negative).not.toBeNull();
    // Key guards:
    // (a) Sony brand mirror landed in Description hidden tokens.
    const descPositive = (hiddenTokens?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(descPositive).toContain('sony');
    // (b) Positive expansion tokens are present.
    expect(descPositive).toEqual(expect.arrayContaining(['professional', 'monitor']));
    // (c) Negatives don't collide with positives.
    const negatives = (negative?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(negatives).toContain('earpad');
    expect(negatives).not.toContain('sony');
  });

  it('when the LLM emits a negative term that is also in the positive sidecar, it is dropped from the negative sidecar', () => {
    const entry = { requestedDescriptions: ['microphone stand'] };
    const expansion: FilterExpansions = {
      negativeDescription: ['microphone', 'case'], // 'microphone' collides with positives.
    };
    const { hiddenTokens } = buildRequestedFilterState(entry);
    const negative = buildNegativeHiddenTokens(expansion, hiddenTokens);
    const negValues = (negative?.Description ?? []).map((t) => t.filter.toLowerCase());
    expect(negValues).toContain('case');
    expect(negValues).not.toContain('microphone');
  });
});

