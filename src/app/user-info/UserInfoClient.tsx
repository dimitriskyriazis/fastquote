'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { showToastMessage } from '../../lib/toast';
import { useUndoStack } from '../hooks/useUndoStack';
import { pushCellEditUndo } from '../../lib/undoHelpers';
import styles from './UserInfo.module.css';

type UserData = {
  userName: string;
  fullName: string;
  fullNameGR: string;
  email: string;
  signTitle: string;
  nameCode: string;
  salesSeniority: string;
  salesDivision: string;
  roles: string[];
};

type FieldDef = {
  key: string;
  label: string;
  editable: boolean;
  apiField?: string;
  type?: 'text' | 'select';
};

const READONLY_FIELDS: FieldDef[] = [
  { key: 'userName', label: 'User Name', editable: false },
  { key: 'nameCode', label: 'Name Code', editable: false },
  { key: 'email', label: 'Email', editable: false },
  { key: 'salesDivision', label: 'Sales Division', editable: false },
  { key: 'salesSeniority', label: 'Sales Seniority', editable: false },
  { key: 'roles', label: 'Roles', editable: false },
];

const EDITABLE_FIELDS: FieldDef[] = [
  { key: 'fullName', label: 'Full Name', editable: true, apiField: 'FullName' },
  { key: 'fullNameGR', label: 'Full Name GR', editable: true, apiField: 'FullNameGR' },
  { key: 'signTitle', label: 'Sign Title', editable: true, apiField: 'SignTitle' },
];

export default function UserInfoClient() {
  const [userData, setUserData] = useState<UserData | null>(null);
  const [salesDivisions, setSalesDivisions] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const savedValuesRef = useRef<Record<string, string>>({});
  const [pendingFields, setPendingFields] = useState<Record<string, boolean>>({});
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/user-info');
        const payload = await res.json();
        if (!active) return;
        if (!res.ok || !payload?.ok) {
          setError(payload?.error ?? 'Failed to load user info');
          return;
        }
        const user = payload.user as UserData;
        setUserData(user);
        setSalesDivisions(payload.salesDivisions ?? []);
        const initial: Record<string, string> = {
          fullName: user.fullName,
          fullNameGR: user.fullNameGR,
          signTitle: user.signTitle,
        };
        setValues(initial);
        savedValuesRef.current = initial;
      } catch {
        if (active) setError('Failed to load user info');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const saveField = useCallback(async (def: FieldDef, rawValue: string) => {
    if (!def.apiField) return;
    const oldValue = savedValuesRef.current[def.key] ?? '';
    setPendingFields((prev) => ({ ...prev, [def.key]: true }));
    try {
      const res = await fetch('/api/user-info', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [{ field: def.apiField, value: rawValue }] }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to update ${def.label}`);
      }
      savedValuesRef.current = { ...savedValuesRef.current, [def.key]: rawValue };
      const capturedOldValue = oldValue;
      pushCellEditUndo(pushUndo, performUndo, def.label, async () => {
        const undoRes = await fetch('/api/user-info', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ field: def.apiField, value: capturedOldValue }] }),
        });
        const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
        if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
        setValues((prev) => ({ ...prev, [def.key]: capturedOldValue }));
        savedValuesRef.current = { ...savedValuesRef.current, [def.key]: capturedOldValue };
      });
    } catch (err) {
      setValues((prev) => ({ ...prev, [def.key]: savedValuesRef.current[def.key] }));
      showToastMessage(
        err instanceof Error ? err.message : `Unable to update ${def.label}`,
        'error',
      );
    } finally {
      setPendingFields((prev) => ({ ...prev, [def.key]: false }));
    }
  }, [pushUndo, performUndo]);

  const handleBlur = useCallback(
    (def: FieldDef) => {
      if (!def.editable || !def.apiField) return;
      const current = values[def.key] ?? '';
      if (current === savedValuesRef.current[def.key]) return;
      void saveField(def, current);
    },
    [saveField, values],
  );

  const handleChange = useCallback(
    (def: FieldDef, newValue: string) => {
      setValues((prev) => ({ ...prev, [def.key]: newValue }));
      if (def.type === 'select') {
        const current = savedValuesRef.current[def.key] ?? '';
        if (newValue !== current) {
          void saveField(def, newValue);
        }
      }
    },
    [saveField],
  );

  const getReadonlyValue = (def: FieldDef): string => {
    if (!userData) return '';
    if (def.key === 'roles') return userData.roles.join(', ');
    if (def.key === 'userName') return userData.userName;
    if (def.key === 'nameCode') return userData.nameCode;
    if (def.key === 'email') return userData.email;
    if (def.key === 'salesDivision') return userData.salesDivision;
    if (def.key === 'salesSeniority') return userData.salesSeniority;
    return '';
  };

  const renderReadonlyField = (def: FieldDef) => (
    <div key={def.key} className={styles.fieldBlock}>
      <label className={styles.fieldLabel}>{def.label}</label>
      <div className={styles.fieldReadonly}>
        {getReadonlyValue(def) || '\u2014'}
      </div>
    </div>
  );

  const renderEditableField = (def: FieldDef) => {
    const isPending = pendingFields[def.key];
    const controlClass = `${styles.fieldControl}${isPending ? ` ${styles.fieldControlPending}` : ''}`;

    if (def.type === 'select') {
      return (
        <div key={def.key} className={styles.fieldBlock}>
          <label className={styles.fieldLabel}>{def.label}</label>
          <select
            className={controlClass}
            value={values[def.key] ?? ''}
            onChange={(e) => handleChange(def, e.target.value)}
          >
            <option value="">{'\u2014'}</option>
            {salesDivisions.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>
      );
    }

    return (
      <div key={def.key} className={styles.fieldBlock}>
        <label className={styles.fieldLabel}>{def.label}</label>
        <input
          type="text"
          className={controlClass}
          value={values[def.key] ?? ''}
          onChange={(e) => handleChange(def, e.target.value)}
          onBlur={() => handleBlur(def)}
        />
      </div>
    );
  };

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        {canUndo && (
          <button type="button" className="page-header-button" onClick={performUndo}>
            ↩ Undo{lastLabel ? `: ${lastLabel}` : ''}
          </button>
        )}
        <h1 className={styles.heading}>User Info</h1>
      </div>
      <div className={styles.pageBody}>
        {loading && <div className={styles.loading}>Loading user info...</div>}
        {!loading && (error || !userData) && (
          <div className={styles.error}>{error ?? 'User not found'}</div>
        )}
        {!loading && userData && (
          <div className={styles.panel}>
            <div className={styles.sectionCard}>
              <div className={styles.sectionHeading}>Account</div>
              <div className={styles.sectionFields}>
                {READONLY_FIELDS.map(renderReadonlyField)}
              </div>
            </div>
            <div className={styles.sectionCard}>
              <div className={styles.sectionHeading}>Profile</div>
              <div className={styles.sectionFields}>
                {EDITABLE_FIELDS.map(renderEditableField)}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
