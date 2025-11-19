'use client';

import { useEffect, useMemo, useState } from 'react';

const COOKIE_NAME = 'telquote-user-id';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // one year

const readCookieValue = (): string | null => {
  if (typeof document === 'undefined') return null;
  const parts = document.cookie.split(';').map((segment) => segment.trim());
  for (const segment of parts) {
    if (!segment) continue;
    if (segment.startsWith(`${COOKIE_NAME}=`)) {
      return decodeURIComponent(segment.slice(COOKIE_NAME.length + 1));
    }
  }
  return null;
};

const writeCookieValue = (value: string) => {
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}`;
};

type Props = {
  collapsed: boolean;
};

type UserOption = {
  id: number;
  label: string;
};

const normalizeInput = (value: string): string => {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return '';
  return String(parsed);
};

export default function UserIdControl({ collapsed }: Props) {
  const [inputValue, setInputValue] = useState('');
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const [users, setUsers] = useState<UserOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  useEffect(() => {
    const existing = readCookieValue();
    if (existing) {
      const normalized = normalizeInput(existing);
      if (normalized) {
        setInputValue(normalized);
      }
    }
  }, []);

  useEffect(() => {
    if (collapsed) return;
    let cancelled = false;
    const controller = new AbortController();
    const loadUsers = async () => {
      setLoading(true);
      setFetchError(null);
      try {
        const res = await fetch('/api/users', { signal: controller.signal });
        const payload = (await res.json()) as { ok?: boolean; users?: Array<{ id: number; fullName: string; email: string | null }>; error?: string };
        if (cancelled) return;
        if (!res.ok || !payload?.ok || !Array.isArray(payload.users)) {
          throw new Error(payload?.error ?? `Failed to load users (status ${res.status})`);
        }
        const mapped = payload.users.map((user) => ({
          id: user.id,
          label: user.fullName || `User #${user.id}`,
        }));
        setUsers(mapped);
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to fetch users', err);
        setFetchError(err instanceof Error ? err.message : 'Unable to load users');
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };
    loadUsers();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [collapsed]);

  const selectedLabel = useMemo(() => {
    if (!inputValue) return '';
    const selected = users.find((user) => String(user.id) === inputValue);
    return selected?.label ?? '';
  }, [inputValue, users]);

  if (collapsed) {
    return null;
  }

  const handleSave = () => {
    const normalized = normalizeInput(inputValue);
    if (!normalized) {
      setStatus('error');
      return;
    }
    writeCookieValue(normalized);
    setInputValue(normalized);
    setStatus('saved');
  };

  return (
    <div className="side-nav__user">
      <div className="side-nav__user-header">
        <span>Audit User</span>
        <small>Used for Created / Modified By</small>
      </div>
      <div className="side-nav__user-select">
        <label htmlFor="side-nav-user-select">Choose account</label>
        <select
          id="side-nav-user-select"
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
            setStatus('idle');
          }}
          disabled={loading || users.length === 0}
        >
          <option value="">{loading ? 'Loading…' : 'Select your user'}</option>
          {users.map((user) => (
            <option key={user.id} value={user.id}>
              {user.label}
            </option>
          ))}
        </select>
      </div>
      <div className="side-nav__user-form">
        {!selectedLabel && (
          <p className="side-nav__user-display" aria-live="polite">
            No user selected
          </p>
        )}
        <button type="button" onClick={handleSave} disabled={!inputValue}>
          Save
        </button>
      </div>
      {fetchError && (
        <p className="side-nav__user-message">
          {fetchError}
        </p>
      )}
      {status === 'error' && (
        <p className="side-nav__user-message">Select a valid Telquote user.</p>
      )}
      {status === 'saved' && (
        <p className="side-nav__user-message side-nav__user-message--success">
          User saved
        </p>
      )}
    </div>
  );
}
