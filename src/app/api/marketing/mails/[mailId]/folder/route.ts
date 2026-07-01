import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import { logRequest } from '../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../lib/sql";
import { requirePermission } from "../../../../../../lib/authz";
import { buildMailFolderPath, buildMailFolderFileUrl } from "../../../../../../lib/mailsExportFolder";

export const runtime = "nodejs";

// Resolve the on-disk export folder for a mail list so the client can open it in Explorer.
// The folder is only created once the list has been exported at least once, so we also
// report whether it currently exists.
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]/folder');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { mailId: rawMailId } = await params;
    const mailId = Number.parseInt(rawMailId, 10);
    if (!Number.isFinite(mailId)) {
      return NextResponse.json({ ok: false, error: "Invalid mail ID" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("mailId", sql.Int, mailId);
    const result = await request.query<{ Description: string | null }>(
      `SELECT Description FROM dbo.Mails WHERE ID = @mailId`,
    );
    const mailRow = result.recordset?.[0];
    if (!mailRow) {
      return NextResponse.json({ ok: false, error: "Mail not found" }, { status: 404 });
    }

    const folder = buildMailFolderPath(mailId, mailRow.Description);
    const fileUrl = buildMailFolderFileUrl(folder);

    let exists = false;
    try {
      const stat = await fs.stat(folder);
      exists = stat.isDirectory();
    } catch {
      // ENOENT (never exported) or share unreachable — leave exists = false.
      exists = false;
    }

    return NextResponse.json({ ok: true, folder, fileUrl, exists });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
