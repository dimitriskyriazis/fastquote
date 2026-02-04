import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { z } from "zod";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { handleApiError } from "../../../lib/errorHandler";
import { logger } from "../../../lib/logger";
import { validateRequest, intSchema, stringSchema, booleanSchema } from "../../../lib/validation";

const createBrandSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(255, "Name must be at most 255 characters"),
    comment: stringSchema(2000),
    softOneId: intSchema,
    softOneCode: stringSchema(255),
    enabled: booleanSchema,
  })
  .strict();

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const validation = await validateRequest(req, createBrandSchema, {
      endpoint: "/api/brands",
      method: "POST",
      rejectUnknownFields: true,
    });

    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    const name = body.name.trim();
    const comment = body.comment ?? null;
    const softOneId = body.softOneId ?? null;
    const softOneCode = body.softOneCode ?? null;
    const enabled = body.enabled ?? true;

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input("Name", sql.NVarChar(255), name);
    request.input("Comment", sql.NVarChar(2000), comment);
    request.input("SoftOneID", sql.Int, softOneId);
    request.input("SoftOneCode", sql.NVarChar(255), softOneCode);
    request.input("Enabled", sql.Bit, enabled ? 1 : 0);
    request.input("CreatedBy", sql.NVarChar(450), userId ?? null);
    request.input("ModifiedBy", sql.NVarChar(450), userId ?? null);

    const result = await request.query<{ BrandID: number; BrandName: string | null }>(`
      INSERT INTO dbo.Brands (
        [Name],
        [Comment],
        [SoftOneID],
        [SoftOneCode],
        [Enabled],
        [CreatedOn],
        [CreatedBy],
        [ModifiedOn],
        [ModifiedBy]
      )
      OUTPUT INSERTED.ID AS BrandID, INSERTED.Name AS BrandName
      VALUES (
        @Name,
        @Comment,
        @SoftOneID,
        @SoftOneCode,
        @Enabled,
        SYSUTCDATETIME(),
        @CreatedBy,
        SYSUTCDATETIME(),
        @ModifiedBy
      )
    `);

    const inserted = result.recordset?.[0];
    if (!inserted?.BrandID) {
      throw new Error("Failed to create brand");
    }

    logger.info("Brand created successfully", {
      requestId,
      endpoint: "/api/brands",
      method: "POST",
      userId,
      brandId: inserted.BrandID,
    });

    return NextResponse.json({
      ok: true,
      brand: {
        id: inserted.BrandID,
        name: inserted.BrandName?.trim() || name,
      },
    });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: "/api/brands",
      method: "POST",
      userId,
    });
  }
}
