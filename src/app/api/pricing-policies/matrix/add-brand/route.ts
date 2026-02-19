import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import { getPool, sql } from "../../../../../lib/sql";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";
import { requirePermission } from "../../../../../lib/authz";

type AddBrandBody = {
  brandId?: unknown;
  responsibleUserId?: unknown;
};

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
};

const normalizeString = (value: unknown, maxLength: number): string | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  const coerced = String(value);
  const trimmed = coerced.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/pricing-policies/matrix/add-brand');
  try {
    const auth = await requirePermission(req, "managePricingPolicies");
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as AddBrandBody | null;
    const brandId = normalizeInt(payload?.brandId);
    if (brandId == null) {
      return NextResponse.json({ ok: false, error: "Brand is required" }, { status: 400 });
    }

    const responsibleUserId = normalizeString(payload?.responsibleUserId, 450);
    const auditUserId = resolveAuditUserId(req);

    const pool = await getPool();

    // Check if brand exists
    const brandCheck = await pool
      .request()
      .input("__brandId", sql.Int, brandId)
      .query<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM dbo.Brands
        WHERE ID = @__brandId
      `);
    if ((brandCheck.recordset?.[0]?.count ?? 0) === 0) {
      return NextResponse.json({ ok: false, error: "Brand not found" }, { status: 404 });
    }

    // Check if rule with NULL PricingPolicyID already exists for this brand
    const existsCheck = await pool
      .request()
      .input("__brandId", sql.Int, brandId)
      .query<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM dbo.PricingPolicyRules
        WHERE BrandID = @__brandId
          AND PricingPolicyID IS NULL
      `);
    if ((existsCheck.recordset?.[0]?.count ?? 0) > 0) {
      return NextResponse.json(
        { ok: false, error: "Brand already added to pricing policies" },
        { status: 400 },
      );
    }

    // Check for ModifiedBy column
    const columnCheck = await pool
      .request()
      .query<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.PricingPolicyRules')
          AND name = 'ModifiedBy';
      `);
    const hasModifiedBy = (columnCheck.recordset?.[0]?.count ?? 0) > 0;

    const columns = [
      "[Name]",
      "[PricingPolicyID]",
      "[BrandID]",
      "[TelmacoDiscountPercentage]",
      "[CustomerDiscountPercentage]",
      "[ResponsibleUserID]",
      "[CreatedOn]",
      "[CreatedBy]",
      "[ModifiedOn]",
      hasModifiedBy ? "[ModifiedBy]" : null,
    ].filter(Boolean);
    const values = [
      "NULL",
      "NULL",
      "@__brandId",
      "NULL",
      "NULL",
      "@__responsibleUserId",
      "SYSUTCDATETIME()",
      "@__userId",
      "SYSUTCDATETIME()",
      hasModifiedBy ? "@__userId" : null,
    ].filter(Boolean);

    const request = pool.request();
    request.input("__brandId", sql.Int, brandId);
    request.input("__responsibleUserId", sql.NVarChar(450), responsibleUserId ?? null);
    request.input("__userId", sql.NVarChar(450), auditUserId ?? null);

    await request.query(`
      INSERT INTO dbo.PricingPolicyRules (${columns.join(", ")})
      VALUES (${values.join(", ")})
    `);

    return NextResponse.json({ ok: true, createdCount: 1 });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
