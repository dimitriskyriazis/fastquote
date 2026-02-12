export const PDF_PRODUCT_COLUMNS = [
  'no',
  'brand',
  'type',
  'description',
  'listPrice',
  'discount',
  'unitPrice',
  'qty',
  'totalList',
  'total',
  'warranty',
  'comment',
  'delivery',
] as const;

export type PdfProductColumn = (typeof PDF_PRODUCT_COLUMNS)[number];

export const DEFAULT_PDF_PRODUCT_COLUMNS: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'description',
  'unitPrice',
  'qty',
  'total',
];

export const PORTRAIT_EXTENDED_COLUMNS_DISCOUNT: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'description',
  'discount',
  'unitPrice',
  'qty',
  'total',
];

export const PORTRAIT_EXTENDED_COLUMNS_LISTPRICE: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'description',
  'listPrice',
  'unitPrice',
  'qty',
  'totalList',
  'total',
];

export const LANDSCAPE_EXTENDED_COLUMNS: PdfProductColumn[] = [
  'no',
  'brand',
  'type',
  'description',
  'listPrice',
  'discount',
  'unitPrice',
  'qty',
  'totalList',
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
