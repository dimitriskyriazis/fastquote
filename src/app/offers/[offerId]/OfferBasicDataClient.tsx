'use client';

import { useMemo, useState, useCallback, useRef, useEffect, type MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';
import styles from './OfferBasicDataPanel.module.css';
import type {
  OfferBasicRecord,
  OfferContactInfo,
  OfferBasicUpdateField,
  OfferDropdownOption,
  MarketOption,
} from './OfferBasicDataTypes';
import { showToastMessage } from '../../../lib/toast';
import { useUnsavedChanges } from '../../hooks/useUnsavedChanges';
import { useUndoStack } from '../../hooks/useUndoStack';
import { useAutoSaveTimer } from '../../hooks/useAutoSaveTimer';
import { pushCellEditUndo } from '../../../lib/undoHelpers';
import { addRecentOffer, buildRecentOfferLabel } from '../../lib/recentOffers';
import UKDatePicker from '../../components/DatePicker';
import { formatDisplayValue } from '../../lib/formatDisplayValue';
import { normalizeValueForApi } from '../../lib/normalizeValueForApi';
import { formatDateInputValue } from '../../lib/formatDateInputValue';
import { useOfferLookups, type LookupKey } from './useOfferLookups';
import { useCustomerSearch } from './useCustomerSearch';

type UserOption = OfferDropdownOption & { salesSeniorityName?: string | null };

type Props = {
  offerId: string;
  record: OfferBasicRecord;
  contacts: OfferContactInfo[];
  customers: OfferDropdownOption[];
  statuses: OfferDropdownOption[];
  pricingPolicies: OfferDropdownOption[];
  markets: MarketOption[];
  salesDivisions: OfferDropdownOption[];
  users: UserOption[];
  fwcProjects: OfferDropdownOption[];
};

type SectionKey = 'general' | 'info' | 'commercial' | 'code' | 'dates';

type FieldDefinition = {
  id: string;
  label: string;
  section: SectionKey;
  recordKey: keyof OfferBasicRecord;
  updateField?: OfferBasicUpdateField;
  span?: number;
  fullWidth?: boolean;
  required?: boolean;
  multiline?: boolean;
  inputType?: string;
  valueType?: 'string' | 'number' | 'date';
  readOnly?: boolean;
  resolveValue?: (record: OfferBasicRecord) => string | null | undefined;
  readOnlyDisplayValue?: (record: OfferBasicRecord) => string | null | undefined;
  options?: OfferDropdownOption[];
  datalistOptions?: OfferDropdownOption[];
};

const normalizeSortText = (value: string | null | undefined): string =>
  (value ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .trim();

const sortContacts = (list: OfferContactInfo[]) =>
  [...list].sort((a, b) => {
    const aName = normalizeSortText(a.FullName);
    const bName = normalizeSortText(b.FullName);
    if (aName < bName) return -1;
    if (aName > bName) return 1;

    const aRaw = (a.FullName ?? '').trim();
    const bRaw = (b.FullName ?? '').trim();
    if (aRaw < bRaw) return -1;
    if (aRaw > bRaw) return 1;

    return Number(a.ContactID) - Number(b.ContactID);
  });

const normalizeContactNamePart = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.trim();
};

const splitContactName = (fullName: string | null | undefined): { firstName: string; lastName: string } => {
  const normalized = normalizeContactNamePart(fullName);
  if (!normalized) return { firstName: '', lastName: '' };
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: normalized, lastName: '' };
  return {
    firstName: parts[0] ?? '',
    lastName: parts.slice(1).join(' '),
  };
};

const SECTION_METADATA: Record<SectionKey, { title: string; gridClass: string }> = {
  general: { title: 'General', gridClass: styles.generalGrid },
  info: { title: 'Info', gridClass: styles.fieldGrid },
  commercial: { title: 'Commercial', gridClass: styles.fieldGrid },
  code: { title: 'Code Number', gridClass: styles.fieldGrid },
  dates: { title: 'Dates', gridClass: styles.fieldGrid },
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

const PROBABILITY_MIN = 0;
const PROBABILITY_MAX = 100;

type CustomerContactsResponse = {
  ok?: boolean;
  error?: string;
  contacts?: OfferContactInfo[];
};

const normalizeProbability = (rawValue: string): number | null => {
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < PROBABILITY_MIN || parsed > PROBABILITY_MAX) return null;
  return parsed;
};

const normalizePositiveInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
  }
  return null;
};

