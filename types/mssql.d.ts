declare module 'mssql' {
  export type config = {
    server: string;
    port?: number;
    database: string;
    user: string;
    password: string;
    options?: {
      encrypt?: boolean;
    };
    pool?: {
      max?: number;
      min?: number;
      idleTimeoutMillis?: number;
    };
  };

  export interface IResult<T> {
    recordset: T[];
    rowsAffected?: number[];
  }

  export class ConnectionPool {
    constructor(config: config);
    connected: boolean;
    connect(): Promise<ConnectionPool>;
    request(): Request;
  }

  export class Request {
    input(name: string, value: unknown): Request;
    input(name: string, type: unknown, value: unknown): Request;
    query<T = unknown>(query: string): Promise<IResult<T>>;
  }

  type SqlTypeFactory = (...args: unknown[]) => unknown;

  export const Int: symbol;
  export const NVarChar: SqlTypeFactory;

  export function connect(config: config): Promise<ConnectionPool>;

  const sql: {
    connect: typeof connect;
    ConnectionPool: typeof ConnectionPool;
    Int: typeof Int;
    NVarChar: typeof NVarChar;
  };

  export default sql;
}

declare module '*.css';
