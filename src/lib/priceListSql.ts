// Shared SQL predicate for "this price list is currently in effect", i.e. its
// prices may be used to price offer lines right now. A list is in effect when:
//   1. it is enabled,
//   2. its ValidFromDate has arrived — lists imported with a future Valid From
//      stay dormant until their start date (scheduled activation), and
//   3. it has not been superseded: when an import marks a list as replaced
//      (PriceLists.ReplacedByPriceListID) the old list drops out the moment its
//      replacement comes into effect, independent of the Enabled-flag sweep in
//      priceListReplacementSweep.ts (which only does the bookkeeping flip).
//
// Every query that PICKS a price list for pricing must use this predicate
// instead of a bare `pl.Enabled = 1` so the old->new handover is exact.
//
// NOTE: dbo.PriceLists.ReplacedByPriceListID is added by
// scripts/migrations/2026-07-14-pricelist-scheduled-activation.sql — that
// script must run before code using this predicate is deployed.
export const priceListInEffectSql = (alias = 'pl'): string => `(${alias}.Enabled = 1
          AND (${alias}.ValidFromDate IS NULL OR ${alias}.ValidFromDate <= SYSUTCDATETIME())
          AND NOT EXISTS (
            SELECT 1 FROM dbo.PriceLists ${alias}_rep
            WHERE ${alias}_rep.ID = ${alias}.ReplacedByPriceListID
              AND ${alias}_rep.Enabled = 1
              AND (${alias}_rep.ValidFromDate IS NULL OR ${alias}_rep.ValidFromDate <= SYSUTCDATETIME())
          ))`;
