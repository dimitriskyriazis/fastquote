export const PDF_PRODUCT_COLUMNS = [
  'no',
  'brand',
  'type',
  'modelNumber',
  'description',
  'qty',
  'listPrice',
  'totalList',
  'discount',
  'unitPrice',
  'total',
  'warranty',
  'origin',
  'comment',
  'delivery',
  'requestedBrand',
  'requestedPartNo',
  'requestedModelNo',
  'requestedDescription',
  'requestedQuantity',
] as const;

export type PdfProductColumn = (typeof PDF_PRODUCT_COLUMNS)[number];

export const DEFAULT_PDF_PRODUCT_COLUMNS: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'modelNumber',
  'description',
  'qty',
  'listPrice',
  'totalList',
];

export const PORTRAIT_EXTENDED_COLUMNS_DISCOUNT: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'description',
  'qty',
  'discount',
  'unitPrice',
  'total',
];

export const PORTRAIT_EXTENDED_COLUMNS_LISTPRICE: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'description',
  'qty',
  'listPrice',
  'totalList',
  'unitPrice',
  'total',
];

export const LANDSCAPE_EXTENDED_COLUMNS: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'description',
  'qty',
  'listPrice',
  'totalList',
  'discount',
  'unitPrice',
  'total',
];

const PDF_PRODUCT_COLUMN_SET = new Set<string>(PDF_PRODUCT_COLUMNS);

export function parsePdfProductColumnsParam(value: string | null | undefined): PdfProductColumn[] {
  if (!value) {
    return [...DEFAULT_PDF_PRODUCT_COLUMNS];
  }

  const ordered: PdfProductColumn[] = [];
  const seen = new Set<PdfProductColumn>();
  for (const rawEntry of value.split(',')) {
    const entry = rawEntry.trim();
    if (!entry || !PDF_PRODUCT_COLUMN_SET.has(entry)) continue;
    const column = entry as PdfProductColumn;
    if (seen.has(column)) continue;
    seen.add(column);
    ordered.push(column);
  }

  if (ordered.length === 0) {
    return [...DEFAULT_PDF_PRODUCT_COLUMNS];
  }

  return ordered;
}

const PDF_COLUMNS_STORAGE_PREFIX = 'fastquote-pdf-columns';

const sanitizeKeySegment = (value: string): string =>
  (value || '').replace(/[^a-zA-Z0-9_-]/g, '_');

export function buildPdfColumnsStorageKey(userId: string | null | undefined, offerId: string | number): string {
  const user = sanitizeKeySegment(userId && String(userId).trim() ? String(userId).trim() : 'anon');
  const offer = sanitizeKeySegment(String(offerId));
  return `${PDF_COLUMNS_STORAGE_PREFIX}:${user}:${offer}`;
}

export function readSavedPdfColumns(key: string): PdfProductColumn[] | null {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.columns) ? parsed.columns : null;
    if (!source) return null;
    const ordered: PdfProductColumn[] = [];
    const seen = new Set<PdfProductColumn>();
    for (const entry of source) {
      if (typeof entry !== 'string' || !PDF_PRODUCT_COLUMN_SET.has(entry)) continue;
      const column = entry as PdfProductColumn;
      if (seen.has(column)) continue;
      seen.add(column);
      ordered.push(column);
    }
    return ordered.length > 0 ? ordered : null;
  } catch {
    return null;
  }
}

export function writeSavedPdfColumns(key: string, columns: PdfProductColumn[]): void {
  if (typeof window === 'undefined' || !key) return;
  try {
    window.localStorage.setItem(key, JSON.stringify({ columns }));
  } catch {
    // ignore quota / serialization errors
  }
}
