'use client';

import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import styles from './CustomerBasicDataPanel.module.css';
import offerFormStyles from '../../offers/create/OfferCreateClient.module.css';
import offerPanelStyles from '../../offers/[offerId]/OfferBasicDataPanel.module.css';
import type { DropdownOption } from '../../../lib/dropdownOptions';
import lookupStyles from '../../components/LookupModal.module.css';
import LookupModal from '../../components/LookupModal';
import lookupButtonStyles from '../../components/LookupAddButton.module.css';
import type {
  CustomerBasicRecord,
  CustomerDropdownOption,
  CustomerBasicUpdateField,
  CustomerCityOption,
} from './CustomerBasicDataTypes';
import { showToastMessage } from '../../../lib/toast';
import { formatDisplayValue } from '../../lib/formatDisplayValue';
import { normalizeValueForApi } from '../../lib/normalizeValueForApi';
import { formatDateInputValue } from '../../lib/formatDateInputValue';

type Props = {
  customerId: string;
  record: CustomerBasicRecord;
  customerGroups: CustomerDropdownOption[];
  parentCustomers: CustomerDropdownOption[];
  pricingPolicies: CustomerDropdownOption[];
  importanceOptions: CustomerDropdownOption[];
  countries: CustomerDropdownOption[];
  cities: CustomerCityOption[];
  calcMethodFormulas: DropdownOption[];
};

type SectionKey = 'general' | 'business' | 'location' | 'contact' | 'notes';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  recordKey: keyof CustomerBasicRecord;
  updateField?: CustomerBasicUpdateField;
  span?: number;
  multiline?: boolean;
  inputType?: string;
  valueType?: 'string' | 'number' | 'date';
  readOnly?: boolean;
  options?: CustomerDropdownOption[];
  datalistOptions?: CustomerDropdownOption[];
  datalistRecordKey?: keyof CustomerBasicRecord;
  onCreateOption?: (label: string) => Promise<CustomerDropdownOption | null>;
  hint?: string;
  comboBox?: boolean;
  required?: boolean;
};

const SECTION_METADATA: Record<SectionKey, { title: string }> = {
  general: { title: 'General' },
  business: { title: 'Business Info' },
  location: { title: 'Location' },
  contact: { title: 'Contact' },
  notes: { title: 'Notes' },
};

const BOOLEAN_OPTIONS: CustomerDropdownOption[] = [
  { value: '1', label: 'Yes' },
  { value: '0', label: 'No' },
];

