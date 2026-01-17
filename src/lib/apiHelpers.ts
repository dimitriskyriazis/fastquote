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

export function createApiContext(
  req: NextRequest,
  endpoint: string,
  method: string = req.method,
): ApiHandlerContext {
  return {
    requestId: getRequestId(req),
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

export function handleApiErrorResponse(
  error: unknown,
  context: ApiHandlerContext,
): NextResponse {
  return handleApiError(error, {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
  });
}

export function createErrorResponseWithContext(
  message: string,
  status: number,
  context: ApiHandlerContext,
): NextResponse {
  return createErrorResponse(message, status, {
    requestId: context.requestId,
    endpoint: context.endpoint,
    method: context.method,
    userId: context.userId,
  });
}
