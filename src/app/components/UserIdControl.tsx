'use client';

import { useEffect, useRef, useState } from 'react';
import { useAuditUser } from './AuditUserProvider';

type Props = {
  collapsed: boolean;
};

export default function UserIdControl({ collapsed }: Props) {
  const {
    selectedUser,
    clearUser,
    loading,
    error,
  } = useAuditUser();
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle');
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  if (collapsed) {
    return null;
  }

  const handleLogout = () => {
    clearUser();
    setStatus('saved');
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(() => {
      setStatus('idle');
      timerRef.current = null;
    }, 3000);
  };

  return (
    <div className="side-nav__user">
      <div className="side-nav__user-form">
        <p className="side-nav__user-display" aria-live="polite">
          {selectedUser ? selectedUser.label : loading ? 'Loading…' : 'No user selected'}
        </p>
        <button
          type="button"
          onClick={handleLogout}
          disabled={loading}
        >
          Log out
        </button>
      </div>
      {error && (
        <p className="side-nav__user-message">
          {error}
        </p>
      )}
      {status === 'saved' && (
        <p className="side-nav__user-message side-nav__user-message--success">
          {selectedUser ? 'User updated' : 'User cleared'}
        </p>
      )}
    </div>
  );
}
