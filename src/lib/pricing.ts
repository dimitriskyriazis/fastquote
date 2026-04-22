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

/* ── Main resolver ───────────────────────────────────────────────────── */

export const resolvePricing = (input: PricingInput): ResolvedPricing | null => {
  const lp = input.listPrice;
  if (lp == null || !Number.isFinite(lp) || Object.is(lp, 0)) return null;

  const cd = input.customerDiscount;
  const td = input.telmacoDiscount;
  const np = input.netUnitPrice;
  const tc = input.netCost;
  const m = input.margin;
  const providedMap = input.provided;

  // When the user changed only ListPrice and both NetUnitPrice and NetCost
  // are already set, preserve those actual prices and derive discounts from
  // them.  Without this, scenario A would fire using stale CustomerDiscount=0
  // / TelmacoDiscount=0 defaults left over from product insert (see add
  // route's `COALESCE(..., 0)`) and overwrite the prices with
  // ListPrice * (1 - 0) = ListPrice, wiping the user's entered prices.
  const onlyListPriceProvided = providedMap.listPrice
    && !providedMap.customerDiscount
    && !providedMap.telmacoDiscount
    && !providedMap.netUnitPrice
    && !providedMap.netCost
    && !providedMap.margin;

  if (onlyListPriceProvided && np != null && tc != null) {
    return {
      customerDiscount: roundTo((1 - np / lp) * 100),
      telmacoDiscount: roundTo((1 - tc / lp) * 100),
      netUnitPrice: np,
      netCost: tc,
      margin: deriveMarginPercent(np, tc),
    };
  }

  type PricingRequiredKey = keyof PricingInput['provided'];

  const scenarios: Array<{
    key: ScenarioKey;
    required: PricingRequiredKey[];
  }> = [
    { key: 'A', required: ['customerDiscount', 'telmacoDiscount'] },
    { key: 'B', required: ['telmacoDiscount', 'margin'] },
    { key: 'C', required: ['netUnitPrice', 'netCost'] },
    { key: 'D', required: ['customerDiscount', 'margin'] },
    { key: 'E', required: ['customerDiscount', 'netCost'] },
    { key: 'F', required: ['telmacoDiscount', 'netUnitPrice'] },
    { key: 'G', required: ['netUnitPrice', 'margin'] },
    { key: 'H', required: ['netCost', 'margin'] },
  ];

  const values: PricingSnapshot = { listPrice: lp, customerDiscount: cd, telmacoDiscount: td, netUnitPrice: np, netCost: tc, margin: m };

  for (const scenario of scenarios) {
    const missingRequired = scenario.required.some((field) => values[field] == null);
    const hasUserInput = providedMap.listPrice || scenario.required.some((field) => providedMap[field]);
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
