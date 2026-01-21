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
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidRecentOffer);
  } catch {
    return [];
  }
};

const persistLocalOffers = (entries: RecentOfferSummary[]) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* ignore */
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

const parseApiResponse = (value: unknown): RecentOfferSummary[] | null => {
  if (!value || typeof value !== "object") return null;
  const payload = value as { ok?: boolean; offers?: unknown };
  if (!payload.ok || !Array.isArray(payload.offers)) return null;
  const normalized = payload.offers.filter(isValidRecentOffer);
  return normalized.length > 0 ? normalized : [];
};

const mergeRecentOffers = (
  server: RecentOfferSummary[],
  local: RecentOfferSummary[],
): RecentOfferSummary[] => {
  const byId = new Map<string, RecentOfferSummary>();
  const score = (value: RecentOfferSummary) => {
    const parsed = new Date(value.openedAt).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  };

  // Prefer server values when openedAt ties, but never drop local-only entries.
  for (const entry of [...local, ...server]) {
    const existing = byId.get(entry.id);
    if (!existing) {
      byId.set(entry.id, entry);
      continue;
    }
    if (score(entry) > score(existing)) {
      byId.set(entry.id, entry);
    }
  }

  return [...byId.values()]
    .sort((a, b) => score(b) - score(a))
    .slice(0, RECENT_OFFERS_MAX);
};

const fetchRecentOffersFromApi = async () => {
  const response = await fetch("/api/recent-offers", { cache: "no-store" });
  const payload = await response.json().catch(() => null);
  const parsed = parseApiResponse(payload);
  if (!response.ok || parsed === null) {
    throw new Error("Failed to load recent offers from server");
  }
  const merged = mergeRecentOffers(parsed, loadLocalOffers());
  persistLocalOffers(merged);
  return merged;
};

export async function loadRecentOffers(): Promise<RecentOfferSummary[]> {
  if (typeof window === "undefined") return [];
  try {
    return await fetchRecentOffersFromApi();
  } catch (error) {
    console.error("Unable to load recent offers from API", error);
    return loadLocalOffers();
  }
}

export async function addRecentOffer(
  entry: Omit<RecentOfferSummary, "openedAt"> & { openedAt?: string },
): Promise<void> {
  if (typeof window === "undefined") return;
  const normalized = normalizeEntry(entry);
  try {
    const response = await fetch("/api/recent-offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalized),
    });
    const payload = await response.json().catch(() => null);
    const parsed = parseApiResponse(payload);
    if (!response.ok || parsed === null) {
      throw new Error("Failed to save recent offer");
    }
    const merged = mergeRecentOffers(parsed, loadLocalOffers());
    persistLocalOffers(merged);
    return;
  } catch (error) {
    console.error("Failed to persist recent offer to API, falling back to local storage", error);
    const fallback = [
      normalized,
      ...loadLocalOffers().filter((item) => item.id !== normalized.id),
    ].slice(0, RECENT_OFFERS_MAX);
    persistLocalOffers(fallback);
  }
}

export function buildRecentOfferLabel(
  source: { title?: string | null; description?: string | null },
  fallback = "Untitled offer",
) {
  const normalize = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim() : value ? String(value).trim() : "";
  const description = normalize(source.description);
  const title = normalize(source.title);
  if (description && title) return `${description} ™?? ${title}`;
  if (description) return description;
  if (title) return title;
  return fallback;
}
