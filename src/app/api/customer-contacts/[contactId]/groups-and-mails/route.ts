import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";
import { getRequestId } from "../../../../../lib/requestId";
import { logEditAuditDetails } from "../../../../../lib/mutationAudit";

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

const EDITABLE_GROUP_FIELDS = new Set(["Importance", "Note"]);
const IMPORTANCE_VALUES = new Set(["High", "Med", "Low"]);

/**
 * Edit Importance / Note on one of this contact's group memberships.
 * Body: { type: 'group', id: ContactGroupListID, field: 'Importance' | 'Note', value }.
 * The UPDATE is scoped to ContactID so a membership row of another contact can
 * never be edited through this contact's URL.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  logRequest(req, '/api/customer-contacts/[contactId]/groups-and-mails');
  const requestId = await getRequestId(req);
  const auditUserId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { contactId: rawId } = await params;
    const contactId = Number.parseInt(rawId, 10);
    if (!Number.isFinite(contactId)) {
      return NextResponse.json({ ok: false, error: "Invalid contact ID" }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as {
      type?: string;
      id?: number | string;
      field?: string;
      value?: unknown;
    } | null;

    if (body?.type !== 'group') {
      return NextResponse.json({ ok: false, error: "Only group memberships can be edited" }, { status: 400 });
    }

    const id = Number(body.id);
    if (!Number.isFinite(id)) {
      return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
    }

    const field = String(body.field ?? "");
    if (!EDITABLE_GROUP_FIELDS.has(field)) {
      return NextResponse.json({ ok: false, error: "Invalid field" }, { status: 400 });
    }

    const trimmed = body.value == null ? "" : String(body.value).trim();
    const value = trimmed.length > 0 ? trimmed : null;
    if (field === "Importance" && value !== null && !IMPORTANCE_VALUES.has(value)) {
      return NextResponse.json({ ok: false, error: "Importance must be High, Med or Low" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("id", sql.Int, id);
    request.input("contactId", sql.Int, contactId);
    request.input("value", field === "Importance" ? sql.NVarChar(50) : sql.NVarChar(sql.MAX), value);
    // `field` is one of two literals validated above, so interpolating it is safe.
    const result = await request.query<{ Before: string | null; After: string | null }>(`
      UPDATE dbo.ContactsGroupLists
      SET ${field} = @value
      OUTPUT DELETED.${field} AS Before, INSERTED.${field} AS After
      WHERE ID = @id AND ContactID = @contactId
    `);
    const row = result.recordset?.[0];
    if (!row) {
      return NextResponse.json({ ok: false, error: "Group membership not found for this contact" }, { status: 404 });
    }

    logEditAuditDetails({
      endpoint: '/api/customer-contacts/[contactId]/groups-and-mails',
      method: 'PATCH',
      requestId,
      userId: auditUserId,
      targetEntity: 'contactGroupMembers',
      targetIds: [id],
      changes: [{ targetId: id, targetName: null, field, before: row.Before, after: row.After }],
      message: 'Contact group member fields updated',
    });

    return NextResponse.json({ ok: true, value: row.After });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
