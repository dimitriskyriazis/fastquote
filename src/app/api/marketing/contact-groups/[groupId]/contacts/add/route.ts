import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../../lib/sql";
import { requirePermission } from "../../../../../../../lib/authz";

type AddContactsBody = {
  contactIds?: Array<number | string>;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  logRequest(req, '/api/marketing/contact-groups/[groupId]/contacts/add');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { groupId: rawId } = await params;
    const groupId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(groupId)) {
      return NextResponse.json({ ok: false, error: "Invalid group ID" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as AddContactsBody | null;
    const rawIds = Array.isArray(body?.contactIds) ? body.contactIds : [];
    const contactIds = rawIds
      .map((v) => (typeof v === "number" ? v : Number.parseInt(String(v), 10)))
      .filter((v) => Number.isFinite(v));

    if (contactIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No contact IDs provided" }, { status: 400 });
    }

    const pool = await getPool();
    let added = 0;

    for (const contactId of contactIds) {
      const checkReq = pool.request();
      checkReq.input("groupId", sql.Int, groupId);
      checkReq.input("contactId", sql.Int, contactId);
      const existing = await checkReq.query(`
        SELECT TOP 1 ID FROM dbo.ContactsGroupLists
        WHERE ContactGroupID = @groupId AND ContactID = @contactId
      `);
      if ((existing.recordset?.length ?? 0) > 0) continue;

      const insertReq = pool.request();
      insertReq.input("groupId", sql.Int, groupId);
      insertReq.input("contactId", sql.Int, contactId);
      await insertReq.query(`
        INSERT INTO dbo.ContactsGroupLists (ContactID, ContactGroupID)
        VALUES (@contactId, @groupId)
      `);
      added++;
    }

    return NextResponse.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
