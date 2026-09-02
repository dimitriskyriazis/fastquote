import { describe, expect, it } from 'vitest';
import {
  foldForCaseCompare,
  isCaseOnlyRewrite,
  isLikelyBadlyCapitalised,
  parseCapitalisationResponse,
  stripJsonFence,
  CAPITALISATION_SYSTEM_PROMPT,
} from '../descriptionCapitalisation';

describe('isLikelyBadlyCapitalised', () => {
  it('flags shouted descriptions', () => {
    // These two were documented as flagged by the previous inline heuristic but were not:
    // its 5-letter minimum threw away HUB, PRO, BAR and WITH, leaving too few words to reach
    // the floor of three all-caps tokens.
    expect(isLikelyBadlyCapitalised('CLICKSHARE HUB PRO EU WITH 2 BUTTONS')).toBe(true);
    expect(isLikelyBadlyCapitalised('CLICKSHARE BAR CB Core EU WITH 1 BUTTON')).toBe(true);
    expect(isLikelyBadlyCapitalised('4K HDMI DISTRIBUTION AMPLIFIER 1X4 WITH EDID')).toBe(true);
    expect(
      isLikelyBadlyCapitalised('BARCO G60-W10 SINGLE LAMP PROJECTOR 10000 LUMEN WUXGA'),
    ).toBe(true);
  });

  it('flags shouted Greek, which the letter-stripping heuristic could never see', () => {
    expect(isLikelyBadlyCapitalised('ΚΑΛΩΔΙΟ HDMI ΜΗΚΟΥΣ 3 ΜΕΤΡΩΝ')).toBe(true);
    expect(isLikelyBadlyCapitalised('Καλώδιο HDMI μήκους 3 μέτρων')).toBe(false);
  });

  it('leaves correctly capitalised descriptions alone', () => {
    expect(isLikelyBadlyCapitalised('Supports the import of data from multiple file types')).toBe(
      false,
    );
    expect(isLikelyBadlyCapitalised('ClickShare Hub Pro EU with 2 Buttons')).toBe(false);
    expect(isLikelyBadlyCapitalised('Short-throw zoom lens, 0.65-0.75:1 throw ratio')).toBe(false);
  });

  it('does not mistake a lone shouted word for a shouted description', () => {
    expect(isLikelyBadlyCapitalised('Linear Acoustic UPMAX downmix processor')).toBe(false);
    expect(isLikelyBadlyCapitalised('Does NOT include 1st year Premium Support')).toBe(false);
  });

  it('does not mistake technical acronyms for shouting', () => {
    // The old heuristic flagged this line: WUXGA, HDBASET and SDVOE all counted as shouted words.
    expect(isLikelyBadlyCapitalised('Dante-enabled WUXGA HDBASET SDVOE processor')).toBe(false);
    expect(isLikelyBadlyCapitalised('4K HDMI over IP encoder with PoE and Dante')).toBe(false);
    expect(isLikelyBadlyCapitalised('QSC Q-SYS Core 110f processor with AES67')).toBe(false);
  });

  it('ignores part numbers and measurements', () => {
    expect(isLikelyBadlyCapitalised('R9832753')).toBe(false);
    expect(isLikelyBadlyCapitalised('G60-W10 / R9008756 / 1X4')).toBe(false);
    expect(isLikelyBadlyCapitalised('')).toBe(false);
    expect(isLikelyBadlyCapitalised(null)).toBe(false);
    expect(isLikelyBadlyCapitalised(undefined)).toBe(false);
  });
});

