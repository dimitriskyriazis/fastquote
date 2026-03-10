import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import { requirePermission } from '../../../../../../lib/authz';
import { suggestProducts, type SuggestInput } from '../suggest/suggestProducts';

export const runtime = 'nodejs';

type BatchEntry = SuggestInput & { offerDetailId: number };

type RequestBody = {
  entries: BatchEntry[];
};

const MAX_CONCURRENT = 5;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products/suggest-batch');

  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response;

  try {
    const { offerId: offerIdRaw } = await params;
    const offerId = Number.parseInt(offerIdRaw, 10);
    if (!Number.isFinite(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid offerId' }, { status: 400 });
    }

    const body = (await req.json()) as RequestBody;
    const entries = body.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return NextResponse.json({ ok: true, results: {} });
    }

    // Process entries with bounded concurrency
    const results: Record<number, Record<string, unknown>[]> = {};
    let idx = 0;

    async function next(): Promise<void> {
      while (idx < entries.length) {
        const entry = entries[idx++];
        try {
          const products = await suggestProducts(entry);
          results[entry.offerDetailId] = products;
        } catch (err) {
          console.error(`[suggest-batch] Failed for offerDetailId=${entry.offerDetailId}`, err);
          results[entry.offerDetailId] = [];
        }
      }
    }

    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, entries.length) }, () => next());
    await Promise.all(workers);

    return NextResponse.json({ ok: true, results });
  } catch (err) {
    console.error('Failed to suggest-batch products', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
