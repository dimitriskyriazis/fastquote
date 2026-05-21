'use client';

import { useEffect, useState } from 'react';
import ProductDetailsClient from './ProductDetailsClient';
import styles from './ProductDetailsPanel.module.css';
import type {
  ProductDetailsRecord,
  ProductLookupItem,
  ProductSubCategoryItem,
} from './ProductDetailsTypes';

type Props = {
  productId: string;
};

type ProductResponse = {
  ok?: boolean;
  error?: string;
  product?: ProductDetailsRecord | null;
};

type LookupsResponse = {
  ok?: boolean;
  error?: string;
  brands?: ProductLookupItem[];
  categories?: ProductLookupItem[];
  subCategories?: ProductSubCategoryItem[];
  types?: ProductLookupItem[];
};

export default function ProductDetailsPanel({ productId }: Props) {
  const encodedId = encodeURIComponent(productId);
  const [record, setRecord] = useState<ProductDetailsRecord | null>(null);
  const [brands, setBrands] = useState<ProductLookupItem[]>([]);
  const [categories, setCategories] = useState<ProductLookupItem[]>([]);
  const [subCategories, setSubCategories] = useState<ProductSubCategoryItem[]>([]);
  const [types, setTypes] = useState<ProductLookupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const loadData = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [productRes, lookupsRes] = await Promise.all([
          fetch(`/api/products/${encodedId}`, { cache: 'no-store' }),
          fetch('/api/products/lookups', { cache: 'no-store' }),
        ]);

        const productPayload = (await productRes.json().catch(() => null)) as ProductResponse | null;
        if (!productRes.ok || !productPayload?.ok || !productPayload.product) {
          throw new Error(productPayload?.error ?? 'Unable to load product data.');
        }

        const lookupsPayload = (await lookupsRes.json().catch(() => null)) as LookupsResponse | null;
        if (!lookupsRes.ok || !lookupsPayload?.ok) {
          throw new Error(lookupsPayload?.error ?? 'Unable to load product lookups.');
        }

        if (!active) return;

        setRecord(productPayload.product);
        setBrands(Array.isArray(lookupsPayload.brands) ? lookupsPayload.brands : []);
        setCategories(Array.isArray(lookupsPayload.categories) ? lookupsPayload.categories : []);
        setSubCategories(Array.isArray(lookupsPayload.subCategories) ? lookupsPayload.subCategories : []);
        setTypes(Array.isArray(lookupsPayload.types) ? lookupsPayload.types : []);
      } catch (err) {
        if (!active) return;
        console.error('Failed to load product details', err);
        setRecord(null);
        setLoadError(err instanceof Error ? err.message : 'Unable to load product data.');
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
    return <section className={styles.emptyState}>Loading product data…</section>;
  }

  if (!record) {
    return (
      <section className={styles.emptyState}>
        {loadError ?? 'This product could not be found or has been removed.'}
      </section>
    );
  }

  return (
    <ProductDetailsClient
      productId={productId}
      record={record}
      brands={brands}
      categories={categories}
      subCategories={subCategories}
      types={types}
    />
  );
}
