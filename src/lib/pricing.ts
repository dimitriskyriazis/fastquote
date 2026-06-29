/**
 * Core pricing calculation logic.
 *
 * Eight scenarios resolve missing pricing fields (discounts, net prices,
 * margins) from whatever combination the user has provided, given a list
 * price.  All monetary values are rounded to 4 decimal places, except sell
 * prices derived from a user-typed margin, which get magnitude-based
 * commercial rounding (see roundPriceByMagnitude).
 */

/* ── Types ───────────────────────────────────────────────────────────── */

export type PricingSnapshot = {
  listPrice: number | null;
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netUnitPrice: number | null;
  netCost: number | null;
  margin: number | null;
  // Additional customer discount: an extra percentage that adds to CustomerDiscount
  // before being applied to ListPrice. Effective discount = CD + ACD.
  additionalCustomerDiscount?: number | null;
};

export type PricingInput = PricingSnapshot & {
  provided: {
    listPrice: boolean;
    customerDiscount: boolean;
    telmacoDiscount: boolean;
    netUnitPrice: boolean;
    netCost: boolean;
    margin: boolean;
    additionalCustomerDiscount?: boolean;
  };
  // Single pricing-behaviour toggle (offer default, optionally overridden per row).
  // Governs how *cost-side* edits — Net Cost AND Telmaco Discount — cascade:
  //   false → "Keep Net":    hold Net Unit Price + Customer Discount; Margin floats.
  //   true  → "Keep Margin": hold Margin; recompute Net Unit Price + Customer Discount.
  // Mapped from the PricingHoldMarginOnCost column on Offer / OfferDetails.
  holdMarginOnCostChange?: boolean | null;
};

export type ResolvedPricing = {
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netUnitPrice: number | null;
  netCost: number | null;
  margin: number | null;
  additionalCustomerDiscount?: number | null;
};

export type ScenarioKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

/* ── Helpers ─────────────────────────────────────────────────────────── */

export const roundTo = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export const percentageToFactor = (value: number): number => value / 100;

/**
 * Magnitude-based commercial rounding for sell prices derived from a margin
 * edit — the bigger the price, the coarser the rounding:
 *   |price| < 10      → 2 decimals
 *   |price| < 100     → 1 decimal
 *   |price| < 1.000   → whole units
 *   |price| < 100.000 → tens
 *   otherwise         → hundreds
 * Bands keep the rounding step at or below ~0.5% of the price, so snapping
 * never shifts the achieved margin by more than ~¼ of a percentage point.
 */
export const roundPriceByMagnitude = (value: number): number => {
  const abs = Math.abs(value);
  if (abs < 10) return roundTo(value, 2);
  if (abs < 100) return roundTo(value, 1);
  if (abs < 1000) return Math.round(value);
  const scale = abs < 100000 ? 10 : 100;
  return Math.round(value / scale) * scale;
};

export const deriveMarginPercent = (
  netPrice: number | null,
  telmacoCost: number | null,
): number | null => {
  if (netPrice == null || telmacoCost == null) return null;
  if (Object.is(netPrice, 0)) return null;
  return roundTo((1 - telmacoCost / netPrice) * 100);
};

/**
 * Markup is the cost-basis twin of Margin, expressed as a cost MULTIPLIER (a
 * factor, e.g. 1.25 = sell at 125% of cost), NOT a percentage. Margin is
 * profit / sell price; markup is sell price / cost. They convert exactly:
 *   factor = NetUnitPrice / NetCost = 100 / (100 − margin)
 *   margin = (1 − 1 / factor) · 100
 * so a markup edit can ride the existing margin pathway after conversion.
 * Markup is never stored — it is always derived from NetUnitPrice/NetCost
 * (or Margin).
 */
export const deriveMarkupFactor = (
  netPrice: number | null,
  telmacoCost: number | null,
): number | null => {
  if (netPrice == null || telmacoCost == null) return null;
  if (Object.is(telmacoCost, 0)) return null;
  return roundTo(netPrice / telmacoCost);
};

