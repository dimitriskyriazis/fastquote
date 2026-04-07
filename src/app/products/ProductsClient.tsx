"use client";

import React, { useMemo, useCallback, useState, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  CellEditingStartedEvent,
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  IRowNode,
  MenuItemDef,
  RowNode,
} from "ag-grid-community";
import type { ServerRequestWithQuickFilter } from "../components/AgGridAll";
import { GridRowDeletion, getContextMenuSelectionSnapshot } from "../../lib/gridRowDeletion";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import { openLinkInNewTab } from "../../lib/navigation";
import { showToastMessage } from "../../lib/toast";
import { useUndoStack } from "../hooks/useUndoStack";
import { showConfirmDialog, showMultiChoiceDialog } from "../../lib/confirm";
import styles from "./ProductsClient.module.css";
import AddProductModal from "./AddProductModal";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>Loading products…</div>
  ),
});

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

const HISTORY_BACK_HREF = "/products";
const HISTORY_BACK_LABEL = "products";

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeEditableValue = (value: unknown): string | null => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

type LookupOption = {
  id: number;
  name: string;
};

type SubCategoryOption = LookupOption & {
  categoryId: number | null;
};

type ProductLookups = {
  categories: LookupOption[];
  subCategories: SubCategoryOption[];
  types: LookupOption[];
};

type ProductLookupResponse = {
  ok?: boolean;
  error?: string;
  categories?: LookupOption[];
  subCategories?: SubCategoryOption[];
  types?: LookupOption[];
};

const PRODUCT_LOOKUP_ENDPOINT = "/api/products/lookups";

const normalizeLookupKey = (value: string | null | undefined): string =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

const resolveLookupOption = (options: LookupOption[], value: unknown): LookupOption | null => {
  const key = normalizeLookupKey(typeof value === "string" ? value : String(value ?? ""));
  if (!key) return null;
  return options.find((option) => normalizeLookupKey(option.name) === key) ?? null;
};

const resolveSubCategoryOption = (
  options: SubCategoryOption[],
  value: unknown,
  categoryId: number | null,
): SubCategoryOption | null => {
  const key = normalizeLookupKey(typeof value === "string" ? value : String(value ?? ""));
  if (!key) return null;
  const matches = options.filter((option) => normalizeLookupKey(option.name) === key);
  if (matches.length === 0) return null;
  if (categoryId != null) {
    return matches.find((option) => option.categoryId === categoryId) ?? matches[0];
  }
  return matches[0];
};

const resolveProductLabel = (row: Record<string, unknown> | null | undefined, fallback: string) => {
  if (!row) return fallback;
  const brand = typeof row.Brand === "string" ? row.Brand.trim() : "";
  const model = typeof row.ModelNumber === "string" ? row.ModelNumber.trim() : "";
  const part = typeof row.PartNumber === "string" ? row.PartNumber.trim() : "";
  const segments = [part, model].filter((segment) => segment.length > 0);
  const prefix = brand.length > 0 ? `${brand} – ` : "";
  if (segments.length > 0) return `${prefix}${segments.join(" – ")}`;
  if (brand.length > 0) return brand;
  const description = typeof row.Description === "string" ? row.Description.trim() : "";
  if (description.length > 0) return description;
  return fallback;
};

type ProductSortEntry = { colId: string; sort: "asc" | "desc" };
type ProductGridApi = GridApi<Record<string, unknown>> & {
  getSortModel?: () => ProductSortEntry[];
  setSortModel?: (model: ProductSortEntry[]) => void;
};

type ProductRowNode = RowNode<Record<string, unknown>> & {
  ensureVisible?: (params?: { position?: "top" | "middle" | "bottom" }) => void;
};

const PRODUCT_ROW_TYPE = "product";
const ADD_WEBLINK_MAX_PRODUCTS = 200;
const ENHANCE_DESC_MAX_PRODUCTS = 200;

const enhanceDescriptionMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <path d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5Z"/>
      <path d="M18 1.5a.75.75 0 0 1 .728.568l.258 1.036a2.63 2.63 0 0 0 1.91 1.91l1.036.258a.75.75 0 0 1 0 1.456l-1.036.258a2.63 2.63 0 0 0-1.91 1.91l-.258 1.036a.75.75 0 0 1-1.456 0l-.258-1.036a2.63 2.63 0 0 0-1.91-1.91l-1.036-.258a.75.75 0 0 1 0-1.456l1.036-.258a2.63 2.63 0 0 0 1.91-1.91l.258-1.036A.75.75 0 0 1 18 1.5Z"/>
    </svg>
  </span>
