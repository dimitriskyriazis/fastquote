"use client";

import { useCallback, useEffect, useState } from "react";
import LookupModal from "./LookupModal";
import lookupStyles from "./LookupModal.module.css";

const COUNTRY_CREATE_ENDPOINT = "/api/countries";

type CreateCountryResponse = {
  ok?: boolean;
  error?: string;
  option?: { value?: string; label?: string } | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated?: (country: { id: number; name: string; enabled: boolean }) => void;
  overlayClassName?: string;
};

export default function AddCountryModal({ open, onClose, onCreated, overlayClassName }: Props) {
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = useCallback(() => {
    setName("");
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
      setError("Country name is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = { name: trimmedName, enabled };
      const response = await fetch(COUNTRY_CREATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = (await response.json().catch(() => null)) as CreateCountryResponse | null;
      if (!response.ok || !result?.ok || !result.option?.value) {
        const message = result?.error ?? null;
        throw new Error(message ?? "Unable to create country.");
      }

      const id = Number.parseInt(result.option.value, 10);
      if (!Number.isFinite(id)) {
        throw new Error("Unable to create country.");
      }

      const countryName = result.option.label?.trim() || trimmedName;
      onCreated?.({ id, name: countryName, enabled });
      onClose();
      resetForm();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create country.";
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [enabled, name, onClose, onCreated, resetForm]);

  return (
    <LookupModal
      open={open}
      title="Add Country"
      onClose={onClose}
      onConfirm={handleCreate}
      confirmLabel="Create"
      saving={saving}
      error={error}
      overlayClassName={overlayClassName}
    >
      <div className={lookupStyles.fieldGrid}>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="country-name">
            Country name <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <input
            id="country-name"
            className={lookupStyles.fieldControl}
            value={name}
            required
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="country-enabled">
            Enabled
          </label>
          <label className={lookupStyles.checkboxLabel} htmlFor="country-enabled">
            <input
              id="country-enabled"
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
