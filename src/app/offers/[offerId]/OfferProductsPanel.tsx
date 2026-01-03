'use client';

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import { useContext } from 'react';
import type {
  CellValueChangedEvent,
  ColDef,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  ICellRendererParams,
  IRowNode,
  MenuItemDef,
  RowClassParams,
  RowDoubleClickedEvent,
  RowHeightParams,
  RowNode,
  ServerSideRowSelectionState,
  ValueFormatterParams,
  ValueGetterParams,
  ValueSetterParams,
  Column,
} from 'ag-grid-community';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import styles from './OfferProductsPanel.module.css';
import type { GridTotals, GridResponse, ServerRequestWithQuickFilter } from '../../components/AgGridAll';

const AgGridAll = dynamic(() => import('../../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading products…
    </div>
  ),
});
import { showToastMessage } from '../../../lib/toast';
import { GridRowDeletion, getContextMenuSelectionSnapshot, setGridRowDeletionContextMenuSelectionSnapshot } from '../../../lib/gridRowDeletion';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment } from '../../../lib/offerProductRows';
import { priceListStatusClassRules } from '../../../lib/priceListStatus';
import { GridQuickSearchContext } from '../../components/GridQuickSearchProvider';
import MatchRequestedProductsModal, {
  type RequestedProductMatchEntry,
} from './products/MatchRequestedProductsModal';
import AddProductModal from '../../products/AddProductModal';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const decimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const hasServerSideSelectAll = (api: GridApi<Record<string, unknown>> | null) => {
  if (!api || typeof api.getServerSideSelectionState !== 'function') return false;
  const state = api.getServerSideSelectionState();
  return Boolean(state && 'selectAll' in state && Boolean((state as ServerSideRowSelectionState).selectAll));
};

type GridRowNode = RowNode<Record<string, unknown>> | IRowNode<Record<string, unknown>>;

const plainNumberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const coerceNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
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
  | 'RequestedModelNo'
  | 'RequestedPartNo'
  | 'RequestedDescription'
  | 'RequestedDescription2'
  | 'RequestedDescription3'
  | 'RequestedQuantity';

type RequestedDisplayFieldKey = Exclude<RequestedFieldKey, 'RequestedItemNo'>;
const REQUESTED_DISPLAY_FIELD_KEYS: RequestedDisplayFieldKey[] = [
  'RequestedBrand',
  'RequestedModelNo',
  'RequestedPartNo',
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
  'RequestedQuantity',
];

const REQUESTED_FIELD_LABELS: Record<RequestedFieldKey, string> = {
  RequestedItemNo: 'requested item number',
  RequestedBrand: 'requested brand',
  RequestedModelNo: 'requested model number',
  RequestedPartNo: 'requested part number',
  RequestedDescription: 'requested description',
  RequestedDescription2: 'requested description 2',
  RequestedDescription3: 'requested description 3',
  RequestedQuantity: 'requested quantity',
};
const REQUESTED_FIELD_SET = new Set<RequestedFieldKey>([
  'RequestedItemNo',
  'RequestedBrand',
  'RequestedModelNo',
  'RequestedPartNo',
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

const compareTreeOrderingPaths = (a: number[], b: number[]) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const max = Math.max(a.length, b.length);
  for (let idx = 0; idx < max; idx += 1) {
    const hasA = idx < a.length;
    const hasB = idx < b.length;
    if (!hasA && !hasB) return 0;
    if (!hasA) return -1;
    if (!hasB) return 1;
    const va = a[idx];
    const vb = b[idx];
    if (va !== vb) return va - vb;
  }
  return 0;
};

const formatTreeOrderingPath = (segments: number[]) => segments.join('.');

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
  };
};

const hasRequestedLookupIdentifiers = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  const part = normalizeRequestedLookupValue((row as { RequestedPartNo?: unknown }).RequestedPartNo ?? null);
  const model = normalizeRequestedLookupValue((row as { RequestedModelNo?: unknown }).RequestedModelNo ?? null);
  const brand = normalizeRequestedLookupValue((row as { RequestedBrand?: unknown }).RequestedBrand ?? null);
  return Boolean(part || model || brand);
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

