import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { logEditAuditDetails } from "../../../../lib/mutationAudit";
import { requirePermission } from "../../../../lib/authz";

type RestoreRow = {
  Name?: string | null;
  SalesDivisionID?: number | null;
  Enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
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
    const restoredRows: Array<{ id: number; name: string | null }> = [];

    for (const row of rows) {
      const request = pool.request();
      request.input("Name", sql.NVarChar(512), row.Name ?? null);
      request.input("SalesDivisionID", sql.Int, row.SalesDivisionID ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);
      request.input("UserId", sql.NVarChar(450), userId ?? null);

      const result = await request.query<{ ID: number }>(`
        INSERT INTO dbo.Markets (
          [Name], [SalesDivisionID], [Enabled],
          [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy]
        )
        OUTPUT INSERTED.ID
        VALUES (
          @Name, @SalesDivisionID, @Enabled,
          SYSUTCDATETIME(), @UserId, SYSUTCDATETIME(), @UserId
        )
      `);
      const insertedId = result.recordset?.[0]?.ID;
      if (insertedId != null) {
        restoredRows.push({ id: insertedId, name: row.Name?.trim() || null });
      }
      restored++;
    }

    if (restoredRows.length > 0) {
      logEditAuditDetails({
        endpoint: '/api/markets/restore',
        method: 'POST',
        requestId,
        userId,
        targetEntity: 'markets',
        targetIds: restoredRows.map((r) => r.id),
        changes: restoredRows.map((r) => ({
          targetId: r.id,
          targetName: r.name,
          field: 'Deleted',
          before: true,
          after: false,
        })),
        message: 'Markets restored',
      });
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore markets", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
