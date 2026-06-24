import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/loggerEdge';
import { categoryFromRequest } from './src/lib/logCategory';
import { applyRateLimitEdge, isStrictOperation } from './src/lib/rateLimiterEdge';
import { SESSION_COOKIE_NAME } from './src/lib/authConstants';
import { verifySessionCookie } from './src/lib/sessionEdge';

export async function middleware(request: NextRequest) {
  const requestId = await getRequestId(request);
  const pathname = request.nextUrl.pathname;

  const requireSession = process.env.AUTH_REQUIRE_SESSION === 'true';
  const isApi = pathname.startsWith('/api/');
  const allowUnauthedApi =
    pathname === '/api/sso' ||
    pathname === '/api/me' ||
    pathname === '/api/whoami' ||
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

  // Apply rate limiting to all API routes
  if (isApi) {
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
