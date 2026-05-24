'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import styles from './PriceListBasicDataPanel.module.css';
import type {
  PriceListBasicRecord,
  PriceListDropdownOption,
  PriceListBasicUpdateField,
  PricingPoliciesByBrand,
  PriceListPricingPolicyEntry,
} from './PriceListBasicDataTypes';
import { showToastMessage } from '../../../lib/toast';
import UKDatePicker from '../../components/DatePicker';
import LookupModal from '../../components/LookupModal';
import AddBrandModal from '../../components/AddBrandModal';
import AddSupplierModal from '../../components/AddSupplierModal';
import lookupButtonStyles from '../../components/LookupAddButton.module.css';
import comboStyles from '../../offers/create/OfferCreateClient.module.css';
import { matchesCountrySearch } from '../../../lib/countryAliases';
import { formatDisplayValue } from '../../lib/formatDisplayValue';
import { normalizeValueForApi } from '../../lib/normalizeValueForApi';
import { useUndoStack } from '../../hooks/useUndoStack';
import { useAutoSaveTimer } from '../../hooks/useAutoSaveTimer';
import { pushCellEditUndo } from '../../../lib/undoHelpers';
import { formatDateInputValue } from '../../lib/formatDateInputValue';
import { getUserNumberLocale, parseLocaleNumber } from '../../../lib/localeNumber';

type Props = {
  priceListId: string;
  record: PriceListBasicRecord;
  brands: PriceListDropdownOption[];
  countries: PriceListDropdownOption[];
  suppliers: PriceListDropdownOption[];
  currencies: PriceListDropdownOption[];
  users: PriceListDropdownOption[];
  pricingPoliciesByBrand: PricingPoliciesByBrand;
  priceListPricingPolicies: PriceListPricingPolicyEntry[];
  allPricingPolicies: PriceListDropdownOption[];
  allPricingPolicyRules: Array<{
    id: number;
    name: string | null;
    pricingPolicyId: number | null;
    brandId: number | null;
    brandName: string | null;
    pricingPolicyName: string | null;
    telmacoDiscountPercentage: number | null;
    customerDiscountPercentage: number | null;
    telmacoWarrantyYears: number | null;
    customerWarrantyYears: number | null;
  }>;
};
type LookupKey = 'brands' | 'countries' | 'suppliers' | 'currencies' | 'users';
type PriceListLookupsPayload = {
  brands?: PriceListDropdownOption[];
  countries?: PriceListDropdownOption[];
  suppliers?: PriceListDropdownOption[];
  currencies?: PriceListDropdownOption[];
  users?: PriceListDropdownOption[];
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
  comboBox?: boolean;
  datalistRecordKey?: keyof PriceListBasicRecord;
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

const numberFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const formatDiscountValue = (value: number | null | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '';
  return numberFormatter.format(value);
};

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
    id: 'validityComment',
    label: 'Validity Comment',
    section: 'general',
    recordKey: 'ValidityComment',
    updateField: 'ValidityComment',
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
    comboBox: true,
    datalistOptions: countries,
    datalistRecordKey: 'CountryName',
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
    id: 'costCurrency',
    label: 'Cost Currency',
    section: 'associations',
    recordKey: 'CostCurrencyID',
    updateField: 'CostCurrencyID',
    valueType: 'number',
    options: currencies,
  },
  {
    id: 'currencyCostModifier',
    label: 'Currency Cost Modifier',
    section: 'associations',
    recordKey: 'CurrencyCostModifier',
    updateField: 'CurrencyCostModifier',
    valueType: 'number',
  },
  {
    id: 'responsibleUser',
    label: 'Responsible User',
    section: 'associations',
    recordKey: 'ResponsibleUserId',
    updateField: 'ResponsibleUserId',
    options: users,
    resolveValue: (rec) => rec.ResponsibleUserId ?? '',
  },
  {
    id: 'createdBy',
    label: 'Created By',
    section: 'associations',
    recordKey: 'CreatedByDisplayName',
    readOnly: true,
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
    id: 'isService',
    label: 'Is Service',
    section: 'settings',
    recordKey: 'IsService',
    updateField: 'IsService',
    valueType: 'number',
    options: BOOLEAN_OPTIONS,
  },
];


