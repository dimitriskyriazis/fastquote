import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import type { Request as SqlRequest } from "mssql";
import { getPool, sql } from "../../../../lib/sql";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam } from "../../../../lib/gridFilters";
import { KnownFilterModel } from "../../../../lib/filterTypes";
import { processFilter } from "../../../../lib/filterProcessing";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { logDeleteAuditDetails, logEditAuditDetails } from "../../../../lib/mutationAudit";
import { requirePermission } from "../../../../lib/authz";
import { checkDeletePermission } from "../../../../lib/deletePermissions";




type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
};

type MatrixRequestBody = {
  request?: GridRequest | null;
};

type MatrixUpdateBody = {
  brandId?: unknown;
  pricingPolicyId?: unknown;
  field?: unknown;
  value?: unknown;
};

type MatrixDeleteBody = {
  brandId?: unknown;
};

type BrandRow = {
  __totalCount: number | bigint | null;
  BrandID: number | null;
  BrandName: string | null;
};

type RuleAggRow = {
  BrandID: number | null;
  PricingPolicyID: number | null;
  MinTelmaco: number | null;
  MinCustomer: number | null;
  MinTelmacoWarranty: number | null;
  MinCustomerWarranty: number | null;
};

type GrandAggRow = {
  PricingPolicyID: number | null;
  MinTelmaco: number | null;
  MinCustomer: number | null;
  MinTelmacoWarranty: number | null;
  MinCustomerWarranty: number | null;
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  BrandName: "dbo.Brands.Name",
  Name: "dbo.Brands.Name",
  BrandID: "dbo.Brands.ID",
};

const QUICK_FILTER_COLUMNS = [
  { colId: "Name", expression: "dbo.Brands.Name" },
  { colId: "BrandID", expression: "dbo.Brands.ID" },
];

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

async function readGridRequest(req: NextRequest): Promise<GridRequest> {
  try {
    const payload = (await req.json().catch(() => null)) as MatrixRequestBody | null;
    const inner = payload?.request;
    if (inner && typeof inner === "object") return inner;
  } catch {
    /* noop */
  }
  return { startRow: 0, endRow: 100 };
}

const buildWhereAndParams = (filterModel: GridRequest["filterModel"]) => {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;

    // Use centralized filter processor
    const result = processFilter(fm, {
      columnExpression,
      columnId: col,
      paramBase: pBase,
    });

    if (result.clause) {
      parts.push(result.clause);
      params.push(...result.params);
    }
  });

  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return { where, params };
};

const normalizeNumeric = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

type UpdateField = "telmaco" | "customer" | "telmacoWarranty" | "customerWarranty";

