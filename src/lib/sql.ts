import * as sql from 'mssql';
import type { ConnectionPool, config as SqlConfig } from 'mssql';

type SqlConnectionConfig = SqlConfig;

const config: SqlConnectionConfig = {
  server: process.env.TELQUOTE_HOST!,
  port: Number(process.env.TELQUOTE_PORT!),
  database: process.env.TELQUOTE_DB!,
  user: process.env.TELQUOTE_USER!,
  password: process.env.TELQUOTE_PASSWORD!,
  options: {
    trustServerCertificate: process.env.TELQUOTE_TRUST_CERT === 'true',
    encrypt: process.env.TELQUOTE_ENCRYPT === 'true',
    requestTimeout: Number(process.env.TELQUOTE_REQUEST_TIMEOUT),
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

// ERP database connection (SOFT1_ERP) - build config dynamically to ensure env vars are read
function getErpConfig(): SqlConnectionConfig {
  return {
    server: process.env.SOFT1_ERP_HOST!,
    port: Number(process.env.SOFT1_ERP_PORT!),
    database: process.env.SOFT1_ERP_DB!,
    user: process.env.SOFT1_ERP_USER!,
    password: process.env.SOFT1_ERP_PASSWORD!,
    options: {
      encrypt: process.env.SOFT1_ERP_ENCRYPT === 'true',
      trustServerCertificate: process.env.SOFT1_ERP_TRUST_CERT === 'true',
      requestTimeout: Number(process.env.SOFT1_ERP_REQUEST_TIMEOUT || 30000),
    },
    pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
  };
}

let erpPoolInstance: ConnectionPool | null = null;
let erpPoolPromise: Promise<ConnectionPool> | null = null;

export async function getErpPool(): Promise<ConnectionPool> {
  if (!erpPoolInstance || !erpPoolInstance.connected) {
    const erpConfig = getErpConfig();
    console.log('Creating NEW ERP pool connection to:', erpConfig.server, erpConfig.database, 'Port:', erpConfig.port);
    
    // Create a new ConnectionPool instance directly to ensure separate connection
    erpPoolInstance = new sqlWithTypes.ConnectionPool(erpConfig);
    erpPoolPromise = erpPoolInstance.connect();
    
    try {
      const pool = await erpPoolPromise;
      console.log('ERP pool connected successfully. Server:', erpConfig.server, 'Database:', erpConfig.database, 'Connected:', pool.connected);
      
      // Verify the connection by checking the actual config
      // Note: ConnectionPool doesn't expose config directly, but we can verify by making a test query
      const testRequest = pool.request();
      const testResult = await testRequest.query('SELECT @@SERVERNAME AS ServerName, DB_NAME() AS DatabaseName');
      const serverInfo = testResult.recordset?.[0] as { ServerName?: string; DatabaseName?: string } | undefined;
      console.log('ERP Connection verified - Server:', serverInfo?.ServerName, 'Database:', serverInfo?.DatabaseName);
      
      return pool;
    } catch (err) {
      console.error('Failed to connect ERP pool:', err);
      console.error('ERP Config used:', {
        server: erpConfig.server,
        database: erpConfig.database,
        user: erpConfig.user,
        port: erpConfig.port,
      });
      erpPoolInstance = null;
      erpPoolPromise = null;
      throw err;
    }
  }

  return erpPoolInstance;
}

export { sqlWithTypes as sql };
