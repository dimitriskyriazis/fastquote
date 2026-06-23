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
import { AUDIT_USER_COOKIE_NAME } from '../../lib/authConstants';

const COOKIE_NAME = AUDIT_USER_COOKIE_NAME;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

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

const readCookieValue = (): string | null => {
  if (typeof document === 'undefined') return null;
  const segments = document.cookie.split(';').map((segment) => segment.trim());
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith(`${COOKIE_NAME}=`)) {
      const raw = decodeURIComponent(segment.slice(COOKIE_NAME.length + 1));
      return normalizeInput(raw) || null;
    }
  }
  return null;
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
    try {
      const meRes = await fetch('/api/me', {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
      });
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
      return { userId: null };
    }
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

    // Always (re)establish the signed session via /api/me on load. The session cookie is
    // httpOnly (JS can't read it) and outlived by the non-httpOnly fastquote-user-id
    // cookie, so we can't tell from the client whether it's still valid — we just re-mint
    // it. /api/me is a silent, IIS-authenticated, bodyless call. Skipping this (relying on
    // the user-id cookie alone) left returning users with an expired session and 401s.
    void (async () => {
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
