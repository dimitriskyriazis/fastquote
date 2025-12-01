'use client';

import { useEffect, useState } from 'react';
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
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setSelection(userId || '');
  }, [userId]);

  useEffect(() => {
    const needsUser = (!userId || !selectedUser) && !loading;
    setOpen(needsUser);
  }, [loading, selectedUser, userId]);

  const handleSave = () => {
    setLocalError(null);
    if (!selection) {
      setLocalError('Select a user to continue.');
      return;
    }
    const exists = users.some((user) => user.id === selection);
    if (!exists || !saveUserId(selection)) {
      setLocalError('Pick a valid user from the list.');
      return;
    }
    setOpen(false);
  };

  if (!open) return null;

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
            value={selection}
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
