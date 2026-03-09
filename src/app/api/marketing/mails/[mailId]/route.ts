import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";

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

    if ("description" in body) {
      request.input("description", sql.NVarChar(255), String(body.description ?? "").trim());
      sets.push("Description = @description");
    }
    if ("note" in body) {
      request.input("note", sql.NVarChar(sql.MAX), String(body.note ?? "").trim() || null);
      sets.push("Note = @note");
    }
    if ("date" in body) {
      const dateValue = body.date ? new Date(String(body.date)) : null;
      request.input("date", sql.DateTime2, dateValue);
      sets.push("[Date] = @date");
    }
    if ("isPresent" in body) {
      const v = body.isPresent === true || body.isPresent === 1 || body.isPresent === "true";
      request.input("isPresent", sql.Bit, v ? 1 : 0);
      sets.push("IsPresent = @isPresent");
    }

    if (sets.length === 0) {
      return NextResponse.json({ ok: false, error: "No fields to update" }, { status: 400 });
    }

    await request.query(`UPDATE dbo.Mails SET ${sets.join(", ")} WHERE ID = @mailId`);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
