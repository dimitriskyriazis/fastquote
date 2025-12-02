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

const COOKIE_NAME = 'fastquote-user-id';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // one year

type AuditUser = {
  id: string;
  label: string;
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

export function AuditUserProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string>(() => readCookieValue() ?? '');
  const [users, setUsers] = useState<AuditUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users');
      const payload = (await res.json().catch(() => null)) as {
        ok?: boolean;
        users?: Array<{ id: number; userName: string | null }>;
        error?: string;
      } | null;

      if (!res.ok || !payload?.ok || !Array.isArray(payload.users)) {
        throw new Error(payload?.error ?? `Failed to load users (status ${res.status})`);
      }

      const mapped = payload.users
        .map((user) => ({
          id: String(user.id),
          label: user.userName || '',
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

  const selectedUser = useMemo(
    () => users.find((user) => user.id === userId) ?? null,
    [userId, users],
  );

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
