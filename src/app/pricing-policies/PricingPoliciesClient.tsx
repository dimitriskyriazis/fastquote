"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
  MenuItemDef,
  ValueFormatterParams,
  ValueGetterParams,
  ValueSetterParams,
} from "ag-grid-community";
import { createPortal } from "react-dom";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import type { GridResponse } from "../components/AgGridAll";
import styles from "./PricingPoliciesClient.module.css";
import { showConfirmDialog } from "../../lib/confirm";
import { showToastMessage } from "../../lib/toast";
import { getUserNumberLocale, parseLocaleNumber } from "../../lib/localeNumber";
import LookupModal from "../components/LookupModal";
import lookupStyles from "../components/LookupModal.module.css";
import type { DropdownOption } from "../../lib/dropdownOptions";
import { dispatchActionMenuCloseEvent, useActionMenuCloseListener } from "../components/useActionMenuCoordinator";
import { useActionMenuPosition } from "../components/useActionMenuPosition";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading pricing policies…</div>,
});

export type PricingPolicyColumn = {
  id: number;
  name: string;
};

type Props = {
  pricingPolicies: PricingPolicyColumn[];
  calcMethodFormulas: DropdownOption[];
};

type PolicyCell = { telmacoDiscount: number | null; customerDiscount: number | null };

type MatrixRow = {
  BrandID: number | null;
  BrandName: string | null;
  policies?: Record<string, PolicyCell | undefined> | null;
};

const numberFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const discountFormatter = (params: ValueFormatterParams) => {
  const raw = params.value;
  const num = typeof raw === "number" ? raw : Number(raw ?? Number.NaN);
  if (!Number.isFinite(num)) return "";
  return numberFormatter.format(num);
};

const parseDiscountInput = (value: unknown): number | null => {
  return parseLocaleNumber(value);
};

const deleteMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--danger" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 7L18.2 19.2C18.1 20.8 16.8 22 15.2 22H8.8C7.2 22 5.9 20.8 5.8 19.2L5 7" />
      <path d="M10 11V17" />
      <path d="M14 11V17" />
      <path d="M4 7H20" />
      <path d="M9 7V4.8C9 3.8 9.8 3 10.8 3H13.2C14.2 3 15 3.8 15 4.8V7" />
    </svg>
  </span>
