"use client";

import React, { useMemo, useCallback, useRef, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  CellEditingStartedEvent,
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
} from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import styles from "./ContactsClient.module.css";
import lookupStyles from "../components/LookupModal.module.css";
import lookupButtonStyles from "../components/LookupAddButton.module.css";
import LookupModal from "../components/LookupModal";
import { showToastMessage } from "../../lib/toast";
import { useUndoStack } from "../hooks/useUndoStack";
import { pushCellEditUndo, makePatternAUndoFn } from "../../lib/undoHelpers";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { useAddModal } from "../lib/useAddModal";
import type { DropdownOption } from "../../lib/dropdownOptions";
import type { CustomerDropdownOption } from "../customers/[customerId]/CustomerBasicDataTypes";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import {
  createContact,
  ContactFormValues,
  EMPTY_CONTACT_FORM,
  validateContactForm,
} from "./contactModalHelpers";
import { useDuplicateCheck } from "../lib/useDuplicateCheck";
import DuplicateWarning from "../components/DuplicateWarning";
import ContactGroupsMailsModal from "./ContactGroupsMailsModal";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading contacts…
    </div>
  ),
});

type Props = {
  statuses: string[];
  importances: Array<string | number>;
  customers: CustomerDropdownOption[];
  titles: DropdownOption[];
  initialContactName?: string | null;
  initialContactFirstName?: string | null;
  initialContactLastName?: string | null;
};

type ContactLookupsResponse = {
  ok?: boolean;
  error?: string;
  lookups?: {
    statuses?: string[];
    customers?: CustomerDropdownOption[];
    titles?: DropdownOption[];
    importances?: Array<string | number>;
  };
};

const DEFAULT_IMPORTANCE_VALUES: Array<string | number> = ["", "High", "Med", "Low"];

const CONTACT_FIELD_LABELS: Record<string, string> = {
  Title: "Title",
  LastName: "Last name",
  FirstName: "First name",
  Position: "Position",
  Email: "Email",
  EmailStatus: "Email status",
  SecondEmail: "Second email",
  SecondEmailStatus: "Second email status",
  Phone: "Phone",
  Mobile: "Mobile",
  Importance: "Importance",
  Enabled: "Enabled",
  CustomerEnabled: "Enabled customer",
};

const normalizeContactId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const BOOLEAN_OPTIONS = [
  { value: "1", label: "Yes" },
  { value: "0", label: "No" },
];

const TITLE_PRIORITY_ORDER = ["Mr", "Mrs", "\u039A\u03BF\u03C2", "\u039A\u03B1", "Dr", "\u0394\u03C1"] as const;

const sortTitleOptions = (options: DropdownOption[]): DropdownOption[] => {
  const priorityIndex = new Map<string, number>(
    TITLE_PRIORITY_ORDER.map((label, index) => [label, index]),
  );
  return [...options].sort((a, b) => {
    const aLabel = a.label.trim();
    const bLabel = b.label.trim();
    const aPriority = priorityIndex.get(aLabel);
    const bPriority = priorityIndex.get(bLabel);
    if (aPriority != null && bPriority != null) return aPriority - bPriority;
    if (aPriority != null) return -1;
    if (bPriority != null) return 1;
    return aLabel.localeCompare(bLabel);
  });
};

const normalizeTextInput = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const resolveContactLabel = (
  row: Record<string, unknown> | null | undefined,
  fallback: string,
) => {
  if (!row) return fallback;
  const firstName = normalizeTextInput(row.FirstName);
  const lastName = normalizeTextInput(row.LastName);
  const nameParts = [firstName, lastName].filter((segment) => segment.length > 0);
  if (nameParts.length > 0) return nameParts.join(" ");
  const email = normalizeTextInput(row.Email);
  if (email.length > 0) return email;
  const secondEmail = normalizeTextInput(row.SecondEmail);
  if (secondEmail.length > 0) return secondEmail;
  return fallback;
};

const changeCustomerMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="17 1 21 5 17 9"/>
      <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
      <polyline points="7 23 3 19 7 15"/>
      <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
    </svg>
  </span>
`;

const viewCustomerMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  </span>
`;

const createOfferMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--copy" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v12" />
      <path d="M17 7h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-2" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </svg>
  </span>
`;

const viewGroupsMailsMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <rect x="14" y="14" width="7" height="7" rx="1"/>
    </svg>
  </span>
`;