export const markupFactorFromMargin = (margin: number | null): number | null => {
  if (margin == null || !Number.isFinite(margin) || margin >= 100) return null;
  return roundTo(100 / (100 - margin));
};

export const marginFromMarkupFactor = (factor: number | null): number | null => {
  if (factor == null || !Number.isFinite(factor) || factor <= 0) return null;
  return roundTo((1 - 1 / factor) * 100);
};

/* ── Scenario engine ─────────────────────────────────────────────────── */

export const computeScenario = (
  scenario: ScenarioKey,
  lp: number,
  cd: number | null,
  td: number | null,
  np: number | null,
  tc: number | null,
  m: number | null,
  acd: number | null = null,
): ResolvedPricing | null => {
  // All percentages are stored as percent units (e.g., 12 = 12%).
  // Effective customer discount = cd + acd. ACD is never derived from prices —
  // it's user-set, so when we back out a customer discount from prices we
  // subtract the held ACD to obtain the user-facing CustomerDiscount.
  const acdValue = acd ?? 0;
  switch (scenario) {
    case 'A': {
      if (cd == null || td == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd + acdValue)));
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginPct = deriveMarginPercent(netPrice, telmacoCost);
      return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: netPrice, netCost: telmacoCost, margin: marginPct, additionalCustomerDiscount: acd };
    }
    case 'B': {
      if (td == null || m == null) return null;
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginFactor = 1 - percentageToFactor(m);
      if (Object.is(marginFactor, 0)) return null;
      const netPrice = roundTo(telmacoCost / marginFactor);
      const customerDiscount = roundTo((1 - netPrice / lp) * 100 - acdValue);
      return { customerDiscount, telmacoDiscount: td, netUnitPrice: netPrice, netCost: telmacoCost, margin: m, additionalCustomerDiscount: acd };
    }
    case 'C': {
      if (np == null || tc == null) return null;
      const customerDiscount = roundTo((1 - np / lp) * 100 - acdValue);
      const telmacoDiscount = roundTo((1 - tc / lp) * 100);
      const marginPct = deriveMarginPercent(np, tc);
      return { customerDiscount, telmacoDiscount, netUnitPrice: np, netCost: tc, margin: marginPct, additionalCustomerDiscount: acd };
    }
    case 'D': {
      if (cd == null || m == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd + acdValue)));
      const telmacoCost = roundTo(netPrice * (1 - percentageToFactor(m)));
      const telmacoDiscount = roundTo((1 - telmacoCost / lp) * 100);
      return { customerDiscount: cd, telmacoDiscount, netUnitPrice: netPrice, netCost: telmacoCost, margin: m, additionalCustomerDiscount: acd };
    }
    case 'E': {
      if (cd == null || tc == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd + acdValue)));
      const telmacoDiscount = roundTo((1 - tc / lp) * 100);
      const marginPct = deriveMarginPercent(netPrice, tc);
      return { customerDiscount: cd, telmacoDiscount, netUnitPrice: netPrice, netCost: tc, margin: marginPct, additionalCustomerDiscount: acd };
    }
    case 'F': {
      if (td == null || np == null) return null;
      const customerDiscount = roundTo((1 - np / lp) * 100 - acdValue);
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginPct = deriveMarginPercent(np, telmacoCost);
      return { customerDiscount, telmacoDiscount: td, netUnitPrice: np, netCost: telmacoCost, margin: marginPct, additionalCustomerDiscount: acd };
    }
    case 'G': {
      if (np == null || m == null) return null;
      const telmacoCost = roundTo(np * (1 - percentageToFactor(m)));
      const customerDiscount = roundTo((1 - np / lp) * 100 - acdValue);
      const telmacoDiscount = roundTo((1 - telmacoCost / lp) * 100);
      return { customerDiscount, telmacoDiscount, netUnitPrice: np, netCost: telmacoCost, margin: m, additionalCustomerDiscount: acd };
    }
    case 'H': {
      if (tc == null || m == null) return null;
      const marginFactor = 1 - percentageToFactor(m);
      if (Object.is(marginFactor, 0)) return null;
      const netPrice = roundTo(tc / marginFactor);
      const customerDiscount = roundTo((1 - netPrice / lp) * 100 - acdValue);
      const telmacoDiscount = roundTo((1 - tc / lp) * 100);
      return { customerDiscount, telmacoDiscount, netUnitPrice: netPrice, netCost: tc, margin: m, additionalCustomerDiscount: acd };
    }
    default:
      return null;
  }
};

