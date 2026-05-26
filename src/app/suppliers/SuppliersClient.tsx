"use client";

import React, { useEffect, useMemo, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import type {
  CellEditingStartedEvent,
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  IMenuActionParams,
  MenuItemDef,
} from "ag-grid-community";
import styles from "./SuppliersClient.module.css";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { showToastMessage } from "../../lib/toast";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import AddSupplierModal from "../components/AddSupplierModal";
import { useUndoStack } from "../hooks/useUndoStack";
import { pushCellEditUndo, makePatternAUndoFn } from "../../lib/undoHelpers";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading suppliers…
    </div>
  ),
});

type RowData = Record<string, unknown>;

type SupplierRow = {
  SupplierID: number | null;
  Name: string | null;
  TaxID: string | null;
  Address: string | null;
  City: string | null;
  Country: string | null;
  PostalCode: string | null;
  Phone: string | null;
  WebSite: string | null;
  Comments: string | null;
  Enabled: boolean | number | null;
};

type Props = {
  countries: Array<{ id: number; name: string }>;
};

const normalizeSupplierId = (value: unknown): number | null => {
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

const SUPPLIER_FIELD_LABELS: Record<string, string> = {
  Name: "Supplier name",
  TaxID: "Tax ID",
  Address: "Address",
  City: "City",
  Country: "Country",
  PostalCode: "Postal code",
  Phone: "Phone",
  WebSite: "Website",
  Comments: "Comments",
  Enabled: "Enabled",
};

function normalizeMenuItemDef(item: MenuItemDef<SupplierRow, unknown>): MenuItemDef<RowData, unknown> {
  return {
    ...item,
    action:
      typeof item.action === "function"
        ? (params: IMenuActionParams<RowData, unknown>) =>
            item.action?.(params as unknown as IMenuActionParams<SupplierRow, unknown>)
        : undefined,
    subMenu: Array.isArray(item.subMenu) ? normalizeSupplierContextMenuItems(item.subMenu) : item.subMenu,
  };
}

function normalizeSupplierContextMenuItems(
  items: Array<string | DefaultMenuItem | MenuItemDef<SupplierRow, unknown>>,
): Array<string | DefaultMenuItem | MenuItemDef<RowData, unknown>> {
  return items.map((item) => {
    if (typeof item === "string") return item;
    return normalizeMenuItemDef(item as MenuItemDef<SupplierRow, unknown>);
  });
}

export default function SuppliersClient({ countries }: Props) {
  useRouter();
  const { roles } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const [countryOptions, setCountryOptions] = useState(() => ["", ...countries.map((c) => c.name)]);
  const countryRefreshInFlightRef = useRef(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isAddSupplierOpen, setIsAddSupplierOpen] = useState(false);

  useEffect(() => {
    setCountryOptions(["", ...countries.map((c) => c.name)]);
  }, [countries]);

  const refreshCountryOptions = useCallback(async () => {
    if (countryRefreshInFlightRef.current) return;
    countryRefreshInFlightRef.current = true;
    try {
      const response = await fetch('/api/customers/lookups?keys=countries', { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean;
        lookups?: { countries?: Array<{ value: string; label: string }> };
      } | null;
      if (!response.ok || !payload?.ok || !payload.lookups?.countries) return;
      const freshNames = payload.lookups.countries.map((opt) => opt.label);
      setCountryOptions(["", ...freshNames]);
    } catch (err) {
      console.error('Failed to refresh country options', err);
    } finally {
      countryRefreshInFlightRef.current = false;
    }
  }, []);

  const handleCellEditingStarted = useCallback(
    (event: CellEditingStartedEvent<Record<string, unknown>>) => {
      if (event.colDef.field === 'Country') {
        void refreshCountryOptions();
      }
    },
    [refreshCountryOptions],
  );

  const supplierRowDeletion = useMemo(
    () =>
      new GridRowDeletion<SupplierRow>({
        endpoint: "/api/suppliers",
        dataEndpoint: "/api/suppliers",
        idField: "SupplierID",
        resolveRowId: (row) => {
          const candidate = row?.SupplierID;
          return typeof candidate === "number" ? candidate : null;
        },
        resolveRowLabel: (row, fallback) => {
          const name = row?.Name;
          if (typeof name === "string" && name.trim().length > 0) return name.trim();
          return fallback;
        },
        resolveRowTypeLabel: () => "supplier",
        buildPayload: (ids) => ({ SupplierIDs: ids }),
        confirmTitle: ({ isSingle }) =>
          (isSingle ? "Delete supplier" : "Delete suppliers"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete supplier" : "Delete suppliers"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep supplier" : "Keep suppliers"),
        successToastMessage: (_, label) => `${label} deleted`,
        failureToastMessage: "Unable to delete supplier. Please try again.",
        refreshHandler: (api) => {
          if (!api || typeof api.refreshServerSide !== "function") return;
          try {
            api.refreshServerSide({ purge: true });
          } catch (err) {
            console.warn("Failed to refresh suppliers grid after deletion", err);
          }
        },
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageBrandsSuppliers'),
        restoreEndpoint: "/api/suppliers/restore",
        onDeleteSuccess: (deletedRows, api) => {
          if (deletedRows.length > 0) {
            pushUndo({
              label: "Supplier deleted",
              undo: async () => {
                const res = await fetch("/api/suppliers/restore", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ rows: deletedRows }),
                });
                const result = (await res.json().catch(() => null)) as { ok?: boolean } | null;
                if (!res.ok || !result?.ok) throw new Error("Failed to restore");
                try { api?.refreshServerSide?.({ purge: true }); } catch { /* noop */ }
              },
            });
          }
        },
      }),
    [roles, pushUndo],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => {
      const typedParams = params as unknown as GetContextMenuItemsParams<SupplierRow>;
      const items = supplierRowDeletion.getContextMenuItems(typedParams);
      return normalizeSupplierContextMenuItems(items ?? []);
    },
    [supplierRowDeletion],
  );

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

  const handleSupplierCreated = useCallback((supplier: { id: number; name: string }) => {
    setIsAddSupplierOpen(false);
    setRefreshToken((prev) => prev + 1);
    pushCellEditUndo(pushUndo, performUndo, `Supplier "${supplier.name}"`, async () => {
      const res = await fetch('/api/suppliers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ SupplierIDs: [supplier.id] }),
      });
      const result = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !result?.ok) throw new Error('Failed to delete supplier');
    });
  }, [pushUndo, performUndo]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "Name",
        headerName: "Supplier Name",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "TaxID",
        headerName: "Tax ID",
        filter: "agTextColumnFilter",
        editable: true,
        width: 150,
      },
      {
        field: "Address",
        headerName: "Address",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "Country",
        headerName: "Country",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        editable: true,
        cellEditor: "agRichSelectCellEditor",
        cellEditorParams: {
          values: countryOptions,
          allowTyping: true,
          filterList: true,
        },
        valueSetter: (params) => {
          const next = typeof params.newValue === "string" ? params.newValue : "";
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Country = next;
          return true;
        },
      },
      {
        field: "City",
        headerName: "City",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        editable: true,
      },
      {
        field: "PostalCode",
        headerName: "Postal Code",
        filter: "agTextColumnFilter",
        editable: true,
        width: 130,
      },
      {
        field: "Phone",
        headerName: "Phone",
        filter: "agTextColumnFilter",
        editable: true,
        width: 150,
      },
      {
        field: "WebSite",
        headerName: "Website",
        filter: "agTextColumnFilter",
        editable: true,
        width: 200,
      },
      {
        field: "Comments",
        headerName: "Comments",
        filter: "agTextColumnFilter",
        editable: true,
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
        },
        width: 120,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: {
          values: enabledOptions,
        },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ],
    [enabledOptions, countryOptions],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in SUPPLIER_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const supplierId = normalizeSupplierId(
      (event.data as { SupplierID?: unknown } | undefined)?.SupplierID ?? null,
    );
    if (supplierId == null) return;
    const label = SUPPLIER_FIELD_LABELS[field] ?? field;
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
        ? normalizeBoolean(
            (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
          )
        : normalizeTextValue(event.newValue);

    const submit = async () => {
      try {
        const res = await fetch("/api/suppliers", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ SupplierID: supplierId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: "/api/suppliers",
          idField: "SupplierID",
          entityId: supplierId,
          field,
          oldValue: event.oldValue,
          node: event.node,
          gridApi: event.api,
        }));
        event.api?.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, "error");
        revertValue();
      }
    };

    void submit();
  }, [pushUndo, performUndo]);

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Suppliers"
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
              onClick={() => setIsAddSupplierOpen(true)}
            >
              Add Supplier
            </button>
          }
        >
          <GridQuickSearchProvider>
            <div className={`${styles.gridFrame} fq-grid-panel`}>
              <AgGridAll
                endpoint="/api/suppliers"
                columnDefs={columnDefs}
                rowGroupPanelShow="always"
                columnStateNamespace="suppliers"
                onGridReady={handleGridReady}
                onCellValueChanged={handleCellEdit}
                onCellEditingStarted={handleCellEditingStarted}
                refreshToken={refreshToken}
                getContextMenuItems={getContextMenuItems}
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
      </main>
      <AddSupplierModal
        open={isAddSupplierOpen}
        onClose={() => setIsAddSupplierOpen(false)}
        onCreated={handleSupplierCreated}
        countries={countries}
      />
    </>
  );
}
