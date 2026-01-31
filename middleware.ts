import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/logger';
import { applyRateLimitEdge, isWriteOperation } from './src/lib/rateLimiterEdge';
import { SESSION_COOKIE_NAME } from './src/lib/authConstants';

export async function middleware(request: NextRequest) {
  const requestId = await getRequestId(request);
  const pathname = request.nextUrl.pathname;
  
  // Apply rate limiting to all API routes
  if (pathname.startsWith('/api/')) {
    const allowUnauthed =
      pathname === '/api/sso' ||
      pathname === '/api/whoami' ||
      pathname === '/api/debug-windows-user';
    const requireSession = process.env.AUTH_REQUIRE_SESSION === 'true';
    if (requireSession && !allowUnauthed && request.method !== 'OPTIONS') {
      const sessionCookie = request.cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
      if (!sessionCookie) {
        const response = NextResponse.json(
          { ok: false, error: 'Authentication required' },
          { status: 401 },
        );
        setRequestIdHeader(response, requestId);
        return response;
      }
    }
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
  matcher: '/api/:path*',
};
