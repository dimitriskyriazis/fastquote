"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type {
  CellValueChangedEvent,
  ColDef,
  GridApi,
  ValueFormatterParams,
  ValueGetterParams,
  ValueSetterParams,
} from "ag-grid-community";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import type { GridResponse } from "../components/AgGridAll";
import styles from "./PricingPoliciesClient.module.css";
import { showToastMessage } from "../../lib/toast";

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
};

type PolicyCell = { telmacoDiscount: number | null; customerDiscount: number | null };

type MatrixRow = {
  BrandID: number | null;
  BrandName: string | null;
  policies?: Record<string, PolicyCell | undefined> | null;
  totalTelmacoDiscount?: number | null;
  totalCustomerDiscount?: number | null;
};

const numberFormatter = new Intl.NumberFormat("en-US", {
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
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(",", ".");
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value == null) return null;
  const coerced = String(value).trim();
  if (!coerced) return null;
  const parsed = Number(coerced.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

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

export default function PricingPoliciesClient({ pricingPolicies }: Props) {
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const pendingGrandTotalRef = useRef<Record<string, unknown> | null>(null);
  const [refreshToken] = useState(0);

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
    },
    [applyGrandTotalRow],
  );

  const handleResponse = useCallback((response: GridResponse | null) => {
    const raw = response as (GridResponse & { grandTotal?: Record<string, unknown> | null }) | null;
    pendingGrandTotalRef.current = raw?.grandTotal ?? null;
    applyGrandTotalRow();
  }, [applyGrandTotalRow]);

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

  const columnDefs = useMemo<ColDef[]>(() => {
    const policyGroups: ColDef[] = pricingPolicies.map((policy) => {
      const policyId = String(policy.id);
      return {
        headerName: normalizePricingPolicyName(policy.name),
        marryChildren: true,
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
      {
        headerName: "Totals",
        marryChildren: true,
        children: [
          {
            field: "totalTelmacoDiscount",
            headerName: "Total Telmaco Discount",
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueFormatter: discountFormatter,
            width: 180,
          },
          {
            field: "totalCustomerDiscount",
            headerName: "Total Customer Discount",
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueFormatter: discountFormatter,
            width: 180,
          },
        ],
      },
    ];
  }, [pricingPolicies]);

  return (
    <main className={styles.page}>
      <PageHeader title="Pricing Policies">
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/pricing-policies/matrix"
              columnDefs={columnDefs}
              columnStateNamespace="pricing-policies-matrix"
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellEdit}
              onResponse={handleResponse}
              disableAutoSize
              refreshToken={refreshToken}
              floatingFilter={true}
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}

