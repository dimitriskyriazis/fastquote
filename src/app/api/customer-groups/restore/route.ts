import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { buildAuditContext, resolveAuditUserId } from "../../../../lib/auditTrail";
import { fetchUserRoles } from "../../../../lib/authz";
import { checkDeletePermission } from "../../../../lib/deletePermissions";
import { getRequestId } from "../../../../lib/requestId";
import { logEditAuditDetails, type FieldChange } from "../../../../lib/mutationAudit";

type RestoreRow = {
  CustomerGroupID?: number | null;
  Name?: string | null;
  Code?: string | null;
  Enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
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
    const restoredRows: Array<{ id: number; name: string | null }> = [];

    for (const row of rows) {
      const request = pool.request();
      request.input("Name", sql.NVarChar(255), row.Name ?? null);
      request.input("Code", sql.NVarChar(255), row.Code ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);

      const result = await request.query<{ ID: number; Name: string | null }>(`
        INSERT INTO dbo.CustomerGroups (Name, Code, Enabled)
        OUTPUT inserted.ID, inserted.Name
        VALUES (@Name, @Code, @Enabled)
      `);
      const inserted = result.recordset?.[0];
      if (inserted?.ID != null) {
        restoredRows.push({ id: inserted.ID, name: inserted.Name ?? row.Name ?? null });
      }
      restored++;
    }

    if (restoredRows.length > 0) {
      const changes: FieldChange[] = restoredRows.map((row) => ({
        targetId: row.id,
        targetName: row.name,
        field: 'Deleted',
        before: true,
        after: false,
      }));
      logEditAuditDetails({
        endpoint: '/api/customer-groups/restore',
        method: 'POST',
        requestId,
        userId,
        targetEntity: 'customerGroups',
        targetIds: restoredRows.map((row) => row.id),
        changes,
        message: 'Customer group restored',
      });
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore customer groups", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
