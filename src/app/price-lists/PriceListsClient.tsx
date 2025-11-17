"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import type { ColDef, ValueFormatterParams } from "ag-grid-community";
import styles from "./PriceListsClient.module.css";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});

const formatDateValue = (params: ValueFormatterParams) => {
  const raw = params.value;
  if (!raw) return "";
  const date = new Date(raw as string);
  return Number.isNaN(date.getTime()) ? String(raw) : date.toLocaleDateString();
};

const formatEnabledValue = (value: unknown) => {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
};

export default function PriceListsClient() {
  const columnDefs: ColDef[] = useMemo(
    () => [
      { field: "Name", headerName: "Price List", filter: "agTextColumnFilter" },
      { field: "SupplierName", headerName: "Supplier", filter: "agTextColumnFilter" },
      {
        field: "ValidFromDate",
        headerName: "Valid From",
        filter: "agDateColumnFilter",
        valueFormatter: formatDateValue,
        width: 200,
        minWidth: 200,
        suppressAutoSize: true,
      },
      {
        field: "ValidToDate",
        headerName: "Valid To",
        filter: "agDateColumnFilter",
        valueFormatter: formatDateValue,
        width: 200,
        minWidth: 200,
        suppressAutoSize: true,
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        valueFormatter: (params) => formatEnabledValue(params.value),
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatEnabledValue(params.value),
          comparator: (a: string, b: string) => {
            if (a === b) return 0;
            return a === "true" ? -1 : 1;
          },
        },
        width: 110,
      },
      {
        field: "SupplierComment",
        headerName: "Supplier Comment",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 220,
      },
    ],
    []
  );

  return (
    <main className={styles.page}>
      <h1 className={styles.heading}>Price Lists</h1>
      <AgGridAll
        endpoint="/api/price-lists"
        columnDefs={columnDefs}
        autoSizeExclusions={["ValidFromDate", "ValidToDate"]}
      />
    </main>
  );
}
