import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { z } from "zod";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { handleApiError } from "../../../../lib/errorHandler";
import { logger } from "../../../../lib/logger";
import { validateRequest, positiveIntSchema, stringSchema, urlSchema, partModelNumberSchema } from "../../../../lib/validation";
import { clearPartModelNumberUpper } from "../../../../lib/partModelNumber";

const toClearedPartModel = (value: string | null | undefined) => {
  if (!value) return null;
  return clearPartModelNumberUpper(value);
};

// Strict schema-based validation with rejection of unknown fields
const createProductSchema = z.object({
  brandId: positiveIntSchema.refine((val) => val !== null && val !== undefined, {
    message: "Brand is required",
  }),
  modelNumber: partModelNumberSchema(255),
  partNumber: partModelNumberSchema(255),
  erpCode: partModelNumberSchema(255),
  typeId: positiveIntSchema,
  categoryId: positiveIntSchema,
  subCategoryId: positiveIntSchema,
  description: stringSchema(2000),
  weblink: urlSchema,
  comments: stringSchema(2000),
  enabled: z.boolean().optional().default(true),
}).strict(); // Reject unknown fields

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  
  try {
    // Validate request body with strict schema
    const validation = await validateRequest(req, createProductSchema, {
      endpoint: "/api/products/create",
      method: "POST",
      rejectUnknownFields: true,
    });

    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    const brandId = body.brandId!; // Validated as required
    const modelNumber = body.modelNumber;
    const partNumber = body.partNumber;
    const modelNumberCleared = toClearedPartModel(modelNumber);
    const partNumberCleared = toClearedPartModel(partNumber);
    const erpCode = body.erpCode;
    const description = body.description;
    const weblink = body.weblink;
    const comments = body.comments;
    const typeId = body.typeId;
    const categoryId = body.categoryId;
    const subCategoryId = body.subCategoryId;
    const enabled = body.enabled ?? true;
    const auditUserId = resolveAuditUserId(req);

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input("BrandID", sql.Int, brandId);
    request.input("ModelNumber", sql.NVarChar(255), modelNumber);
    request.input("PartNumber", sql.NVarChar(255), partNumber);
    request.input("ModelNumberCleared", sql.NVarChar(255), modelNumberCleared);
    request.input("PartNumberCleared", sql.NVarChar(255), partNumberCleared);
    request.input("ERPCode", sql.NVarChar(255), erpCode);
    request.input("Description", sql.NVarChar(2000), description);
    request.input("WebLink", sql.NVarChar(1000), weblink);
    request.input("Comments", sql.NVarChar(2000), comments);
    request.input("TypeID", sql.Int, typeId);
    request.input("CategoryID", sql.Int, categoryId);
    request.input("SubCategoryID", sql.Int, subCategoryId);
    request.input("Enabled", sql.Bit, enabled ? 1 : 0);
    request.input("CreatedBy", sql.NVarChar(450), auditUserId);
    request.input("ModifiedBy", sql.NVarChar(450), auditUserId);

    const result = await request.query<{ ProductID: number }>(`
      INSERT INTO dbo.Products (
        BrandID,
        ModelNumber,
        PartNumber,
        ModelNumberCleared,
        PartNumberCleared,
        ERPCode,
        Description,
        WebLink,
        Comments,
        TypeID,
        CategoryID,
        SubCategoryID,
        Enabled,
        CreatedOn,
        CreatedBy,
        ModifiedOn,
        ModifiedBy
      )
      OUTPUT INSERTED.ID AS ProductID
      VALUES (
        @BrandID,
        @ModelNumber,
        @PartNumber,
        @ModelNumberCleared,
        @PartNumberCleared,
        @ERPCode,
        @Description,
        @WebLink,
        @Comments,
        @TypeID,
        @CategoryID,
        @SubCategoryID,
        @Enabled,
        SYSUTCDATETIME(),
        @CreatedBy,
        SYSUTCDATETIME(),
        @ModifiedBy
      )
    `);

    const productId = result.recordset?.[0]?.ProductID ?? null;
    if (!productId) {
      throw new Error("Failed to create product");
    }

    logger.info("Product created successfully", {
      requestId,
      endpoint: "/api/products/create",
      method: "POST",
      userId,
      productId,
    });

    return NextResponse.json({ ok: true, productId });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: "/api/products/create",
      method: "POST",
      userId,
    });
  }
}
