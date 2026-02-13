'use client';

import React, { useMemo, useCallback, useState, useRef, useEffect, useImperativeHandle } from 'react';
import type {
  CellValueChangedEvent,
  ColDef,
  ColumnEventType,
  ColumnMovedEvent,
  ColumnPinnedEvent,
  ColumnResizedEvent,
  ColumnVisibleEvent,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  ICellRendererParams,
  ICellEditorParams,
  IRowNode,
  MenuItemDef,
  RowClassParams,
  RowDoubleClickedEvent,
  RowNode,
  ValueFormatterParams,
  ValueGetterParams,
  ValueSetterParams,
} from 'ag-grid-community';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import styles from './OfferProductsPanel.module.css';
import type {
  AgGridAllProps,
  GridTotals,
  GridResponse,
  ServerRequestWithQuickFilter,
} from '../../components/AgGridAll';
import {
  buildGridColumnStateStorageKey,
  collectPersistableColumnState,
  writePersistedColumnState,
} from '../../components/AgGridAll';

const AgGridAll = dynamic<AgGridAllProps>(() => import('../../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading products…
    </div>
  ),
});
import { showToastMessage } from '../../../lib/toast';
import { GridRowDeletion, getContextMenuSelectionSnapshot, setGridRowDeletionContextMenuSelectionSnapshot } from '../../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../../lib/deletePermissions';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment } from '../../../lib/offerProductRows';
import { priceListStatusClassRules } from '../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../lib/localeNumber';
import { useRealtimeGridUpdates } from '../../hooks/useRealtimeGridUpdates';
import MatchRequestedProductsModal, {
  type RequestedProductMatchEntry,
} from './products/MatchRequestedProductsModal';
import AddProductModal, { type AddProductInitialValues } from '../../products/AddProductModal';
import { useAuditUser } from '../../components/AuditUserProvider';
import LookupModal from '../../components/LookupModal';
import lookupStyles from '../../components/LookupModal.module.css';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const decimalFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const DEFAULT_ROW_HEIGHT = 32;

const COLLAPSED_CATEGORIES_COOKIE_NAME = 'offer_products_collapsed';

function readCollapsedCategoryPathsFromCookie(offerId: string): Set<string> {
  if (typeof document === 'undefined' || !offerId) return new Set();
  try {
    const raw = document.cookie
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COLLAPSED_CATEGORIES_COOKIE_NAME}=`));
    if (!raw) return new Set();
    const value = raw.slice(COLLAPSED_CATEGORIES_COOKIE_NAME.length + 1).trim();
    const decoded = value ? decodeURIComponent(value) : '';
    const parsed = JSON.parse(decoded) as Record<string, string[] | undefined>;
    const paths = parsed[offerId];
    return Array.isArray(paths) ? new Set(paths) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsedCategoryPathsToCookie(offerId: string, paths: Set<string>): void {
  if (typeof document === 'undefined' || !offerId) return;
  try {
    let all: Record<string, string[]> = {};
    const existing = document.cookie
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COLLAPSED_CATEGORIES_COOKIE_NAME}=`));
    if (existing) {
      const value = existing.slice(COLLAPSED_CATEGORIES_COOKIE_NAME.length + 1).trim();
      const decoded = value ? decodeURIComponent(value) : '{}';
      all = JSON.parse(decoded) as Record<string, string[]>;
    }
    if (paths.size === 0) {
      delete all[offerId];
    } else {
      all[offerId] = Array.from(paths);
    }
    const encoded = encodeURIComponent(JSON.stringify(all));
    const maxAge = 60 * 60 * 24 * 365; // 1 year
    document.cookie = `${COLLAPSED_CATEGORIES_COOKIE_NAME}=${encoded}; path=/; max-age=${maxAge}; SameSite=Lax`;
  } catch {
    // ignore
  }
}

type GridRowNode = RowNode<Record<string, unknown>> | IRowNode<Record<string, unknown>>;

const plainNumberFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const parseFlexibleNumber = (raw: string): number | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const numericPortion = trimmed.replace(/[^\d.,+-]/g, '');
  if (!numericPortion) return null;

  const commaCount = (numericPortion.match(/,/g) ?? []).length;
  const dotCount = (numericPortion.match(/\./g) ?? []).length;

  let normalized = numericPortion;
  if (commaCount > 0 && dotCount > 0) {
    const lastComma = numericPortion.lastIndexOf(',');
    const lastDot = numericPortion.lastIndexOf('.');
    if (lastComma > lastDot) {
      normalized = numericPortion.replace(/\./g, '').replace(/,/g, '.');
    } else {
      normalized = numericPortion.replace(/,/g, '');
    }
  } else if (commaCount > 0) {
    normalized = numericPortion.replace(/,/g, '.');
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const coerceNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    return parseFlexibleNumber(value);
  }
  return null;
};

const formatPercentageValue = (value: unknown) => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  return `${decimalFormatter.format(num)} %`;
};

const formatEuroValue = (value: unknown) => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  return `${decimalFormatter.format(num)} €`;
};

type FormatterParams = ValueFormatterParams<Record<string, unknown>, unknown>;
const percentageFormatter = ({ value }: FormatterParams) => formatPercentageValue(value);
const euroFormatter = ({ value }: FormatterParams) => formatEuroValue(value);
const zeroBlankNumberFormatter = ({ value }: FormatterParams) => {
  const num = coerceNumber(value);
  if (num == null) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
  }
  if (Object.is(num, 0)) return '';
  return plainNumberFormatter.format(num);
};

type RequestedFieldKey =
  | 'RequestedItemNo'
  | 'RequestedBrand'
  | 'RequestedPartNo'
  | 'RequestedModelNo'
  | 'RequestedWebLink'
  | 'RequestedDescription'
  | 'RequestedDescription2'
  | 'RequestedDescription3'
  | 'RequestedQuantity';

type RequestedDisplayFieldKey = Exclude<RequestedFieldKey, 'RequestedItemNo'>;
const REQUESTED_DISPLAY_FIELD_KEYS: RequestedDisplayFieldKey[] = [
  'RequestedBrand',
  'RequestedPartNo',
  'RequestedModelNo',
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
  'RequestedQuantity',
];

const REQUESTED_FIELD_LABELS: Record<RequestedFieldKey, string> = {
  RequestedItemNo: 'requested item number',
  RequestedBrand: 'requested brand',
  RequestedPartNo: 'requested part number',
  RequestedModelNo: 'requested model number',
  RequestedWebLink: 'requested web link',
  RequestedDescription: 'requested description',
  RequestedDescription2: 'requested description 2',
  RequestedDescription3: 'requested description 3',
  RequestedQuantity: 'requested quantity',
};

const REQUESTED_FIELD_SET = new Set<RequestedFieldKey>([
  'RequestedItemNo',
  'RequestedBrand',
  'RequestedPartNo',
  'RequestedModelNo',
  'RequestedWebLink',
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
  'RequestedQuantity',
]);

const isRequestedFieldKey = (value: string | null | undefined): value is RequestedFieldKey =>
  typeof value === 'string' && REQUESTED_FIELD_SET.has(value as RequestedFieldKey);

const compareTreeOrderingValues = (a: unknown, b: unknown) => {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa && !sb) return 0;  // both empty/null
  if (!sa) return -1;        // empty/null first
  if (!sb) return 1;
  return collator.compare(sa, sb);
};

const parseTreeOrderingPath = (value: unknown): number[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
};

const buildTreeOrderingKey = (segments: number[]) => segments.join('.');

const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const resolveRowLabel = (row: Record<string, unknown> | null | undefined, fallback: string) => {
  if (!row) return fallback;
  const partNumberRaw = (row as { PartNumber?: unknown }).PartNumber;
  const descriptionRaw = (row as { Description?: unknown }).Description;
  const brandRaw = (row as { BrandName?: unknown }).BrandName;
  const normalize = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const partNumber = normalize(partNumberRaw);
  const description = normalize(descriptionRaw);
  if (partNumber && description) return `${partNumber} – ${description}`;
  if (partNumber) return partNumber;
  if (description) return description;
  const brand = normalize(brandRaw);
  return brand || fallback;
};

const resolveOfferProductTypeLabel = (row: Record<string, unknown> | null | undefined) => {
  const rowType = resolveOfferProductRowType(row);
  if (rowType === 'category') return 'category';
  if (rowType === 'product') return 'product';
  if (rowType === 'printable-comment' || rowType === 'non-printable-comment') return 'comment';
  return 'record';
};

const isRequestedRow = (row: Record<string, unknown> | null | undefined) =>
  Boolean((row as { __isRequestedRow?: number | null })?.__isRequestedRow === 1);

const isRequestedDescriptionField = (field: string | null | undefined): field is 'RequestedDescription' | 'RequestedDescription2' | 'RequestedDescription3' =>
  field === 'RequestedDescription' || field === 'RequestedDescription2' || field === 'RequestedDescription3';

const canEditRequestedField = (field: RequestedFieldKey, row: Record<string, unknown> | null | undefined) => {
  if (isRequestedRow(row)) return true;
  if (isRequestedDescriptionField(field) && isOfferProductCategory(row)) {
    return true;
  }
  return false;
};

const normalizeDescriptionValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const REQUESTED_DESCRIPTION_FIELD_KEYS = [
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
] as const;
type RequestedDescriptionFieldKey = (typeof REQUESTED_DESCRIPTION_FIELD_KEYS)[number];

const getNormalizedRequestedDescriptionValues = (row: Record<string, unknown> | null | undefined): string[] => {
  if (!row || typeof row !== 'object') return [];
  const values: string[] = [];
  REQUESTED_DESCRIPTION_FIELD_KEYS.forEach((key) => {
    const normalized = normalizeDescriptionValue((row as Record<RequestedDescriptionFieldKey, unknown>)[key] ?? null);
    if (normalized != null) {
      values.push(normalized);
    }
  });
  return values;
};

const normalizeRequestedItemNoValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const REQUESTED_HISTORY_LOOKUP_ENDPOINT = '/api/products/resolve';
const requestedHistoryLookupCache = new Map<string, number | null>();

const normalizeRequestedLookupValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getExactTextValue = (value: unknown): string | null => {
  if (value == null) return null;
  return typeof value === 'string' ? value : String(value);
};

const normalizeRequestedQuantityValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
};

const sanitizeDetailValue = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const buildRequestedProductMatchEntry = (
  data: Record<string, unknown>,
  offerDetailId: number,
): RequestedProductMatchEntry => {
  const requestedBrand = normalizeRequestedLookupValue(
    (data as { RequestedBrand?: unknown }).RequestedBrand ?? null,
  );
  const requestedModel = normalizeRequestedLookupValue(
    (data as { RequestedModelNo?: unknown }).RequestedModelNo ?? null,
  );
  const requestedPart = normalizeRequestedLookupValue(
    (data as { RequestedPartNo?: unknown }).RequestedPartNo ?? null,
  );
  const requestedWebLink = normalizeRequestedLookupValue(
    (data as { RequestedWebLink?: unknown }).RequestedWebLink ?? null,
  );
  const requestedDescription = normalizeDescriptionValue(
    (data as { RequestedDescription?: unknown }).RequestedDescription ?? null,
  );
  const requestedDescription2 = normalizeDescriptionValue(
    (data as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
  );
  const requestedDescription3 = normalizeDescriptionValue(
    (data as { RequestedDescription3?: unknown }).RequestedDescription3 ?? null,
  );
  const requestedItemNo = normalizeRequestedItemNoValue(
    (data as { RequestedItemNo?: unknown }).RequestedItemNo ?? null,
  );
  const treeOrderingRaw = (data as { TreeOrdering?: unknown }).TreeOrdering;
  const treeOrdering = typeof treeOrderingRaw === 'string' && treeOrderingRaw.trim()
    ? treeOrderingRaw.trim()
    : null;
  const labelCandidates = [
    requestedDescription,
    requestedDescription2,
    requestedDescription3,
    requestedPart,
    requestedModel,
    requestedBrand,
    requestedItemNo,
    treeOrdering,
  ];
  const label = labelCandidates.find((item) => typeof item === 'string' && item.trim()) ?? 'Requested item';
  const parentCategoryId = normalizeOfferDetailId(
    (data as { ParentOfferDetailID?: unknown }).ParentOfferDetailID ?? null,
  );
  const detailEntries: Array<{ label: string; value: string }> = [];
  const addDetail = (detailLabel: string, detailValue: string | null | undefined) => {
    const sanitized = sanitizeDetailValue(detailValue);
    if (sanitized) {
      detailEntries.push({ label: detailLabel, value: sanitized });
    }
  };
  addDetail('Brand', requestedBrand);
  addDetail('Model', requestedModel);
  addDetail('Part number', requestedPart);
  addDetail('Web link', requestedWebLink);
  addDetail('Requested item number', requestedItemNo);
  addDetail('Tree ordering', treeOrdering);
  addDetail('Requested description', requestedDescription);
  addDetail('Requested description 2', requestedDescription2);
  addDetail('Requested description 3', requestedDescription3);
  return {
    offerDetailId,
    parentCategoryId,
    label,
    quantity: normalizeRequestedQuantityValue(
      (data as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
    ),
    details: detailEntries,
    requestedBrand,
    requestedModelNumber: requestedModel,
    requestedPartNumber: requestedPart,
    requestedWebLink,
    requestedDescription,
    requestedDescription2,
    requestedDescription3,
  };
};

const hasRequestedLookupIdentifiers = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  const part = normalizeRequestedLookupValue((row as { RequestedPartNo?: unknown }).RequestedPartNo ?? null);
  const model = normalizeRequestedLookupValue((row as { RequestedModelNo?: unknown }).RequestedModelNo ?? null);
  const brand = normalizeRequestedLookupValue((row as { RequestedBrand?: unknown }).RequestedBrand ?? null);
  const webLink = normalizeRequestedLookupValue((row as { RequestedWebLink?: unknown }).RequestedWebLink ?? null);
  return Boolean(part || model || brand || webLink);
};

const hasRequestedRowData = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  if (hasRequestedLookupIdentifiers(row)) return true;
  const quantity = normalizeRequestedQuantityValue(
    (row as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
  );
  if (quantity != null && !Object.is(quantity, 0)) return true;
  const actualQuantity = coerceNumber((row as { Quantity?: unknown }).Quantity ?? null);
  if (actualQuantity != null && !Object.is(actualQuantity, 0)) return true;
  return false;
};

const hasRequestedPseudoFields = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  return hasRequestedRowData(row);
};

type RequestedLookupInfo = {
  partNumber: string | null;
  modelNumber: string | null;
  brand: string | null;
};

const buildRequestedLookupInfo = (row: Record<string, unknown> | null | undefined): RequestedLookupInfo => {
  if (!row || typeof row !== 'object') {
    return { partNumber: null, modelNumber: null, brand: null };
  }
  const requestedPart = normalizeRequestedLookupValue((row as { RequestedPartNo?: unknown }).RequestedPartNo ?? (row as { PartNumber?: unknown }).PartNumber);
  const requestedModel = normalizeRequestedLookupValue((row as { RequestedModelNo?: unknown }).RequestedModelNo ?? (row as { ModelNumber?: unknown }).ModelNumber);
  const requestedBrand = normalizeRequestedLookupValue((row as { RequestedBrand?: unknown }).RequestedBrand ?? (row as { BrandName?: unknown }).BrandName);
  return {
    partNumber: requestedPart,
    modelNumber: requestedModel,
    brand: requestedBrand,
  };
};

const resolveProductIdFromRequestedInfo = async (info: RequestedLookupInfo): Promise<number | null> => {
  const { partNumber, modelNumber, brand } = info;
  if (!partNumber && !modelNumber) return null;
  const normalizedBrand = brand
    ? brand.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim()
    : null;
  const brandKey = normalizedBrand
    ? normalizedBrand.replace(/\s+/g, '').toLowerCase()
    : null;
  const params = new URLSearchParams();
  if (partNumber) params.set('partNumber', partNumber);
  if (modelNumber) params.set('modelNumber', modelNumber);
  if (normalizedBrand) params.set('brand', normalizedBrand);
  const cacheKey = `${partNumber ?? ''}|${modelNumber ?? ''}|${brandKey ?? ''}`;
  if (requestedHistoryLookupCache.has(cacheKey)) {
    return requestedHistoryLookupCache.get(cacheKey) ?? null;
  }
  try {
    const response = await fetch(`${REQUESTED_HISTORY_LOOKUP_ENDPOINT}?${params.toString()}`);
    if (!response.ok) {
      requestedHistoryLookupCache.set(cacheKey, null);
      return null;
    }
    const payload = (await response.json().catch(() => null)) as { ok?: boolean; productId?: number | null } | null;
    const productId =
      payload?.ok && typeof payload.productId === 'number' && Number.isInteger(payload.productId)
        ? payload.productId
        : null;
    requestedHistoryLookupCache.set(cacheKey, productId);
    return productId;
  } catch (err) {
    console.error('Failed to resolve product for requested row', err);
    requestedHistoryLookupCache.set(cacheKey, null);
    return null;
  }
};

type ProductSummary = {
  ProductID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  Description: string | null;
};

const productSummaryCache = new Map<number, ProductSummary | null>();

