import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';

type StatusCount = { Name: string; count: number };

export async function GET(request: NextRequest) {
  try {
    const pool = await getPool();
    const userId = request.nextUrl.searchParams.get('userId')?.trim() || null;

    const userFilter = userId ? ' AND o.SalesPersonId = @userId' : '';
    const userFilterShort = userId ? ' AND SalesPersonId = @userId' : '';

    const addUserParam = (req: ReturnType<typeof pool.request>) => {
      if (userId) req.input('userId', sql.NVarChar(450), userId);
      return req;
    };

    const [openResult, statusResult, monthResult, yearResult, winRateResult] = await Promise.all([
      addUserParam(pool.request()).query<{ openOffers: number }>(`
        SELECT COUNT(*) AS openOffers
        FROM dbo.Offer AS o
        JOIN dbo.OfferStatus AS os ON os.ID = o.StatusID
        WHERE o.Enabled = 1
          AND os.Name NOT IN ('Order Signed', 'Rejection', 'Cancelled')
          ${userFilter}
      `),
      addUserParam(pool.request()).query<StatusCount>(`
        SELECT os.Name, COUNT(*) AS count
        FROM dbo.Offer AS o
        JOIN dbo.OfferStatus AS os ON os.ID = o.StatusID
        WHERE o.Enabled = 1
          ${userFilter}
        GROUP BY os.Name
        ORDER BY COUNT(*) DESC
      `),
      addUserParam(pool.request()).query<{ createdThisMonth: number }>(`
        SELECT COUNT(*) AS createdThisMonth
        FROM dbo.Offer
        WHERE Enabled = 1
          AND MONTH(CreatedOn) = MONTH(GETDATE())
          AND YEAR(CreatedOn) = YEAR(GETDATE())
          ${userFilterShort}
      `),
      addUserParam(pool.request()).query<{ createdThisYear: number }>(`
        SELECT COUNT(*) AS createdThisYear
        FROM dbo.Offer
        WHERE Enabled = 1
          AND YEAR(CreatedOn) = YEAR(GETDATE())
          ${userFilterShort}
      `),
      addUserParam(pool.request()).query<{ winRate: number | null }>(`
        SELECT
          CAST(
            SUM(CASE WHEN os.Name IN ('Order Signed') THEN 1 ELSE 0 END) AS FLOAT
          ) / NULLIF(
            SUM(CASE WHEN os.Name IN ('Order Signed', 'Rejection', 'Cancelled') THEN 1 ELSE 0 END), 0
          ) AS winRate
        FROM dbo.Offer AS o
        JOIN dbo.OfferStatus AS os ON os.ID = o.StatusID
        WHERE o.Enabled = 1
          ${userFilter}
      `),
    ]);

    const offersByStatus: Record<string, number> = {};
    for (const row of statusResult.recordset ?? []) {
      if (row.Name) offersByStatus[row.Name] = row.count;
    }

    return NextResponse.json({
      ok: true,
      stats: {
        openOffers: openResult.recordset?.[0]?.openOffers ?? 0,
        offersByStatus,
        createdThisMonth: monthResult.recordset?.[0]?.createdThisMonth ?? 0,
        createdThisYear: yearResult.recordset?.[0]?.createdThisYear ?? 0,
        winRate: winRateResult.recordset?.[0]?.winRate ?? null,
      },
    });
  } catch (err) {
    console.error('Dashboard stats failed', err);
    return NextResponse.json(
      { ok: false, error: 'Failed to load dashboard stats' },
      { status: 500 },
    );
  }
}
