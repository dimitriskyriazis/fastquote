'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './ProductDetailsPanel.module.css';
import type {
  ProductDetailsRecord,
  ProductLookupItem,
  ProductSubCategoryItem,
} from './ProductDetailsTypes';
import { showToastMessage } from '../../../lib/toast';
import { useUndoStack } from '../../hooks/useUndoStack';
import { useAutoSaveTimer } from '../../hooks/useAutoSaveTimer';
import { pushCellEditUndo } from '../../../lib/undoHelpers';
import { formatDisplayValue } from '../../lib/formatDisplayValue';

type Props = {
  productId: string;
  record: ProductDetailsRecord;
  brands: ProductLookupItem[];
  categories: ProductLookupItem[];
  subCategories: ProductSubCategoryItem[];
  types: ProductLookupItem[];
};

type SectionKey = 'identification' | 'description' | 'classification' | 'status';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  recordKey: keyof ProductDetailsRecord;
  apiField?: string;
  span?: number;
  multiline?: boolean;
  inputType?: string;
  readOnly?: boolean;
  isSelect?: boolean;
  noBlankOption?: boolean;
};

const SECTION_METADATA: Record<SectionKey, { title: string }> = {
  identification: { title: 'Identification' },
  description: { title: 'Description' },
  classification: { title: 'Classification' },
  status: { title: 'Status' },
};

const SECTION_ORDER: SectionKey[] = ['identification', 'description', 'classification', 'status'];

const BASE_FIELD_DEFINITIONS: FieldDefinition[] = [
  { id: 'partNumber', label: 'Part Number', section: 'identification', recordKey: 'PartNumber', apiField: 'partNumber' },
  { id: 'modelNumber', label: 'Model Number', section: 'identification', recordKey: 'ModelNumber', apiField: 'modelNumber' },
  { id: 'legacyPartNo', label: 'Legacy Part No', section: 'identification', recordKey: 'LegacyPartNo', readOnly: true },
  { id: 'erpCode', label: 'ERP Code', section: 'identification', recordKey: 'ERPCode', apiField: 'erpCode' },
  { id: 'description', label: 'Description', section: 'description', recordKey: 'Description', apiField: 'description', multiline: true, span: -1 },
  { id: 'webLink', label: 'Web Link', section: 'description', recordKey: 'WebLink', apiField: 'webLink', inputType: 'url' },
  { id: 'origin', label: 'Origin', section: 'description', recordKey: 'Origin', apiField: 'origin' },
  { id: 'brand', label: 'Brand', section: 'classification', recordKey: 'BrandID', apiField: 'brandId', isSelect: true },
  { id: 'category', label: 'Category', section: 'classification', recordKey: 'CategoryID', apiField: 'categoryId', isSelect: true },
  { id: 'subCategory', label: 'Sub-Category', section: 'classification', recordKey: 'SubCategoryID', apiField: 'subCategoryId', isSelect: true },
  { id: 'type', label: 'Type', section: 'classification', recordKey: 'TypeID', apiField: 'typeId', isSelect: true },
  { id: 'enabled', label: 'Enabled', section: 'status', recordKey: 'Enabled', apiField: 'enabled', isSelect: true },
  { id: 'isService', label: 'Is Service', section: 'status', recordKey: 'IsService', readOnly: true },
  { id: 'serviceType', label: 'Service Type', section: 'status', recordKey: 'ServiceType', apiField: 'serviceType', isSelect: true, noBlankOption: true },
];

const BOOLEAN_OPTIONS: Array<{ id: number | string; name: string }> = [
  { id: 1, name: 'Yes' },
  { id: 0, name: 'No' },
];

const SERVICE_TYPE_OPTIONS: Array<{ id: number | string; name: string }> = [
  { id: 'ServPerUnit', name: 'ServPerUnit' },
  { id: 'ServLot', name: 'ServLot' },
];

const formatInitialValue = (record: ProductDetailsRecord, def: FieldDefinition): string => {
  const raw = record[def.recordKey];
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'boolean') return raw ? '1' : '0';
  if (typeof raw === 'number') return String(raw);
  return String(raw);
};

