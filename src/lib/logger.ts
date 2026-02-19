import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';
import type { LogCategory } from './logCategory';

export type { LogCategory } from './logCategory';

export type LogContext = {
  requestId?: string;
  userId?: string | null;
  endpoint?: string;
  method?: string;
  category?: LogCategory;
  [key: string]: unknown;
};

export { categoryFromMethod, categoryFromRequest } from './logCategory';

const isDev = process.env.NODE_ENV === 'development';
const logsDir = path.join(process.cwd(), 'logs');

// Ensure logs directory exists before creating transports
fs.mkdirSync(logsDir, { recursive: true });

const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

const categoryFilter = (category: LogCategory) =>
  winston.format((info) => (info['category'] === category ? info : false))();

const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  isDev ? winston.format.colorize() : winston.format.uncolorize(),
  winston.format.printf(({ timestamp, level, message, stack, ...rest }) => {
    const context = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    const base = `[${timestamp}] [${level.toUpperCase()}] ${message}${context}`;
    return stack ? `${base}\n${stack}` : base;
  }),
);

function makeRotateTransport(filename: string, opts: {
  level?: string;
  maxFiles?: string;
  format?: winston.Logform.Format;
}) {
  const transport = new DailyRotateFile({
    dirname: logsDir,
    filename,
    datePattern: 'YYYY-MM-DD',
    maxFiles: opts.maxFiles ?? '14d',
    level: opts.level ?? 'info',
    format: opts.format ?? jsonFormat,
    createSymlink: false,   // symlinks require elevated privileges on Windows
    auditFile: path.join(logsDir, `.audit-${filename.replace('%DATE%', '').replace('.log', '')}.json`),
  });

  transport.on('error', (err) => {
    console.error(`[logger] DailyRotateFile transport error (${filename}):`, err);
  });

  return transport;
}

const winstonLogger = winston.createLogger({
  level: isDev ? 'debug' : 'info',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    makeRotateTransport('app-%DATE%.log', { level: 'info' }),
    makeRotateTransport('error-%DATE%.log', { level: 'error', maxFiles: '30d' }),
    makeRotateTransport('views-%DATE%.log', {
      format: winston.format.combine(categoryFilter('view'), jsonFormat),
    }),
    makeRotateTransport('mutations-%DATE%.log', {
      format: winston.format.combine(categoryFilter('mutation'), jsonFormat),
    }),
    makeRotateTransport('deletes-%DATE%.log', {
      format: winston.format.combine(categoryFilter('delete'), jsonFormat),
    }),
  ],
});

winstonLogger.on('error', (err) => {
  console.error('[logger] Winston error:', err);
});

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
    winstonLogger.debug(message, buildMeta(context));
  }

  info(message: string, context?: LogContext): void {
    winstonLogger.info(message, buildMeta(context));
  }

  warn(message: string, context?: LogContext, error?: Error): void {
    winstonLogger.warn(message, buildMeta(context, error));
  }

  error(message: string, context?: LogContext, error?: Error): void {
    winstonLogger.error(message, buildMeta(context, error));
  }
}

export const logger = new Logger();
