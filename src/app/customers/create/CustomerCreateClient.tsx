'use client';

import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerDropdownOption } from '../[customerId]/CustomerBasicDataTypes';
import panelStyles from '../[customerId]/CustomerBasicDataPanel.module.css';
import styles from './CustomerCreateClient.module.css';
import lookupStyles from '../../components/LookupModal.module.css';
import LookupModal from '../../components/LookupModal';
import lookupButtonStyles from '../../components/LookupAddButton.module.css';
import { showToastMessage } from '../../../lib/toast';
import { useDuplicateCheck } from '../../lib/useDuplicateCheck';
import DuplicateWarning from '../../components/DuplicateWarning';
import { matchesCountrySearch } from '../../../lib/countryAliases';

type SectionKey = 'general' | 'business' | 'location' | 'contact' | 'notes';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  type?: 'text' | 'textarea' | 'select' | 'combobox';
  inputType?: string;
  required?: boolean;
  options?: CustomerDropdownOption[];
  span?: number;
  placeholder?: string;
  hint?: string;
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
    type: 'text',
    span: 2,
    required: true,
    placeholder: 'Customer name',
  },
  {
    id: 'brandName',
    label: 'Official Name',
    section: 'general',
    type: 'text',
    placeholder: 'Optional secondary name',
  },
  {
    id: 'customerGroup',
    label: 'Customer Group',
    section: 'general',
    type: 'select',
    options: customerGroups,
  },
  {
    id: 'parentCustomer',
    label: 'Parent Customer',
    section: 'general',
    type: 'select',
    options: parentCustomers,
  },
  {
    id: 'importance',
    label: 'Importance',
    section: 'general',
    type: 'select',
    options: importanceOptions,
    required: true,
  },
  {
    id: 'pricingPolicy',
    label: 'Pricing Policy',
    section: 'general',
    type: 'select',
    options: pricingPolicies,
    required: true,
  },
  {
    id: 'isParent',
    label: 'Is Parent',
    section: 'general',
    type: 'select',
    options: BOOLEAN_OPTIONS,
    placeholder: 'Select…',
  },
  {
    id: 'enabled',
    label: 'Enabled',
    section: 'general',
    type: 'select',
    options: BOOLEAN_OPTIONS,
    placeholder: 'Select…',
  },
  {
    id: 'taxId',
    label: 'Tax ID',
    section: 'business',
    type: 'text',
  },
  {
    id: 'taxOffice',
    label: 'Tax Office',
    section: 'business',
    type: 'text',
  },
  {
    id: 'profession',
    label: 'Profession',
    section: 'business',
    type: 'text',
  },

  {
    id: 'erp',
    label: 'ERP ID',
    section: 'business',
    type: 'text',
  },
  {
    id: 'address',
    label: 'Address',
    section: 'location',
    type: 'textarea',
    span: -1,
  },
  {
    id: 'country',
    label: 'Country',
    section: 'location',
    type: 'combobox',
    options: countries,
  },
  {
    id: 'city',
    label: 'City',
    section: 'location',
    type: 'text',
  },
  {
    id: 'phone',
    label: 'Phone',
    section: 'contact',
    type: 'text',
    inputType: 'tel',
  },
  {
    id: 'email',
    label: 'Email',
    section: 'contact',
    type: 'text',
    inputType: 'email',
  },
  {
    id: 'website',
    label: 'Website',
    section: 'contact',
    type: 'text',
    inputType: 'url',
  },
  {
    id: 'notes',
    label: 'Notes',
    section: 'notes',
    type: 'textarea',
    span: -1,
  },
];

const SECTION_ORDER: SectionKey[] = ['general', 'business', 'location', 'contact', 'notes'];

const toNullableString = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const toNumberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const toBooleanNumber = (value: string): number | null => {
  if (value === '1') return 1;
  if (value === '0') return 0;
  return null;
};

