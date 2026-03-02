'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import LookupModal from './LookupModal';
import lookupStyles from './LookupModal.module.css';
import { showToastMessage } from '../../lib/toast';
import { useDuplicateCheck } from '../lib/useDuplicateCheck';
import DuplicateWarning from './DuplicateWarning';
import { matchesCountrySearch } from '../../lib/countryAliases';

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
  const [countryText, setCountryText] = useState('');
  const [showCountryList, setShowCountryList] = useState(false);
  const countryListCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localCountries, setLocalCountries] = useState(countries);
  const countryRefreshInFlightRef = useRef(false);
  const { warnings: duplicateWarnings, check: checkDuplicates, clear: clearDuplicates } = useDuplicateCheck('supplier');

  const resetForm = useCallback(() => {
    setName('');
    setTaxId('');
    setAddress('');
    setCity('');
    setCountryId(null);
    setCountryText('');
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

  const clearCountryListCloseTimer = useCallback(() => {
    if (countryListCloseTimerRef.current) {
      clearTimeout(countryListCloseTimerRef.current);
      countryListCloseTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => { clearCountryListCloseTimer(); },
    [clearCountryListCloseTimer],
  );

  useEffect(() => {
    setLocalCountries(countries);
  }, [countries]);

  const refreshCountries = useCallback(async () => {
    if (countryRefreshInFlightRef.current) return;
    countryRefreshInFlightRef.current = true;
    try {
      const response = await fetch('/api/customers/lookups?keys=countries', { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        lookups?: { countries?: Array<{ value: string; label: string }> };
      } | null;
      if (!response.ok || !payload?.ok || !payload.lookups?.countries) return;
      const fresh = payload.lookups.countries
        .map((opt) => ({ id: Number(opt.value), name: opt.label }))
        .filter((c) => Number.isFinite(c.id) && c.name.length > 0);
      setLocalCountries(fresh);
    } catch (err) {
      console.error('Failed to refresh countries', err);
    } finally {
      countryRefreshInFlightRef.current = false;
    }
  }, []);

  const filteredCountries = useMemo(() => {
    const search = countryText.trim();
    if (!search) return localCountries;
    return localCountries.filter((c) => matchesCountrySearch(c.name, search));
  }, [localCountries, countryText]);

  const handleCountryInputChange = useCallback((text: string) => {
    clearCountryListCloseTimer();
    setCountryText(text);
    setShowCountryList(true);
    const normalized = text.trim().toLowerCase();
    const exactMatch = normalized
      ? localCountries.find((c) => c.name.trim().toLowerCase() === normalized)
      : null;
    setCountryId(exactMatch?.id ?? null);
  }, [clearCountryListCloseTimer, localCountries]);

  const handleCountrySelect = useCallback((country: { id: number; name: string }) => {
    clearCountryListCloseTimer();
    setCountryText(country.name);
    setShowCountryList(false);
    setCountryId(country.id);
  }, [clearCountryListCloseTimer]);

  const handleCountryBlur = useCallback(() => {
    clearCountryListCloseTimer();
    countryListCloseTimerRef.current = setTimeout(() => {
      setShowCountryList(false);
      countryListCloseTimerRef.current = null;
    }, 120);
    const trimmed = countryText.trim();
    if (!trimmed) {
      setCountryText('');
      setCountryId(null);
      return;
    }
    const match = localCountries.find(
      (c) => c.name.trim().toLowerCase() === trimmed.toLowerCase(),
    );
    if (match) {
      setCountryText(match.name);
      setCountryId(match.id);
    } else {
      const selected = localCountries.find((c) => c.id === countryId);
      setCountryText(selected?.name ?? '');
    }
  }, [clearCountryListCloseTimer, localCountries, countryId, countryText]);

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
          <div className={lookupStyles.comboWrapper}>
            <input
              autoComplete="off"
              id="supplier-country"
              className={`${lookupStyles.fieldControl} ${lookupStyles.comboInput}`}
              value={countryText}
              placeholder="Type to filter countries"
              onChange={(event) => handleCountryInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && showCountryList && filteredCountries.length > 0) {
                  event.preventDefault();
                  handleCountrySelect(filteredCountries[0]);
                }
              }}
              onBlur={handleCountryBlur}
              onFocus={(event) => {
                clearCountryListCloseTimer();
                event.target.select();
                setShowCountryList(true);
                refreshCountries();
              }}
            />
            {showCountryList && filteredCountries.length > 0 ? (
              <div className={lookupStyles.comboList}>
                {filteredCountries.map((country) => (
                  <button
                    key={country.id}
                    type="button"
                    className={lookupStyles.comboOption}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => handleCountrySelect(country)}
                  >
                    {country.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
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
