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

const COOKIE_NAME = 'fastquote-user-id';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 90; // 90 days

type AuditUser = {
  id: string;
  label: string;
  windowsUserName?: string;
};

type AuditUserContextValue = {
  userId: string;
  selectedUser: AuditUser | null;
  users: AuditUser[];
  loading: boolean;
  error: string | null;
  refreshUsers: () => Promise<void>;
  saveUserId: (nextId: string) => boolean;
  clearUser: () => void;
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
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
};

const clearCookieValue = () => {
  document.cookie = `${COOKIE_NAME}=; path=/; max-age=0`;
};

type WindowsAuthResult = {
  userId: string | null;
  accessDenied?: boolean;
  windowsUserName?: string;
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
  const autoResolveAttemptedRef = useState(() => ({ value: false }))[0];
  const windowsAuthAttemptedRef = useState(() => ({ value: false }))[0];

  const normalizeWindowsIdentity = (value: string): string => {
    return value.trim().replaceAll('/', '\\').toLowerCase();
  };

  /** Resolve current user via IIS Windows Auth: /test.asp → POST /api/me */
  const tryResolveViaWindowsAuth = useCallback(async (): Promise<WindowsAuthResult> => {
    try {
      const aspRes = await fetch('/test.asp', { credentials: 'include', cache: 'no-store' });
      if (!aspRes.ok) return { userId: null };
      const asp = (await aspRes.json().catch(() => null)) as { windowsUserName?: string } | null;
      const windowsUserName =
        typeof asp?.windowsUserName === 'string' ? asp.windowsUserName.trim() : '';
      if (!windowsUserName) return { userId: null };

      const meRes = await fetch('/api/me', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowsUserName }),
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
          windowsUserName: typeof me?.windowsUserName === 'string' ? me.windowsUserName : windowsUserName,
        };
      }
      if (!meRes.ok) return { userId: null };
      if (!me?.ok || !me.user || typeof me.user.id !== 'number') return { userId: null };
      return { userId: String(me.user.id) };
    } catch {
      return { userId: null };
    }
  }, []);

  const tryResolveWindowsIdentity = async (): Promise<string | null> => {
    try {
      const res = await fetch('/api/whoami', { cache: 'no-store' });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; username?: string; source?: string }
        | null;
      if (
        res.ok &&
        payload?.ok &&
        payload.source === 'header' &&
        typeof payload.username === 'string' &&
        payload.username.trim()
      ) {
        return payload.username.trim();
      }
    } catch {
      // ignore and fall back
    }

    try {
      const res = await fetch('/whoami.aspx', { cache: 'no-store' });
      if (!res.ok) return null;
      const text = (await res.text()).trim();
      return text ? text : null;
    } catch {
      return null;
    }
  };

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users');
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        users?: Array<{ id: number; userName: string | null; windowsUserName?: string | null }>;
        error?: string;
      } | null;

      if (!res.ok || !payload?.ok || !Array.isArray(payload.users)) {
        throw new Error(payload?.error ?? `Failed to load users (status ${res.status})`);
      }

      const mapped = payload.users
        .map((user) => ({
          id: String(user.id),
          label: user.userName || '',
          windowsUserName: user.windowsUserName ?? undefined,
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
    void refreshUsers();
  }, [refreshUsers]);

  useEffect(() => {
    if (windowsAuthAttemptedRef.value) return;
    // If we already have a user id from the cookie, skip Windows auth entirely.
    // This ensures Windows authentication is only attempted on the first visit
    // (or after the cookie has been cleared), avoiding repeated login prompts.
    if (userId) return;

    windowsAuthAttemptedRef.value = true;
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
    })();
  }, [userId, tryResolveViaWindowsAuth, windowsAuthAttemptedRef]);

  const selectedUser = useMemo(
    () => users.find((user) => user.id === userId) ?? null,
    [userId, users],
  );

  useEffect(() => {
    if (autoResolveAttemptedRef.value) return;
    if (loading) return;
    // If we already have a user id from the cookie, do not call Windows-auth endpoints
    // (e.g. /whoami.aspx); they can trigger a credential prompt.
    if (userId) return;
    if (users.length === 0) return;
    if (accessDeniedUnrecognizedUser) return;

    autoResolveAttemptedRef.value = true;

    void (async () => {
      const identity = await tryResolveWindowsIdentity();
      if (!identity) return;

      const normalized = normalizeWindowsIdentity(identity);
      const match = users.find((user) => {
        if (!user.windowsUserName) return false;
        return normalizeWindowsIdentity(user.windowsUserName) === normalized;
      });

      if (match) {
        writeCookieValue(match.id);
        setUserId(match.id);
      } else {
        setAccessDeniedUnrecognizedUser(true);
        setAccessDeniedWindowsIdentity(identity);
      }
    })();
  }, [loading, userId, selectedUser, users, accessDeniedUnrecognizedUser, autoResolveAttemptedRef]);

  const saveUserId = useCallback((nextId: string) => {
    const normalized = normalizeInput(nextId);
    if (!normalized) return false;
    writeCookieValue(normalized);
    setUserId(normalized);
    return true;
  }, []);

  const clearUser = useCallback(() => {
    clearCookieValue();
    setUserId('');
  }, []);

  const value = useMemo(
    () => ({
      userId,
      selectedUser,
      users,
      loading,
      error,
      refreshUsers,
      saveUserId,
      clearUser,
    }),
    [userId, selectedUser, users, loading, error, refreshUsers, saveUserId, clearUser],
  );

  if (accessDeniedUnrecognizedUser) {
    return (
      <AuditUserContext.Provider value={value}>
        <AccessDeniedPage windowsIdentity={accessDeniedWindowsIdentity} />
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
