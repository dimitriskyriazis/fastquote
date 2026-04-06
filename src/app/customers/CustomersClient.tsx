"use client";

import React, { useMemo, useCallback, useRef, useState, useEffect } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GridApi,
  GetContextMenuItemsParams,
  ICellRendererParams,
  MenuItemDef,
} from "ag-grid-community";
import { createPortal } from "react-dom";
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from "../components/actionMenuMarkers";
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from "../components/useActionMenuCoordinator";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import Link from "next/link";
import styles from "./CustomersClient.module.css";
import { useActionMenuPosition } from "../components/useActionMenuPosition";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import { showToastMessage } from "../../lib/toast";
import { useUndoStack } from "../hooks/useUndoStack";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading customers…
    </div>
  ),
});


const normalizeCustomerId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const createOfferMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--copy" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14 3H7a2 2 0 0 0-2 2v12" />
      <path d="M17 7h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2v-2" />
      <path d="M12 11v6" />
      <path d="M9 14h6" />
    </svg>
  </span>
`;

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

const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  TaxID: "Tax ID",
  Enabled: "Enabled",
};

export default function CustomersClient() {
  const router = useRouter();
  const { roles, userId } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);

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
        width:48,
        cellClass: styles.actionCellContainer,
        cellRenderer: ActionCell,
      },
      {
        field: "CustomerID",
        headerName: "ID",
        filter: "agNumberColumnFilter",
        editable: false,
        width: 100,
        hide: true,
      },
      {
        field: "CustomerName",
        headerName: "Customer",
        filter: "agTextColumnFilter",
      },
      {
        field: "BrandName",
        headerName: "Brand",
        filter: "agTextColumnFilter",
      },
      {
        field: "TaxID",
        headerName: "Tax ID",
        filter: "agTextColumnFilter",
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
        },
      },
      {
        field: "ParentCustomer",
        headerName: "Parent Customer",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
      },
      {
        field: "PricingPolicy",
        headerName: "Pricing Policy",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
      },
      {
        field: "Importance",
        headerName: "Importance",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
      },
      {
        field: "Country",
        headerName: "Country",
        filter: "agTextColumnFilter",
      },
      {
        field: "City",
        headerName: "City",
        filter: "agTextColumnFilter",
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
        editable: true,
        cellEditor: "agSelectCellEditor",
        cellEditorParams: { values: enabledOptions },
        valueSetter: (params) => {
          params.data = params.data ?? {};
          (params.data as Record<string, unknown>).Enabled = normalizeBoolean(params.newValue);
          return true;
        },
      },
    ],
    [ActionCell, enabledOptions],
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in CUSTOMER_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const customerId = normalizeCustomerId(
      (event.data as { CustomerID?: unknown } | undefined)?.CustomerID ?? null,
    );
    if (customerId == null) return;
    const label = CUSTOMER_FIELD_LABELS[field] ?? field;
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
    const value =
      field === "Enabled"
        ? normalizeBoolean(
            (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
          )
        : event.newValue;

    const submit = async () => {
      try {
        const res = await fetch(`/api/customers/${customerId}/basicdata`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ field, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        const undoLabel = `${label} updated`;
        pushUndo({
          label: undoLabel,
          undo: async () => {
            const undoRes = await fetch(`/api/customers/${customerId}/basicdata`, {
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
  }, [performUndo, pushUndo]);

  const customerRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: "/api/customers",
        dataEndpoint: "/api/customers",
        idField: "CustomerID",
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
        failureToastMessage: "Cannot delete customer: an offer already exists for this customer.",
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'manageCustomersContacts'),
      }),
    [roles],
  );

  const customerContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const baseItems = customerRowDeletion.getContextMenuItems(params);
      const items = Array.isArray(baseItems) ? [...baseItems] : [];
      const clickedCustomerId = normalizeCustomerId(
        (params.node?.data as { CustomerID?: unknown } | null | undefined)?.CustomerID ?? null,
      );
      if (!clickedCustomerId) {
        return items;
      }

      const selectedNodes = typeof params.api?.getSelectedNodes === "function"
        ? params.api.getSelectedNodes()
        : [];
      if (selectedNodes.length > 1) {
        return items;
      }

      const createOfferItem: MenuItemDef<Record<string, unknown>> = {
        name: "Create an offer for this customer",
        icon: createOfferMenuIcon,
        action: () => {
          try {
            const user = userId?.trim() || 'anon';
            localStorage.removeItem(`fastquote.draft:offer-create:${user}`);
          } catch { /* ignore */ }
          router.push(`/offers/create?customerId=${encodeURIComponent(String(clickedCustomerId))}`);
        },
      };

      if (items.length > 0) {
        items.splice(Math.max(0, items.length - 1), 0, createOfferItem);
      } else {
        items.push(createOfferItem);
      }

      return items;
    },
    [customerRowDeletion, router, userId],
  );

  return (
    <main className={styles.page}>
      <PageHeader
        title="Customers"
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
            onClick={() => {
              router.push("/customers/create");
            }}
          >
            Add Customer
          </button>
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
              onCellValueChanged={handleCellEdit}
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
