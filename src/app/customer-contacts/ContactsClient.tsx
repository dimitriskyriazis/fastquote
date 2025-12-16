"use client";

import React, { useMemo, useCallback, useRef, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
} from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import styles from "./ContactsClient.module.css";
import lookupStyles from "../components/LookupModal.module.css";
import lookupButtonStyles from "../components/LookupAddButton.module.css";
import LookupModal from "../components/LookupModal";
import { showToastMessage } from "../../lib/toast";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { useAddModal } from "../lib/useAddModal";
import type { DropdownOption } from "../../lib/dropdownOptions";
import type { CustomerDropdownOption } from "../customers/[customerId]/CustomerBasicDataTypes";
import {
  createContact,
  ContactFormValues,
  EMPTY_CONTACT_FORM,
  validateContactForm,
} from "./contactModalHelpers";

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
};

const CONTACT_FIELD_LABELS: Record<string, string> = {
  LastName: "Last name",
  FirstName: "First name",
  Position: "Position",
  CustomerName: "Customer name",
  Email: "Email",
  EmailStatus: "Email status",
  SecondEmail: "Second email",
  SecondEmailStatus: "Second email status",
  Phone: "Phone",
  Mobile: "Mobile",
  Importance: "Importance",
  Enabled: "Enabled",
};

const resolveEnabledState = (value: unknown): boolean | null => {
  if (value === 1 || value === true || value === "true" || value === "Yes") return true;
  if (value === 0 || value === false || value === "false" || value === "No") return false;
  return null;
};

const formatBooleanValue = (value: unknown) => {
  const state = resolveEnabledState(value);
  if (state === true) return "Yes";
  if (state === false) return "No";
  return "";
};

const normalizeEnabledInput = (value: unknown): boolean => resolveEnabledState(value) === true;

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

