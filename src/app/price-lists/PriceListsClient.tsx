"use client";

import React, { useMemo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
  ICellRendererParams,
  ValueFormatterParams,
} from "ag-grid-community";
import { createPortal } from "react-dom";
import styles from "./PriceListsClient.module.css";
import { GridRowDeletion } from "../../lib/gridRowDeletion";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});

const formatDateValue = (params: ValueFormatterParams) => {
  const raw = params.value;
  if (!raw) return "";
  const date = new Date(raw as string);
  return Number.isNaN(date.getTime())
    ? String(raw)
    : date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
};

const formatEnabledValue = (value: unknown) => {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
};

const normalizePriceListIdValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
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

const PRICE_LIST_ROW_TYPE_LABEL = "price list";

export default function PriceListsClient() {
  const router = useRouter();
  const defaultEnabledFilterAppliedRef = useRef(false);

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

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const ActionMenu: React.FC = () => {
      const [open, setOpen] = useState(false);
      const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
      const btnRef = useRef<HTMLButtonElement | null>(null);
      const priceListId = params?.data?.PriceListID as string | number | undefined;
      const encodedId = priceListId != null ? encodeURIComponent(String(priceListId)) : "";

      const go = (suffix: "products" | "basicdata") => {
        if (!encodedId) return;
        router.push(`/price-lists/${encodedId}/${suffix}`);
      };

      const preventRangeSelection = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };

      useEffect(() => {
        if (!open) return;
        const rect = btnRef.current?.getBoundingClientRect();
        if (rect) {
          setMenuPos({ top: rect.bottom + 6, left: rect.left });
        }
        const onDocClick = (e: MouseEvent) => {
          if (!btnRef.current) return setOpen(false);
          if (e.target instanceof Node && btnRef.current.contains(e.target)) return;
          setOpen(false);
        };
        window.addEventListener("click", onDocClick);
        return () => window.removeEventListener("click", onDocClick);
      }, [open]);

      const lines = (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="4" width="10" height="1.5" rx="0.75" fill="currentColor" />
          <rect x="3" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor" />
          <rect x="3" y="10.5" width="10" height="1.5" rx="0.75" fill="currentColor" />
        </svg>
      );

      return (
        <div
          className={styles.actionCell}
          onMouseDownCapture={preventRangeSelection}
          onPointerDownCapture={preventRangeSelection}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            className={styles.actionButton}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((v) => !v);
            }}
            onMouseDownCapture={preventRangeSelection}
            onPointerDownCapture={preventRangeSelection}
            onContextMenuCapture={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            disabled={!encodedId}
            title={encodedId ? "Open menu" : "Missing Price List ID"}
            ref={btnRef}
          >
            {lines}
          </button>
          {open &&
            menuPos &&
            createPortal(
              <div
                role="menu"
                className={styles.actionMenu}
                style={{ top: menuPos.top, left: menuPos.left }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className={styles.actionMenuItem}
                  onClick={() => go("basicdata")}
                >
                  View Basic Data
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.actionMenuItem}
                  onClick={() => go("products")}
                >
                  View Products
                </button>
              </div>,
              document.body
            )}
        </div>
      );
    };

  return <ActionMenu />;
  }, [router]);

  const priceListRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: '/api/price-lists',
        resolveRowId: (row) =>
          normalizePriceListIdValue((row as { PriceListID?: unknown } | null | undefined)?.PriceListID ?? null),
        resolveRowLabel: (row, fallback) =>
          resolvePriceListRowLabel(
            row as { Name?: string | null; SupplierName?: string | null } | null,
            fallback,
          ),
        resolveRowTypeLabel: () => PRICE_LIST_ROW_TYPE_LABEL,
        buildPayload: (ids) => ({ PriceListIDs: ids }),
        confirmTitle: 'Delete price list',
        confirmConfirmLabel: 'Delete price list',
        confirmCancelLabel: 'Keep price list',
        successToastMessage: 'Price list deleted',
        failureToastMessage: 'Unable to delete price list. Please try again.',
      }),
    [],
  );

  const priceListsContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) =>
      priceListRowDeletion.getContextMenuItems(params),
    [priceListRowDeletion],
  );

  const columnDefs: ColDef[] = useMemo(
    () => [
      {
        headerName: "",
        field: "__actions__",
        pinned: "left",
        lockPinned: true,
        lockPosition: true,
        suppressNavigable: true,
        resizable: false,
        sortable: false,
        filter: false,
        suppressMovable: true,
        suppressSizeToFit: true,
        suppressColumnsToolPanel: true,
        maxWidth: 52,
        minWidth: 44,
        width: 48,
        cellClass: styles.actionCellContainer,
        cellRenderer: ActionCell,
      },
      { field: "Name", headerName: "Price List", filter: "agTextColumnFilter" },
      { field: "SupplierName", headerName: "Supplier", filter: "agTextColumnFilter", enableRowGroup: true },
      {
        field: "ValidFromDate",
        headerName: "Valid From",
        filter: "agDateColumnFilter",
        valueFormatter: formatDateValue,
        width: 107,
        minWidth: 107,
        maxWidth: 107,
        suppressAutoSize: true,
      },
      {
        field: "ValidToDate",
        headerName: "Valid To",
        filter: "agDateColumnFilter",
        valueFormatter: formatDateValue,
        width: 105,
        minWidth: 105,
        suppressAutoSize: true,
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
          buttons: ["apply"],
          closeOnApply: true,
        },
        width: 110,
      },
      {
        field: "SupplierComment",
        headerName: "Supplier Comment",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 220,
      },
    ],
    [ActionCell]
  );

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.heading}>Price Lists</h1>
      <button
        type="button"
        className={`${styles.importButton} page-header-button`}
        onClick={handleImportClick}
      >
        Import Price List
      </button>
    </div>
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint="/api/price-lists"
          columnDefs={columnDefs}
          getContextMenuItems={priceListsContextMenuItems}
          onGridReady={handleGridReady}
          autoSizeExclusions={["ValidFromDate", "ValidToDate"]}
        />
      </div>
    </main>
  );
}