export default function ContactsClient({
  statuses,
  importances,
  customers,
  titles,
  initialContactName,
  initialContactFirstName,
  initialContactLastName,
}: Props) {
  const router = useRouter();
  const { roles, userId } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const initialContactFilterAppliedRef = useRef(false);
  const buildStatusDropdownValues = useCallback((raw: string[]) => {
    const unique = new Set(
      raw.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean),
    );
    return ["", ...Array.from(unique)];
  }, []);
  const buildImportanceDropdownValues = useCallback((raw: Array<string | number>) => {
    const normalized = raw
      .map((entry) => {
        if (entry == null) return "";
        if (typeof entry === "number") return String(entry);
        return String(entry).trim();
      })
      .filter((value) => value.length > 0);
    return ["", ...Array.from(new Set(normalized))];
  }, []);
  const buildTitleDropdownValues = useCallback((raw: DropdownOption[]) => {
    const priority = ["Mr", "Mrs", "\u039A\u03BF\u03C2", "\u039A\u03B1", "Dr", "\u0394\u03C1"];
    const labels = raw.map((t) => t.label);
    const prioritized = priority.filter((p) => labels.includes(p));
    const rest = labels
      .filter((l) => !priority.includes(l))
      .sort((a, b) => a.localeCompare(b));
    return ["", ...prioritized, ...rest];
  }, []);
  const [statusDropdownValues, setStatusDropdownValues] = useState(() => buildStatusDropdownValues(statuses));
  const [importanceDropdownValues, setImportanceDropdownValues] = useState(() => buildImportanceDropdownValues(importances));
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const [titleDropdownValues, setTitleDropdownValues] = useState(() => buildTitleDropdownValues(titles));
  const importanceOptions = useMemo(() => importanceDropdownValues.filter((v) => v.length > 0), [importanceDropdownValues]);
  const contactLookupsRefreshInFlightRef = useRef(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const {
    values: contactForm,
    setField: setContactField,
    isOpen: isAddContactOpen,
    open: openAddContact,
    close: closeAddContact,
    saving: contactSaving,
    error: contactError,
    setSaving: setContactSaving,
    setError: setContactError,
  } = useAddModal<ContactFormValues>(() => ({ ...EMPTY_CONTACT_FORM }));
  const { warnings: duplicateWarnings, check: checkDuplicates, clear: clearDuplicates } = useDuplicateCheck('contact');

  useEffect(() => {
    if (isAddContactOpen) {
      checkDuplicates({ firstName: contactForm.firstName, lastName: contactForm.lastName });
    } else {
      clearDuplicates();
    }
  }, [contactForm.firstName, contactForm.lastName, isAddContactOpen, checkDuplicates, clearDuplicates]);

  useEffect(() => { setStatusDropdownValues(buildStatusDropdownValues(statuses)); }, [statuses, buildStatusDropdownValues]);
  useEffect(() => { setImportanceDropdownValues(buildImportanceDropdownValues(importances)); }, [importances, buildImportanceDropdownValues]);
  useEffect(() => { setTitleDropdownValues(buildTitleDropdownValues(titles)); }, [titles, buildTitleDropdownValues]);

  const refreshContactLookups = useCallback(async () => {
    if (contactLookupsRefreshInFlightRef.current) return;
    contactLookupsRefreshInFlightRef.current = true;
    try {
      const response = await fetch("/api/customer-contacts?mode=lookups", { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as ContactLookupsResponse | null;
      if (!response.ok || !payload?.ok || !payload.lookups) return;
      if (Array.isArray(payload.lookups.statuses)) setStatusDropdownValues(buildStatusDropdownValues(payload.lookups.statuses));
      if (Array.isArray(payload.lookups.titles)) setTitleDropdownValues(buildTitleDropdownValues(payload.lookups.titles));
      if (Array.isArray(payload.lookups.importances)) setImportanceDropdownValues(buildImportanceDropdownValues(payload.lookups.importances));
    } catch (err) {
      console.error('Failed to refresh contact lookups', err);
    } finally {
      contactLookupsRefreshInFlightRef.current = false;
    }
  }, [buildStatusDropdownValues, buildTitleDropdownValues, buildImportanceDropdownValues]);

  const handleContactCellEditingStarted = useCallback(
    (event: CellEditingStartedEvent<Record<string, unknown>>) => {
      const field = event.colDef.field;
      if (field === 'Title' || field === 'EmailStatus' || field === 'SecondEmailStatus' || field === 'Importance') {
        void refreshContactLookups();
      }
    },
    [refreshContactLookups],
  );

  const customerOptions = useMemo(() => customers, [customers]);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const [changeCustomerContactId, setChangeCustomerContactId] = useState<number | null>(null);
  const [changeCustomerText, setChangeCustomerText] = useState("");
  const [changeCustomerSelected, setChangeCustomerSelected] = useState<CustomerDropdownOption | null>(null);
  const [isChangeCustomerListOpen, setIsChangeCustomerListOpen] = useState(false);
  const [changeCustomerSaving, setChangeCustomerSaving] = useState(false);
  const [changeCustomerError, setChangeCustomerError] = useState<string | null>(null);
  const changeCustomerListTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isChangeCustomerOpen = changeCustomerContactId != null;

  const [groupsMailsContactId, setGroupsMailsContactId] = useState<number | null>(null);
  const [groupsMailsContactName, setGroupsMailsContactName] = useState("");

  const closeChangeCustomer = useCallback(() => {
    setChangeCustomerContactId(null);
    setChangeCustomerText("");
    setChangeCustomerSelected(null);
    setIsChangeCustomerListOpen(false);
    setChangeCustomerError(null);
  }, []);

  const cancelChangeCustomerListClose = useCallback(() => {
    if (changeCustomerListTimerRef.current) {
      clearTimeout(changeCustomerListTimerRef.current);
      changeCustomerListTimerRef.current = null;
    }
  }, []);

  const scheduleChangeCustomerListClose = useCallback(() => {
    cancelChangeCustomerListClose();
    changeCustomerListTimerRef.current = setTimeout(() => {
      setIsChangeCustomerListOpen(false);
      changeCustomerListTimerRef.current = null;
    }, 120);
  }, [cancelChangeCustomerListClose]);

  const filteredChangeCustomerOptions = useMemo(() => {
    const query = changeCustomerText.trim().toLowerCase();
    if (!query) return customerOptions;
    return customerOptions.filter((option) => {
      const label = option.label.toLowerCase();
      const value = option.value.toLowerCase();
      return label.includes(query) || value.includes(query);
    });
  }, [customerOptions, changeCustomerText]);

  useEffect(() => () => cancelChangeCustomerListClose(), [cancelChangeCustomerListClose]);

  const handleChangeCustomerSave = useCallback(async () => {
    if (!changeCustomerSelected || changeCustomerContactId == null) return;
    setChangeCustomerSaving(true);
    setChangeCustomerError(null);
    try {
      const res = await fetch("/api/customer-contacts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          updates: [{
            ContactID: changeCustomerContactId,
            field: "CustomerName",
            value: changeCustomerSelected.label,
          }],
        }),
      });
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? "Failed to update customer");
      }
      showToastMessage("Customer updated", "success");
      closeChangeCustomer();
      gridApiRef.current?.refreshServerSide?.({ purge: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to update customer";
      setChangeCustomerError(message);
      showToastMessage(message, "error");
    } finally {
      setChangeCustomerSaving(false);
    }
  }, [changeCustomerContactId, changeCustomerSelected, closeChangeCustomer]);

  const [localTitleOptions, setLocalTitleOptions] = useState(() => sortTitleOptions(titles));
  useEffect(() => {
    setLocalTitleOptions(sortTitleOptions(titles));
  }, [titles]);
  const titleOptions = useMemo(() => localTitleOptions, [localTitleOptions]);
  const [isAddTitleOpen, setIsAddTitleOpen] = useState(false);
  const [newTitleName, setNewTitleName] = useState("");
  const [newTitleEnabled, setNewTitleEnabled] = useState("1");
  const [newTitleGreek, setNewTitleGreek] = useState("1");
  const [newTitleDescription, setNewTitleDescription] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const openTitleModal = useCallback(() => {
    setNewTitleName("");
    setNewTitleEnabled("1");
    setNewTitleGreek("1");
    setNewTitleDescription("");
    setTitleError(null);
    setIsAddTitleOpen(true);
  }, []);

  const handleCreateTitle = useCallback(async () => {
    const trimmed = newTitleName.trim();
    if (!trimmed) {
      setTitleError("Name is required");
      return;
    }
    setTitleSaving(true);
    setTitleError(null);
    try {
      const response = await fetch("/api/titles", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: trimmed,
          enabled: newTitleEnabled === "1",
          greek: newTitleGreek === "1",
          description: newTitleDescription.trim() || null,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; option?: DropdownOption; error?: string }
        | null;
      const option = payload?.option;
      if (!response.ok || !payload?.ok || !option) {
        throw new Error(payload?.error ?? "Unable to add title");
      }
      setLocalTitleOptions((prev) => sortTitleOptions([...prev, option]));
      setContactField("titleId", option.value);
      showToastMessage("Title added", "success");
      setIsAddTitleOpen(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to add title";
      setTitleError(message);
      showToastMessage(message, "error");
    } finally {
      setTitleSaving(false);
    }
  }, [
    newTitleName,
    newTitleEnabled,
    newTitleGreek,
    newTitleDescription,
    setContactField,
  ]);

  const [customerText, setCustomerText] = useState("");
  const [isCustomerListOpen, setIsCustomerListOpen] = useState(false);
  const customerListTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelCustomerListClose = useCallback(() => {
    if (customerListTimerRef.current) {
      clearTimeout(customerListTimerRef.current);
      customerListTimerRef.current = null;
    }
  }, []);

  const scheduleCustomerListClose = useCallback(() => {
    cancelCustomerListClose();
    customerListTimerRef.current = setTimeout(() => {
      setIsCustomerListOpen(false);
      customerListTimerRef.current = null;
    }, 120);
  }, [cancelCustomerListClose]);

  const handleCustomerInputFocus = useCallback(() => {
    cancelCustomerListClose();
    setIsCustomerListOpen(true);
  }, [cancelCustomerListClose]);

  const handleCustomerInputBlur = useCallback(() => scheduleCustomerListClose(), [scheduleCustomerListClose]);

  const handleCustomerInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setCustomerText(event.target.value);
      setContactField("customerId", "");
      setIsCustomerListOpen(true);
    },
    [setContactField],
  );

  const handleCustomerOptionSelect = useCallback(
    (option: CustomerDropdownOption) => {
      cancelCustomerListClose();
      setContactField("customerId", option.value);
      setCustomerText(option.label);
      setIsCustomerListOpen(false);
    },
    [cancelCustomerListClose, setContactField],
  );

  const filteredCustomerOptions = useMemo(() => {
    const query = customerText.trim().toLowerCase();
    if (!query) return customerOptions;
    return customerOptions.filter((option) => {
      const label = option.label.toLowerCase();
      const value = option.value.toLowerCase();
      return label.includes(query) || value.includes(query);
    });
  }, [customerOptions, customerText]);

  useEffect(() => () => cancelCustomerListClose(), [cancelCustomerListClose]);
  useEffect(() => {
    if (!isAddContactOpen) {
      setCustomerText("");
      setIsCustomerListOpen(false);
    }
  }, [isAddContactOpen]);

  const renderLookupAddButton = useCallback(
    (fieldId: string) =>
      fieldId === "title" ? (
        <button
          type="button"
          className={lookupButtonStyles.lookupAddButton}
          onClick={openTitleModal}
          disabled={titleSaving}
        >
          Add Title
        </button>
      ) : null,
    [openTitleModal, titleSaving],
  );

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    if (!api) return;
    gridApiRef.current = api;
    const firstNameFilter = typeof initialContactFirstName === "string" ? initialContactFirstName.trim() : "";
    const lastNameFilter = typeof initialContactLastName === "string" ? initialContactLastName.trim() : "";
    const nameFilter = typeof initialContactName === "string" ? initialContactName.trim() : "";
    const hasColumnNameFilters = firstNameFilter.length > 0 || lastNameFilter.length > 0;
    const applyLaunchFilters = () => {
      if (hasColumnNameFilters) {
        const nextModel: Record<string, unknown> = {};
        if (firstNameFilter.length > 0) {
          nextModel.FirstName = {
            filterType: "text",
            type: "contains",
            filter: firstNameFilter,
          };
        }
        if (lastNameFilter.length > 0) {
          nextModel.LastName = {
            filterType: "text",
            type: "contains",
            filter: lastNameFilter,
          };
        }
        api.setFilterModel(nextModel);
        return;
      }
      if (nameFilter.length > 0) {
        const apiWithQuickFilter = api as GridApi<Record<string, unknown>> & {
          setGridOption?: (key: string, value: unknown) => void;
          setQuickFilter?: (value: string) => void;
        };
        if (typeof apiWithQuickFilter.setGridOption === "function") {
          apiWithQuickFilter.setGridOption("quickFilterText", nameFilter);
        } else if (typeof apiWithQuickFilter.setQuickFilter === "function") {
          apiWithQuickFilter.setQuickFilter(nameFilter);
        }
      }
    };

    if (!defaultEnabledFilterAppliedRef.current) {
      const existingModel = api.getFilterModel() as Record<string, unknown> | null;
      const nextModel = existingModel && typeof existingModel === "object" ? { ...existingModel } : {};
      if (!("Enabled" in nextModel) && nameFilter.length === 0 && !hasColumnNameFilters) {
        api.setFilterModel({
          ...nextModel,
          Enabled: { filterType: "set", values: ["true"] },
          CustomerEnabled: { filterType: "set", values: ["true"] },
        });
      }
      defaultEnabledFilterAppliedRef.current = true;
    }
    if (!initialContactFilterAppliedRef.current) {
      if (hasColumnNameFilters || nameFilter.length > 0) {
        applyLaunchFilters();
        // AgGridAll restores persisted filter state right after grid ready.
        // Re-apply launch filters to ensure link-driven filtering wins.
        setTimeout(() => {
          if (api.isDestroyed?.()) return;
          applyLaunchFilters();
        }, 350);
      }
      initialContactFilterAppliedRef.current = true;
    }
  }, [initialContactFirstName, initialContactLastName, initialContactName]);

  const columnDefs = useMemo<ColDef[]>(() => {
    const orderedColumns: ColDef[] = [
      {
        field: "Title",
        headerName: "Title",
        filter: "agTextColumnFilter",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: titleDropdownValues },
      },
      {
        field: "LastName",
        headerName: "Last Name",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "FirstName",
        headerName: "First Name",
        filter: "agTextColumnFilter",

        editable: true,
      },
      {
        field: "Position",
        headerName: "Position",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "CustomerName",
        headerName: "Customer",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
      },
      {
        field: "Email",
        headerName: "Email",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "EmailStatus",
        headerName: "Email Status",
        filter: "agTextColumnFilter",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: statusDropdownValues },
      },
      {
        field: "SecondEmail",
        headerName: "Second Email",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "SecondEmailStatus",
        headerName: "Second Email Status",
        filter: "agTextColumnFilter",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: statusDropdownValues },
      },
      {
        field: "Phone",
        headerName: "Phone",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "Mobile",
        headerName: "Mobile",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "Importance",
        headerName: "Importance",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: importanceDropdownValues },
      },
      {
        field: "CustomerEnabled",
        headerName: "Enabled Customer",
        filter: "agSetColumnFilter",
        valueFormatter: (params) => formatBooleanValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
          comparator: (a: string, b: string) => {
            if (a === b) return 0;
            return a === "true" ? -1 : 1;
          },
        },
        width: 150,
        hide: true,
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        valueFormatter: (params) => formatBooleanValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
          comparator: (a: string, b: string) => {
            if (a === b) return 0;
            return a === "true" ? -1 : 1;
          },
        },
        width: 120,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ];
    return orderedColumns;
  }, [enabledOptions, statusDropdownValues, importanceDropdownValues, titleDropdownValues]);

  const contactRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/customer-contacts",
        dataEndpoint: "/api/customer-contacts",
        idField: "ContactID",
        resolveRowId: (row) =>
          normalizeContactId((row as { ContactID?: unknown } | null)?.ContactID ?? null),
        resolveRowLabel: (row, fallback) =>
          resolveContactLabel(row as Record<string, unknown> | null | undefined, fallback),
        resolveRowTypeLabel: () => "contact",
        buildPayload: (ids) => ({ ContactIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? "Delete contact" : "Delete contacts"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete contact" : "Delete contacts"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep contact" : "Keep contacts"),
        successToastMessage: "Contact deleted",
        failureToastMessage: "Unable to delete contact. Please try again.",
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageCustomersContacts'),
      }),
    [roles],
  );

  const contactContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const deleteItems = contactRowDeletion.getContextMenuItems(params);
      const customerId = normalizeContactId(
        (params.node?.data as { CustomerID?: unknown } | undefined)?.CustomerID ?? null,
      );
      const contactId = normalizeContactId(
        (params.node?.data as { ContactID?: unknown } | undefined)?.ContactID ?? null,
      );
      const viewCustomerItem = customerId != null
        ? [
            {
              name: "View Customer",
              icon: viewCustomerMenuIcon,
              action: () => router.push(`/customers/${customerId}/basicdata`),
            },
          ]
        : [];
      const changeCustomerItem = contactId != null
        ? [
            {
              name: "Change Customer",
              icon: changeCustomerMenuIcon,
              action: () => {
                setChangeCustomerContactId(contactId);
                setChangeCustomerText("");
                setChangeCustomerSelected(null);
                setChangeCustomerError(null);
              },
            },
          ]
        : [];
      const createOfferItem = customerId != null && contactId != null
        ? [
            {
              name: "Create an offer for this contact",
              icon: createOfferMenuIcon,
              action: () => {
                try {
                  const user = userId?.trim() || 'anon';
                  localStorage.removeItem(`fastquote.draft:offer-create:${user}`);
                } catch { /* ignore */ }
                router.push(`/offers/create?customerId=${encodeURIComponent(String(customerId))}&contactId=${encodeURIComponent(String(contactId))}`);
              },
            },
          ]
        : [];
      const viewGroupsMailsItem = contactId != null
        ? [
            {
              name: "View Contact Group Lists data",
              icon: viewGroupsMailsMenuIcon,
              action: () => {
                const data = params.node?.data as { LastName?: string; FirstName?: string } | undefined;
                const name = [data?.FirstName, data?.LastName].filter(Boolean).join(' ') || `Contact ${contactId}`;
                setGroupsMailsContactId(contactId);
                setGroupsMailsContactName(name);
              },
            },
          ]
        : [];
      const customerItems = [...viewCustomerItem, ...changeCustomerItem, ...createOfferItem, ...viewGroupsMailsItem];
      return [...(customerItems.length > 0 ? [...customerItems, "separator" as const] : []), ...deleteItems];
    },
    [contactRowDeletion, router, userId],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in CONTACT_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const contactId = normalizeContactId(
      (event.data as { ContactID?: unknown } | undefined)?.ContactID ?? null,
    );
    if (contactId == null) return;
    const label = CONTACT_FIELD_LABELS[field] ?? field;
    const revertValue = () => {
      if (event.node) {
        try {
          event.node.setDataValue(field, event.oldValue);
          return;
        } catch {
          /* noop */
        }
      }
      event.api.refreshCells({ force: true });
    };
    let value: unknown;
    if (field === "Enabled") {
      value = normalizeBoolean(
        (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
      );
    } else if (field === "EmailStatus" || field === "SecondEmailStatus") {
      value = normalizeTextInput(event.newValue);
    } else {
      value = normalizeTextInput(event.newValue);
    }

    const submit = async () => {
      try {
        const res = await fetch("/api/customer-contacts", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ ContactID: contactId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: "/api/customer-contacts",
          idField: "ContactID",
          entityId: contactId,
          field,
          oldValue: event.oldValue,
          node: event.node,
          gridApi: event.api,
        }));
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, "error");
        revertValue();
      }
    };

    void submit();
  }, [pushUndo, performUndo]);

  const handleCreateContact = useCallback(async () => {
    const validationError = validateContactForm(contactForm);
    if (validationError) {
      setContactError(validationError);
      showToastMessage(validationError, "error");
      return;
    }
    setContactSaving(true);
    setContactError(null);
    const result = await createContact(contactForm);
    if (!result.ok) {
      const message = result.error ?? "Unable to add contact.";
      setContactError(message);
      showToastMessage(message, "error");
      setContactSaving(false);
      return;
    }
    closeAddContact();
    setContactSaving(false);
    setRefreshToken((prev) => prev + 1);
    showToastMessage("Contact added", "success");
  }, [contactForm, closeAddContact, setContactError, setContactSaving, setRefreshToken]);

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Contacts"
          leftActions={
            canUndo ? (
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={performUndo}
              >
                ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
              </button>
            ) : undefined
          }
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.headerButton} page-header-button`}
                onClick={openAddContact}
              >
                Add Contact
              </button>
            </div>
          }
        >
          <GridQuickSearchProvider>
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/customer-contacts"
                columnDefs={columnDefs}
                rowGroupPanelShow="always"
                columnStateNamespace="customer-contacts-all"
                onGridReady={handleGridReady}
                getContextMenuItems={contactContextMenuItems}
                onCellValueChanged={handleCellEdit}
                onCellEditingStarted={handleContactCellEditingStarted}
                refreshToken={refreshToken}
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
      </main>
      <LookupModal
        open={isAddContactOpen}
        title="Add contact"
        onClose={closeAddContact}
        onConfirm={handleCreateContact}
        confirmLabel="Add contact"
        saving={contactSaving}
        error={contactError}
      >
        <div className={styles.contactModalBody}>
          <div className={styles.contactModalGrid}>
            <div
              className={`${styles.contactModalField} ${styles.comboWrapper} ${styles.contactModalFieldFull}`}
            >
              <label className={styles.fieldLabel} htmlFor="contact-customer">
                Customer <span className={styles.requiredMark}>*</span>
              </label>
              <input
                id="contact-customer"
                autoComplete="off"
                className={`${styles.fieldControl} ${styles.comboInput}`}
                value={customerText}
                aria-invalid={Boolean(contactError) && !(contactForm.customerId ?? "").trim()}
                placeholder="Type to search customers"
                onFocus={handleCustomerInputFocus}
                onBlur={handleCustomerInputBlur}
                onChange={handleCustomerInputChange}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && isCustomerListOpen && filteredCustomerOptions.length > 0) {
                    event.preventDefault();
                    handleCustomerOptionSelect(filteredCustomerOptions[0]);
                  }
                }}
              />
              {isCustomerListOpen ? (
                <div className={styles.comboList}>
                  {filteredCustomerOptions.length > 0 ? (
                    filteredCustomerOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={styles.comboOption}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => handleCustomerOptionSelect(option)}
                      >
                        {option.label}
                      </button>
                    ))
                  ) : (
                    <div className={styles.comboListEmpty}>No customers match</div>
                  )}
                </div>
              ) : null}
            </div>
            <div className={`${styles.contactModalField} ${styles.contactModalFieldFull}`}>
              <label className={styles.fieldLabel} htmlFor="contact-title">
                <div className={styles.lookupLabelRow}>
                  <div className={styles.labelText}>
                    Title <span className={styles.requiredMark}>*</span>
                  </div>
                  {renderLookupAddButton("title")}
                </div>
              </label>
              <select
                id="contact-title"
                className={styles.fieldControl}
                value={contactForm.titleId}
                required
                onMouseDown={() => refreshContactLookups()}
                onFocus={() => refreshContactLookups()}
                onChange={(event) => setContactField("titleId", event.target.value)}
              >
                <option value="">Select title...</option>
                {titleOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-last-name">
              Last name <span className={styles.requiredMark}>*</span>
            </label>
            <input
              id="contact-last-name"
              className={styles.fieldControl}
              value={contactForm.lastName}
              required
              onChange={(event) => setContactField("lastName", event.target.value)}
            />
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-first-name">
              First name <span className={styles.requiredMark}>*</span>
            </label>
            <input
              id="contact-first-name"
              className={styles.fieldControl}
              value={contactForm.firstName}
              required
              onChange={(event) => setContactField("firstName", event.target.value)}
            />
          </div>
          <div className={`${styles.contactModalField} ${styles.contactModalFieldFull}`}>
            <DuplicateWarning warnings={duplicateWarnings} />
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-position">
              Position
            </label>
            <input
              id="contact-position"
              className={styles.fieldControl}
              value={contactForm.position}
              onChange={(event) => setContactField("position", event.target.value)}
            />
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-importance">
              Importance <span className={styles.requiredMark}>*</span>
            </label>
            <select
              id="contact-importance"
              className={styles.fieldControl}
              value={contactForm.importance}
              required
              onChange={(event) => setContactField("importance", event.target.value)}
            >
              <option value="">Select importance...</option>
              {importanceOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-email">
              Email
            </label>
            <input
              id="contact-email"
              className={styles.fieldControl}
              value={contactForm.email}
              onChange={(event) => setContactField("email", event.target.value)}
            />
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-email-status">
              Email status
            </label>
            <select
              id="contact-email-status"
              className={styles.fieldControl}
              value={contactForm.emailStatus}
              onChange={(event) => setContactField("emailStatus", event.target.value)}
            >
              {statusDropdownValues.map((option) => (
                <option key={option} value={option}>
                  {option || "Select status..."}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-second-email">
              Second email
            </label>
            <input
              id="contact-second-email"
              className={styles.fieldControl}
              value={contactForm.secondEmail}
              onChange={(event) => setContactField("secondEmail", event.target.value)}
            />
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-second-email-status">
              Second email status
            </label>
            <select
              id="contact-second-email-status"
              className={styles.fieldControl}
              value={contactForm.secondEmailStatus}
              onChange={(event) => setContactField("secondEmailStatus", event.target.value)}
            >
              {statusDropdownValues.map((option) => (
                <option key={option} value={option}>
                  {option || "Select status..."}
                </option>
              ))}
            </select>
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-phone">
              Phone
            </label>
            <input
              id="contact-phone"
              className={styles.fieldControl}
              value={contactForm.phone}
              onChange={(event) => setContactField("phone", event.target.value)}
            />
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-mobile">
              Mobile
            </label>
            <input
              id="contact-mobile"
              className={styles.fieldControl}
              value={contactForm.mobile}
              onChange={(event) => setContactField("mobile", event.target.value)}
            />
          </div>
          <div className={`${styles.contactModalField} ${styles.contactModalToggle}`}>
            <label className={styles.fieldLabel} htmlFor="contact-enabled">
              Enabled <span className={styles.requiredMark}>*</span>
            </label>
            <label className={styles.contactToggleControl} htmlFor="contact-enabled">
              <input
                id="contact-enabled"
                type="checkbox"
                checked={contactForm.enabled}
                onChange={(event) => setContactField("enabled", event.target.checked)}
              />
              {contactForm.enabled ? "Yes" : "No"}
            </label>
          </div>
          </div>
        </div>
      </LookupModal>
      <LookupModal
        open={isAddTitleOpen}
        title="Add Title"
        onClose={() => setIsAddTitleOpen(false)}
        onConfirm={handleCreateTitle}
        confirmLabel="Create"
        saving={titleSaving}
        error={titleError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="new-title-name">
            Name
          </label>
          <input
            id="new-title-name"
            className={lookupStyles.fieldControl}
            value={newTitleName}
            required
            onChange={(event) => setNewTitleName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="new-title-description">
            Description
          </label>
          <textarea
            id="new-title-description"
            className={`${lookupStyles.fieldControl} ${lookupStyles.textarea}`}
            value={newTitleDescription}
            onChange={(event) => setNewTitleDescription(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="new-title-greek">
            Greek
          </label>
          <select
            id="new-title-greek"
            className={lookupStyles.fieldControl}
            value={newTitleGreek}
            onChange={(event) => setNewTitleGreek(event.target.value)}
          >
            {BOOLEAN_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="new-title-enabled">
            Enabled
          </label>
          <select
            id="new-title-enabled"
            className={lookupStyles.fieldControl}
            value={newTitleEnabled}
            onChange={(event) => setNewTitleEnabled(event.target.value)}
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
        open={isChangeCustomerOpen}
        title="Change Customer"
        onClose={closeChangeCustomer}
        onConfirm={handleChangeCustomerSave}
        confirmLabel="Save"
        saving={changeCustomerSaving}
        error={changeCustomerError}
      >
        <div className={styles.contactModalBody} style={{ minHeight: 320 }}>
          <div className={`${styles.contactModalField} ${styles.comboWrapper}`}>
            <label className={styles.fieldLabel} htmlFor="change-customer-input">
              Customer <span className={styles.requiredMark}>*</span>
            </label>
            <input
              id="change-customer-input"
              autoComplete="off"
              className={`${styles.fieldControl} ${styles.comboInput}`}
              value={changeCustomerText}
              placeholder="Type to search customers"
              onFocus={() => {
                cancelChangeCustomerListClose();
                setIsChangeCustomerListOpen(true);
              }}
              onBlur={() => scheduleChangeCustomerListClose()}
              onChange={(event) => {
                setChangeCustomerText(event.target.value);
                setChangeCustomerSelected(null);
                setIsChangeCustomerListOpen(true);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && isChangeCustomerListOpen && filteredChangeCustomerOptions.length > 0) {
                  event.preventDefault();
                  cancelChangeCustomerListClose();
                  setChangeCustomerSelected(filteredChangeCustomerOptions[0]);
                  setChangeCustomerText(filteredChangeCustomerOptions[0].label);
                  setIsChangeCustomerListOpen(false);
                }
              }}
            />
            {isChangeCustomerListOpen ? (
              <div className={styles.comboList}>
                {filteredChangeCustomerOptions.length > 0 ? (
                  filteredChangeCustomerOptions.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={styles.comboOption}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        cancelChangeCustomerListClose();
                        setChangeCustomerSelected(option);
                        setChangeCustomerText(option.label);
                        setIsChangeCustomerListOpen(false);
                      }}
                    >
                      {option.label}
                    </button>
                  ))
                ) : (
                  <div className={styles.comboListEmpty}>No customers match</div>
                )}
              </div>
            ) : null}
          </div>
        </div>
      </LookupModal>
      {groupsMailsContactId != null && (
        <ContactGroupsMailsModal
          contactId={groupsMailsContactId}
          contactName={groupsMailsContactName}
          onClose={() => {
            setGroupsMailsContactId(null);
            setGroupsMailsContactName("");
          }}
        />
      )}
    </>
  );
}

export function ContactsPageContainer() {
  const searchParams = useSearchParams();
  const [statuses, setStatuses] = useState<string[]>([]);
  const [customers, setCustomers] = useState<CustomerDropdownOption[]>([]);
  const [titles, setTitles] = useState<DropdownOption[]>([]);
  const [importances, setImportances] = useState<Array<string | number>>(DEFAULT_IMPORTANCE_VALUES);

  const initialContactName = (searchParams.get("contactName") ?? "").trim();
  const initialContactFirstName = (searchParams.get("firstName") ?? "").trim();
  const initialContactLastName = (searchParams.get("lastName") ?? "").trim();

  useEffect(() => {
    let active = true;

    const loadLookups = async () => {
      try {
        const response = await fetch("/api/customer-contacts?mode=lookups", {
          method: "GET",
          cache: "no-store",
        });
        const payload = (await response.json().catch(() => null)) as ContactLookupsResponse | null;
        if (!response.ok || !payload?.ok || !payload.lookups) {
          throw new Error(payload?.error ?? "Unable to load contact lookups.");
        }
        if (!active) return;
        setStatuses(Array.isArray(payload.lookups.statuses) ? payload.lookups.statuses : []);
        setCustomers(Array.isArray(payload.lookups.customers) ? payload.lookups.customers : []);
        setTitles(Array.isArray(payload.lookups.titles) ? payload.lookups.titles : []);
        setImportances(
          Array.isArray(payload.lookups.importances) && payload.lookups.importances.length > 0
            ? payload.lookups.importances
            : DEFAULT_IMPORTANCE_VALUES,
        );
      } catch (err) {
        if (!active) return;
        console.error("Failed to load contact lookups", err);
        showToastMessage("Unable to load contact lookups.", "warning");
      }
    };

    void loadLookups();
    return () => {
      active = false;
    };
  }, []);

  return (
    <ContactsClient
      statuses={statuses}
      importances={importances}
      customers={customers}
      titles={titles}
      initialContactName={initialContactName}
      initialContactFirstName={initialContactFirstName}
      initialContactLastName={initialContactLastName}
    />
  );
}
