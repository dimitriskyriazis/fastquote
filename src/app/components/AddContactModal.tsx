'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import LookupModal from './LookupModal';
import styles from './LookupModal.module.css';
import {
  EMPTY_CONTACT_FORM,
  createContact,
  validateContactForm,
  type ContactFormValues,
} from '../customer-contacts/contactModalHelpers';
import { showToastMessage } from '../../lib/toast';
import type { DropdownOption } from '../../lib/dropdownOptions';

type ContactLookupsResponse = {
  ok?: boolean;
  lookups?: {
    statuses?: string[];
    titles?: DropdownOption[];
    importances?: Array<string | number>;
  };
};

type Props = {
  open: boolean;
  onClose: () => void;
  customerId: string;
  customerName: string | null;
  onCreated: (contactId: number, fullName: string) => void;
};

const TITLE_PRIORITY_ORDER = ['Mr', 'Mrs', 'Κος', 'Κα', 'Dr', 'Δρ'];

const sortTitleOptions = (options: DropdownOption[]): DropdownOption[] => {
  const priorityIndex = new Map<string, number>(
    TITLE_PRIORITY_ORDER.map((label, index) => [label, index]),
  );
  return [...options].sort((a, b) => {
    const aLabel = a.label.trim();
    const bLabel = b.label.trim();
    const aPriority = priorityIndex.get(aLabel);
    const bPriority = priorityIndex.get(bLabel);
    if (aPriority != null && bPriority != null) return aPriority - bPriority;
    if (aPriority != null) return -1;
    if (bPriority != null) return 1;
    return aLabel.localeCompare(bLabel);
  });
};

