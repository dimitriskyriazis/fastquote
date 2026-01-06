export type RecentOfferSummary = {
  id: string;
  label: string;
  customerName?: string | null;
  description?: string | null;
  title?: string | null;
  openedAt: string;
};

const STORAGE_KEY_PREFIX = 'fastquote.recentOffers';
const STORAGE_KEY_DEFAULT_USER = 'anon';
const MAX_ENTRIES = 6;
export const RECENT_OFFERS_MAX = MAX_ENTRIES;

const isValidRecentOffer = (value: unknown): value is RecentOfferSummary => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as RecentOfferSummary;
  return (
    typeof candidate.id === 'string' &&
    candidate.id.length > 0 &&
    typeof candidate.label === 'string' &&
    candidate.label.length > 0 &&
    typeof candidate.openedAt === 'string'
  );
};

const parseStoredValue = (raw: string | null): RecentOfferSummary[] => {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecentOffer);
  } catch {
    return [];
  }
};

const resolveStorageKey = (userId?: string | null) => {
  const trimmed = typeof userId === 'string' ? userId.trim() : '';
  const normalized = trimmed.length > 0 ? trimmed : STORAGE_KEY_DEFAULT_USER;
  return `${STORAGE_KEY_PREFIX}:${normalized}`;
};

const persistEntries = (entries: RecentOfferSummary[], key: string) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(entries));
  } catch {
    /* ignore */
  }
};

const loadEntries = (key: string) => {
  if (typeof window === 'undefined') return [];
  return parseStoredValue(window.localStorage.getItem(key));
};

export function loadRecentOffers(userId?: string | null): RecentOfferSummary[] {
  if (typeof window === 'undefined') return [];
  const key = resolveStorageKey(userId);
  return loadEntries(key);
}

export function addRecentOffer(
  entry: Omit<RecentOfferSummary, 'openedAt'> & { openedAt?: string },
  userId?: string | null,
) {
  if (typeof window === 'undefined') return;
  const normalized: RecentOfferSummary = {
    id: entry.id,
    label: entry.label,
    customerName: entry.customerName ?? null,
    description: entry.description?.trim() ?? null,
    title: entry.title?.trim() ?? null,
    openedAt: entry.openedAt ?? new Date().toISOString(),
  };
  const key = resolveStorageKey(userId);
  const current = loadEntries(key);
  const next = [normalized, ...current.filter((item) => item.id !== normalized.id)].slice(
    0,
    MAX_ENTRIES,
  );
  persistEntries(next, key);
}

export function buildRecentOfferLabel(
  source: { title?: string | null; description?: string | null },
  fallback = 'Untitled offer',
) {
  const normalize = (value: string | null | undefined) =>
    typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
  const description = normalize(source.description);
  const title = normalize(source.title);
  if (description && title) return `${description} ™?? ${title}`;
  if (description) return description;
  if (title) return title;
  return fallback;
}
