'use client';

import React, { useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';
import type {
  ColDef,
  ValueFormatterParams,
  GridApi,
} from 'ag-grid-community';
import styles from './ProductHistory.module.css';

declare global {
  var __FASTQUOTE_HISTORY_AG__: boolean | undefined;
}

if (!globalThis.__FASTQUOTE_HISTORY_AG__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  globalThis.__FASTQUOTE_HISTORY_AG__ = true;
}

export type HistoryRow = {
  OfferID: number | null;
  OfferDate: Date | string | null;
  CustomerName: string | null;
  ListPrice: number | null;
  CustomerDiscount: number | null;
  NetUnitPrice: number | null;
  TelmacoDiscount: number | null;
  NetCost: number | null;
};

type Props = {
  rows: HistoryRow[];
};

const currencyFormatter = (params: { value?: unknown }) => {
  const num = typeof params.value === 'number' ? params.value : Number(params.value ?? Number.NaN);
  if (!Number.isFinite(num)) return '';
  return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
};

const percentFormatter = (params: { value?: unknown }) => {
  const num = typeof params.value === 'number' ? params.value : Number(params.value ?? Number.NaN);
  if (!Number.isFinite(num)) return '';
  return `${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
};

export default function ProductHistoryGrid({ rows }: Props) {

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    enableRowGroup: false,
    filterParams: { buttons: ['apply', 'clear'], closeOnApply: true },
  }), []);

  const handleGridReady = useCallback((params: { api: GridApi<HistoryRow> }) => {
    try {
      params.api.closeToolPanel();
    } catch {
      /* ignore */
    }
  }, []);

  const pricingCols = useMemo<ColDef[]>(() => [
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 90, suppressHeaderMenuButton: true },
    { field: 'OfferDate', headerName: 'Offer Date', filter: 'agDateColumnFilter', suppressHeaderMenuButton: true, valueFormatter: (p: ValueFormatterParams<HistoryRow>) => p.value ? new Date(p.value as string | number | Date).toLocaleDateString() : '' },
    { field: 'CustomerName', headerName: 'Customer', filter: 'agTextColumnFilter', width: 200, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'ListPrice', headerName: 'List Price', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 140, valueFormatter: currencyFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'CustomerDiscount', headerName: 'Customer Discount', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 140, valueFormatter: percentFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'NetUnitPrice', headerName: 'Net Unit Price', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 150, valueFormatter: currencyFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'TelmacoDiscount', headerName: 'Telmaco Discount', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 160, valueFormatter: percentFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'NetCost', headerName: 'Net Cost', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 140, valueFormatter: currencyFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
  ], []);

  return (
    <div className={`${styles.gridContainer} ${styles.bandedRows} offer-products-grid`}>
      <div
        className={`ag-theme-quartz ${styles.gridShell}`}
        data-ag-grid-size="compact"
      >
        <AgGridReact
          rowData={rows}
          columnDefs={pricingCols}
          defaultColDef={defaultColDef}
          domLayout="autoHeight"
          animateRows
          rowGroupPanelShow="always"
          sideBar={['columns', 'filters']}
          suppressDragLeaveHidesColumns
          suppressCellFocus
          cellSelection
          rowHeight={32}
          headerHeight={38}
          statusBar={{ statusPanels: [{ statusPanel: 'agAggregationComponent' }] }}
          enableCharts={false}
          pivotMode={false}
          rowModelType="clientSide"
          onGridReady={handleGridReady}
        />
      </div>
    </div>
  );
}
