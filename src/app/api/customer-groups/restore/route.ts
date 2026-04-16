import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { buildAuditContext } from "../../../../lib/auditTrail";
import { fetchUserRoles } from "../../../../lib/authz";
import { checkDeletePermission } from "../../../../lib/deletePermissions";

type RestoreRow = {
  CustomerGroupID?: number | null;
  Name?: string | null;
  Code?: string | null;
  Enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  try {
    const audit = buildAuditContext(req);
    const roles = await fetchUserRoles(audit.userId);

    const deleteCheck = checkDeletePermission(roles, 1, 'generic', 'manageCustomersContacts');
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as { rows?: RestoreRow[] } | null;
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows to restore" }, { status: 400 });
    }

    const pool = await getPool();
    let restored = 0;

    for (const row of rows) {
      const request = pool.request();
      request.input("Name", sql.NVarChar(255), row.Name ?? null);
      request.input("Code", sql.NVarChar(255), row.Code ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);

      await request.query(`
        INSERT INTO dbo.CustomerGroups (Name, Code, Enabled)
        VALUES (@Name, @Code, @Enabled)
      `);
      restored++;
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore customer groups", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