describe('isCaseOnlyRewrite', () => {
  it('accepts a pure re-casing', () => {
    expect(
      isCaseOnlyRewrite(
        'CLICKSHARE HUB PRO EU WITH 2 BUTTONS',
        'ClickShare Hub Pro EU with 2 Buttons',
      ),
    ).toBe(true);
    expect(
      isCaseOnlyRewrite(
        '4K HDMI DISTRIBUTION AMPLIFIER 1X4 WITH EDID',
        '4K HDMI Distribution Amplifier 1x4 with EDID',
      ),
    ).toBe(true);
  });

  it('accepts an unchanged line', () => {
    expect(isCaseOnlyRewrite('Barco G60-W10 Projector', 'Barco G60-W10 Projector')).toBe(true);
  });

  it('tolerates collapsed whitespace', () => {
    expect(isCaseOnlyRewrite('HDMI   CABLE  3M', 'HDMI Cable 3m')).toBe(true);
  });

  it('accepts restored Greek accents and final sigma', () => {
    expect(isCaseOnlyRewrite('ΟΘΟΝΗ ΑΦΗΣ', 'Οθόνη αφής')).toBe(true);
    expect(isCaseOnlyRewrite('ΛΑΜΠΕΣ ΠΡΟΒΟΛΕΩΝ', 'Λάμπες προβολέων')).toBe(true);
  });

  it('rejects a description swapped in from another product', () => {
    // The exact failure the user saw: an example leaking out of the prompt onto a real row.
    expect(
      isCaseOnlyRewrite(
        'BARCO G60-W10 SINGLE LAMP PROJECTOR 10000 LUMEN WUXGA',
        'ClickShare Hub Pro EU with 2 Buttons',
      ),
    ).toBe(false);
  });

  it('rejects added, dropped or reordered words', () => {
    expect(isCaseOnlyRewrite('HDMI CABLE 3M', 'HDMI Cable 3m, black')).toBe(false);
    expect(isCaseOnlyRewrite('HDMI CABLE 3M BLACK', 'HDMI Cable 3m')).toBe(false);
    expect(isCaseOnlyRewrite('HDMI CABLE 3M', '3m HDMI Cable')).toBe(false);
  });

  it('rejects substituted characters and digits', () => {
    expect(isCaseOnlyRewrite('AMPLIFIER 1X4', 'Amplifier 1×4')).toBe(false);
    expect(isCaseOnlyRewrite('PROJECTOR 10000 LUMEN', 'Projector 10,000 Lumen')).toBe(false);
  });

  it('rejects an empty original or candidate', () => {
    expect(isCaseOnlyRewrite('', 'Anything')).toBe(false);
    expect(isCaseOnlyRewrite('HDMI CABLE', '')).toBe(false);
  });
});

describe('foldForCaseCompare', () => {
  it('collapses case, accents and whitespace', () => {
    expect(foldForCaseCompare('  Café   AUDIO ')).toBe('cafe audio');
  });
});

describe('stripJsonFence', () => {
  it('unwraps a fenced payload', () => {
    expect(stripJsonFence('```json\n["a"]\n```')).toBe('["a"]');
    expect(stripJsonFence('```\n["a"]\n```')).toBe('["a"]');
    expect(stripJsonFence('["a"]')).toBe('["a"]');
  });
});

describe('parseCapitalisationResponse', () => {
  it('maps index-keyed objects into their own slots regardless of order', () => {
    const raw = '[{"n":3,"text":"Third"},{"n":1,"text":"First"}]';
    expect(parseCapitalisationResponse(raw, 3)).toEqual(['First', null, 'Third']);
  });

  it('accepts a bare string array only when the length matches exactly', () => {
    expect(parseCapitalisationResponse('["A","B"]', 2)).toEqual(['A', 'B']);
    // A four-item example echoed in place of a twenty-item answer must not shift the rows.
    expect(parseCapitalisationResponse('["A","B","C","D"]', 20)).toEqual(
      new Array(20).fill(null),
    );
  });

  it('drops out-of-range and malformed entries instead of shifting the rest', () => {
    const raw = '[{"n":0,"text":"X"},{"n":9,"text":"Y"},{"n":2,"text":"Kept"},{"n":1}]';
    expect(parseCapitalisationResponse(raw, 3)).toEqual([null, 'Kept', null]);
  });

  it('unwraps a wrapper object', () => {
    expect(parseCapitalisationResponse('{"results":[{"n":1,"text":"A"}]}', 1)).toEqual(['A']);
  });

  it('returns empty slots for prose, empty output or broken JSON', () => {
    expect(parseCapitalisationResponse('Sure! Here you go:', 2)).toEqual([null, null]);
    expect(parseCapitalisationResponse('', 2)).toEqual([null, null]);
    expect(parseCapitalisationResponse('[{"n":1,"text":"A"', 2)).toEqual([null, null]);
  });
});

describe('CAPITALISATION_SYSTEM_PROMPT', () => {
  it('carries no brand that could be mistaken for a real catalogue line', () => {
    // The worked example used to be a real ClickShare description, which the model copied
    // verbatim onto unrelated products.
    expect(CAPITALISATION_SYSTEM_PROMPT).not.toContain('CLICKSHARE HUB PRO EU WITH 2 BUTTONS');
    expect(CAPITALISATION_SYSTEM_PROMPT).toContain('never copy text from them');
  });
});
