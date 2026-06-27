"use client";

import React, { useMemo, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { openLinkInNewTab } from "../../lib/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  IMenuActionParams,
  MenuItemDef,
} from "ag-grid-community";
import styles from "./BrandsClient.module.css";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import AddBrandModal from "../components/AddBrandModal";
import { showToastMessage } from "../../lib/toast";
import { useUndoStack } from "../hooks/useUndoStack";
import { pushCellEditUndo, makePatternAUndoFn } from "../../lib/undoHelpers";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading brands…
    </div>
  ),
});

const brandDetailsMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';

type RowData = Record<string, unknown>;

type BrandRow = {
  BrandID: number | null;
  Name: string | null;
  Enabled: boolean | number | null;
  Comment: string | null;
  SoftOneID: number | null;
  SoftOneCode: string | null;
  AVC4Name: string | null;
  PartNumberSuffix: string | null;
  PartNumberPattern1: string | null;
  PartNumberPattern2: string | null;
};

const normalizeBrandId = (value: unknown): number | null => {
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

const normalizeOptionalInt = (value: unknown): number | null => {
  const text = normalizeTextValue(value);
  if (!text) return null;
  const parsed = Number.parseInt(text, 10);
  if (Number.isFinite(parsed)) return parsed;
  return null;
};

const BRAND_FIELD_LABELS: Record<string, string> = {
  Name: "Brand name",
  SoftOneID: "ERP ID",
  SoftOneCode: "SoftOne Code",
  Comment: "Comment",
  AVC4Name: "AVC4 Name",
  Enabled: "Enabled",
  PartNumberSuffix: "Part Number Suffix",
  PartNumberPattern1: "Part Number Pattern 1",
  PartNumberPattern2: "Part Number Pattern 2",
};

function normalizeMenuItemDef(item: MenuItemDef<BrandRow, unknown>): MenuItemDef<RowData, unknown> {
  return {
    ...item,
    action:
      typeof item.action === "function"
        ? (params: IMenuActionParams<RowData, unknown>) =>
            item.action?.(params as unknown as IMenuActionParams<BrandRow, unknown>)
        : undefined,
    subMenu: Array.isArray(item.subMenu) ? normalizeBrandContextMenuItems(item.subMenu) : item.subMenu,
  };
}

function normalizeBrandContextMenuItems(
  items: Array<string | DefaultMenuItem | MenuItemDef<BrandRow, unknown>>,
): Array<string | DefaultMenuItem | MenuItemDef<RowData, unknown>> {
  return items.map((item) => {
    if (typeof item === "string") return item;
    return normalizeMenuItemDef(item as MenuItemDef<BrandRow, unknown>);
  });
}

export default function BrandsClient() {
  useRouter();
  const { roles } = useAuditUser();
  const canEditAdminOnly = useMemo(
    () => roles.includes("Administrator") || roles.includes("Developer"),
    [roles],
  );
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);

  const brandRowDeletion = useMemo(
    () =>
      new GridRowDeletion<BrandRow>({
        endpoint: "/api/brands",
        dataEndpoint: "/api/brands/grid",
        idField: "BrandID",
        resolveRowId: (row) => {
          const candidate = row?.BrandID;
          return typeof candidate === "number" ? candidate : null;
        },
        resolveRowLabel: (row, fallback) => {
          const name = row?.Name;
          if (typeof name === "string" && name.trim().length > 0) return name.trim();
          return fallback;
        },
        resolveRowTypeLabel: () => "brand",
        buildPayload: (ids) => ({ BrandIDs: ids }),
        confirmTitle: ({ isSingle }) =>
          (isSingle ? "Delete brand" : "Delete brands"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete brand" : "Delete brands"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep brand" : "Keep brands"),
        successToastMessage: (_, label) => `${label} deleted`,
        failureToastMessage: "Unable to delete brand. Please try again.",
        refreshHandler: (api) => {
          if (!api || typeof api.refreshServerSide !== "function") return;
          try {
            api.refreshServerSide({ purge: true });
          } catch (err) {
            console.warn("Failed to refresh brands grid after deletion", err);
          }
        },
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageBrandsSuppliers'),
        restoreEndpoint: "/api/brands/restore",
        onDeleteSuccess: (deletedRows, api) => {
          if (deletedRows.length > 0) {
            pushUndo({
              label: "Brand deleted",
              undo: async () => {
                const res = await fetch("/api/brands/restore", {
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
      const typedParams = params as unknown as GetContextMenuItemsParams<BrandRow>;
      const items = brandRowDeletion.getContextMenuItems(typedParams);

      const rowData = params.node?.data as BrandRow | null | undefined;
      const rawBrandId = rowData?.BrandID;
      const brandId =
        typeof rawBrandId === "number"
          ? rawBrandId
          : typeof rawBrandId === "string"
            ? Number.parseInt(rawBrandId, 10)
            : null;

      if (brandId && Number.isInteger(brandId)) {
        const detailsItem: MenuItemDef<RowData> = {
          name: "View brand details",
          icon: brandDetailsMenuIcon,
          action: () => {
            openLinkInNewTab(`/brands/${encodeURIComponent(String(brandId))}/details`);
          },
        };
        const normalizedItems = normalizeBrandContextMenuItems(items ?? []);
        return [detailsItem, ...normalizedItems];
      }

      return normalizeBrandContextMenuItems(items ?? []);
    },
    [brandRowDeletion],
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

  const handleBrandCreated = useCallback((brand: { id: number; name: string }) => {
    setIsAddBrandOpen(false);
    setRefreshToken((prev) => prev + 1);
    pushCellEditUndo(pushUndo, performUndo, `Brand "${brand.name}"`, async () => {
      const res = await fetch('/api/brands', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ BrandIDs: [brand.id] }),
      });
      const result = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !result?.ok) throw new Error('Failed to delete brand');
    });
  }, [pushUndo, performUndo]);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "Name",
        headerName: "Brand Name",
        filter: "agTextColumnFilter",
        editable: true,
      },
      {
        field: "SoftOneCode",
        headerName: "SoftOne Code",
        filter: "agTextColumnFilter",
        width: 150,
        editable: true,
        hide: true,
      },
      {
        field: "AVC4Name",
        headerName: "AVC4 Name",
        filter: "agTextColumnFilter",
        width: 180,
        editable: canEditAdminOnly,
      },
      {
        field: "SoftOneID",
        headerName: "ERP ID",
        filter: "agTextColumnFilter",
        width: 130,
        editable: true,
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).SoftOneID = normalizeOptionalInt(params.newValue);
          return true;
        },
      },
      {
        field: "PartNumberSuffix",
        headerName: "Part Number Suffix",
        filter: "agTextColumnFilter",
        width: 160,
        editable: canEditAdminOnly,
      },
      {
        field: "PartNumberPattern1",
        headerName: "Part Number Pattern 1",
        filter: "agTextColumnFilter",
        width: 180,
        editable: canEditAdminOnly,
      },
      {
        field: "PartNumberPattern2",
        headerName: "Part Number Pattern 2",
        filter: "agTextColumnFilter",
        width: 180,
        editable: canEditAdminOnly,
      },
      {
        field: "Comment",
        headerName: "Comment",
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
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ],
    [enabledOptions, canEditAdminOnly],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in BRAND_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const brandId = normalizeBrandId(
      (event.data as { BrandID?: unknown } | undefined)?.BrandID ?? null,
    );
    if (brandId == null) return;
    const label = BRAND_FIELD_LABELS[field] ?? field;
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
        : field === "SoftOneID"
          ? normalizeOptionalInt(
              (event.data as { SoftOneID?: unknown } | undefined)?.SoftOneID ?? event.newValue,
            )
          : normalizeTextValue(event.newValue);

    const submit = async () => {
      try {
        const res = await fetch("/api/brands", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ BrandID: brandId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: "/api/brands",
          idField: "BrandID",
          entityId: brandId,
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
          title="Brands"
          leftActions={
            <>
              {canUndo && (
                <button
                  type="button"
                  className={`page-header-button ${styles.headerButton}`}
                  onClick={performUndo}
                >
                  ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
                </button>
              )}
            </>
          }
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`page-header-button ${styles.headerButton}`}
                onClick={() => setIsAddBrandOpen(true)}
              >
                Add Brand
              </button>
            </div>
          }
        >
          <GridQuickSearchProvider>
            <div className={`${styles.gridFrame} fq-grid-panel`}>
              <AgGridAll
                endpoint="/api/brands/grid"
                columnDefs={columnDefs}
                rowGroupPanelShow="always"
                columnStateNamespace="brands"
                onGridReady={handleGridReady}
                onCellValueChanged={handleCellEdit}
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
      <AddBrandModal
        open={isAddBrandOpen}
        onClose={() => setIsAddBrandOpen(false)}
        onCreated={handleBrandCreated}
      />
    </>
  );
}
