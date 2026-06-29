import { describe, it, expect } from 'vitest';
import {
  roundTo,
  roundPriceByMagnitude,
  percentageToFactor,
  deriveMarginPercent,
  deriveMarkupFactor,
  markupFactorFromMargin,
  marginFromMarkupFactor,
  deriveWithoutListPrice,
  computeScenario,
  resolvePricing,
  type PricingInput,
} from '../pricing';

/* ── roundTo ─────────────────────────────────────────────────────────── */

describe('roundTo', () => {
  it('rounds to 4 decimal places by default', () => {
    expect(roundTo(1.23456789)).toBe(1.2346);
  });

  it('rounds to specified decimal places', () => {
    expect(roundTo(1.23456789, 2)).toBe(1.23);
    expect(roundTo(1.23456789, 0)).toBe(1);
  });

  it('handles negative numbers', () => {
    expect(roundTo(-1.23456789)).toBe(-1.2346);
  });

  it('handles zero', () => {
    expect(roundTo(0)).toBe(0);
  });

  it('handles banker-style rounding edge case (0.5)', () => {
    // JavaScript Math.round rounds 0.5 up
    expect(roundTo(0.00005, 4)).toBe(0.0001);
  });
});

/* ── roundPriceByMagnitude ───────────────────────────────────────────── */

describe('roundPriceByMagnitude', () => {
  it('rounds prices under 10 to 2 decimals', () => {
    expect(roundPriceByMagnitude(0.123456)).toBe(0.12);
    expect(roundPriceByMagnitude(0.897436)).toBe(0.9);
    expect(roundPriceByMagnitude(8.1333)).toBe(8.13);
  });

  it('rounds prices under 100 to 1 decimal', () => {
    expect(roundPriceByMagnitude(12.54)).toBe(12.5);
    expect(roundPriceByMagnitude(20.267)).toBe(20.3);
    expect(roundPriceByMagnitude(99.96)).toBe(100);
  });

  it('rounds prices under 1.000 to whole units', () => {
    expect(roundPriceByMagnitude(101.43)).toBe(101);
    expect(roundPriceByMagnitude(646.67)).toBe(647);
    expect(roundPriceByMagnitude(999.4)).toBe(999);
  });

  it('rounds prices under 100.000 to tens', () => {
    expect(roundPriceByMagnitude(1004.29)).toBe(1000);
    expect(roundPriceByMagnitude(14285.71)).toBe(14290);
    expect(roundPriceByMagnitude(99994)).toBe(99990);
  });

  it('rounds prices of 100.000 and above to hundreds', () => {
    expect(roundPriceByMagnitude(121428.57)).toBe(121400);
    expect(roundPriceByMagnitude(100042.86)).toBe(100000);
  });

  it('uses the absolute value to pick the band for negative prices', () => {
    expect(roundPriceByMagnitude(-12.54)).toBe(-12.5);
    expect(roundPriceByMagnitude(-0.123)).toBe(-0.12);
  });
});

/* ── deriveWithoutListPrice ──────────────────────────────────────────── */

describe('deriveWithoutListPrice — margin-derived sell price', () => {
  it('applies magnitude rounding and refreshes margin when the margin was user-typed', () => {
    const r = deriveWithoutListPrice(null, 10, 22, {
      netUnitPrice: false,
      netCost: false,
      margin: true,
    });
    expect(r.netUnitPrice).toBe(12.8);        // 10 / 0.78 = 12.8205 → 1 decimal
    expect(r.margin).toBeCloseTo(21.875, 3);  // refreshed from rounded NP
    expect(r.netCost).toBe(10);
  });

  it('keeps exact 4-decimal rounding when the margin is merely held', () => {
    const r = deriveWithoutListPrice(null, 10, 20, {
      netUnitPrice: false,
      netCost: true,
      margin: false,
    });
    expect(r.netUnitPrice).toBe(12.5);        // exact, no commercial rounding
    expect(r.margin).toBe(20);                // untouched
  });
});

