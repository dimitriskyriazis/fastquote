"use client";

import React, { useMemo, useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GridApi,
  GetContextMenuItemsParams,
  MenuItemDef,
} from "ag-grid-community";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import styles from "./CustomersClient.module.css";
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

  const columnDefs = useMemo<ColDef[]>(
    () => [
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
        headerName: "Customer Name",
        filter: "agTextColumnFilter",
        minWidth: 300,
      },
      {
        field: "BrandName",
        headerName: "Official Name",
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
        field: "CustomerGroup",
        headerName: "Customer Group",
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
    [enabledOptions],
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
      const isMultiSelection = selectedNodes.length > 1;

      const encodedCustomerId = encodeURIComponent(String(clickedCustomerId));
      const basicDataHref = `/customers/${encodedCustomerId}/basicdata`;
      const contactsHref = `/customers/${encodedCustomerId}/contacts`;
      const basicDataIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';
      const contactsIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg></span>';
      const newTabIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg></span>';
      const viewBasicDataItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View Basic Data',
        icon: basicDataIcon,
        action: () => { router.push(basicDataHref); },
        subMenu: [
          { name: 'Open', icon: basicDataIcon, action: () => { router.push(basicDataHref); } },
          { name: 'Open in new tab', icon: newTabIcon, action: () => { window.open(basicDataHref, '_blank', 'noopener,noreferrer'); } },
        ],
      };
      const viewContactsItem: MenuItemDef<Record<string, unknown>> = {
        name: 'View Contacts',
        icon: contactsIcon,
        action: () => { router.push(contactsHref); },
        subMenu: [
          { name: 'Open', icon: contactsIcon, action: () => { router.push(contactsHref); } },
          { name: 'Open in new tab', icon: newTabIcon, action: () => { window.open(contactsHref, '_blank', 'noopener,noreferrer'); } },
        ],
      };
      items.unshift(viewBasicDataItem, viewContactsItem, 'separator');

      if (isMultiSelection) {
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
