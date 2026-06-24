import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from './loggerEdge';
import { getRequestId } from './requestId';

// NOTE: no `blockDuration` is set on any limiter. With rate-limiter-flexible that
// means there is no extended lock-out: once the rolling `duration` window frees up
// points they become available again. Previously every limiter used
// `blockDuration: duration`, so a brief burst locked the client out for the full
// 15-minute window (the `retryAfter: 445` users saw was mid-block).
const createRateLimiter = (points: number, duration: number) =>
  new RateLimiterMemory({ points, duration });

// Coarse backstop for UNAUTHENTICATED traffic, keyed by client IP. Authenticated
// requests are governed by `userLimiter` instead (see applyRateLimitEdge), so the
// IIS reverse proxy collapsing every user onto one shared IP no longer throttles
// the whole company on a single bucket.
const ipLimiter = createRateLimiter(
  Number(process.env.RATE_LIMIT_IP_POINTS) || 5000,
  Number(process.env.RATE_LIMIT_IP_DURATION) || 900,
);

// Primary per-user budget. This is the previously-configured-but-never-wired
// RATE_LIMIT_USER_* budget. It governs everything an authenticated user does,
// including the high-volume server-side grid block fetches (which are POSTs).
const userLimiter = createRateLimiter(
  Number(process.env.RATE_LIMIT_USER_POINTS) || 15000,
  Number(process.env.RATE_LIMIT_USER_DURATION) || 900,
);

// Extra throttle for genuine, destructive mutations only (PUT/PATCH/DELETE).
// Read-only grid data fetches use POST and must NOT count against this bucket,
// otherwise normal scrolling/filtering exhausts it (the original "offers don't
// load in prod" 429). POST creates are still bounded by `userLimiter` above.
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
  /**
   * Stable per-principal key, e.g. `user:<uid>` for an authenticated request.
   * When provided, the request is governed by the per-user budget; when omitted,
   * it falls back to a per-IP budget. Pass this for every authenticated request
   * so users are isolated from each other behind the reverse proxy.
   */
  identifier?: string;
};

export async function applyRateLimitEdge(
  req: NextRequest,
  options: RateLimitOptions = {},
): Promise<NextResponse | null> {
  const requestId = await getRequestId(req);
  const clientIp = getClientIp(req);

  // Authenticated requests carry an `identifier` (e.g. `user:42`); fall back to
  // the client IP for anonymous traffic.
  const isAuthenticated = Boolean(options.identifier);
  const principalKey = options.identifier || `ip:${clientIp}`;

  try {
    // General volume limit: per-user when authenticated, per-IP otherwise.
    const generalLimiter = isAuthenticated ? userLimiter : ipLimiter;
    try {
      await generalLimiter.consume(principalKey);
    } catch (generalRejRes) {
      const generalLimiterRes = generalRejRes as RateLimiterRes;
      logger.warn('Rate limit exceeded (General)', {
        requestId,
        ip: clientIp,
        principal: principalKey,
        authenticated: isAuthenticated,
        endpoint: req.nextUrl.pathname,
        method: req.method,
        remaining: generalLimiterRes.remainingPoints,
      });
      return createRateLimitResponse(generalLimiterRes);
    }

    if (options.strict) {
      const strictKey = `strict:${principalKey}`;
      try {
        await strictLimiter.consume(strictKey);
      } catch (strictRejRes) {
        const strictLimiterRes = strictRejRes as RateLimiterRes;
        logger.warn('Rate limit exceeded (Strict)', {
          requestId,
          ip: clientIp,
          principal: principalKey,
          authenticated: isAuthenticated,
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

/**
 * Whether a method mutates server state at all. Kept for callers/categorisation.
 */
export function isWriteOperation(method: string): boolean {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}

/**
 * Whether a request should additionally consume the *strict* (destructive-write)
 * budget. POST is deliberately excluded: server-side grids fetch their data with
 * POST, and counting those reads as strict writes is what exhausted the bucket and
 * caused widespread 429s. Genuine create endpoints remain bounded by the general
 * per-user limiter.
 */
export function isStrictOperation(method: string): boolean {
  return ['PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}
