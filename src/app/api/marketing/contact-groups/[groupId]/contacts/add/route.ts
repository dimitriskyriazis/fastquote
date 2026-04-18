import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../../lib/sql";
import { requirePermission } from "../../../../../../../lib/authz";
import { resolveAuditUserId } from "../../../../../../../lib/auditTrail";
import { getRequestId } from "../../../../../../../lib/requestId";
import { logAddAuditDetails } from "../../../../../../../lib/mutationAudit";

type AddContactsBody = {
  contactIds?: Array<number | string>;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ groupId: string }> },
) {
  logRequest(req, '/api/marketing/contact-groups/[groupId]/contacts/add');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageMarketing");
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
    const addedContactIds: number[] = [];

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
      addedContactIds.push(contactId);
    }

    if (addedContactIds.length > 0) {
      logAddAuditDetails({
        endpoint: '/api/marketing/contact-groups/[groupId]/contacts/add',
        method: 'POST',
        requestId,
        userId: auditUserId,
        targetEntity: 'contactGroupMembers',
        createdRows: addedContactIds.map((contactId) => ({
          id: contactId,
          name: null,
          groupId,
        })),
        message: `Contacts added to contact group ID ${groupId}`,
      });
    }

    return NextResponse.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
