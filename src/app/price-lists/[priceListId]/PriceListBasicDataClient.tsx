'use client';

import { useMemo, useState, useCallback, useRef } from 'react';
import styles from './PriceListBasicDataPanel.module.css';
import type {
  PriceListBasicRecord,
  PriceListDropdownOption,
  PriceListBasicUpdateField,
  PricingPoliciesByBrand,
} from './PriceListBasicDataTypes';
import { showToastMessage } from '../../../lib/toast';
import UKDatePicker from '../../components/DatePicker';

type Props = {
  priceListId: string;
  record: PriceListBasicRecord;
  brands: PriceListDropdownOption[];
  countries: PriceListDropdownOption[];
  suppliers: PriceListDropdownOption[];
  currencies: PriceListDropdownOption[];
  users: PriceListDropdownOption[];
  pricingPoliciesByBrand: PricingPoliciesByBrand;
};

type SectionKey = 'general' | 'validity' | 'associations' | 'settings';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  recordKey: keyof PriceListBasicRecord;
  updateField?: PriceListBasicUpdateField;
  span?: number;
  multiline?: boolean;
  inputType?: string;
  valueType?: 'string' | 'number' | 'date';
  readOnly?: boolean;
  resolveValue?: (record: PriceListBasicRecord) => string | null | undefined;
  options?: PriceListDropdownOption[];
  datalistOptions?: PriceListDropdownOption[];
};

const SECTION_METADATA: Record<SectionKey, { title: string }> = {
  general: { title: 'General' },
  validity: { title: 'Validity' },
  associations: { title: 'Associations' },
  settings: { title: 'Settings' },
};

const BOOLEAN_OPTIONS: PriceListDropdownOption[] = [
  { value: '1', label: 'Yes' },
  { value: '0', label: 'No' },
];

const buildFieldDefinitions = (
  brands: PriceListDropdownOption[],
  countries: PriceListDropdownOption[],
  suppliers: PriceListDropdownOption[],
  currencies: PriceListDropdownOption[],
  users: PriceListDropdownOption[],
): FieldDefinition[] => [
  {
    id: 'name',
    label: 'Name',
    section: 'general',
    recordKey: 'Name',
    updateField: 'Name',
  },
  {
    id: 'filePath',
    label: 'File Path',
    section: 'general',
    recordKey: 'FilePath',
    updateField: 'FilePath',
  },
  {
    id: 'comments',
    label: 'Comments',
    section: 'general',
    recordKey: 'Comments',
    updateField: 'Comments',
    multiline: true,
    span: 2,
  },
  {
    id: 'supplierComment',
    label: 'Supplier Comment',
    section: 'general',
    recordKey: 'SupplierComment',
    updateField: 'SupplierComment',
    multiline: true,
    span: 2,
  },
  {
    id: 'validFrom',
    label: 'Valid From',
    section: 'validity',
    recordKey: 'ValidFromDate',
    updateField: 'ValidFromDate',
    inputType: 'date',
    valueType: 'date',
  },
  {
    id: 'validTo',
    label: 'Valid To',
    section: 'validity',
    recordKey: 'ValidToDate',
    updateField: 'ValidToDate',
    inputType: 'date',
    valueType: 'date',
  },
  {
    id: 'brand',
    label: 'Brand',
    section: 'associations',
    recordKey: 'BrandID',
    updateField: 'BrandID',
    valueType: 'number',
    options: brands,
  },
  {
    id: 'supplier',
    label: 'Supplier',
    section: 'associations',
    recordKey: 'SupplierID',
    updateField: 'SupplierID',
    valueType: 'number',
    options: suppliers,
  },
  {
    id: 'country',
    label: 'Country',
    section: 'associations',
    recordKey: 'CountryId',
    updateField: 'CountryId',
    valueType: 'number',
    options: countries,
  },
  {
    id: 'currency',
    label: 'Currency',
    section: 'associations',
    recordKey: 'CurrencyId',
    updateField: 'CurrencyId',
    valueType: 'number',
    options: currencies,
  },
  {
    id: 'responsibleUser',
    label: 'Responsible User',
    section: 'associations',
    recordKey: 'ResponsibleUserName',
    updateField: 'ResponsibleUserId',
    datalistOptions: users,
    resolveValue: (rec) => rec.ResponsibleUserName ?? '',
  },
  {
    id: 'enabled',
    label: 'Enabled',
    section: 'settings',
    recordKey: 'Enabled',
    updateField: 'Enabled',
    valueType: 'number',
    options: BOOLEAN_OPTIONS,
  },
  {
    id: 'hasDuty',
    label: 'Has Duty',
    section: 'settings',
    recordKey: 'HasDuty',
    updateField: 'HasDuty',
    valueType: 'number',
    options: BOOLEAN_OPTIONS,
  },
  {
    id: 'pricingPolicyName',
    label: 'Primary Pricing Policy',
    section: 'settings',
    recordKey: 'PricingPolicyName',
    readOnly: true,
  },
];