const formatInitialValue = (record: PriceListBasicRecord, def: FieldDefinition) => {
  if (def.comboBox && def.datalistOptions && def.datalistOptions.length > 0) {
    const comboValue = record[def.datalistRecordKey ?? def.recordKey];
    if (comboValue === null || comboValue === undefined) return '';
    if (typeof comboValue === 'string') return comboValue;
    if (typeof comboValue === 'number') {
      const matchingOption = def.datalistOptions.find((option) => option.value === String(comboValue));
      return matchingOption?.label ?? String(comboValue);
    }
    return String(comboValue);
  }
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
  pricingPoliciesByBrand: _unused,
  priceListPricingPolicies: initialPriceListPricingPolicies,
  allPricingPolicies,
  allPricingPolicyRules,
}: Props) {
  // Suppress unused variable warning - pricingPoliciesByBrand is part of Props but not used in this component
  void _unused;

  // Local state for brands and suppliers (can be updated when new items are created)
  const [localBrands, setLocalBrands] = useState(brands);
  const [localCountries, setLocalCountries] = useState(countries);
  const [localSuppliers, setLocalSuppliers] = useState(suppliers);
  const [localCurrencies, setLocalCurrencies] = useState(currencies);
  const [localUsers, setLocalUsers] = useState(users);
  const lookupRefreshInFlightRef = useRef(new Set<LookupKey>());

  const fieldDefinitions = useMemo(
    () => buildFieldDefinitions(localBrands, localCountries, localSuppliers, localCurrencies, localUsers),
    [localBrands, localCountries, localSuppliers, localCurrencies, localUsers]
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
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [undoPortal, setUndoPortal] = useState<Element | null>(null);
  useEffect(() => {
    setUndoPortal(document.getElementById('undo-portal'));
  }, []);

  const [priceListPricingPolicies, setPriceListPricingPolicies] = useState<PriceListPricingPolicyEntry[]>(
    initialPriceListPricingPolicies,
  );
  const [localPricingPolicyRules, setLocalPricingPolicyRules] = useState(allPricingPolicyRules);
  const [isRulePickerOpen, setIsRulePickerOpen] = useState(false);
  const [rulePickerSelection, setRulePickerSelection] = useState<Set<number>>(new Set());
  const [rulePickerSaving, setRulePickerSaving] = useState(false);
  const [rulePickerError, setRulePickerError] = useState<string | null>(null);
  const [discountDrafts, setDiscountDrafts] = useState<Record<number, { telmaco: string; customer: string; telmacoWarranty: string; customerWarranty: string }>>({});
  const [openComboField, setOpenComboField] = useState<string | null>(null);
  const [comboErrors, setComboErrors] = useState<Record<string, string>>({});
  const comboCloseTimerRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);
  const [isAddSupplierOpen, setIsAddSupplierOpen] = useState(false);

  useEffect(() => {
    setLocalPricingPolicyRules(allPricingPolicyRules);
  }, [allPricingPolicyRules]);

  useEffect(() => {
    setLocalBrands(brands);
  }, [brands]);

  useEffect(() => {
    setLocalCountries(countries);
  }, [countries]);

  useEffect(() => {
    setLocalSuppliers(suppliers);
  }, [suppliers]);

  useEffect(() => {
    setLocalCurrencies(currencies);
  }, [currencies]);

  useEffect(() => {
    setLocalUsers(users);
  }, [users]);

  const refreshLookups = useCallback(async (keys: LookupKey[]) => {
    const uniqueKeys = Array.from(new Set(keys));
    const pendingKeys = uniqueKeys.filter((key) => !lookupRefreshInFlightRef.current.has(key));
    if (pendingKeys.length === 0) return;
    pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.add(key));
    try {
      const search = new URLSearchParams();
      pendingKeys.forEach((key) => search.append('keys', key));
      const response = await fetch(`/api/price-lists/lookups?${search.toString()}`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; lookups?: PriceListLookupsPayload }
        | null;
      if (!response.ok || !payload?.ok || !payload.lookups) {
        throw new Error(payload?.error ?? 'Unable to refresh lookup options');
      }
      if (payload.lookups.brands) setLocalBrands(payload.lookups.brands);
      if (payload.lookups.countries) setLocalCountries(payload.lookups.countries);
      if (payload.lookups.suppliers) setLocalSuppliers(payload.lookups.suppliers);
      if (payload.lookups.currencies) setLocalCurrencies(payload.lookups.currencies);
      if (payload.lookups.users) setLocalUsers(payload.lookups.users);
    } catch (err) {
      console.error(err);
      showToastMessage('Unable to refresh latest dropdown values.', 'warning');
    } finally {
      pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.delete(key));
    }
  }, []);

  const countriesForModal = useMemo(() =>
    localCountries.map((country) => ({
      id: Number(country.value),
      name: country.label,
    })),
    [localCountries]
  );

  const scheduleComboClose = useCallback((fieldId: string) => {
    comboCloseTimerRef.current[fieldId] = setTimeout(() => {
      setOpenComboField((prev) => (prev === fieldId ? null : prev));
      delete comboCloseTimerRef.current[fieldId];
    }, 120);
  }, []);

  const cancelComboClose = useCallback((fieldId: string) => {
    if (comboCloseTimerRef.current[fieldId]) {
      clearTimeout(comboCloseTimerRef.current[fieldId]);
      delete comboCloseTimerRef.current[fieldId];
    }
  }, []);

  const scheduleAutoSaveRef = useRef<(fieldId: string) => void>(() => {});
  const cancelAutoSaveRef = useRef<(fieldId: string) => void>(() => {});

  const handleValueChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    scheduleAutoSaveRef.current(fieldId);
  }, []);

  const handleBrandCreated = useCallback(
    (brand: { id: number; name: string }) => {
      const option = { value: String(brand.id), label: brand.name };
      setLocalBrands((prev) => {
        if (prev.some((existing) => existing.value === option.value)) return prev;
        return [...prev, option];
      });
      setValues((prev) => ({ ...prev, brand: option.value }));
    },
    [],
  );

  const handleSupplierCreated = useCallback(
    (supplier: { id: number; name: string }) => {
      const option = { value: String(supplier.id), label: supplier.name };
      setLocalSuppliers((prev) => {
        if (prev.some((existing) => existing.value === option.value)) return prev;
        return [...prev, option];
      });
      setValues((prev) => ({ ...prev, supplier: option.value }));
    },
    [],
  );

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

      // Capture current saved state for undo before sending the update
      const oldDisplayValue = savedValuesRef.current[def.id] ?? '';
      let oldPayloadValue: string | number | null | undefined;
      if (def.datalistOptions && def.datalistOptions.length > 0) {
        const trimmedOld = oldDisplayValue.trim().toLowerCase();
        const oldMatch = def.datalistOptions.find(
          (option) => option.label.trim().toLowerCase() === trimmedOld,
        );
        oldPayloadValue = oldMatch?.value ?? null;
      } else {
        oldPayloadValue = normalizeValueForApi(oldDisplayValue, def.valueType);
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
        const capturedOldDisplayValue = oldDisplayValue;
        const capturedOldPayloadValue = oldPayloadValue;
        pushCellEditUndo(pushUndo, performUndo, def.label, async () => {
          const undoRes = await fetch(`/api/price-lists/${encodeURIComponent(priceListId)}/basicdata`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: [{ field: def.updateField, value: capturedOldPayloadValue }] }),
          });
          const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
          if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
          setValues((prev) => ({ ...prev, [def.id]: capturedOldDisplayValue }));
          setSavedValues((prev) => {
            const next = { ...prev, [def.id]: capturedOldDisplayValue };
            savedValuesRef.current = next;
            return next;
          });
        });
      } catch (err) {
        console.error(err);
        setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
        showToastMessage(`Unable to update ${def.label}. Please try again.`, 'error');
      } finally {
        setPendingFields((prev) => ({ ...prev, [def.id]: false }));
      }
    },
    [priceListId, pushUndo, performUndo],
  );

  const handleBlur = useCallback(
    (def: FieldDefinition) => {
      cancelAutoSaveRef.current(def.id);
      if (!def.updateField) return;
      const latestValue = values[def.id] ?? '';
      if (latestValue === savedValuesRef.current[def.id]) return;
      void saveField(def, latestValue);
    },
    [saveField, values],
  );

  const { scheduleAutoSave, cancelAutoSave } = useAutoSaveTimer({
    values,
    savedValuesRef,
    fieldDefinitions: editableFields,
    saveField,
  });
  scheduleAutoSaveRef.current = scheduleAutoSave;
  cancelAutoSaveRef.current = cancelAutoSave;

  const pricingPolicyNameById = useMemo(() => {
    const map = new Map<number, string>();
    allPricingPolicies.forEach((policy) => {
      const id = Number(policy.value);
      if (Number.isFinite(id)) {
        map.set(id, policy.label);
      }
    });
    return map;
  }, [allPricingPolicies]);

  const currentBrandId = useMemo(() => {
    const raw = values.brand ?? '';
    const parsed = raw ? Number(raw) : Number.NaN;
    if (Number.isFinite(parsed)) return parsed;
    return record.BrandID ?? null;
  }, [record.BrandID, values.brand]);

  const hasBrandSelection = currentBrandId != null && Number.isFinite(currentBrandId);

  const rulesForPicker = useMemo(() => {
    const filtered =
      currentBrandId == null
        ? localPricingPolicyRules
        : localPricingPolicyRules.filter(
            (rule) => rule.brandId == null || rule.brandId === currentBrandId,
          );
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      const aPolicy = a.pricingPolicyName ?? pricingPolicyNameById.get(Number(a.pricingPolicyId)) ?? '';
      const bPolicy = b.pricingPolicyName ?? pricingPolicyNameById.get(Number(b.pricingPolicyId)) ?? '';
      const policyCompare = aPolicy.localeCompare(bPolicy);
      if (policyCompare !== 0) return policyCompare;
      return (a.name ?? '').localeCompare(b.name ?? '');
    });
    return sorted;
  }, [currentBrandId, localPricingPolicyRules, pricingPolicyNameById]);

  const selectedRuleIds = useMemo(() => {
    const existingPolicyIds = new Set(
      priceListPricingPolicies.map((entry) => entry.pricingPolicyId),
    );
    return new Set(
      localPricingPolicyRules
        .filter(
          (rule) =>
            rule.pricingPolicyId != null &&
            existingPolicyIds.has(rule.pricingPolicyId) &&
            (rule.brandId == null || rule.brandId === currentBrandId),
        )
        .map((rule) => rule.id),
    );
  }, [priceListPricingPolicies, localPricingPolicyRules, currentBrandId]);

  const rulesById = useMemo(() => {
    const map = new Map<number, (typeof localPricingPolicyRules)[number]>();
    localPricingPolicyRules.forEach((rule) => {
      if (Number.isFinite(rule.id)) {
        map.set(rule.id, rule);
      }
    });
    return map;
  }, [localPricingPolicyRules]);

  const selectedRuleSummary = useMemo(() => {
    const existingPolicyIds = new Set(
      priceListPricingPolicies.map((entry) => entry.pricingPolicyId),
    );
    return localPricingPolicyRules.filter(
      (rule) =>
        rule.pricingPolicyId != null &&
        existingPolicyIds.has(rule.pricingPolicyId) &&
        (rule.brandId == null || rule.brandId === currentBrandId),
    );
  }, [priceListPricingPolicies, localPricingPolicyRules, currentBrandId]);

  const selectedPolicySummary = useMemo(() => {
    const ruleMatchedPolicyIds = new Set(
      selectedRuleSummary.map((rule) => rule.pricingPolicyId).filter((id): id is number => id != null),
    );
    const seen = new Set<number>();
    return priceListPricingPolicies
      .filter((entry) => !ruleMatchedPolicyIds.has(entry.pricingPolicyId))
      .map((entry) => {
        const id = entry.pricingPolicyId;
        if (!Number.isFinite(id) || seen.has(id)) return null;
        seen.add(id);
        return {
          id,
          name: entry.pricingPolicyName ?? pricingPolicyNameById.get(id) ?? `Policy ${id}`,
        };
      })
      .filter((entry): entry is { id: number; name: string } => Boolean(entry));
  }, [priceListPricingPolicies, selectedRuleSummary, pricingPolicyNameById]);

  useEffect(() => {
    if (!isRulePickerOpen) return;
    setRulePickerError(null);
    const visibleRuleIds = new Set(rulesForPicker.map((rule) => rule.id));
    setRulePickerSelection(
      new Set(Array.from(selectedRuleIds).filter((id) => visibleRuleIds.has(id))),
    );
  }, [isRulePickerOpen, rulesForPicker, selectedRuleIds]);

  useEffect(() => {
    if (!isRulePickerOpen) return;
    const next: Record<number, { telmaco: string; customer: string; telmacoWarranty: string; customerWarranty: string }> = {};
    rulesForPicker.forEach((rule) => {
      next[rule.id] = {
        telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
        customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
        telmacoWarranty: rule.telmacoWarrantyYears != null ? String(rule.telmacoWarrantyYears) : '',
        customerWarranty: rule.customerWarrantyYears != null ? String(rule.customerWarrantyYears) : '',
      };
    });
    setDiscountDrafts(next);
  }, [isRulePickerOpen, rulesForPicker]);

  const toggleRuleSelection = useCallback((ruleId: number) => {
    setRulePickerSelection((prev) => {
      const next = new Set(prev);
      if (next.has(ruleId)) {
        next.delete(ruleId);
      } else {
        next.add(ruleId);
      }
      return next;
    });
  }, []);

  const applyRuleSelection = useCallback(async () => {
    setRulePickerSaving(true);
    setRulePickerError(null);

    // Build the set of pricingPolicyIds that the desired rules map to
    const desiredPolicyIds = new Set<number>();
    for (const ruleId of rulePickerSelection) {
      const rule = rulesById.get(ruleId);
      if (rule?.pricingPolicyId != null) desiredPolicyIds.add(rule.pricingPolicyId);
    }

    // Existing entries whose pricingPolicyId is NOT among the desired ones should be deleted
    const toDelete = priceListPricingPolicies.filter(
      (entry) => !desiredPolicyIds.has(entry.pricingPolicyId),
    );
    // Desired policyIds that don't already have an entry should be added
    const existingPolicyIds = new Set(priceListPricingPolicies.map((e) => e.pricingPolicyId));
    const toAddPolicyIds = Array.from(desiredPolicyIds).filter((id) => !existingPolicyIds.has(id));

    const deletedIds = new Set(toDelete.map((entry) => entry.id));
    const addedEntries: PriceListPricingPolicyEntry[] = [];

    try {
      for (const entry of toDelete) {
        const response = await fetch(
          `/api/price-lists/${encodeURIComponent(priceListId)}/pricing-policies?policyId=${entry.id}`,
          { method: 'DELETE' },
        );
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? 'Failed to remove pricing policy rule');
        }
      }

      for (const policyId of toAddPolicyIds) {
        const response = await fetch(`/api/price-lists/${encodeURIComponent(priceListId)}/pricing-policies`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pricingPolicyId: policyId }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string; id?: number } | null;
        if (!response.ok || !payload?.ok || !payload?.id) {
          throw new Error(payload?.error ?? 'Failed to add pricing policy rule');
        }
        addedEntries.push({
          id: payload.id,
          priceListId: Number(priceListId),
          pricingPolicyId: policyId,
          pricingPolicyName: pricingPolicyNameById.get(policyId) ?? null,
        });
      }

      setPriceListPricingPolicies((prev) => {
        const kept = prev.filter((entry) => !deletedIds.has(entry.id));
        return [...kept, ...addedEntries];
      });
      showToastMessage('Pricing rules updated', 'success');
      setIsRulePickerOpen(false);
    } catch (err) {
      console.error('Failed to update pricing rules', err);
      const message = err instanceof Error ? err.message : 'Unable to update pricing rules';
      setRulePickerError(message);
      showToastMessage(message, 'error');
    } finally {
      setRulePickerSaving(false);
    }
  }, [priceListId, priceListPricingPolicies, rulePickerSelection, rulesById, pricingPolicyNameById]);

  const handleRuleDiscountChange = useCallback(
    (ruleId: number, field: 'telmaco' | 'customer' | 'telmacoWarranty' | 'customerWarranty', value: string) => {
      setDiscountDrafts((prev) => ({
        ...prev,
        [ruleId]: {
          telmaco: prev[ruleId]?.telmaco ?? '',
          customer: prev[ruleId]?.customer ?? '',
          telmacoWarranty: prev[ruleId]?.telmacoWarranty ?? '',
          customerWarranty: prev[ruleId]?.customerWarranty ?? '',
          [field]: value,
        },
      }));
    },
    [],
  );

  const handleRuleDiscountSave = useCallback(
    async (
      rule: (typeof localPricingPolicyRules)[number],
      field: 'telmaco' | 'customer' | 'telmacoWarranty' | 'customerWarranty',
    ) => {
      const ruleId = rule.id;
      if (!Number.isFinite(ruleId)) return;
      const isWarrantyField = field === 'telmacoWarranty' || field === 'customerWarranty';
      if (rule.brandId == null || rule.pricingPolicyId == null) {
        showToastMessage('This rule cannot be edited.', 'error');
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
            telmacoWarranty: rule.telmacoWarrantyYears != null ? String(rule.telmacoWarrantyYears) : '',
            customerWarranty: rule.customerWarrantyYears != null ? String(rule.customerWarrantyYears) : '',
          },
        }));
        return;
      }

      const draft = discountDrafts[ruleId]?.[field] ?? '';
      const parsed = parseLocaleNumber(draft);
      if (parsed == null && !isWarrantyField) {
        showToastMessage('Discount is required', 'error');
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
            telmacoWarranty: rule.telmacoWarrantyYears != null ? String(rule.telmacoWarrantyYears) : '',
            customerWarranty: rule.customerWarrantyYears != null ? String(rule.customerWarrantyYears) : '',
          },
        }));
        return;
      }

      const currentValue =
        field === 'telmaco'
          ? rule.telmacoDiscountPercentage ?? null
          : field === 'customer'
            ? rule.customerDiscountPercentage ?? null
            : field === 'telmacoWarranty'
              ? rule.telmacoWarrantyYears ?? null
              : rule.customerWarrantyYears ?? null;
      const apiValue = isWarrantyField ? (parsed ?? 1) : parsed;
      if (currentValue != null && apiValue === currentValue) return;

      try {
        const response = await fetch('/api/pricing-policies/matrix', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            brandId: rule.brandId,
            pricingPolicyId: rule.pricingPolicyId,
            field,
            value: apiValue,
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? isWarrantyField ? 'Unable to update warranty' : 'Unable to update discounts');
        }
        setLocalPricingPolicyRules((prev) =>
          prev.map((entry) =>
            entry.id === ruleId
              ? {
                  ...entry,
                  telmacoDiscountPercentage:
                    field === 'telmaco' ? parsed : entry.telmacoDiscountPercentage ?? null,
                  customerDiscountPercentage:
                    field === 'customer' ? parsed : entry.customerDiscountPercentage ?? null,
                  telmacoWarrantyYears:
                    field === 'telmacoWarranty' ? (apiValue as number) : entry.telmacoWarrantyYears ?? null,
                  customerWarrantyYears:
                    field === 'customerWarranty' ? (apiValue as number) : entry.customerWarrantyYears ?? null,
                }
              : entry,
          ),
        );
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco: field === 'telmaco' ? formatDiscountValue(parsed) : prev[ruleId]?.telmaco ?? '',
            customer: field === 'customer' ? formatDiscountValue(parsed) : prev[ruleId]?.customer ?? '',
            telmacoWarranty: field === 'telmacoWarranty' ? String(apiValue) : prev[ruleId]?.telmacoWarranty ?? '',
            customerWarranty: field === 'customerWarranty' ? String(apiValue) : prev[ruleId]?.customerWarranty ?? '',
          },
        }));
        showToastMessage(isWarrantyField ? 'Warranty updated' : 'Discount updated', 'success');
      } catch (err) {
        console.error('Failed to update', err);
        showToastMessage(isWarrantyField ? 'Unable to update warranty. Please try again.' : 'Unable to update discount. Please try again.', 'error');
        setDiscountDrafts((prev) => ({
          ...prev,
          [ruleId]: {
            telmaco: formatDiscountValue(rule.telmacoDiscountPercentage ?? null),
            customer: formatDiscountValue(rule.customerDiscountPercentage ?? null),
            telmacoWarranty: rule.telmacoWarrantyYears != null ? String(rule.telmacoWarrantyYears) : '',
            customerWarranty: rule.customerWarrantyYears != null ? String(rule.customerWarrantyYears) : '',
          },
        }));
      }
    },
    [discountDrafts],
  );

  const refreshFieldLookups = useCallback((fieldId: string) => {
    if (fieldId === 'brand') {
      void refreshLookups(['brands']);
      return;
    }
    if (fieldId === 'supplier') {
      void refreshLookups(['suppliers']);
      return;
    }
    if (fieldId === 'country') {
      void refreshLookups(['countries']);
      return;
    }
    if (fieldId === 'currency' || fieldId === 'costCurrency') {
      void refreshLookups(['currencies']);
      return;
    }
    if (fieldId === 'responsibleUser') {
      void refreshLookups(['users']);
      return;
    }
    if (fieldId === 'enabled' || fieldId === 'hasDuty') {
      return;
    }
  }, [refreshLookups]);

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

    if (def.comboBox && def.datalistOptions && def.datalistOptions.length > 0) {
      const search = value.trim();
      const filteredOptions = search
        ? def.datalistOptions.filter((option) => matchesCountrySearch(option.label, search))
        : def.datalistOptions;
      const isOpen = openComboField === def.id;
      const errorMessage = comboErrors[def.id];
      const handleComboBlur = () => {
        scheduleComboClose(def.id);
        if (!def.updateField) return;
        const latestValue = (valuesRef.current?.[def.id] ?? '').trim();
        if (latestValue === (savedValuesRef.current[def.id] ?? '').trim()) {
          setComboErrors((prev) => {
            if (!prev[def.id]) return prev;
            const next = { ...prev };
            delete next[def.id];
            return next;
          });
          return;
        }
        void (async () => {
          await saveField(def, latestValue);
        })();
      };
      return (
        <div className={`${comboStyles.controlStack} ${comboStyles.comboWrapper}`}>
          <input
            autoComplete="off"
            id={controlId}
            name={def.id}
            className={`${styles.fieldControl} ${comboStyles.comboInput} ${pending ? styles.fieldControlPending : ''}`}
            value={value}
            placeholder="Type to filter countries"
            onChange={(event) => {
              cancelComboClose(def.id);
              handleValueChange(def.id, event.target.value);
              setComboErrors((prev) => {
                if (!prev[def.id]) return prev;
                const next = { ...prev };
                delete next[def.id];
                return next;
              });
            }}
            onFocus={(event) => {
              event.target.select();
              refreshFieldLookups(def.id);
              setOpenComboField(def.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && isOpen && filteredOptions.length > 0) {
                event.preventDefault();
                cancelComboClose(def.id);
                setOpenComboField(null);
                setComboErrors((prev) => {
                  if (!prev[def.id]) return prev;
                  const next = { ...prev };
                  delete next[def.id];
                  return next;
                });
                handleValueChange(def.id, filteredOptions[0].label);
                void saveField(def, filteredOptions[0].label);
              }
            }}
            onBlur={handleComboBlur}
          />
          {isOpen && filteredOptions.length > 0 ? (
            <div className={comboStyles.comboList}>
              {filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={comboStyles.comboOption}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    cancelComboClose(def.id);
                    setOpenComboField(null);
                    setComboErrors((prev) => {
                      if (!prev[def.id]) return prev;
                      const next = { ...prev };
                      delete next[def.id];
                      return next;
                    });
                    handleValueChange(def.id, option.label);
                    void saveField(def, option.label);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {errorMessage ? <div className={comboStyles.fieldError}>{errorMessage}</div> : null}
        </div>
      );
    }

    if (def.options && def.options.length > 0) {
      return (
        <select
          id={controlId}
          name={def.id}
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          value={value}
          onMouseDown={() => refreshFieldLookups(def.id)}
          onFocus={() => refreshFieldLookups(def.id)}
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
            onFocus={() => refreshFieldLookups(def.id)}
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
            const isBrandField = field.id === 'brand';
            const isSupplierField = field.id === 'supplier';

            const isFilePathField = field.id === 'filePath';

            return (
              <div key={field.id} className={`${styles.fieldBlock} ${spanClass}`}>
                <label className={styles.fieldLabel} htmlFor={`price-list-field-${field.id}`}>
                  {isBrandField || isSupplierField || isFilePathField ? (
                    <span className={styles.fieldLabelRow}>
                      <span>{field.label}</span>
                      {isBrandField ? (
                        <button
                          type="button"
                          className={lookupButtonStyles.lookupAddButton}
                          onClick={() => setIsAddBrandOpen(true)}
                        >
                          Add New Brand
                        </button>
                      ) : null}
                      {isSupplierField ? (
                        <button
                          type="button"
                          className={lookupButtonStyles.lookupAddButton}
                          onClick={() => setIsAddSupplierOpen(true)}
                        >
                          Add New Supplier
                        </button>
                      ) : null}
                      {isFilePathField && record.FilePath ? (
                        <button
                          type="button"
                          className={lookupButtonStyles.lookupAddButton}
                          onClick={() => window.open(`/api/price-lists/${encodeURIComponent(priceListId)}/file`, '_blank')}
                        >
                          View Original File
                        </button>
                      ) : null}
                    </span>
                  ) : (
                    field.label
                  )}
                </label>
                {renderFieldControl(field)}
              </div>
            );
          })}
        </div>
      </>
    );

    return (
      <section key={sectionKey} className={`${styles.sectionCard} ${styles.detailSection}`}>
        {cardContent}
        {sectionKey === 'settings' ? (
          <div className={styles.chipListWrapper}>
            <div className={styles.chipListHeading}>Pricing Policy Rules</div>
            {selectedRuleSummary.length > 0 || selectedPolicySummary.length > 0 ? (
              <div className={styles.ruleSummaryList}>
                {selectedRuleSummary.map((rule) => (
                  <span key={rule.id} className={styles.ruleSummaryItem}>
                    {rule.name ?? `Rule ${rule.id}`}
                  </span>
                ))}
                {selectedPolicySummary.map((policy) => (
                  <span key={`policy-${policy.id}`} className={styles.ruleSummaryItem}>
                    {policy.name}
                  </span>
                ))}
              </div>
            ) : (
              <div className={styles.chipListEmpty}>No pricing policies selected.</div>
            )}
            <span
              className={styles.tooltipWrapper}
              data-tooltip={
                !hasBrandSelection
                  ? 'Select a brand with a pricing policy and a rule first.'
                  : rulesForPicker.length === 0
                    ? 'No pricing policy rules are available for this brand.'
                    : ''
              }
            >
              <button
                type="button"
                className={`${styles.buttonSecondary} ${styles.rulePickerButton}`}
                onClick={() => {
                  if (!hasBrandSelection) {
                    showToastMessage('Please select a brand first.', 'error');
                    return;
                  }
                  setIsRulePickerOpen(true);
                }}
                disabled={!hasBrandSelection || rulesForPicker.length === 0}
              >
                Select Pricing Policy Rules
              </button>
            </span>
          </div>
        ) : null}
      </section>
    );
  };

  return (
    <>
      {canUndo && undoPortal && createPortal(
        <button type="button" className="page-header-button" onClick={performUndo}>
          ↩ Undo{lastLabel ? `: ${lastLabel}` : ''}
        </button>,
        undoPortal,
      )}
      <div className={styles.panel}>
        {renderSectionCard('general')}
        <div className={styles.sectionsGrid}>
          {renderSectionCard('validity')}
          {renderSectionCard('associations')}
          {renderSectionCard('settings')}
        </div>
      </div>
      <LookupModal
        open={isRulePickerOpen}
        title="Select Pricing Policy Rules"
        onClose={() => setIsRulePickerOpen(false)}
        onConfirm={() => void applyRuleSelection()}
        confirmLabel="Apply"
        saving={rulePickerSaving}
        error={rulePickerError}
        cardClassName={styles.rulePickerModal}
        bodyClassName={styles.rulePickerBody}
      >
        {rulesForPicker.length > 0 ? (
          <table className={styles.ruleTable}>
            <thead>
              <tr>
                <th className={styles.ruleCheckboxCell} />
                <th>Rule</th>
                <th>Pricing Policy</th>
                <th>Telmaco Discount</th>
                <th>Customer Discount</th>
                <th>Telmaco Warranty</th>
                <th>Customer Warranty</th>
              </tr>
            </thead>
            <tbody>
              {rulesForPicker.map((rule) => {
                const isSelected = rulePickerSelection.has(rule.id);
                const policyLabel =
                  rule.pricingPolicyName ?? pricingPolicyNameById.get(Number(rule.pricingPolicyId)) ?? '—';
                const canEdit = rule.brandId != null && rule.pricingPolicyId != null;
                const draft = discountDrafts[rule.id];
                return (
                  <tr key={rule.id} className={isSelected ? styles.ruleRowSelected : ''}>
                    <td className={styles.ruleCheckboxCell}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleRuleSelection(rule.id)}
                      />
                    </td>
                    <td className={styles.ruleName}>{rule.name ?? `Rule ${rule.id}`}</td>
                    <td className={styles.rulePolicy}>{policyLabel}</td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.telmaco ?? formatDiscountValue(rule.telmacoDiscountPercentage ?? null)}
                        onChange={(event) => handleRuleDiscountChange(rule.id, 'telmaco', event.target.value)}
                        onBlur={() => void handleRuleDiscountSave(rule, 'telmaco')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!canEdit || rulePickerSaving}
                        aria-label={`Telmaco discount for ${rule.name ?? `Rule ${rule.id}`}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.customer ?? formatDiscountValue(rule.customerDiscountPercentage ?? null)}
                        onChange={(event) => handleRuleDiscountChange(rule.id, 'customer', event.target.value)}
                        onBlur={() => void handleRuleDiscountSave(rule, 'customer')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!canEdit || rulePickerSaving}
                        aria-label={`Customer discount for ${rule.name ?? `Rule ${rule.id}`}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.telmacoWarranty ?? (rule.telmacoWarrantyYears != null ? String(rule.telmacoWarrantyYears) : '')}
                        onChange={(event) => handleRuleDiscountChange(rule.id, 'telmacoWarranty', event.target.value)}
                        onBlur={() => void handleRuleDiscountSave(rule, 'telmacoWarranty')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!canEdit || rulePickerSaving}
                        aria-label={`Telmaco warranty for ${rule.name ?? `Rule ${rule.id}`}`}
                      />
                    </td>
                    <td>
                      <input
                        className={styles.ruleDiscountInput}
                        value={draft?.customerWarranty ?? (rule.customerWarrantyYears != null ? String(rule.customerWarrantyYears) : '')}
                        onChange={(event) => handleRuleDiscountChange(rule.id, 'customerWarranty', event.target.value)}
                        onBlur={() => void handleRuleDiscountSave(rule, 'customerWarranty')}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.currentTarget.blur();
                          }
                        }}
                        disabled={!canEdit || rulePickerSaving}
                        aria-label={`Customer warranty for ${rule.name ?? `Rule ${rule.id}`}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className={styles.ruleTableEmpty}>No pricing policy rules available for the selected brand.</div>
        )}
      </LookupModal>
      <AddBrandModal
        open={isAddBrandOpen}
        onClose={() => setIsAddBrandOpen(false)}
        onCreated={handleBrandCreated}
      />
      <AddSupplierModal
        open={isAddSupplierOpen}
        onClose={() => setIsAddSupplierOpen(false)}
        onCreated={handleSupplierCreated}
        countries={countriesForModal}
      />
    </>
  );
}
