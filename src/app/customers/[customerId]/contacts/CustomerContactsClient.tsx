"use client";

import Link from "next/link";
import React, { useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import type { ColDef, GetContextMenuItemsParams, GridApi } from "ag-grid-community";
import { GridRowDeletion } from "../../../../lib/gridRowDeletion";
import styles from "./CustomerContactsClient.module.css";
import PageHeader from "../../../components/PageHeader";
import { GridQuickSearchProvider } from "../../../components/GridQuickSearchProvider";

const AgGridAll = dynamic(() => import("../../../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading contacts…
    </div>
  ),
});

const formatBooleanValue = (value: unknown) => {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
};

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

type Props = {
  customerId: string;
  customerName: string | null;
};

export default function CustomerContactsClient({ customerId, customerName }: Props) {
  const defaultEnabledFilterAppliedRef = useRef(false);
  const encodedCustomerId = encodeURIComponent(customerId);

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
        flex: 1,
        minWidth: 160,
      },
      {
        field: "FirstName",
        headerName: "First Name",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 160,
      },
      {
        field: "Position",
        headerName: "Position",
        filter: "agTextColumnFilter",
        minWidth: 160,
      },
      {
        field: "Email",
        headerName: "Email",
        filter: "agTextColumnFilter",
        minWidth: 220,
      },
      {
        field: "SecondEmail",
        headerName: "Second Email",
        filter: "agTextColumnFilter",
        minWidth: 220,
      },
      {
        field: "Phone",
        headerName: "Phone",
        filter: "agTextColumnFilter",
        minWidth: 160,
      },
      {
        field: "Mobile",
        headerName: "Mobile",
        filter: "agTextColumnFilter",
        minWidth: 160,
      },
      {
        field: "Importance",
        headerName: "Importance",
        filter: "agTextColumnFilter",
        minWidth: 140,
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
      },
    ],
    [],
  );

  const endpoint = `/api/customers/${encodedCustomerId}/contacts`;

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
        confirmTitle: "Delete contact",
        confirmConfirmLabel: "Delete contact",
        confirmCancelLabel: "Keep contact",
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
              getContextMenuItems={contactContextMenuItems}
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
