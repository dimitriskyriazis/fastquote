'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { showToastMessage } from '../../lib/toast';
import { useUndoStack } from '../hooks/useUndoStack';
import { pushCellEditUndo } from '../../lib/undoHelpers';
import { useAutoSaveTimer } from '../hooks/useAutoSaveTimer';
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
  id: string;
  label: string;
  editable: boolean;
  updateField?: string;
  type?: 'text' | 'select';
};

const READONLY_FIELDS: FieldDef[] = [
  { id: 'userName', label: 'User Name', editable: false },
  { id: 'nameCode', label: 'Name Code', editable: false },
  { id: 'email', label: 'Email', editable: false },
  { id: 'salesDivision', label: 'Sales Division', editable: false },
  { id: 'salesSeniority', label: 'Sales Seniority', editable: false },
  { id: 'roles', label: 'Roles', editable: false },
];

const EDITABLE_FIELDS: FieldDef[] = [
  { id: 'fullName', label: 'Full Name', editable: true, updateField: 'FullName' },
  { id: 'fullNameGR', label: 'Full Name GR', editable: true, updateField: 'FullNameGR' },
  { id: 'signTitle', label: 'Sign Title', editable: true, updateField: 'SignTitle' },
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
    if (!def.updateField) return;
    const oldValue = savedValuesRef.current[def.id] ?? '';
    setPendingFields((prev) => ({ ...prev, [def.id]: true }));
    try {
      const res = await fetch('/api/user-info', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [{ field: def.updateField, value: rawValue }] }),
      });
      const payload = await res.json();
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to update ${def.label}`);
      }
      savedValuesRef.current = { ...savedValuesRef.current, [def.id]: rawValue };
      const capturedOldValue = oldValue;
      pushCellEditUndo(pushUndo, performUndo, def.label, async () => {
        const undoRes = await fetch('/api/user-info', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ field: def.updateField, value: capturedOldValue }] }),
        });
        const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
        if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
        setValues((prev) => ({ ...prev, [def.id]: capturedOldValue }));
        savedValuesRef.current = { ...savedValuesRef.current, [def.id]: capturedOldValue };
      });
    } catch (err) {
      setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] }));
      showToastMessage(
        err instanceof Error ? err.message : `Unable to update ${def.label}`,
        'error',
      );
    } finally {
      setPendingFields((prev) => ({ ...prev, [def.id]: false }));
    }
  }, [pushUndo, performUndo]);

  const { scheduleAutoSave, cancelAutoSave } = useAutoSaveTimer({
    values,
    savedValuesRef,
    fieldDefinitions: EDITABLE_FIELDS,
    saveField,
  });

  const handleBlur = useCallback(
    (def: FieldDef) => {
      if (!def.editable || !def.updateField) return;
      cancelAutoSave(def.id);
      const current = values[def.id] ?? '';
      if (current === savedValuesRef.current[def.id]) return;
      void saveField(def, current);
    },
    [saveField, cancelAutoSave, values],
  );

  const handleChange = useCallback(
    (def: FieldDef, newValue: string) => {
      setValues((prev) => ({ ...prev, [def.id]: newValue }));
      if (def.type === 'select') {
        const current = savedValuesRef.current[def.id] ?? '';
        if (newValue !== current) {
          void saveField(def, newValue);
        }
        return;
      }
      if (newValue !== (savedValuesRef.current[def.id] ?? '')) {
        scheduleAutoSave(def.id);
      } else {
        cancelAutoSave(def.id);
      }
    },
    [saveField, scheduleAutoSave, cancelAutoSave],
  );

  const getReadonlyValue = (def: FieldDef): string => {
    if (!userData) return '';
    if (def.id === 'roles') return userData.roles.join(', ');
    if (def.id === 'userName') return userData.userName;
    if (def.id === 'nameCode') return userData.nameCode;
    if (def.id === 'email') return userData.email;
    if (def.id === 'salesDivision') return userData.salesDivision;
    if (def.id === 'salesSeniority') return userData.salesSeniority;
    return '';
  };

  const renderReadonlyField = (def: FieldDef) => (
    <div key={def.id} className={styles.fieldBlock}>
      <label className={styles.fieldLabel}>{def.label}</label>
      <div className={styles.fieldReadonly}>
        {getReadonlyValue(def) || '\u2014'}
      </div>
    </div>
  );

  const renderEditableField = (def: FieldDef) => {
    const isPending = pendingFields[def.id];
    const controlClass = `${styles.fieldControl}${isPending ? ` ${styles.fieldControlPending}` : ''}`;

    if (def.type === 'select') {
      return (
        <div key={def.id} className={styles.fieldBlock}>
          <label className={styles.fieldLabel}>{def.label}</label>
          <select
            className={controlClass}
            value={values[def.id] ?? ''}
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
      <div key={def.id} className={styles.fieldBlock}>
        <label className={styles.fieldLabel}>{def.label}</label>
        <input
          type="text"
          className={controlClass}
          value={values[def.id] ?? ''}
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
