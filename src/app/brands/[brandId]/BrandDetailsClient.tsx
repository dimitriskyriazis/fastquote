'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './BrandDetailsPanel.module.css';
import type { BrandDetailsRecord } from './BrandDetailsTypes';
import { showToastMessage } from '../../../lib/toast';
import { useUndoStack } from '../../hooks/useUndoStack';
import { useAutoSaveTimer } from '../../hooks/useAutoSaveTimer';
import { pushCellEditUndo } from '../../../lib/undoHelpers';
import { useAuditUser } from '../../components/AuditUserProvider';

type Props = {
  brandId: string;
  record: BrandDetailsRecord;
};

type SectionKey = 'general' | 'advanced';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  recordKey: keyof BrandDetailsRecord;
  apiField: string;
  span?: number;
  multiline?: boolean;
  isSelect?: boolean;
  isInt?: boolean;
  adminOnly?: boolean;
};

const SECTION_METADATA: Record<SectionKey, { title: string }> = {
  general: { title: 'General' },
  advanced: { title: 'Advanced (Admin/Developer)' },
};

const ALL_FIELD_DEFINITIONS: FieldDefinition[] = [
  { id: 'name', label: 'Name', section: 'general', recordKey: 'Name', apiField: 'Name' },
  { id: 'comment', label: 'Comment', section: 'general', recordKey: 'Comment', apiField: 'Comment', multiline: true, span: -1 },
  { id: 'softOneId', label: 'ERP ID', section: 'general', recordKey: 'SoftOneID', apiField: 'SoftOneID', isInt: true },
  { id: 'softOneCode', label: 'ERP Code', section: 'general', recordKey: 'SoftOneCode', apiField: 'SoftOneCode' },
  { id: 'avc4Name', label: 'AVC4 Name', section: 'general', recordKey: 'AVC4Name', apiField: 'AVC4Name' },
  { id: 'epLincName', label: 'EP LINC Name', section: 'general', recordKey: 'EPLINCName', apiField: 'EPLINCName' },
  { id: 'enabled', label: 'Enabled', section: 'general', recordKey: 'Enabled', apiField: 'Enabled', isSelect: true },
  { id: 'partNumberSuffix', label: 'Part Number Suffix', section: 'advanced', recordKey: 'PartNumberSuffix', apiField: 'PartNumberSuffix', adminOnly: true },
  { id: 'partNumberPattern1', label: 'Part Number Pattern 1', section: 'advanced', recordKey: 'PartNumberPattern1', apiField: 'PartNumberPattern1', adminOnly: true },
  { id: 'partNumberPattern2', label: 'Part Number Pattern 2', section: 'advanced', recordKey: 'PartNumberPattern2', apiField: 'PartNumberPattern2', adminOnly: true },
];

const BOOLEAN_OPTIONS = [
  { value: '1', label: 'Yes' },
  { value: '0', label: 'No' },
];

const formatInitialValue = (record: BrandDetailsRecord, def: FieldDefinition): string => {
  const raw = record[def.recordKey];
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? '1' : '0';
  if (typeof raw === 'number') return String(raw);
  return String(raw);
};

