'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AccessDeniedPage from './AccessDeniedPage';
import { AUDIT_USER_COOKIE_NAME, SESSION_EXP_COOKIE_NAME } from '../../lib/authConstants';

const COOKIE_NAME = AUDIT_USER_COOKIE_NAME;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

// A session with more than this much life left needs no /api/me call at all. /api/me is
// the ONLY endpoint IIS guards with Windows auth, so every call is a handshake against
// Active Directory — and a browser holding a stale cached credential (the normal state
// right after a domain password change) turns each handshake into a bad-password attempt
// that walks the account toward a lockout. Middleware slides the session cookie forward
// on ordinary requests, so in active use this margin is never crossed and the app does
// exactly ONE handshake per login instead of one every 30 minutes per open tab.
const SESSION_OK_MARGIN_SECONDS = 15 * 60;
// How often to CHECK the expiry hint. This is a local cookie read: it costs no request
// and no handshake unless the session is genuinely close to expiring.
const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

type AuditUser = {
  id: string;
  label: string;
  windowsUserName?: string;
  roles: string[];
  salesSeniorityName?: string | null;
};

type AuditUserContextValue = {
  userId: string;
  selectedUser: AuditUser | null;
  users: AuditUser[];
  roles: string[];
  loading: boolean;
  error: string | null;
  refreshUsers: () => Promise<void>;
  saveUserId: (nextId: string) => boolean;
};

const AuditUserContext = createContext<AuditUserContextValue | undefined>(undefined);

const normalizeInput = (value: string): string => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return '';
  return String(parsed);
};

const readRawCookie = (name: string): string | null => {
  if (typeof document === 'undefined') return null;
  const segments = document.cookie.split(';').map((segment) => segment.trim());
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith(`${name}=`)) {
      return decodeURIComponent(segment.slice(name.length + 1));
    }
  }
  return null;
};

const readCookieValue = (): string | null =>
  normalizeInput(readRawCookie(COOKIE_NAME) ?? '') || null;

/**
 * Seconds of session left per the fastquote-session-exp hint, or null when there is no
 * usable hint — which is treated as "must re-authenticate". Trustworthy because
 * middleware writes, renews AND clears this cookie in lockstep with the httpOnly session
 * cookie it describes; it is a timing hint only and grants no access on its own.
 */
const sessionRemainingSeconds = (): number | null => {
  const raw = readRawCookie(SESSION_EXP_COOKIE_NAME);
  if (!raw) return null;
  const exp = Number(raw);
  if (!Number.isFinite(exp)) return null;
  return Math.floor(exp - Date.now() / 1000);
};

const hasHealthySession = (): boolean => {
  const remaining = sessionRemainingSeconds();
  return remaining !== null && remaining > SESSION_OK_MARGIN_SECONDS;
};