/* ── List-price derivation ───────────────────────────────────────────── */

/**
 * Derives ListPrice from a known price + its corresponding discount.
 * Priority: NetUnitPrice + CustomerDiscount, then NetCost + TelmacoDiscount.
 */
export const deriveListPrice = (
  np: number | null,
  tc: number | null,
  cd: number | null,
  td: number | null,
  acd: number | null = null,
): number | null => {
  if (np != null && cd != null) {
    const effCd = cd + (acd ?? 0);
    const factor = 1 - percentageToFactor(effCd);
    if (factor > 0 && factor < 1) return roundTo(np / factor);
  }
  if (tc != null && td != null) {
    const factor = 1 - percentageToFactor(td);
    if (factor > 0 && factor < 1) return roundTo(tc / factor);
  }
  return null;
};

/* ── List-price-free derivations ─────────────────────────────────────── */

/**
 * Derives NetUnitPrice, NetCost, and Margin from each other when at least
 * two of the three are known, without needing a list price.
 * Discount fields (CustomerDiscount, TelmacoDiscount) require a list price
 * and are left untouched here.
 */
export const deriveWithoutListPrice = (
  np: number | null,
  tc: number | null,
  m: number | null,
  provided: Pick<PricingInput['provided'], 'netUnitPrice' | 'netCost' | 'margin'>,
): { netUnitPrice: number | null; netCost: number | null; margin: number | null } => {
  let resolvedNp = np;
  let resolvedTc = tc;
  let resolvedM = m;

  const hasUserInput = provided.netUnitPrice || provided.netCost || provided.margin;
  if (!hasUserInput) return { netUnitPrice: np, netCost: tc, margin: m };

  // netCost + margin → netUnitPrice. When the margin is what the user typed,
  // the derived sell price gets magnitude-based commercial rounding and the
  // margin is refreshed to the actual value the rounded price yields.
  if (resolvedNp == null && resolvedTc != null && resolvedM != null) {
    const factor = 1 - percentageToFactor(resolvedM);
    if (factor > 0 && factor < 1) {
      if (provided.margin) {
        resolvedNp = roundPriceByMagnitude(resolvedTc / factor);
        resolvedM = deriveMarginPercent(resolvedNp, resolvedTc) ?? resolvedM;
      } else {
        resolvedNp = roundTo(resolvedTc / factor);
      }
    }
  }
  // netUnitPrice + margin → netCost
  if (resolvedTc == null && resolvedNp != null && resolvedM != null) {
    resolvedTc = roundTo(resolvedNp * (1 - percentageToFactor(resolvedM)));
  }
  // netUnitPrice + netCost → margin
  if (resolvedM == null && resolvedNp != null && resolvedTc != null) {
    resolvedM = deriveMarginPercent(resolvedNp, resolvedTc);
  }

  return { netUnitPrice: resolvedNp, netCost: resolvedTc, margin: resolvedM };
};

/* ── Single-field edit resolver ──────────────────────────────────────── */

