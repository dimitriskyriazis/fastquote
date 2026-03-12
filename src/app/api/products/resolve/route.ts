import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';
import { clearPartModelNumber } from '../../../../lib/partModelNumber';

const normalizeParam = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeBrandName = (value: string | null): string | null => {
  const normalized = normalizeParam(value);
  if (!normalized) return null;
  // Normalize whitespace (including NBSP) for more stable exact matching.
  return normalized.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
};

const normalizeBrandKey = (value: string | null): string | null => {
  const normalized = normalizeBrandName(value);
  if (!normalized) return null;
  // Brand comparison key: ignore whitespace differences (BlackMagic vs Black Magic).
  return normalized.replace(/\s+/g, '').toLowerCase();
};

const brandKeySql = (expr: string) => (
  // Builds a whitespace-insensitive brand key in SQL.
  // Keep this aligned with normalizeBrandKey above.
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(LTRIM(RTRIM(ISNULL(${expr}, N'')))), NCHAR(160), N''), NCHAR(9), N''), NCHAR(10), N''), NCHAR(13), N''), N' ', N'')`
);

// Normalize part/model numbers by removing special characters (dashes, underscores, spaces, periods, etc.)
const normalizePartModelNumber = (value: string | null): string | null => {
  if (!value) return null;
  return clearPartModelNumber(value);
};

// Helper to get the cleared column name for part/model numbers
// Uses the existing PartNumberCleared and ModelNumberCleared columns for better performance
const partModelNumberSql = (expr: string) => {
  // Replace PartNumber/ModelNumber with their cleared versions
  if (expr.includes('.PartNumber')) {
    return `ISNULL(${expr.replace('.PartNumber', '.PartNumberCleared')}, '')`;
  }
  if (expr.includes('.ModelNumber')) {
    return `ISNULL(${expr.replace('.ModelNumber', '.ModelNumberCleared')}, '')`;
  }
  // Fallback for edge cases
  return `ISNULL(${expr}, '')`;
};

export async function GET(req: NextRequest) {
  logRequest(req, '/api/products/resolve');
  try {
    const url = new URL(req.url);
    const partNumberRaw = normalizeParam(url.searchParams.get('partNumber'));
    const modelNumberRaw = normalizeParam(url.searchParams.get('modelNumber'));
    // Normalize the search values
    const partNumber = partNumberRaw ? normalizePartModelNumber(partNumberRaw) : null;
    const modelNumber = modelNumberRaw ? normalizePartModelNumber(modelNumberRaw) : null;
    const brandName = normalizeBrandName(url.searchParams.get('brand'));
    const brandKey = normalizeBrandKey(brandName);

    if (!partNumber && !modelNumber) {
      return NextResponse.json({ ok: false, error: 'Please provide a part number or model number' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    // Cross-search: use a single search value that checks both PartNumber and ModelNumber
    const searchValue = partNumber || modelNumber;
    if (searchValue) {
      request.input('searchValue', sql.NVarChar(255), searchValue);
    }
    if (brandName) {
      request.input('brandName', sql.NVarChar(255), brandName);
    }
    if (brandKey) {
      request.input('brandKey', sql.NVarChar(255), brandKey);
    }

    // Cross-search: part/model number searches PartNumber, ModelNumber, and LegacyPartNoCleaned
    // Uses cleared columns (PartNumberCleared, ModelNumberCleared, LegacyPartNoCleaned) for index-based performance
    const partModelCondition = searchValue
      ? `(${partModelNumberSql('p.PartNumber')} = @searchValue OR ${partModelNumberSql('p.ModelNumber')} = @searchValue OR ISNULL(p.LegacyPartNoCleaned, '') = @searchValue)`
      : '0=1';
    const whereConditions = [] as string[];
    if (searchValue) whereConditions.push(partModelCondition);

    const runQuery = async (enforceBrandKey: boolean) => {
      const brandFilterSql = enforceBrandKey && brandKey
        ? ` AND ${brandKeySql('b.Name')} = @brandKey`
        : '';
      const whereClause = whereConditions.length
        ? `WHERE (${whereConditions.join(' OR ')})${brandFilterSql}`
        : '';
      const brandOrderSql = brandKey
        ? `
        CASE
          WHEN @brandName IS NOT NULL AND NULLIF(LTRIM(RTRIM(b.Name)), '') = @brandName THEN 0
          WHEN ${brandKeySql('b.Name')} = @brandKey THEN 1
          ELSE 2
        END,`
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
          ${brandOrderSql}
          CASE
            WHEN ${partModelCondition} THEN 0
            ELSE 1
          END,
          p.ID ASC
      `;

      const result = await request.query<{ ProductID: number | null }>(query);
      const row = result.recordset?.[0] ?? null;
      return row?.ProductID ?? null;
    };

    // Primary: use whitespace-insensitive brand key when provided.
    const productId = await runQuery(true);
    if (productId != null) {
      return NextResponse.json({ ok: true, productId, match: brandKey ? 'brandKey' : 'noBrand' });
    }

    // Fallback: if brand was provided but didn't match (typo/variant), try part/model without brand.
    if (brandKey) {
      const fallbackProductId = await runQuery(false);
      if (fallbackProductId != null) {
        return NextResponse.json({ ok: true, productId: fallbackProductId, match: 'fallbackNoBrand' });
      }
    }

    return NextResponse.json({ ok: false, error: 'No matching product found' }, { status: 404 });
  } catch (err) {
    console.error('Failed to resolve product reference', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
