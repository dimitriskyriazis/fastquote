import { z } from 'zod';
import { NextRequest, NextResponse } from 'next/server';
import { getRequestId } from './requestId';
import { resolveAuditUserId } from './auditTrail';
import { createErrorResponse } from './errorHandler';
import { logger } from './logger';

/**
 * Common validation schemas following OWASP best practices
 */

// String validation with length limits
export const stringSchema = (maxLength: number, minLength = 0) =>
  z
    .string()
    .min(minLength, `Must be at least ${minLength} characters`)
    .max(maxLength, `Must be at most ${maxLength} characters`)
    .trim()
    .transform((val) => (val === '' ? null : val))
    .nullable();

// Integer validation
export const intSchema = z
  .union([
    z.number().int(),
    z.string().transform((val, ctx) => {
      const parsed = Number.parseInt(val.trim(), 10);
      if (Number.isNaN(parsed) || !Number.isInteger(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Must be a valid integer',
        });
        return z.NEVER;
      }
      return parsed;
    }),
  ])
  .nullable()
  .optional();

// Positive integer validation
export const positiveIntSchema = intSchema.refine(
  (val) => val === null || val === undefined || val > 0,
  { message: 'Must be a positive integer' },
);

// Boolean validation
export const booleanSchema = z
  .union([
    z.boolean(),
    z.string().transform((val) => {
      const lower = val.toLowerCase().trim();
      return lower === 'true' || lower === '1';
    }),
    z.number().transform((val) => val === 1 || val !== 0),
  ])
  .nullable()
  .optional();

// Date validation
export const dateSchema = z
  .union([
    z.date(),
    z.string().transform((val, ctx) => {
      const trimmed = val.trim();
      if (!trimmed) return null;
      const parsed = new Date(trimmed);
      if (Number.isNaN(parsed.getTime())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Must be a valid date',
        });
        return z.NEVER;
      }
      return parsed;
    }),
  ])
  .nullable()
  .optional();

// Email validation
export const emailSchema = z
  .string()
  .email('Must be a valid email address')
  .max(256, 'Email must be at most 256 characters')
  .trim()
  .toLowerCase()
  .nullable()
  .optional();

// URL validation
export const urlSchema = z
  .string()
  .url('Must be a valid URL')
  .max(2000, 'URL must be at most 2000 characters')
  .trim()
  .nullable()
  .optional();