const isTruthyFlag = (value: unknown): boolean => {
  if (value == null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
};

const shouldSyncRequestedItemNo = (row: Record<string, unknown> | null | undefined) => {
  if (!row) return false;
  if (!hasRequestedRowData(row)) return false;
  if (!isTruthyFlag((row as { IsCategory?: unknown }).IsCategory)) return false;
  if (isTruthyFlag((row as { IsComment?: unknown }).IsComment)) return false;
  return true;
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
  const params = new URLSearchParams();
  if (partNumber) params.set('partNumber', partNumber);
  if (modelNumber) params.set('modelNumber', modelNumber);
  if (brand) params.set('brand', brand);
  const cacheKey = `${partNumber ?? ''}|${modelNumber ?? ''}|${brand ?? ''}`;
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

const populateOfferMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--copy" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M7 5h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />
      <path d="M7 7V5a2 2 0 0 1 2-2h6" />
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
  NetCost: 'Net Cost',
  Margin: 'Margin',
  ListPrice: 'List Price',
};

const PRICING_EDITABLE_FIELDS = new Set(Object.keys(PRICING_FIELD_LABELS));

const findDeleteMenuItemIndex = (
  items: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string>,
) => items.findIndex((item) => {
  if (!item || typeof item !== 'object') return false;
  const { name } = item as MenuItemDef<Record<string, unknown>>;
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return normalized === 'delete row' || normalized === 'delete rows';
});

type Props = {
  offerId: string;
  endpoint?: string;
  manualMode?: boolean;
  refreshToken?: number;
  showRequestedColumns?: boolean;
};

const buildEndpointForOffer = (offerId: string) =>
  `/api/offers/${encodeURIComponent(offerId)}/products`;

export default function OfferProductsPanel({
  offerId,
  endpoint,
  manualMode = false,
  refreshToken = 0,
  showRequestedColumns = true,
}: Props) {
  const router = useRouter();
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    return buildEndpointForOffer(offerId);
  }, [endpoint, offerId]);
  const quickSearchContext = useContext(GridQuickSearchContext);
  const quickSearchActive = Boolean(quickSearchContext?.value?.trim());
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
    RequestedDescription: false,
    RequestedDescription2: false,
    RequestedDescription3: false,
    RequestedQuantity: false,
  });
  const [requestedItemNoVisible, setRequestedItemNoVisible] = useState(false);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const [requestedColumnsReady, setRequestedColumnsReadyFlag] = useState(false);
  const [requestedMatchQueue, setRequestedMatchQueue] = useState<RequestedProductMatchEntry[]>([]);
  const [processedRequestedMatches, setProcessedRequestedMatches] = useState(0);
  const [collapsedCategoryPaths, setCollapsedCategoryPaths] = useState<Set<string>>(() => new Set());
  const [categoryPathsWithChildren, setCategoryPathsWithChildren] = useState<Set<string>>(() => new Set());
  const [categoryChildrenKnown, setCategoryChildrenKnown] = useState(false);
  const treeOrderingRootMapRef = useRef<Map<string, number>>(new Map());
  const serverRowsRef = useRef<Array<Record<string, unknown>>>([]);
  const appliedRequestedColumnVisibilityRef = useRef<Record<RequestedDisplayFieldKey, boolean> | null>(null);
  const appliedRequestedItemNoVisibleRef = useRef<boolean>(false);
  const appliedShowRequestedColumnsRef = useRef<boolean | null>(null);
  const lastServerRequestRef = useRef<ServerRequestWithQuickFilter | null>(null);
  const lastRowCountRef = useRef<number | null>(null);
  const headerSelectAllInFlightRef = useRef(false);
  const [matchAddProductOpen, setMatchAddProductOpen] = useState(false);
  const [matchAddedProductId, setMatchAddedProductId] = useState<number | null>(null);
  const clearMatchAddedProductId = useCallback(() => setMatchAddedProductId(null), []);
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
    const path = parseTreeOrderingPath(value);
    if (path.length === 0) return '';
    const map = treeOrderingRootMapRef.current;
    const key = String(path[0]);
    let rootIndex = map.get(key);
    if (rootIndex == null) {
      rootIndex = map.size + 1;
      map.set(key, rootIndex);
    }
    const displayPath = [rootIndex, ...path.slice(1)];
    return formatTreeOrderingPath(displayPath);
  }, []);

  const applyRequestedColumnVisibility = useCallback((visibility: Partial<Record<RequestedDisplayFieldKey, boolean>> | null | undefined, replace = false) => {
    const resetState = {
      RequestedBrand: false,
      RequestedModelNo: false,
      RequestedPartNo: false,
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
      if (prev.size === next.size) {
        let identical = true;
        for (const value of prev) {
          if (!next.has(value)) {
            identical = false;
            break;
          }
        }
        if (identical) return prev;
      }
      return next;
    });
    setCollapsedCategoryPaths((prev) => {
      let changed = false;
      const nextCollapsed = new Set(prev);
      for (const value of prev) {
        if (!next.has(value)) {
          nextCollapsed.delete(value);
          changed = true;
        }
      }
      return changed ? nextCollapsed : prev;
    });
    setCategoryChildrenKnown(true);
  }, []);

  const autoSizeExclusions = useMemo<string[]>(() => [
    'Description',
    'RequestedItemNo',
    ...REQUESTED_DISPLAY_FIELD_KEYS,
  ], []);

  const autoSizeOfferColumns = useCallback(() => {
    const run = () => {
      const api = gridApiRef.current;
      if (!api || api.isDestroyed?.()) return;
      const displayed: Column[] | null =
        typeof api.getAllDisplayedColumns === 'function'
          ? api.getAllDisplayedColumns()
          : null;
      if (!displayed || displayed.length === 0) return;
      const exclusions = new Set(autoSizeExclusions);
      const columnsToSize = displayed.filter((column) => {
        const colId =
          typeof column.getColId === 'function'
            ? column.getColId()
            : typeof (column as { getId?: () => string }).getId === 'function'
              ? (column as { getId?: () => string }).getId?.()
              : null;
        if (!colId) return true;
        return !exclusions.has(colId);
      });
      if (columnsToSize.length === 0) return;
      const columnIds = columnsToSize
        .map((column) => {
          if (typeof column.getColId === 'function') return column.getColId();
          if (typeof (column as { getId?: () => string }).getId === 'function') {
            return (column as { getId?: () => string }).getId?.();
          }
          return null;
        })
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (columnIds.length === 0) return;
      api.autoSizeColumns(columnIds, false);
    };

    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(run);
    } else {
      setTimeout(run, 0);
    }
  }, [autoSizeExclusions]);

  const triggerAutoSize = useCallback(() => {
    autoSizeOfferColumns();
  }, [autoSizeOfferColumns]);

  useEffect(() => {
    if (!requestedColumnsReady) return;
    const api = gridApiRef.current;
    if (!api) return;

    const keys = REQUESTED_DISPLAY_FIELD_KEYS;
    const forcedHiddenVisibility = keys.reduce<Record<RequestedDisplayFieldKey, boolean>>((acc, key) => {
      acc[key] = false;
      return acc;
    }, {} as Record<RequestedDisplayFieldKey, boolean>);
    const effectiveVisibility = showRequestedColumns ? requestedColumnVisibility : forcedHiddenVisibility;
    const effectiveItemNoVisible = showRequestedColumns ? requestedItemNoVisible : false;

    const previousVisibility = appliedRequestedColumnVisibilityRef.current;
    const visibilityChanged = !previousVisibility
      || appliedShowRequestedColumnsRef.current !== showRequestedColumns
      || keys.some((key) => previousVisibility?.[key] !== effectiveVisibility[key]);
    const itemNoVisibilityChanged = appliedRequestedItemNoVisibleRef.current !== effectiveItemNoVisible;
    if (!visibilityChanged && !itemNoVisibilityChanged) {
      return;
    }

    try {
      const hiddenKeys = keys.filter((key) => !effectiveVisibility[key]);
      const visibleKeys = keys.filter((key) => effectiveVisibility[key]);
      if (hiddenKeys.length > 0) {
        api.setColumnsVisible(hiddenKeys, false);
      }
      if (visibleKeys.length > 0) {
        api.setColumnsVisible(visibleKeys, true);
      }
      if (itemNoVisibilityChanged) {
        api.setColumnsVisible(['RequestedItemNo'], effectiveItemNoVisible);
      }
    } catch {
      /* noop */
    }

    appliedRequestedColumnVisibilityRef.current = { ...effectiveVisibility };
    appliedRequestedItemNoVisibleRef.current = effectiveItemNoVisible;
    appliedShowRequestedColumnsRef.current = showRequestedColumns;
    triggerAutoSize();
  }, [requestedColumnVisibility, requestedColumnsReady, requestedItemNoVisible, triggerAutoSize, showRequestedColumns]);

  const handleGridResponse = useCallback((response: GridResponse | null) => {
    lastRowCountRef.current = response?.rowCount ?? null;
    const hasRows = Boolean(response?.rowCount && response.rowCount > 0);
    serverRowsRef.current = Array.isArray(response?.rows) ? response.rows : [];
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
    updateCategoryAncestors();
    if (!quickSearchActive) {
      triggerAutoSize();
    }
  }, [applyRequestedColumnVisibility, rebuildTreeOrderingRootMap, quickSearchActive, updateCategoryAncestors, triggerAutoSize]);

  const handleServerRequest = useCallback((request: ServerRequestWithQuickFilter) => {
    lastServerRequestRef.current = request;
  }, []);

  const fetchAllRowsFromServer = useCallback(async () => {
    const templateRequest = lastServerRequestRef.current ?? {};
    const limit = 1000;
    const accumulated: Array<Record<string, unknown>> = [];
    let startRow = 0;
    let totalCount = typeof lastRowCountRef.current === 'number' && Number.isFinite(lastRowCountRef.current)
      ? lastRowCountRef.current
      : Number.POSITIVE_INFINITY;

    while (startRow < totalCount) {
      const payload = {
        request: {
          ...templateRequest,
          startRow,
          endRow: startRow + limit,
        },
      };
      const res = await fetch(resolvedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => null)) as GridResponse | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Failed to fetch rows (status ${res.status})`);
      }
      const rows = Array.isArray(data.rows) ? data.rows : [];
      if (rows.length === 0) break;
      accumulated.push(...rows);
      if (typeof data.rowCount === 'number' && Number.isFinite(data.rowCount)) {
        totalCount = data.rowCount;
      }
      if (accumulated.length >= totalCount) break;
      startRow = accumulated.length;
    }

    return accumulated;
  }, [resolvedEndpoint]);

  const handleHeaderSelectAllChange = useCallback(async (
    selected: boolean,
    api: GridApi<Record<string, unknown>> | null,
  ) => {
    if (!selected) {
      setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, []);
      return;
    }
    if (headerSelectAllInFlightRef.current) return;
    headerSelectAllInFlightRef.current = true;
    try {
      const rows = await fetchAllRowsFromServer();
      if (rows.length === 0) {
        setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, []);
        return;
      }
      const nodes = rows.map((data) => ({ data } as RowNode<Record<string, unknown>>));
      setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, nodes);
    } catch (err) {
      console.error('Failed to load all rows for selection', err);
      showToastMessage('Unable to select all rows. Please try again.', 'error');
    } finally {
      headerSelectAllInFlightRef.current = false;
    }
  }, [fetchAllRowsFromServer]);

  const syncRequestedItemNumbers = useCallback((apiParam?: GridApi<Record<string, unknown>> | null) => {
    const api = apiParam ?? gridApiRef.current;
    if (!api) return;
    const requestedEntries: Array<{
      node: IRowNode<Record<string, unknown>>;
      path: number[];
      offerDetailId: number;
    }> = [];
    api.forEachNode((node) => {
      const row = node.data ?? null;
      if (!row) return;
      if (!isRequestedRow(row)) return;
      const offerDetailId = normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
      if (offerDetailId == null) return;
      if (!shouldSyncRequestedItemNo(row)) return;
      const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      requestedEntries.push({ node, path, offerDetailId });
    });
    if (requestedEntries.length === 0) return;
    requestedEntries.sort((a, b) => compareTreeOrderingPaths(a.path, b.path));
    const updates: Array<{ OfferDetailID: number; RequestedItemNo: string }> = [];
    requestedEntries.forEach((entry, idx) => {
      const targetNumber = entry.path.length > 0
        ? formatTreeOrderingPath(entry.path)
        : String(idx + 1);
      const currentNumber = normalizeRequestedItemNoValue(entry.node.data?.RequestedItemNo ?? null) ?? '';
      if (currentNumber === targetNumber) return;
      updates.push({ OfferDetailID: entry.offerDetailId, RequestedItemNo: targetNumber });
      try {
        entry.node.setDataValue?.('RequestedItemNo', targetNumber);
      } catch {
        /* noop */
      }
    });
    if (updates.length === 0) return;
    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Unable to update requested item numbers (status ${res.status})`);
        }
      } catch (err) {
        console.error('Failed to update requested item numbers', err);
        showToastMessage('Unable to sync requested item numbers. Please refresh the grid.', 'error');
      }
    };
    void runUpdate();
  }, [resolvedEndpoint]);

  const handleRowsMoved = useCallback((api: GridApi<Record<string, unknown>>) => {
    syncRequestedItemNumbers(api);
    api.applyColumnState({
      state: [{ colId: 'RequestedItemNo', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: false,
    });
    try {
      api.refreshClientSideRowModel();
    } catch {
      /* noop */
    }
  }, [syncRequestedItemNumbers]);

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    gridApiRef.current = api;
    setRequestedColumnsReadyFlag(true);
  }, [setRequestedColumnsReadyFlag]);

  const handleGridModelUpdated = useCallback(() => {
    updateCategoryAncestors();
    triggerAutoSize();
  }, [updateCategoryAncestors, triggerAutoSize]);

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

  const hasCollapsedAncestor = useCallback((path: number[]) => {
    for (let idx = 1; idx < path.length; idx += 1) {
      const ancestorKey = buildTreeOrderingKey(path.slice(0, idx));
      if (ancestorKey && collapsedCategoryPaths.has(ancestorKey)) {
        return true;
      }
    }
    return false;
  }, [collapsedCategoryPaths]);

  const getRowHeight = useCallback((params: RowHeightParams<Record<string, unknown>>) => {
    const row = params.data ?? null;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length > 0 && hasCollapsedAncestor(path)) {
      return 0;
    }
    return 32;
  }, [hasCollapsedAncestor]);

  const toggleCategoryCollapsed = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return;
    if (!hasCategoryChildren(row)) return;
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
    const path = parseTreeOrderingPath(
      (params.data as { TreeOrdering?: string | null } | null | undefined)?.TreeOrdering ?? null,
    );
    if (path.length > 0 && hasCollapsedAncestor(path)) {
      classes.push('offer-row--category-descendant-collapsed');
    }
    if (classes.length === 0) {
      return undefined;
    }
    return classes.join(' ');
  }, [isCategoryRowCollapsed, hasCategoryChildren, hasCollapsedAncestor]);

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
    const hasChildren = isCategory && hasCategoryChildren(rowData);
    const collapsed = isCategory && isCategoryRowCollapsed(rowData);
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
        toggleCategoryCollapsed(rowData);
      }
    };

    const indicatorLabel = hasChildren
      ? (collapsed ? 'Expand category' : 'Collapse category')
      : 'Category without child entries';

    const display = value;
    return (
      <span className={styles.treeOrderingCell}>
        <span>{display}</span>
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
      </span>
    );
  }, [hasCategoryChildren, isCategoryRowCollapsed, toggleCategoryCollapsed, formatDisplayTreeOrdering]);

const RequestedItemNoCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
  const value = params.value;
  const rowData = params.data ?? null;
  const isCategory = isOfferProductCategory(rowData);
  const shouldShowIndicator = isCategory && isRequestedRow(rowData);
  const hasChildren = shouldShowIndicator && hasCategoryChildren(rowData);
  const collapsed = shouldShowIndicator && isCategoryRowCollapsed(rowData);
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
        toggleCategoryCollapsed(rowData);
      }
    };

    const indicatorLabel = hasChildren
      ? (collapsed ? 'Expand category' : 'Collapse category')
      : 'Category without child entries';

    return (
      <span className={styles.treeOrderingCell}>
        <span>{value ?? ''}</span>
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
      </span>
    );
  }, [hasCategoryChildren, isCategoryRowCollapsed, toggleCategoryCollapsed]);

  // Row drag handle: starts native drag with row data (no visible selection)
  const RowDragHandle = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const sixDots = (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="4" cy="3" r="1.5" fill="currentColor" />
        <circle cx="10" cy="3" r="1.5" fill="currentColor" />
        <circle cx="4" cy="7" r="1.5" fill="currentColor" />
        <circle cx="10" cy="7" r="1.5" fill="currentColor" />
        <circle cx="4" cy="11" r="1.5" fill="currentColor" />
        <circle cx="10" cy="11" r="1.5" fill="currentColor" />
      </svg>
    );
    const preventRangeSelection = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    // Temporary elements/listeners used only during drag
    let previewEl: HTMLElement | null = null; // 1x1 px canvas to hide native ghost
    let overlayEl: HTMLElement | null = null; // in-window ghost that follows cursor
    let cleanupListeners: (() => void) | null = null;
    let dx = 0; // cursor offset within row at drag start
    let dy = 0;
    let dropCleanupHandler: (() => void) | null = null;

    const cleanupDragArtifacts = () => {
      if (cleanupListeners) {
        cleanupListeners();
        cleanupListeners = null;
      }
      document.documentElement.classList.remove('dragging');
      if (previewEl && previewEl.parentNode) {
        previewEl.parentNode.removeChild(previewEl);
      }
      previewEl = null;
      if (overlayEl && overlayEl.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl);
      }
      overlayEl = null;
      if (dropCleanupHandler && typeof window !== 'undefined') {
        window.removeEventListener('fastquote-row-drop', dropCleanupHandler);
      }
      dropCleanupHandler = null;
    };

    const onDragStart = (e: React.DragEvent) => {
      // Provide row identity/data for drop targets so TreeOrdering can be recomputed client-side
      const resolvedRowIndex = typeof params.node?.rowIndex === 'number'
        ? params.node.rowIndex
        : null;

      const isSelectAll = hasServerSideSelectAll(params.api ?? null);
      const selectedNodes = isSelectAll
        ? []
        : (typeof params.api?.getSelectedNodes === 'function'
          ? params.api.getSelectedNodes().map((node) => node.id ?? null).filter((id): id is string => typeof id === 'string' && id.length > 0)
          : []);
      if (params.node?.id) {
        if (!selectedNodes.includes(params.node.id)) {
          selectedNodes.push(params.node.id);
        }
      }
      const payload = {
        type: 'offer-product-row',
        rowId: params.node?.id ?? null,
        rowIndex: resolvedRowIndex,
        data: params.data ?? null,
        selectedRowIds: selectedNodes,
      };
      try {
        e.dataTransfer.setData('application/x-fastquote-row+json', JSON.stringify(payload));
      } catch { /* noop */ }
      try {
        e.dataTransfer.setData('text/plain', JSON.stringify(payload));
      } catch { /* noop */ }
      e.dataTransfer.effectAllowed = 'move';
      // Hide the native OS drag ghost so we can render our own overlay inside the window only
      const px = document.createElement('canvas');
      px.width = 1; px.height = 1;
      px.style.position = 'absolute';
      px.style.top = '-10000px';
      px.style.left = '-10000px';
      document.body.appendChild(px);
      previewEl = px;
      try { e.dataTransfer.setDragImage(px, 0, 0); } catch { /* noop */ }

      // Create an in-window overlay that mirrors the dragged row and follows the cursor
      const handle = e.currentTarget as HTMLElement;
      const rowEl = handle.closest('.ag-row') as HTMLElement | null;
      if (rowEl) {
        const rect = rowEl.getBoundingClientRect();
        dx = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        dy = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const clone = rowEl.cloneNode(true) as HTMLElement;
        clone.style.position = 'fixed';
        clone.style.pointerEvents = 'none';
        clone.style.top = '0';
        clone.style.left = '0';
        clone.style.width = `${rect.width}px`;
        clone.style.height = `${rect.height}px`;
        clone.style.transform = `translate(${e.clientX - dx}px, ${e.clientY - dy}px)`;
        clone.style.zIndex = '999999';
        clone.style.background = getComputedStyle(rowEl).backgroundColor || '#ffffff';
        clone.style.boxShadow = '0 8px 24px rgba(15, 23, 42, 0.16)';
        clone.classList.add('drag-overlay-row');
        document.body.appendChild(clone);
        overlayEl = clone;
      }

      // While dragging, mark the whole document as a valid drop target to avoid the OS "not-allowed" cursor
      const handler: EventListener = (evt: Event) => {
        const ev = evt as DragEvent;
        ev.preventDefault();
        try { if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; } catch { /* noop */ }
        if (overlayEl) {
          const x = Math.max(0, ev.clientX - dx);
          const y = Math.max(0, ev.clientY - dy);
          overlayEl.style.transform = `translate(${x}px, ${y}px)`;
        }
      };
      const opts: AddEventListenerOptions = { capture: true };
      document.addEventListener('dragover', handler, opts);
      document.addEventListener('dragenter', handler, opts);
      window.addEventListener('dragover', handler, opts);
      document.body.addEventListener('dragover', handler, opts);
      cleanupListeners = () => {
        document.removeEventListener('dragover', handler, opts);
        document.removeEventListener('dragenter', handler, opts);
        window.removeEventListener('dragover', handler, opts);
        document.body.removeEventListener('dragover', handler, opts);
      };
      document.documentElement.classList.add('dragging');

      if (typeof window !== 'undefined') {
        dropCleanupHandler = () => {
          cleanupDragArtifacts();
        };
        window.addEventListener('fastquote-row-drop', dropCleanupHandler);
      }
    };

    return (
      <div className={styles.dragCellWrapper} onMouseDownCapture={preventRangeSelection} onPointerDownCapture={preventRangeSelection}>
        <button
          type="button"
          aria-label="Drag row"
          title="Drag row"
          className={styles.dragButton}
          draggable
          onDragStart={onDragStart}
          onMouseDownCapture={preventRangeSelection}
          onPointerDownCapture={preventRangeSelection}
          onDragEnd={(e) => {
            e.stopPropagation();
            cleanupDragArtifacts();
          }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseDown={(e) => { e.stopPropagation(); }}
        >
          {sixDots}
        </button>
      </div>
    );
  }, []);

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

