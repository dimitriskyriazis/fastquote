/**
 * EP LINC pricing-policy rules.
 *
 * EP LINC offers price each product line by one of three methods:
 *
 *   RRP        — the policy's CustomerDiscount is non-null/non-zero: the net
 *                unit price is the usual ListPrice × (1 − CustomerDiscount%).
 *   UPLIFT     — the policy's CustomerDiscount is null or 0: the net unit
 *                price is NetCost × 1.15 instead.
 *   COMPARISON — the CustomerDiscount is non-null/non-zero BUT the
 *                manufacturer's whole-offer RRP net total exceeds €25.000:
 *                each of that manufacturer's lines takes the cheaper of its
 *                RRP net and its UPLIFT net.
 *
 * The COMPARISON threshold is deliberately evaluated on the RRP-basis total
 * (ListPrice × (1 − CustomerDiscount%) × Quantity summed per manufacturer),
 * NOT on the stored nets — otherwise picking the cheaper uplift prices could
 * drop the total back under the threshold and the method would oscillate
 * between recalculations.
 *
 * These helpers are the single client-side source of truth (grid column +
 * Fill EP LINC export). The SQL in update-prices / add / paste mirrors the
 * same formulas — keep them in sync.
 */

import { percentageToFactor, roundTo } from './pricing';

export const EP_LINC_UPLIFT_FACTOR = 1.15;
export const EP_LINC_COMPARISON_THRESHOLD = 25000;

// EP LINC pricing policies are named like "EP LINC 2023" — match on the "linc"
// token so future year variants are covered without a code change (same rule
// as AddRequestedProductsModal's import-side detection).
export const isEpLincPricingPolicyName = (name?: string | null): boolean =>
  typeof name === 'string' && name.trim().toLowerCase().includes('linc');

export type EpLincPriceMethod = 'RRP' | 'UPLIFT' | 'COMPARISON';

/** RRP-basis net unit price: ListPrice × (1 − CustomerDiscount%), 4 dp. */
export const epLincRrpNetUnitPrice = (
  listPrice: number | null,
  customerDiscount: number | null,
): number | null => {
  if (listPrice == null || !Number.isFinite(listPrice)) return null;
  return roundTo(listPrice * (1 - percentageToFactor(customerDiscount ?? 0)));
};

/** UPLIFT net unit price: NetCost × 1.15, 4 dp. */
export const epLincUpliftNetUnitPrice = (netCost: number | null): number | null => {
  if (netCost == null || !Number.isFinite(netCost)) return null;
  return roundTo(netCost * EP_LINC_UPLIFT_FACTOR);
};

/**
 * Which pricing method applies to a line, given its policy CustomerDiscount
 * and its manufacturer's whole-offer RRP net total.
 */
export const resolveEpLincPriceMethod = (
  customerDiscount: number | null,
  brandRrpNetTotal: number | null,
): EpLincPriceMethod => {
  if (customerDiscount == null || customerDiscount === 0) return 'UPLIFT';
  if (brandRrpNetTotal != null && brandRrpNetTotal > EP_LINC_COMPARISON_THRESHOLD) {
    return 'COMPARISON';
  }
  return 'RRP';
};

/**
 * Which side a COMPARISON line lands on: uplift wins only when its net is
 * strictly cheaper than the RRP net (a tie or an incomputable side keeps RRP).
 */
export const epLincComparisonPicksUplift = (line: {
  listPrice: number | null;
  customerDiscount: number | null;
  netCost: number | null;
}): boolean => {
  const rrpNet = epLincRrpNetUnitPrice(line.listPrice, line.customerDiscount);
  const upliftNet = epLincUpliftNetUnitPrice(line.netCost);
  return rrpNet != null && upliftNet != null && upliftNet < rrpNet;
};

/**
 * Whether the Fill EP LINC export reveals the line's cost: UPLIFT lines and
 * ALL COMPARISON lines do (EP LINC needs the cost to run the comparison on
 * their side, whichever way it lands); plain RRP lines never do.
 */
export const epLincLineRevealsCost = (line: {
  customerDiscount: number | null;
  brandRrpNetTotal: number | null;
}): boolean => {
  const method = resolveEpLincPriceMethod(line.customerDiscount, line.brandRrpNetTotal);
  return method === 'UPLIFT' || method === 'COMPARISON';
};

/**
 * Display label for the grid's Price Method column. COMPARISON lines show the
 * winning side: "COMPARISON (UPLIFT)" when the uplift net is cheaper, else
 * "COMPARISON (RRP)".
 */
export const formatEpLincPriceMethodLabel = (line: {
  customerDiscount: number | null;
  brandRrpNetTotal: number | null;
  listPrice: number | null;
  netCost: number | null;
}): string => {
  const method = resolveEpLincPriceMethod(line.customerDiscount, line.brandRrpNetTotal);
  if (method !== 'COMPARISON') return method;
  return epLincComparisonPicksUplift(line) ? 'COMPARISON (UPLIFT)' : 'COMPARISON (RRP)';
};

export type EpLincBrandTotalLine = {
  /** Grouping key — brand/manufacturer name (client) or id (server). */
  brandKey: string | null;
  listPrice: number | null;
  customerDiscount: number | null;
  quantity: number | null;
};

/**
 * Whole-offer RRP net total per manufacturer. Callers pass only the lines that
 * count: assigned product rows, excluding categories/comments/services and
 * excluding options (alternates aren't part of the purchased volume) — the
 * same predicate the server uses for EpLincBrandRrpTotal.
 */
export const computeEpLincBrandRrpTotals = (
  lines: EpLincBrandTotalLine[],
): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (!line.brandKey) continue;
    const rrpNet = epLincRrpNetUnitPrice(line.listPrice, line.customerDiscount);
    if (rrpNet == null) continue;
    const contribution = rrpNet * (line.quantity ?? 0);
    totals.set(line.brandKey, (totals.get(line.brandKey) ?? 0) + contribution);
  }
  return totals;
};
