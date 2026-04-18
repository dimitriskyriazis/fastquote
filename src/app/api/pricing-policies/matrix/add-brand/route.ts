import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import { getPool, sql } from "../../../../../lib/sql";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";
import { getRequestId } from "../../../../../lib/requestId";
import { logAddAuditDetails } from "../../../../../lib/mutationAudit";
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
  const requestId = await getRequestId(req);
  const userIdForLog = resolveAuditUserId(req);
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

    const insertRes = await request.query<{ InsertedID: number; BrandName: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, BrandID INT);
      INSERT INTO dbo.PricingPolicyRules (${columns.join(", ")})
      OUTPUT INSERTED.ID, INSERTED.BrandID INTO @Inserted
      VALUES (${values.join(", ")});

      SELECT TOP 1 i.ID AS InsertedID, b.Name AS BrandName
      FROM @Inserted i
      LEFT JOIN dbo.Brands b ON b.ID = i.BrandID;
    `);

    const inserted = insertRes.recordset?.[0];
    const insertedId = inserted?.InsertedID ?? null;
    const brandName = inserted?.BrandName?.trim() || `Brand ${brandId}`;

    if (insertedId != null) {
      logAddAuditDetails({
        endpoint: '/api/pricing-policies/matrix/add-brand',
        method: 'POST',
        requestId,
        userId: userIdForLog,
        targetEntity: 'pricingPolicyRules',
        createdRows: [{ id: insertedId, name: brandName }],
        message: 'Brand added to pricing policy matrix',
        extra: { brandId },
      });
    }

    return NextResponse.json({ ok: true, createdCount: 1 });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
