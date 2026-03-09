import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../../lib/sql";
import { requirePermission } from "../../../../../../../lib/authz";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]/contact-groups/count');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    await params;

    const body = (await req.json().catch(() => null)) as { contactGroupId?: number | string } | null;
    const groupId = body?.contactGroupId != null ? Number(body.contactGroupId) : null;
    if (groupId == null || !Number.isFinite(groupId)) {
      return NextResponse.json({ ok: false, error: "Invalid contact group ID" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("groupId", sql.Int, groupId);

    const result = await request.query<{
      TotalCount: number;
      Importance1: number;
      Importance2: number;
      Importance3: number;
    }>(`
      SELECT
        COUNT(*) AS TotalCount,
        SUM(CASE WHEN Importance = 1 THEN 1 ELSE 0 END) AS Importance1,
        SUM(CASE WHEN Importance = 2 THEN 1 ELSE 0 END) AS Importance2,
        SUM(CASE WHEN Importance = 3 THEN 1 ELSE 0 END) AS Importance3
      FROM dbo.ContactsGroupLists
      WHERE ContactGroupID = @groupId
    `);

    const row = result.recordset?.[0];
    return NextResponse.json({
      ok: true,
      totalCount: row?.TotalCount ?? 0,
      importance1: row?.Importance1 ?? 0,
      importance2: row?.Importance2 ?? 0,
      importance3: row?.Importance3 ?? 0,
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
