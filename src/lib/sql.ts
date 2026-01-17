import * as sql from 'mssql';
import type { ConnectionPool, config as SqlConfig } from 'mssql';

type SqlConnectionConfig = SqlConfig;

const config: SqlConnectionConfig = {
  server: process.env.SQLSERVER_HOST!,
  port: Number(process.env.SQLSERVER_PORT || 1433),
  database: process.env.SQLSERVER_DB!,
  user: process.env.SQLSERVER_USER!,
  password: process.env.SQLSERVER_PASSWORD!,
  options: {
    encrypt: false,
    requestTimeout: Number(process.env.SQLSERVER_REQUEST_TIMEOUT || 30000), // 30 seconds default
  },
  pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
};

type SqlFactoryWithPrecisionScale = (precision?: number, scale?: number) => {
  type: unknown;
  precision?: number;
  scale?: number;
};

type SqlWithTypes = typeof sql & {
  TYPES: {
    Numeric: SqlFactoryWithPrecisionScale;
    Decimal: SqlFactoryWithPrecisionScale;
  };
};

const sqlWithTypes = sql as SqlWithTypes;

let poolPromise: Promise<ConnectionPool> | null = null;

export async function getPool(): Promise<ConnectionPool> {
  if (!poolPromise) {
    poolPromise = sqlWithTypes.connect(config);
  }

  try {
    const pool = await poolPromise;
    if (!pool.connected) {
      poolPromise = sqlWithTypes.connect(config);
      return await poolPromise;
    }
    return pool;
  } catch (err) {
    poolPromise = null;
    throw err;
  }
}

export { sqlWithTypes as sql };
