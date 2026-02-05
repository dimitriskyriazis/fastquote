"use client";

import Link from "next/link";
import React, { useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import type { CellValueChangedEvent, ColDef, GetContextMenuItemsParams, GridApi } from "ag-grid-community";
import { GridRowDeletion } from "../../../../lib/gridRowDeletion";
import styles from "./CustomerContactsClient.module.css";
import PageHeader from "../../../components/PageHeader";
import { GridQuickSearchProvider } from "../../../components/GridQuickSearchProvider";
import { formatBooleanValue } from "../../../lib/formatBooleanValue";
import { normalizeBoolean } from "../../../../lib/normalizeBoolean";
import { showToastMessage } from "../../../../lib/toast";

const AgGridAll = dynamic(() => import("../../../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading contacts…
    </div>
  ),
});


const normalizeContactId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const resolveCustomerContactLabel = (
  row: Record<string, unknown> | null | undefined,
  fallback: string,
) => {
  if (!row) return fallback;
  const firstName = typeof row.FirstName === "string" ? row.FirstName.trim() : "";
  const lastName = typeof row.LastName === "string" ? row.LastName.trim() : "";
  const nameParts = [firstName, lastName].filter((value) => value.length > 0);
  if (nameParts.length > 0) {
    return nameParts.join(" ");
  }
  const email = typeof row.Email === "string" ? row.Email.trim() : "";
  if (email.length > 0) return email;
  return fallback;
};

const CONTACT_FIELD_LABELS: Record<string, string> = {
  Enabled: "Enabled",
};

type Props = {
  customerId: string;
  customerName: string | null;
};

export default function CustomerContactsClient({ customerId, customerName }: Props) {
  const defaultEnabledFilterAppliedRef = useRef(false);
  const encodedCustomerId = encodeURIComponent(customerId);
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

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "LastName",
        headerName: "Last Name",
        filter: "agTextColumnFilter",
      },
      {
        field: "FirstName",
        headerName: "First Name",
        filter: "agTextColumnFilter",
      },
      {
        field: "Position",
        headerName: "Position",
        filter: "agTextColumnFilter",
      },
      {
        field: "Email",
        headerName: "Email",
        filter: "agTextColumnFilter",
      },
      {
        field: "SecondEmail",
        headerName: "Second Email",
        filter: "agTextColumnFilter",
      },
      {
        field: "Phone",
        headerName: "Phone",
        filter: "agTextColumnFilter",
      },
      {
        field: "Mobile",
        headerName: "Mobile",
        filter: "agTextColumnFilter",
      },
      {
        field: "Importance",
        headerName: "Importance",
        filter: "agTextColumnFilter",
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        width: 120,
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
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ],
    [enabledOptions],
  );

  const endpoint = `/api/customers/${encodedCustomerId}/contacts`;

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
    const value = normalizeBoolean(
      (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
    );

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

  const contactRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint,
        resolveRowId: (row) =>
          normalizeContactId((row as { ContactID?: unknown } | null)?.ContactID ?? null),
        resolveRowLabel: (row, fallback) =>
          resolveCustomerContactLabel(row as Record<string, unknown> | null | undefined, fallback),
        resolveRowTypeLabel: () => "contact",
        buildPayload: (ids) => ({ ContactIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? "Delete contact" : "Delete contacts"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete contact" : "Delete contacts"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep contact" : "Keep contacts"),
        successToastMessage: "Contact deleted",
        failureToastMessage: "Unable to delete contact. Please try again.",
      }),
    [endpoint],
  );

  const contactContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) =>
      contactRowDeletion.getContextMenuItems(params),
    [contactRowDeletion],
  );

  const heading = customerName ? `${customerName} – Contacts` : "Customer Contacts";

  return (
    <main className={styles.page}>
      <PageHeader
        title={heading}
        leftActions={
          <Link href="/customers" className={`${styles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to customers
          </Link>
        }
        rightActions={
          <button
            type="button"
            className={`${styles.headerActionButton} page-header-button`}
            onClick={() => {
              /* add contact placeholder */
            }}
          >
            Add Contact
          </button>
        }
      >
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint={endpoint}
              columnDefs={columnDefs}
              rowGroupPanelShow="never"
              columnStateNamespace="customer-contacts"
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              getContextMenuItems={contactContextMenuItems}
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
