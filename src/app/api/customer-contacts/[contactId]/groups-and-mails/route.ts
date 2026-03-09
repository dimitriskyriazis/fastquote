import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  logRequest(req, '/api/customer-contacts/[contactId]/groups-and-mails');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { contactId: rawId } = await params;
    const contactId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(contactId)) {
      return NextResponse.json({ ok: false, error: "Invalid contact ID" }, { status: 400 });
    }

    const pool = await getPool();

    // Get contact's group memberships
    const groupsReq = pool.request();
    groupsReq.input("contactId", sql.Int, contactId);
    const groupsResult = await groupsReq.query(`
      SELECT
        cgl.ID AS ContactGroupListID,
        cg.ID AS ContactGroupID,
        cg.Description,
        cgl.Importance,
        cgl.Note
      FROM dbo.ContactsGroupLists cgl
      INNER JOIN dbo.ContactGroups cg ON cg.ID = cgl.ContactGroupID
      WHERE cgl.ContactID = @contactId
      ORDER BY cg.Description
    `);

    // Get contact's mail memberships
    const mailsReq = pool.request();
    mailsReq.input("contactId", sql.Int, contactId);
    const mailsResult = await mailsReq.query(`
      SELECT
        mc.ID AS MailContactID,
        m.ID AS MailID,
        m.Description,
        mc.Note
      FROM dbo.MailContacts mc
      INNER JOIN dbo.Mails m ON m.ID = mc.MailID
      WHERE mc.ContactID = @contactId
      ORDER BY m.Date DESC
    `);

    return NextResponse.json({
      ok: true,
      groups: groupsResult.recordset ?? [],
      mails: mailsResult.recordset ?? [],
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  logRequest(req, '/api/customer-contacts/[contactId]/groups-and-mails');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    await params;

    const body = (await req.json().catch(() => null)) as {
      type?: 'group' | 'mail';
      id?: number | string;
    } | null;

    if (!body?.type || !body?.id) {
      return NextResponse.json({ ok: false, error: "Missing type or id" }, { status: 400 });
    }

    const id = Number(body.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("id", sql.Int, id);

    if (body.type === 'group') {
      await request.query(`DELETE FROM dbo.ContactsGroupLists WHERE ID = @id`);
    } else if (body.type === 'mail') {
      await request.query(`DELETE FROM dbo.MailContacts WHERE ID = @id`);
    } else {
      return NextResponse.json({ ok: false, error: "Invalid type" }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  logRequest(req, '/api/customer-contacts/[contactId]/groups-and-mails');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { contactId: rawId } = await params;
    const contactId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(contactId)) {
      return NextResponse.json({ ok: false, error: "Invalid contact ID" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as {
      type?: 'group' | 'mail';
      targetId?: number | string;
    } | null;

    if (!body?.type || !body?.targetId) {
      return NextResponse.json({ ok: false, error: "Missing type or targetId" }, { status: 400 });
    }

    const targetId = Number(body.targetId);
    if (!Number.isFinite(targetId)) {
      return NextResponse.json({ ok: false, error: "Invalid targetId" }, { status: 400 });
    }

    const pool = await getPool();

    if (body.type === 'group') {
      // Check duplicate
      const checkReq = pool.request();
      checkReq.input("contactId", sql.Int, contactId);
      checkReq.input("groupId", sql.Int, targetId);
      const existing = await checkReq.query(`
        SELECT TOP 1 ID FROM dbo.ContactsGroupLists
        WHERE ContactID = @contactId AND ContactGroupID = @groupId
      `);
      if ((existing.recordset?.length ?? 0) > 0) {
        return NextResponse.json({ ok: false, error: "Contact already in this group" }, { status: 400 });
      }

      const insertReq = pool.request();
      insertReq.input("contactId", sql.Int, contactId);
      insertReq.input("groupId", sql.Int, targetId);
      await insertReq.query(`
        INSERT INTO dbo.ContactsGroupLists (ContactID, ContactGroupID)
        VALUES (@contactId, @groupId)
      `);
    } else if (body.type === 'mail') {
      // Check duplicate
      const checkReq = pool.request();
      checkReq.input("contactId", sql.Int, contactId);
      checkReq.input("mailId", sql.Int, targetId);
      const existing = await checkReq.query(`
        SELECT TOP 1 ID FROM dbo.MailContacts
        WHERE ContactID = @contactId AND MailID = @mailId
      `);
      if ((existing.recordset?.length ?? 0) > 0) {
        return NextResponse.json({ ok: false, error: "Contact already in this mail" }, { status: 400 });
      }

      const insertReq = pool.request();
      insertReq.input("contactId", sql.Int, contactId);
      insertReq.input("mailId", sql.Int, targetId);
      await insertReq.query(`
        INSERT INTO dbo.MailContacts (ContactID, MailID)
        VALUES (@contactId, @mailId)
      `);
    } else {
      return NextResponse.json({ ok: false, error: "Invalid type" }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
