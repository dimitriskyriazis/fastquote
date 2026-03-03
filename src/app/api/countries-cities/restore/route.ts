import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";

type RestoreRow = {
  Name?: string | null;
};

export async function POST(req: NextRequest) {
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

    for (const row of rows) {
      if (!row.Name?.trim()) continue;
      const request = pool.request();
      request.input("Name", sql.NVarChar(512), row.Name.trim());
      request.input("UserId", sql.NVarChar(450), userId ?? null);

      await request.query(`
        INSERT INTO dbo.Countries ([Name], [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy], [Enabled])
        VALUES (@Name, SYSUTCDATETIME(), @UserId, SYSUTCDATETIME(), @UserId, 1)
      `);
      restored++;
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore countries", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
