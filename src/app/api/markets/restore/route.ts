import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";

type RestoreRow = {
  Name?: string | null;
  SalesDivisionID?: number | null;
  Enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageMarkets");
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
      const request = pool.request();
      request.input("Name", sql.NVarChar(512), row.Name ?? null);
      request.input("SalesDivisionID", sql.Int, row.SalesDivisionID ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);
      request.input("UserId", sql.NVarChar(450), userId ?? null);

      await request.query(`
        INSERT INTO dbo.Markets (
          [Name], [SalesDivisionID], [Enabled],
          [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy]
        ) VALUES (
          @Name, @SalesDivisionID, @Enabled,
          SYSUTCDATETIME(), @UserId, SYSUTCDATETIME(), @UserId
        )
      `);
      restored++;
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore markets", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
