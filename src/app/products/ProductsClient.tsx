"use client";

import React, { useMemo, useCallback } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { ColDef, DefaultMenuItem, GetContextMenuItemsParams, MenuItemDef } from "ag-grid-community";
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

export default function ProductsClient() {
  const router = useRouter();
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

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const items: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string> = [
        ...(params.defaultItems ?? []),
      ];
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
          void router.push(
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
    [router],
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
