import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";
import { getRequestId } from "../../../../../lib/requestId";
import { logEditAuditDetails } from "../../../../../lib/mutationAudit";

type MailHeader = {
  MailID: number;
  Date: string | null;
  Description: string | null;
  Note: string | null;
  UsedForFax: boolean | number | null;
  IsPresent: boolean | number | null;
  Locked: boolean | number | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]');
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
    const result = await request.query<MailHeader>(`
      SELECT
        ID AS MailID,
        Date,
        Description,
        Note,
        UsedForFax,
        IsPresent,
        Locked
      FROM dbo.Mails
      WHERE ID = @mailId
    `);

    const row = result.recordset?.[0];
    if (!row) {
      return NextResponse.json({ ok: false, error: "Mail not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, mail: row });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ mailId: string }> },
) {
  logRequest(req, '/api/marketing/mails/[mailId]');
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

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    }

    const pool = await getPool();
    const sets: string[] = [];
    const request = pool.request();
    request.input("mailId", sql.Int, mailId);
    const changes: Array<{
      targetId: number;
      targetName: string | null;
      field: string;
      before: unknown;
      after: unknown;
    }> = [];

    if ("description" in body) {
      const val = String(body.description ?? "").trim();
      request.input("description", sql.NVarChar(255), val);
      sets.push("Description = @description");
      changes.push({ targetId: mailId, targetName: null, field: 'Description', before: null, after: val });
    }
    if ("note" in body) {
      const val = String(body.note ?? "").trim() || null;
      request.input("note", sql.NVarChar(sql.MAX), val);
      sets.push("Note = @note");
      changes.push({ targetId: mailId, targetName: null, field: 'Note', before: null, after: val });
    }
    if ("date" in body) {
      const dateValue = body.date ? new Date(String(body.date)) : null;
      request.input("date", sql.DateTime2, dateValue);
      sets.push("[Date] = @date");
      changes.push({ targetId: mailId, targetName: null, field: 'Date', before: null, after: dateValue });
    }
    if ("isPresent" in body) {
      const v = body.isPresent === true || body.isPresent === 1 || body.isPresent === "true";
      request.input("isPresent", sql.Bit, v ? 1 : 0);
      sets.push("IsPresent = @isPresent");
      changes.push({ targetId: mailId, targetName: null, field: 'IsPresent', before: null, after: v });
    }

    if (sets.length === 0) {
      return NextResponse.json({ ok: false, error: "No fields to update" }, { status: 400 });
    }

    await request.query(`UPDATE dbo.Mails SET ${sets.join(", ")} WHERE ID = @mailId`);

    logEditAuditDetails({
      endpoint: '/api/marketing/mails/[mailId]',
      method: 'PATCH',
      requestId,
      userId: auditUserId,
      targetEntity: 'mails',
      targetIds: [mailId],
      changes,
      message: 'Mail updated',
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
