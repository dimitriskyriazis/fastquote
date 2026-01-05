"use client";

import React, { useMemo, useCallback, useRef, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  ColDef,
  GridApi,
  GetContextMenuItemsParams,
  ICellRendererParams,
} from "ag-grid-community";
import { createPortal } from "react-dom";
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from "../components/actionMenuMarkers";
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from "../components/useActionMenuCoordinator";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import Link from "next/link";
import styles from "./CustomersClient.module.css";
import { useActionMenuPosition } from "../components/useActionMenuPosition";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";

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

const normalizeCustomerId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const resolveCustomerLabel = (
  row: Record<string, unknown> | null | undefined,
  fallback: string,
) => {
  if (!row) return fallback;
  const customerName = typeof row.CustomerName === "string" ? row.CustomerName.trim() : "";
  if (customerName.length > 0) return customerName;
  const brandName = typeof row.BrandName === "string" ? row.BrandName.trim() : "";
  if (brandName.length > 0) return brandName;
  const identifier = row.CustomerID != null ? String(row.CustomerID) : "";
  return identifier ? `#${identifier}` : fallback;
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
      const closeMenu = useCallback(() => setOpen(false), []);
      const instanceId = useActionMenuCloseListener(closeMenu);
      const { buttonRef, menuRef, menuPos } = useActionMenuPosition(open);
      const id = params?.data?.CustomerID as string | number | undefined;
      const encodedId = id != null ? encodeURIComponent(String(id)) : "";

      const preventRangeSelection = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };

      useEffect(() => {
        if (!open) return;
        const onDocClick = (e: MouseEvent) => {
          if (!(e.target instanceof Node)) return setOpen(false);
          if (buttonRef.current?.contains(e.target) || menuRef.current?.contains(e.target)) return;
          setOpen(false);
        };
        window.addEventListener("click", onDocClick);
        return () => window.removeEventListener("click", onDocClick);
      }, [open, buttonRef, menuRef]);

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
          {...{ [ACTION_MENU_TRIGGER_ATTRIBUTE]: 'true' }}
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
            {...{ [ACTION_MENU_TRIGGER_ATTRIBUTE]: 'true' }}
            onClick={(event) => {
              event.stopPropagation();
              if (!open) {
                dispatchActionMenuCloseEvent(instanceId);
              }
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
            ref={buttonRef}
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
                ref={menuRef}
                {...{ [ACTION_MENU_PANEL_ATTRIBUTE]: 'true' }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                }}
              >
                <Link
                  role="menuitem"
                  className={styles.actionMenuItem}
                  href={`/customers/${encodedId}/basicdata`}
                  prefetch={false}
                  onClick={(event) => event.stopPropagation()}
                >
                  View Basic Data
                </Link>
                <Link
                  role="menuitem"
                  className={styles.actionMenuItem}
                  href={`/customers/${encodedId}/contacts`}
                  prefetch={false}
                  onClick={(event) => event.stopPropagation()}
                >
                  View Contacts
                </Link>
              </div>,
              document.body,
            )}
        </div>
      );
    };

    return <ActionMenu />;
  }, []);

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
        width: 48,
        cellClass: styles.actionCellContainer,
        cellRenderer: ActionCell,
      },
      {
        field: "CustomerName",
        headerName: "Customer",
        filter: "agTextColumnFilter",
        flex: 1,
      },
      {
        field: "BrandName",
        headerName: "Brand",
        filter: "agTextColumnFilter",
        flex: 1,
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
      },
      {
        field: "ParentCustomer",
        headerName: "Parent Customer",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        flex: 1,
      },
      {
        field: "PricingPolicy",
        headerName: "Pricing Policy",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        flex: 1,
      },
      {
        field: "Importance",
        headerName: "Importance",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
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

  const customerRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/customers",
        resolveRowId: (row) =>
          normalizeCustomerId((row as { CustomerID?: unknown } | null)?.CustomerID ?? null),
        resolveRowLabel: (row, fallback) =>
          resolveCustomerLabel(row as Record<string, unknown> | null | undefined, fallback),
        resolveRowTypeLabel: () => "customer",
        buildPayload: (ids) => ({ CustomerIDs: ids }),
        confirmTitle: ({ isSingle }) =>
          (isSingle ? "Delete customer" : "Delete customers"),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? "Delete customer" : "Delete customers"),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? "Keep customer" : "Keep customers"),
        successToastMessage: "Customer deleted",
        failureToastMessage: "Unable to delete customer. Please try again.",
      }),
    [],
  );

  const customerContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) =>
      customerRowDeletion.getContextMenuItems(params),
    [customerRowDeletion],
  );

  return (
    <main className={styles.page}>
      <PageHeader
        title="Customers"
        rightActions={
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
                router.push("/customers/create");
              }}
            >
              Add Customer
            </button>
          </div>
        }
      >
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/customers"
              columnDefs={columnDefs}
              rowGroupPanelShow="always"
              columnStateNamespace="customers"
              onGridReady={handleGridReady}
              getContextMenuItems={customerContextMenuItems}
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
