import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import sql from "mssql";
import { z } from "zod";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { handleApiError } from "../../../../lib/errorHandler";
import { logger } from "../../../../lib/logger";
import { logAddAuditDetails } from "../../../../lib/mutationAudit";
import { validateRequest, intSchema, stringSchema, booleanSchema } from "../../../../lib/validation";
import { requirePermission } from "../../../../lib/authz";

const createSupplierSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(255, "Name must be at most 255 characters"),
    taxId: stringSchema(128),
    address: stringSchema(500),
    city: stringSchema(256),
    countryId: intSchema,
    postalCode: stringSchema(20),
    phone: stringSchema(50),
    webSite: stringSchema(255),
    comments: stringSchema(2000),
    enabled: booleanSchema,
  })
  .strict();

export async function POST(req: NextRequest) {
  logRequest(req, '/api/suppliers/create');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const validation = await validateRequest(req, createSupplierSchema, {
      endpoint: "/api/suppliers/create",
      method: "POST",
      rejectUnknownFields: true,
    });

    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    const name = body.name.trim();
    const taxId = body.taxId ?? null;
    const address = body.address ?? null;
    const city = body.city ?? null;
    const countryId = body.countryId ?? null;
    const postalCode = body.postalCode ?? null;
    const phone = body.phone ?? null;
    const webSite = body.webSite ?? null;
    const comments = body.comments ?? null;
    const enabled = body.enabled ?? true;

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input("Name", sql.NVarChar(255), name);
    request.input("TaxID", sql.NVarChar(128), taxId);
    request.input("Address", sql.NVarChar(500), address);
    request.input("City", sql.NVarChar(256), city);
    request.input("CountryID", sql.Int, countryId);
    request.input("PostalCode", sql.NVarChar(20), postalCode);
    request.input("Phone", sql.NVarChar(50), phone);
    request.input("WebSite", sql.NVarChar(255), webSite);
    request.input("Comments", sql.NVarChar(2000), comments);
    request.input("Enabled", sql.Bit, enabled ? 1 : 0);
    request.input("CreatedBy", sql.NVarChar(450), userId ?? null);
    request.input("ModifiedBy", sql.NVarChar(450), userId ?? null);

    const result = await request.query<{ SupplierID: number; SupplierName: string | null; TaxID: string | null }>(`
      INSERT INTO dbo.Suppliers (
        [Name],
        [TaxID],
        [Address],
        [City],
        [CountryID],
        [PostalCode],
        [Phone],
        [WebSite],
        [Comments],
        [Enabled],
        [CreatedOn],
        [CreatedBy],
        [ModifiedOn],
        [ModifiedBy]
      )
      OUTPUT INSERTED.ID AS SupplierID, INSERTED.Name AS SupplierName, INSERTED.TaxID
      VALUES (
        @Name,
        @TaxID,
        @Address,
        @City,
        @CountryID,
        @PostalCode,
        @Phone,
        @WebSite,
        @Comments,
        @Enabled,
        SYSUTCDATETIME(),
        @CreatedBy,
        SYSUTCDATETIME(),
        @ModifiedBy
      )
    `);

    const inserted = result.recordset?.[0];
    if (!inserted?.SupplierID) {
      throw new Error("Failed to create supplier");
    }

    logger.info("Supplier created successfully", {
      requestId,
      endpoint: "/api/suppliers/create",
      method: "POST",
      userId,
      supplierId: inserted.SupplierID,
    });
    logAddAuditDetails({
      endpoint: "/api/suppliers/create",
      method: "POST",
      requestId,
      userId,
      targetEntity: "suppliers",
      createdRows: [
        {
          id: inserted.SupplierID,
          name: inserted.SupplierName?.trim() || name,
          taxId: inserted.TaxID?.trim() || null,
        },
      ],
      message: "Supplier created",
    });

    return NextResponse.json({
      ok: true,
      supplier: {
        id: inserted.SupplierID,
        name: inserted.SupplierName?.trim() || name,
      },
    });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: "/api/suppliers/create",
      method: "POST",
      userId,
    });
  }
}
