import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { logEditAuditDetails } from "../../../../lib/mutationAudit";
import { requirePermission } from "../../../../lib/authz";

type RestoreRow = {
  Name?: string | null;
};

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "manageCitiesCountries");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { rows?: RestoreRow[] } | null;
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows to restore" }, { status: 400 });
    }

    const pool = await getPool();
    const userId = resolveAuditUserId(req);
    let restored = 0;
    const restoredRows: Array<{ id: number; name: string }> = [];

    for (const row of rows) {
      if (!row.Name?.trim()) continue;
      const request = pool.request();
      const name = row.Name.trim();
      request.input("Name", sql.NVarChar(512), name);
      request.input("UserId", sql.NVarChar(450), userId ?? null);

      const result = await request.query<{ ID: number }>(`
        INSERT INTO dbo.Countries ([Name], [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy], [Enabled])
        OUTPUT INSERTED.ID
        VALUES (@Name, SYSUTCDATETIME(), @UserId, SYSUTCDATETIME(), @UserId, 1)
      `);
      const insertedId = result.recordset?.[0]?.ID;
      if (insertedId != null) {
        restoredRows.push({ id: insertedId, name });
      }
      restored++;
    }

    if (restoredRows.length > 0) {
      logEditAuditDetails({
        endpoint: '/api/countries-cities/restore',
        method: 'POST',
        requestId,
        userId,
        targetEntity: 'countries',
        targetIds: restoredRows.map((r) => r.id),
        changes: restoredRows.map((r) => ({
          targetId: r.id,
          targetName: r.name,
          field: 'Deleted',
          before: true,
          after: false,
        })),
        message: 'Countries restored',
      });
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore countries", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
