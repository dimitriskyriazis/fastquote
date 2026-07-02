import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { z } from 'zod';
import { getPool } from '../../../../lib/sql';
import { getRequestId } from '../../../../lib/requestId';
import { handleApiError, createErrorResponse } from '../../../../lib/errorHandler';
import { logger } from '../../../../lib/logger';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { validateParams } from '../../../../lib/validation';

const brandIdParamsSchema = z.object({
  brandId: z.string().transform((val, ctx) => {
    const parsed = Number.parseInt(val.trim(), 10);
    if (Number.isNaN(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Brand ID must be a positive integer',
      });
      return z.NEVER;
    }
    return parsed;
  }),
});

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ brandId: string }> },
) {
  logRequest(req, '/api/brands/[brandId]');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const paramsValidation = await validateParams(context.params, brandIdParamsSchema, {
      requestId,
      endpoint: req.nextUrl.pathname,
      method: 'GET',
      userId,
    });

    if (!paramsValidation.success) {
      return paramsValidation.response;
    }

    const brandId = paramsValidation.data.brandId;

    const pool = await getPool();
    const request = pool.request();
    request.timeout = 30000;
    request.input('brandId', sql.Int, brandId);

    const result = await request.query<{
      BrandID: number;
      Name: string | null;
      Comment: string | null;
      SoftOneID: number | null;
      SoftOneCode: string | null;
      AVC4Name: string | null;
      EPLINCName: string | null;
      Enabled: boolean | null;
      PartNumberSuffix: string | null;
      PartNumberPattern1: string | null;
      PartNumberPattern2: string | null;
    }>(`
      SELECT
        ID AS BrandID,
        NULLIF(LTRIM(RTRIM(Name)), '') AS Name,
        NULLIF(LTRIM(RTRIM(Comment)), '') AS Comment,
        SoftOneID,
        NULLIF(LTRIM(RTRIM(SoftOneCode)), '') AS SoftOneCode,
        NULLIF(LTRIM(RTRIM(AVC4Name)), '') AS AVC4Name,
        NULLIF(LTRIM(RTRIM(EPLINCName)), '') AS EPLINCName,
        CAST(Enabled AS BIT) AS Enabled,
        NULLIF(LTRIM(RTRIM(PartNumberSuffix)), '') AS PartNumberSuffix,
        NULLIF(LTRIM(RTRIM(PartNumberPattern1)), '') AS PartNumberPattern1,
        NULLIF(LTRIM(RTRIM(PartNumberPattern2)), '') AS PartNumberPattern2
      FROM dbo.Brands
      WHERE ID = @brandId
    `);

    const row = result.recordset?.[0] ?? null;
    if (!row) {
      return await createErrorResponse('Brand not found', 404, {
        requestId,
        endpoint: `/api/brands/${brandId}`,
        method: 'GET',
        userId,
      });
    }

    logger.info('Brand fetched successfully', {
      requestId,
      endpoint: `/api/brands/${brandId}`,
      method: 'GET',
      userId,
      brandId,
    });

    return NextResponse.json({ ok: true, brand: row });
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: req.nextUrl.pathname,
      method: 'GET',
      userId,
    });
  }
}
