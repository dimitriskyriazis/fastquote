import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { NextRequest, NextResponse } from 'next/server';
import { logger } from './loggerEdge';
import { getRequestId } from './requestId';

// ── Rate-limit budgets are configured EXCLUSIVELY via environment variables ──────────
// There are intentionally NO limit numbers in this file. The values live in the
// environment (.env.local in dev; the OS/PM2 process env in prod) so config never drifts
// between code and env. Tune a limit by changing the env var and redeploying.
//
// IMPORTANT (Next.js 16, edge middleware): this module is imported by middleware.ts, which
// runs in the Edge runtime. Edge bundles inline `process.env.X` at BUILD time, so a changed
// env var only takes effect after a rebuild — NOT on a bare process restart. The prod
// deploy (git pull + build + pm2 restart) rebuilds, so changes apply on the next deploy.
//
// FAIL CLOSED: if a var is missing/malformed we throw at module load (refuse to serve)
// rather than continue. This is deliberate: rate-limiter-flexible silently coerces a
// non-numeric `points` to its internal default of 4, which would throttle every user to
// ~4 requests/window — a silent, near-total lockout that's far harder to diagnose than a
// loud boot failure. (Mirrors, more strictly, the SESSION_SECRET guard in middleware.ts.)
const requireBudget = (raw: string | undefined, varName: string): number => {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === '' || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `[rateLimiterEdge] ${varName} is missing or invalid (got: ${raw ?? 'unset'}). ` +
        `Rate-limit budgets are configured exclusively via environment variables; set ` +
        `${varName} to a positive integer. Refusing to start.`,
    );
  }
  return n;
};

// NOTE: RateLimiterMemory is a FIXED window (not sliding) — the budget resets all at once
// when `duration` elapses from the principal's first request, and with no `blockDuration`
// set, an exhausted bucket's `retryAfter` is the time left in that window. So `*_DURATION`
// is also the worst-case lockout a tripped user faces; keep it short (e.g. 300s) so a false
// trip costs ~5 minutes, not the 15 the old 900s window imposed.
const createRateLimiter = (points: number, duration: number) =>
  new RateLimiterMemory({ points, duration });

// Coarse backstop for UNAUTHENTICATED traffic, keyed by client IP. Authenticated
// requests are governed by `userLimiter` instead (see applyRateLimitEdge), so the
// IIS reverse proxy collapsing every user onto one shared IP no longer throttles
// the whole company on a single bucket.
const ipLimiter = createRateLimiter(
  requireBudget(process.env.RATE_LIMIT_IP_POINTS, 'RATE_LIMIT_IP_POINTS'),
  requireBudget(process.env.RATE_LIMIT_IP_DURATION, 'RATE_LIMIT_IP_DURATION'),
);

// Primary per-user budget. Governs everything an authenticated user does, including the
// high-volume server-side grid block fetches (POSTs) AND every cell-edit PATCH. Keep this
// comfortably above the strict budget so strict (not this) stays the binding cap for edits;
// otherwise raising strict would just relocate the 429 onto this bucket in a mixed
// edit+scroll session.
const userLimiter = createRateLimiter(
  requireBudget(process.env.RATE_LIMIT_USER_POINTS, 'RATE_LIMIT_USER_POINTS'),
  requireBudget(process.env.RATE_LIMIT_USER_DURATION, 'RATE_LIMIT_USER_DURATION'),
);

// Extra throttle for mutations (PUT/PATCH/DELETE). Read-only grid data fetches use POST and
// must NOT count against this bucket, otherwise normal scrolling/filtering exhausts it (the
// original "offers don't load in prod" 429). POST creates are still bounded by `userLimiter`.
//
// NOTE: in this app PATCH is the *normal editing* verb — each single cell edit in the
// offer-products grid is one PATCH, and undo/redo PATCH too. So this bucket governs routine
// work, not just "destructive" ops; size RATE_LIMIT_STRICT_POINTS to cover a power user's
// editing/paste/undo burst within one window (the old 1000/15min tripped on normal edits).
const strictLimiter = createRateLimiter(
  requireBudget(process.env.RATE_LIMIT_STRICT_POINTS, 'RATE_LIMIT_STRICT_POINTS'),
  requireBudget(process.env.RATE_LIMIT_STRICT_DURATION, 'RATE_LIMIT_STRICT_DURATION'),
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
 * Whether a request should consume the *strict* (destructive-write) budget. POST is
 * deliberately excluded: server-side grids fetch their data with POST, and counting
 * those reads as strict writes is what exhausted the bucket and caused widespread
 * 429s. Genuine create endpoints (also POST) remain bounded by the general per-user
 * limiter. Do NOT widen this to include POST without separating grid-read POSTs first.
 */
export function isStrictOperation(method: string): boolean {
  return ['PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase());
}
