// Runtime-agnostic session cookie policy — no crypto, no Node- or Edge-specific APIs,
// so both src/lib/session.ts (Node route handlers) and src/lib/sessionEdge.ts (Edge
// middleware) share ONE definition of the TTLs, the sliding-renewal rule and the
// companion expiry cookie.
//
// Why sliding renewal exists: /api/me is the only endpoint IIS protects with Windows
// Authentication, so every call to it is a fresh handshake against Active Directory.
// The SPA used to call it every 30 minutes purely to keep the session cookie from
// lapsing, which meant a browser holding a STALE cached credential (typical right after
// a domain password change) fired a bad-password attempt at the DC every 30 minutes per
// open tab and locked the account out. Renewing the already-verified session cookie on
// ordinary, anonymous requests removes that timer: the identity was proven once at
// login, and re-signing the cookie needs no AD round-trip.

import { SESSION_EXP_COOKIE_NAME } from './authConstants';

const readPositiveSeconds = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/** Lifetime stamped into a freshly minted — or slidingly renewed — session cookie. */
export const SESSION_TTL_SECONDS = readPositiveSeconds(
  process.env.SESSION_TTL_SECONDS,
  60 * 60 * 8,
);

/**
 * Hard ceiling, measured from the ORIGINAL login (`iat`), on how far sliding renewal may
 * push a session. Renewal is what removes the periodic Windows handshake; this cap is
 * what keeps it from becoming an unbounded session that never re-proves the Windows
 * identity. Once the cap is reached the cookie is allowed to expire and the SPA does one
 * real /api/me handshake.
 */
export const SESSION_ABSOLUTE_TTL_SECONDS = readPositiveSeconds(
  process.env.SESSION_ABSOLUTE_TTL_SECONDS,
  60 * 60 * 12,
);

/** Renew only once the cookie is inside this much of its expiry (avoids re-signing on every request). */
export const SESSION_RENEW_WINDOW_SECONDS = readPositiveSeconds(
  process.env.SESSION_RENEW_WINDOW_SECONDS,
  Math.max(60, Math.floor(SESSION_TTL_SECONDS / 2)),
);

/** Don't bother re-signing for a gain smaller than this (i.e. already pinned to the ceiling). */
const MIN_RENEW_GAIN_SECONDS = 60;

export const getSessionCookieSecure = (): boolean =>
  process.env.SESSION_COOKIE_SECURE != null ? process.env.SESSION_COOKIE_SECURE === 'true' : false;

export type SessionCookieDescriptor = {
  name: string;
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
};

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export const buildSessionExpCookie = (
  exp: number,
  now: number = nowSeconds(),
): SessionCookieDescriptor => ({
  name: SESSION_EXP_COOKIE_NAME,
  value: String(exp),
  httpOnly: false, // deliberately JS-readable: it is the SPA's "do I need /api/me?" signal
  secure: getSessionCookieSecure(),
  sameSite: 'lax',
  path: '/',
  maxAge: Math.max(0, exp - now),
});

/** Expire the hint cookie so the SPA stops believing it has a live session. */
export const buildClearedSessionExpCookie = (): SessionCookieDescriptor => ({
  name: SESSION_EXP_COOKIE_NAME,
  value: '',
  httpOnly: false,
  secure: getSessionCookieSecure(),
  sameSite: 'lax',
  path: '/',
  maxAge: 0,
});

/**
 * New `exp` for a sliding renewal, or null when renewal is not warranted (too early,
 * already expired, or the absolute ceiling leaves nothing meaningful to gain).
 * `iat` is preserved across renewals so the ceiling is measured from the real login.
 */
export const nextSessionExp = (
  payload: { iat?: number; exp: number },
  now: number = nowSeconds(),
): number | null => {
  const remaining = payload.exp - now;
  if (remaining <= 0) return null; // already dead — needs a real handshake, not a renewal
  if (remaining > SESSION_RENEW_WINDOW_SECONDS) return null; // not due yet
  const issuedAt = Number.isFinite(payload.iat) ? Number(payload.iat) : now;
  const ceiling = issuedAt + SESSION_ABSOLUTE_TTL_SECONDS;
  const candidate = Math.min(now + SESSION_TTL_SECONDS, ceiling);
  if (candidate <= payload.exp + MIN_RENEW_GAIN_SECONDS) return null;
  return candidate;
};
