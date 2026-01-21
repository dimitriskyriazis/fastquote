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
  layout: 'category' | 'brand' | 'categoryBrand' | 'discount';
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

  const columnDefs = useMemo<ColDef<RowData>[]>(() => ([
    { field: 'OfferDetailID', hide: true, suppressColumnsToolPanel: true },
    { field: 'ProductID', hide: true, suppressColumnsToolPanel: true },

    { field: 'CategoryName', headerName: 'Category' },
    { field: 'BrandName', headerName: 'Brand' },
    { field: 'PartNumber', headerName: 'Part No' },
    { field: 'ModelNumber', headerName: 'Model No' },
    { field: 'Description', headerName: 'Description', minWidth: 280 },
    { field: 'Quantity', headerName: 'Qty', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('Quantity'), valueFormatter: numberValueFormatter, aggFunc: 'sum' },

    { field: 'ListPrice', headerName: 'List Price', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('ListPrice'), valueFormatter: euroValueFormatter, aggFunc: 'sum' },
    { field: 'NetUnitPrice', headerName: 'Net Unit', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('NetUnitPrice'), valueFormatter: euroValueFormatter, aggFunc: 'sum' },
    { field: 'TotalPrice', headerName: 'Total List', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalPrice'), valueFormatter: euroValueFormatter, aggFunc: 'sum' },
    { field: 'TotalNet', headerName: 'Total Net', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalNet'), valueFormatter: euroValueFormatter, aggFunc: 'sum' },
    { field: 'NetCost', headerName: 'Net Cost', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('NetCost'), valueFormatter: euroValueFormatter, aggFunc: 'sum', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' } },
    { field: 'TotalCost', headerName: 'Total Cost', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalCost'), valueFormatter: euroValueFormatter, aggFunc: 'sum', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' } },
    { field: 'GrossProfit', headerName: 'Gross Profit', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('GrossProfit'), valueFormatter: euroValueFormatter, aggFunc: 'sum', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' } },
    { field: 'Margin', headerName: 'Margin %', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('Margin'), valueFormatter: percentValueFormatter, aggFunc: 'avg', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' } },
    { field: 'CustomerDiscount', headerName: 'Cust Disc %', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('CustomerDiscount'), valueFormatter: percentValueFormatter, aggFunc: 'avg' },
    { field: 'TelmacoDiscount', headerName: 'Telm Disc %', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TelmacoDiscount'), valueFormatter: percentValueFormatter, aggFunc: 'avg', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' } },
    {
      colId: 'DiscountAmount',
      headerName: 'Discount €',
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
    },
  ]), []);

  const fieldList = useMemo(
    () => Array.from(new Set(
      columnDefs
        .map((def) => (typeof def.field === 'string' ? def.field : null))
        .filter((field): field is string => Boolean(field) && field !== 'OfferDetailID'),
    )),
    [columnDefs],
  );

  const applyLayout = useMemo(() => () => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;

    api.setGridOption('pivotMode', true);

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
      case 'categoryBrand': {
        set('CategoryName', { rowGroup: true, rowGroupIndex: 0 });
        set('BrandName', { pivot: true, pivotIndex: 0 });
        set('TotalNet', { aggFunc: 'sum' });
        break;
      }
      case 'discount': {
        set('CategoryName', { rowGroup: true, rowGroupIndex: 0 });
        set('TotalPrice', { aggFunc: 'sum' });
        set('TotalNet', { aggFunc: 'sum' });
        set('DiscountAmount', { aggFunc: 'sum' });
        set('TotalCost', { aggFunc: 'sum' });
        set('GrossProfit', { aggFunc: 'sum' });
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
    minWidth: 120,
    flex: 0,
  }), []);

  const onGridReady = useMemo(() => (e: GridReadyEvent<RowData>) => {
    gridApiRef.current = e.api;
    e.api.setSideBarVisible(true);
    e.api.closeToolPanel();
    // Start in pivot mode (user can disable via the default Pivot Mode toggle).
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
            sideBar={{ toolPanels: ['columns', 'filters'], defaultToolPanel: 'columns' }}
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
    </div>
  );
}

