import { NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../lib/sql";
import { requirePermission } from "../../../../lib/authz";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  filterModel?: Record<string, KnownFilterModel> | null;
};

type GridBody = {
  request?: GridRequest | null;
  fields?: string[] | null;
};

type RawRow = {
  UserID: number | null;
  UserName: string | null;
  FullName: string | null;
  FullNameGR: string | null;
  Email: string | null;
  SalesDivision: string | null;
  SalesSeniority: string | null;
  SignTitle: string | null;
  NameCode: string | null;
  WindowsUserName: string | null;
  RoleName: string | null;
};

type ColumnCheckRow = {
  name: string;
};

type TextFilterModel = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith";
  filter?: string;
};

type CompoundTextFilterModel = {
  filterType: "text";
  operator: "AND" | "OR";
  conditions: TextFilterModel[];
};

type SetFilterModel = {
  filterType: "set";
  values?: Array<string | number | boolean>;
};

type KnownFilterModel = TextFilterModel | CompoundTextFilterModel | SetFilterModel;

const normalizeText = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeRoles = (roles: string[]) => {
  const deduped = new Map<string, string>();
  roles.forEach((role) => {
    const trimmed = role.trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, trimmed);
  });
  return Array.from(deduped.values()).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: "base" }),
  );
};

const applyQuickFilter = (rows: Record<string, unknown>[], query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    return Object.values(row).some((value) => {
      if (value == null) return false;
      const text = String(value).toLowerCase();
      return text.includes(needle);
    });
  });
};

const applyTextCondition = (value: unknown, model: TextFilterModel): boolean => {
  const filterValue = String(model.filter ?? "").toLowerCase();
  if (!filterValue) return true;
  const text = String(value ?? "").toLowerCase();
  switch (model.type ?? "contains") {
    case "equals":
      return text === filterValue;
    case "notEqual":
      return text !== filterValue;
    case "startsWith":
      return text.startsWith(filterValue);
    case "endsWith":
      return text.endsWith(filterValue);
    case "contains":
    default:
      return text.includes(filterValue);
  }
};

const applyTextFilter = (value: unknown, model: TextFilterModel | CompoundTextFilterModel): boolean => {
  if ("operator" in model && Array.isArray(model.conditions)) {
    const operator = model.operator === "OR" ? "OR" : "AND";
    const conditionResults = model.conditions
      .map((condition) => applyTextCondition(value, condition));
    if (conditionResults.length === 0) return true;
    if (operator === "OR") {
      return conditionResults.some(Boolean);
    }
    return conditionResults.every(Boolean);
  }
  return applyTextCondition(value, model);
};

const applySetFilter = (value: unknown, model: SetFilterModel): boolean => {
  const values = Array.isArray(model.values) ? model.values : [];
  if (values.length === 0) return true;
  return values.some((candidate) => String(candidate) === String(value ?? ""));
};

const applyFilterModel = (
  rows: Record<string, unknown>[],
  filterModel?: Record<string, KnownFilterModel> | null,
) => {
  if (!filterModel || Object.keys(filterModel).length === 0) return rows;
  return rows.filter((row) => {
    return Object.entries(filterModel).every(([field, model]) => {
      const value = row[field];
      if (!model) return true;
      if (model.filterType === "text") {
        return applyTextFilter(value, model as TextFilterModel | CompoundTextFilterModel);
      }
      if (model.filterType === "set") {
        return applySetFilter(value, model as SetFilterModel);
      }
      return true;
    });
  });
};

const coerceNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const applySort = (rows: Record<string, unknown>[], sortModel?: GridRequest["sortModel"]) => {
  if (!sortModel || sortModel.length === 0) {
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const aFullName = String(a.FullName ?? "");
      const bFullName = String(b.FullName ?? "");
      const fullNameCmp = aFullName.localeCompare(bFullName, undefined, { sensitivity: "base" });
      if (fullNameCmp !== 0) return fullNameCmp;

      const aUserName = String(a.UserName ?? "");
      const bUserName = String(b.UserName ?? "");
      const userNameCmp = aUserName.localeCompare(bUserName, undefined, { sensitivity: "base" });
      if (userNameCmp !== 0) return userNameCmp;

      const av = a.UserID;
      const bv = b.UserID;
      const aNum = typeof av === "number" ? av : Number(av);
      const bNum = typeof bv === "number" ? bv : Number(bv);
      if (!Number.isFinite(aNum) && !Number.isFinite(bNum)) return 0;
      if (!Number.isFinite(aNum)) return 1;
      if (!Number.isFinite(bNum)) return -1;
      return aNum - bNum;
    });
    return sorted;
  }
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const entry of sortModel) {
      const key = entry.colId;
      const dir = entry.sort === "desc" ? -1 : 1;
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) continue;
      if (av == null) return 1 * dir;
      if (bv == null) return -1 * dir;
      const aNum = coerceNumber(av);
      const bNum = coerceNumber(bv);
      const useNumeric = key === "UserID" || (aNum != null && bNum != null);
      if (useNumeric) {
        if (aNum == null && bNum == null) continue;
        if (aNum == null) return 1 * dir;
        if (bNum == null) return -1 * dir;
        const cmp = aNum - bNum;
        if (cmp !== 0) return cmp * dir;
        continue;
      }
      const aText = String(av);
      const bText = String(bv);
      const cmp = aText.localeCompare(bText, undefined, { sensitivity: "base" });
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
  return sorted;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageUsers");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as GridBody | null;
    const request = body?.request ?? {};

    const pool = await getPool();
    const columnCheck = await pool.request().query<ColumnCheckRow>(`
      SELECT name
      FROM sys.columns
      WHERE object_id = OBJECT_ID(N'dbo.AspNetUserRoles')
        AND name IN ('UserId', 'RoleId', 'AspNetUsersID', 'AspNetRolesID')
    `);
    const columnNames = new Set((columnCheck.recordset ?? []).map((row) => row.name));
    const hasLegacy = columnNames.has("UserId") && columnNames.has("RoleId");
    const hasAspNet = columnNames.has("AspNetUsersID") && columnNames.has("AspNetRolesID");

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

    const result = await pool.request().query<RawRow>(`
      SELECT
        u.Id AS UserID,
        u.UserName,
        u.FullName,
        u.FullNameGR,
        u.Email,
        sd.Name AS SalesDivision,
        ss.Name AS SalesSeniority,
        u.SignTitle,
        u.NameCode,
        u.WindowsUserName,
        r.Name AS RoleName
      FROM dbo.AspNetUsers u
      ${joinSql}
      LEFT JOIN dbo.SalesSeniorities ss ON ss.ID = u.SalesSeniorityID
      LEFT JOIN dbo.SalesDivision sd ON sd.ID = u.SalesDivisionID
      ORDER BY u.FullName, u.UserName, u.Id
    `);

    const ordered: Array<{
      UserID: number;
      UserName: string | null;
      FullName: string | null;
      FullNameGR: string | null;
      Email: string | null;
      SalesDivision: string | null;
      SalesSeniority: string | null;
      SignTitle: string | null;
      NameCode: string | null;
      WindowsUserName: string | null;
      roles: string[];
    }> = [];
    const indexById = new Map<number, (typeof ordered)[number]>();

    for (const row of result.recordset ?? []) {
      const id = row.UserID;
      if (typeof id !== "number" || !Number.isFinite(id)) continue;
      let entry = indexById.get(id);
      if (!entry) {
        entry = {
          UserID: id,
          UserName: normalizeText(row.UserName),
          FullName: normalizeText(row.FullName),
          FullNameGR: normalizeText(row.FullNameGR),
          Email: normalizeText(row.Email),
          SalesDivision: normalizeText(row.SalesDivision),
          SalesSeniority: normalizeText(row.SalesSeniority),
          SignTitle: normalizeText(row.SignTitle),
          NameCode: normalizeText(row.NameCode),
          WindowsUserName: normalizeText(row.WindowsUserName),
          roles: [],
        };
        indexById.set(id, entry);
        ordered.push(entry);
      }
      const roleName = normalizeText(row.RoleName);
      if (roleName) {
        entry.roles.push(roleName);
      }
    }

    const rows = ordered.map((entry) => {
      const roles = normalizeRoles(entry.roles);
      return {
        UserID: entry.UserID,
        UserName: entry.UserName,
        FullName: entry.FullName,
        FullNameGR: entry.FullNameGR,
        Email: entry.Email,
        SalesDivision: entry.SalesDivision,
        SalesSeniority: entry.SalesSeniority,
        SignTitle: entry.SignTitle,
        NameCode: entry.NameCode,
        WindowsUserName: entry.WindowsUserName,
        Role1: roles[0] ?? "",
        Role2: roles[1] ?? "",
      };
    });

    const quickFiltered = request?.quickFilterText ? applyQuickFilter(rows, request.quickFilterText) : rows;
    const filtered = applyFilterModel(quickFiltered, request?.filterModel ?? null);
    const sorted = applySort(filtered, request?.sortModel);

    const startRow = request?.startRow ?? 0;
    const endRow = request?.endRow ?? startRow + 100;
    const pageSize = Math.max(1, endRow - startRow);
    const paged = sorted.slice(startRow, startRow + pageSize);

    return NextResponse.json({ ok: true, rows: paged, rowCount: sorted.length });
  } catch (err) {
    console.error("Failed to load users grid", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
