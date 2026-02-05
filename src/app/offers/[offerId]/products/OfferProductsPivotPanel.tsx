'use client';

import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  ColumnState,
  ColumnPivotModeChangedEvent,
  ColDef,
  GridApi,
  GridReadyEvent,
  ValueFormatterParams,
} from 'ag-grid-community';
import {
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  DateFilterModule,
  EventApiModule,
  ModuleRegistry,
  NumberFilterModule,
  RowApiModule,
  RowStyleModule,
  TextFilterModule,
} from 'ag-grid-community';
import {
  AggregationModule,
  CellSelectionModule,
  ClipboardModule,
  ColumnMenuModule,
  ColumnsToolPanelModule,
  ContextMenuModule,
  FiltersToolPanelModule,
  LicenseManager,
  MenuModule,
  PivotModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  SetFilterModule,
  SideBarModule,
  StatusBarModule,
} from 'ag-grid-enterprise';
import { GridQuickSearchContext } from '../../../components/GridQuickSearchProvider';
import { showToastMessage } from '../../../../lib/toast';
import gridStyles from '../../../components/AgGridAll.module.css';
import panelStyles from '../OfferProductsPanel.module.css';
import { getUserNumberLocale } from '../../../../lib/localeNumber';

type RowData = Record<string, unknown>;

type Props = {
  offerId: string;
  refreshToken?: number;
  onExitPivot?: () => void;
  layout: 'category' | 'brand';
};

const currencyFormatter = new Intl.NumberFormat(getUserNumberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentFormatter = new Intl.NumberFormat(getUserNumberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const euroValueFormatter = ({ value }: ValueFormatterParams<RowData, unknown>) => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || Object.is(num, 0)) return '';
  return `${currencyFormatter.format(num)} €`;
};

const percentValueFormatter = ({ value }: ValueFormatterParams<RowData, unknown>) => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || Object.is(num, 0)) return '';
  return `${percentFormatter.format(num)} %`;
};

const numberValueFormatter = ({ value }: ValueFormatterParams<RowData, unknown>) => {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || Object.is(num, 0)) return '';
  return String(num);
};
const formatEuroTotal = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${currencyFormatter.format(value)} €`;
};
const formatPercentTotal = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${percentFormatter.format(value)} %`;
};

const toFiniteNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const numericFieldValueGetter = (field: string) => (params: { data?: RowData | null }) => {
  const data = params.data ?? null;
  if (!data) return null;
  return toFiniteNumber((data as Record<string, unknown>)[field]);
};

if (!(globalThis as unknown as { __AG_GRID_PIVOT_MODULES_REGISTERED__?: boolean }).__AG_GRID_PIVOT_MODULES_REGISTERED__) {
  ModuleRegistry.registerModules([
    ClientSideRowModelModule,
    RowGroupingModule,
    RowGroupingPanelModule,
    PivotModule,
    ColumnsToolPanelModule,
    FiltersToolPanelModule,
    SideBarModule,
    StatusBarModule,
    AggregationModule,
    MenuModule,
    ColumnMenuModule,
    ContextMenuModule,
    ClipboardModule,
    SetFilterModule,
    CellSelectionModule,
    TextFilterModule,
    NumberFilterModule,
    DateFilterModule,
    EventApiModule,
    ColumnApiModule,
    ColumnAutoSizeModule,
    RowStyleModule,
    RowApiModule,
  ]);
  (globalThis as unknown as { __AG_GRID_PIVOT_MODULES_REGISTERED__?: boolean }).__AG_GRID_PIVOT_MODULES_REGISTERED__ = true;
}

LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE || '');

