"use client";

import React, { useMemo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
  ValueFormatterParams,
} from "ag-grid-community";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import styles from "./PriceListsClient.module.css";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { openLinkInNewTab } from "../../lib/navigation";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import { formatDateUK } from "../lib/formatDateTime";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import { resolvePriceListStatus } from "../../lib/priceListStatus";
import { showToastMessage } from "../../lib/toast";
import { useUndoStack } from "../hooks/useUndoStack";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});

const normalizePriceListIdValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeStringValue = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
};

const resolvePriceListRowLabel = (
  row: { Name?: string | null; SupplierName?: string | null } | null,
  fallback: string,
) => {
  if (!row) return fallback;
  const normalize = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : value ? String(value) : "";
  const name = normalize(row.Name);
  const supplier = normalize(row.SupplierName);
  if (name && supplier) return `${name} – ${supplier}`;
  if (name) return name;
  if (supplier) return supplier;
  return fallback;
};

// Maps a Price Lists grid row (ValidFromDate / ValidToDate / Enabled) onto the
// shape resolvePriceListStatus expects, so the Valid To cell can be coloured with
// the same active/expiring/expired palette as the offer-products List Price cell.
const resolvePriceListRowStatus = (data: Record<string, unknown> | null | undefined) =>
  resolvePriceListStatus(
    data
      ? {
          PriceListID: data.PriceListID,
          PriceListEnabled: data.Enabled,
          PriceListValidFromDate: data.ValidFromDate,
          PriceListValidToDate: data.ValidToDate,
        }
      : null,
  );

// Toggles the validity-status classes on the Valid To cell. The colours live in
// PriceListsClient.module.css (.pl-valid-to--*, scoped under .gridFrame), mirroring
// the offer-products List Price cell palette.
const validToStatusClassRules = {
  "pl-valid-to--active": (params: { data?: Record<string, unknown> | null }) =>
    resolvePriceListRowStatus(params.data) === "active",
  "pl-valid-to--expiring": (params: { data?: Record<string, unknown> | null }) =>
    resolvePriceListRowStatus(params.data) === "expiring",
  "pl-valid-to--expired": (params: { data?: Record<string, unknown> | null }) =>
    resolvePriceListRowStatus(params.data) === "expired",
};

const PRICE_LIST_ROW_TYPE_LABEL = "price list";

const PRICE_LIST_FIELD_LABELS: Record<string, string> = {
  Enabled: "Enabled",
};

const PRICING_POLICY_SEPARATOR = "\u001F";

const PRICING_POLICY_INITIALS: Record<string, string> = {
  "Dealer Level 1": "DL1",
  "Dealer Level 2": "DL2",
  "Default Pricing Policy": "DPP",
  "EP LINC 2023": "EPL23",
  "Rental Level 1": "RL1",
  "Rental Level 2": "RL2",
  "AVC4": "AVC4",
};

const toPricingPolicyInitials = (name: string): string => {
  const trimmed = name.trim();
  if (PRICING_POLICY_INITIALS[trimmed]) return PRICING_POLICY_INITIALS[trimmed];
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return trimmed;
  const initials = parts
    .map((part) => {
      const letter = part.match(/[A-Za-z]/)?.[0] ?? "";
      const digits = part.match(/\d+/)?.[0] ?? "";
      return `${letter}${digits}`;
    })
    .join("")
    .toUpperCase();
  return initials || trimmed;
};

const parsePricingPolicies = (value: unknown): string[] => {
  if (typeof value !== "string" || value.length === 0) return [];
  return value.split(PRICING_POLICY_SEPARATOR).filter((entry) => entry.length > 0);
};

