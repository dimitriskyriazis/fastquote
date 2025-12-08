"use client";

import React, { useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import type { ColDef, DefaultMenuItem, GetContextMenuItemsParams, MenuItemDef } from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { openLinkInNewTab } from "../../lib/navigation";
import styles from "./ProductsClient.module.css";

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

const PRODUCT_ROW_TYPE = "product";

export default function ProductsClient() {
  const columnDefs = useMemo<ColDef[]>(() => [
    {
      field: "Brand",
      headerName: "Brand",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "ModelNumber",
      headerName: "Model",
      filter: "agTextColumnFilter",
      minWidth: 180,
      flex: 1,
    },
    {
      field: "PartNumber",
      headerName: "Part number",
      filter: "agTextColumnFilter",
      minWidth: 180,
    },
    {
      field: "ERPPartNumber",
      headerName: "ERP part number",
      filter: "agTextColumnFilter",
      minWidth: 180,
    },
    {
      field: "Description",
      headerName: "Description",
      filter: "agTextColumnFilter",
      minWidth: 280,
      width: 320,
    },
    {
      field: "Category",
      headerName: "Category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "SubCategory",
      headerName: "Sub-category",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "Type",
      headerName: "Type",
      enableRowGroup: true,
      filter: "agTextColumnFilter",
      minWidth: 160,
    },
    {
      field: "WebLink",
      headerName: "Web link",
      filter: "agTextColumnFilter",
      minWidth: 220,
      flex: 1,
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
        confirmTitle: "Delete product",
        confirmConfirmLabel: "Delete product",
        confirmCancelLabel: "Keep product",
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

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.heading}>Products</h1>
      </div>
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint="/api/products"
          columnDefs={columnDefs}
          getContextMenuItems={getContextMenuItems}
          rowGroupPanelShow="always"
          autoSizeExclusions={["Description"]}
          columnStateNamespace="products-v2"
        />
      </div>
    </main>
  );
}
