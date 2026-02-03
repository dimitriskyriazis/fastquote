"use client";

import React, { useMemo, useCallback, useState, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import type {
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  IRowNode,
  MenuItemDef,
  RowNode,
} from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { openLinkInNewTab } from "../../lib/navigation";
import { showToastMessage } from "../../lib/toast";
import styles from "./ProductsClient.module.css";
import AddProductModal from "./AddProductModal";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";

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

export default function ProductsClient() {
  const [isAddProductOpen, setIsAddProductOpen] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [highlightedProductId, setHighlightedProductId] = useState<number | null>(null);
  const [lookups, setLookups] = useState<ProductLookups | null>(null);
  const lookupsLoadingRef = useRef(false);

  const loadLookups = useCallback(async () => {
    if (lookupsLoadingRef.current) return;
    lookupsLoadingRef.current = true;
    try {
      const response = await fetch(PRODUCT_LOOKUP_ENDPOINT);
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
      field: "ModelNumber",
      headerName: "Model number",
      filter: "agTextColumnFilter",
      editable: true,
      valueParser: (params) => normalizeEditableValue(params.newValue),
    },
    {
      field: "PartNumber",
      headerName: "Part number",
      filter: "agTextColumnFilter",
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
      field: "Description",
      headerName: "Description",
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
  ], [categoryOptions, subCategoryOptions, typeOptions]);

  const productRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/products",
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
      }),
    [],
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
          (item as MenuItemDef).name === "Delete row",
      );
      if (deleteIndex >= 0) {
        items.splice(deleteIndex, 0, historyItem);
      } else {
        items.push(historyItem);
      }

      return items;
    },
    [productRowDeletion],
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

      const runUpdate = async (payload: Record<string, unknown>, label: string) => {
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
          showToastMessage(`${label} updated`, "success");
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
        void runUpdate({ [config.payloadKey]: normalizedNew }, config.label);
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
    },
    [categoryOptions, lookups, subCategoryOptions, typeOptions],
  );

  return (
    <>
      <main className={styles.page}>
        <PageHeader
          title="Products"
          rightActions={
            <div className={styles.headerActions}>
              <button
                type="button"
                className={`${styles.headerButton} page-header-button`}
                onClick={openAddProduct}
              >
                Add Product
              </button>
            </div>
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
                onRequestPayloadConsumed={() => {
                  setHighlightedProductId(null);
                }}
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
