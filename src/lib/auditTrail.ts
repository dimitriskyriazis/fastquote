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
  'fastquote-user-id',
  'fastquote_user_id',
];

const AUDIT_QUERY_PARAM_CANDIDATES = [
  'userId',
  'userid',
  'aspNetUserId',
  'aspnetuserid',
];

const normalizeAuditUserId = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.includes(':') ? trimmed.split(':').pop()?.trim() ?? null : trimmed;
};

const resolveFallbackAuditUserId = (): string | null => {
  const envCandidates = [
    process.env.AUDIT_DEFAULT_USER_ID,
    process.env.DEFAULT_ASPNET_USER_ID,
  ];
  for (const raw of envCandidates) {
    const normalized = normalizeAuditUserId(raw ?? null);
    if (normalized) return normalized;
  }
  return null;
};

const FALLBACK_AUDIT_USER_ID = resolveFallbackAuditUserId();

const readFromHeaders = (req: RequestLike): string | null => {
  if (!req?.headers) return null;
  for (const headerName of AUDIT_HEADER_CANDIDATES) {
    const normalized = normalizeAuditUserId(req.headers.get(headerName));
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

const readFromCookies = (req: RequestLike): string | null => {
  if (!req?.cookies || typeof req.cookies.get !== 'function') return null;
  for (const cookieName of AUDIT_COOKIE_CANDIDATES) {
    const normalized = normalizeAuditUserId(req.cookies.get(cookieName)?.value ?? null);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

const readFromQueryParams = (req: RequestLike): string | null => {
  const searchParams = req?.nextUrl?.searchParams;
  if (!searchParams) return null;
  for (const paramName of AUDIT_QUERY_PARAM_CANDIDATES) {
    const normalized = normalizeAuditUserId(searchParams.get(paramName));
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

export type AuditContext = {
  userId: string | null;
  hasExplicitUser: boolean;
};

export const getAuditFallbackUserId = () => FALLBACK_AUDIT_USER_ID;

export function buildAuditContext(req?: RequestLike): AuditContext {
  const fromHeaders = readFromHeaders(req);
  if (fromHeaders) {
    return { userId: fromHeaders, hasExplicitUser: true };
  }
  const fromCookies = readFromCookies(req);
  if (fromCookies) {
    return { userId: fromCookies, hasExplicitUser: true };
  }
  const fromQuery = readFromQueryParams(req);
  if (fromQuery) {
    return { userId: fromQuery, hasExplicitUser: true };
  }
  return { userId: FALLBACK_AUDIT_USER_ID ?? null, hasExplicitUser: false };
}

export const resolveAuditUserId = (req?: RequestLike): string | null =>
  buildAuditContext(req).userId;
