import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/sql';

type UserRecord = {
  Id: number;
  UserName: string | null;
  WindowsUserName: string | null;
};

export async function GET() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const query = `
      SELECT
        Id,
        UserName,
        WindowsUserName
      FROM dbo.AspNetUsers
      ORDER BY
        CASE WHEN UserName IS NULL OR LTRIM(RTRIM(UserName)) = '' THEN 1 ELSE 0 END,
        UserName
    `;
    const result = await request.query<UserRecord>(query);
    const users = (result.recordset ?? []).map((user) => ({
      id: user.Id,
      userName: user.UserName ?? null,
      windowsUserName: user.WindowsUserName ?? null,
    }));
    return NextResponse.json({ ok: true, users });
  } catch (err) {
    console.error('Failed to load AspNetUsers', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
