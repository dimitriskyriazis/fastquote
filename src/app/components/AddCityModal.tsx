"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import LookupModal from "./LookupModal";
import lookupStyles from "./LookupModal.module.css";

const CITY_CREATE_ENDPOINT = "/api/cities";

type CreateCityResponse = {
  ok?: boolean;
  error?: string;
  option?: { value?: string; label?: string; countryId?: number | null } | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  onCreated?: (city: { id: number; name: string; countryId: number | null; enabled: boolean }) => void;
  countries: Array<{ id: number; name: string }>;
  overlayClassName?: string;
};

export default function AddCityModal({ open, onClose, onCreated, countries, overlayClassName }: Props) {
  const [name, setName] = useState("");
  const [countryId, setCountryId] = useState<number | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedCountries = useMemo(
    () => [...countries].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [countries],
  );

  const resetForm = useCallback(() => {
    setName("");
    setCountryId(null);
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
      setError("City name is required.");
      return;
    }

    if (countryId == null) {
      setError("Country is required.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const payload = { name: trimmedName, countryId, enabled };
      const response = await fetch(CITY_CREATE_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const result = (await response.json().catch(() => null)) as CreateCityResponse | null;
      if (!response.ok || !result?.ok || !result.option?.value) {
        const message = result?.error ?? null;
        throw new Error(message ?? "Unable to create city.");
      }

      const id = Number.parseInt(result.option.value, 10);
      if (!Number.isFinite(id)) {
        throw new Error("Unable to create city.");
      }

      const cityName = result.option.label?.trim() || trimmedName;
      onCreated?.({
        id,
        name: cityName,
        countryId: result.option.countryId ?? countryId,
        enabled,
      });
      onClose();
      resetForm();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to create city.";
      setError(message);
    } finally {
      setSaving(false);
    }
  }, [countryId, enabled, name, onClose, onCreated, resetForm]);

  return (
    <LookupModal
      open={open}
      title="Add City"
      onClose={onClose}
      onConfirm={handleCreate}
      confirmLabel="Create"
      saving={saving}
      error={error}
      overlayClassName={overlayClassName}
    >
      <div className={lookupStyles.fieldGrid}>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="city-name">
            City name <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <input
            id="city-name"
            className={lookupStyles.fieldControl}
            value={name}
            required
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="city-country">
            Country <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <select
            id="city-country"
            className={lookupStyles.fieldControl}
            value={countryId ?? ""}
            required
            disabled={sortedCountries.length === 0}
            onChange={(event) => {
              const value = event.target.value;
              setCountryId(value ? Number.parseInt(value, 10) : null);
            }}
          >
            <option value="">Select country...</option>
            {sortedCountries.map((country) => (
              <option key={country.id} value={country.id}>
                {country.name}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.fieldFull}>
          <label className={lookupStyles.fieldLabel} htmlFor="city-enabled">
            Enabled
          </label>
          <label className={lookupStyles.checkboxLabel} htmlFor="city-enabled">
            <input
              id="city-enabled"
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
