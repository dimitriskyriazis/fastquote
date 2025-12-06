"use client";

import React, { useMemo, useCallback, useRef } from "react";
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
import { showToastMessage } from "../../lib/toast";

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

export default function ContactsClient({ statuses, importances }: Props) {
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

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
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
        </div>
        <h1 className={styles.heading}>Contacts</h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
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
              onClick={() => {
                /* Add contact placeholder */
              }}
            >
              Add Contact
            </button>
          </div>
        </div>
      </div>
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint="/api/customer-contacts"
          columnDefs={columnDefs}
          rowGroupPanelShow="always"
          columnStateNamespace="customer-contacts-all"
          onGridReady={handleGridReady}
          getContextMenuItems={contactContextMenuItems}
          onCellValueChanged={handleCellEdit}
        />
      </div>
    </main>
  );
}