/**
 * Handles the common case where the user edited exactly one pricing field.
 * Anchor selection by row type:
 *   - price-list row (ListPrice present) → ListPrice is the anchor.
 *   - ad-hoc row (ListPrice absent)       → NetUnitPrice / NetCost are anchors.
 *
 * Cascade table (price-list row, single edit). "hold" = unchanged,
 * "calc" = recomputed.  Cost-side edits (TelmacoDiscount, NetCost) branch on
 * the Keep Net / Keep Margin toggle (`holdMarginOnCostChange`):
 *
 *   field edited      | toggle      | LP   CD    NP    TD    TC    M
 *   ------------------|-------------|----------------------------------
 *   ListPrice         |     —       | edit hold  calc  hold  calc  hold
 *   CustomerDiscount  |     —       | hold edit  calc  hold  hold  calc
 *   NetUnitPrice      |     —       | hold calc  edit  hold  hold  calc
 *   TelmacoDiscount   | Keep Net    | hold hold  hold  edit  calc  calc
 *   TelmacoDiscount   | Keep Margin | hold calc  calc  edit  calc  hold
 *   NetCost           | Keep Net    | hold hold  hold  calc  edit  calc
 *   NetCost           | Keep Margin | hold calc  calc  calc  edit  hold
 *   Margin            |     —       | hold calc  calc  hold  hold  edit*
 *
 * (*) A margin edit derives NP, then NP is snapped via roundPriceByMagnitude
 * and Margin is refreshed to the actual value the rounded price yields.
 *
 * Keep Margin necessarily recomputes CD + NP: holding LP and the margin while
 * the cost moves forces the sell price (and therefore the discount) to float.
 *
 * On ad-hoc rows (no valid List Price) the discount columns can't be derived,
 * so the absolute fields are held and Margin is refreshed from NP/TC.
 *
 * Returns null if nothing meaningful can be resolved (e.g. invalid denominator).
 */
