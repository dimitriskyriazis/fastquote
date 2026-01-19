import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { resolveAuditUserId } from '../../../../../../lib/auditTrail';

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeStringValue = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
};

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  try {
    const { offerId: offerIdParam } = await params;
    const normalizedId = normalizeOfferId(
      typeof offerIdParam === 'string' ? decodeURIComponent(offerIdParam) : null,
    );
    if (!normalizedId) {
      return NextResponse.json(
        { ok: false, error: 'Missing or invalid offer id' },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const auditUserId = normalizeStringValue(resolveAuditUserId(_req)) ?? null;
    const request = pool.request();
    request.input('offerId', sql.Int, normalizedId);
    request.input('modifiedBy', sql.NVarChar(450), auditUserId);

    const result = await request.query<{ updated: number }>(`
      WITH OfferContext AS (
        SELECT
          o.ID AS OfferID,
          o.PricingPolicyID
        FROM dbo.Offer o
        WHERE o.ID = @offerId
      )
      UPDATE od
      SET
        [PriceListID] = price.PriceListID,
        [PriceListItemID] = price.PriceListItemID,
        [ListPrice] = price.ListPrice,
        [NetUnitPrice] = price.ListPrice,
        [TotalPrice] = CASE WHEN price.ListPrice IS NULL OR od.Quantity IS NULL THEN NULL ELSE price.ListPrice * od.Quantity END,
        [TotalNet] = CASE WHEN price.ListPrice IS NULL OR od.Quantity IS NULL THEN NULL ELSE price.ListPrice * od.Quantity END,
        [NetCost] = COALESCE(price.CostPrice, price.ListPrice),
        [TelmacoDiscount] = discounts.TelmacoDiscountPercentage,
        [CustomerDiscount] = discounts.CustomerDiscountPercentage,
        [Margin] = 0,
        [GrossProfit] = 0,
        [TotalCost] = CASE WHEN COALESCE(price.CostPrice, price.ListPrice) IS NULL OR od.Quantity IS NULL THEN NULL ELSE COALESCE(price.CostPrice, price.ListPrice) * od.Quantity END,
        [ModifiedOn] = SYSUTCDATETIME(),
        [ModifiedBy] = @modifiedBy
      FROM dbo.OfferDetails od
      INNER JOIN OfferContext oc ON od.OfferID = oc.OfferID
      OUTER APPLY (
        SELECT TOP (1)
          pli.PriceListID,
          pli.ID AS PriceListItemID,
          pli.ListPrice,
          pli.CostPrice
        FROM dbo.PriceListItems pli
        INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
        WHERE pli.ProductID = od.ProductID
          AND pl.Enabled = 1
        ORDER BY
          CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
          pl.ValidToDate DESC,
          pl.ValidFromDate DESC,
          pli.ID DESC
      ) price
      OUTER APPLY (
        SELECT TOP (1)
          ppr.TelmacoDiscountPercentage,
          ppr.CustomerDiscountPercentage
        FROM dbo.PricingPolicyRules ppr
        WHERE ppr.PricingPolicyID = oc.PricingPolicyID
          AND (ppr.BrandID = od.BrandID OR ppr.BrandID IS NULL)
        ORDER BY
          CASE WHEN ppr.BrandID = od.BrandID THEN 0 ELSE 1 END,
          ppr.ID DESC
      ) discounts
      WHERE od.ProductID IS NOT NULL;
      SELECT @@ROWCOUNT AS updated;
    `);

    const updated = Number(result.recordset?.[0]?.updated ?? 0);
    return NextResponse.json({ ok: true, updated });
  } catch (err) {
    console.error('Failed to update offer prices', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
