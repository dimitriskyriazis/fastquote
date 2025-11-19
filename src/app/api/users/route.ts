import { NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';

type UserRecord = {
  Id: number;
  FullName: string | null;
  Email: string | null;
};

export async function GET() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const query = `
      SELECT
        Id,
        FullName,
        Email
      FROM dbo.AspNetUsers
      ORDER BY
        CASE WHEN FullName IS NULL OR LTRIM(RTRIM(FullName)) = '' THEN 1 ELSE 0 END,
        FullName
    `;
    const result = await request.query<UserRecord>(query);
    const users = (result.recordset ?? []).map((user) => ({
      id: user.Id,
      fullName: user.FullName ?? 'Unknown user',
      email: user.Email ?? null,
    }));
    return NextResponse.json({ ok: true, users });
  } catch (err) {
    console.error('Failed to load AspNetUsers', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