// Part/Model number normalization (alphanumeric + common separators)
export const partModelNumberSchema = (maxLength: number) =>
  z
    .string()
    .max(maxLength, `Must be at most ${maxLength} characters`)
    .trim()
    .regex(
      /^[a-zA-Z0-9\s\-_./,()"\'&+\u2019]+$/,
      'Part/Model number can only contain alphanumeric characters, spaces, and -_./,()"\'+&',
    )
    .transform((val) => (val === '' ? null : val))
    .nullable()
    .optional();

/**
 * Validate request body against a Zod schema
 * 
 * @param req - Next.js request
 * @param schema - Zod schema to validate against
 * @param options - Validation options
 * @returns Validated data or error response
 */
export async function validateRequest<T>(
  req: NextRequest,
  schema: z.ZodSchema<T>,
  options: {
    endpoint?: string;
    method?: string;
    rejectUnknownFields?: boolean;
  } = {},
): Promise<{ success: true; data: T } | { success: false; response: NextResponse }> {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  const endpoint = options.endpoint || req.nextUrl.pathname;
  const method = options.method || req.method;

  try {
    // Parse JSON body
    let body: unknown;
    try {
      body = await req.json();
    } catch (error) {
      logger.warn('Invalid JSON in request body', {
        requestId,
        endpoint,
        method,
        userId,
        error: error instanceof Error ? error.message : 'Invalid JSON',
      });
      return {
        success: false,
        response: await createErrorResponse('Invalid JSON in request body', 400, {
          requestId,
          endpoint,
          method,
          userId,
        }),
      };
    }

    // Note: Unknown fields are rejected by Zod's .strict() mode on the schema
    // The rejectUnknownFields option is informational - ensure schemas use .strict()

    // Validate against schema
    const result = await schema.safeParseAsync(body);

    if (!result.success) {
      const errors = result.error.issues.map((err) => {
        const path = err.path.join('.');
        return `${path}: ${err.message}`;
      });

      logger.warn('Validation failed', {
        requestId,
        endpoint,
        method,
        userId,
        errors: errors.join('; '),
      });

      return {
        success: false,
        response: await createErrorResponse(
          `Validation failed: ${errors.join('; ')}`,
          400,
          {
            requestId,
            endpoint,
            method,
            userId,
          },
        ),
      };
    }

    return { success: true, data: result.data };
  } catch (error) {
    logger.error('Validation error', {
      requestId,
      endpoint,
      method,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      response: await createErrorResponse('Validation error occurred', 500, {
        requestId,
        endpoint,
        method,
        userId,
      }),
    };
  }
}

/**
 * Validate URL parameters against a Zod schema
 */
export async function validateParams<T>(
  params: Promise<Record<string, string>> | Record<string, string>,
  schema: z.ZodSchema<T>,
  options: {
    requestId?: string;
    endpoint?: string;
    method?: string;
    userId?: string | null;
  } = {},
): Promise<{ success: true; data: T } | { success: false; response: NextResponse }> {
  const requestId = options.requestId || (await getRequestId());
  const endpoint = options.endpoint || 'unknown';
  const method = options.method || 'GET';

  try {
    const resolvedParams = params instanceof Promise ? await params : params;
    const result = await schema.safeParseAsync(resolvedParams);

    if (!result.success) {
      const errors = result.error.issues.map((err) => {
        const path = err.path.join('.');
        return `${path}: ${err.message}`;
      });

      logger.warn('Parameter validation failed', {
        requestId,
        endpoint,
        method,
        userId: options.userId,
        errors: errors.join('; '),
      });

      return {
        success: false,
        response: await createErrorResponse(
          `Invalid parameters: ${errors.join('; ')}`,
          400,
          {
            requestId,
            endpoint,
            method,
            userId: options.userId,
          },
        ),
      };
    }

    return { success: true, data: result.data };
  } catch (error) {
    logger.error('Parameter validation error', {
      requestId,
      endpoint,
      method,
      userId: options.userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      response: await createErrorResponse('Parameter validation error occurred', 500, {
        requestId,
        endpoint,
        method,
        userId: options.userId,
      }),
    };
  }
}

/**
 * Validate query parameters against a Zod schema
 */
export function validateQuery<T>(
  searchParams: URLSearchParams,
  schema: z.ZodSchema<T>,
  options: {
    requestId?: string;
    endpoint?: string;
    method?: string;
    userId?: string | null;
  } = {},
): { success: true; data: T } | { success: false; response: NextResponse } {
  const requestId = options.requestId || 'unknown';
  const endpoint = options.endpoint || 'unknown';
  const method = options.method || 'GET';

  try {
    // Convert URLSearchParams to object
    const queryObj: Record<string, string> = {};
    searchParams.forEach((value, key) => {
      queryObj[key] = value;
    });

    const result = schema.safeParse(queryObj);

    if (!result.success) {
      const errors = result.error.issues.map((err) => {
        const path = err.path.join('.');
        return `${path}: ${err.message}`;
      });

      logger.warn('Query validation failed', {
        requestId,
        endpoint,
        method,
        userId: options.userId,
        errors: errors.join('; '),
      });

      return {
        success: false,
        response: NextResponse.json(
          {
            ok: false,
            error: `Invalid query parameters: ${errors.join('; ')}`,
            requestId: process.env.NODE_ENV !== 'production' ? requestId : undefined,
          },
          { status: 400 },
        ),
      };
    }

    return { success: true, data: result.data };
  } catch (error) {
    logger.error('Query validation error', {
      requestId,
      endpoint,
      method,
      userId: options.userId,
      error: error instanceof Error ? error.message : String(error),
    });

    return {
      success: false,
      response: NextResponse.json(
        {
          ok: false,
          error: 'Query validation error occurred',
          requestId: process.env.NODE_ENV !== 'production' ? requestId : undefined,
        },
        { status: 500 },
      ),
    };
  }
}
