import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql, { type ConnectionPool } from "mssql";
import { getPool } from "../../../lib/sql";
import { requirePermission } from "../../../lib/authz";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { logAddAuditDetails, logEditAuditDetails } from "../../../lib/mutationAudit";

type CreateBody = {
  userName?: unknown;
  windowsUserName?: unknown;
  role?: unknown;
  fullName?: unknown;
  fullNameGR?: unknown;
  email?: unknown;
  signTitle?: unknown;
  nameCode?: unknown;
  salesDivision?: unknown;
  salesSeniority?: unknown;
};

type UpdateInput = {
  UserID?: number | string | null;
  field?: string | null;
  value?: unknown;
  roles?: unknown;
};

type RoleSchema = {
  userColumn: "UserId" | "AspNetUsersID";
  roleColumn: "RoleId" | "AspNetRolesID";
};

type ColumnCheckRow = {
  name: string;
};

type EnabledColumn = "IsActive" | "IsEnabled" | "Enabled" | null;

const getEnabledColumn = async (pool: ConnectionPool): Promise<EnabledColumn> => {
  const result = await pool.request().query<ColumnCheckRow>(`
    SELECT name
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.AspNetUsers')
      AND name IN ('IsActive', 'IsEnabled', 'Enabled')
  `);
  const names = new Set((result.recordset ?? []).map((row) => row.name));
  if (names.has("IsActive")) return "IsActive";
  if (names.has("IsEnabled")) return "IsEnabled";
  if (names.has("Enabled")) return "Enabled";
  return null;
};

type UserTimestampSchema = {
  hasCreatedAt: boolean;
  hasModifiedAt: boolean;
  hasCreatedOn: boolean;
  hasModifiedOn: boolean;
};

class UserUpdateError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "UserUpdateError";
    this.status = status;
  }
}

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeRequiredString = (value: unknown): string | null => {
  const trimmed = normalizeOptionalString(value);
  return trimmed && trimmed.length > 0 ? trimmed : null;
};

const normalizeRoleNames = (value: unknown): string[] => {
  const raw = Array.isArray(value) ? value : [];
  const deduped = new Map<string, string>();
  raw.forEach((entry) => {
    if (typeof entry !== "string") return;
    const trimmed = entry.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, trimmed);
  });
  return Array.from(deduped.values());
};

const getRoleSchema = async (pool: ConnectionPool): Promise<RoleSchema> => {
  const columnCheck = await pool.request().query<ColumnCheckRow>(`
    SELECT name
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.AspNetUserRoles')
      AND name IN ('UserId', 'RoleId', 'AspNetUsersID', 'AspNetRolesID')
  `);
  const columnNames = new Set((columnCheck.recordset ?? []).map((row) => row.name));
  const hasLegacy = columnNames.has("UserId") && columnNames.has("RoleId");
  const hasAspNet = columnNames.has("AspNetUsersID") && columnNames.has("AspNetRolesID");
  if (hasLegacy) {
    return { userColumn: "UserId", roleColumn: "RoleId" };
  }
  if (hasAspNet) {
    return { userColumn: "AspNetUsersID", roleColumn: "AspNetRolesID" };
  }
  throw new Error("AspNetUserRoles schema not recognized.");
};

const getUserTimestampSchema = async (pool: ConnectionPool): Promise<UserTimestampSchema> => {
  const result = await pool.request().query<ColumnCheckRow>(`
    SELECT name
    FROM sys.columns
    WHERE object_id = OBJECT_ID(N'dbo.AspNetUsers')
      AND name IN ('CreatedAt', 'ModifiedAt', 'CreatedOn', 'ModifiedOn')
  `);

  const names = new Set((result.recordset ?? []).map((row) => row.name));
  return {
    hasCreatedAt: names.has("CreatedAt"),
    hasModifiedAt: names.has("ModifiedAt"),
    hasCreatedOn: names.has("CreatedOn"),
    hasModifiedOn: names.has("ModifiedOn"),
  };
};

const resolveRoleIds = async (pool: ConnectionPool, roleNames: string[]) => {
  if (roleNames.length === 0) return new Map<string, number>();
  const request = pool.request();
  const placeholders = roleNames.map((name, idx) => {
    const key = `role_${idx}`;
    request.input(key, sql.NVarChar, name);
    return `@${key}`;
  });
  const result = await request.query<{ Id: number; Name: string | null }>(`
    SELECT Id, Name
    FROM dbo.AspNetRoles
    WHERE Name IN (${placeholders.join(", ")})
  `);
  const byName = new Map<string, number>();
  (result.recordset ?? []).forEach((row) => {
    const name = row.Name?.trim();
    if (!name || row.Id == null) return;
    byName.set(name.toLowerCase(), row.Id);
  });
  return byName;
};