type Props = {
  customerGroups: CustomerDropdownOption[];
  parentCustomers: CustomerDropdownOption[];
  pricingPolicies: CustomerDropdownOption[];
  importanceOptions: CustomerDropdownOption[];
  countries: CustomerDropdownOption[];
  formId?: string;
};

type LookupKey =
  | 'customerGroups'
  | 'parentCustomers'
  | 'pricingPolicies'
  | 'importanceOptions'
  | 'countries';

type CustomerLookupsPayload = {
  customerGroups?: CustomerDropdownOption[];
  parentCustomers?: CustomerDropdownOption[];
  pricingPolicies?: CustomerDropdownOption[];
  importanceOptions?: CustomerDropdownOption[];
  countries?: CustomerDropdownOption[];
};

type CustomerLookupsResponse = {
  ok?: boolean;
  error?: string;
  lookups?: CustomerLookupsPayload;
};

const requiredFieldIds = ['name', 'pricingPolicy', 'importance'];
const LOOKUP_KEYS: LookupKey[] = [
  'customerGroups',
  'parentCustomers',
  'pricingPolicies',
  'importanceOptions',
  'countries',
];

const resolveDefaultPricingPolicyId = (options: CustomerDropdownOption[]): string => {
  const normalizedTarget = 'default pricing policy';
  const byLabel = options.find((opt) => (opt.label ?? '').trim().toLowerCase() === normalizedTarget);
  if (byLabel?.value) return byLabel.value;
  const byValue = options.find((opt) => (opt.value ?? '').trim().toLowerCase() === normalizedTarget);
  return byValue?.value ?? '';
};