const writeCookieValue = (value: string) => {
  const isSecure = typeof window !== 'undefined' && window.location.protocol === 'https:';
  const secureFlag = isSecure ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secureFlag}`;
};

type WindowsAuthResult = {
  userId: string | null;
  accessDenied?: boolean;
  windowsUserName?: string | null;
};

export function AuditUserProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string>(() => readCookieValue() ?? '');
  const [users, setUsers] = useState<AuditUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accessDeniedUnrecognizedUser, setAccessDeniedUnrecognizedUser] = useState(false);
  const [accessDeniedWindowsIdentity, setAccessDeniedWindowsIdentity] = useState<string | null>(
    null,
  );
  const windowsAuthAttemptedRef = useState(() => ({ value: false }))[0];
  // Whether the initial /api/me session bootstrap has completed. We gate rendering on
  // this so child components never fire authenticated API calls before a signed session
  // cookie exists (which would 401).
  const [sessionEstablished, setSessionEstablished] = useState(false);

  /** Resolve current user via IIS Windows Auth: POST /api/me reads the
   *  IIS-injected X-Windows-User header (set by WindowsUserHeaderModule). */
  const tryResolveViaWindowsAuth = useCallback(async (): Promise<WindowsAuthResult> => {
    // Retry transient failures (429 rate-limit, 5xx) with backoff instead of giving
    // up after one shot. A throttled /api/me used to drop the user into a session-less
    // app that 401s on every request with no recovery path; retrying re-mints the
    // session once the limiter frees up. Honors Retry-After (capped) when present.
    const MAX_ATTEMPTS = 4;
    // A 5xx means the backend itself is down (deploy / pm2 restart). Unlike a 429 that
    // frees up on its own, no amount of retrying inside one page load fixes it — while
    // every retry is another AD handshake, so a restart could burn a whole lockout
    // threshold in 15 seconds. Cap those tightly; the focus/visibility path recovers
    // once the backend is back.
    const MAX_SERVER_ERROR_ATTEMPTS = 2;
    let serverErrorAttempts = 0;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const meRes = await fetch('/api/me', {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
        });

        const isServerError = meRes.status >= 500;
        if (isServerError) serverErrorAttempts += 1;
        const retriesLeft =
          attempt < MAX_ATTEMPTS - 1 &&
          !(isServerError && serverErrorAttempts >= MAX_SERVER_ERROR_ATTEMPTS);

        // Transient — wait and retry rather than rendering a broken, session-less app.
        if ((meRes.status === 429 || isServerError) && retriesLeft) {
          const retryAfter = Number(meRes.headers.get('Retry-After'));
          const backoffMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? Math.min(retryAfter * 1000, 15000)
              : Math.min(1000 * 2 ** attempt, 8000);
          await sleep(backoffMs);
          continue;
        }

        const me = (await meRes.json().catch(() => null)) as {
          ok?: boolean;
          reason?: string;
          windowsUserName?: string;
          user?: { id: number; userName?: string | null; windowsUserName?: string | null };
        } | null;

        if (meRes.status === 403 && (me?.reason === 'unrecognized_windows_user' || !me?.ok)) {
          return {
            userId: null,
            accessDenied: true,
            windowsUserName: typeof me?.windowsUserName === 'string' ? me.windowsUserName : null,
          };
        }
        if (!meRes.ok) return { userId: null };
        if (!me?.ok || !me.user || typeof me.user.id !== 'number') return { userId: null };
        return { userId: String(me.user.id) };
      } catch {
        // Network error — back off and retry a couple of times before giving up.
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(Math.min(1000 * 2 ** attempt, 8000));
          continue;
        }
        return { userId: null };
      }
    }
    return { userId: null };
  }, []);

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users');
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        users?: Array<{
          id: number;
          fullName?: string | null;
          userName: string | null;
          windowsUserName?: string | null;
          roles?: string[];
          salesSeniorityName?: string | null;
        }>;
        error?: string;
      } | null;

      if (!res.ok || !payload?.ok || !Array.isArray(payload.users)) {
        throw new Error(payload?.error ?? `Failed to load users (status ${res.status})`);
      }

      const mapped = payload.users
        .map((user) => ({
          id: String(user.id),
          label: user.fullName?.trim() || user.userName || '',
          windowsUserName: user.windowsUserName ?? undefined,
          roles: Array.isArray(user.roles) ? user.roles : [],
          salesSeniorityName: user.salesSeniorityName ?? null,
        }))
        .filter((user) => Boolean(user.label));
      setUsers(mapped);
    } catch (err) {
      console.error('Failed to load audit users', err);
      setError(err instanceof Error ? err.message : 'Unable to load users');
      setUsers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!userId) return;
    void refreshUsers();
  }, [refreshUsers, userId]);

  useEffect(() => {
    if (windowsAuthAttemptedRef.value) return;
    windowsAuthAttemptedRef.value = true;

    // Establish the signed session via /api/me — but only when we actually need to.
    //
    // The session cookie is httpOnly so JS can't inspect it; what it CAN read is the
    // fastquote-session-exp hint middleware maintains alongside it. A hint with
    // comfortable life left means the session is live, so the Windows handshake is
    // skipped. This is NOT a return to the old bug of trusting the 90-day
    // fastquote-user-id cookie: that cookie said nothing about session validity and left
    // returning users with an expired session and 401 storms. The hint carries the real
    // expiry, and middleware CLEARS it the moment the session is missing or invalid, so a
    // stale hint cannot survive even one request.
    void (async () => {
      if (readCookieValue() && hasHealthySession()) {
        setSessionEstablished(true);
        return;
      }

      const result = await tryResolveViaWindowsAuth();
      if (result.accessDenied) {
        setAccessDeniedUnrecognizedUser(true);
        setAccessDeniedWindowsIdentity(result.windowsUserName ?? null);
        return;
      }
      if (result.userId) {
        writeCookieValue(result.userId);
        setUserId(result.userId);
      }
      setSessionEstablished(true);
    })();
  }, [tryResolveViaWindowsAuth, windowsAuthAttemptedRef]);

  // Re-authenticate a long-open tab only when its session is genuinely about to lapse.
  //
  // Middleware slides the session cookie forward on ordinary requests, so a tab in active
  // use never approaches expiry and this handler costs nothing. What remains is the real
  // edge case: a tab open past the absolute cap, or a machine asleep overnight, whose
  // cookie has actually died. Without recovery the next authenticated request 401s and,
  // now carrying no uid, collapses onto the shared per-IP rate-limit bucket and starts
  // returning 429s on top ("Authentication required" + "Too many requests").
  //
  // This deliberately no longer re-mints on a fixed 30-minute timer. That timer meant a
  // full Active Directory handshake every half hour for every open tab, which is how one
  // stale cached credential — the normal state after a domain password change — locked
  // users out of the domain within a few hours.
  useEffect(() => {
    if (!sessionEstablished) return;
    if (accessDeniedUnrecognizedUser) return;
    if (typeof window === 'undefined') return;

    // Coalesce bursts of focus/visibility/online events (rapid tab flipping) so we
    // don't re-mint — and spend rate-limit budget — more than once per window.
    const MIN_REMINT_GAP_MS = 5 * 60 * 1000; // 5 min

    let lastRemintAt = Date.now();
    let cancelled = false;
    let inFlight = false;

    const remintIfExpiring = async () => {
      if (cancelled || inFlight) return;
      // No point refreshing a hidden tab — the visibility handler catches the moment it
      // becomes visible again, which is exactly the overnight case.
      if (document.visibilityState === 'hidden') return;
      // The common case: the session is healthy, so there is nothing to do and — the whole
      // point — no handshake to make.
      if (hasHealthySession()) return;
      inFlight = true;
      try {
        const result = await tryResolveViaWindowsAuth();
        if (cancelled) return;
        lastRemintAt = Date.now();
        if (result.userId) {
          writeCookieValue(result.userId);
          setUserId(result.userId);
        }
        // A background refresh deliberately does NOT tear the app down on a
        // transient failure or a mid-session access change: the next focus tick
        // (or a real request's own error path) recovers, and staying quiet avoids
        // false "access denied"/"signing in" flashes on a flaky network.
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => {
      void remintIfExpiring();
    }, SESSION_CHECK_INTERVAL_MS);

    const onWake = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastRemintAt < MIN_REMINT_GAP_MS) return;
      void remintIfExpiring();
    };

    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onWake);
    window.addEventListener('online', onWake);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [sessionEstablished, accessDeniedUnrecognizedUser, tryResolveViaWindowsAuth]);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === userId) ?? null,
    [userId, users],
  );

  const saveUserId = useCallback((nextId: string) => {
    const normalized = normalizeInput(nextId);
    if (!normalized) return false;
    writeCookieValue(normalized);
    setUserId(normalized);
    return true;
  }, []);

  const value = useMemo(
    () => ({
      userId,
      selectedUser,
      users,
      roles: selectedUser?.roles ?? [],
      loading,
      error,
      refreshUsers,
      saveUserId,
    }),
    [userId, selectedUser, users, loading, error, refreshUsers, saveUserId],
  );

  if (accessDeniedUnrecognizedUser) {
    return (
      <AuditUserContext.Provider value={value}>
        <AccessDeniedPage windowsIdentity={accessDeniedWindowsIdentity} />
      </AuditUserContext.Provider>
    );
  }

  if (!sessionEstablished) {
    return (
      <AuditUserContext.Provider value={value}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            fontFamily: 'system-ui, sans-serif',
            color: '#888',
          }}
        >
          Signing in…
        </div>
      </AuditUserContext.Provider>
    );
  }

  return <AuditUserContext.Provider value={value}>{children}</AuditUserContext.Provider>;
}

export const useAuditUser = () => {
  const ctx = useContext(AuditUserContext);
  if (!ctx) {
    throw new Error('useAuditUser must be used within an AuditUserProvider');
  }
  return ctx;
};

export const normalizeAuditUserInput = normalizeInput;
