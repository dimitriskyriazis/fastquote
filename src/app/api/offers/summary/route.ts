import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/sql';
import sql from 'mssql';

// One flat row per LATEST-version offer (mirrors the offered-products summary grain, but at
// offer-header level instead of offer-line level). Feeds the Offers page "Pivot Mode" — AG Grid
// does all the aggregation client-side, so we deliberately do NOT aggregate here.
//
// We keep only the latest version of each version group (so summed TotalNet isn't double-counted
// across versions) and exclude standard packages / disabled offers, matching the default offers
// list view. Dates are emitted as dd/mm/yyyy strings so they group cleanly by day.
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const from     = searchParams.get('from')     ?? ''; // OfferDate >= from (yyyy-mm-dd)
    const to       = searchParams.get('to')       ?? ''; // OfferDate <= to   (yyyy-mm-dd)
    const division = searchParams.get('division') ?? '';
    const market   = searchParams.get('market')   ?? '';
    const status   = searchParams.get('status')   ?? ''; // OfferStatus.Name exact match
    // TelQuote-imported offers are excluded by default; telquote=1 includes them.
    const includeTelquote = searchParams.get('telquote') === '1';

    const pool = await getPool();
    const dataReq = pool.request();

    // Optional pre-filters (date range on OfferDate, sales division, market). Bound as params.
    // Dates bound as ISO strings; CONVERT(date, …) in SQL — 'yyyy-mm-dd' is locale-independent.
    const filterClauses: string[] = [];
    if (from)     { filterClauses.push('dbo.Offer.OfferDate >= CONVERT(date, @from)');                   dataReq.input('from',     sql.NVarChar(10),  from); }
    if (to)       { filterClauses.push('dbo.Offer.OfferDate < DATEADD(day, 1, CONVERT(date, @to))');      dataReq.input('to',       sql.NVarChar(10),  to); }
    if (division) { filterClauses.push('dbo.SalesDivision.Name = @division');                            dataReq.input('division', sql.NVarChar(500), division); }
    if (market)   { filterClauses.push('dbo.Markets.Name = @market');                                    dataReq.input('market',   sql.NVarChar(500), market); }
    if (status)   { filterClauses.push('dbo.OfferStatus.Name = @status');                                 dataReq.input('status',   sql.NVarChar(500), status); }
    if (!includeTelquote) { filterClauses.push('ISNULL(dbo.Offer.FromTelquote, 0) = 0'); }
    const extraWhere = filterClauses.length ? `\n        AND ${filterClauses.join('\n        AND ')}` : '';

    const dataSql = `
      WITH VersionTree AS (
        SELECT ID, ParentOfferID, ID AS RootOfferID
        FROM dbo.Offer
        WHERE ParentOfferID IS NULL
        UNION ALL
        SELECT o.ID, o.ParentOfferID, vt.RootOfferID
        FROM dbo.Offer o
        INNER JOIN VersionTree vt ON o.ParentOfferID = vt.ID
      )
      SELECT
        dbo.Offer.ID AS OfferID,
        dbo.Offer.OfferVersion AS OfferVersion,
        ISNULL(dbo.Customers.Name, '') AS CustomerName,
        ISNULL(offerCustomerGroup.Name, '') AS CustomerGroup,
        ISNULL(dbo.PricingPolicies.Name, '') AS PricingPolicyName,
        ISNULL(dbo.Markets.Name, '') AS SalesMarket,
        ISNULL(dbo.SalesDivision.Name, '') AS SalesDivision,
        ISNULL(sales.FullName, '') AS SalesPerson,
        ISNULL(created.FullName, '') AS SalesCreationPerson,
        ISNULL(dbo.OfferStatus.Name, '(No Status)') AS OfferStatus,
        ISNULL(dbo.Offer.ERPProjectCode, '') AS ERPProjectCode,
        ISNULL(LTRIM(RTRIM(fwc.ShortName)), '') AS ERPFWCProjectShortName,
        ISNULL(dbo.Offer.Title, '') AS Title,
        ISNULL(dbo.Offer.OfferContact, '') AS OfferContact,
        CASE WHEN ISNULL(dbo.Offer.FromTelquote, 0) = 1 THEN 'Yes' ELSE 'No' END AS FromTelquote,
        CONVERT(varchar(10), dbo.Offer.OfferDate, 103) AS OfferDate,
        CONVERT(varchar(10), dbo.Offer.CreatedOn, 103) AS CreatedOn,
        CONVERT(varchar(10),
          CASE
            WHEN allOfferDetailsStats.DetailsModifiedOn IS NULL THEN dbo.Offer.ModifiedOn
            WHEN dbo.Offer.ModifiedOn IS NULL THEN allOfferDetailsStats.DetailsModifiedOn
            WHEN allOfferDetailsStats.DetailsModifiedOn > dbo.Offer.ModifiedOn THEN allOfferDetailsStats.DetailsModifiedOn
            ELSE dbo.Offer.ModifiedOn
          END, 103) AS ModifiedOnAny,
        dbo.Offer.Probability AS Probability,
        offerTotals.TotalNet AS TotalNet,
        1 AS OfferCount
      FROM
        dbo.Offer
        LEFT JOIN VersionTree versionTree ON versionTree.ID = dbo.Offer.ID
        LEFT JOIN (
          SELECT vt.RootOfferID, MAX(o.OfferVersion) AS MaxOfferVersion
          FROM VersionTree vt
          INNER JOIN dbo.Offer o ON o.ID = vt.ID
          GROUP BY vt.RootOfferID
        ) AS versionStats ON versionStats.RootOfferID = versionTree.RootOfferID
        INNER JOIN dbo.Customers ON dbo.Offer.CustomerID = dbo.Customers.ID
        LEFT JOIN dbo.CustomerGroups AS offerCustomerGroup ON dbo.Customers.CustomerGroupID = offerCustomerGroup.ID
        INNER JOIN dbo.PricingPolicies ON dbo.Offer.PricingPolicyID = dbo.PricingPolicies.ID
        INNER JOIN dbo.Markets ON dbo.Offer.MarketID = dbo.Markets.ID
        INNER JOIN dbo.SalesDivision ON dbo.Offer.SalesDivisionID = dbo.SalesDivision.ID
        INNER JOIN dbo.AspNetUsers AS sales ON dbo.Offer.SalesPersonId = sales.Id
        LEFT JOIN dbo.AspNetUsers AS created ON dbo.Offer.CreatedBy = created.Id
        INNER JOIN dbo.OfferStatus ON dbo.Offer.StatusID = dbo.OfferStatus.ID
        LEFT JOIN dbo.FWCs AS fwc ON fwc.ID = dbo.Offer.ERPFWCProjectID
        OUTER APPLY (
          SELECT MAX(od.ModifiedOn) AS DetailsModifiedOn
          FROM dbo.OfferDetails od
          WHERE od.OfferID = dbo.Offer.ID
        ) AS allOfferDetailsStats
        OUTER APPLY (
          SELECT SUM(
            CASE
              WHEN (od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0
                THEN COALESCE(od.TotalNet, 0)
              ELSE 0
            END
          ) AS TotalNet
          FROM dbo.OfferDetails od
          WHERE od.OfferID = dbo.Offer.ID
        ) AS offerTotals
      WHERE ISNULL(dbo.Offer.IsStandardPackage, 0) = 0
        AND ISNULL(dbo.Offer.Enabled, 0) = 1
        AND dbo.Offer.OfferVersion = COALESCE(versionStats.MaxOfferVersion, dbo.Offer.OfferVersion)${extraWhere}
      ORDER BY dbo.Offer.ID DESC
    `;

    const dataRes = await dataReq.query<Record<string, unknown>>(dataSql);
    const rows = (dataRes.recordset ?? []).map(r => ({ ...r }));

    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error('Failed to load offers summary', err);
    return NextResponse.json({ ok: false, error: 'Failed to load summary' }, { status: 500 });
  }
}
