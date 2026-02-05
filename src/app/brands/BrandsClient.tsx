"use client";

import React, { useMemo, useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
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
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import AddBrandModal from "../components/AddBrandModal";
import { showToastMessage } from "../../lib/toast";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading brands…
    </div>
  ),
});

type RowData = Record<string, unknown>;

type BrandRow = {
  BrandID: number | null;
  Name: string | null;
  Enabled: boolean | number | null;
  Comment: string | null;
  SoftOneID: number | null;
  SoftOneCode: string | null;
};

const normalizeBrandId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const BRAND_FIELD_LABELS: Record<string, string> = {
  Enabled: "Enabled",
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
  const router = useRouter();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);

  const brandRowDeletion = useMemo(
    () =>
      new GridRowDeletion<BrandRow>({
        endpoint: "/api/brands",
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
      }),
    [],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<RowData>) => {
      const typedParams = params as unknown as GetContextMenuItemsParams<BrandRow>;
      const items = brandRowDeletion.getContextMenuItems(typedParams);
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

  const handleBrandCreated = useCallback(() => {
    setIsAddBrandOpen(false);
    setRefreshToken((prev) => prev + 1);
  }, []);

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        field: "Name",
        headerName: "Brand Name",
        filter: "agTextColumnFilter",
        minWidth: 200,
      },
      {
        field: "SoftOneID",
        headerName: "SoftOne ID",
        filter: "agTextColumnFilter",
        width: 130,
      },
      {
        field: "SoftOneCode",
        headerName: "SoftOne Code",
        filter: "agTextColumnFilter",
        width: 150,
      },
      {
        field: "Comment",
        headerName: "Comment",
        filter: "agTextColumnFilter",
        minWidth: 200,
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
    [enabledOptions],
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
    const value = normalizeBoolean(
      (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
    );

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
    <>
      <main className={styles.page}>
        <PageHeader
          title="Brands"
          leftActions={
            <button
              type="button"
              className={`page-header-button ${styles.headerButton}`}
              onClick={() => router.push("/suppliers")}
            >
              <span aria-hidden="true">←</span>
              Back to Suppliers
            </button>
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
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/brands/grid"
                columnDefs={columnDefs}
                rowGroupPanelShow="always"
                columnStateNamespace="brands"
                onGridReady={handleGridReady}
                onCellValueChanged={handleCellEdit}
                refreshToken={refreshToken}
                getContextMenuItems={getContextMenuItems}
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