export default function PriceListsClient() {
  const router = useRouter();
  const { roles, users } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const [maxPricingPolicies, setMaxPricingPolicies] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const loadMaxPricingPolicies = async () => {
      try {
        const res = await fetch("/api/price-lists", { method: "GET" });
        const payload = (await res.json().catch(() => null)) as
          | { ok?: boolean; maxPricingPolicies?: number }
          | null;
        if (cancelled) return;
        if (res.ok && payload?.ok && typeof payload.maxPricingPolicies === "number") {
          setMaxPricingPolicies(Math.max(0, Math.floor(payload.maxPricingPolicies)));
        }
      } catch {
        /* noop */
      }
    };
    void loadMaxPricingPolicies();
    return () => {
      cancelled = true;
    };
  }, []);
  const responsibleUserNameById = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((user) => {
      const normalizedName = user.label.trim();
      if (!normalizedName) return;
      map.set(user.id, normalizedName);
    });
    return map;
  }, [users]);

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

  const handleImportClick = useCallback(() => {
    router.push("/price-lists/import");
  }, [router]);

  const priceListRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: '/api/price-lists',
        dataEndpoint: '/api/price-lists',
        idField: 'PriceListID',
        resolveRowId: (row) =>
          normalizePriceListIdValue((row as { PriceListID?: unknown } | null | undefined)?.PriceListID ?? null),
        resolveRowLabel: (row, fallback) =>
          resolvePriceListRowLabel(
            row as { Name?: string | null; SupplierName?: string | null } | null,
            fallback,
          ),
        resolveRowTypeLabel: () => PRICE_LIST_ROW_TYPE_LABEL,
        buildPayload: (ids) => ({ PriceListIDs: ids }),
        confirmTitle: ({ isSingle }) =>
          (isSingle ? 'Delete price list' : 'Delete price lists'),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? 'Delete price list' : 'Delete price lists'),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? 'Keep price list' : 'Keep price lists'),
        successToastMessage: 'Price list deleted',
        failureToastMessage: 'Unable to delete price list. Please try again.',
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'pricelists', 'managePriceLists'),
      }),
    [roles],
  );

  const importNewVersionIcon = `
    <span class="fastquote-menu-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <polyline points="9 15 12 12 15 15" />
      </svg>
    </span>
  `;

  const appendProductsIcon = `
    <span class="fastquote-menu-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <line x1="12" y1="8" x2="12" y2="16" />
        <line x1="8" y1="12" x2="16" y2="12" />
      </svg>
    </span>
  `;

  const viewOriginalFileIcon = `
    <span class="fastquote-menu-icon" aria-hidden="true">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
        <polyline points="10 9 9 9 8 9" />
      </svg>
    </span>
  `;

  const brandDetailsMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';

  const priceListsContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const baseItems = priceListRowDeletion.getContextMenuItems(params);
      const rowData = params.node?.data ?? null;
      const priceListId = normalizePriceListIdValue(
        (rowData as { PriceListID?: unknown } | null)?.PriceListID ?? null,
      );
      if (priceListId == null) return baseItems;

      const encodedPriceListId = encodeURIComponent(String(priceListId));
      const basicDataHref = `/price-lists/${encodedPriceListId}/basicdata`;
      const productsHref = `/price-lists/${encodedPriceListId}/products`;
      const basicDataIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';
      const productsMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg></span>';
      const newTabIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span>';
      const viewBasicDataItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View Basic Data',
        icon: basicDataIcon,
        action: () => { router.push(basicDataHref); },
        subMenu: [
          { name: 'Open', icon: basicDataIcon, action: () => { router.push(basicDataHref); } },
          { name: 'Open in new tab', icon: newTabIcon, action: () => { window.open(basicDataHref, '_blank', 'noopener,noreferrer'); } },
        ],
      };
      const viewProductsItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View Products',
        icon: productsMenuIcon,
        action: () => { router.push(productsHref); },
        subMenu: [
          { name: 'Open', icon: productsMenuIcon, action: () => { router.push(productsHref); } },
          { name: 'Open in new tab', icon: newTabIcon, action: () => { window.open(productsHref, '_blank', 'noopener,noreferrer'); } },
        ],
      };

      const topItems: Array<MenuItemDef<Record<string, unknown>> | string> = [viewBasicDataItem, viewProductsItem];

      const rawBrandId = (rowData as { BrandID?: unknown } | null)?.BrandID ?? null;
      const brandId = typeof rawBrandId === 'number'
        ? rawBrandId
        : typeof rawBrandId === 'string'
          ? Number.parseInt(rawBrandId, 10)
          : null;
      if (brandId != null && Number.isInteger(brandId) && brandId > 0) {
        const viewBrandDetailsItem: MenuItemDef<Record<string, unknown>> = {
          name: 'View Brand Details',
          icon: brandDetailsMenuIcon,
          action: () => { openLinkInNewTab(`/brands/${encodeURIComponent(String(brandId))}/details`); },
        };
        topItems.push(viewBrandDetailsItem);
      }

      baseItems.unshift(...topItems, 'separator');

      const importItem = {
        name: "Import new version",
        icon: importNewVersionIcon,
        action: () => {
          router.push(`/price-lists/import?from=${encodeURIComponent(String(priceListId))}`);
        },
      };

      const appendItem = {
        name: "Append products",
        icon: appendProductsIcon,
        action: () => {
          router.push(`/price-lists/import?append=${encodeURIComponent(String(priceListId))}`);
        },
      };

      const filePath = normalizeStringValue(
        (rowData as { FilePath?: unknown } | null)?.FilePath ?? null,
      );
      const viewFileItem = filePath
        ? {
            name: "View original file",
            icon: viewOriginalFileIcon,
            action: () => {
              window.open(`/api/price-lists/${encodeURIComponent(String(priceListId))}/file`, "_blank");
            },
          }
        : null;

      // Insert just before the delete item (last item), in the same section
      const lastItem = baseItems[baseItems.length - 1];
      const isLastDelete = lastItem && typeof lastItem === "object" && "name" in lastItem
        && typeof lastItem.name === "string" && lastItem.name.startsWith("Delete");
      if (isLastDelete) {
        if (viewFileItem) baseItems.splice(baseItems.length - 1, 0, viewFileItem);
        baseItems.splice(baseItems.length - 1, 0, importItem);
        baseItems.splice(baseItems.length - 1, 0, appendItem);
      } else {
        if (viewFileItem) baseItems.push(viewFileItem);
        baseItems.push(importItem);
        baseItems.push(appendItem);
      }

      return baseItems;
    },
    [priceListRowDeletion, router, importNewVersionIcon, appendProductsIcon, viewOriginalFileIcon, brandDetailsMenuIcon],
  );

  const pricingPolicyColumns: ColDef[] = useMemo(
    () =>
      Array.from({ length: maxPricingPolicies }, (_, idx) => ({
        colId: `PP${idx + 1}`,
        headerName: `PP${idx + 1}`,
        filter: "agTextColumnFilter",
        sortable: true,
        width: 90,
        valueGetter: (params: { data?: Record<string, unknown> | null }) => {
          const policies = parsePricingPolicies(params.data?.PricingPolicies);
          const name = policies[idx];
          return name ? toPricingPolicyInitials(name) : null;
        },
        tooltipValueGetter: (params: { data?: Record<string, unknown> | null }) => {
          const policies = parsePricingPolicies(params.data?.PricingPolicies);
          return policies[idx] ?? null;
        },
      })),
    [maxPricingPolicies],
  );

  const columnDefs: ColDef[] = useMemo(
    () => [
      { field: "BrandID", hide: true, suppressColumnsToolPanel: true },
      { field: "Name", headerName: "Price List Name", filter: "agTextColumnFilter" },
      { field: "BrandName", headerName: "Brand", filter: "agTextColumnFilter" },
      { field: "SupplierName", headerName: "Supplier", filter: "agTextColumnFilter", enableRowGroup: true },
      {
        field: "ResponsibleUserName",
        headerName: "Responsible User",
        filter: "agTextColumnFilter",
        valueFormatter: (params) => {
          const explicitName = normalizeStringValue(params.value);
          if (explicitName) return explicitName;
          const row = params.data as { ResponsibleUserId?: unknown } | null | undefined;
          const id = normalizeStringValue(row?.ResponsibleUserId ?? null);
          return id ? (responsibleUserNameById.get(id) ?? "") : "";
        },
      },
      {
        field: "ValidFromDate",
        headerName: "Valid From",
        filter: "agDateColumnFilter",
        valueFormatter: (params: ValueFormatterParams) => formatDateUK(params.value),
        filterParams: { 
          browserDatePicker: false, 
          minValidYear: 2000,
        },
      },
      {
        field: "ValidToDate",
        headerName: "Valid To",
        filter: "agDateColumnFilter",
        valueFormatter: (params: ValueFormatterParams) => formatDateUK(params.value),
        cellClassRules: validToStatusClassRules,
        filterParams: {
          browserDatePicker: false,
          minValidYear: 2000,
        },
      },
      {
        field: "ValidityComment",
        headerName: "Validity Comment",
        filter: "agTextColumnFilter"
      },
      {
        field: "CreatedBy",
        headerName: "Created By",
        filter: "agTextColumnFilter",
      },
      {
        field: "CreatedOn",
        headerName: "Created On",
        filter: "agDateColumnFilter",
        valueFormatter: (params: ValueFormatterParams) => formatDateUK(params.value),
        filterParams: {
          browserDatePicker: false,
          minValidYear: 2000,
        },
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
        width: 110,
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
      ...pricingPolicyColumns,
    ],
    [enabledOptions, responsibleUserNameById, pricingPolicyColumns]
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in PRICE_LIST_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const priceListId = normalizePriceListIdValue(
      (event.data as { PriceListID?: unknown } | null | undefined)?.PriceListID ?? null,
    );
    if (priceListId == null) return;
    const label = PRICE_LIST_FIELD_LABELS[field] ?? field;
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
    const value = field === "Enabled"
      ? normalizeBoolean(
          (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
        )
      : null;
    const updateField = field;

    const submit = async () => {
      try {
        const res = await fetch(`/api/price-lists/${priceListId}/basicdata`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ field: updateField, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        const undoLabel = `${label} updated`;
        pushUndo({
          label: undoLabel,
          undo: async () => {
            const undoRes = await fetch(`/api/price-lists/${priceListId}/basicdata`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ updates: [{ field, value: event.oldValue }] }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error("Failed to revert");
            try { event.node?.setDataValue(field, event.oldValue); } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage(undoLabel, "success", 5500, {
          label: "Undo",
          onClick: () => performUndo(),
        });
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
    <main className={styles.page}>
      <PageHeader
        title="Price Lists"
        leftActions={
          canUndo ? (
            <button
              type="button"
              className="page-header-button"
              onClick={performUndo}
            >
              ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
            </button>
          ) : undefined
        }
        rightActions={
          <button
            type="button"
            className={`${styles.importButton} page-header-button`}
            onClick={handleImportClick}
          >
            Import Price List
          </button>
        }
      >
        <GridQuickSearchProvider>
          <div className={`${styles.gridFrame} fq-grid-panel`}>
            <AgGridAll
              endpoint="/api/price-lists"
              columnDefs={columnDefs}
              getContextMenuItems={priceListsContextMenuItems}
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              autoSizeExclusions={["ValidFromDate", "ValidToDate"]}
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
