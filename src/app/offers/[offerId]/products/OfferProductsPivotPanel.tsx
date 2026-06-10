'use client';

import React, { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import type {
  CellDoubleClickedEvent,
  CellValueChangedEvent,
  ColumnState,
  ColumnPivotModeChangedEvent,
  ColDef,
  GridApi,
  GridReadyEvent,
  RowClassParams,
  ValueFormatterParams,
  ValueSetterParams,
} from 'ag-grid-community';
import {
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  DateFilterModule,
  EventApiModule,
  ModuleRegistry,
  NumberFilterModule,
  QuickFilterModule,
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
import LookupModal from '../../../components/LookupModal';
import { showToastMessage } from '../../../../lib/toast';
import gridStyles from '../../../components/AgGridAll.module.css';
import panelStyles from '../OfferProductsPanel.module.css';
import { getUserNumberLocale } from '../../../../lib/localeNumber';
import { floorTo } from '../offerProductsUtils';

type RowData = Record<string, unknown>;

type Props = {
  offerId: string;
  refreshToken?: number;
  onExitPivot?: () => void;
  onDataChanged?: () => void;
  layout: 'category' | 'brand' | 'brandPartNo';
  readOnly?: boolean;
};

type BulkEditField = 'CustomerDiscount' | 'TelmacoDiscount' | 'Margin';

const BULK_EDIT_FIELDS: ReadonlySet<string> = new Set<BulkEditField>(['CustomerDiscount', 'TelmacoDiscount', 'Margin']);

const BULK_EDIT_LABELS: Record<BulkEditField, string> = {
  CustomerDiscount: 'Customer Discount',
  TelmacoDiscount: 'Telmaco Discount',
  Margin: 'Margin',
};

const currencyFormatter = new Intl.NumberFormat(getUserNumberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percentFormatter = new Intl.NumberFormat(getUserNumberLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Symbol placement mirrors the rest of the app: '$'/'£' lead the amount, others trail.
const placeCurrencySymbol = (formatted: string, symbol: string) =>
  symbol === '$' || symbol === '£' ? `${symbol} ${formatted}` : `${formatted} ${symbol}`;

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
const formatPercentTotal = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${percentFormatter.format(value)} %`;
};
const formatHoursTotal = (value: number | null | undefined) => {
  if (value == null || !Number.isFinite(value)) return '0 h';
  return `${currencyFormatter.format(value)} h`;
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
    QuickFilterModule,
  ]);
  (globalThis as unknown as { __AG_GRID_PIVOT_MODULES_REGISTERED__?: boolean }).__AG_GRID_PIVOT_MODULES_REGISTERED__ = true;
}

LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE || '');

export default function OfferProductsPivotPanel({ offerId, refreshToken = 0, onExitPivot, onDataChanged, layout, readOnly = false }: Props) {
  const quickSearch = useContext(GridQuickSearchContext);
  const gridApiRef = useRef<GridApi<RowData> | null>(null);
  const lastFetchSignatureRef = useRef<string>('');
  const suppressPivotExitRef = useRef(false);
  const [gridReady, setGridReady] = useState(false);
  const [rowData, setRowData] = useState<RowData[]>([]);
  const [loading, setLoading] = useState(false);
  const [rowCount, setRowCount] = useState<number | null>(null);
  const [apiTotals, setApiTotals] = useState<{
    totalListPrice: number;
    totalNetPrice: number;
    totalCost: number;
    totalInstallation: number;
    totalElInstalation: number;
    totalCommissioning: number;
  } | null>(null);

  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditField, setBulkEditField] = useState<BulkEditField>('CustomerDiscount');
  const [bulkEditBrand, setBulkEditBrand] = useState('');
  const [bulkEditValue, setBulkEditValue] = useState('');
  const [bulkEditSaving, setBulkEditSaving] = useState(false);
  const [bulkEditError, setBulkEditError] = useState<string | null>(null);

  const endpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products`,
    [offerId],
  );

  // Offer currency symbol (from the products endpoint). Kept in a ref so the grid
  // value formatter can stay stable (no columnDefs/fieldList churn → no extra fetch),
  // plus state so the totals bar re-renders when it changes.
  const currencySymbolRef = useRef('€');
  const [currencySymbol, setCurrencySymbol] = useState('€');

  const applyOfferCurrency = useCallback((name: unknown) => {
    const symbol = typeof name === 'string' && name.trim() ? name.trim() : '€';
    currencySymbolRef.current = symbol;
    setCurrencySymbol(symbol);
  }, []);

  const moneyValueFormatter = useCallback(({ value }: ValueFormatterParams<RowData, unknown>) => {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num) || Object.is(num, 0)) return '';
    return placeCurrencySymbol(currencyFormatter.format(num), currencySymbolRef.current);
  }, []);

  const formatMoneyTotal = useCallback((value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return placeCurrencySymbol(currencyFormatter.format(value), currencySymbol);
  }, [currencySymbol]);

  const columnDefs = useMemo<ColDef<RowData>[]>(() => {
    const hideCategory = layout === 'brand' || layout === 'brandPartNo';
    const hideBrand = layout === 'category';
    const isBrandPartNo = layout === 'brandPartNo';
    return [
      { field: 'OfferDetailID', hide: true, suppressColumnsToolPanel: true },
      { field: 'ProductID', hide: true, suppressColumnsToolPanel: true },
      { field: 'IsService', hide: true, suppressColumnsToolPanel: true },
      { field: 'IsOption', hide: true, suppressColumnsToolPanel: true },
      { field: 'IsPrintable', hide: true, suppressColumnsToolPanel: true },

      { field: 'CategoryName', headerName: 'Category', hide: hideCategory, suppressColumnsToolPanel: hideCategory},
      { field: 'BrandName', headerName: 'Brand', hide: hideBrand, suppressColumnsToolPanel: hideBrand },
      { field: 'PartNumber', headerName: 'Part No', hide: !isBrandPartNo, suppressColumnsToolPanel: !isBrandPartNo },
      { field: 'Quantity', headerName: 'Qty', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('Quantity'), valueFormatter: numberValueFormatter, aggFunc: 'sum', width: 110 },
      { field: 'TotalPrice', headerName: 'Total List', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalPrice'), valueFormatter: moneyValueFormatter, aggFunc: 'sum', width: 150 },
      { field: 'CustomerDiscount', headerName: 'Customer Discount', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('CustomerDiscount'), valueFormatter: percentValueFormatter, aggFunc: 'avg', width: 200 },
      { field: 'TotalNet', headerName: 'Total Net', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalNet'), valueFormatter: moneyValueFormatter, aggFunc: 'sum', width: 150 },
      { field: 'TelmacoDiscount', headerName: 'Telmaco Discount', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TelmacoDiscount'), valueFormatter: percentValueFormatter, aggFunc: 'avg', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' }, width: 180 },
      { field: 'Margin', headerName: 'Margin %', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('Margin'), valueFormatter: percentValueFormatter, aggFunc: 'avg', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' }, width: 150 },
      { field: 'GrossProfit', headerName: 'Gross Profit', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('GrossProfit'), valueFormatter: moneyValueFormatter, aggFunc: 'sum', cellClass: panelStyles.redDataCell, cellStyle: { color: '#dc2626' }, width: 150 },
      { field: 'TotalCost', headerName: 'Total Cost', filter: 'agNumberColumnFilter', valueGetter: numericFieldValueGetter('TotalCost'), valueFormatter: moneyValueFormatter, aggFunc: 'sum', cellClass: panelStyles.redDataCell, cellStyle: { color:'#dc2626' }, width : 150},
      {
        field: 'Installation',
        headerName: 'Installation (h)',
        hide: !isBrandPartNo,
        suppressColumnsToolPanel: !isBrandPartNo,
        filter: 'agNumberColumnFilter',
        valueGetter: numericFieldValueGetter('Installation'),
        valueSetter: (params: ValueSetterParams<RowData>) => {
          if (params.data) { (params.data as Record<string, unknown>).Installation = params.newValue; return true; }
          return false;
        },
        valueFormatter: numberValueFormatter,
        aggFunc: 'sum',
        editable: readOnly ? false : (params) => !params.node.group,
        cellStyle: (params) => params.node.group || readOnly ? null : { backgroundColor: '#f0fdf4' as string, cursor: 'text' as string },
        width: 160,
      },
      {
        field: 'ElInstalation',
        headerName: 'El Installation (h)',
        hide: !isBrandPartNo,
        suppressColumnsToolPanel: !isBrandPartNo,
        filter: 'agNumberColumnFilter',
        valueGetter: numericFieldValueGetter('ElInstalation'),
        valueSetter: (params: ValueSetterParams<RowData>) => {
          if (params.data) { (params.data as Record<string, unknown>).ElInstalation = params.newValue; return true; }
          return false;
        },
        valueFormatter: numberValueFormatter,
        aggFunc: 'sum',
        editable: readOnly ? false : (params) => !params.node.group,
        cellStyle: (params) => params.node.group || readOnly ? null : { backgroundColor: '#f0fdf4' as string, cursor: 'text' as string },
        width: 175,
      },
      {
        field: 'Commissioning',
        headerName: 'Commissioning (h)',
        hide: !isBrandPartNo,
        suppressColumnsToolPanel: !isBrandPartNo,
        filter: 'agNumberColumnFilter',
        valueGetter: numericFieldValueGetter('Commissioning'),
        valueSetter: (params: ValueSetterParams<RowData>) => {
          if (params.data) { (params.data as Record<string, unknown>).Commissioning = params.newValue; return true; }
          return false;
        },
        valueFormatter: numberValueFormatter,
        aggFunc: 'sum',
        editable: readOnly ? false : (params) => !params.node.group,
        cellStyle: (params) => params.node.group || readOnly ? null : { backgroundColor: '#f0fdf4' as string, cursor: 'text' as string },
        width: 185,
      },
    ];
  }, [layout, readOnly, moneyValueFormatter]);

  const fieldList = useMemo(
    () => Array.from(new Set(
      columnDefs
        .map((def) => (typeof def.field === 'string' ? def.field : null))
        .filter((field): field is string => Boolean(field)),
    )),
    [columnDefs],
  );
  const totals = useMemo(() => {
    const totalNetPrice = apiTotals?.totalNetPrice ?? 0;
    const totalListPrice = apiTotals?.totalListPrice ?? 0;
    const totalCost = apiTotals?.totalCost ?? 0;
    const totalInstallation = apiTotals?.totalInstallation ?? 0;
    const totalElInstalation = apiTotals?.totalElInstalation ?? 0;
    const totalCommissioning = apiTotals?.totalCommissioning ?? 0;
    const totalDiscount = totalListPrice - totalNetPrice;
    const discountPct = totalListPrice === 0 ? 0 : (totalDiscount / totalListPrice) * 100;
    const totalMargin = totalNetPrice === 0 ? 0 : ((totalNetPrice - totalCost) / totalNetPrice) * 100;
    return { totalNetPrice, totalListPrice, totalCost, totalMargin, totalDiscount, discountPct, totalInstallation, totalElInstalation, totalCommissioning };
  }, [apiTotals]);

  const applyLayout = useMemo(() => () => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;

    // brandPartNo uses plain row-grouping (no pivot mode) so leaf cells are editable.
    // Suppress the exit callback that fires when pivotMode goes false.
    if (layout === 'brandPartNo') {
      suppressPivotExitRef.current = true;
      api.setGridOption('pivotMode', false);
      window.setTimeout(() => { suppressPivotExitRef.current = false; }, 0);
    } else {
      api.setGridOption('pivotMode', true);
    }
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
      set('TotalPrice', { aggFunc: 'sum' });
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
      case 'brandPartNo': {
        set('BrandName', { rowGroup: true, rowGroupIndex: 0 });
        set('PartNumber', { rowGroup: true, rowGroupIndex: 1 });
        enableTotals();
        set('Installation', { aggFunc: 'sum' });
        set('ElInstalation', { aggFunc: 'sum' });
        set('Commissioning', { aggFunc: 'sum' });
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

  const handleCellDoubleClicked = useCallback((event: CellDoubleClickedEvent<RowData>) => {
    if (readOnly) return;
    if (layout !== 'brand' && layout !== 'brandPartNo') return;
    const { node, colDef } = event;
    if (!node.group || !colDef.field || !BULK_EDIT_FIELDS.has(colDef.field)) return;
    // For brandPartNo, only allow bulk edit on the top-level brand group (level 0)
    if (layout === 'brandPartNo' && node.level !== 0) return;
    const brandName = String(node.key ?? '').trim();
    if (!brandName) return;
    // AG Grid 'avg' aggFunc stores {count, value}; 'sum' stores a plain number
    const raw = event.value;
    const num = typeof raw === 'number' ? raw
      : (raw && typeof raw === 'object' && 'value' in raw && typeof (raw as { value: unknown }).value === 'number')
        ? (raw as { value: number }).value
        : 0;
    setBulkEditField(colDef.field as BulkEditField);
    setBulkEditBrand(brandName);
    setBulkEditValue(String(Math.round(num * 100) / 100));
    setBulkEditError(null);
    setBulkEditOpen(true);
  }, [layout, readOnly]);

  const EDITABLE_HOUR_FIELDS = useMemo(() => new Set(['Installation', 'ElInstalation', 'Commissioning']), []);

  const refreshPivotData = useCallback(() => {
    lastFetchSignatureRef.current = '';
    setLoading(true);
    const run = async () => {
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
          | { ok?: boolean; error?: string; rows?: RowData[]; rowCount?: number; totals?: Record<string, number>; offerCurrencyName?: string | null }
          | null;
        if (!res.ok || !payload?.ok) throw new Error(payload?.error ?? 'Failed to reload');
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        setRowData(rows);
        applyOfferCurrency(payload.offerCurrencyName);
        setRowCount(typeof payload.rowCount === 'number' ? payload.rowCount : rows.length);
        if (payload.totals) {
          const t = payload.totals;
          setApiTotals({
            totalListPrice: typeof t.totalListPrice === 'number' ? t.totalListPrice : 0,
            totalNetPrice: typeof t.totalNetPrice === 'number' ? t.totalNetPrice : 0,
            totalCost: typeof t.totalCost === 'number' ? t.totalCost : 0,
            totalInstallation: typeof t.totalInstallation === 'number' ? t.totalInstallation : 0,
            totalElInstalation: typeof t.totalElInstalation === 'number' ? t.totalElInstalation : 0,
            totalCommissioning: typeof t.totalCommissioning === 'number' ? t.totalCommissioning : 0,
          });
        }
      } catch {
        showToastMessage('Unable to reload pivot data.', 'error');
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, [endpoint, fieldList, quickSearch?.value, applyOfferCurrency]);

  const HOUR_FIELD_LABELS: Record<string, string> = useMemo(() => ({
    Installation: 'Installation',
    ElInstalation: 'El. Installation',
    Commissioning: 'Commissioning',
  }), []);

  const HOUR_FIELD_TOTAL_KEYS: Record<string, keyof NonNullable<typeof apiTotals>> = useMemo(() => ({
    Installation: 'totalInstallation',
    ElInstalation: 'totalElInstalation',
    Commissioning: 'totalCommissioning',
  }), []);

  const handleCellValueChanged = useCallback(async (event: CellValueChangedEvent<RowData>) => {
    const { data, colDef, newValue, oldValue } = event;
    if (!data || !colDef.field || !EDITABLE_HOUR_FIELDS.has(colDef.field)) return;
    const offerDetailId = typeof data.OfferDetailID === 'number' ? data.OfferDetailID : null;
    if (offerDetailId == null) return;
    const parsed = newValue === '' || newValue == null ? null : Number(newValue);
    const valueToSave = parsed != null && Number.isFinite(parsed) ? parsed : null;
    const fieldLabel = HOUR_FIELD_LABELS[colDef.field] ?? colDef.field;
    const totalKey = HOUR_FIELD_TOTAL_KEYS[colDef.field];
    try {
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: [{ OfferDetailID: offerDetailId, [colDef.field]: valueToSave }],
        }),
      });
      if (!res.ok) throw new Error('Save failed');
      showToastMessage(`${fieldLabel} updated`, 'success');
      // Update bottom totals bar locally — avoids a full data re-fetch that would collapse groups
      if (totalKey) {
        const qty = toFiniteNumber((data as Record<string, unknown>).Quantity) ?? 0;
        const oldVal = toFiniteNumber(oldValue) ?? 0;
        const newVal = valueToSave ?? 0;
        const delta = qty * (newVal - oldVal);
        if (delta !== 0) {
          setApiTotals((prev) => prev ? { ...prev, [totalKey]: (prev[totalKey] ?? 0) + delta } : prev);
        }
      }
    } catch {
      showToastMessage('Failed to save change. Please try again.', 'error');
      refreshPivotData();
    }
  }, [endpoint, EDITABLE_HOUR_FIELDS, HOUR_FIELD_LABELS, HOUR_FIELD_TOTAL_KEYS, refreshPivotData]);

  const confirmBulkEdit = useCallback(async () => {
    const valueNumber = Number(bulkEditValue);
    if (!Number.isFinite(valueNumber)) {
      setBulkEditError('Please enter a valid number.');
      return;
    }
    if (bulkEditField === 'Margin' && (valueNumber < -100 || valueNumber > 100)) {
      setBulkEditError('Margin must be between -100 and 100.');
      return;
    }
    setBulkEditSaving(true);
    setBulkEditError(null);
    try {
      // Fetch all OfferDetailIDs for this brand
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            allRows: true,
            view: 'pivot',
            filterModel: {
              BrandName: { filterType: 'text', type: 'equals', filter: bulkEditBrand },
            },
          },
          fields: ['OfferDetailID'],
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; rows?: RowData[] }
        | null;
      if (!res.ok || !payload?.ok) throw new Error('Failed to fetch brand rows.');
      const ids = (payload.rows ?? [])
        .map((r) => r.OfferDetailID)
        .filter((id): id is number => typeof id === 'number');
      if (ids.length === 0) {
        setBulkEditError('No products found for this brand.');
        return;
      }
      // Batch PATCH updates
      const chunkSize = 200;
      for (let idx = 0; idx < ids.length; idx += chunkSize) {
        const chunk = ids.slice(idx, idx + chunkSize);
        const updates = chunk.map((OfferDetailID) => ({
          OfferDetailID,
          [bulkEditField]: valueNumber,
        }));
        const patchRes = await fetch(endpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });
        if (!patchRes.ok) throw new Error('Failed to apply updates.');
      }
      showToastMessage(
        `${BULK_EDIT_LABELS[bulkEditField]} updated for ${bulkEditBrand} (${ids.length} items)`,
        'success',
      );
      setBulkEditOpen(false);
      refreshPivotData();
      onDataChanged?.();
    } catch (err) {
      setBulkEditError(err instanceof Error ? err.message : 'Update failed.');
    } finally {
      setBulkEditSaving(false);
    }
  }, [bulkEditBrand, bulkEditField, bulkEditValue, endpoint, onDataChanged, refreshPivotData]);

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
          | { ok?: boolean; error?: string; rows?: RowData[]; rowCount?: number; totals?: Record<string, number>; offerCurrencyName?: string | null }
          | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to load pivot data (status ${res.status})`);
        }
        if (cancelled) return;
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        setRowData(rows);
        applyOfferCurrency(payload.offerCurrencyName);
        setRowCount(typeof payload.rowCount === 'number' ? payload.rowCount : rows.length);
        if (payload.totals) {
          const t = payload.totals;
          setApiTotals({
            totalListPrice: typeof t.totalListPrice === 'number' ? t.totalListPrice : 0,
            totalNetPrice: typeof t.totalNetPrice === 'number' ? t.totalNetPrice : 0,
            totalCost: typeof t.totalCost === 'number' ? t.totalCost : 0,
            totalInstallation: typeof t.totalInstallation === 'number' ? t.totalInstallation : 0,
            totalElInstalation: typeof t.totalElInstalation === 'number' ? t.totalElInstalation : 0,
            totalCommissioning: typeof t.totalCommissioning === 'number' ? t.totalCommissioning : 0,
          });
        }
      } catch (err) {
        console.error('Failed to load pivot data', err);
        if (!cancelled) {
          setRowData([]);
          setRowCount(null);
          setApiTotals(null);
        }
        showToastMessage('Unable to load pivot data. Please try again.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
      lastFetchSignatureRef.current = '';
    };
  }, [endpoint, fieldList, offerId, refreshToken, quickSearch?.value, applyOfferCurrency]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    api.setGridOption('quickFilterText', quickSearch?.value ?? '');
  }, [quickSearch?.value]);

  // Re-run money value formatters when the offer currency symbol changes.
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    api.refreshCells({ force: true });
  }, [currencySymbol]);

  const defaultColDef = useMemo<ColDef<RowData>>(() => ({
    sortable: true,
    filter: true,
    resizable: true,
    enableRowGroup: true,
    enablePivot: true,
    enableValue: true,
    flex: 0,
    filterParams: {
      buttons: ['reset'],
      maxNumConditions: 2,
      alwaysShowBothConditions: true,
      defaultJoinOperator: 'AND',
    },
  }), []);

  const getRowClass = useCallback((params: RowClassParams<RowData>) => {
    // AG Grid group rows (Brand/PartNo header rows) — no extra class
    if (params.node.group) return undefined;
    const d = params.data as Record<string, unknown> | null | undefined;
    if (!d) return undefined;
    const isService = d.IsService === 1 || d.IsService === true || d.IsService === '1';
    const isPrintable = d.IsPrintable === 1 || d.IsPrintable === true || d.IsPrintable === '1';
    const isOption = d.IsOption === 1 || d.IsOption === true || d.IsOption === '1';
    if (isService) {
      return isPrintable ? 'offer-row offer-row--printable-service' : 'offer-row offer-row--nonprintable-service';
    }
    if (isOption) return 'offer-row offer-row--option';
    return undefined;
  }, []);

  const onGridReady = useMemo(() => (e: GridReadyEvent<RowData>) => {
    gridApiRef.current = e.api;
    e.api.setSideBarVisible(true);
    e.api.closeToolPanel();
    // brandPartNo uses plain row-grouping (not pivot mode) so leaf cells are editable
    e.api.setGridOption('pivotMode', layout !== 'brandPartNo');
    e.api.setGridOption('quickFilterText', quickSearch?.value ?? '');
    setGridReady(true);
  }, [layout, quickSearch?.value]);

  const handlePivotModeChanged = useMemo(() => (e: ColumnPivotModeChangedEvent<RowData>) => {
    if (suppressPivotExitRef.current) return;
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
            popupParent={typeof document !== 'undefined' ? document.body : undefined}
            rowHeight={32}
            headerHeight={38}
            rowModelType="clientSide"
            getRowClass={getRowClass}
            onCellDoubleClicked={handleCellDoubleClicked}
            onCellValueChanged={readOnly ? undefined : (e) => { void handleCellValueChanged(e); }}
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
            groupRemoveLowestSingleChildren={layout === 'brandPartNo'}
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
          <span className={panelStyles.totalLabel}>Total List:</span>
          <span className={panelStyles.totalValue}>{formatMoneyTotal(totals.totalListPrice)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total Discount:</span>
          <span className={panelStyles.totalValue}>
            {formatMoneyTotal(totals.totalDiscount)}
            {Number.isFinite(totals.discountPct) && totals.discountPct !== 0
              ? ` (${percentFormatter.format(totals.discountPct)} %)`
              : null}
          </span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total Net:</span>
          <span className={panelStyles.totalValue}>{formatMoneyTotal(totals.totalNetPrice)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total Cost:</span>
          <span className={panelStyles.totalValue}>{formatMoneyTotal(totals.totalCost)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Total Margin:</span>
          <span className={panelStyles.totalValue}>{formatPercentTotal(floorTo(totals.totalMargin, 2))}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Installation:</span>
          <span className={panelStyles.totalValue}>{formatHoursTotal(totals.totalInstallation)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>El. Installation:</span>
          <span className={panelStyles.totalValue}>{formatHoursTotal(totals.totalElInstalation)}</span>
        </div>
        <div className={panelStyles.totalItem}>
          <span className={panelStyles.totalLabel}>Commissioning:</span>
          <span className={panelStyles.totalValue}>{formatHoursTotal(totals.totalCommissioning)}</span>
        </div>
      </div>
      <LookupModal
        open={bulkEditOpen}
        title={`Set ${BULK_EDIT_LABELS[bulkEditField]} for "${bulkEditBrand}"`}
        onClose={() => setBulkEditOpen(false)}
        onConfirm={confirmBulkEdit}
        confirmLabel="Apply"
        saving={bulkEditSaving}
        error={bulkEditError}
      >
        <p style={{ margin: '0 0 12px', color: '#64748b', fontSize: '0.9rem' }}>
          This will update <strong>{BULK_EDIT_LABELS[bulkEditField]}</strong> for all products
          of brand <strong>{bulkEditBrand}</strong> in this offer.
        </p>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.9rem' }}>
          {BULK_EDIT_LABELS[bulkEditField]} (%)
          <input
            type="number"
            step="any"
            value={bulkEditValue}
            onChange={(e) => setBulkEditValue(e.target.value)}
            autoFocus
            style={{
              padding: '6px 8px',
              border: '1px solid #cbd5e1',
              borderRadius: 4,
              fontSize: '0.9rem',
              width: '100%',
            }}
          />
        </label>
      </LookupModal>
    </div>
  );
}
