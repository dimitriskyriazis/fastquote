import { getPool, sql } from './sql';

type UserRecord = {
  Id: number;
  UserName: string | null;
  WindowsUserName: string | null;
};

type ColumnCheckRow = {
  name: string;
};

type UserTableFlags = {
  hasIsActive: boolean;
  hasIsEnabled: boolean;
  hasEnabled: boolean;
};

let userTableFlagsPromise: Promise<UserTableFlags> | null = null;

const getUserTableFlags = async (): Promise<UserTableFlags> => {
  if (!userTableFlagsPromise) {
    userTableFlagsPromise = (async () => {
      const pool = await getPool();
      const result = await pool.request().query<ColumnCheckRow>(`
        SELECT name
        FROM sys.columns
        WHERE object_id = OBJECT_ID(N'dbo.AspNetUsers')
          AND name IN ('IsActive', 'IsEnabled', 'Enabled')
      `);
      const names = new Set((result.recordset ?? []).map((row) => row.name));
      return {
        hasIsActive: names.has('IsActive'),
        hasIsEnabled: names.has('IsEnabled'),
        hasEnabled: names.has('Enabled'),
      };
    })();
  }
  return await userTableFlagsPromise;
};

export const findUserByWindowsIdentity = async (windowsUserName: string): Promise<UserRecord | null> => {
  const pool = await getPool();
  const flags = await getUserTableFlags();
  const activeClause = flags.hasIsActive
    ? 'AND IsActive = 1'
    : flags.hasIsEnabled
      ? 'AND IsEnabled = 1'
      : flags.hasEnabled
        ? 'AND Enabled = 1'
        : '';

  const request = pool.request();
  request.input('WindowsUserName', sql.NVarChar(450), windowsUserName);

  const result = await request.query<UserRecord>(`
    SELECT TOP 1
      Id,
      UserName,
      WindowsUserName
    FROM dbo.AspNetUsers
    WHERE WindowsUserName COLLATE Latin1_General_CI_AS
      = @WindowsUserName COLLATE Latin1_General_CI_AS
    ${activeClause}
  `);

  return result.recordset?.[0] ?? null;
};
