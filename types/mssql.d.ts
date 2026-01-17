declare module 'mssql' {
  export type config = {
    server: string;
    port?: number;
    database: string;
    user: string;
    password: string;
    options?: {
      encrypt?: boolean;
      requestTimeout?: number;
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

  export class Transaction {
    constructor(pool: ConnectionPool);
    begin(): Promise<void>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    request(): Request;
  }

  export class Request {
    constructor();
    constructor(transaction: Transaction);
    timeout?: number;
    input(name: string, value: unknown): Request;
    input(name: string, type: unknown, value: unknown): Request;
    query<T = unknown>(query: string): Promise<IResult<T>>;
  }

  export type ISqlTypeFactory = (...args: unknown[]) => unknown;
  export interface ISqlTypeFactoryWithLength extends ISqlTypeFactory {
    (length?: number): unknown;
  }

  export const Int: ISqlTypeFactory;
  export const Bit: ISqlTypeFactory;
  export const DateTime2: ISqlTypeFactory;
  export const NVarChar: ISqlTypeFactoryWithLength;
  export const MAX: number;

  export function connect(config: config): Promise<ConnectionPool>;

  const sql: {
    connect: typeof connect;
    ConnectionPool: typeof ConnectionPool;
    Request: typeof Request;
    Int: typeof Int;
    Bit: typeof Bit;
    DateTime2: typeof DateTime2;
    NVarChar: typeof NVarChar;
    MAX: typeof MAX;
    Transaction: typeof Transaction;
  };

  export default sql;
}

declare module '*.css';
