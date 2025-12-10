import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  const { productId } = await context.params;
  try {
    const normalized = normalizeProductId(productId);
    if (normalized == null) {
      return NextResponse.json({ ok: false, error: 'Invalid product id' }, { status: 400 });
    }
    const pool = await getPool();
    const request = pool.request();
    request.input('productId', sql.Int, normalized);
    const result = await request.query<{
      ProductID: number;
      PartNumber: string | null;
      ModelNumber: string | null;
      BrandName: string | null;
      Description: string | null;
    }>(`
      SELECT
        p.ID AS ProductID,
        NULLIF(LTRIM(RTRIM(p.PartNumber)), '') AS PartNumber,
        NULLIF(LTRIM(RTRIM(p.ModelNumber)), '') AS ModelNumber,
        NULLIF(LTRIM(RTRIM(b.Name)), '') AS BrandName,
        NULLIF(LTRIM(RTRIM(p.Description)), '') AS Description
      FROM dbo.Products p
      LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
      WHERE p.ID = @productId
    `);
    const row = result.recordset?.[0] ?? null;
    if (!row) {
      return NextResponse.json({ ok: false, error: 'Product not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, product: row });
  } catch (err) {
    console.error('Failed to fetch product summary', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
