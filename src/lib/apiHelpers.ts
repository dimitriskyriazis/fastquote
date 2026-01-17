import { NextRequest, NextResponse } from 'next/server';
import { getRequestId } from './requestId';
import { resolveAuditUserId } from './auditTrail';
import { handleApiError, createErrorResponse } from './errorHandler';
import { logger } from './logger';
import type { LogContext } from './logger';

export type ApiHandlerContext = {
  requestId: string;
  userId: string | null;
  endpoint: string;
  method: string;
};

export async function createApiContext(
  req: NextRequest,
  endpoint: string,
  method: string = req.method,
): Promise<ApiHandlerContext> {
  return {
    requestId: await getRequestId(req),
    userId: resolveAuditUserId(req),
    endpoint,
    method,
  };
}

export function logApiRequest(context: ApiHandlerContext, message?: string): void {
  logger.info(message || 'API request', {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
  });
}

export function logApiSuccess(context: ApiHandlerContext, message?: string, extra?: LogContext): void {
  logger.info(message || 'API request succeeded', {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
    ...extra,
  });
}

export async function handleApiErrorResponse(
  error: unknown,
  context: ApiHandlerContext,
): Promise<NextResponse> {
  return await handleApiError(error, {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
  });
}

export async function createErrorResponseWithContext(
  message: string,
  status: number,
  context: ApiHandlerContext,
): Promise<NextResponse> {
  return await createErrorResponse(message, status, {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
  });
}
