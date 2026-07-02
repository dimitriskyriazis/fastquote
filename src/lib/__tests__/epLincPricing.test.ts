import { describe, it, expect } from 'vitest';
import {
  EP_LINC_COMPARISON_THRESHOLD,
  computeEpLincBrandRrpTotals,
  epLincLineUsesUplift,
  epLincRrpNetUnitPrice,
  epLincUpliftNetUnitPrice,
  formatEpLincPriceMethodLabel,
  isEpLincPricingPolicyName,
  resolveEpLincPriceMethod,
} from '../epLincPricing';

describe('isEpLincPricingPolicyName', () => {
  it('matches the linc token across year variants and casing', () => {
    expect(isEpLincPricingPolicyName('EP LINC 2023')).toBe(true);
    expect(isEpLincPricingPolicyName('ep linc 2026')).toBe(true);
    expect(isEpLincPricingPolicyName('  EP LINC ')).toBe(true);
  });

  it('rejects other policies and empty values', () => {
    expect(isEpLincPricingPolicyName('AVC4')).toBe(false);
    expect(isEpLincPricingPolicyName('')).toBe(false);
    expect(isEpLincPricingPolicyName(null)).toBe(false);
    expect(isEpLincPricingPolicyName(undefined)).toBe(false);
  });
});

describe('epLincRrpNetUnitPrice / epLincUpliftNetUnitPrice', () => {
  it('computes RRP net as list price minus customer discount', () => {
    expect(epLincRrpNetUnitPrice(100, 20)).toBe(80);
    // 99.99 × 0.875 = 87.49125 → IEEE754 stores it just under the .5 midpoint,
    // so roundTo lands on .4912 (the codebase-wide rounding semantics).
    expect(epLincRrpNetUnitPrice(99.99, 12.5)).toBe(87.4912);
  });

  it('treats a null discount as 0 and a null list price as unknown', () => {
    expect(epLincRrpNetUnitPrice(100, null)).toBe(100);
    expect(epLincRrpNetUnitPrice(null, 20)).toBeNull();
  });

  it('computes uplift net as cost * 1.15', () => {
    expect(epLincUpliftNetUnitPrice(100)).toBe(115);
    expect(epLincUpliftNetUnitPrice(33.3333)).toBe(38.3333);
    expect(epLincUpliftNetUnitPrice(null)).toBeNull();
  });
});

describe('resolveEpLincPriceMethod', () => {
  it('is UPLIFT when the policy customer discount is null or 0', () => {
    expect(resolveEpLincPriceMethod(null, 50000)).toBe('UPLIFT');
    expect(resolveEpLincPriceMethod(0, 50000)).toBe('UPLIFT');
  });

  it('is RRP for a discounted brand at or under the threshold', () => {
    expect(resolveEpLincPriceMethod(20, 10000)).toBe('RRP');
    expect(resolveEpLincPriceMethod(20, EP_LINC_COMPARISON_THRESHOLD)).toBe('RRP');
    expect(resolveEpLincPriceMethod(20, null)).toBe('RRP');
  });

  it('is COMPARISON for a discounted brand over the threshold', () => {
    expect(resolveEpLincPriceMethod(20, EP_LINC_COMPARISON_THRESHOLD + 0.01)).toBe('COMPARISON');
  });
});

describe('epLincLineUsesUplift', () => {
  it('UPLIFT lines reveal cost only when a cost exists', () => {
    expect(epLincLineUsesUplift({ customerDiscount: 0, brandRrpNetTotal: null, listPrice: 100, netCost: 60 })).toBe(true);
    expect(epLincLineUsesUplift({ customerDiscount: null, brandRrpNetTotal: null, listPrice: 100, netCost: null })).toBe(false);
  });

  it('RRP lines never reveal cost', () => {
    expect(epLincLineUsesUplift({ customerDiscount: 20, brandRrpNetTotal: 10000, listPrice: 100, netCost: 10 })).toBe(false);
  });

  it('COMPARISON lines reveal cost only when uplift beats RRP', () => {
    // RRP net = 80, uplift net = 69 → uplift wins.
    expect(epLincLineUsesUplift({ customerDiscount: 20, brandRrpNetTotal: 30000, listPrice: 100, netCost: 60 })).toBe(true);
    // RRP net = 80, uplift net = 92 → RRP wins.
    expect(epLincLineUsesUplift({ customerDiscount: 20, brandRrpNetTotal: 30000, listPrice: 100, netCost: 80 })).toBe(false);
    // Equal (RRP net = 80, uplift net = 80) → RRP wins the tie, cost stays hidden.
    expect(epLincLineUsesUplift({ customerDiscount: 20, brandRrpNetTotal: 30000, listPrice: 100, netCost: 69.5652 })).toBe(false);
  });
});

describe('formatEpLincPriceMethodLabel', () => {
  it('labels plain methods as-is', () => {
    expect(formatEpLincPriceMethodLabel({ customerDiscount: 0, brandRrpNetTotal: null, listPrice: 100, netCost: 60 })).toBe('UPLIFT');
    expect(formatEpLincPriceMethodLabel({ customerDiscount: 20, brandRrpNetTotal: 10000, listPrice: 100, netCost: 60 })).toBe('RRP');
  });

  it('labels comparison lines with the cheaper side', () => {
    // RRP net = 80, uplift net = 69 → uplift is cheaper.
    expect(formatEpLincPriceMethodLabel({ customerDiscount: 20, brandRrpNetTotal: 30000, listPrice: 100, netCost: 60 })).toBe('COMPARISON (UPLIFT)');
    // RRP net = 80, uplift net = 92 → RRP is cheaper.
    expect(formatEpLincPriceMethodLabel({ customerDiscount: 20, brandRrpNetTotal: 30000, listPrice: 100, netCost: 80 })).toBe('COMPARISON (RRP)');
    // Uplift side incomputable (no cost) → RRP.
    expect(formatEpLincPriceMethodLabel({ customerDiscount: 20, brandRrpNetTotal: 30000, listPrice: 100, netCost: null })).toBe('COMPARISON (RRP)');
  });
});

describe('computeEpLincBrandRrpTotals', () => {
  it('sums RRP net x quantity per brand and skips unpriced or brandless lines', () => {
    const totals = computeEpLincBrandRrpTotals([
      { brandKey: 'd&b', listPrice: 100, customerDiscount: 20, quantity: 10 },   // 800
      { brandKey: 'd&b', listPrice: 50, customerDiscount: 20, quantity: 2 },     // 80
      { brandKey: 'Sony', listPrice: 200, customerDiscount: 0, quantity: 5 },    // 1000 (no discount → RRP basis = LP)
      { brandKey: null, listPrice: 100, customerDiscount: 20, quantity: 1 },     // skipped
      { brandKey: 'd&b', listPrice: null, customerDiscount: 20, quantity: 4 },   // skipped
    ]);
    expect(totals.get('d&b')).toBe(880);
    expect(totals.get('Sony')).toBe(1000);
    expect(totals.size).toBe(2);
  });

  it('treats a null quantity as 0', () => {
    const totals = computeEpLincBrandRrpTotals([
      { brandKey: 'K&M', listPrice: 100, customerDiscount: 10, quantity: null },
    ]);
    expect(totals.get('K&M')).toBe(0);
  });
});
