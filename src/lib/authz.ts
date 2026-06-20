import { NextRequest, NextResponse } from 'next/server';
import { getSessionUserId } from './session';
import { getPool, sql } from './sql';
import { coerceRoles, roleHasPermission, type AppRole, type Permission } from './roles';

type RoleRow = {
  RoleName: string | null;
};

type ColumnCheckRow = {
  name: string;
};

const normalizeUserId = (value: string | null): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

export const fetchUserRoles = async (userId: string | null): Promise<AppRole[]> => {
  const normalized = normalizeUserId(userId);
  if (!normalized) return [];

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
  request.input('__userId', sql.NVarChar(450), normalized);

  const joinSql = hasLegacy
    ? `
      SELECT r.Name AS RoleName
      FROM dbo.AspNetUserRoles ur
      INNER JOIN dbo.AspNetRoles r ON r.Id = ur.RoleId
      WHERE ur.UserId = @__userId
    `
    : hasAspNet
      ? `
      SELECT r.Name AS RoleName
      FROM dbo.AspNetUserRoles ur
      INNER JOIN dbo.AspNetRoles r ON r.Id = ur.AspNetRolesID
      WHERE ur.AspNetUsersID = @__userId
    `
      : `
      SELECT NULL AS RoleName
      WHERE 1 = 0
    `;

  const result = await request.query<RoleRow>(joinSql);

  const rawRoles = (result.recordset ?? []).map((row) => row.RoleName ?? null);
  return coerceRoles(rawRoles);
};

export async function requirePermission(
  req: NextRequest,
  permission: Permission,
): Promise<{ ok: true; userId: string; roles: AppRole[] } | { ok: false; response: NextResponse }> {
  // Identity for authorization comes ONLY from the HMAC-signed session cookie.
  // Never trust headers / unsigned cookies / query params here — those are forgeable.
  const userId = normalizeUserId(getSessionUserId(req.cookies));

  if (!userId) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'Authentication required' },
        { status: 401 },
      ),
    };
  }

  const roles = await fetchUserRoles(userId);
  if (!roleHasPermission(roles, permission)) {
    return {
      ok: false,
      response: NextResponse.json(
        { ok: false, error: 'You do not have rights to perform this action', requiredPermission: permission },
        { status: 403 },
      ),
    };
  }

  return { ok: true, userId, roles };
}
