import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/logger';
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

    // Log API request
    logger.info('API request', {
      requestId,
      method,
      endpoint: pathname,
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
