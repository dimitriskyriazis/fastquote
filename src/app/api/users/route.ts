import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import { getPool } from '../../../lib/sql';
import { coerceRoles } from '../../../lib/roles';
import { getSessionUserId } from '../../../lib/session';

type UserRecord = {
  Id: number;
  FullName: string | null;
  UserName: string | null;
  WindowsUserName: string | null;
  RoleName: string | null;
  SalesSeniorityName: string | null;
};

type ColumnCheckRow = {
  name: string;
};

export async function GET(req: NextRequest) {
  logRequest(req, '/api/users');
  if (!getSessionUserId(req.cookies)) {
    return NextResponse.json({ ok: false, error: 'Authentication required' }, { status: 401 });
  }
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
        u.FullName,
        u.UserName,
        u.WindowsUserName,
        r.Name AS RoleName,
        ss.Name AS SalesSeniorityName
      FROM dbo.AspNetUsers u
      ${joinSql}
      LEFT JOIN dbo.SalesSeniorities ss ON ss.ID = u.SalesSeniorityID
      ORDER BY
        CASE WHEN u.FullName IS NULL OR LTRIM(RTRIM(u.FullName)) = '' THEN 1 ELSE 0 END,
        COALESCE(NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserName)
    `;
    const result = await request.query<UserRecord>(query);
    const byId = new Map<number, {
      id: number;
      fullName: string | null;
      userName: string | null;
      windowsUserName: string | null;
      roles: Array<string | null>;
      salesSeniorityName: string | null;
    }>();

    (result.recordset ?? []).forEach((row) => {
      const existing = byId.get(row.Id) ?? {
        id: row.Id,
        fullName: row.FullName ?? null,
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
      fullName: user.fullName,
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
