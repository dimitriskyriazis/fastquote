import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/sql';

type UserRecord = {
  Id: number;
  UserName: string | null;
  WindowsUserName: string | null;
};

type WindowsIdentityResponse = {
  windowsUserName?: string;
};

const WINDOWS_IDENTITY_ENDPOINT = 'http://127.0.0.1/test.asp';

export async function GET() {
  try {
    // 1) Ask IIS (via classic ASP endpoint) who the current Windows user is
    const identityRes = await fetch(WINDOWS_IDENTITY_ENDPOINT, {
      cache: 'no-store',
    });

    if (!identityRes.ok) {
      const text = await identityRes.text().catch(() => '');
      return NextResponse.json(
        {
          ok: false,
          error: 'Failed to resolve Windows identity',
          details: text || identityRes.statusText,
        },
        { status: 502 },
      );
    }

    const identityJson = (await identityRes.json()) as WindowsIdentityResponse;
    const windowsUserName = typeof identityJson.windowsUserName === 'string'
      ? identityJson.windowsUserName.trim()
      : '';

    if (!windowsUserName) {
      return NextResponse.json(
        { ok: false, error: 'No Windows user resolved' },
        { status: 401 },
      );
    }

    // 2) Look up matching AspNetUsers row by full DOMAIN\\username
    const pool = await getPool();
    const request = pool.request();
    request.input('WindowsUserName', windowsUserName);

    const result = await request.query<UserRecord>(`
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