const loadUserRoleIds = async (pool: ConnectionPool, schema: RoleSchema, userId: number) => {
  const request = pool.request();
  request.input("userId", sql.Int, userId);
  const result = await request.query<{ RoleId: number }>(`
    SELECT ${schema.roleColumn} AS RoleId
    FROM dbo.AspNetUserRoles
    WHERE ${schema.userColumn} = @userId
  `);
  return (result.recordset ?? [])
    .map((row) => row.RoleId)
    .filter((id) => typeof id === "number" && Number.isFinite(id));
};

const replaceUserRoles = async (
  pool: ConnectionPool,
  schema: RoleSchema,
  userId: number,
  roleNames: string[],
) => {
  const normalized = normalizeRoleNames(roleNames).slice(0, 2);
  if (normalized.length === 0) {
    throw new UserUpdateError("At least one role is required.");
  }

  const roleIdMap = await resolveRoleIds(pool, normalized);
  const missing = normalized.filter((name) => !roleIdMap.has(name.toLowerCase()));
  if (missing.length > 0) {
    throw new UserUpdateError(`Role(s) not found: ${missing.join(", ")}`);
  }

  const desiredRoleIds = normalized
    .map((name) => roleIdMap.get(name.toLowerCase()))
    .filter((id): id is number => typeof id === "number");

  const existingRoleIds = await loadUserRoleIds(pool, schema, userId);
  const existingSet = new Set(existingRoleIds);
  const desiredSet = new Set(desiredRoleIds);

  const toRemove = existingRoleIds.filter((id) => !desiredSet.has(id));
  const toAdd = desiredRoleIds.filter((id) => !existingSet.has(id));

  for (const roleId of toRemove) {
    const request = pool.request();
    request.input("userId", sql.Int, userId);
    request.input("roleId", sql.Int, roleId);
    await request.query(`
      DELETE FROM dbo.AspNetUserRoles
      WHERE ${schema.userColumn} = @userId
        AND ${schema.roleColumn} = @roleId
    `);
  }

  for (const roleId of toAdd) {
    const request = pool.request();
    request.input("userId", sql.Int, userId);
    request.input("roleId", sql.Int, roleId);
    await request.query(`
      INSERT INTO dbo.AspNetUserRoles (${schema.userColumn}, ${schema.roleColumn})
      VALUES (@userId, @roleId)
    `);
  }
};

const findSalesDivisionId = async (pool: ConnectionPool, name: string): Promise<number | null> => {
  const request = pool.request();
  request.input("divisionName", sql.NVarChar, name);
  const result = await request.query<{ ID: number }>(`
    SELECT TOP 1 ID
    FROM dbo.SalesDivision
    WHERE Name = @divisionName
    ORDER BY ID
  `);
  return result.recordset?.[0]?.ID ?? null;
};

const findSalesSeniorityId = async (pool: ConnectionPool, name: string): Promise<number | null> => {
  const request = pool.request();
  request.input("seniorityName", sql.NVarChar, name);
  const result = await request.query<{ ID: number }>(`
    SELECT TOP 1 ID
    FROM dbo.SalesSeniorities
    WHERE Name = @seniorityName
    ORDER BY ID
  `);
  return result.recordset?.[0]?.ID ?? null;
};

