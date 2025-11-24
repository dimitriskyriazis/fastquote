export type PriceListStatus = 'active' | 'expiring' | 'expired' | null;

export type PriceListRow = {
  PriceListID?: unknown;
  PriceListEnabled?: unknown;
  PriceListValidFromDate?: unknown;
  PriceListValidToDate?: unknown;
} | null | undefined;

const MS_PER_DAY = 1000 * 60 * 60 * 24;
export const EXPIRING_THRESHOLD_DAYS = 30;

const normalizeInteger = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeBooleanFlag = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n'].includes(normalized)) return false;
  }
  return null;
};

const parseDateValue = (value: unknown): Date | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};

export const resolvePriceListStatus = (row: PriceListRow): PriceListStatus => {
  if (!row || typeof row !== 'object') return null;
  const priceListId = normalizeInteger((row as { PriceListID?: unknown })?.PriceListID ?? null);
  // No linked price list: leave unstyled
  if (priceListId == null) return null;

  const enabled = normalizeBooleanFlag((row as { PriceListEnabled?: unknown })?.PriceListEnabled ?? null);
  if (enabled === false) return 'expired';

  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const validFromRaw = (row as { PriceListValidFromDate?: unknown })?.PriceListValidFromDate ?? null;
  const validToRaw = (row as { PriceListValidToDate?: unknown })?.PriceListValidToDate ?? null;
  const validFrom = parseDateValue(validFromRaw);
  const validTo = parseDateValue(validToRaw);

  const validFromMs = validFrom ? Date.UTC(validFrom.getUTCFullYear(), validFrom.getUTCMonth(), validFrom.getUTCDate()) : null;
  const validToMs = validTo ? Date.UTC(validTo.getUTCFullYear(), validTo.getUTCMonth(), validTo.getUTCDate()) : null;

  if (validFromMs != null && validFromMs > todayUtc) return 'expired';
  if (validToMs != null) {
    if (validToMs < todayUtc) return 'expired';
    const daysUntilExpiry = (validToMs - todayUtc) / MS_PER_DAY;
    if (daysUntilExpiry <= EXPIRING_THRESHOLD_DAYS) return 'expiring';
  }

  return 'active';
};

export const priceListStatusClassRules = (rowAccessor?: (params: { data?: Record<string, unknown> | null }) => PriceListRow) => {
  const resolveRow = rowAccessor
    ? (params: { data?: Record<string, unknown> | null }) => rowAccessor(params)
    : (params: { data?: Record<string, unknown> | null }) => params.data;

  return {
    'offer-products-grid__cell--pricelist-active': (params: { data?: Record<string, unknown> | null }) =>
      resolvePriceListStatus(resolveRow(params)) === 'active',
    'offer-products-grid__cell--pricelist-expiring': (params: { data?: Record<string, unknown> | null }) =>
      resolvePriceListStatus(resolveRow(params)) === 'expiring',
    'offer-products-grid__cell--pricelist-expired': (params: { data?: Record<string, unknown> | null }) =>
      resolvePriceListStatus(resolveRow(params)) === 'expired',
  };
};
