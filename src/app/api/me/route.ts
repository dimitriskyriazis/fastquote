import { NextResponse, type NextRequest } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import { fetchUserRoles } from '../../../lib/authz';
import { getWindowsIdentityFromHeaders } from '../../../lib/windowsIdentity';
import { findUserByWindowsIdentity } from '../../../lib/windowsUserLookup';
import { buildSessionCookie, getSessionCookieSecure } from '../../../lib/session';
import { AUDIT_USER_COOKIE_NAME } from '../../../lib/authConstants';

type MeRequestBody = {
  windowsUserName?: string;
};

/**
 * POST /api/me
 *
 * Uses the IIS-injected X-Windows-User header to resolve the app user and
 * sets the FastQuote session cookie.
 */
export async function POST(request: NextRequest) {
  logRequest(request, '/api/me');
  try {
    const headerIdentity = getWindowsIdentityFromHeaders(request.headers);
    let windowsUserName = headerIdentity ?? '';

    if (!windowsUserName) {
      const body = (await request.json().catch(() => ({}))) as MeRequestBody;
      const rawWindowsUserName =
        typeof body.windowsUserName === 'string' ? body.windowsUserName.trim() : '';
      const allowBodyOverride = process.env.ALLOW_WINDOWS_USER_BODY === 'true';
      windowsUserName = allowBodyOverride ? rawWindowsUserName : '';
    }

    if (!windowsUserName) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Missing Windows identity header',
        },
        { status: 401 },
      );
    }

    const user = await findUserByWindowsIdentity(windowsUserName);

    if (!user) {
      return NextResponse.json(
        {
          ok: false,
          error: 'No matching application user for Windows identity',
          reason: 'unrecognized_windows_user',
          windowsUserName,
        },
        { status: 403 },
      );
    }

    const roles = await fetchUserRoles(String(user.Id));

    const response = NextResponse.json({
      ok: true,
      user: {
        id: user.Id,
        userName: user.UserName,
        windowsUserName: user.WindowsUserName,
        roles,
      },
    });
    const sessionCookie = buildSessionCookie(String(user.Id), windowsUserName);
    response.cookies.set(sessionCookie);
    response.cookies.set({
      name: AUDIT_USER_COOKIE_NAME,
      value: String(user.Id),
      httpOnly: false,
      secure: getSessionCookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 90,
    });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { ok: false, error: 'Server error', details: message },
      { status: 500 },
    );
  }
}
