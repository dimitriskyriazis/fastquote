import sql, { type ConnectionPool, type config as SqlConfig } from 'mssql';

type SqlConnectionConfig = SqlConfig;

const config: SqlConnectionConfig = {
  server: process.env.SQLSERVER_HOST!,
  port: Number(process.env.SQLSERVER_PORT || 1433),
  database: process.env.SQLSERVER_DB!,
  user: process.env.SQLSERVER_USER!,
  password: process.env.SQLSERVER_PASSWORD!,
  options: { encrypt: false },
  pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
};

let poolPromise: Promise<ConnectionPool> | null = null;

export async function getPool(): Promise<ConnectionPool> {
  if (!poolPromise) {
    poolPromise = sql.connect(config);
  }

  try {
    const pool = await poolPromise;
    if (!pool.connected) {
      poolPromise = sql.connect(config);
      return await poolPromise;
    }
    return pool;
  } catch (err) {
    poolPromise = null;
    throw err;
  }
}

export { sql };