const buildFieldDefinitions = (
  customers: OfferDropdownOption[],
  statuses: OfferDropdownOption[],
  pricingPolicies: OfferDropdownOption[],
  markets: OfferDropdownOption[],
  salesDivisions: OfferDropdownOption[],
  salesUsers: OfferDropdownOption[],
  approvalUsers: OfferDropdownOption[],
  contacts: OfferDropdownOption[],
  fwcProjects: OfferDropdownOption[],
): FieldDefinition[] => [
  { id: 'title', label: 'Title', section: 'general', recordKey: 'Title', updateField: 'Title' },
  { id: 'description', label: 'Description', section: 'general', recordKey: 'Description', updateField: 'Description' },
  { id: 'paymentTerms', label: 'Payment Terms', section: 'general', recordKey: 'PaymentTerms', updateField: 'PaymentTerms', multiline: true },
  { id: 'install', label: 'Installation Schedule', section: 'general', recordKey: 'InstallationSchedule', updateField: 'InstallationSchedule', multiline: true },
  { id: 'closingNote', label: 'Closing Note', section: 'general', recordKey: 'OfferNotesClosing', updateField: 'OfferNotesClosing', multiline: true },
  { id: 'offerValidity', label: 'Offer Validity', section: 'general', recordKey: 'OfferValidity', updateField: 'OfferValidity' },
  { id: 'deliveryTime', label: 'Delivery Time', section: 'general', recordKey: 'DeliveryTime', updateField: 'DeliveryTime' },
  { id: 'introNote', label: 'Introduction Note', section: 'general', recordKey: 'OfferNotesIntroduction', updateField: 'OfferNotesIntroduction', multiline: true },
  {
    id: 'customer',
    label: 'Customer',
    section: 'general',
    recordKey: 'CustomerID',
    updateField: 'CustomerID',
    valueType: 'number',
    options: customers,
  },
  {
    id: 'status',
    label: 'Status',
    section: 'general',
    recordKey: 'StatusID',
    updateField: 'StatusID',
    valueType: 'number',
    options: statuses,
  },

  {
    id: 'contactId',
    label: 'Contact',
    section: 'info',
    recordKey: 'ContactID',
    updateField: 'ContactID',
    valueType: 'number',
    options: contacts,
    fullWidth: true,
  },
  { id: 'telmaco', label: 'Telmaco Note', section: 'info', recordKey: 'TelmacoNote', updateField: 'Comments', multiline: true },

  {
    id: 'pricingPolicy',
    label: 'Pricing Policy',
    section: 'commercial',
    recordKey: 'PricingPolicyID',
    updateField: 'PricingPolicyID',
    valueType: 'number',
    options: pricingPolicies,
    required: true,
  },
  {
    id: 'market',
    label: 'Market',
    section: 'commercial',
    recordKey: 'MarketID',
    updateField: 'MarketID',
    valueType: 'number',
    options: markets,
  },
  {
    id: 'division',
    label: 'Sales Division',
    section: 'commercial',
    recordKey: 'SalesDivisionID',
    updateField: 'SalesDivisionID',
    valueType: 'number',
    options: salesDivisions,
  },
  {
    id: 'salesCreation',
    label: 'Sales Creation Person',
    section: 'commercial',
    recordKey: 'SalesCreationPersonId',
    updateField: 'CreatedBy',
    valueType: 'string',
    options: salesUsers,
    readOnly: true,
  },
  {
    id: 'salesPersonId',
    label: 'Sales Person',
    section: 'commercial',
    recordKey: 'SalesPersonId',
    updateField: 'SalesPersonId',
    options: salesUsers,
    valueType: 'string',
  },
  {
    id: 'approvalUserId',
    label: 'Approval User',
    section: 'commercial',
    recordKey: 'ApprovalUserId',
    updateField: 'ApprovalUserId',
    options: approvalUsers,
    valueType: 'string',
  },
  {
    id: 'erpProjectCode',
    label: 'ERP Project Code',
    section: 'code',
    recordKey: 'ERPProjectCode',
    updateField: 'ERPProjectCode',
    valueType: 'string',
  },
  {
    id: 'erpFwcProjectId',
    label: 'ERP FWC Project',
    section: 'code',
    recordKey: 'ERPFWCProjectID',
    updateField: 'ERPFWCProjectID',
    valueType: 'number',
    options: fwcProjects,
  },
  {
    id: 'probability',
    label: 'Probability',
    section: 'code',
    recordKey: 'Probability',
    updateField: 'Probability',
    valueType: 'number',
    inputType: 'number',
  },
  { id: 'offerVersion', label: 'Offer Version', section: 'code', recordKey: 'OfferVersion', readOnly: true },
  { id: 'offerId', label: 'Offer ID', section: 'code', recordKey: 'OfferID', readOnly: true },
  { id: 'customerRef', label: 'Customer Ref', section: 'code', recordKey: 'CustomerRef', updateField: 'CustomerRef' },
  { id: 'protocolNo', label: 'Protocol No', section: 'code', recordKey: 'ProtocolNo', updateField: 'ProtocolNo', valueType: 'number', inputType: 'number' },

  { id: 'initialRequest', label: 'Draft Request', section: 'dates', recordKey: 'DraftRequestDate', updateField: 'DraftRequestDate', inputType: 'date', valueType: 'date' },
  { id: 'draftOffer', label: 'Draft Offer', section: 'dates', recordKey: 'DraftOfferDate', updateField: 'DraftOfferDate', inputType: 'date', valueType: 'date' },
  { id: 'officialRequest', label: 'Request', section: 'dates', recordKey: 'RequestDate', updateField: 'RequestDate', inputType: 'date', valueType: 'date' },
  { id: 'offerDate', label: 'Offer', section: 'dates', recordKey: 'OfferDate', updateField: 'OfferDate', inputType: 'date', valueType: 'date' },
  { id: 'offerDeadline', label: 'Offer Deadline', section: 'dates', recordKey: 'OfferDeadlineDate', updateField: 'OfferDeadlineDate', inputType: 'date', valueType: 'date' },
  { id: 'orderSigned', label: 'Order Signed', section: 'dates', recordKey: 'OrderSignedDate', updateField: 'OrderSignedDate', inputType: 'date', valueType: 'date' },
  { id: 'possibleOrderDate', label: 'Possible Order', section: 'dates', recordKey: 'PossibleOrderDate', updateField: 'PossibleOrderDate', inputType: 'date', valueType: 'date' },
  { id: 'deliveryDue', label: 'Delivery Due', section: 'dates', recordKey: 'DeliveryDueDate', updateField: 'DeliveryDueDate', inputType: 'date', valueType: 'date' },
];


