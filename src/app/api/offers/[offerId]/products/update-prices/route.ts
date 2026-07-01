import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import sql, { type ConnectionPool } from 'mssql';
import { getPool } from '../../../../../../lib/sql';
import { resolveAuditUserId } from '../../../../../../lib/auditTrail';
import { requirePermission } from '../../../../../../lib/authz';
import { fetchFarnellProduct, matchPriceTier, type FarnellProduct } from '../../../../../../lib/farnell';
import { realtimeEvents } from '../../../../../../lib/realtimeEvents';

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

const parseBrandList = (value: unknown): string[] => {
  if (typeof value !== 'string') return [];
  return Array.from(
    new Set(
      value
        .split('|~|')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
};

type FarnellOfferRow = {
  OfferDetailID: number;
  PartNumber: string | null;
  Quantity: number | null;
};

type FarnellUpdateResult = {
  updatedCount: number;
  updatedBrands: string[];
};

async function updateFarnellPrices(
  pool: ConnectionPool,
  offerId: number,
  auditUserId: string | null,
  selectedOfferDetailIds: number[],
): Promise<FarnellUpdateResult> {
  // Find all Farnell-brand offer detail rows
  const findRequest = pool.request();
  findRequest.input('offerId', sql.Int, offerId);
  const selectedFilter = selectedOfferDetailIds.length > 0
    ? ` AND od.ID IN (${selectedOfferDetailIds.map((_, idx) => `@selId${idx}`).join(', ')})`
    : '';
  selectedOfferDetailIds.forEach((id, idx) => {
    findRequest.input(`selId${idx}`, sql.Int, id);
  });

  const farnellRows = await findRequest.query<FarnellOfferRow>(`
    SELECT
      od.ID AS OfferDetailID,
      p.PartNumber,
      od.Quantity
    FROM dbo.OfferDetails od
    INNER JOIN dbo.Products p ON p.ID = od.ProductID
    INNER JOIN dbo.Brands b ON b.ID = od.BrandID
    WHERE od.OfferID = @offerId
      AND od.ProductID IS NOT NULL
      AND LTRIM(RTRIM(b.Name)) = 'Farnell'
      ${selectedFilter}
  `);

  const rows = farnellRows.recordset ?? [];
  if (rows.length === 0) return { updatedCount: 0, updatedBrands: [] };

  // Deduplicate Farnell API calls by part number.
  const farnellProductCache = new Map<string, FarnellProduct | null>();
  let updatedCount = 0;

  for (const row of rows) {
    if (!row.PartNumber) continue;
    const quantity = row.Quantity != null && Number.isFinite(row.Quantity) && row.Quantity > 0
      ? row.Quantity
      : 1;

    let farnellProduct: FarnellProduct | null;
    if (farnellProductCache.has(row.PartNumber)) {
      farnellProduct = farnellProductCache.get(row.PartNumber) ?? null;
    } else {
      farnellProduct = await fetchFarnellProduct(row.PartNumber, quantity);
      // PartNumber may be a manufacturer part number, not a Farnell order code.
      // The default 'id' search only matches order codes, so fall back to a
      // manufacturer-part-number search before giving up on this row.
      if (!farnellProduct) {
        farnellProduct = await fetchFarnellProduct(row.PartNumber, quantity, 'manuPartNum');
      }
      farnellProductCache.set(row.PartNumber, farnellProduct);
    }
    const listPrice = farnellProduct && farnellProduct.prices.length > 0
      ? matchPriceTier(farnellProduct.prices, quantity)
      : farnellProduct?.matchedPrice ?? null;
    if (listPrice == null) continue;

    // Update ListPrice and recalculate all derived fields using pricing policy discounts
    const updateRequest = pool.request();
    updateRequest.input('detailId', sql.Int, row.OfferDetailID);
    updateRequest.input('offerId', sql.Int, offerId);
    updateRequest.input('listPrice', sql.Decimal(18, 4), listPrice);
    updateRequest.input('modifiedBy', sql.NVarChar(450), auditUserId);

    await updateRequest.query(`
      DECLARE @PricingPolicyID INT = (
        SELECT TOP (1) o.PricingPolicyID
        FROM dbo.Offer o
        WHERE o.ID = @offerId
      );

      DECLARE @CustomerDiscount DECIMAL(18, 6) = 0;
      DECLARE @TelmacoDiscount DECIMAL(18, 6) = 0;
      DECLARE @TelmacoWarrantyYears INT = 1;
      DECLARE @CustomerWarrantyYears INT = 1;

      SELECT TOP (1)
        @CustomerDiscount = COALESCE(ppr.CustomerDiscountPercentage, 0),
        @TelmacoDiscount = COALESCE(ppr.TelmacoDiscountPercentage, 0),
        @TelmacoWarrantyYears = COALESCE(ppr.TelmacoWarrantyYears, 1),
        @CustomerWarrantyYears = COALESCE(ppr.CustomerWarrantyYears, 1)
      FROM (
        SELECT TOP (1)
          ppr.CustomerDiscountPercentage,
          ppr.TelmacoDiscountPercentage,
          ppr.TelmacoWarrantyYears,
          ppr.CustomerWarrantyYears,
          1 AS Priority
        FROM dbo.OfferDetails od_inner
        INNER JOIN dbo.PriceListPricingPolicy plpp ON plpp.PriceListID = od_inner.PriceListID
          AND plpp.PricingPolicyID = @PricingPolicyID
        INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyID = ppr.PricingPolicyID
        WHERE od_inner.ID = @detailId
          AND (ppr.BrandID = od_inner.BrandID OR ppr.BrandID IS NULL)
        ORDER BY
          CASE WHEN ppr.BrandID = od_inner.BrandID THEN 0 ELSE 1 END,
          ppr.ID DESC

        UNION ALL

        SELECT TOP (1)
          ppr.CustomerDiscountPercentage,
          ppr.TelmacoDiscountPercentage,
          ppr.TelmacoWarrantyYears,
          ppr.CustomerWarrantyYears,
          2 AS Priority
        FROM dbo.OfferDetails od_inner
        INNER JOIN dbo.PricingPolicyRules ppr ON ppr.PricingPolicyID = @PricingPolicyID
        WHERE od_inner.ID = @detailId
          AND (ppr.BrandID = od_inner.BrandID OR ppr.BrandID IS NULL)
        ORDER BY
          CASE WHEN ppr.BrandID = od_inner.BrandID THEN 0 ELSE 1 END,
          ppr.ID DESC
      ) ppr
      ORDER BY ppr.Priority;

      DECLARE @NetUnitPrice DECIMAL(18, 4) = ROUND(
        @listPrice * (CAST(1 AS DECIMAL(18, 8)) - (CAST(@CustomerDiscount AS DECIMAL(18, 8)) / 100)),
        4
      );
      DECLARE @NetCost DECIMAL(18, 4) = ROUND(
        @listPrice * (CAST(1 AS DECIMAL(18, 8)) - (CAST(@TelmacoDiscount AS DECIMAL(18, 8)) / 100)),
        4
      );

      UPDATE dbo.OfferDetails
      SET
        [ListPrice] = @listPrice,
        [CustomerDiscount] = @CustomerDiscount,
        [TelmacoDiscount] = @TelmacoDiscount,
        [TelmacoWarranty] = @TelmacoWarrantyYears,
        [Warranty] = @CustomerWarrantyYears,
        [NetUnitPrice] = @NetUnitPrice,
        [NetCost] = @NetCost,
        [TotalPrice] = CASE WHEN Quantity IS NULL THEN NULL ELSE ROUND(@listPrice * Quantity, 4) END,
        [TotalNet] = CASE WHEN Quantity IS NULL THEN NULL ELSE ROUND(@NetUnitPrice * Quantity, 4) END,
        [TotalCost] = CASE WHEN Quantity IS NULL THEN NULL ELSE ROUND(@NetCost * Quantity, 4) END,
        [GrossProfit] = CASE
          WHEN Quantity IS NULL THEN NULL
          ELSE ROUND((@NetUnitPrice - @NetCost) * Quantity, 4)
        END,
        [Margin] = CASE
          WHEN @NetUnitPrice = 0 THEN NULL
          ELSE ROUND((CAST(1 AS DECIMAL(18, 8)) - (CAST(@NetCost AS DECIMAL(18, 8)) / CAST(@NetUnitPrice AS DECIMAL(18, 8)))) * 100, 4)
        END,
        [ModifiedOn] = SYSUTCDATETIME(),
        [ModifiedBy] = @modifiedBy
      WHERE ID = @detailId
    `);
    updatedCount += 1;
  }

  return {
    updatedCount,
    updatedBrands: updatedCount > 0 ? ['Farnell'] : [],
  };
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products/update-prices');
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { offerDetailIds?: unknown; dryRun?: unknown } | null;
    const selectedOfferDetailIds = Array.isArray(body?.offerDetailIds)
      ? Array.from(
          new Set(
            body.offerDetailIds
              .map((value) => normalizeOfferId(value))
              .filter((id): id is number => id != null && id > 0),
          ),
        )
      : [];
    const dryRun = body?.dryRun === true;

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
    const auditUserId = normalizeStringValue(resolveAuditUserId(req)) ?? null;

    if (dryRun) {
      const countRequest = pool.request();
      countRequest.input('offerId', sql.Int, normalizedId);
      const dryFilterSql = selectedOfferDetailIds.length > 0
        ? ` AND od.ID IN (${selectedOfferDetailIds.map((_, idx) => `@dryId${idx}`).join(', ')})`
        : '';
      selectedOfferDetailIds.forEach((id, idx) => {
        countRequest.input(`dryId${idx}`, sql.Int, id);
      });
      const countResult = await countRequest.query<{ willUpdate: number }>(`
        SELECT COUNT(*) AS willUpdate
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @offerId
          AND od.ProductID IS NOT NULL
          ${dryFilterSql}
          AND (
            EXISTS (
              SELECT 1 FROM dbo.Brands fb
              WHERE fb.ID = od.BrandID
                AND LTRIM(RTRIM(fb.Name)) = 'Farnell'
            )
            OR EXISTS (
              SELECT 1 FROM dbo.PriceListItems pli
              INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID AND pl.Enabled = 1
              WHERE pli.ProductID = od.ProductID
            )
          );
      `);
      const willUpdate = Number(countResult.recordset?.[0]?.willUpdate ?? 0);
      return NextResponse.json({ ok: true, dryRun: true, willUpdate });
    }

    // Step 1: Update Farnell-brand rows via live API
    const farnellUpdated = await updateFarnellPrices(
      pool,
      normalizedId,
      auditUserId,
      selectedOfferDetailIds,
    );

    // Step 2: Update non-Farnell rows via standard price list logic
    const request = pool.request();
    request.input('offerId', sql.Int, normalizedId);
    request.input('modifiedBy', sql.NVarChar(450), auditUserId);
    const selectedDetailsFilterSql = selectedOfferDetailIds.length > 0
      ? ` AND od.ID IN (${selectedOfferDetailIds.map((_, idx) => `@selectedOfferDetailId${idx}`).join(', ')})`
      : '';
    selectedOfferDetailIds.forEach((id, idx) => {
      request.input(`selectedOfferDetailId${idx}`, sql.Int, id);
    });

    // Exclude Farnell brand from pricing policy checks and standard update
    const excludeFarnellSql = `
      AND NOT EXISTS (
        SELECT 1
        FROM dbo.Products pfb
        INNER JOIN dbo.Brands fb ON fb.ID = COALESCE(od.BrandID, pfb.BrandID)
        WHERE pfb.ID = od.ProductID
          AND LTRIM(RTRIM(fb.Name)) = 'Farnell'
      )`;

    const result = await request.query<{
      updated: number;
      updatedBrandsCsv: string | null;
      failedBrandsCsv: string | null;
    }>(`
      -- Resolve legacy products: if a product has no enabled pricelist items
      -- but another product's legacy part number matches, migrate to that product
      UPDATE od
      SET
        od.ProductID = p_new.ID,
        od.PartNumber = p_new.PartNumber,
        od.ModelNumber = p_new.ModelNumber,
        od.BrandID = p_new.BrandID,
        od.ProductDescription = COALESCE(NULLIF(p_new.Description, ''), od.ProductDescription)
      FROM dbo.OfferDetails od
      INNER JOIN dbo.Products pr ON pr.ID = od.ProductID
      CROSS APPLY (
        SELECT TOP (1) p_new.ID, p_new.PartNumber, p_new.ModelNumber, p_new.BrandID, p_new.Description
        FROM dbo.Products p_new
        WHERE p_new.LegacyPartNoCleaned = pr.PartNumberCleared
          AND p_new.LegacyPartNoCleaned IS NOT NULL
          AND p_new.LegacyPartNoCleaned <> ''
          AND p_new.ID <> pr.ID
          AND EXISTS (
            SELECT 1 FROM dbo.PriceListItems pli_chk
            INNER JOIN dbo.PriceLists pl_chk ON pli_chk.PriceListID = pl_chk.ID AND pl_chk.Enabled = 1
            WHERE pli_chk.ProductID = p_new.ID
          )
        ORDER BY p_new.ID DESC
      ) p_new
      WHERE od.OfferID = @offerId
        AND od.ProductID IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM dbo.PriceListItems pli_chk
          INNER JOIN dbo.PriceLists pl_chk ON pli_chk.PriceListID = pl_chk.ID AND pl_chk.Enabled = 1
          WHERE pli_chk.ProductID = pr.ID
        )${selectedDetailsFilterSql}${excludeFarnellSql};

      DECLARE @PricingPolicyID INT = (
        SELECT TOP (1) o.PricingPolicyID
        FROM dbo.Offer o
        WHERE o.ID = @offerId
      );
      IF @PricingPolicyID IS NULL
      BEGIN
        THROW 50000, 'Offer has no pricing policy.', 1;
      END;
      DECLARE @MissingBrandLabels TABLE (BrandLabel NVARCHAR(300) PRIMARY KEY);
      DECLARE @UpdatedBrandLabels TABLE (BrandLabel NVARCHAR(300));

      INSERT INTO @MissingBrandLabels (BrandLabel)
      SELECT DISTINCT
        COALESCE(
          NULLIF(LTRIM(RTRIM(b.Name)), ''),
          CASE
            WHEN COALESCE(od.BrandID, p.BrandID) IS NULL THEN CONCAT('No brand selected (Offer detail ', CAST(od.ID AS NVARCHAR(20)), ')')
            ELSE CONCAT('Brand ID ', CAST(COALESCE(od.BrandID, p.BrandID) AS NVARCHAR(20)))
          END
        ) AS BrandLabel
      FROM dbo.OfferDetails od
      LEFT JOIN dbo.Products p ON p.ID = od.ProductID
      LEFT JOIN dbo.Brands b ON b.ID = COALESCE(od.BrandID, p.BrandID)
      WHERE od.OfferID = @offerId
        AND od.ProductID IS NOT NULL
        ${selectedDetailsFilterSql}
        ${excludeFarnellSql}
        AND NOT EXISTS (
          SELECT 1
          FROM dbo.PricingPolicyRules ppr
          WHERE ppr.PricingPolicyID = @PricingPolicyID
            AND (ppr.BrandID = COALESCE(od.BrandID, p.BrandID) OR ppr.BrandID IS NULL)
        );

      DECLARE @euroCurrencyId INT;
      SELECT TOP 1 @euroCurrencyId = ID
      FROM dbo.Currencies
      WHERE Name = N'€' OR LOWER(Name) LIKE '%eur%'
      ORDER BY
        CASE WHEN Name = N'€' THEN 0
             WHEN LOWER(Name) LIKE '%eur%' THEN 1
             WHEN LOWER(Name) LIKE '%euro%' THEN 2
             ELSE 3
        END;

      DECLARE @offerCurrencyId INT;
      DECLARE @offerCurrencyModifier DECIMAL(18, 8);
      SELECT
        @offerCurrencyId = o.CurrencyID,
        @offerCurrencyModifier = o.CurrencyModifier
      FROM dbo.Offer o
      WHERE o.ID = @offerId;
      IF @offerCurrencyId IS NULL SET @offerCurrencyId = @euroCurrencyId;

      WITH OfferContext AS (
        SELECT
          o.ID AS OfferID,
          o.PricingPolicyID
        FROM dbo.Offer o
        WHERE o.ID = @offerId
      ),
      EligibleDetails AS (
        SELECT
          od.ID AS OfferDetailID,
          COALESCE(od.BrandID, p.BrandID) AS EffectiveBrandID,
          COALESCE(
            NULLIF(LTRIM(RTRIM(b.Name)), ''),
            CASE
              WHEN COALESCE(od.BrandID, p.BrandID) IS NULL THEN CONCAT('No brand selected (Offer detail ', CAST(od.ID AS NVARCHAR(20)), ')')
              ELSE CONCAT('Brand ID ', CAST(COALESCE(od.BrandID, p.BrandID) AS NVARCHAR(20)))
            END
          ) AS BrandLabel
        FROM dbo.OfferDetails od
        INNER JOIN OfferContext oc ON od.OfferID = oc.OfferID
        LEFT JOIN dbo.Products p ON p.ID = od.ProductID
        LEFT JOIN dbo.Brands b ON b.ID = COALESCE(od.BrandID, p.BrandID)
        WHERE od.ProductID IS NOT NULL
          ${selectedDetailsFilterSql}
          ${excludeFarnellSql}
          AND EXISTS (
            SELECT 1
            FROM dbo.PricingPolicyRules ppr
            WHERE ppr.PricingPolicyID = oc.PricingPolicyID
              AND (ppr.BrandID = COALESCE(od.BrandID, p.BrandID) OR ppr.BrandID IS NULL)
          )
      )
      UPDATE od
      SET
        [PriceListID] = price.PriceListID,
        [PriceListItemID] = price.PriceListItemID,
        [ListPrice] = price.ListPrice,
        [NetUnitPrice] = computed.ComputedNetUnitPrice,
        [TotalPrice] = CASE WHEN price.ListPrice IS NULL OR od.Quantity IS NULL THEN NULL ELSE price.ListPrice * od.Quantity END,
        [TotalNet] = CASE WHEN computed.ComputedNetUnitPrice IS NULL OR od.Quantity IS NULL THEN NULL ELSE computed.ComputedNetUnitPrice * od.Quantity END,
        [NetCostOtherCurrency] = CASE WHEN price.OtherCurrencyID IS NULL THEN NULL ELSE price.CostPrice END,
        [OtherCurrencyID] = price.OtherCurrencyID,
        [CurrencyCostModifier] = price.CurrencyCostModifier,
        [NetCost] = COALESCE(computed.ComputedNetCost, price.CostPrice * COALESCE(price.CurrencyCostModifier, 1), price.ListPrice),
        [TelmacoDiscount] = CASE
          -- Case 2: If cost price exists, calculate Telmaco discount from cost price
          WHEN price.CostPrice IS NOT NULL AND price.ListPrice IS NOT NULL AND price.ListPrice <> 0
            THEN ROUND(
              (CAST(1 AS DECIMAL(18, 8))
                - (CAST(price.CostPrice * COALESCE(price.CurrencyCostModifier, 1) AS DECIMAL(18, 8))
                  / CAST(price.ListPrice AS DECIMAL(18, 8))
                )
              ) * 100,
              4
            )
          -- Case 1: If no cost price, use discount from pricing policy rule
          ELSE discounts.TelmacoDiscountPercentage
        END,
        [CustomerDiscount] = discounts.CustomerDiscountPercentage,
        [TelmacoWarranty] = COALESCE(discounts.TelmacoWarrantyYears, 1),
        [Warranty] = COALESCE(discounts.CustomerWarrantyYears, 1),
        [Margin] = CASE
          WHEN computed.ComputedNetUnitPrice IS NULL
            OR computed.ComputedNetUnitPrice = 0
            OR COALESCE(computed.ComputedNetCost, price.CostPrice * COALESCE(price.CurrencyCostModifier, 1), price.ListPrice) IS NULL
            THEN NULL
          ELSE ROUND(
            (CAST(1 AS DECIMAL(18, 8))
              - (CAST(COALESCE(computed.ComputedNetCost, price.CostPrice * COALESCE(price.CurrencyCostModifier, 1), price.ListPrice) AS DECIMAL(18, 8))
                / CAST(computed.ComputedNetUnitPrice AS DECIMAL(18, 8))
              )
            ) * 100,
            4
          )
        END,
        [GrossProfit] = CASE
          WHEN computed.ComputedNetUnitPrice IS NULL
            OR COALESCE(computed.ComputedNetCost, price.CostPrice * COALESCE(price.CurrencyCostModifier, 1), price.ListPrice) IS NULL
            OR od.Quantity IS NULL
            THEN NULL
          ELSE ROUND(
            (computed.ComputedNetUnitPrice - COALESCE(computed.ComputedNetCost, price.CostPrice * COALESCE(price.CurrencyCostModifier, 1), price.ListPrice))
            * od.Quantity,
            4
          )
        END,
        [TotalCost] = CASE
          WHEN COALESCE(computed.ComputedNetCost, price.CostPrice * COALESCE(price.CurrencyCostModifier, 1), price.ListPrice) IS NULL
            OR od.Quantity IS NULL
            THEN NULL
          ELSE ROUND(
            COALESCE(computed.ComputedNetCost, price.CostPrice * COALESCE(price.CurrencyCostModifier, 1), price.ListPrice) * od.Quantity,
            4
          )
        END,
        [ModifiedOn] = SYSUTCDATETIME(),
        [ModifiedBy] = @modifiedBy
      OUTPUT eligible.BrandLabel INTO @UpdatedBrandLabels (BrandLabel)
      FROM dbo.OfferDetails od
      INNER JOIN EligibleDetails eligible ON eligible.OfferDetailID = od.ID
      INNER JOIN OfferContext oc ON od.OfferID = oc.OfferID
      OUTER APPLY (
        SELECT TOP (1)
          pli.PriceListID,
          pli.ID AS PriceListItemID,
          CASE WHEN pl.CurrencyId = @offerCurrencyId THEN pli.ListPrice
               ELSE pli.ListPrice * COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1)
          END AS ListPrice,
          pli.CostPrice,
          CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
               ELSE COALESCE(pl.CostCurrencyID, pl.CurrencyId) END AS OtherCurrencyID,
          CASE WHEN COALESCE(pl.CostCurrencyID, pl.CurrencyId) = @offerCurrencyId THEN NULL
               ELSE COALESCE(@offerCurrencyModifier, pl.CurrencyCostModifier, 1) END AS CurrencyCostModifier
        FROM dbo.PriceListItems pli
        INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
        LEFT JOIN dbo.PriceListPricingPolicy plpp ON plpp.PriceListID = pl.ID AND plpp.PricingPolicyID = oc.PricingPolicyID
        WHERE pli.ProductID = od.ProductID
          AND pl.Enabled = 1
        ORDER BY
          CASE WHEN plpp.ID IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN pli.CostPrice IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
          pl.ValidToDate DESC,
          pl.ValidFromDate DESC,
          pli.ID DESC
      ) price
      OUTER APPLY (
        SELECT TOP (1)
          ppr.TelmacoDiscountPercentage,
          ppr.CustomerDiscountPercentage,
          ppr.TelmacoWarrantyYears,
          ppr.CustomerWarrantyYears
        FROM (
          -- Priority 1: Use rules from policy specified in PriceListPricingPolicy
          SELECT TOP (1)
            ppr.TelmacoDiscountPercentage,
            ppr.CustomerDiscountPercentage,
            ppr.TelmacoWarrantyYears,
            ppr.CustomerWarrantyYears,
            1 AS Priority
          FROM dbo.PriceListPricingPolicy plpp
          INNER JOIN dbo.PricingPolicyRules ppr ON plpp.PricingPolicyID = ppr.PricingPolicyID
          WHERE plpp.PriceListID = price.PriceListID
            AND plpp.PricingPolicyID = oc.PricingPolicyID
            AND (ppr.BrandID = eligible.EffectiveBrandID OR ppr.BrandID IS NULL)
          ORDER BY
            CASE WHEN ppr.BrandID = eligible.EffectiveBrandID THEN 0 ELSE 1 END,
            ppr.ID DESC

          UNION ALL

          -- Priority 2: Fall back to Offer's PricingPolicyID
          SELECT TOP (1)
            ppr.TelmacoDiscountPercentage,
            ppr.CustomerDiscountPercentage,
            ppr.TelmacoWarrantyYears,
            ppr.CustomerWarrantyYears,
            2 AS Priority
          FROM dbo.PricingPolicyRules ppr
          WHERE ppr.PricingPolicyID = oc.PricingPolicyID
            AND (ppr.BrandID = eligible.EffectiveBrandID OR ppr.BrandID IS NULL)
          ORDER BY
            CASE WHEN ppr.BrandID = eligible.EffectiveBrandID THEN 0 ELSE 1 END,
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
      WHERE od.ProductID IS NOT NULL
        AND price.ListPrice IS NOT NULL${selectedDetailsFilterSql}${excludeFarnellSql};
      SELECT
        @@ROWCOUNT AS updated,
        (
          SELECT STRING_AGG(updatedBrands.BrandLabel, '|~|')
          FROM (
            SELECT DISTINCT BrandLabel
            FROM @UpdatedBrandLabels
          ) updatedBrands
        ) AS updatedBrandsCsv,
        (
          SELECT STRING_AGG(missingBrands.BrandLabel, '|~|')
          FROM @MissingBrandLabels missingBrands
        ) AS failedBrandsCsv;
    `);

    const standardUpdated = Number(result.recordset?.[0]?.updated ?? 0);
    const standardUpdatedBrands = parseBrandList(result.recordset?.[0]?.updatedBrandsCsv);
    const failedBrands = parseBrandList(result.recordset?.[0]?.failedBrandsCsv);

    // Step 3: Update service product rows using ServicesLocation-aware pricing
    const locationLookup = pool.request();
    locationLookup.input('offerId', sql.Int, normalizedId);
    const locationResult = await locationLookup.query<{ ServicesLocation: string | null }>(`
      SELECT TOP (1) ServicesLocation FROM dbo.Offer WHERE ID = @offerId
    `);
    const servicesLocation = locationResult.recordset?.[0]?.ServicesLocation ?? null;

    const serviceRequest = pool.request();
    serviceRequest.input('offerId', sql.Int, normalizedId);
    serviceRequest.input('modifiedBy', sql.NVarChar(450), auditUserId);
    serviceRequest.input('svcLocation', sql.NVarChar(10), servicesLocation);
    const serviceSelectedFilterSql = selectedOfferDetailIds.length > 0
      ? ` AND od.ID IN (${selectedOfferDetailIds.map((_, idx) => `@svcSelId${idx}`).join(', ')})`
      : '';
    selectedOfferDetailIds.forEach((id, idx) => {
      serviceRequest.input(`svcSelId${idx}`, sql.Int, id);
    });

    const serviceResult = await serviceRequest.query(`
      UPDATE od
      SET
        od.ListPrice    = src.NewPrice,
        od.TotalPrice   = CASE WHEN src.NewPrice IS NULL THEN NULL
                               ELSE ROUND(src.NewPrice * ISNULL(od.Quantity, 1), 4) END,
        od.NetUnitPrice = CASE WHEN src.NewPrice IS NULL THEN NULL
                               ELSE ROUND(src.NewPrice * (1.0 - ISNULL(od.CustomerDiscount, 0) / 100.0), 4) END,
        od.TotalNet     = CASE WHEN src.NewPrice IS NULL THEN NULL
                               ELSE ROUND(src.NewPrice * (1.0 - ISNULL(od.CustomerDiscount, 0) / 100.0) * ISNULL(od.Quantity, 1), 4) END,
        od.NetCost      = CASE WHEN src.NewPrice IS NULL THEN NULL
                               ELSE ROUND(src.NewPrice * (1.0 - ISNULL(od.TelmacoDiscount, 0) / 100.0), 4) END,
        od.TotalCost    = CASE WHEN src.NewPrice IS NULL THEN NULL
                               ELSE ROUND(src.NewPrice * (1.0 - ISNULL(od.TelmacoDiscount, 0) / 100.0) * ISNULL(od.Quantity, 1), 4) END,
        od.GrossProfit  = CASE WHEN src.NewPrice IS NULL OR ISNULL(od.Quantity, 1) = 0 THEN NULL
                               ELSE ROUND((src.NewPrice * (1.0 - ISNULL(od.CustomerDiscount, 0) / 100.0)
                                          - src.NewPrice * (1.0 - ISNULL(od.TelmacoDiscount, 0) / 100.0))
                                         * ISNULL(od.Quantity, 1), 4) END,
        od.Margin       = CASE WHEN src.NewPrice IS NULL OR src.NewPrice * (1.0 - ISNULL(od.CustomerDiscount, 0) / 100.0) = 0 THEN NULL
                               ELSE ROUND((1.0 - (src.NewPrice * (1.0 - ISNULL(od.TelmacoDiscount, 0) / 100.0))
                                               / (src.NewPrice * (1.0 - ISNULL(od.CustomerDiscount, 0) / 100.0))) * 100, 4) END,
        od.ModifiedOn   = SYSUTCDATETIME(),
        od.ModifiedBy   = @modifiedBy
      FROM dbo.OfferDetails od
      CROSS APPLY (
        SELECT TOP (1)
          CASE
            WHEN @svcLocation = 'GR'    THEN COALESCE(pli.ServicePriceGR,    pli.ListPrice)
            WHEN @svcLocation = 'outGR' THEN COALESCE(pli.ServicePriceOutGR, pli.ListPrice)
            ELSE pli.ListPrice
          END AS NewPrice
        FROM dbo.PriceListItems pli
        INNER JOIN dbo.PriceLists pl ON pli.PriceListID = pl.ID
        WHERE pli.ProductID = od.ProductID
          AND ISNULL(pl.IsService, 0) = 1
          AND pl.Enabled = 1
        ORDER BY pli.ID DESC
      ) src
      WHERE od.OfferID = @offerId
        AND od.ProductID IS NOT NULL
        ${serviceSelectedFilterSql};
    `);
    const serviceUpdated = serviceResult.rowsAffected?.[0] ?? 0;

    const updatedBrands = Array.from(new Set([...farnellUpdated.updatedBrands, ...standardUpdatedBrands]));
    const totalUpdated = standardUpdated + farnellUpdated.updatedCount + serviceUpdated;
    if (totalUpdated > 0) {
      realtimeEvents.emit(
        `offer:${normalizedId}:products`,
        'rows-refresh',
        { reason: 'update-prices', updated: totalUpdated, updatedBy: auditUserId },
      );
    }
    return NextResponse.json({
      ok: true,
      updated: totalUpdated,
      updatedBrands,
      failedBrands,
      serviceUpdated,
    });
  } catch (err) {
    console.error('Failed to update offer prices', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
