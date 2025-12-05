'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import styles from './OfferBasicDataPanel.module.css';
import type {
  OfferBasicRecord,
  OfferContactInfo,
  OfferBasicUpdateField,
  OfferDropdownOption,
} from './OfferBasicDataTypes';
import { showToastMessage } from '../../../lib/toast';

type Props = {
  offerId: string;
  record: OfferBasicRecord;
  contacts: OfferContactInfo[];
  statuses: OfferDropdownOption[];
  pricingPolicies: OfferDropdownOption[];
  markets: OfferDropdownOption[];
  users: OfferDropdownOption[];
  titles: OfferDropdownOption[];
  calcMethodFormulas: OfferDropdownOption[];
};

type SectionKey = 'general' | 'info' | 'commercial' | 'code' | 'dates';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  recordKey: keyof OfferBasicRecord;
  updateField?: OfferBasicUpdateField;
  span?: number;
  fullWidth?: boolean;
  multiline?: boolean;
  inputType?: string;
  valueType?: 'string' | 'number' | 'date';
  readOnly?: boolean;
  resolveValue?: (record: OfferBasicRecord) => string | null | undefined;
  readOnlyDisplayValue?: (record: OfferBasicRecord) => string | null | undefined;
  options?: OfferDropdownOption[];
  datalistOptions?: OfferDropdownOption[];
};

type ContactFormValues = {
  firstName: string;
  lastName: string;
  titleId: string;
  position: string;
  importance: string;
  enabled: boolean;
  phone: string;
  mobile: string;
  email: string;
  emailStatusId: string;
  secondEmail: string;
  secondEmailStatusId: string;
  notes: string;
};

const EMPTY_CONTACT_FORM: ContactFormValues = {
  firstName: '',
  lastName: '',
  titleId: '',
  position: '',
  importance: '',
  enabled: true,
  phone: '',
  mobile: '',
  email: '',
  emailStatusId: '',
  secondEmail: '',
  secondEmailStatusId: '',
  notes: '',
};

const sortContacts = (list: OfferContactInfo[]) =>
  [...list].sort((a, b) =>
    (a.FullName || '').localeCompare(b.FullName || '', undefined, { sensitivity: 'base' })
  );

const SECTION_METADATA: Record<SectionKey, { title: string; gridClass: string }> = {
  general: { title: 'General', gridClass: styles.generalGrid },
  info: { title: 'Info', gridClass: styles.fieldGrid },
  commercial: { title: 'Commercial', gridClass: styles.fieldGrid },
  code: { title: 'Code Number', gridClass: styles.fieldGrid },
  dates: { title: 'Dates', gridClass: styles.fieldGrid },
};

