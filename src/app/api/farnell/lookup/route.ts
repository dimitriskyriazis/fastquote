import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import { requirePermission } from '../../../../lib/authz';
import { fetchFarnellProduct, fetchFarnellProducts, type FarnellProduct } from '../../../../lib/farnell';
import { getPool } from '../../../../lib/sql';

let cachedFarnellBrandId: number | null | undefined = undefined;

// Cache Farnell API results for 10 minutes to avoid repeated slow external calls
const CACHE_TTL_MS = 10 * 60 * 1000;
const singleCache = new Map<string, { product: FarnellProduct | null; ts: number }>();
const multiCache = new Map<string, { products: FarnellProduct[]; ts: number }>();

function evictStale<T>(cache: Map<string, { ts: number } & T>) {
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts > CACHE_TTL_MS) cache.delete(k);
    }
  }
}

async function fetchCached(sku: string, quantity: number, searchType: 'id' | 'manuPartNum'): Promise<FarnellProduct | null> {
  const key = `${searchType}::${sku}::${quantity}`;
  const entry = singleCache.get(key);
  if (entry && Date.now() - entry.ts <= CACHE_TTL_MS) return entry.product;
  const product = await fetchFarnellProduct(sku, quantity, searchType);
  singleCache.set(key, { product, ts: Date.now() });
  evictStale(singleCache);
  return product;
}

async function fetchCachedMulti(sku: string, quantity: number, searchType: 'id' | 'manuPartNum'): Promise<FarnellProduct[]> {
  const key = `multi::${searchType}::${sku}::${quantity}`;
  const entry = multiCache.get(key);
  if (entry && Date.now() - entry.ts <= CACHE_TTL_MS) return entry.products;
  const products = await fetchFarnellProducts(sku, quantity, searchType);
  multiCache.set(key, { products, ts: Date.now() });
  evictStale(multiCache);
  return products;
}

async function resolveFarnellBrandId(): Promise<number | null> {
  if (cachedFarnellBrandId !== undefined) return cachedFarnellBrandId;
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<{ ID: number }>(`
      SELECT TOP (1) ID FROM dbo.Brands WHERE LTRIM(RTRIM(Name)) = 'Farnell'
    `);
    cachedFarnellBrandId = result.recordset?.[0]?.ID ?? null;
    return cachedFarnellBrandId;
  } catch {
    cachedFarnellBrandId = null;
    return null;
  }
}

export async function GET(req: NextRequest) {
  logRequest(req, '/api/farnell/lookup');
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const { searchParams } = new URL(req.url);
    const sku = searchParams.get('sku')?.trim() ?? '';
    if (!sku) {
      return NextResponse.json(
        { ok: false, error: 'Missing required parameter: sku' },
        { status: 400 },
      );
    }

    const quantityParam = searchParams.get('quantity');
    const quantity =
      quantityParam != null ? Math.max(1, Math.trunc(Number(quantityParam) || 1)) : 1;

    const searchTypeParam = searchParams.get('searchType');

    if (searchTypeParam === 'auto') {
      // Try both in parallel, but only use part number results if order code found nothing
      const [byId, byPartNum] = await Promise.all([
        fetchCachedMulti(sku, quantity, 'id'),
        fetchCachedMulti(sku, quantity, 'manuPartNum'),
      ]);

      const results = byId.length > 0 ? byId : byPartNum;

      // Deduplicate by SKU
      const seen = new Set<string>();
      const products: FarnellProduct[] = [];
      for (const p of results) {
        if (!seen.has(p.sku)) {
          seen.add(p.sku);
          products.push(p);
        }
      }

      if (products.length === 0) {
        return NextResponse.json(
          { ok: false, error: `No product found for ${sku}` },
          { status: 404 },
        );
      }

      const farnellBrandId = await resolveFarnellBrandId();
      // Return both `products` array and `product` (first match) for backward compatibility
      return NextResponse.json({ ok: true, product: products[0], products, farnellBrandId });
    }

    // Single-product lookup (used by offers flow)
    const searchType = searchTypeParam === 'manuPartNum' ? 'manuPartNum' : 'id';
    const product = await fetchCached(sku, quantity, searchType);

    if (!product) {
      return NextResponse.json(
        { ok: false, error: `No product found for SKU ${sku}` },
        { status: 404 },
      );
    }

    const farnellBrandId = await resolveFarnellBrandId();
    return NextResponse.json({ ok: true, product, farnellBrandId });
  } catch (err) {
    console.error('Farnell lookup failed', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
