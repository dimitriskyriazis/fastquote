import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { resolveAuditUserId } from '../../../../../../lib/auditTrail';
import { requirePermission } from '../../../../../../lib/authz';

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
    const auth = await requirePermission(_req, "editOffers");
    if (!auth.ok) return auth.response;

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
      DECLARE @PricingPolicyID INT = (
        SELECT TOP (1) o.PricingPolicyID
        FROM dbo.Offer o
        WHERE o.ID = @offerId
      );
      IF @PricingPolicyID IS NULL
      BEGIN
        THROW 50000, 'Offer has no pricing policy.', 1;
      END;
      IF EXISTS (
        SELECT 1
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @offerId
          AND od.ProductID IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM dbo.PricingPolicyRules ppr
            WHERE ppr.PricingPolicyID = @PricingPolicyID
              AND (ppr.BrandID = od.BrandID OR ppr.BrandID IS NULL)
          )
      )
      BEGIN
        THROW 50000, 'Missing pricing policy rule for one or more brands in this offer. Please add a default (All brands) rule or brand-specific rules.', 1;
      END;
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
        [NetUnitPrice] = computed.ComputedNetUnitPrice,
        [TotalPrice] = CASE WHEN price.ListPrice IS NULL OR od.Quantity IS NULL THEN NULL ELSE price.ListPrice * od.Quantity END,
        [TotalNet] = CASE WHEN computed.ComputedNetUnitPrice IS NULL OR od.Quantity IS NULL THEN NULL ELSE computed.ComputedNetUnitPrice * od.Quantity END,
        [NetCostOtherCurrency] = price.CostPrice,
        [OtherCurrencyID] = price.OtherCurrencyID,
        [CurrencyCostModifier] = price.CurrencyCostModifier,
        [NetCost] = COALESCE(computed.ComputedNetCost, price.CostPrice * price.CurrencyCostModifier, price.ListPrice),
        [TelmacoDiscount] = CASE
          -- Case 2: If cost price exists, calculate Telmaco discount from cost price
          WHEN price.CostPrice IS NOT NULL AND price.ListPrice IS NOT NULL AND price.ListPrice <> 0
            THEN ROUND(
              (CAST(1 AS DECIMAL(18, 8))
                - (CAST(price.CostPrice * price.CurrencyCostModifier AS DECIMAL(18, 8))
                  / CAST(price.ListPrice AS DECIMAL(18, 8))
                )
              ) * 100,
              4
            )
          -- Case 1: If no cost price, use discount from pricing policy rule
          ELSE discounts.TelmacoDiscountPercentage
        END,
        [CustomerDiscount] = discounts.CustomerDiscountPercentage,
        [Margin] = CASE
          WHEN computed.ComputedNetUnitPrice IS NULL
            OR computed.ComputedNetUnitPrice = 0
            OR COALESCE(computed.ComputedNetCost, price.CostPrice * price.CurrencyCostModifier, price.ListPrice) IS NULL
            THEN NULL
          ELSE ROUND(
            (CAST(1 AS DECIMAL(18, 8))
              - (CAST(COALESCE(computed.ComputedNetCost, price.CostPrice * price.CurrencyCostModifier, price.ListPrice) AS DECIMAL(18, 8))
                / CAST(computed.ComputedNetUnitPrice AS DECIMAL(18, 8))
              )
            ) * 100,
            4
          )
        END,
        [GrossProfit] = CASE
          WHEN computed.ComputedNetUnitPrice IS NULL
            OR COALESCE(computed.ComputedNetCost, price.CostPrice * price.CurrencyCostModifier, price.ListPrice) IS NULL
            OR od.Quantity IS NULL
            THEN NULL
          ELSE ROUND(
            (computed.ComputedNetUnitPrice - COALESCE(computed.ComputedNetCost, price.CostPrice * price.CurrencyCostModifier, price.ListPrice))
            * od.Quantity,
            4
          )
        END,
        [TotalCost] = CASE
          WHEN COALESCE(computed.ComputedNetCost, price.CostPrice * price.CurrencyCostModifier, price.ListPrice) IS NULL
            OR od.Quantity IS NULL
            THEN NULL
          ELSE ROUND(
            COALESCE(computed.ComputedNetCost, price.CostPrice * price.CurrencyCostModifier, price.ListPrice) * od.Quantity,
            4
          )
        END,
        [ModifiedOn] = SYSUTCDATETIME(),
        [ModifiedBy] = @modifiedBy
      FROM dbo.OfferDetails od
      INNER JOIN OfferContext oc ON od.OfferID = oc.OfferID
      OUTER APPLY (
        SELECT TOP (1)
          pli.PriceListID,
          pli.ID AS PriceListItemID,
          pli.ListPrice,
          pli.CostPrice,
          COALESCE(pl.CostCurrencyID, pl.CurrencyId) AS OtherCurrencyID,
          COALESCE(pl.CurrencyCostModifier, 1) AS CurrencyCostModifier
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
        FROM (
          -- Priority 1: Use specific rule from PriceListPricingPolicy if PricingPolicyRuleID is set
          SELECT TOP (1)
            ppr.TelmacoDiscountPercentage,
            ppr.CustomerDiscountPercentage,
            1 AS Priority
          FROM dbo.PriceListPricingPolicy plpp
          INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyRuleID = ppr.ID
          WHERE plpp.PriceListID = price.PriceListID
            AND plpp.PricingPolicyID = oc.PricingPolicyID
            AND plpp.PricingPolicyRuleID IS NOT NULL
            AND (ppr.BrandID = od.BrandID OR ppr.BrandID IS NULL)
          ORDER BY
            CASE WHEN ppr.BrandID = od.BrandID THEN 0 ELSE 1 END,
            ppr.ID DESC
          
          UNION ALL
          
          -- Priority 2: Use rules from policy specified in PriceListPricingPolicy
          SELECT TOP (1)
            ppr.TelmacoDiscountPercentage,
            ppr.CustomerDiscountPercentage,
            2 AS Priority
          FROM dbo.PriceListPricingPolicy plpp
          INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyID = ppr.PricingPolicyID
          WHERE plpp.PriceListID = price.PriceListID
            AND plpp.PricingPolicyID = oc.PricingPolicyID
            AND plpp.PricingPolicyRuleID IS NULL
            AND (ppr.BrandID = od.BrandID OR ppr.BrandID IS NULL)
          ORDER BY
            CASE WHEN ppr.BrandID = od.BrandID THEN 0 ELSE 1 END,
            ppr.ID DESC
          
          UNION ALL
          
          -- Priority 3: Fall back to Offer's PricingPolicyID
          SELECT TOP (1)
            ppr.TelmacoDiscountPercentage,
            ppr.CustomerDiscountPercentage,
            3 AS Priority
          FROM dbo.PricingPolicyRules ppr
          WHERE ppr.PricingPolicyID = oc.PricingPolicyID
            AND (ppr.BrandID = od.BrandID OR ppr.BrandID IS NULL)
          ORDER BY
            CASE WHEN ppr.BrandID = od.BrandID THEN 0 ELSE 1 END,
            ppr.ID DESC
        ) ppr
        ORDER BY ppr.Priority
      ) discounts
      OUTER APPLY (
        SELECT
          CASE
            WHEN price.ListPrice IS NULL THEN NULL
            ELSE ROUND(
              price.ListPrice
              * (
                CAST(1 AS DECIMAL(18, 8))
                - (CAST(COALESCE(discounts.CustomerDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
              ),
              4
            )
          END AS ComputedNetUnitPrice,
          CASE
            -- Case 2: If cost price exists, use cost price (with currency modifier) as NetCost
            WHEN price.CostPrice IS NOT NULL THEN price.CostPrice * price.CurrencyCostModifier
            -- Case 1: If no cost price, calculate from Telmaco discount percentage
            WHEN price.ListPrice IS NULL THEN NULL
            ELSE ROUND(
              price.ListPrice
              * (
                CAST(1 AS DECIMAL(18, 8))
                - (CAST(COALESCE(discounts.TelmacoDiscountPercentage, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))
              ),
              4
            )
          END AS ComputedNetCost
      ) computed
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
