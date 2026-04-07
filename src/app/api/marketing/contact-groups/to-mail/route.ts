import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

type ToMailBody = {
  contactGroupId?: number | string;
  mailId?: number | string;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/contact-groups/to-mail');
  try {
    const auth = await requirePermission(req, "manageMarketing");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as ToMailBody | null;
    const contactGroupId = Number(body?.contactGroupId);
    const mailId = Number(body?.mailId);

    if (!Number.isFinite(contactGroupId) || !Number.isFinite(mailId)) {
      return NextResponse.json({ ok: false, error: "Invalid group or mail ID" }, { status: 400 });
    }

    const pool = await getPool();

    // Add all contacts from the group to the mail (skip duplicates)
    const request = pool.request();
    request.input("groupId", sql.Int, contactGroupId);
    request.input("mailId", sql.Int, mailId);
    const result = await request.query(`
      INSERT INTO dbo.MailContacts (ContactID, MailID)
      SELECT cgl.ContactID, @mailId
      FROM dbo.ContactsGroupLists cgl
      WHERE cgl.ContactGroupID = @groupId
        AND cgl.ContactID NOT IN (
          SELECT ContactID FROM dbo.MailContacts WHERE MailID = @mailId
        )
    `);

    const added = result.rowsAffected?.[0] ?? 0;

    // Also add the contact group to the mail's contact groups (if not already)
    const checkGroupReq = pool.request();
    checkGroupReq.input("groupId", sql.Int, contactGroupId);
    checkGroupReq.input("mailId", sql.Int, mailId);
    const existingGroup = await checkGroupReq.query(`
      SELECT TOP 1 ID FROM dbo.MailContactGroups
      WHERE ContactGroupID = @groupId AND MailID = @mailId
    `);
    if ((existingGroup.recordset?.length ?? 0) === 0) {
      const addGroupReq = pool.request();
      addGroupReq.input("groupId", sql.Int, contactGroupId);
      addGroupReq.input("mailId", sql.Int, mailId);
      await addGroupReq.query(`
        INSERT INTO dbo.MailContactGroups (ContactGroupID, MailID)
        VALUES (@groupId, @mailId)
      `);
    }

    return NextResponse.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
