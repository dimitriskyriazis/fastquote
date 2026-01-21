"use client";

import React, { useMemo, useCallback, useState, useRef, useEffect } from "react";
import dynamic from "next/dynamic";
import type {
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
  RowNode,
} from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { openLinkInNewTab } from "../../lib/navigation";
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
    },
    {
      field: "PartNumber",
      headerName: "Part number",
      filter: "agTextColumnFilter",
    },
    {
      field: "ERPPartNumber",
      headerName: "ERP part number",
      filter: "agTextColumnFilter",
    },
    {
      field: "Description",
      headerName: "Description",
      filter: "agTextColumnFilter",
      width: 320,
    },
    {
      field: "Category",
      headerName: "Category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
    },
    {
      field: "SubCategory",
      headerName: "Sub-category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
    },
    {
      field: "Type",
      headerName: "Type",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
    },
    {
      field: "WebLink",
      headerName: "Web link",
      filter: "agTextColumnFilter",
    },
  ], []);

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
                rowSelection="multiple"
                rowMultiSelectWithClick
                rowDeselection
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
