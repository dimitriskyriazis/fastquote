import { NextResponse } from 'next/server';
import { logger } from './logger';
import { getRequestId } from './requestId';
import type { LogContext } from './logger';

type ErrorHandlerOptions = {
  requestId?: string;
  endpoint?: string;
  method?: string;
  userId?: string | null;
  exposeDetails?: boolean;
};

const isProduction = process.env.NODE_ENV === 'production';

export function sanitizeError(error: unknown, options: ErrorHandlerOptions = {}): string {
  if (error instanceof Error) {
    if (options.exposeDetails || !isProduction) {
      return error.message;
    }
    return 'An internal error occurred';
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'An unexpected error occurred';
}

export function handleApiError(
  error: unknown,
  options: ErrorHandlerOptions = {},
): NextResponse {
  const requestId = options.requestId ?? getRequestId();
  const sanitizedMessage = sanitizeError(error, options);
  
  const context: LogContext = {
    requestId,
    endpoint: options.endpoint,
    method: options.method,
    userId: options.userId,
  };

  if (error instanceof Error) {
    logger.error('API error occurred', context, error);
  } else {
    logger.error('API error occurred', { ...context, error: String(error) });
  }

  const status = error instanceof Error && 'status' in error && typeof error.status === 'number'
    ? error.status
    : 500;

  return NextResponse.json(
    {
      ok: false,
      error: sanitizedMessage,
      requestId: isProduction ? undefined : requestId,
    },
    { status },
  );
}

export function createErrorResponse(
  message: string,
  status: number = 500,
  options: ErrorHandlerOptions = {},
): NextResponse {
  const requestId = options.requestId ?? getRequestId();
  
  const context: LogContext = {
    requestId,
    endpoint: options.endpoint,
    method: options.method,
    userId: options.userId,
  };

  logger.warn(`API error: ${message}`, context);

  return NextResponse.json(
    {
      ok: false,
      error: message,
      requestId: isProduction ? undefined : requestId,
    },
    { status },
  );
}
