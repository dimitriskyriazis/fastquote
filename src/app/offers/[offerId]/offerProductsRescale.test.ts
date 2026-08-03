import { describe, expect, it } from 'vitest';
import {
  ceilMoney,
  computeNetPriceRescale,
  floorTo,
  PRICE_DECIMALS,
  roundMoney,
  type NetRescaleEntry,
} from './offerProductsUtils';
import { roundPriceByMagnitude } from '../../../lib/pricing';

/** Mirrors applyTotalNetPriceScale: hold the un-rescalable slice, aim at the rest. */
const runMarginEdit = (nets: Array<[number, number]>, comment: number, cost: number, typed: number) => {
  const entries: NetRescaleEntry[] = nets.map(([n, q], i) => ({
    OfferDetailID: i + 1, oldNet: n, quantity: q, newNet: n,
  }));
  const windowMin = cost / (1 - typed / 100);
  const windowMax = cost / (1 - (typed + 0.01) / 100);
  computeNetPriceRescale(entries, roundMoney(ceilMoney(windowMin, 2) - comment, PRICE_DECIMALS), {
    magnitudeRounding: true,
    exactTotal: true,
    atLeastTarget: true,
    acceptWindow: { min: windowMin - comment, max: windowMax - comment },
  });
  return entries;
};

const runNetEdit = (nets: Array<[number, number]>, comment: number, typedTotal: number) => {
  const entries: NetRescaleEntry[] = nets.map(([n, q], i) => ({
    OfferDetailID: i + 1, oldNet: n, quantity: q, newNet: n,
  }));
  computeNetPriceRescale(entries, roundMoney(roundMoney(typedTotal, 2) - comment, PRICE_DECIMALS), {
    magnitudeRounding: true, exactTotal: true,
  });
  return entries;
};

/** The offer total the server stores: SUM of each line's TotalNet at 4dp. */
const offerNet = (entries: NetRescaleEntry[], comment: number) =>
  roundMoney(entries.reduce((s, e) => s + roundMoney(e.newNet * e.quantity, PRICE_DECIMALS), 0) + comment, PRICE_DECIMALS);

/** What the grid shows a line adding up to, and what the column visibly sums to. */
const visibleColumnTotal = (entries: NetRescaleEntry[], comment: number) =>
  roundMoney(entries.reduce((s, e) => s + roundMoney(roundMoney(e.newNet, 2) * e.quantity, 2), 0) + comment, 2);

/** How many decimal levels a price gave up versus its magnitude band. */
const levelsDropped = (price: number) => {
  const band = roundPriceByMagnitude(price);
  if (Math.abs(band - price) < 1e-9) return 0;
  for (const [levels, step] of [[1, 0.1], [2, 0.01], [3, 0.001], [4, 0.0001]] as const) {
    if (Math.abs(price / step - Math.round(price / step)) < 1e-6) {
      // Distance in decades between the band's own step and this one.
      const abs = Math.abs(price);
      const bandStep = abs < 10 ? 0.01 : abs < 100 ? 0.1 : abs < 1000 ? 1 : abs < 100000 ? 10 : 100;
      return Math.round(Math.log10(bandStep / step));
    }
    void levels;
  }
  return 99;
};

// Offer "401 Γ.Σ.Ν.Α. TEST" as shown in the grid: 13 priced product/service lines
// plus a 400,00 printable comment that the totals bar counts but never rescales.
const OFFER_401: Array<[number, number]> = [636, 4750, 3050, 162, 1780, 1320, 1310, 162, 1320, 1320, 162, 651, 736]
  .map((n) => [n, 1]);
const COMMENT_401 = 400;
const COST_401 = 7636.35;