export default function OfferProductsPivotPanel({ offerId, refreshToken = 0, onExitPivot, layout }: Props) {
  const quickSearch = useContext(GridQuickSearchContext);
  const gridApiRef = useRef<GridApi<RowData> | null>(null);
  const lastFetchSignatureRef = useRef<string>('');
  const [gridReady, setGridReady] = useState(false);
  const [rowData, setRowData] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(false);
  const [rowCount, setRowCount] = useState<number | null>(null);

  const endpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products`,
    [offerId],
  );

  const columnDefs = useMemo<ColDef<RowData>[]>(() => {
    const hideCategory = layout === 'brand';
    const hideBrand = layout === 'category';
    return [
      { field: 'OfferDetailID', hide: true, suppressColumnsToolPanel: true },
      { field: 'ProductID', hide: true, suppressColumnsToolPanel: true },

      { field: 'CategoryName', headerName: 'Category', hide: hideCategory, suppressColumnsToolPanel: hideCategory},
      { field: 'BrandName', headerName: 'Brand', hide: hideBrand, suppressColumnsToolPanel: hideBrand },
      { field: 'Quantity', headerName: 'Qty', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('Quantity'), valueFormatter: numberValueFormatter, aggFunc: 'sum', width: 110 },
      { field: 'TotalPrice', headerName: 'Total List', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalPrice'), valueFormatter: euroValueFormatter, aggFunc: 'sum', width: 150 },
      { field: 'CustomerDiscount', headerName: 'Customer Discount', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('CustomerDiscount'), valueFormatter: percentValueFormatter, aggFunc: 'avg', width: 200 },
      { field: 'TotalNet', headerName: 'Total Net', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalNet'), valueFormatter: euroValueFormatter, aggFunc: 'sum', width: 150 },
      { field: 'TelmacoDiscount', headerName: 'Telmaco Discount', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TelmacoDiscount'), valueFormatter: percentValueFormatter, aggFunc: 'avg', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' }, width: 180 },
      { field: 'Margin', headerName: 'Margin %', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('Margin'), valueFormatter: percentValueFormatter, aggFunc: 'avg', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' }, width: 150 },
      { field: 'GrossProfit', headerName: 'Gross Profit', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('GrossProfit'), valueFormatter: euroValueFormatter, aggFunc: 'sum', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' }, width: 150 },
      { field: 'TotalCost', headerName: 'Total Cost', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalCost'), valueFormatter: euroValueFormatter, aggFunc: 'sum', cellClass: panelStyles.redDataCell, cellStyle: { color:'#dc2626' }, width : 150},
      {
        colId: 'DiscountAmount',
        headerName: 'Total Discounts',
        valueGetter: (params) => {
          const data = params.data as RowData | null | undefined;
          const totalPrice = data ? toFiniteNumber((data as { TotalPrice?: unknown })?.TotalPrice) : null;
          const totalNet = data ? toFiniteNumber((data as { TotalNet?: unknown })?.TotalNet) : null;
          if (totalPrice == null || totalNet == null) return null;
          return totalPrice - totalNet;
        },
        valueFormatter: euroValueFormatter,
        aggFunc: 'sum',
        enableValue: true,
        cellStyle: { color: '#dc2626' },
        width: 180,
      },
    ];
  }, [layout]);

  const fieldList = useMemo(
    () => Array.from(new Set(
      columnDefs
        .map((def) => (typeof def.field === 'string' ? def.field : null))
        .filter((field): field is string => Boolean(field) && field !== 'OfferDetailID'),
    )),
    [columnDefs],
  );
  const totals = useMemo(() => {
    let totalNetPrice = 0;
    let totalListPrice = 0;
    let totalCost = 0;
    rowData.forEach((row) => {
      totalNetPrice += toFiniteNumber((row as { TotalNet?: unknown }).TotalNet) ?? 0;
      totalListPrice += toFiniteNumber((row as { TotalPrice?: unknown }).TotalPrice) ?? 0;
      totalCost += toFiniteNumber((row as { TotalCost?: unknown }).TotalCost) ?? 0;
    });
    const marginBasis = Object.is(totalNetPrice, 0) ? 0 : totalNetPrice;
    const totalMargin = marginBasis === 0 ? 0 : ((totalNetPrice - totalCost) / marginBasis) * 100;
    return { totalNetPrice, totalListPrice, totalCost, totalMargin };
  }, [rowData]);

  const applyLayout = useMemo(() => () => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;

    api.setGridOption('pivotMode', true);
    api.closeToolPanel();

    const state: ColumnState[] = [
      // reset everything
      // (defaultState below handles reset; state here sets what's enabled)
    ];

    const set = (colId: string, next: Partial<ColumnState>) => {
      state.push({ colId, ...next });
    };

    // Common numeric values
    const enableTotals = () => {
      set('Quantity', { aggFunc: 'sum' });
      set('TotalNet', { aggFunc: 'sum' });
      set('TotalCost', { aggFunc: 'sum' });
      set('GrossProfit', { aggFunc: 'sum' });
    };

    switch (layout) {
      case 'category': {
        set('CategoryName', { rowGroup: true, rowGroupIndex: 0 });
        enableTotals();
        break;
      }
      case 'brand': {
        set('BrandName', { rowGroup: true, rowGroupIndex: 0 });
        enableTotals();
        break;
      }
      default:
        break;
    }

    api.applyColumnState({
      defaultState: { rowGroup: false, pivot: false, aggFunc: undefined },
      state,
      applyOrder: false,
    });
  }, [layout]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (!offerId) return;
      const signature = `${offerId}:${refreshToken}:${quickSearch?.value ?? ''}`;
      if (lastFetchSignatureRef.current === signature) return;
      lastFetchSignatureRef.current = signature;

      setLoading(true);
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request: { allRows: true, view: 'pivot', quickFilterText: quickSearch?.value ?? null },
            fields: fieldList,
          }),
        });
        const payload = (await res.json().catch(() => null)) as
          | { ok?: boolean; error?: string; rows?: RowData[]; rowCount?: number }
          | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to load pivot data (status ${res.status})`);
        }
        if (cancelled) return;
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        setRowData(rows);
        setRowCount(typeof payload.rowCount === 'number' ? payload.rowCount : rows.length);
      } catch (err) {
        console.error('Failed to load pivot data', err);
        if (!cancelled) {
          setRowData([]);
          setRowCount(null);
        }
        showToastMessage('Unable to load pivot data. Please try again.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [endpoint, fieldList, offerId, refreshToken, quickSearch?.value]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    api.setGridOption('quickFilterText', quickSearch?.value ?? '');
  }, [quickSearch?.value]);

  const defaultColDef = useMemo<ColDef<RowData>>(() => ({
    sortable: true,
    filter: true,
    resizable: true,
    enableRowGroup: true,
    enablePivot: true,
    enableValue: true,
    flex: 0,
  }), []);

  const onGridReady = useMemo(() => (e: GridReadyEvent<RowData>) => {
    gridApiRef.current = e.api;
    e.api.setSideBarVisible(true);
    e.api.closeToolPanel();
    // Start in pivot mode for the pivot view.
    e.api.setGridOption('pivotMode', true);
    e.api.setGridOption('quickFilterText', quickSearch?.value ?? '');
    setGridReady(true);
  }, [quickSearch?.value]);

  const handlePivotModeChanged = useMemo(() => (e: ColumnPivotModeChangedEvent<RowData>) => {
    const api = e.api ?? gridApiRef.current;
    const enabled = typeof api?.isPivotMode === 'function' ? api.isPivotMode() : true;
    if (!enabled) {
      onExitPivot?.();
    }
  }, [onExitPivot]);

  useEffect(() => {
    if (!gridReady) return;
    // Apply preset when entering pivot view or when user changes preset.
    // Delay slightly to ensure column defs are fully registered.
    const t = window.setTimeout(() => applyLayout(), 0);
    return () => window.clearTimeout(t);
  }, [applyLayout, gridReady]);

  return (
    <div className={`${panelStyles.panel} offer-products-grid`}>
      <div className={gridStyles.container}>
        <div
          className={`ag-theme-quartz ${gridStyles.gridShell}`}
          data-ag-grid-size="compact"
          data-allow-column-drop="true"
        >
          {loading ? (
            <div className={panelStyles.loading}>Loading pivot data…</div>
          ) : null}
          <AgGridReact<RowData>
            rowData={rowData}
            columnDefs={columnDefs}
            defaultColDef={defaultColDef}
            rowHeight={32}
            headerHeight={38}
            rowModelType="clientSide"
            sideBar={{
              toolPanels: [
                {
                  id: 'columns',
                  labelDefault: 'Columns',
                  labelKey: 'columns',
                  iconKey: 'columns',
                  toolPanel: 'agColumnsToolPanel',
                  toolPanelParams: {
                    suppressPivotMode: true,
                    suppressPivots: true,
                  },
                },
                {
                  id: 'filters',
                  labelDefault: 'Filters',
                  labelKey: 'filters',
                  iconKey: 'filter',
                  toolPanel: 'agFiltersToolPanel',
                },
              ],
            }}
            statusBar={{ statusPanels: [{ statusPanel: 'agAggregationComponent' }] }}
            rowGroupPanelShow="always"
            pivotPanelShow="always"
            suppressAggFuncInHeader
            onGridReady={onGridReady}
            onColumnPivotModeChanged={handlePivotModeChanged}
            overlayNoRowsTemplate={
              loading
                ? '<span style="padding: 10px; color: #475569;">Loading…</span>'
                : rowCount === 0
                  ? '<span style="padding: 10px; color: #475569;">No rows to pivot.</span>'
                  : '<span style="padding: 10px; color: #475569;">No rows.</span>'
            }
          />
        </div>
      </div>
      <div className={panelStyles.totalsBar}>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total Net Price</span>
          <span className={panelStyles.totalValue}>{formatEuroTotal(totals.totalNetPrice)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total List Price</span>
          <span className={panelStyles.totalValue}>{formatEuroTotal(totals.totalListPrice)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total Cost</span>
          <span className={panelStyles.totalValue}>{formatEuroTotal(totals.totalCost)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total Margin</span>
          <span className={panelStyles.totalValue}>{formatPercentTotal(totals.totalMargin)}</span>
        </div>
      </div>
    </div>
  );
}
