import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { buildAuditContext } from '../../../../../../lib/auditTrail';
import { getPool } from '../../../../../../lib/sql';
import { requirePermission } from '../../../../../../lib/authz';
import { realtimeEvents } from '../../../../../../lib/realtimeEvents';

const getDecimalType = () => {
  const decimalFactory = (sql as unknown as { Decimal: (precision: number, scale: number) => unknown }).Decimal;
  return decimalFactory(18, 4);
};

type RestoreRow = Record<string, unknown>;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const audit = buildAuditContext(req);
    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const offerId = Number(normalizedId);
    if (!Number.isInteger(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as { rows?: RestoreRow[] } | null;
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: 'No rows to restore' }, { status: 400 });
    }

    const pool = await getPool();
    const Decimal = getDecimalType();
    let restored = 0;

    // Get the next ordering values
    const orderingReq = pool.request();
    orderingReq.input('__offerId', sql.Int, offerId);
    const orderingResult = await orderingReq.query<{ maxOrdering: number | null; maxRoot: number | null }>(`
      SELECT
        MAX(ISNULL(od.Ordering, 0)) AS maxOrdering,
        MAX(
          TRY_CONVERT(INT,
            CASE
              WHEN CHARINDEX('.', LTRIM(RTRIM(ISNULL(od.TreeOrdering, '')))) > 0 THEN
                LEFT(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), CHARINDEX('.', LTRIM(RTRIM(ISNULL(od.TreeOrdering, '')))) - 1)
              ELSE NULLIF(LTRIM(RTRIM(ISNULL(od.TreeOrdering, ''))), '')
            END
          )
        ) AS maxRoot
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
    `);
    let nextOrdering = (orderingResult.recordset?.[0]?.maxOrdering ?? 0) + 1;
    let nextRoot = (orderingResult.recordset?.[0]?.maxRoot ?? 0) + 1;

    for (const row of rows) {
      const request = pool.request();
      request.input('__offerId', sql.Int, offerId);
      request.input('__ordering', sql.Int, nextOrdering);
      request.input('__treeOrdering', sql.NVarChar(255), String(nextRoot));
      request.input('__parentId', sql.Int, null);
      request.input('__isPrintable', sql.Bit, row.IsPrintable != null ? (row.IsPrintable ? 1 : 0) : 1);
      request.input('__isComment', sql.Bit, row.IsComment ? 1 : 0);
      request.input('__isCategory', sql.Bit, row.IsCategory ? 1 : 0);
      request.input('__enabled', sql.Bit, row.Enabled != null ? (row.Enabled ? 1 : 0) : 1);
      request.input('__description', sql.NVarChar(2000), row.ProductDescription ?? row.Description ?? null);
      request.input('__quantity', Decimal, row.Quantity ?? null);
      request.input('__listPrice', Decimal, row.ListPrice ?? null);
      request.input('__netUnitPrice', Decimal, row.NetUnitPrice ?? null);
      request.input('__totalPrice', Decimal, row.TotalPrice ?? null);
      request.input('__totalNet', Decimal, row.TotalNet ?? null);
      request.input('__netCost', Decimal, row.NetCost ?? null);
      request.input('__netCostOther', Decimal, row.NetCostOtherCurrency ?? null);
      request.input('__otherCurrencyId', sql.Int, row.OtherCurrencyID ?? null);
      request.input('__currencyCostModifier', Decimal, row.CurrencyCostModifier ?? null);
      request.input('__customerDiscount', Decimal, row.CustomerDiscount ?? null);
      request.input('__telmacoDiscount', Decimal, row.TelmacoDiscount ?? null);
      request.input('__margin', Decimal, row.Margin ?? null);
      request.input('__grossProfit', Decimal, row.GrossProfit ?? null);
      request.input('__totalCost', Decimal, row.TotalCost ?? null);
      request.input('__comment', sql.NVarChar(2000), row.Comment ?? null);
      request.input('__delivery', sql.NVarChar(500), row.Delivery ?? null);
      request.input('__warranty', sql.NVarChar(500), row.Warranty ?? null);
      request.input('__customerWarranty', sql.Int, typeof row.CustomerWarranty === 'number' ? row.CustomerWarranty : null);
      request.input('__productId', sql.Int, row.ProductID ?? null);
      request.input('__brandId', sql.Int, row.BrandID ?? null);
      request.input('__priceListId', sql.Int, row.PriceListID ?? null);
      request.input('__priceListItemId', sql.Int, row.PriceListItemID ?? null);
      request.input('__requestedItemNo', sql.NVarChar(500), row.RequestedItemNo ?? null);
      request.input('__requestedBrand', sql.NVarChar(500), row.RequestedBrand ?? null);
      request.input('__requestedModelNo', sql.NVarChar(500), row.RequestedModelNo ?? null);
      request.input('__requestedPartNo', sql.NVarChar(500), row.RequestedPartNo ?? null);
      request.input('__requestedWebLink', sql.NVarChar(2000), row.RequestedWebLink ?? null);
      request.input('__requestedDescription', sql.NVarChar(2000), row.RequestedDescription ?? null);
      request.input('__requestedDescription2', sql.NVarChar(2000), row.RequestedDescription2 ?? null);
      request.input('__requestedDescription3', sql.NVarChar(2000), row.RequestedDescription3 ?? null);
      request.input('__requestedQuantity', Decimal, row.RequestedQuantity ?? null);
      request.input('__userId', sql.NVarChar(450), audit.userId ?? null);

      await request.query(`
        INSERT INTO dbo.OfferDetails (
          OfferID, ParentOfferDetailID, TreeOrdering, Ordering,
          IsPrintable, IsComment, IsCategory, Enabled,
          ProductDescription, Quantity,
          ListPrice, NetUnitPrice, TotalPrice, TotalNet,
          NetCost, NetCostOtherCurrency, OtherCurrencyID, CurrencyCostModifier,
          CustomerDiscount, TelmacoDiscount, Margin, GrossProfit, TotalCost,
          Comment, Delivery, Warranty, CustomerWarranty,
          ProductID, BrandID, PriceListID, PriceListItemID,
          RequestedItemNo, RequestedBrand, RequestedModelNo, RequestedPartNo,
          RequestedWebLink, RequestedDescription, RequestedDescription2, RequestedDescription3,
          RequestedQuantity,
          CreatedOn, CreatedBy, ModifiedOn, ModifiedBy
        ) VALUES (
          @__offerId, @__parentId, @__treeOrdering, @__ordering,
          @__isPrintable, @__isComment, @__isCategory, @__enabled,
          @__description, @__quantity,
          @__listPrice, @__netUnitPrice, @__totalPrice, @__totalNet,
          @__netCost, @__netCostOther, @__otherCurrencyId, @__currencyCostModifier,
          @__customerDiscount, @__telmacoDiscount, @__margin, @__grossProfit, @__totalCost,
          @__comment, @__delivery, @__warranty, @__customerWarranty,
          @__productId, @__brandId, @__priceListId, @__priceListItemId,
          @__requestedItemNo, @__requestedBrand, @__requestedModelNo, @__requestedPartNo,
          @__requestedWebLink, @__requestedDescription, @__requestedDescription2, @__requestedDescription3,
          @__requestedQuantity,
          SYSUTCDATETIME(), @__userId, SYSUTCDATETIME(), @__userId
        )
      `);

      restored++;
      nextOrdering++;
      nextRoot++;
    }

    // Emit realtime event so the grid refreshes
    realtimeEvents.emit(
      `offer:${offerId}:products`,
      'rows-restored',
      { restoredCount: restored, updatedBy: audit.userId },
    );

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error('Failed to restore offer products', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
