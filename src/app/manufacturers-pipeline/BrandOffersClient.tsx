"use client";

import React, { useMemo, useCallback, useState, useRef } from "react";
import dynamic from "next/dynamic";
import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import styles from "./BrandOffersClient.module.css";
import PageHeader from "../components/PageHeader";
import { GridQuickSearchProvider } from "../components/GridQuickSearchProvider";
import { getUserNumberLocale } from "../../lib/localeNumber";
import type { DropdownOption } from "../../lib/dropdownOptions";

const AgGridAll = dynamic(() => import("../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>Loading grid…</div>
  ),
});

const currencyFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatCurrency = (params: ValueFormatterParams) => {
  const value = params?.value;
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "";
  return `${currencyFormatter.format(num)} €`;
};

const formatDateDMY = (value: unknown): string => {
  if (!value) return "";
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

type Props = {
  brands: DropdownOption[];
};

const viewDetailsIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
      <circle cx="12" cy="12" r="3"/>
    </svg>
  </span>
`;

export default function BrandOffersClient({ brands }: Props) {
  const [selectedBrandId, setSelectedBrandId] = useState("");
  const [brandText, setBrandText] = useState("");
  const [showBrandList, setShowBrandList] = useState(false);
  const brandCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const filteredBrands = useMemo(() => {
    const q = brandText.trim().toLowerCase();
    if (!q) return brands;
    return brands.filter((b) => b.label.toLowerCase().includes(q));
  }, [brands, brandText]);

  const clearBrandCloseTimer = useCallback(() => {
    if (brandCloseTimerRef.current) {
      clearTimeout(brandCloseTimerRef.current);
      brandCloseTimerRef.current = null;
    }
  }, []);

  const handleBrandSelect = useCallback(
    (option: DropdownOption) => {
      setSelectedBrandId(option.value);
      setBrandText(option.label);
      setShowBrandList(false);
      setRefreshToken((prev) => prev + 1);
    },
    [],
  );

  const handleBrandInputChange = useCallback(
    (value: string) => {
      setBrandText(value);
      setShowBrandList(true);
      if (!value.trim()) {
        setSelectedBrandId("");
      }
    },
    [],
  );

  const handleBrandBlur = useCallback(() => {
    clearBrandCloseTimer();
    brandCloseTimerRef.current = setTimeout(() => {
      setShowBrandList(false);
      if (selectedBrandId) {
        const selected = brands.find((b) => b.value === selectedBrandId);
        if (selected) setBrandText(selected.label);
      } else {
        setBrandText("");
      }
    }, 150);
  }, [clearBrandCloseTimer, selectedBrandId, brands]);

  const ViewDetailsCell = useCallback(
    (params: ICellRendererParams) => {
      if (!params.data) return null;
      const data = params.data as Record<string, unknown>;
      const offerId = data.OfferID as number;
      if (!offerId) return null;
      return (
        <button
          type="button"
          className={styles.detailsButton}
          title="View Details"
          onClick={() => {
            const url = `/manufacturers-pipeline/${encodeURIComponent(String(offerId))}/products?brandId=${encodeURIComponent(selectedBrandId)}`;
            window.open(url, "_blank", "noopener,noreferrer");
          }}
          dangerouslySetInnerHTML={{ __html: viewDetailsIcon }}
        />
      );
    },
    [selectedBrandId],
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
      {
        headerName: "",
        cellRenderer: ViewDetailsCell,
        width: 50,
        maxWidth: 50,
        sortable: false,
        filter: false,
        resizable: false,
        suppressHeaderMenuButton: true,
        pinned: "left",
      },
      {
        field: "OfferID",
        headerName: "Offer ID",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        width: 110,
      },
      {
        field: "TotalOfferValue",
        headerName: "Total Value",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: formatCurrency,
        width: 160,
      },
      {
        field: "TotalCostValue",
        headerName: "Total Cost",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: formatCurrency,
        width: 160,
      },
      {
        field: "TotalListValue",
        headerName: "Total List",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: formatCurrency,
        width: 160,
      },
      {
        field: "Probability",
        headerName: "Probability",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        width: 120,
      },
      {
        field: "OfferDate",
        headerName: "Offer Date",
        filter: "agDateColumnFilter",
        valueFormatter: (params) => formatDateDMY(params.value),
        filterParams: { browserDatePicker: false, minValidYear: 2000 },
        width: 140,
      },
      {
        field: "PossibleOrderDate",
        headerName: "Possible Order Date",
        filter: "agDateColumnFilter",
        valueFormatter: (params) => formatDateDMY(params.value),
        filterParams: { browserDatePicker: false, minValidYear: 2000 },
        width: 180,
      },
      {
        field: "Description",
        headerName: "Description",
        filter: "agTextColumnFilter",
        width: 250,
      },
      {
        field: "CustomerName",
        headerName: "Customer",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        width: 200,
      },
      {
        field: "SalesMarket",
        headerName: "Market",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        width: 150,
      },
      {
        field: "SalesPerson",
        headerName: "Sales Person",
        filter: "agTextColumnFilter",
        enableRowGroup: true,
        width: 160,
      },
    ],
    [ViewDetailsCell],
  );

  const requestPayload = useMemo(
    () => ({ brandId: selectedBrandId ? Number(selectedBrandId) : null, view: "summary" as const }),
    [selectedBrandId],
  );

  return (
    <main className={styles.page}>
      <PageHeader
        title="Manufacturer's Pipeline"
        leftActions={
          <div className={styles.brandComboWrapper}>
            <input
              autoComplete="off"
              className={styles.brandComboInput}
              value={brandText}
              placeholder="Type to filter brands"
              onChange={(e) => handleBrandInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && showBrandList && filteredBrands.length > 0) {
                  e.preventDefault();
                  handleBrandSelect(filteredBrands[0]);
                }
              }}
              onFocus={(e) => {
                clearBrandCloseTimer();
                e.target.select();
                setShowBrandList(true);
              }}
              onBlur={handleBrandBlur}
            />
            {showBrandList && filteredBrands.length > 0 && (
              <div className={styles.brandComboList}>
                {filteredBrands.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.brandComboOption}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => handleBrandSelect(option)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        }
      >
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            {selectedBrandId ? (
              <AgGridAll
                endpoint="/api/manufacturers-pipeline"
                columnDefs={columnDefs}
                requestPayload={requestPayload}
                refreshToken={refreshToken}
                columnStateNamespace="manufacturers-pipeline"
                rowGroupPanelShow="always"
              />
            ) : (
              <div className={styles.emptyState}>
                Select a brand from the top-left dropdown menu to view open offers.
              </div>
            )}
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