export default function ContactsClient({ statuses, importances, customers, titles }: Props) {
  const router = useRouter();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const statusOptions = useMemo(() => {
    const unique = new Set(
      statuses.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean),
    );
    return Array.from(unique);
  }, [statuses]);
  const statusDropdownValues = useMemo(() => ["", ...statusOptions], [statusOptions]);
  const importanceOptions = useMemo(() => {
    const normalized = importances
      .map((entry) => {
        if (entry == null) return "";
        if (typeof entry === "number") return String(entry);
        return String(entry).trim();
      })
      .filter((value) => value.length > 0);
    return Array.from(new Set(normalized));
  }, [importances]);
  const importanceDropdownValues = useMemo(() => ["", ...importanceOptions], [importanceOptions]);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);

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
  const customerOptions = useMemo(() => customers, [customers]);
  const [localTitleOptions, setLocalTitleOptions] = useState(titles);
  useEffect(() => {
    setLocalTitleOptions(titles);
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
      setLocalTitleOptions((prev) => [...prev, option]);
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
    if (!api || defaultEnabledFilterAppliedRef.current) return;
    const existingModel = api.getFilterModel() as Record<string, unknown> | null;
    const nextModel = existingModel && typeof existingModel === "object" ? { ...existingModel } : {};
    if ("Enabled" in nextModel) {
      defaultEnabledFilterAppliedRef.current = true;
      return;
    }
    api.setFilterModel({
      ...nextModel,
      Enabled: { filterType: "set", values: ["true"] },
    });
    defaultEnabledFilterAppliedRef.current = true;
  }, []);

  const columnDefs = useMemo<ColDef[]>(() => {
    const orderedColumns: ColDef[] = [
      {
        field: "LastName",
        headerName: "Last Name",
        filter: "agTextColumnFilter",
        minWidth: 160,
        flex: 1,
        editable: true,
      },
      {
        field: "FirstName",
        headerName: "First Name",
        filter: "agTextColumnFilter",
        minWidth: 160,
        flex: 1,
        editable: true,
      },
      {
        field: "Position",
        headerName: "Position",
        filter: "agTextColumnFilter",
        minWidth: 160,
        editable: true,
      },
      {
        field: "CustomerName",
        headerName: "Customer",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        minWidth: 220,
        flex: 1,
        editable: true,
      },
      {
        field: "Email",
        headerName: "Email",
        filter: "agTextColumnFilter",
        minWidth: 220,
        flex: 1,
        editable: true,
      },
      {
        field: "EmailStatus",
        headerName: "Email Status",
        filter: "agTextColumnFilter",
        minWidth: 160,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: statusDropdownValues },
      },
      {
        field: "SecondEmail",
        headerName: "Second Email",
        filter: "agTextColumnFilter",
        minWidth: 220,
        editable: true,
      },
      {
        field: "SecondEmailStatus",
        headerName: "Second Email Status",
        filter: "agTextColumnFilter",
        minWidth: 160,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: statusDropdownValues },
      },
      {
        field: "Phone",
        headerName: "Phone",
        filter: "agTextColumnFilter",
        minWidth: 160,
        editable: true,
      },
      {
        field: "Mobile",
        headerName: "Mobile",
        filter: "agTextColumnFilter",
        minWidth: 160,
        editable: true,
      },
      {
        field: "Importance",
        headerName: "Importance",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        minWidth: 160,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: importanceDropdownValues },
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
          buttons: ["apply"],
          closeOnApply: true,
        },
        width: 120,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeEnabledInput(params.newValue);
          return true;
        },
      },
    ];
    return orderedColumns;
  }, [enabledOptions, statusDropdownValues, importanceDropdownValues]);

  const contactRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/customer-contacts",
        resolveRowId: (row) =>
          normalizeContactId((row as { ContactID?: unknown } | null)?.ContactID ?? null),
        resolveRowLabel: (row, fallback) =>
          resolveContactLabel(row as Record<string, unknown> | null | undefined, fallback),
        resolveRowTypeLabel: () => "contact",
        buildPayload: (ids) => ({ ContactIDs: ids }),
        confirmTitle: "Delete contact",
        confirmConfirmLabel: "Delete contact",
        confirmCancelLabel: "Keep contact",
        successToastMessage: "Contact deleted",
        failureToastMessage: "Unable to delete contact. Please try again.",
      }),
    [],
  );

  const contactContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) =>
      contactRowDeletion.getContextMenuItems(params),
    [contactRowDeletion],
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
      value = normalizeEnabledInput(
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
        showToastMessage(`${label} updated`, "success");
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, "error");
        revertValue();
      }
    };

    void submit();
  }, []);

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
            <button
              type="button"
              className={`${styles.backLink} page-header-button`}
              onClick={() => {
                router.push("/customers");
              }}
            >
              <span aria-hidden="true">←</span>
              Back to customers
            </button>
          }
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.headerButton} page-header-button`}
                onClick={() => {
                  router.push("/customer-groups");
                }}
              >
                View Groups
              </button>
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
                refreshToken={refreshToken}
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
                Customer
              </label>
              <input
                id="contact-customer"
                autoComplete="off"
                className={`${styles.fieldControl} ${styles.comboInput}`}
                value={customerText}
                placeholder="Type to search customers"
                onFocus={handleCustomerInputFocus}
                onBlur={handleCustomerInputBlur}
                onChange={handleCustomerInputChange}
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
              Last name
            </label>
            <input
              id="contact-last-name"
              className={styles.fieldControl}
              value={contactForm.lastName}
              onChange={(event) => setContactField("lastName", event.target.value)}
            />
          </div>
          <div className={styles.contactModalField}>
            <label className={styles.fieldLabel} htmlFor="contact-first-name">
              First name
            </label>
            <input
              id="contact-first-name"
              className={styles.fieldControl}
              value={contactForm.firstName}
              onChange={(event) => setContactField("firstName", event.target.value)}
            />
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
              Importance
            </label>
            <select
              id="contact-importance"
              className={styles.fieldControl}
              value={contactForm.importance}
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
              Enabled
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
    </>
  );
}