`;

export default function ProductsClient() {
  const router = useRouter();
  const { roles } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [isAddingWebLinks, setIsAddingWebLinks] = useState(false);
  const [isEnhancingDescriptions, setIsEnhancingDescriptions] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [highlightedProductId, setHighlightedProductId] = useState<number | null>(null);
  const [lookups, setLookups] = useState<ProductLookups | null>(null);
  const lookupsLoadingRef = useRef(false);
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const lastServerRequestRef = useRef<ServerRequestWithQuickFilter | null>(null);

  const handleServerRequest = useCallback((request: ServerRequestWithQuickFilter) => {
    lastServerRequestRef.current = request;
  }, []);

  const fetchAllFilteredProductIds = useCallback(async (): Promise<number[]> => {
    const api = productsApiRef.current;
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
    const response = await fetch("/api/products", {
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
    return Array.from(new Set(
      payload.rows
        .map((row) => normalizeProductId((row as { ProductID?: unknown }).ProductID ?? null))
        .filter((id): id is number => id != null),
    ));
  }, []);

  const loadLookups = useCallback(async () => {
    if (lookupsLoadingRef.current) return;
    lookupsLoadingRef.current = true;
    try {
      const response = await fetch(PRODUCT_LOOKUP_ENDPOINT, { cache: 'no-store' });
      const payload = (await response.json().catch(() => null)) as ProductLookupResponse | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? "Unable to load product lookup data.");
      }
      setLookups({
        categories: payload.categories ?? [],
        subCategories: payload.subCategories ?? [],
        types: payload.types ?? [],
      });
    } catch (err) {
      console.error("Failed to load product lookup data", err);
      showToastMessage(
        err instanceof Error ? err.message : "Unable to load product lookup data.",
        "error",
      );
    } finally {
      lookupsLoadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (lookups) return;
    loadLookups();
  }, [loadLookups, lookups]);

  const handleProductCellEditingStarted = useCallback(
    (event: CellEditingStartedEvent<Record<string, unknown>>) => {
      const field = event.colDef.field;
      if (field === 'Category' || field === 'SubCategory' || field === 'Type') {
        void loadLookups();
      }
    },
    [loadLookups],
  );

  const categoryOptions = useMemo(() => lookups?.categories ?? [], [lookups]);
  const subCategoryOptions = useMemo(() => lookups?.subCategories ?? [], [lookups]);
  const typeOptions = useMemo(() => lookups?.types ?? [], [lookups]);
  const columnDefs = useMemo<ColDef[]>(() => [
    {
      field: "Brand",
      headerName: "Brand",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
    },
    {
      field: "PartNumber",
      headerName: "Part number",
      filter: "agTextColumnFilter",
      editable: true,
      valueParser: (params) => normalizeEditableValue(params.newValue),
    },
    {
      field: "LegacyPartNo",
      headerName: "Legacy Part No",
      filter: "agTextColumnFilter",
    },
    {
      field: "ModelNumber",
      headerName: "Model number",
      filter: "agTextColumnFilter",
      width: 250,
      editable: true,
      valueParser: (params) => normalizeEditableValue(params.newValue),
    },
    {
      field: "Description",
      headerName: "Description",
      filter: "agTextColumnFilter",
      width: 400,
      editable: true,
      valueParser: (params) => normalizeEditableValue(params.newValue),
    },
    {
      field: "ERPCode",
      headerName: "ERP Code",
      filter: "agTextColumnFilter",
      editable: true,
      valueParser: (params) => normalizeEditableValue(params.newValue),
    },
    {
      field: "Category",
      headerName: "Category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: {
        values: [
          "",
          ...categoryOptions.map((option) => option.name).filter((name) => name.length > 0),
        ],
      },
    },
    {
      field: "SubCategory",
      headerName: "Sub-category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: (params: { data?: Record<string, unknown> | null }) => {
        const categoryName = typeof params.data?.Category === "string" ? params.data?.Category : null;
        const categoryOption = resolveLookupOption(categoryOptions, categoryName);
        const values = subCategoryOptions
          .filter((option) => (categoryOption?.id != null ? option.categoryId === categoryOption.id : true))
          .map((option) => option.name)
          .filter((name) => name.length > 0);
        return { values: ["", ...values] };
      },
    },
    {
      field: "Type",
      headerName: "Type",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      editable: true,
      cellEditor: "agSelectCellEditor",
      cellEditorParams: {
        values: [
          "",
          ...typeOptions.map((option) => option.name).filter((name) => name.length > 0),
        ],
      },
    },
    {
      field: "WebLink",
      headerName: "Web link",
      filter: "agTextColumnFilter",
      editable: true,
      valueParser: (params) => normalizeEditableValue(params.newValue),
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
  ], [categoryOptions, subCategoryOptions, typeOptions, enabledOptions]);

  const productRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/products",
        dataEndpoint: "/api/products",
        idField: "ProductID",
        resolveRowId: (row) => normalizeProductId((row as { ProductID?: unknown } | null)?.ProductID ?? null),
        resolveRowLabel: (row, fallback) => resolveProductLabel(row, fallback),
        resolveRowTypeLabel: () => PRODUCT_ROW_TYPE,
        buildPayload: (ids) => ({ ProductIDs: ids }),
        confirmTitle: ({ isSingle }) =>
          (isSingle ? "Delete product" : "Delete products"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete product" : "Delete products"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep product" : "Keep products"),
        successToastMessage: "Product deleted",
        failureToastMessage: "Unable to delete product. Please try again.",
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageBrandsSuppliers'),
      }),
    [roles],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const items: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string> =
        (productRowDeletion.getContextMenuItems(params) ?? []).map((item) => item);
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
        name: "View product history",
        icon: productHistoryMenuIcon,
        action: () => {
          const qs = new URLSearchParams();
          qs.set("backHref", HISTORY_BACK_HREF);
          qs.set("backLabel", HISTORY_BACK_LABEL);
          openLinkInNewTab(
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
              const productsWithLinks = targetProducts.filter((p) => !!p.WebLink);
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
                const msg =
                  data.failedCount
                    ? `Updated ${data.updatedCount} web link(s), ${data.failedCount} could not be found.`
                    : `Updated ${data.updatedCount} web link(s).`;
                showToastMessage(msg, "success");
                productsApiRef.current?.refreshServerSide({ purge: true });
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

        const insertAt = deleteIndex >= 0 ? deleteIndex : items.length;
        items.splice(insertAt, 0, webLinkItem);
      }

      // --- Enhance description item ---
      if (targetIds.length > 0 || isSelectAllActive) {
        const enhanceDescItem: MenuItemDef = {
          name: isSelectAllActive
            ? "Enhance descriptions (all filtered)"
            : targetIds.length > 1
              ? `Enhance descriptions (${targetIds.length})`
              : "Enhance description",
          icon: enhanceDescriptionMenuIcon,
          disabled: isEnhancingDescriptions,
          action: async () => {
            let idsToProcess: number[] = [];
            if (isSelectAllActive) {
              const confirmed = await showConfirmDialog({
                title: "Enhance descriptions for all filtered products",
                message: "This will overwrite descriptions for the filtered rows. Continue?",
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
            }

            if (idsToProcess.length === 0) {
              showToastMessage("No products selected for description enhancement.", "info");
              return;
            }
            if (idsToProcess.length > ENHANCE_DESC_MAX_PRODUCTS) {
              showToastMessage(`Cannot process more than ${ENHANCE_DESC_MAX_PRODUCTS} products at once. Please filter first.`, "error");
              return;
            }

            setIsEnhancingDescriptions(true);
            const dismissLoadingToast = showToastMessage("Enhancing descriptions\u2026", "info", 120000);
            try {
              const res = await fetch("/api/products/enhance-descriptions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ productIds: idsToProcess }),
              });
              const data = (await res.json()) as {
                ok: boolean;
                updatedCount?: number;
                failedCount?: number;
                results?: Array<{
                  productId: number;
                  oldDescription: string | null;
                  newDescription: string | null;
                  status: string;
                }>;
                error?: string;
              };
              dismissLoadingToast();
              if (data.ok) {
                const msg = data.failedCount
                  ? `Enhanced ${data.updatedCount} description(s), ${data.failedCount} could not be enhanced.`
                  : `Enhanced ${data.updatedCount} description(s).`;
                showToastMessage(msg, "success");
                productsApiRef.current?.refreshServerSide({ purge: true });
                router.refresh();

                const updatedResults = (data.results ?? []).filter((r) => r.status === "updated");
                if (updatedResults.length > 0) {
                  pushUndo({
                    label: `Enhance ${updatedResults.length} description(s)`,
                    undo: async () => {
                      await fetch("/api/products/enhance-descriptions", {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          items: updatedResults.map((r) => ({
                            productId: r.productId,
                            description: r.oldDescription ?? "",
                          })),
                        }),
                      });
                      productsApiRef.current?.refreshServerSide({ purge: true });
                      router.refresh();
                    },
                  });
                }
              } else {
                showToastMessage(data.error ?? "Failed to enhance descriptions. Please try again.", "error");
              }
            } catch {
              dismissLoadingToast();
              showToastMessage("Failed to enhance descriptions. Please try again.", "error");
            } finally {
              setIsEnhancingDescriptions(false);
            }
          },
        };

        const enhanceInsertAt = deleteIndex >= 0 ? deleteIndex : items.length;
        items.splice(enhanceInsertAt, 0, enhanceDescItem);
      }

      return items;
    },
    [fetchAllFilteredProductIds, isAddingWebLinks, isEnhancingDescriptions, pushUndo, productRowDeletion, router],
  );

  const openAddProduct = useCallback(() => {
    setIsAddProductOpen(true);
  }, []);

  const closeAddProduct = useCallback(() => {
    setIsAddProductOpen(false);
  }, []);

  const productsApiRef = useRef<ProductGridApi | null>(null);
  const pendingSelectionProductIdRef = useRef<number | null>(null);

  const highlightRequestPayload = useMemo(
    () => (highlightedProductId != null ? { newProductId: highlightedProductId } : null),
    [highlightedProductId],
  );

  const ensureProductSort = useCallback((api?: ProductGridApi | null) => {
    if (!api) return;
    const sortModelGetter = api.getSortModel;
    const sortModel = typeof sortModelGetter === "function" ? sortModelGetter() : [];
    const hasProductIdDesc = sortModel.some((entry) => entry.colId === "ProductID" && entry.sort === "desc");
    if (!hasProductIdDesc) {
      const setter = api.setSortModel;
      if (typeof setter === "function") {
        setter([{ colId: "ProductID", sort: "desc" }]);
      }
    }
  }, []);

  const trySelectPendingProduct = useCallback(
    (api: GridApi<Record<string, unknown>>) => {
      const targetId = pendingSelectionProductIdRef.current;
      if (targetId == null) return;
      let found = false;
      api.forEachNode((node) => {
        if (found) return;
        const candidateId = normalizeProductId((node.data as { ProductID?: unknown }).ProductID ?? null);
        if (candidateId === targetId) {
          try {
            api.deselectAll();
          } catch {
            /* noop */
          }
          try {
            node.setSelected(true, true);
          } catch {
            node.setSelected(true);
          }
        const typedNode = node as ProductRowNode;
        const ensureVisible = typedNode.ensureVisible;
        if (typeof ensureVisible === "function") {
          try {
            ensureVisible.call(typedNode, { position: "top" });
          } catch {
            /* noop */
          }
        }
          found = true;
        }
      });
      if (found) {
        pendingSelectionProductIdRef.current = null;
        setHighlightedProductId(null);
      }
    },
    [setHighlightedProductId],
  );

  const handleGridReady = useCallback(
    (api: GridApi<Record<string, unknown>>) => {
      productsApiRef.current = api;
      if (!defaultEnabledFilterAppliedRef.current) {
        const existingModel = api.getFilterModel() as Record<string, unknown> | null;
        const nextModel = existingModel && typeof existingModel === "object" ? { ...existingModel } : {};
        if (!("Enabled" in nextModel)) {
          api.setFilterModel({
            ...nextModel,
            Enabled: { filterType: "set", values: ["true"] },
          });
        }
        defaultEnabledFilterAppliedRef.current = true;
      }
      ensureProductSort(api);
      trySelectPendingProduct(api);
    },
    [ensureProductSort, trySelectPendingProduct],
  );

  const handleModelUpdated = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    ensureProductSort(api);
    trySelectPendingProduct(api);
  }, [ensureProductSort, trySelectPendingProduct]);

  useEffect(() => {
    if (highlightedProductId == null) return;
    pendingSelectionProductIdRef.current = highlightedProductId;
    const api = productsApiRef.current;
    ensureProductSort(api);
  }, [ensureProductSort, highlightedProductId]);

  const handleProductAdded = useCallback((result?: { productId?: number | null }) => {
    const productId = result?.productId ?? null;
    if (productId != null) {
      setHighlightedProductId(productId);
    }
    setRefreshToken((prev) => prev + 1);
  }, []);

  const handleProductCellEdit = useCallback(
    (event: CellValueChangedEvent<Record<string, unknown>>) => {
      const field = typeof event.colDef?.field === "string" ? event.colDef.field : null;
      if (!field) return;
      const editableFields: Record<string, { label: string; payloadKey: "partNumber" | "modelNumber" | "description" | "erpCode" | "webLink" }> = {
        PartNumber: { label: "Part number", payloadKey: "partNumber" },
        ModelNumber: { label: "Model number", payloadKey: "modelNumber" },
        Description: { label: "Description", payloadKey: "description" },
        ERPCode: { label: "ERP code", payloadKey: "erpCode" },
        WebLink: { label: "Web link", payloadKey: "webLink" },
      };
      const config = editableFields[field];
      const source = (event as { source?: string }).source;
      if (source === "api") return;

      const productId = normalizeProductId(event.data?.ProductID ?? null);
      if (productId == null) {
        const label = config?.label ?? field;
        showToastMessage(`Unable to update ${label.toLowerCase()}. Missing product id.`, "error");
        try {
          (event.node as IRowNode<Record<string, unknown>> | null | undefined)?.setDataValue?.(field, event.oldValue ?? null);
        } catch {
          /* noop */
        }
        return;
      }

      const revertValue = () => {
        try {
          (event.node as IRowNode<Record<string, unknown>> | null | undefined)?.setDataValue?.(field, event.oldValue ?? null);
        } catch {
          /* noop */
        }
      };

      const runUpdate = async (payload: Record<string, unknown>, label: string, onSuccess?: () => void) => {
        try {
          const res = await fetch(`/api/products/${encodeURIComponent(String(productId))}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const payloadResponse = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payloadResponse?.ok) {
            throw new Error(payloadResponse?.error ?? `Failed to update ${label.toLowerCase()} (status ${res.status})`);
          }
          if (onSuccess) {
            onSuccess();
          } else {
            showToastMessage(`${label} updated`, "success");
          }
        } catch (err) {
          console.error(`Failed to update ${label}`, err);
          showToastMessage(`Unable to update ${label.toLowerCase()}. Please try again.`, "error");
          revertValue();
        }
      };

      if (config) {
        const normalizedOld = normalizeEditableValue(event.oldValue ?? null);
        const normalizedNew = normalizeEditableValue(event.newValue ?? null);
        if (normalizedOld === normalizedNew) return;
        const capturedProductId = productId;
        const capturedPayloadKey = config.payloadKey;
        const capturedLabel = config.label;
        const capturedOldValue = normalizedOld;
        const capturedNode = event.node;
        const capturedApi = event.api;
        void runUpdate({ [capturedPayloadKey]: normalizedNew }, capturedLabel, () => {
          pushUndo({
            label: `${capturedLabel} updated`,
            undo: async () => {
              const undoRes = await fetch(`/api/products/${encodeURIComponent(String(capturedProductId))}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ [capturedPayloadKey]: capturedOldValue }),
              });
              const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
              if (!undoRes.ok || !undoPayload?.ok) throw new Error("Failed to revert");
              try { capturedNode?.setDataValue?.(field, capturedOldValue); } catch { /* noop */ }
              capturedApi?.refreshServerSide?.({ purge: false });
            },
          });
          showToastMessage(`${capturedLabel} updated`, "success", 5500, {
            label: "Undo",
            onClick: () => performUndo(),
          });
        });
        return;
      }

      if (!lookups) {
        showToastMessage("Lookup data is not loaded yet. Please try again in a moment.", "error");
        revertValue();
        return;
      }

      const categoryOption = resolveLookupOption(categoryOptions, event.data?.Category ?? null);
      const currentCategoryId = categoryOption?.id ?? null;

      if (field === "Category") {
        const rawValue = normalizeLookupKey(typeof event.newValue === "string" ? event.newValue : String(event.newValue ?? ""));
        if (!rawValue) {
          try {
            (event.node as IRowNode<Record<string, unknown>> | null | undefined)?.setDataValue?.("SubCategory", null);
          } catch {
            /* noop */
          }
          void runUpdate({ categoryId: null, subCategoryId: null }, "Category");
          return;
        }
        const nextCategory = resolveLookupOption(categoryOptions, event.newValue ?? null);
        if (!nextCategory) {
          showToastMessage("Please select a valid category.", "error");
          revertValue();
          return;
        }
        const updates: Record<string, unknown> = { categoryId: nextCategory.id };
        const subCategoryOption = resolveSubCategoryOption(subCategoryOptions, event.data?.SubCategory ?? null, currentCategoryId);
        if (subCategoryOption && subCategoryOption.categoryId !== nextCategory.id) {
          updates.subCategoryId = null;
          try {
            (event.node as IRowNode<Record<string, unknown>> | null | undefined)?.setDataValue?.("SubCategory", null);
          } catch {
            /* noop */
          }
        }
        void runUpdate(updates, "Category");
        return;
      }

      if (field === "SubCategory") {
        const rawValue = normalizeLookupKey(typeof event.newValue === "string" ? event.newValue : String(event.newValue ?? ""));
        if (!rawValue) {
          void runUpdate({ subCategoryId: null }, "Sub-category");
          return;
        }
        const nextSubCategory = resolveSubCategoryOption(subCategoryOptions, event.newValue ?? null, currentCategoryId);
        if (!nextSubCategory) {
          showToastMessage("Please select a valid sub-category.", "error");
          revertValue();
          return;
        }
        const updates: Record<string, unknown> = { subCategoryId: nextSubCategory.id };
        if (nextSubCategory.categoryId != null && nextSubCategory.categoryId !== currentCategoryId) {
          const nextCategory = categoryOptions.find((option) => option.id === nextSubCategory.categoryId) ?? null;
          if (nextCategory) {
            updates.categoryId = nextCategory.id;
            try {
              (event.node as IRowNode<Record<string, unknown>> | null | undefined)?.setDataValue?.("Category", nextCategory.name);
            } catch {
              /* noop */
            }
          }
        }
        void runUpdate(updates, "Sub-category");
        return;
      }

      if (field === "Type") {
        const rawValue = normalizeLookupKey(typeof event.newValue === "string" ? event.newValue : String(event.newValue ?? ""));
        if (!rawValue) {
          void runUpdate({ typeId: null }, "Type");
          return;
        }
        const nextType = resolveLookupOption(typeOptions, event.newValue ?? null);
        if (!nextType) {
          showToastMessage("Please select a valid type.", "error");
          revertValue();
          return;
        }
        void runUpdate({ typeId: nextType.id }, "Type");
        return;
      }

      if (field === "Enabled") {
        const enabled = normalizeBoolean(
          (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
        );
        void runUpdate({ enabled }, "Enabled");
        return;
      }
    },
    [categoryOptions, lookups, performUndo, pushUndo, subCategoryOptions, typeOptions],
  );

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Products"
          leftActions={
            canUndo ? (
              <button
                type="button"
                className={`${styles.headerButton} page-header-button`}
                onClick={performUndo}
              >
                ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
              </button>
            ) : undefined
          }
          rightActions={
            <button
              type="button"
              className={`${styles.headerButton} page-header-button`}
              onClick={openAddProduct}
            >
              Add Product
            </button>
          }
        >
          <GridQuickSearchProvider>
            <div className={styles.gridFrame}>
              <AgGridAll
                endpoint="/api/products"
                columnDefs={columnDefs}
                getContextMenuItems={getContextMenuItems}
                rowGroupPanelShow="always"
                autoSizeExclusions={["Description"]}
                columnStateNamespace="products-v2"
                refreshToken={refreshToken}
                requestPayload={highlightRequestPayload}
                onGridReady={handleGridReady}
                onModelUpdated={handleModelUpdated}
                cacheBlockSize={200}
                rowBuffer={40}
                maxBlocksInCache={10}
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
                onCellValueChanged={handleProductCellEdit}
                onCellEditingStarted={handleProductCellEditingStarted}
                onRequestPayloadConsumed={() => {
                  setHighlightedProductId(null);
                }}
                onServerRequest={handleServerRequest}
              />
            </div>
          </GridQuickSearchProvider>
        </PageHeader>
      </main>
      <AddProductModal
        open={isAddProductOpen}
        onClose={closeAddProduct}
        onAdded={handleProductAdded}
      />
    </>
  );
}
