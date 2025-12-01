'use client';

import { useEffect, useState } from 'react';
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

  useEffect(() => {
    setStatus('idle');
  }, [selectedUser]);

  if (collapsed) {
    return null;
  }

  const handleLogout = () => {
    clearUser();
    setStatus('saved');
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
