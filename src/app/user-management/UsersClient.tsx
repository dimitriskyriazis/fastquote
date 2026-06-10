"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { CellEditingStartedEvent, CellValueChangedEvent, ColDef, GridApi } from "ag-grid-community";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { useAuditUser } from "../components/AuditUserProvider";
import AccessDeniedPage from "../components/AccessDeniedPage";
import AddUserModal from "../components/AddUserModal";
import { showToastMessage } from "../../lib/toast";
import { useUndoStack } from "../hooks/useUndoStack";
import { pushCellEditUndo, makePatternAUndoFn } from "../../lib/undoHelpers";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import styles from "./UsersClient.module.css";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading users...</div>,
});

type OptionsPayload = {
  ok?: boolean;
  roles?: string[];
  salesDivisions?: string[];
  salesSeniorities?: string[];
  error?: string;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const normalizeUserId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const REQUIRED_FIELDS = new Set(["UserName", "WindowsUserName"]);

export default function UsersClient() {
  const { roles, loading } = useAuditUser();
  const canAccess = roles.includes("Administrator") || roles.includes("Developer");
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [roleOptions, setRoleOptions] = useState<string[]>([]);
  const [salesDivisionOptions, setSalesDivisionOptions] = useState<string[]>([]);
  const [salesSeniorityOptions, setSalesSeniorityOptions] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const optionsRefreshInFlightRef = useRef(false);

  useEffect(() => {
    if (!canAccess) return;
    let isActive = true;
    setOptionsLoading(true);
    setOptionsError(null);
    void (async () => {
      try {
        const res = await fetch("/api/user-management/options");
        const payload = (await res.json().catch(() => null)) as OptionsPayload | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to load options.");
        }
        if (!isActive) return;
        setRoleOptions(Array.isArray(payload.roles) ? payload.roles : []);
        setSalesDivisionOptions(Array.isArray(payload.salesDivisions) ? payload.salesDivisions : []);
        setSalesSeniorityOptions(Array.isArray(payload.salesSeniorities) ? payload.salesSeniorities : []);
      } catch (err) {
        if (!isActive) return;
        const message = err instanceof Error ? err.message : "Unable to load options.";
        setOptionsError(message);
        showToastMessage(message, "error");
      } finally {
        if (isActive) setOptionsLoading(false);
      }
    })();
    return () => {
      isActive = false;
    };
  }, [canAccess]);

  const refreshOptions = useCallback(async () => {
    if (optionsRefreshInFlightRef.current) return;
    optionsRefreshInFlightRef.current = true;
    try {
      const res = await fetch("/api/user-management/options", { cache: 'no-store' });
      const payload = (await res.json().catch(() => null)) as OptionsPayload | null;
      if (!res.ok || !payload?.ok) return;
      if (Array.isArray(payload.roles)) setRoleOptions(payload.roles);
      if (Array.isArray(payload.salesDivisions)) setSalesDivisionOptions(payload.salesDivisions);
      if (Array.isArray(payload.salesSeniorities)) setSalesSeniorityOptions(payload.salesSeniorities);
    } catch (err) {
      console.error('Failed to refresh user options', err);
    } finally {
      optionsRefreshInFlightRef.current = false;
    }
  }, []);

  const handleCellEditingStarted = useCallback(
    (event: CellEditingStartedEvent<Record<string, unknown>>) => {
      const field = event.colDef.field;
      if (field === 'SalesDivision' || field === 'SalesSeniority' || field === 'Role1' || field === 'Role2') {
        void refreshOptions();
      }
    },
    [refreshOptions],
  );

  const roleSelectOptions = useMemo(() => ["", ...roleOptions], [roleOptions]);
  const divisionSelectOptions = useMemo(() => ["", ...salesDivisionOptions], [salesDivisionOptions]);
  const senioritySelectOptions = useMemo(() => {
    const seniorityOrder = new Map<string, number>([
      ["ceo", 0],
      ["general director", 1],
      ["director", 2],
      ["manager", 3],
      ["basic", 4],
      ["not sales", 5],
    ]);

    const withIndex = salesSeniorityOptions.map((value, index) => ({
      value,
      index,
      order: seniorityOrder.get(value.trim().toLowerCase()) ?? Number.POSITIVE_INFINITY,
    }));

    withIndex.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return a.index - b.index;
    });

    return ["", ...withIndex.map((entry) => entry.value)];
  }, [salesSeniorityOptions]);

  // Editors read their option lists from refs (via a function `cellEditorParams`)
  // rather than from `columnDefs`. This keeps `columnDefs` identity stable, so
  // refreshing options while a cell is being edited does NOT re-apply the grid
  // columns and destroy the open dropdown popup. The function form is evaluated
  // each time editing starts, so dropdowns still show the freshest options.
  const divisionSelectOptionsRef = useRef<string[]>(divisionSelectOptions);
  const roleSelectOptionsRef = useRef<string[]>(roleSelectOptions);
  const senioritySelectOptionsRef = useRef<string[]>(senioritySelectOptions);
  useEffect(() => {
    divisionSelectOptionsRef.current = divisionSelectOptions;
  }, [divisionSelectOptions]);
  useEffect(() => {
    roleSelectOptionsRef.current = roleSelectOptions;
  }, [roleSelectOptions]);
  useEffect(() => {
    senioritySelectOptionsRef.current = senioritySelectOptions;
  }, [senioritySelectOptions]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "UserID",
        headerName: "ID",
        filter: "agNumberColumnFilter",
        editable: false,
        width: 90,
      },
      {
        field: "UserName",
        headerName: "User Name",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "FullName",
        headerName: "Full Name",
        filter: "agTextColumnFilter",
        editable: true,
        sort: "asc",
      },
      {
        field: "FullNameGR",
        headerName: "Full Name GR",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "Email",
        headerName: "Email",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "SalesDivision",
        headerName: "Sales Division",
        filter: "agSetColumnFilter",
        filterParams: {
          values: ["AVS", "TVS"],
        },
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: () => ({
          values: divisionSelectOptionsRef.current,
        }),
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).SalesDivision = params.newValue ?? "";
          return true;
        },
      },
      {
        field: "SalesSeniority",
        headerName: "Sales Seniority",
        filter: "agTextColumnFilter",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: () => ({
          values: senioritySelectOptionsRef.current,
        }),
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).SalesSeniority = params.newValue ?? "";
          return true;
        },
      },
      {
        field: "SignTitle",
        headerName: "Sign Title",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "NameCode",
        headerName: "Name Code",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "WindowsUserName",
        headerName: "Windows User Name",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "Role1",
        headerName: "Role 1",
        filter: "agTextColumnFilter",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: () => ({
          values: roleSelectOptionsRef.current,
        }),
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Role1 = params.newValue ?? "";
          return true;
        },
      },
      {
        field: "Role2",
        headerName: "Role 2",
        filter: "agTextColumnFilter",
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: () => ({
          values: roleSelectOptionsRef.current,
        }),
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Role2 = params.newValue ?? "";
          return true;
        },
      },
      {
        field: "Enabled",
        headerName: "Enabled",
        filter: "agSetColumnFilter",
        filterParams: {
          values: ["true", "false"],
          valueFormatter: (params: { value?: unknown }) => formatBooleanValue(params.value),
          comparator: (a: string, b: string) => {
            if (a === b) return 0;
            return a === "true" ? -1 : 1;
          },
        },
        valueFormatter: (params) => formatBooleanValue(params.value),
        editable: true,
        width: 110,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: ["Yes", "No"],
        },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ],
    // Intentionally empty: editors read fresh options from refs, so columnDefs
    // stays referentially stable and never resets the grid during an active edit.
    [],
  );

  const handleGridReady = useCallback((api: GridApi) => {
    const existing = api.getFilterModel() as Record<string, unknown> | null;
    if (!existing || Object.keys(existing).length === 0) {
      api.setFilterModel({
        Enabled: { filterType: "set", values: ["true"] },
      });
    }
  }, []);

  const revertCell = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.node) {
      try {
        event.node.setDataValue(event.colDef.field ?? "", event.oldValue);
        return;
      } catch {
        /* noop */
      }
    }
    event.api.refreshCells({ force: true });
  }, []);

  const handleCellEdit = useCallback(
    (event: CellValueChangedEvent<Record<string, unknown>>) => {
      const field = event.colDef.field;
      if (!field || field === "UserID") return;
      if (event.newValue === event.oldValue) return;

      const userId = normalizeUserId((event.data as { UserID?: unknown } | undefined)?.UserID);
      if (userId == null) return;

      if (field === "Role1" || field === "Role2") {
        const role1 = normalizeTextValue(
          (event.data as Record<string, unknown> | undefined)?.Role1 ?? "",
        );
        const role2 = normalizeTextValue(
          (event.data as Record<string, unknown> | undefined)?.Role2 ?? "",
        );
        const roles = [role1, role2].filter((value) => value.length > 0);
        if (roles.length === 0) {
          showToastMessage("At least one role is required.", "error");
          revertCell(event);
          return;
        }
        void (async () => {
          try {
            const res = await fetch("/api/user-management", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                updates: [{ UserID: userId, field, roles }],
              }),
            });
            const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
            if (!res.ok || !payload?.ok) {
              throw new Error(payload?.error ?? "Unable to update roles.");
            }
            showToastMessage("Roles updated", "success");
            setRefreshToken((prev) => prev + 1);
          } catch (err) {
            const message = err instanceof Error ? err.message : "Unable to update roles.";
            showToastMessage(message, "error");
            revertCell(event);
          }
        })();
        return;
      }

      const value = normalizeTextValue(event.newValue);
      if (REQUIRED_FIELDS.has(field) && !value) {
        showToastMessage(`${field === "UserName" ? "User name" : "Windows user name"} is required.`, "error");
        revertCell(event);
        return;
      }

      const payloadValue = value.length > 0 ? value : null;
      const label = field;
      void (async () => {
        try {
          const res = await fetch("/api/user-management", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              updates: [{ UserID: userId, field, value: payloadValue }],
            }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payload?.ok) {
            throw new Error(payload?.error ?? "Unable to update user.");
          }
          pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
            endpoint: "/api/user-management",
            idField: "UserID",
            entityId: userId,
            field,
            oldValue: event.oldValue,
            node: event.node,
            gridApi: event.api,
          }));
          setRefreshToken((prev) => prev + 1);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unable to update user.";
          showToastMessage(message, "error");
          revertCell(event);
        }
      })();
    },
    [revertCell, pushUndo, performUndo],
  );

  if (loading) {
    return (
      <main className={styles.page}>
        <div className={styles.loading}>Loading user access...</div>
      </main>
    );
  }

  if (!canAccess) {
    return <AccessDeniedPage />;
  }

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="User Management"
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
            <button
              type="button"
              className={`page-header-button ${styles.headerButton}`}
              onClick={() => setIsAddOpen(true)}
              disabled={optionsLoading}
            >
              Add New User
            </button>
          }
        >
          <GridQuickSearchProvider>
            <div className={`${styles.gridFrame} fq-grid-panel`}>
              <AgGridAll
                endpoint="/api/user-management/grid"
                columnDefs={columnDefs}
                defaultColDef={{
                  editable: true,
                  cellEditor: "agTextCellEditor",
                }}
                columnStateNamespace="users"
                onCellValueChanged={handleCellEdit}
                onCellEditingStarted={handleCellEditingStarted}
                onGridReady={handleGridReady}
                refreshToken={refreshToken}
                suppressRowClickSelection
                suppressMovableColumns
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
        {optionsError ? <div className={styles.loading}>{optionsError}</div> : null}
      </main>
      <AddUserModal
        open={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onCreated={() => setRefreshToken((prev) => prev + 1)}
        roles={roleOptions}
        salesDivisions={salesDivisionOptions}
        salesSeniorities={salesSeniorityOptions}
      />
    </>
  );
}