`;

type PricingPolicyGroupHeaderParams = {
  displayName?: string;
  disabled?: boolean;
  pricingPolicyId?: number;
  onDelete?: (pricingPolicyId: number) => void;
};

function PricingPolicyGroupHeader({
  displayName,
  disabled = false,
  pricingPolicyId,
  onDelete,
}: PricingPolicyGroupHeaderParams) {
  const [open, setOpen] = useState(false);
  const closeMenu = useCallback(() => setOpen(false), []);
  const instanceId = useActionMenuCloseListener(closeMenu);
  const { buttonRef, menuRef, menuPos } = useActionMenuPosition(open);

  const preventRangeSelection = (event: React.SyntheticEvent) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const canDelete =
    !disabled && typeof pricingPolicyId === "number" && Number.isFinite(pricingPolicyId) && typeof onDelete === "function";

  return (
    <div className={styles.policyGroupHeader}>
      <span className={styles.policyGroupTitle} title={displayName}>
        {displayName}
      </span>

      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        className={styles.policyGroupMenuButton}
        disabled={disabled}
        title="Actions"
        ref={buttonRef}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!open) {
            dispatchActionMenuCloseEvent(instanceId);
          }
          setOpen((v) => !v);
        }}
        onMouseDownCapture={preventRangeSelection}
        onPointerDownCapture={preventRangeSelection}
        onContextMenuCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        ⋮
      </button>

      {open && menuPos
        ? createPortal(
            <div
              role="menu"
              className={styles.policyGroupMenu}
              style={{ top: menuPos.top, left: menuPos.left }}
              ref={menuRef}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <button
                type="button"
                role="menuitem"
                className={styles.policyGroupMenuItem}
                disabled={!canDelete}
                onClick={() => {
                  setOpen(false);
                  if (canDelete) onDelete(pricingPolicyId);
                }}
              >
                <span
                  className={styles.policyGroupMenuIcon}
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: deleteMenuIcon }}
                />
                <span>Delete pricing policy</span>
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const getOrCreatePolicyCell = (row: MatrixRow, policyId: string): PolicyCell => {
  row.policies = row.policies && typeof row.policies === "object" ? row.policies : {};
  const existing = row.policies[policyId];
  if (existing && typeof existing === "object") return existing;
  const next: PolicyCell = { telmacoDiscount: null, customerDiscount: null };
  row.policies[policyId] = next;
  return next;
};

const normalizePricingPolicyName = (name: string): string => {
  const trimmed = name.trim();
  if (!trimmed) return name;
  const withoutPrefix = trimmed.replace(/^min\s+of\s+/i, "").replace(/^min\s+/i, "").trim();
  return withoutPrefix || trimmed;
};

const isDefaultPricingPolicyName = (name: string): boolean => {
  const normalized = normalizePricingPolicyName(name);
  return /\bdefault\b/i.test(normalized);
};

export default function PricingPoliciesClient({ pricingPolicies, calcMethodFormulas }: Props) {
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const pendingGrandTotalRef = useRef<Record<string, unknown> | null>(null);

  const [localPricingPolicies, setLocalPricingPolicies] = useState(pricingPolicies);
  useEffect(() => {
    setLocalPricingPolicies(pricingPolicies);
  }, [pricingPolicies]);

  const [isAddPricingPolicyOpen, setIsAddPricingPolicyOpen] = useState(false);
  const [newPricingPolicyName, setNewPricingPolicyName] = useState("");
  const [newPricingPolicyCalcMethodId, setNewPricingPolicyCalcMethodId] = useState("");
  const [newPricingPolicyEnabled, setNewPricingPolicyEnabled] = useState(true);
  const [pricingPolicySaving, setPricingPolicySaving] = useState(false);
  const [pricingPolicyError, setPricingPolicyError] = useState<string | null>(null);
  const [pricingPolicyDeleting, setPricingPolicyDeleting] = useState(false);
  const [brandDeleting, setBrandDeleting] = useState(false);

  const orderedPricingPolicies = useMemo(() => {
    const defaults = localPricingPolicies.filter((policy) => isDefaultPricingPolicyName(policy.name));
    const rest = localPricingPolicies.filter((policy) => !isDefaultPricingPolicyName(policy.name));
    return [...defaults, ...rest];
  }, [localPricingPolicies]);

  const defaultPolicyId = useMemo(() => {
    const firstDefault = orderedPricingPolicies.find((policy) => isDefaultPricingPolicyName(policy.name));
    return firstDefault?.id ?? null;
  }, [orderedPricingPolicies]);

  const openAddPricingPolicyModal = useCallback(
    (calcMethodFormulas: DropdownOption[]) => {
      setNewPricingPolicyName("");
      setPricingPolicyError(null);
      setNewPricingPolicyEnabled(true);
      setNewPricingPolicyCalcMethodId(calcMethodFormulas[0]?.value ?? "");
      setIsAddPricingPolicyOpen(true);
    },
    [],
  );

  const enforceDefaultPolicyFirst = useCallback((api: GridApi<Record<string, unknown>> | null) => {
    if (!api) return;
    if (defaultPolicyId == null) return;
    const telmacoColId = `pp_${String(defaultPolicyId)}_telmaco`;
    const customerColId = `pp_${String(defaultPolicyId)}_customer`;
    try {
      const displayed = typeof api.getAllDisplayedColumns === "function" ? api.getAllDisplayedColumns() : [];
      const displayedIds = new Set(
        displayed
          .map((col) => (typeof col.getColId === "function" ? col.getColId() : ""))
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      );
      const idsToMove = [telmacoColId, customerColId].filter((id) => displayedIds.has(id));
      if (idsToMove.length === 0) return;
      if (typeof api.moveColumns === "function") {
        api.moveColumns(idsToMove, 0);
      }
    } catch (err) {
      console.warn("Failed to enforce default policy ordering", err);
    }
  }, [defaultPolicyId]);

  const applyGrandTotalRow = useCallback(() => {
    const api = gridApiRef.current;
    if (!api) return;
    const grandTotal = pendingGrandTotalRef.current;
    try {
      api.setGridOption("pinnedBottomRowData", grandTotal ? [grandTotal] : []);
    } catch (err) {
      console.warn("Failed to apply grand total row", err);
    }
  }, []);

  const handleGridReady = useCallback(
    (api: GridApi<Record<string, unknown>>) => {
      gridApiRef.current = api;
      applyGrandTotalRow();
      enforceDefaultPolicyFirst(api);
    },
    [applyGrandTotalRow, enforceDefaultPolicyFirst],
  );

  const handleResponse = useCallback((response: GridResponse | null) => {
    const raw = response as (GridResponse & { grandTotal?: Record<string, unknown> | null }) | null;
    pendingGrandTotalRef.current = raw?.grandTotal ?? null;
    applyGrandTotalRow();
    enforceDefaultPolicyFirst(gridApiRef.current);
  }, [applyGrandTotalRow, enforceDefaultPolicyFirst]);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const colId = event.column?.getColId?.() ?? event.colDef?.colId ?? "";
    const match = /^pp_(\d+)_(telmaco|customer)$/.exec(colId);
    if (!match) return;

    if (event.node?.rowPinned) return;

    const policyId = Number(match[1] ?? Number.NaN);
    if (!Number.isFinite(policyId)) return;
    const field = match[2] === "customer" ? "customer" : "telmaco";

    const row = event.data as MatrixRow | null | undefined;
    const brandId = row?.BrandID ?? null;
    if (brandId == null || !Number.isFinite(brandId)) return;

    const nextValue = parseDiscountInput(event.newValue);
    const previousValue = parseDiscountInput(event.oldValue);
    if (nextValue == null) {
      showToastMessage("Discount is required", "error");
      event.api.refreshServerSide?.({ purge: false });
      return;
    }
    if (previousValue != null && nextValue === previousValue) return;

    const submit = async () => {
      try {
        const response = await fetch("/api/pricing-policies/matrix", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brandId,
            pricingPolicyId: policyId,
            field,
            value: nextValue,
          }),
        });
        const payload = (await response.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to update discounts");
        }
        showToastMessage("Discount updated", "success");
        event.api.refreshServerSide?.({ purge: false });
      } catch (err) {
        console.error("Failed to update discount", err);
        showToastMessage("Unable to update discount. Please try again.", "error");
        event.api.refreshServerSide?.({ purge: false });
      }
    };

    void submit();
  }, []);

  const deletePricingPolicy = useCallback(
    async (pricingPolicyId: number) => {
      if (!Number.isFinite(pricingPolicyId) || pricingPolicyId <= 0) return;
      if (pricingPolicyDeleting || pricingPolicySaving) return;

      const policyName =
        localPricingPolicies.find((policy) => policy.id === pricingPolicyId)?.name ?? `#${pricingPolicyId}`;

      const confirmed = await showConfirmDialog({
        title: "Delete pricing policy",
        message: `Delete pricing policy "${policyName}"? This will also delete all pricing policy rules. This action cannot be undone.`,
        confirmLabel: "Delete pricing policy",
        cancelLabel: "Keep pricing policy",
        tone: "danger",
      });
      if (!confirmed) return;

      setPricingPolicyDeleting(true);
      try {
        const response = await fetch("/api/pricing-policies", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pricingPolicyId }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; deletedPolicies?: number; deletedRules?: number }
          | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to delete pricing policy");
        }

        setLocalPricingPolicies((prev) => prev.filter((policy) => policy.id !== pricingPolicyId));
        showToastMessage("Pricing policy deleted", "success");

        try {
          gridApiRef.current?.refreshServerSide?.({ purge: true });
        } catch {
          /* noop */
        }
      } catch (err) {
        console.error("Failed to delete pricing policy", err);
        showToastMessage(err instanceof Error ? err.message : "Unable to delete pricing policy.", "error");
      } finally {
        setPricingPolicyDeleting(false);
      }
    },
    [localPricingPolicies, pricingPolicyDeleting, pricingPolicySaving],
  );

  const deleteBrand = useCallback(
    async (brandId: number, brandName: string | null) => {
      if (!Number.isFinite(brandId) || brandId <= 0) return;
      if (brandDeleting || pricingPolicyDeleting || pricingPolicySaving) return;

      const label = brandName?.trim() || `Brand #${brandId}`;
      const confirmed = await showConfirmDialog({
        title: "Delete brand",
        message: `Remove "${label}" from pricing policies? All pricing policy rules for this brand will be deleted. This action cannot be undone.`,
        confirmLabel: "Delete brand",
        cancelLabel: "Keep brand",
        tone: "danger",
      });
      if (!confirmed) return;

      setBrandDeleting(true);
      try {
        const response = await fetch("/api/pricing-policies/matrix", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandId }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; deletedCount?: number }
          | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? "Unable to delete brand from pricing policies");
        }
        showToastMessage("Brand removed from pricing policies", "success");
        try {
          gridApiRef.current?.refreshServerSide?.({ purge: true });
        } catch {
          /* noop */
        }
      } catch (err) {
        console.error("Failed to delete brand from pricing policies", err);
        showToastMessage(
          err instanceof Error ? err.message : "Unable to delete brand from pricing policies.",
          "error",
        );
      } finally {
        setBrandDeleting(false);
      }
    },
    [brandDeleting, pricingPolicyDeleting, pricingPolicySaving],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>): Array<MenuItemDef<Record<string, unknown>> | string> => {
      const defaultItems = Array.isArray(params.defaultItems) ? params.defaultItems : [];
      const colId = params.column?.getColId?.() ?? "";
      if (colId !== "BrandName") return defaultItems;

      const row = params.node?.data as MatrixRow | null | undefined;
      if (!row || row.BrandID == null || !Number.isFinite(row.BrandID) || params.node?.rowPinned) {
        return defaultItems;
      }

      const deleteBrandItem: MenuItemDef<Record<string, unknown>> = {
        name: "Delete brand",
        icon: deleteMenuIcon,
        disabled: brandDeleting || pricingPolicyDeleting || pricingPolicySaving,
        action: () => {
          void deleteBrand(row.BrandID as number, row.BrandName ?? null);
        },
      };

      return [...defaultItems, "separator", deleteBrandItem];
    },
    [brandDeleting, deleteBrand, pricingPolicyDeleting, pricingPolicySaving],
  );

  const handleCreatePricingPolicy = useCallback(
    async (calcMethodFormulas: DropdownOption[]) => {
      const trimmed = newPricingPolicyName.trim();
      if (!trimmed) {
        setPricingPolicyError("Name is required");
        return;
      }
      if (!newPricingPolicyCalcMethodId) {
        setPricingPolicyError("Calc method formula is required");
        return;
      }
      setPricingPolicySaving(true);
      setPricingPolicyError(null);
      try {
        const response = await fetch("/api/pricing-policies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: trimmed,
            enabled: newPricingPolicyEnabled,
            calcMethodFormulasId: newPricingPolicyCalcMethodId,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; option?: DropdownOption; error?: string }
          | null;
        const option = payload?.option;
        if (!response.ok || !payload?.ok || !option?.value) {
          throw new Error(payload?.error ?? "Unable to add pricing policy");
        }
        const id = Number(option.value);
        if (!Number.isFinite(id)) {
          throw new Error("Server returned an invalid pricing policy ID");
        }

        setLocalPricingPolicies((prev) => {
          if (prev.some((policy) => policy.id === id)) return prev;
          return [...prev, { id, name: option.label }];
        });
        showToastMessage("Pricing policy added", "success");
        setIsAddPricingPolicyOpen(false);

        // Refresh rows so any downstream totals update.
        gridApiRef.current?.refreshServerSide?.({ purge: true });
      } catch (err) {
        console.error("Failed to create pricing policy", err);
        const message = err instanceof Error ? err.message : "Unable to add pricing policy";
        setPricingPolicyError(message);
        showToastMessage(message, "error");
      } finally {
        setPricingPolicySaving(false);
        // Ensure current selection stays valid if formulas list changes.
        setNewPricingPolicyCalcMethodId((prev) =>
          calcMethodFormulas.some((option) => option.value === prev)
            ? prev
            : calcMethodFormulas[0]?.value ?? "",
        );
      }
    },
    [newPricingPolicyCalcMethodId, newPricingPolicyEnabled, newPricingPolicyName],
  );

  useEffect(() => {
    setNewPricingPolicyCalcMethodId((prev) =>
      calcMethodFormulas.some((option) => option.value === prev)
        ? prev
        : calcMethodFormulas[0]?.value ?? "",
    );
  }, [calcMethodFormulas]);

  const columnDefs = useMemo<ColDef[]>(() => {
    const policyGroups: ColDef[] = orderedPricingPolicies.map((policy) => {
      const policyId = String(policy.id);
      return {
        headerName: normalizePricingPolicyName(policy.name),
        marryChildren: true,
        headerGroupComponent: PricingPolicyGroupHeader,
        headerGroupComponentParams: {
          disabled: pricingPolicyDeleting || pricingPolicySaving,
          pricingPolicyId: policy.id,
          onDelete: (id: number) => {
            void deletePricingPolicy(id);
          },
        },
        children: [
          {
            headerName: "Telmaco Discount",
            colId: `pp_${policyId}_telmaco`,
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueGetter: (params: ValueGetterParams) => {
              const row = params.data as MatrixRow | null | undefined;
              return row?.policies?.[policyId]?.telmacoDiscount ?? null;
            },
            valueFormatter: discountFormatter,
            editable: (params: { node?: { rowPinned?: string | null }; data?: unknown }) => {
              if (params.node?.rowPinned) return false;
              const row = params.data as MatrixRow | null | undefined;
              if (row?.BrandID == null) return false;
              return Boolean(row?.policies?.[policyId]);
            },
            cellEditor: "agTextCellEditor",
            valueSetter: (params: ValueSetterParams<Record<string, unknown>, unknown>) => {
              const row = params.data as MatrixRow | null | undefined;
              if (!row) return false;
              const parsed = parseDiscountInput(params.newValue);
              if (parsed == null) return false;
              const cell = getOrCreatePolicyCell(row, policyId);
              cell.telmacoDiscount = parsed;
              return true;
            },
            width: 150,
          },
          {
            headerName: "Customer Discount",
            colId: `pp_${policyId}_customer`,
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueGetter: (params: ValueGetterParams) => {
              const row = params.data as MatrixRow | null | undefined;
              return row?.policies?.[policyId]?.customerDiscount ?? null;
            },
            valueFormatter: discountFormatter,
            editable: (params: { node?: { rowPinned?: string | null }; data?: unknown }) => {
              if (params.node?.rowPinned) return false;
              const row = params.data as MatrixRow | null | undefined;
              if (row?.BrandID == null) return false;
              return Boolean(row?.policies?.[policyId]);
            },
            cellEditor: "agTextCellEditor",
            valueSetter: (params: ValueSetterParams<Record<string, unknown>, unknown>) => {
              const row = params.data as MatrixRow | null | undefined;
              if (!row) return false;
              const parsed = parseDiscountInput(params.newValue);
              if (parsed == null) return false;
              const cell = getOrCreatePolicyCell(row, policyId);
              cell.customerDiscount = parsed;
              return true;
            },
            width: 150,
          },
        ],
      };
    });

    return [
      {
        field: "BrandName",
        headerName: "Brand",
        pinned: "left",
        lockPinned: true,
        lockPosition: true,
        sortable: true,
        filter: "agTextColumnFilter",
        floatingFilter: true,
        width: 165,
      },
      ...policyGroups,
    ];
  }, [deletePricingPolicy, orderedPricingPolicies, pricingPolicyDeleting, pricingPolicySaving]);

  return (
    <main className={styles.page}>
      <PageHeader
        title="Pricing Policies"
        rightActions={
          <button
            type="button"
            className={`${styles.addButton} page-header-button`}
            onClick={() => openAddPricingPolicyModal(calcMethodFormulas)}
            disabled={pricingPolicySaving || calcMethodFormulas.length === 0}
            title={calcMethodFormulas.length === 0 ? "No calc method formulas available" : "Add pricing policy"}
          >
            Add Pricing Policy
          </button>
        }
      >
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/pricing-policies/matrix"
              columnDefs={columnDefs}
              columnStateNamespace="pricing-policies-matrix"
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              onResponse={handleResponse}
              getContextMenuItems={getContextMenuItems}
              disableAutoSize
              floatingFilter={true}
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
      <LookupModal
        open={isAddPricingPolicyOpen}
        title="Add Pricing Policy"
        onClose={() => setIsAddPricingPolicyOpen(false)}
        onConfirm={() => void handleCreatePricingPolicy(calcMethodFormulas)}
        confirmLabel="Create"
        saving={pricingPolicySaving}
        error={pricingPolicyError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="pricing-policy-name">
            Name
          </label>
          <input
            id="pricing-policy-name"
            className={lookupStyles.fieldControl}
            value={newPricingPolicyName}
            required
            onChange={(event) => setNewPricingPolicyName(event.target.value)}
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="pricing-policy-calc-method">
            Calc method formula
          </label>
          <select
            id="pricing-policy-calc-method"
            className={lookupStyles.fieldControl}
            value={newPricingPolicyCalcMethodId}
            required
            onChange={(event) => setNewPricingPolicyCalcMethodId(event.target.value)}
          >
            <option value="">Select calc method formula</option>
            {calcMethodFormulas.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.checkboxLabel} htmlFor="pricing-policy-enabled">
            <input
              id="pricing-policy-enabled"
              type="checkbox"
              checked={newPricingPolicyEnabled}
              onChange={(event) => setNewPricingPolicyEnabled(event.target.checked)}
            />
            Enabled
          </label>
        </div>
      </LookupModal>
    </main>
  );
}