const buildFieldDefinitions = (
  statuses: OfferDropdownOption[],
  pricingPolicies: OfferDropdownOption[],
  markets: OfferDropdownOption[],
  users: OfferDropdownOption[],
  contacts: OfferDropdownOption[],
  calcMethodFormulas: OfferDropdownOption[],
): FieldDefinition[] => [
  { id: 'title', label: 'Title', section: 'general', recordKey: 'Title', updateField: 'Title' },
  { id: 'description', label: 'Description', section: 'general', recordKey: 'Description', updateField: 'Description' },
  { id: 'paymentTerms', label: 'Payment Terms', section: 'general', recordKey: 'PaymentTerms', updateField: 'PaymentTerms', multiline: true },
  { id: 'install', label: 'Installation Schedule', section: 'general', recordKey: 'InstallationSchedule', updateField: 'InstallationSchedule', multiline: true },
  { id: 'closingNote', label: 'Closing Note', section: 'general', recordKey: 'OfferNotesClosing', updateField: 'OfferNotesClosing', multiline: true },
  { id: 'offerValidity', label: 'Offer Validity', section: 'general', recordKey: 'OfferValidity', updateField: 'OfferValidity' },
  { id: 'deliveryTime', label: 'Delivery Time', section: 'general', recordKey: 'DeliveryTime', updateField: 'DeliveryTime' },
  { id: 'introNote', label: 'Introduction Note', section: 'general', recordKey: 'OfferNotesIntroduction', updateField: 'OfferNotesIntroduction', multiline: true },
  { id: 'customer', label: 'Customer', section: 'general', recordKey: 'CustomerName', readOnly: true },
  {
    id: 'status',
    label: 'Status',
    section: 'general',
    recordKey: 'StatusID',
    updateField: 'StatusID',
    valueType: 'number',
    options: statuses,
  },

  {
    id: 'contactId',
    label: 'Contact',
    section: 'info',
    recordKey: 'ContactID',
    updateField: 'ContactID',
    valueType: 'number',
    options: contacts,
    fullWidth: true,
  },
  { id: 'telmaco', label: 'Telmaco Note', section: 'info', recordKey: 'TelmacoNote', updateField: 'Comments', multiline: true },

  {
    id: 'pricingPolicy',
    label: 'Pricing Policy',
    section: 'commercial',
    recordKey: 'PricingPolicyID',
    updateField: 'PricingPolicyID',
    valueType: 'number',
    options: pricingPolicies,
  },
  {
    id: 'market',
    label: 'Market',
    section: 'commercial',
    recordKey: 'MarketID',
    updateField: 'MarketID',
    valueType: 'number',
    options: markets,
  },
  { id: 'division', label: 'Sales Division', section: 'commercial', recordKey: 'SalesDivisionName', readOnly: true },
  {
    id: 'salesCreation',
    label: 'Sales Creation Person',
    section: 'commercial',
    recordKey: 'SalesCreationPersonId',
    readOnly: true,
    options: users,
    readOnlyDisplayValue: (rec) => rec.SalesCreationPersonName ?? rec.SalesCreationPersonUserName ?? null,
  },
  {
    id: 'salesPersonId',
    label: 'Sales Person',
    section: 'commercial',
    recordKey: 'SalesPersonId',
    updateField: 'SalesPersonId',
    options: users,
    valueType: 'string',
  },
  {
    id: 'approvalUserId',
    label: 'Approval User',
    section: 'commercial',
    recordKey: 'ApprovalUserId',
    updateField: 'ApprovalUserId',
    options: users,
    valueType: 'string',
  },
  {
    id: 'defaultCalc',
    label: 'Default Calc Method Formula',
    section: 'commercial',
    recordKey: 'DefaultCalcMethodFormulasID',
    readOnly: true,
    options: calcMethodFormulas,
    readOnlyDisplayValue: (rec) => rec.DefaultCalcMethodFormulaName ?? null,
  },

  { id: 'projectId', label: 'Project ID', section: 'code', recordKey: 'ProjectID', updateField: 'ProjectID', valueType: 'number' },
  { id: 'offerId', label: 'Offer ID', section: 'code', recordKey: 'OfferID', readOnly: true },
  { id: 'customerRef', label: 'Customer Ref', section: 'code', recordKey: 'CustomerRef', updateField: 'CustomerRef' },

  { id: 'initialRequest', label: 'Initial Request', section: 'dates', recordKey: 'InitialRequest', updateField: 'InitialRequest', inputType: 'date', valueType: 'date' },
  { id: 'officialRequest', label: 'Official Request', section: 'dates', recordKey: 'OfficialRequest', updateField: 'OfficialRequest', inputType: 'date', valueType: 'date' },
  { id: 'draftOffer', label: 'Draft Offer', section: 'dates', recordKey: 'DraftOffer', updateField: 'DraftOffer', inputType: 'date', valueType: 'date' },
  { id: 'officialQuote', label: 'Official Quote Offer', section: 'dates', recordKey: 'OfficialQuoteOffer', updateField: 'OfficialQuoteOffer', inputType: 'date', valueType: 'date' },
  { id: 'offerDate', label: 'Offer Date', section: 'dates', recordKey: 'OfferDate', updateField: 'OfferDate', inputType: 'date', valueType: 'date' },
  { id: 'offerDeadline', label: 'Offer Deadline', section: 'dates', recordKey: 'OfferDeadline', updateField: 'OfferDeadline', inputType: 'date', valueType: 'date' },
  { id: 'orderSigned', label: 'Order Signed', section: 'dates', recordKey: 'OrderSigned', updateField: 'OrderSigned', inputType: 'date', valueType: 'date' },
  { id: 'deliveryDue', label: 'Delivery Due', section: 'dates', recordKey: 'DeliveryDue', updateField: 'DeliveryDue', inputType: 'date', valueType: 'date' },
  { id: 'delivery', label: 'Delivery', section: 'dates', recordKey: 'Delivery', updateField: 'Delivery', inputType: 'date', valueType: 'date' },
];

