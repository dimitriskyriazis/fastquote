import { describe, it, expect } from 'vitest';
import {
  roundTo,
  percentageToFactor,
  deriveMarginPercent,
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

    it('returns null when denominator blows up (CD=100%)', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 100,
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
    it('price-list row: holds LP, recomputes NetCost (sell side untouched)', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 25,    // user changed from 20
        netUnitPrice: 900,
        netCost: 800,
        margin: null,
        provided: { ...noProvided, telmacoDiscount: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(750);            // 1000 × 0.75
      expect(r.telmacoDiscount).toBe(25);
      expect(r.netUnitPrice).toBe(900);       // unchanged
      expect(r.customerDiscount).toBe(10);    // unchanged
    });
  });

  describe('NetCost edit', () => {
    it('price-list row: holds LP, recomputes TelmacoDiscount (sell side untouched)', () => {
      const input: PricingInput = {
        listPrice: 1000,
        customerDiscount: 10,
        telmacoDiscount: 20,
        netUnitPrice: 900,
        netCost: 750,    // user edited from 800
        margin: null,
        provided: { ...noProvided, netCost: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netCost).toBe(750);
      expect(r.telmacoDiscount).toBe(25);     // 1 - 750/1000
      expect(r.netUnitPrice).toBe(900);       // unchanged
      expect(r.customerDiscount).toBe(10);    // unchanged
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

    it('ad-hoc row: holds NetCost, recomputes NP, discounts unchanged', () => {
      const input: PricingInput = {
        listPrice: null,
        customerDiscount: 17,
        telmacoDiscount: null,
        netUnitPrice: null,
        netCost: 10,
        margin: 20,
        provided: { ...noProvided, margin: true },
      };
      const r = resolvePricing(input)!;
      expect(r.netUnitPrice).toBe(12.5);      // 10 / 0.8
      expect(r.netCost).toBe(10);
      expect(r.customerDiscount).toBe(17);    // unchanged
      expect(r.margin).toBe(20);
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
  });
});
