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

    // 1. Fetch distinct statuses present in the (filtered) data
    const filterClauses: string[] = [baseFilter];
    if (brand)    filterClauses.push(`b.Name = @brand`);
    if (division) filterClauses.push(`sd.Name = @division`);
    if (market)   filterClauses.push(`mkt.Name = @market`);
    if (fwc)      filterClauses.push(`fwc.ShortName = @fwc`);
    const whereClause = `WHERE ${filterClauses.join(' AND ')}`;

    const statusReq = pool.request();
    if (brand)    statusReq.input('brand',    sql.NVarChar(500), brand);
    if (division) statusReq.input('division', sql.NVarChar(500), division);
    if (market)   statusReq.input('market',   sql.NVarChar(500), market);
    if (fwc)      statusReq.input('fwc',      sql.NVarChar(500), fwc);

    const statusSql = `
      SELECT DISTINCT os.Name AS StatusName
      ${fromClause}
      ${whereClause}
        AND os.Name IS NOT NULL
      ORDER BY os.Name
    `;
    const statusRes = await statusReq.query<{ StatusName: string }>(statusSql);
    const statuses = (statusRes.recordset ?? []).map(r => r.StatusName);

    if (statuses.length === 0) {
      return NextResponse.json({ ok: true, statuses: [], rows: [] });
    }

    // 2. Build conditional aggregation — one CASE WHEN per status
    const caseLines = statuses.map((s, i) =>
      `SUM(CASE WHEN os.Name = @status_${i} THEN ISNULL(od.Quantity, 0) ELSE 0 END) AS [${s.replace(/]/g, ']]')}]`
    ).join(',\n      ');

    const dataReq = pool.request();
    if (brand)    dataReq.input('brand',    sql.NVarChar(500), brand);
    if (division) dataReq.input('division', sql.NVarChar(500), division);
    if (market)   dataReq.input('market',   sql.NVarChar(500), market);
    if (fwc)      dataReq.input('fwc',      sql.NVarChar(500), fwc);
    statuses.forEach((s, i) => dataReq.input(`status_${i}`, sql.NVarChar(500), s));

    const dataSql = `
      SELECT
        ISNULL(od.PartNumber, '') AS PartNumber,
        ISNULL(od.ProductDescription, '') AS ProductDescription,
        ISNULL(c.Name, '') AS CustomerName,
        ${caseLines},
        SUM(ISNULL(od.Quantity, 0)) AS GrandTotal
      ${fromClause}
      ${whereClause}
      GROUP BY
        od.PartNumber,
        od.ProductDescription,
        c.Name
      ORDER BY
        od.PartNumber,
        od.ProductDescription,
        c.Name
    `;

    const dataRes = await dataReq.query<Record<string, unknown>>(dataSql);
    const rows = (dataRes.recordset ?? []).map(r => ({ ...r }));

    return NextResponse.json({ ok: true, statuses, rows });
  } catch (err) {
    console.error('Failed to load offered-products summary', err);
    return NextResponse.json({ ok: false, error: 'Failed to load summary' }, { status: 500 });
  }
}
