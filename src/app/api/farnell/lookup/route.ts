import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import { requirePermission } from '../../../../lib/authz';
import { fetchFarnellProduct } from '../../../../lib/farnell';
import { getPool } from '../../../../lib/sql';

let cachedFarnellBrandId: number | null | undefined = undefined;

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

    const searchType = searchParams.get('searchType') === 'manuPartNum' ? 'manuPartNum' : 'id';

    const product = await fetchFarnellProduct(sku, quantity, searchType);
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