export default function AddContactModal({
  open,
  onClose,
  customerId,
  customerName,
  onCreated,
}: Props) {
  const [form, setForm] = useState<ContactFormValues>(() => ({
    ...EMPTY_CONTACT_FORM,
    customerId,
  }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [titles, setTitles] = useState<DropdownOption[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [importances, setImportances] = useState<string[]>([]);
  const [lookupsLoaded, setLookupsLoaded] = useState(false);

  useEffect(() => {
    if (lookupsLoaded) return;
    let active = true;
    const load = async () => {
      try {
        const res = await fetch('/api/customer-contacts?mode=lookups', { cache: 'no-store' });
        const payload = (await res.json().catch(() => null)) as ContactLookupsResponse | null;
        if (!active || !res.ok || !payload?.ok || !payload.lookups) return;
        setTitles(sortTitleOptions(Array.isArray(payload.lookups.titles) ? payload.lookups.titles : []));
        setStatuses(Array.isArray(payload.lookups.statuses) ? payload.lookups.statuses : []);
        setImportances(
          Array.isArray(payload.lookups.importances)
            ? payload.lookups.importances
                .map((v) => (typeof v === 'number' ? String(v) : String(v ?? '').trim()))
                .filter((v) => v.length > 0)
            : [],
        );
        setLookupsLoaded(true);
      } catch (err) {
        console.error('Failed to load contact lookups', err);
      }
    };
    void load();
    return () => { active = false; };
  }, [lookupsLoaded]);

  const setField = useCallback(<K extends keyof ContactFormValues>(field: K, value: ContactFormValues[K]) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setError(null);
  }, []);

  const statusOptions = useMemo(() => ['', ...statuses], [statuses]);

  const handleConfirm = useCallback(async () => {
    const payload = { ...form, customerId };
    const validationError = validateContactForm(payload);
    if (validationError) {
      setError(validationError);
      showToastMessage(validationError, 'error');
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createContact(payload);
    if (!result.ok || result.contactId == null) {
      const message = result.error ?? 'Unable to add contact.';
      setError(message);
      showToastMessage(message, 'error');
      setSaving(false);
      return;
    }
    const fullName = `${payload.lastName} ${payload.firstName}`.trim() || `Contact ${result.contactId}`;
    setSaving(false);
    onCreated(result.contactId, fullName);
    onClose();
    showToastMessage('Contact added', 'success');
  }, [form, customerId, onCreated, onClose]);

  return (
    <LookupModal
      open={open}
      title="Add contact"
      onClose={onClose}
      onConfirm={handleConfirm}
      confirmLabel="Add contact"
      saving={saving}
      error={error}
      cardClassName={styles.cardWide}
    >
      <div className={styles.fieldGrid}>
        <div className={styles.fieldFull}>
          <label className={styles.fieldLabel}>Customer</label>
          <div className={styles.fieldControl} style={{ background: '#f8fafc' }}>
            {customerName?.trim() || `Customer ${customerId}`}
          </div>
        </div>
        <div className={styles.fieldFull}>
          <label className={styles.fieldLabel} htmlFor="add-contact-title">
            Title <span className={styles.requiredMark}>*</span>
          </label>
          <select
            id="add-contact-title"
            className={styles.fieldControl}
            value={form.titleId}
            required
            onChange={(event) => setField('titleId', event.target.value)}
          >
            <option value="">Select title...</option>
            {titles.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-last-name">
            Last name <span className={styles.requiredMark}>*</span>
          </label>
          <input
            id="add-contact-last-name"
            className={styles.fieldControl}
            value={form.lastName}
            required
            onChange={(event) => setField('lastName', event.target.value)}
          />
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-first-name">
            First name <span className={styles.requiredMark}>*</span>
          </label>
          <input
            id="add-contact-first-name"
            className={styles.fieldControl}
            value={form.firstName}
            required
            onChange={(event) => setField('firstName', event.target.value)}
          />
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-position">Position</label>
          <input
            id="add-contact-position"
            className={styles.fieldControl}
            value={form.position}
            onChange={(event) => setField('position', event.target.value)}
          />
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-importance">
            Importance <span className={styles.requiredMark}>*</span>
          </label>
          <select
            id="add-contact-importance"
            className={styles.fieldControl}
            value={form.importance}
            required
            onChange={(event) => setField('importance', event.target.value)}
          >
            <option value="">Select importance...</option>
            {importances.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-email">Email</label>
          <input
            id="add-contact-email"
            className={styles.fieldControl}
            value={form.email}
            onChange={(event) => setField('email', event.target.value)}
          />
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-email-status">Email status</label>
          <select
            id="add-contact-email-status"
            className={styles.fieldControl}
            value={form.emailStatus}
            onChange={(event) => setField('emailStatus', event.target.value)}
          >
            {statusOptions.map((option) => (
              <option key={option} value={option}>{option || 'Select status...'}</option>
            ))}
          </select>
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-second-email">Second email</label>
          <input
            id="add-contact-second-email"
            className={styles.fieldControl}
            value={form.secondEmail}
            onChange={(event) => setField('secondEmail', event.target.value)}
          />
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-second-email-status">Second email status</label>
          <select
            id="add-contact-second-email-status"
            className={styles.fieldControl}
            value={form.secondEmailStatus}
            onChange={(event) => setField('secondEmailStatus', event.target.value)}
          >
            {statusOptions.map((option) => (
              <option key={option} value={option}>{option || 'Select status...'}</option>
            ))}
          </select>
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-phone">Phone</label>
          <input
            id="add-contact-phone"
            className={styles.fieldControl}
            value={form.phone}
            onChange={(event) => setField('phone', event.target.value)}
          />
        </div>
        <div className={styles.fieldHalf}>
          <label className={styles.fieldLabel} htmlFor="add-contact-mobile">Mobile</label>
          <input
            id="add-contact-mobile"
            className={styles.fieldControl}
            value={form.mobile}
            onChange={(event) => setField('mobile', event.target.value)}
          />
        </div>
        <div className={styles.fieldFull}>
          <label className={styles.checkboxLabel} htmlFor="add-contact-enabled">
            <input
              id="add-contact-enabled"
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setField('enabled', event.target.checked)}
            />
            Enabled
          </label>
        </div>
      </div>
    </LookupModal>
  );
}
