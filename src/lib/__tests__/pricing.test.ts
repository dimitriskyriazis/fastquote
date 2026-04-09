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

  it('returns null when listPrice is null', () => {
    const input: PricingInput = {
      listPrice: null,
      customerDiscount: 10,
      telmacoDiscount: 20,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true },
    };
    expect(resolvePricing(input)).toBeNull();
  });

  it('returns null when listPrice is 0', () => {
    const input: PricingInput = {
      listPrice: 0,
      customerDiscount: 10,
      telmacoDiscount: 20,
      netUnitPrice: null,
      netCost: null,
      margin: null,
      provided: { ...noProvided, customerDiscount: true },
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