const normalizeUpdateField = (value: unknown): UpdateField | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "telmaco") return "telmaco";
  if (trimmed === "customer") return "customer";
  if (trimmed === "telmacowarranty") return "telmacoWarranty";
  if (trimmed === "customerwarranty") return "customerWarranty";
  return null;
};

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/pricing-policies/matrix');
  const requestId = await getRequestId(req);
  const userIdForLog = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "managePricingPolicies");
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as MatrixUpdateBody | null;
    const brandId = normalizeInt(payload?.brandId);
    if (brandId == null) {
      return NextResponse.json({ ok: false, error: "Brand is required" }, { status: 400 });
    }
    const pricingPolicyId = normalizeInt(payload?.pricingPolicyId);
    if (pricingPolicyId == null) {
      return NextResponse.json({ ok: false, error: "Pricing policy is required" }, { status: 400 });
    }
    const field = normalizeUpdateField(payload?.field);
    if (!field) {
      return NextResponse.json({ ok: false, error: "Field is required" }, { status: 400 });
    }
    const isWarrantyField = field === "telmacoWarranty" || field === "customerWarranty";
    const value = isWarrantyField ? normalizeInt(payload?.value) : normalizeNumeric(payload?.value);
    if (value == null) {
      return NextResponse.json({ ok: false, error: "Value is required" }, { status: 400 });
    }

    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);

    // Get brand and pricing policy names
    const namesReq = pool.request();
    namesReq.input("__brandId", sql.Int, brandId);
    namesReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
    const namesRes = await namesReq.query<{
      BrandName: string | null;
      PricingPolicyName: string | null;
    }>(`
      SELECT
        b.Name AS BrandName,
        pp.Name AS PricingPolicyName
      FROM dbo.Brands b
      CROSS JOIN dbo.PricingPolicies pp
      WHERE b.ID = @__brandId
        AND pp.ID = @__pricingPolicyId
    `);
    const namesRow = namesRes.recordset?.[0];
    if (!namesRow) {
      return NextResponse.json({ ok: false, error: "Brand or pricing policy not found" }, { status: 404 });
    }

    const brandName = namesRow.BrandName?.trim() || `Brand ${brandId}`;
    const pricingPolicyName = namesRow.PricingPolicyName?.trim() || `Policy ${pricingPolicyId}`;
    const ruleName = `${brandName} - ${pricingPolicyName}`;

    // Check for existing rule with NULL PricingPolicyID (created via Add Brand)
    const nullPolicyCheck = pool.request();
    nullPolicyCheck.input("__brandId", sql.Int, brandId);
    const nullPolicyRes = await nullPolicyCheck.query<{ count: number | bigint | null }>(`
      SELECT COUNT_BIG(1) AS count
      FROM dbo.PricingPolicyRules
      WHERE BrandID = @__brandId
        AND PricingPolicyID IS NULL
    `);
    const hasNullPolicyRule = Number(nullPolicyRes.recordset?.[0]?.count ?? 0) > 0;

    // Check for any existing rules for this brand/policy combination
    const existsReq = pool.request();
    existsReq.input("__brandId", sql.Int, brandId);
    existsReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
    const existsRes = await existsReq.query<{ count: number | bigint | null }>(`
      SELECT COUNT_BIG(1) AS count
      FROM dbo.PricingPolicyRules
      WHERE BrandID = @__brandId
        AND PricingPolicyID = @__pricingPolicyId
    `);
    const hasAnyRule = Number(existsRes.recordset?.[0]?.count ?? 0) > 0;

    const columnCheck = await pool
      .request()
      .query<{ count: number }>(`
        SELECT COUNT(*) AS count
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.PricingPolicyRules')
          AND name = 'ModifiedBy';
      `);
    const hasModifiedBy = (columnCheck.recordset?.[0]?.count ?? 0) > 0;

    const modifiedByClause = hasModifiedBy ? ", ModifiedBy = @__userId" : "";

    if (isWarrantyField) {
      // Warranty years are INT columns — simpler direct-update logic (no MIN-based spreading)
      const warrantyColumn = field === "telmacoWarranty" ? "TelmacoWarrantyYears" : "CustomerWarrantyYears";

      if (hasNullPolicyRule) {
        // Migrate the null-policy rule to this policy and set the warranty value
        const updateReq = pool.request();
        updateReq.input("__brandId", sql.Int, brandId);
        updateReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
        updateReq.input("__name", sql.NVarChar(512), ruleName);
        updateReq.input("__value", sql.Int, value);
        updateReq.input("__userId", sql.NVarChar(450), auditUserId ?? null);

        const updateSql = `
          UPDATE dbo.PricingPolicyRules
          SET Name = @__name,
              PricingPolicyID = @__pricingPolicyId,
              [${warrantyColumn}] = @__value,
              ModifiedOn = SYSUTCDATETIME()
              ${modifiedByClause}
          WHERE BrandID = @__brandId
            AND PricingPolicyID IS NULL;

          SELECT @@ROWCOUNT AS UpdatedCount;
        `;

        const updateRes = await updateReq.query<{ UpdatedCount: number | null }>(updateSql);
        const updatedCount = updateRes.recordset?.[0]?.UpdatedCount ?? 0;
        logEditAuditDetails({
          endpoint: '/api/pricing-policies/matrix',
          method: 'PATCH',
          requestId,
          userId: userIdForLog,
          targetEntity: 'pricingPolicyRules',
          targetIds: [brandId],
          changes: [{ targetId: brandId, targetName: ruleName, field, before: null, after: value }],
          message: 'Pricing policy matrix cell updated',
          extra: { brandId, pricingPolicyId, pricingPolicyName },
        });
        return NextResponse.json({ ok: true, updatedCount });
      } else if (!hasAnyRule) {
        // Create new rule with warranty value
        const columns = [
          "[Name]",
          "[PricingPolicyID]",
          "[BrandID]",
          `[${warrantyColumn}]`,
          "[CreatedOn]",
          "[CreatedBy]",
          "[ModifiedOn]",
          hasModifiedBy ? "[ModifiedBy]" : null,
        ].filter(Boolean);
        const values = [
          "@__name",
          "@__pricingPolicyId",
          "@__brandId",
          "@__value",
          "SYSUTCDATETIME()",
          "@__userId",
          "SYSUTCDATETIME()",
          hasModifiedBy ? "@__userId" : null,
        ].filter(Boolean);

        const insertReq = pool.request();
        insertReq.input("__name", sql.NVarChar(512), ruleName);
        insertReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
        insertReq.input("__brandId", sql.Int, brandId);
        insertReq.input("__value", sql.Int, value);
        insertReq.input("__userId", sql.NVarChar(450), auditUserId ?? null);

        await insertReq.query(`
          INSERT INTO dbo.PricingPolicyRules (${columns.join(", ")})
          VALUES (${values.join(", ")})
        `);

        logEditAuditDetails({
          endpoint: '/api/pricing-policies/matrix',
          method: 'PATCH',
          requestId,
          userId: userIdForLog,
          targetEntity: 'pricingPolicyRules',
          targetIds: [brandId],
          changes: [{ targetId: brandId, targetName: ruleName, field, before: null, after: value }],
          message: 'Pricing policy matrix rule created',
          extra: { brandId, pricingPolicyId, pricingPolicyName },
        });
        return NextResponse.json({ ok: true, updatedCount: 1 });
      } else {
        // Direct update of warranty years on existing rule(s)
        const updateReq = pool.request();
        updateReq.input("__brandId", sql.Int, brandId);
        updateReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
        updateReq.input("__value", sql.Int, value);
        updateReq.input("__userId", sql.NVarChar(450), auditUserId ?? null);

        const updateSql = `
          UPDATE dbo.PricingPolicyRules
          SET [${warrantyColumn}] = @__value,
              ModifiedOn = SYSUTCDATETIME()
              ${modifiedByClause}
          WHERE BrandID = @__brandId
            AND PricingPolicyID = @__pricingPolicyId;

          SELECT @@ROWCOUNT AS UpdatedCount;
        `;

        const updateRes = await updateReq.query<{ UpdatedCount: number | null }>(updateSql);
        const updatedCount = updateRes.recordset?.[0]?.UpdatedCount ?? 0;
        logEditAuditDetails({
          endpoint: '/api/pricing-policies/matrix',
          method: 'PATCH',
          requestId,
          userId: userIdForLog,
          targetEntity: 'pricingPolicyRules',
          targetIds: [brandId],
          changes: [{ targetId: brandId, targetName: ruleName, field, before: null, after: value }],
          message: 'Pricing policy matrix cell updated',
          extra: { brandId, pricingPolicyId, pricingPolicyName },
        });
        return NextResponse.json({ ok: true, updatedCount });
      }
    }

    // Discount percentage fields
    const discountColumn =
      field === "telmaco" ? "TelmacoDiscountPercentage" : "CustomerDiscountPercentage";

    if (hasNullPolicyRule) {
      // Get current discount values from the NULL PricingPolicyID rule
      const currentDiscountsReq = pool.request();
      currentDiscountsReq.input("__brandId", sql.Int, brandId);
      const currentDiscountsRes = await currentDiscountsReq.query<{
        TelmacoDiscount: number | null;
        CustomerDiscount: number | null;
      }>(`
        SELECT
          TelmacoDiscountPercentage AS TelmacoDiscount,
          CustomerDiscountPercentage AS CustomerDiscount
        FROM dbo.PricingPolicyRules
        WHERE BrandID = @__brandId
          AND PricingPolicyID IS NULL
      `);
      const currentDiscounts = currentDiscountsRes.recordset?.[0];
      const currentTelmaco = currentDiscounts?.TelmacoDiscount ?? null;
      const currentCustomer = currentDiscounts?.CustomerDiscount ?? null;
      const newTelmaco = field === "telmaco" ? value : currentTelmaco;
      const newCustomer = field === "customer" ? value : currentCustomer;

      const updateReq = pool.request();
      updateReq.input("__brandId", sql.Int, brandId);
      updateReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
      updateReq.input("__name", sql.NVarChar(512), ruleName);
      if (newTelmaco != null) {
        updateReq.input("__telmaco", sql.TYPES.Numeric(9, 6), newTelmaco);
      }
      if (newCustomer != null) {
        updateReq.input("__customer", sql.TYPES.Numeric(9, 6), newCustomer);
      }
      updateReq.input("__userId", sql.NVarChar(450), auditUserId ?? null);

      const telmacoClause = newTelmaco != null ? "@__telmaco" : "NULL";
      const customerClause = newCustomer != null ? "@__customer" : "NULL";

      const updateSql = `
        UPDATE dbo.PricingPolicyRules
        SET Name = @__name,
            PricingPolicyID = @__pricingPolicyId,
            TelmacoDiscountPercentage = ${telmacoClause},
            CustomerDiscountPercentage = ${customerClause},
            ModifiedOn = SYSUTCDATETIME()
            ${modifiedByClause}
        WHERE BrandID = @__brandId
          AND PricingPolicyID IS NULL;

        SELECT @@ROWCOUNT AS UpdatedCount;
      `;

      const updateRes = await updateReq.query<{ UpdatedCount: number | null }>(updateSql);
      const updatedCount = updateRes.recordset?.[0]?.UpdatedCount ?? 0;
      logEditAuditDetails({
        endpoint: '/api/pricing-policies/matrix',
        method: 'PATCH',
        requestId,
        userId: userIdForLog,
        targetEntity: 'pricingPolicyRules',
        targetIds: [brandId],
        changes: [{ targetId: brandId, targetName: ruleName, field, before: null, after: value }],
        message: 'Pricing policy matrix cell updated',
        extra: { brandId, pricingPolicyId, pricingPolicyName },
      });
      return NextResponse.json({ ok: true, updatedCount });
    } else if (!hasAnyRule) {
      // Create new rule with name, PricingPolicyID, and discounts
      const newTelmaco = field === "telmaco" ? value : null;
      const newCustomer = field === "customer" ? value : null;

      const columns = [
        "[Name]",
        "[PricingPolicyID]",
        "[BrandID]",
        "[TelmacoDiscountPercentage]",
        "[CustomerDiscountPercentage]",
        "[CreatedOn]",
        "[CreatedBy]",
        "[ModifiedOn]",
        hasModifiedBy ? "[ModifiedBy]" : null,
      ].filter(Boolean);
      const values = [
        "@__name",
        "@__pricingPolicyId",
        "@__brandId",
        newTelmaco != null ? "@__telmaco" : "NULL",
        newCustomer != null ? "@__customer" : "NULL",
        "SYSUTCDATETIME()",
        "@__userId",
        "SYSUTCDATETIME()",
        hasModifiedBy ? "@__userId" : null,
      ].filter(Boolean);

      const insertReq = pool.request();
      insertReq.input("__name", sql.NVarChar(512), ruleName);
      insertReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
      insertReq.input("__brandId", sql.Int, brandId);
      if (newTelmaco != null) {
        insertReq.input("__telmaco", sql.TYPES.Numeric(9, 6), newTelmaco);
      }
      if (newCustomer != null) {
        insertReq.input("__customer", sql.TYPES.Numeric(9, 6), newCustomer);
      }
      insertReq.input("__userId", sql.NVarChar(450), auditUserId ?? null);

      await insertReq.query(`
        INSERT INTO dbo.PricingPolicyRules (${columns.join(", ")})
        VALUES (${values.join(", ")})
      `);

      logEditAuditDetails({
        endpoint: '/api/pricing-policies/matrix',
        method: 'PATCH',
        requestId,
        userId: userIdForLog,
        targetEntity: 'pricingPolicyRules',
        targetIds: [brandId],
        changes: [{ targetId: brandId, targetName: ruleName, field, before: null, after: value }],
        message: 'Pricing policy matrix rule created',
        extra: { brandId, pricingPolicyId, pricingPolicyName },
      });
      return NextResponse.json({ ok: true, updatedCount: 1 });
    } else {
      // Update existing rule (with PricingPolicyID) - check if discount is NULL
      const currentDiscountReq = pool.request();
      currentDiscountReq.input("__brandId", sql.Int, brandId);
      currentDiscountReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
      const currentDiscountRes = await currentDiscountReq.query<{
        CurrentDiscount: number | null;
      }>(`
        SELECT [${discountColumn}] AS CurrentDiscount
        FROM dbo.PricingPolicyRules
        WHERE BrandID = @__brandId
          AND PricingPolicyID = @__pricingPolicyId
      `);
      const currentDiscount = currentDiscountRes.recordset?.[0]?.CurrentDiscount ?? null;

      if (currentDiscount == null) {
        // If current discount is NULL, just update it directly
        const updateReq = pool.request();
        updateReq.input("__brandId", sql.Int, brandId);
        updateReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
        updateReq.input("__value", sql.TYPES.Numeric(9, 6), value);
        updateReq.input("__userId", sql.NVarChar(450), auditUserId ?? null);

        const updateSql = `
          UPDATE dbo.PricingPolicyRules
          SET [${discountColumn}] = @__value,
              ModifiedOn = SYSUTCDATETIME()
              ${modifiedByClause}
          WHERE BrandID = @__brandId
            AND PricingPolicyID = @__pricingPolicyId;

          SELECT @@ROWCOUNT AS UpdatedCount;
        `;

        const updateRes = await updateReq.query<{ UpdatedCount: number | null }>(updateSql);
        const updatedCount = updateRes.recordset?.[0]?.UpdatedCount ?? 0;
        logEditAuditDetails({
          endpoint: '/api/pricing-policies/matrix',
          method: 'PATCH',
          requestId,
          userId: userIdForLog,
          targetEntity: 'pricingPolicyRules',
          targetIds: [brandId],
          changes: [{ targetId: brandId, targetName: ruleName, field, before: null, after: value }],
          message: 'Pricing policy matrix cell updated',
          extra: { brandId, pricingPolicyId, pricingPolicyName },
        });
        return NextResponse.json({ ok: true, updatedCount });
      } else {
        // Use the existing logic for non-NULL discounts
        const updateSql = `
          DECLARE @CurrentMin NUMERIC(18, 6);
          SELECT @CurrentMin = MIN(ppr.[${discountColumn}])
          FROM dbo.PricingPolicyRules ppr
          WHERE ppr.BrandID = @__brandId
            AND ppr.PricingPolicyID = @__pricingPolicyId;

          IF @CurrentMin IS NULL
          BEGIN
            THROW 50000, 'Unable to resolve current minimum discount for this brand/policy.', 1;
          END

          UPDATE dbo.PricingPolicyRules
          SET [${discountColumn}] = @__value,
              ModifiedOn = SYSUTCDATETIME()
              ${modifiedByClause}
          WHERE BrandID = @__brandId
            AND PricingPolicyID = @__pricingPolicyId
            AND ([${discountColumn}] < @__value OR [${discountColumn}] = @CurrentMin);

          SELECT @@ROWCOUNT AS UpdatedCount;
        `;

        const updateReq = pool.request();
        updateReq.input("__brandId", sql.Int, brandId);
        updateReq.input("__pricingPolicyId", sql.Int, pricingPolicyId);
        updateReq.input("__value", sql.TYPES.Numeric(9, 6), value);
        updateReq.input("__userId", sql.NVarChar(450), auditUserId ?? null);

        const updateRes = await updateReq.query<{ UpdatedCount: number | null }>(updateSql);
        const updatedCount = updateRes.recordset?.[0]?.UpdatedCount ?? 0;
        logEditAuditDetails({
          endpoint: '/api/pricing-policies/matrix',
          method: 'PATCH',
          requestId,
          userId: userIdForLog,
          targetEntity: 'pricingPolicyRules',
          targetIds: [brandId],
          changes: [{ targetId: brandId, targetName: ruleName, field, before: null, after: value }],
          message: 'Pricing policy matrix cell updated',
          extra: { brandId, pricingPolicyId, pricingPolicyName },
        });
        return NextResponse.json({ ok: true, updatedCount });
      }
    }
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/pricing-policies/matrix');
  const requestId = await getRequestId(req);
  const userIdForLog = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "managePricingPolicies");
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as MatrixDeleteBody | null;
    const brandId = normalizeInt(payload?.brandId);
    if (brandId == null) {
      return NextResponse.json({ ok: false, error: "Brand is required" }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, 1, 'pricingPolicyRules', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const delReq = pool.request();
    delReq.input("__brandId", sql.Int, brandId);
    const delRes = await delReq.query<{ DeletedID: number | null; DeletedName: string | null }>(`
      DECLARE @DeletedRules TABLE (ID INT, Name NVARCHAR(512));
      DELETE FROM dbo.PricingPolicyRules
      OUTPUT DELETED.ID, DELETED.Name INTO @DeletedRules
      WHERE BrandID = @__brandId;
      SELECT ID AS DeletedID, Name AS DeletedName FROM @DeletedRules;
    `);
    const deletedRows = (delRes.recordset ?? [])
      .filter((row) => row.DeletedID != null)
      .map((row) => ({
        id: row.DeletedID as number,
        name: row.DeletedName?.trim() || null,
      }));
    const deletedCount = deletedRows.length;

    logDeleteAuditDetails({
      endpoint: '/api/pricing-policies/matrix',
      requestId,
      userId: userIdForLog,
      targetEntity: 'pricingPolicyRules',
      requestedIds: deletedRows.map((row) => row.id),
      deletedRows,
      message: 'Pricing policy matrix brand removed',
      extra: { brandId },
    });

    return NextResponse.json({ ok: true, deletedCount });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  logRequest(req, '/api/pricing-policies/matrix');
  try {
    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const { where, params: whereParams } = buildWhereAndParams(gridRequest.filterModel);
    const quickFilter = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilter.clause);
    const combinedParams = [...whereParams, ...quickFilter.params];

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;
    const brandSql = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Brands.ID AS BrandID,
        dbo.Brands.Name AS BrandName
      FROM dbo.Brands
      INNER JOIN (
        SELECT DISTINCT BrandID
        FROM dbo.PricingPolicyRules
        WHERE BrandID IS NOT NULL
      ) AS linked ON dbo.Brands.ID = linked.BrandID
      ${combinedWhere}
      ORDER BY dbo.Brands.Name
      ${paging}
    `;
    const brandReq = bindParams(pool.request(), combinedParams);
    brandReq.input("__offset", sql.Int, offset);
    brandReq.input("__limit", sql.Int, pageSize);
    const brandRes = await brandReq.query<BrandRow>(brandSql);
    const brandRows = brandRes.recordset ?? [];
    const rowCount = brandRows.length > 0 ? Number(brandRows[0].__totalCount ?? 0) : 0;

    const brandIds = brandRows
      .map((row) => row.BrandID)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

    let ruleAggRows: RuleAggRow[] = [];
    if (brandIds.length > 0) {
      const inParams = brandIds.map((_, idx) => `@__brand_${idx}`).join(", ");
      const rulesReq = pool.request();
      brandIds.forEach((id, idx) => rulesReq.input(`__brand_${idx}`, sql.Int, id));
      const rulesSql = `
        SELECT
          ppr.BrandID,
          ppr.PricingPolicyID,
          MIN(ppr.TelmacoDiscountPercentage) AS MinTelmaco,
          MIN(ppr.CustomerDiscountPercentage) AS MinCustomer,
          MIN(ppr.TelmacoWarrantyYears) AS MinTelmacoWarranty,
          MIN(ppr.CustomerWarrantyYears) AS MinCustomerWarranty
        FROM dbo.PricingPolicyRules ppr
        WHERE ppr.BrandID IS NOT NULL
          AND ppr.BrandID IN (${inParams})
        GROUP BY ppr.BrandID, ppr.PricingPolicyID
      `;
      const rulesRes = await rulesReq.query<RuleAggRow>(rulesSql);
      ruleAggRows = rulesRes.recordset ?? [];
    }

    const grandReq = pool.request();
    const grandRes = await grandReq.query<GrandAggRow>(`
      SELECT
        ppr.PricingPolicyID,
        MIN(ppr.TelmacoDiscountPercentage) AS MinTelmaco,
        MIN(ppr.CustomerDiscountPercentage) AS MinCustomer,
        MIN(ppr.TelmacoWarrantyYears) AS MinTelmacoWarranty,
        MIN(ppr.CustomerWarrantyYears) AS MinCustomerWarranty
      FROM dbo.PricingPolicyRules ppr
      WHERE ppr.BrandID IS NOT NULL
      GROUP BY ppr.PricingPolicyID
    `);
    const grandAggRows = grandRes.recordset ?? [];

    type PolicyCell = {
      telmacoDiscount: number | null;
      customerDiscount: number | null;
      telmacoWarranty: number | null;
      customerWarranty: number | null;
    };
    const policiesByBrand = new Map<number, Record<string, PolicyCell>>();
    ruleAggRows.forEach((row) => {
      const brandId = row.BrandID;
      const policyId = row.PricingPolicyID;
      if (brandId == null || policyId == null) return;
      const key = String(policyId);
      const map = policiesByBrand.get(brandId) ?? {};
      map[key] = {
        telmacoDiscount: normalizeNumeric(row.MinTelmaco),
        customerDiscount: normalizeNumeric(row.MinCustomer),
        telmacoWarranty: normalizeInt(row.MinTelmacoWarranty),
        customerWarranty: normalizeInt(row.MinCustomerWarranty),
      };
      policiesByBrand.set(brandId, map);
    });

    const rows = brandRows.map((brand) => {
      const brandId = brand.BrandID;
      const policies = typeof brandId === "number" ? (policiesByBrand.get(brandId) ?? {}) : {};
      const telmacoValues = Object.values(policies)
        .map((cell) => cell?.telmacoDiscount ?? null)
        .filter((value): value is number => value != null && Number.isFinite(value));
      const customerValues = Object.values(policies)
        .map((cell) => cell?.customerDiscount ?? null)
        .filter((value): value is number => value != null && Number.isFinite(value));

      return {
        BrandID: brand.BrandID,
        BrandName: brand.BrandName,
        policies,
        totalTelmacoDiscount: telmacoValues.length > 0 ? Math.min(...telmacoValues) : null,
        totalCustomerDiscount: customerValues.length > 0 ? Math.min(...customerValues) : null };
    });

    const grandPolicies: Record<string, PolicyCell> = {};
    const grandTelmacoValues: number[] = [];
    const grandCustomerValues: number[] = [];
    grandAggRows.forEach((row) => {
      const policyId = row.PricingPolicyID;
      if (policyId == null) return;
      const cell: PolicyCell = {
        telmacoDiscount: normalizeNumeric(row.MinTelmaco),
        customerDiscount: normalizeNumeric(row.MinCustomer),
        telmacoWarranty: normalizeInt(row.MinTelmacoWarranty),
        customerWarranty: normalizeInt(row.MinCustomerWarranty),
      };
      grandPolicies[String(policyId)] = cell;
      if (cell.telmacoDiscount != null && Number.isFinite(cell.telmacoDiscount)) {
        grandTelmacoValues.push(cell.telmacoDiscount);
      }
      if (cell.customerDiscount != null && Number.isFinite(cell.customerDiscount)) {
        grandCustomerValues.push(cell.customerDiscount);
      }
    });

    const grandTotalRow = {
      BrandID: null,
      BrandName: "Minimum per Policy",
      policies: grandPolicies,
      totalTelmacoDiscount: grandTelmacoValues.length > 0 ? Math.min(...grandTelmacoValues) : null,
      totalCustomerDiscount: grandCustomerValues.length > 0 ? Math.min(...grandCustomerValues) : null };

    return NextResponse.json({ ok: true, rows, rowCount, grandTotal: grandTotalRow });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
