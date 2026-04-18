import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../../../lib/sql";
import { requirePermission } from "../../../../../../../lib/authz";
import { resolveAuditUserId } from "../../../../../../../lib/auditTrail";
import { getRequestId } from "../../../../../../../lib/requestId";
import { logAddAuditDetails } from "../../../../../../../lib/mutationAudit";

type AddGroupsBody = {
  contactGroupIds?: Array<number | string>;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]/contact-groups/add');
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

    const body = (await req.json().catch(() => null)) as AddGroupsBody | null;
    const rawIds = Array.isArray(body?.contactGroupIds) ? body.contactGroupIds : [];
    const groupIds = rawIds
      .map((v) => (typeof v === "number" ? v : Number.parseInt(String(v), 10)))
      .filter((v) => Number.isFinite(v));

    if (groupIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No contact group IDs provided" }, { status: 400 });
    }

    const pool = await getPool();
    let added = 0;
    const addedGroupIds: number[] = [];

    for (const groupId of groupIds) {
      // Check if already assigned
      const checkReq = pool.request();
      checkReq.input("mailId", sql.Int, mailId);
      checkReq.input("groupId", sql.Int, groupId);
      const existing = await checkReq.query(`
        SELECT TOP 1 ID FROM dbo.MailContactGroups
        WHERE MailID = @mailId AND ContactGroupID = @groupId
      `);
      if ((existing.recordset?.length ?? 0) > 0) continue;

      const insertReq = pool.request();
      insertReq.input("mailId", sql.Int, mailId);
      insertReq.input("groupId", sql.Int, groupId);
      await insertReq.query(`
        INSERT INTO dbo.MailContactGroups (ContactGroupID, MailID)
        VALUES (@groupId, @mailId)
      `);
      added++;
      addedGroupIds.push(groupId);
    }

    if (addedGroupIds.length > 0) {
      logAddAuditDetails({
        endpoint: '/api/marketing/mails/[mailId]/contact-groups/add',
        method: 'POST',
        requestId,
        userId: auditUserId,
        targetEntity: 'mailContactGroups',
        createdRows: addedGroupIds.map((groupId) => ({
          id: groupId,
          name: null,
          mailId,
        })),
        message: `Contact groups added to mail ID ${mailId}`,
      });
    }

    return NextResponse.json({ ok: true, added });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
