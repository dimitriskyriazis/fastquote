import type {
  CellValueChangedEvent,
  DefaultMenuItem,
  GridApi,
  MenuItemDef,
  ValueFormatterParams,
  ValueGetterParams,
} from 'ag-grid-community';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment } from '../../../lib/offerProductRows';
import { priceListStatusClassRules } from '../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../lib/localeNumber';
import type { RequestedProductMatchEntry } from './products/MatchRequestedProductsModal';

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const decimalFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const DEFAULT_ROW_HEIGHT = 32;
export const MAX_CATEGORY_DEPTH = 3;
export const ADD_WEBLINK_MAX_PRODUCTS = 200;
export const ENHANCE_DESC_MAX_PRODUCTS = 200;

const COLLAPSED_CATEGORIES_COOKIE_NAME = 'offer_products_collapsed';

export function readCollapsedCategoryPathsFromCookie(offerId: string): Set<string> {
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

export function writeCollapsedCategoryPathsToCookie(offerId: string, paths: Set<string>): void {
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

export const plainNumberFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

export const parseFlexibleNumber = (raw: string): number | null => {
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

export const coerceNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    return parseFlexibleNumber(value);
  }
  return null;
};

export const formatPercentageValue = (value: unknown) => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  return `${decimalFormatter.format(num)} %`;
};

export const formatCurrencyValue = (value: unknown, symbol = '€') => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  const formatted = decimalFormatter.format(num);
  return symbol === '$' ? `${symbol} ${formatted}` : `${formatted} ${symbol}`;
};

export const formatEuroValue = (value: unknown) => formatCurrencyValue(value, '€');

type FormatterParams = ValueFormatterParams<Record<string, unknown>, unknown>;
export const percentageFormatter = ({ value }: FormatterParams) => formatPercentageValue(value);
export const euroFormatter = ({ value }: FormatterParams) => formatEuroValue(value);
export const buildCurrencyFormatter = (symbol: string) =>
  ({ value }: FormatterParams) => formatCurrencyValue(value, symbol);
export const zeroBlankNumberFormatter = ({ value }: FormatterParams) => {
  const num = coerceNumber(value);
  if (num == null) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
  }
  if (Object.is(num, 0)) return '';
  return plainNumberFormatter.format(num);
};

export type RequestedFieldKey =
  | 'RequestedItemNo'
  | 'RequestedBrand'
  | 'RequestedPartNo'
  | 'RequestedModelNo'
  | 'RequestedWebLink'
  | 'RequestedDescription'
  | 'RequestedDescription2'
  | 'RequestedDescription3'
  | 'RequestedQuantity';

export type RequestedDisplayFieldKey = Exclude<RequestedFieldKey, 'RequestedItemNo'>;
export const REQUESTED_DISPLAY_FIELD_KEYS: RequestedDisplayFieldKey[] = [
  'RequestedBrand',
  'RequestedPartNo',
  'RequestedModelNo',
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
  'RequestedQuantity',
];

