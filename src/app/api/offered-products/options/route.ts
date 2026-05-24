import { NextResponse } from 'next/server';
import { getPool } from '../../../../lib/sql';

const baseFilter = `
  ISNULL(od.IsCategory, 0) = 0
  AND ISNULL(od.IsComment, 0) = 0
  AND od.ProductID IS NOT NULL
  AND ISNULL(o.Enabled, 0) = 1
  AND ISNULL(o.IsStandardPackage, 0) = 0
`;

export async function GET() {
  try {
    const pool = await getPool();

    const sql = `
      SELECT DISTINCT b.Name AS val
      FROM dbo.OfferDetails od
        INNER JOIN dbo.Offer o ON od.OfferID = o.ID
        LEFT JOIN dbo.Brands b ON od.BrandID = b.ID
      WHERE ${baseFilter} AND b.Name IS NOT NULL
      ORDER BY b.Name;

      SELECT DISTINCT sd.Name AS val
      FROM dbo.OfferDetails od
        INNER JOIN dbo.Offer o ON od.OfferID = o.ID
        LEFT JOIN dbo.SalesDivision sd ON sd.ID = o.SalesDivisionID
      WHERE ${baseFilter} AND sd.Name IS NOT NULL
      ORDER BY sd.Name;

      SELECT DISTINCT mkt.Name AS market, ISNULL(sd.Name, '') AS division
      FROM dbo.OfferDetails od
        INNER JOIN dbo.Offer o ON od.OfferID = o.ID
        LEFT JOIN dbo.Markets mkt ON mkt.ID = o.MarketID
        LEFT JOIN dbo.SalesDivision sd ON sd.ID = o.SalesDivisionID
      WHERE ${baseFilter} AND mkt.Name IS NOT NULL
      ORDER BY mkt.Name;

      SELECT DISTINCT fwc.ShortName AS val
      FROM dbo.OfferDetails od
        INNER JOIN dbo.Offer o ON od.OfferID = o.ID
        LEFT JOIN dbo.FWCs fwc ON fwc.ID = o.ERPFWCProjectID
      WHERE ${baseFilter} AND fwc.ShortName IS NOT NULL
      ORDER BY fwc.ShortName;
    `;

    const result = await pool.request().query(sql);
    const sets = result.recordsets as Array<Array<Record<string, string>>>;

    return NextResponse.json({
      ok: true,
      brands: (sets[0] ?? []).map(r => r.val),
      salesDivisions: (sets[1] ?? []).map(r => r.val),
      markets: (sets[2] ?? []).map(r => ({ market: r.market, division: r.division })),
      fwcProjects: (sets[3] ?? []).map(r => r.val),
    });
  } catch (err) {
    console.error('Failed to load offered-products options', err);
    return NextResponse.json({ ok: false, error: 'Failed to load options' }, { status: 500 });
  }
}
