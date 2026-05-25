import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { logRequest } from '../../../../../lib/apiHelpers';
import { getPool } from '../../../../../lib/sql';

type PricedServiceRow = {
  TreeOrdering: number | null;
  ProductDescription: string | null;
  Comment: string | null;
  Quantity: number | null;
  NetUnitPrice: number | null;
  TotalPrice: number | null;
  TotalNet: number | null;
  ListPrice: number | null;
  NetCost: number | null;
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(request, '/api/offers/[offerId]/priced-services');
  try {
    const { offerId: rawId } = await params;
    const normalizedId = decodeURIComponent(String(rawId ?? '')).trim();
    const numericId = Number(normalizedId);
    if (!normalizedId || !Number.isInteger(numericId) || numericId <= 0) {
      return NextResponse.json({ ok: false, error: 'Invalid offer id' }, { status: 400 });
    }

    const pool = await getPool();
    const req = pool.request();
    req.input('__offerId', sql.Int, numericId);
    const result = await req.query<PricedServiceRow>(`
      SELECT
        od.TreeOrdering,
        od.ProductDescription,
        od.Comment,
        od.Quantity,
        od.NetUnitPrice,
        od.TotalPrice,
        od.TotalNet,
        od.ListPrice,
        od.NetCost
      FROM dbo.OfferDetails AS od
      WHERE od.OfferID = @__offerId
        AND ISNULL(od.IsService, 0) = 1
        AND (
             (od.NetUnitPrice IS NOT NULL AND od.NetUnitPrice <> 0)
          OR (od.TotalPrice   IS NOT NULL AND od.TotalPrice   <> 0)
          OR (od.TotalNet     IS NOT NULL AND od.TotalNet     <> 0)
          OR (od.ListPrice    IS NOT NULL AND od.ListPrice    <> 0)
          OR (od.NetCost      IS NOT NULL AND od.NetCost      <> 0)
        )
      ORDER BY od.TreeOrdering, od.ID
    `);

    const services = (result.recordset ?? []).map((r) => ({
      treeOrdering: r.TreeOrdering != null ? Number(r.TreeOrdering) : null,
      description: (r.ProductDescription ?? r.Comment ?? '').toString().trim() || null,
      quantity: r.Quantity != null ? Number(r.Quantity) : null,
      netUnitPrice: r.NetUnitPrice != null ? Number(r.NetUnitPrice) : null,
      totalPrice: r.TotalPrice != null ? Number(r.TotalPrice) : null,
      totalNet: r.TotalNet != null ? Number(r.TotalNet) : null,
      listPrice: r.ListPrice != null ? Number(r.ListPrice) : null,
      netCost: r.NetCost != null ? Number(r.NetCost) : null,
    }));

    return NextResponse.json({ ok: true, services });
  } catch (error) {
    console.error('Failed to load priced services', error);
    return NextResponse.json(
      { ok: false, error: 'Unable to fetch priced services' },
      { status: 500 },
    );
  }
}
