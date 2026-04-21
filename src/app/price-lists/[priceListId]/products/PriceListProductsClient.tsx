"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
  ValueFormatterParams,
} from "ag-grid-community";
import type { ServerRequestWithQuickFilter } from "../../../components/AgGridAll";
import layoutStyles from "../../priceListDetail.module.css";
import pageStyles from "./PriceListProductsPage.module.css";
import { GridRowDeletion, getContextMenuSelectionSnapshot, getServerSideDeselectedRowIds } from "../../../../lib/gridRowDeletion";
import { showConfirmDialog, showMultiChoiceDialog } from "../../../../lib/confirm";
import { checkDeletePermissionForClient } from "../../../../lib/deletePermissions";
import { useAuditUser } from "../../../components/AuditUserProvider";
import { getUserNumberLocale } from "../../../../lib/localeNumber";
import { normalizeBoolean } from "../../../../lib/normalizeBoolean";
import { showToastMessage } from "../../../../lib/toast";
import { useUndoStack } from "../../../hooks/useUndoStack";
import { pushCellEditUndo, makePatternAUndoFn } from "../../../../lib/undoHelpers";

const AgGridAll = dynamic(() => import("../../../components/AgGridAll"), {
  ssr: false,
  loading: () => <div>Loading price list products…</div>,
});

type Props = {
  priceListId: string;
  headingText: string;
  priceListLabel: string;
};

type PriceListProductRowGrid = {
  ProductID?: number | null;
  PriceListItemID?: number | null;
  Description?: string | null;
  PartNumber?: string | null;
  LegacyPartNo?: string | null;
  ModelNumber?: string | null;
  ListPrice?: string | number | null;
  CostPrice?: string | number | null;
  CostPriceOtherCurrency?: string | number | null;
  CostCurrencyName?: string | null;
  Warning?: string | number | boolean | null;
  Enabled?: boolean | number | null;
  PriceListID?: number | null;
};

const currencyFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatCurrency = (params: ValueFormatterParams) => {
  const value = params?.value;
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${currencyFormatter.format(num)} €`;
};

const formatEnabledValue = (value: unknown) => {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
};

const normalizePriceListItemId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const resolvePriceListRowLabel = (row: PriceListProductRowGrid | null | undefined, fallback: string) => {
  if (!row) return fallback;
  const normalize = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : value ? String(value) : "";
  const partNumber = normalize(row.PartNumber);
  const description = normalize(row.Description);
  if (partNumber && description) return `${partNumber} – ${description}`;
  if (partNumber) return partNumber;
  if (description) return description;
  return fallback;
};

const PRICE_LIST_ROW_TYPE_LABEL = "price list item";
const TWO_CONDITION_FILTER_PARAMS = {
  maxNumConditions: 2,
  alwaysShowBothConditions: true,
  defaultJoinOperator: "AND" as const,
};

const PRICE_LIST_FIELD_LABELS: Record<string, string> = {
  Enabled: "Enabled",
  ModelNumber: "Model Number",
};

const productHistoryMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--history" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5a7 7 0 1 1-7 7" />
      <path d="M12 9v4l2.6 1.5" />
      <path d="M5 7 4 4l3 1" />
    </svg>
  </span>
`;

const addWebLinkMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5Z"/>
      <path d="M18 1.5a.75.75 0 0 1 .728.568l.258 1.036a2.63 2.63 0 0 0 1.91 1.91l1.036.258a.75.75 0 0 1 0 1.456l-1.036.258a2.63 2.63 0 0 0-1.91 1.91l-.258 1.036a.75.75 0 0 1-1.456 0l-.258-1.036a2.63 2.63 0 0 0-1.91-1.91l-1.036-.258a.75.75 0 0 1 0-1.456l1.036-.258a2.63 2.63 0 0 0 1.91-1.91l.258-1.036A.75.75 0 0 1 18 1.5Z"/>
    </svg>
  </span>
`;
const ADD_WEBLINK_MAX_PRODUCTS = 200;

export default function PriceListProductsClient({
  priceListId,
  headingText,
  priceListLabel,
}: Props) {
  const { roles } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [isAddingWebLinks, setIsAddingWebLinks] = useState(false);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const defaultEnabledFilterAppliedRef = useRef(false);
  const lastServerRequestRef = useRef<ServerRequestWithQuickFilter | null>(null);
  const endpoint = useMemo(
    () => `/api/price-lists/${encodeURIComponent(priceListId)}/products`,
    [priceListId],
  );
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPartNumberFilterRef = useRef((searchParams.get("partNumber") ?? "").trim());
  const initialDescriptionFilterRef = useRef((searchParams.get("description") ?? "").trim());
  const enabledOptions = useMemo(() => ["Yes", "No"], []);

  const handleServerRequest = useCallback((request: ServerRequestWithQuickFilter) => {
    lastServerRequestRef.current = request;
  }, []);

  const fetchAllFilteredProductIds = useCallback(async (): Promise<number[]> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      throw new Error("Grid is not ready yet.");
    }
    const baseRequest: Record<string, unknown> = {
      filterModel: api.getFilterModel?.() ?? {},
      sortModel: api.getColumnState?.()
        ?.filter((col) => col.sort === "asc" || col.sort === "desc")
        .map((col) => ({ colId: col.colId, sort: col.sort as "asc" | "desc" })) ?? [],
    };
    const quickFilterText = typeof lastServerRequestRef.current?.quickFilterText === "string"
      ? lastServerRequestRef.current.quickFilterText.trim()
      : "";
    if (quickFilterText.length > 0) {
      baseRequest.quickFilterText = quickFilterText;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          ...baseRequest,
          startRow: 0,
          endRow: ADD_WEBLINK_MAX_PRODUCTS,
        },
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>>; rowCount?: number }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to load selected rows (status ${response.status})`);
    }
    const rowCount = Number(payload.rowCount ?? payload.rows.length);
    if (Number.isFinite(rowCount) && rowCount > ADD_WEBLINK_MAX_PRODUCTS) {
      throw new Error(`Cannot process more than ${ADD_WEBLINK_MAX_PRODUCTS} products at once. Please filter first.`);
    }
    const deselectedIds = getServerSideDeselectedRowIds(api);
    return Array.from(new Set(
      payload.rows
        .map((row) => normalizeProductId((row as { ProductID?: unknown }).ProductID ?? null))
        .filter((id): id is number => id != null)
        .filter((id) => deselectedIds.size === 0 || !deselectedIds.has(String(id))),
    ));
  }, [endpoint]);

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    gridApiRef.current = api;
    if (!api || defaultEnabledFilterAppliedRef.current) return;
    const existingModel = api.getFilterModel() as Record<string, unknown> | null;
    const nextModel = existingModel && typeof existingModel === "object" ? { ...existingModel } : {};
    const initialPartNumber = initialPartNumberFilterRef.current;
    const initialDescription = initialDescriptionFilterRef.current;
    let changed = false;
    if (!("Enabled" in nextModel)) {
      nextModel.Enabled = { filterType: "set", values: ["true"] };
      changed = true;
    }
    if (initialPartNumber && !("PartNumber" in nextModel)) {
      nextModel.PartNumber = { filterType: "text", type: "equals", filter: initialPartNumber };
      changed = true;
    }
    if (initialDescription && !("Description" in nextModel)) {
      nextModel.Description = { filterType: "text", type: "contains", filter: initialDescription };
      changed = true;
    }
    if (changed) {
      api.setFilterModel(nextModel);
    }
    defaultEnabledFilterAppliedRef.current = true;
  }, []);

  const columnDefs: ColDef[] = useMemo(
    () => [
      {
        colId: "__seq__",
        headerName: "#",
        width: 64,
        suppressMovable: true,
        suppressSizeToFit: true,
        sortable: false,
        filter: false,
        valueGetter: (params) => {
          const idx = params.node?.rowIndex;
          return typeof idx === "number" && idx >= 0 ? idx + 1 : "";
        },
      },
      {
        field: "PriceListItemID",
        hide: true,
        suppressColumnsToolPanel: true,
      },
      {
        field: "Description",
        headerName: "Product Description",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        width: 400,
      },
      {
        field: "PartNumber",
        headerName: "Part Number",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        width: 160,
      },
      {
        field: "LegacyPartNo",
        headerName: "Legacy Part No",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        width: 160,
      },
      {
        field: "ModelNumber",
        headerName: "Model Number",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        width: 160,
        editable: true,
      },
      {
        field: "ListPrice",
        headerName: "List Price",
        filter: "agNumberColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        valueFormatter: formatCurrency,
        type: "numericColumn",
        width: 140,
      },
      {
        field: "CostPrice",
        headerName: "Cost Price",
        filter: "agNumberColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        valueFormatter: formatCurrency,
        type: "numericColumn",
        width: 140,
      },
      {
        field: "CostPriceOtherCurrency",
        headerName: "Cost Price (Other Currency)",
        filter: "agNumberColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        valueFormatter: (params) => {
          const value = params?.value;
          if (value == null || value === "") return "";
          const num = typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(num)) return String(value);
          const currencyName = (params.data as PriceListProductRowGrid | undefined)?.CostCurrencyName ?? "";
          if (!currencyName) return currencyFormatter.format(num);
          const formatted = currencyFormatter.format(num);
          return currencyName === '$' ? `${currencyName} ${formatted}` : `${formatted} ${currencyName}`;
        },
        type: "numericColumn",
        width: 200,
      },
      {
        field: "Warning",
        headerName: "Warning",
        filter: "agTextColumnFilter",
        filterParams: TWO_CONDITION_FILTER_PARAMS,
        width: 140,
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
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
      {
        field: "CostCurrencyName",
        hide: true,
        suppressColumnsToolPanel: true,
      },
      {
        field: "PriceListID",
        headerName: "Price List ID",
        hide: true,
        suppressColumnsToolPanel: true,
      },
    ],
    [enabledOptions],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in PRICE_LIST_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const priceListItemId = normalizePriceListItemId(
      (event.data as { PriceListItemID?: unknown } | undefined)?.PriceListItemID ?? null,
    );
    if (priceListItemId == null) return;
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
      : event.newValue;

    const submit = async () => {
      try {
        const res = await fetch(endpoint, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ PriceListItemID: priceListItemId, field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        pushCellEditUndo(pushUndo, performUndo, label, makePatternAUndoFn({
          endpoint: `/api/price-lists/${priceListId}/products`,
          idField: "PriceListItemID",
          entityId: priceListItemId,
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
  }, [endpoint, pushUndo, performUndo, priceListId]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
      filterParams: TWO_CONDITION_FILTER_PARAMS,
    }),
    [],
  );

  const historyBackHref = `/price-lists/${encodeURIComponent(priceListId)}/products`;
  const historyBackLabel = priceListLabel?.trim() ? priceListLabel.trim() : "price list";

  const priceListRowDeletion = useMemo(
    () =>
      new GridRowDeletion<PriceListProductRowGrid>({
        endpoint,
        dataEndpoint: endpoint,
        idField: 'PriceListItemID',
        resolveRowId: (row) => normalizePriceListItemId(row?.PriceListItemID ?? null),
        resolveRowLabel: resolvePriceListRowLabel,
        resolveRowTypeLabel: () => PRICE_LIST_ROW_TYPE_LABEL,
        buildPayload: (ids) => ({ PriceListItemIDs: ids }),
        confirmTitle: ({ isSingle }) =>
          (isSingle ? "Delete price list item" : "Delete price list items"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete price list item" : "Delete price list items"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep item" : "Keep items"),
        successToastMessage: "Price list item deleted",
        failureToastMessage: "Unable to delete price list item. Please try again.",
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'managePriceLists'),
      }),
    [endpoint, roles],
  );

  const priceListContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const baseItems = priceListRowDeletion.getContextMenuItems(params) ?? [];
      const items = [...baseItems];
      const rowData = params.node?.data ?? null;
      if (!rowData) {
        return items;
      }

      const rawProductId = (rowData as { ProductID?: unknown }).ProductID;
      const productId =
        typeof rawProductId === "number"
          ? rawProductId
          : typeof rawProductId === "string"
            ? Number.parseInt(rawProductId, 10)
            : null;

      if (!productId || !Number.isInteger(productId)) {
        return items;
      }

      const historyItem: MenuItemDef = {
        name: "View Product's History",
        icon: productHistoryMenuIcon,
        action: () => {
          const qs = new URLSearchParams();
          qs.set("backHref", historyBackHref);
          qs.set("backLabel", historyBackLabel);
          void router.push(
            `/products/${encodeURIComponent(String(productId))}/history?${qs.toString()}`,
          );
        },
      };

      const deleteIndex = items.findIndex(
        (item) =>
          typeof item === "object" &&
          item != null &&
          typeof (item as MenuItemDef).name === "string" &&
          (item as MenuItemDef).name.trim().toLowerCase().startsWith("delete"),
      );
      if (deleteIndex >= 0) {
        items.splice(deleteIndex, 0, historyItem);
      } else {
        items.push(historyItem);
      }

      const isSelectAllActive = params.api && typeof params.api.getServerSideSelectionState === "function"
        ? (() => {
            const state = params.api.getServerSideSelectionState();
            return Boolean(state && "selectAll" in state && Boolean((state as { selectAll?: boolean }).selectAll));
          })()
        : false;

      // --- Add web links item ---
      const selectedNodes = getContextMenuSelectionSnapshot(params.api);
      const targetNodes = selectedNodes.length > 0 ? selectedNodes : (params.node ? [params.node] : []);
      const targetProducts = targetNodes.map((n) => n.data).filter(Boolean) as Record<string, unknown>[];
      const targetIds = targetProducts
        .map((p) => normalizeProductId(p.ProductID))
        .filter((id): id is number => id !== null);

      if (targetIds.length > 0 || isSelectAllActive) {
        const productsWithLinks = targetProducts.filter((p) => !!p.WebLink);
        const webLinkItem: MenuItemDef = {
          name: isSelectAllActive
            ? "Add web links (all filtered)"
            : targetIds.length > 1
              ? `Add web links (${targetIds.length})`
              : "Add web link",
          icon: addWebLinkMenuIcon,
          disabled: isAddingWebLinks,
          action: async () => {
            let idsToProcess: number[] = [];
            if (isSelectAllActive) {
              const confirmed = await showConfirmDialog({
                title: "Add web links for all filtered products",
                message: "This will overwrite any existing web links for the filtered rows. Continue?",
                confirmLabel: "Continue",
                cancelLabel: "Cancel",
              });
              if (!confirmed) return;
              try {
                idsToProcess = await fetchAllFilteredProductIds();
              } catch (err) {
                showToastMessage(
                  err instanceof Error ? err.message : "Failed to resolve selected products.",
                  "error",
                );
                return;
              }
            } else {
              idsToProcess = [...targetIds];

              if (productsWithLinks.length > 0) {
                const choice = await showMultiChoiceDialog({
                  title: "Existing web links found",
                  message:
                    productsWithLinks.length === targetIds.length
                      ? `All ${targetIds.length} selected product(s) already have a web link. Overwrite them?`
                      : `${productsWithLinks.length} of ${targetIds.length} selected product(s) already have a web link.`,
                  choices: [
                    { label: "Overwrite all", value: "overwrite" },
                    { label: "Skip existing", value: "skip" },
                    { label: "Cancel", value: "cancel" },
                  ],
                });
                if (!choice || choice === "cancel") return;
                if (choice === "skip") {
                  idsToProcess = targetProducts
                    .filter((p) => !p.WebLink)
                    .map((p) => normalizeProductId(p.ProductID))
                    .filter((id): id is number => id !== null);
                }
              }
            }

            if (idsToProcess.length === 0) {
              showToastMessage("No products selected for web link lookup.", "info");
              return;
            }

            setIsAddingWebLinks(true);
            const dismissLoadingToast = showToastMessage("Searching for web links\u2026", "info", 60000);
            try {
              const res = await fetch("/api/products/add-weblinks", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productIds: idsToProcess }),
              });
              const data = (await res.json()) as {
                ok: boolean;
                updatedCount?: number;
                failedCount?: number;
                error?: string;
              };
              dismissLoadingToast();
              if (data.ok) {
                const msg = data.failedCount
                  ? `Updated ${data.updatedCount} web link(s), ${data.failedCount} could not be found.`
                  : `Updated ${data.updatedCount} web link(s).`;
                showToastMessage(msg, "success");
                gridApiRef.current?.refreshServerSide({ purge: false });
                router.refresh();
              } else {
                showToastMessage(data.error ?? "Failed to find web links. Please try again.", "error");
              }
            } catch {
              dismissLoadingToast();
              showToastMessage("Failed to find web links. Please try again.", "error");
            } finally {
              setIsAddingWebLinks(false);
            }
          },
        };
        items.splice(deleteIndex >= 0 ? deleteIndex : items.length, 0, webLinkItem);
      }

      return items;
    },
    [fetchAllFilteredProductIds, historyBackHref, historyBackLabel, isAddingWebLinks, priceListRowDeletion, router],
  );

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/price-lists" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to price lists
          </Link>
          {canUndo && (
            <button
              type="button"
              className={`${layoutStyles.headerActionButton} page-header-button`}
              onClick={performUndo}
            >
              ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
            </button>
          )}
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>{headingText}</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <Link
            href={`/price-lists/${encodeURIComponent(priceListId)}/basicdata`}
            className={`${layoutStyles.headerActionButton} page-header-button`}
          >
            View Basic Data
          </Link>
        </div>
      </div>
      <div className={`${layoutStyles.pageBody} ${pageStyles.gridShell}`}>
        <div className={`${pageStyles.gridWrapper} ${pageStyles.bandedRows}`}>
          <AgGridAll
            endpoint={endpoint}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            onGridReady={handleGridReady}
            getContextMenuItems={priceListContextMenuItems}
            onCellValueChanged={handleCellEdit}
            rowGroupPanelShow="never"
            rowSelection="multiple"
            rowMultiSelectWithClick
            rowDeselection
            onServerRequest={handleServerRequest}
          />
        </div>
      </div>
    </main>
  );
}
