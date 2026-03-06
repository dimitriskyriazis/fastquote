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

export default function RecentOffersSection() {
  const [recentOffers, setRecentOffers] = useState<RecentOfferSummary[]>([]);
  const [verifiedOffers, setVerifiedOffers] = useState<RecentOfferSummary[] | null>([]);
  const [descriptionOverrides, setDescriptionOverrides] = useState<Record<string, string>>({});
  const { userId } = useAuditUser();

  const refreshRecentOffers = useCallback(
    async (signal?: AbortSignal) => {
      if (typeof window === "undefined") return;
      try {
        const entries = sortRecentOffers(await loadRecentOffers());
        if (signal?.aborted) return;
        setRecentOffers(entries);
        setVerifiedOffers(entries.length === 0 ? [] : null);
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
    if (recentOffers.length === 0) {
      return;
    }

    let cancelled = false;
    const verifyOffersAndDescriptions = async () => {
      try {
        const ids = recentOffers.map((entry) => entry.id);
        const response = await fetch('/api/offers/batch-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        });
        if (!response.ok) return;
        const payload = (await response.json()) as {
          ok?: boolean;
          offers?: Record<string, {
            description?: string | null;
            title?: string | null;
            isStandardPackage?: boolean;
          }>;
        } | null;
        if (!payload?.ok || !payload.offers) return;

        const nextVerified: RecentOfferSummary[] = [];
        const nextOverrides: Record<string, string> = {};
        for (const entry of recentOffers) {
          const offer = payload.offers[entry.id];
          if (!offer) continue;
          if (offer.isStandardPackage) continue;
          nextVerified.push(entry);
          const resolvedDescription = offer.description?.trim() || offer.title?.trim();
          if (resolvedDescription) {
            nextOverrides[entry.id] = resolvedDescription;
          }
        }

        if (cancelled) return;
        setVerifiedOffers(nextVerified);
        setDescriptionOverrides(nextOverrides);
      } catch {
        // On failure, show unverified offers
      }
    };

    void verifyOffersAndDescriptions();
    return () => {
      cancelled = true;
    };
  }, [recentOffers]);

  const offersToRender = verifiedOffers ?? [];
  const isCheckingRecentOffers = verifiedOffers === null;

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

      <hr className={styles.divider} />

      {isCheckingRecentOffers ? (
        <div className={styles.emptyState}>
          <p>Checking recent offers...</p>
        </div>
      ) : offersToRender.length === 0 ? (
        <div className={styles.emptyState}>
          <p>No offers shown yet.</p>
          <p>Open any offer to make it appear here for quick access.</p>
        </div>
      ) : (
        <div className={styles.recentOfferGrid}>
          {offersToRender.map((offer) => {
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
