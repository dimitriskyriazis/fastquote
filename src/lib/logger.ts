type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogContext = {
  requestId?: string;
  userId?: string | null;
  endpoint?: string;
  method?: string;
  [key: string]: unknown;
};

class Logger {
  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`;
  }

  private log(level: LogLevel, message: string, context?: LogContext, error?: Error): void {
    const formatted = this.formatMessage(level, message, context);
    
    if (error) {
      const errorDetails = {
        message: error.message,
        stack: error.stack,
        name: error.name,
      };
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
        formatted,
        errorDetails,
      );
    } else {
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](formatted);
    }
  }

  debug(message: string, context?: LogContext): void {
    if (process.env.NODE_ENV === 'development') {
      this.log('debug', message, context);
    }
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext, error?: Error): void {
    this.log('warn', message, context, error);
  }

  error(message: string, context?: LogContext, error?: Error): void {
    this.log('error', message, context, error);
  }
}

export const logger = new Logger();
export type { LogContext };
