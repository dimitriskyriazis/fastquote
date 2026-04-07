"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";

import type { ColDef } from "ag-grid-community";
import styles from "./LogsClient.module.css";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { useAuditUser } from "../components/AuditUserProvider";
import AccessDeniedPage from "../components/AccessDeniedPage";
import TimestampFilter from "./TimestampFilter";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading logs...</div>,
});

export default function LogsClient() {
  const { roles, loading } = useAuditUser();
  const canAccess =
    roles.includes("Administrator") || roles.includes("Developer");

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "Timestamp",
        headerName: "Time",
        filter: TimestampFilter,
        suppressHeaderMenuButton: false,
        sort: "desc" as const,
        width: 190,
        valueFormatter: (params: { value: unknown }) => {
          if (!params.value) return "";
          const d = new Date(params.value as string);
          const dd = String(d.getDate()).padStart(2, "0");
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const yyyy = d.getFullYear();
          const hh = String(d.getHours()).padStart(2, "0");
          const min = String(d.getMinutes()).padStart(2, "0");
          const ss = String(d.getSeconds()).padStart(2, "0");
          return `${dd}/${mm}/${yyyy} ${hh}:${min}:${ss}`;
        },
      },
      {
        field: "UserName",
        headerName: "User",
        filter: "agTextColumnFilter",
        width: 180,
      },
      {
        field: "Category",
        headerName: "Category",
        filter: "agSetColumnFilter",
        width: 120,
        filterParams: {
          values: ["view", "mutation", "delete"],
        },
      },
      {
        field: "Message",
        headerName: "Message",
        filter: "agTextColumnFilter",
        flex: 2,
        minWidth: 250,
      },
      {
        field: "Details",
        headerName: "Details",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 200,
        hide: true,
      },
      {
        field: "Endpoint",
        headerName: "Endpoint",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 200,
      },
      {
        field: "Level",
        headerName: "Level",
        filter: "agSetColumnFilter",
        width: 100,
        filterParams: {
          values: ["info", "warn", "error"],
        },
        cellStyle: (params: { value: unknown }) => {
          if (params.value === "error")
            return { color: "#d32f2f", fontWeight: 600 };
          if (params.value === "warn")
            return { color: "#ed6c02", fontWeight: 600 };
          return null;
        },
      },
      {
        field: "UserId",
        headerName: "User ID",
        filter: "agTextColumnFilter",
        width: 100,
        hide: true,
      },
      {
        field: "Method",
        headerName: "Method",
        filter: "agSetColumnFilter",
        width: 100,
        filterParams: {
          values: ["GET", "POST", "PATCH", "PUT", "DELETE"],
        },
      },
      {
        field: "RequestId",
        headerName: "Request ID",
        filter: "agTextColumnFilter",
        width: 140,
        hide: true,
      },
    ],
    [],
  );

  if (loading) return null;
  if (!canAccess) return <AccessDeniedPage />;

  return (
    <main className={styles.page}>
      <PageHeader title="Logs">
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll endpoint="/api/logs" columnDefs={columnDefs} disableAutoSize />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
