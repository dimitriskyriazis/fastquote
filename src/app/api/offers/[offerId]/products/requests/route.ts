import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../../lib/sql';

const normalizeOfferId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const TREE_ORDERING_RAW_EXPRESSION = 'NULLIF(LTRIM(RTRIM(od.TreeOrdering)), \'\')';
const TREE_ORDERING_HIERARCHY_EXPRESSION = `
  CASE
    WHEN ${TREE_ORDERING_RAW_EXPRESSION} IS NULL THEN NULL
    ELSE TRY_CONVERT(hierarchyid, CONCAT('/', REPLACE(${TREE_ORDERING_RAW_EXPRESSION}, '.', '/'), '/'))
  END
`;

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  try {
    const { offerId: offerIdParam } = await params;
    const normalizedOfferId = normalizeOfferId(decodeURIComponent(String(offerIdParam ?? '')).trim());
    if (normalizedOfferId == null) {
      return NextResponse.json({ ok: false, error: 'Invalid offer id', rows: [] }, { status: 400 });
    }

    const categoryIdParam = req.nextUrl.searchParams.get('categoryId') ?? null;
    const normalizedCategoryId = normalizeOfferDetailId(categoryIdParam);

    const pool = await getPool();
    let categoryTreeOrdering: string | null = null;
    if (normalizedCategoryId != null) {
      const lookup = pool.request();
      lookup.input('__offerId', sql.Int, normalizedOfferId);
      lookup.input('__categoryId', sql.Int, normalizedCategoryId);
      const lookupResult = await lookup.query<{ TreeOrdering: string | null }>(`
        SELECT TOP (1)
          NULLIF(LTRIM(RTRIM(od.TreeOrdering)), '') AS TreeOrdering
        FROM dbo.OfferDetails od
        WHERE od.OfferID = @__offerId
          AND od.ID = @__categoryId
      `);
      categoryTreeOrdering = lookupResult.recordset?.[0]?.TreeOrdering ?? null;
    }
    const request = pool.request();
    request.input('__offerId', sql.Int, normalizedOfferId);
    request.input('__categoryId', sql.Int, normalizedCategoryId);
    request.input('__categoryTree', sql.NVarChar(255), categoryTreeOrdering);

    const query = `
      SELECT
        od.ID AS OfferDetailID,
        od.TreeOrdering,
        od.RequestedItemNo,
        od.RequestedBrand,
        od.RequestedModelNo,
        od.RequestedPartNo,
      od.RequestedDescription,
      od.RequestedDescription2,
      od.RequestedDescription3,
      od.RequestedQuantity
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @__offerId
        AND (
          @__categoryId IS NULL
          OR od.ParentOfferDetailID = @__categoryId
          OR (
            @__categoryTree IS NOT NULL
            AND od.TreeOrdering LIKE CONCAT(@__categoryTree, '.%')
          )
        )
        AND (
          NULLIF(LTRIM(RTRIM(od.RequestedItemNo)), '') IS NOT NULL
          OR NULLIF(LTRIM(RTRIM(od.RequestedBrand)), '') IS NOT NULL
          OR NULLIF(LTRIM(RTRIM(od.RequestedModelNo)), '') IS NOT NULL
          OR NULLIF(LTRIM(RTRIM(od.RequestedPartNo)), '') IS NOT NULL
          OR NULLIF(LTRIM(RTRIM(od.RequestedDescription)), '') IS NOT NULL
          OR NULLIF(LTRIM(RTRIM(od.RequestedDescription2)), '') IS NOT NULL
          OR NULLIF(LTRIM(RTRIM(od.RequestedDescription3)), '') IS NOT NULL
          OR od.RequestedQuantity IS NOT NULL
        )
      ORDER BY ${TREE_ORDERING_HIERARCHY_EXPRESSION}, od.TreeOrdering;
    `;

    const result = await request.query<{
      OfferDetailID: number;
      TreeOrdering: string | null;
      RequestedItemNo: string | null;
      RequestedBrand: string | null;
      RequestedModelNo: string | null;
      RequestedPartNo: string | null;
      RequestedDescription: string | null;
      RequestedDescription2: string | null;
      RequestedDescription3: string | null;
      RequestedQuantity: number | null;
    }>(query);

    const rows = (result.recordset ?? []).map((row) => ({
      OfferDetailID: row.OfferDetailID,
      TreeOrdering: row.TreeOrdering,
      RequestedItemNo: row.RequestedItemNo,
      RequestedBrand: row.RequestedBrand,
      RequestedModelNo: row.RequestedModelNo,
      RequestedPartNo: row.RequestedPartNo,
      RequestedDescription: row.RequestedDescription,
      RequestedDescription2: row.RequestedDescription2,
      RequestedDescription3: row.RequestedDescription3,
      RequestedQuantity: row.RequestedQuantity,
    }));

    return NextResponse.json({ ok: true, rows });
  } catch (err) {
    console.error('Failed to load requested rows for category', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message, rows: [] }, { status: 500 });
  }
}
