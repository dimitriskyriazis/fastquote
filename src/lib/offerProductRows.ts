export type OfferProductRow = Record<string, unknown> | null | undefined;

export type OfferProductRowType =
  | 'category'
  | 'product'
  | 'printable-comment'
  | 'non-printable-comment'
  | 'unknown';

const isTruthy = (value: unknown): boolean => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
};

const isFalsy = (value: unknown): boolean => {
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value === 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '0' || normalized === 'false' || normalized === 'no';
  }
  return false;
};

const hasPartNumber = (value: unknown): boolean => {
  if (value == null) return false;
  const str = typeof value === 'string' ? value : String(value);
  return str.trim().length > 0;
};

export const resolveOfferProductRowType = (row: OfferProductRow): OfferProductRowType => {
  if (!row || typeof row !== 'object') return 'unknown';
  const printableRaw = (row as { IsPrintable?: unknown }).IsPrintable;
  const commentRaw = (row as { IsComment?: unknown }).IsComment;
  const partNumberRaw = (row as { PartNumber?: unknown }).PartNumber;

  const isComment = isTruthy(commentRaw);
  const isPrintable = isTruthy(printableRaw);
  const isExplicitlyNotPrintable = isFalsy(printableRaw);

  if (isComment && isPrintable) return 'printable-comment';
  if (isComment && isExplicitlyNotPrintable) return 'non-printable-comment';
  if (printableRaw == null && !hasPartNumber(partNumberRaw)) {
    return 'category';
  }
  if (hasPartNumber(partNumberRaw)) {
    return 'product';
  }
  return 'unknown';
};

export const isOfferProductCategory = (row: OfferProductRow) => resolveOfferProductRowType(row) === 'category';
export const isOfferProductProduct = (row: OfferProductRow) => resolveOfferProductRowType(row) === 'product';
export const isOfferProductComment = (row: OfferProductRow) => {
  const type = resolveOfferProductRowType(row);
  return type === 'printable-comment' || type === 'non-printable-comment';
};