const fetchProductSummary = async (productId: number): Promise<ProductSummary | null> => {
  if (productSummaryCache.has(productId)) {
    return productSummaryCache.get(productId) ?? null;
  }
  try {
    const res = await fetch(`/api/products/${encodeURIComponent(String(productId))}`);
    if (!res.ok) {
      productSummaryCache.set(productId, null);
      return null;
    }
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; product?: ProductSummary } | null;
    const product = payload?.ok && payload.product ? payload.product : null;
    productSummaryCache.set(productId, product);
    return product;
  } catch (err) {
    console.error('Failed to fetch product summary', err);
    productSummaryCache.set(productId, null);
    return null;
  }
};

const isOfferProductCommentOrProduct = (row: Record<string, unknown> | null | undefined) =>
  isOfferProductProduct(row) || isOfferProductComment(row);

const buildCategoryAggregateGetter = (field: 'TotalPrice' | 'TotalNet' | 'TotalCost') => (
  params: ValueGetterParams<Record<string, unknown>, unknown>,
) => {
  const rowData = params.data ?? null;
  if (!isOfferProductCategory(rowData)) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  const path = parseTreeOrderingPath((rowData as { TreeOrdering?: string | null })?.TreeOrdering);
  if (path.length === 0 || !params.api) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  let sum = 0;
  let count = 0;
  params.api.forEachNode((node) => {
    if (!node?.data || node === params.node) return;
    const candidateData = node.data as Record<string, unknown>;
    if (!isOfferProductCommentOrProduct(candidateData)) return;
    const candidatePath = parseTreeOrderingPath((candidateData as { TreeOrdering?: string | null }).TreeOrdering);
    if (candidatePath.length <= path.length) return;
    const isDescendant = path.every((segment, idx) => candidatePath[idx] === segment);
    if (!isDescendant) return;
    const value = coerceNumber((candidateData as Record<string, unknown>)[field]);
    if (value == null) return;
    sum += value;
    count += 1;
  });
  if (count === 0) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  return sum;
};

const roundMoney = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const OFFER_PRODUCTS_EXPORT_FIELDS = [
  'TreeOrdering',
  'PartNumber',
  'BrandName',
  'ModelNumber',
  'Description',
  'Quantity',
  'NetUnitPrice',
  'Comment',
  'Delivery',
  'IsPrintable',
  'IsComment',
  'IsCategory',
] as const;

