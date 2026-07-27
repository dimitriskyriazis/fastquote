import crypto from 'crypto';
import { SESSION_COOKIE_NAME } from './authConstants';
import {
  SESSION_TTL_SECONDS,
  buildSessionExpCookie,
  getSessionCookieSecure,
  nowSeconds,
  type SessionCookieDescriptor,
} from './sessionShared';

type CookieStore = {
  get(name: string): { value?: string } | undefined;
};

type SessionPayload = {
  uid: string;
  win: string;
  iat: number;
  exp: number;
};

const SESSION_SECRET = process.env.SESSION_SECRET ?? '';

const base64UrlEncode = (input: string | Buffer) => Buffer.from(input).toString('base64url');
const base64UrlDecode = (input: string) => Buffer.from(input, 'base64url').toString('utf8');

const sign = (data: string): string =>
  base64UrlEncode(crypto.createHmac('sha256', SESSION_SECRET).update(data).digest());

const timingSafeEqual = (a: string, b: string): boolean => {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

const ensureSecret = () => {
  if (!SESSION_SECRET) {
    throw new Error('SESSION_SECRET is required for session cookies');
  }
};

/**
 * Cookies to set after a successful Windows-auth handshake: the signed httpOnly session
 * itself plus the JS-readable expiry hint the SPA uses to avoid re-authenticating on a
 * timer. Always set BOTH together — a hint cookie that outlives its session would send
 * the client back to the pre-fix behaviour of assuming a session it no longer has.
 */
export const buildSessionCookies = (
  userId: string,
  windowsUserName: string,
): SessionCookieDescriptor[] => {
  ensureSecret();
  const now = nowSeconds();
  const exp = now + SESSION_TTL_SECONDS;
  const payload: SessionPayload = { uid: userId, win: windowsUserName, iat: now, exp };
  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signature = sign(payloadEncoded);
  return [
    {
      name: SESSION_COOKIE_NAME,
      value: `${payloadEncoded}.${signature}`,
      httpOnly: true,
      secure: getSessionCookieSecure(),
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    },
    buildSessionExpCookie(exp, now),
  ];
};

export { getSessionCookieSecure };

export const readSessionPayload = (cookies?: CookieStore): SessionPayload | null => {
  if (!cookies || typeof cookies.get !== 'function') return null;
  const raw = cookies.get(SESSION_COOKIE_NAME)?.value ?? '';
  if (!raw) return null;
  const [payloadEncoded, signature] = raw.split('.', 2);
  if (!payloadEncoded || !signature) return null;
  if (!SESSION_SECRET) return null;
  const expected = sign(payloadEncoded);
  if (!timingSafeEqual(signature, expected)) return null;

  try {
    const parsed = JSON.parse(base64UrlDecode(payloadEncoded)) as SessionPayload;
    if (!parsed?.uid || !parsed?.win || !parsed?.exp) return null;
    const now = nowSeconds();
    if (parsed.exp < now) return null;
    return parsed;
  } catch {
    return null;
  }
};

export const getSessionUserId = (cookies?: CookieStore): string | null =>
  readSessionPayload(cookies)?.uid ?? null;

export const getSessionWindowsUser = (cookies?: CookieStore): string | null =>
  readSessionPayload(cookies)?.win ?? null;
