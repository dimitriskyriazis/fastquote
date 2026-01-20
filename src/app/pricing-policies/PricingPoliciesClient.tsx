"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ColDef, GridApi, ValueFormatterParams, ValueGetterParams } from "ag-grid-community";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import type { GridResponse } from "../components/AgGridAll";
import styles from "./PricingPoliciesClient.module.css";

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

type PolicyCell = { minTelmaco: number | null; minCustomer: number | null };

type MatrixRow = {
  BrandID: number | null;
  BrandName: string | null;
  policies?: Record<string, PolicyCell | undefined> | null;
  totalMinTelmaco?: number | null;
  totalMinCustomer?: number | null;
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

  const columnDefs = useMemo<ColDef[]>(() => {
    const policyGroups: ColDef[] = pricingPolicies.map((policy) => {
      const policyId = String(policy.id);
      return {
        headerName: policy.name,
        marryChildren: true,
        children: [
          {
            headerName: "Telmaco Discount Min",
            colId: `pp_${policyId}_telmaco`,
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueGetter: (params: ValueGetterParams) => {
              const row = params.data as MatrixRow | null | undefined;
              return row?.policies?.[policyId]?.minTelmaco ?? null;
            },
            valueFormatter: discountFormatter,
            width: 140,
          },
          {
            headerName: "Customer Discount Min",
            colId: `pp_${policyId}_customer`,
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueGetter: (params: ValueGetterParams) => {
              const row = params.data as MatrixRow | null | undefined;
              return row?.policies?.[policyId]?.minCustomer ?? null;
            },
            valueFormatter: discountFormatter,
            width: 160,
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
        width: 220,
      },
      ...policyGroups,
      {
        headerName: "Totals",
        marryChildren: true,
        children: [
          {
            field: "totalMinTelmaco",
            headerName: "Total Min of Telmaco Discount",
            pinned: "right",
            lockPinned: true,
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueFormatter: discountFormatter,
            width: 200,
          },
          {
            field: "totalMinCustomer",
            headerName: "Total Min of Customer Discount",
            pinned: "right",
            lockPinned: true,
            sortable: false,
            filter: false,
            floatingFilter: false,
            type: "numericColumn",
            valueFormatter: discountFormatter,
            width: 220,
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

