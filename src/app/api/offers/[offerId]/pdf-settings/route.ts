import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';
import { requirePermission } from '../../../../../lib/authz';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/pdf-settings');
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { offerId } = await params;
    const numericId = Number(offerId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid offer ID' }, { status: 400 });
    }

    const pool = await getPool();

    // Compute NoOfLevels from current products
    const depthResult = await pool
      .request()
      .input('offerId', sql.Int, numericId)
      .query<{ MaxDepth: number }>(`
        SELECT ISNULL(MAX(
          LEN(od.TreeOrdering) - LEN(REPLACE(od.TreeOrdering, '.', '')) + 1
        ), 0) AS MaxDepth
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @offerId
          AND od.TreeOrdering IS NOT NULL
          AND od.TreeOrdering <> ''
      `);

    const noOfLevels = depthResult.recordset[0]?.MaxDepth ?? 0;

    // Update NoOfLevels in the offer
    await pool
      .request()
      .input('offerId', sql.Int, numericId)
      .input('noOfLevels', sql.Int, noOfLevels)
      .query(`
        UPDATE dbo.Offer
        SET NoOfLevels = @noOfLevels
        WHERE ID = @offerId
      `);

    // Fetch saved print preferences
    const settingsResult = await pool
      .request()
      .input('offerId', sql.Int, numericId)
      .query<{
        PrintProducts: boolean | number | null;
        PrintSubSubCategories: boolean | number | null;
        PrintSubCategories: boolean | number | null;
        PrintCategories: boolean | number | null;
        OfferLanguage: string | null;
        PaymentTerms: string | null;
        DeliveryTime: string | null;
        OfferValidity: string | null;
        InstallationSchedule: string | null;
        OfferDate: string | null;
      }>(`
        SELECT
          PrintProducts,
          PrintSubSubCategories,
          PrintSubCategories,
          PrintCategories,
          OfferLanguage,
          PaymentTerms,
          DeliveryTime,
          OfferValidity,
          InstallationSchedule,
          OfferDate
        FROM dbo.Offer
        WHERE ID = @offerId
      `);

    const row = settingsResult.recordset[0];

    return NextResponse.json({
      ok: true,
      noOfLevels,
      printProducts: row ? (!!row.PrintProducts ? 1 : 0) : 0,
      printSubSubCategories: row ? (!!row.PrintSubSubCategories ? 1 : 0) : 0,
      printSubCategories: row ? (!!row.PrintSubCategories ? 1 : 0) : 0,
      printCategories: row ? (!!row.PrintCategories ? 1 : 0) : 0,
      offerLanguage: row?.OfferLanguage ?? null,
      offerDate: row?.OfferDate ?? null,
      terms: {
        paymentTerms: row?.PaymentTerms ?? null,
        deliveryTime: row?.DeliveryTime ?? null,
        offerValidity: row?.OfferValidity ?? null,
        installationSchedule: row?.InstallationSchedule ?? null,
      },
    });
  } catch (err) {
    console.error('PDF settings fetch failed:', err);
    return NextResponse.json(
      { ok: false, error: 'Failed to fetch PDF settings' },
      { status: 500 },
    );
  }
}