export const REQUESTED_FIELD_LABELS: Record<RequestedFieldKey, string> = {
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

export const REQUESTED_FIELD_SET = new Set<RequestedFieldKey>([
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

export const isRequestedFieldKey = (value: string | null | undefined): value is RequestedFieldKey =>
  typeof value === 'string' && REQUESTED_FIELD_SET.has(value as RequestedFieldKey);

export const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export const compareTreeOrderingValues = (a: unknown, b: unknown) => {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa && !sb) return 0;  // both empty/null
  if (!sa) return -1;        // empty/null first
  if (!sb) return 1;
  return collator.compare(sa, sb);
};

export const parseTreeOrderingPath = (value: unknown): number[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
};

export const buildTreeOrderingKey = (segments: number[]) => segments.join('.');

export function computeDisplayOrderingMap(rows: Record<string, unknown>[]): Map<string, string> {
  const sorted = rows
    .filter((row): row is Record<string, unknown> => row != null && row.TreeOrdering != null)
    .sort((a, b) => compareTreeOrderingValues(a.TreeOrdering, b.TreeOrdering));

  const result = new Map<string, string>();

  for (const row of sorted) {
    const actualKey = String(row.TreeOrdering ?? '').trim();
    if (!actualKey) continue;
    const path = parseTreeOrderingPath(actualKey);
    if (path.length === 0) continue;

    if (resolveOfferProductRowType(row) === 'non-printable-comment') continue;

    const lastSegment = path[path.length - 1];
    const actualParentKey = path.slice(0, -1).join('.');
    const parentDisplayKey = path.length === 1 ? '' : (result.get(actualParentKey) ?? actualParentKey);
    const displayKey = parentDisplayKey ? `${parentDisplayKey}.${lastSegment}` : String(lastSegment);
    result.set(actualKey, displayKey);
  }

  return result;
}

export const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export const resolveRowLabel = (row: Record<string, unknown> | null | undefined, fallback: string) => {
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

export const resolveOfferProductTypeLabel = (row: Record<string, unknown> | null | undefined) => {
  const rowType = resolveOfferProductRowType(row);
  if (rowType === 'category') return 'category';
  if (rowType === 'product') return 'product';
  if (rowType === 'printable-comment' || rowType === 'non-printable-comment') return 'comment';
  return 'record';
};

export const isRequestedRow = (row: Record<string, unknown> | null | undefined) =>
  Boolean((row as { __isRequestedRow?: number | null })?.__isRequestedRow === 1);

export const hasAssignedProductId = (row: Record<string, unknown> | null | undefined): boolean => {
  const raw = (row as { ProductID?: unknown } | null | undefined)?.ProductID;
  if (raw == null) return false;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0;
  if (typeof raw === 'string') return raw.trim().length > 0;
  return false;
};

// Requested-only row that hasn't been matched to a real product yet.
// Editing actual product columns (Description, prices, qty, ...) on these
// rows is misleading because there is no product behind the cell.
export const isUnassignedRequestedRow = (row: Record<string, unknown> | null | undefined): boolean =>
  isRequestedRow(row) && !hasAssignedProductId(row);

export const isRequestedDescriptionField = (field: string | null | undefined): field is 'RequestedDescription' | 'RequestedDescription2' | 'RequestedDescription3' =>
  field === 'RequestedDescription' || field === 'RequestedDescription2' || field === 'RequestedDescription3';

export const canEditRequestedField = (field: RequestedFieldKey, row: Record<string, unknown> | null | undefined) => {
  if (isRequestedRow(row)) return true;
  if (isRequestedDescriptionField(field) && isOfferProductCategory(row)) {
    return true;
  }
  return false;
};

export const normalizeDescriptionValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const REQUESTED_DESCRIPTION_FIELD_KEYS = [
  'RequestedDescription',
  'RequestedDescription2',
  'RequestedDescription3',
] as const;
export type RequestedDescriptionFieldKey = (typeof REQUESTED_DESCRIPTION_FIELD_KEYS)[number];

export const getNormalizedRequestedDescriptionValues = (row: Record<string, unknown> | null | undefined): string[] => {
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

export const normalizeRequestedItemNoValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const REQUESTED_HISTORY_LOOKUP_ENDPOINT = '/api/products/resolve';
export const requestedHistoryLookupCache = new Map<string, number | null>();

export const normalizeRequestedLookupValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const getExactTextValue = (value: unknown): string | null => {
  if (value == null) return null;
  return typeof value === 'string' ? value : String(value);
};

export const normalizeRequestedQuantityValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return null;
};

export const sanitizeDetailValue = (value: string | null | undefined): string | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const buildRequestedProductMatchEntry = (
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

export const hasRequestedLookupIdentifiers = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  const part = normalizeRequestedLookupValue((row as { RequestedPartNo?: unknown }).RequestedPartNo ?? null);
  const model = normalizeRequestedLookupValue((row as { RequestedModelNo?: unknown }).RequestedModelNo ?? null);
  const brand = normalizeRequestedLookupValue((row as { RequestedBrand?: unknown }).RequestedBrand ?? null);
  const webLink = normalizeRequestedLookupValue((row as { RequestedWebLink?: unknown }).RequestedWebLink ?? null);
  return Boolean(part || model || brand || webLink);
};

export const hasRequestedRowData = (row: Record<string, unknown> | null | undefined) => {
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

export const hasRequestedPseudoFields = (row: Record<string, unknown> | null | undefined) => {
  if (!row || typeof row !== 'object') return false;
  return hasRequestedRowData(row);
};

export type RequestedLookupInfo = {
  partNumber: string | null;
  modelNumber: string | null;
  brand: string | null;
};

export const buildRequestedLookupInfo = (row: Record<string, unknown> | null | undefined): RequestedLookupInfo => {
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

export const resolveProductIdFromRequestedInfo = async (info: RequestedLookupInfo): Promise<number | null> => {
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

export type ProductSummary = {
  ProductID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandName: string | null;
  Description: string | null;
};

export const productSummaryCache = new Map<number, ProductSummary | null>();

export const fetchProductSummary = async (productId: number): Promise<ProductSummary | null> => {
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

export const isFarnellBrand = (brand: string | null | undefined): boolean => {
  if (!brand || typeof brand !== 'string') return false;
  return brand.replace(/\u00A0/g, ' ').trim().toLowerCase() === 'farnell';
};

export type FarnellLookupResult = {
  sku: string;
  displayName: string;
  manufacturerPartNumber: string | null;
  brandName: string | null;
  description: string | null;
  productURL: string | null;
  stock: number | null;
  prices: { from: number; to: number; cost: number }[];
  matchedPrice: number | null;
};

export type FarnellLookupResponse = {
  product: FarnellLookupResult;
  farnellBrandId: number | null;
};

export type AssignedRequestedPricing = {
  quantity: number | null;
  customerDiscount: number | null;
  telmacoDiscount: number | null;
};

export const fetchFarnellLookup = async (
  sku: string,
  quantity?: number,
  searchType: 'id' | 'manuPartNum' = 'id',
): Promise<FarnellLookupResponse | null> => {
  try {
    const params = new URLSearchParams({ sku });
    if (quantity != null && quantity > 0) {
      params.set('quantity', String(Math.trunc(quantity)));
    }
    if (searchType !== 'id') {
      params.set('searchType', searchType);
    }
    const res = await fetch(`/api/farnell/lookup?${params.toString()}`);
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      product?: FarnellLookupResult;
      farnellBrandId?: number | null;
    } | null;
    if (!payload?.ok || !payload.product) return null;
    return {
      product: payload.product,
      farnellBrandId: typeof payload.farnellBrandId === 'number' ? payload.farnellBrandId : null,
    };
  } catch (err) {
    console.error('Failed to fetch Farnell product', err);
    return null;
  }
};

export const fetchFarnellSearchProducts = async (
  term: string,
  quantity?: number,
  searchType: 'auto' | 'keyword' | 'ai' = 'auto',
  signal?: AbortSignal,
): Promise<{ products: FarnellLookupResult[]; farnellBrandId: number | null }> => {
  try {
    const params = new URLSearchParams({ sku: term, searchType });
    if (quantity != null && quantity > 0) {
      params.set('quantity', String(Math.trunc(quantity)));
    }
    const res = await fetch(`/api/farnell/lookup?${params.toString()}`, { signal });
    if (!res.ok) return { products: [], farnellBrandId: null };
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      product?: FarnellLookupResult;
      products?: FarnellLookupResult[];
      farnellBrandId?: number | null;
    } | null;
    if (!payload?.ok) return { products: [], farnellBrandId: null };
    const products = Array.isArray(payload.products)
      ? payload.products
      : payload.product
        ? [payload.product]
        : [];
    const farnellBrandId = typeof payload.farnellBrandId === 'number' ? payload.farnellBrandId : null;
    return { products, farnellBrandId };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { products: [], farnellBrandId: null };
    }
    console.error('Failed to fetch Farnell search products', err);
    return { products: [], farnellBrandId: null };
  }
};

export const resolveFarnellProductByPartNumber = async (
  partNumber: string,
): Promise<number | null> => {
  try {
    const params = new URLSearchParams({
      partNumber,
      brand: 'Farnell',
    });
    const res = await fetch(`/api/products/resolve?${params.toString()}`);
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as {
      ok?: boolean;
      productId?: number;
      match?: string;
    } | null;
    // Only accept brand-matched results - reject fallback matches from other brands.
    if (payload?.ok && typeof payload.productId === 'number' && payload.match !== 'fallbackNoBrand') {
      return payload.productId;
    }
    return null;
  } catch {
    return null;
  }
};

export const createFarnellProduct = async (
  farnellBrandId: number,
  farnellProduct: FarnellLookupResult,
  sku: string,
): Promise<number | null> => {
  try {
    const rawDescription = farnellProduct.description ?? farnellProduct.displayName ?? null;

    // Shorten description to max 60 characters via AI
    let description = rawDescription;
    if (rawDescription && rawDescription.length > 60) {
      try {
        const shortenRes = await fetch('/api/products/shorten-description', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description: rawDescription,
            brand: farnellProduct.brandName ?? undefined,
            partNumber: sku,
          }),
        });
        if (shortenRes.ok) {
          const { shortened } = (await shortenRes.json()) as { shortened: string | null };
          if (shortened) description = shortened;
        }
      } catch {
        // Fall back to raw description on failure
      }
    }

    const res = await fetch('/api/products/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        brandId: farnellBrandId,
        partNumber: sku,
        modelNumber: farnellProduct.manufacturerPartNumber ?? null,
        erpCode: null,
        description,
        weblink: `https://be.farnell.com/en-BE/search?st=${encodeURIComponent(sku)}`,
        comments: null,
        typeId: null,
        categoryId: null,
        subCategoryId: null,
      }),
    });
    if (!res.ok) return null;
    const payload = (await res.json().catch(() => null)) as { ok?: boolean; productId?: number } | null;
    return payload?.ok && typeof payload.productId === 'number' ? payload.productId : null;
  } catch (err) {
    console.error('Failed to create Farnell product', err);
    return null;
  }
};

