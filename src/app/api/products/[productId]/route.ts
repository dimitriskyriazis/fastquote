import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { z } from 'zod';
import { getPool } from '../../../../lib/sql';
import { getRequestId } from '../../../../lib/requestId';
import { handleApiError, createErrorResponse } from '../../../../lib/errorHandler';
import { logger } from '../../../../lib/logger';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { validateParams } from '../../../../lib/validation';

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