const buildFieldDefinitions = (
  customerGroups: CustomerDropdownOption[],
  parentCustomers: CustomerDropdownOption[],
  pricingPolicies: CustomerDropdownOption[],
  importanceOptions: CustomerDropdownOption[],
  countries: CustomerDropdownOption[],
): FieldDefinition[] => [
  {
    id: 'name',
    label: 'Name',
    section: 'general',
    recordKey: 'Name',
    updateField: 'Name',
    span: 2,
  },
  {
    id: 'brandName',
    label: 'Brand Name',
    section: 'general',
    recordKey: 'BrandName',
    updateField: 'BrandName',
  },
  {
    id: 'customerGroup',
    label: 'Customer Group',
    section: 'general',
    recordKey: 'CustomerGroupID',
    updateField: 'CustomerGroupID',
    valueType: 'number',
    options: customerGroups,
  },
  {
    id: 'parentCustomer',
    label: 'Parent Customer',
    section: 'general',
    recordKey: 'ParentCustomerID',
    updateField: 'ParentCustomerID',
    valueType: 'number',
    options: parentCustomers,
  },
  {
    id: 'importance',
    label: 'Importance',
    section: 'general',
    recordKey: 'Importance',
    updateField: 'Importance',
    options: importanceOptions,
  },
  {
    id: 'pricingPolicy',
    label: 'Pricing Policy',
    section: 'general',
    recordKey: 'PricingPolicyID',
    updateField: 'PricingPolicyID',
    valueType: 'number',
    options: pricingPolicies,
  },
  {
    id: 'isParent',
    label: 'Is Parent',
    section: 'general',
    recordKey: 'IsParent',
    updateField: 'IsParent',
    valueType: 'number',
    options: BOOLEAN_OPTIONS,
  },
  {
    id: 'enabled',
    label: 'Enabled',
    section: 'general',
    recordKey: 'Enabled',
    updateField: 'Enabled',
    valueType: 'number',
    options: BOOLEAN_OPTIONS,
  },
  {
    id: 'taxId',
    label: 'Tax ID',
    section: 'business',
    recordKey: 'TaxID',
    updateField: 'TaxID',
  },
  {
    id: 'taxOffice',
    label: 'Tax Office',
    section: 'business',
    recordKey: 'TaxOffice',
    updateField: 'TaxOffice',
  },
  {
    id: 'profession',
    label: 'Profession',
    section: 'business',
    recordKey: 'Profession',
    updateField: 'Profession',
  },
  {
    id: 'activityCode',
    label: 'Activity Code',
    section: 'business',
    recordKey: 'ActivityCode',
    updateField: 'ActivityCode',
  },
  {
    id: 'erp',
    label: 'ERP ID',
    section: 'business',
    recordKey: 'ERPID',
    updateField: 'ERPID',
  },
  {
    id: 'address',
    label: 'Address',
    section: 'location',
    recordKey: 'Address',
    updateField: 'Address',
    multiline: true,
    span: -1,
  },
  {
    id: 'country',
    label: 'Country',
    section: 'location',
    recordKey: 'CountryID',
    updateField: 'CountryID',
    valueType: 'number',
    options: countries,
  },
  {
    id: 'city',
    label: 'City',
    section: 'location',
    recordKey: 'CityID',
    updateField: 'CityID',
    valueType: 'number',
  },
  {
    id: 'phone',
    label: 'Phone',
    section: 'contact',
    recordKey: 'Phone',
    updateField: 'Phone',
  },
  {
    id: 'email',
    label: 'Email',
    section: 'contact',
    recordKey: 'Email',
    updateField: 'Email',
    inputType: 'email',
  },
  {
    id: 'website',
    label: 'Website',
    section: 'contact',
    recordKey: 'WebSite',
    updateField: 'WebSite',
    inputType: 'url',
  },
  {
    id: 'notes',
    label: 'Notes',
    section: 'notes',
    recordKey: 'Notes',
    updateField: 'Notes',
    multiline: true,
    span: -1,
  },
];


const parseDateValue = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

const formatInitialValue = (record: CustomerBasicRecord, def: FieldDefinition) => {
  const raw = record[def.recordKey];
  if (def.inputType === 'date' || def.valueType === 'date') {
    return formatDateInputValue(raw as Date | string | null | undefined);
  }
  if (raw === null || raw === undefined) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return String(raw);
  if (typeof raw === 'boolean') return raw ? '1' : '0';
  const fallbackDate = parseDateValue(raw);
  if (fallbackDate) return formatDateInputValue(fallbackDate);
  return String(raw);
};

const resolveFieldValue = (record: CustomerBasicRecord, def: FieldDefinition) => record[def.recordKey] ?? null;

const SECTION_ORDER: SectionKey[] = ['general', 'business', 'location', 'contact', 'notes'];

