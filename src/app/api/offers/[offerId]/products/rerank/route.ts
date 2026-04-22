import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../../lib/apiHelpers';
import { requirePermission } from '../../../../../../lib/authz';
import { performRerank, type RerankInput, type RankedEntry } from '../../../../../../lib/rerank';

export const runtime = 'nodejs';

// Thin HTTP wrapper around performRerank() in ../lib/rerank.ts.  The grid
// route (products/add) now calls performRerank() inline on first-page
// loads, so the client no longer needs this endpoint for the normal match
// flow.  Kept for ad-hoc debugging and any future callers that want to
// rerank without touching the grid path.

type RerankOutput = {
  ok: boolean;
  ranked?: RankedEntry[];
  error?: string;
};

export async function POST(
  req: NextRequest,
): Promise<NextResponse<RerankOutput>> {
  logRequest(req, '/api/offers/[offerId]/products/rerank');
  const auth = await requirePermission(req, 'editOffers');
  if (!auth.ok) return auth.response as NextResponse<RerankOutput>;
  try {
    const body = (await req.json()) as RerankInput;
    const ranked = await performRerank(body);
    return NextResponse.json({ ok: true, ranked });
  } catch (err) {
    console.error('Rerank endpoint failed', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Server error' },
      { status: 500 },
    );
  }
}
