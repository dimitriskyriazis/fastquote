'use client';

import { useState, useMemo, useEffect, useCallback, useRef, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { DropdownOption } from '../../../lib/dropdownOptions';
import { showToastMessage } from '../../../lib/toast';
import { useAuditUser } from '../../components/AuditUserProvider';
import { useFormDraft } from '../../hooks/useFormDraft';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import panelStyles from '../[offerId]/OfferBasicDataPanel.module.css';
import styles from './OfferCreateClient.module.css';
import UKDatePicker from '../../components/DatePicker';
import {
  DEFAULT_OFFER_LANGUAGE,
  OFFER_LANGUAGES,
  OFFER_LANGUAGE_DEFAULTS,
  type OfferLanguage,
} from '../../../lib/offerLanguage';

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
  projectCode: string;
  erpFwcProjectId: string;
  customerRef: string;
  probability: string;
  initialRequest: string;
  draftOffer: string;
  officialRequest: string;
  offerDeadline: string;
  orderSigned: string;
  deliveryDue: string;
  possibleOrderDate: string;
  offerDate: string;
  protocolNo: string;
  offerLanguage: OfferLanguage;
  finalPriceLabel: string;
  currencyId: string;
  currencyModifier: string;
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
  hideEmptyOption?: boolean;
};

type OfferCreateDefaults = {
  suggestedUserId?: string;
};

export type MarketOption = DropdownOption & { salesDivisionId: string | null };
type UserOption = DropdownOption & { salesSeniorityName?: string | null };
type LookupKey =
  | 'customers'
  | 'statuses'
  | 'pricingPolicies'
  | 'markets'
  | 'salesDivisions'
  | 'users'
  | 'fwcProjects'
  | 'currencies';
type OfferLookupPayload = {
  customers?: DropdownOption[];
  statuses?: DropdownOption[];
  pricingPolicies?: DropdownOption[];
  markets?: MarketOption[];
  salesDivisions?: DropdownOption[];
  users?: UserOption[];
  fwcProjects?: DropdownOption[];
  currencies?: DropdownOption[];
};

type Props = {
  customers: DropdownOption[];
  statuses: DropdownOption[];
  pricingPolicies: DropdownOption[];
  markets: MarketOption[];
  salesDivisions: DropdownOption[];
  users: UserOption[];
  fwcProjects: DropdownOption[];
  currencies: DropdownOption[];
  defaultValues: OfferCreateDefaults;
  formId?: string;
};

const isEurOption = (option: DropdownOption): boolean => {
  const label = (option.label ?? '').trim().toLowerCase();
  return label === '€' || label === 'eur' || label.includes('eur');
};

const SALES_USER_SENIORITIES = new Set([
  'ceo',
  'general director',
  'director',
  'manager',
  'basic',
]);

const APPROVAL_USER_SENIORITIES = new Set([
  'ceo',
  'general director',
  'director',
  'manager',
]);

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
  'salesPersonId',
  'approvalUserId',
];

const toNumberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const PROBABILITY_MIN = 0;
const PROBABILITY_MAX = 100;