export default function CustomerBasicDataClient({
  customerId,
  record,
  customerGroups,
  parentCustomers,
  pricingPolicies,
  importanceOptions,
  countries,
  cities,
  calcMethodFormulas,
}: Props) {
  const [pricingPolicyOptions, setPricingPolicyOptions] = useState(pricingPolicies);
  const [countryOptions, setCountryOptions] = useState(countries);
  const [cityOptions, setCityOptions] = useState(cities);
  const [openComboField, setOpenComboField] = useState<string | null>(null);
  const [comboErrors, setComboErrors] = useState<Record<string, string | null>>({});
  const comboCloseTimersRef = useRef<Record<string, ReturnType<typeof setTimeout> | null>>({});

  const cancelComboClose = useCallback((fieldId: string) => {
    if (comboCloseTimersRef.current[fieldId]) {
      clearTimeout(comboCloseTimersRef.current[fieldId]!);
      comboCloseTimersRef.current[fieldId] = null;
    }
  }, []);

  const scheduleComboClose = useCallback(
    (fieldId: string) => {
      cancelComboClose(fieldId);
      comboCloseTimersRef.current[fieldId] = setTimeout(() => {
        setOpenComboField((prev) => (prev === fieldId ? null : prev));
        comboCloseTimersRef.current[fieldId] = null;
      }, 120);
    },
    [cancelComboClose],
  );

  useEffect(
    () => () => {
      Object.values(comboCloseTimersRef.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    },
    [],
  );

  useEffect(() => {
    setPricingPolicyOptions(pricingPolicies);
  }, [pricingPolicies]);

  useEffect(() => {
    setCountryOptions(countries);
  }, [countries]);

  useEffect(() => {
    setCityOptions(cities);
  }, [cities]);

  const [isAddPricingPolicyOpen, setIsAddPricingPolicyOpen] = useState(false);
  const [newPricingPolicyName, setNewPricingPolicyName] = useState('');
  const [newPricingPolicyEnabled, setNewPricingPolicyEnabled] = useState('1');
  const [newPricingPolicyCalcMethod, setNewPricingPolicyCalcMethod] = useState(
    calcMethodFormulas[0]?.value ?? '',
  );
  const [pricingPolicySaving, setPricingPolicySaving] = useState(false);
  const [pricingPolicyError, setPricingPolicyError] = useState<string | null>(null);
  const [isAddCountryOpen, setIsAddCountryOpen] = useState(false);
  const [newCountryName, setNewCountryName] = useState('');
  const [newCountryEnabled, setNewCountryEnabled] = useState('1');
  const [countrySaving, setCountrySaving] = useState(false);
  const [countryError, setCountryError] = useState<string | null>(null);
  const [isAddCityOpen, setIsAddCityOpen] = useState(false);
  const [newCityName, setNewCityName] = useState('');
  const [newCityCountryId, setNewCityCountryId] = useState('');
  const [newCityEnabled, setNewCityEnabled] = useState('1');
  const [citySaving, setCitySaving] = useState(false);
  const [cityError, setCityError] = useState<string | null>(null);

  useEffect(() => {
    if (calcMethodFormulas.length === 0) {
      setNewPricingPolicyCalcMethod('');
      return;
    }
    setNewPricingPolicyCalcMethod((prev) =>
      calcMethodFormulas.some((option) => option.value === prev)
        ? prev
        : calcMethodFormulas[0].value,
    );
  }, [calcMethodFormulas]);

  const fieldDefinitions = useMemo(
    () =>
      buildFieldDefinitions(
        customerGroups,
        parentCustomers,
        pricingPolicyOptions,
        importanceOptions,
        countryOptions,
      ),
    [customerGroups, parentCustomers, pricingPolicyOptions, importanceOptions, countryOptions],
  );

  const editableFields = useMemo(
    () => fieldDefinitions.filter((def) => def.updateField && !def.readOnly),
    [fieldDefinitions],
  );

  const initialValues = useMemo(() => {
    const valuesMap: Record<string, string> = {};
    editableFields.forEach((def) => {
      valuesMap[def.id] = formatInitialValue(record, def);
    });
    return valuesMap;
  }, [editableFields, record]);

  const [values, setValues] = useState(initialValues);
  const [pendingFields, setPendingFields] = useState<Record<string, boolean>>({});
  const [savedValues, setSavedValues] = useState(initialValues);
  const savedValuesRef = useRef(savedValues);
  savedValuesRef.current = savedValues;
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const selectedCountryId = values.country ?? '';

  useEffect(() => {
    if (!isAddCityOpen) return;
    const fallback =
      selectedCountryId &&
      countryOptions.some((option) => option.value === selectedCountryId)
        ? selectedCountryId
        : countryOptions[0]?.value ?? '';
    setNewCityCountryId(fallback);
  }, [isAddCityOpen, selectedCountryId, countryOptions]);

  const handleValueChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
  }, []);

  const saveField = useCallback(
    async (def: FieldDefinition, rawValue: string) => {
      if (!def.updateField) return false;
      let payloadValue: string | number | null | undefined = null;
      let resolvedDisplayValue = rawValue;

      if (def.datalistOptions && def.datalistOptions.length > 0) {
        const trimmed = rawValue.trim();
        if (!trimmed) {
          payloadValue = null;
        } else {
          let option: CustomerDropdownOption | null | undefined = def.datalistOptions.find(
            (candidate) => candidate.label.trim().toLowerCase() === trimmed.toLowerCase(),
          );
          if (!option && typeof def.onCreateOption === 'function') {
            option = await def.onCreateOption(trimmed);
          }
          if (!option) {
            showToastMessage(`Please choose a valid ${def.label.toLowerCase()}`, 'error');
            setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
            return false;
          }
          resolvedDisplayValue = option.label;
          payloadValue =
            def.valueType === 'number' ? Number(option.value) : def.valueType === 'date' ? option.value : option.value;
        }
      } else if (def.options && def.options.length > 0) {
        payloadValue = normalizeValueForApi(rawValue, def.valueType);
      } else {
        payloadValue = normalizeValueForApi(rawValue, def.valueType);
      }

      setPendingFields((prev) => ({ ...prev, [def.id]: true }));

      try {
        const response = await fetch(`/api/customers/${encodeURIComponent(customerId)}/basicdata`, {
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
        return true;
      } catch (err) {
        console.error(err);
        setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
        showToastMessage(`Unable to update ${def.label}. Please try again.`, 'error');
        return false;
      } finally {
        setPendingFields((prev) => ({ ...prev, [def.id]: false }));
      }
    },
    [customerId],
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

  const openPricingPolicyModal = useCallback(() => {
    setNewPricingPolicyName('');
    setNewPricingPolicyEnabled('1');
    setPricingPolicyError(null);
    setNewPricingPolicyCalcMethod(calcMethodFormulas[0]?.value ?? '');
    setIsAddPricingPolicyOpen(true);
  }, [calcMethodFormulas]);

  const handleCreatePricingPolicy = useCallback(async () => {
    const trimmedName = newPricingPolicyName.trim();
    if (!trimmedName) {
      setPricingPolicyError('Name is required');
      return;
    }
    if (!newPricingPolicyCalcMethod) {
      setPricingPolicyError('Calc method formula is required');
      return;
    }
    setPricingPolicySaving(true);
    setPricingPolicyError(null);
    try {
      const response = await fetch('/api/pricing-policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmedName,
          enabled: newPricingPolicyEnabled === '1',
          calcMethodFormulasId: newPricingPolicyCalcMethod,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; option?: CustomerDropdownOption; error?: string }
        | null;
      const option = payload?.option;
      if (!response.ok || !payload?.ok || !option) {
        throw new Error(payload?.error ?? 'Unable to add pricing policy');
      }
      setPricingPolicyOptions((prev) => [...prev, option]);
      setValues((prev) => ({ ...prev, pricingPolicy: option.value }));
      showToastMessage('Pricing policy added', 'success');
      setIsAddPricingPolicyOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to add pricing policy';
      setPricingPolicyError(message);
      showToastMessage(message, 'error');
    } finally {
      setPricingPolicySaving(false);
    }
  }, [
    newPricingPolicyName,
    newPricingPolicyEnabled,
    newPricingPolicyCalcMethod,
    setValues,
  ]);

  const openCountryModal = useCallback(() => {
    setNewCountryName('');
    setNewCountryEnabled('1');
    setCountryError(null);
    setIsAddCountryOpen(true);
  }, []);

  const handleCreateCountry = useCallback(async () => {
    const trimmed = newCountryName.trim();
    if (!trimmed) {
      setCountryError('Name is required');
      return;
    }
    setCountrySaving(true);
    setCountryError(null);
    try {
      const response = await fetch('/api/countries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          enabled: newCountryEnabled === '1',
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; option?: CustomerDropdownOption; error?: string }
        | null;
      const option = payload?.option;
      if (!response.ok || !payload?.ok || !option) {
        throw new Error(payload?.error ?? 'Unable to add country');
      }
      setCountryOptions((prev) => [...prev, option]);
      setValues((prev) => ({ ...prev, country: option.value }));
      showToastMessage('Country added', 'success');
      setIsAddCountryOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to add country';
      setCountryError(message);
      showToastMessage(message, 'error');
    } finally {
      setCountrySaving(false);
    }
  }, [newCountryName, newCountryEnabled]);

  const openCityModal = useCallback(() => {
    setNewCityName('');
    setNewCityEnabled('1');
    setCityError(null);
    setIsAddCityOpen(true);
  }, []);

  const handleCreateCity = useCallback(async () => {
    const trimmed = newCityName.trim();
    if (!trimmed) {
      setCityError('Name is required');
      return;
    }
    if (!newCityCountryId) {
      setCityError('Country is required');
      return;
    }
    setCitySaving(true);
    setCityError(null);
    try {
      const response = await fetch('/api/cities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: trimmed,
          countryId: newCityCountryId,
          enabled: newCityEnabled === '1',
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; option?: DropdownOption & { countryId?: number | null }; error?: string }
        | null;
      const resultOption = payload?.option;
      if (!response.ok || !payload?.ok || !resultOption) {
        throw new Error(payload?.error ?? 'Unable to add city');
      }
      const option = {
        ...resultOption,
        countryId:
          resultOption.countryId ??
          (countryOptions.find((option) => option.value === newCityCountryId)
            ? Number(newCityCountryId)
            : null),
      };
      setCityOptions((prev) => [...prev, option]);
      setValues((prev) => ({ ...prev, city: option.value }));
      showToastMessage('City added', 'success');
      setIsAddCityOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to add city';
      setCityError(message);
      showToastMessage(message, 'error');
    } finally {
      setCitySaving(false);
    }
  }, [newCityName, newCityCountryId, newCityEnabled, countryOptions]);

  const renderLookupAddButton = useCallback(
    (fieldId: string) => {
      if (fieldId === 'pricingPolicy') {
        return (
          <button
            type="button"
            className={lookupButtonStyles.lookupAddButton}
            onClick={openPricingPolicyModal}
            disabled={calcMethodFormulas.length === 0 || pricingPolicySaving}
          >
            Add Pricing Policy
          </button>
        );
      }
      if (fieldId === 'country') {
        return (
          <button
            type="button"
            className={lookupButtonStyles.lookupAddButton}
            onClick={openCountryModal}
            disabled={countrySaving}
          >
            Add Country
          </button>
        );
      }
      if (fieldId === 'city') {
        return (
          <button
            type="button"
            className={lookupButtonStyles.lookupAddButton}
            onClick={openCityModal}
            disabled={citySaving || countryOptions.length === 0}
          >
            Add City
          </button>
        );
      }
      return null;
    },
    [
      calcMethodFormulas,
      countryOptions.length,
      openCityModal,
      openCountryModal,
      openPricingPolicyModal,
      pricingPolicySaving,
      countrySaving,
      citySaving,
    ],
  );

  const renderFieldControl = (def: FieldDefinition) => {
    const isEditable = Boolean(def.updateField && !def.readOnly);
    const controlId = `customer-field-${def.id}`;

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

    const isCityField = def.id === 'city';
    const filteredCityOptions = isCityField
      ? cityOptions.filter((option) => {
          if (option.countryId == null || !selectedCountryId) return false;
          return String(option.countryId) === selectedCountryId;
        })
      : [];
    const fieldOptions = isCityField ? filteredCityOptions : def.options ?? [];
    const shouldRenderSelect = isCityField || (fieldOptions && fieldOptions.length > 0);

    if (shouldRenderSelect) {
      const cityDisabled = isCityField && (!selectedCountryId || pending);
      const placeholderText = isCityField
        ? !selectedCountryId
          ? 'Select a country first'
          : filteredCityOptions.length > 0
            ? 'Select city...'
            : 'No cities available'
        : 'Select...';
      const cityStatusMessage =
        isCityField && !pending
          ? !selectedCountryId
            ? 'Select a country to choose a city.'
            : filteredCityOptions.length === 0
              ? 'No cities found for the selected country.'
              : null
          : null;
      return (
        <>
          <select
            id={controlId}
            name={def.id}
            className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
            value={value}
            disabled={cityDisabled}
            onChange={(event) => handleValueChange(def.id, event.target.value)}
            onBlur={() => handleBlur(def)}
          >
            <option value="">{placeholderText}</option>
            {(fieldOptions ?? []).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {cityStatusMessage ? <div className={styles.inlineHint}>{cityStatusMessage}</div> : null}
        </>
      );
    }

    if (def.comboBox && def.datalistOptions && def.datalistOptions.length > 0) {
      const search = value.trim().toLowerCase();
      const filteredOptions = search
        ? def.datalistOptions.filter((option) => {
            const label = option.label.toLowerCase();
            const val = option.value.toLowerCase();
            return label.includes(search) || val.includes(search);
          })
        : def.datalistOptions;
      const isOpen = openComboField === def.id;
      const errorMessage = comboErrors[def.id];
      const comboPlaceholder = def.id === 'country' ? 'Type to filter countries' : 'Type to filter options';
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
          const success = await saveField(def, latestValue);
          setComboErrors((prev) => {
            const next = { ...prev };
            if (success) {
              delete next[def.id];
            } else {
              next[def.id] = `Please choose a valid ${def.label.toLowerCase()}`;
            }
            return next;
          });
        })();
      };
      return (
        <div className={`${offerFormStyles.controlStack} ${offerFormStyles.comboWrapper}`}>
          <input
            autoComplete="off"
            id={controlId}
            name={def.id}
            className={`${offerPanelStyles.fieldControl} ${offerFormStyles.comboInput} ${pending ? styles.fieldControlPending : ''}`}
            value={value}
            placeholder={comboPlaceholder}
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
              setOpenComboField(def.id);
            }}
            onBlur={handleComboBlur}
          />
          {isOpen && filteredOptions.length > 0 ? (
            <div className={offerFormStyles.comboList}>
              {filteredOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={offerFormStyles.comboOption}
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
          {errorMessage ? <div className={offerFormStyles.fieldError}>{errorMessage}</div> : null}
        </div>
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

    return (
      <section key={sectionKey} className={`${styles.sectionCard} ${styles.detailSection}`}>
        <div className={styles.sectionHeading}>{metadata.title}</div>
        <div className={styles.sectionFields}>
          {sectionFields.map((field) => {
            const spanClass =
              field.span && field.span > 1 ? styles.fieldWide : field.span === -1 ? styles.fieldFull : '';
            return (
              <div key={field.id} className={`${styles.fieldBlock} ${spanClass}`}>
                <label className={styles.fieldLabel} htmlFor={`customer-field-${field.id}`}>
                  <div className={styles.labelRow}>
                    <div className={styles.labelText}>
                      {field.label}
                      {field.required ? <span className={styles.requiredMark}>*</span> : null}
                    </div>
                    {renderLookupAddButton(field.id)}
                  </div>
                </label>
                {renderFieldControl(field)}
                {field.hint ? <div className={styles.inlineHint}>{field.hint}</div> : null}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  useEffect(() => {
    const cityField = fieldDefinitions.find((field) => field.id === 'city');
    if (!cityField || !cityField.updateField) return;
    const currentCityValue = valuesRef.current?.[cityField.id] ?? '';
    if (!selectedCountryId) {
      if (currentCityValue) {
        setValues((prev) => ({ ...prev, [cityField.id]: '' }));
        void saveField(cityField, '');
      }
      return;
    }
    const allowedCityIds = cityOptions
      .filter((option) => option.countryId != null && String(option.countryId) === selectedCountryId)
      .map((option) => option.value);
    if (currentCityValue && !allowedCityIds.includes(currentCityValue)) {
      setValues((prev) => ({ ...prev, [cityField.id]: '' }));
      void saveField(cityField, '');
    }
  }, [cityOptions, fieldDefinitions, saveField, selectedCountryId]);

  const remainingSections = SECTION_ORDER.filter((section) => section !== 'general');

  return (
    <>
      <div className={styles.panel}>
        {renderSectionCard('general')}
        <div className={styles.sectionsGrid}>
          {remainingSections.map((section) => renderSectionCard(section))}
        </div>
      </div>
      <LookupModal
        open={isAddPricingPolicyOpen}
        title="Add Pricing Policy"
        onClose={() => setIsAddPricingPolicyOpen(false)}
        onConfirm={handleCreatePricingPolicy}
        confirmLabel="Create"
        saving={pricingPolicySaving}
        error={pricingPolicyError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-pricing-policy-name">
            Name
          </label>
          <input
            id="customer-pricing-policy-name"
            className={lookupStyles.fieldControl}
            value={newPricingPolicyName}
            onChange={(event) => setNewPricingPolicyName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-pricing-policy-calc">
            Calc method formula
          </label>
          <select
            id="customer-pricing-policy-calc"
            className={lookupStyles.fieldControl}
            value={newPricingPolicyCalcMethod}
            onChange={(event) => setNewPricingPolicyCalcMethod(event.target.value)}
          >
            <option value="">Select calc method formula</option>
            {calcMethodFormulas.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-pricing-policy-enabled">
            Enabled
          </label>
          <select
            id="customer-pricing-policy-enabled"
            className={lookupStyles.fieldControl}
            value={newPricingPolicyEnabled}
            onChange={(event) => setNewPricingPolicyEnabled(event.target.value)}
          >
            {BOOLEAN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </LookupModal>
      <LookupModal
        open={isAddCountryOpen}
        title="Add Country"
        onClose={() => setIsAddCountryOpen(false)}
        onConfirm={handleCreateCountry}
        confirmLabel="Create"
        saving={countrySaving}
        error={countryError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-country-name">
            Name
          </label>
          <input
            id="customer-country-name"
            className={lookupStyles.fieldControl}
            value={newCountryName}
            onChange={(event) => setNewCountryName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-country-enabled">
            Enabled
          </label>
          <select
            id="customer-country-enabled"
            className={lookupStyles.fieldControl}
            value={newCountryEnabled}
            onChange={(event) => setNewCountryEnabled(event.target.value)}
          >
            {BOOLEAN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </LookupModal>
      <LookupModal
        open={isAddCityOpen}
        title="Add City"
        onClose={() => setIsAddCityOpen(false)}
        onConfirm={handleCreateCity}
        confirmLabel="Create"
        saving={citySaving}
        error={cityError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-city-name">
            Name
          </label>
          <input
            id="customer-city-name"
            className={lookupStyles.fieldControl}
            value={newCityName}
            onChange={(event) => setNewCityName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-city-country">
            Country
          </label>
          <select
            id="customer-city-country"
            className={lookupStyles.fieldControl}
            value={newCityCountryId}
            onChange={(event) => setNewCityCountryId(event.target.value)}
          >
            <option value="">Select country</option>
            {countryOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="customer-city-enabled">
            Enabled
          </label>
          <select
            id="customer-city-enabled"
            className={lookupStyles.fieldControl}
            value={newCityEnabled}
            onChange={(event) => setNewCityEnabled(event.target.value)}
          >
            {BOOLEAN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </LookupModal>
    </>
  );
}
