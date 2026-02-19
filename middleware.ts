import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/loggerEdge';
import { categoryFromRequest } from './src/lib/logCategory';
import { applyRateLimitEdge, isWriteOperation } from './src/lib/rateLimiterEdge';
import { SESSION_COOKIE_NAME } from './src/lib/authConstants';

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

  if (
    requireSession &&
    request.method !== 'OPTIONS' &&
    !allowUnauthedApi &&
    !allowUnauthedPage
  ) {
    const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
    if (!sessionCookie) {
      const response = isApi
        ? NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 })
        : new NextResponse('Authentication required', { status: 401 });
      setRequestIdHeader(response, requestId);
      return response;
    }
  }

  // Apply rate limiting to all API routes
  if (isApi) {
    const method = request.method;

    // Apply rate limiting (strict for write operations)
    const rateLimitResponse = await applyRateLimitEdge(request, {
      strict: isWriteOperation(method),
    });

    if (rateLimitResponse) {
      // Rate limit exceeded - return 429 response
      setRequestIdHeader(rateLimitResponse, requestId);
      return rateLimitResponse;
    }

    // Decode session cookie to get userId for logging (no signature verification needed here)
    let userId: string | null = null;
    try {
      const raw = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
      const [encoded] = raw.split('.', 1);
      if (encoded) {
        const decoded = JSON.parse(atob(encoded.replace(/-/g, '+').replace(/_/g, '/'))) as { uid?: string };
        userId = decoded?.uid ?? null;
      }
    } catch { /* ignore */ }

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
