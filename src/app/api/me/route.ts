import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/sql';

type UserRecord = {
  Id: number;
  UserName: string | null;
  WindowsUserName: string | null;
};

type MeRequestBody = {
  windowsUserName?: string;
};

/**
 * POST /api/me
 *
 * Expects JSON body: { "windowsUserName": "TELMACO\\dim.kyriazis" }
 * (The browser gets this value from the IIS-protected /test.asp endpoint.)
 *
 * Returns the matching AspNetUsers row or an appropriate error.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as MeRequestBody;

    const rawWindowsUserName =
      typeof body.windowsUserName === 'string' ? body.windowsUserName.trim() : '';

    if (!rawWindowsUserName) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing windowsUserName in request body',
        },
        { status: 400 },
      );
    }

    // Use the full DOMAIN\\username as stored in AspNetUsers.WindowsUserName
    const windowsUserName = rawWindowsUserName;

    const pool = await getPool();
    const sqlRequest = pool.request();
    sqlRequest.input('WindowsUserName', windowsUserName);

    const result = await sqlRequest.query<UserRecord>(`
      SELECT TOP 1
        Id,
        UserName,
        WindowsUserName
      FROM dbo.AspNetUsers
      WHERE WindowsUserName = @WindowsUserName
    `);

    const user = result.recordset?.[0];

    if (!user) {
      return NextResponse.json(
        {
          ok: false,
          error: 'No matching application user for Windows identity',
          windowsUserName,
        },
        { status: 403 },
      );
    }

    return NextResponse.json({
      ok: true,
      user: {
        id: user.Id,
        userName: user.UserName,
        windowsUserName: user.WindowsUserName,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: 'Server error', details: message },
      { status: 500 },
    );
  }
}


