import { NextRequest, NextResponse } from 'next/server';
import { getRequestId, setRequestIdHeader } from './src/lib/requestId';
import { logger } from './src/lib/logger';

export function middleware(request: NextRequest) {
  const requestId = getRequestId(request);
  const response = NextResponse.next();
  setRequestIdHeader(response, requestId);

  if (request.nextUrl.pathname.startsWith('/api/')) {
    const method = request.method;
    const pathname = request.nextUrl.pathname;
    
    logger.info('API request', {
      requestId,
      method,
      endpoint: pathname,
      userAgent: request.headers.get('user-agent')?.substring(0, 100),
    });

    response.headers.set('x-request-id', requestId);
  }

  return response;
}

export const config = {
  matcher: '/api/:path*',
};
