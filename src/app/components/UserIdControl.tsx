'use client';

import { useAuditUser } from './AuditUserProvider';

type Props = {
  collapsed: boolean;
};

export default function UserIdControl({ collapsed }: Props) {
  const {
    selectedUser,
    loading,
    error,
  } = useAuditUser();

  if (collapsed) {
    return null;
  }

  return (
    <div className="side-nav__user">
      <div className="side-nav__user-form">
        <p className="side-nav__user-display" aria-live="polite">
          {selectedUser ? selectedUser.label : loading ? 'Loading…' : 'No user selected'}
        </p>
      </div>
      {error && (
        <p className="side-nav__user-message">
          {error}
        </p>
      )}
    </div>
  );
}
