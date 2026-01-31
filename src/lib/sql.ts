import * as sql from 'mssql';
import type { ConnectionPool, config as SqlConfig } from 'mssql';

type SqlConnectionConfig = SqlConfig;

const buildFastQuoteConfig = (): SqlConnectionConfig => {
  const server = process.env.FASTQUOTE_HOST!;
  const port = Number(process.env.FASTQUOTE_PORT!);
  const database = process.env.FASTQUOTE_DB!;
  const trustServerCertificate = process.env.FASTQUOTE_TRUST_CERT === 'true';
  const encrypt = process.env.FASTQUOTE_ENCRYPT === 'true';
  const requestTimeout = Number(process.env.FASTQUOTE_REQUEST_TIMEOUT);
  const integrated = process.env.FASTQUOTE_INTEGRATED === 'true';

  if (integrated) {
    return {
      server,
      port,
      database,
      driver: 'msnodesqlv8',
      options: {
        trustedConnection: true,
        trustServerCertificate,
        encrypt,
        requestTimeout,
      },
      pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
    };
  }

  return {
    server,
    port,
    database,
    user: process.env.FASTQUOTE_USER!,
    password: process.env.FASTQUOTE_PASSWORD!,
    options: {
      trustServerCertificate,
      encrypt,
      requestTimeout,
    },
    pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
  };
};

const config: SqlConnectionConfig = buildFastQuoteConfig();

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
  const server = process.env.SOFT1_ERP_HOST!;
  const port = Number(process.env.SOFT1_ERP_PORT!);
  const database = process.env.SOFT1_ERP_DB!;
  const encrypt = process.env.SOFT1_ERP_ENCRYPT === 'true';
  const trustServerCertificate = process.env.SOFT1_ERP_TRUST_CERT === 'true';
  const requestTimeout = Number(process.env.SOFT1_ERP_REQUEST_TIMEOUT || 30000);
  const integrated = process.env.SOFT1_ERP_INTEGRATED === 'true';

  if (integrated) {
    return {
      server,
      port,
      database,
      driver: 'msnodesqlv8',
      options: {
        trustedConnection: true,
        encrypt,
        trustServerCertificate,
        requestTimeout,
      },
      pool: { max: 10, min: 1, idleTimeoutMillis: 30000 },
    };
  }

  return {
    server,
    port,
    database,
    user: process.env.SOFT1_ERP_USER!,
    password: process.env.SOFT1_ERP_PASSWORD!,
    options: {
      encrypt,
      trustServerCertificate,
      requestTimeout,
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
