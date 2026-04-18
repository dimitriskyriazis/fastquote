import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { logEditAuditDetails } from "../../../../lib/mutationAudit";
import { requirePermission } from "../../../../lib/authz";

type RestoreRow = {
  Name?: string | null;
  Comment?: string | null;
  SoftOneID?: number | null;
  SoftOneCode?: string | null;
  AVC4Name?: string | null;
  Enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
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
      request.input("Name", sql.NVarChar(255), row.Name ?? null);
      request.input("Comment", sql.NVarChar(2000), row.Comment ?? null);
      request.input("SoftOneID", sql.Int, row.SoftOneID ?? null);
      request.input("SoftOneCode", sql.NVarChar(255), row.SoftOneCode ?? null);
      request.input("AVC4Name", sql.NVarChar(255), row.AVC4Name ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);
      request.input("UserId", sql.NVarChar(450), userId ?? null);

      const result = await request.query<{ ID: number }>(`
        INSERT INTO dbo.Brands (
          [Name], [Comment], [SoftOneID], [SoftOneCode], [AVC4Name], [Enabled],
          [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy]
        )
        OUTPUT INSERTED.ID
        VALUES (
          @Name, @Comment, @SoftOneID, @SoftOneCode, @AVC4Name, @Enabled,
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
        endpoint: '/api/brands/restore',
        method: 'POST',
        requestId,
        userId,
        targetEntity: 'brands',
        targetIds: restoredRows.map((r) => r.id),
        changes: restoredRows.map((r) => ({
          targetId: r.id,
          targetName: r.name,
          field: 'Deleted',
          before: true,
          after: false,
        })),
        message: 'Brands restored',
      });
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore brands", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
