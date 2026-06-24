import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/loggerEdge';
import { categoryFromRequest } from './src/lib/logCategory';
import { applyRateLimitEdge, isStrictOperation } from './src/lib/rateLimiterEdge';
import { SESSION_COOKIE_NAME } from './src/lib/authConstants';
import { verifySessionCookie } from './src/lib/sessionEdge';

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
    pathname === '/api/health' ||
    pathname === '/api/debug-windows-user';
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

  // Verify the session cookie's HMAC signature + expiry (not just presence). This is
  // the only authentication gate once IIS serves the app anonymously (Windows auth is
  // scoped to /api/me), so a forged or expired cookie must be rejected here.
  const sessionPayload =
    needsGate || isApi
      ? await verifySessionCookie(request.cookies.get(SESSION_COOKIE_NAME)?.value)
      : null;

  if (needsGate && !sessionPayload) {
    const response = isApi
      ? NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
      : new NextResponse('Authentication required', { status: 401 });
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

  if (request.nextUrl.pathname.startsWith('/api/')) {
    response.headers.set('x-request-id', requestId);
  }

  return response;
}

export const config = {
  matcher: '/:path*',
};
