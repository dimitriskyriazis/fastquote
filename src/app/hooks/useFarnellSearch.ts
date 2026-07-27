import { useCallback, useRef, useState } from 'react';
import {
  fetchFarnellSearchProducts,
  type FarnellLookupResult,
} from '../offers/[offerId]/offerProductsUtils';

export type FarnellSearchRow = {
  ProductID: string;
  PartNumber: string;
  Description: string;
  BrandName: string;
  ModelNumber: string | null;
  ListPrice: number | null;
  UnitPrice: number | null;
  PriceListName: string;
  /** Turns the Part Number cell into a link to the Farnell listing, so the
   *  user can eyeball which of several same-MPN order codes is the right one. */
  WebLink: string;
  __source: 'farnell-search';
  __farnellSku: string;
  __farnellProduct: FarnellLookupResult;
  __farnellBrandId: number | null;
};

function mapFarnellProduct(
  product: FarnellLookupResult,
  farnellBrandId: number | null,
): FarnellSearchRow {
  return {
    ProductID: `farnell-${product.sku}`,
    PartNumber: product.sku,
    Description: product.description ?? product.displayName ?? '',
    BrandName: 'Farnell',
    ModelNumber: product.manufacturerPartNumber,
    ListPrice: product.matchedPrice,
    UnitPrice: product.matchedPrice,
    PriceListName: 'Farnell API',
    WebLink: product.productURL
      ?? `https://be.farnell.com/en-BE/search?st=${encodeURIComponent(product.sku)}`,
    __source: 'farnell-search',
    __farnellSku: product.sku,
    __farnellProduct: product,
    __farnellBrandId: farnellBrandId,
  };
}

export function isFarnellRow(row: Record<string, unknown> | null | undefined): row is FarnellSearchRow {
  return row != null && (row as { __source?: string }).__source === 'farnell-search';
}

type UseFarnellSearchOptions = {
  partNumber: string | null;
  description: string | null;
  quantity?: number;
};

export function useFarnellSearch({ partNumber, description, quantity }: UseFarnellSearchOptions) {
  const [farnellResults, setFarnellResults] = useState<FarnellSearchRow[]>([]);
  const [farnellLoading, setFarnellLoading] = useState(false);
  const [noFarnellResults, setNoFarnellResults] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const searchFarnell = useCallback(async (overrideSearchTerm?: string) => {
    const hasOverride = overrideSearchTerm != null && overrideSearchTerm.trim().length > 0;
    const trimmedPartNumber = hasOverride ? null : (partNumber?.trim() || null);
    const trimmedDescription = hasOverride ? overrideSearchTerm.trim() : (description?.trim() || null);
    if (!trimmedPartNumber && !trimmedDescription) return;

    // Cancel any in-flight request
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setFarnellLoading(true);
    setNoFarnellResults(false);
    try {
      const qty = quantity != null && quantity > 0 ? quantity : 1;
      const promises: Promise<{ products: FarnellLookupResult[]; farnellBrandId: number | null }>[] = [];

      if (trimmedPartNumber) {
        promises.push(fetchFarnellSearchProducts(trimmedPartNumber, qty, 'auto', controller.signal));
      }
      if (trimmedDescription) {
        // Use AI to generate likely manufacturer part numbers from the description,
        // then search Farnell with those terms. Falls back to keyword if AI finds nothing.
        promises.push(fetchFarnellSearchProducts(trimmedDescription, qty, 'ai', controller.signal));
      }

      if (promises.length === 0) {
        setFarnellResults([]);
        setNoFarnellResults(true);
        return;
      }

      const results = await Promise.all(promises);
      if (controller.signal.aborted) return;

      // Merge and deduplicate by SKU
      const seen = new Set<string>();
      const merged: FarnellSearchRow[] = [];
      let farnellBrandId: number | null = null;
      for (const result of results) {
        if (result.farnellBrandId != null) farnellBrandId = result.farnellBrandId;
        for (const product of result.products) {
          if (!seen.has(product.sku)) {
            seen.add(product.sku);
            merged.push(mapFarnellProduct(product, farnellBrandId));
          }
        }
      }

      setFarnellResults(merged);
      setNoFarnellResults(merged.length === 0);
    } catch {
      if (!controller.signal.aborted) {
        setFarnellResults([]);
        setNoFarnellResults(true);
      }
    } finally {
      if (!controller.signal.aborted) {
        setFarnellLoading(false);
      }
    }
  }, [partNumber, description, quantity]);

  const clearFarnellResults = useCallback(() => {
    abortRef.current?.abort();
    setFarnellResults([]);
    setFarnellLoading(false);
    setNoFarnellResults(false);
  }, []);

  // Show candidates that were already fetched elsewhere (Populate hands over
  // the listings it refused to choose between) without re-hitting the API.
  const seedFarnellResults = useCallback((
    products: FarnellLookupResult[],
    farnellBrandId: number | null,
  ) => {
    abortRef.current?.abort();
    const seen = new Set<string>();
    const rows: FarnellSearchRow[] = [];
    for (const product of products) {
      if (!product?.sku || seen.has(product.sku)) continue;
      seen.add(product.sku);
      rows.push(mapFarnellProduct(product, farnellBrandId));
    }
    setFarnellResults(rows);
    setFarnellLoading(false);
    setNoFarnellResults(false);
  }, []);

  return {
    farnellResults,
    farnellLoading,
    noFarnellResults,
    searchFarnell,
    clearFarnellResults,
    seedFarnellResults,
  };
}
