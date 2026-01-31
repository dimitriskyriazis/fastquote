import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/sql';
import { coerceRoles } from '../../../lib/roles';

type UserRecord = {
  Id: number;
  UserName: string | null;
  WindowsUserName: string | null;
  RoleName: string | null;
  SalesSeniorityName: string | null;
};

type ColumnCheckRow = {
  name: string;
};

export async function GET() {
  try {
    const pool = await getPool();
    const columnCheck = await pool.request().query<ColumnCheckRow>(`
      SELECT name
      FROM sys.columns
      WHERE object_id = OBJECT_ID(N'dbo.AspNetUserRoles')
        AND name IN ('UserId', 'RoleId', 'AspNetUsersID', 'AspNetRolesID')
    `);
    const columnNames = new Set((columnCheck.recordset ?? []).map((row) => row.name));
    const hasLegacy = columnNames.has('UserId') && columnNames.has('RoleId');
    const hasAspNet = columnNames.has('AspNetUsersID') && columnNames.has('AspNetRolesID');

    const request = pool.request();
    const joinSql = hasLegacy
      ? `
      LEFT JOIN dbo.AspNetUserRoles ur ON ur.UserId = u.Id
      LEFT JOIN dbo.AspNetRoles r ON r.Id = ur.RoleId
    `
      : hasAspNet
        ? `
      LEFT JOIN dbo.AspNetUserRoles ur ON ur.AspNetUsersID = u.Id
      LEFT JOIN dbo.AspNetRoles r ON r.Id = ur.AspNetRolesID
    `
        : `
      LEFT JOIN dbo.AspNetRoles r ON 1 = 0
    `;

    const query = `
      SELECT
        u.Id,
        u.UserName,
        u.WindowsUserName,
        r.Name AS RoleName,
        ss.Name AS SalesSeniorityName
      FROM dbo.AspNetUsers u
      ${joinSql}
      LEFT JOIN dbo.SalesSeniorities ss ON ss.ID = u.SalesSeniorityID
      ORDER BY
        CASE WHEN u.UserName IS NULL OR LTRIM(RTRIM(u.UserName)) = '' THEN 1 ELSE 0 END,
        u.UserName
    `;
    const result = await request.query<UserRecord>(query);
    const byId = new Map<number, {
      id: number;
      userName: string | null;
      windowsUserName: string | null;
      roles: Array<string | null>;
      salesSeniorityName: string | null;
    }>();

    (result.recordset ?? []).forEach((row) => {
      const existing = byId.get(row.Id) ?? {
        id: row.Id,
        userName: row.UserName ?? null,
        windowsUserName: row.WindowsUserName ?? null,
        roles: [],
        salesSeniorityName: row.SalesSeniorityName ?? null,
      };
      if (row.RoleName) {
        existing.roles.push(row.RoleName);
      }
      if (!existing.salesSeniorityName && row.SalesSeniorityName) {
        existing.salesSeniorityName = row.SalesSeniorityName;
      }
      byId.set(row.Id, existing);
    });

    const users = Array.from(byId.values()).map((user) => ({
      id: user.id,
      userName: user.userName,
      windowsUserName: user.windowsUserName,
      roles: coerceRoles(user.roles),
      salesSeniorityName: user.salesSeniorityName,
    }));
    return NextResponse.json({ ok: true, users });
  } catch (err) {
    console.error('Failed to load AspNetUsers', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
