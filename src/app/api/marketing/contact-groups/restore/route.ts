import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

type RestoreRow = {
  ContactGroupID?: number | null;
  Description?: string | null;
  SalesDivisionID?: number | null;
  SalespersonID?: number | null;
  GroupImportance?: string | null;
  Note?: string | null;
  Enabled?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageMarketing");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { rows?: RestoreRow[] } | null;
    const rows = Array.isArray(body?.rows) ? body.rows : [];
    if (rows.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows to restore" }, { status: 400 });
    }

    const pool = await getPool();
    let restored = 0;

    for (const row of rows) {
      const request = pool.request();
      request.input("Description", sql.NVarChar(sql.MAX), row.Description ?? null);
      request.input("SalesDivisionID", sql.Int, row.SalesDivisionID ?? null);
      request.input("SalespersonID", sql.Int, row.SalespersonID ?? null);
      request.input("GroupImportance", sql.NVarChar(255), row.GroupImportance ?? null);
      request.input("Note", sql.NVarChar(sql.MAX), row.Note ?? null);
      request.input("Enabled", sql.Bit, row.Enabled ? 1 : 0);

      await request.query(`
        INSERT INTO dbo.ContactGroups (Description, SalesDivisionID, SalespersonID, GroupImportance, Note, Enabled, TotalCount)
        VALUES (@Description, @SalesDivisionID, @SalespersonID, @GroupImportance, @Note, @Enabled, 0)
      `);
      restored++;
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore contact groups", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
