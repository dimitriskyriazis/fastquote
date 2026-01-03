'use client';

import { useState } from 'react';
import { useAuditUser } from './AuditUserProvider';
import styles from './AuditUserPrompt.module.css';

export default function AuditUserPrompt() {
  const {
    userId,
    selectedUser,
    users,
    loading,
    error,
    saveUserId,
  } = useAuditUser();
  const [selection, setSelection] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const selectionValue = selection ?? userId ?? '';
  const needsUser = (!userId || !selectedUser) && !loading;

  const handleSave = () => {
    setLocalError(null);
    if (!selectionValue) {
      setLocalError('Select a user to continue.');
      return;
    }
    const exists = users.some((user) => user.id === selectionValue);
    if (!exists || !saveUserId(selectionValue)) {
      setLocalError('Pick a valid user from the list.');
      return;
    }
    setSelection(null);
  };

  if (!needsUser) return null;

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="audit-user-title"
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <h2 id="audit-user-title">Login</h2>
        </div>
        <label className={styles.field}>
          <span>Choose user</span>
          <select
            value={selectionValue}
            onChange={(event) => {
              setSelection(event.target.value);
              setLocalError(null);
            }}
            disabled={loading || users.length === 0}
          >
            <option value="">{loading ? 'Loading users…' : 'Select your account'}</option>
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {user.label}
              </option>
            ))}
          </select>
        </label>
        {(error || localError) && (
          <p className={styles.error} role="alert">
            {error ?? localError}
          </p>
        )}
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.primary}
            onClick={handleSave}
            disabled={loading || users.length === 0}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