/* ── percentageToFactor ──────────────────────────────────────────────── */

describe('percentageToFactor', () => {
  it('converts percentage to decimal factor', () => {
    expect(percentageToFactor(12)).toBe(0.12);
    expect(percentageToFactor(100)).toBe(1);
    expect(percentageToFactor(0)).toBe(0);
  });
});

/* ── deriveMarginPercent ─────────────────────────────────────────────── */

describe('deriveMarginPercent', () => {
  it('calculates margin as (1 - cost/price) * 100', () => {
    // NetPrice=100, Cost=80 → Margin = (1 - 80/100) * 100 = 20%
    expect(deriveMarginPercent(100, 80)).toBe(20);
  });

  it('returns null when netPrice is null', () => {
    expect(deriveMarginPercent(null, 80)).toBeNull();
  });

  it('returns null when telmacoCost is null', () => {
    expect(deriveMarginPercent(100, null)).toBeNull();
  });

  it('returns null when netPrice is 0 (division by zero)', () => {
    expect(deriveMarginPercent(0, 80)).toBeNull();
  });

  it('handles negative margin (cost > price)', () => {
    // NetPrice=80, Cost=100 → Margin = (1 - 100/80) * 100 = -25%
    expect(deriveMarginPercent(80, 100)).toBe(-25);
  });

  it('handles 100% margin (cost = 0)', () => {
    expect(deriveMarginPercent(100, 0)).toBe(100);
  });
});

/* ── Markup (cost multiplier — the cost-basis twin of margin) ─────────── */

describe('deriveMarkupFactor', () => {
  it('calculates markup as the cost multiplier price/cost', () => {
    // NetPrice=100, Cost=80 → Markup factor = 100/80 = 1.25
    expect(deriveMarkupFactor(100, 80)).toBe(1.25);
  });

  it('returns null when either input is null', () => {
    expect(deriveMarkupFactor(null, 80)).toBeNull();
    expect(deriveMarkupFactor(100, null)).toBeNull();
  });

  it('returns null when cost is 0 (division by zero)', () => {
    expect(deriveMarkupFactor(100, 0)).toBeNull();
  });

  it('handles a below-cost factor (< 1) when cost > price', () => {
    // NetPrice=80, Cost=100 → factor = 0.8
    expect(deriveMarkupFactor(80, 100)).toBe(0.8);
  });
});

describe('markupFactorFromMargin / marginFromMarkupFactor', () => {
  it('converts 20% margin to a 1.25 markup factor', () => {
    expect(markupFactorFromMargin(20)).toBe(1.25);
  });

  it('converts a 1.25 markup factor to 20% margin', () => {
    expect(marginFromMarkupFactor(1.25)).toBe(20);
  });

  it('round-trips margin → factor → margin', () => {
    for (const margin of [-25, 0, 10, 33.33, 50, 80, 99]) {
      const factor = markupFactorFromMargin(margin);
      expect(factor).not.toBeNull();
      expect(marginFromMarkupFactor(factor as number)).toBeCloseTo(margin, 2);
    }
  });

  it('maps 0 margin to a factor of 1 and back', () => {
    expect(markupFactorFromMargin(0)).toBe(1);
    expect(marginFromMarkupFactor(1)).toBe(0);
  });

  it('matches deriveMarkupFactor for the same NP/NC pair', () => {
    // NP=120, NC=80 → margin = 33.3333%, factor = 1.5
    const margin = deriveMarginPercent(120, 80);
    expect(markupFactorFromMargin(margin)).toBeCloseTo(deriveMarkupFactor(120, 80) as number, 4);
    expect(markupFactorFromMargin(margin)).toBeCloseTo(1.5, 4);
  });

  it('returns null for margin at/above 100% (undefined factor)', () => {
    expect(markupFactorFromMargin(100)).toBeNull();
    expect(markupFactorFromMargin(120)).toBeNull();
    expect(markupFactorFromMargin(null)).toBeNull();
  });

  it('returns null for a non-positive factor (undefined margin)', () => {
    expect(marginFromMarkupFactor(0)).toBeNull();
    expect(marginFromMarkupFactor(-1)).toBeNull();
    expect(marginFromMarkupFactor(null)).toBeNull();
  });

  it('a factor of 0.5 maps to the rejected -100% margin boundary', () => {
    // The panel rejects markup ≤ 0.5 because it yields margin ≤ -100%.
    expect(marginFromMarkupFactor(0.5)).toBe(-100);
    expect(marginFromMarkupFactor(0.51)).toBeGreaterThan(-100);
  });
});