describe('AUDIT: totals-row rescale', () => {
  it('offer 401 — every margin from 40,00 to 70,00 % reads back exactly', () => {
    let allRoundFigures = 0;
    for (let hundredths = 4000; hundredths <= 7000; hundredths++) {
      const typed = hundredths / 100;
      const entries = runMarginEdit(OFFER_401, COMMENT_401, COST_401, typed);
      const net = offerNet(entries, COMMENT_401);
      const shown = floorTo((1 - COST_401 / net) * 100, 2);

      expect(shown, `typed ${typed} → net ${net} shows ${shown}`).toBe(typed);
      // Grid consistency: the visible column sums to the visible total.
      expect(visibleColumnTotal(entries, COMMENT_401), `typed ${typed}: column does not sum to total`)
        .toBe(roundMoney(net, 2));
      // No price ever goes below the cent.
      for (const e of entries) {
        expect(roundMoney(e.newNet, 2), `typed ${typed}: price ${e.newNet} is sub-cent`).toBe(e.newNet);
      }
      const dropped = Math.max(...entries.map((e) => levelsDropped(e.newNet)));
      expect(dropped, `typed ${typed}: dropped ${dropped} rounding levels`).toBeLessThanOrEqual(3);
      if (dropped === 0) allRoundFigures += 1;
    }
    // Three quarters of all margin targets on this offer leave every single price
    // on its magnitude band — the accept window means nothing has to move at all.
    expect(allRoundFigures / 3001).toBeGreaterThan(0.7);
  });

  it('offer 401 — typed Total Net lands on the cent, dropping one level at a time', () => {
    for (let cents = 1600000; cents <= 1960000; cents += 137) {
      const typed = cents / 100;
      const entries = runNetEdit(OFFER_401, COMMENT_401, typed);
      const net = offerNet(entries, COMMENT_401);
      expect(net, `typed ${typed} → net ${net}`).toBe(typed);
      expect(visibleColumnTotal(entries, COMMENT_401), `typed ${typed}: column does not sum to total`).toBe(typed);
      for (const e of entries) {
        expect(roundMoney(e.newNet, 2), `typed ${typed}: price ${e.newNet} is sub-cent`).toBe(e.newNet);
      }
      const dropped = Math.max(...entries.map((e) => levelsDropped(e.newNet)));
      expect(dropped, `typed ${typed}: dropped ${dropped} levels`).toBeLessThanOrEqual(3);
    }
  });

  it('random realistic offers — margin and typed net both hold', () => {
    let seed = 20260803;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let worstLevels = 0;
    let columnOffByACent = 0;
    let netMissedByACent = 0;
    let marginTooSmallToResolve = 0;
    for (let run = 0; run < 400; run++) {
      const rows = 2 + Math.floor(rand() * 14);
      const nets: Array<[number, number]> = [];
      for (let i = 0; i < rows; i++) {
        const magnitude = 10 ** Math.floor(rand() * 4);
        nets.push([
          Math.round(magnitude * (0.5 + rand() * 9.5) * 100) / 100,
          1 + Math.floor(rand() * 8),
        ]);
      }
      const comment = rand() < 0.4 ? Math.round(rand() * 800 * 100) / 100 : 0;
      const basis = nets.reduce((s, [p, q]) => s + p * q, 0) + comment;
      const cost = roundMoney(basis * (0.3 + rand() * 0.45), PRICE_DECIMALS);
      const typed = Math.round((5 + rand() * 60) * 100) / 100;

      const marginEntries = runMarginEdit(nets, comment, cost, typed);
      const marginNet = offerNet(marginEntries, comment);
      // The headline guarantee: the totals bar reads back the typed margin —
      // whenever a whole-cent total can express it at all. A hundredth of a
      // percent is worth net x 0.0001 / (1 - margin), so on an offer under about
      // 100 EUR the window is narrower than a cent and no cent-priced offer can
      // sit inside it; those are counted and reported instead.
      const marginWindowFitsACent = cost / (1 - (typed + 0.01) / 100) - cost / (1 - typed / 100) >= 0.01;
      if (marginWindowFitsACent) {
        expect(floorTo((1 - cost / marginNet) * 100, 2), `run ${run}: margin ${typed} → net ${marginNet}`).toBe(typed);
      } else {
        marginTooSmallToResolve += 1;
        expect(Math.abs((1 - cost / marginNet) * 100 - typed), `run ${run}: tiny offer drifted`).toBeLessThan(0.1);
      }
      const columnGap = roundMoney(visibleColumnTotal(marginEntries, comment) - roundMoney(marginNet, 2), 2);
      expect(Math.abs(columnGap), `run ${run}: column off by ${columnGap}`).toBeLessThanOrEqual(0.01);
      if (columnGap !== 0) {
        columnOffByACent += 1;
      }

      const typedTotal = Math.round(basis * (0.6 + rand() * 0.8) * 100) / 100;
      const netEntries = runNetEdit(nets, comment, typedTotal);
      const gotNet = offerNet(netEntries, comment);
      // Whole cents throughout means the column always agrees with the total.
      expect(visibleColumnTotal(netEntries, comment), `run ${run}: net column mismatch`).toBe(roundMoney(gotNet, 2));
      const netGap = roundMoney(gotNet - typedTotal, 2);
      expect(Math.abs(netGap), `run ${run}: typed net ${typedTotal} → ${gotNet}`).toBeLessThanOrEqual(0.01);
      if (netGap !== 0) netMissedByACent += 1;

      for (const e of [...marginEntries, ...netEntries]) {
        worstLevels = Math.max(worstLevels, levelsDropped(e.newNet));
      }
    }
    // A price gives up at most three rounding levels (tens to units to tenths to
    // cents) and never goes below the cent, so the grid always adds up.
    expect(worstLevels).toBeLessThanOrEqual(3);
    // Nothing hidden below the cent means the column never disagrees with the total.
    expect(columnOffByACent, 'the visible column should always sum to the visible total').toBe(0);
    // A typed net lands exactly unless the line quantities cannot compose the last
    // cent; that is a handful of cases in four hundred, and the toast reports the
    // figure actually achieved.
    expect(netMissedByACent / 400).toBeLessThan(0.1);
    // Offers too small for a 2-decimal margin to be expressible in whole cents at
    // all — a couple of euros of total. Vanishingly rare, and bounded above.
    expect(marginTooSmallToResolve / 400).toBeLessThan(0.02);
  });
});
