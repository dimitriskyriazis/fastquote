import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/logger';
import { applyRateLimit, isWriteOperation } from './src/lib/rateLimiter';

export async function middleware(request: NextRequest) {
  const requestId = await getRequestId(request);
  
  // Apply rate limiting to all API routes
  if (request.nextUrl.pathname.startsWith('/api/')) {
    const method = request.method;
    const pathname = request.nextUrl.pathname;
    
    // Apply rate limiting (strict for write operations)
    const rateLimitResponse = await applyRateLimit(request, {
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
