"use client";

import React, { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  IRowNode,
  MenuItemDef,
} from 'ag-grid-community';
import PageHeader from '../components/PageHeader';
import { GridQuickSearchProvider } from '../components/GridQuickSearchProvider';
import { formatDateTime } from '../lib/formatDateTime';
import { showToastMessage } from '../../lib/toast';
import { openLinkInNewTab } from '../../lib/navigation';
import styles from './OfferDetailsClient.module.css';

const viewInOfferMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  </span>
`;

const viewProductDetailsMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';
const viewBrandDetailsMenuIcon = '<span class="fastquote-menu-icon" aria-hidden="true" style="display:flex;align-items:center;justify-content:center;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>';

const viewPriceListMenuIcon = `
  <span class="fastquote-menu-icon" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="5" y="2" width="14" height="20" rx="2" />
      <path d="M9 7h6M9 11h6M9 15h4" />
    </svg>
  </span>
`;

type MarketOption = { market: string; division: string };

type GroupOptions = {
  brands: string[];
  salesDivisions: string[];
  markets: MarketOption[];
  fwcProjects: string[];
};

type GroupFilters = {
  BrandName: string;
  SalesDivision: string;
  SalesMarket: string;
  ERPFWCProjectShortName: string;
};

const EMPTY_FILTERS: GroupFilters = {
  BrandName: '',
  SalesDivision: '',
  SalesMarket: '',
  ERPFWCProjectShortName: '',
};

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeOriginValue = (value: unknown): string | null => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const AgGridAll = dynamic(() => import('../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading grid…
    </div>
  ),
});

const AgGridSummary = dynamic(() => import('./OfferedProductsSummaryGrid'), {
  ssr: false,
  loading: () => <div className={styles.loading}>Loading summary…</div>,
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
  const router = useRouter();
  const [pivotMode, setPivotMode] = useState(false);
  const [options, setOptions] = useState<GroupOptions>({ brands: [], salesDivisions: [], markets: [], fwcProjects: [] });
  const [filters, setFilters] = useState<GroupFilters>(EMPTY_FILTERS);
  const [brandSearch, setBrandSearch] = useState('');
  const [showBrandList, setShowBrandList] = useState(false);

  // Fetch dropdown options once
  useEffect(() => {
    void fetch('/api/offered-products/options')
      .then(r => r.json())
      .then((data: { ok?: boolean; brands?: string[]; salesDivisions?: string[]; markets?: MarketOption[]; fwcProjects?: string[] }) => {
        if (data.ok) {
          setOptions({
            brands: data.brands ?? [],
            salesDivisions: data.salesDivisions ?? [],
            markets: data.markets ?? [],
            fwcProjects: data.fwcProjects ?? [],
          });
        }
      })
      .catch(() => { /* silent */ });
  }, []);

  const togglePivotMode = useCallback(() => {
    setPivotMode(prev => {
      if (prev) {
        // clear pre-filters on close
        setFilters(EMPTY_FILTERS);
        setBrandSearch('');
      }
      return !prev;
    });
  }, []);

  const handleFilterChange = useCallback((key: keyof GroupFilters, value: string) => {
    // Return the same object when nothing changed so the summary effect
    // doesn't refetch on every keystroke in the brand combobox.
    setFilters(prev => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);

  // ── Pivot summary data ─────────────────────────────────────────────────────
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryData, setSummaryData] = useState<Record<string, unknown>[] | null>(null);

  const fetchSummary = useCallback((currentFilters: GroupFilters) => {
    setSummaryLoading(true);
    const qs = new URLSearchParams();
    if (currentFilters.BrandName)              qs.set('brand',    currentFilters.BrandName);
    if (currentFilters.SalesDivision)          qs.set('division', currentFilters.SalesDivision);
    if (currentFilters.SalesMarket)            qs.set('market',   currentFilters.SalesMarket);
    if (currentFilters.ERPFWCProjectShortName) qs.set('fwc',      currentFilters.ERPFWCProjectShortName);
    void fetch(`/api/offered-products/summary${qs.toString() ? `?${qs}` : ''}`)
      .then(r => r.json())
      .then((data: { ok?: boolean; rows?: Record<string, unknown>[] }) => {
        if (data.ok) setSummaryData(data.rows ?? []);
      })
      .catch(() => { /* silent */ })
      .finally(() => setSummaryLoading(false));
  }, []);

  // Fetch summary when pivot mode opens and whenever pre-filters change while open
  useEffect(() => {
    if (pivotMode) fetchSummary(filters);
  }, [filters, pivotMode, fetchSummary]);

  // Excel-style pivot. Default layout: rows Customer → Offer Description → Offer
  // Date, columns by Status, values Sum of Qty / Sum of Total List. Every field
  // from the main Offered Products grid is exposed here and is draggable in the
  // columns tool panel (rows / column labels / values), so the user can build any
  // pivot like Excel's PivotTable Fields.
  const summaryColDefs = useMemo((): ColDef[] => {
    const dimension: ColDef = { enableRowGroup: true, enablePivot: true, filter: 'agSetColumnFilter' };
    const euro = (p: { value: unknown }) =>
      p.value == null || p.value === '' ? '' : `${formatNumber(p.value)} €`;
    const num = (p: { value: unknown }) => formatNumber(p.value);
    const pct = (p: { value: unknown }) => formatPercent(p.value);
    // Measures are draggable into the Values area (enableValue). Only Qty and
    // Total List carry a default aggFunc so they're active out of the box; every
    // other measure stays available and picks up an agg function when the user
    // drags it in (default sum — switch to avg for unit prices / percentages).
    const measure: ColDef = { enableValue: true, type: 'numericColumn', width: 140, filter: 'agNumberColumnFilter' };
    const euroMeasure: ColDef = { ...measure, valueFormatter: euro };
    const numMeasure: ColDef = { ...measure, valueFormatter: num };
    const pctMeasure: ColDef = { ...measure, valueFormatter: pct };
    return [
      // ── Dimensions: drag into Rows or Column Labels ──
      { ...dimension, field: 'CustomerName',           headerName: 'Customer',           rowGroup: true },
      { ...dimension, field: 'CustomerGroup',          headerName: 'Customer Group' },
      { ...dimension, field: 'OfferID',                headerName: 'Offer ID' },
      { ...dimension, field: 'OfferDescription',       headerName: 'Offer Description',  rowGroup: true },
      { ...dimension, field: 'OfferTitle',             headerName: 'Offer Title' },
      { ...dimension, field: 'OfferVersion',           headerName: 'Version' },
      { ...dimension, field: 'OfferStatus',            headerName: 'Status',             pivot: true },
      { ...dimension, field: 'OfferDate',              headerName: 'Offer Date',         rowGroup: true },
      { ...dimension, field: 'OfferDeadlineDate',      headerName: 'Offer Due Date' },
      { ...dimension, field: 'SalesDivision',          headerName: 'Sales Division' },
      { ...dimension, field: 'SalesMarket',            headerName: 'Market' },
      { ...dimension, field: 'ERPFWCProjectShortName', headerName: 'FWC Project' },
      { ...dimension, field: 'ERPProjectCode',         headerName: 'ERP Project Code' },
      { ...dimension, field: 'BrandName',              headerName: 'Brand' },
      { ...dimension, field: 'PartNumber',             headerName: 'Part Number' },
      { ...dimension, field: 'ModelNumber',            headerName: 'Model Number' },
      { ...dimension, field: 'ProductDescription',     headerName: 'Product Description' },
      { ...dimension, field: 'Origin',                 headerName: 'Origin' },
      { ...dimension, field: 'Delivery',               headerName: 'Delivery' },
      { ...dimension, field: 'OtherCurrencyName',      headerName: 'Currency' },
      { ...dimension, field: 'CreatedOn',              headerName: 'Created' },
      { ...dimension, field: 'ModifiedOn',             headerName: 'Modified' },
      // ── Measures: drag into Values ──
      { ...measure,     field: 'Quantity',             headerName: 'Total Qty', aggFunc: 'sum', width: 120 },
      { ...euroMeasure, field: 'ListPrice',            headerName: 'List Price' },
      { ...euroMeasure, field: 'TotalPrice',           headerName: 'Total List', aggFunc: 'sum' },
      { ...pctMeasure,  field: 'CustomerDiscount',     headerName: 'Cust. Discount' },
      { ...euroMeasure, field: 'NetUnitPrice',         headerName: 'Net Unit Price' },
      { ...euroMeasure, field: 'TotalNet',             headerName: 'Total Net' },
      { ...numMeasure,  field: 'Warranty',             headerName: 'Warranty' },
      { ...pctMeasure,  field: 'Probability',          headerName: 'Probability' },
      // ── Cost / margin measures (red, like the main grid) ──
      { ...pctMeasure,  field: 'TelmacoDiscount',      headerName: 'Telmaco Discount',       cellStyle: redCellStyle },
      { ...euroMeasure, field: 'NetCostOtherCurrency', headerName: 'Net Cost (Other Curr.)', cellStyle: redCellStyle },
      { ...numMeasure,  field: 'CurrencyCostModifier', headerName: 'Cost Modifier',          cellStyle: redCellStyle },
      { ...euroMeasure, field: 'NetCost',              headerName: 'Net Cost',               cellStyle: redCellStyle },
      { ...euroMeasure, field: 'TotalCost',            headerName: 'Total Cost',             cellStyle: redCellStyle },
      { ...pctMeasure,  field: 'Margin',               headerName: 'Margin',                 cellStyle: redCellStyle },
      { ...euroMeasure, field: 'GrossProfit',          headerName: 'Gross Profit',           cellStyle: redCellStyle },
      { ...numMeasure,  field: 'TelmacoWarranty',      headerName: 'Telmaco Warranty',       cellStyle: redCellStyle },
    ];
  }, []);

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
      field: 'ERPFWCProjectShortName',
      headerName: 'ERP FWC Project',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 150,
    },
    {
      field: 'ERPProjectCode',
      headerName: 'ERP Project Code',
      filter: 'agTextColumnFilter',
      width: 150,
    },
    {
      field: 'OfferDescription',
      headerName: 'Offer Description',
      filter: 'agTextColumnFilter',
      minWidth: 180,
    },
    {
      field: 'SalesDivision',
      headerName: 'Sales Division',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 140,
    },
    {
      field: 'SalesMarket',
      headerName: 'Market',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 130,
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
      field: 'OfferDeadlineDate',
      headerName: 'Offer Due Date',
      filter: 'agDateColumnFilter',
      valueFormatter: (params) => formatDateDMY(params.value),
      width: 140,
      filterParams: { browserDatePicker: false, minValidYear: 2000 },
    },
    {
      field: 'Probability',
      headerName: 'Probability',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => formatPercent(params.value),
      width: 120,
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
      field: 'BrandName',
      headerName: 'Brand',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 130,
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
      aggFunc: 'sum',
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
      field: 'TotalPrice',
      headerName: 'Total Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      aggFunc: 'sum',
      valueFormatter: (params) => formatNumber(params.value),
      width: 120,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Cust. Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      aggFunc: 'avg',
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
      field: 'TotalNet',
      headerName: 'Total Net',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      aggFunc: 'sum',
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
      field: 'Origin',
      headerName: 'Origin',
      filter: 'agTextColumnFilter',
      enableRowGroup: true,
      width: 130,
      editable: (params) => normalizeProductId((params.data as { ProductID?: unknown } | null | undefined)?.ProductID ?? null) != null,
      valueParser: (params) => normalizeOriginValue(params.newValue),
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
      aggFunc: 'avg',
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
        if (!currencyName) return '';
        const formatted = num.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        return currencyName === '$' || currencyName === '£' ? `${currencyName} ${formatted}` : `${formatted} ${currencyName}`;
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
        if (!currencyName) return '';
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
      field: 'TotalCost',
      headerName: 'Total Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      aggFunc: 'sum',
      valueFormatter: (params) => formatNumber(params.value),
      cellStyle: redCellStyle,
      width: 120,
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      aggFunc: 'avg',
      valueFormatter: (params) => formatPercent(params.value),
      cellStyle: redCellStyle,
      width: 110,
    },
    {
      field: 'GrossProfit',
      headerName: 'Gross Profit',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      aggFunc: 'sum',
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

  const handleCellValueChanged = useCallback(
    (event: CellValueChangedEvent<Record<string, unknown>>) => {
      const field = typeof event.colDef?.field === 'string' ? event.colDef.field : null;
      if (field !== 'Origin') return;
      const source = (event as { source?: string }).source;
      if (source === 'api') return;

      const oldValue = normalizeOriginValue(event.oldValue ?? null);
      const newValue = normalizeOriginValue(event.newValue ?? null);
      if (oldValue === newValue) return;

      const revertValue = () => {
        try {
          (event.node as IRowNode<Record<string, unknown>> | null | undefined)?.setDataValue?.(field, oldValue);
        } catch {
          /* noop */
        }
      };

      const productId = normalizeProductId((event.data as { ProductID?: unknown } | null | undefined)?.ProductID ?? null);
      if (productId == null) {
        showToastMessage('Unable to update origin. Missing product id.', 'error');
        revertValue();
        return;
      }

      void (async () => {
        try {
          const res = await fetch(`/api/products/${encodeURIComponent(String(productId))}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ origin: newValue }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payload?.ok) {
            throw new Error(payload?.error ?? `Failed to update origin (status ${res.status})`);
          }
          showToastMessage('Origin updated', 'success');
          event.api?.refreshServerSide?.({ purge: false });
        } catch (err) {
          console.error('Failed to update origin', err);
          showToastMessage(
            err instanceof Error ? err.message : 'Unable to update origin. Please try again.',
            'error',
          );
          revertValue();
        }
      })();
    },
    [],
  );

  const getContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<Record<string, unknown>>) => {
      const rowData = params.node?.data as Record<string, unknown> | null | undefined;
      const offerId = normalizeOfferId(
        (rowData as { OfferID?: unknown } | null | undefined)?.OfferID ?? null,
      );
      if (offerId == null) {
        return ['export'];
      }

      const items: Array<MenuItemDef<Record<string, unknown>> | string> = [];

      // View product details
      const productId = normalizeProductId(
        (rowData as { ProductID?: unknown } | null | undefined)?.ProductID ?? null,
      );
      if (productId != null) {
        items.push({
          name: 'View Product Details',
          icon: viewProductDetailsMenuIcon,
          action: () => {
            openLinkInNewTab(`/products/${encodeURIComponent(String(productId))}/details`);
          },
        });
      }

      // View brand details
      const rawBrandId = (rowData as { BrandID?: unknown } | null | undefined)?.BrandID ?? null;
      const brandId = typeof rawBrandId === 'number'
        ? rawBrandId
        : typeof rawBrandId === 'string'
          ? Number.parseInt(rawBrandId, 10)
          : null;
      if (brandId != null && Number.isInteger(brandId) && brandId > 0) {
        items.push({
          name: 'View Brand Details',
          icon: viewBrandDetailsMenuIcon,
          action: () => {
            openLinkInNewTab(`/brands/${encodeURIComponent(String(brandId))}/details`);
          },
        });
      }

      // View product in price list
      const rawPriceListId = (rowData as { PriceListID?: unknown } | null | undefined)?.PriceListID ?? null;
      const priceListId = typeof rawPriceListId === 'number'
        ? rawPriceListId
        : typeof rawPriceListId === 'string'
          ? Number.parseInt(rawPriceListId, 10)
          : null;
      if (priceListId != null && Number.isInteger(priceListId) && priceListId > 0) {
        const qs = new URLSearchParams();
        const partNumber = typeof (rowData as { PartNumber?: unknown })?.PartNumber === 'string'
          ? String((rowData as { PartNumber?: unknown }).PartNumber).trim()
          : '';
        const description = typeof (rowData as { ProductDescription?: unknown })?.ProductDescription === 'string'
          ? String((rowData as { ProductDescription?: unknown }).ProductDescription).trim()
          : '';
        if (partNumber) qs.set('partNumber', partNumber);
        if (description) qs.set('description', description);
        const qsStr = qs.toString();
        items.push({
          name: 'View Product in Price List',
          icon: viewPriceListMenuIcon,
          action: () => {
            openLinkInNewTab(
              `/price-lists/${encodeURIComponent(String(priceListId))}/products${qsStr ? `?${qsStr}` : ''}`,
            );
          },
        });
      }

      // View in offer
      items.push({
        name: 'View in Offer',
        icon: viewInOfferMenuIcon,
        action: () => {
          router.push(`/offers/${encodeURIComponent(String(offerId))}/products`);
        },
      });

      items.push('separator', 'export');
      return items;
    },
    [router],
  );

  // Markets filtered by selected division
  const filteredMarkets = filters.SalesDivision
    ? options.markets.filter(m => m.division === filters.SalesDivision)
    : options.markets;

  // Filtered brand suggestions
  const brandSuggestions = brandSearch.trim()
    ? options.brands.filter(b => b.toLowerCase().includes(brandSearch.toLowerCase()))
    : options.brands;

  const pivotModeButton = (
    <button
      type="button"
      className={`${pivotMode ? styles.groupBtnActive : styles.groupBtn} page-header-button`}
      onClick={togglePivotMode}
    >
      Pivot Mode
    </button>
  );

  const headerActions = pivotMode ? (
    <div className={styles.headerActions}>
      {/* Brand — custom combobox */}
      <div className={styles.brandCombo}>
        <input
          autoComplete="off"
          className={`${styles.groupSelect} page-header-button`}
          placeholder="Brand: All"
          value={brandSearch}
          style={{ width: 160, paddingRight: 10 }}
          aria-label="Brand"
          onChange={e => {
            setBrandSearch(e.target.value);
            setShowBrandList(true);
            // clear filter while typing; set when user picks from list
            handleFilterChange('BrandName', '');
          }}
          onFocus={() => setShowBrandList(true)}
          onBlur={() => {
            // slight delay so click on option registers first
            setTimeout(() => {
              setShowBrandList(false);
              // if text doesn't match a brand exactly, clear it
              const match = options.brands.find(b => b.toLowerCase() === brandSearch.toLowerCase());
              if (!match) {
                setBrandSearch('');
                handleFilterChange('BrandName', '');
              } else {
                setBrandSearch(match);
                handleFilterChange('BrandName', match);
              }
            }, 150);
          }}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter' && brandSuggestions.length > 0) {
              const pick = brandSuggestions[0];
              setBrandSearch(pick);
              handleFilterChange('BrandName', pick);
              setShowBrandList(false);
            } else if (e.key === 'Escape') {
              setShowBrandList(false);
            }
          }}
        />
        {showBrandList && brandSuggestions.length > 0 && (
          <div className={styles.brandList}>
            {brandSuggestions.map(v => (
              <button
                key={v}
                type="button"
                className={styles.brandOption}
                onMouseDown={e => e.preventDefault()}
                onClick={() => {
                  setBrandSearch(v);
                  handleFilterChange('BrandName', v);
                  setShowBrandList(false);
                }}
              >
                {v}
              </button>
            ))}
          </div>
        )}
      </div>

      <select
        className={`${styles.groupSelect} page-header-button`}
        value={filters.SalesDivision}
        onChange={e => {
          handleFilterChange('SalesDivision', e.target.value);
          // Clear market when division changes
          handleFilterChange('SalesMarket', '');
        }}
        aria-label="Sales Division"
      >
        <option value="">Division: All</option>
        {options.salesDivisions.map(v => <option key={v} value={v}>{v}</option>)}
      </select>

      <select
        className={`${styles.groupSelect} page-header-button`}
        value={filters.SalesMarket}
        onChange={e => handleFilterChange('SalesMarket', e.target.value)}
        aria-label="Market"
      >
        <option value="">Market: All</option>
        {filteredMarkets.map(m => (
          <option key={`${m.market}|${m.division}`} value={m.market}>
            {m.division ? `${m.market} - ${m.division}` : m.market}
          </option>
        ))}
      </select>

      <select
        className={`${styles.groupSelect} page-header-button`}
        value={filters.ERPFWCProjectShortName}
        onChange={e => handleFilterChange('ERPFWCProjectShortName', e.target.value)}
        aria-label="FWC Project"
      >
        <option value="">FWC: All</option>
        {options.fwcProjects.map(v => <option key={v} value={v}>{v}</option>)}
      </select>
    </div>
  ) : null;

  return (
    <main className={styles.page}>
      <PageHeader title="Offered Products" afterSearchActions={pivotModeButton} rightActions={headerActions}>
        <GridQuickSearchProvider>
          <div className={`${styles.gridFrame} fq-grid-panel`} style={pivotMode ? { display: 'none' } : undefined}>
            <AgGridAll
              endpoint="/api/offered-products"
              columnDefs={columnDefs}
              rowGroupPanelShow="never"
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
              onCellValueChanged={handleCellValueChanged}
              getContextMenuItems={getContextMenuItems}
            />
          </div>
          {pivotMode && (
            <div
              className={`${styles.gridFrame} fq-grid-panel`}
              style={{ opacity: summaryLoading && summaryData ? 0.65 : 1, transition: 'opacity 120ms ease' }}
            >
              {!summaryData ? (
                <div className={styles.loading}>Loading summary…</div>
              ) : (
                <AgGridSummary
                  containerClassName={styles.pivotShell}
                  columnDefs={summaryColDefs}
                  rowData={summaryData}
                  pivotMode
                  groupDisplayType="multipleColumns"
                  // Flatten the row-group hierarchy: instead of a staircase where
                  // each grouped field (Brand, Part Number, Model Number, …) sits on
                  // its own indented row, the leaf row shows every group column on a
                  // single line — so a product reads like one row in the normal offer
                  // grid rather than a 6-level drill-down.
                  groupHideOpenParents
                  groupDefaultExpanded={1}
                  suppressAggFuncInHeader
                  pivotRowTotals="after"
                  grandTotalRow="bottom"
                  groupTotalRow={(params) => (params.node.level === 0 ? 'bottom' : undefined)}
                  autoGroupColumnDef={{ minWidth: 170, resizable: true }}
                  sideBar={{
                    toolPanels: ['columns', 'filters'],
                    defaultToolPanel: 'columns',
                  }}
                />
              )}
            </div>
          )}
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
