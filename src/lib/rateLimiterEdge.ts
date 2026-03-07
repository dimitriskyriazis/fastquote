import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from './loggerEdge';
import { getRequestId } from './requestId';

const createRateLimiter = (points: number, duration: number) =>
  new RateLimiterMemory({ points, duration, blockDuration: duration });

const ipLimiter = createRateLimiter(
  Number(process.env.RATE_LIMIT_IP_POINTS) || 5000,
  Number(process.env.RATE_LIMIT_IP_DURATION) || 900,
);

const strictLimiter = createRateLimiter(
  Number(process.env.RATE_LIMIT_STRICT_POINTS) || 1000,
  Number(process.env.RATE_LIMIT_STRICT_DURATION) || 900,
);

function getClientIp(req: NextRequest): string {
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const ips = forwardedFor.split(',').map((ip) => ip.trim());
    return ips[0] || 'unknown';
  }

  return req.headers.get('x-real-ip') || req.headers.get('cf-connecting-ip') || 'unknown';
}

function createRateLimitResponse(limiterRes: RateLimiterRes): NextResponse {
  const retryAfter = Math.ceil(limiterRes.msBeforeNext / 1000);

  return NextResponse.json(
    {
      ok: false,
      error: 'Too many requests. Please try again later.',
      retryAfter,
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(retryAfter),
        'X-RateLimit-Remaining': String(limiterRes.remainingPoints),
        'X-RateLimit-Reset': new Date(Date.now() + limiterRes.msBeforeNext).toISOString(),
      },
    },
  );
}

export type RateLimitOptions = {
  strict?: boolean;
  identifier?: string;
};

export async function applyRateLimitEdge(
  req: NextRequest,
  options: RateLimitOptions = {},
): Promise<NextResponse | null> {
  const requestId = await getRequestId(req);
  const clientIp = getClientIp(req);

  try {
    const ipKey = options.identifier || `ip:${clientIp}`;
    try {
      await ipLimiter.consume(ipKey);
    } catch (ipRejRes) {
      const ipLimiterRes = ipRejRes as RateLimiterRes;
      logger.warn('Rate limit exceeded (IP)', {
        requestId,
        ip: clientIp,
        endpoint: req.nextUrl.pathname,
        method: req.method,
        remaining: ipLimiterRes.remainingPoints,
      });
      return createRateLimitResponse(ipLimiterRes);
    }

    if (options.strict) {
      const strictKey = options.identifier ? `strict:${options.identifier}` : `strict:ip:${clientIp}`;
      try {
        await strictLimiter.consume(strictKey);
      } catch (strictRejRes) {
        const strictLimiterRes = strictRejRes as RateLimiterRes;
        logger.warn('Rate limit exceeded (Strict)', {
          requestId,
          ip: clientIp,
          endpoint: req.nextUrl.pathname,
          method: req.method,
          remaining: strictLimiterRes.remainingPoints,
        });
        return createRateLimitResponse(strictLimiterRes);
      }
    }

    return null;
  } catch (error) {
    logger.error('Rate limiter error', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function isWriteOperation(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}