const normalizeNoForExport = (value: unknown): string | number => {
  if (value == null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return trimmed;
};

const recalcProductTotals = (
  event: CellValueChangedEvent<Record<string, unknown>>,
  quantityOverride?: number | null,
) => {
  const node = event.node;
  const data = event.data;
  if (!node || !data) return;

  const quantity = quantityOverride ?? coerceNumber((data as { Quantity?: unknown }).Quantity) ?? 0;
  const listPrice = coerceNumber((data as { ListPrice?: unknown }).ListPrice);
  const netUnitPrice = coerceNumber((data as { NetUnitPrice?: unknown }).NetUnitPrice);
  const netCost = coerceNumber((data as { NetCost?: unknown }).NetCost);

  const setValue = (field: 'TotalPrice' | 'TotalNet' | 'TotalCost' | 'GrossProfit', value: number | null) => {
    try {
      node.setDataValue(field, value);
    } catch {
      /* noop */
    }
  };

  setValue('TotalPrice', listPrice != null ? roundMoney(listPrice * quantity) : null);
  setValue('TotalNet', netUnitPrice != null ? roundMoney(netUnitPrice * quantity) : null);
  setValue('TotalCost', netCost != null ? roundMoney(netCost * quantity) : null);
  setValue(
    'GrossProfit',
    netUnitPrice != null && netCost != null ? roundMoney((netUnitPrice - netCost) * quantity) : null,
  );
};

const CATEGORY_TOTAL_COLUMNS: string[] = ['TotalPrice', 'TotalNet', 'TotalCost'];
const refreshCategoryAggregates = (api?: GridApi<Record<string, unknown>> | null) => {
  if (!api || typeof api.refreshCells !== 'function') return;
  try {
    api.refreshCells({ columns: CATEGORY_TOTAL_COLUMNS, force: true });
  } catch (err) {
    console.warn('Failed to refresh category aggregates', err);
  }
};

const categoryTotalPriceGetter = buildCategoryAggregateGetter('TotalPrice');
const categoryTotalNetGetter = buildCategoryAggregateGetter('TotalNet');
const categoryTotalCostGetter = buildCategoryAggregateGetter('TotalCost');

const productHistoryMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--history" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5a7 7 0 1 1-7 7" />
      <path d="M12 9v4l2.6 1.5" />
      <path d="M5 7 4 4l3 1" />
    </svg>
  </span>
`;

const categoryMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--category" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 5h6l2 2h10v12H3z" />
      <path d="M3 7h18" />
    </svg>
  </span>
`;

const brandBulkEditMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--brand" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  </span>
`;

const productAccentCellClassRules = {
  'offer-products-grid__cell--product-accent': (params: { data?: Record<string, unknown> | null }) =>
    isOfferProductProduct(params.data),
};

const productPriceListClassRules = priceListStatusClassRules((params) =>
  isOfferProductProduct(params.data) ? params.data : null,
);

const totalPriceCellClassRules = {
  ...productAccentCellClassRules,
  ...productPriceListClassRules,
};

const PRICING_FIELD_LABELS: Record<string, string> = {
  CustomerDiscount: 'Customer Discount',
  NetUnitPrice: 'Net Unit Price',
  TelmacoDiscount: 'Telmaco Discount',
  NetCostOtherCurrency: 'Cost (Other Currency)',
  CurrencyCostModifier: 'Cost Modifier',
  NetCost: 'Net Cost',
  Margin: 'Margin',
  ListPrice: 'List Price',
};

const PRICING_EDITABLE_FIELDS = new Set(Object.keys(PRICING_FIELD_LABELS));
const COST_ANALYSIS_COLUMNS = [
  'TelmacoDiscount',
  'NetCostOtherCurrency',
  'CurrencyCostModifier',
  'NetCost',
  'Margin',
  'GrossProfit',
  'TotalCost',
];

const findDeleteMenuItemIndex = (
  items: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string>,
) => items.findIndex((item) => {
  if (!item || typeof item !== 'object') return false;
  const { name } = item as MenuItemDef<Record<string, unknown>>;
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return normalized.startsWith('delete');
});

type Props = {
  offerId: string;
  endpoint?: string;
  manualMode?: boolean;
  refreshToken?: number;
  showRequestedColumns?: boolean;
  tableLayout?: 'cust' | 'wCost' | 'wReq';
  hideTotals?: boolean;
  initialSelectedOfferDetailIds?: number[];
};

export type OfferProductsPanelHandle = {
  populateOffer: () => Promise<void>;
  getTemplateExportRows: () => Promise<OfferProductsTemplateExportRow[]>;
  getAddInsertionAnchor: () => { offerDetailId: number; parentPath: number[] } | null;
  getSelectedOfferDetailIdsForPriceUpdate: () => number[];
  getSelectedOfferDetailIds: () => number[];
};

export type OfferProductsTemplateExportRow = {
  no: string | number;
  productReference: string;
  manufacturer: string;
  descriptionType: string;
  qty: number | '';
  unitPrice: number | '';
  delayForDelivery: string;
  comments: string;
};

type OfferExportRow = {
  TreeOrdering: string | null;
  PartNumber: string | null;
  BrandName: string | null;
  ModelNumber: string | null;
  Description: string | null;
  Quantity: number | null;
  NetUnitPrice: number | null;
  Delivery: string | null;
  Comment: string | null;
  IsPrintable?: boolean | null;
  IsComment?: boolean | null;
  IsCategory?: boolean | null;
};

// Custom cell editor for multiline text (Description and Comment cells)
class MultilineTextCellEditor {
  private eInput!: HTMLTextAreaElement;
  private eWrapper!: HTMLDivElement;
  private initialValue: string = '';
  private params!: ICellEditorParams;
  private isMultiline: boolean = false;
  private lastMeasuredWidth: number = 0;

  init(params: ICellEditorParams) {
    this.params = params;
    this.initialValue = params.value ?? '';
    this.isMultiline = this.initialValue.includes('\n');

    // Create wrapper div for positioning
    this.eWrapper = document.createElement('div');
    this.eWrapper.style.position = 'relative';
    this.eWrapper.style.width = '100%';
    this.eWrapper.style.height = '100%';
    this.eWrapper.style.overflow = 'visible';

    // Create textarea
    this.eInput = document.createElement('textarea');
    this.eInput.value = this.initialValue;
    this.eInput.style.border = 'none';
    this.eInput.style.outline = 'none';
    this.eInput.style.resize = 'none';
    this.eInput.style.fontFamily = 'inherit';
    this.eInput.style.fontSize = 'inherit';
    this.eInput.style.lineHeight = '1.5';
    this.eInput.style.boxSizing = 'border-box';
    this.eInput.style.background = 'white';

    if (this.isMultiline) {
      this.applyMultilineStyle();
    } else {
      this.applySingleLineStyle();
    }

    // Handle Alt+Enter to insert line breaks
    this.eInput.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && e.altKey) {
        e.preventDefault();
        e.stopPropagation();

        const start = this.eInput.selectionStart;
        const end = this.eInput.selectionEnd;
        const value = this.eInput.value;

        // Insert newline at cursor position
        this.eInput.value = value.substring(0, start) + '\n' + value.substring(end);

        // Move cursor after the newline
        this.eInput.selectionStart = this.eInput.selectionEnd = start + 1;

        // Switch to multi-line mode if not already
        if (!this.isMultiline) {
          this.isMultiline = true;
          this.applyMultilineStyle();
        }

        // Resize row to fit content
        this.resizeToFit();
      }
    });

    // Detect when all line breaks are removed -> switch back to single-line
    this.eInput.addEventListener('input', () => {
      const hasBreaks = this.eInput.value.includes('\n');
      if (this.isMultiline && !hasBreaks) {
        this.isMultiline = false;
        this.applySingleLineStyle();
        // Reset row height back to default
        const node = this.params.node;
        if (node) {
          node.setRowHeight(null);
          this.params.api.onRowHeightChanged();
        }
      }
    });

    this.eWrapper.appendChild(this.eInput);
  }

  private applySingleLineStyle() {
    this.eInput.style.position = 'absolute';
    this.eInput.style.top = '0';
    this.eInput.style.left = '0';
    this.eInput.style.width = '2000px';
    this.eInput.style.height = '100%';
    this.eInput.style.padding = '4px 0';
    this.eInput.style.whiteSpace = 'nowrap';
    this.eInput.style.overflow = 'hidden';
    this.eInput.style.zIndex = '1000';
  }

  private applyMultilineStyle() {
    this.eInput.style.position = 'absolute';
    this.eInput.style.top = '0';
    this.eInput.style.left = '0';
    this.eInput.style.width = '2000px';
    this.eInput.style.height = '100%';
    this.eInput.style.padding = '0';
    this.eInput.style.whiteSpace = 'pre';
    this.eInput.style.overflow = 'hidden';
    this.eInput.style.zIndex = '1000';
  }

  private measureTextWidth(): number {
    const text = this.eInput.value;
    if (!text) return 0;
    const computed = window.getComputedStyle(this.eInput);
    const font = `${computed.fontSize} ${computed.fontFamily}`;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 0;
    ctx.font = font;
    const lines = text.split('\n');
    let maxWidth = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxWidth) maxWidth = w;
    }
    return Math.ceil(maxWidth) + 24;
  }

  private resizeToFit() {
    requestAnimationFrame(() => {
      // Calculate height from line count (lineHeight 1.5 * fontSize)
      const lineCount = this.eInput.value.split('\n').length;
      const computed = window.getComputedStyle(this.eInput);
      const fontSize = parseFloat(computed.fontSize) || 14;
      const lineHeight = fontSize * 1.5;
      const neededHeight = Math.ceil(lineCount * lineHeight);

      // Set textarea and row height
      this.eInput.style.height = neededHeight + 'px';

      const node = this.params.node;
      if (node) {
        node.setRowHeight(neededHeight);
        this.params.api.onRowHeightChanged();
      }

      // Measure and store width for use on destroy
      this.lastMeasuredWidth = this.measureTextWidth();
    });
  }

  getGui() {
    return this.eWrapper;
  }

  afterGuiAttached() {
    this.eInput.focus();
    this.eInput.select();
    this.eInput.scrollLeft = 0;
  }

  getValue() {
    return this.eInput.value;
  }

  isCancelBeforeStart() {
    return false;
  }

  isCancelAfterEnd() {
    return false;
  }

  destroy() {
    // Reset scroll position of the cell so it shows the left (beginning) of text
    const cell = this.eWrapper.closest('.ag-cell');
    if (cell) {
      cell.scrollLeft = 0;
      const wrapper = cell.querySelector('.ag-cell-wrapper');
      if (wrapper) (wrapper as HTMLElement).scrollLeft = 0;
      const value = cell.querySelector('.ag-cell-value');
      if (value) (value as HTMLElement).scrollLeft = 0;
    }

  }
}

const buildEndpointForOffer = (offerId: string) =>
  `/api/offers/${encodeURIComponent(offerId)}/products`;

const OfferProductsPanel = React.forwardRef<OfferProductsPanelHandle, Props>(({
  offerId,
  endpoint,
  manualMode = false,
  refreshToken = 0,
  showRequestedColumns = true,
  tableLayout = 'wReq',
  hideTotals = false,
  initialSelectedOfferDetailIds,
}: Props, ref) => {
  const router = useRouter();
  const { userId, roles } = useAuditUser();
  useEffect(() => {
    deferInitialHeavyWorkRef.current = true;
  }, [offerId]);
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    return buildEndpointForOffer(offerId);
  }, [endpoint, offerId]);
  const dataEndpoint = resolvedEndpoint;
  // Persist Offer Products layouts globally (shared across all offers).
  // Still separated per table layout via `columnStateNamespace`.
  const persistenceEndpoint = '/api/offers/products';
  const columnStateNamespace = useMemo(
    () => `offer-products-${tableLayout}`,
    [tableLayout],
  );
  const columnStateStorageKey = useMemo(
    () => buildGridColumnStateStorageKey(persistenceEndpoint, userId, columnStateNamespace),
    [columnStateNamespace, persistenceEndpoint, userId],
  );
  const pricingToastDedupRef = useRef<Map<string, number>>(new Map());
  const realtimeCellUpdateRef = useRef<Map<string, number>>(new Map());
  const registerRealtimeCellUpdate = useCallback((rowId: number, field: string, value: unknown) => {
    const key = `${rowId}:${field}:${String(value)}`;
    realtimeCellUpdateRef.current.set(key, Date.now());
  }, []);
  const shouldSkipRealtimeCellEdit = useCallback(
    (event: CellValueChangedEvent<Record<string, unknown>>) => {
      const field = event.colDef.field;
      if (!field) return false;
      const rowId = normalizeOfferDetailId(
        (event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null,
      );
      if (rowId == null) return false;
      const key = `${rowId}:${field}:${String(event.newValue)}`;
      const lastSeen = realtimeCellUpdateRef.current.get(key);
      if (!lastSeen) return false;
      if (Date.now() - lastSeen > 1500) {
        realtimeCellUpdateRef.current.delete(key);
        return false;
      }
      realtimeCellUpdateRef.current.delete(key);
      return true;
    },
    [],
  );
  const { savedColumnOrder, savedHiddenMap } = useMemo(() => {
    if (typeof window === 'undefined' || !columnStateStorageKey) {
      return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
    }

    // If the audit user id is resolved after the page loads, the storage key changes from
    // "anon" to the real user id. If we read before any migration happens, we’ll treat the
    // new key as empty and re-render the grid with default column visibility/order (and
    // AG Grid may also reset widths).
    //
    // Migrate the previous anon state forward before we read.
    try {
      const hasRealUser = typeof userId === 'string' && userId.trim().length > 0;
      if (hasRealUser) {
        const existing = window.localStorage.getItem(columnStateStorageKey);
        if (!existing) {
          const anonKey = buildGridColumnStateStorageKey(persistenceEndpoint, '', columnStateNamespace);
          const anonRaw = window.localStorage.getItem(anonKey);
          if (anonRaw) {
            window.localStorage.setItem(columnStateStorageKey, anonRaw);
          }
        }
      }
    } catch {
      /* noop */
    }

    try {
      const raw = window.localStorage.getItem(columnStateStorageKey);
      if (!raw) {
        return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
      }
      const parsed = JSON.parse(raw) as {
        columns?: Array<{ colId?: unknown; order?: unknown; hide?: unknown }>;
      } | null;
      if (!parsed || !Array.isArray(parsed.columns)) {
        return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
      }
      const savedColumnOrder = parsed.columns
        .filter((entry) => typeof entry?.colId === 'string' && typeof entry?.order === 'number')
        .sort((a, b) => (a.order as number) - (b.order as number))
        .map((entry) => entry.colId as string);
      const savedHiddenMap: Record<string, boolean> = {};
      parsed.columns.forEach((entry) => {
        const colId = typeof entry?.colId === 'string' ? entry.colId : '';
        if (!colId) return;
        if (typeof entry?.hide === 'boolean') {
          savedHiddenMap[colId] = entry.hide;
        }
      });
      return { savedColumnOrder, savedHiddenMap };
    } catch {
      return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
    }
  }, [columnStateNamespace, columnStateStorageKey, userId]);
  useEffect(() => {
    warmupFetchedRef.current = false;
  }, [dataEndpoint]);
  useEffect(() => {
    if (warmupFetchedRef.current) return;
    if (typeof window === 'undefined') return;
    const warmup = async () => {
      try {
        await fetch(dataEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: { startRow: 0, endRow: 1 }, __warmup: true }),
        });
      } catch {
        /* noop */
      } finally {
        warmupFetchedRef.current = true;
      }
    };
    void warmup();
  }, [dataEndpoint]);
  const addProductsEndpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products/add`,
    [offerId],
  );
  const assignRequestedRowToProduct = useCallback(
    async (requestedRowId: number, productId: number, categoryId: number | null) => {
      try {
        const body: Record<string, unknown> = {
          action: 'assign-requested',
          requestedRowId,
          productId,
        };
        if (categoryId != null) {
          body.categoryId = categoryId;
        }
        const res = await fetch(addProductsEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          console.error('Failed to assign requested row to product', payload?.error ?? `status ${res.status}`);
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to assign requested row to product', err);
        return false;
      }
    },
    [addProductsEndpoint],
  );
  const [totals, setTotals] = useState<{ totalListPrice: number; totalNetPrice: number; totalCost: number; totalMargin: number } | null>(null);
  const [requestedColumnVisibility, setRequestedColumnVisibility] = useState<Record<RequestedDisplayFieldKey, boolean>>({
    RequestedBrand: false,
    RequestedModelNo: false,
    RequestedPartNo: false,
    RequestedWebLink: false,
    RequestedDescription: false,
    RequestedDescription2: false,
    RequestedDescription3: false,
    RequestedQuantity: false,
  });
  const [requestedItemNoVisible, setRequestedItemNoVisible] = useState(false);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const warmupFetchedRef = useRef(false);
  const [requestedColumnsReady, setRequestedColumnsReadyFlag] = useState(false);
  const [requestedMatchQueue, setRequestedMatchQueue] = useState<RequestedProductMatchEntry[]>([]);
  const [processedRequestedMatches, setProcessedRequestedMatches] = useState(0);
  const [collapsedCategoryPaths, setCollapsedCategoryPaths] = useState<Set<string>>(() =>
    readCollapsedCategoryPathsFromCookie(offerId),
  );
  const [categoryPathsWithChildren, setCategoryPathsWithChildren] = useState<Set<string>>(() => new Set());
  const [categoryChildrenKnown, setCategoryChildrenKnown] = useState(false);
  const collapsedCategoryPathsRef = useRef(collapsedCategoryPaths);
  collapsedCategoryPathsRef.current = collapsedCategoryPaths;
  const categoryPathsWithChildrenRef = useRef(categoryPathsWithChildren);
  categoryPathsWithChildrenRef.current = categoryPathsWithChildren;
  const categoryChildrenKnownRef = useRef(categoryChildrenKnown);
  categoryChildrenKnownRef.current = categoryChildrenKnown;
  const treeOrderingRootMapRef = useRef<Map<string, number>>(new Map());
  const serverRowsRef = useRef<Array<Record<string, unknown>>>([]);
  const appliedRequestedColumnVisibilityRef = useRef<Record<RequestedDisplayFieldKey, boolean> | null>(null);
  const appliedRequestedItemNoVisibleRef = useRef<boolean | null>(null);
  const appliedShowRequestedColumnsRef = useRef<boolean | null>(null);
  const appliedTableLayoutRef = useRef<'cust' | 'wCost' | 'wReq' | null>(null);
  const lastServerRequestRef = useRef<ServerRequestWithQuickFilter | null>(null);
  const lastRowCountRef = useRef<number | null>(null);
  const lastRequestStartRef = useRef<number | null>(null);
  const deferInitialHeavyWorkRef = useRef(true);
  const skipModelUpdateRef = useRef(false);
  const collapseSkipUntilRef = useRef<number | null>(null);
  const pendingContextMenuSelectionClearRef = useRef(false);
  const toggleCategoryCollapsedRef = useRef<(row: Record<string, unknown> | null | undefined) => void>(() => {});
  const [matchAddProductOpen, setMatchAddProductOpen] = useState(false);
  const [matchAddedProductId, setMatchAddedProductId] = useState<number | null>(null);
  const clearMatchAddedProductId = useCallback(() => setMatchAddedProductId(null), []);
  const [brandBulkEditOpen, setBrandBulkEditOpen] = useState(false);
  const [brandBulkEditField, setBrandBulkEditField] = useState<'CurrencyCostModifier' | 'Margin'>('CurrencyCostModifier');
  const [brandBulkEditBrandName, setBrandBulkEditBrandName] = useState('');
  const [brandBulkEditValue, setBrandBulkEditValue] = useState('');
  const [brandBulkEditSaving, setBrandBulkEditSaving] = useState(false);
  const [brandBulkEditError, setBrandBulkEditError] = useState<string | null>(null);
  const refreshScheduledRef = useRef(false);
  const pendingRefreshPurgeRef = useRef<boolean | null>(null);
  const captureColumnWidths = useCallback((api: GridApi<Record<string, unknown>>) => {
    const stateNow = typeof api.getColumnState === 'function' ? api.getColumnState() : [];
    return (Array.isArray(stateNow) ? stateNow : [])
      .map((entry) => {
        const colId = typeof entry?.colId === 'string' ? entry.colId : '';
        const width = typeof entry?.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
          ? entry.width
          : null;
        if (!colId || width == null) return null;
        return { colId, width };
      })
      .filter((entry): entry is { colId: string; width: number } => entry != null);
  }, []);
  const restoreColumnWidths = useCallback((
    api: GridApi<Record<string, unknown>>,
    widths: Array<{ colId: string; width: number }>,
  ) => {
    if (!widths.length) return;
    try {
      api.applyColumnState({
        state: widths,
        applyOrder: false,
      });
    } catch {
      /* noop */
    }
  }, []);
  const rebuildTreeOrderingRootMap = useCallback((rows?: Array<Record<string, unknown>>, reset = false) => {
    const map = reset ? new Map<string, number>() : new Map(treeOrderingRootMapRef.current);
    (rows ?? []).forEach((row) => {
      if (!row) return;
      const path = parseTreeOrderingPath((row as Record<string, unknown>)?.TreeOrdering ?? null);
      if (path.length === 0) return;
      const key = String(path[0]);
      if (!map.has(key)) {
        map.set(key, map.size + 1);
      }
    });
    treeOrderingRootMapRef.current = map;
  }, []);
  const formatDisplayTreeOrdering = useCallback((value: unknown) => {
    if (value == null) return '';
    const trimmed = String(value).trim();
    if (!trimmed) return '';

    // Keep the root map updated (used elsewhere), but do not renumber the displayed value.
    const path = parseTreeOrderingPath(trimmed);
    if (path.length > 0) {
      const map = treeOrderingRootMapRef.current;
      const key = String(path[0]);
      if (!map.has(key)) {
        map.set(key, map.size + 1);
      }
    }

    return trimmed;
  }, []);

  const applyRequestedColumnVisibility = useCallback((visibility: Partial<Record<RequestedDisplayFieldKey, boolean>> | null | undefined, replace = false) => {
    const resetState = {
      RequestedBrand: false,
      RequestedModelNo: false,
      RequestedPartNo: false,
      RequestedWebLink: false,
      RequestedDescription: false,
      RequestedDescription2: false,
      RequestedDescription3: false,
      RequestedQuantity: false,
    };
    if (!visibility) {
      if (!replace) return;
      setRequestedColumnVisibility((prev) => {
        const next = { ...resetState };
        const hasChanged = REQUESTED_DISPLAY_FIELD_KEYS.some((key) => prev[key] !== next[key]);
        return hasChanged ? next : prev;
      });
      return;
    }
    setRequestedColumnVisibility((prev) => {
      const next = replace ? { ...resetState } : { ...prev };
      REQUESTED_DISPLAY_FIELD_KEYS.forEach((key) => {
        if (visibility[key] == null) return;
        const nextValue = Boolean(visibility[key]);
        next[key] = nextValue;
      });
      const hasChanged = REQUESTED_DISPLAY_FIELD_KEYS.some((key) => prev[key] !== next[key]);
      return hasChanged ? next : prev;
    });
  }, []);

  const defaultColDef = useMemo<ColDef>(() => ({
    editable: (params) => (
      isOfferProductProduct(params?.data ?? null)
      || isOfferProductComment(params?.data ?? null)
    ),
    sortable: false,
    cellStyle: {
      display: 'flex',
      alignItems: 'center',
    },
  }), []);

  const handleTotalsChange = useCallback((payload: GridTotals | null) => {
    if (!payload) {
      setTotals(null);
      return;
    }
    const totalNetPrice = payload.totalNetPrice ?? 0;
    const totalListPrice = payload.totalListPrice ?? 0;
    const totalCost = payload.totalCost ?? 0;
    const marginBasis = Object.is(totalNetPrice, 0) ? 0 : totalNetPrice;
    const totalMargin = marginBasis === 0 ? 0 : ((totalNetPrice - totalCost) / marginBasis) * 100;
    setTotals((prev) => {
      if (
        prev
        && Object.is(prev.totalNetPrice, totalNetPrice)
        && Object.is(prev.totalListPrice, totalListPrice)
        && Object.is(prev.totalCost, totalCost)
        && Object.is(prev.totalMargin, totalMargin)
      ) {
        return prev;
      }
      return { totalNetPrice, totalListPrice, totalCost, totalMargin };
    });
  }, []);

  const updateCategoryAncestors = useCallback(() => {
    const rows = serverRowsRef.current;
    if (rows.length === 0) {
      setCategoryPathsWithChildren((prev) => (prev.size === 0 ? prev : new Set()));
      setCollapsedCategoryPaths((prev) => (prev.size === 0 ? prev : new Set()));
      setCategoryChildrenKnown(false);
      return;
    }
    const rowsByPath = new Map<string, Record<string, unknown>>();
    rows.forEach((rowData) => {
      if (!rowData) return;
      const path = parseTreeOrderingPath((rowData as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      if (path.length === 0) return;
      const key = buildTreeOrderingKey(path);
      if (!key) return;
      rowsByPath.set(key, rowData);
    });
    if (rowsByPath.size === 0) {
      setCategoryPathsWithChildren((prev) => (prev.size === 0 ? prev : new Set()));
      setCategoryChildrenKnown(false);
      return;
    }
    const categoryKeys = new Set<string>();
    rowsByPath.forEach((rowData, key) => {
      if (isOfferProductCategory(rowData)) {
        categoryKeys.add(key);
      }
    });
    const next = new Set<string>();
    rowsByPath.forEach((rowData) => {
      const path = parseTreeOrderingPath((rowData as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      if (path.length <= 1) return;
      const parentKey = buildTreeOrderingKey(path.slice(0, -1));
      if (parentKey && categoryKeys.has(parentKey)) {
        next.add(parentKey);
      }
    });
    setCategoryPathsWithChildren((prev) => {
      if (next.size === 0) {
        return prev;
      }
      const merged = new Set(prev);
      next.forEach((value) => merged.add(value));
      return merged;
    });
    setCategoryChildrenKnown((prev) => prev || next.size > 0);
  }, []);

  useEffect(() => {
    if (!requestedColumnsReady) return;
    const api = gridApiRef.current;
    if (!api) return;
    const widthSnapshot = captureColumnWidths(api);

    const keys = REQUESTED_DISPLAY_FIELD_KEYS;
    const forcedHiddenVisibility = keys.reduce<Record<RequestedDisplayFieldKey, boolean>>((acc, key) => {
      acc[key] = false;
      return acc;
    }, {} as Record<RequestedDisplayFieldKey, boolean>);
    const savedRequestedHidden = (key: string) => savedHiddenMap[key] === true;
    const effectiveVisibility = showRequestedColumns
      ? keys.reduce<Record<RequestedDisplayFieldKey, boolean>>((acc, key) => {
        const baseVisible = requestedColumnVisibility[key];
        acc[key] = Boolean(baseVisible) && !savedRequestedHidden(key);
        return acc;
      }, {} as Record<RequestedDisplayFieldKey, boolean>)
      : forcedHiddenVisibility;
    const effectiveItemNoVisible = showRequestedColumns
      ? requestedItemNoVisible && !savedRequestedHidden('RequestedItemNo')
      : false;

    const previousVisibility = appliedRequestedColumnVisibilityRef.current;
    const visibilityChanged = !previousVisibility
      || appliedShowRequestedColumnsRef.current !== showRequestedColumns
      || keys.some((key) => previousVisibility?.[key] !== effectiveVisibility[key]);
    const itemNoVisibilityChanged = appliedRequestedItemNoVisibleRef.current !== effectiveItemNoVisible;
    if (!visibilityChanged && !itemNoVisibilityChanged) {
      return;
    }

    try {
      const state: Array<{ colId: string; hide: boolean }> = keys.map((key) => ({
        colId: key,
        hide: !effectiveVisibility[key],
      }));
      if (itemNoVisibilityChanged || visibilityChanged) {
        state.push({ colId: 'RequestedItemNo', hide: !effectiveItemNoVisible });
      }
      api.applyColumnState({ state, applyOrder: false });
    } catch {
      /* noop */
    }
    restoreColumnWidths(api, widthSnapshot);

    // AG Grid can sometimes drift hidden "Requested…" columns into unexpected positions.
    // Always keep the full Requested block (visible + hidden) at the start (right after the
    // drag handle) so it comes back in the correct place across all layouts.
    if (typeof window !== 'undefined' && typeof api.getColumnState === 'function' && typeof api.moveColumns === 'function') {
      const applyOrder = () => {
        try {
          const stateNow = api.getColumnState();
          const currentOrder = Array.isArray(stateNow)
            ? stateNow.map((entry) => (typeof entry?.colId === 'string' ? entry.colId : '')).filter((id) => id)
            : [];
          if (currentOrder.length === 0) return;
          const dragIndex = currentOrder.indexOf('__row_drag__');
          const anchorIndex = dragIndex >= 0 ? dragIndex + 1 : 0;

          const desiredStartIds = ['ProductID', 'RequestedItemNo', ...keys, 'TreeOrdering'];
          const toMove = desiredStartIds.filter((id) => currentOrder.includes(id));
          if (toMove.length === 0) return;
          api.moveColumns(toMove, anchorIndex);
        } catch {
          /* noop */
        } finally {
          restoreColumnWidths(api, widthSnapshot);
        }
      };
      // Run twice to avoid races with internal column-state restoration.
      window.requestAnimationFrame(() => window.requestAnimationFrame(applyOrder));
    } else {
      restoreColumnWidths(api, widthSnapshot);
    }

    appliedRequestedColumnVisibilityRef.current = { ...effectiveVisibility };
    appliedRequestedItemNoVisibleRef.current = effectiveItemNoVisible;
    appliedShowRequestedColumnsRef.current = showRequestedColumns;
  }, [
    captureColumnWidths,
    columnStateStorageKey,
    requestedColumnVisibility,
    requestedColumnsReady,
    requestedItemNoVisible,
    restoreColumnWidths,
    savedHiddenMap,
    showRequestedColumns,
  ]);

  useEffect(() => {
    if (!requestedColumnsReady) return;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    if (appliedTableLayoutRef.current === tableLayout) return;
    const widthSnapshot = captureColumnWidths(api);

    const showCostAnalysis = tableLayout !== 'cust';
    try {
      const state = COST_ANALYSIS_COLUMNS.map((colId) => ({
        colId,
        hide: !showCostAnalysis,
      }));
      api.applyColumnState({ state, applyOrder: false });
    } catch {
      /* noop */
    }
    restoreColumnWidths(api, widthSnapshot);

    appliedTableLayoutRef.current = tableLayout;
  }, [captureColumnWidths, requestedColumnsReady, restoreColumnWidths, tableLayout]);

  const handleGridResponse = useCallback((response: GridResponse | null) => {
    lastRowCountRef.current = response?.rowCount ?? null;
    const hasRows = Boolean(response?.rowCount && response.rowCount > 0);
    serverRowsRef.current = response && Array.isArray(response.rows) ? response.rows : [];
    const shouldResetRoots = response?.request?.startRow === 0;
    rebuildTreeOrderingRootMap(response?.rows as Array<Record<string, unknown>> | undefined, shouldResetRoots);
    const requestColumnVisibility: Partial<Record<RequestedDisplayFieldKey, boolean>> = {};
    if (response?.requestedColumns) {
      REQUESTED_DISPLAY_FIELD_KEYS.forEach((key) => {
        const value = response.requestedColumns?.[key];
        if (value != null) {
          requestColumnVisibility[key] = Boolean(value);
        }
      });
      applyRequestedColumnVisibility(requestColumnVisibility, true);
    } else if (response) {
      applyRequestedColumnVisibility(null, true);
    }
    const hasRequestedItemInRows = (response?.rows ?? []).some((row) => normalizeRequestedItemNoValue(
      (row as Record<string, unknown>)?.RequestedItemNo ?? null,
    ) != null);
    const shouldShowRequestedItemNo = hasRows
      && (Boolean(response?.requestedColumns?.RequestedItemNo) || hasRequestedItemInRows);
    setRequestedItemNoVisible(shouldShowRequestedItemNo);
    const runHeavyUpdates = () => {
      updateCategoryAncestors();
    };
    const shouldDeferHeavy = hasRows && deferInitialHeavyWorkRef.current;
    if (shouldDeferHeavy && typeof window !== 'undefined') {
      deferInitialHeavyWorkRef.current = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(runHeavyUpdates);
      });
    } else {
      deferInitialHeavyWorkRef.current = false;
      runHeavyUpdates();
    }
  }, [applyRequestedColumnVisibility, rebuildTreeOrderingRootMap, updateCategoryAncestors]);

  const handleServerRequest = useCallback((request: ServerRequestWithQuickFilter) => {
    lastRequestStartRef.current = performance.now();
    lastServerRequestRef.current = request;
  }, []);

  const [gridReadyApi, setGridReadyApi] = useState<GridApi<Record<string, unknown>> | null>(null);
  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    gridApiRef.current = api;
    setGridReadyApi(api);

    // Real-time updates are handled by useRealtimeGridUpdates hook below
    setRequestedColumnsReadyFlag(true);
  }, [setRequestedColumnsReadyFlag]);


  const saveLayout = useCallback((options?: { silent?: boolean }) => {
    if (typeof window === 'undefined') return false;
    if (!columnStateStorageKey) return false;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      if (!options?.silent) {
        showToastMessage('Unable to save layout. Please try again.', 'error');
      }
      return false;
    }
    const currentState = api.getColumnState();
    const columnOrderMap = new Map<string, number>();
    const displayedOrder = (typeof api.getAllDisplayedColumns === 'function'
      ? api.getAllDisplayedColumns()
      : [])
      .map((column) => (typeof column.getColId === 'function' ? column.getColId() : ''))
      .filter((colId) => colId);
    const currentOrder = currentState
      .map((entry) => (typeof entry.colId === 'string' ? entry.colId : ''))
      .filter((colId) => colId);
    const visibleOrderSource = displayedOrder;
    const visibleSet = new Set(visibleOrderSource);
    const visibleQueue = visibleOrderSource.filter((colId) => currentOrder.includes(colId));
    const mergedOrder = currentOrder.map((colId) => (visibleSet.has(colId) ? visibleQueue.shift() ?? colId : colId));
    mergedOrder.forEach((colId, index) => {
      if (colId) columnOrderMap.set(colId, index);
    });

    // Some AG Grid configurations (and some column types) can yield column state entries
    // without a reliable `width`, even though the UI is clearly showing custom widths.
    // If we persist a layout without widths, the grid will fall back to default widths.
    //
    // To prevent that, we always fill missing widths from:
    // - the live column actual widths (preferred)
    // - the previously saved widths (fallback)
    const existingWidthByColId = new Map<string, number>();
    try {
      const rawExisting = window.localStorage.getItem(columnStateStorageKey);
      if (rawExisting) {
        const parsedExisting = JSON.parse(rawExisting) as { columns?: Array<{ colId?: unknown; width?: unknown }> } | null;
        if (parsedExisting && Array.isArray(parsedExisting.columns)) {
          parsedExisting.columns.forEach((entry) => {
            const colId = typeof entry?.colId === 'string' ? entry.colId : '';
            const width = typeof entry?.width === 'number' ? entry.width : null;
            if (colId && width != null && Number.isFinite(width) && width > 0) {
              existingWidthByColId.set(colId, width);
            }
          });
        }
      }
    } catch {
      /* noop */
    }

    const actualWidthByColId = new Map<string, number>();
    try {
      const apiWithAllGridColumns = api as unknown as {
        getAllGridColumns?: () => Array<{ getColId?: () => string; getActualWidth?: () => number }>;
      };
      const columns = typeof apiWithAllGridColumns.getAllGridColumns === 'function'
        ? apiWithAllGridColumns.getAllGridColumns()
        : (typeof api.getAllDisplayedColumns === 'function' ? api.getAllDisplayedColumns() : []);
      if (Array.isArray(columns)) {
        columns.forEach((column) => {
          const colId = typeof column?.getColId === 'function' ? column.getColId() : '';
          const width = typeof column?.getActualWidth === 'function' ? column.getActualWidth() : null;
          if (colId && width != null && Number.isFinite(width) && width > 0) {
            actualWidthByColId.set(colId, width);
          }
        });
      }
    } catch {
      /* noop */
    }

    const nextState = collectPersistableColumnState(currentState, columnOrderMap).map((entry) => {
      const widthCandidate = typeof entry.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
        ? entry.width
        : actualWidthByColId.get(entry.colId) ?? existingWidthByColId.get(entry.colId);
      if (widthCandidate != null && Number.isFinite(widthCandidate) && widthCandidate > 0) {
        return { ...entry, width: widthCandidate };
      }
      return entry;
    });
    writePersistedColumnState(columnStateStorageKey, nextState);
    if (!options?.silent) {
      showToastMessage('Layout saved', 'success');
    }
    return true;
  }, [columnStateStorageKey]);

  const autoSaveTimerRef = useRef<number | null>(null);
  const queueAutoSaveLayout = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      saveLayout({ silent: true });
    }, 200);
  }, [saveLayout]);

  const shouldAutoSaveFromColumnEvent = useCallback((source: ColumnEventType) => (
    source.startsWith('ui')
    || source === 'toolPanelUi'
    || source === 'toolPanelDragAndDrop'
    || source === 'columnMenu'
    || source === 'contextMenu'
  ), []);

  useEffect(() => () => {
    if (autoSaveTimerRef.current && typeof window !== 'undefined') {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const api = gridReadyApi;
    if (!api || api.isDestroyed?.()) return undefined;

    const handleColumnMoved = (event: ColumnMovedEvent<Record<string, unknown>>) => {
      if (!event.finished) return;
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };
    const handleColumnResized = (event: ColumnResizedEvent<Record<string, unknown>>) => {
      if (!event.finished) return;
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };
    const handleColumnVisible = (event: ColumnVisibleEvent<Record<string, unknown>>) => {
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };
    const handleColumnPinned = (event: ColumnPinnedEvent<Record<string, unknown>>) => {
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };

    api.addEventListener('columnMoved', handleColumnMoved);
    api.addEventListener('columnResized', handleColumnResized);
    api.addEventListener('columnVisible', handleColumnVisible);
    api.addEventListener('columnPinned', handleColumnPinned);

    return () => {
      api.removeEventListener('columnMoved', handleColumnMoved);
      api.removeEventListener('columnResized', handleColumnResized);
      api.removeEventListener('columnVisible', handleColumnVisible);
      api.removeEventListener('columnPinned', handleColumnPinned);
    };
  }, [gridReadyApi, queueAutoSaveLayout, shouldAutoSaveFromColumnEvent]);

  const isCategoryRowCollapsed = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!row) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    return key.length > 0 && collapsedCategoryPaths.has(key);
  }, [collapsedCategoryPaths]);

  const hasCategoryChildren = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    if (!categoryChildrenKnown) return true;
    return key.length > 0 && categoryPathsWithChildren.has(key);
  }, [categoryChildrenKnown, categoryPathsWithChildren]);

  const isCategoryRowCollapsedForRenderer = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!row) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    return key.length > 0 && collapsedCategoryPathsRef.current.has(key);
  }, []);

  const hasCategoryChildrenForRenderer = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    if (!categoryChildrenKnownRef.current) return true;
    return key.length > 0 && categoryPathsWithChildrenRef.current.has(key);
  }, []);

  const hasCollapsedAncestorInSet = useCallback((path: number[], collapsedSet: Set<string>) => {
    for (let idx = 1; idx < path.length; idx += 1) {
      const ancestorKey = buildTreeOrderingKey(path.slice(0, idx));
      if (ancestorKey && collapsedSet.has(ancestorKey)) {
        return true;
      }
    }
    return false;
  }, []);

  const determineRowHeight = useCallback((params: { data?: Record<string, unknown> }) => {
    const row = params.data;
    if (!row) return DEFAULT_ROW_HEIGHT;

    // Check if Description or Comment fields contain line breaks
    const description = (row.ProductDescription ?? row.Description ?? '') as string;
    const comment = (row.Comment ?? '') as string;

    // If either field contains newlines, return undefined to let AG Grid auto-calculate height
    if (description.includes('\n') || comment.includes('\n')) {
      return undefined;
    }

    return DEFAULT_ROW_HEIGHT;
  }, []);

  const getRowHeight = useCallback(
    (params: { data?: Record<string, unknown> }) => determineRowHeight(params),
    [determineRowHeight],
  );

  const pendingInitialSelectionRestoreRef = useRef<(() => void) | null>(null);

  const handleGridModelUpdated = useCallback(() => {
    if (skipModelUpdateRef.current) {
      skipModelUpdateRef.current = false;
      return;
    }
    const skipUntil = collapseSkipUntilRef.current;
    if (typeof skipUntil === 'number' && Date.now() <= skipUntil) {
      return;
    }
    updateCategoryAncestors();
    pendingInitialSelectionRestoreRef.current?.();
  }, [updateCategoryAncestors]);

  const toggleCategoryCollapsed = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return;
    if (!hasCategoryChildren(row)) return;
    collapseSkipUntilRef.current = Date.now() + 200;
    skipModelUpdateRef.current = true;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return;
    const key = buildTreeOrderingKey(path);
    if (!key) return;
    setCollapsedCategoryPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [hasCategoryChildren]);
  toggleCategoryCollapsedRef.current = toggleCategoryCollapsed;

  const getRowClass = useCallback((params: RowClassParams<Record<string, unknown>>) => {
    const rowType = resolveOfferProductRowType(params.data);
    let baseClass: string | undefined;
    switch (rowType) {
      case 'category':
        baseClass = 'offer-row offer-row--category';
        break;
      case 'product':
        baseClass = 'offer-row offer-row--product';
        break;
      case 'printable-comment':
        baseClass = 'offer-row offer-row--printable-comment';
        break;
      case 'non-printable-comment':
        baseClass = 'offer-row offer-row--nonprintable-comment';
        break;
      default:
        baseClass = undefined;
    }
    const classes: string[] = [];
    if (baseClass) {
      classes.push(baseClass);
      if (rowType === 'category') {
        if (isCategoryRowCollapsed(params.data)) {
          classes.push('offer-row--category-collapsed');
        }
        if (!hasCategoryChildren(params.data)) {
          classes.push('offer-row--category-empty');
        }
      }
    }
    if (classes.length === 0) {
      return undefined;
    }
    return classes.join(' ');
  }, [isCategoryRowCollapsed, hasCategoryChildren]);

  const removeCollapsedDescendantsFromGrid = useCallback((collapsedSet: Set<string>) => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    if (collapsedSet.size === 0) return;
    const rowsToRemove: Array<Record<string, unknown>> = [];
    api.forEachNode((node) => {
      const row = node.data ?? null;
      if (!row) return;
      const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      if (path.length === 0) return;
      if (hasCollapsedAncestorInSet(path, collapsedSet)) {
        rowsToRemove.push(row);
      }
    });
    if (rowsToRemove.length > 0) {
      try {
        api.applyServerSideTransaction({ remove: rowsToRemove });
      } catch {
        /* noop */
      }
    }
  }, [hasCollapsedAncestorInSet]);

  const handleRowDoubleClicked = useCallback((params: RowDoubleClickedEvent<Record<string, unknown>>) => {
    const target = params.event?.target;
    if (target instanceof Element) {
      const isDescriptionCell = Boolean(target.closest('[col-id="Description"]'));
      const isRequestedDescriptionCell = Boolean(target.closest('[col-id="RequestedDescription"]'));
      const isRequestedDescription2Cell = Boolean(target.closest('[col-id="RequestedDescription2"]'));
      const isRequestedDescription3Cell = Boolean(target.closest('[col-id="RequestedDescription3"]'));
      if (isDescriptionCell || isRequestedDescriptionCell || isRequestedDescription2Cell || isRequestedDescription3Cell) {
        // Prevent collapsing the category when double-clicking a description cell.
        return;
      }
    }
    toggleCategoryCollapsed(params.data ?? null);
  }, [toggleCategoryCollapsed]);

  const TreeOrderingCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const rawValue = params.value ?? (params.data as { TreeOrdering?: unknown } | undefined)?.TreeOrdering ?? null;
    const value = formatDisplayTreeOrdering(rawValue);
    const rowData = params.data ?? null;
    const isCategory = isOfferProductCategory(rowData);
    const shouldShowIndicator = isCategory;
    const hasChildren = isCategory && hasCategoryChildrenForRenderer(rowData);
    const collapsed = isCategory && isCategoryRowCollapsedForRenderer(rowData);
    const indicator = shouldShowIndicator
      ? hasChildren
        ? (collapsed ? '▸' : '▾')
        : '•'
      : null;
    const indicatorClass = shouldShowIndicator
      ? hasChildren
        ? `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorArrow}`
        : `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorEmpty}`
      : undefined;

    const handleIndicatorClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (hasChildren) {
        toggleCategoryCollapsedRef.current(rowData);
      }
    };

    const indicatorLabel = hasChildren
      ? (collapsed ? 'Expand category' : 'Collapse category')
      : 'Category without child entries';

    const display = value;
    return (
      <span className={styles.treeOrderingCell}>
        {indicator && (
          <button
            type="button"
            className={`${styles.treeOrderingIndicatorButton} ${indicatorClass ?? ''}`.trim()}
            onClick={handleIndicatorClick}
            aria-label={indicatorLabel}
            disabled={!hasChildren}
          >
            {indicator}
          </button>
        )}
        <span className={styles.treeOrderingText}>{display}</span>
      </span>
    );
  }, [formatDisplayTreeOrdering, hasCategoryChildrenForRenderer, isCategoryRowCollapsedForRenderer]);

const RequestedItemNoCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
  const value = params.value;
  const rowData = params.data ?? null;
  const isCategory = isOfferProductCategory(rowData);
  const shouldShowIndicator = isCategory && isRequestedRow(rowData);
  const hasChildren = shouldShowIndicator && hasCategoryChildrenForRenderer(rowData);
  const collapsed = shouldShowIndicator && isCategoryRowCollapsedForRenderer(rowData);
  const indicator = shouldShowIndicator
    ? hasChildren
      ? (collapsed ? '▸' : '▾')
      : '•'
    : null;
  const indicatorClass = shouldShowIndicator
    ? hasChildren
      ? `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorArrow}`
      : `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorEmpty}`
    : undefined;

    const handleIndicatorClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (hasChildren) {
        toggleCategoryCollapsedRef.current(rowData);
      }
    };

    const indicatorLabel = hasChildren
      ? (collapsed ? 'Expand category' : 'Collapse category')
      : 'Category without child entries';

    return (
      <span className={styles.treeOrderingCell}>
        {indicator && (
          <button
            type="button"
            className={`${styles.treeOrderingIndicatorButton} ${indicatorClass ?? ''}`.trim()}
            onClick={handleIndicatorClick}
            aria-label={indicatorLabel}
            disabled={!hasChildren}
          >
            {indicator}
          </button>
        )}
        <span className={styles.treeOrderingText}>{value ?? ''}</span>
      </span>
    );
  }, [hasCategoryChildrenForRenderer, isCategoryRowCollapsedForRenderer]);

const PartNumberCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const rawValue = params.value;
    if (rawValue == null) return '';
    const partNumber = String(rawValue).trim();
    if (!partNumber) return '';

    const rawLink = (params.data as { WebLink?: string | null } | undefined)?.WebLink;
    const normalizedLink = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!normalizedLink) return partNumber;

    const stop = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <a
        href={normalizedLink}
        target="_blank"
        rel="noreferrer noopener"
        className={styles.partNumberLink}
        onClick={stop}
        onMouseDown={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
        title="Open product link"
      >
        {partNumber}
    </a>
  );
}, []);

const ModelNumberCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const rawValue = params.value;
    if (rawValue == null) return '';
    const modelNumber = String(rawValue).trim();
    if (!modelNumber) return '';

    // Only show link if PartNumber is empty
    const partNumberRaw = (params.data as { PartNumber?: unknown } | undefined)?.PartNumber;
    const partNumber = typeof partNumberRaw === 'string' ? partNumberRaw.trim() : '';
    if (partNumber) return modelNumber; // PartNumber exists, don't show link on ModelNumber

    const rawLink = (params.data as { WebLink?: string | null } | undefined)?.WebLink;
    const normalizedLink = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!normalizedLink) return modelNumber;

    const stop = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <a
        href={normalizedLink}
        target="_blank"
        rel="noreferrer noopener"
        className={styles.partNumberLink}
        onClick={stop}
        onMouseDown={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
        title="Open product link"
      >
        {modelNumber}
    </a>
  );
}, []);

  const REQUESTED_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--requested';
  const ACTUAL_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--actual';
  const TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--truncate';
  const truncateCellStyle = useMemo(
    () => ({
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      display: 'flex',
      alignItems: 'center',
      minWidth: 0,
    } as const),
    [],
  );

  const actualNumericCellClass = useMemo(
    () => [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS, 'ag-right-aligned'],
    [],
  );
  const actualNumericCellStyle = useMemo(
    () => ({
      ...truncateCellStyle,
      justifyContent: 'flex-end',
      textAlign: 'right',
    } as const),
    [truncateCellStyle],
  );

  const requestedCellClassRules = useMemo(() => ({
    [styles.requestedColumnCell]: (params: { data?: Record<string, unknown> | null }) =>
      isOfferProductCategory(params.data ?? null),
    [REQUESTED_COLUMN_GLOBAL_CLASS]: (params: { data?: Record<string, unknown> | null }) =>
      isOfferProductCategory(params.data ?? null),
  }), []);

  const clearRequestedFlags = useCallback((node: GridRowNode | null) => {
    if (!node) return;
    try {
      node.setDataValue('__isRequestedRow', 0);
    } catch {
      /* noop */
    }
  }, []);

  const refreshRowNodes = useCallback((node: GridRowNode | null) => {
    if (!node) return;
    const api = gridApiRef.current;
    if (!api) return;
    try {
      api.refreshCells({ rowNodes: [node], force: true });
    } catch {
      /* noop */
    }
  }, []);

  const promoteNodeToCategory = useCallback((
    node: GridRowNode | null,
    treeOrdering: string | null,
    description: string | null,
    requestedItemNo: string | null = null,
  ) => {
    if (!node) return;
    try {
      node.setDataValue('IsCategory', 1);
      node.setDataValue('IsComment', false);
      node.setDataValue('IsPrintable', null);
    } catch {
      /* noop */
    }
    clearRequestedFlags(node);
    if (treeOrdering != null) {
      try {
        node.setDataValue('TreeOrdering', treeOrdering);
      } catch {
        /* noop */
      }
    }
    if (requestedItemNo != null) {
      try {
        node.setDataValue('RequestedItemNo', requestedItemNo);
      } catch {
        /* noop */
      }
    }
    if (description != null) {
      try {
        node.setDataValue('Description', description);
      } catch {
        /* noop */
      }
    }
    refreshRowNodes(node);
  }, [clearRequestedFlags, refreshRowNodes]);

  const promoteNodeToProduct = useCallback((
    node: GridRowNode | null,
    productMeta: ProductSummary,
    partNumber: string | null,
    modelNumber: string | null,
    brandName: string | null,
    description: string | null,
  ) => {
    if (!node) return;
    try {
      node.setDataValue('IsCategory', 0);
      node.setDataValue('ProductID', productMeta.ProductID);
    } catch {
      /* noop */
    }
    clearRequestedFlags(node);
    try {
      node.setDataValue('PartNumber', partNumber ?? null);
      node.setDataValue('ModelNumber', modelNumber ?? null);
      node.setDataValue('BrandName', brandName ?? null);
      node.setDataValue('ProductDescription', description ?? null);
      node.setDataValue('Description', description ?? null);
    } catch {
      /* noop */
    }
    refreshRowNodes(node);
  }, [clearRequestedFlags, refreshRowNodes]);

