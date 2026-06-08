'use client';

import React, { useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';
import type {
  ColDef,
  ValueFormatterParams,
  GridApi,
  GetContextMenuItemsParams,
  MenuItemDef,
  DefaultMenuItem,
} from 'ag-grid-community';
import styles from './ProductHistory.module.css';
import { formatDateUK } from '../../lib/formatDateTime';
import { DdMmYyyyDateFilter } from '../../components/dateFilterDdMmYyyy';
import { openLinkInNewTab } from '../../../lib/navigation';

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
  SalesPerson: string | null;
  PricingPolicyName: string | null;
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
  return `${num.toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
};

const percentFormatter = (params: { value?: unknown }) => {
  const num = typeof params.value === 'number' ? params.value : Number(params.value ?? Number.NaN);
  if (!Number.isFinite(num)) return '';
  return `${num.toLocaleString('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
};

const viewInOfferMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';

export default function ProductHistoryGrid({ rows }: Props) {

  const defaultColDef = useMemo<ColDef>(() => ({
    resizable: true,
    sortable: true,
    filter: true,
    floatingFilter: true,
    enableRowGroup: false,
    filterParams: {
      buttons: ['reset'],
      maxNumConditions: 2,
      alwaysShowBothConditions: true,
      defaultJoinOperator: 'AND',
    },
  }), []);

  const handleGridReady = useCallback((params: { api: GridApi<HistoryRow> }) => {
    try {
      params.api.closeToolPanel();
    } catch {
      /* ignore */
    }
  }, []);

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<HistoryRow>): Array<MenuItemDef<HistoryRow> | DefaultMenuItem> => {
      const defaultItems = params.defaultItems ?? [];
      const offerId = params.node?.data?.OfferID ?? null;
      if (offerId == null) {
        return defaultItems;
      }
      const viewInOfferItem: MenuItemDef<HistoryRow> = {
        name: 'View in Offer',
        icon: viewInOfferMenuIcon,
        action: () => {
          openLinkInNewTab(`/offers/${encodeURIComponent(String(offerId))}/products`);
        },
      };
      return [viewInOfferItem, 'separator', ...defaultItems];
    },
    [],
  );

  const pricingCols = useMemo<ColDef[]>(() => [
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agNumberColumnFilter', type: 'numericColumn', width: 90, suppressHeaderMenuButton: true },
    { 
      field: 'OfferDate', 
      headerName: 'Offer Date', 
      filter: 'agDateColumnFilter', 
      suppressHeaderMenuButton: true, 
      valueFormatter: (p: ValueFormatterParams<HistoryRow>) => p.value ? formatDateUK(p.value) : '', 
      filterParams: {
        browserDatePicker: false,
        minValidYear: 2000,
        maxNumConditions: 2,
        alwaysShowBothConditions: true,
        defaultJoinOperator: 'AND',
        inRangeFloatingFilterDateFormat: 'DD/MM/YYYY',
      }
    },
    { field: 'CustomerName', headerName: 'Customer', filter: 'agTextColumnFilter', width: 200, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'SalesPerson', headerName: 'Sales Person', filter: 'agTextColumnFilter', width: 160, suppressHeaderMenuButton: true, enableRowGroup: true },
    { field: 'PricingPolicyName', headerName: 'Pricing Policy', filter: 'agTextColumnFilter', width: 160, suppressHeaderMenuButton: true, enableRowGroup: true },
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
          components={{ agDateInput: DdMmYyyyDateFilter }}
          localeText={{ dateFormatOoo: 'dd/mm/yyyy' }}
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
          rowModelType="clientSide"
          onGridReady={handleGridReady}
          getContextMenuItems={getContextMenuItems}
        />
      </div>
    </div>
  );
}
