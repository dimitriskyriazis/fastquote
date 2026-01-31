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
        {selectedUser?.salesSeniorityName && (
          <p className="side-nav__user-role">
            {selectedUser.salesSeniorityName}
          </p>
        )}
        {selectedUser?.roles?.length ? (
          <p className="side-nav__user-role">
            {selectedUser.roles.join(' • ')}
          </p>
        ) : null}
      </div>
      {error && (
        <p className="side-nav__user-message">
          {error}
        </p>
      )}
    </div>
  );
}