const formatInitialValue = (record: OfferBasicRecord, def: FieldDefinition) => {
  const raw = record[def.recordKey];
  if (def.inputType === 'date' || def.valueType === 'date') {
    return formatDateInputValue(raw as Date | string | null | undefined);
  }
  if (raw == null) return '';
  return typeof raw === 'string' ? raw : String(raw);
};

const resolveFieldValue = (record: OfferBasicRecord, def: FieldDefinition) =>
  (typeof def.resolveValue === 'function' ? def.resolveValue(record) : record[def.recordKey]) ?? null;

export default function OfferBasicDataClient({
  offerId,
  record,
  contacts,
  customers,
  statuses,
  pricingPolicies,
  markets,
  salesDivisions,
  users,
  fwcProjects,
}: Props) {
  const { lookups, updateLookup, refreshLookups: refreshLookupsRaw } = useOfferLookups({
    customers, statuses, pricingPolicies, markets, salesDivisions, users, fwcProjects,
  });
  const { customers: localCustomers, statuses: localStatuses, pricingPolicies: localPricingPolicies,
    markets: localMarkets, salesDivisions: localSalesDivisions, users: localUsers,
    fwcProjects: localFwcProjects } = lookups;

  const refreshLookups = useCallback(async (keys: LookupKey[]) => {
    try {
      await refreshLookupsRaw(keys);
    } catch {
      showToastMessage('Unable to refresh latest dropdown values.', 'warning');
    }
  }, [refreshLookupsRaw]);

  const searchCustomers = useCustomerSearch(
    useCallback((results) => updateLookup('customers', results), [updateLookup]),
  );

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

  const [contactEntries, setContactEntries] = useState<OfferContactInfo[]>(contacts);
  const [isRefreshingContacts, setIsRefreshingContacts] = useState(false);
  const [includeInitialContactOption, setIncludeInitialContactOption] = useState(true);
  const contactRefreshTokenRef = useRef(0);

  const contactOptions = useMemo(() => {
    const sortedContacts = sortContacts(contactEntries);
    const options = sortedContacts.map((contact) => {
      const fallback = `Contact ${contact.ContactID}`;
      const fullName =
        contact.FullName?.trim() ||
        [contact.FirstName, contact.LastName]
          .map((part) => part?.trim())
          .filter(Boolean)
          .join(' ');
      return {
        value: String(contact.ContactID),
        label: fullName || fallback,
      };
    });

    const selectedId = includeInitialContactOption ? record.ContactID : null;
    if (
      selectedId != null &&
      !options.some((option) => Number(option.value) === Number(selectedId))
    ) {
      const fallback = `Contact ${selectedId}`;
      const label = (record.ContactFullName ?? '').trim() || fallback;
      options.push({ value: String(selectedId), label });
    }

    return options;
  }, [contactEntries, includeInitialContactOption, record.ContactFullName, record.ContactID]);

  const fwcProjectOptions = useMemo(() => {
    const options = [...localFwcProjects];
    const selectedId = record.ERPFWCProjectID;
    if (
      selectedId != null &&
      !options.some((option) => Number(option.value) === Number(selectedId))
    ) {
      options.push({
        value: String(selectedId),
        label: String(selectedId),
      });
    }
    return options;
  }, [localFwcProjects, record.ERPFWCProjectID]);

  const customerOptions = useMemo(() => {
    const options = [...localCustomers];
    const selectedId = record.CustomerID;
    if (
      selectedId != null &&
      !options.some((option) => Number(option.value) === Number(selectedId))
    ) {
      options.push({
        value: String(selectedId),
        label: record.CustomerName?.trim() || `Customer ${selectedId}`,
      });
    }
    return options;
  }, [localCustomers, record.CustomerID, record.CustomerName]);

  const salesDivisionOptions = useMemo(() => {
    const options = [...localSalesDivisions];
    const selectedId = record.SalesDivisionID;
    if (
      selectedId != null &&
      !options.some((option) => Number(option.value) === Number(selectedId))
    ) {
      options.push({
        value: String(selectedId),
        label: record.SalesDivisionName?.trim() || `Sales Division ${selectedId}`,
      });
    }
    return options;
  }, [localSalesDivisions, record.SalesDivisionID, record.SalesDivisionName]);

  useEffect(() => {
    const trimmedDescription = typeof record.Description === 'string'
      ? record.Description.trim()
      : null;
    const trimmedTitle = typeof record.Title === 'string'
      ? record.Title.trim()
      : null;
    const label = buildRecentOfferLabel({
      title: trimmedTitle,
      description: trimmedDescription,
    });
    void addRecentOffer({
      id: offerId,
      label,
      customerName: record.CustomerName ?? null,
      description: trimmedDescription || null,
      title: trimmedTitle || null,
    });
  }, [offerId, record.CustomerName, record.Description, record.Title]);

  const fieldDefinitions = useMemo(
    () =>
      buildFieldDefinitions(
        customerOptions,
        localStatuses,
        localPricingPolicies,
        localMarkets,
        salesDivisionOptions,
        salesUsers,
        approvalUsers,
        contactOptions,
        fwcProjectOptions,
      ),
    [
      customerOptions,
      localStatuses,
      localPricingPolicies,
      localMarkets,
      salesDivisionOptions,
      salesUsers,
      approvalUsers,
      contactOptions,
      fwcProjectOptions,
    ],
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
  const isDirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(savedValues), [values, savedValues]);
  useUnsavedChanges(isDirty);
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [undoPortal, setUndoPortal] = useState<Element | null>(null);
  useEffect(() => {
    setUndoPortal(document.getElementById('undo-portal'));
  }, []);
  const [customerText, setCustomerText] = useState('');
  const [showCustomerList, setShowCustomerList] = useState(false);
  const customerListCloseTimerRef = useRef<NodeJS.Timeout | null>(null);
  const savedValuesRef = useRef(savedValues);
  savedValuesRef.current = savedValues;
  const filteredMarkets = useMemo(() => {
    const divisionValue = values.division ?? '';
    if (!divisionValue) return localMarkets as OfferDropdownOption[];
    return localMarkets.filter(
      (market) => market.salesDivisionId === divisionValue,
    ) as OfferDropdownOption[];
  }, [localMarkets, values.division]);

  // Clear market when selected division changes and current market doesn't belong to it
  useEffect(() => {
    const divisionValue = values.division ?? '';
    const marketValue = values.market ?? '';
    if (!divisionValue || !marketValue) return;
    const currentMarket = localMarkets.find((m) => m.value === marketValue);
    if (currentMarket && currentMarket.salesDivisionId !== divisionValue) {
      setValues((prev) => ({ ...prev, market: '' }));
    }
  }, [localMarkets, values.division, values.market]);

  const [contextMenuState, setContextMenuState] = useState<{
    x: number;
    y: number;
    fieldId: 'customer' | 'contactId';
  } | null>(null);

  useEffect(() => {
    setContactEntries(contacts);
    setIncludeInitialContactOption(true);
  }, [contacts]);

  const activeContactId = useMemo(() => {
    const raw = values.contactId ?? '';
    if (!raw) return null;
    const parsed = Number.parseInt(String(raw), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [values.contactId]);

  const activeContactName = useMemo(() => {
    if (activeContactId == null) return null;
    if (activeContactId != null) {
      const fromOptions = contactOptions.find((option) => Number(option.value) === activeContactId);
      const label = fromOptions?.label?.trim();
      if (label) return label;
    }
    return `Contact ${activeContactId}`;
  }, [activeContactId, contactOptions]);

  const activeContactNameParts = useMemo(() => {
    if (activeContactId != null) {
      const selected = contactEntries.find((entry) => Number(entry.ContactID) === activeContactId);
      const firstName = normalizeContactNamePart(selected?.FirstName);
      const lastName = normalizeContactNamePart(selected?.LastName);
      if (firstName || lastName) {
        return { firstName, lastName };
      }
    }
    return splitContactName(activeContactName);
  }, [activeContactId, activeContactName, contactEntries]);

  const activeCustomerId = useMemo(() => {
    const raw = values.customer ?? '';
    const parsed = Number.parseInt(String(raw), 10);
    if (Number.isInteger(parsed) && parsed > 0) return parsed;
    const fallback = Number(record.CustomerID);
    return Number.isInteger(fallback) && fallback > 0 ? fallback : null;
  }, [record.CustomerID, values.customer]);

  const hasCustomerNavigation = activeCustomerId != null;
  const hasContactNavigation = typeof activeContactName === 'string' && activeContactName.length > 0;

  const closeContextMenu = useCallback(() => {
    setContextMenuState(null);
  }, []);

  const handleContextMenuAction = useCallback((fieldId: 'customer' | 'contactId') => {
    if (fieldId === 'customer') {
      if (activeCustomerId == null) return;
      const customerUrl = `/customers/${encodeURIComponent(String(activeCustomerId))}/basicdata`;
      window.open(customerUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    if (!hasContactNavigation || !activeContactName) return;
    const params = new URLSearchParams();
    if (activeContactNameParts.firstName) {
      params.set('firstName', activeContactNameParts.firstName);
    }
    if (activeContactNameParts.lastName) {
      params.set('lastName', activeContactNameParts.lastName);
    }
    if (params.size === 0) {
      params.set('contactName', activeContactName);
    }
    const contactUrl = `/contacts?${params.toString()}`;
    window.open(contactUrl, '_blank', 'noopener,noreferrer');
  }, [activeContactName, activeContactNameParts.firstName, activeContactNameParts.lastName, activeCustomerId, hasContactNavigation]);

  const handleFieldContextMenu = useCallback(
    (event: ReactMouseEvent, fieldId: 'customer' | 'contactId') => {
      const canOpen =
        (fieldId === 'customer' && hasCustomerNavigation) ||
        (fieldId === 'contactId' && hasContactNavigation);
      if (!canOpen) return;
      event.preventDefault();
      setContextMenuState({
        x: event.clientX,
        y: event.clientY,
        fieldId,
      });
    },
    [hasContactNavigation, hasCustomerNavigation],
  );

  useEffect(() => {
    if (!contextMenuState) return;
    const handlePointerDown = () => closeContextMenu();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handlePointerDown, true);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handlePointerDown, true);
    };
  }, [closeContextMenu, contextMenuState]);

  const scheduleAutoSaveRef = useRef<(fieldId: string) => void>(() => {});
  const cancelAutoSaveRef = useRef<(fieldId: string) => void>(() => {});

  const handleValueChange = useCallback((fieldId: string, value: string) => {
    setValues((prev) => ({ ...prev, [fieldId]: value }));
    scheduleAutoSaveRef.current(fieldId);
  }, []);

  const fetchContactsByCustomer = useCallback(async (customerId: number | null): Promise<OfferContactInfo[]> => {
    if (!customerId) return [];
    const response = await fetch(`/api/customers/${encodeURIComponent(String(customerId))}/contacts`, {
      cache: 'no-store',
    });
    const payload = (await response.json().catch(() => null)) as CustomerContactsResponse | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.contacts)) {
      throw new Error(payload?.error ?? 'Unable to load contacts');
    }
    return payload.contacts
      .map((contact) => {
        const contactId = normalizePositiveInteger(contact.ContactID);
        if (!contactId) return null;
        const firstName = typeof contact.FirstName === 'string' ? contact.FirstName.trim() : null;
        const lastName = typeof contact.LastName === 'string' ? contact.LastName.trim() : null;
        const fallbackName = [firstName, lastName].filter(Boolean).join(' ');
        return {
          ContactID: contactId,
          FirstName: firstName,
          LastName: lastName,
          FullName: (typeof contact.FullName === 'string' ? contact.FullName.trim() : '') || fallbackName || `Contact ${String(contactId)}`,
        };
      })
      .filter((contact): contact is OfferContactInfo => contact != null);
  }, []);

  const saveField = useCallback(async (def: FieldDefinition, rawValue: string) => {
    if (!def.updateField) return;
    let payloadValue: string | number | null | undefined;
    let resolvedDisplayValue = rawValue;
    if (def.id === 'probability') {
      const parsed = normalizeProbability(rawValue);
      if (parsed == null) {
        showToastMessage(`Probability must be an integer between ${PROBABILITY_MIN} and ${PROBABILITY_MAX}`, 'error');
        setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
        return;
      }
      payloadValue = parsed;
      resolvedDisplayValue = String(parsed);
    } else if (def.datalistOptions && def.datalistOptions.length > 0) {
      const trimmed = rawValue.trim().toLowerCase();
      const match = def.datalistOptions.find(
        (option) => option.label.trim().toLowerCase() === trimmed
      );
      if (!match) {
        showToastMessage('Please choose a valid user', 'error');
        setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
        return;
      }
      resolvedDisplayValue = match.label;
      payloadValue = normalizeValueForApi(match.value, def.valueType);
    } else {
      payloadValue = normalizeValueForApi(rawValue, def.valueType);
    }
    // Capture current saved state for undo before sending the update
    const oldDisplayValue = savedValuesRef.current[def.id] ?? '';
    let oldPayloadValue: string | number | null | undefined;
    if (def.id === 'probability') {
      oldPayloadValue = normalizeProbability(oldDisplayValue) ?? null;
    } else if (def.datalistOptions && def.datalistOptions.length > 0) {
      const trimmedOld = oldDisplayValue.trim().toLowerCase();
      const oldMatch = def.datalistOptions.find(
        (option) => option.label.trim().toLowerCase() === trimmedOld,
      );
      oldPayloadValue = oldMatch != null ? normalizeValueForApi(oldMatch.value, def.valueType) : null;
    } else {
      oldPayloadValue = normalizeValueForApi(oldDisplayValue, def.valueType);
    }
    setPendingFields((prev) => ({ ...prev, [def.id]: true }));
    try {
      const response = await fetch(`/api/offers/${encodeURIComponent(offerId)}/basicdata`, {
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

      if (def.id === 'customer') {
        setIncludeInitialContactOption(false);
        setSavedValues((prev) => {
          const next = { ...prev, contactId: '' };
          savedValuesRef.current = next;
          return next;
        });
        setValues((prev) => ({ ...prev, contactId: '' }));

        const nextCustomerId = normalizePositiveInteger(payloadValue);
        const refreshToken = contactRefreshTokenRef.current + 1;
        contactRefreshTokenRef.current = refreshToken;
        setIsRefreshingContacts(true);
        setContactEntries([]);
        try {
          const nextContacts = await fetchContactsByCustomer(nextCustomerId);
          if (contactRefreshTokenRef.current === refreshToken) {
            setContactEntries(nextContacts);
          }
        } catch (contactsErr) {
          if (contactRefreshTokenRef.current === refreshToken) {
            setContactEntries([]);
          }
          console.error(contactsErr);
          showToastMessage('Customer updated but contacts could not be refreshed.', 'warning');
        } finally {
          if (contactRefreshTokenRef.current === refreshToken) {
            setIsRefreshingContacts(false);
          }
        }
      }

      const capturedOldDisplayValue = oldDisplayValue;
      const capturedOldPayloadValue = oldPayloadValue;
      pushCellEditUndo(pushUndo, performUndo, def.label, async () => {
        const undoRes = await fetch(`/api/offers/${encodeURIComponent(offerId)}/basicdata`, {
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
      setValues((prev) => ({ ...prev, [def.id]: savedValuesRef.current[def.id] ?? '' }));
      console.error(err);
      showToastMessage(`Unable to update ${def.label}. Please try again.`, 'error');
    } finally {
      setPendingFields((prev) => ({ ...prev, [def.id]: false }));
    }
  }, [fetchContactsByCustomer, offerId, pushUndo, performUndo]);

  const handleBlur = useCallback((def: FieldDefinition) => {
    cancelAutoSaveRef.current(def.id);
    if (!def.updateField) return;
    const latestValue = values[def.id] ?? '';
    if (latestValue === savedValuesRef.current[def.id]) return;
    void saveField(def, latestValue);
  }, [saveField, values]);

  const { scheduleAutoSave, cancelAutoSave } = useAutoSaveTimer({
    values,
    savedValuesRef,
    fieldDefinitions: editableFields,
    saveField,
  });
  scheduleAutoSaveRef.current = scheduleAutoSave;
  cancelAutoSaveRef.current = cancelAutoSave;

  const handleDateChange = useCallback((def: FieldDefinition, newValue: string) => {
    cancelAutoSaveRef.current(def.id);
    handleValueChange(def.id, newValue);
    if (!def.updateField) return;
    if (newValue === savedValuesRef.current[def.id]) return;
    void saveField(def, newValue);
  }, [handleValueChange, saveField]);

  const customerFieldDefinition = useMemo(
    () => fieldDefinitions.find((def) => def.id === 'customer'),
    [fieldDefinitions],
  );

  useEffect(() => {
    const selectedValue = values.customer ?? '';
    const selectedOption = customerOptions.find((option) => option.value === selectedValue);
    setCustomerText(selectedOption?.label ?? '');
  }, [customerOptions, values.customer]);

  useEffect(() => {
    return () => {
      if (customerListCloseTimerRef.current) {
        clearTimeout(customerListCloseTimerRef.current);
      }
    };
  }, []);

  const filteredCustomerOptions = useMemo(() => {
    const search = customerText.trim().toLowerCase();
    if (!search) return customerOptions;
    return customerOptions.filter((option) => {
      const label = option.label?.toLowerCase() ?? '';
      const value = option.value?.toLowerCase() ?? '';
      return label.includes(search) || value.includes(search);
    });
  }, [customerOptions, customerText]);

  const handleCustomerSelection = useCallback((option: OfferDropdownOption) => {
    setShowCustomerList(false);
    setValues((prev) => ({ ...prev, customer: option.value }));
    setCustomerText(option.label);
    if (customerFieldDefinition?.updateField && option.value !== savedValuesRef.current.customer) {
      void saveField(customerFieldDefinition, option.value);
    }
  }, [customerFieldDefinition, saveField]);

  const handleCustomerBlur = useCallback(() => {
    customerListCloseTimerRef.current = setTimeout(() => setShowCustomerList(false), 120);
    const trimmed = customerText.trim();
    if (!customerFieldDefinition?.updateField) return;

    if (!trimmed) {
      if ((savedValuesRef.current.customer ?? '') !== '') {
        setValues((prev) => ({ ...prev, customer: '' }));
        void saveField(customerFieldDefinition, '');
      }
      return;
    }

    const selected = customerOptions.find((option) => {
      const optionLabel = option.label.trim().toLowerCase();
      const optionValue = option.value.trim().toLowerCase();
      const normalized = trimmed.toLowerCase();
      return optionLabel === normalized || optionValue === normalized;
    });
    if (!selected) {
      const savedId = savedValuesRef.current.customer ?? '';
      const savedLabel = customerOptions.find((option) => option.value === savedId)?.label ?? '';
      setCustomerText(savedLabel);
      setValues((prev) => ({ ...prev, customer: savedId }));
      showToastMessage('Please choose a valid customer', 'error');
      return;
    }
    if (selected.value !== (savedValuesRef.current.customer ?? '')) {
      setValues((prev) => ({ ...prev, customer: selected.value }));
      setCustomerText(selected.label);
      void saveField(customerFieldDefinition, selected.value);
      return;
    }
    setCustomerText(selected.label);
    setValues((prev) => ({ ...prev, customer: selected.value }));
  }, [customerFieldDefinition, customerOptions, customerText, saveField]);

  const refreshFieldLookups = useCallback((fieldId: string) => {
    if (fieldId === 'customer') {
      void refreshLookups(['customers']);
      return;
    }
    if (fieldId === 'status') {
      void refreshLookups(['statuses']);
      return;
    }
    if (fieldId === 'pricingPolicy') {
      void refreshLookups(['pricingPolicies']);
      return;
    }
    if (fieldId === 'market') {
      void refreshLookups(['markets']);
      return;
    }
    if (fieldId === 'division') {
      void refreshLookups(['salesDivisions']);
      return;
    }
    if (fieldId === 'salesCreation' || fieldId === 'salesPersonId' || fieldId === 'approvalUserId') {
      void refreshLookups(['users']);
      return;
    }
    if (fieldId === 'erpFwcProjectId') {
      void refreshLookups(['fwcProjects']);
      return;
    }
    if (fieldId === 'contactId') {
      const customerId =
        normalizePositiveInteger(values.customer) ?? normalizePositiveInteger(record.CustomerID);
      if (customerId == null) return;
      const refreshToken = contactRefreshTokenRef.current + 1;
      contactRefreshTokenRef.current = refreshToken;
      setIsRefreshingContacts(true);
      void fetchContactsByCustomer(customerId)
        .then((nextContacts) => {
          if (contactRefreshTokenRef.current === refreshToken) {
            setContactEntries(nextContacts);
            setIncludeInitialContactOption(false);
          }
        })
        .catch((err) => {
          if (contactRefreshTokenRef.current === refreshToken) {
            setContactEntries([]);
          }
          console.error(err);
          showToastMessage('Unable to refresh contacts.', 'warning');
        })
        .finally(() => {
          if (contactRefreshTokenRef.current === refreshToken) {
            setIsRefreshingContacts(false);
          }
        });
    }
  }, [fetchContactsByCustomer, record.CustomerID, refreshLookups, values.customer]);

  const renderLookupAddButton = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (_: FieldDefinition) => null,
    [],
  );

  const getFieldContextMenuItemLabel = useCallback((fieldId: string) => {
    if (fieldId === 'customer' && hasCustomerNavigation) return 'View Customer';
    if (fieldId === 'contactId' && hasContactNavigation) return 'View Contact';
    return null;
  }, [hasContactNavigation, hasCustomerNavigation]);

  const renderFieldControl = (
  def: FieldDefinition,
  valueMap: Record<string, string>,
  pendingMap: Record<string, boolean>,
  handleValueChange: (fieldId: string, value: string) => void,
  handleDateChange: (def: FieldDefinition, newValue: string) => void,
  handleBlur: (def: FieldDefinition) => void,
  record: OfferBasicRecord,
) => {
  const isEditable = Boolean(def.updateField && !def.readOnly);
  const controlId = `offer-field-${def.id}`;
  const value = isEditable ? (valueMap[def.id] ?? '') : resolveFieldValue(record, def);
  const readOnlyDisplayValue = typeof def.readOnlyDisplayValue === 'function'
    ? def.readOnlyDisplayValue(record)
    : null;
  const placeholder = !isEditable ? undefined : (value == null || value === '' ? '—' : undefined);
  const pending = pendingMap[def.id] || (def.id === 'contactId' && isRefreshingContacts);

  if (!isEditable) {
    if (def.options && def.options.length > 0) {
      const readonlyValue = value == null ? '' : String(value);
      const matchingOption = def.options.find((option) => String(option.value) === readonlyValue);
      const displayValue =
        matchingOption?.label ??
        readOnlyDisplayValue ??
        (readonlyValue ? formatDisplayValue(readonlyValue) : '—');
      return (
        <div className={styles.fieldReadonly} id={controlId}>
          {displayValue}
        </div>
      );
    }
    return (
      <div className={styles.fieldReadonly} id={controlId}>
        {formatDisplayValue(value)}
      </div>
    );
  }

  if (isEditable && def.options && def.options.length > 0) {
    if (def.id === 'customer') {
      return (
        <div className={styles.comboWrapper}>
          <input
            autoComplete="off"
            id={controlId}
            name={def.id}
            className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
            value={customerText}
            placeholder="Type to filter customers"
            onChange={(event) => {
              const value = event.target.value;
              setCustomerText(value);
              setShowCustomerList(true);
              searchCustomers(value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && showCustomerList && filteredCustomerOptions.length > 0) {
                event.preventDefault();
                handleCustomerSelection(filteredCustomerOptions[0]);
              }
            }}
            onBlur={handleCustomerBlur}
            onFocus={(event) => {
              event.target.select();
              refreshFieldLookups('customer');
              setShowCustomerList(true);
            }}
          />
          {showCustomerList && filteredCustomerOptions.length > 0 ? (
            <div className={styles.comboList}>
              {filteredCustomerOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={styles.comboOption}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => handleCustomerSelection(option)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      );
    }

    const selectOptions = def.id === 'market' ? filteredMarkets : def.options;
    return (
      <select
        id={controlId}
        name={def.id}
        className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
        value={valueMap[def.id] ?? ''}
        onMouseDown={() => refreshFieldLookups(def.id)}
        onFocus={() => refreshFieldLookups(def.id)}
        onChange={(event) => handleValueChange(def.id, event.target.value)}
        onBlur={() => handleBlur(def)}
      >
        <option value="">Select...</option>
        {selectOptions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (isEditable && def.datalistOptions && def.datalistOptions.length > 0) {
    const listId = `datalist-${def.id}`;
    return (
      <>
        <input
          autoComplete="off"
          id={controlId}
          name={def.id}
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          value={valueMap[def.id] ?? ''}
          list={listId}
          placeholder={placeholder}
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
          value={values[def.id] ?? ''}
          placeholder={placeholder}
          onChange={(event) => handleValueChange(def.id, event.target.value)}
          onBlur={() => handleBlur(def)}
        />
      );
    }

    if (def.inputType === 'date' || def.valueType === 'date') {
      return (
        <UKDatePicker
          value={values[def.id] ?? ''}
          onChange={(newValue) => handleDateChange(def, newValue)}
          placeholder="DD/MM/YYYY"
          className={`${styles.fieldControl} ${pending ? styles.fieldControlPending : ''}`}
          disabled={pending}
          required={def.required}
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
          min={def.id === 'probability' ? PROBABILITY_MIN : undefined}
          max={def.id === 'probability' ? PROBABILITY_MAX : undefined}
          step={def.id === 'probability' ? 1 : undefined}
          inputMode={def.id === 'probability' ? 'numeric' : undefined}
          value={values[def.id] ?? ''}
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
      <section key={sectionKey} className={`${styles.detailSection} ${styles.sectionCard}`}>
        <div className={styles.sectionHeading}>{metadata.title}</div>
        <div className={styles.sectionFields}>
          {sectionFields.map((field) => {
            const spanClass = field.fullWidth
              ? styles.fieldFull
              : field.span && field.span > 1
                ? styles.fieldWide
                : '';
            return (
              <div key={field.id} className={`${styles.fieldBlock} ${spanClass}`}>
                <label className={styles.fieldLabel} htmlFor={`offer-field-${field.id}`}>
                  <div className={styles.lookupLabelRow}>
                    <div className={styles.labelText}>
                      {field.label}
                      {field.required ? <span className={styles.requiredMark}>*</span> : null}
                    </div>
                    {renderLookupAddButton(field)}
                  </div>
                </label>
                <div
                  onContextMenu={(event) => {
                    if (field.id === 'customer' || field.id === 'contactId') {
                      handleFieldContextMenu(event, field.id);
                    }
                  }}
                >
                  {renderFieldControl(field, values, pendingFields, handleValueChange, handleDateChange, handleBlur, record)}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    );
  };

  const generalFields = fieldDefinitions.filter((field) => field.section === 'general');
  const generalFieldMap = generalFields.reduce<Record<string, FieldDefinition>>((acc, field) => {
    acc[field.id] = field;
    return acc;
  }, {});

  const generalRowLayout: string[][] = [
    ['title', 'description', 'customer', 'offerValidity', 'status'],
    ['deliveryTime', 'paymentTerms', 'install', 'introNote', 'closingNote'],
  ];

  const generalRows = generalRowLayout
    .map((rowIds) => rowIds.map((id) => generalFieldMap[id]).filter((field): field is FieldDefinition => Boolean(field)))
    .filter((row) => row.length > 0);

  const assignedFieldIds = new Set(generalRowLayout.flat());
  const remainingFields = generalFields.filter((field) => !assignedFieldIds.has(field.id));
  if (remainingFields.length > 0) {
    generalRows.push(remainingFields);
  }

  return (
    <>
      {canUndo && undoPortal && createPortal(
        <button type="button" className="page-header-button" onClick={performUndo}>
          ↩ Undo{lastLabel ? `: ${lastLabel}` : ''}
        </button>,
        undoPortal,
      )}
      <section className={styles.panel}>
        <div className={`${styles.section} ${styles.sectionCard} ${styles.generalSection}`}>
          <div className={styles.sectionHeading}>{SECTION_METADATA.general.title}</div>
          <div className={styles.generalRows}>
            {generalRows.map((row, rowIdx) => (
              <div key={rowIdx} className={styles.generalRow}>
                {row.map((field) => (
                  <div key={field.id} className={styles.field}>
                    <label className={styles.fieldLabel} htmlFor={`offer-field-${field.id}`}>
                      {field.label}
                    </label>
                    <div
                      onContextMenu={(event) => {
                        if (field.id === 'customer' || field.id === 'contactId') {
                          handleFieldContextMenu(event, field.id);
                        }
                      }}
                    >
                      {renderFieldControl(field, values, pendingFields, handleValueChange, handleDateChange, handleBlur, record)}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
        <div className={styles.sectionsGrid}>
          {(['info', 'commercial', 'code', 'dates'] as SectionKey[]).map((sectionKey) =>
            renderSectionCard(sectionKey)
          )}
        </div>
      </section>
      {contextMenuState ? (
        <div
          className={styles.fieldContextMenu}
          style={{ left: contextMenuState.x, top: contextMenuState.y }}
          role="menu"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={styles.fieldContextMenuItem}
            onClick={() => {
              handleContextMenuAction(contextMenuState.fieldId);
              closeContextMenu();
            }}
          >
            <span
              className={`${styles.fieldContextMenuIcon} fastquote-menu-icon`}
              aria-hidden="true"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 4h6v6" />
                <path d="m10 14 10-10" />
                <path d="M20 14v6H4V4h6" />
              </svg>
            </span>
            {getFieldContextMenuItemLabel(contextMenuState.fieldId)}
          </button>
        </div>
      ) : null}
    </>
  );
}
