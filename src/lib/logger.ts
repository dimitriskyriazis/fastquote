import { getPool, sql } from './sql';
import type { LogCategory } from './logCategory';

export type { LogCategory } from './logCategory';

export type LogContext = {
  requestId?: string;
  userId?: string | null;
  userName?: string | null;
  endpoint?: string;
  method?: string;
  category?: LogCategory;
  [key: string]: unknown;
};

export { categoryFromMethod, categoryFromRequest } from './logCategory';

const isDev = process.env.NODE_ENV === 'development';

const KNOWN_FIELDS = new Set([
  'category', 'userId', 'userName', 'method', 'endpoint', 'requestId',
]);

const DB_LOG_SKIP_ENDPOINTS = new Set(['/api/logs']);

function formatConsole(level: string, message: string, context?: LogContext): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const contextStr = context ? ` ${JSON.stringify(context)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`;
}

function writeToDatabase(
  level: string,
  message: string,
  context?: LogContext,
  error?: Error,
): void {
  const endpoint = context?.endpoint as string | undefined;
  if (endpoint && DB_LOG_SKIP_ENDPOINTS.has(endpoint)) return;

  void (async () => {
    try {
      const pool = await getPool();
      const request = pool.request();

      const category = (context?.category as string) ?? null;
      const userId = (context?.userId as string) ?? null;
      const method = (context?.method as string) ?? null;
      const requestId = (context?.requestId as string) ?? null;

      const details: Record<string, unknown> = {};
      if (context) {
        for (const [key, value] of Object.entries(context)) {
          if (KNOWN_FIELDS.has(key)) continue;
          details[key] = value;
        }
      }
      if (error) {
        details.errorName = error.name;
        details.errorMessage = error.message;
        details.stack = error.stack;
      }
      const detailsJson = Object.keys(details).length > 0
        ? JSON.stringify(details)
        : null;

      request.input('level', sql.NVarChar(10), level);
      request.input('message', sql.NVarChar(2000), message.slice(0, 2000));
      request.input('category', sql.NVarChar(20), category);
      request.input('userId', sql.NVarChar(450), userId);
      request.input('method', sql.NVarChar(10), method);
      request.input('endpoint', sql.NVarChar(500), endpoint?.slice(0, 500) ?? null);
      request.input('requestId', sql.NVarChar(100), requestId);
      request.input('details', sql.NVarChar(sql.MAX), detailsJson);

      await request.query(`
        INSERT INTO dbo.Logs (
          Timestamp, Level, Message, Category, UserId, Method, Endpoint, RequestId, Details
        ) VALUES (
          SYSUTCDATETIME(), @level, @message, @category, @userId, @method, @endpoint, @requestId, @details
        )
      `);
    } catch (err) {
      console.error('[logger] Failed to write log to database:', err);
    }
  })();
}

function buildMeta(context?: LogContext, error?: Error): Record<string, unknown> {
  const meta: Record<string, unknown> = { ...context };
  if (error) {
    meta.errorName = error.name;
    meta.errorMessage = error.message;
    meta.stack = error.stack;
  }
  return meta;
}

class Logger {
  debug(message: string, context?: LogContext): void {
    if (!isDev) return;
    console.log(formatConsole('debug', message, context));
  }

  info(message: string, context?: LogContext): void {
    if (isDev) console.log(formatConsole('info', message, context));
    writeToDatabase('info', message, context);
  }

  warn(message: string, context?: LogContext, error?: Error): void {
    if (isDev) console.warn(formatConsole('warn', message, context));
    writeToDatabase('warn', message, context, error);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    if (isDev) {
      const meta = buildMeta(context, error);
      console.error(formatConsole('error', message, context), error ? meta : undefined);
    }
    writeToDatabase('error', message, context, error);
  }
}

export const logger = new Logger();