const formatDisplayValue = (value: unknown) => {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return value.toLocaleDateString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '—';
  }
  return String(value);
};

const formatDateInputValue = (value: Date | string | null | undefined) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
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
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }
  return trimmed;
};

const formatInitialValue = (record: OfferBasicRecord, def: FieldDefinition) => {
  const raw = record[def.recordKey];
  if (def.inputType === 'date' || def.valueType === 'date') {
    return formatDateInputValue(raw as Date | string | null | undefined);
  }
  if (raw == null) return '';
  return typeof raw === 'string' ? raw : String(raw);
};

const resolveFieldValue = (record: OfferBasicRecord, def: FieldDefinition) =>
  (typeof def.resolveValue === 'function' ? def.resolveValue(record) : record[def.recordKey]) ?? null;

export default function OfferBasicDataClient({ offerId, record, contacts, statuses, pricingPolicies, markets, users, titles, calcMethodFormulas }: Props) {
  const [contactList, setContactList] = useState(() => sortContacts(contacts));

  const contactOptions = useMemo(() => {
    const options = contactList.map((contact) => {
      const fallback = `Contact ${contact.ContactID}`;
      const fullName =
        contact.FullName?.trim() ||
        [contact.FirstName, contact.LastName]
          .map((part) => part?.trim())
          .filter(Boolean)
          .join(' ');
      return {
        value: String(contact.ContactID),
        label: fullName || fallback,
      };
    });

    const selectedId = record.ContactID;
    if (
      selectedId != null &&
      !options.some((option) => Number(option.value) === Number(selectedId))
    ) {
      const fallback = `Contact ${selectedId}`;
      const label = (record.ContactFullName ?? '').trim() || fallback;
      options.push({ value: String(selectedId), label });
    }

    return options;
  }, [contactList, record.ContactFullName, record.ContactID]);

  const fieldDefinitions = useMemo(
    () => buildFieldDefinitions(statuses, pricingPolicies, markets, users, contactOptions, calcMethodFormulas),
    [statuses, pricingPolicies, markets, users, contactOptions, calcMethodFormulas]
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
  const [isContactModalOpen, setContactModalOpen] = useState(false);
  const [contactForm, setContactForm] = useState<ContactFormValues>(EMPTY_CONTACT_FORM);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);

  useEffect(() => {
    setContactList(sortContacts(contacts));
  }, [contacts]);

  const handleValueChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const saveField = useCallback(async (def: FieldDefinition, rawValue: string) => {
    if (!def.updateField) return;
    let payloadValue: string | number | null | undefined;
    let resolvedDisplayValue = rawValue;
    if (def.datalistOptions && def.datalistOptions.length > 0) {
      const trimmed = rawValue.trim().toLowerCase();
      const match = def.datalistOptions.find(
        (option) => option.label.trim().toLowerCase() === trimmed
      );
      if (!match) {
        showToastMessage('Please choose a valid user', 'error');
        setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
        return;
      }
      resolvedDisplayValue = match.label;
      payloadValue = normalizeValueForApi(match.value, def.valueType);
    } else {
      payloadValue = normalizeValueForApi(rawValue, def.valueType);
    }
    setPendingFields((prev) => ({ ...prev, [def.id]: true }));
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/basicdata`, {
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
      setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
      console.error(err);
      showToastMessage(`Unable to update ${def.label}. Please try again.`, 'error');
    } finally {
      setPendingFields((prev) => ({ ...prev, [def.id]: false }));
    }
  }, [offerId]);

  const handleBlur = useCallback((def: FieldDefinition) => {
    if (!def.updateField) return;
    const latestValue = values[def.id] ?? '';
    if (latestValue === savedValuesRef.current[def.id]) return;
    void saveField(def, latestValue);
  }, [saveField, values]);

  const resetContactForm = useCallback(() => {
    setContactForm({ ...EMPTY_CONTACT_FORM });
    setContactError(null);
  }, []);

  const handleContactFieldChange = useCallback(
    (field: keyof ContactFormValues, value: string | boolean) => {
      setContactForm((prev) => ({ ...prev, [field]: value } as ContactFormValues));
    },
    [],
  );

  const handleOpenContactModal = useCallback(() => {
    if (!record.CustomerID) {
      showToastMessage('Please set a customer before adding contacts.', 'error');
      return;
    }
    resetContactForm();
    setContactModalOpen(true);
  }, [record.CustomerID, resetContactForm]);

  const handleCloseContactModal = useCallback(() => {
    setContactModalOpen(false);
    setContactSaving(false);
    setContactError(null);
  }, []);

  const normalizeNumberInput = (value: string): number | null => {
    const trimmed = (value ?? '').toString().trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isInteger(parsed) ? parsed : null;
  };

  const handleCreateContact = useCallback(async () => {
    if (!record.CustomerID) {
      showToastMessage('Please set a customer before adding contacts.', 'error');
      return;
    }

    const trimmedFirst = (contactForm.firstName ?? '').trim();
    const trimmedLast = (contactForm.lastName ?? '').trim();
    if (!trimmedFirst && !trimmedLast) {
      setContactError('Please enter at least a first or last name.');
      return;
    }

    const payload = {
      firstName: trimmedFirst,
      lastName: trimmedLast,
      titleId: normalizeNumberInput(contactForm.titleId),
      position: (contactForm.position ?? '').trim(),
      importance: normalizeNumberInput(contactForm.importance),
      enabled: contactForm.enabled,
      phone: (contactForm.phone ?? '').trim(),
      mobile: (contactForm.mobile ?? '').trim(),
      email: (contactForm.email ?? '').trim(),
      emailStatusId: normalizeNumberInput(contactForm.emailStatusId),
      secondEmail: (contactForm.secondEmail ?? '').trim(),
      secondEmailStatusId: normalizeNumberInput(contactForm.secondEmailStatusId),
      notes: (contactForm.notes ?? '').trim(),
    };

    setContactSaving(true);
    setContactError(null);
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/contacts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => null)) as {
        ok?: boolean;
        error?: string;
        contact?: OfferContactInfo;
      } | null;
      if (!response.ok || !result?.ok || !result.contact) {
        throw new Error(result?.error ?? 'Unable to add contact');
      }
      const createdContact = result.contact;
      setContactList((prev) => sortContacts([...prev, createdContact]));
      setContactModalOpen(false);
      resetContactForm();
      showToastMessage('Contact added', 'success');
    } catch (err) {
      console.error(err);
      setContactError(err instanceof Error ? err.message : 'Unable to add contact.');
      showToastMessage('Unable to add contact. Please try again.', 'error');
    } finally {
      setContactSaving(false);
    }
  }, [contactForm, offerId, record.CustomerID, resetContactForm]);

const renderFieldControl = (
  def: FieldDefinition,
  valueMap: Record<string, string>,
  pendingMap: Record<string, boolean>,
  handleValueChange: (fieldId: string, value: string) => void,
  handleBlur: (def: FieldDefinition) => void,
  record: OfferBasicRecord,
) => {
  const isEditable = Boolean(def.updateField && !def.readOnly);
  const controlId = `offer-field-${def.id}`;
  const value = isEditable ? (valueMap[def.id] ?? '') : resolveFieldValue(record, def);
  const readOnlyDisplayValue = typeof def.readOnlyDisplayValue === 'function'
    ? def.readOnlyDisplayValue(record)
    : null;
  const placeholder = !isEditable ? undefined : (value == null || value === '' ? '—' : undefined);
  const pending = pendingMap[def.id];

  if (!isEditable) {
    if (def.options && def.options.length > 0) {
      const readonlyValue = value == null ? '' : String(value);
      const matchingOption = def.options.find((option) => String(option.value) === readonlyValue);
      const displayValue =
        matchingOption?.label ??
        readOnlyDisplayValue ??
        (readonlyValue ? formatDisplayValue(readonlyValue) : '—');
      return (
        <div className={styles.fieldReadonly} id={controlId}>
          {displayValue}
        </div>
      );
    }
    return (
      <div className={styles.fieldReadonly} id={controlId}>
        {formatDisplayValue(value)}
      </div>
    );
  }

  if (isEditable && def.options && def.options.length > 0) {
    return (
      <select
        id={controlId}
        name={def.id}
        className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
        value={valueMap[def.id] ?? ''}
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

  if (isEditable && def.datalistOptions && def.datalistOptions.length > 0) {
    const listId = `datalist-${def.id}`;
    return (
      <>
        <input
          id={controlId}
          name={def.id}
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          value={valueMap[def.id] ?? ''}
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
          id={controlId}
          name={def.id}
          className={`${styles.fieldControl} ${styles.fieldControlMultiline} ${pending ? styles.fieldControlPending : ''}`}
          value={values[def.id] ?? ''}
          placeholder={placeholder}
          onChange={(event) => handleValueChange(def.id, event.target.value)}
          onBlur={() => handleBlur(def)}
        />
      );
    }

    return (
      <input
        id={controlId}
        name={def.id}
        className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
        type={def.inputType ?? 'text'}
        value={values[def.id] ?? ''}
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

    return (
      <section key={sectionKey} className={`${styles.detailSection} ${styles.sectionCard}`}>
        <div className={styles.sectionHeading}>{metadata.title}</div>
        <div className={styles.sectionFields}>
          {sectionFields.map((field) => {
            const spanClass = field.fullWidth
              ? styles.fieldFull
              : field.span && field.span > 1
                ? styles.fieldWide
                : '';
            return (
              <div key={field.id} className={`${styles.fieldBlock} ${spanClass}`}>
                <label className={styles.fieldLabel} htmlFor={`offer-field-${field.id}`}>
                  {field.label}
                </label>
                {field.id === 'contactId' ? (
                  <div className={styles.contactFieldRow}>
                    <div className={styles.contactFieldControl}>
                      {renderFieldControl(field, values, pendingFields, handleValueChange, handleBlur, record)}
                    </div>
                    <button
                      type="button"
                      className={`${styles.addContactButton} page-header-button`}
                      onClick={handleOpenContactModal}
                      disabled={!record.CustomerID}
                      title={!record.CustomerID ? 'Set a customer first' : 'Add a contact'}
                    >
                      Add
                    </button>
                  </div>
                ) : (
                  renderFieldControl(field, values, pendingFields, handleValueChange, handleBlur, record)
                )}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const generalFields = fieldDefinitions.filter((field) => field.section === 'general');
  const generalFieldMap = generalFields.reduce<Record<string, FieldDefinition>>((acc, field) => {
    acc[field.id] = field;
    return acc;
  }, {});

  const generalRowLayout: string[][] = [
    ['title', 'description', 'customer', 'offerValidity', 'status'],
    ['deliveryTime', 'paymentTerms', 'install', 'introNote', 'closingNote'],
  ];

  const generalRows = generalRowLayout
    .map((rowIds) => rowIds.map((id) => generalFieldMap[id]).filter((field): field is FieldDefinition => Boolean(field)))
    .filter((row) => row.length > 0);

  const assignedFieldIds = new Set(generalRowLayout.flat());
  const remainingFields = generalFields.filter((field) => !assignedFieldIds.has(field.id));
  if (remainingFields.length > 0) {
    generalRows.push(remainingFields);
  }

  return (
    <>
      <section className={styles.panel}>
        <div className={`${styles.section} ${styles.sectionCard} ${styles.generalSection}`}>
          <div className={styles.sectionHeading}>{SECTION_METADATA.general.title}</div>
          <div className={styles.generalRows}>
            {generalRows.map((row, rowIdx) => (
              <div key={rowIdx} className={styles.generalRow}>
                {row.map((field) => (
                  <div key={field.id} className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor={`offer-field-${field.id}`}>
                      {field.label}
                    </label>
                    {renderFieldControl(field, values, pendingFields, handleValueChange, handleBlur, record)}
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.sectionsGrid}>
          {(['info', 'commercial', 'code', 'dates'] as SectionKey[]).map((sectionKey) =>
            renderSectionCard(sectionKey)
          )}
        </div>
      </section>

      {isContactModalOpen ? (
        <div
          className={styles.contactModalOverlay}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              handleCloseContactModal();
            }
          }}
        >
          <div className={styles.contactModalCard} role="dialog" aria-modal="true" aria-label="Add contact">
            <div className={styles.contactModalHeader}>
              <div>
                <div className={styles.contactModalTitle}>Add Contact</div>
              </div>
              <button
                type="button"
                className={styles.contactModalClose}
                aria-label="Close add contact form"
                onClick={handleCloseContactModal}
              >
                ×
              </button>
            </div>
            <div className={styles.contactModalBody}>
              <div className={styles.contactModalGrid}>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-first-name">
                    First Name
                  </label>
                  <input
                    id="contact-first-name"
                    className={styles.fieldControl}
                    value={contactForm.firstName}
                    onChange={(event) => handleContactFieldChange('firstName', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-last-name">
                    Last Name
                  </label>
                  <input
                    id="contact-last-name"
                    className={styles.fieldControl}
                    value={contactForm.lastName}
                    onChange={(event) => handleContactFieldChange('lastName', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-title">
                    Title
                  </label>
                  <select
                    id="contact-title"
                    className={styles.fieldControl}
                    value={contactForm.titleId}
                    onChange={(event) => handleContactFieldChange('titleId', event.target.value)}
                  >
                    <option value="">Select title...</option>
                    {titles.map((title) => (
                      <option key={title.value} value={title.value}>
                        {title.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-position">
                    Position
                  </label>
                  <input
                    id="contact-position"
                    className={styles.fieldControl}
                    value={contactForm.position}
                    onChange={(event) => handleContactFieldChange('position', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-importance">
                    Importance
                  </label>
                  <input
                    id="contact-importance"
                    className={styles.fieldControl}
                    type="number"
                    value={contactForm.importance}
                    onChange={(event) => handleContactFieldChange('importance', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-phone">
                    Phone
                  </label>
                  <input
                    id="contact-phone"
                    className={styles.fieldControl}
                    value={contactForm.phone}
                    onChange={(event) => handleContactFieldChange('phone', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-mobile">
                    Mobile
                  </label>
                  <input
                    id="contact-mobile"
                    className={styles.fieldControl}
                    value={contactForm.mobile}
                    onChange={(event) => handleContactFieldChange('mobile', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-email">
                    Email
                  </label>
                  <input
                    id="contact-email"
                    className={styles.fieldControl}
                    type="email"
                    value={contactForm.email}
                    onChange={(event) => handleContactFieldChange('email', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-email-status">
                    Email Status ID
                  </label>
                  <input
                    id="contact-email-status"
                    className={styles.fieldControl}
                    type="number"
                    value={contactForm.emailStatusId}
                    onChange={(event) => handleContactFieldChange('emailStatusId', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-second-email">
                    Second Email
                  </label>
                  <input
                    id="contact-second-email"
                    className={styles.fieldControl}
                    type="email"
                    value={contactForm.secondEmail}
                    onChange={(event) => handleContactFieldChange('secondEmail', event.target.value)}
                  />
                </div>
                <div className={styles.contactModalField}>
                  <label className={styles.fieldLabel} htmlFor="contact-second-email-status">
                    Second Email Status ID
                  </label>
                  <input
                    id="contact-second-email-status"
                    className={styles.fieldControl}
                    type="number"
                    value={contactForm.secondEmailStatusId}
                    onChange={(event) => handleContactFieldChange('secondEmailStatusId', event.target.value)}
                  />
                </div>
                <div className={`${styles.contactModalField} ${styles.contactModalToggle}`}>
                  <label className={styles.fieldLabel} htmlFor="contact-enabled">
                    Enabled
                  </label>
                  <label className={styles.contactToggleControl} htmlFor="contact-enabled">
                    <input
                      id="contact-enabled"
                      type="checkbox"
                      checked={contactForm.enabled}
                      onChange={(event) => handleContactFieldChange('enabled', event.target.checked)}
                    />
                  </label>
                </div>
                <div className={`${styles.contactModalField} ${styles.contactModalFieldFull}`}>
                  <label className={styles.fieldLabel} htmlFor="contact-notes">
                    Notes
                  </label>
                  <textarea
                    id="contact-notes"
                    className={`${styles.fieldControl} ${styles.fieldControlMultiline}`}
                    value={contactForm.notes}
                    onChange={(event) => handleContactFieldChange('notes', event.target.value)}
                  />
                </div>
              </div>
              {contactError ? <div className={styles.contactModalError}>{contactError}</div> : null}
            </div>
            <div className={styles.contactModalFooter}>
              <button
                type="button"
                className={`${styles.contactSaveButton} page-header-button`}
                onClick={handleCreateContact}
                disabled={contactSaving}
              >
                {contactSaving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
