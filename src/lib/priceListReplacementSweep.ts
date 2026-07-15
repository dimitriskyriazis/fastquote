import type { ConnectionPool } from 'mssql';

// Flips Enabled = 0 on price lists whose scheduled replacement has come into
// effect (import with a previous list selected + a future Valid From defers
// the deactivation instead of disabling immediately). Pricing queries already
// ignore superseded lists via priceListInEffectSql, so this sweep is pure
// bookkeeping: it makes the Enabled flag — and the price-lists grid — reflect
// the handover. Runs opportunistically on price-lists page loads and imports;
// idempotent and a no-op when nothing is pending.
export async function sweepScheduledPriceListReplacements(pool: ConnectionPool): Promise<number> {
  try {
    const result = await pool.request().query(`
      UPDATE old
      SET Enabled = 0,
          ModifiedOn = SYSUTCDATETIME()
      FROM dbo.PriceLists old
      INNER JOIN dbo.PriceLists rep ON rep.ID = old.ReplacedByPriceListID
      WHERE old.Enabled = 1
        AND rep.Enabled = 1
        AND (rep.ValidFromDate IS NULL OR rep.ValidFromDate <= SYSUTCDATETIME())
    `);
    return result.rowsAffected?.[0] ?? 0;
  } catch (err) {
    // The sweep must never break its caller (e.g. if the migration adding
    // ReplacedByPriceListID hasn't run yet); pricing correctness does not
    // depend on it.
    console.error('Scheduled price list replacement sweep failed:', err);
    return 0;
  }
}
