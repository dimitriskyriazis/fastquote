import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';

const normalizeParam = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const partNumber = normalizeParam(url.searchParams.get('partNumber'));
    const modelNumber = normalizeParam(url.searchParams.get('modelNumber'));
    const brand = normalizeParam(url.searchParams.get('brand'));

    if (!partNumber && !modelNumber) {
      return NextResponse.json({ ok: false, error: 'Please provide a part number or model number' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    if (partNumber) {
      request.input('partNumber', sql.NVarChar(255), partNumber);
    }
    if (modelNumber) {
      request.input('modelNumber', sql.NVarChar(255), modelNumber);
    }
    if (brand) {
      request.input('brandName', sql.NVarChar(255), brand);
    }

    const partCondition = partNumber
      ? "NULLIF(LTRIM(RTRIM(p.PartNumber)), '') = @partNumber"
      : '0=1';
    const modelCondition = modelNumber
      ? "NULLIF(LTRIM(RTRIM(p.ModelNumber)), '') = @modelNumber"
      : '0=1';
    const whereConditions = [] as string[];
    if (partNumber) whereConditions.push(partCondition);
    if (modelNumber) whereConditions.push(modelCondition);
    const whereClause = whereConditions.length
      ? `WHERE (${whereConditions.join(' OR ')})${brand ? " AND NULLIF(LTRIM(RTRIM(b.Name)), '') = @brandName" : ''}`
      : '';

    const query = `
      SELECT TOP (1)
        p.ID AS ProductID,
        NULLIF(LTRIM(RTRIM(p.PartNumber)), '') AS PartNumber,
        NULLIF(LTRIM(RTRIM(p.ModelNumber)), '') AS ModelNumber,
        NULLIF(LTRIM(RTRIM(b.Name)), '') AS BrandName
      FROM dbo.Products p
      LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
      ${whereClause}
      ORDER BY
        CASE
          WHEN ${partCondition} THEN 0
          WHEN ${modelCondition} THEN 1
          ELSE 2
        END,
        p.ID ASC
    `;

    const result = await request.query<{ ProductID: number | null }>(query);
    const row = result.recordset?.[0] ?? null;
    if (!row || row.ProductID == null) {
      return NextResponse.json({ ok: false, error: 'No matching product found' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, productId: row.ProductID });
  } catch (err) {
    console.error('Failed to resolve product reference', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
