import { NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../lib/sql";
import { requirePermission } from "../../../../lib/authz";
import { sortRoleNames } from "../../../../lib/roles";

const normalizeList = (rows: Array<{ Name: string | null }>) => {
  const values = new Set<string>();
  rows.forEach((row) => {
    const name = row.Name?.trim();
    if (name) values.add(name);
  });
  return Array.from(values).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
};

const normalizeRoleList = (rows: Array<{ Name: string | null }>) => {
  const values = new Set<string>();
  rows.forEach((row) => {
    const name = row.Name?.trim();
    if (name) values.add(name);
  });
  return sortRoleNames(Array.from(values));
};

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageUsers");
    if (!auth.ok) return auth.response;

    const pool = await getPool();
    const [rolesResult, divisionsResult, senioritiesResult] = await Promise.all([
      pool.request().query<{ Name: string | null }>(`
        SELECT Name
        FROM dbo.AspNetRoles
        ORDER BY Name
      `),
      pool.request().query<{ Name: string | null }>(`
        SELECT Name
        FROM dbo.SalesDivision
        ORDER BY Name
      `),
      pool.request().query<{ Name: string | null }>(`
        SELECT Name
        FROM dbo.SalesSeniorities
        ORDER BY Name
      `),
    ]);

    return NextResponse.json({
      ok: true,
      roles: normalizeRoleList(rolesResult.recordset ?? []),
      salesDivisions: normalizeList(divisionsResult.recordset ?? []),
      salesSeniorities: normalizeList(senioritiesResult.recordset ?? []),
    });
  } catch (err) {
    console.error("Failed to load user-management options", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
