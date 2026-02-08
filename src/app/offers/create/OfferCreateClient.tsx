'use client';

import { useState, useMemo, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DropdownOption } from '../../../lib/dropdownOptions';
import { showToastMessage } from '../../../lib/toast';
import panelStyles from '../[offerId]/OfferBasicDataPanel.module.css';
import styles from './OfferCreateClient.module.css';
import UKDatePicker from '../../components/DatePicker';

type SectionKey = 'general' | 'info' | 'commercial' | 'code' | 'dates';

type FormValues = {
  title: string;
  description: string;
  paymentTerms: string;
  deliveryTime: string;
  offerValidity: string;
  installationSchedule: string;
  closingNote: string;
  introNote: string;
  telmacoNote: string;
  customerId: string;
  contactId: string;
  statusId: string;
  pricingPolicyId: string;
  marketId: string;
  salesDivisionId: string;
  salesCreationPersonId: string;
  salesPersonId: string;
  approvalUserId: string;
  projectId: string;
  erpFwcProjectId: string;
  customerRef: string;
  initialRequest: string;
  draftOffer: string;
  officialRequest: string;
  offerDeadline: string;
  officialQuoteOffer: string;
  orderSigned: string;
  deliveryDue: string;
  delivery: string;
  offerDate: string;
};

type FieldConfig = {
  id: keyof FormValues;
  label: string;
  section: SectionKey;
  type?: 'text' | 'textarea' | 'select' | 'date';
  required?: boolean;
  options?: DropdownOption[];
  fullWidth?: boolean;
  inputType?: string;
  readOnly?: boolean;
  span?: number;
  dependsOnCustomer?: boolean;
};

type OfferCreateDefaults = {
  deliveryTime: string;
  paymentTerms: string;
  offerValidity: string;
  suggestedUserId?: string;
};

export type MarketOption = DropdownOption & { salesDivisionId: string | null };

type Props = {
  customers: DropdownOption[];
  statuses: DropdownOption[];
  pricingPolicies: DropdownOption[];
  markets: MarketOption[];
  salesDivisions: DropdownOption[];
  users: DropdownOption[];
  fwcProjects: DropdownOption[];
  defaultValues: OfferCreateDefaults;
  formId?: string;
};

const SECTION_METADATA: Record<SectionKey, { title: string; gridClass: string }> = {
  general: { title: 'General', gridClass: panelStyles.generalGrid },
  info: { title: 'Info', gridClass: panelStyles.fieldGrid },
  commercial: { title: 'Commercial', gridClass: panelStyles.fieldGrid },
  code: { title: 'Code Number', gridClass: panelStyles.fieldGrid },
  dates: { title: 'Dates', gridClass: panelStyles.fieldGrid },
};

const requiredFieldIds: Array<keyof FormValues> = [
  'title',
  'deliveryTime',
  'description',
  'paymentTerms',
  'customerId',
  'offerValidity',
  'statusId',
  'contactId',
  'pricingPolicyId',
  'marketId',
  'salesDivisionId',
  'salesCreationPersonId',
];

const toNumberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const toNullableString = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

const resolveDefaultPricingPolicyId = (options: DropdownOption[]): string => {
  const normalizedTarget = 'default pricing policy';
  const byLabel = options.find((opt) => (opt.label ?? '').trim().toLowerCase() === normalizedTarget);
  if (byLabel?.value) return byLabel.value;
  const byValue = options.find((opt) => (opt.value ?? '').trim().toLowerCase() === normalizedTarget);
  return byValue?.value ?? '';
};

const resolveDefaultStatusId = (options: DropdownOption[]): string => {
  const normalizedTarget = 'draft offer';
  const byLabel = options.find((opt) => (opt.label ?? '').trim().toLowerCase() === normalizedTarget);
  if (byLabel?.value) return byLabel.value;
  const byValue = options.find((opt) => (opt.value ?? '').trim().toLowerCase() === normalizedTarget);
  return byValue?.value ?? '';
};

