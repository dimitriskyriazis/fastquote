"use client";

import React, { useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { ColDef, GridApi } from "ag-grid-community";
import styles from "./ContactsClient.module.css";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
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

export default function ContactsClient() {
  const router = useRouter();
  const defaultEnabledFilterAppliedRef = useRef(false);

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
        minWidth: 160,
        flex: 1,
      },
      {
        field: "FirstName",
        headerName: "First Name",
        filter: "agTextColumnFilter",
        minWidth: 160,
        flex: 1,
      },
      {
        field: "Position",
        headerName: "Position",
        filter: "agTextColumnFilter",
        minWidth: 160,
      },
      {
        field: "CustomerName",
        headerName: "Customer",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        minWidth: 220,
        flex: 1,
      },
      {
        field: "Email",
        headerName: "Email",
        filter: "agTextColumnFilter",
        minWidth: 220,
        flex: 1,
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
        enableRowGroup: true,
        minWidth: 160,
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
      },
    ],
    [],
  );

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.heading}>Contacts</h1>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={`${styles.headerButton} page-header-button`}
            onClick={() => {
              router.push("/customers");
            }}
          >
            View Customers
          </button>
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
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint="/api/contacts"
          columnDefs={columnDefs}
          rowGroupPanelShow="always"
          columnStateNamespace="contacts"
          onGridReady={handleGridReady}
        />
      </div>
    </main>
  );
}
