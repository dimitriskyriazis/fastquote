import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import { requirePermission } from '../../../../../lib/authz';
import {
  composeEmbeddingText,
  embedTexts,
  fetchProductsNeedingEmbedding,
  getSemanticIndex,
  writeEmbeddings,
} from '../../../../../lib/productEmbeddings';

export const runtime = 'nodejs';
export const maxDuration = 300;

// POST /api/products/embeddings/backfill
// Body: { limit?: number }
// Pulls up to `limit` products with a missing embedding, embeds them via
// OpenAI in batches, and writes the vectors back.  Safe to re-run — the query
// filter WHERE Embedding IS NULL prevents double-processing.  Invalidates the
// in-memory semantic index after the write so fresh embeddings surface on the
// next search without requiring a process restart.
export async function POST(req: NextRequest) {
  logRequest(req, '/api/products/embeddings/backfill');
  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response;

  try {
    const body = (await req.json().catch(() => ({}))) as { limit?: number };
    const limit = Math.max(1, Math.min(2000, body.limit ?? 500));

    const rows = await fetchProductsNeedingEmbedding(limit);
    if (rows.length === 0) {
      return NextResponse.json({ ok: true, processed: 0, remaining: 0 });
    }

    const texts = rows.map((r) => composeEmbeddingText(r));
    const vectors = await embedTexts(texts);

    const payload = rows.map((r, i) => ({
      productId: r.ProductID,
      text: texts[i],
      vector: vectors[i],
    }));
    const written = await writeEmbeddings(payload);
    getSemanticIndex().invalidate();

    return NextResponse.json({
      ok: true,
      processed: written,
      batchSize: rows.length,
    });
  } catch (err) {
    console.error('Failed to backfill embeddings', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// GET /api/products/embeddings/backfill
// Returns index statistics — useful for monitoring backfill progress without
// actually running it.
export async function GET(req: NextRequest) {
  logRequest(req, '/api/products/embeddings/backfill');
  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response;

  const index = getSemanticIndex();
  const stats = index.stats();
  return NextResponse.json({ ok: true, ...stats });
}
