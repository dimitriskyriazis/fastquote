import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { handleApiError, createErrorResponse } from "../../../../lib/errorHandler";
import { logger } from "../../../../lib/logger";

type CreateProductPayload = {
  brandId?: unknown;
  modelNumber?: unknown;
  partNumber?: unknown;
  erpPartNumber?: unknown;
  typeId?: unknown;
  categoryId?: unknown;
  subCategoryId?: unknown;
  description?: unknown;
  weblink?: unknown;
  comments?: unknown;
  enabled?: unknown;
};

const normalizeString = (value: unknown, maxLength = 2000): string | null => {
  if (typeof value === "string" && value.trim()) {
    const trimmed = value.trim();
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = String(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }
  return null;
};

const normalizeNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeBool = (value: unknown): boolean => {
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return Boolean(value);
};

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  
  try {
    const body = (await req.json().catch(() => null)) as CreateProductPayload | null;
    const brandId = normalizeNumber(body?.brandId ?? null);
    if (brandId == null) {
      return await createErrorResponse("Brand is required", 400, {
        requestId,
        endpoint: "/api/products/create",
        method: "POST",
        userId,
      });
    }

    const modelNumber = normalizeString(body?.modelNumber, 255);
    const partNumber = normalizeString(body?.partNumber, 255);
    const erpPartNumber = normalizeString(body?.erpPartNumber, 255);
    const description = normalizeString(body?.description, 2000);
    const weblink = normalizeString(body?.weblink, 1000);
    const comments = normalizeString(body?.comments, 2000);
    const typeId = normalizeNumber(body?.typeId ?? null);
    const categoryId = normalizeNumber(body?.categoryId ?? null);
    const subCategoryId = normalizeNumber(body?.subCategoryId ?? null);
    const enabled = body?.enabled === undefined ? true : normalizeBool(body.enabled);
    const auditUserId = resolveAuditUserId(req);

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input("BrandID", sql.Int, brandId);
    request.input("ModelNumber", sql.NVarChar(255), modelNumber);
    request.input("PartNumber", sql.NVarChar(255), partNumber);
    request.input("ERPPartNumber", sql.NVarChar(255), erpPartNumber);
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
        ERPPartNumber,
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
        @ERPPartNumber,
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
