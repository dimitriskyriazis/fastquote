'use client';

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAuditUser } from "./components/AuditUserProvider";
import { loadRecentOffers, type RecentOfferSummary } from "./lib/recentOffers";
import { formatDateTime } from "./lib/formatDateTime";
import styles from "./page.module.css";

const sortRecentOffers = (items: RecentOfferSummary[]) =>
  [...items].sort((a, b) => {
    const left = new Date(a.openedAt).getTime();
    const right = new Date(b.openedAt).getTime();
    return right - left;
  });

const normalizeOfferIdToken = (value: string) =>
  value.replace(/[^0-9]+/g, "").trim();

const looksLikeOfferIdPlaceholder = (text: string, offerId: string) => {
  const normalized = text.trim().toLowerCase();
  const numericId = normalizeOfferIdToken(offerId);
  if (!numericId) return false;
  const bare = `offer ${numericId}`;
  if (normalized === bare) return true;
  if (normalized === `offer #${numericId}`) return true;
  if (normalized === `offerid ${numericId}`) return true;
  return false;
};

export default function RecentOffersSection() {
  const [recentOffers, setRecentOffers] = useState<RecentOfferSummary[]>([]);
  const [descriptionOverrides, setDescriptionOverrides] = useState<Record<string, string>>({});
  const { userId } = useAuditUser();

  const refreshRecentOffers = useCallback(
    async (signal?: AbortSignal) => {
      if (typeof window === "undefined") return;
      try {
        const entries = sortRecentOffers(await loadRecentOffers());
        if (signal?.aborted) return;
        setRecentOffers(entries);
        setDescriptionOverrides({});
      } catch (err) {
        console.error("Failed to load recent offers", err);
      }
    },
    [],
  );

  useEffect(() => {
    const abortController = new AbortController();
    const timeout = window.setTimeout(() => {
      void refreshRecentOffers(abortController.signal);
    }, 0);
    return () => {
      window.clearTimeout(timeout);
      abortController.abort();
    };
  }, [refreshRecentOffers, userId]);

  useEffect(() => {
    const handleStorage = () => {
      void refreshRecentOffers();
    };

    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("storage", handleStorage);
    };
  }, [refreshRecentOffers]);

  useEffect(() => {
    if (recentOffers.length === 0) return;
    const missing = recentOffers.filter((offer) => {
      const overridden = descriptionOverrides[offer.id];
      if (overridden) return false;
      const storedDescription = offer.description?.trim();
      if (!storedDescription) return true;
      if (looksLikeOfferIdPlaceholder(storedDescription, offer.id)) return true;
      return false;
    });
    if (missing.length === 0) return;
    let cancelled = false;
    const refreshDescriptions = async () => {
      const updated: Record<string, string> = {};
      for (const entry of missing) {
        try {
          const response = await fetch(`/api/offers/${encodeURIComponent(entry.id)}/summary`);
          if (!response.ok) continue;
          const payload = (await response.json()) as {
            ok?: boolean;
            offer?: { description?: string | null; title?: string | null };
          } | null;
          if (!payload?.ok) continue;
          const description = payload.offer?.description?.trim();
          const title = payload.offer?.title?.trim();
          const resolved = description || title;
          if (resolved) {
            updated[entry.id] = resolved;
          }
        } catch {
          //
        }
      }
      if (cancelled) return;
      if (Object.keys(updated).length === 0) return;
      setDescriptionOverrides((prev) => ({ ...prev, ...updated }));
    };
    void refreshDescriptions();
    return () => {
      cancelled = true;
    };
  }, [recentOffers, descriptionOverrides]);

  return (
    <section className={styles.recentOffersSection}>
      <header className={styles.sectionHeader}>
        <h2 className={styles.sectionTitle}>Recent Offers</h2>
        <Link
          href="/offers"
          className={`${styles.sectionAction} page-header-button`}
        >
          View all offers
        </Link>
      </header>

      {recentOffers.length === 0 ? (
        <div className={styles.emptyState}>
          <p>No offers shown yet.</p>
          <p>Open any offer to make it appear here for quick access.</p>
        </div>
      ) : (
        <div className={styles.recentOfferGrid}>
          {recentOffers.map((offer) => {
            const encodedId = encodeURIComponent(offer.id);
            const descriptionValue = descriptionOverrides[offer.id] ?? offer.description?.trim();
            const fallbackDescription = offer.label.includes(" – ")
              ? offer.label.split(" – ")[0].trim()
              : offer.label.trim();
            const descriptionOnly = descriptionValue || fallbackDescription;
            return (
              <Link
                key={offer.id}
                href={`/offers/${encodedId}/products`}
                className={styles.recentOfferCard}
              >
                <p className={styles.cardLabel}>{descriptionOnly}</p>
                <div className={styles.cardMetaRow}>
                  <span className={styles.cardDate}>{formatDateTime(offer.openedAt)}</span>
                  <span className={styles.cardId}>Offer {offer.id}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
