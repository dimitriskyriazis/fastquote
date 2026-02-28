'use client';

import React, { useCallback, useEffect, useState } from 'react';
import LookupModal from './LookupModal';
import lookupStyles from './LookupModal.module.css';
import { showToastMessage } from '../../lib/toast';
import { useDuplicateCheck } from '../lib/useDuplicateCheck';
import DuplicateWarning from './DuplicateWarning';

const SUPPLIER_CREATE_ENDPOINT = '/api/suppliers/create';

type CreateSupplierResponse = {
  ok?: boolean;
  error?: string;
  supplier?: { id?: number | null; name?: string | null } | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated?: (supplier: { id: number; name: string }) => void;
  countries: Array<{ id: number; name: string }>;
  overlayClassName?: string;
};

export default function AddSupplierModal({ open, onClose, onCreated, countries, overlayClassName }: Props) {
  const [name, setName] = useState('');
  const [taxId, setTaxId] = useState('');
  const [address, setAddress] = useState('');
  const [city, setCity] = useState('');
  const [countryId, setCountryId] = useState<number | null>(null);
  const [postalCode, setPostalCode] = useState('');
  const [phone, setPhone] = useState('');
  const [webSite, setWebSite] = useState('');
  const [comments, setComments] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { warnings: duplicateWarnings, check: checkDuplicates, clear: clearDuplicates } = useDuplicateCheck('supplier');

  const resetForm = useCallback(() => {
    setName('');
    setTaxId('');
    setAddress('');
    setCity('');
    setCountryId(null);
    setPostalCode('');
    setPhone('');
    setWebSite('');
    setComments('');
    setEnabled(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
      clearDuplicates();
    }
  }, [open, resetForm, clearDuplicates]);

  useEffect(() => {
    if (open) checkDuplicates({ name, taxId });
  }, [name, taxId, checkDuplicates, open]);

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: trimmedName,
        taxId: taxId.trim() || null,
        address: address.trim() || null,
        city: city.trim() || null,
        countryId: countryId ?? null,
        postalCode: postalCode.trim() || null,
        phone: phone.trim() || null,
        webSite: webSite.trim() || null,
        comments: comments.trim() || null,
        enabled,
      };

      const response = await fetch(SUPPLIER_CREATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = (await response.json().catch(() => null)) as CreateSupplierResponse | null;
      if (!response.ok || !result?.ok || !result.supplier?.id) {
        const message = result?.error ?? null;
        throw new Error(message ?? 'Unable to create supplier.');
      }

      const supplierName = result.supplier.name?.trim() || trimmedName;
      showToastMessage('Supplier added', 'success');
      onCreated?.({ id: result.supplier.id, name: supplierName });
      onClose();
      resetForm();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to create supplier.';
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [name, taxId, address, city, countryId, postalCode, phone, webSite, comments, enabled, onClose, onCreated, resetForm]);

  return (
    <LookupModal
      open={open}
      title="Add Supplier"
      onClose={onClose}
      onConfirm={handleCreate}
      confirmLabel="Create"
      saving={saving}
      error={error}
      overlayClassName={overlayClassName}
    >
      <div className={lookupStyles.fieldGrid}>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-name">
            Name <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <input
            id="supplier-name"
            className={lookupStyles.fieldControl}
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <DuplicateWarning warnings={duplicateWarnings} />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-tax-id">
            Tax ID
          </label>
          <input
            id="supplier-tax-id"
            className={lookupStyles.fieldControl}
            value={taxId}
            onChange={(event) => setTaxId(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-address">
            Address
          </label>
          <input
            id="supplier-address"
            className={lookupStyles.fieldControl}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-city">
            City
          </label>
          <input
            id="supplier-city"
            className={lookupStyles.fieldControl}
            value={city}
            onChange={(event) => setCity(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-country">
            Country
          </label>
          <select
            id="supplier-country"
            className={lookupStyles.fieldControl}
            value={countryId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              setCountryId(value ? Number.parseInt(value, 10) : null);
            }}
          >
            <option value="">Select country...</option>
            {countries.map((country) => (
              <option key={country.id} value={country.id}>
                {country.name}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-postal-code">
            Postal Code
          </label>
          <input
            id="supplier-postal-code"
            className={lookupStyles.fieldControl}
            value={postalCode}
            onChange={(event) => setPostalCode(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-phone">
            Phone
          </label>
          <input
            id="supplier-phone"
            className={lookupStyles.fieldControl}
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-website">
            Website
          </label>
          <input
            id="supplier-website"
            className={lookupStyles.fieldControl}
            type="url"
            value={webSite}
            onChange={(event) => setWebSite(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-comments">
            Comments
          </label>
          <textarea
            id="supplier-comments"
            className={lookupStyles.fieldControl}
            rows={3}
            value={comments}
            onChange={(event) => setComments(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="supplier-enabled">
            Enabled
          </label>
          <label className={lookupStyles.checkboxLabel} htmlFor="supplier-enabled">
            <input
              id="supplier-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            Yes
          </label>
        </div>
      </div>
    </LookupModal>
  );
}
