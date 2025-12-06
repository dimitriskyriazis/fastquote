'use client';

import { useMemo, useState, useCallback, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import type { CustomerCityOption, CustomerDropdownOption } from '../[customerId]/CustomerBasicDataTypes';
import panelStyles from '../[customerId]/CustomerBasicDataPanel.module.css';
import styles from './CustomerCreateClient.module.css';
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
  formId?: string;
};

const requiredFieldIds = ['name', 'pricingPolicy', 'importance'];

export default function CustomerCreateClient({
  customerGroups,
  parentCustomers,
  pricingPolicies,
  importanceOptions,
  countries,
  cities,
  formId = 'customer-create-form',
}: Props) {
  const router = useRouter();
  const [, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const fieldDefinitions = useMemo(
    () =>
      buildFieldDefinitions(
        customerGroups,
        parentCustomers,
        pricingPolicies,
        importanceOptions,
        countries,
      ),
    [customerGroups, parentCustomers, pricingPolicies, importanceOptions, countries],
  );

  const initialValues = useMemo(() => {
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
      next[field.id] = '';
    });
    return next;
  }, [fieldDefinitions]);

  const [values, setValues] = useState(initialValues);

  useEffect(() => {
    setValues(initialValues);
  }, [initialValues]);

  const selectedCountryId = values.country ?? '';

  const filteredCityOptions = useMemo(
    () =>
      cities.filter((city) => {
        if (!selectedCountryId) return false;
        return city.countryId != null && String(city.countryId) === selectedCountryId;
      }),
    [cities, selectedCountryId],
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

  const renderFieldControl = (field: FieldDefinition) => {
    const value = values[field.id] ?? '';
    const fieldError = errors[field.id];
    const hasError = Boolean(fieldError);
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

      return (
        <>
          <select
            id={`customer-create-${field.id}`}
            name={field.id}
            className={className}
            value={value}
            disabled={isDisabled}
            onChange={(event) => handleChange(field.id, event.target.value)}
          >
            <option value="">{placeholder}</option>
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
          {fieldError ? <div className={styles.fieldError}>{fieldError}</div> : null}
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
            onChange={(event) => handleChange(field.id, event.target.value)}
          />
          {fieldError ? <div className={styles.fieldError}>{fieldError}</div> : null}
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
          onChange={(event) => handleChange(field.id, event.target.value)}
        />
        {fieldError ? <div className={styles.fieldError}>{fieldError}</div> : null}
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
            return (
              <div key={field.id} className={`${panelStyles.fieldBlock} ${spanClass}`}>
                <label className={panelStyles.fieldLabel} htmlFor={`customer-create-${field.id}`}>
                  {field.label}
                  {field.required ? <span className={styles.requiredMark}>*</span> : null}
                </label>
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
    <form id={formId} className={styles.form} onSubmit={handleSubmit} autoComplete="off">
      <section className={panelStyles.panel}>
        {renderSectionCard('general')}
        <div className={panelStyles.sectionsGrid}>
          {remainingSections.map((section) => renderSectionCard(section))}
        </div>
      </section>
    </form>
  );
}
