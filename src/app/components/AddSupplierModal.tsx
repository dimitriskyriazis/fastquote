'use client';

import React, { useCallback, useEffect, useState } from 'react';
import LookupModal from './LookupModal';
import lookupStyles from './LookupModal.module.css';
import { showToastMessage } from '../../lib/toast';

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
  cities: Array<{ id: number; name: string }>;
  countries: Array<{ id: number; name: string }>;
  overlayClassName?: string;
};

export default function AddSupplierModal({ open, onClose, onCreated, cities, countries, overlayClassName }: Props) {
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [cityId, setCityId] = useState<number | null>(null);
  const [countryId, setCountryId] = useState<number | null>(null);
  const [postalCode, setPostalCode] = useState('');
  const [phone, setPhone] = useState('');
  const [webSite, setWebSite] = useState('');
  const [comments, setComments] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setName('');
    setAddress('');
    setCityId(null);
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
    }
  }, [open, resetForm]);

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
        address: address.trim() || null,
        cityId: cityId ?? null,
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
  }, [name, address, cityId, countryId, postalCode, phone, webSite, comments, enabled, onClose, onCreated, resetForm]);

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
          <select
            id="supplier-city"
            className={lookupStyles.fieldControl}
            value={cityId ?? ''}
            onChange={(event) => {
              const value = event.target.value;
              setCityId(value ? Number.parseInt(value, 10) : null);
            }}
          >
            <option value="">Select city...</option>
            {cities.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
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
