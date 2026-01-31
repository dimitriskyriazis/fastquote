import { NextRequest, NextResponse } from 'next/server';
import { getPool, sql } from '../../../lib/sql';
import { resolveAuditUserId } from '../../../lib/auditTrail';
import { requirePermission } from '../../../lib/authz';

type CreatePricingPolicyRuleBody = {
  name?: unknown;
  pricingPolicyId?: unknown;
  brandId?: unknown;
  telmacoDiscountPercentage?: unknown;
  customerDiscountPercentage?: unknown;
  responsibleUserId?: unknown;
  comments?: unknown;
};

const normalizeString = (value: unknown, maxLength: number): string | null => {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  const coerced = String(value);
  const trimmed = coerced.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeInt = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
};

const normalizeDecimal = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "managePricingPolicies");
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as CreatePricingPolicyRuleBody | null;
    const name = normalizeString(payload?.name, 512);
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 });
    }
    const pricingPolicyId = normalizeInt(payload?.pricingPolicyId);
    if (pricingPolicyId == null) {
      return NextResponse.json({ ok: false, error: 'Pricing policy is required' }, { status: 400 });
    }
    // Brand is optional. When NULL, the rule applies to all brands (default rule).
    const brandId = normalizeInt(payload?.brandId);
    const telmaco = normalizeDecimal(payload?.telmacoDiscountPercentage);
    if (telmaco == null) {
      return NextResponse.json(
        { ok: false, error: 'Telmaco discount percentage is required' },
        { status: 400 },
      );
    }
    const customer = normalizeDecimal(payload?.customerDiscountPercentage);
    if (customer == null) {
      return NextResponse.json(
        { ok: false, error: 'Customer discount percentage is required' },
        { status: 400 },
      );
    }

    const responsibleUserId = normalizeString(payload?.responsibleUserId, 450);
    const comments = normalizeString(payload?.comments, 2000);

    const pool = await getPool();
    const columnCheck = await pool
      .request()
      .query<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.PricingPolicyRules')
          AND name = 'ModifiedBy';
      `);
    const hasModifiedBy = (columnCheck.recordset?.[0]?.count ?? 0) > 0;

    const request = pool.request();
    request.input('__name', sql.NVarChar(512), name);
    request.input('__pricingPolicyId', sql.Int, pricingPolicyId);
    request.input('__brandId', sql.Int, brandId);
    request.input('__telmaco', sql.TYPES.Numeric(9, 6), telmaco);
    request.input('__customer', sql.TYPES.Numeric(9, 6), customer);
    request.input('__responsibleUserId', sql.NVarChar(450), responsibleUserId ?? null);
    request.input('__comments', sql.NVarChar(2000), comments ?? null);
    const auditUserId = resolveAuditUserId(req);
    request.input('__userId', sql.NVarChar(450), auditUserId ?? null);

    const columns = [
      '[Name]',
      '[PricingPolicyID]',
      '[BrandID]',
      '[TelmacoDiscountPercentage]',
      '[CustomerDiscountPercentage]',
      '[ResponsibleUserID]',
      '[Comments]',
      '[CreatedOn]',
      '[CreatedBy]',
      '[ModifiedOn]',
      hasModifiedBy ? '[ModifiedBy]' : null,
    ].filter(Boolean);
    const values = [
      '@__name',
      '@__pricingPolicyId',
      '@__brandId',
      '@__telmaco',
      '@__customer',
      '@__responsibleUserId',
      '@__comments',
      'SYSUTCDATETIME()',
      '@__userId',
      'SYSUTCDATETIME()',
      hasModifiedBy ? '@__userId' : null,
    ].filter(Boolean);

    const result = await request.query<{
      ID: number;
      Name: string | null;
      BrandID: number | null;
      PricingPolicyID: number | null;
      BrandName: string | null;
      PricingPolicyName: string | null;
    }>(`
      DECLARE @Inserted TABLE (
        ID INT,
        Name NVARCHAR(512),
        BrandID INT,
        PricingPolicyID INT
      );
      INSERT INTO dbo.PricingPolicyRules (${columns.join(', ')})
      OUTPUT INSERTED.ID, INSERTED.Name, INSERTED.BrandID, INSERTED.PricingPolicyID INTO @Inserted
      VALUES (${values.join(', ')});

      SELECT
        i.ID,
        i.Name,
        i.BrandID,
        i.PricingPolicyID,
        b.Name AS BrandName,
        pp.Name AS PricingPolicyName
      FROM @Inserted i
      LEFT JOIN dbo.Brands AS b ON i.BrandID = b.ID
      LEFT JOIN dbo.PricingPolicies AS pp ON i.PricingPolicyID = pp.ID;
    `);

    const inserted = result.recordset?.[0];
    if (!inserted || inserted.ID == null) {
      throw new Error('Unable to create pricing policy rule');
    }

    const option = {
      value: String(inserted.ID),
      label: inserted.Name?.trim() || `Rule ${inserted.ID}`,
      brandId: inserted.BrandID ?? null,
      brandName: inserted.BrandName ?? null,
      pricingPolicyId: inserted.PricingPolicyID ?? null,
      pricingPolicyName: inserted.PricingPolicyName ?? null,
      telmacoDiscountPercentage: telmaco,
      customerDiscountPercentage: customer,
    };

    return NextResponse.json({ ok: true, option });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
