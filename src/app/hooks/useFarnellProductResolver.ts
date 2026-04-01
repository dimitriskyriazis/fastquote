import { useCallback, useState } from 'react';
import {
  resolveFarnellProductByPartNumber,
  createFarnellProduct,
} from '../offers/[offerId]/offerProductsUtils';
import type { FarnellSearchRow } from './useFarnellSearch';

export function useFarnellProductResolver() {
  const [resolving, setResolving] = useState(false);

  const resolveFarnellProduct = useCallback(async (
    row: FarnellSearchRow,
  ): Promise<number | null> => {
    setResolving(true);
    try {
      const sku = row.__farnellSku;

      // 1. Check if product already exists in database
      const existingId = await resolveFarnellProductByPartNumber(sku);
      if (existingId != null) return existingId;

      // 2. Need to create — fetch full product data and create
      const farnellBrandId = row.__farnellBrandId;
      if (farnellBrandId == null) return null;

      const farnellProduct = row.__farnellProduct;
      if (!farnellProduct) return null;

      const createdId = await createFarnellProduct(farnellBrandId, farnellProduct, sku);
      return createdId;
    } catch (err) {
      console.error('Failed to resolve Farnell product', err);
      return null;
    } finally {
      setResolving(false);
    }
  }, []);

  return { resolveFarnellProduct, resolving };
}
