import { NextResponse } from 'next/server';
import { getPool } from '../../../../lib/sql';

// Dropdown options for the Offers page "Pivot Mode" pre-filter bar (Sales Division + Market).
// Sourced from the same population as the summary (enabled, non-standard-package offers). Markets
// carry their division so the Market dropdown can be narrowed by the selected Sales Division.
export async function GET() {
  try {
    const pool = await getPool();

    const optionsSql = `
      SELECT DISTINCT sd.Name AS val
      FROM dbo.Offer o
        INNER JOIN dbo.SalesDivision sd ON sd.ID = o.SalesDivisionID
      WHERE ISNULL(o.IsStandardPackage, 0) = 0 AND ISNULL(o.Enabled, 0) = 1 AND sd.Name IS NOT NULL
      ORDER BY sd.Name;

      SELECT DISTINCT mkt.Name AS market, ISNULL(sd.Name, '') AS division
      FROM dbo.Offer o
        INNER JOIN dbo.Markets mkt ON mkt.ID = o.MarketID
        LEFT JOIN dbo.SalesDivision sd ON sd.ID = o.SalesDivisionID
      WHERE ISNULL(o.IsStandardPackage, 0) = 0 AND ISNULL(o.Enabled, 0) = 1 AND mkt.Name IS NOT NULL
      ORDER BY mkt.Name;
    `;

    const result = await pool.request().query(optionsSql);
    const sets = result.recordsets as Array<Array<Record<string, string>>>;

    return NextResponse.json({
      ok: true,
      salesDivisions: (sets[0] ?? []).map(r => r.val),
      markets: (sets[1] ?? []).map(r => ({ market: r.market, division: r.division })),
    });
  } catch (err) {
    console.error('Failed to load offers options', err);
    return NextResponse.json({ ok: false, error: 'Failed to load options' }, { status: 500 });
  }
}
