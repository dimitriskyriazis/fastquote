"use client";

import React, { useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
  ValueFormatterParams,
} from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import styles from "./CustomerGroupsClient.module.css";
import { showToastMessage } from "../../lib/toast";

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

const normalizeEnabledInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "true" || value === "Yes") return true;
  if (value === 0 || value === false || value === "false" || value === "No") return false;
  return false;
};

const normalizeGroupId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const resolveGroupLabel = (
  row: Record<string, unknown> | null | undefined,
  fallback: string,
) => {
  if (!row) return fallback;
  const name = typeof row.Name === "string" ? row.Name.trim() : "";
  return name.length > 0 ? name : fallback;
};

const formatDateValue = (value: unknown) => {
  if (!value) return "";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return String(value ?? "");
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
};

const GROUP_FIELD_LABELS: Record<string, string> = {
  Name: "Group name",
  Enabled: "Enabled",
};

export default function CustomerGroupsClient() {
  const router = useRouter();
  const defaultEnabledFilterAppliedRef = useRef(false);
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
        field: "Name",
        headerName: "Group Name",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 220,
        editable: true,
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
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeEnabledInput(params.newValue);
          return true;
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
    [enabledOptions],
  );

  const groupRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/customer-groups",
        resolveRowId: (row) =>
          normalizeGroupId((row as { CustomerGroupID?: unknown } | null)?.CustomerGroupID ?? null),
        resolveRowLabel: (row, fallback) =>
          resolveGroupLabel(row as Record<string, unknown> | null | undefined, fallback),
        resolveRowTypeLabel: () => "group",
        buildPayload: (ids) => ({ CustomerGroupIDs: ids }),
        confirmTitle: "Delete group",
        confirmConfirmLabel: "Delete group",
        confirmCancelLabel: "Keep group",
        successToastMessage: "Customer group deleted",
        failureToastMessage: "Unable to delete group. Please try again.",
      }),
    [],
  );

  const groupContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) =>
      groupRowDeletion.getContextMenuItems(params),
    [groupRowDeletion],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in GROUP_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const groupId = normalizeGroupId(
      (event.data as { CustomerGroupID?: unknown } | undefined)?.CustomerGroupID ?? null,
    );
    if (groupId == null) return;
    const label = GROUP_FIELD_LABELS[field] ?? field;
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
    const value =
      field === "Enabled"
        ? normalizeEnabledInput(
            (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
          )
        : normalizeTextValue(event.newValue);

    const submit = async () => {
      try {
        const res = await fetch("/api/customer-groups", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ CustomerGroupID: groupId, field, value }] }),
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
            onClick={() => router.push("/customers")}
          >
            <span aria-hidden="true">←</span>
            Back to customers
          </button>
        </div>
        <h1 className={styles.heading}>Customer Groups</h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
          <div className={styles.headerActions}>
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
      </div>
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint="/api/customer-groups"
          columnDefs={columnDefs}
          columnStateNamespace="customer-groups"
          rowGroupPanelShow="never"
          onGridReady={handleGridReady}
          getContextMenuItems={groupContextMenuItems}
          onCellValueChanged={handleCellEdit}
        />
      </div>
    </main>
  );
}
