import { MAX_STORED_PERCENT } from './pricing';

/**
 * Wraps a T-SQL numeric expression so its value is clamped to the
 * DECIMAL(5,2) storage range of the OfferDetails percentage columns
 * (Margin, TelmacoDiscount, CustomerDiscount, AdditionalCustomerDiscount):
 * ±999.99. Derived percentages exceed that range whenever a cost dwarfs the
 * net/list price it is divided by (e.g. a pricelist cost far above the
 * discounted sell price), and an out-of-range value fails the entire UPDATE
 * with SQL error 8115 (arithmetic overflow). JS-side derivations get the
 * same treatment in lib/pricing.ts via MAX_STORED_PERCENT.
 *
 * The expression is inlined three times (SQL Server < 2022 has no
 * GREATEST/LEAST), so pass a pure expression without side effects.
 */
export const clampPercentSql = (expr: string): string =>
  `CASE WHEN (${expr}) > ${MAX_STORED_PERCENT} THEN ${MAX_STORED_PERCENT} `
  + `WHEN (${expr}) < ${-MAX_STORED_PERCENT} THEN ${-MAX_STORED_PERCENT} `
  + `ELSE (${expr}) END`;