export default function CustomerCreateClient({
  customerGroups,
  parentCustomers,
  pricingPolicies,
  importanceOptions,
  countries,
  formId = 'customer-create-form',
}: Props) {
  const router = useRouter();
  const [, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [localCustomerGroups, setLocalCustomerGroups] = useState(customerGroups);
  const [localParentCustomers, setLocalParentCustomers] = useState(parentCustomers);
  const [localPricingPolicies, setLocalPricingPolicies] = useState(pricingPolicies);
  const [localImportanceOptions, setLocalImportanceOptions] = useState(importanceOptions);
  const [countryOptions, setCountryOptions] = useState(countries);
  const [isAddCountryOpen, setIsAddCountryOpen] = useState(false);
  const [newCountryName, setNewCountryName] = useState('');
  const [newCountryEnabled, setNewCountryEnabled] = useState('1');
  const [countrySaving, setCountrySaving] = useState(false);
  const [countryError, setCountryError] = useState<string | null>(null);
  const [parentCustomerText, setParentCustomerText] = useState('');
  const [showParentCustomerList, setShowParentCustomerList] = useState(false);
  const [isParentCustomerEditing, setIsParentCustomerEditing] = useState(false);
  const parentListCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [countryText, setCountryText] = useState('');
  const [showCountryList, setShowCountryList] = useState(false);
  const countryListCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialValuesSyncedRef = useRef(false);
  const lookupRefreshInFlightRef = useRef(new Set<LookupKey>());

  const refreshLookups = useCallback(async (keys: LookupKey[]) => {
    const uniqueKeys = Array.from(new Set(keys));
    const pendingKeys = uniqueKeys.filter((key) => !lookupRefreshInFlightRef.current.has(key));
    if (pendingKeys.length === 0) return;
    pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.add(key));
    try {
      const search = new URLSearchParams();
      pendingKeys.forEach((key) => search.append('keys', key));
      const response = await fetch(`/api/customers/lookups?${search.toString()}`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as CustomerLookupsResponse | null;
      if (!response.ok || !payload?.ok || !payload.lookups) {
        throw new Error(payload?.error ?? 'Unable to refresh lookup options');
      }
      if (payload.lookups.customerGroups) setLocalCustomerGroups(payload.lookups.customerGroups);
      if (payload.lookups.parentCustomers) setLocalParentCustomers(payload.lookups.parentCustomers);
      if (payload.lookups.pricingPolicies) setLocalPricingPolicies(payload.lookups.pricingPolicies);
      if (payload.lookups.importanceOptions) setLocalImportanceOptions(payload.lookups.importanceOptions);
      if (payload.lookups.countries) setCountryOptions(payload.lookups.countries);
    } catch (err) {
      console.error(err);
    } finally {
      pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.delete(key));
    }
  }, []);

  const refreshFieldLookups = useCallback((fieldId: string) => {
    if (fieldId === 'customerGroup') {
      void refreshLookups(['customerGroups']);
      return;
    }
    if (fieldId === 'parentCustomer') {
      void refreshLookups(['parentCustomers']);
      return;
    }
    if (fieldId === 'pricingPolicy') {
      void refreshLookups(['pricingPolicies']);
      return;
    }
    if (fieldId === 'importance') {
      void refreshLookups(['importanceOptions']);
      return;
    }
    if (fieldId === 'country') {
      void refreshLookups(['countries']);
    }
  }, [refreshLookups]);

  const fieldDefinitions = useMemo(
    () =>
      buildFieldDefinitions(
        localCustomerGroups,
        localParentCustomers,
        localPricingPolicies,
        localImportanceOptions,
        countryOptions,
      ),
    [countryOptions, localCustomerGroups, localImportanceOptions, localParentCustomers, localPricingPolicies],
  );

  const initialValues = useMemo(() => {
    const defaultPricingPolicyId = resolveDefaultPricingPolicyId(localPricingPolicies);
    const next: Record<string, string> = {};
    fieldDefinitions.forEach((field) => {
      if (field.id === 'isParent') {
        next[field.id] = '0';
        return;
      }
      if (field.id === 'enabled') {
        next[field.id] = '1';
        return;
      }
      if (field.id === 'importance') {
        next[field.id] = field.options?.[0]?.value ?? '';
        return;
      }
      if (field.id === 'pricingPolicy') {
        next[field.id] = defaultPricingPolicyId;
        return;
      }
      next[field.id] = '';
    });
    return next;
  }, [fieldDefinitions, localPricingPolicies]);

  const [values, setValues] = useState(initialValues);
  const { warnings: duplicateWarnings, check: checkDuplicates } = useDuplicateCheck('customer');

  useEffect(() => {
    if (!initialValuesSyncedRef.current) {
      setValues(initialValues);
      initialValuesSyncedRef.current = true;
      return;
    }
    setValues((prev) => {
      if (prev.pricingPolicy || !initialValues.pricingPolicy) return prev;
      return { ...prev, pricingPolicy: initialValues.pricingPolicy };
    });
  }, [initialValues]);

  useEffect(() => {
    checkDuplicates({ name: values.name, taxId: values.taxId });
  }, [values.name, values.taxId, checkDuplicates]);

  useEffect(() => {
    setLocalCustomerGroups(customerGroups);
  }, [customerGroups]);

  useEffect(() => {
    setLocalParentCustomers(parentCustomers);
  }, [parentCustomers]);

  useEffect(() => {
    setLocalPricingPolicies(pricingPolicies);
  }, [pricingPolicies]);

  useEffect(() => {
    setLocalImportanceOptions(importanceOptions);
  }, [importanceOptions]);

  useEffect(() => {
    setCountryOptions(countries);
  }, [countries]);

  const clearParentListCloseTimer = useCallback(() => {
    if (parentListCloseTimerRef.current) {
      clearTimeout(parentListCloseTimerRef.current);
      parentListCloseTimerRef.current = null;
    }
  }, []);

  const clearCountryListCloseTimer = useCallback(() => {
    if (countryListCloseTimerRef.current) {
      clearTimeout(countryListCloseTimerRef.current);
      countryListCloseTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearParentListCloseTimer();
      clearCountryListCloseTimer();
    },
    [clearParentListCloseTimer, clearCountryListCloseTimer],
  );

  useEffect(() => {
    let active = true;

    const loadLookups = async () => {
      try {
        const params = new URLSearchParams();
        LOOKUP_KEYS.forEach((key) => params.append('keys', key));
        const response = await fetch(`/api/customers/lookups?${params.toString()}`, { cache: 'no-store' });
        const payload = (await response.json().catch(() => null)) as CustomerLookupsResponse | null;
        if (!response.ok || !payload?.ok || !payload.lookups) {
          throw new Error(payload?.error ?? 'Unable to load customer lookups.');
        }
        if (!active) return;
        setLocalCustomerGroups(
          Array.isArray(payload.lookups.customerGroups) ? payload.lookups.customerGroups : [],
        );
        setLocalParentCustomers(
          Array.isArray(payload.lookups.parentCustomers) ? payload.lookups.parentCustomers : [],
        );
        setLocalPricingPolicies(
          Array.isArray(payload.lookups.pricingPolicies) ? payload.lookups.pricingPolicies : [],
        );
        setLocalImportanceOptions(
          Array.isArray(payload.lookups.importanceOptions) ? payload.lookups.importanceOptions : [],
        );
        setCountryOptions(Array.isArray(payload.lookups.countries) ? payload.lookups.countries : []);
      } catch (err) {
        if (!active) return;
        console.error('Failed to load create-customer lookups', err);
        showToastMessage('Unable to load customer lookups.', 'warning');
      }
    };

    void loadLookups();
    return () => {
      active = false;
    };
  }, []);


  useEffect(() => {
    if (isParentCustomerEditing) return;
    const selectedValue = values.parentCustomer ?? '';
    if (!selectedValue) {
      setParentCustomerText((prev) => (prev ? '' : prev));
      return;
    }
    const selectedOption = localParentCustomers.find((option) => option.value === selectedValue);
    const nextText = selectedOption?.label ?? selectedValue;
    setParentCustomerText((prev) => (prev === nextText ? prev : nextText));
  }, [isParentCustomerEditing, localParentCustomers, values.parentCustomer]);

  const filteredParentCustomers = useMemo(() => {
    const search = parentCustomerText.trim().toLowerCase();
    if (!search) return localParentCustomers;
    return localParentCustomers.filter((option) => {
      const label = option.label?.toLowerCase() ?? '';
      const value = option.value?.toLowerCase() ?? '';
      return label.includes(search) || value.includes(search);
    });
  }, [localParentCustomers, parentCustomerText]);

  const filteredCountries = useMemo(() => {
    const search = countryText.trim();
    if (!search) return countryOptions;
    return countryOptions.filter((option) => matchesCountrySearch(option.label, search));
  }, [countryOptions, countryText]);

  const handleCountryInputChange = useCallback((text: string) => {
    clearCountryListCloseTimer();
    setCountryText(text);
    setShowCountryList(true);
    const normalized = text.trim().toLowerCase();
    const exactMatch = normalized
      ? countryOptions.find((opt) => (opt.label?.trim().toLowerCase() ?? '') === normalized)
      : null;
    setValues((prev) => ({ ...prev, country: exactMatch?.value ?? '' }));
    setErrors((prev) => {
      if (!prev.country) return prev;
      const next = { ...prev };
      delete next.country;
      return next;
    });
  }, [clearCountryListCloseTimer, countryOptions]);

  const handleCountrySelect = useCallback((option: CustomerDropdownOption) => {
    clearCountryListCloseTimer();
    setCountryText(option.label);
    setShowCountryList(false);
    setValues((prev) => ({ ...prev, country: option.value }));
    setErrors((prev) => {
      if (!prev.country) return prev;
      const next = { ...prev };
      delete next.country;
      return next;
    });
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
      setValues((prev) => ({ ...prev, country: '' }));
      return;
    }
    const match = countryOptions.find(
      (opt) => (opt.label?.trim().toLowerCase() ?? '') === trimmed.toLowerCase(),
    );
    if (match) {
      setCountryText(match.label);
      setValues((prev) => ({ ...prev, country: match.value }));
    } else {
      const selectedOption = countryOptions.find((opt) => opt.value === values.country);
      setCountryText(selectedOption?.label ?? '');
    }
  }, [clearCountryListCloseTimer, countryOptions, countryText, values.country]);

  const handleChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    setErrors((prev) => {
      if (!prev[fieldId]) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }, []);

  const findParentCustomerOption = useCallback((text: string): CustomerDropdownOption | null => {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return null;
    return localParentCustomers.find((option) => {
      const label = option.label?.trim().toLowerCase() ?? '';
      const value = option.value?.trim().toLowerCase() ?? '';
      return label === normalized || value === normalized;
    }) ?? null;
  }, [localParentCustomers]);

  const setParentCustomerSelection = useCallback((option: CustomerDropdownOption | null, text: string) => {
    setParentCustomerText(text);
    setValues((prev) => ({ ...prev, parentCustomer: option?.value ?? '' }));
    setShowParentCustomerList(false);
    setErrors((prev) => {
      if (!prev.parentCustomer) return prev;
      const next = { ...prev };
      delete next.parentCustomer;
      return next;
    });
  }, []);

  const handleParentCustomerInputChange = useCallback((text: string) => {
    clearParentListCloseTimer();
    setParentCustomerText(text);
    setShowParentCustomerList(true);
    const exactMatch = findParentCustomerOption(text);
    setValues((prev) => ({ ...prev, parentCustomer: exactMatch?.value ?? '' }));
    setErrors((prev) => {
      if (!prev.parentCustomer) return prev;
      const next = { ...prev };
      delete next.parentCustomer;
      return next;
    });
  }, [clearParentListCloseTimer, findParentCustomerOption]);

  const handleParentCustomerBlur = useCallback(() => {
    setIsParentCustomerEditing(false);
    clearParentListCloseTimer();
    parentListCloseTimerRef.current = setTimeout(() => {
      setShowParentCustomerList(false);
      parentListCloseTimerRef.current = null;
    }, 120);
    const trimmed = parentCustomerText.trim();
    if (!trimmed) {
      setParentCustomerSelection(null, '');
      return;
    }
    const match = findParentCustomerOption(trimmed);
    if (!match) {
      const selectedOption = localParentCustomers.find((option) => option.value === values.parentCustomer);
      setParentCustomerText(selectedOption?.label ?? '');
      return;
    }
    setParentCustomerSelection(match, match.label);
  }, [
    clearParentListCloseTimer,
    findParentCustomerOption,
    localParentCustomers,
    parentCustomerText,
    setParentCustomerSelection,
    values.parentCustomer,
  ]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const nextErrors: Record<string, string> = {};
      requiredFieldIds.forEach((field) => {
        const value = values[field] ?? '';
        if (!value.trim()) {
          nextErrors[field] = 'Required';
        }
      });
      if (Object.keys(nextErrors).length > 0) {
        setErrors(nextErrors);
        showToastMessage('Please fill all required fields.', 'error');
        return;
      }

      const payload = {
        name: values.name.trim(),
        brandName: toNullableString(values.brandName),
        taxId: toNullableString(values.taxId),
        taxOffice: toNullableString(values.taxOffice),
        profession: toNullableString(values.profession),
        customerGroupId: toNumberOrNull(values.customerGroup),

        erpId: toNullableString(values.erp),
        isParent: toBooleanNumber(values.isParent) ?? 0,
        parentCustomerId: toNumberOrNull(values.parentCustomer),
        pricingPolicyId: toNumberOrNull(values.pricingPolicy),
        importance: values.importance.trim(),
        enabled: toBooleanNumber(values.enabled) ?? 1,
        address: toNullableString(values.address),
        countryId: toNumberOrNull(values.country),
        city: values.city.trim() || null,
        phone: toNullableString(values.phone),
        email: toNullableString(values.email),
        webSite: toNullableString(values.website),
        notes: toNullableString(values.notes),
      };

      setSubmitting(true);
      try {
        const response = await fetch('/api/customers/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = (await response.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          customerId?: number;
        } | null;
        if (!response.ok || !data?.ok || !data.customerId) {
          throw new Error(data?.error ?? 'Unable to add customer');
        }
        showToastMessage('Customer added', 'success');
        router.push(`/customers/${encodeURIComponent(String(data.customerId))}/contacts`);
      } catch (err) {
        console.error(err);
        showToastMessage(err instanceof Error ? err.message : 'Unable to add customer.', 'error');
      } finally {
        setSubmitting(false);
      }
    },
    [router, values],
  );

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

  const renderLookupAddButton = useCallback(
    (fieldId: string) => {
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
      return null;
    },
    [
      openCountryModal,
      countrySaving,
    ],
  );

  const renderFieldControl = (field: FieldDefinition) => {
    const value = values[field.id] ?? '';
    const fieldError = errors[field.id];
    const hasError = Boolean(fieldError);
    const showErrorText = typeof fieldError === 'string' && fieldError.length > 0 && fieldError !== 'Required';
    const className = `${panelStyles.fieldControl} ${hasError ? panelStyles.fieldControlError : ''}`;

    if (field.id === 'parentCustomer') {
      return (
        <div className={`${styles.controlStack} ${styles.comboWrapper}`}>
          <input
            autoComplete="off"
            id={`customer-create-${field.id}`}
            name={field.id}
            className={`${className} ${styles.comboInput}`}
            value={parentCustomerText}
            placeholder="Type to filter parent customers"
            onChange={(event) => handleParentCustomerInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && showParentCustomerList && filteredParentCustomers.length > 0) {
                event.preventDefault();
                clearParentListCloseTimer();
                setParentCustomerSelection(filteredParentCustomers[0], filteredParentCustomers[0].label);
              }
            }}
            onBlur={handleParentCustomerBlur}
            onFocus={(event) => {
              setIsParentCustomerEditing(true);
              clearParentListCloseTimer();
              event.target.select();
              setShowParentCustomerList(true);
              refreshFieldLookups('parentCustomer');
            }}
          />
          {showParentCustomerList && filteredParentCustomers.length > 0 ? (
            <div className={styles.comboList}>
              {filteredParentCustomers.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.comboOption}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    clearParentListCloseTimer();
                    setParentCustomerSelection(option, option.label);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {showErrorText ? <div className={styles.fieldError}>{fieldError}</div> : null}
        </div>
      );
    }

    if (field.type === 'combobox') {
      const filtered = filteredCountries;
      return (
        <div className={`${styles.controlStack} ${styles.comboWrapper}`}>
          <input
            autoComplete="off"
            id={`customer-create-${field.id}`}
            name={field.id}
            className={`${className} ${styles.comboInput}`}
            value={countryText}
            placeholder="Type to filter countries"
            onChange={(event) => handleCountryInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && showCountryList && filtered.length > 0) {
                event.preventDefault();
                handleCountrySelect(filtered[0]);
              }
            }}
            onBlur={handleCountryBlur}
            onFocus={(event) => {
              clearCountryListCloseTimer();
              event.target.select();
              setShowCountryList(true);
              refreshFieldLookups('country');
            }}
          />
          {showCountryList && filtered.length > 0 ? (
            <div className={styles.comboList}>
              {filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.comboOption}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleCountrySelect(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {showErrorText ? <div className={styles.fieldError}>{fieldError}</div> : null}
        </div>
      );
    }

    if (field.type === 'select') {
      const options = field.options ?? [];
      const showEmptyOption = field.id !== 'importance' || options.length === 0;

      return (
        <>
          <select
            id={`customer-create-${field.id}`}
            name={field.id}
            className={className}
            value={value}
            required={Boolean(field.required)}
            aria-invalid={hasError}
            onMouseDown={() => refreshFieldLookups(field.id)}
            onFocus={() => refreshFieldLookups(field.id)}
            onChange={(event) => handleChange(field.id, event.target.value)}
          >
            {showEmptyOption ? <option value="">Select...</option> : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {showErrorText ? <div className={styles.fieldError}>{fieldError}</div> : null}
        </>
      );
    }

    if (field.type === 'textarea') {
      return (
        <>
          <textarea
            id={`customer-create-${field.id}`}
            name={field.id}
            className={`${className} ${panelStyles.fieldControlMultiline}`}
            value={value}
            placeholder={field.placeholder}
            required={Boolean(field.required)}
            aria-invalid={hasError}
            onChange={(event) => handleChange(field.id, event.target.value)}
          />
          {showErrorText ? <div className={styles.fieldError}>{fieldError}</div> : null}
        </>
      );
    }

    return (
      <>
        <input
          id={`customer-create-${field.id}`}
          name={field.id}
          className={className}
          type={field.inputType ?? 'text'}
          value={value}
          placeholder={field.placeholder}
          required={Boolean(field.required)}
          aria-invalid={hasError}
          onChange={(event) => handleChange(field.id, event.target.value)}
        />
        {showErrorText ? <div className={styles.fieldError}>{fieldError}</div> : null}
      </>
    );
  };

  const renderSectionCard = (sectionKey: SectionKey) => {
    const metadata = SECTION_METADATA[sectionKey];
    const sectionFields = fieldDefinitions.filter((field) => field.section === sectionKey);
    if (!metadata || sectionFields.length === 0) return null;

    return (
      <section key={sectionKey} className={`${panelStyles.sectionCard} ${panelStyles.detailSection}`}>
        <div className={panelStyles.sectionHeading}>{metadata.title}</div>
        <div className={panelStyles.sectionFields}>
          {sectionFields.map((field) => {
            const spanClass =
              field.span && field.span > 1
                ? panelStyles.fieldWide
                : field.span === -1
                  ? panelStyles.fieldFull
                  : '';
            const lookupButton = renderLookupAddButton(field.id);
            const hasLookupButton = Boolean(lookupButton);
            return (
              <div key={field.id} className={`${panelStyles.fieldBlock} ${spanClass}`}>
                {hasLookupButton ? (
                  <div className={styles.fieldHeaderWithLookup}>
                    <label className={panelStyles.fieldLabel} htmlFor={`customer-create-${field.id}`}>
                      <div className={styles.labelText}>
                        {field.label}
                        {field.required ? <span className={styles.requiredMark}>*</span> : null}
                      </div>
                    </label>
                    <div className={styles.lookupButtonRaised}>{lookupButton}</div>
                  </div>
                ) : (
                  <label className={panelStyles.fieldLabel} htmlFor={`customer-create-${field.id}`}>
                    <div className={styles.labelText}>
                      {field.label}
                      {field.required ? <span className={styles.requiredMark}>*</span> : null}
                    </div>
                  </label>
                )}
                {renderFieldControl(field)}
                {field.hint ? <div className={panelStyles.inlineHint}>{field.hint}</div> : null}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const remainingSections = SECTION_ORDER.filter((section) => section !== 'general');

  return (
    <>
      <form
        id={formId}
        className={styles.form}
        onSubmit={handleSubmit}
        autoComplete="off"
        noValidate
        data-show-validation={Object.keys(errors).length > 0 ? 'true' : 'false'}
      >
        <section className={panelStyles.panel}>
          {renderSectionCard('general')}
          <DuplicateWarning warnings={duplicateWarnings} />
          <div className={panelStyles.sectionsGrid}>
            {remainingSections.map((section) => renderSectionCard(section))}
          </div>
        </section>
      </form>
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
          <label className={lookupStyles.fieldLabel} htmlFor="new-country-name">
            Name
          </label>
          <input
            id="new-country-name"
            className={lookupStyles.fieldControl}
            value={newCountryName}
            required
            onChange={(event) => setNewCountryName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="new-country-enabled">
            Enabled
          </label>
          <select
            id="new-country-enabled"
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
    </>
  );
}
