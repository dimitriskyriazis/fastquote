// Edge-runtime-safe verification AND sliding renewal of the FastQuote session cookie.
//
// Mirrors the signing in src/lib/session.ts exactly: the cookie value is
// `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payloadEncoded, SESSION_SECRET))>`.
// session.ts runs in Node (node:crypto); this module runs in the Edge middleware
// using Web Crypto only, so the middleware can verify the signature + expiry on
// every request (not just check that a cookie is present) — and re-sign a still-valid
// session with a later expiry, which is what lets the SPA stop calling the
// Windows-authenticated /api/me on a timer (see lib/sessionShared.ts for the why).

import { SESSION_COOKIE_NAME } from './authConstants';
import {
  SESSION_TTL_SECONDS,
  buildSessionExpCookie,
  getSessionCookieSecure,
  nextSessionExp,
  nowSeconds,
  type SessionCookieDescriptor,
} from './sessionShared';

export type EdgeSessionPayload = { uid: string; win: string; iat: number; exp: number };

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  // btoa -> standard base64; convert to base64url and strip padding to match
  // Node's Buffer.toString('base64url').
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const constantTimeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
};

const signPayload = async (payloadEncoded: string, secret: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadEncoded));
  return bytesToBase64Url(new Uint8Array(sigBuf));
};

/**
 * Returns the decoded payload if the cookie's HMAC signature is valid and it has
 * not expired, otherwise null. Never throws.
 */
export async function verifySessionCookie(
  raw: string | undefined | null,
): Promise<EdgeSessionPayload | null> {
  const secret = process.env.SESSION_SECRET ?? '';
  if (!raw || !secret) return null;

  const dot = raw.indexOf('.');
  if (dot <= 0) return null;
  const payloadEncoded = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  if (!payloadEncoded || !signature) return null;

  try {
    const expected = await signPayload(payloadEncoded, secret);
    if (!constantTimeEqual(expected, signature)) return null;

    let b64 = payloadEncoded.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const payload = JSON.parse(atob(b64)) as EdgeSessionPayload;
    if (!payload?.uid || !payload?.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Re-signs an ALREADY-VERIFIED session with a later expiry, returning the session cookie
 * plus its refreshed expiry hint — or null when renewal isn't warranted (not due yet, or
 * the absolute ceiling from the original login has been reached, in which case the
 * session is left to expire so a real Windows handshake happens).
 *
 * This never grants identity: it only extends a session whose signature the caller has
 * just verified, keeps the original `iat` so the ceiling can't be walked forward, and
 * carries the same uid/win. Never throws.
 */
export async function buildRenewedSessionCookies(
  payload: EdgeSessionPayload,
  now: number = nowSeconds(),
): Promise<SessionCookieDescriptor[] | null> {
  const secret = process.env.SESSION_SECRET ?? '';
  if (!secret) return null;
  // A payload without `win` would fail the Node-side checks in readSessionPayload, so
  // don't manufacture one — let it lapse and be re-minted by /api/me.
  if (!payload.uid || !payload.win) return null;

  const exp = nextSessionExp(payload, now);
  if (exp === null) return null;

  try {
    const issuedAt = Number.isFinite(payload.iat) ? Number(payload.iat) : now;
    const renewed: EdgeSessionPayload = {
      uid: payload.uid,
      win: payload.win,
      iat: issuedAt,
      exp,
    };
    const payloadEncoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(renewed)));
    const signature = await signPayload(payloadEncoded, secret);
    return [
      {
        name: SESSION_COOKIE_NAME,
        value: `${payloadEncoded}.${signature}`,
        httpOnly: true,
        secure: getSessionCookieSecure(),
        sameSite: 'lax',
        path: '/',
        // Cap the browser-side lifetime at the signed expiry, never beyond it.
        maxAge: Math.min(SESSION_TTL_SECONDS, Math.max(0, exp - now)),
      },
      buildSessionExpCookie(exp, now),
    ];
  } catch {
    return null;
  }
}
