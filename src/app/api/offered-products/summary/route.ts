import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/sql';
import sql from 'mssql';

const baseFilter = `
  ISNULL(od.IsCategory, 0) = 0
  AND ISNULL(od.IsComment, 0) = 0
  AND od.ProductID IS NOT NULL
  AND ISNULL(o.Enabled, 0) = 1
  AND ISNULL(o.IsStandardPackage, 0) = 0
`;

const fromClause = `
  FROM dbo.OfferDetails od
    INNER JOIN dbo.Offer o ON od.OfferID = o.ID
    INNER JOIN dbo.Customers c ON o.CustomerID = c.ID
    LEFT JOIN dbo.Brands b ON od.BrandID = b.ID
    LEFT JOIN dbo.OfferStatus os ON o.StatusID = os.ID
    LEFT JOIN dbo.SalesDivision sd ON sd.ID = o.SalesDivisionID
    LEFT JOIN dbo.Markets mkt ON mkt.ID = o.MarketID
    LEFT JOIN dbo.FWCs fwc ON fwc.ID = o.ERPFWCProjectID
`;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const brand    = searchParams.get('brand')    ?? '';
    const division = searchParams.get('division') ?? '';
    const market   = searchParams.get('market')   ?? '';
    const fwc      = searchParams.get('fwc')      ?? '';

    const pool = await getPool();

    const filterClauses: string[] = [baseFilter];
    if (brand)    filterClauses.push(`b.Name = @brand`);
    if (division) filterClauses.push(`sd.Name = @division`);
    if (market)   filterClauses.push(`mkt.Name = @market`);
    if (fwc)      filterClauses.push(`fwc.ShortName = @fwc`);
    const whereClause = `WHERE ${filterClauses.join(' AND ')}`;

    const dataReq = pool.request();
    if (brand)    dataReq.input('brand',    sql.NVarChar(500), brand);
    if (division) dataReq.input('division', sql.NVarChar(500), division);
    if (market)   dataReq.input('market',   sql.NVarChar(500), market);
    if (fwc)      dataReq.input('fwc',      sql.NVarChar(500), fwc);

    // Flat aggregated rows — the client pivots them with AG Grid. Grain includes
    // every dimension the user can drag into rows/columns in the pivot field panel;
    // measures are pre-summed at that grain and AG Grid re-aggregates as needed.
    const dataSql = `
      SELECT
        ISNULL(c.Name, '') AS CustomerName,
        ISNULL(o.Description, '') AS OfferDescription,
        CONVERT(varchar(10), o.OfferDate, 103) AS OfferDate,
        ISNULL(os.Name, '(No Status)') AS OfferStatus,
        ISNULL(b.Name, '') AS BrandName,
        ISNULL(sd.Name, '') AS SalesDivision,
        ISNULL(mkt.Name, '') AS SalesMarket,
        ISNULL(LTRIM(RTRIM(fwc.ShortName)), '') AS ERPFWCProjectShortName,
        SUM(ISNULL(od.Quantity, 0)) AS Qty,
        SUM(ISNULL(od.TotalPrice, 0)) AS TotalPrice,
        SUM(ISNULL(od.TotalNet, 0)) AS TotalNet,
        SUM(ISNULL(od.TotalCost, 0)) AS TotalCost,
        SUM(ISNULL(od.GrossProfit, 0)) AS GrossProfit
      ${fromClause}
      ${whereClause}
      GROUP BY
        c.Name,
        o.Description,
        CONVERT(varchar(10), o.OfferDate, 103),
        os.Name,
        b.Name,
        sd.Name,
        mkt.Name,
        fwc.ShortName
      ORDER BY
        c.Name,
        o.Description,
        MIN(o.OfferDate)
    `;

    const dataRes = await dataReq.query<Record<string, unknown>>(dataSql);
    const rows = (dataRes.recordset ?? []).map(r => ({ ...r }));

    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error('Failed to load offered-products summary', err);
    return NextResponse.json({ ok: false, error: 'Failed to load summary' }, { status: 500 });
  }
}
