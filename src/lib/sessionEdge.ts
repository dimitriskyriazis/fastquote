// Edge-runtime-safe verification of the FastQuote session cookie.
//
// Mirrors the signing in src/lib/session.ts exactly: the cookie value is
// `<base64url(JSON payload)>.<base64url(HMAC-SHA256(payloadEncoded, SESSION_SECRET))>`.
// session.ts runs in Node (node:crypto); this module runs in the Edge middleware
// using Web Crypto only, so the middleware can verify the signature + expiry on
// every request (not just check that a cookie is present).

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
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadEncoded));
    const expected = bytesToBase64Url(new Uint8Array(sigBuf));
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
