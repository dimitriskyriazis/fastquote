import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { z } from "zod";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { handleApiError } from "../../../lib/errorHandler";
import { logger } from "../../../lib/logger";
import { validateRequest, intSchema, stringSchema, booleanSchema } from "../../../lib/validation";
import { requirePermission } from "../../../lib/authz";

const createBrandSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(255, "Name must be at most 255 characters"),
    comment: stringSchema(2000),
    softOneId: intSchema,
    softOneCode: stringSchema(255),
    enabled: booleanSchema,
  })
  .strict();

type BrandUpdateInput = {
  BrandID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedBrandUpdate = {
  brandId: number;
  field: "Name" | "Comment" | "SoftOneID" | "SoftOneCode" | "Enabled";
  value: unknown;
};

class BrandUpdateError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "BrandUpdateError";
    this.status = status;
  }
}

const normalizeBrandId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return Boolean(value);
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const normalizeNullableTextValue = (value: unknown): string | null => {
  const normalized = normalizeTextValue(value);
  return normalized.length > 0 ? normalized : null;
};

const normalizeOptionalIntInput = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  const text = normalizeTextValue(value);
  if (!text) return null;
  if (!/^-?\d+$/.test(text)) {
    throw new BrandUpdateError("SoftOne ID must be a valid integer", 400);
  }
  const parsed = Number.parseInt(text, 10);
  if (!Number.isFinite(parsed)) {
    throw new BrandUpdateError("SoftOne ID must be a valid integer", 400);
  }
  return parsed;
};

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

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

export async function PATCH(req: NextRequest) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: BrandUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: BrandUpdateInput[] }).updates ?? [])
      : [];
    const normalized: NormalizedBrandUpdate[] = updates
      .map((entry) => {
        const brandId = normalizeBrandId(entry?.BrandID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (
          brandId == null ||
          !field ||
          (field !== "Name" &&
            field !== "Comment" &&
            field !== "SoftOneID" &&
            field !== "SoftOneCode" &&
            field !== "Enabled")
        ) {
          return null;
        }
        return { brandId, field, value: entry?.value };
      })
      .filter((entry): entry is NormalizedBrandUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    for (const update of normalized) {
      const request = pool.request();
      request.input("brandId", sql.Int, update.brandId);
      request.input("userId", sql.NVarChar(450), userId ?? null);
      if (update.field === "Enabled") {
        request.input("value", sql.Bit, normalizeBooleanInput(update.value) ? 1 : 0);
        await request.query(`
          UPDATE dbo.Brands
          SET Enabled = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @brandId
        `);
      } else if (update.field === "SoftOneID") {
        request.input("value", sql.Int, normalizeOptionalIntInput(update.value));
        await request.query(`
          UPDATE dbo.Brands
          SET SoftOneID = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @brandId
        `);
      } else if (update.field === "SoftOneCode") {
        request.input("value", sql.NVarChar(255), normalizeNullableTextValue(update.value));
        await request.query(`
          UPDATE dbo.Brands
          SET SoftOneCode = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @brandId
        `);
      } else if (update.field === "Comment") {
        request.input("value", sql.NVarChar(2000), normalizeNullableTextValue(update.value));
        await request.query(`
          UPDATE dbo.Brands
          SET Comment = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @brandId
        `);
      } else {
        const name = normalizeTextValue(update.value);
        if (!name) {
          throw new BrandUpdateError("Brand name is required", 400);
        }
        request.input("value", sql.NVarChar(255), name);
        await request.query(`
          UPDATE dbo.Brands
          SET Name = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @brandId
        `);
      }
    }

    logger.info("Brand updated successfully", {
      requestId,
      endpoint: "/api/brands",
      method: "PATCH",
      userId,
      count: normalized.length,
    });

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    if (err instanceof BrandUpdateError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    return await handleApiError(err, {
      requestId,
      endpoint: "/api/brands",
      method: "PATCH",
      userId,
    });
  }
}