export default function ProductDetailsClient({
  productId,
  record,
  brands,
  categories,
  subCategories,
  types,
}: Props) {
  const editableFields = useMemo(
    () => BASE_FIELD_DEFINITIONS.filter((def) => !def.readOnly),
    [],
  );

  const initialValues = useMemo(() => {
    const map: Record<string, string> = {};
    BASE_FIELD_DEFINITIONS.forEach((def) => {
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
      if (!def.apiField) return false;

      // Compute API payload value
      const booleanFieldIds = ['enabled', 'isService'];
      let payloadValue: string | number | boolean | null;
      if (booleanFieldIds.includes(def.id)) {
        payloadValue = rawValue === '1' ? true : rawValue === '0' ? false : null;
      } else if (['brand', 'category', 'subCategory', 'type'].includes(def.id)) {
        payloadValue = rawValue === '' ? null : Number(rawValue);
      } else {
        payloadValue = rawValue === '' ? null : rawValue;
      }

      const oldDisplayValue = savedValuesRef.current[def.id] ?? '';
      let oldPayloadValue: string | number | boolean | null;
      if (booleanFieldIds.includes(def.id)) {
        oldPayloadValue = oldDisplayValue === '1' ? true : oldDisplayValue === '0' ? false : null;
      } else if (['brand', 'category', 'subCategory', 'type'].includes(def.id)) {
        oldPayloadValue = oldDisplayValue === '' ? null : Number(oldDisplayValue);
      } else {
        oldPayloadValue = oldDisplayValue === '' ? null : oldDisplayValue;
      }

      setPendingFields((prev) => ({ ...prev, [def.id]: true }));

      try {
        const response = await fetch(`/api/products/${encodeURIComponent(productId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [def.apiField]: payloadValue }),
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
          const undoRes = await fetch(`/api/products/${encodeURIComponent(productId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ [def.apiField!]: capturedOldPayload }),
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
    [productId, pushUndo, performUndo],
  );

  const handleBlur = useCallback(
    (def: FieldDefinition) => {
      cancelAutoSaveRef.current(def.id);
      if (!def.apiField) return;
      const latestValue = valuesRef.current[def.id] ?? '';
      if (latestValue === savedValuesRef.current[def.id]) return;
      void saveField(def, latestValue);
    },
    [saveField],
  );

  const { scheduleAutoSave, cancelAutoSave } = useAutoSaveTimer({
    values,
    savedValuesRef,
    fieldDefinitions: editableFields,
    saveField,
  });
  scheduleAutoSaveRef.current = scheduleAutoSave;
  cancelAutoSaveRef.current = cancelAutoSave;

  // Filtered subcategories based on selected category
  const selectedCategoryId = values['category'] ? Number(values['category']) : null;
  const filteredSubCategories = useMemo(
    () =>
      selectedCategoryId != null
        ? subCategories.filter((sc) => sc.categoryId === selectedCategoryId)
        : subCategories,
    [selectedCategoryId, subCategories],
  );

  const getSelectOptions = (def: FieldDefinition): Array<{ id: number | string; name: string }> => {
    if (def.id === 'brand') return brands;
    if (def.id === 'category') return categories;
    if (def.id === 'subCategory') return filteredSubCategories;
    if (def.id === 'type') return types;
    if (def.id === 'enabled') return BOOLEAN_OPTIONS;
    if (def.id === 'isService') return BOOLEAN_OPTIONS;
    if (def.id === 'serviceType') return SERVICE_TYPE_OPTIONS;
    return [];
  };

  const renderFieldControl = (def: FieldDefinition) => {
    if (def.readOnly) {
      const raw = record[def.recordKey];
      return (
        <div className={styles.fieldReadonly}>
          {formatDisplayValue(raw as string | number | boolean | null | undefined)}
        </div>
      );
    }

    const pending = pendingFields[def.id];
    const value = values[def.id] ?? '';

    if (def.isSelect) {
      const options = getSelectOptions(def);
      return (
        <select
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          value={value}
          onChange={(e) => {
            handleValueChange(def.id, e.target.value);
            // For select, save immediately on change
            const nextDef = def;
            const nextVal = e.target.value;
            cancelAutoSaveRef.current(def.id);
            void saveField(nextDef, nextVal);
          }}
        >
          {!def.noBlankOption && <option value="">Select...</option>}
          {options.map((opt) => (
            <option key={opt.id} value={String(opt.id)}>
              {opt.name}
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
          placeholder="—"
          onChange={(e) => handleValueChange(def.id, e.target.value)}
          onBlur={() => handleBlur(def)}
        />
      );
    }

    return (
      <input
        autoComplete="off"
        className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
        type={def.inputType ?? 'text'}
        value={value}
        placeholder="—"
        onChange={(e) => handleValueChange(def.id, e.target.value)}
        onBlur={() => handleBlur(def)}
      />
    );
  };

  const renderSection = (sectionKey: SectionKey) => {
    const metadata = SECTION_METADATA[sectionKey];
    const sectionFields = BASE_FIELD_DEFINITIONS.filter((f) => f.section === sectionKey);
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
        {renderSection('identification')}
        <div className={styles.sectionsGrid}>
          {SECTION_ORDER.filter((s) => s !== 'identification').map((s) => renderSection(s))}
        </div>
      </div>
    </>
  );
}
