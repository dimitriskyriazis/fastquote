import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { z } from "zod";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { handleApiError } from "../../../lib/errorHandler";
import { logger } from "../../../lib/logger";
import {
  buildFieldChanges,
  indexRowsById,
  logAddAuditDetails,
  logDeleteAuditDetails,
  logEditAuditDetails,
  type FieldUpdate,
} from "../../../lib/mutationAudit";
import { validateRequest, intSchema, stringSchema, booleanSchema } from "../../../lib/validation";
import { requirePermission } from "../../../lib/authz";
import { checkDeletePermission } from "../../../lib/deletePermissions";

const createBrandSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(255, "Name must be at most 255 characters"),
    comment: stringSchema(2000),
    softOneId: intSchema,
    softOneCode: stringSchema(255),
    avc4Name: stringSchema(255),
    enabled: booleanSchema,
  })
  .strict();

type BrandUpdateInput = {
  BrandID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type BrandDeleteBody = {
  BrandIDs?: unknown;
};

type BrandAuditRow = {
  BrandID: number;
  Name: string | null;
  Comment: string | null;
  SoftOneID: number | null;
  SoftOneCode: string | null;
  AVC4Name: string | null;
  Enabled: boolean | number | null;
  PartNumberSuffix: string | null;
  PartNumberPattern1: string | null;
  PartNumberPattern2: string | null;
};

type NormalizedBrandUpdate = {
  brandId: number;
  field:
    | "Name"
    | "Comment"
    | "SoftOneID"
    | "SoftOneCode"
    | "AVC4Name"
    | "Enabled"
    | "PartNumberSuffix"
    | "PartNumberPattern1"
    | "PartNumberPattern2";
  value: unknown;
};

const ADMIN_ONLY_FIELDS = new Set<NormalizedBrandUpdate["field"]>([
  "PartNumberSuffix",
  "PartNumberPattern1",
  "PartNumberPattern2",
]);

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

const normalizeBooleanOutput = (value: unknown): boolean | null => {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return null;
};

const normalizeTextOutput = (value: string | null | undefined): string | null =>
  typeof value === "string" ? value.trim() : null;

const fetchBrandAuditRows = async (ids: number[]) => {
  if (ids.length === 0) return new Map<number, BrandAuditRow>();
  const pool = await getPool();
  const request = pool.request();
  ids.forEach((id, idx) => {
    request.input(`auditId${idx}`, sql.Int, id);
  });
  const result = await request.query<BrandAuditRow>(`
    SELECT
      ID AS BrandID,
      Name,
      Comment,
      SoftOneID,
      SoftOneCode,
      AVC4Name,
      Enabled,
      PartNumberSuffix,
      PartNumberPattern1,
      PartNumberPattern2
    FROM dbo.Brands
    WHERE ID IN (${ids.map((_, idx) => `@auditId${idx}`).join(", ")})
  `);

  const normalizedRows = (result.recordset ?? []).map((row) => ({
    BrandID: row.BrandID,
    Name: normalizeTextOutput(row.Name),
    Comment: normalizeTextOutput(row.Comment),
    SoftOneID: row.SoftOneID ?? null,
    SoftOneCode: normalizeTextOutput(row.SoftOneCode),
    AVC4Name: normalizeTextOutput(row.AVC4Name),
    Enabled: normalizeBooleanOutput(row.Enabled),
    PartNumberSuffix: normalizeTextOutput(row.PartNumberSuffix),
    PartNumberPattern1: normalizeTextOutput(row.PartNumberPattern1),
    PartNumberPattern2: normalizeTextOutput(row.PartNumberPattern2),
  }));
  return indexRowsById(normalizedRows, (row) => row.BrandID);
};

const resolveBrandFieldValue = (
  row: BrandAuditRow | undefined,
  field: NormalizedBrandUpdate["field"],
): unknown => {
  if (!row) return null;
  if (field === "Enabled") return normalizeBooleanOutput(row.Enabled);
  return row[field];
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/brands');
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
    const avc4Name = body.avc4Name ?? null;
    const enabled = body.enabled ?? true;

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input("Name", sql.NVarChar(255), name);
    request.input("Comment", sql.NVarChar(2000), comment);
    request.input("SoftOneID", sql.Int, softOneId);
    request.input("SoftOneCode", sql.NVarChar(255), softOneCode);
    request.input("AVC4Name", sql.NVarChar(255), avc4Name);
    request.input("Enabled", sql.Bit, enabled ? 1 : 0);
    request.input("CreatedBy", sql.NVarChar(450), userId ?? null);
    request.input("ModifiedBy", sql.NVarChar(450), userId ?? null);

    const result = await request.query<{ BrandID: number; BrandName: string | null }>(`
      INSERT INTO dbo.Brands (
        [Name],
        [Comment],
        [SoftOneID],
        [SoftOneCode],
        [AVC4Name],
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
        @AVC4Name,
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
    logAddAuditDetails({
      endpoint: "/api/brands",
      method: "POST",
      requestId,
      userId,
      targetEntity: "brands",
      createdRows: [
        {
          id: inserted.BrandID,
          name: inserted.BrandName?.trim() || name,
        },
      ],
      message: "Brand created",
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
  logRequest(req, '/api/brands');
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
            field !== "AVC4Name" &&
            field !== "Enabled" &&
            field !== "PartNumberSuffix" &&
            field !== "PartNumberPattern1" &&
            field !== "PartNumberPattern2")
        ) {
          return null;
        }
        return { brandId, field, value: entry?.value };
      })
      .filter((entry): entry is NormalizedBrandUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const hasAdminOnlyFields = normalized.some((entry) => ADMIN_ONLY_FIELDS.has(entry.field));
    if (hasAdminOnlyFields) {
      const isAdminOrDev =
        auth.roles.includes("Administrator") || auth.roles.includes("Developer");
      if (!isAdminOrDev) {
        return NextResponse.json(
          { ok: false, error: "Only administrators and developers can edit Part Number columns" },
          { status: 403 },
        );
      }
    }

    const targetBrandIds = Array.from(new Set(normalized.map((entry) => entry.brandId)));
    const beforeById = await fetchBrandAuditRows(targetBrandIds);
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
      } else if (update.field === "AVC4Name") {
        request.input("value", sql.NVarChar(255), normalizeNullableTextValue(update.value));
        await request.query(`
          UPDATE dbo.Brands
          SET AVC4Name = @value,
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
      } else if (update.field === "PartNumberSuffix") {
        request.input("value", sql.NVarChar(20), normalizeNullableTextValue(update.value));
        await request.query(`
          UPDATE dbo.Brands
          SET PartNumberSuffix = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @brandId
        `);
      } else if (update.field === "PartNumberPattern1") {
        request.input("value", sql.NVarChar(50), normalizeNullableTextValue(update.value));
        await request.query(`
          UPDATE dbo.Brands
          SET PartNumberPattern1 = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @brandId
        `);
      } else if (update.field === "PartNumberPattern2") {
        request.input("value", sql.NVarChar(50), normalizeNullableTextValue(update.value));
        await request.query(`
          UPDATE dbo.Brands
          SET PartNumberPattern2 = @value,
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

    const afterById = await fetchBrandAuditRows(targetBrandIds);
    const changes = buildFieldChanges({
      updates: normalized.map(
        (entry) =>
          ({
            targetId: entry.brandId,
            field: entry.field,
          }) satisfies FieldUpdate<NormalizedBrandUpdate["field"], number>,
      ),
      beforeById,
      afterById,
      getFieldValue: resolveBrandFieldValue,
      getTargetName: (before, after) => after?.Name ?? before?.Name ?? null,
    });
    if (changes.length > 0) {
      logEditAuditDetails({
        endpoint: "/api/brands",
        method: "PATCH",
        requestId,
        userId,
        targetEntity: "brands",
        targetIds: targetBrandIds,
        changes,
        message: "Brand fields updated",
      });
    }

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

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/brands');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as BrandDeleteBody | null;
    const rawIds = Array.isArray(body?.BrandIDs) ? body.BrandIDs : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((entry) => normalizeBrandId(entry))
          .filter((value): value is number => value != null),
      ),
    );

    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No brands provided" }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, ids.length, "generic", null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const request = pool.request();
    ids.forEach((value, idx) => {
      request.input(`id${idx}`, sql.Int, value);
    });
    const deleteResult = await request.query<{
      BrandID: number;
      Name: string | null;
      Comment: string | null;
      SoftOneID: number | null;
      SoftOneCode: string | null;
      AVC4Name: string | null;
      Enabled: boolean | number | null;
    }>(`
      DELETE FROM dbo.Brands
      OUTPUT
        DELETED.ID AS BrandID,
        DELETED.Name,
        DELETED.Comment,
        DELETED.SoftOneID,
        DELETED.SoftOneCode,
        DELETED.AVC4Name,
        DELETED.Enabled
      WHERE ID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})
    `);

    const rawDeletedRows = deleteResult.recordset ?? [];
    const deletedRows = rawDeletedRows.map((row) => ({
      id: row.BrandID,
      name: normalizeTextOutput(row.Name),
    }));
    logDeleteAuditDetails({
      endpoint: "/api/brands",
      requestId,
      userId,
      targetEntity: "brands",
      requestedIds: ids,
      deletedRows,
      message: "Brands deleted",
    });

    return NextResponse.json({
      ok: true,
      deleted: deletedRows.length,
      deletedRows: rawDeletedRows.map((row) => ({
        Name: row.Name,
        Comment: row.Comment,
        SoftOneID: row.SoftOneID,
        SoftOneCode: row.SoftOneCode,
        AVC4Name: row.AVC4Name,
        Enabled: row.Enabled,
      })),
    });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: "/api/brands",
      method: "DELETE",
      userId,
    });
  }
}