export const buildFarnellPricingPatch = (
  offerDetailId: number,
  listPrice: number,
  pricing: AssignedRequestedPricing | null,
): Record<string, unknown> | null => {
  if (!Number.isFinite(listPrice) || listPrice <= 0) return null;
  const customerDiscount = pricing?.customerDiscount ?? 0;
  const telmacoDiscount = pricing?.telmacoDiscount ?? 0;

  return {
    OfferDetailID: offerDetailId,
    ListPrice: listPrice,
    CustomerDiscount: customerDiscount,
    TelmacoDiscount: telmacoDiscount,
  };
};

export const isOfferProductCommentOrProduct = (row: Record<string, unknown> | null | undefined) =>
  isOfferProductProduct(row) || isOfferProductComment(row);

export const buildCategoryAggregateGetter = (field: 'TotalPrice' | 'TotalNet' | 'TotalCost') => (
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

export const roundMoney = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

export const OFFER_PRODUCTS_EXPORT_FIELDS = [
  'TreeOrdering',
  'PartNumber',
  'BrandName',
  'AVC4BrandName',
  'ModelNumber',
  'Description',
  'Quantity',
  'ListPrice',
  'Comment',
  'Delivery',
  'IsPrintable',
  'IsComment',
  'IsCategory',
] as const;

export const normalizeNoForExport = (value: unknown): string | number => {
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

export const recalcProductTotals = (
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

export const CATEGORY_TOTAL_COLUMNS: string[] = ['TotalPrice', 'TotalNet', 'TotalCost'];
export const refreshCategoryAggregates = (api?: GridApi<Record<string, unknown>> | null) => {
  if (!api || typeof api.refreshCells !== 'function') return;
  try {
    api.refreshCells({ columns: CATEGORY_TOTAL_COLUMNS, force: true });
  } catch (err) {
    console.warn('Failed to refresh category aggregates', err);
  }
};

export const categoryTotalPriceGetter = buildCategoryAggregateGetter('TotalPrice');
export const categoryTotalNetGetter = buildCategoryAggregateGetter('TotalNet');
export const categoryTotalCostGetter = buildCategoryAggregateGetter('TotalCost');

export const productAccentCellClassRules = {
  'offer-products-grid__cell--product-accent': (params: { data?: Record<string, unknown> | null }) =>
    isOfferProductProduct(params.data),
};

export const productPriceListClassRules = priceListStatusClassRules((params) =>
  isOfferProductProduct(params.data) ? params.data : null,
);

export const totalPriceCellClassRules = {
  ...productAccentCellClassRules,
  ...productPriceListClassRules,
};

export const PRICING_FIELD_LABELS: Record<string, string> = {
  CustomerDiscount: 'Customer Discount',
  NetUnitPrice: 'Net Unit Price',
  TelmacoDiscount: 'Telmaco Discount',
  NetCostOtherCurrency: 'Cost (Other Currency)',
  CurrencyCostModifier: 'Cost Modifier',
  NetCost: 'Net Cost',
  Margin: 'Margin',
  ListPrice: 'List Price',
};

export const PRICING_EDITABLE_FIELDS = new Set(Object.keys(PRICING_FIELD_LABELS));

// UI labels that should never be persisted as product descriptions.
// Guards against accidental clipboard paste from the toolbar area.
export const DESCRIPTION_PASTE_BLOCKLIST = new Set([
  'Populate Offer',
  'Populating...',
  'Update Prices',
  'Updating prices...',
  'Fill AVC4 Offer',
  'Filling...',
  'View Basic Data',
  'Add Products',
  'Add Category',
  'Add Printable Comment',
  'Add Non Printable Comment',
  'Add Requested Products',
  'New Category',
  'New Printable Comment',
  'New Non Printable Comment',
  'Printable',
  'Non Printable',
]);

export const COST_ANALYSIS_COLUMNS = [
  'TelmacoDiscount',
  'NetCostOtherCurrency',
  'CurrencyCostModifier',
  'NetCost',
  'Margin',
  'GrossProfit',
  'TotalCost',
  'TelmacoWarranty',
];

export const STANDARD_PACKAGE_PRODUCTS_FIELDS = [
  'OfferDetailID',
  'ProductID',
  'Quantity',
  'PartNumber',
  'ModelNumber',
  'ProductDescription',
  'Ordering',
  'TreeOrdering',
  'BrandID',
  'Comment',
  'IsCategory',
  'IsComment',
  'IsPrintable',
  'WebLink',
  'Enabled',
  'CreatedOn',
  'CreatedBy',
  'ModifiedOn',
  'ModifiedBy',
];

export const findDeleteMenuItemIndex = (
  items: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string>,
) => items.findIndex((item) => {
  if (!item || typeof item !== 'object') return false;
  const { name } = item as MenuItemDef<Record<string, unknown>>;
  if (typeof name !== 'string') return false;
  const normalized = name.trim().toLowerCase();
  return normalized.startsWith('delete');
});

export const buildEndpointForOffer = (offerId: string) =>
  `/api/offers/${encodeURIComponent(offerId)}/products`;
