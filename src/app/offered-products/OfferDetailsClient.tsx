"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import type {
  CellValueChangedEvent,
  ColDef,
  GetContextMenuItemsParams,
  GridApi,
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

const FILTER_TO_COLUMN: Record<keyof GroupFilters, string> = {
  BrandName: 'BrandName',
  SalesDivision: 'SalesDivision',
  SalesMarket: 'SalesMarket',
  ERPFWCProjectShortName: 'ERPFWCProjectShortName',
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
  const gridApiRef = useRef<GridApi | null>(null);
  const [groupMode, setGroupMode] = useState(false);
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

  const handleGridReady = useCallback((api: GridApi) => {
    gridApiRef.current = api;
  }, []);

  // Apply filters whenever filters or mode changes (no row grouping — just flat filtered rows)
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;

    const currentModel = api.getFilterModel() as Record<string, unknown>;
    const newModel: Record<string, unknown> = { ...currentModel };

    // Remove all group-dimension filters first
    Object.values(FILTER_TO_COLUMN).forEach(colId => delete newModel[colId]);

    if (groupMode) {
      // Re-add only selected values
      (Object.entries(filters) as [keyof GroupFilters, string][]).forEach(([key, val]) => {
        if (val) {
          newModel[FILTER_TO_COLUMN[key]] = { filterType: 'text', type: 'equals', filter: val };
        }
      });
    }

    api.setFilterModel(newModel);
  }, [groupMode, filters]);

  const toggleGroupMode = useCallback(() => {
    setGroupMode(prev => {
      if (prev) setFilters(EMPTY_FILTERS); // clear on close
      return !prev;
    });
  }, []);

  const handleFilterChange = useCallback((key: keyof GroupFilters, value: string) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, []);

  // ── Summary / Totals mode ──────────────────────────────────────────────────
  const [summaryMode, setSummaryMode] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryData, setSummaryData] = useState<{ statuses: string[]; rows: Record<string, unknown>[] } | null>(null);

  const fetchSummary = useCallback((currentFilters: GroupFilters) => {
    setSummaryLoading(true);
    const qs = new URLSearchParams();
    if (currentFilters.BrandName)              qs.set('brand',    currentFilters.BrandName);
    if (currentFilters.SalesDivision)          qs.set('division', currentFilters.SalesDivision);
    if (currentFilters.SalesMarket)            qs.set('market',   currentFilters.SalesMarket);
    if (currentFilters.ERPFWCProjectShortName) qs.set('fwc',      currentFilters.ERPFWCProjectShortName);
    void fetch(`/api/offered-products/summary${qs.toString() ? `?${qs}` : ''}`)
      .then(r => r.json())
      .then((data: { ok?: boolean; statuses?: string[]; rows?: Record<string, unknown>[] }) => {
        if (data.ok) setSummaryData({ statuses: data.statuses ?? [], rows: data.rows ?? [] });
      })
      .catch(() => { /* silent */ })
      .finally(() => setSummaryLoading(false));
  }, []);

  const toggleSummaryMode = useCallback(() => {
    setSummaryMode(prev => {
      if (!prev) fetchSummary(filters);
      return !prev;
    });
  }, [fetchSummary, filters]);

  // Re-fetch summary when filters change while summary is open
  useEffect(() => {
    if (summaryMode) fetchSummary(filters);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, summaryMode]);

  const summaryColDefs = useMemo((): ColDef[] => {
    if (!summaryData) return [];
    return [
      { field: 'PartNumber',         headerName: 'Part Number',         minWidth: 160, pinned: 'left' as const },
      { field: 'ProductDescription', headerName: 'Product Description', minWidth: 220, pinned: 'left' as const },
      { field: 'CustomerName',       headerName: 'Customer',            minWidth: 200 },
      ...summaryData.statuses.map(s => ({
        field: s,
        headerName: s,
        type: 'numericColumn' as const,
        width: 160,
        valueFormatter: (p: { value: unknown }) => (p.value == null || Number(p.value) === 0 ? '' : String(p.value)),
      })),
      {
        field: 'GrandTotal',
        headerName: 'Grand Total',
        type: 'numericColumn' as const,
        width: 130,
        cellStyle: { fontWeight: 600 },
      },
    ];
  }, [summaryData]);

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
      field: 'ERPProjectCode',
      headerName: 'ERP Project Code',
      filter: 'agTextColumnFilter',
      width: 150,
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
        return currencyName === '$' ? `${currencyName} ${formatted}` : `${formatted} ${currencyName}`;
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
      className={`${groupMode ? styles.groupBtnActive : styles.groupBtn} page-header-button`}
      onClick={toggleGroupMode}
    >
      Pivot Mode
    </button>
  );

  const headerActions = groupMode ? (
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

      <button
        type="button"
        className={`${summaryMode ? styles.totalsBtnActive : styles.totalsBtn} page-header-button`}
        onClick={toggleSummaryMode}
      >
        {summaryLoading ? 'Loading…' : 'Totals'}
      </button>
    </div>
  ) : null;

  return (
    <main className={styles.page}>
      <PageHeader title="Offered Products" afterSearchActions={pivotModeButton} rightActions={headerActions}>
        <GridQuickSearchProvider>
          <div className={styles.gridFrame} style={summaryMode ? { display: 'none' } : undefined}>
            <AgGridAll
              endpoint="/api/offered-products"
              columnDefs={columnDefs}
              rowGroupPanelShow="never"
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
              onGridReady={handleGridReady}
              onCellValueChanged={handleCellValueChanged}
              getContextMenuItems={getContextMenuItems}
            />
          </div>
          {summaryMode && (
            <div className={styles.gridFrame}>
              {summaryLoading || !summaryData ? (
                <div className={styles.loading}>Loading summary…</div>
              ) : (
                <AgGridSummary
                  columnDefs={summaryColDefs}
                  rowData={summaryData.rows}
                  defaultColDef={{ resizable: true, sortable: true }}
                />
              )}
            </div>
          )}
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
