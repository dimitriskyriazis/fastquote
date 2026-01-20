'use client';

import { useMemo, useState, useCallback, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerCityOption, CustomerDropdownOption } from '../[customerId]/CustomerBasicDataTypes';
import type { DropdownOption } from '../../../lib/dropdownOptions';
import panelStyles from '../[customerId]/CustomerBasicDataPanel.module.css';
import styles from './CustomerCreateClient.module.css';
import lookupStyles from '../../components/LookupModal.module.css';
import LookupModal from '../../components/LookupModal';
import lookupButtonStyles from '../../components/LookupAddButton.module.css';
import { showToastMessage } from '../../../lib/toast';

type SectionKey = 'general' | 'business' | 'location' | 'contact' | 'notes';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  type?: 'text' | 'textarea' | 'select';
  inputType?: string;
  required?: boolean;
  options?: CustomerDropdownOption[];
  span?: number;
  placeholder?: string;
  hint?: string;
  dependsOnCountry?: boolean;
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
    label: 'Brand Name',
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
    id: 'activityCode',
    label: 'Activity Code',
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
    type: 'select',
    options: countries,
  },
  {
    id: 'city',
    label: 'City',
    section: 'location',
    type: 'select',
    dependsOnCountry: true,
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
  cities: CustomerCityOption[];
  calcMethodFormulas: DropdownOption[];
  formId?: string;
};

const requiredFieldIds = ['name', 'pricingPolicy', 'importance'];

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
  cities,
  calcMethodFormulas,
  formId = 'customer-create-form',
}: Props) {
  const router = useRouter();
  const [, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pricingPolicyOptions, setPricingPolicyOptions] = useState(pricingPolicies);
  const [countryOptions, setCountryOptions] = useState(countries);
  const [cityOptions, setCityOptions] = useState(cities);
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

  const initialValues = useMemo(() => {
    const defaultPricingPolicyId = resolveDefaultPricingPolicyId(pricingPolicyOptions);
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
  }, [fieldDefinitions, pricingPolicyOptions]);

  const [values, setValues] = useState(initialValues);

  useEffect(() => {
    setValues(initialValues);
  }, [initialValues]);

  useEffect(() => {
    setPricingPolicyOptions(pricingPolicies);
  }, [pricingPolicies]);

  useEffect(() => {
    setCountryOptions(countries);
  }, [countries]);

  useEffect(() => {
    setCityOptions(cities);
  }, [cities]);

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

  const filteredCityOptions = useMemo(
    () =>
      cityOptions.filter((city) => {
        if (!selectedCountryId) return false;
        return city.countryId != null && String(city.countryId) === selectedCountryId;
      }),
    [cityOptions, selectedCountryId],
  );

  useEffect(() => {
    if (!values.city) return;
    if (!filteredCityOptions.some((option) => option.value === values.city)) {
      setValues((prev) => ({ ...prev, city: '' }));
    }
  }, [filteredCityOptions, values.city]);

  const handleChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    setErrors((prev) => {
      if (!prev[fieldId]) return prev;
      const next = { ...prev };
      delete next[fieldId];
      return next;
    });
  }, []);

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
        activityCode: toNullableString(values.activityCode),
        erpId: toNullableString(values.erp),
        isParent: toBooleanNumber(values.isParent) ?? 0,
        parentCustomerId: toNumberOrNull(values.parentCustomer),
        pricingPolicyId: toNumberOrNull(values.pricingPolicy),
        importance: values.importance.trim(),
        enabled: toBooleanNumber(values.enabled) ?? 1,
        address: toNullableString(values.address),
        countryId: toNumberOrNull(values.country),
        cityId: toNumberOrNull(values.city),
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
  }, [newPricingPolicyName, newPricingPolicyEnabled, newPricingPolicyCalcMethod]);

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
      const baseOption = payload?.option;
      if (!response.ok || !payload?.ok || !baseOption) {
        throw new Error(payload?.error ?? 'Unable to add city');
      }
      const option = {
        ...baseOption,
        countryId:
          baseOption.countryId ??
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
            Add new
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

  const renderFieldControl = (field: FieldDefinition) => {
    const value = values[field.id] ?? '';
    const fieldError = errors[field.id];
    const hasError = Boolean(fieldError);
    const showErrorText = typeof fieldError === 'string' && fieldError.length > 0 && fieldError !== 'Required';
    const className = `${panelStyles.fieldControl} ${hasError ? panelStyles.fieldControlError : ''}`;

    if (field.type === 'select') {
      const options = field.id === 'city' ? filteredCityOptions : field.options ?? [];
      const placeholder = field.dependsOnCountry
        ? !selectedCountryId
          ? 'Select a country first'
          : filteredCityOptions.length > 0
            ? 'Select city...'
            : 'No cities available'
        : 'Select...';
      const isDisabled = field.dependsOnCountry ? !selectedCountryId : false;
      const showEmptyOption = field.id !== 'importance' || options.length === 0;

      return (
        <>
          <select
            id={`customer-create-${field.id}`}
            name={field.id}
            className={className}
            value={value}
            disabled={isDisabled}
            required={Boolean(field.required)}
            aria-invalid={hasError}
            onChange={(event) => handleChange(field.id, event.target.value)}
          >
            {showEmptyOption ? <option value="">{placeholder}</option> : null}
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {field.dependsOnCountry && !fieldError ? (
            <div className={panelStyles.inlineHint}>
              {!selectedCountryId
                ? 'Select a country to choose a city.'
                : filteredCityOptions.length === 0
                  ? 'No cities found for the selected country.'
                  : null}
            </div>
          ) : null}
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
            const pricingPolicyNudgeClass = field.id === 'pricingPolicy' ? styles.pricingPolicyNudgeUp : '';
            return (
              <div key={field.id} className={`${panelStyles.fieldBlock} ${spanClass} ${pricingPolicyNudgeClass}`}>
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
          <div className={panelStyles.sectionsGrid}>
            {remainingSections.map((section) => renderSectionCard(section))}
          </div>
        </section>
      </form>
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
          <label className={lookupStyles.fieldLabel} htmlFor="new-pricing-policy-name">
            Name
          </label>
          <input
            id="new-pricing-policy-name"
            className={lookupStyles.fieldControl}
            value={newPricingPolicyName}
            required
            onChange={(event) => setNewPricingPolicyName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="new-pricing-policy-calc">
            Calc method formula
          </label>
          <select
            id="new-pricing-policy-calc"
            className={lookupStyles.fieldControl}
            value={newPricingPolicyCalcMethod}
            required
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
          <label className={lookupStyles.fieldLabel} htmlFor="new-pricing-policy-enabled">
            Enabled
          </label>
          <select
            id="new-pricing-policy-enabled"
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
          <label className={lookupStyles.fieldLabel} htmlFor="new-city-name">
            Name
          </label>
          <input
            id="new-city-name"
            className={lookupStyles.fieldControl}
            value={newCityName}
            required
            onChange={(event) => setNewCityName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="new-city-country">
            Country
          </label>
          <select
            id="new-city-country"
            className={lookupStyles.fieldControl}
            value={newCityCountryId}
            required
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
          <label className={lookupStyles.fieldLabel} htmlFor="new-city-enabled">
            Enabled
          </label>
          <select
            id="new-city-enabled"
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