/* ── computeScenario ─────────────────────────────────────────────────── */

describe('computeScenario', () => {
  const LP = 1000; // list price

  describe('Scenario A: CustomerDiscount + TelmacoDiscount → derive Net, Cost, Margin', () => {
    it('computes correctly with 10% customer / 20% telmaco discount', () => {
      const result = computeScenario('A', LP, 10, 20, null, null, null);
      expect(result).not.toBeNull();
      expect(result!.netUnitPrice).toBe(900);    // 1000 * 0.9
      expect(result!.netCost).toBe(800);          // 1000 * 0.8
      expect(result!.customerDiscount).toBe(10);
      expect(result!.telmacoDiscount).toBe(20);
      // Margin = (1 - 800/900) * 100 ≈ 11.1111%
      expect(result!.margin).toBeCloseTo(11.1111, 3);
    });

    it('returns null if customerDiscount is null', () => {
      expect(computeScenario('A', LP, null, 20, null, null, null)).toBeNull();
    });
  });

  describe('Scenario B: TelmacoDiscount + Margin → derive Cost, NetPrice, CustomerDiscount', () => {
    it('computes correctly with 20% telmaco discount and 20% margin', () => {
      const result = computeScenario('B', LP, null, 20, null, null, 20);
      expect(result).not.toBeNull();
      expect(result!.netCost).toBe(800);          // 1000 * 0.8
      // NetPrice = 800 / (1 - 0.20) = 800 / 0.8 = 1000
      expect(result!.netUnitPrice).toBe(1000);
      // CustomerDiscount = (1 - 1000/1000) * 100 = 0%
      expect(result!.customerDiscount).toBe(0);
    });

    it('returns null with 100% margin (division by zero)', () => {
      expect(computeScenario('B', LP, null, 20, null, null, 100)).toBeNull();
    });
  });

  describe('Scenario C: NetUnitPrice + NetCost → derive both discounts and margin', () => {
    it('computes correctly', () => {
      const result = computeScenario('C', LP, null, null, 900, 800, null);
      expect(result).not.toBeNull();
      expect(result!.customerDiscount).toBe(10);  // (1 - 900/1000) * 100
      expect(result!.telmacoDiscount).toBe(20);   // (1 - 800/1000) * 100
      expect(result!.margin).toBeCloseTo(11.1111, 3);
    });
  });

  describe('Scenario D: CustomerDiscount + Margin → derive NetPrice, Cost, TelmacoDiscount', () => {
    it('computes correctly with 10% customer discount and 25% margin', () => {
      const result = computeScenario('D', LP, 10, null, null, null, 25);
      expect(result).not.toBeNull();
      expect(result!.netUnitPrice).toBe(900);     // 1000 * 0.9
      // NetCost = 900 * (1 - 0.25) = 675
      expect(result!.netCost).toBe(675);
      // TelmacoDiscount = (1 - 675/1000) * 100 = 32.5%
      expect(result!.telmacoDiscount).toBe(32.5);
    });
  });

  describe('Scenario E: CustomerDiscount + NetCost → derive NetPrice, TelmacoDiscount, Margin', () => {
    it('computes correctly', () => {
      const result = computeScenario('E', LP, 10, null, null, 800, null);
      expect(result).not.toBeNull();
      expect(result!.netUnitPrice).toBe(900);
      expect(result!.telmacoDiscount).toBe(20);
      expect(result!.margin).toBeCloseTo(11.1111, 3);
    });
  });

  describe('Scenario F: TelmacoDiscount + NetUnitPrice → derive CustomerDiscount, Cost, Margin', () => {
    it('computes correctly', () => {
      const result = computeScenario('F', LP, null, 20, 900, null, null);
      expect(result).not.toBeNull();
      expect(result!.customerDiscount).toBe(10);
      expect(result!.netCost).toBe(800);
      expect(result!.margin).toBeCloseTo(11.1111, 3);
    });
  });

  describe('Scenario G: NetUnitPrice + Margin → derive Cost, both discounts', () => {
    it('computes correctly with 900 net price and 20% margin', () => {
      const result = computeScenario('G', LP, null, null, 900, null, 20);
      expect(result).not.toBeNull();
      // NetCost = 900 * (1 - 0.20) = 720
      expect(result!.netCost).toBe(720);
      expect(result!.customerDiscount).toBe(10);
      // TelmacoDiscount = (1 - 720/1000) * 100 = 28%
      expect(result!.telmacoDiscount).toBe(28);
    });
  });

  describe('Scenario H: NetCost + Margin → derive NetPrice, both discounts', () => {
    it('computes correctly with 800 cost and 20% margin', () => {
      const result = computeScenario('H', LP, null, null, null, 800, 20);
      expect(result).not.toBeNull();
      // NetPrice = 800 / (1 - 0.20) = 800 / 0.8 = 1000
      expect(result!.netUnitPrice).toBe(1000);
      expect(result!.customerDiscount).toBe(0);
      expect(result!.telmacoDiscount).toBe(20);
    });

    it('returns null with 100% margin (division by zero)', () => {
      expect(computeScenario('H', LP, null, null, null, 800, 100)).toBeNull();
    });
  });
});

