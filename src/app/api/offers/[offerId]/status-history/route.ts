import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../lib/sql';
import sql from 'mssql';
import { requirePermission } from '../../../../../lib/authz';

type StatusHistoryEntry = {
  ID: number;
  StatusID: number;
  StatusName: string;
  CreatedOn: Date;
  CreatedBy: string | null;
  CreatedByFullName: string | null;
  CreatedByUserName: string | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> }
) {
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing offer ID' }, { status: 400 });
    }

    const offerId = Number(normalizedId);
    if (!Number.isInteger(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid offer ID' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('offerId', sql.Int, offerId);

    const result = await request.query<StatusHistoryEntry>(`
      SELECT
        h.ID,
        h.StatusID,
        s.Name AS StatusName,
        h.CreatedOn,
        h.CreatedBy,
        u.FullName AS CreatedByFullName,
        u.UserName AS CreatedByUserName
      FROM dbo.OfferStatusHistory h
      INNER JOIN dbo.OfferStatus s ON h.StatusID = s.ID
      LEFT JOIN dbo.AspNetUsers u ON h.CreatedBy = u.Id
      WHERE h.OfferID = @offerId AND h.Enabled = 1
      ORDER BY h.CreatedOn DESC, h.ID DESC
    `);

    return NextResponse.json({ ok: true, history: result.recordset });
  } catch (err) {
    console.error('Error fetching offer status history:', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
