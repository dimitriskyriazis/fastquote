/**
 * EP LINC method re-pricing — the single SQL enforcement of the pricing rules
 * documented in src/lib/epLincPricing.ts. For every ASSIGNED product line of
 * an EP LINC offer (ProductID set; categories/comments/services excluded) the
 * target net unit price is:
 *
 *   CustomerDiscount null/0                → UPLIFT  = NetCost × 1.15
 *   CD > 0, brand RRP total > €25.000      → cheaper of RRP net and UPLIFT net
 *   CD > 0 otherwise                       → RRP     = ListPrice × (1 − CD%)
 *
 * Only rows whose stored NetUnitPrice differs from the target are rewritten
 * (TotalNet / Margin / GrossProfit follow), so repeated runs are no-ops.
 * Lines missing the needed inputs (no cost for UPLIFT, no list price for RRP)
 * are left untouched. The brand threshold is evaluated on the RRP basis over
 * the WHOLE offer (options excluded) — see epLincPricing.ts for why.
 *
 * Runs after every mutation that can move prices or brand totals: the
 * products PATCH (cell edits), add / assign (populate), paste, and Update
 * Prices — so stored nets always match the grid's Price Method column.
 * No-op for offers whose pricing policy is not EP LINC (guarded in SQL).
 */

import sql, { type Request } from 'mssql';

export const EP_LINC_METHOD_REPRICE_SQL = `
  DECLARE @__epLincPolicyId INT = (
    SELECT TOP (1) o.PricingPolicyID FROM dbo.Offer o WHERE o.ID = @__epOfferId
  );
  DECLARE @__epLincIds TABLE (ID INT PRIMARY KEY);

  IF EXISTS (
    SELECT 1 FROM dbo.PricingPolicies pp
    WHERE pp.ID = @__epLincPolicyId AND UPPER(pp.Name) LIKE '%LINC%'
  )
  BEGIN
    WITH EpLincLines AS (
      SELECT
        od.ID,
        COALESCE(od.BrandID, p.BrandID) AS EffectiveBrandID,
        od.CustomerDiscount,
        od.Quantity,
        ISNULL(od.IsOption, 0) AS IsOptionFlag,
        CASE
          WHEN od.ListPrice IS NULL THEN NULL
          ELSE ROUND(
            od.ListPrice
            * (CAST(1 AS DECIMAL(18, 8)) - (CAST(COALESCE(od.CustomerDiscount, 0) AS DECIMAL(18, 8)) / CAST(100 AS DECIMAL(18, 8)))),
            4
          )
        END AS RrpNet,
        CASE
          WHEN od.NetCost IS NULL THEN NULL
          ELSE ROUND(CAST(od.NetCost AS DECIMAL(18, 8)) * CAST(1.15 AS DECIMAL(18, 8)), 4)
        END AS UpliftNet
      FROM dbo.OfferDetails od
      LEFT JOIN dbo.Products p ON od.ProductID = p.ID
      WHERE od.OfferID = @__epOfferId
        AND od.ProductID IS NOT NULL
        AND ISNULL(od.IsCategory, 0) = 0
        AND ISNULL(od.IsComment, 0) = 0
        AND ISNULL(od.IsService, 0) = 0
    ),
    BrandTotals AS (
      SELECT
        EffectiveBrandID,
        SUM(COALESCE(RrpNet, 0) * COALESCE(Quantity, 0)) AS BrandRrpNetTotal
      FROM EpLincLines
      WHERE IsOptionFlag = 0
      GROUP BY EffectiveBrandID
    ),
    Targets AS (
      SELECT
        l.ID,
        CASE
          WHEN COALESCE(l.CustomerDiscount, 0) = 0 THEN l.UpliftNet
          WHEN COALESCE(bt.BrandRrpNetTotal, 0) > 25000 THEN
            CASE
              WHEN l.UpliftNet IS NOT NULL AND l.RrpNet IS NOT NULL AND l.UpliftNet < l.RrpNet THEN l.UpliftNet
              ELSE l.RrpNet
            END
          ELSE l.RrpNet
        END AS TargetNet
      FROM EpLincLines l
      LEFT JOIN BrandTotals bt ON bt.EffectiveBrandID = l.EffectiveBrandID
    )
    UPDATE od
    SET
      [NetUnitPrice] = t.TargetNet,
      [TotalNet] = CASE WHEN od.Quantity IS NULL THEN NULL ELSE ROUND(t.TargetNet * od.Quantity, 4) END,
      [GrossProfit] = CASE
        WHEN od.Quantity IS NULL OR od.NetCost IS NULL THEN NULL
        ELSE ROUND((t.TargetNet - od.NetCost) * od.Quantity, 4)
      END,
      [Margin] = CASE
        WHEN t.TargetNet = 0 OR od.NetCost IS NULL THEN NULL
        ELSE ROUND(
          (CAST(1 AS DECIMAL(18, 8)) - (CAST(od.NetCost AS DECIMAL(18, 8)) / CAST(t.TargetNet AS DECIMAL(18, 8)))) * 100,
          4
        )
      END,
      [ModifiedOn] = SYSUTCDATETIME(),
      [ModifiedBy] = @__epModifiedBy
    OUTPUT inserted.ID INTO @__epLincIds (ID)
    FROM dbo.OfferDetails od
    INNER JOIN Targets t ON t.ID = od.ID
    WHERE t.TargetNet IS NOT NULL
      AND (od.NetUnitPrice IS NULL OR od.NetUnitPrice <> t.TargetNet);
  END;

  SELECT ID FROM @__epLincIds;
`;

/**
 * Runs the EP LINC method re-pricing for an offer. Returns the IDs of the
 * OfferDetails rows whose net changed (empty when the offer's policy is not
 * EP LINC or everything already matched). `makeRequest` supplies a fresh
 * mssql Request (pool.request(), or a transaction-bound request).
 */
export async function applyEpLincMethodRepricing(
  makeRequest: () => Request,
  offerId: number,
  modifiedBy: string | number | null | undefined,
): Promise<number[]> {
  const request = makeRequest();
  request.input('__epOfferId', sql.Int, offerId);
  request.input('__epModifiedBy', sql.NVarChar(450), modifiedBy == null ? null : String(modifiedBy));
  const result = await request.query<{ ID: number }>(EP_LINC_METHOD_REPRICE_SQL);
  return (result.recordset ?? [])
    .map((row) => row.ID)
    .filter((id): id is number => typeof id === 'number' && Number.isFinite(id));
}
