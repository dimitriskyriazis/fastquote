"use client";

import React, { useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { ColDef, GridApi, ValueFormatterParams } from "ag-grid-community";
import styles from "./CustomerGroupsClient.module.css";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading customer groups…
    </div>
  ),
});

const formatBooleanValue = (value: unknown) => {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
};

const formatDateValue = (value: unknown) => {
  if (!value) return "";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
};

export default function CustomerGroupsClient() {
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
        field: "Name",
        headerName: "Group Name",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 220,
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        width: 130,
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
      {
        field: "CreatedOn",
        headerName: "Created On",
        filter: "agDateColumnFilter",
        valueFormatter: (params: ValueFormatterParams) => formatDateValue(params.value),
        minWidth: 150,
        width: 160,
      },
    ],
    [],
  );

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.heading}>Customer Groups</h1>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={`${styles.headerButton} page-header-button`}
            onClick={() => router.push("/customers")}
          >
            View Customers
          </button>
          <button
            type="button"
            className={`${styles.headerButton} page-header-button`}
            onClick={() => router.push("/customer-contacts")}
          >
            View Contacts
          </button>
          <button
            type="button"
            className={`${styles.headerButton} page-header-button`}
            onClick={() => {
              /* Add group placeholder */
            }}
          >
            Add Group
          </button>
        </div>
      </div>
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint="/api/customer-groups"
          columnDefs={columnDefs}
          columnStateNamespace="customer-groups"
          rowGroupPanelShow="never"
          onGridReady={handleGridReady}
        />
      </div>
    </main>
  );
}
