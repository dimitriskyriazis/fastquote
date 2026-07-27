import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/loggerEdge';
import { categoryFromRequest } from './src/lib/logCategory';
import { applyRateLimitEdge, isStrictOperation } from './src/lib/rateLimiterEdge';
import { SESSION_COOKIE_NAME, SESSION_EXP_COOKIE_NAME } from './src/lib/authConstants';
import {
  buildRenewedSessionCookies,
  verifySessionCookie,
  type EdgeSessionPayload,
} from './src/lib/sessionEdge';
import {
  buildClearedSessionExpCookie,
  buildSessionExpCookie,
  nowSeconds,
} from './src/lib/sessionShared';

// Fail loud (once per worker at module load) if the session secret is missing.
// Without it verifySessionCookie() returns null for EVERY request, silently
// demoting all authenticated users onto the shared anonymous IP rate-limit bucket
// — which behind the IIS reverse proxy re-creates the company-wide 429 outage that
// per-user rate limiting was added to prevent. Loud beats silent-and-broken.
if (!process.env.SESSION_SECRET) {
  logger.error(
    'SESSION_SECRET is not set — session cookies cannot be verified; all users will collapse onto the shared IP rate-limit bucket',
  );
}

const STATIC_ASSET_RE = /\.(?:ico|png|jpe?g|gif|svg|webp|avif|css|js|mjs|map|txt|xml|woff2?|ttf|otf|eot)$/i;

/**
 * Keep the session cookie alive WITHOUT going back to Active Directory.
 *
 * /api/me is the only Windows-authenticated endpoint, so every call to it is an AD
 * handshake — and a browser holding a stale cached credential (the normal state right
 * after a domain password change) turns each handshake into a bad-password attempt and
 * eventually an account lockout. The SPA used to call it every 30 minutes purely to stop
 * the 8h cookie from lapsing. Re-signing an already-verified session here removes that
 * timer entirely: the Windows identity was proven at login, and extending the cookie
 * needs no DC round-trip. lib/sessionShared.nextSessionExp caps the total extension at
 * SESSION_ABSOLUTE_TTL_SECONDS from the ORIGINAL login, so the identity still gets
 * re-proven — once or twice a day instead of dozens of times.
 *
 * The companion SESSION_EXP_COOKIE_NAME is the client's only way to see the (httpOnly)
 * session's expiry. It is written here on renewal, back-filled for sessions minted before
 * this code shipped, and CLEARED whenever the session is missing or invalid — that last
 * part is what makes it safe for the SPA to trust, unlike the old 90-day user-id cookie.
 */
async function applySessionRenewal(
  request: NextRequest,
  response: NextResponse,
  payload: EdgeSessionPayload | null,
): Promise<void> {
  const hint = request.cookies.get(SESSION_EXP_COOKIE_NAME)?.value ?? null;

  if (!payload) {
    if (hint) response.cookies.set(buildClearedSessionExpCookie());
    return;
  }

  const now = nowSeconds();
  const renewed = await buildRenewedSessionCookies(payload, now);
  if (renewed) {
    for (const cookie of renewed) response.cookies.set(cookie);
    return;
  }

  // Not due for renewal — just make sure the client's view of the expiry is accurate.
  if (hint !== String(payload.exp)) {
    response.cookies.set(buildSessionExpCookie(payload.exp, now));
  }
}

export async function middleware(request: NextRequest) {
  const requestId = await getRequestId(request);
  const pathname = request.nextUrl.pathname;

  const requireSession = process.env.AUTH_REQUIRE_SESSION === 'true';
  const isApi = pathname.startsWith('/api/');
  // Infra liveness probe (IIS ARR / uptime monitor). It is anonymous, so it would
  // otherwise land on the shared IP bucket and compete with the /api/me login
  // bootstrap; a throttled or 401'd probe can make IIS mark the backend pool down.
  // Exempt it from both the auth gate and rate limiting — probes must never be blocked.
  const isHealthProbe = pathname === '/api/health';
  const allowUnauthedApi =
    pathname === '/api/sso' ||
    pathname === '/api/me' ||
    pathname === '/api/whoami' ||
    pathname === '/api/health';
  const allowUnauthedPage =
    pathname === '/' ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    pathname.startsWith('/_next/');

  const needsGate =
    requireSession &&
    request.method !== 'OPTIONS' &&
    !allowUnauthedApi &&
    !allowUnauthedPage;

  const isStaticAsset = pathname.startsWith('/_next/') || STATIC_ASSET_RE.test(pathname);
  // /api/me and /api/sso mint their own session cookies from the Windows handshake, so
  // renewal must keep its hands off them — two Set-Cookie writes for one name is a
  // race, not a belt-and-braces.
  const mintsOwnSession = pathname === '/api/me' || pathname === '/api/sso';
  const canRenewSession = !isStaticAsset && !mintsOwnSession;

  // Verify the session cookie's HMAC signature + expiry (not just presence). This is
  // the only authentication gate once IIS serves the app anonymously (Windows auth is
  // scoped to /api/me), so a forged or expired cookie must be rejected here. Also
  // verified on anonymous pages (e.g. '/') that don't need the gate, because sliding
  // renewal and the expiry hint both depend on knowing the real session state there.
  const sessionPayload =
    needsGate || isApi || canRenewSession
      ? await verifySessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value)
      : null;

  if (needsGate && !sessionPayload) {
    const response = isApi
      ? NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
      : new NextResponse('Authentication required', { status: 401 });
    // Stop the client believing it still has a session, so it re-authenticates instead
    // of retrying against a cookie that will keep failing.
    if (request.cookies.has(SESSION_EXP_COOKIE_NAME)) {
      response.cookies.set(buildClearedSessionExpCookie());
    }
    setRequestIdHeader(response, requestId);
    return response;
  }

  // Apply rate limiting to all API routes (except the infra health probe).
  if (isApi && !isHealthProbe) {
    const method = request.method;

    // Attribute the request to the verified session (null if unauthenticated/invalid).
    // Behind the IIS reverse proxy every request can share one client IP (or collapse
    // to 'unknown'), so IP-only rate limiting throttled the whole company on a single
    // bucket. Keying by user isolates each user; anonymous requests fall back to IP.
    const userId = sessionPayload?.uid ?? null;

    // Apply rate limiting (strict only for destructive mutations: PUT/PATCH/DELETE).
    const rateLimitResponse = await applyRateLimitEdge(request, {
      strict: isStrictOperation(method),
      identifier: userId ? `user:${userId}` : undefined,
    });

    if (rateLimitResponse) {
      // Rate limit exceeded - return 429 response
      setRequestIdHeader(rateLimitResponse, requestId);
      return rateLimitResponse;
    }

    const category = categoryFromRequest(method, pathname);

    // Log API request
    logger.info('API request', {
      requestId,
      method,
      endpoint: pathname,
      userId,
      category,
      userAgent: request.headers.get('user-agent')?.substring(0, 100),
    });
  }

  const response = NextResponse.next();
  setRequestIdHeader(response, requestId);

  if (canRenewSession) {
    await applySessionRenewal(request, response, sessionPayload);
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('x-request-id', requestId);
  }

  return response;
}

export const config = {
  matcher: '/:path*',
};
