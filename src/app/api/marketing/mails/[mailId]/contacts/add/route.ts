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
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]/contacts/add');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { mailId: rawMailId } = await params;
    const mailId = Number.parseInt(rawMailId, 10);
    if (!Number.isFinite(mailId)) {
      return NextResponse.json({ ok: false, error: "Invalid mail ID" }, { status: 400 });
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
      checkReq.input("mailId", sql.Int, mailId);
      checkReq.input("contactId", sql.Int, contactId);
      const existing = await checkReq.query(`
        SELECT TOP 1 ID FROM dbo.MailContacts
        WHERE MailID = @mailId AND ContactID = @contactId
      `);
      if ((existing.recordset?.length ?? 0) > 0) continue;

      const insertReq = pool.request();
      insertReq.input("mailId", sql.Int, mailId);
      insertReq.input("contactId", sql.Int, contactId);
      await insertReq.query(`
        INSERT INTO dbo.MailContacts (ContactID, MailID)
        VALUES (@contactId, @mailId)
      `);
      added++;
      addedContactIds.push(contactId);
    }

    if (addedContactIds.length > 0) {
      logAddAuditDetails({
        endpoint: '/api/marketing/mails/[mailId]/contacts/add',
        method: 'POST',
        requestId,
        userId: auditUserId,
        targetEntity: 'mailContacts',
        createdRows: addedContactIds.map((contactId) => ({
          id: contactId,
          name: null,
          mailId,
        })),
        message: `Contacts added to mail ID ${mailId}`,
      });
    }

    return NextResponse.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
