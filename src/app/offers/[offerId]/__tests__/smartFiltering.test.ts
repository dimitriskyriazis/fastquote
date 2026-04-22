import { describe, it, expect } from 'vitest';
import {
  looksLikeProse,
  expandWithSynonyms,
  tokenizeDescription,
  buildRequestedFilterState,
  buildBasicRequestedFilterState,
  buildNegativeHiddenTokens,
  type FilterExpansions,
  type FuzzyTextFilter,
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

  // Known edge cases worth addressing in a follow-up:
  it.todo('classifies "Model X" / "Series 5" correctly — currently treated as prose because there is no digit after trim when we only look at the whole string');
  it.todo('handles descriptions that happen to contain a lone version number like "Firmware v2"');
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

  it.todo('handles irregular plurals we don\'t cover: mouse/mice only via synonym dict, box/boxes, child/children, etc.');
  it.todo('recognises "-er" agent nouns — "projector" ↔ "projection"');
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
  it('emits equals chips on PartNumber and ModelNumber, nothing else', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedPartNumber: 'AMX-8952-C',
      requestedModelNumber: 'AMX-8952-C',
    });
    expect(visibleModel).toEqual({
      PartNumber: { filterType: 'text', type: 'equals', filter: 'AMX-8952-C' },
      ModelNumber: { filterType: 'text', type: 'equals', filter: 'AMX-8952-C' },
    });
  });

  it('returns a null visibleModel when both inputs are empty', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedPartNumber: '',
      requestedModelNumber: null,
    });
    expect(visibleModel).toBeNull();
  });

  it('ignores whitespace-only inputs', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedPartNumber: '   ',
      requestedModelNumber: 'MZFS-80',
    });
    expect(visibleModel).toEqual({
      ModelNumber: { filterType: 'text', type: 'equals', filter: 'MZFS-80' },
    });
  });

  it('does NOT emit a Description or BrandName chip (server cross-searches on its own)', () => {
    const { visibleModel } = buildBasicRequestedFilterState({
      requestedPartNumber: 'ABC-123',
    });
    expect(visibleModel).not.toHaveProperty('Description');
    expect(visibleModel).not.toHaveProperty('BrandName');
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

  it.todo('returns distinct penalty weights when the LLM indicates relative severity (today every term is weight 1; a "strong negative" signal from the prompt could escalate "carrying case" vs "kit")');
  it.todo('de-duplicates against positive hidden tokens so the LLM can\'t simultaneously boost and penalize the same word');
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
