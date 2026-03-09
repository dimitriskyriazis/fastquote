import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { requirePermission } from "../../../../../lib/authz";
import { logAddAuditDetails } from "../../../../../lib/mutationAudit";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";

type CreateMailBody = {
  date?: string | null;
  description?: string | null;
  note?: string | null;
  usedForFax?: boolean | number | null;
  isPresent?: boolean | number | null;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "1") return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return true;
  }
  return false;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/marketing/mails/create');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as CreateMailBody | null;
    if (!body) {
      return NextResponse.json({ ok: false, error: "Invalid request body" }, { status: 400 });
    }

    const description = normalizeTextValue(body.description);
    if (!description) {
      return NextResponse.json({ ok: false, error: "Description is required" }, { status: 400 });
    }

    const dateValue = body.date ? new Date(String(body.date)) : new Date();
    const note = normalizeTextValue(body.note) || null;
    const usedForFax = normalizeBooleanInput(body.usedForFax);
    const isPresent = normalizeBooleanInput(body.isPresent);

    const pool = await getPool();
    const request = pool.request();
    request.input("date", sql.DateTime2, dateValue);
    request.input("description", sql.NVarChar(255), description);
    request.input("note", sql.NVarChar(sql.MAX), note);
    request.input("usedForFax", sql.Bit, usedForFax ? 1 : 0);
    request.input("isPresent", sql.Bit, isPresent ? 1 : 0);

    const result = await request.query<{ ID: number }>(`
      INSERT INTO dbo.Mails ([Date], Description, Note, UsedForFax, IsPresent, Locked)
      OUTPUT INSERTED.ID
      VALUES (@date, @description, @note, @usedForFax, @isPresent, 0)
    `);

    const mailId = result.recordset?.[0]?.ID;
    if (mailId == null) {
      return NextResponse.json({ ok: false, error: "Failed to create mail" }, { status: 500 });
    }

    const auditUserId = resolveAuditUserId(req);
    logAddAuditDetails({
      endpoint: "/api/marketing/mails/create",
      userId: auditUserId,
      targetEntity: "mails",
      createdRows: [{ id: mailId, name: description }],
      message: "Mail created",
    });

    return NextResponse.json({ ok: true, mailId });
  } catch (err) {
    console.error("Failed to create mail", err);
    const message = err instanceof Error ? err.message : "Unable to create mail.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
