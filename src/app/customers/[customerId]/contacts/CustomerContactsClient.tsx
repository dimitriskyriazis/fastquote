"use client";

import Link from "next/link";
import React, { useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import type { ColDef, GridApi } from "ag-grid-community";
import styles from "./CustomerContactsClient.module.css";

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

  const heading = customerName ? `${customerName} – Contacts` : "Customer Contacts";

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
          <Link href="/customers" className={`${styles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to customers
          </Link>
        </div>
        <h1 className={styles.heading}>{heading}</h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
          <button
            type="button"
            className={`${styles.headerActionButton} page-header-button`}
            onClick={() => {
              /* add contact placeholder */
            }}
          >
            Add Contact
          </button>
        </div>
      </div>
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint={`/api/customers/${encodedCustomerId}/contacts`}
          columnDefs={columnDefs}
          rowGroupPanelShow="never"
          columnStateNamespace="customer-contacts"
          onGridReady={handleGridReady}
        />
      </div>
    </main>
  );
}
