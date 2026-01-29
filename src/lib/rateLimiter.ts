import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAuditUserId } from './auditTrail';
import { logger } from './logger';
import { getRequestId } from './requestId';

/**
 * Rate limiter configuration following OWASP best practices
 * 
 * Default limits:
 * - IP-based: 100 requests per 15 minutes (burst protection)
 * - User-based: 200 requests per 15 minutes (authenticated users get higher limit)
 * - Strict endpoints (create/update/delete): 30 requests per 15 minutes
 */
const createRateLimiter = (points: number, duration: number) => {
  return new RateLimiterMemory({
    points, // Number of requests
    duration, // Per duration in seconds
    blockDuration: duration, // Block for the same duration
  });
};

// IP-based rate limiter (applies to all requests)
const ipLimiter = createRateLimiter(
  Number(process.env.RATE_LIMIT_IP_POINTS),
  Number(process.env.RATE_LIMIT_IP_DURATION), // 15 minutes
);

// User-based rate limiter (applies to authenticated requests)
const userLimiter = createRateLimiter(
  Number(process.env.RATE_LIMIT_USER_POINTS),
  Number(process.env.RATE_LIMIT_USER_DURATION), // 15 minutes
);

// Strict rate limiter for write operations (create/update/delete)
const strictLimiter = createRateLimiter(
  Number(process.env.RATE_LIMIT_STRICT_POINTS),
  Number(process.env.RATE_LIMIT_STRICT_DURATION), // 15 minutes
);

/**
 * Get client IP address from request
 * Handles proxies and load balancers
 */
function getClientIp(req: NextRequest): string {
  // Check various headers for real IP (handles proxies/load balancers)
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    const ips = forwardedFor.split(',').map((ip) => ip.trim());
    return ips[0] || 'unknown';
  }

  const realIp = req.headers.get('x-real-ip');
  if (realIp) {
    return realIp;
  }

  // Fallback to Cloudflare connecting IP or unknown
  return req.headers.get('cf-connecting-ip') || 'unknown';
}

/**
 * Create a graceful 429 response with retry-after header
 */
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
  /**
   * Whether to apply strict rate limiting (for write operations)
   * @default false
   */
  strict?: boolean;
  /**
   * Custom identifier for rate limiting (overrides IP/user detection)
   */
  identifier?: string;
};

/**
 * Apply rate limiting to a request
 * 
 * @param req - Next.js request
 * @param options - Rate limiting options
 * @returns null if request should proceed, or a 429 response if rate limited
 */
export async function applyRateLimit(
  req: NextRequest,
  options: RateLimitOptions = {},
): Promise<NextResponse | null> {
  const requestId = await getRequestId(req);
  const clientIp = getClientIp(req);
  const userId = resolveAuditUserId(req);

  try {
    // Always apply IP-based rate limiting
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

    // Apply user-based rate limiting if user is authenticated
    if (userId) {
      const userKey = options.identifier || `user:${userId}`;
      try {
        await userLimiter.consume(userKey);
      } catch (userRejRes) {
        const userLimiterRes = userRejRes as RateLimiterRes;
        logger.warn('Rate limit exceeded (User)', {
          requestId,
          userId,
          ip: clientIp,
          endpoint: req.nextUrl.pathname,
          method: req.method,
          remaining: userLimiterRes.remainingPoints,
        });
        return createRateLimitResponse(userLimiterRes);
      }
    }

    // Apply strict rate limiting for write operations
    if (options.strict) {
      const strictKey = options.identifier 
        ? `strict:${options.identifier}`
        : userId 
          ? `strict:user:${userId}` 
          : `strict:ip:${clientIp}`;
      
      try {
        await strictLimiter.consume(strictKey);
      } catch (strictRejRes) {
        const strictLimiterRes = strictRejRes as RateLimiterRes;
        logger.warn('Rate limit exceeded (Strict)', {
          requestId,
          userId,
          ip: clientIp,
          endpoint: req.nextUrl.pathname,
          method: req.method,
          remaining: strictLimiterRes.remainingPoints,
        });
        return createRateLimitResponse(strictLimiterRes);
      }
    }

    return null; // Request should proceed
  } catch (error) {
    // If rate limiter fails, log but allow request (fail open for availability)
    logger.error('Rate limiter error', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Check if a method is a write operation (POST, PUT, PATCH, DELETE)
 */
export function isWriteOperation(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}
