import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

type RestoreRow = {
  MailID?: number | null;
  Date?: string | null;
  Description?: string | null;
  Note?: string | null;
  UsedForFax?: boolean | number | null;
  IsPresent?: boolean | number | null;
  Locked?: boolean | number | null;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
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
      const dateValue = row.Date ? new Date(row.Date) : new Date();
      request.input("Date", sql.DateTime2, isNaN(dateValue.getTime()) ? new Date() : dateValue);
      request.input("Description", sql.NVarChar(sql.MAX), row.Description ?? null);
      request.input("Note", sql.NVarChar(sql.MAX), row.Note ?? null);
      request.input("UsedForFax", sql.Bit, row.UsedForFax ? 1 : 0);
      request.input("IsPresent", sql.Bit, row.IsPresent ? 1 : 0);
      request.input("Locked", sql.Bit, row.Locked ? 1 : 0);

      await request.query(`
        INSERT INTO dbo.Mails ([Date], Description, Note, UsedForFax, IsPresent, Locked)
        VALUES (@Date, @Description, @Note, @UsedForFax, @IsPresent, @Locked)
      `);
      restored++;
    }

    return NextResponse.json({ ok: true, restored });
  } catch (err) {
    console.error("Failed to restore mails", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