const parseProbability = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < PROBABILITY_MIN || parsed > PROBABILITY_MAX) return null;
  return parsed;
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
  currencies,
  defaultValues,
  formId = 'offer-create-form',
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { userId } = useAuditUser();
  const [contactOptions, setContactOptions] = useState<DropdownOption[]>([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactLoadError, setContactLoadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [customerText, setCustomerText] = useState('');
  const [showCustomerList, setShowCustomerList] = useState(false);
  const [localCustomers, setLocalCustomers] = useState(customers);
  const [localStatuses, setLocalStatuses] = useState(statuses);
  const [localPricingPolicies, setLocalPricingPolicies] = useState(pricingPolicies);
  const [localMarkets, setLocalMarkets] = useState(markets);
  const [localSalesDivisions, setLocalSalesDivisions] = useState(salesDivisions);
  const [localUsers, setLocalUsers] = useState(users);
  const [localFwcProjects, setLocalFwcProjects] = useState(fwcProjects);
  const [localCurrencies, setLocalCurrencies] = useState(currencies);
  const lastCustomerRef = useRef<string>('');
  const listCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const appliedCustomerParamRef = useRef(false);
  const lookupRefreshInFlightRef = useRef(new Set<LookupKey>());
  const contactRefreshTokenRef = useRef(0);
  const initialCustomerIdParam = (searchParams?.get('customerId') ?? '').trim();
  const initialContactIdParam = (searchParams?.get('contactId') ?? '').trim();
  const appliedContactParamRef = useRef(false);

  const defaultPricingPolicyId = useMemo(
    () => resolveDefaultPricingPolicyId(localPricingPolicies),
    [localPricingPolicies],
  );

  const defaultStatusId = useMemo(() => resolveDefaultStatusId(localStatuses), [localStatuses]);

  const salesUsers = useMemo(
    () =>
      localUsers.filter((user) =>
        SALES_USER_SENIORITIES.has((user.salesSeniorityName ?? '').trim().toLowerCase()),
      ),
    [localUsers],
  );

  const approvalUsers = useMemo(
    () =>
      localUsers.filter((user) =>
        APPROVAL_USER_SENIORITIES.has((user.salesSeniorityName ?? '').trim().toLowerCase()),
      ),
    [localUsers],
  );

  const defaultSuggestedUserId = useMemo(() => {
    const suggestedUserId = (defaultValues.suggestedUserId ?? '').trim();
    if (!suggestedUserId) return '';
    return salesUsers.some((user) => user.value === suggestedUserId) ? suggestedUserId : '';
  }, [defaultValues.suggestedUserId, salesUsers]);

  const defaultApprovalUserId = useMemo(() => {
    const suggestedUserId = (defaultValues.suggestedUserId ?? '').trim();
    if (!suggestedUserId) return '';
    return approvalUsers.some((user) => user.value === suggestedUserId) ? suggestedUserId : '';
  }, [defaultValues.suggestedUserId, approvalUsers]);

  const eurCurrencyId = useMemo(() => {
    const match = localCurrencies.find(isEurOption);
    return match?.value ?? '';
  }, [localCurrencies]);

  const initialValues = useMemo<FormValues>(() => {
    const langDefaults = OFFER_LANGUAGE_DEFAULTS[DEFAULT_OFFER_LANGUAGE];
    return {
      title: langDefaults.title,
      description: '',
      paymentTerms: langDefaults.paymentTerms,
      deliveryTime: langDefaults.deliveryTime,
      offerValidity: langDefaults.offerValidity,
      installationSchedule: '',
      closingNote: langDefaults.closingNote,
      introNote: '',
      telmacoNote: '',
      customerId: '',
      contactId: '',
      statusId: defaultStatusId,
      pricingPolicyId: defaultPricingPolicyId,
      marketId: '',
      salesDivisionId: '',
      salesCreationPersonId: defaultSuggestedUserId,
      salesPersonId: defaultSuggestedUserId,
      approvalUserId: defaultApprovalUserId,
      projectCode: '',
      erpFwcProjectId: '',
      customerRef: '',
      probability: '',
      initialRequest: '',
      draftOffer: '',
      officialRequest: '',
      offerDeadline: '',
      orderSigned: '',
      deliveryDue: '',
      possibleOrderDate: '',
      offerDate: '',
      protocolNo: '',
      offerLanguage: DEFAULT_OFFER_LANGUAGE,
      finalPriceLabel: langDefaults.finalPriceLabel,
      currencyId: eurCurrencyId,
      currencyModifier: '',
    };
  }, [
    defaultPricingPolicyId,
    defaultStatusId,
    defaultSuggestedUserId,
    defaultApprovalUserId,
    eurCurrencyId,
  ]);

  const [values, setValues] = useState<FormValues>(initialValues);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof FormValues, string>>>({});
  const { hasDraft, restoredValues, saveDraft: saveDraftValues, clearDraft } = useFormDraft<FormValues>('offer-create', initialValues, userId);

  // Restore draft if available
  useEffect(() => {
    if (hasDraft && restoredValues) {
      setValues(restoredValues);
      showToastMessage('Draft restored', 'info', 5500, {
        label: 'Discard',
        onClick: () => {
          clearDraft();
          setValues(initialValues);
        },
      });
    }
  }, [hasDraft, restoredValues]); // eslint-disable-line react-hooks/exhaustive-deps -- run once on restore

  // Auto-save draft on value changes
  useEffect(() => {
    saveDraftValues(values);
  }, [values, saveDraftValues]);

  // Warn on unsaved changes
  const isDirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initialValues), [values, initialValues]);
  useUnsavedChanges(isDirty);

  useEffect(() => {
    setLocalCustomers(customers);
  }, [customers]);

  useEffect(() => {
    setLocalStatuses(statuses);
  }, [statuses]);

  useEffect(() => {
    setLocalPricingPolicies(pricingPolicies);
  }, [pricingPolicies]);

  useEffect(() => {
    setLocalMarkets(markets);
  }, [markets]);

  useEffect(() => {
    setLocalSalesDivisions(salesDivisions);
  }, [salesDivisions]);

  useEffect(() => {
    setLocalUsers(users);
  }, [users]);

  useEffect(() => {
    setLocalFwcProjects(fwcProjects);
  }, [fwcProjects]);

  useEffect(() => {
    setLocalCurrencies(currencies);
  }, [currencies]);

  useEffect(() => {
    if (!eurCurrencyId) return;
    setValues((prev) => (prev.currencyId ? prev : { ...prev, currencyId: eurCurrencyId }));
  }, [eurCurrencyId]);

  const refreshLookups = useCallback(async (keys: LookupKey[]) => {
    const uniqueKeys = Array.from(new Set(keys));
    const pendingKeys = uniqueKeys.filter((key) => !lookupRefreshInFlightRef.current.has(key));
    if (pendingKeys.length === 0) return;
    pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.add(key));
    try {
      const search = new URLSearchParams();
      pendingKeys.forEach((key) => search.append('keys', key));
      const response = await fetch(`/api/offers/lookups?${search.toString()}`, { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; lookups?: OfferLookupPayload }
        | null;
      if (!response.ok || !payload?.ok || !payload.lookups) {
        throw new Error(payload?.error ?? 'Unable to refresh lookup options');
      }
      if (payload.lookups.customers) setLocalCustomers(payload.lookups.customers);
      if (payload.lookups.statuses) setLocalStatuses(payload.lookups.statuses);
      if (payload.lookups.pricingPolicies) setLocalPricingPolicies(payload.lookups.pricingPolicies);
      if (payload.lookups.markets) setLocalMarkets(payload.lookups.markets);
      if (payload.lookups.salesDivisions) setLocalSalesDivisions(payload.lookups.salesDivisions);
      if (payload.lookups.users) setLocalUsers(payload.lookups.users);
      if (payload.lookups.fwcProjects) setLocalFwcProjects(payload.lookups.fwcProjects);
      if (payload.lookups.currencies) setLocalCurrencies(payload.lookups.currencies);
    } catch (err) {
      console.error(err);
      showToastMessage('Unable to refresh latest dropdown values.', 'warning');
    } finally {
      pendingKeys.forEach((key) => lookupRefreshInFlightRef.current.delete(key));
    }
  }, []);

  const salesDivisionLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    localSalesDivisions.forEach((division) => {
      if (!division?.value) return;
      const label = division.label?.trim();
      if (!label) return;
      map.set(division.value, label);
    });
    return map;
  }, [localSalesDivisions]);

  const marketsWithDivisionLabel = useMemo(() => {
    return localMarkets.map((market) => {
      const divisionLabel = market.salesDivisionId
        ? salesDivisionLabelMap.get(market.salesDivisionId) ?? ''
        : '';
      const label = divisionLabel ? `${market.label} - ${divisionLabel}` : market.label;
      return { ...market, label };
    });
  }, [localMarkets, salesDivisionLabelMap]);

  const filteredMarkets = useMemo(() => {
    if (!values.salesDivisionId) return marketsWithDivisionLabel;
    return marketsWithDivisionLabel.filter(
      (market) => market.salesDivisionId === values.salesDivisionId,
    );
  }, [marketsWithDivisionLabel, values.salesDivisionId]);

  const marketDivisionMap = useMemo(() => {
    const map = new Map<string, string>();
    localMarkets.forEach((market) => {
      if (!market || !market.value) return;
      map.set(market.value, market.salesDivisionId ?? '');
    });
    return map;
  }, [localMarkets]);

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
    return localCustomers.find((option) => {
      const label = option.label?.trim().toLowerCase();
      const value = option.value?.trim().toLowerCase();
      return label === normalized || value === normalized;
    }) ?? null;
  }, [localCustomers]);

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
    if (localCustomers.length === 0) return;
    const match = localCustomers.find((option) => {
      const value = option.value?.trim() ?? '';
      return value === initialCustomerIdParam;
    }) ?? localCustomers.find((option) => {
      const label = option.label?.trim().toLowerCase() ?? '';
      return label === initialCustomerIdParam.toLowerCase();
    });
    appliedCustomerParamRef.current = true;
    if (!match) return;
    setCustomerSelection(match, match.label ?? initialCustomerIdParam);
  }, [localCustomers, initialCustomerIdParam, setCustomerSelection]);

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

  const loadContactsForCustomer = useCallback(async (customerId: string) => {
    const refreshToken = contactRefreshTokenRef.current + 1;
    contactRefreshTokenRef.current = refreshToken;
    if (!customerId) {
      if (contactRefreshTokenRef.current === refreshToken) {
        setContactOptions([]);
        setContactLoadError(null);
        setContactsLoading(false);
      }
      return;
    }

    setContactsLoading(true);
    try {
      const res = await fetch(`/api/customers/${encodeURIComponent(customerId)}/contacts`, {
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        contacts?: Array<{ ContactID: number; FullName: string }>;
        error?: string;
      } | null;
      if (!res.ok || !data?.ok || !Array.isArray(data.contacts)) {
        throw new Error(data?.error ?? 'Unable to load contacts');
      }
      if (contactRefreshTokenRef.current === refreshToken) {
        setContactOptions(
          data.contacts.map((contact) => ({
            value: String(contact.ContactID),
            label: contact.FullName ?? `Contact ${contact.ContactID}`,
          })),
        );
        setContactLoadError(null);
      }
    } catch (err) {
      if (contactRefreshTokenRef.current !== refreshToken) return;
      const message = err instanceof Error ? err.message : 'Unable to load contacts';
      setContactOptions([]);
      setContactLoadError(message);
      showToastMessage('Unable to load contacts for this customer.', 'error');
    } finally {
      if (contactRefreshTokenRef.current === refreshToken) {
        setContactsLoading(false);
      }
    }
  }, []);

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
      try {
        await loadContactsForCustomer(customerId);
        if (cancelled) return;
      } catch (err) {
        if (cancelled) return;
        console.error(err);
      }
    };
    void load();

    return () => {
      cancelled = true;
      if (listCloseTimerRef.current) {
        clearTimeout(listCloseTimerRef.current);
      }
    };
  }, [loadContactsForCustomer, values.customerId]);

  useEffect(() => {
    if (appliedContactParamRef.current) return;
    if (!initialContactIdParam) return;
    if (contactOptions.length === 0) return;
    const match = contactOptions.find((option) => option.value?.trim() === initialContactIdParam);
    appliedContactParamRef.current = true;
    if (!match) return;
    setValues((prev) => ({ ...prev, contactId: match.value }));
  }, [contactOptions, initialContactIdParam]);

  const handleChange = useCallback((field: keyof FormValues, value: string) => {
    setValues((prev) => {
      if (field === 'offerLanguage' && (value === 'Greek' || value === 'English') && prev.offerLanguage !== value) {
        const prevDefaults = OFFER_LANGUAGE_DEFAULTS[prev.offerLanguage];
        const nextDefaults = OFFER_LANGUAGE_DEFAULTS[value];
        const swap = (current: string, was: string, next: string) =>
          current.trim() === '' || current === was ? next : current;
        return {
          ...prev,
          offerLanguage: value,
          title: swap(prev.title, prevDefaults.title, nextDefaults.title),
          paymentTerms: swap(prev.paymentTerms, prevDefaults.paymentTerms, nextDefaults.paymentTerms),
          deliveryTime: swap(prev.deliveryTime, prevDefaults.deliveryTime, nextDefaults.deliveryTime),
          offerValidity: swap(prev.offerValidity, prevDefaults.offerValidity, nextDefaults.offerValidity),
          closingNote: swap(prev.closingNote, prevDefaults.closingNote, nextDefaults.closingNote),
          finalPriceLabel: swap(prev.finalPriceLabel, prevDefaults.finalPriceLabel, nextDefaults.finalPriceLabel),
        };
      }
      return { ...prev, [field]: value } as FormValues;
    });
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
    const normalizedProbability = parseProbability(values.probability);
    if (values.probability.trim() && normalizedProbability == null) {
      errors.probability = `Probability must be an integer between ${PROBABILITY_MIN} and ${PROBABILITY_MAX}`;
    }

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
      salesPersonId: toNullableString(values.salesPersonId),
      approvalUserId: toNullableString(values.approvalUserId),
      installationSchedule: toNullableString(values.installationSchedule),
      closingNote: toNullableString(values.closingNote),
      introNote: toNullableString(values.introNote),
      telmacoNote: toNullableString(values.telmacoNote),
      projectCode: toNullableString(values.projectCode),
      erpFwcProjectId: toNumberOrNull(values.erpFwcProjectId),
      customerRef: toNullableString(values.customerRef),
      probability: normalizedProbability ?? 0,
      initialRequest: toNullableString(values.initialRequest),
      draftOffer: toNullableString(values.draftOffer),
      officialRequest: toNullableString(values.officialRequest),
      offerDeadline: toNullableString(values.offerDeadline),
      orderSigned: toNullableString(values.orderSigned),
      deliveryDue: toNullableString(values.deliveryDue),
      possibleOrderDate: toNullableString(values.possibleOrderDate),
      offerDate: toNullableString(values.offerDate),
      protocolNo: toNumberOrNull(values.protocolNo),
      offerLanguage: values.offerLanguage,
      finalPriceLabel: toNullableString(values.finalPriceLabel),
      currencyId: toNumberOrNull(values.currencyId),
      currencyModifier:
        values.currencyId && values.currencyId !== eurCurrencyId
          ? Number(values.currencyModifier.replace(',', '.')) || null
          : null,
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
      clearDraft();
      showToastMessage('Offer created', 'success');
      router.push(`/offers/${encodeURIComponent(String(data.offerId))}/products`);
    } catch (err) {
      console.error(err);
      showToastMessage(err instanceof Error ? err.message : 'Unable to create offer.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [router, values, clearDraft, eurCurrencyId]);

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
      { id: 'customerId', label: 'Customer', section: 'general', required: true, type: 'select', options: localCustomers },
      { id: 'statusId', label: 'Status', section: 'general', required: true, type: 'select', options: localStatuses },

      { id: 'contactId', label: 'Contact', section: 'info', required: true, type: 'select', options: contactOptions, fullWidth: true, dependsOnCustomer: true },
      { id: 'telmacoNote', label: 'Telmaco Note', section: 'info', type: 'textarea' },
      { id: 'offerLanguage', label: 'Offer Language', section: 'info', required: true, type: 'select', options: OFFER_LANGUAGES.map((l) => ({ value: l, label: l })), fullWidth: true, hideEmptyOption: true },

      { id: 'pricingPolicyId', label: 'Pricing Policy', section: 'commercial', required: true, type: 'select', options: localPricingPolicies },
      { id: 'currencyId', label: 'Currency', section: 'commercial', type: 'select', options: localCurrencies, hideEmptyOption: true },
      ...(values.currencyId && values.currencyId !== eurCurrencyId
        ? [{ id: 'currencyModifier' as keyof FormValues, label: 'Currency Modifier', section: 'commercial' as SectionKey, inputType: 'number' }]
        : []),
      { id: 'marketId', label: 'Market', section: 'commercial', required: true, type: 'select', options: localMarkets },
      { id: 'salesDivisionId', label: 'Sales Division', section: 'commercial', required: true, type: 'select', options: localSalesDivisions },
      { id: 'salesCreationPersonId', label: 'Sales Creation Person', section: 'commercial', required: true, type: 'select', options: salesUsers, readOnly: true },
      { id: 'salesPersonId', label: 'Sales Person', section: 'commercial', required: true, type: 'select', options: salesUsers },
      { id: 'approvalUserId', label: 'Approval User', section: 'commercial', required: true, type: 'select', options: approvalUsers },

      { id: 'projectCode', label: 'ERP Project Code', section: 'code' },
      { id: 'erpFwcProjectId', label: 'ERP FWC Project', section: 'code', type: 'select', options: localFwcProjects },
      { id: 'customerRef', label: 'Customer Ref', section: 'code' },
      { id: 'probability', label: 'Probability', section: 'code', inputType: 'number' },
      { id: 'protocolNo', label: 'Protocol No', section: 'code', inputType: 'number' },

      { id: 'initialRequest', label: 'Draft Request', section: 'dates', type: 'date' },
      { id: 'draftOffer', label: 'Draft Offer', section: 'dates', type: 'date' },
      { id: 'officialRequest', label: 'Request', section: 'dates', type: 'date' },
      { id: 'offerDate', label: 'Offer', section: 'dates', type: 'date' },
      { id: 'offerDeadline', label: 'Offer Deadline', section: 'dates', type: 'date' },
      { id: 'orderSigned', label: 'Order Signed', section: 'dates', type: 'date' },
      { id: 'possibleOrderDate', label: 'Possible Order', section: 'dates', type: 'date' },
      { id: 'deliveryDue', label: 'Delivery Due', section: 'dates', type: 'date' },
    ],
    [
      contactOptions,
      localCustomers,
      localMarkets,
      localPricingPolicies,
      localSalesDivisions,
      localStatuses,
      salesUsers,
      approvalUsers,
      localFwcProjects,
      localCurrencies,
      values.currencyId,
      eurCurrencyId,
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

  const refreshFieldLookups = useCallback((fieldId: keyof FormValues) => {
    if (fieldId === 'customerId') {
      void refreshLookups(['customers']);
      return;
    }
    if (fieldId === 'statusId') {
      void refreshLookups(['statuses']);
      return;
    }
    if (fieldId === 'pricingPolicyId') {
      void refreshLookups(['pricingPolicies']);
      return;
    }
    if (fieldId === 'marketId') {
      void refreshLookups(['markets']);
      return;
    }
    if (fieldId === 'salesDivisionId') {
      void refreshLookups(['salesDivisions']);
      return;
    }
    if (
      fieldId === 'salesCreationPersonId' ||
      fieldId === 'salesPersonId' ||
      fieldId === 'approvalUserId'
    ) {
      void refreshLookups(['users']);
      return;
    }
    if (fieldId === 'erpFwcProjectId') {
      void refreshLookups(['fwcProjects']);
      return;
    }
    if (fieldId === 'currencyId') {
      void refreshLookups(['currencies']);
      return;
    }
    if (fieldId === 'contactId') {
      const customerId = values.customerId.trim();
      if (!customerId) return;
      void loadContactsForCustomer(customerId);
    }
  }, [loadContactsForCustomer, refreshLookups, values.customerId]);

  const renderFieldControl = (field: FieldConfig) => {
    const fieldId = `offer-create-${field.id}`;
    const value = values[field.id as keyof FormValues];
    const error = fieldErrors[field.id as keyof FormValues];
    const disabled = field.readOnly || (field.dependsOnCustomer && !values.customerId) || submitting;
    const invalid = Boolean(error);
    const showErrorText = typeof error === 'string' && error.length > 0 && error !== 'Required';

    if (field.id === 'customerId') {
      const filtered = customerText.trim()
        ? localCustomers.filter((option) => {
            const label = option.label?.toLowerCase() ?? '';
            const val = option.value?.toLowerCase() ?? '';
            const search = customerText.toLowerCase();
            return label.includes(search) || val.includes(search);
          })
        : localCustomers;
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
            onKeyDown={(event) => {
              if (event.key === 'Enter' && showCustomerList && filtered.length > 0) {
                event.preventDefault();
                setCustomerSelection(filtered[0], filtered[0].label);
                setShowCustomerList(false);
              }
            }}
            onBlur={handleCustomerBlur}
            onFocus={(event) => {
              event.target.select();
              refreshFieldLookups('customerId');
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
              onMouseDown={() => { if (!dependsOnCustomer) refreshFieldLookups(field.id); }}
              onFocus={() => { if (!dependsOnCustomer) refreshFieldLookups(field.id); }}
              onChange={(event) => {
                const newValue = event.target.value;
                handleChange(field.id as keyof FormValues, newValue);
              }}
            >
              {!field.hideEmptyOption && <option value="">{placeholder}</option>}
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
          min={field.id === 'probability' ? PROBABILITY_MIN : undefined}
          max={field.id === 'probability' ? PROBABILITY_MAX : undefined}
          step={field.id === 'probability' ? 1 : undefined}
          inputMode={field.id === 'probability' ? 'numeric' : undefined}
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
