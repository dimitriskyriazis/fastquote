import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import sql from "mssql";
import { z } from "zod";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { handleApiError, createErrorResponse } from "../../../../lib/errorHandler";
import { logger } from "../../../../lib/logger";
import { logAddAuditDetails } from "../../../../lib/mutationAudit";
import { validateRequest, positiveIntSchema, stringSchema, urlSchema, partModelNumberSchema } from "../../../../lib/validation";
import { clearPartModelNumberUpper, isSameProductSpelling } from "../../../../lib/partModelNumber";
import {
  applyBrandPattern,
  hasPatternConfig,
  normalizePatternConfig,
} from "../../../../lib/partNumberPattern";

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
  partNumber: partModelNumberSchema(255).refine((val) => val !== null && val !== undefined, {
    message: "Part number is required",
  }),
  erpCode: partModelNumberSchema(255),
  typeId: positiveIntSchema,
  categoryId: positiveIntSchema,
  subCategoryId: positiveIntSchema,
  description: stringSchema(2000),
  weblink: urlSchema,
  comments: stringSchema(2000),
  enabled: z.boolean().optional().default(true),
  // Set by the client after the user confirms, in the duplicate dialog, that a
  // product sharing this cleaned part number is a genuinely DIFFERENT product
  // (e.g. Belden XDR8419-312W vs XDR8419-312-W). Without it, a collision is
  // refused with 409 and the colliding rows are returned.
  acknowledgeDuplicate: z.boolean().optional().default(false),
}).strict(); // Reject unknown fields

export async function POST(req: NextRequest) {
  logRequest(req, '/api/products/create');
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
    let partNumber = body.partNumber;

    const pool = await getPool();

    if (partNumber) {
      const brandPatternResult = await pool
        .request()
        .input("BrandID", sql.Int, brandId)
        .query<{
          PartNumberSuffix: string | null;
          PartNumberPattern1: string | null;
          PartNumberPattern2: string | null;
        }>(`
          SELECT PartNumberSuffix, PartNumberPattern1, PartNumberPattern2
          FROM dbo.Brands
          WHERE ID = @BrandID
        `);
      const brandRow = brandPatternResult.recordset?.[0];
      const patternConfig = normalizePatternConfig({
        suffix: brandRow?.PartNumberSuffix ?? null,
        patterns: [brandRow?.PartNumberPattern1 ?? null, brandRow?.PartNumberPattern2 ?? null],
      });
      if (hasPatternConfig(patternConfig)) {
        const result = applyBrandPattern(partNumber, patternConfig);
        if (!result.ok) {
          return NextResponse.json(
            { ok: false, error: "Part number does not match the brand format." },
            { status: 400 },
          );
        }
        partNumber = result.value;
      }
    }

    const modelNumberCleared = toClearedPartModel(modelNumber);
    const partNumberCleared = toClearedPartModel(partNumber);

    // Duplicate gate. Enforced HERE rather than in the modal: the warning in
    // AddProductModal is advisory and can be clicked past, which is how the
    // Adder ALIF1102 T / ALIF1102T pair was created by hand. Any client,
    // script included, has to pass acknowledgeDuplicate to create a product
    // whose cleaned part number already exists in the same brand.
    if (partNumberCleared && !body.acknowledgeDuplicate) {
      const dupRequest = pool.request();
      dupRequest.input("BrandID", sql.Int, brandId);
      dupRequest.input("PartNumberCleared", sql.NVarChar(255), partNumberCleared);
      const dupResult = await dupRequest.query<{
        ID: number;
        PartNumber: string | null;
        ModelNumber: string | null;
        Description: string | null;
        Enabled: boolean | null;
      }>(`
        SELECT TOP (10) p.ID, p.PartNumber, p.ModelNumber, p.Description, p.Enabled
        FROM dbo.Products p
        WHERE p.BrandID = @BrandID
          AND p.PartNumberCleared = @PartNumberCleared
          -- Only LIVE products block creation. Disabled rows include the 93
          -- retired merge losers, which still hold their old part numbers; being
          -- unable to create a product because a retired twin exists would be
          -- wrong, and resolve/search ignore them too. Exact raw duplicates are
          -- still caught by the global unique index on PartNumber.
          AND ISNULL(p.Enabled, 1) = 1
        ORDER BY p.ID
      `);
      const collisions = dupResult.recordset ?? [];
      if (collisions.length > 0) {
        logger.info("Product create blocked by cleaned part number collision", {
          requestId,
          endpoint: "/api/products/create",
          method: "POST",
          userId,
          partNumber,
          collisionIds: collisions.map((c) => c.ID),
        });
        return NextResponse.json(
          {
            ok: false,
            error: collisions.length === 1
              ? `This brand already has a product with the same part number once separators are ignored: "${collisions[0].PartNumber ?? ''}". Use that product, or confirm this is a different product.`
              : `This brand already has ${collisions.length} products with the same part number once separators are ignored. Use one of them, or confirm this is a different product.`,
            duplicateCleanedPartNumber: {
              partNumber,
              partNumberCleared,
              // sameSpelling means the existing row differs only in which
              // separator characters were used, so it is almost certainly the
              // same product rather than a new one.
              matches: collisions.map((c) => ({
                id: c.ID,
                partNumber: c.PartNumber,
                modelNumber: c.ModelNumber,
                description: c.Description,
                // always true given the Enabled filter above; kept so the
                // client shape stays stable if the filter is ever relaxed.
                enabled: c.Enabled !== false,
                sameSpelling: isSameProductSpelling(partNumber ?? "", c.PartNumber ?? ""),
              })),
            },
          },
          { status: 409 },
        );
      }
    }
    const erpCode = body.erpCode;
    const description = body.description;
    const weblink = body.weblink;
    const comments = body.comments;
    const typeId = body.typeId;
    const categoryId = body.categoryId;
    const subCategoryId = body.subCategoryId;
    const enabled = body.enabled ?? true;
    const auditUserId = resolveAuditUserId(req);

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

    const result = await request.query<{ ProductID: number; PartNumber: string | null }>(`
      INSERT INTO dbo.Products (
        BrandID,
        ModelNumber,
        PartNumber,
        ModelNumberCleared,
        PartNumberCleared,
        LegacyPartNo,
        LegacyPartNoCleaned,
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
      OUTPUT INSERTED.ID AS ProductID, INSERTED.PartNumber AS PartNumber
      VALUES (
        @BrandID,
        @ModelNumber,
        @PartNumber,
        @ModelNumberCleared,
        @PartNumberCleared,
        NULL,
        NULL,
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
    const insertedPartNumber = result.recordset?.[0]?.PartNumber ?? null;

    logger.info("Product created successfully", {
      requestId,
      endpoint: "/api/products/create",
      method: "POST",
      userId,
      productId,
    });
    logAddAuditDetails({
      endpoint: "/api/products/create",
      method: "POST",
      requestId,
      userId,
      targetEntity: "products",
      createdRows: [
        {
          id: productId,
          name: insertedPartNumber?.trim() || partNumber || null,
        },
      ],
      message: "Product created",
    });

    return NextResponse.json({ ok: true, productId });
  } catch (err) {
    const sqlNumber = (err as { number?: number } | null)?.number;
    if (sqlNumber === 2627 || sqlNumber === 2601) {
      return await createErrorResponse(
        "A product with this part number already exists.",
        409,
        { requestId, endpoint: "/api/products/create", method: "POST", userId },
      );
    }
    return await handleApiError(err, {
      requestId,
      endpoint: "/api/products/create",
      method: "POST",
      userId,
    });
  }
}
