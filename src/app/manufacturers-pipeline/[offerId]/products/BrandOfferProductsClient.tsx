"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import type { ColDef, ValueFormatterParams } from "ag-grid-community";
import styles from "./BrandOfferProductsClient.module.css";
import PageHeader from "../../../components/PageHeader";
import { GridQuickSearchProvider } from "../../../components/GridQuickSearchProvider";
import { getUserNumberLocale } from "../../../../lib/localeNumber";

const AgGridAll = dynamic(() => import("../../../components/AgGridAll"), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>Loading products…</div>
  ),
});

const decimalFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const euroFormatter = (params: ValueFormatterParams) => {
  const value = params?.value;
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || Object.is(num, 0)) return "";
  return `${decimalFormatter.format(num)} €`;
};

const percentageFormatter = (params: ValueFormatterParams) => {
  const value = params?.value;
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) return "";
  return `${decimalFormatter.format(num)} %`;
};

const intFormatter = (params: ValueFormatterParams) => {
  const value = params?.value;
  if (value == null || value === "") return "";
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num) || Object.is(num, 0)) return "";
  return String(Math.round(num));
};

type Props = {
  offerId: string;
  brandId: string;
  heading: string;
};

export default function BrandOfferProductsClient({
  offerId,
  brandId,
  heading,
}: Props) {
  const columnDefs = useMemo<ColDef[]>(
    () => [
      { field: "PartNumber", headerName: "Part Number", filter: "agTextColumnFilter", width: 160 },
      { field: "ModelNumber", headerName: "Model Number", filter: "agTextColumnFilter", width: 160 },
      { field: "Description", headerName: "Description", filter: "agTextColumnFilter", width: 280 },
      {
        field: "ListPrice",
        headerName: "List Price",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: euroFormatter,
        width: 140,
      },
      {
        field: "CustomerDiscount",
        headerName: "Customer Discount",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: percentageFormatter,
        width: 160,
      },
      {
        field: "NetUnitPrice",
        headerName: "Net Unit Price",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: euroFormatter,
        width: 140,
      },
      {
        field: "Quantity",
        headerName: "Qty",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: intFormatter,
        width: 90,
      },
      {
        field: "TotalPrice",
        headerName: "Total List Price",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: euroFormatter,
        width: 150,
      },
      {
        field: "TotalNet",
        headerName: "Total Net",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: euroFormatter,
        width: 140,
      },
      {
        field: "Warranty",
        headerName: "Warranty",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: intFormatter,
        width: 110,
      },
      { field: "Comment", headerName: "Comment", filter: "agTextColumnFilter", width: 180 },
      { field: "Delivery", headerName: "Delivery", filter: "agTextColumnFilter", width: 120 },
      {
        field: "TelmacoDiscount",
        headerName: "Telmaco Discount",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: percentageFormatter,
        cellStyle: { color: "#dc2626" },
        width: 150,
      },
      {
        field: "NetCost",
        headerName: "Net Cost",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: euroFormatter,
        cellStyle: { color: "#dc2626" },
        width: 130,
      },
      {
        field: "Margin",
        headerName: "Margin",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: percentageFormatter,
        cellStyle: { color: "#dc2626" },
        width: 110,
      },
      {
        field: "GrossProfit",
        headerName: "Gross Profit",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: euroFormatter,
        cellStyle: { color: "#dc2626" },
        width: 130,
      },
      {
        field: "TotalCost",
        headerName: "Total Cost",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: euroFormatter,
        cellStyle: { color: "#dc2626" },
        width: 130,
      },
      {
        field: "TelmacoWarranty",
        headerName: "Telmaco Warranty",
        filter: "agNumberColumnFilter",
        type: "numericColumn",
        valueFormatter: intFormatter,
        cellStyle: { color: "#dc2626" },
        width: 150,
      },
    ],
    [],
  );

  const requestPayload = useMemo(
    () => ({ brandId: brandId ? Number(brandId) : null }),
    [brandId],
  );

  return (
    <main className={styles.page}>
      <PageHeader
        title={heading}
      >
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint={`/api/manufacturers-pipeline/${encodeURIComponent(offerId)}/products`}
              columnDefs={columnDefs}
              requestPayload={requestPayload}
              columnStateNamespace="brand-offer-products"
              rowGroupPanelShow="always"
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
