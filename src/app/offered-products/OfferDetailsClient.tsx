"use client";

import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import type { ColDef } from 'ag-grid-community';
import PageHeader from '../components/PageHeader';
import { GridQuickSearchProvider } from '../components/GridQuickSearchProvider';
import { formatDateTime } from '../lib/formatDateTime';
import styles from './OfferDetailsClient.module.css';

const AgGridAll = dynamic(() => import('../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});

const formatDateDMY = (value: unknown): string => {
  if (!value) return '';
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) return '';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}`;
};

const formatNumber = (value: unknown): string => {
  if (value == null || value === '') return '';
  const num = Number(value);
  if (Number.isNaN(num)) return '';
  return num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatPercent = (value: unknown): string => {
  if (value == null || value === '') return '';
  const num = Number(value);
  if (Number.isNaN(num)) return '';
  return `${num.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
};

const formatModifiedValue = (value: unknown): string => {
  if (value == null || value === '') return '-';
  return formatDateTime(value as string | Date);
};

const redCellStyle = { color: '#dc2626' } as const;

export default function OfferDetailsClient() {
  const columnDefs: ColDef[] = useMemo(() => [
    {
      field: 'OfferID',
      headerName: 'Offer ID',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      width: 110,
    },
    {
      field: 'CustomerName',
      headerName: 'Customer',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      minWidth: 180,
    },
    {
      field: 'OfferDescription',
      headerName: 'Offer Description',
      filter: 'agTextColumnFilter',
      minWidth: 180,
    },
    {
      field: 'OfferVersion',
      headerName: 'Version',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      width: 100,
    },
    {
      field: 'OfferStatus',
      headerName: 'Status',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 130,
    },
    {
      field: 'OfferDate',
      headerName: 'Offer Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      width: 130,
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
    },
    {
      field: 'OfferTitle',
      headerName: 'Offer Title',
      filter: 'agTextColumnFilter',
      minWidth: 160,
      hide: true,
    },
    {
      field: 'CustomerGroup',
      headerName: 'Customer Group',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 150,
      hide: true,
    },
    {
      field: 'PartNumber',
      headerName: 'Part Number',
      filter: 'agTextColumnFilter',
      minWidth: 140,
    },
    {
      field: 'ModelNumber',
      headerName: 'Model Number',
      filter: 'agTextColumnFilter',
      minWidth: 140,
    },
    {
      field: 'BrandName',
      headerName: 'Brand',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 130,
    },
    {
      field: 'ProductDescription',
      headerName: 'Product Description',
      filter: 'agTextColumnFilter',
      minWidth: 220,
    },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      width: 90,
    },
    {
      field: 'ListPrice',
      headerName: 'List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatNumber(params.value),
      width: 120,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Cust. Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatPercent(params.value),
      width: 130,
    },
    {
      field: 'NetUnitPrice',
      headerName: 'Net Unit Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatNumber(params.value),
      width: 130,
    },
    {
      field: 'TotalPrice',
      headerName: 'Total Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatNumber(params.value),
      width: 120,
    },
    {
      field: 'TotalNet',
      headerName: 'Total Net',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatNumber(params.value),
      width: 120,
    },
    {
      field: 'Warranty',
      headerName: 'Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      width: 100,
    },
    {
      field: 'Delivery',
      headerName: 'Delivery',
      filter: 'agTextColumnFilter',
      width: 130,
    },
    // Cost columns (red text)
    {
      field: 'TelmacoDiscount',
      headerName: 'Telmaco Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatPercent(params.value),
      cellStyle: redCellStyle,
      width: 140,
    },
    {
      field: 'NetCostOtherCurrency',
      headerName: 'Net Cost (Other Currency)',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => {
        if (params.value == null || params.value === '') return '';
        const num = Number(params.value);
        if (Number.isNaN(num) || num === 0) return '';
        const currencyName = typeof (params.data as Record<string, unknown> | null)?.OtherCurrencyName === 'string'
          ? String((params.data as Record<string, unknown>).OtherCurrencyName).trim()
          : '';
        if (!currencyName || currencyName === '€' || currencyName.toLowerCase().includes('eur')) return '';
        return currencyName === '$'
          ? `$ ${num.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
          : `${num.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${currencyName}`;
      },
      cellStyle: redCellStyle,
      width: 180,
    },
    {
      field: 'CurrencyCostModifier',
      headerName: 'Cost Modifier',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => {
        const currencyName = typeof (params.data as Record<string, unknown> | null)?.OtherCurrencyName === 'string'
          ? String((params.data as Record<string, unknown>).OtherCurrencyName).trim()
          : '';
        if (!currencyName || currencyName === '€' || currencyName.toLowerCase().includes('eur')) return '';
        if (params.value == null || params.value === '') return '';
        return String(params.value);
      },
      cellStyle: redCellStyle,
      width: 130,
    },
    {
      field: 'NetCost',
      headerName: 'Net Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatNumber(params.value),
      cellStyle: redCellStyle,
      width: 120,
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatPercent(params.value),
      cellStyle: redCellStyle,
      width: 110,
    },
    {
      field: 'GrossProfit',
      headerName: 'Gross Profit',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatNumber(params.value),
      cellStyle: redCellStyle,
      width: 120,
    },
    {
      field: 'TotalCost',
      headerName: 'Total Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatNumber(params.value),
      cellStyle: redCellStyle,
      width: 120,
    },
    {
      field: 'TelmacoWarranty',
      headerName: 'Telmaco Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      cellStyle: redCellStyle,
      width: 140,
    },
    // Dates
    {
      field: 'CreatedOn',
      headerName: 'Created',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatModifiedValue(params.value),
      width: 160,
      hide: true,
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
    },
    {
      field: 'ModifiedOn',
      headerName: 'Modified',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatModifiedValue(params.value),
      width: 160,
      hide: true,
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
    },
  ], []);

  return (
    <main className={styles.page}>
      <PageHeader title="Offered Products">
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/offered-products"
              columnDefs={columnDefs}
              rowGroupPanelShow="always"
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
