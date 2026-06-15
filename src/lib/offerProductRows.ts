export type OfferProductRow = Record<string, unknown> | null | undefined;

export type OfferProductRowType =
  | 'category'
  | 'product'
  | 'printable-comment'
  | 'non-printable-comment'
  | 'printable-service'
  | 'non-printable-service'
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

const hasModelNumber = (value: unknown): boolean => {
  if (value == null) return false;
  const str = typeof value === 'string' ? value : String(value);
  return str.trim().length > 0;
};

export const resolveOfferProductRowType = (row: OfferProductRow): OfferProductRowType => {
  if (!row || typeof row !== 'object') return 'unknown';
  const printableRaw = (row as { IsPrintable?: unknown }).IsPrintable;
  const commentRaw = (row as { IsComment?: unknown }).IsComment;
  const serviceRaw = (row as { IsService?: unknown }).IsService;
  const partNumberRaw = (row as { PartNumber?: unknown }).PartNumber;
  const modelNumberRaw = (row as { ModelNumber?: unknown }).ModelNumber;
  const requestedPartRaw = (row as { RequestedPartNo?: unknown }).RequestedPartNo;
  const requestedModelRaw = (row as { RequestedModelNo?: unknown }).RequestedModelNo;
  const categoryRaw = (row as { IsCategory?: unknown }).IsCategory;

  const isService = isTruthy(serviceRaw);
  const isComment = isTruthy(commentRaw);
  const isExplicitlyNotPrintable = isFalsy(printableRaw);
  const isExplicitCategory = isTruthy(categoryRaw);

  if (isService) {
    if (isExplicitlyNotPrintable) return 'non-printable-service';
    return 'printable-service';
  }
  if (isComment) {
    if (isExplicitlyNotPrintable) return 'non-printable-comment';
    return 'printable-comment';
  }
  if (isExplicitCategory) return 'category';
  const hasPartOrModel =
    hasPartNumber(partNumberRaw)
    || hasModelNumber(modelNumberRaw)
    || hasPartNumber(requestedPartRaw)
    || hasModelNumber(requestedModelRaw);

  if (hasPartOrModel) {
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

export const isOfferProductService = (row: OfferProductRow): boolean => {
  const type = resolveOfferProductRowType(row);
  return type === 'printable-service' || type === 'non-printable-service';
};

export const isNonPrintableOfferProductRow = (row: OfferProductRow): boolean => {
  const type = resolveOfferProductRowType(row);
  return type === 'non-printable-service' || type === 'non-printable-comment';
};

export const isNonPrintableComment = (row: OfferProductRow): boolean =>
  resolveOfferProductRowType(row) === 'non-printable-comment';

export const isOfferProductOption = (row: OfferProductRow): boolean => {
  if (!row || typeof row !== 'object') return false;
  return isTruthy((row as { IsOption?: unknown }).IsOption);
};

/**
 * A row that looks like a product (or is free-text) but has no real catalog link —
 * i.e. no positive ProductID. These render light grey ('offer-row--unlinked') and are
 * treated as non-catalog archive rows (e.g. imported TelQuote lines). Categories,
 * comments and services are never "unlinked".
 */
export const isUnlinkedOfferProductRow = (row: OfferProductRow): boolean => {
  if (!row || typeof row !== 'object') return false;
  const type = resolveOfferProductRowType(row);
  if (type !== 'product' && type !== 'unknown') return false;
  const productIdRaw = (row as { ProductID?: unknown }).ProductID;
  const hasCatalogLink = productIdRaw != null && Number(productIdRaw) > 0;
  return !hasCatalogLink;
};

export const describeOfferProductRowType = (type: OfferProductRowType | null | undefined) => {
  switch (type) {
    case 'category':
      return 'Categories';
    case 'product':
      return 'Products';
    case 'printable-comment':
      return 'Printable comments';
    case 'non-printable-comment':
      return 'Non printable comments';
    case 'printable-service':
      return 'Printable services';
    case 'non-printable-service':
      return 'Non printable services';
    default:
      return 'This row type';
  }
};
