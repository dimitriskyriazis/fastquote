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
  }

  export class ConnectionPool {
    constructor(config: config);
    connect(): Promise<ConnectionPool>;
    request(): Request;
  }

  export class Request {
    input(name: string, value: unknown): Request;
    input(name: string, type: unknown, value: unknown): Request;
    query<T = unknown>(query: string): Promise<IResult<T>>;
  }

  export const Int: symbol;

  export function connect(config: config): Promise<ConnectionPool>;

  const sql: {
    connect: typeof connect;
    ConnectionPool: typeof ConnectionPool;
    Int: typeof Int;
  };

  export default sql;
}

declare module '*.css';
