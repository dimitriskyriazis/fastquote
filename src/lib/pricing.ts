/**
 * Core pricing calculation logic.
 *
 * Eight scenarios resolve missing pricing fields (discounts, net prices,
 * margins) from whatever combination the user has provided, given a list
 * price.  All monetary values are rounded to 4 decimal places.
 */

/* ── Types ───────────────────────────────────────────────────────────── */

export type PricingSnapshot = {
  listPrice: number | null;
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netUnitPrice: number | null;
  netCost: number | null;
  margin: number | null;
};

export type PricingInput = PricingSnapshot & {
  provided: {
    listPrice: boolean;
    customerDiscount: boolean;
    telmacoDiscount: boolean;
    netUnitPrice: boolean;
    netCost: boolean;
    margin: boolean;
  };
};

export type ResolvedPricing = {
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netUnitPrice: number | null;
  netCost: number | null;
  margin: number | null;
};

export type ScenarioKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';

/* ── Helpers ─────────────────────────────────────────────────────────── */

export const roundTo = (value: number, places = 4): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export const percentageToFactor = (value: number): number => value / 100;

export const deriveMarginPercent = (
  netPrice: number | null,
  telmacoCost: number | null,
): number | null => {
  if (netPrice == null || telmacoCost == null) return null;
  if (Object.is(netPrice, 0)) return null;
  return roundTo((1 - telmacoCost / netPrice) * 100);
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
): ResolvedPricing | null => {
  // All percentages are stored as percent units (e.g., 12 = 12%).
  switch (scenario) {
    case 'A': {
      if (cd == null || td == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd)));
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginPct = deriveMarginPercent(netPrice, telmacoCost);
      return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: netPrice, netCost: telmacoCost, margin: marginPct };
    }
    case 'B': {
      if (td == null || m == null) return null;
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginFactor = 1 - percentageToFactor(m);
      if (Object.is(marginFactor, 0)) return null;
      const netPrice = roundTo(telmacoCost / marginFactor);
      const customerDiscount = roundTo((1 - netPrice / lp) * 100);
      return { customerDiscount, telmacoDiscount: td, netUnitPrice: netPrice, netCost: telmacoCost, margin: m };
    }
    case 'C': {
      if (np == null || tc == null) return null;
      const customerDiscount = roundTo((1 - np / lp) * 100);
      const telmacoDiscount = roundTo((1 - tc / lp) * 100);
      const marginPct = deriveMarginPercent(np, tc);
      return { customerDiscount, telmacoDiscount, netUnitPrice: np, netCost: tc, margin: marginPct };
    }
    case 'D': {
      if (cd == null || m == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd)));
      const telmacoCost = roundTo(netPrice * (1 - percentageToFactor(m)));
      const telmacoDiscount = roundTo((1 - telmacoCost / lp) * 100);
      return { customerDiscount: cd, telmacoDiscount, netUnitPrice: netPrice, netCost: telmacoCost, margin: m };
    }
    case 'E': {
      if (cd == null || tc == null) return null;
      const netPrice = roundTo(lp * (1 - percentageToFactor(cd)));
      const telmacoDiscount = roundTo((1 - tc / lp) * 100);
      const marginPct = deriveMarginPercent(netPrice, tc);
      return { customerDiscount: cd, telmacoDiscount, netUnitPrice: netPrice, netCost: tc, margin: marginPct };
    }
    case 'F': {
      if (td == null || np == null) return null;
      const customerDiscount = roundTo((1 - np / lp) * 100);
      const telmacoCost = roundTo(lp * (1 - percentageToFactor(td)));
      const marginPct = deriveMarginPercent(np, telmacoCost);
      return { customerDiscount, telmacoDiscount: td, netUnitPrice: np, netCost: telmacoCost, margin: marginPct };
    }
    case 'G': {
      if (np == null || m == null) return null;
      const telmacoCost = roundTo(np * (1 - percentageToFactor(m)));
      const customerDiscount = roundTo((1 - np / lp) * 100);
      const telmacoDiscount = roundTo((1 - telmacoCost / lp) * 100);
      return { customerDiscount, telmacoDiscount, netUnitPrice: np, netCost: telmacoCost, margin: m };
    }
    case 'H': {
      if (tc == null || m == null) return null;
      const marginFactor = 1 - percentageToFactor(m);
      if (Object.is(marginFactor, 0)) return null;
      const netPrice = roundTo(tc / marginFactor);
      const customerDiscount = roundTo((1 - netPrice / lp) * 100);
      const telmacoDiscount = roundTo((1 - tc / lp) * 100);
      return { customerDiscount, telmacoDiscount, netUnitPrice: netPrice, netCost: tc, margin: m };
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
): number | null => {
  if (np != null && cd != null) {
    const factor = 1 - percentageToFactor(cd);
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

  // netCost + margin → netUnitPrice
  if (resolvedNp == null && resolvedTc != null && resolvedM != null) {
    const factor = 1 - percentageToFactor(resolvedM);
    if (factor > 0 && factor < 1) {
      resolvedNp = roundTo(resolvedTc / factor);
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
 * Cascade table (single edit):
 *   field edited        | price-list row                    | ad-hoc row
 *   --------------------|-----------------------------------|--------------------------
 *   ListPrice           | hold discounts → recompute NP,TC  | same
 *   CustomerDiscount    | hold LP → recompute NP            | hold NP → LP back-fills downstream
 *   NetUnitPrice        | hold LP → recompute CD            | hold CD → LP back-fills downstream
 *   TelmacoDiscount     | hold LP → recompute TC            | hold TC → LP back-fills downstream
 *   NetCost             | hold LP → recompute TD            | hold TD → LP back-fills downstream
 *   Margin              | hold TC → recompute NP → recompute CD (holding LP) | hold TC → recompute NP
 *
 * Margin is always refreshed from NP/TC when both are known and the user didn't
 * edit Margin directly.
 *
 * Returns null if nothing meaningful can be resolved (e.g. invalid denominator).
 */
const resolveSingleFieldEdit = (input: PricingInput): ResolvedPricing | null => {
  const { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: m } = input;
  const lp = input.listPrice;
  const p = input.provided;
  const hasValidLp = lp != null && Number.isFinite(lp) && !Object.is(lp, 0);

  // Margin edit: hold NetCost, recompute NetUnitPrice, then cascade discounts.
  if (p.margin) {
    if (m == null || tc == null) return null;
    const marginFactor = 1 - percentageToFactor(m);
    if (!(marginFactor > 0)) return null; // margin >= 100% or invalid
    const newNp = roundTo(tc / marginFactor);
    if (hasValidLp) {
      return {
        customerDiscount: roundTo((1 - newNp / lp) * 100),
        telmacoDiscount: td,
        netUnitPrice: newNp,
        netCost: tc,
        margin: m,
      };
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: newNp, netCost: tc, margin: m };
  }

  // ListPrice edit: hold discounts, recompute NP and TC.
  if (p.listPrice) {
    if (!hasValidLp) return null;
    // If NP and TC are already populated (stale discount defaults common after insert)
    // prefer holding the prices and deriving the implied discounts. Otherwise recompute
    // prices from the discounts.
    if (np != null && tc != null) {
      return {
        customerDiscount: roundTo((1 - np / lp) * 100),
        telmacoDiscount: roundTo((1 - tc / lp) * 100),
        netUnitPrice: np,
        netCost: tc,
        margin: deriveMarginPercent(np, tc),
      };
    }
    const newNp = cd != null ? roundTo(lp * (1 - percentageToFactor(cd))) : np;
    const newTc = td != null ? roundTo(lp * (1 - percentageToFactor(td))) : tc;
    return {
      customerDiscount: cd,
      telmacoDiscount: td,
      netUnitPrice: newNp,
      netCost: newTc,
      margin: deriveMarginPercent(newNp, newTc),
    };
  }

  // CustomerDiscount edit
  if (p.customerDiscount) {
    if (cd == null) return null;
    if (hasValidLp) {
      const factor = 1 - percentageToFactor(cd);
      if (!(factor > 0)) return null; // 100%+ discount: skip recompute
      const newNp = roundTo(lp * factor);
      return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: newNp, netCost: tc, margin: deriveMarginPercent(newNp, tc) };
    }
    // ad-hoc: hold NP; LP back-filled downstream via deriveListPrice
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc) };
  }

  // NetUnitPrice edit
  if (p.netUnitPrice) {
    if (np == null) return null;
    if (hasValidLp) {
      const newCd = roundTo((1 - np / lp) * 100);
      return { customerDiscount: newCd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc) };
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc) };
  }

  // TelmacoDiscount edit (mirror of CD)
  if (p.telmacoDiscount) {
    if (td == null) return null;
    if (hasValidLp) {
      const factor = 1 - percentageToFactor(td);
      if (!(factor > 0)) return null;
      const newTc = roundTo(lp * factor);
      return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: newTc, margin: deriveMarginPercent(np, newTc) };
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc) };
  }

  // NetCost edit (mirror of NP)
  if (p.netCost) {
    if (tc == null) return null;
    if (hasValidLp) {
      const newTd = roundTo((1 - tc / lp) * 100);
      return { customerDiscount: cd, telmacoDiscount: newTd, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc) };
    }
    return { customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: deriveMarginPercent(np, tc) };
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
    (p.margin ? 1 : 0);

  // Single-field edit (the common case) → explicit anchor rules.
  // "Only ListPrice edited" also counts as a single edit and routes through here.
  if (providedPricingCount <= 1) {
    return resolveSingleFieldEdit(input);
  }

  // Multi-field edit (bulk paste / row creation / import) → scenario engine.
  // Requires a valid ListPrice to anchor scenarios A–H.
  const lp = input.listPrice;
  if (lp == null || !Number.isFinite(lp) || Object.is(lp, 0)) return null;

  const values: PricingSnapshot = {
    listPrice: lp,
    customerDiscount: input.customerDiscount,
    telmacoDiscount: input.telmacoDiscount,
    netUnitPrice: input.netUnitPrice,
    netCost: input.netCost,
    margin: input.margin,
  };

  type PricingRequiredKey = keyof PricingInput['provided'];
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
    const hasUserInput = p.listPrice || scenario.required.some((field) => p[field]);
    if (missingRequired || !hasUserInput) continue;
    const resolved = computeScenario(
      scenario.key,
      lp,
      values.customerDiscount,
      values.telmacoDiscount,
      values.netUnitPrice,
      values.netCost,
      values.margin,
    );
    if (resolved) return resolved;
  }

  return null;
};
