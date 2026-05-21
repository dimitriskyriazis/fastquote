'use client';

import { useEffect, useState } from 'react';
import BrandDetailsClient from './BrandDetailsClient';
import styles from './BrandDetailsPanel.module.css';
import type { BrandDetailsRecord } from './BrandDetailsTypes';

type Props = {
  brandId: string;
};

type BrandResponse = {
  ok?: boolean;
  error?: string;
  brand?: BrandDetailsRecord | null;
};

export default function BrandDetailsPanel({ brandId }: Props) {
  const encodedId = encodeURIComponent(brandId);
  const [record, setRecord] = useState<BrandDetailsRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const res = await fetch(`/api/brands/${encodedId}`, { cache: 'no-store' });
        const payload = (await res.json().catch(() => null)) as BrandResponse | null;
        if (!res.ok || !payload?.ok || !payload.brand) {
          throw new Error(payload?.error ?? 'Unable to load brand data.');
        }
        if (!active) return;
        setRecord(payload.brand);
      } catch (err) {
        if (!active) return;
        console.error('Failed to load brand details', err);
        setRecord(null);
        setLoadError(err instanceof Error ? err.message : 'Unable to load brand data.');
      } finally {
        if (!active) return;
        setLoading(false);
      }
    };

    void loadData();

    return () => {
      active = false;
    };
  }, [encodedId]);

  if (loading && !record) {
    return <section className={styles.emptyState}>Loading brand data…</section>;
  }

  if (!record) {
    return (
      <section className={styles.emptyState}>
        {loadError ?? 'This brand could not be found or has been removed.'}
      </section>
    );
  }

  return <BrandDetailsClient brandId={brandId} record={record} />;
}
