"use client";

import React, { useCallback, useMemo } from 'react';
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
      field: 'TotalPrice',
      headerName: 'Total Price',
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

  return (
    <main className={styles.page}>
      <PageHeader title="Offered Products">
        <GridQuickSearchProvider>
          <div className={styles.gridFrame}>
            <AgGridAll
              endpoint="/api/offered-products"
              columnDefs={columnDefs}
              rowGroupPanelShow="always"
              rowSelection="multiple"
              rowMultiSelectWithClick
              rowDeselection
              enablePivotMode
              onCellValueChanged={handleCellValueChanged}
              getContextMenuItems={getContextMenuItems}
            />
          </div>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
