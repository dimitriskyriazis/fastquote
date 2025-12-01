'use client';

import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllEnterpriseModule,
  ModuleRegistry,
  LicenseManager,
} from 'ag-grid-enterprise';
import type {
  ColDef,
  GridApi,
  FirstDataRenderedEvent,
  ValueFormatterParams,
  Column,
} from 'ag-grid-community';
import styles from './ProductHistory.module.css';
import gridStyles from '../../../components/AgGridAll.module.css';

declare global {
  // Prevent double registration during HMR/StrictMode
  var __TELQUOTE_HISTORY_AG__: boolean | undefined;
}

if (!globalThis.__TELQUOTE_HISTORY_AG__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  globalThis.__TELQUOTE_HISTORY_AG__ = true;
}

LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE || '');

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
  const gridApiRef = useRef<GridApi<HistoryRow> | null>(null);

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    enableRowGroup: false,
    filterParams: { buttons: ['apply', 'clear'], closeOnApply: true },
    minWidth: 80,
  }), []);

  const autoSizeAll = useCallback((api?: GridApi<HistoryRow> | null) => {
    const gridApi = api ?? gridApiRef.current;
    if (!gridApi || gridApi.isDestroyed?.()) return;
    const resize = () => {
      if (gridApi.isDestroyed?.()) return;
      const displayed: Column[] | null = typeof gridApi.getAllDisplayedColumns === 'function'
        ? gridApi.getAllDisplayedColumns()
        : null;
      if (!displayed || displayed.length === 0) return;
      const exclusions = new Set<string>(['ProductDescription']);
      const columnsToSize = displayed.filter((col: Column) => {
        const colId = typeof col.getColId === 'function'
          ? col.getColId()
          : (typeof (col as { getId?: () => string }).getId === 'function'
            ? (col as { getId?: () => string }).getId?.()
            : null);
        if (!colId) return true;
        return !exclusions.has(colId);
      });
      if (columnsToSize.length === 0) return;
      const columnIds = columnsToSize
        .map((col: Column) => {
          if (typeof col.getColId === 'function') return col.getColId();
          if (typeof (col as { getId?: () => string }).getId === 'function') return (col as { getId?: () => string }).getId?.();
          return null;
        })
        .filter((id: unknown): id is string => typeof id === 'string' && (id as string).length > 0);
      if (columnIds.length === 0) return;
      gridApi.autoSizeColumns(columnIds, false);
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(resize);
    } else {
      setTimeout(resize, 0);
    }
  }, []);

  const handleGridReady = useCallback((params: { api: GridApi<HistoryRow> }) => {
    gridApiRef.current = params.api;
    autoSizeAll(params.api);
    try {
      params.api.closeToolPanel();
    } catch {
      /* ignore */
    }
  }, [autoSizeAll]);

  const handleFirstDataRendered = useCallback((event: FirstDataRenderedEvent<HistoryRow>) => {
    autoSizeAll(event.api);
  }, [autoSizeAll]);

  useEffect(() => {
    autoSizeAll();
  }, [autoSizeAll]);

  const pricingCols = useMemo<ColDef[]>(() => [
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 90, suppressHeaderMenuButton: true },
    { field: 'OfferDate', headerName: 'Offer Date', filter: 'agDateColumnFilter', width: 107, minWidth: 107, maxWidth: 107, suppressAutoSize: true, 
      suppressHeaderMenuButton: true, valueFormatter: (p: ValueFormatterParams<HistoryRow>) => p.value ? new Date(p.value as string | number | Date).toLocaleDateString() : '' },
    { field: 'CustomerName', headerName: 'Customer', filter: 'agTextColumnFilter', width: 200, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'ListPrice', headerName: 'List Price', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 140, valueFormatter: currencyFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'CustomerDiscount', headerName: 'Customer Discount', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 140, valueFormatter: percentFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'NetUnitPrice', headerName: 'Net Unit Price', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 150, valueFormatter: currencyFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'TelmacoDiscount', headerName: 'Telmaco Discount', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 160, valueFormatter: percentFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'NetCost', headerName: 'Net Cost', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 140, valueFormatter: currencyFormatter, suppressHeaderMenuButton: true, enableRowGroup: true },
  ], []);

  return (
    <div className={`${styles.gridContainer} ${gridStyles.container} ${styles.bandedRows} offer-products-grid`}>
      <div
        className={`ag-theme-quartz ${styles.gridShell} ${gridStyles.gridShell}`}
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
          onFirstDataRendered={handleFirstDataRendered}
        />
      </div>
    </div>
  );
}