const FIELD_COLUMN_MAP: Record<string, string> = {
  UserName: "UserName",
  FullName: "FullName",
  FullNameGR: "FullNameGR",
  Email: "Email",
  SignTitle: "SignTitle",
  NameCode: "NameCode",
  WindowsUserName: "WindowsUserName",
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/user-management');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageUsers");
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as CreateBody | null;
    const userName = normalizeRequiredString(payload?.userName);
    const windowsUserName = normalizeRequiredString(payload?.windowsUserName);
    const roleName = normalizeRequiredString(payload?.role);
    const fullName = normalizeRequiredString(payload?.fullName);

    if (!userName) {
      return NextResponse.json({ ok: false, error: "User name is required." }, { status: 400 });
    }
    if (!windowsUserName) {
      return NextResponse.json({ ok: false, error: "Windows user name is required." }, { status: 400 });
    }
    if (!roleName) {
      return NextResponse.json({ ok: false, error: "Role is required." }, { status: 400 });
    }
    if (!fullName) {
      return NextResponse.json({ ok: false, error: "Full name is required." }, { status: 400 });
    }

    const fullNameGR = normalizeOptionalString(payload?.fullNameGR);
    const email = normalizeOptionalString(payload?.email);
    const signTitle = normalizeOptionalString(payload?.signTitle);
    const nameCode = normalizeOptionalString(payload?.nameCode);
    const divisionName = normalizeOptionalString(payload?.salesDivision);
    const seniorityName = normalizeOptionalString(payload?.salesSeniority);

    const pool = await getPool();
    let divisionId: number | null = null;
    let seniorityId: number | null = null;
    if (divisionName) {
      divisionId = await findSalesDivisionId(pool, divisionName);
      if (divisionId == null) {
        return NextResponse.json(
          { ok: false, error: `Sales division "${divisionName}" not found.` },
          { status: 400 },
        );
      }
    }
    if (seniorityName) {
      seniorityId = await findSalesSeniorityId(pool, seniorityName);
      if (seniorityId == null) {
        return NextResponse.json(
          { ok: false, error: `Sales seniority "${seniorityName}" not found.` },
          { status: 400 },
        );
      }
    }

    const insertRequest = pool.request();
    insertRequest.input("userName", sql.NVarChar, userName);
    insertRequest.input("windowsUserName", sql.NVarChar, windowsUserName);
    insertRequest.input("fullName", sql.NVarChar, fullName);
    insertRequest.input("fullNameGR", sql.NVarChar, fullNameGR);
    insertRequest.input("email", sql.NVarChar, email);
    insertRequest.input("signTitle", sql.NVarChar, signTitle);
    insertRequest.input("nameCode", sql.NVarChar, nameCode);
    insertRequest.input("salesDivisionId", sql.Int, divisionId);
    insertRequest.input("salesSeniorityId", sql.Int, seniorityId);

    const [timestampSchema, enabledColumn] = await Promise.all([
      getUserTimestampSchema(pool),
      getEnabledColumn(pool),
    ]);
    if (enabledColumn) {
      insertRequest.input("enabled", sql.Bit, 1);
    }
    const insertColumns = [
      "UserName",
      "WindowsUserName",
      "FullName",
      "FullNameGR",
      "Email",
      "SignTitle",
      "NameCode",
      "SalesDivisionID",
      "SalesSeniorityID",
      ...(timestampSchema.hasCreatedAt ? ["CreatedAt"] : []),
      ...(timestampSchema.hasModifiedAt ? ["ModifiedAt"] : []),
      ...(timestampSchema.hasCreatedOn ? ["CreatedOn"] : []),
      ...(timestampSchema.hasModifiedOn ? ["ModifiedOn"] : []),
      ...(enabledColumn ? [enabledColumn] : []),
    ];
    const insertValues = [
      "@userName",
      "@windowsUserName",
      "@fullName",
      "@fullNameGR",
      "@email",
      "@signTitle",
      "@nameCode",
      "@salesDivisionId",
      "@salesSeniorityId",
      ...(timestampSchema.hasCreatedAt ? ["SYSUTCDATETIME()"] : []),
      ...(timestampSchema.hasModifiedAt ? ["SYSUTCDATETIME()"] : []),
      ...(timestampSchema.hasCreatedOn ? ["SYSUTCDATETIME()"] : []),
      ...(timestampSchema.hasModifiedOn ? ["SYSUTCDATETIME()"] : []),
      ...(enabledColumn ? ["@enabled"] : []),
    ];

    const insertResult = await insertRequest.query<{ ID: number }>(`
      INSERT INTO dbo.AspNetUsers (
        ${insertColumns.join(",\n        ")}
      )
      OUTPUT INSERTED.Id AS ID
      VALUES (
        ${insertValues.join(",\n        ")}
      )
    `);
    const newUserId = insertResult.recordset?.[0]?.ID ?? null;
    if (newUserId == null) {
      throw new Error("Unable to create user.");
    }

    const schema = await getRoleSchema(pool);
    const roleIds = await resolveRoleIds(pool, [roleName]);
    const roleId = roleIds.get(roleName.toLowerCase());
    if (!roleId) {
      return NextResponse.json(
        { ok: false, error: `Role "${roleName}" not found.` },
        { status: 400 },
      );
    }

    const roleInsert = pool.request();
    roleInsert.input("userId", sql.Int, newUserId);
    roleInsert.input("roleId", sql.Int, roleId);
    await roleInsert.query(`
      INSERT INTO dbo.AspNetUserRoles (${schema.userColumn}, ${schema.roleColumn})
      VALUES (@userId, @roleId)
    `);

    logAddAuditDetails({
      endpoint: '/api/user-management',
      method: 'POST',
      requestId,
      userId: auditUserId,
      targetEntity: 'users',
      createdRows: [{ id: newUserId, name: fullName || userName, userName, email }],
      message: 'User created',
    });

    return NextResponse.json({ ok: true, user: { id: newUserId } });
  } catch (err) {
    console.error("Failed to create user", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/user-management');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageUsers");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: UpdateInput[] } | null)?.updates)
      ? ((body as { updates?: UpdateInput[] }).updates ?? [])
      : [];

    const normalized = updates
      .map((entry) => {
        const userId = normalizeInt(entry?.UserID ?? null);
        if (userId == null) return null;
        const field = typeof entry?.field === "string" ? entry.field : null;
        const roles = normalizeRoleNames(entry?.roles);

        if (roles.length > 0 || field === "Role1" || field === "Role2") {
          const effectiveRoles = roles.length > 0 ? roles : normalizeRoleNames([entry?.value]);
          if (effectiveRoles.length === 0) {
            throw new UserUpdateError("At least one role is required.");
          }
          return { kind: "roles", userId, roles: effectiveRoles } as const;
        }

        if (!field) return null;

        if (field === "SalesDivision" || field === "SalesSeniority") {
          const value = normalizeOptionalString(entry?.value);
          return { kind: "lookup", userId, field, value } as const;
        }

        if (field === "Enabled") {
          const value = normalizeOptionalString(entry?.value);
          return { kind: "enabled", userId, value } as const;
        }

        if (FIELD_COLUMN_MAP[field]) {
          const value = normalizeOptionalString(entry?.value);
          if ((field === "UserName" || field === "WindowsUserName") && !value) {
            throw new UserUpdateError(
              `${field === "UserName" ? "User name" : "Windows user name"} is required.`,
            );
          }
          return { kind: "field", userId, field, value } as const;
        }

        return null;
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided." }, { status: 400 });
    }

    const pool = await getPool();
    const [schema, enabledCol] = await Promise.all([
      getRoleSchema(pool),
      getEnabledColumn(pool),
    ]);

    for (const update of normalized) {
      if (update.kind === "enabled") {
        if (!enabledCol) continue;
        const v = update.value?.toLowerCase() ?? "";
        const bitValue = (v === "yes" || v === "true" || v === "1") ? 1 : 0;
        const request = pool.request();
        request.input("userId", sql.Int, update.userId);
        request.input("enabled", sql.Bit, bitValue);
        await request.query(`
          UPDATE dbo.AspNetUsers
          SET ${enabledCol} = @enabled
          WHERE Id = @userId
        `);
        continue;
      }

      if (update.kind === "roles") {
        await replaceUserRoles(pool, schema, update.userId, update.roles);
        continue;
      }

      if (update.kind === "lookup") {
        if (update.field === "SalesDivision") {
          let divisionId: number | null = null;
          if (update.value) {
            divisionId = await findSalesDivisionId(pool, update.value);
            if (divisionId == null) {
              throw new UserUpdateError(`Sales division "${update.value}" not found.`);
            }
          }
          const request = pool.request();
          request.input("userId", sql.Int, update.userId);
          request.input("divisionId", sql.Int, divisionId);
          await request.query(`
            UPDATE dbo.AspNetUsers
            SET SalesDivisionID = @divisionId
            WHERE Id = @userId
          `);
          continue;
        }

        if (update.field === "SalesSeniority") {
          let seniorityId: number | null = null;
          if (update.value) {
            seniorityId = await findSalesSeniorityId(pool, update.value);
            if (seniorityId == null) {
              throw new UserUpdateError(`Sales seniority "${update.value}" not found.`);
            }
          }
          const request = pool.request();
          request.input("userId", sql.Int, update.userId);
          request.input("seniorityId", sql.Int, seniorityId);
          await request.query(`
            UPDATE dbo.AspNetUsers
            SET SalesSeniorityID = @seniorityId
            WHERE Id = @userId
          `);
        }
        continue;
      }

      const column = FIELD_COLUMN_MAP[update.field];
      const request = pool.request();
      request.input("userId", sql.Int, update.userId);
      request.input("value", sql.NVarChar, update.value ?? null);
      await request.query(`
        UPDATE dbo.AspNetUsers
        SET ${column} = @value
        WHERE Id = @userId
      `);
    }

    const targetIds = Array.from(new Set(normalized.map((u) => u.userId)));
    const changes = normalized.map((u) => {
      if (u.kind === 'roles') {
        return {
          targetId: u.userId,
          targetName: null,
          field: 'Roles',
          before: null,
          after: u.roles.join(', '),
        };
      }
      if (u.kind === 'enabled') {
        return {
          targetId: u.userId,
          targetName: null,
          field: 'Enabled',
          before: null,
          after: u.value,
        };
      }
      if (u.kind === 'lookup') {
        return {
          targetId: u.userId,
          targetName: null,
          field: u.field,
          before: null,
          after: u.value,
        };
      }
      return {
        targetId: u.userId,
        targetName: null,
        field: u.field,
        before: null,
        after: u.value,
      };
    });
    logEditAuditDetails({
      endpoint: '/api/user-management',
      method: 'PATCH',
      requestId,
      userId: auditUserId,
      targetEntity: 'users',
      targetIds,
      changes,
      message: 'User fields updated',
    });

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    if (err instanceof UserUpdateError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Server error";
    console.error("Failed to update user", err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