export default function BrandDetailsClient({ brandId, record }: Props) {
  const { roles } = useAuditUser();
  const isAdminOrDev = roles.includes('Administrator') || roles.includes('Developer');

  const fieldDefinitions = useMemo(
    () =>
      isAdminOrDev
        ? ALL_FIELD_DEFINITIONS
        : ALL_FIELD_DEFINITIONS.filter((f) => !f.adminOnly),
    [isAdminOrDev],
  );

  const initialValues = useMemo(() => {
    const map: Record<string, string> = {};
    ALL_FIELD_DEFINITIONS.forEach((def) => {
      map[def.id] = formatInitialValue(record, def);
    });
    return map;
  }, [record]);

  const [values, setValues] = useState(initialValues);
  const [pendingFields, setPendingFields] = useState<Record<string, boolean>>({});
  const [savedValues, setSavedValues] = useState(initialValues);
  const savedValuesRef = useRef(savedValues);
  savedValuesRef.current = savedValues;

  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [undoPortal, setUndoPortal] = useState<Element | null>(null);
  useEffect(() => {
    setUndoPortal(document.getElementById('undo-portal'));
  }, []);

  const valuesRef = useRef(values);
  valuesRef.current = values;

  const scheduleAutoSaveRef = useRef<(fieldId: string) => void>(() => {});
  const cancelAutoSaveRef = useRef<(fieldId: string) => void>(() => {});

  const handleValueChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    scheduleAutoSaveRef.current(fieldId);
  }, []);

  const saveField = useCallback(
    async (def: FieldDefinition, rawValue: string) => {
      let payloadValue: string | number | boolean | null;
      if (def.isSelect) {
        payloadValue = rawValue === '1' ? true : rawValue === '0' ? false : null;
      } else if (def.isInt) {
        payloadValue = rawValue === '' ? null : Number.parseInt(rawValue, 10);
      } else {
        payloadValue = rawValue === '' ? null : rawValue;
      }

      const oldDisplayValue = savedValuesRef.current[def.id] ?? '';
      let oldPayloadValue: string | number | boolean | null;
      if (def.isSelect) {
        oldPayloadValue = oldDisplayValue === '1' ? true : oldDisplayValue === '0' ? false : null;
      } else if (def.isInt) {
        oldPayloadValue = oldDisplayValue === '' ? null : Number.parseInt(oldDisplayValue, 10);
      } else {
        oldPayloadValue = oldDisplayValue === '' ? null : oldDisplayValue;
      }

      const brandIdNum = Number.parseInt(brandId, 10);
      if (!Number.isInteger(brandIdNum) || brandIdNum <= 0) {
        showToastMessage('Invalid brand ID', 'error');
        return false;
      }

      setPendingFields((prev) => ({ ...prev, [def.id]: true }));

      try {
        const response = await fetch('/api/brands', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ BrandID: brandIdNum, field: def.apiField, value: payloadValue }],
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${def.label}`);
        }

        setSavedValues((prev) => {
          const next = { ...prev, [def.id]: rawValue };
          savedValuesRef.current = next;
          return next;
        });

        const capturedOld = oldDisplayValue;
        const capturedOldPayload = oldPayloadValue;
        pushCellEditUndo(pushUndo, performUndo, def.label, async () => {
          const undoRes = await fetch('/api/brands', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              updates: [{ BrandID: brandIdNum, field: def.apiField, value: capturedOldPayload }],
            }),
          });
          const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
          if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
          setValues((prev) => ({ ...prev, [def.id]: capturedOld }));
          setSavedValues((prev) => {
            const next = { ...prev, [def.id]: capturedOld };
            savedValuesRef.current = next;
            return next;
          });
        });

        return true;
      } catch (err) {
        console.error(err);
        setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
        showToastMessage(`Unable to update ${def.label}. Please try again.`, 'error');
        return false;
      } finally {
        setPendingFields((prev) => ({ ...prev, [def.id]: false }));
      }
    },
    [brandId, pushUndo, performUndo],
  );

  const handleBlur = useCallback(
    (def: FieldDefinition) => {
      cancelAutoSaveRef.current(def.id);
      const latestValue = valuesRef.current[def.id] ?? '';
      if (latestValue === savedValuesRef.current[def.id]) return;
      void saveField(def, latestValue);
    },
    [saveField],
  );

  const { scheduleAutoSave, cancelAutoSave } = useAutoSaveTimer({
    values,
    savedValuesRef,
    fieldDefinitions,
    saveField,
  });
  scheduleAutoSaveRef.current = scheduleAutoSave;
  cancelAutoSaveRef.current = cancelAutoSave;

  const renderFieldControl = (def: FieldDefinition) => {
    const pending = pendingFields[def.id];
    const value = values[def.id] ?? '';

    if (def.isSelect) {
      return (
        <select
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          value={value}
          onChange={(e) => {
            const nextVal = e.target.value;
            handleValueChange(def.id, nextVal);
            cancelAutoSaveRef.current(def.id);
            void saveField(def, nextVal);
          }}
        >
          <option value="">Select...</option>
          {BOOLEAN_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      );
    }

    if (def.multiline) {
      return (
        <textarea
          autoComplete="off"
          className={`${styles.fieldControl} ${styles.fieldControlMultiline} ${pending ? styles.fieldControlPending : ''}`}
          value={value}
          placeholder="-"
          onChange={(e) => handleValueChange(def.id, e.target.value)}
          onBlur={() => handleBlur(def)}
        />
      );
    }

    return (
      <input
        autoComplete="off"
        className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
        type="text"
        value={value}
        placeholder="-"
        onChange={(e) => handleValueChange(def.id, e.target.value)}
        onBlur={() => handleBlur(def)}
      />
    );
  };

  const renderSection = (sectionKey: SectionKey) => {
    const metadata = SECTION_METADATA[sectionKey];
    const sectionFields = fieldDefinitions.filter((f) => f.section === sectionKey);
    if (sectionFields.length === 0) return null;

    return (
      <section key={sectionKey} className={`${styles.sectionCard} ${styles.detailSection}`}>
        <div className={styles.sectionHeading}>{metadata.title}</div>
        <div className={styles.sectionFields}>
          {sectionFields.map((field) => {
            const spanClass =
              field.span === -1 ? styles.fieldFull : field.span && field.span > 1 ? styles.fieldWide : '';
            return (
              <div key={field.id} className={`${styles.fieldBlock} ${spanClass}`}>
                <label className={styles.fieldLabel}>{field.label}</label>
                {renderFieldControl(field)}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <>
      {canUndo && undoPortal
        ? createPortal(
            <button type="button" className="page-header-button" onClick={performUndo}>
              ↩ Undo{lastLabel ? `: ${lastLabel}` : ''}
            </button>,
            undoPortal,
          )
        : null}
      <div className={styles.panel}>
        {renderSection('general')}
        {isAdminOrDev ? (
          <div className={styles.sectionsGrid}>{renderSection('advanced')}</div>
        ) : null}
      </div>
    </>
  );
}
