import type { NextRequest } from 'next/server';

type CookieStore = {
  get(name: string): { value?: string } | undefined;
};

type RequestLike = Pick<NextRequest, 'headers' | 'cookies' | 'nextUrl'> | {
  headers?: Headers;
  cookies?: CookieStore;
  nextUrl?: { searchParams?: URLSearchParams };
} | null | undefined;

const AUDIT_HEADER_CANDIDATES = [
  'x-aspnet-user-id',
  'x-aspnet-userid',
  'x-user-id',
  'x-userid',
  'x-ms-client-principal-id',
  'x-authenticated-userid',
];

const AUDIT_COOKIE_CANDIDATES = [
  'aspnet-user-id',
  'aspnetuserid',
  'telquote-user-id',
  'telquote_user_id',
];

const AUDIT_QUERY_PARAM_CANDIDATES = [
  'userId',
  'userid',
  'aspNetUserId',
  'aspnetuserid',
];

const resolveFallbackAuditUserId = (): number => {
  const envCandidates = [
    process.env.AUDIT_DEFAULT_USER_ID,
    process.env.DEFAULT_ASPNET_USER_ID,
  ];
  for (const raw of envCandidates) {
    if (!raw) continue;
    const parsed = Number.parseInt(raw.trim(), 10);
    if (Number.isInteger(parsed)) {
      return parsed;
    }
  }
  return 0;
};

const FALLBACK_AUDIT_USER_ID = resolveFallbackAuditUserId();

const parseAuditUserId = (value: string | null | undefined): number | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const sanitized = trimmed.includes(':')
    ? trimmed.split(':').pop()?.trim() ?? ''
    : trimmed;
  if (!sanitized) return null;
  const parsed = Number.parseInt(sanitized, 10);
  return Number.isInteger(parsed) ? parsed : null;
};

const readFromHeaders = (req: RequestLike): number | null => {
  if (!req?.headers) return null;
  for (const headerName of AUDIT_HEADER_CANDIDATES) {
    const parsed = parseAuditUserId(req.headers.get(headerName));
    if (parsed != null) {
      return parsed;
    }
  }
  return null;
};

const readFromCookies = (req: RequestLike): number | null => {
  if (!req?.cookies || typeof req.cookies.get !== 'function') return null;
  for (const cookieName of AUDIT_COOKIE_CANDIDATES) {
    const parsed = parseAuditUserId(req.cookies.get(cookieName)?.value ?? null);
    if (parsed != null) {
      return parsed;
    }
  }
  return null;
};

const readFromQueryParams = (req: RequestLike): number | null => {
  const searchParams = req?.nextUrl?.searchParams;
  if (!searchParams) return null;
  for (const paramName of AUDIT_QUERY_PARAM_CANDIDATES) {
    const parsed = parseAuditUserId(searchParams.get(paramName));
    if (parsed != null) {
      return parsed;
    }
  }
  return null;
};

export type AuditContext = {
  userId: number;
  hasExplicitUser: boolean;
};

export const getAuditFallbackUserId = () => FALLBACK_AUDIT_USER_ID;

export function buildAuditContext(req?: RequestLike): AuditContext {
  const fromHeaders = readFromHeaders(req);
  if (fromHeaders != null) {
    return { userId: fromHeaders, hasExplicitUser: true };
  }
  const fromCookies = readFromCookies(req);
  if (fromCookies != null) {
    return { userId: fromCookies, hasExplicitUser: true };
  }
  const fromQuery = readFromQueryParams(req);
  if (fromQuery != null) {
    return { userId: fromQuery, hasExplicitUser: true };
  }
  return { userId: FALLBACK_AUDIT_USER_ID, hasExplicitUser: false };
}

export const resolveAuditUserId = (req?: RequestLike): number =>
  buildAuditContext(req).userId;
