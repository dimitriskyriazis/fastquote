'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import LookupModal from './LookupModal';
import lookupStyles from './LookupModal.module.css';
import { showToastMessage } from '../../lib/toast';

const BRAND_CREATE_ENDPOINT = '/api/brands';

type CreateBrandResponse = {
  ok?: boolean;
  error?: string;
  brand?: { id?: number | null; name?: string | null } | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated?: (brand: { id: number; name: string }) => void;
  overlayClassName?: string;
};

const parseOptionalInt = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

export default function AddBrandModal({ open, onClose, onCreated, overlayClassName }: Props) {
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [softOneId, setSoftOneId] = useState('');
  const [softOneCode, setSoftOneCode] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setName('');
    setComment('');
    setSoftOneId('');
    setSoftOneCode('');
    setEnabled(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!open) {
      resetForm();
    }
  }, [open, resetForm]);

  const isSoftOneIdValid = useMemo(() => {
    if (!softOneId.trim()) return true;
    return Number.isFinite(Number.parseInt(softOneId.trim(), 10));
  }, [softOneId]);

  const handleCreate = useCallback(async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Name is required.');
      return;
    }

    if (!isSoftOneIdValid) {
      setError('SoftOne ID must be a valid integer.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: trimmedName,
        comment: comment.trim() || null,
        softOneId: parseOptionalInt(softOneId),
        softOneCode: softOneCode.trim() || null,
        enabled,
      };

      const response = await fetch(BRAND_CREATE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = (await response.json().catch(() => null)) as CreateBrandResponse | null;
      if (!response.ok || !result?.ok || !result.brand?.id) {
        const message = result?.error ?? null;
        throw new Error(message ?? 'Unable to create brand.');
      }

      const brandName = result.brand.name?.trim() || trimmedName;
      showToastMessage('Brand added', 'success');
      onCreated?.({ id: result.brand.id, name: brandName });
      onClose();
      resetForm();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to create brand.';
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [comment, enabled, isSoftOneIdValid, name, onClose, onCreated, resetForm, softOneCode, softOneId]);

  return (
    <LookupModal
      open={open}
      title="Add Brand"
      onClose={onClose}
      onConfirm={handleCreate}
      confirmLabel="Create"
      saving={saving}
      error={error}
      overlayClassName={overlayClassName}
    >
      <div className={lookupStyles.fieldGrid}>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="brand-name">
            Name <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <input
            id="brand-name"
            className={lookupStyles.fieldControl}
            value={name}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="brand-comment">
            Comment
          </label>
          <textarea
            id="brand-comment"
            className={lookupStyles.fieldControl}
            rows={3}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="brand-softone-id">
            SoftOne ID
          </label>
          <input
            id="brand-softone-id"
            className={lookupStyles.fieldControl}
            inputMode="numeric"
            value={softOneId}
            aria-invalid={!isSoftOneIdValid}
            onChange={(event) => setSoftOneId(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldHalf}>
          <label className={lookupStyles.fieldLabel} htmlFor="brand-softone-code">
            SoftOne Code
          </label>
          <input
            id="brand-softone-code"
            className={lookupStyles.fieldControl}
            value={softOneCode}
            onChange={(event) => setSoftOneCode(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="brand-enabled">
            Enabled
          </label>
          <label className={lookupStyles.checkboxLabel} htmlFor="brand-enabled">
            <input
              id="brand-enabled"
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