/* ── resolvePricing ──────────────────────────────────────────────────── */

describe('resolvePricing', () => {
  const noProvided = {
    listPrice: false,
    customerDiscount: false,
    telmacoDiscount: false,
    netUnitPrice: false,
    netCost: false,
    margin: false,
  };

  it('returns null for multi-field edits when listPrice is null', () => {
    // Multi-field edits require LP to anchor the scenario engine.
    const input: PricingInput = {
      listPrice: null,
      customerDiscount: 10,
      telmacoDiscount: 20,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true, telmacoDiscount: true },
    };
    expect(resolvePricing(input)).toBeNull();
  });

  it('returns null for multi-field edits when listPrice is 0', () => {
    const input: PricingInput = {
      listPrice: 0,
      customerDiscount: 10,
      telmacoDiscount: 20,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true, telmacoDiscount: true },
    };
    expect(resolvePricing(input)).toBeNull();
  });

  it('selects Scenario A when both discounts are provided', () => {
    const input: PricingInput = {
      listPrice: 1000,
      customerDiscount: 10,
      telmacoDiscount: 20,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true, telmacoDiscount: true },
    };
    const result = resolvePricing(input);
    expect(result).not.toBeNull();
    expect(result!.netUnitPrice).toBe(900);
    expect(result!.netCost).toBe(800);
  });

  it('requires at least one provided field to match a scenario', () => {
    // All values present but none flagged as "provided" → no scenario matches
    const input: PricingInput = {
      listPrice: 1000,
      customerDiscount: 10,
      telmacoDiscount: 20,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: noProvided,
    };
    expect(resolvePricing(input)).toBeNull();
  });

  it('matches when only listPrice is flagged as provided', () => {
    // Scenario A: both discounts have values, listPrice is provided → match
    const input: PricingInput = {
      listPrice: 1000,
      customerDiscount: 10,
      telmacoDiscount: 20,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, listPrice: true },
    };
    const result = resolvePricing(input);
    expect(result).not.toBeNull();
    expect(result!.netUnitPrice).toBe(900);
  });

  it('falls through to next scenario if first does not match', () => {
    // customerDiscount + margin provided → Scenario D
    const input: PricingInput = {
      listPrice: 1000,
      customerDiscount: 10,
      telmacoDiscount: null,
      netUnitPrice: null,
      netCost: null,
      margin: 25,
      provided: { ...noProvided, customerDiscount: true, margin: true },
    };
    const result = resolvePricing(input);
    expect(result).not.toBeNull();
    expect(result!.netUnitPrice).toBe(900);
    expect(result!.netCost).toBe(675);
    expect(result!.telmacoDiscount).toBe(32.5);
  });

  it('handles realistic pricing: LP=250, CD=15%, TD=30%', () => {
    const input: PricingInput = {
      listPrice: 250,
      customerDiscount: 15,
      telmacoDiscount: 30,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true, telmacoDiscount: true },
    };
    const result = resolvePricing(input);
    expect(result).not.toBeNull();
    // NetPrice = 250 * 0.85 = 212.5
    expect(result!.netUnitPrice).toBe(212.5);
    // NetCost = 250 * 0.70 = 175
    expect(result!.netCost).toBe(175);
    // Margin = (1 - 175/212.5) * 100 ≈ 17.6471%
    expect(result!.margin).toBeCloseTo(17.6471, 3);
  });

  it('handles zero discounts correctly', () => {
    const input: PricingInput = {
      listPrice: 500,
      customerDiscount: 0,
      telmacoDiscount: 0,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true, telmacoDiscount: true },
    };
    const result = resolvePricing(input);
    expect(result).not.toBeNull();
    expect(result!.netUnitPrice).toBe(500);
    expect(result!.netCost).toBe(500);
    expect(result!.margin).toBe(0);
  });

  it('handles negative margin scenario (cost > price)', () => {
    // Customer gets bigger discount than Telmaco → negative margin
    const input: PricingInput = {
      listPrice: 1000,
      customerDiscount: 30,
      telmacoDiscount: 10,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true, telmacoDiscount: true },
    };
    const result = resolvePricing(input);
    expect(result).not.toBeNull();
    expect(result!.netUnitPrice).toBe(700);
    expect(result!.netCost).toBe(900);
    // Margin = (1 - 900/700) * 100 ≈ -28.5714%
    expect(result!.margin!).toBeLessThan(0);
  });
});