const formatDisplayValue = (value: unknown) => {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '—';
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
};

const formatDateInputValue = (value: Date | string | null | undefined) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  // Return ISO format (YYYY-MM-DD) for date inputs - required for type="date"
  return date.toISOString().slice(0, 10);
};

const normalizeValueForApi = (value: string, type?: 'string' | 'number' | 'date') => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (type === 'number') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (type === 'date') {
    // For type="date" inputs, value is already in ISO format (YYYY-MM-DD)
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }
  return trimmed;
};

const formatInitialValue = (record: PriceListBasicRecord, def: FieldDefinition) => {
  const raw = typeof def.resolveValue === 'function' ? def.resolveValue(record) : record[def.recordKey];
  if (def.inputType === 'date' || def.valueType === 'date') {
    return formatDateInputValue(raw as Date | string | null | undefined);
  }
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'boolean') return raw ? '1' : '0';
  if (raw instanceof Date) return formatDateInputValue(raw);
  return String(raw);
};

const resolveFieldValue = (record: PriceListBasicRecord, def: FieldDefinition) =>
  (typeof def.resolveValue === 'function' ? def.resolveValue(record) : record[def.recordKey]) ?? null;

export default function PriceListBasicDataClient({
  priceListId,
  record,
  brands,
  countries,
  suppliers,
  currencies,
  users,
  pricingPoliciesByBrand,
}: Props) {
  const fieldDefinitions = useMemo(
    () => buildFieldDefinitions(brands, countries, suppliers, currencies, users),
    [brands, countries, suppliers, currencies, users]
  );

  const editableFields = useMemo(
    () => fieldDefinitions.filter((def) => def.updateField && !def.readOnly),
    [fieldDefinitions]
  );

  const initialValues = useMemo(() => {
    const values: Record<string, string> = {};
    editableFields.forEach((def) => {
      values[def.id] = formatInitialValue(record, def);
    });
    return values;
  }, [editableFields, record]);

  const [values, setValues] = useState(initialValues);
  const [pendingFields, setPendingFields] = useState<Record<string, boolean>>({});
  const [savedValues, setSavedValues] = useState(initialValues);
  const savedValuesRef = useRef(savedValues);
  savedValuesRef.current = savedValues;

  const handleValueChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const saveField = useCallback(
    async (def: FieldDefinition, rawValue: string) => {
      if (!def.updateField) return;
      let payloadValue: string | number | null | undefined;
      let resolvedDisplayValue = rawValue;

      if (def.datalistOptions && def.datalistOptions.length > 0) {
        const trimmed = rawValue.trim().toLowerCase();
        const match = def.datalistOptions.find(
          (option) => option.label.trim().toLowerCase() === trimmed,
        );
        if (!match) {
          showToastMessage(`Please choose a valid ${def.label.toLowerCase()}`, 'error');
          setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
          return;
        }
        resolvedDisplayValue = match.label;
        payloadValue = match.value;
      } else {
        payloadValue = normalizeValueForApi(rawValue, def.valueType);
      }

      setPendingFields((prev) => ({ ...prev, [def.id]: true }));
      try {
        const response = await fetch(`/api/price-lists/${encodeURIComponent(priceListId)}/basicdata`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ field: def.updateField, value: payloadValue }] }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${def.label}`);
        }
        setSavedValues((prev) => {
          const next = { ...prev, [def.id]: resolvedDisplayValue };
          savedValuesRef.current = next;
          return next;
        });
        setValues((prev) => ({ ...prev, [def.id]: resolvedDisplayValue }));
        showToastMessage(`${def.label} updated`, 'success');
      } catch (err) {
        console.error(err);
        setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
        showToastMessage(`Unable to update ${def.label}. Please try again.`, 'error');
      } finally {
        setPendingFields((prev) => ({ ...prev, [def.id]: false }));
      }
    },
    [priceListId],
  );

  const handleBlur = useCallback(
    (def: FieldDefinition) => {
      if (!def.updateField) return;
      const latestValue = values[def.id] ?? '';
      if (latestValue === savedValuesRef.current[def.id]) return;
      void saveField(def, latestValue);
    },
    [saveField, values],
  );

  const renderFieldControl = (def: FieldDefinition) => {
    const isEditable = Boolean(def.updateField && !def.readOnly);
    const controlId = `price-list-field-${def.id}`;

    if (!isEditable) {
      const readonlyValue = resolveFieldValue(record, def);
      return (
        <div className={styles.fieldReadonly} id={controlId}>
          {formatDisplayValue(readonlyValue)}
        </div>
      );
    }

    const pending = pendingFields[def.id];
    const value = values[def.id] ?? '';
    const placeholder = value === '' ? '—' : undefined;

    if (def.options && def.options.length > 0) {
      return (
        <select
          id={controlId}
          name={def.id}
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          value={value}
          onChange={(event) => handleValueChange(def.id, event.target.value)}
          onBlur={() => handleBlur(def)}
        >
          <option value="">Select...</option>
          {def.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }

    if (def.datalistOptions && def.datalistOptions.length > 0) {
      const listId = `price-list-datalist-${def.id}`;
      return (
        <>
          <input
            autoComplete="off"
            id={controlId}
            name={def.id}
            className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
            value={value}
            list={listId}
            placeholder={placeholder}
            onChange={(event) => handleValueChange(def.id, event.target.value)}
            onBlur={() => handleBlur(def)}
          />
          <datalist id={listId}>
            {def.datalistOptions.map((option) => (
              <option key={option.value} value={option.label} />
            ))}
          </datalist>
        </>
      );
    }

    if (def.multiline) {
      return (
        <textarea
          autoComplete="off"
          id={controlId}
          name={def.id}
          className={`${styles.fieldControl} ${styles.fieldControlMultiline} ${pending ? styles.fieldControlPending : ''}`}
          value={value}
          placeholder={placeholder}
          onChange={(event) => handleValueChange(def.id, event.target.value)}
          onBlur={() => handleBlur(def)}
        />
      );
    }

    if (def.inputType === 'date' || def.valueType === 'date') {
      return (
        <UKDatePicker
          value={value}
          onChange={(newValue) => handleValueChange(def.id, newValue)}
          placeholder="DD/MM/YYYY"
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          disabled={pending}
          required
        />
      );
    }

    return (
      <input
        autoComplete="off"
        id={controlId}
        name={def.id}
        className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
        type={def.inputType ?? 'text'}
        value={value}
        placeholder={placeholder}
        onChange={(event) => handleValueChange(def.id, event.target.value)}
        onBlur={() => handleBlur(def)}
      />
    );
  };

  const renderSectionCard = (sectionKey: SectionKey) => {
    const metadata = SECTION_METADATA[sectionKey];
    const sectionFields = fieldDefinitions.filter((field) => field.section === sectionKey);
    if (sectionFields.length === 0 || !metadata) return null;

    const cardContent = (
      <>
        <div className={styles.sectionHeading}>{metadata.title}</div>
        <div className={styles.sectionFields}>
          {sectionFields.map((field) => {
            const spanClass =
              field.span && field.span > 1 ? styles.fieldWide : field.span === -1 ? styles.fieldFull : '';
            return (
              <div key={field.id} className={`${styles.fieldBlock} ${spanClass}`}>
                <label className={styles.fieldLabel} htmlFor={`price-list-field-${field.id}`}>
                  {field.label}
                </label>
                {renderFieldControl(field)}
              </div>
            );
          })}
        </div>
      </>
    );

    const brandField = fieldDefinitions.find((field) => field.id === 'brand');
    const brandValueRaw = values[brandField?.id ?? 'brand'] ?? (record.BrandID != null ? String(record.BrandID) : '');
    const brandValue = brandValueRaw.trim();
    const policies = brandValue ? pricingPoliciesByBrand[brandValue] ?? [] : [];
    const brandLabel =
      brandValue && brandField?.options
        ? brandField.options.find((option) => option.value === brandValue)?.label ?? ''
        : '';

    return (
      <section key={sectionKey} className={`${styles.sectionCard} ${styles.detailSection}`}>
        {cardContent}
        {sectionKey === 'settings' ? (
          <div className={styles.chipListWrapper}>
            <div className={styles.chipListHeading}>Pricing Policies</div>
            {brandValue ? (
              policies.length > 0 ? (
                <div className={styles.chipList}>
                  {policies.map((policy) => (
                    <span key={`${policy.brandId}-${policy.pricingPolicyId}`} className={styles.chip}>
                      {policy.name ?? '—'}
                    </span>
                  ))}
                </div>
              ) : (
                <div className={styles.chipListEmpty}>No pricing policies for {brandLabel || 'this brand'}.</div>
              )
            ) : (
              <div className={styles.chipListEmpty}>Select a brand to view pricing policies.</div>
            )}
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <div className={styles.panel}>
      {renderSectionCard('general')}
      <div className={styles.sectionsGrid}>
        {renderSectionCard('validity')}
        {renderSectionCard('associations')}
        {renderSectionCard('settings')}
      </div>
    </div>
  );
}