const resolveSingleFieldEdit = (input: PricingInput): ResolvedPricing | null => {
  const { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: m } = input;
  const acd = input.additionalCustomerDiscount ?? null;
  const acdValue = acd ?? 0;
  const lp = input.listPrice;
  const p = input.provided;
  const hasValidLp = lp != null && Number.isFinite(lp) && !Object.is(lp, 0);
  // Keep Margin (true) vs Keep Net (false) — the single cost-side behaviour toggle.
  const keepMargin = input.holdMarginOnCostChange ?? false;

  // Margin edit: hold NetCost, recompute NetUnitPrice, then cascade discounts.
  // The derived sell price gets magnitude-based commercial rounding, and the
  // stored Margin is refreshed to the actual value the rounded price yields
  // (so the row stays internally consistent: NP × (1 − M%) = TC).
  if (p.margin) {
    if (m == null || tc == null) return null;
    const marginFactor = 1 - percentageToFactor(m);
    if (!(marginFactor > 0)) return null; // margin >= 100% or invalid
    const newNp = roundPriceByMagnitude(tc / marginFactor);
    const newM = deriveMarginPercent(newNp, tc) ?? m;
    if (hasValidLp) {
      // Hold ACD; CD = totalImpliedDiscount - ACD.
      return {
        customerDiscount: roundTo((1 - newNp / lp) * 100 - acdValue),
        telmacoDiscount: td,
        netUnitPrice: newNp,
        netCost: tc,
        margin: newM,
        additionalCustomerDiscount: acd,
      };
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: newNp, netCost: tc, margin: newM, additionalCustomerDiscount: acd };
  }

  // ListPrice edit — hold both discount percentages (CustomerDiscount and
  // TelmacoDiscount) and rescale the absolute prices to the new list price, so
  // Margin is preserved (the screenshot behaviour for a normal row).
  //
  // Guard: when a discount is a stale/absent default (null or 0) while a real
  // absolute price exists, hold that price and back out the implied discount
  // instead. This protects a freshly-typed Net price/cost on a just-inserted
  // row (whose discounts are still 0) from being overwritten.
  if (p.listPrice) {
    if (!hasValidLp) return null;

    const holdNpAbsolute = (cd == null || Object.is(cd, 0)) && np != null && !Object.is(np, 0);
    const holdTcAbsolute = (td == null || Object.is(td, 0)) && tc != null && !Object.is(tc, 0);

    const newNp = holdNpAbsolute
      ? np
      : cd != null ? roundTo(lp * (1 - percentageToFactor(cd + acdValue))) : np;
    const newTc = holdTcAbsolute
      ? tc
      : td != null ? roundTo(lp * (1 - percentageToFactor(td))) : tc;
    const newCd = holdNpAbsolute
      ? (newNp != null ? roundTo((1 - newNp / lp) * 100 - acdValue) : cd)
      : cd;
    const newTd = holdTcAbsolute
      ? (newTc != null ? roundTo((1 - newTc / lp) * 100) : td)
      : td;
    return {
      customerDiscount: newCd,
      telmacoDiscount: newTd,
      netUnitPrice: newNp,
      netCost: newTc,
      margin: deriveMarginPercent(newNp, newTc),
      additionalCustomerDiscount: acd,
    };
  }

  // CustomerDiscount or AdditionalCustomerDiscount edit: NP recomputes from effective CD.
  if (p.customerDiscount || p.additionalCustomerDiscount) {
    if (cd == null && acd == null) return null;
    const effective = (cd ?? 0) + acdValue;
    if (hasValidLp) {
      const factor = 1 - percentageToFactor(effective);
      // An exactly-100% effective discount (factor === 0) is a legitimate free
      // line → net 0 (lp * 0). Only an over-100% discount (factor < 0, which
      // would imply a negative net) is nonsensical, so skip recompute there.
      if (factor < 0) return null;
      const newNp = roundTo(lp * factor);
      return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: newNp, netCost: tc, margin: deriveMarginPercent(newNp, tc), additionalCustomerDiscount: acd };
    }
    // ad-hoc: hold NP; LP back-filled downstream via deriveListPrice
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc), additionalCustomerDiscount: acd };
  }

  // NetUnitPrice edit: hold ACD, derive new CD.
  if (p.netUnitPrice) {
    if (np == null) return null;
    if (hasValidLp) {
      const newCd = roundTo((1 - np / lp) * 100 - acdValue);
      return { customerDiscount: newCd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc), additionalCustomerDiscount: acd };
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc), additionalCustomerDiscount: acd };
  }

  // TelmacoDiscount edit — cost-side edit governed by the Keep Net / Keep Margin
  // toggle. TC always recomputes from the new TD (TC = LP * (1 - TD%)).
  //   Keep Net    → hold NP + CD; Margin floats.
  //   Keep Margin → hold Margin; recompute NP = TC / (1 - M%), then CD.
  if (p.telmacoDiscount) {
    if (td == null) return null;
    if (hasValidLp) {
      const factor = 1 - percentageToFactor(td);
      // 100% Telmaco discount (factor === 0) → net cost 0 (free cost), the
      // cost-side mirror of the CustomerDiscount branch above. Only an
      // over-100% discount (factor < 0, negative cost) is skipped.
      if (factor < 0) return null;
      const newTc = roundTo(lp * factor);
      if (keepMargin && m != null) {
        const marginFactor = 1 - percentageToFactor(m);
        if (marginFactor > 0) {
          const newNp = roundTo(newTc / marginFactor);
          const newCd = roundTo((1 - newNp / lp) * 100 - acdValue);
          return { customerDiscount: newCd, telmacoDiscount: td, netUnitPrice: newNp, netCost: newTc, margin: m, additionalCustomerDiscount: acd };
        }
      }
      return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: newTc, margin: deriveMarginPercent(np, newTc), additionalCustomerDiscount: acd };
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc), additionalCustomerDiscount: acd };
  }

  // NetCost edit — cost-side edit governed by the Keep Net / Keep Margin toggle.
  // TD always recomputes from the new TC (TD = (1 - TC / LP) * 100).
  //   Keep Net    → hold NP + CD; Margin floats (shows the cost impact).
  //   Keep Margin → hold Margin; recompute NP = TC / (1 - M%), then CD.
  if (p.netCost) {
    if (tc == null) return null;
    if (hasValidLp) {
      const newTd = roundTo((1 - tc / lp) * 100);
      if (keepMargin && m != null) {
        // Hold margin → recompute NP = TC / (1 - M%), then CD.
        const marginFactor = 1 - percentageToFactor(m);
        if (marginFactor > 0) {
          const newNp = roundTo(tc / marginFactor);
          const newCd = roundTo((1 - newNp / lp) * 100 - acdValue);
          return { customerDiscount: newCd, telmacoDiscount: newTd, netUnitPrice: newNp, netCost: tc, margin: m, additionalCustomerDiscount: acd };
        }
      }
      return { customerDiscount: cd, telmacoDiscount: newTd, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc), additionalCustomerDiscount: acd };
    }
    if (keepMargin && m != null) {
      const marginFactor = 1 - percentageToFactor(m);
      if (marginFactor > 0) {
        const newNp = roundTo(tc / marginFactor);
        return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: newNp, netCost: tc, margin: m, additionalCustomerDiscount: acd };
      }
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc), additionalCustomerDiscount: acd };
  }

  return null;
};

