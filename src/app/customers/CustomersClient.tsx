"use client";

import React, { useMemo, useCallback, useRef, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { ColDef, GridApi, ICellRendererParams } from "ag-grid-community";
import { createPortal } from "react-dom";
import styles from "./CustomersClient.module.css";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading customers…
    </div>
  ),
});

const formatBooleanValue = (value: unknown) => {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
};

export default function CustomersClient() {
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

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const ActionMenu: React.FC = () => {
      const [open, setOpen] = useState(false);
      const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
      const btnRef = useRef<HTMLButtonElement | null>(null);
      const id = params?.data?.CustomerID as string | number | undefined;
      const encodedId = id != null ? encodeURIComponent(String(id)) : "";

      const go = (suffix: "basic" | "contacts") => {
        if (!encodedId) return;
        router.push(`/customers/${encodedId}/${suffix}`);
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
            title={encodedId ? "Open menu" : "Missing Customer ID"}
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
                  onClick={() => go("basic")}
                >
                  View Basic Data
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.actionMenuItem}
                  onClick={() => go("contacts")}
                >
                  View Contacts
                </button>
              </div>,
              document.body,
            )}
        </div>
      );
    };

    return <ActionMenu />;
  }, [router]);

  const columnDefs = useMemo<ColDef[]>(
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
      {
        field: "CustomerName",
        headerName: "Customer",
        filter: "agTextColumnFilter",
        flex: 1,
        minWidth: 200,
      },
      {
        field: "BrandName",
        headerName: "Brand",
        filter: "agTextColumnFilter",
        minWidth: 160,
      },
      {
        field: "IsParent",
        headerName: "Is Parent",
        filter: "agSetColumnFilter",
        enableRowGroup: true,
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
        width: 130,
        minWidth: 120,
      },
      {
        field: "ParentCustomer",
        headerName: "Parent Customer",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        minWidth: 220,
        flex: 1,
      },
      {
        field: "PricingPolicy",
        headerName: "Pricing Policy",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        minWidth: 220,
        flex: 1,
      },
      {
        field: "Importance",
        headerName: "Importance",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        minWidth: 160,
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
      },
    ],
    [ActionCell],
  );

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <h1 className={styles.heading}>Customers</h1>
        <div className={styles.headerActions}>
          <button
            type="button"
            className={`${styles.headerButton} page-header-button`}
            onClick={() => {
              router.push("/customer-contacts");
            }}
          >
            View All Contacts
          </button>
          <button
            type="button"
            className={`${styles.headerButton} page-header-button`}
            onClick={() => {
              router.push("/customer-groups");
            }}
          >
            View Groups
          </button>
          <button
            type="button"
            className={`${styles.headerButton} page-header-button`}
            onClick={() => {
              /* Add customer action placeholder */
            }}
          >
            Add Customer
          </button>
        </div>
      </div>
      <div className={styles.gridFrame}>
        <AgGridAll
          endpoint="/api/customers"
          columnDefs={columnDefs}
          rowGroupPanelShow="always"
          columnStateNamespace="customers"
          onGridReady={handleGridReady}
        />
      </div>
    </main>
  );
}
