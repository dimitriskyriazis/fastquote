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
    LEFT JOIN dbo.CustomerGroups cg ON c.CustomerGroupID = cg.ID
    LEFT JOIN dbo.Brands b ON od.BrandID = b.ID
    LEFT JOIN dbo.OfferStatus os ON o.StatusID = os.ID
    LEFT JOIN dbo.Currencies oc ON od.OtherCurrencyID = oc.ID
    LEFT JOIN dbo.Products p ON od.ProductID = p.ID
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
    // TelQuote-imported offers are excluded by default; telquote=1 includes them.
    const includeTelquote = searchParams.get('telquote') === '1';

    const pool = await getPool();

    const filterClauses: string[] = [baseFilter];
    if (brand)    filterClauses.push(`b.Name = @brand`);
    if (division) filterClauses.push(`sd.Name = @division`);
    if (market)   filterClauses.push(`mkt.Name = @market`);
    if (fwc)      filterClauses.push(`fwc.ShortName = @fwc`);
    if (!includeTelquote) filterClauses.push(`ISNULL(o.FromTelquote, 0) = 0`);
    const whereClause = `WHERE ${filterClauses.join(' AND ')}`;

    const dataReq = pool.request();
    if (brand)    dataReq.input('brand',    sql.NVarChar(500), brand);
    if (division) dataReq.input('division', sql.NVarChar(500), division);
    if (market)   dataReq.input('market',   sql.NVarChar(500), market);
    if (fwc)      dataReq.input('fwc',      sql.NVarChar(500), fwc);

    // One row per offer line (mirrors the main /api/offered-products grain) so
    // every field on the main page is available in the pivot field panel. AG Grid
    // does all the aggregation client-side — per-line measures (unit prices,
    // margins, discounts) can't be pre-summed, so we deliberately do NOT aggregate
    // here. Dates are emitted as dd/mm/yyyy strings so they group cleanly by day.
    const dataSql = `
      SELECT
        od.OfferID AS OfferID,
        o.OfferVersion AS OfferVersion,
        ISNULL(c.Name, '') AS CustomerName,
        ISNULL(cg.Name, '') AS CustomerGroup,
        ISNULL(o.Description, '') AS OfferDescription,
        ISNULL(o.Title, '') AS OfferTitle,
        ISNULL(os.Name, '(No Status)') AS OfferStatus,
        CASE WHEN ISNULL(o.FromTelquote, 0) = 1 THEN 'Yes' ELSE 'No' END AS FromTelquote,
        CONVERT(varchar(10), o.OfferDate, 103) AS OfferDate,
        CONVERT(varchar(10), o.OfferDeadlineDate, 103) AS OfferDeadlineDate,
        ISNULL(sd.Name, '') AS SalesDivision,
        ISNULL(mkt.Name, '') AS SalesMarket,
        ISNULL(LTRIM(RTRIM(fwc.ShortName)), '') AS ERPFWCProjectShortName,
        ISNULL(o.ERPProjectCode, '') AS ERPProjectCode,
        ISNULL(b.Name, '') AS BrandName,
        ISNULL(od.PartNumber, '') AS PartNumber,
        ISNULL(od.ModelNumber, '') AS ModelNumber,
        ISNULL(od.ProductDescription, '') AS ProductDescription,
        ISNULL(p.Origin, '') AS Origin,
        ISNULL(od.Delivery, '') AS Delivery,
        ISNULL(oc.Name, '') AS OtherCurrencyName,
        od.Quantity AS Quantity,
        od.ListPrice AS ListPrice,
        od.CustomerDiscount AS CustomerDiscount,
        od.NetUnitPrice AS NetUnitPrice,
        od.TotalPrice AS TotalPrice,
        od.TotalNet AS TotalNet,
        od.TelmacoDiscount AS TelmacoDiscount,
        od.NetCostOtherCurrency AS NetCostOtherCurrency,
        od.CurrencyCostModifier AS CurrencyCostModifier,
        od.NetCost AS NetCost,
        od.TotalCost AS TotalCost,
        od.Margin AS Margin,
        od.GrossProfit AS GrossProfit,
        od.Warranty AS Warranty,
        od.TelmacoWarranty AS TelmacoWarranty,
        o.Probability AS Probability,
        CONVERT(varchar(10), od.CreatedOn, 103) AS CreatedOn,
        CONVERT(varchar(10), od.ModifiedOn, 103) AS ModifiedOn
      ${fromClause}
      ${whereClause}
      ORDER BY o.ID DESC, od.ID
    `;

    const dataRes = await dataReq.query<Record<string, unknown>>(dataSql);
    const rows = (dataRes.recordset ?? []).map(r => ({ ...r }));

    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error('Failed to load offered-products summary', err);
    return NextResponse.json({ ok: false, error: 'Failed to load summary' }, { status: 500 });
  }
}