/* ── Main resolver ───────────────────────────────────────────────────── */

export const resolvePricing = (input: PricingInput): ResolvedPricing | null => {
  const p = input.provided;
  const providedPricingCount =
    (p.customerDiscount ? 1 : 0) +
    (p.telmacoDiscount ? 1 : 0) +
    (p.netUnitPrice ? 1 : 0) +
    (p.netCost ? 1 : 0) +
    (p.margin ? 1 : 0) +
    (p.additionalCustomerDiscount ? 1 : 0);

  // Single-field edit (the common case) → explicit anchor rules.
  // "Only ListPrice edited" also counts as a single edit and routes through here.
  if (providedPricingCount <= 1) {
    return resolveSingleFieldEdit(input);
  }

  // Multi-field edit (bulk paste / row creation / import) → scenario engine.
  // Requires a valid ListPrice to anchor scenarios A–H.
  const lp = input.listPrice;
  if (lp == null || !Number.isFinite(lp) || Object.is(lp, 0)) return null;

  const acd = input.additionalCustomerDiscount ?? null;

  const values: PricingSnapshot = {
    listPrice: lp,
    customerDiscount: input.customerDiscount,
    telmacoDiscount: input.telmacoDiscount,
    netUnitPrice: input.netUnitPrice,
    netCost: input.netCost,
    margin: input.margin,
    additionalCustomerDiscount: acd,
  };

  type PricingRequiredKey = 'customerDiscount' | 'telmacoDiscount' | 'netUnitPrice' | 'netCost' | 'margin';
  const scenarios: Array<{ key: ScenarioKey; required: PricingRequiredKey[] }> = [
    { key: 'A', required: ['customerDiscount', 'telmacoDiscount'] },
    { key: 'B', required: ['telmacoDiscount', 'margin'] },
    { key: 'C', required: ['netUnitPrice', 'netCost'] },
    { key: 'D', required: ['customerDiscount', 'margin'] },
    { key: 'E', required: ['customerDiscount', 'netCost'] },
    { key: 'F', required: ['telmacoDiscount', 'netUnitPrice'] },
    { key: 'G', required: ['netUnitPrice', 'margin'] },
    { key: 'H', required: ['netCost', 'margin'] },
  ];

  for (const scenario of scenarios) {
    const missingRequired = scenario.required.some((field) => values[field] == null);
    const hasUserInput = p.listPrice || p.additionalCustomerDiscount || scenario.required.some((field) => p[field]);
    if (missingRequired || !hasUserInput) continue;
    const resolved = computeScenario(
      scenario.key,
      lp,
      values.customerDiscount,
      values.telmacoDiscount,
      values.netUnitPrice,
      values.netCost,
      values.margin,
      acd,
    );
    if (resolved) return resolved;
  }

  return null;
};