/* ── Single-field edit priority rules ────────────────────────────────── */

describe('resolvePricing — single-field edit cascade', () => {
  const noProvided = {
    listPrice: false,
    customerDiscount: false,
    telmacoDiscount: false,
    netUnitPrice: false,
    netCost: false,
    margin: false,
  };

  describe('CustomerDiscount edit', () => {
    it('price-list row: holds ListPrice, recomputes NetUnitPrice (cost side untouched)', () => {
      // Row state: LP=1000, CD=10%, TD=20%, NP=900, TC=800. User edits CD to 15%.
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 15,
        telmacoDiscount: 20,
        netUnitPrice: 900,
        netCost: 800,
        margin: 11.1111,
        provided: { ...noProvided, customerDiscount: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(850);       // 1000 × 0.85
      expect(r.customerDiscount).toBe(15);
      expect(r.netCost).toBe(800);            // unchanged
      expect(r.telmacoDiscount).toBe(20);     // unchanged
      expect(r.margin).toBeCloseTo(5.8824, 3); // refreshed from 850/800
    });

    it('ad-hoc row (no LP): holds NetUnitPrice, returns it unchanged for downstream LP back-fill', () => {
      const input: PricingInput = {
        listPrice: null,
        customerDiscount: 20,
        telmacoDiscount: null,
        netUnitPrice: 12.29,
        netCost: null,
        margin: null,
        provided: { ...noProvided, customerDiscount: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(12.29);     // preserved
      expect(r.customerDiscount).toBe(20);    // as edited
    });

    it('CD=100%: gives the line away free → net 0, margin null', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 100,
        telmacoDiscount: 20,
        netUnitPrice: 900,
        netCost: 800,
        margin: null,
        provided: { ...noProvided, customerDiscount: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(0);         // 1000 × (1 - 1.00)
      expect(r.customerDiscount).toBe(100);
      expect(r.netCost).toBe(800);            // cost-side untouched
      expect(r.telmacoDiscount).toBe(20);     // unchanged
      expect(r.margin).toBeNull();            // margin undefined at net 0
    });

    it('effective discount > 100% (CD + ACD): skips recompute, holds old net', () => {
      // CD edited to 80 while a held ACD of 30 already pushes the effective
      // discount to 110% — a negative net is nonsensical, so net is held.
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 80,
        additionalCustomerDiscount: 30,
        telmacoDiscount: 20,
        netUnitPrice: 900,
        netCost: 800,
        margin: null,
        provided: { ...noProvided, customerDiscount: true },
      };
      expect(resolvePricing(input)).toBeNull();
    });
  });

  describe('NetUnitPrice edit', () => {
    it('price-list row: holds LP, recomputes CustomerDiscount (cost side untouched)', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 20,
        netUnitPrice: 850,    // user edited from 900
        netCost: 800,
        margin: null,
        provided: { ...noProvided, netUnitPrice: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(850);
      expect(r.customerDiscount).toBe(15);    // 1 - 850/1000
      expect(r.netCost).toBe(800);            // unchanged
      expect(r.telmacoDiscount).toBe(20);     // unchanged
    });

    it('ad-hoc row: holds NP, CD unchanged', () => {
      const input: PricingInput = {
        listPrice: null,
        customerDiscount: 17,
        telmacoDiscount: null,
        netUnitPrice: 15,
        netCost: null,
        margin: null,
        provided: { ...noProvided, netUnitPrice: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(15);
      expect(r.customerDiscount).toBe(17);
    });
  });

  describe('TelmacoDiscount edit', () => {
    it('Keep Net (default): recomputes NetCost, holds NP + CD, Margin floats', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 25,    // user changed from 20
        netUnitPrice: 900,
        netCost: 800,
        margin: 11.1111,
        provided: { ...noProvided, telmacoDiscount: true },
        holdMarginOnCostChange: false,
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(750);            // 1000 × 0.75
      expect(r.telmacoDiscount).toBe(25);
      expect(r.netUnitPrice).toBe(900);       // unchanged
      expect(r.customerDiscount).toBe(10);    // unchanged
      expect(r.margin).toBeCloseTo(16.6667, 3); // (1 - 750/900) — floated
    });

    it('Keep Margin: recomputes NetCost, holds Margin, floats NP + CD', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 25,    // user changed from 20
        netUnitPrice: 900,
        netCost: 800,
        margin: 11.1111,        // (1 - 800/900) — to be held
        provided: { ...noProvided, telmacoDiscount: true },
        holdMarginOnCostChange: true,
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(750);            // 1000 × 0.75
      expect(r.telmacoDiscount).toBe(25);
      expect(r.margin).toBe(11.1111);         // held
      // NP = 750 / (1 - 0.111111) = 843.7508 → CD = 1 - 843.7508/1000
      expect(r.netUnitPrice).toBeCloseTo(843.75, 1);
      expect(r.customerDiscount).toBeCloseTo(15.625, 2);
    });

    it('TD=100% (Keep Net): zeroes Net Cost (free cost), Margin floats to 100%', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 100,   // free cost
        netUnitPrice: 900,
        netCost: 800,
        margin: 11.1111,
        provided: { ...noProvided, telmacoDiscount: true },
        holdMarginOnCostChange: false,
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(0);              // 1000 × (1 - 1.00)
      expect(r.telmacoDiscount).toBe(100);
      expect(r.netUnitPrice).toBe(900);       // held (Keep Net)
      expect(r.customerDiscount).toBe(10);    // held
      expect(r.margin).toBe(100);             // (1 - 0/900) — full margin at zero cost
    });
  });

  describe('NetCost edit', () => {
    it('Keep Net (default): recomputes TelmacoDiscount, holds NP + CD, Margin floats', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 20,
        netUnitPrice: 900,
        netCost: 750,    // user edited from 800
        margin: 11.1111,
        provided: { ...noProvided, netCost: true },
        holdMarginOnCostChange: false,
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(750);
      expect(r.telmacoDiscount).toBe(25);     // 1 - 750/1000
      expect(r.netUnitPrice).toBe(900);       // unchanged
      expect(r.customerDiscount).toBe(10);    // unchanged
      expect(r.margin).toBeCloseTo(16.6667, 3); // floated
    });

    it('Keep Margin: recomputes TelmacoDiscount, holds Margin, floats NP + CD', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 20,
        netUnitPrice: 900,
        netCost: 720,    // user edited from 800
        margin: 20,      // to be held
        provided: { ...noProvided, netCost: true },
        holdMarginOnCostChange: true,
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(720);
      expect(r.telmacoDiscount).toBe(28);     // 1 - 720/1000
      expect(r.margin).toBe(20);              // held
      expect(r.netUnitPrice).toBe(900);       // 720 / 0.8
      expect(r.customerDiscount).toBe(10);    // 1 - 900/1000
    });
  });

  describe('Margin edit', () => {
    it('price-list row: holds NetCost, recomputes NP and cascades to CustomerDiscount', () => {
      // "edit cost then margin" workflow: user sets TC=480 earlier, then edits Margin=25%
      // Expected: NP = 480 / 0.75 = 640. CD = 1 - 640/1000 = 36%.
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,    // stale
        telmacoDiscount: 52,     // previously recomputed
        netUnitPrice: 900,       // stale
        netCost: 480,
        margin: 25,
        provided: { ...noProvided, margin: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(640);
      expect(r.customerDiscount).toBe(36);
      expect(r.netCost).toBe(480);            // held
      expect(r.telmacoDiscount).toBe(52);     // unchanged
      expect(r.margin).toBe(25);
    });

    it('ad-hoc row: holds NetCost, recomputes NP with magnitude rounding, discounts unchanged', () => {
      const input: PricingInput = {
        listPrice: null,
        customerDiscount: 17,
        telmacoDiscount: null,
        netUnitPrice: null,
        netCost: 10,
        margin: 22,
        provided: { ...noProvided, margin: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(12.8);      // 10 / 0.78 = 12.8205 → 1 decimal
      expect(r.netCost).toBe(10);
      expect(r.customerDiscount).toBe(17);    // unchanged
      expect(r.margin).toBeCloseTo(21.875, 3); // refreshed from rounded NP
    });

    it('rounds the derived sell price by magnitude and refreshes Margin to the actual value', () => {
      // TC=485, Margin=25% → raw NP = 646.6667 → rounds to whole units = 647.
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: null,
        telmacoDiscount: 51.5,
        netUnitPrice: null,
        netCost: 485,
        margin: 25,
        provided: { ...noProvided, margin: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(647);
      expect(r.customerDiscount).toBeCloseTo(35.3, 3);     // 1 - 647/1000
      expect(r.margin).toBeCloseTo(25.0386, 3);            // 1 - 485/647
      expect(r.netCost).toBe(485);                         // held
    });

    it('applies coarser rounding bands as the derived price grows', () => {
      const mkInput = (netCost: number): PricingInput => ({
        listPrice: null,
        customerDiscount: null,
        telmacoDiscount: null,
        netUnitPrice: null,
        netCost,
        margin: 30,
        provided: { ...noProvided, margin: true },
      });
      // TC=4.49 → 6.4143 → 6.41 (2 decimals); TC=14.2 → 20.2857 → 20.3 (1 decimal);
      // TC=630 → 900 (whole); TC=6300 → 9000 (tens);
      // TC=10000 → 14285.71 → 14290 (tens); TC=85000 → 121428.57 → 121400 (hundreds).
      expect(resolvePricing(mkInput(4.49))!.netUnitPrice).toBe(6.41);
      expect(resolvePricing(mkInput(14.2))!.netUnitPrice).toBe(20.3);
      expect(resolvePricing(mkInput(630))!.netUnitPrice).toBe(900);
      expect(resolvePricing(mkInput(6300))!.netUnitPrice).toBe(9000);
      expect(resolvePricing(mkInput(10000))!.netUnitPrice).toBe(14290);
      expect(resolvePricing(mkInput(85000))!.netUnitPrice).toBe(121400);
    });

    it('returns null when margin is 100% (division by zero)', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: null,
        telmacoDiscount: 20,
        netUnitPrice: null,
        netCost: 800,
        margin: 100,
        provided: { ...noProvided, margin: true },
      };
      expect(resolvePricing(input)).toBeNull();
    });

    it('returns null when NetCost is missing (nothing to hold)', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: null,
        telmacoDiscount: null,
        netUnitPrice: 900,
        netCost: null,
        margin: 25,
        provided: { ...noProvided, margin: true },
      };
      expect(resolvePricing(input)).toBeNull();
    });
  });

  describe('ListPrice edit', () => {
    it('preserves NP and TC when both are populated (derives implied discounts)', () => {
      // Post-insert stale-default guard: row has NP+TC from creation, user sets LP.
      const input: PricingInput = {
        listPrice: 1000,    // newly set
        customerDiscount: 0,  // stale default
        telmacoDiscount: 0,   // stale default
        netUnitPrice: 900,
        netCost: 800,
        margin: null,
        provided: { ...noProvided, listPrice: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(900);       // preserved
      expect(r.netCost).toBe(800);            // preserved
      expect(r.customerDiscount).toBe(10);    // implied
      expect(r.telmacoDiscount).toBe(20);     // implied
    });

    it('with NP/TC empty and discounts populated: recomputes NP and TC from LP', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 20,
        netUnitPrice: null,
        netCost: null,
        margin: null,
        provided: { ...noProvided, listPrice: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(900);
      expect(r.netCost).toBe(800);
    });

    it('preserves NetCost when only TC is populated (user set cost, then list price)', () => {
      // Repro: user types NetCost=100 first, then ListPrice=200. Stale post-insert
      // discount defaults (CD=TD=0) must not overwrite the just-entered cost.
      const input: PricingInput = {
        listPrice: 200,
        customerDiscount: 0,
        telmacoDiscount: 0,
        netUnitPrice: null,
        netCost: 100,
        margin: null,
        provided: { ...noProvided, listPrice: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(100);          // preserved
      expect(r.telmacoDiscount).toBe(50);   // implied from held cost
      expect(r.netUnitPrice).toBe(200);     // derived from CD=0
      expect(r.customerDiscount).toBe(0);   // unchanged
    });

    it('normal consistent row: holds both discounts, rescales prices, preserves margin', () => {
      // Core screenshot behaviour: CD/TD stay, NP/TC auto-calc, Margin unchanged.
      const input: PricingInput = {
        listPrice: 1100,     // raised from 1000
        customerDiscount: 10,
        telmacoDiscount: 20,
        netUnitPrice: 900,   // was 1000 × 0.9
        netCost: 800,        // was 1000 × 0.8
        margin: 11.1111,
        provided: { ...noProvided, listPrice: true },
      };
      const r = resolvePricing(input)!;
      expect(r.customerDiscount).toBe(10);   // held
      expect(r.telmacoDiscount).toBe(20);    // held
      expect(r.netUnitPrice).toBe(990);      // 1100 × 0.9
      expect(r.netCost).toBe(880);           // 1100 × 0.8
      expect(r.margin).toBeCloseTo(11.1111, 3); // preserved
    });

    it('preserves NetUnitPrice when only NP is populated', () => {
      const input: PricingInput = {
        listPrice: 200,
        customerDiscount: 0,
        telmacoDiscount: 0,
        netUnitPrice: 150,
        netCost: null,
        margin: null,
        provided: { ...noProvided, listPrice: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(150);     // preserved
      expect(r.customerDiscount).toBe(25);  // implied from held price
      expect(r.netCost).toBe(200);          // derived from TD=0
      expect(r.telmacoDiscount).toBe(0);    // unchanged
    });
  });
});
