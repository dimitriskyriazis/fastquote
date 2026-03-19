import { parseLocaleNumber } from '../../../../lib/localeNumber';

export const CLIPBOARD_STORAGE_KEY = 'fastquote-product-clipboard';
export const CLIPBOARD_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ClipboardRow {
  originalOfferDetailId: number;
  productId: number | null;
  isCategory: boolean;
  isComment: boolean;
  isPrintable: boolean | null;
  treeOrdering: string;
  brandName: string | null;
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  productDescription: string | null;
  quantity: number | null;
  netUnitPrice: number | null;
  listPrice: number | null;
  customerDiscount: number | null;
  telmacoDiscount: number | null;
  netCost: number | null;
  netCostOtherCurrency: number | null;
  margin: number | null;
  grossProfit: number | null;
  comment: string | null;
  delivery: string | null;
  warranty: number | null;
  telmacoWarranty: number | null;
  otherCurrencyId: number | null;
  currencyCostModifier: number | null;
  priceListId: number | null;
  priceListItemId: number | null;
  requestedItemNo: string | null;
  requestedBrand: string | null;
  requestedPartNo: string | null;
  requestedModelNo: string | null;
  requestedWebLink: string | null;
  requestedDescription: string | null;
  requestedDescription2: string | null;
  requestedDescription3: string | null;
  requestedQuantity: number | null;
}

export interface ProductClipboard {
  sourceOfferId: string;
  copiedAt: string;
  rows: ClipboardRow[];
}

export function readClipboard(): ProductClipboard | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CLIPBOARD_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProductClipboard;
    if (!parsed || !Array.isArray(parsed.rows) || parsed.rows.length === 0) {
      window.localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
      return null;
    }
    if (!parsed.copiedAt) {
      window.localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
      return null;
    }
    const age = Date.now() - new Date(parsed.copiedAt).getTime();
    if (age > CLIPBOARD_MAX_AGE_MS) {
      window.localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writeClipboard(data: ProductClipboard): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(CLIPBOARD_STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

export function clearClipboard(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(CLIPBOARD_STORAGE_KEY);
  } catch {
    /* noop */
  }
}

export function isClipboardPopulated(): boolean {
  return readClipboard() != null;
}

const coerceNumber = (value: unknown): number | null => {
  return parseLocaleNumber(value);
};

const coerceInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const coerceString = (value: unknown): string | null => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return null;
};

const coerceBool = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value === '1' || value.toLowerCase() === 'true';
  return false;
};

const coerceNullableBool = (value: unknown): boolean | null => {
  if (value == null) return null;
  return coerceBool(value);
};

export function mapRowToClipboardRow(row: Record<string, unknown>): ClipboardRow {
  return {
    originalOfferDetailId: coerceInt(row.OfferDetailID) ?? 0,
    productId: coerceInt(row.ProductID),
    isCategory: coerceBool(row.IsCategory),
    isComment: coerceBool(row.IsComment),
    isPrintable: coerceNullableBool(row.IsPrintable),
    treeOrdering: coerceString(row.TreeOrdering) ?? '',
    brandName: coerceString(row.BrandName),
    partNumber: coerceString(row.PartNumber),
    modelNumber: coerceString(row.ModelNumber),
    description: coerceString(row.Description),
    productDescription: coerceString(row.ProductDescription),
    quantity: coerceNumber(row.Quantity),
    netUnitPrice: coerceNumber(row.NetUnitPrice),
    listPrice: coerceNumber(row.ListPrice),
    customerDiscount: coerceNumber(row.CustomerDiscount),
    telmacoDiscount: coerceNumber(row.TelmacoDiscount),
    netCost: coerceNumber(row.NetCost),
    netCostOtherCurrency: coerceNumber(row.NetCostOtherCurrency),
    margin: coerceNumber(row.Margin),
    grossProfit: coerceNumber(row.GrossProfit),
    comment: coerceString(row.Comment),
    delivery: coerceString(row.Delivery),
    warranty: coerceInt(row.Warranty),
    telmacoWarranty: coerceInt(row.TelmacoWarranty),
    otherCurrencyId: coerceInt(row.OtherCurrencyID),
    currencyCostModifier: coerceNumber(row.CurrencyCostModifier),
    priceListId: coerceInt(row.PriceListID),
    priceListItemId: coerceInt(row.PriceListItemID),
    requestedItemNo: coerceString(row.RequestedItemNo),
    requestedBrand: coerceString(row.RequestedBrand),
    requestedPartNo: coerceString(row.RequestedPartNo),
    requestedModelNo: coerceString(row.RequestedModelNo),
    requestedWebLink: coerceString(row.RequestedWebLink),
    requestedDescription: coerceString(row.RequestedDescription),
    requestedDescription2: coerceString(row.RequestedDescription2),
    requestedDescription3: coerceString(row.RequestedDescription3),
    requestedQuantity: coerceNumber(row.RequestedQuantity),
  };
}

export function enrichWithParentCategories(
  selectedRows: ClipboardRow[],
  allGridRows: Array<Record<string, unknown>>,
): ClipboardRow[] {
  const selectedTreeOrderings = new Set(selectedRows.map((r) => r.treeOrdering));
  const neededParents = new Set<string>();

  for (const row of selectedRows) {
    const segments = row.treeOrdering.split('.').filter(Boolean);
    for (let depth = 1; depth < segments.length; depth++) {
      const parentPath = segments.slice(0, depth).join('.');
      if (!selectedTreeOrderings.has(parentPath) && !neededParents.has(parentPath)) {
        neededParents.add(parentPath);
      }
    }
  }

  if (neededParents.size === 0) {
    return Array.from(
      new Map(selectedRows.map((row) => [row.treeOrdering, row])).values(),
    ).sort((a, b) => a.treeOrdering.localeCompare(b.treeOrdering, undefined, { numeric: true }));
  }

  const parentRows: ClipboardRow[] = [];
  for (const gridRow of allGridRows) {
    const tree = coerceString(gridRow.TreeOrdering);
    if (tree && neededParents.has(tree) && coerceBool(gridRow.IsCategory)) {
      parentRows.push(mapRowToClipboardRow(gridRow));
      neededParents.delete(tree);
      if (neededParents.size === 0) break;
    }
  }

  return Array.from(
    new Map([...selectedRows, ...parentRows].map((row) => [row.treeOrdering, row])).values(),
  ).sort((a, b) => a.treeOrdering.localeCompare(b.treeOrdering, undefined, { numeric: true }));
}
