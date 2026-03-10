import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import { requirePermission } from '../../../../../../lib/authz';
import { suggestProducts, type SuggestInput } from './suggestProducts';

export const runtime = 'nodejs';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/products/suggest');

  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response;

  try {
    const { offerId: offerIdRaw } = await params;
    const offerId = Number.parseInt(offerIdRaw, 10);
    if (!Number.isFinite(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid offerId' }, { status: 400 });
    }

    const body = (await req.json()) as SuggestInput;
    const products = await suggestProducts(body);
    return NextResponse.json({ ok: true, products });
  } catch (err) {
    console.error('Failed to suggest products', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