export default function OfferCreateClient({
  customers,
  statuses,
  pricingPolicies,
  markets,
  salesDivisions,
  users,
  fwcProjects,
  defaultValues,
  formId = 'offer-create-form',
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [contactOptions, setContactOptions] = useState<DropdownOption[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactLoadError, setContactLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [customerText, setCustomerText] = useState('');
  const [showCustomerList, setShowCustomerList] = useState(false);
  const lastCustomerRef = useRef<string>('');
  const listCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const appliedCustomerParamRef = useRef(false);
  const initialCustomerIdParam = (searchParams?.get('customerId') ?? '').trim();

  const defaultPricingPolicyId = useMemo(
    () => resolveDefaultPricingPolicyId(pricingPolicies),
    [pricingPolicies],
  );

  const defaultStatusId = useMemo(() => resolveDefaultStatusId(statuses), [statuses]);

  const initialValues = useMemo<FormValues>(() => ({
    title: 'Financial Proposal',
    description: '',
    paymentTerms: defaultValues.paymentTerms ?? '',
    deliveryTime: defaultValues.deliveryTime ?? '',
    offerValidity: defaultValues.offerValidity ?? '',
    installationSchedule: '',
    closingNote: '',
    introNote: '',
    telmacoNote: '',
    customerId: '',
    contactId: '',
    statusId: defaultStatusId,
    pricingPolicyId: defaultPricingPolicyId,
    marketId: '',
    salesDivisionId: '',
    salesCreationPersonId: defaultValues.suggestedUserId ?? '',
    salesPersonId: defaultValues.suggestedUserId ?? '',
    approvalUserId: '',
    projectId: '0',
    erpFwcProjectId: '',
    customerRef: '',
    initialRequest: '',
    draftOffer: '',
    officialRequest: '',
    offerDeadline: '',
    officialQuoteOffer: '',
    orderSigned: '',
    deliveryDue: '',
    delivery: '',
    offerDate: '',
  }), [defaultPricingPolicyId, defaultStatusId, defaultValues]);

  const [values, setValues] = useState<FormValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const [localPricingPolicies, setLocalPricingPolicies] = useState(pricingPolicies);
  useEffect(() => {
    setLocalPricingPolicies(pricingPolicies);
  }, [pricingPolicies]);

  const salesDivisionLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    salesDivisions.forEach((division) => {
      if (!division?.value) return;
      const label = division.label?.trim();
      if (!label) return;
      map.set(division.value, label);
    });
    return map;
  }, [salesDivisions]);

  const marketsWithDivisionLabel = useMemo(() => {
    return markets.map((market) => {
      const divisionLabel = market.salesDivisionId
        ? salesDivisionLabelMap.get(market.salesDivisionId) ?? ''
        : '';
      const label = divisionLabel ? `${market.label} - ${divisionLabel}` : market.label;
      return { ...market, label };
    });
  }, [markets, salesDivisionLabelMap]);

  const filteredMarkets = useMemo(() => {
    if (!values.salesDivisionId) return marketsWithDivisionLabel;
    return marketsWithDivisionLabel.filter(
      (market) => market.salesDivisionId === values.salesDivisionId,
    );
  }, [marketsWithDivisionLabel, values.salesDivisionId]);

  const marketDivisionMap = useMemo(() => {
    const map = new Map<string, string>();
    markets.forEach((market) => {
      if (!market || !market.value) return;
      map.set(market.value, market.salesDivisionId ?? '');
    });
    return map;
  }, [markets]);

  const lastMarketSelectionRef = useRef<string>('');
  useEffect(() => {
    const marketId = values.marketId;
    if (marketId === lastMarketSelectionRef.current) return;
    lastMarketSelectionRef.current = marketId;
    const defaultDivision = marketId ? marketDivisionMap.get(marketId) ?? '' : '';
    setValues((prev) => {
      if (prev.salesDivisionId === defaultDivision) return prev;
      return { ...prev, salesDivisionId: defaultDivision };
    });
  }, [marketDivisionMap, values.marketId]);

  useEffect(() => {
    const divisionId = values.salesDivisionId;
    const marketId = values.marketId;
    if (!divisionId || !marketId) return;
    const marketDivision = marketDivisionMap.get(marketId) ?? '';
    if (marketDivision && marketDivision !== divisionId) {
      setValues((prev) => {
        if (prev.marketId === marketId) {
          return { ...prev, marketId: '' };
        }
        return prev;
      });
    }
  }, [marketDivisionMap, values.marketId, values.salesDivisionId]);

  const findCustomerOption = useCallback((text: string) => {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return null;
    return customers.find((option) => {
      const label = option.label?.trim().toLowerCase();
      const value = option.value?.trim().toLowerCase();
      return label === normalized || value === normalized;
    }) ?? null;
  }, [customers]);

  const setCustomerSelection = useCallback((option: DropdownOption | null, rawText: string) => {
    setCustomerText(rawText);
    setValues((prev) => ({ ...prev, customerId: option?.value ?? '' }));
    setShowCustomerList(false);
    setFieldErrors((prev) => {
      if (!prev.customerId) return prev;
      const next = { ...prev };
      delete next.customerId;
      return next;
    });
  }, []);

  useEffect(() => {
    if (appliedCustomerParamRef.current) return;
    if (!initialCustomerIdParam) return;
    if (customers.length === 0) return;
    const match = customers.find((option) => {
      const value = option.value?.trim() ?? '';
      return value === initialCustomerIdParam;
    }) ?? customers.find((option) => {
      const label = option.label?.trim().toLowerCase() ?? '';
      return label === initialCustomerIdParam.toLowerCase();
    });
    appliedCustomerParamRef.current = true;
    if (!match) return;
    setCustomerSelection(match, match.label ?? initialCustomerIdParam);
  }, [customers, initialCustomerIdParam, setCustomerSelection]);

  const handleCustomerInputChange = useCallback((text: string) => {
    const match = findCustomerOption(text);
    setCustomerSelection(match, text);
    setShowCustomerList(true);
    if (!match) {
      setValues((prev) => ({ ...prev, customerId: '' }));
    }
  }, [findCustomerOption, setCustomerSelection]);

  const handleCustomerBlur = useCallback(() => {
    if (listCloseTimerRef.current) {
      clearTimeout(listCloseTimerRef.current);
    }
    listCloseTimerRef.current = setTimeout(() => setShowCustomerList(false), 120);
    const trimmed = customerText.trim();
    if (!trimmed) {
      setCustomerSelection(null, '');
      return;
    }
    const match = findCustomerOption(trimmed);
    if (!match) {
      setCustomerSelection(null, trimmed);
      setFieldErrors((prev) => ({ ...prev, customerId: 'Please choose a valid customer' }));
      return;
    }
    setCustomerSelection(match, match.label);
  }, [customerText, findCustomerOption, setCustomerSelection]);

  useEffect(() => {
    const customerId = values.customerId.trim();
    if (customerId === lastCustomerRef.current) return;
    lastCustomerRef.current = customerId;
    setValues((prev) => ({ ...prev, contactId: '' }));
    setFieldErrors((prev) => {
      if (!prev.contactId) return prev;
      const next = { ...prev };
      delete next.contactId;
      return next;
    });
    setContactOptions([]);
    setContactLoadError(null);
    if (!customerId) return;

    let cancelled = false;
    const load = async () => {
      setContactsLoading(true);
      try {
        const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}/contacts`);
        const data = (await res.json().catch(() => null)) as {
          ok?: boolean;
          contacts?: Array<{ ContactID: number; FullName: string }>;
          error?: string;
        } | null;
        if (cancelled) return;
        if (!res.ok || !data?.ok || !Array.isArray(data.contacts)) {
          throw new Error(data?.error ?? 'Unable to load contacts');
        }
        setContactOptions(
          data.contacts.map((contact) => ({
            value: String(contact.ContactID),
            label: contact.FullName ?? `Contact ${contact.ContactID}`,
          })),
        );
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Unable to load contacts';
        setContactOptions([]);
        setContactLoadError(message);
        showToastMessage('Unable to load contacts for this customer.', 'error');
      } finally {
        if (!cancelled) setContactsLoading(false);
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (listCloseTimerRef.current) {
        clearTimeout(listCloseTimerRef.current);
      }
    };
  }, [values.customerId]);

  const handleChange = useCallback((field: keyof FormValues, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors: Partial<Record<keyof FormValues, string>> = {};
    requiredFieldIds.forEach((field) => {
      const val = values[field];
      if (!val || !val.trim()) {
        errors[field] = 'Required';
      }
    });

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      showToastMessage('Please fill all required fields.', 'error');
      return;
    }

    const payload = {
      title: values.title,
      description: values.description,
      paymentTerms: values.paymentTerms,
      deliveryTime: values.deliveryTime,
      offerValidity: values.offerValidity,
      customerId: toNumberOrNull(values.customerId),
      statusId: toNumberOrNull(values.statusId),
      contactId: toNumberOrNull(values.contactId),
      pricingPolicyId: toNumberOrNull(values.pricingPolicyId),
      marketId: toNumberOrNull(values.marketId),
      salesDivisionId: toNumberOrNull(values.salesDivisionId),
      salesCreationPersonId: toNullableString(values.salesCreationPersonId),
      salesPersonId: toNullableString(values.salesPersonId) ?? toNullableString(values.salesCreationPersonId),
      approvalUserId: toNullableString(values.approvalUserId),
      installationSchedule: toNullableString(values.installationSchedule),
      closingNote: toNullableString(values.closingNote),
      introNote: toNullableString(values.introNote),
      telmacoNote: toNullableString(values.telmacoNote),
      projectId: toNumberOrNull(values.projectId),
      erpFwcProjectId: toNumberOrNull(values.erpFwcProjectId),
      customerRef: toNullableString(values.customerRef),
      initialRequest: toNullableString(values.initialRequest),
      draftOffer: toNullableString(values.draftOffer),
      officialRequest: toNullableString(values.officialRequest),
      offerDeadline: toNullableString(values.offerDeadline),
      officialQuoteOffer: toNullableString(values.officialQuoteOffer),
      orderSigned: toNullableString(values.orderSigned),
      deliveryDue: toNullableString(values.deliveryDue),
      delivery: toNullableString(values.delivery),
      offerDate: toNullableString(values.offerDate),
    };

    setSubmitting(true);
    try {
      const res = await fetch('/api/offers/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; offerId?: number } | null;
      if (!res.ok || !data?.ok || !data.offerId) {
        throw new Error(data?.error ?? 'Unable to create offer');
      }
      showToastMessage('Offer created', 'success');
      router.push(`/offers/${encodeURIComponent(String(data.offerId))}/products`);
    } catch (err) {
      console.error(err);
      showToastMessage(err instanceof Error ? err.message : 'Unable to create offer.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [router, values]);

  const fieldDefinitions: FieldConfig[] = useMemo(
    () => [
      { id: 'title', label: 'Title', section: 'general', required: true },
      { id: 'description', label: 'Description', section: 'general', required: true },
      { id: 'paymentTerms', label: 'Payment Terms', section: 'general', required: true, type: 'textarea' },
      { id: 'installationSchedule', label: 'Installation Schedule', section: 'general', type: 'textarea' },
      { id: 'closingNote', label: 'Closing Note', section: 'general', type: 'textarea' },
      { id: 'offerValidity', label: 'Offer Validity', section: 'general', required: true },
      { id: 'deliveryTime', label: 'Delivery Time', section: 'general', required: true },
      { id: 'introNote', label: 'Introduction Note', section: 'general', type: 'textarea' },
      { id: 'customerId', label: 'Customer', section: 'general', required: true, type: 'select', options: customers },
      { id: 'statusId', label: 'Status', section: 'general', required: true, type: 'select', options: statuses },

      { id: 'contactId', label: 'Contact', section: 'info', required: true, type: 'select', options: contactOptions, fullWidth: true, dependsOnCustomer: true },
      { id: 'telmacoNote', label: 'Telmaco Note', section: 'info', type: 'textarea' },

      { id: 'pricingPolicyId', label: 'Pricing Policy', section: 'commercial', required: true, type: 'select', options: localPricingPolicies },
      { id: 'marketId', label: 'Market', section: 'commercial', required: true, type: 'select', options: markets },
      { id: 'salesDivisionId', label: 'Sales Division', section: 'commercial', required: true, type: 'select', options: salesDivisions },
      { id: 'salesCreationPersonId', label: 'Sales Creation Person', section: 'commercial', required: true, type: 'select', options: users },
      { id: 'salesPersonId', label: 'Sales Person', section: 'commercial', type: 'select', options: users },
      { id: 'approvalUserId', label: 'Approval User', section: 'commercial', type: 'select', options: users },

      { id: 'projectId', label: 'ERP Project ID', section: 'code', inputType: 'number' },
      { id: 'erpFwcProjectId', label: 'ERP FWC Project ID', section: 'code', type: 'select', options: fwcProjects },
      { id: 'customerRef', label: 'Customer Ref', section: 'code' },

      { id: 'initialRequest', label: 'Initial Request', section: 'dates', type: 'date' },
      { id: 'officialRequest', label: 'Official Request', section: 'dates', type: 'date' },
      { id: 'draftOffer', label: 'Draft Offer', section: 'dates', type: 'date' },
      { id: 'officialQuoteOffer', label: 'Official Quote Offer', section: 'dates', type: 'date' },
      { id: 'offerDate', label: 'Offer Date', section: 'dates', type: 'date' },
      { id: 'offerDeadline', label: 'Offer Deadline', section: 'dates', type: 'date' },
      { id: 'orderSigned', label: 'Order Signed', section: 'dates', type: 'date' },
      { id: 'deliveryDue', label: 'Delivery Due', section: 'dates', type: 'date' },
      { id: 'delivery', label: 'Delivery', section: 'dates', type: 'date' },
    ],
    [
      contactOptions,
      customers,
      markets,
      localPricingPolicies,
      salesDivisions,
      statuses,
      users,
      fwcProjects,
    ],
  );

  const generalLayout: Array<Array<keyof FormValues>> = [
    ['title', 'description', 'customerId', 'offerValidity', 'statusId'],
    ['deliveryTime', 'paymentTerms', 'installationSchedule', 'introNote', 'closingNote'],
  ];

  const renderLabel = (field: FieldConfig) => (
    <label className={panelStyles.fieldLabel} htmlFor={`offer-create-${field.id}`}>
      <div className={styles.lookupLabelRow}>
        <div className={styles.labelText}>
          {field.label}
          {field.required ? <span className={styles.requiredMark}>*</span> : null}
        </div>
      </div>
    </label>
  );

  const renderFieldControl = (field: FieldConfig) => {
    const fieldId = `offer-create-${field.id}`;
    const value = values[field.id as keyof FormValues];
    const error = fieldErrors[field.id as keyof FormValues];
    const disabled = field.readOnly || (field.dependsOnCustomer && !values.customerId) || submitting;
    const invalid = Boolean(error);
    const showErrorText = typeof error === 'string' && error.length > 0 && error !== 'Required';

    if (field.id === 'customerId') {
      const filtered = customerText.trim()
        ? customers.filter((option) => {
            const label = option.label?.toLowerCase() ?? '';
            const val = option.value?.toLowerCase() ?? '';
            const search = customerText.toLowerCase();
            return label.includes(search) || val.includes(search);
          })
        : customers;
      return (
        <div className={`${styles.controlStack} ${styles.comboWrapper}`}>
          <input
            autoComplete="off"
            id={fieldId}
            className={`${panelStyles.fieldControl} ${styles.comboInput}`}
            aria-invalid={invalid}
            value={customerText}
            disabled={submitting}
            placeholder="Type to filter customers"
            onChange={(event) => handleCustomerInputChange(event.target.value)}
            onBlur={handleCustomerBlur}
            onFocus={(event) => {
              event.target.select();
              setShowCustomerList(true);
            }}
          />
          {showCustomerList && filtered.length > 0 ? (
            <div className={styles.comboList}>
              {filtered.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.comboOption}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setCustomerSelection(option, option.label);
                    setShowCustomerList(false);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {showErrorText ? <div className={styles.fieldError}>{error}</div> : null}
        </div>
      );
    }

    if (field.type === 'select') {
      const selectOptions = field.id === 'marketId' ? filteredMarkets : field.options ?? [];
      const baseOptions = selectOptions;
      const hasValueInOptions = value ? baseOptions.some((option) => option.value === value) : true;
      const options = !hasValueInOptions && value
        ? [...baseOptions, { value, label: value }]
        : baseOptions;
      const dependsOnCustomer = Boolean(field.dependsOnCustomer);
      const placeholder = dependsOnCustomer
        ? (!values.customerId ? 'Select a customer first' : contactsLoading ? 'Loading contacts…' : 'Select contact...')
        : 'Select...';
      const isDisabled = disabled || (dependsOnCustomer && (!values.customerId || contactsLoading));
      return (
        <div className={styles.controlStack}>
          {isDisabled && dependsOnCustomer ? (
            <div className={`${panelStyles.fieldReadonly} ${invalid ? 'fastquote-invalid-outline' : ''}`}>
              {placeholder}
            </div>
          ) : (
            <select
              id={fieldId}
              name={field.id}
              className={panelStyles.fieldControl}
              aria-invalid={invalid}
              value={value}
              disabled={isDisabled}
              required={field.required}
              onChange={(event) => {
                const newValue = event.target.value;
                handleChange(field.id as keyof FormValues, newValue);
              }}
            >
              <option value="">{placeholder}</option>
              {options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
          {field.dependsOnCustomer ? (
            <div className={styles.contactStatus}>
              {!values.customerId
                ? 'Select a customer to load contacts.'
                : contactsLoading
                  ? 'Loading contacts...'
                  : contactLoadError || (contactOptions.length === 0 ? 'No contacts found yet for this customer.' : null)}
            </div>
          ) : null}
          {showErrorText ? <div className={styles.fieldError}>{error}</div> : null}
        </div>
      );
    }

    if (field.type === 'textarea') {
      return (
        <div className={styles.controlStack}>
          <textarea
            autoComplete="off"
            id={fieldId}
            name={field.id}
            className={`${panelStyles.fieldControl} ${panelStyles.fieldControlMultiline}`}
            aria-invalid={invalid}
            value={value}
            disabled={disabled}
            required={field.required}
            onChange={(event) => {
              handleChange(field.id as keyof FormValues, event.target.value);
            }}
          />
          {showErrorText ? <div className={styles.fieldError}>{error}</div> : null}
        </div>
      );
    }

    if (field.type === 'date') {
      return (
        <div className={styles.controlStack}>
          <UKDatePicker
            value={value}
            onChange={(newValue) => {
              handleChange(field.id as keyof FormValues, newValue);
            }}
            placeholder="DD/MM/YYYY"
            className={panelStyles.fieldControl}
            disabled={disabled}
            required={field.required}
            invalid={invalid}
          />
          {showErrorText ? <div className={styles.fieldError}>{error}</div> : null}
        </div>
      );
    }

    return (
      <div className={styles.controlStack}>
        <input
          autoComplete="off"
          id={fieldId}
          name={field.id}
          className={panelStyles.fieldControl}
          aria-invalid={invalid}
          type={field.inputType ?? 'text'}
          value={value}
          disabled={disabled}
          required={field.required}
          onChange={(event) => {
            handleChange(field.id as keyof FormValues, event.target.value);
          }}
          readOnly={field.readOnly}
        />
        {showErrorText ? <div className={styles.fieldError}>{error}</div> : null}
      </div>
    );
  };

  const renderSection = (sectionKey: SectionKey) => {
    const metadata = SECTION_METADATA[sectionKey];
    if (!metadata) return null;
    const sectionFields = fieldDefinitions.filter((field) => field.section === sectionKey);
    if (sectionFields.length === 0) return null;
    return (
      <section key={sectionKey} className={`${panelStyles.detailSection} ${panelStyles.sectionCard}`}>
        <div className={panelStyles.sectionHeading}>{metadata.title}</div>
        <div className={panelStyles.sectionFields}>
          {sectionFields.map((field) => {
            const spanClass = field.fullWidth
              ? panelStyles.fieldFull
              : field.span && field.span > 1
                ? panelStyles.fieldWide
                : '';
            return (
              <div key={field.id} className={`${panelStyles.fieldBlock} ${spanClass}`}>
                {renderLabel(field)}
                {renderFieldControl(field)}
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const generalFields = fieldDefinitions.filter((field) => field.section === 'general');
  const generalFieldMap = generalFields.reduce<Record<string, FieldConfig>>((acc, field) => {
    acc[field.id] = field;
    return acc;
  }, {});

  const generalRows = generalLayout
    .map((rowIds) =>
      rowIds
        .map((id) => generalFieldMap[id])
        .filter((field): field is FieldConfig => Boolean(field)),
    )
    .filter((row) => row.length > 0);

  const assignedFieldIds = new Set(generalLayout.flat());
  const remainingFields = generalFields.filter((field) => !assignedFieldIds.has(field.id));
  if (remainingFields.length > 0) generalRows.push(remainingFields);

  return (
    <>
      <form
        id={formId}
        className={styles.form}
        onSubmit={handleSubmit}
        autoComplete="off"
        noValidate
        data-show-validation={Object.keys(fieldErrors).length > 0 ? 'true' : 'false'}
      >
        <section className={panelStyles.panel}>
          <div className={`${panelStyles.section} ${panelStyles.sectionCard} ${panelStyles.generalSection}`}>
            <div className={panelStyles.sectionHeading}>{SECTION_METADATA.general.title}</div>
            <div className={panelStyles.generalRows}>
              {generalRows.map((row, rowIdx) => (
                <div key={rowIdx} className={panelStyles.generalRow}>
                  {row.map((field) => (
                    <div key={field.id} className={panelStyles.field}>
                      {renderLabel(field)}
                      {renderFieldControl(field)}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <div className={panelStyles.sectionsGrid}>
            {(['info', 'commercial', 'code', 'dates'] as SectionKey[]).map((sectionKey) =>
              renderSection(sectionKey),
            )}
          </div>
        </section>
      </form>
    </>
  );
}