const REQUESTED_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--requested';
const ACTUAL_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--actual';

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
  ) => {
    if (!node) return;
    try {
      node.setDataValue('IsCategory', 1);
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
    if (treeOrdering != null) {
      try {
        node.setDataValue('RequestedItemNo', treeOrdering);
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
    const column: ColDef = {
      field,
      headerName,
      filter: 'agTextColumnFilter',
      minWidth: isDescription ? 280 : 140,
      headerClass: styles.requestedHeader,
      cellClassRules: requestedCellClassRules,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField(field, params.data ?? null),
      singleClickEdit: true,
      cellEditor: 'agTextCellEditor',
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
    };
    if (isDescription) {
      column.width = 320;
    }
    return column;
  };

  return {
    RequestedBrand: buildTextRequestedColumn('RequestedBrand', 'Req. Brand'),
    RequestedModelNo: buildTextRequestedColumn('RequestedModelNo', 'Req. Model Number'),
    RequestedPartNo: buildTextRequestedColumn('RequestedPartNo', 'Req. Part Number'),
    RequestedDescription: buildTextRequestedColumn('RequestedDescription', 'Req. Description'),
    RequestedDescription2: buildTextRequestedColumn('RequestedDescription2', 'Req. Description 2'),
    RequestedDescription3: buildTextRequestedColumn('RequestedDescription3', 'Req. Description 3'),
    RequestedQuantity: {
      field: 'RequestedQuantity',
      headerName: 'Req. Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: zeroBlankNumberFormatter,
      headerClass: styles.requestedHeader,
      cellClassRules: requestedCellClassRules,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField('RequestedQuantity', params.data ?? null),
      singleClickEdit: true,
      cellEditor: 'agTextCellEditor',
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        (data as Record<string, unknown>).RequestedQuantity = normalizeRequestedQuantityValue(newValue);
        return true;
      },
    },
  };
}, [requestedCellClassRules]);

  const productColumnDefs: ColDef[] = useMemo(() => {
    const requestedColumns: ColDef[] = [];
    REQUESTED_DISPLAY_FIELD_KEYS.forEach((key) => {
      const baseColDef = requestedColumnDefsMap[key];
      if (!baseColDef) return;
      const columnVisible = showRequestedColumns && requestedColumnVisibility[key];
      requestedColumns.push({
        ...baseColDef,
        hide: !columnVisible,
        suppressSizeToFit: !columnVisible,
      });
      if (!columnVisible && baseColDef.flex) {
        requestedColumns[requestedColumns.length - 1].flex = undefined;
      }
    });

  const treeColumn: ColDef = {
    field: 'TreeOrdering',
    headerName: '#',
    maxWidth: 90,
    filter: 'agTextColumnFilter',
    type: 'numericColumn',
    comparator: compareTreeOrderingValues,
    editable: manualMode,
    singleClickEdit: manualMode,
    cellRenderer: TreeOrderingCell,
    cellClass: ['offer-products-tree-ordering-cell', ACTUAL_COLUMN_GLOBAL_CLASS],
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
      minWidth: 110,
      maxWidth: 160,
      filter: 'agTextColumnFilter',
      headerClass: styles.requestedHeader,
      cellClassRules: requestedCellClassRules,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField('RequestedItemNo', params.data ?? null),
      singleClickEdit: true,
      cellEditor: 'agTextCellEditor',
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        const normalized = normalizeRequestedItemNoValue(newValue);
        (data as Record<string, unknown>).RequestedItemNo = normalized;
        return true;
      },
      hide: !showRequestedColumns || !requestedItemNoVisible,
      suppressSizeToFit: !showRequestedColumns || !requestedItemNoVisible,
      valueGetter: ({ data }) => {
        if (!data) return '';
        const requestedItemNo = normalizeRequestedItemNoValue(
          (data as Record<string, unknown>).RequestedItemNo ?? null,
        );
        if (requestedItemNo != null) return requestedItemNo;
        if (!isRequestedRow(data as Record<string, unknown> | null)) return '';
        const treeOrdering = (data as Record<string, unknown>).TreeOrdering;
        return treeOrdering != null ? formatDisplayTreeOrdering(treeOrdering) : '';
      },
      cellRenderer: RequestedItemNoCell,
    };

    return [
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
        maxWidth: 52,
        minWidth: 40,
        width: 44,
        cellStyle: { padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
        cellRenderer: RowDragHandle,
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
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      },
      {
        field: 'PartNumber',
        headerName: 'Part Number',
        filter: 'agTextColumnFilter',
        cellRenderer: PartNumberCell,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      },
      { field: 'ModelNumber', headerName: 'Model Number', filter: 'agTextColumnFilter', cellClass: ACTUAL_COLUMN_GLOBAL_CLASS },
      {
        field: 'Description',
        headerName: 'Description',
        minWidth: 280,
        width: 320,
        filter: 'agTextColumnFilter',
        valueGetter: ({ data }) => {
          const row = data as Record<string, unknown> | null | undefined;
          const manual = normalizeDescriptionValue(row?.ProductDescription ?? null);
          if (manual != null) return manual;
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
        singleClickEdit: true,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      },
    {
      field: 'ListPrice',
      headerName: 'List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: productPriceListClassRules,
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Customer Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: percentageFormatter,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'NetUnitPrice',
      headerName: 'Net Unit Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: euroFormatter,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'TotalPrice',
      headerName: 'Total List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueGetter: categoryTotalPriceGetter,
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: totalPriceCellClassRules,
      editable: false,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'TotalNet',
      headerName: 'Total Net',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueGetter: categoryTotalNetGetter,
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'Warranty',
      headerName: 'Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'TelmacoDiscount',
      headerName: 'Telmaco Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: percentageFormatter,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'NetCost',
      headerName: 'Net Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: euroFormatter,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: percentageFormatter,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'GrossProfit',
      headerName: 'Gross Profit',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
    {
      field: 'TotalCost',
      headerName: 'Total Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: euroFormatter,
      valueGetter: categoryTotalCostGetter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
    },
  ];
  }, [
    RowDragHandle,
    PartNumberCell,
    manualMode,
    TreeOrderingCell,
    requestedColumnDefsMap,
    requestedColumnVisibility,
    requestedItemNoVisible,
    RequestedItemNoCell,
    requestedCellClassRules,
    formatDisplayTreeOrdering,
    showRequestedColumns,
  ]);

  const refreshOfferProductGrid = useCallback((api: GridApi<Record<string, unknown>> | null, options?: { refresh?: boolean }) => {
    const targetApi = api ?? gridApiRef.current;
    if (!targetApi) return;
    if (options?.refresh ?? true) {
      if (typeof targetApi.refreshServerSide === 'function') {
        try {
          targetApi.refreshServerSide({ purge: true });
        } catch (err) {
          console.warn('Failed to refresh grid after row deletion', err);
        }
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
    if (refreshToken === 0) return;
    syncRequestedItemNumbers();
  }, [refreshToken, syncRequestedItemNumbers]);

  useEffect(() => {
    if (requestedMatchQueue.length === 0 && processedRequestedMatches !== 0) {
      setProcessedRequestedMatches(0);
    }
  }, [processedRequestedMatches, requestedMatchQueue.length]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    if (typeof api.resetRowHeights === 'function') {
      try {
        api.resetRowHeights();
      } catch (err) {
        console.warn('Failed to reset row heights after collapsing categories', err);
      }
    }
    try {
      api.redrawRows();
    } catch (err) {
      console.warn('Failed to redraw rows after collapsing categories', err);
    }
  }, [collapsedCategoryPaths]);

  const productRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: resolvedEndpoint,
        resolveRowId: (row) =>
          normalizeOfferDetailId((row as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null),
        resolveRowLabel,
        resolveRowTypeLabel: resolveOfferProductTypeLabel,
        buildPayload: (ids) => ({ OfferDetailIDs: ids }),
        confirmTitle: ({ isSingle }) => (isSingle ? 'Delete row' : 'Delete rows'),
        confirmConfirmLabel: ({ isSingle }) =>
          (isSingle ? 'Delete row' : 'Delete rows'),
        confirmCancelLabel: ({ isSingle }) =>
          (isSingle ? 'Keep row' : 'Keep rows'),
        successToastMessage: 'Row deleted',
        failureToastMessage: 'Unable to delete row. Please try again.',
        refreshHandler: refreshOfferProductGrid,
      }),
    [resolvedEndpoint, refreshOfferProductGrid],
  );

  const populateRequestedRowsToOffer = useCallback(async (nodes: RowNode<Record<string, unknown>>[]) => {
    const requestedNodes = nodes.filter((node) => isRequestedRow(node?.data ?? null));
    if (requestedNodes.length === 0) return;

    const updates: Array<Record<string, unknown>> = [];
    let categoriesAdded = 0;
    let productsAdded = 0;
    const unmatchedRequestedRows: RequestedProductMatchEntry[] = [];
    const baseRootCategoryCount = treeOrderingRootMapRef.current.size;
    let sequentialCategoryCount = 0;
    let lastAssignedCategoryOrdinal: string | null = null;
    const productChildCounters = new Map<string, number>();

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
      const requestedDescriptionPrimaryRaw = getExactTextValue(
        (data as { RequestedDescription?: unknown }).RequestedDescription ?? null,
      );
      const requestedDescriptionSecondary = normalizeDescriptionValue(
        (data as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
      );
      const requestedDescriptionSecondaryRaw = getExactTextValue(
        (data as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
      );
      const descriptionOverrideRaw = getExactTextValue(
        (data as { Description?: unknown }).Description ?? null,
      );
      const requestedTree = normalizeRequestedItemNoValue((data as { RequestedItemNo?: unknown }).RequestedItemNo ?? null);
      const treeOrderingRaw = (data as { TreeOrdering?: unknown }).TreeOrdering;
      let treeOrderingValue = requestedTree || (typeof treeOrderingRaw === 'string'
        ? treeOrderingRaw.trim()
        : null);
      const requestedDescriptionValue = requestedDescriptionPrimary ?? requestedDescriptionSecondary;
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
          payloadEntry.RequestedItemNo = treeOrderingValue;
        }
        if (requestedDescriptionPrimary != null) {
          payloadEntry.RequestedDescription = requestedDescriptionPrimary;
        }
        if (requestedDescriptionSecondary != null) {
          payloadEntry.RequestedDescription2 = requestedDescriptionSecondary;
        }
        updates.push(payloadEntry);
        promoteNodeToCategory(node, treeOrderingValue ?? null, categoryDescription);
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
        const productDescription = productMeta?.Description ?? null;
        const description = productDescription
          ?? requestedDescriptionPrimaryRaw
          ?? requestedDescriptionSecondaryRaw
          ?? descriptionOverrideRaw
          ?? null;
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
        refreshOfferProductGrid(null);
      } catch {
        /* noop */
      }
    }
    if (manualMatchesRequired) {
      showToastMessage(
        'Some requested products require manual matching. Please resolve them using the matcher.',
        'info',
      );
    }
  }, [assignRequestedRowToProduct, promoteNodeToCategory, promoteNodeToProduct, refreshOfferProductGrid, resolvedEndpoint]);

  const currentRequestedMatch = requestedMatchQueue[0] ?? null;
  const openMatchAddProduct = useCallback(() => setMatchAddProductOpen(true), []);
  const closeMatchAddProduct = useCallback(() => setMatchAddProductOpen(false), []);
  const handleMatchProductAdded = useCallback((result?: { productId?: number | null }) => {
    if (result?.productId != null) {
      setMatchAddedProductId(result.productId);
    }
    try {
      refreshOfferProductGrid(null);
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
        refreshOfferProductGrid(null);
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

  const manualMatchTotal = processedRequestedMatches + requestedMatchQueue.length;
  const manualMatchPosition = currentRequestedMatch ? processedRequestedMatches + 1 : 0;

  const productContextMenuItems = useCallback((
    params: GetContextMenuItemsParams<Record<string, unknown>>,
  ) => {
    const baseItems = productRowDeletion.getContextMenuItems(params) ?? [];
    const items = [...baseItems];
    const rowNode = params.node ?? null;
    const snapshotNodes = getContextMenuSelectionSnapshot(params.api ?? null);
    const relevantNodes = snapshotNodes.length > 0
      ? snapshotNodes
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

    const hasRequestedSelection = relevantNodes.some((node) => isRequestedRow(node?.data ?? null));
    const rowHasRequestedFields = hasRequestedPseudoFields(rowData);

    const deleteIndexAfterHistory = findDeleteMenuItemIndex(items);

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
          promoteNodeToCategory(rowNode, treeOrderingValue ?? null, descriptionValue ?? null);
          try {
            const payloadEntry: Record<string, unknown> = {
              OfferDetailID: offerDetailId,
              IsCategory: 1,
            };
            if (descriptionValue != null) {
              payloadEntry.Description = descriptionValue;
            }
            if (treeOrderingValue != null) {
              payloadEntry.TreeOrdering = treeOrderingValue;
              payloadEntry.RequestedItemNo = treeOrderingValue;
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

    if (hasRequestedSelection) {
      const populateItem: MenuItemDef = {
        name: 'Populate offer',
        icon: populateOfferMenuIcon,
        action: () => {
          const nodesToCopy = relevantNodes.filter((node): node is RowNode<Record<string, unknown>> => Boolean(node && node.data));
          void populateRequestedRowsToOffer(nodesToCopy);
        },
      };
      if (deleteIndexAfterHistory >= 0) {
        items.splice(deleteIndexAfterHistory, 0, populateItem);
      } else {
        items.push(populateItem);
      }
    }

    return items;
  }, [
    productRowDeletion,
    router,
    offerId,
    populateRequestedRowsToOffer,
    promoteNodeToCategory,
    resolvedEndpoint,
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
  }, [resolvedEndpoint]);

  const handleQuantityEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Quantity') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
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
        try {
          event.api?.refreshServerSide?.({ purge: false });
        } catch (refreshErr) {
          console.warn('Failed to refresh grid after quantity update', refreshErr);
        }
        recalcProductTotals(event, normalizedNewValue);
        refreshCategoryAggregates(event.api);
      } catch (err) {
        console.error('Failed to update quantity', err);
        showToastMessage('Unable to update quantity. Please try again.', 'error');
        revertValue();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint]);

  const handleDescriptionEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Description') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
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
  }, [resolvedEndpoint]);

  const handlePricingEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !PRICING_EDITABLE_FIELDS.has(field)) return;
    const label = PRICING_FIELD_LABELS[field] ?? field;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;

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

    const normalizedNewValue = coerceNumber(event.newValue);
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
        showToastMessage(`${label} updated`, 'success');
        try {
          event.api?.refreshServerSide?.({ purge: false });
        } catch (refreshErr) {
          console.warn('Failed to refresh grid after pricing update', refreshErr);
        }
        recalcProductTotals(event);
        refreshCategoryAggregates(event.api);
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint]);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    handleDescriptionEdit(event);
    handleRequestedFieldEdit(event);
    handleQuantityEdit(event);
    handlePricingEdit(event);
  }, [handleDescriptionEdit, handleRequestedFieldEdit, handleQuantityEdit, handlePricingEdit]);

  const formatEuroTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} €`;
  };
  const formatPercentTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} %`;
  };

  return (
    <>
      <div className={styles.panel}>
        <div className={`${styles.gridWrapper} offer-products-grid`}>
          <AgGridAll
            endpoint={resolvedEndpoint}
            columnDefs={productColumnDefs}
            defaultColDef={defaultColDef}
            manualMode={manualMode}
            getRowClass={getRowClass}
            getContextMenuItems={productContextMenuItems}
            onCellValueChanged={handleCellEdit}
            refreshToken={refreshToken}
            onGridReady={handleGridReady}
            onModelUpdated={handleGridModelUpdated}
            getRowHeight={getRowHeight}
            onRowDoubleClicked={handleRowDoubleClicked}
            autoSizeExclusions={autoSizeExclusions}
            enableColumnStatePersistence={false}
            suppressColumnVirtualisation
            onTotalsChange={handleTotalsChange}
            onResponse={handleGridResponse}
            onServerRequest={handleServerRequest}
            onHeaderSelectAllChange={handleHeaderSelectAllChange}
            rowGroupPanelShow="never"
            onRowsMoved={handleRowsMoved}
            rowSelection="multiple"
            rowMultiSelectWithClick
            rowDeselection
            disableAutoSize
          />
        </div>
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
      </div>
      {currentRequestedMatch ? (
        <MatchRequestedProductsModal
          entry={currentRequestedMatch}
          position={manualMatchPosition}
          total={manualMatchTotal}
          onAssign={handleManualAssign}
          onSkip={handleManualSkip}
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
      />
    </>
  );
}
