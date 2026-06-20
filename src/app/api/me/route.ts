import { NextResponse, type NextRequest } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import { fetchUserRoles } from '../../../lib/authz';
import { getWindowsIdentityFromHeaders } from '../../../lib/windowsIdentity';
import { findUserByWindowsIdentity } from '../../../lib/windowsUserLookup';
import { buildSessionCookie, getSessionCookieSecure } from '../../../lib/session';
import { AUDIT_USER_COOKIE_NAME } from '../../../lib/authConstants';

/**
 * POST /api/me
 *
 * Resolves the app user from the IIS-injected X-Windows-User header (set by the
 * WindowsUserHeaderModule after Windows auth and not client-forgeable) and sets the
 * FastQuote session cookie. The request body is intentionally NOT trusted for identity.
 */
export async function POST(request: NextRequest) {
  logRequest(request, '/api/me');
  try {
    const windowsUserName = getWindowsIdentityFromHeaders(request.headers) ?? '';

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
