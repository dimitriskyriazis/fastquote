import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import { requirePermission } from '../../../../lib/authz';
import { fetchFarnellProduct, fetchFarnellProducts, type FarnellProduct } from '../../../../lib/farnell';
import { getPool } from '../../../../lib/sql';
import OpenAI from 'openai';

let _openai: OpenAI | null = null;
function getOpenAI() {
  if (!_openai) _openai = new OpenAI();
  return _openai;
}

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

async function fetchCached(sku: string, quantity: number, searchType: 'id' | 'manuPartNum' | 'keyword'): Promise<FarnellProduct | null> {
  const key = `${searchType}::${sku}::${quantity}`;
  const entry = singleCache.get(key);
  if (entry && Date.now() - entry.ts <= CACHE_TTL_MS) return entry.product;
  const product = await fetchFarnellProduct(sku, quantity, searchType);
  if (product != null) {
    singleCache.set(key, { product, ts: Date.now() });
    evictStale(singleCache);
  } else {
    singleCache.delete(key);
  }
  return product;
}

async function fetchCachedMulti(sku: string, quantity: number, searchType: 'id' | 'manuPartNum' | 'keyword'): Promise<FarnellProduct[]> {
  const key = `multi::${searchType}::${sku}::${quantity}`;
  const entry = multiCache.get(key);
  if (entry && Date.now() - entry.ts <= CACHE_TTL_MS) return entry.products;
  const products = await fetchFarnellProducts(sku, quantity, searchType);
  // Only cache non-empty results — empty results may be due to transient
  // issues or code changes (e.g. hyphen fix) and should be retried.
  if (products.length > 0) {
    multiCache.set(key, { products, ts: Date.now() });
    evictStale(multiCache);
  } else {
    multiCache.delete(key);
  }
  return products;
}

async function generateFarnellSearchTerms(description: string): Promise<string[]> {
  try {
    const res = await getOpenAI().responses.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      input: [
        {
          role: 'system',
          content: [
            'You are a Farnell/Element14 product search assistant.',
            'Given a product description, generate the most likely manufacturer part numbers or search terms that would find this exact product on Farnell.',
            '',
            'RULES:',
            '- Return ONLY a JSON array of exactly 2 search terms as strings',
            '- FIRST term: the most specific, full manufacturer part number (e.g. RPI5-4GB-SINGLE, SC1157, SC1159)',
            '- SECOND term: a shorter/alternative part number or 2-3 keyword search',
            '- Put the LONGEST, most complete part number FIRST — this is critical',
            '- For Raspberry Pi: full part numbers include suffixes like -SINGLE, -EU, -UK',
            '- Do NOT include generic terms like just "RPI5" or brand names alone',
            '- Do NOT wrap in markdown code blocks',
          ].join('\n'),
        },
        {
          role: 'user',
          content: description,
        },
      ],
      stream: false,
    });

    const text = res.output_text?.trim() ?? '';
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).slice(0, 2);
    }
    return [];
  } catch (err) {
    console.error('Failed to generate Farnell search terms', err);
    return [];
  }
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

    if (searchTypeParam === 'keyword') {
      const products = await fetchCachedMulti(sku, quantity, 'keyword');
      if (products.length === 0) {
        return NextResponse.json(
          { ok: false, error: `No products found for "${sku}"` },
          { status: 404 },
        );
      }
      const farnellBrandId = await resolveFarnellBrandId();
      return NextResponse.json({ ok: true, product: products[0], products, farnellBrandId });
    }

    if (searchTypeParam === 'ai') {
      // Use AI to generate likely part numbers, then search sequentially
      // to avoid rate-limiting (403) from too many parallel API calls.
      const aiTerms = await generateFarnellSearchTerms(sku);
      const seen = new Set<string>();
      const products: FarnellProduct[] = [];

      for (const term of aiTerms) {
        const trimmed = term.trim();
        if (!trimmed) continue;
        const hasSpaces = /\s/.test(trimmed);

        let batch: FarnellProduct[] = [];
        try {
          if (!hasSpaces) {
            // AI generates manufacturer part numbers, not Farnell order codes —
            // only try manuPartNum to minimize API calls and avoid rate limiting.
            batch = await fetchCachedMulti(trimmed, quantity, 'manuPartNum');
          } else {
            batch = await fetchCachedMulti(trimmed, quantity, 'keyword');
          }
        } catch {
          // Stop on any error (likely 403 rate limit) — don't hammer the API
          break;
        }

        for (const p of batch) {
          if (!seen.has(p.sku)) {
            seen.add(p.sku);
            products.push(p);
          }
        }
        // Stop once we have enough results
        if (products.length >= 10) break;
      }

      // Fallback to keyword with original description if AI terms found nothing
      if (products.length === 0) {
        const kwResults = await fetchCachedMulti(sku, quantity, 'keyword');
        for (const p of kwResults) {
          if (!seen.has(p.sku)) {
            seen.add(p.sku);
            products.push(p);
          }
        }
      }

      if (products.length === 0) {
        return NextResponse.json(
          { ok: false, error: `No product found for ${sku}` },
          { status: 404 },
        );
      }

      const farnellBrandId = await resolveFarnellBrandId();
      return NextResponse.json({ ok: true, product: products[0], products, farnellBrandId });
    }

    if (searchTypeParam === 'auto') {
      // Terms with spaces are not valid order codes or part numbers —
      // skip id/manuPartNum to avoid 500 errors from the Element14 API.
      const hasSpaces = /\s/.test(sku);
      let results: FarnellProduct[] = [];

      if (!hasSpaces) {
        const [byId, byPartNum] = await Promise.all([
          fetchCachedMulti(sku, quantity, 'id'),
          fetchCachedMulti(sku, quantity, 'manuPartNum'),
        ]);
        results = byId.length > 0 ? byId : byPartNum;
      }

      // Fallback to keyword search when id/manuPartNum didn't match (or were skipped)
      if (results.length === 0) {
        results = await fetchCachedMulti(sku, quantity, 'keyword');
      }

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
    if (err instanceof Error && err.message === 'FARNELL_RATE_LIMITED') {
      return NextResponse.json(
        { ok: false, error: 'Farnell API rate limited. Please try again in a moment.' },
        { status: 429 },
      );
    }
    console.error('Farnell lookup failed', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
