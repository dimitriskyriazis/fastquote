export type { RecentOfferSummary } from "../../lib/recentOfferTypes";
import type { RecentOfferSummary } from "../../lib/recentOfferTypes";
import { RECENT_OFFERS_MAX } from "../../lib/recentOfferTypes";

const LOCAL_STORAGE_KEY = "fastquote.recentOffers";

const isValidRecentOffer = (value: unknown): value is RecentOfferSummary => {
  if (!value || typeof value !== "object") return false;
  const candidate = value as RecentOfferSummary;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.label === "string" &&
    candidate.label.length > 0 &&
    typeof candidate.openedAt === "string"
  );
};

const parseStoredValue = (raw: string | null): RecentOfferSummary[] => {
  if (!raw) {
    console.log('[recentOffers] No stored value found');
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.warn('[recentOffers] Stored value is not an array — discarding', { parsed });
      return [];
    }
    const valid = parsed.filter(isValidRecentOffer);
    if (valid.length !== parsed.length) {
      console.warn('[recentOffers] Some stored entries failed validation', {
        total: parsed.length,
        valid: valid.length,
      });
    }
    return valid;
  } catch (err) {
    console.warn('[recentOffers] Failed to parse stored value', err);
    return [];
  }
};

const persistLocalOffers = (entries: RecentOfferSummary[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(entries));
  } catch (err) {
    console.warn('[recentOffers] Failed to persist — localStorage may be full or blocked', err);
  }
};

const loadLocalOffers = (): RecentOfferSummary[] => {
  if (typeof window === "undefined") return [];
  return parseStoredValue(window.localStorage.getItem(LOCAL_STORAGE_KEY));
};

const normalizeEntry = (
  entry: Omit<RecentOfferSummary, "openedAt"> & { openedAt?: string },
): RecentOfferSummary => {
  const now = new Date();
  const normalizedOpenedAt =
    typeof entry.openedAt === "string" && !Number.isNaN(new Date(entry.openedAt).getTime())
      ? new Date(entry.openedAt).toISOString()
      : now.toISOString();
  const normalizeText = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : value ? String(value).trim() : "";
  const normalizedId = normalizeText(entry.id);
  const normalizedLabel = normalizeText(entry.label);
  const normalizedCustomerName = normalizeText(entry.customerName);
  const normalizedDescription = normalizeText(entry.description);
  const normalizedTitle = normalizeText(entry.title);
  return {
    id: normalizedId,
    label: normalizedLabel,
    customerName: normalizedCustomerName.length > 0 ? normalizedCustomerName : null,
    description: normalizedDescription.length > 0 ? normalizedDescription : null,
    title: normalizedTitle.length > 0 ? normalizedTitle : null,
    openedAt: normalizedOpenedAt,
  };
};

export async function loadRecentOffers(): Promise<RecentOfferSummary[]> {
  if (typeof window === "undefined") return [];
  return loadLocalOffers();
}

export async function addRecentOffer(
  entry: Omit<RecentOfferSummary, "openedAt"> & { openedAt?: string },
): Promise<void> {
  if (typeof window === "undefined") return;
  const normalized = normalizeEntry(entry);
  const current = loadLocalOffers();
  const next = [normalized, ...current.filter((item) => item.id !== normalized.id)].slice(
    0,
    RECENT_OFFERS_MAX,
  );
  persistLocalOffers(next);
}

export function buildRecentOfferLabel(
  source: { title?: string | null; description?: string | null },
  fallback = "Untitled offer",
) {
  const normalize = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : value ? String(value).trim() : "";
  const description = normalize(source.description);
  const title = normalize(source.title);
  if (description && title) return `${description} – ${title}`;
  if (description) return description;
  if (title) return title;
  return fallback;
}
