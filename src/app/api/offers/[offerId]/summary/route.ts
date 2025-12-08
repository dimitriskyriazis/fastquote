import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';

type OfferSummaryRow = {
  Title: string | null;
  Description: string | null;
  CustomerName: string | null;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  try {
    const { offerId: rawId } = await params;
    const normalizedId = decodeURIComponent(String(rawId ?? '')).trim();
    const numericId = Number(normalizedId);
    if (!normalizedId || !Number.isInteger(numericId) || numericId <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid offer id' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('__offerId', sql.Int, numericId);
    const result = await request.query<OfferSummaryRow>(`
      SELECT
        o.Title,
        o.Description,
        c.Name AS CustomerName
      FROM dbo.Offer AS o
      LEFT JOIN dbo.Customers AS c ON o.CustomerID = c.ID
      WHERE o.ID = @__offerId
    `);
    const row = result.recordset?.[0] ?? null;
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Offer not found' }, { status: 404 });
    }
    return NextResponse.json({
      ok: true,
      offer: {
        title: row.Title?.trim() ?? null,
        description: row.Description?.trim() ?? null,
        customerName: row.CustomerName?.trim() ?? null,
      },
    });
  } catch (error) {
    console.error('Failed to load offer summary', error);
    return NextResponse.json(
      { ok: false, error: 'Unable to fetch offer summary' },
      { status: 500 },
    );
  }
}
