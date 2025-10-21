// src/lib/db.ts
import sql, { config as SQLConfig } from 'mssql';

const config: SQLConfig = {
  server: process.env.DB_SERVER as string,
  port: Number(process.env.DB_PORT || 1433),
  database: process.env.DB_DATABASE as string,
  user: process.env.DB_USER as string,
  password: process.env.DB_PASSWORD as string,

  // Global timeouts so requests fail fast instead of hanging forever
  requestTimeout: 7000,     // ms
  connectionTimeout: 7000,  // ms

  options: {
    encrypt: process.env.DB_ENCRYPT === 'true',
    trustServerCertificate: process.env.DB_TRUST_SERVER_CERTIFICATE === 'true',
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
};

let pool: sql.ConnectionPool | null = null;

export async function getPool() {
  if (pool) return pool;
  try {
    pool = await new sql.ConnectionPool(config).connect();
    return pool;
  } catch (e) {
    pool = null; // reset so next call can retry
    throw e;
  }
}

// Tagged-template style query helper (as you were using)
export async function query<T = any>(strings: TemplateStringsArray | string, ...values: any[]): Promise<T[]> {
  const p = await getPool();
  const request = p.request();

  // Allow both tagged template and plain string
  const raw =
    typeof strings === 'string'
      ? strings
      : strings.reduce((acc, s, i) => acc + s + (i < values.length ? values[i] : ''), '');

  const result = await request.query(raw);
  return result.recordset as T[];
}