const requestedColumnDefsMap = useMemo<Record<RequestedDisplayFieldKey, ColDef>>(() => {
  const buildTextRequestedColumn = (
    field: RequestedDisplayFieldKey,
    headerName: string
  ) => {
    const isDescription = isRequestedDescriptionField(field);
    const supportsWebLink = field === 'RequestedPartNo' || field === 'RequestedModelNo';
    const column: ColDef = {
      field,
      headerName,
      filter: 'agTextColumnFilter',
      headerClass: styles.requestedHeader,
      cellClassRules: requestedCellClassRules,
      cellClass: isDescription ? ACTUAL_COLUMN_GLOBAL_CLASS : TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
      cellStyle: isDescription
        ? (params) => {
            const row = params.data as Record<string, unknown> | null | undefined;
            const description = (row?.[field] ?? '') as string;
            const hasLineBreaks = description.includes('\n');

            return {
              whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
              lineHeight: '1.5',
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
              textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
            };
          }
        : truncateCellStyle,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField(field, params.data ?? null),
      cellEditor: isDescription ? MultilineTextCellEditor : 'agTextCellEditor',
      valueGetter: (params: ValueGetterParams<Record<string, unknown>, unknown>) => {
        const row = params.data ?? null;
        const rawValue = row ? row[field] : null;
        if (isDescription) {
          return normalizeDescriptionValue(rawValue) ?? '';
        }
        if (typeof rawValue === 'string') return rawValue.trim();
        return rawValue;
      },
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        const normalized = isDescription
          ? normalizeDescriptionValue(newValue)
          : normalizeRequestedLookupValue(newValue);
        (data as Record<string, unknown>)[field] = normalized;
        return true;
      },
      cellRenderer: supportsWebLink
        ? (params: ICellRendererParams<Record<string, unknown>>) => {
            const rawValue = params.value;
            if (rawValue == null) return '';
            const displayValue = String(rawValue).trim();
            if (!displayValue) return '';

            if (field === 'RequestedModelNo') {
              const partNoRaw = (params.data as { RequestedPartNo?: unknown } | undefined)?.RequestedPartNo ?? null;
              const partNo = normalizeRequestedLookupValue(partNoRaw);
              if (partNo) return displayValue;
            }

            const rawLink = (params.data as { RequestedWebLink?: unknown } | undefined)?.RequestedWebLink ?? null;
            const normalizedLink = normalizeRequestedLookupValue(rawLink);
            if (!normalizedLink) return displayValue;

            const stop = (event: React.SyntheticEvent) => {
              event.stopPropagation();
            };

            return (
              <a
                href={normalizedLink}
                target="_blank"
                rel="noreferrer noopener"
                className={styles.partNumberLink}
                onClick={stop}
                onMouseDown={stop}
                onDoubleClick={stop}
                onContextMenu={stop}
                title="Open requested product link"
              >
                {displayValue}
              </a>
            );
          }
        : undefined,
      autoHeight: isDescription ? true : undefined,
    };
    return column;
  };

  return {
    RequestedBrand: buildTextRequestedColumn('RequestedBrand', 'Req. Brand'),
    RequestedPartNo: buildTextRequestedColumn('RequestedPartNo', 'Req. Part Number'),
    RequestedModelNo: buildTextRequestedColumn('RequestedModelNo', 'Req. Model Number'),
    RequestedWebLink: buildTextRequestedColumn('RequestedWebLink', 'Req. Web Link'),
    RequestedDescription: buildTextRequestedColumn('RequestedDescription', 'Req. Description'),
    RequestedDescription2: buildTextRequestedColumn('RequestedDescription2', 'Req. Description 2'),
    RequestedDescription3: buildTextRequestedColumn('RequestedDescription3', 'Req. Description 3'),
    RequestedQuantity: {
      field: 'RequestedQuantity',
      headerName: 'Req. Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: zeroBlankNumberFormatter,
      headerClass: [styles.requestedHeader, 'ag-right-aligned-header'],
      cellClassRules: requestedCellClassRules,
      cellClass: 'ag-right-aligned',
      cellStyle: actualNumericCellStyle,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField('RequestedQuantity', params.data ?? null),
      cellEditor: 'agTextCellEditor',
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        (data as Record<string, unknown>).RequestedQuantity = normalizeRequestedQuantityValue(newValue);
        return true;
      },
    },
  };
}, [actualNumericCellStyle, requestedCellClassRules, truncateCellStyle]);

  const productColumnDefs: ColDef[] = useMemo(() => {
    const requestedColumns: ColDef[] = [];
    REQUESTED_DISPLAY_FIELD_KEYS.forEach((key) => {
      const baseColDef = requestedColumnDefsMap[key];
      if (!baseColDef) return;
      requestedColumns.push({ ...baseColDef });
    });

    const treeColumn: ColDef = {
      field: 'TreeOrdering',
      headerName: 'Item No',
      filter: 'agTextColumnFilter',
      type: 'numericColumn',
      comparator: compareTreeOrderingValues,
      editable: manualMode,
      cellRenderer: TreeOrderingCell,
      headerClass: 'ag-right-aligned-header',
      cellClass: [
        'offer-products-tree-ordering-cell',
        ACTUAL_COLUMN_GLOBAL_CLASS,
        TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
        'ag-right-aligned',
      ],
      cellStyle: truncateCellStyle,
    valueGetter: ({ data }) => {
      const row = data as {
        __isRequestedRow?: number | null;
        TreeOrdering?: unknown;
      } | null | undefined;
      const treeValue = row?.TreeOrdering;
      if (treeValue != null) {
        return typeof treeValue === 'string' ? treeValue.trim() : String(treeValue);
      }
      return '';
    },
  };

    const requestedItemNoColumn: ColDef = {
      field: 'RequestedItemNo',
      headerName: 'Req. Item No',
      filter: 'agTextColumnFilter',
      headerClass: [styles.requestedHeader, 'ag-right-aligned-header'],
      cellClassRules: requestedCellClassRules,
      cellClass: [TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS, 'ag-right-aligned'],
      cellStyle: truncateCellStyle,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField('RequestedItemNo', params.data ?? null),
      cellEditor: 'agTextCellEditor',
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        const normalized = normalizeRequestedItemNoValue(newValue);
        (data as Record<string, unknown>).RequestedItemNo = normalized;
        return true;
      },
      valueGetter: ({ data }) => {
        if (!data) return '';
        const requestedItemNo = normalizeRequestedItemNoValue(
          (data as Record<string, unknown>).RequestedItemNo ?? null,
        );
        return requestedItemNo ?? '';
      },
      cellRenderer: RequestedItemNoCell,
    };

    const baseColumns: ColDef[] = [
      {
        headerName: '',
        colId: '__row_drag__',
        lockPosition: true,
        suppressMovable: true,
        suppressSizeToFit: true,
        suppressColumnsToolPanel: true,
        resizable: false,
        sortable: false,
        filter: false,
        width: 44,
        rowDrag: true,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      },
      {
        field: 'ProductID',
        hide: true,
        lockVisible: true,
        suppressColumnsToolPanel: true,
      },
      requestedItemNoColumn,
      ...requestedColumns,
      treeColumn,
      {
        field: 'BrandName',
        headerName: 'Brand',
        filter: 'agTextColumnFilter',
        cellClassRules: productAccentCellClassRules,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'PartNumber',
        headerName: 'Part Number',
        filter: 'agTextColumnFilter',
        cellRenderer: PartNumberCell,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'ModelNumber',
        headerName: 'Model Number',
        filter: 'agTextColumnFilter',
        cellRenderer: ModelNumberCell,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'Description',
        headerName: 'Description',
        filter: 'agTextColumnFilter',
        valueGetter: ({ data }) => {
          const row = data as Record<string, unknown> | null | undefined;
          const rawProductId = (row as { ProductID?: unknown } | null | undefined)?.ProductID ?? null;
          const hasProductId =
            typeof rawProductId === 'number'
              ? Number.isFinite(rawProductId)
              : typeof rawProductId === 'string'
                ? rawProductId.trim().length > 0
                : false;
          const isAssignedProduct = isOfferProductProduct(row) || hasProductId;
          if (isRequestedRow(row) && !isAssignedProduct) return '';
          const manual = normalizeDescriptionValue(row?.ProductDescription ?? null);
          if (manual != null) return manual;
          if (!isOfferProductCategory(row) && !isOfferProductProduct(row) && !isOfferProductComment(row)) {
            return '';
          }
          return normalizeDescriptionValue(row?.Description ?? null) ?? '';
        },
        valueSetter: ({ data, newValue }) => {
          if (!data) return false;
          const normalized = normalizeDescriptionValue(newValue);
          (data as Record<string, unknown>).ProductDescription = normalized;
          (data as Record<string, unknown>).Description = normalized;
          return true;
        },
        editable: (params) => {
          const row = params?.data ?? null;
          return (
            isOfferProductCategory(row)
            || isOfferProductComment(row)
            || isOfferProductProduct(row)
          );
        },
        cellEditor: MultilineTextCellEditor,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
        cellStyle: (params) => {
          const row = params.data as Record<string, unknown> | null | undefined;
          const description = (row?.ProductDescription ?? row?.Description ?? '') as string;
          const hasLineBreaks = description.includes('\n');

          return {
            whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
          };
        },
        autoHeight: true,
      },
    {
      field: 'ListPrice',
      headerName: 'List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: productPriceListClassRules,
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Customer Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: percentageFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'NetUnitPrice',
      headerName: 'Net Unit Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: euroFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'TotalPrice',
      headerName: 'Total List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueGetter: categoryTotalPriceGetter,
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: totalPriceCellClassRules,
      editable: false,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'TotalNet',
      headerName: 'Total Net',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueGetter: categoryTotalNetGetter,
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'Warranty',
      headerName: 'Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
      {
        field: 'Comment',
        headerName: 'Comment',
        filter: 'agTextColumnFilter',
        editable: (params) => {
          const row = params?.data ?? null;
          return (
            isOfferProductCategory(row)
            || isOfferProductComment(row)
            || isOfferProductProduct(row)
          );
        },
        cellEditor: MultilineTextCellEditor,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
        cellStyle: (params) => {
          const row = params.data as Record<string, unknown> | null | undefined;
          const comment = (row?.Comment ?? '') as string;
          const hasLineBreaks = comment.includes('\n');

          return {
            whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
          };
        },
        autoHeight: true,
      },
      {
        field: 'Delivery',
        headerName: 'Delivery',
        filter: 'agTextColumnFilter',
        editable: (params) => {
          const row = params?.data ?? null;
          return (
            isOfferProductCategory(row)
            || isOfferProductComment(row)
            || isOfferProductProduct(row)
          );
        },
        valueGetter: ({ data }) => {
          const raw = (data as { Delivery?: unknown } | null | undefined)?.Delivery;
          return raw == null ? '' : String(raw).trim();
        },
        valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
          if (!data) return false;
          (data as Record<string, unknown>).Delivery = normalizeRequestedLookupValue(newValue ?? null);
          return true;
        },
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
    {
      field: 'TelmacoDiscount',
      headerName: 'Telmaco Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: percentageFormatter,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'NetCost',
      headerName: 'Net Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: euroFormatter,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: percentageFormatter,
      cellClassRules: {
        [styles.negativeMarginCell]: (params) => {
          const value = coerceNumber(
            params.value
            ?? (params.data as { Margin?: unknown } | null | undefined)?.Margin
            ?? null,
          );
          return value != null && value < 0;
        },
      },
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'GrossProfit',
      headerName: 'Gross Profit',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
      {
        field: 'TotalCost',
        headerName: 'Total Cost',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        headerClass: 'ag-right-aligned-header',
        valueFormatter: euroFormatter,
        valueGetter: categoryTotalCostGetter,
        cellClassRules: productAccentCellClassRules,
        editable: false,
        cellClass: [...actualNumericCellClass, styles.redDataCell],
        cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
      },
    ];
    const columnMap = new Map<string, ColDef>();
    baseColumns.forEach((column) => {
      const id = typeof column.colId === 'string'
        ? column.colId
        : typeof column.field === 'string'
          ? column.field
          : '';
      if (!id) return;
      columnMap.set(id, column);
    });
    const ordered: ColDef[] = [];

    // Keep Requested columns first (and in-order) across all layouts, even if hidden.
    const fixedStartIds = [
      '__row_drag__',
      'ProductID',
      'RequestedItemNo',
      ...REQUESTED_DISPLAY_FIELD_KEYS,
      'TreeOrdering',
    ];
    const fixedStartSet = new Set(fixedStartIds);
    fixedStartIds.forEach((id) => {
      const column = columnMap.get(id);
      if (!column) return;
      ordered.push(column);
      columnMap.delete(id);
    });

    savedColumnOrder
      .filter((id) => !fixedStartSet.has(id))
      .forEach((id) => {
        const column = columnMap.get(id);
        if (!column) return;
        ordered.push(column);
        columnMap.delete(id);
      });
    columnMap.forEach((column) => ordered.push(column));
    if (Object.keys(savedHiddenMap).length > 0) {
      return ordered.map((column) => {
        const id = typeof column.colId === 'string'
          ? column.colId
          : typeof column.field === 'string'
            ? column.field
            : '';
        if (!id) return column;
        if (savedHiddenMap[id] == null) return column;
        return {
          ...column,
          hide: savedHiddenMap[id],
        };
      });
    }
    return ordered;
  }, [
    actualNumericCellClass,
    actualNumericCellStyle,
    PartNumberCell,
    ModelNumberCell,
    manualMode,
    TreeOrderingCell,
    requestedColumnDefsMap,
    RequestedItemNoCell,
    requestedCellClassRules,
    savedHiddenMap,
    savedColumnOrder,
    truncateCellStyle,
  ]);

  const refreshOfferProductGrid = useCallback((api: GridApi<Record<string, unknown>> | null, options?: { refresh?: boolean; purge?: boolean }) => {
    const targetApi = api ?? gridApiRef.current;
    if (!targetApi) return;
    const shouldRefresh = options?.refresh ?? true;
    if (shouldRefresh && typeof targetApi.refreshServerSide === 'function') {
      const requestedPurge = options?.purge ?? false;
      if (pendingRefreshPurgeRef.current == null) {
        pendingRefreshPurgeRef.current = requestedPurge;
      } else {
        pendingRefreshPurgeRef.current = pendingRefreshPurgeRef.current || requestedPurge;
      }
      if (!refreshScheduledRef.current) {
        refreshScheduledRef.current = true;
        Promise.resolve().then(() => {
          refreshScheduledRef.current = false;
          const apiForRefresh = gridApiRef.current;
          const purge = pendingRefreshPurgeRef.current ?? false;
          pendingRefreshPurgeRef.current = null;
          if (!apiForRefresh) return;
          try {
            apiForRefresh.refreshServerSide?.({ purge });
          } catch (err) {
            console.warn('Failed to refresh grid after row deletion', err);
          }
        });
      }
    }
    try {
      targetApi.redrawRows();
    } catch (err) {
      console.warn('Failed to refresh category metadata after row deletion', err);
    }
  }, []);

  useEffect(() => {
    if (refreshToken === 0) return;
    refreshOfferProductGrid(null, { refresh: false });
  }, [refreshOfferProductGrid, refreshToken]);

  useEffect(() => {
    if (requestedMatchQueue.length === 0 && processedRequestedMatches !== 0) {
      setProcessedRequestedMatches(0);
    }
  }, [processedRequestedMatches, requestedMatchQueue.length]);

  const previousCollapsedPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    const prev = previousCollapsedPathsRef.current;
    const next = collapsedCategoryPaths;
    const added = Array.from(next).filter((key) => !prev.has(key));
    const removed = Array.from(prev).filter((key) => !next.has(key));
    if (added.length > 0) {
      removeCollapsedDescendantsFromGrid(next);
    }
    if (removed.length > 0) {
      api.refreshServerSide?.({ purge: false });
    }
    previousCollapsedPathsRef.current = new Set(next);
  }, [collapsedCategoryPaths, removeCollapsedDescendantsFromGrid]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    try {
      api.redrawRows();
    } catch {
      /* noop */
    }
  }, [collapsedCategoryPaths]);

  const prevOfferIdForCookieRef = useRef(offerId);
  useEffect(() => {
    if (prevOfferIdForCookieRef.current !== offerId) {
      prevOfferIdForCookieRef.current = offerId;
      return;
    }
    writeCollapsedCategoryPathsToCookie(offerId, collapsedCategoryPaths);
  }, [offerId, collapsedCategoryPaths]);

  useEffect(() => {
    setCollapsedCategoryPaths(readCollapsedCategoryPathsFromCookie(offerId));
    prevOfferIdForCookieRef.current = offerId;
  }, [offerId]);

  const productRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: resolvedEndpoint,
        resolveRowId: (row) =>
          normalizeOfferDetailId((row as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null),
        resolveRowLabel,
        resolveRowTypeLabel: resolveOfferProductTypeLabel,
        resolveMultiRowTypeLabel: (rows) => {
          const types = new Set(
            rows.map((row) => resolveOfferProductTypeLabel(row)).filter((value) => value && value.trim().length > 0),
          );
          if (types.size !== 1) return 'items';
          const [type] = Array.from(types);
          if (type === 'category') return 'categories';
          if (type === 'product') return 'products';
          if (type === 'comment') return 'comments';
          if (type.endsWith('s')) return type;
          return `${type}s`;
        },
        buildPayload: (ids) => ({ OfferDetailIDs: ids }),
        confirmTitle: ({ typeLabel }) => `Delete ${typeLabel}`,
        confirmConfirmLabel: ({ typeLabel }) => `Delete ${typeLabel}`,
        confirmCancelLabel: ({ typeLabel }) => `Keep ${typeLabel}`,
        successToastMessage: 'Row deleted',
        failureToastMessage: 'Unable to delete row. Please try again.',
        refreshHandler: (api) => refreshOfferProductGrid(api, { purge: true }),
        canDelete: (count) => checkDeletePermissionForClient(roles, count, 'generic', 'editOffers'),
      }),
    [resolvedEndpoint, refreshOfferProductGrid, roles],
  );

  const populateRequestedRowsToOffer = useCallback(async (nodes: RowNode<Record<string, unknown>>[]) => {
    const requestedNodes = nodes.filter((node) => isRequestedRow(node?.data ?? null));
    if (requestedNodes.length === 0) return;

    try {
      gridApiRef.current?.deselectAll?.();
    } catch {
      /* noop */
    }
    setGridRowDeletionContextMenuSelectionSnapshot(gridApiRef.current, []);
    pendingContextMenuSelectionClearRef.current = true;

    const finalizeSelection = () => {
      requestedNodes.forEach((node) => {
        try {
          node?.setSelected?.(false);
        } catch {
          /* noop */
        }
      });
      setGridRowDeletionContextMenuSelectionSnapshot(gridApiRef.current, []);
      pendingContextMenuSelectionClearRef.current = true;
      try {
        gridApiRef.current?.deselectAll?.();
      } catch {
        /* noop */
      }
    };

    const updates: Array<Record<string, unknown>> = [];
    let categoriesAdded = 0;
    let productsAdded = 0;
    const unmatchedRequestedRows: RequestedProductMatchEntry[] = [];
    const baseRootCategoryCount = treeOrderingRootMapRef.current.size;
    let sequentialCategoryCount = 0;
    let lastAssignedCategoryOrdinal: string | null = null;
    const productChildCounters = new Map<string, number>();

    try {
      for (const node of requestedNodes) {
        const data = node?.data ?? null;
        if (!data || typeof data !== 'object') continue;
        const offerDetailId = normalizeOfferDetailId((data as { OfferDetailID?: unknown }).OfferDetailID ?? null);
        if (offerDetailId == null) continue;

        const lookupInfo = buildRequestedLookupInfo(data);
        const hasRequestedIdentifiers = Boolean(lookupInfo.partNumber || lookupInfo.modelNumber);
        const requestedDescriptionPrimary = normalizeDescriptionValue(
          (data as { RequestedDescription?: unknown }).RequestedDescription ?? null,
        );
        const requestedDescriptionSecondary = normalizeDescriptionValue(
          (data as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
        );
        const requestedDescriptionTertiary = normalizeDescriptionValue(
          (data as { RequestedDescription3?: unknown }).RequestedDescription3 ?? null,
        );
        const descriptionOverrideRaw = getExactTextValue(
          (data as { Description?: unknown }).Description ?? null,
        );
        const requestedTree = normalizeRequestedItemNoValue((data as { RequestedItemNo?: unknown }).RequestedItemNo ?? null);
        const treeOrderingRaw = (data as { TreeOrdering?: unknown }).TreeOrdering;
        let treeOrderingValue = requestedTree || (typeof treeOrderingRaw === 'string'
          ? treeOrderingRaw.trim()
          : null);
        const requestedDescriptionValue = requestedDescriptionPrimary ?? requestedDescriptionSecondary ?? requestedDescriptionTertiary;
        const descriptionOverride = normalizeDescriptionValue(descriptionOverrideRaw);
        const normalizedDescriptionValues = getNormalizedRequestedDescriptionValues(data);
        const hasSingleDescriptionOnly = normalizedDescriptionValues.length > 0
          && new Set(normalizedDescriptionValues).size === 1;
        const requestedQuantityValue = normalizeRequestedQuantityValue(
          (data as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
        );
        const actualQuantityValue = coerceNumber((data as { Quantity?: unknown }).Quantity ?? null);
        const hasRequestedQuantity = requestedQuantityValue != null && !Object.is(requestedQuantityValue, 0);
        const hasActualQuantity = actualQuantityValue != null && !Object.is(actualQuantityValue, 0);
        const hasQuantity = hasRequestedQuantity || hasActualQuantity;
        const shouldPromoteToCategory = (
          !hasRequestedIdentifiers
          && hasSingleDescriptionOnly
          && !hasQuantity
        );
        if (shouldPromoteToCategory) {
          const categoryDescription = requestedDescriptionValue ?? descriptionOverride ?? null;
          const payloadEntry: Record<string, unknown> = {
            OfferDetailID: offerDetailId,
            IsCategory: 1,
          };
          if (!treeOrderingValue) {
            sequentialCategoryCount += 1;
            treeOrderingValue = String(baseRootCategoryCount + sequentialCategoryCount);
          }
          lastAssignedCategoryOrdinal = treeOrderingValue;
          productChildCounters.set(treeOrderingValue, 0);
          if (categoryDescription != null) {
            payloadEntry.Description = categoryDescription;
          }
          if (treeOrderingValue != null) {
            payloadEntry.TreeOrdering = treeOrderingValue;
            if (requestedTree != null) {
              payloadEntry.RequestedItemNo = requestedTree;
            }
          }
          if (requestedDescriptionPrimary != null) {
            payloadEntry.RequestedDescription = requestedDescriptionPrimary;
          }
          if (requestedDescriptionSecondary != null) {
            payloadEntry.RequestedDescription2 = requestedDescriptionSecondary;
          }
          if (requestedDescriptionTertiary != null) {
            payloadEntry.RequestedDescription3 = requestedDescriptionTertiary;
          }
          updates.push(payloadEntry);
          promoteNodeToCategory(
            node,
            treeOrderingValue ?? null,
            categoryDescription,
            requestedTree,
          );
          categoriesAdded += 1;
          continue;
        }

        if (!treeOrderingValue && lastAssignedCategoryOrdinal) {
          const nextChildIndex = (productChildCounters.get(lastAssignedCategoryOrdinal) ?? 0) + 1;
          productChildCounters.set(lastAssignedCategoryOrdinal, nextChildIndex);
          treeOrderingValue = `${lastAssignedCategoryOrdinal}.${nextChildIndex}`;
        }

        if (!hasRequestedIdentifiers) {
          unmatchedRequestedRows.push(buildRequestedProductMatchEntry(data, offerDetailId));
          continue;
        }

        try {
          const productId = await resolveProductIdFromRequestedInfo(lookupInfo);
          if (productId == null) {
            unmatchedRequestedRows.push(buildRequestedProductMatchEntry(data, offerDetailId));
            continue;
          }
          const parentCategoryId = normalizeOfferDetailId(
            (data as { ParentOfferDetailID?: unknown }).ParentOfferDetailID ?? null,
          );
          const assigned = await assignRequestedRowToProduct(offerDetailId, productId, parentCategoryId);
          if (!assigned) {
            unmatchedRequestedRows.push(buildRequestedProductMatchEntry(data, offerDetailId));
            continue;
          }
          const productMeta = await fetchProductSummary(productId);
          const productDescription = normalizeDescriptionValue(productMeta?.Description ?? null);
          const description = productDescription ?? descriptionOverride ?? null;
          const requestedPartNumberRaw = getExactTextValue(
            (data as { RequestedPartNo?: unknown }).RequestedPartNo ?? null,
          );
          const requestedModelNumberRaw = getExactTextValue(
            (data as { RequestedModelNo?: unknown }).RequestedModelNo ?? null,
          );
          const requestedBrandRaw = getExactTextValue(
            (data as { RequestedBrand?: unknown }).RequestedBrand ?? null,
          );
          const partNumber = requestedPartNumberRaw
            ?? getExactTextValue((data as { PartNumber?: unknown }).PartNumber ?? null)
            ?? productMeta?.PartNumber
            ?? null;
          const modelNumber = requestedModelNumberRaw
            ?? getExactTextValue((data as { ModelNumber?: unknown }).ModelNumber ?? null)
            ?? productMeta?.ModelNumber
            ?? null;
          const brandName = requestedBrandRaw
            ?? getExactTextValue((data as { BrandName?: unknown }).BrandName ?? null)
            ?? productMeta?.BrandName
            ?? null;
          const fallbackProductMeta: ProductSummary = {
            ProductID: productId,
            PartNumber: null,
            ModelNumber: null,
            BrandName: null,
            Description: null,
          };
          const summary = productMeta ?? fallbackProductMeta;
          promoteNodeToProduct(
            node,
            summary,
            partNumber ?? null,
            modelNumber ?? null,
            brandName ?? null,
            description ?? null,
          );
          productsAdded += 1;
        } catch (err) {
          console.error('Failed to populate requested row in offer', err);
        }
        continue;
      }

      if (updates.length > 0) {
        try {
          const res = await fetch(resolvedEndpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payload?.ok) {
            throw new Error(payload?.error ?? `Failed to populate requested rows (status ${res.status})`);
          }
        } catch (err) {
          console.error('Failed to populate requested rows', err);
          showToastMessage('Unable to populate the offer with requested rows. Please try again.', 'error');
          return;
        }
      }

      const manualMatchesRequired = unmatchedRequestedRows.length > 0;
      if (manualMatchesRequired) {
        setRequestedMatchQueue((prev) => [...prev, ...unmatchedRequestedRows]);
      }
      const parts: string[] = [];
      if (categoriesAdded > 0) parts.push(`${categoriesAdded} categor${categoriesAdded === 1 ? 'y' : 'ies'}`);
      if (productsAdded > 0) parts.push(`${productsAdded} product${productsAdded === 1 ? '' : 's'}`);
      if (parts.length === 0) {
        if (manualMatchesRequired) {
          showToastMessage(
            'Some requested products require manual matching. Please resolve them using the matcher.',
            'info',
          );
        }
        return;
      }
      showToastMessage(`Populated ${parts.join(' and ')} in the offer.`, 'success');
      const shouldRefresh = updates.length > 0 || productsAdded > 0;
      if (shouldRefresh) {
        try {
          window.requestAnimationFrame(() => refreshOfferProductGrid(null, { purge: true }));
        } catch {
          refreshOfferProductGrid(null, { purge: true });
        }
      }
      if (manualMatchesRequired) {
        showToastMessage(
          'Some requested products require manual matching. Please resolve them using the matcher.',
          'info',
        );
      }
    } finally {
      finalizeSelection();
    }
  }, [assignRequestedRowToProduct, promoteNodeToCategory, promoteNodeToProduct, refreshOfferProductGrid, resolvedEndpoint]);

  const currentRequestedMatch = requestedMatchQueue[0] ?? null;
  const matchAddProductInitialValues = useMemo<AddProductInitialValues | null>(() => {
    if (!currentRequestedMatch) return null;
    const descriptionParts = [
      currentRequestedMatch.requestedDescription,
      currentRequestedMatch.requestedDescription2,
      currentRequestedMatch.requestedDescription3,
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
    return {
      brandName: currentRequestedMatch.requestedBrand,
      modelNumber: currentRequestedMatch.requestedModelNumber,
      partNumber: currentRequestedMatch.requestedPartNumber,
      description: descriptionParts.join('\n'),
      weblink: currentRequestedMatch.requestedWebLink,
    };
  }, [currentRequestedMatch]);
  const openMatchAddProduct = useCallback(() => setMatchAddProductOpen(true), []);
  const closeMatchAddProduct = useCallback(() => setMatchAddProductOpen(false), []);
  const handleMatchProductAdded = useCallback((result?: { productId?: number | null }) => {
    if (result?.productId != null) {
      setMatchAddedProductId(result.productId);
    }
    try {
      refreshOfferProductGrid(null, { purge: true });
    } catch {
      /* noop */
    }
    closeMatchAddProduct();
  }, [closeMatchAddProduct, refreshOfferProductGrid]);

  const advanceMatchQueue = useCallback(() => {
    setRequestedMatchQueue((prev) => (prev.length > 0 ? prev.slice(1) : prev));
    setProcessedRequestedMatches((prev) => prev + 1);
  }, []);

  const handleManualAssign = useCallback(async (productId: number) => {
    if (!currentRequestedMatch) return false;
    const assigned = await assignRequestedRowToProduct(
      currentRequestedMatch.offerDetailId,
      productId,
      currentRequestedMatch.parentCategoryId,
    );
    if (assigned) {
      showToastMessage('Requested item filled', 'success');
      try {
        refreshOfferProductGrid(null, { purge: true });
      } catch {
        /* noop */
      }
      advanceMatchQueue();
      return true;
    }
    showToastMessage('Unable to assign requested item. Please try again.', 'error');
    return false;
  }, [advanceMatchQueue, assignRequestedRowToProduct, currentRequestedMatch, refreshOfferProductGrid]);

  const handleManualSkip = useCallback(() => {
    if (!currentRequestedMatch) return;
    showToastMessage('Skipped requested item.', 'info');
    advanceMatchQueue();
  }, [advanceMatchQueue, currentRequestedMatch]);

  const handleManualSkipAll = useCallback(() => {
    if (requestedMatchQueue.length === 0) return;
    showToastMessage('Skipped all requested items.', 'info');
    setRequestedMatchQueue([]);
    setProcessedRequestedMatches(0);
  }, [requestedMatchQueue.length]);

  const populateOfferBusyRef = useRef(false);
  const populateOffer = useCallback(async () => {
    if (populateOfferBusyRef.current) return;
    populateOfferBusyRef.current = true;
    try {
      const api = gridApiRef.current;
      if (!api || api.isDestroyed?.()) {
        showToastMessage('Grid is not ready yet.', 'error');
        return;
      }

      let requestedNodes: Array<RowNode<Record<string, unknown>>> = [];

      // Prefer explicit selection when present.
      try {
        const selected = typeof api.getSelectedNodes === 'function'
          ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
          : [];
        requestedNodes = selected.filter((node) => isRequestedRow(node?.data ?? null));
      } catch {
        /* noop */
      }

      // Fallback: if nothing is selected, populate from all currently-loaded requested rows.
      if (requestedNodes.length === 0) {
        try {
          if (typeof api.forEachNode === 'function') {
            const allRequested: Array<RowNode<Record<string, unknown>>> = [];
            api.forEachNode((node) => {
              if (isRequestedRow(node?.data ?? null)) {
                allRequested.push(node as RowNode<Record<string, unknown>>);
              }
            });
            requestedNodes = allRequested;
          }
        } catch {
          /* noop */
        }
      }

      if (requestedNodes.length === 0) {
        showToastMessage('No requested rows found to populate.', 'info');
        return;
      }

      await populateRequestedRowsToOffer(requestedNodes);
    } finally {
      populateOfferBusyRef.current = false;
    }
  }, [populateRequestedRowsToOffer]);

  const fetchExportRows = useCallback(async (): Promise<OfferExportRow[]> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      throw new Error('Grid is not ready yet.');
    }
    const filterModel = api.getFilterModel?.() ?? {};
    const sortModel = api.getColumnState?.()
      ?.filter((col) => col.sort === 'asc' || col.sort === 'desc')
      .map((col) => ({ colId: col.colId, sort: col.sort as 'asc' | 'desc' })) ?? [];
    const quickFilterText = typeof lastServerRequestRef.current?.quickFilterText === 'string'
      ? lastServerRequestRef.current.quickFilterText
      : null;
    const request: Record<string, unknown> = {
      startRow: 0,
      endRow: 1000,
      allRows: true,
      filterModel,
      sortModel,
    };
    if (quickFilterText && quickFilterText.trim().length > 0) {
      request.quickFilterText = quickFilterText.trim();
    }

    const response = await fetch(dataEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request,
        fields: [...OFFER_PRODUCTS_EXPORT_FIELDS],
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: OfferExportRow[] }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to fetch export rows (status ${response.status})`);
    }
    return payload.rows;
  }, [dataEndpoint]);

  const buildTemplateExportRows = useCallback((rows: OfferExportRow[]): OfferProductsTemplateExportRow[] => {
    const includedRows = rows.filter((row) => {
      const rowType = resolveOfferProductRowType(row as unknown as Record<string, unknown>);
      return rowType === 'product' || rowType === 'category' || rowType === 'printable-comment';
    });

    return includedRows.map((row) => {
      const model = (row.ModelNumber ?? '').toString().trim();
      const description = (row.Description ?? '').toString().trim();
      const descriptionType = [model, description].filter((part) => part.length > 0).join(' ').trim();
      const qty = coerceNumber(row.Quantity);
      const netUnitPrice = coerceNumber(row.NetUnitPrice);
      const qtyForExport = qty != null && !Object.is(qty, 0) ? qty : null;
      const deliveryRaw = row.Delivery == null ? '' : String(row.Delivery).trim();
      const deliveryValue = deliveryRaw.length > 0 ? deliveryRaw : 'unknown';
      return {
        no: normalizeNoForExport(row.TreeOrdering),
        productReference: row.PartNumber?.toString().trim() ?? '',
        manufacturer: row.BrandName?.toString().trim() ?? '',
        descriptionType,
        qty: qtyForExport ?? '',
        unitPrice: netUnitPrice ?? '',
        delayForDelivery: deliveryValue,
        comments: row.Comment?.toString() ?? '',
      };
    });
  }, []);

  const getTemplateExportRows = useCallback(async (): Promise<OfferProductsTemplateExportRow[]> => {
    const rows = await fetchExportRows();
    return buildTemplateExportRows(rows);
  }, [buildTemplateExportRows, fetchExportRows]);

  const getAddInsertionAnchor = useCallback((): { offerDetailId: number; parentPath: number[] } | null => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return null;
    try {
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      if (selectedNodes.length === 0) return null;
      for (let idx = selectedNodes.length - 1; idx >= 0; idx -= 1) {
        const row = selectedNodes[idx]?.data ?? null;
        const offerDetailId = normalizeOfferDetailId((row as { OfferDetailID?: unknown } | null)?.OfferDetailID ?? null);
        if (offerDetailId == null) continue;
        const path = parseTreeOrderingPath((row as { TreeOrdering?: unknown } | null)?.TreeOrdering ?? null);
        if (path.length === 0) continue;
        return { offerDetailId, parentPath: path.slice(0, -1) };
      }
    } catch {
      /* noop */
    }
    return null;
  }, []);

  const getSelectedOfferDetailIdsForPriceUpdate = useCallback((): number[] => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return [];
    try {
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      if (selectedNodes.length === 0) return [];
      const ids = selectedNodes
        .filter((node) => isOfferProductProduct(node?.data ?? null))
        .map((node) =>
          normalizeOfferDetailId(
            (node?.data as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null,
          ),
        )
        .filter((id): id is number => id != null);
      return Array.from(new Set(ids));
    } catch {
      return [];
    }
  }, []);

  const getSelectedOfferDetailIds = useCallback((): number[] => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return [];
    try {
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      if (selectedNodes.length === 0) return [];
      const ids = selectedNodes
        .map((node) =>
          normalizeOfferDetailId(
            (node?.data as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null,
          ),
        )
        .filter((id): id is number => id != null);
      return Array.from(new Set(ids));
    } catch {
      return [];
    }
  }, []);

  // Restore selection from initialSelectedOfferDetailIds after grid data loads
  const initialSelectionRestoredRef = useRef(false);
  const pendingInitialSelectionRef = useRef<number[] | null>(
    initialSelectedOfferDetailIds?.length ? initialSelectedOfferDetailIds : null,
  );

  const tryRestoreInitialSelection = useCallback(() => {
    if (initialSelectionRestoredRef.current) return;
    const ids = pendingInitialSelectionRef.current;
    if (!ids || ids.length === 0) return;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    const idSet = new Set(ids);
    let found = false;
    api.forEachNode((node) => {
      if (!node.data) return;
      const offerDetailId = normalizeOfferDetailId(
        (node.data as { OfferDetailID?: unknown }).OfferDetailID ?? null,
      );
      if (offerDetailId != null && idSet.has(offerDetailId)) {
        node.setSelected(true);
        found = true;
      }
    });
    if (found) {
      initialSelectionRestoredRef.current = true;
      pendingInitialSelectionRef.current = null;
      pendingInitialSelectionRestoreRef.current = null;
    }
  }, []);

  // Wire up the restore function so handleGridModelUpdated can call it
  pendingInitialSelectionRestoreRef.current = pendingInitialSelectionRef.current?.length
    ? tryRestoreInitialSelection
    : null;

  useImperativeHandle(
    ref,
    () => ({
      populateOffer,
      getTemplateExportRows,
      getAddInsertionAnchor,
      getSelectedOfferDetailIdsForPriceUpdate,
      getSelectedOfferDetailIds,
    }),
    [getAddInsertionAnchor, getSelectedOfferDetailIds, getSelectedOfferDetailIdsForPriceUpdate, getTemplateExportRows, populateOffer],
  );


  const manualMatchTotal = processedRequestedMatches + requestedMatchQueue.length;
  const manualMatchPosition = currentRequestedMatch ? processedRequestedMatches + 1 : 0;

  const openBrandBulkEdit = useCallback((
    field: 'CurrencyCostModifier' | 'Margin',
    brandName: string,
    currentValue?: unknown,
  ) => {
    const normalizedBrand = brandName.trim();
    if (!normalizedBrand) {
      showToastMessage('Missing brand name for bulk edit.', 'error');
      return;
    }
    setBrandBulkEditField(field);
    setBrandBulkEditBrandName(normalizedBrand);
    setBrandBulkEditError(null);
    const numericCurrent = coerceNumber(currentValue);
    if (field === 'CurrencyCostModifier') {
      setBrandBulkEditValue(String(numericCurrent ?? 1));
    } else {
      setBrandBulkEditValue(String(numericCurrent ?? 0));
    }
    setBrandBulkEditOpen(true);
  }, []);

  const closeBrandBulkEdit = useCallback(() => {
    if (brandBulkEditSaving) return;
    setBrandBulkEditOpen(false);
  }, [brandBulkEditSaving]);

  const confirmBrandBulkEdit = useCallback(async () => {
    if (brandBulkEditSaving) return;
    const brandName = brandBulkEditBrandName.trim();
    if (!brandName) {
      setBrandBulkEditError('Brand is required.');
      return;
    }
    const valueNumber = coerceNumber(brandBulkEditValue);
    const label = brandBulkEditField === 'CurrencyCostModifier' ? 'Cost modifier' : 'Margin';
    if (valueNumber == null || !Number.isFinite(valueNumber)) {
      setBrandBulkEditError(`Please enter a valid ${label.toLowerCase()}.`);
      return;
    }
    if (brandBulkEditField === 'CurrencyCostModifier' && !(valueNumber > 0)) {
      setBrandBulkEditError('Cost modifier must be greater than 0.');
      return;
    }
    if (brandBulkEditField === 'Margin' && Math.abs(valueNumber) >= 100) {
      setBrandBulkEditError('Margin must be between -100 and 100.');
      return;
    }

    setBrandBulkEditSaving(true);
    setBrandBulkEditError(null);
    try {
      // Fetch all product rows for this brand (pivot view excludes categories and requested-only rows).
      const res = await fetch(resolvedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            allRows: true,
            view: 'pivot',
            filterModel: {
              BrandName: {
                filterType: 'text',
                type: 'equals',
                filter: brandName,
              },
            },
          },
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
        | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Unable to load brand rows (status ${res.status})`);
      }
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const ids = rows
        .map((row) => normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
        .filter((id): id is number => id != null);
      if (ids.length === 0) {
        throw new Error('No product rows found for this brand.');
      }

      const chunkSize = 200;
      for (let idx = 0; idx < ids.length; idx += chunkSize) {
        const chunk = ids.slice(idx, idx + chunkSize);
        const updates = chunk.map((OfferDetailID) => ({
          OfferDetailID,
          [brandBulkEditField]: valueNumber,
        }));
        const updateRes = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });
        const updatePayload = (await updateRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!updateRes.ok || !updatePayload?.ok) {
          throw new Error(updatePayload?.error ?? `Bulk update failed (status ${updateRes.status})`);
        }
      }

      showToastMessage(`${label} updated for ${brandName} (${ids.length} items)`, 'success');
      setBrandBulkEditOpen(false);
      refreshOfferProductGrid(null, { purge: false });
    } catch (err) {
      console.error('Brand bulk edit failed', err);
      setBrandBulkEditError(err instanceof Error ? err.message : 'Unable to apply changes.');
    } finally {
      setBrandBulkEditSaving(false);
    }
  }, [
    brandBulkEditBrandName,
    brandBulkEditField,
    brandBulkEditSaving,
    brandBulkEditValue,
    refreshOfferProductGrid,
    resolvedEndpoint,
  ]);

  const productContextMenuItems = useCallback((
    params: GetContextMenuItemsParams<Record<string, unknown>>,
  ) => {
    const baseItems = productRowDeletion.getContextMenuItems(params) ?? [];
    const items = [...baseItems];
    if (pendingContextMenuSelectionClearRef.current) {
      pendingContextMenuSelectionClearRef.current = false;
      setGridRowDeletionContextMenuSelectionSnapshot(params.api ?? null, []);
    }
    const rowNode = params.node ?? null;
    
    // Check if server-side select-all is active
    const api = params.api ?? null;
    const isSelectAllActive = api && typeof api.getServerSideSelectionState === 'function'
      ? (() => {
          const state = api.getServerSideSelectionState();
          return Boolean(state && 'selectAll' in state && Boolean((state as { selectAll?: boolean }).selectAll));
        })()
      : false;
    
    // Get current actual selection from the grid API
    const currentSelectedNodes = !isSelectAllActive && api && typeof api.getSelectedNodes === 'function'
      ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
      : [];
    
    const snapshotNodes = getContextMenuSelectionSnapshot(params.api ?? null);
    
    // Use current selection if available, otherwise fall back to snapshot
    // If snapshot exists but current selection is different (was cleared), use current selection
    const hasCurrentSelection = currentSelectedNodes.length > 0;
    const hasSnapshotSelection = snapshotNodes.length > 0;
    const shouldUseCurrentSelection = hasCurrentSelection || (!hasSnapshotSelection && !isSelectAllActive);
    
    const nodesToConsider = shouldUseCurrentSelection ? currentSelectedNodes : snapshotNodes;
    
    const requestedSelectionIds = nodesToConsider
      .map((node) => normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown })?.OfferDetailID ?? null));
    const clickedRowId = normalizeOfferDetailId(
      (rowNode?.data as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null,
    );
    const snapshotMatchesClick = clickedRowId != null && requestedSelectionIds.some((id) => id === clickedRowId);
    const relevantNodes = nodesToConsider.length > 0 && (snapshotMatchesClick || !rowNode || !rowNode.data)
      ? nodesToConsider
      : rowNode && rowNode.data
        ? [rowNode as RowNode<Record<string, unknown>>]
        : [];
    const rowData = rowNode?.data ?? relevantNodes[0]?.data ?? null;
    if (!rowData) {
      return items;
    }
    const rawProductId = (rowData as { ProductID?: unknown }).ProductID;
    const parsedProductId =
      typeof rawProductId === 'number'
        ? rawProductId
        : typeof rawProductId === 'string'
          ? Number.parseInt(rawProductId, 10)
          : null;
    const resolvedProductId =
      typeof parsedProductId === 'number' &&
      Number.isInteger(parsedProductId) &&
      parsedProductId > 0
        ? parsedProductId
        : null;
    const requestedLookup = buildRequestedLookupInfo(rowData);
    const hasRequestedLookupFields = Boolean(requestedLookup.partNumber || requestedLookup.modelNumber);
    const canViewHistory = Boolean(resolvedProductId) || hasRequestedLookupFields;
    if (canViewHistory) {
      const qs = new URLSearchParams();
      qs.set('backHref', `/offers/${encodeURIComponent(offerId)}/products`);
      qs.set('backLabel', `offer ${offerId}`);

      const historyItem: MenuItemDef = {
        name: "View Product's History",
        icon: productHistoryMenuIcon,
        action: async () => {
          let targetProductId = resolvedProductId;
          if (!targetProductId) {
            const fetchedId = await resolveProductIdFromRequestedInfo(requestedLookup);
            if (!fetchedId) {
              showToastMessage('Unable to find a product for the requested entry.', 'error');
              return;
            }
            targetProductId = fetchedId;
          }
          router.push(`/products/${encodeURIComponent(String(targetProductId))}/history?${qs.toString()}`);
        },
      };

      const deleteIndex = findDeleteMenuItemIndex(items);

      if (deleteIndex >= 0) {
        items.splice(deleteIndex, 0, historyItem);
      } else {
        items.push(historyItem);
      }
    }

    const rowHasRequestedFields = hasRequestedPseudoFields(rowData);

    let deleteIndexAfterHistory = findDeleteMenuItemIndex(items);

    const rowBrandName = typeof (rowData as { BrandName?: unknown } | null | undefined)?.BrandName === 'string'
      ? String((rowData as { BrandName?: unknown }).BrandName).trim()
      : '';
    const canBulkEditBrand = rowBrandName.length > 0 && isOfferProductProduct(rowData);
    if (canBulkEditBrand) {
      const currentModifier = (rowData as { CurrencyCostModifier?: unknown }).CurrencyCostModifier ?? null;
      const currentMargin = (rowData as { Margin?: unknown }).Margin ?? null;
      const otherCurrencyName = typeof (rowData as { OtherCurrencyName?: unknown } | null | undefined)?.OtherCurrencyName === 'string'
        ? String((rowData as { OtherCurrencyName?: unknown }).OtherCurrencyName).trim()
        : '';
      const isEuroCostCurrency =
        !otherCurrencyName ||
        otherCurrencyName === '€' ||
        otherCurrencyName.toLowerCase().includes('eur') ||
        otherCurrencyName.toLowerCase().includes('euro');
      const setModifierItem: MenuItemDef = {
        name: 'Set cost modifier for this brand',
        icon: brandBulkEditMenuIcon,
        action: () => openBrandBulkEdit('CurrencyCostModifier', rowBrandName, currentModifier),
      };
      const setMarginItem: MenuItemDef = {
        name: 'Set margin for this brand',
        icon: brandBulkEditMenuIcon,
        action: () => openBrandBulkEdit('Margin', rowBrandName, currentMargin),
      };
      const bulkItems: MenuItemDef[] = [];
      if (!isEuroCostCurrency) {
        bulkItems.push(setModifierItem);
      }
      bulkItems.push(setMarginItem);
      if (bulkItems.length > 0) {
        if (deleteIndexAfterHistory >= 0) {
          items.splice(deleteIndexAfterHistory, 0, ...bulkItems);
        } else {
          items.push(...bulkItems);
        }
      }
      deleteIndexAfterHistory = findDeleteMenuItemIndex(items);
    }

    const offerDetailId = normalizeOfferDetailId((rowData as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null);
    const canMarkCategory = (
      offerDetailId != null
      && !isOfferProductCategory(rowData)
      && !rowHasRequestedFields
    );
    if (canMarkCategory) {
      const makeCategoryItem: MenuItemDef = {
        name: 'Set as Category',
        icon: categoryMenuIcon,
        action: async () => {
          const previousIsCategory = rowNode?.data ? (rowNode.data as { IsCategory?: unknown }).IsCategory : null;
          const previousIsComment = rowNode?.data ? (rowNode.data as { IsComment?: unknown }).IsComment : null;
          const previousIsPrintable = rowNode?.data ? (rowNode.data as { IsPrintable?: unknown }).IsPrintable : null;
          const previousDescription = rowNode?.data ? (rowNode.data as { Description?: unknown }).Description : null;
          const previousTreeOrdering = rowNode?.data ? (rowNode.data as { TreeOrdering?: unknown }).TreeOrdering : null;
          const previousRequestedFlag = rowNode?.data ? (rowNode.data as { __isRequestedRow?: unknown }).__isRequestedRow : null;
          const requestedDescriptionPrimary = normalizeDescriptionValue(
            (rowData as { RequestedDescription?: unknown }).RequestedDescription ?? null,
          );
          const requestedDescriptionSecondary = normalizeDescriptionValue(
            (rowData as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
          );
          const requestedDescriptionValue = requestedDescriptionPrimary ?? requestedDescriptionSecondary;
          const descriptionValue = requestedDescriptionValue
            ?? normalizeDescriptionValue((rowData as { Description?: unknown }).Description ?? null);
          const requestedTree = normalizeRequestedItemNoValue((rowData as { RequestedItemNo?: unknown }).RequestedItemNo ?? null);
          const treeOrderingRaw = (rowData as { TreeOrdering?: unknown }).TreeOrdering;
          const treeOrderingValue = requestedTree || (typeof treeOrderingRaw === 'string'
            ? treeOrderingRaw.trim()
            : null);
          promoteNodeToCategory(
            rowNode,
            treeOrderingValue ?? null,
            descriptionValue ?? null,
            requestedTree,
          );
          try {
            const payloadEntry: Record<string, unknown> = {
              OfferDetailID: offerDetailId,
              IsCategory: 1,
              IsComment: false,
              IsPrintable: null,
            };
            if (descriptionValue != null) {
              payloadEntry.Description = descriptionValue;
            }
            if (treeOrderingValue != null) {
              payloadEntry.TreeOrdering = treeOrderingValue;
              if (requestedTree != null) {
                payloadEntry.RequestedItemNo = requestedTree;
              }
            }
            if (requestedDescriptionPrimary != null) {
              payloadEntry.RequestedDescription = requestedDescriptionPrimary;
            }
            if (requestedDescriptionSecondary != null) {
              payloadEntry.RequestedDescription2 = requestedDescriptionSecondary;
            }
            const res = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                updates: [payloadEntry],
              }),
            });
            const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
            if (!res.ok || !payload?.ok) {
              throw new Error(payload?.error ?? `Unable to mark category (status ${res.status})`);
            }
            showToastMessage('Marked as category', 'success');
            try {
              gridApiRef.current?.refreshServerSide?.({ purge: false });
            } catch {
              /* noop */
            }
          } catch (err) {
            if (rowNode) {
              try {
                rowNode.setDataValue('IsCategory', previousIsCategory ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('IsComment', previousIsComment ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('IsPrintable', previousIsPrintable ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('Description', previousDescription ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('__isRequestedRow', previousRequestedFlag ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('TreeOrdering', previousTreeOrdering ?? null);
              } catch {
                /* noop */
              }
            }
            console.error('Failed to mark category', err);
            showToastMessage('Unable to mark row as category. Please try again.', 'error');
          }
        },
      };
      if (deleteIndexAfterHistory >= 0) {
        items.splice(deleteIndexAfterHistory, 0, makeCategoryItem);
      } else {
        items.push(makeCategoryItem);
      }
    }

    return items;
  }, [
    productRowDeletion,
    router,
    offerId,
    promoteNodeToCategory,
    resolvedEndpoint,
    openBrandBulkEdit,
  ]);

  const getCellEditorRawValue = (
    event: CellValueChangedEvent<Record<string, unknown>>,
  ): string | null => {
    const domEvent = (event as { event?: Event }).event;
    if (!domEvent) return null;
    const target = domEvent.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return target.value ?? null;
    }
    return null;
  };

  const handleRequestedFieldEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!isRequestedFieldKey(field)) return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;
    if (!canEditRequestedField(field, event.data)) return;

    const label = REQUESTED_FIELD_LABELS[field];
    const friendlyLabel = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
    let normalizedOldValue: string | number | null = null;
    let normalizedNewValue: string | number | null = null;

    if (field === 'RequestedQuantity') {
      const rawInput = getCellEditorRawValue(event);
      const candidateValue = rawInput ?? event.newValue;
      normalizedNewValue = normalizeRequestedQuantityValue(candidateValue ?? null);
      normalizedOldValue = normalizeRequestedQuantityValue(event.oldValue ?? null);
      const hasProvidedValue = Boolean(
        (rawInput != null && rawInput.trim().length > 0)
        || (typeof event.newValue === 'number' && Number.isFinite(event.newValue)),
      );
      if (hasProvidedValue && normalizedNewValue == null) {
        showToastMessage('Please enter a valid requested quantity (zero or more).', 'error');
        try {
          event.node?.setDataValue?.(field, normalizedOldValue ?? '');
        } catch {
          /* noop */
        }
        return;
      }
    } else if (field === 'RequestedItemNo') {
      normalizedNewValue = normalizeRequestedItemNoValue(event.newValue ?? null);
      normalizedOldValue = normalizeRequestedItemNoValue(event.oldValue ?? null);
    } else {
      normalizedNewValue = normalizeRequestedLookupValue(event.newValue ?? null);
      normalizedOldValue = normalizeRequestedLookupValue(event.oldValue ?? null);
    }

    if (Object.is(normalizedNewValue, normalizedOldValue)) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId(
      (event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null,
    );
    if (offerDetailId == null) {
      showToastMessage(`Unable to update ${friendlyLabel}. Missing record identifier.`, 'error');
      try {
        event.node?.setDataValue?.(field, normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.(field, normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, [field]: normalizedNewValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${friendlyLabel} (status ${res.status})`);
        }
        showToastMessage(`${friendlyLabel} updated`, 'success');
      } catch (err) {
        console.error(`Failed to update ${friendlyLabel}`, err);
        showToastMessage(`Unable to update ${friendlyLabel}. Please try again.`, 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit]);

  const handleQuantityEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Quantity') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;
      if (!isOfferProductCommentOrProduct(event.data)) {
        try {
          event.node?.setDataValue?.('Quantity', event.oldValue ?? '');
        } catch {
          /* noop */
        }
      return;
    }

    const normalizedOldValue = coerceNumber(event.oldValue);
    const normalizedNewValue = coerceNumber(event.newValue);
    if (normalizedNewValue == null || normalizedNewValue < 0) {
      showToastMessage('Please enter a valid quantity (zero or more).', 'error');
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }
    if (normalizedOldValue != null && Object.is(normalizedOldValue, normalizedNewValue)) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update quantity. Missing record identifier.', 'error');
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, Quantity: normalizedNewValue }],
          }),
        });
        let payload: { ok?: boolean; error?: string } | null = null;
        try {
          payload = (await res.json()) as { ok?: boolean; error?: string } | null;
        } catch {
          payload = null;
        }
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update quantity (status ${res.status})`);
        }
        showToastMessage('Quantity updated', 'success');
        recalcProductTotals(event, normalizedNewValue);
        refreshCategoryAggregates(event.api);
      } catch (err) {
        console.error('Failed to update quantity', err);
        showToastMessage('Unable to update quantity. Please try again.', 'error');
        revertValue();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit]);

  const handleDescriptionEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Description') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;
    const normalizedOldValue = normalizeDescriptionValue(event.oldValue);
    const normalizedNewValue = normalizeDescriptionValue(event.newValue);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }
    // All edits here target the offer-specific ProductDescription so shared product rows stay untouched.
    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update description. Missing record identifier.', 'error');
      event.node?.setDataValue?.('Description', normalizedOldValue ?? '');
      return;
    }
    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Description', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };
    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: [{ OfferDetailID: offerDetailId, ProductDescription: normalizedNewValue }],
        }),
        });
        let payload: { ok?: boolean; error?: string } | null = null;
        try {
          payload = (await res.json()) as { ok?: boolean; error?: string } | null;
        } catch {
          payload = null;
        }
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update description (status ${res.status})`);
        }
        showToastMessage('Description updated', 'success');
      } catch (err) {
        console.error('Failed to update description', err);
        showToastMessage('Unable to update description. Please try again.', 'error');
        revertValue();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit]);

  const handleCommentEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Comment') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    const row = event.data ?? null;
    if (!isOfferProductCategory(row) && !isOfferProductComment(row) && !isOfferProductProduct(row)) {
      try {
        event.node?.setDataValue?.('Comment', event.oldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const normalizedOldValue = normalizeDescriptionValue(event.oldValue);
    const normalizedNewValue = normalizeDescriptionValue(event.newValue);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update comment. Missing record identifier.', 'error');
      try {
        event.node?.setDataValue?.('Comment', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Comment', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, Comment: normalizedNewValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update comment (status ${res.status})`);
        }
        showToastMessage('Comment updated', 'success');
      } catch (err) {
        console.error('Failed to update comment', err);
        showToastMessage('Unable to update comment. Please try again.', 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit]);

  const handleDeliveryEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Delivery') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    const normalizedOldValue = normalizeRequestedLookupValue(event.oldValue ?? null);
    const normalizedNewValue = normalizeRequestedLookupValue(event.newValue ?? null);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update delivery. Missing record identifier.', 'error');
      try {
        event.node?.setDataValue?.('Delivery', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Delivery', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, Delivery: normalizedNewValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update delivery (status ${res.status})`);
        }
        showToastMessage('Delivery updated', 'success');
      } catch (err) {
        console.error('Failed to update delivery', err);
        showToastMessage('Unable to update delivery. Please try again.', 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit]);

  const handlePricingEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !PRICING_EDITABLE_FIELDS.has(field)) return;
    const label = PRICING_FIELD_LABELS[field] ?? field;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    if (!isOfferProductCommentOrProduct(event.data)) {
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      showToastMessage('Pricing can only be edited on product or comment rows.', 'error');
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage(`Unable to update ${label}. Missing record identifier.`, 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }

    let normalizedNewValue = coerceNumber(event.newValue);
    if (field === 'CurrencyCostModifier') {
      if (source === 'delete' && normalizedNewValue == null) {
        normalizedNewValue = 1;
      }
      if (normalizedNewValue == null && String(event.newValue ?? '').trim() === '') {
        normalizedNewValue = 1;
      }
    } else {
      if (source === 'delete' && normalizedNewValue == null) {
        normalizedNewValue = 0;
      }
      if (normalizedNewValue == null && String(event.newValue ?? '').trim() === '') {
        normalizedNewValue = 0;
      }
    }
    if (normalizedNewValue == null || !Number.isFinite(normalizedNewValue)) {
      showToastMessage(`Please enter a valid ${label.toLowerCase()}.`, 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }
    if (field === 'Margin' && Math.abs(normalizedNewValue) >= 100) {
      showToastMessage('Margin must be between -100 and 100.', 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }
    if (field === 'CurrencyCostModifier') {
      if (!Number.isFinite(normalizedNewValue) || !(normalizedNewValue > 0)) {
        showToastMessage('Cost modifier must be greater than 0.', 'error');
        try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
        return;
      }
    }

    const normalizedOldValue = coerceNumber(event.oldValue);
    if (normalizedOldValue != null && Object.is(normalizedOldValue, normalizedNewValue)) {
      return;
    }

    const revertValue = () => {
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ OfferDetailID: offerDetailId, [field]: normalizedNewValue }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label} (status ${res.status})`);
        }
        const toastKey = `${offerDetailId}:${field}:${String(normalizedNewValue)}`;
        const now = Date.now();
        const lastShown = pricingToastDedupRef.current.get(toastKey) ?? 0;
        if (now - lastShown > 800) {
          pricingToastDedupRef.current.set(toastKey, now);
          showToastMessage(`${label} updated`, 'success');
        }
        recalcProductTotals(event);
        refreshCategoryAggregates(event.api);
        try {
          refreshOfferProductGrid(event.api ?? null, { purge: false });
        } catch {
          /* noop */
        }
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, [refreshOfferProductGrid, resolvedEndpoint, shouldSkipRealtimeCellEdit]);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    handleDescriptionEdit(event);
    handleCommentEdit(event);
    handleDeliveryEdit(event);
    handleRequestedFieldEdit(event);
    handleQuantityEdit(event);
    handlePricingEdit(event);
  }, [handleDescriptionEdit, handleCommentEdit, handleDeliveryEdit, handleRequestedFieldEdit, handleQuantityEdit, handlePricingEdit]);

  const formatEuroTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} €`;
  };
  const formatPercentTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} %`;
  };

  // Real-time updates for collaborative editing
  // showNotifications: false - only the person making the edit sees toasts from their own actions
  useRealtimeGridUpdates({
    resource: `offer:${offerId}:products`,
    gridApi: gridApiRef.current,
    enabled: true,
    showNotifications: false,
    onBeforeCellUpdate: (info) => {
      registerRealtimeCellUpdate(info.rowId, info.field, info.value);
    },
  });

  return (
    <>
      <div className={styles.panel}>
        <div className={`${styles.gridWrapper} offer-products-grid`}>
          <AgGridAll
            endpoint={dataEndpoint}
            persistenceEndpoint={persistenceEndpoint}
            columnDefs={productColumnDefs}
            defaultColDef={defaultColDef}
            manualMode={manualMode}
            getRowClass={getRowClass}
            getContextMenuItems={productContextMenuItems}
            onCellValueChanged={handleCellEdit}
            refreshToken={refreshToken}
            onGridReady={handleGridReady}
            onModelUpdated={handleGridModelUpdated}
            onRowDoubleClicked={handleRowDoubleClicked}
            enableColumnStatePersistence
            autoPersistColumnState={false}
            applyColumnStateOrder
            maintainColumnOrder
            columnStateNamespace={columnStateNamespace}
            onTotalsChange={handleTotalsChange}
            onResponse={handleGridResponse}
            onServerRequest={handleServerRequest}
            getRowHeight={getRowHeight}
            floatingFilter
            rowGroupPanelShow="never"
            rowSelection="multiple"
            rowMultiSelectWithClick
            rowDeselection
            useAgGridRowDrag
            serverSideHeaderSelectMode="all"
            suppressColumnVirtualisation={false}
            cacheBlockSize={20}
            rowBuffer={5}
            maxBlocksInCache={2}
          />
        </div>
        {hideTotals ? null : (
          <div className={styles.totalsBar}>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Net Price</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalNetPrice)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total List Price</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalListPrice)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Cost</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalCost)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Margin</span>
              <span className={styles.totalValue}>{formatPercentTotal(totals?.totalMargin)}</span>
            </div>
          </div>
        )}
      </div>
      {currentRequestedMatch ? (
      <MatchRequestedProductsModal
        offerId={offerId}
        entry={currentRequestedMatch}
        position={manualMatchPosition}
        total={manualMatchTotal}
        onAssign={handleManualAssign}
        onSkip={handleManualSkip}
        onSkipAll={handleManualSkipAll}
        onRequestAddProduct={openMatchAddProduct}
        newProductId={matchAddedProductId}
          onClearNewProductId={clearMatchAddedProductId}
          onRequestPayloadConsumed={clearMatchAddedProductId}
        />
      ) : null}
      <AddProductModal
        open={matchAddProductOpen}
        onAdded={handleMatchProductAdded}
        onClose={closeMatchAddProduct}
        initialValues={matchAddProductInitialValues}
      />
      <LookupModal
        open={brandBulkEditOpen}
        title={brandBulkEditField === 'CurrencyCostModifier' ? 'Bulk edit cost modifier by brand' : 'Bulk edit margin by brand'}
        onClose={closeBrandBulkEdit}
        onConfirm={confirmBrandBulkEdit}
        confirmLabel="Apply"
        saving={brandBulkEditSaving}
        error={brandBulkEditError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="bulk-edit-brand-name">
            Brand
          </label>
          <input
            id="bulk-edit-brand-name"
            className={lookupStyles.fieldControl}
            value={brandBulkEditBrandName}
            readOnly
          />
        </div>
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="bulk-edit-brand-value">
            {brandBulkEditField === 'CurrencyCostModifier' ? 'Cost modifier' : 'Margin (%)'}
          </label>
          <input
            id="bulk-edit-brand-value"
            className={lookupStyles.fieldControl}
            value={brandBulkEditValue}
            inputMode="decimal"
            onChange={(e) => setBrandBulkEditValue(e.target.value)}
          />
        </div>
      </LookupModal>
    </>
  );
});

OfferProductsPanel.displayName = 'OfferProductsPanel';

export default React.memo(OfferProductsPanel);
