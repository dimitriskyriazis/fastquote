"use client";

import React, { useMemo, useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
  ICellRendererParams,
  ValueFormatterParams,
} from "ag-grid-community";
import { createPortal } from "react-dom";
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from "../components/actionMenuMarkers";
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from "../components/useActionMenuCoordinator";
import { useActionMenuPosition } from "../components/useActionMenuPosition";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import styles from "./PriceListsClient.module.css";
import { GridRowDeletion } from "../../lib/gridRowDeletion";
import { checkDeletePermissionForClient } from "../../lib/deletePermissions";
import { useAuditUser } from "../components/AuditUserProvider";
import { formatDateUK } from "../lib/formatDateTime";
import { formatBooleanValue } from "../lib/formatBooleanValue";
import { normalizeBoolean } from "../../lib/normalizeBoolean";
import { showToastMessage } from "../../lib/toast";
import { useUndoStack } from "../hooks/useUndoStack";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});

const normalizePriceListIdValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeStringValue = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
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

const PRICE_LIST_FIELD_LABELS: Record<string, string> = {
  Enabled: "Enabled",
};

export default function PriceListsClient() {
  const router = useRouter();
  const { roles, users } = useAuditUser();
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  const defaultEnabledFilterAppliedRef = useRef(false);
  const enabledOptions = useMemo(() => ["Yes", "No"], []);
  const responsibleUserNameById = useMemo(() => {
    const map = new Map<string, string>();
    users.forEach((user) => {
      const normalizedName = user.label.trim();
      if (!normalizedName) return;
      map.set(user.id, normalizedName);
    });
    return map;
  }, [users]);

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
      const closeMenu = useCallback(() => setOpen(false), []);
      const instanceId = useActionMenuCloseListener(closeMenu);
      const { buttonRef, menuRef, menuPos } = useActionMenuPosition(open);
      const priceListId = params?.data?.PriceListID as string | number | undefined;
      const encodedId = priceListId != null ? encodeURIComponent(String(priceListId)) : "";

      const preventRangeSelection = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
      };

      const openInNewWindow = (suffix: "products" | "basicdata") => {
        if (!encodedId) return;
        const url = `/price-lists/${encodedId}/${suffix}`;
        setOpen(false);
        if (typeof window !== "undefined") {
          window.open(url, "_blank", "noopener,noreferrer");
          return;
        }
        router.push(url);
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
            title={encodedId ? "Open menu" : "Missing Price List ID"}
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
                <button
                  type="button"
                  role="menuitem"
                  className={styles.actionMenuItem}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openInNewWindow("basicdata");
                  }}
                >
                  View Basic Data
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.actionMenuItem}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    openInNewWindow("products");
                  }}
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
        confirmTitle: ({ isSingle }) =>
          (isSingle ? 'Delete price list' : 'Delete price lists'),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? 'Delete price list' : 'Delete price lists'),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? 'Keep price list' : 'Keep price lists'),
        successToastMessage: 'Price list deleted',
        failureToastMessage: 'Unable to delete price list. Please try again.',
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'pricelists', 'managePriceLists'),
      }),
    [roles],
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
        width: 48,
        cellClass: styles.actionCellContainer,
        cellRenderer: ActionCell,
      },
      { field: "Name", headerName: "Price List", filter: "agTextColumnFilter" },
      { field: "BrandName", headerName: "Brand", filter: "agTextColumnFilter" },
      { field: "SupplierName", headerName: "Supplier", filter: "agTextColumnFilter", enableRowGroup: true },
      {
        field: "ResponsibleUserName",
        headerName: "Responsible User",
        filter: "agTextColumnFilter",
        valueFormatter: (params) => {
          const explicitName = normalizeStringValue(params.value);
          if (explicitName) return explicitName;
          const row = params.data as { ResponsibleUserId?: unknown } | null | undefined;
          const id = normalizeStringValue(row?.ResponsibleUserId ?? null);
          return id ? (responsibleUserNameById.get(id) ?? "") : "";
        },
      },
      {
        field: "ValidFromDate",
        headerName: "Valid From",
        filter: "agDateColumnFilter",
        valueFormatter: (params: ValueFormatterParams) => formatDateUK(params.value),
        filterParams: { 
          browserDatePicker: false, 
          minValidYear: 2000,
        },
      },
      {
        field: "ValidToDate",
        headerName: "Valid To",
        filter: "agDateColumnFilter",
        valueFormatter: (params: ValueFormatterParams) => formatDateUK(params.value),
        filterParams: { 
          browserDatePicker: false, 
          minValidYear: 2000,
        },
      },
      {
        field: "ValidityComment",
        headerName: "Validity Comment",
        filter: "agTextColumnFilter"
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
        width: 110,
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
    [ActionCell, enabledOptions, responsibleUserNameById]
  );

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !(field in PRICE_LIST_FIELD_LABELS)) return;
    if (event.newValue === event.oldValue) return;
    const priceListId = normalizePriceListIdValue(
      (event.data as { PriceListID?: unknown } | null | undefined)?.PriceListID ?? null,
    );
    if (priceListId == null) return;
    const label = PRICE_LIST_FIELD_LABELS[field] ?? field;
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
    const value = field === "Enabled"
      ? normalizeBoolean(
          (event.data as { Enabled?: unknown } | undefined)?.Enabled ?? event.newValue,
        )
      : null;
    const updateField = field;

    const submit = async () => {
      try {
        const res = await fetch(`/api/price-lists/${priceListId}/basicdata`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ updates: [{ field: updateField, value }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label}`);
        }
        const undoLabel = `${label} updated`;
        pushUndo({
          label: undoLabel,
          undo: async () => {
            const undoRes = await fetch(`/api/price-lists/${priceListId}/basicdata`, {
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
  }, [pushUndo, performUndo]);

  return (
    <main className={styles.page}>
      <PageHeader
        title="Price Lists"
        rightActions={
          <div style={{ display: "flex", gap: "0.75rem" }}>
            {canUndo && (
              <button
                type="button"
                className="page-header-button"
                onClick={performUndo}
              >
                ↩ Undo{lastLabel ? `: ${lastLabel}` : ""}
              </button>
            )}
            <button
              type="button"
              className={`${styles.importButton} page-header-button`}
              onClick={handleImportClick}
            >
              Import Price List
            </button>
          </div>
        }
      >
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/price-lists"
              columnDefs={columnDefs}
              getContextMenuItems={priceListsContextMenuItems}
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              autoSizeExclusions={["ValidFromDate", "ValidToDate"]}
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
