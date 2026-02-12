import { NextRequest, NextResponse } from 'next/server';
import sql, { type Request as SqlRequest } from "mssql";
import { z } from 'zod';
import { getPool } from '../../../../lib/sql';
import { getRequestId } from '../../../../lib/requestId';
import { handleApiError, createErrorResponse } from '../../../../lib/errorHandler';
import { logger } from '../../../../lib/logger';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { clearPartModelNumberUpper } from '../../../../lib/partModelNumber';
import {
  validateParams,
  validateRequest,
  partModelNumberSchema,
  stringSchema,
  urlSchema,
  positiveIntSchema,
} from '../../../../lib/validation';

const toClearedPartModel = (value: string | null | undefined) => {
  if (!value) return null;
  return clearPartModelNumberUpper(value);
};

// Validate productId parameter
const productIdParamsSchema = z.object({
  productId: z.string().transform((val, ctx) => {
    const parsed = Number.parseInt(val.trim(), 10);
    if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Product ID must be a positive integer',
      });
      return z.NEVER;
    }
    return parsed;
  }),
});

const updateProductSchema = z.object({
  partNumber: partModelNumberSchema(255),
  modelNumber: partModelNumberSchema(255),
  erpCode: partModelNumberSchema(255),
  description: stringSchema(2000).optional(),
  webLink: urlSchema,
  categoryId: positiveIntSchema,
  subCategoryId: positiveIntSchema,
  typeId: positiveIntSchema,
}).strict().refine((data) => (
  data.partNumber !== undefined
  || data.modelNumber !== undefined
  || data.erpCode !== undefined
  || data.description !== undefined
  || data.webLink !== undefined
  || data.categoryId !== undefined
  || data.subCategoryId !== undefined
  || data.typeId !== undefined
), {
  message: 'No updates provided',
});

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  
  try {
    // Validate URL parameters
    const paramsValidation = await validateParams(context.params, productIdParamsSchema, {
      requestId,
      endpoint: req.nextUrl.pathname,
      method: 'GET',
      userId,
    });

    if (!paramsValidation.success) {
      return paramsValidation.response;
    }

    const normalized = paramsValidation.data.productId;
    
    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input('productId', sql.Int, normalized);
    
    const result = await request.query<{
      ProductID: number;
      PartNumber: string | null;
      ModelNumber: string | null;
      BrandName: string | null;
      Description: string | null;
    }>(`
      SELECT
        p.ID AS ProductID,
        NULLIF(LTRIM(RTRIM(p.PartNumber)), '') AS PartNumber,
        NULLIF(LTRIM(RTRIM(p.ModelNumber)), '') AS ModelNumber,
        NULLIF(LTRIM(RTRIM(b.Name)), '') AS BrandName,
        NULLIF(LTRIM(RTRIM(p.Description)), '') AS Description
      FROM dbo.Products p
      LEFT JOIN dbo.Brands b ON p.BrandID = b.ID
      WHERE p.ID = @productId
    `);
    
    const row = result.recordset?.[0] ?? null;
    if (!row) {
      return await createErrorResponse('Product not found', 404, {
        requestId,
        endpoint: `/api/products/${normalized}`,
        method: 'GET',
        userId,
      });
    }
    
    logger.info('Product fetched successfully', {
      requestId,
      endpoint: `/api/products/${normalized}`,
      method: 'GET',
      userId,
      productId: normalized,
    });
    
    return NextResponse.json({ ok: true, product: row });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: req.nextUrl.pathname,
      method: 'GET',
      userId,
    });
  }
}

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ productId: string }> },
) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const paramsValidation = await validateParams(context.params, productIdParamsSchema, {
      requestId,
      endpoint: req.nextUrl.pathname,
      method: 'PATCH',
      userId,
    });

    if (!paramsValidation.success) {
      return paramsValidation.response;
    }

    const normalized = paramsValidation.data.productId;

    const validation = await validateRequest(req, updateProductSchema, {
      endpoint: `/api/products/${normalized}`,
      method: 'PATCH',
      rejectUnknownFields: true,
    });

    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    type SqlInputType = Parameters<SqlRequest["input"]>[1];
    const updates: Array<{
      column: string;
      param: string;
      value: unknown;
      type: SqlInputType;
    }> = [];

    if (body.partNumber !== undefined) {
      updates.push({ column: 'PartNumber', param: 'PartNumber', value: body.partNumber, type: sql.NVarChar(255) });
      updates.push({
        column: 'PartNumberCleared',
        param: 'PartNumberCleared',
        value: toClearedPartModel(body.partNumber),
        type: sql.NVarChar(255),
      });
    }
    if (body.modelNumber !== undefined) {
      updates.push({ column: 'ModelNumber', param: 'ModelNumber', value: body.modelNumber, type: sql.NVarChar(255) });
      updates.push({
        column: 'ModelNumberCleared',
        param: 'ModelNumberCleared',
        value: toClearedPartModel(body.modelNumber),
        type: sql.NVarChar(255),
      });
    }
    if (body.erpCode !== undefined) {
      updates.push({ column: 'ERPCode', param: 'ERPCode', value: body.erpCode, type: sql.NVarChar(255) });
    }
    if (body.description !== undefined) {
      updates.push({ column: 'Description', param: 'Description', value: body.description, type: sql.NVarChar(2000) });
    }
    if (body.webLink !== undefined) {
      updates.push({ column: 'WebLink', param: 'WebLink', value: body.webLink, type: sql.NVarChar(2000) });
    }
    if (body.categoryId !== undefined) {
      updates.push({ column: 'CategoryID', param: 'CategoryID', value: body.categoryId, type: sql.Int });
    }
    if (body.subCategoryId !== undefined) {
      updates.push({ column: 'SubCategoryID', param: 'SubCategoryID', value: body.subCategoryId, type: sql.Int });
    }
    if (body.typeId !== undefined) {
      updates.push({ column: 'TypeID', param: 'TypeID', value: body.typeId, type: sql.Int });
    }

    if (updates.length === 0) {
      return await createErrorResponse('No updates provided', 400, {
        requestId,
        endpoint: `/api/products/${normalized}`,
        method: 'PATCH',
        userId,
      });
    }

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input('ProductID', sql.Int, normalized);
    request.input('ModifiedBy', sql.NVarChar(450), userId);
    updates.forEach((entry) => {
      request.input(entry.param, entry.type, entry.value);
    });

    const setClauses = updates.map((entry) => `p.${entry.column} = @${entry.param}`).join(', ');

    const result = await request.query(`
      UPDATE p
      SET ${setClauses},
          p.ModifiedOn = SYSUTCDATETIME(),
          p.ModifiedBy = @ModifiedBy
      FROM dbo.Products p
      WHERE p.ID = @ProductID;
    `);

    const rowsAffected = result.rowsAffected?.[0] ?? 0;
    if (rowsAffected === 0) {
      return await createErrorResponse('Product not found', 404, {
        requestId,
        endpoint: `/api/products/${normalized}`,
        method: 'PATCH',
        userId,
      });
    }

    logger.info('Product updated successfully', {
      requestId,
      endpoint: `/api/products/${normalized}`,
      method: 'PATCH',
      userId,
      productId: normalized,
      updatedFields: updates.map((entry) => entry.column),
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: req.nextUrl.pathname,
      method: 'PATCH',
      userId,
    });
  }
}
