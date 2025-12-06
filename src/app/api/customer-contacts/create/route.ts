import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";

const normalizeString = (value: unknown, maxLength = 500): string | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  const coerced = String(value);
  const trimmed = coerced.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeId = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeBoolean = (value: unknown): boolean => {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(lowered)) return true;
    if (["false", "no", "n"].includes(lowered)) return false;
  }
  return false;
};

const resolveEmailStatusId = async (
  pool: sql.ConnectionPool,
  statusName: string | null,
): Promise<number | null> => {
  if (!statusName) return null;
  const request = pool.request();
  request.input("statusName", sql.NVarChar, statusName);
  const result = await request.query<{ ID: number }>(`
    SELECT TOP 1 ID
    FROM dbo.EmailStatuses
    WHERE Name = @statusName
    ORDER BY ID
  `);
  return result.recordset?.[0]?.ID ?? null;
};

const ensureCustomerExists = async (pool: sql.ConnectionPool, customerId: number): Promise<boolean> => {
  const request = pool.request();
  request.input("customerId", sql.Int, customerId);
  const result = await request.query<{ ID: number }>(`
    SELECT TOP 1 ID
    FROM dbo.Customers
    WHERE ID = @customerId
  `);
  return result.recordset?.length > 0;
};

const ensureTitleExists = async (pool: sql.ConnectionPool, titleId: number): Promise<boolean> => {
  const request = pool.request();
  request.input("titleId", sql.Int, titleId);
  const result = await request.query<{ ID: number }>(`
    SELECT TOP 1 ID
    FROM dbo.Titles
    WHERE ID = @titleId
  `);
  return result.recordset?.length > 0;
};

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json().catch(() => null)) as
      | {
          customerId?: unknown;
          titleId?: unknown;
          lastName?: unknown;
          firstName?: unknown;
          position?: unknown;
          email?: unknown;
          emailStatus?: unknown;
          secondEmail?: unknown;
          secondEmailStatus?: unknown;
          phone?: unknown;
          mobile?: unknown;
          importance?: unknown;
          enabled?: unknown;
          notes?: unknown;
        }
      | null;

    if (!payload) {
      return NextResponse.json({ ok: false, error: "Missing payload" }, { status: 400 });
    }

    const customerId = normalizeId(payload.customerId);
    if (customerId == null) {
      return NextResponse.json({ ok: false, error: "Customer is required." }, { status: 400 });
    }

    const titleId = normalizeId(payload.titleId);
    if (titleId == null) {
      return NextResponse.json({ ok: false, error: "Title is required." }, { status: 400 });
    }

    const lastName = normalizeString(payload.lastName, 120);
    if (!lastName) {
      return NextResponse.json({ ok: false, error: "Last name is required." }, { status: 400 });
    }

    const firstName = normalizeString(payload.firstName, 120);
    if (!firstName) {
      return NextResponse.json({ ok: false, error: "First name is required." }, { status: 400 });
    }

    const importance = normalizeString(payload.importance, 50);
    if (!importance) {
      return NextResponse.json({ ok: false, error: "Importance is required." }, { status: 400 });
    }

    const position = normalizeString(payload.position, 255);
    const email = normalizeString(payload.email, 320);
    const secondEmail = normalizeString(payload.secondEmail, 320);
    const phone = normalizeString(payload.phone, 120);
    const mobile = normalizeString(payload.mobile, 120);
    const emailStatus = normalizeString(payload.emailStatus, 128);
    const secondEmailStatus = normalizeString(payload.secondEmailStatus, 128);
    const notes = normalizeString(payload.notes, 2000);
    const enabledValue = normalizeBoolean(payload.enabled ?? true);

    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);

    const customerExists = await ensureCustomerExists(pool, customerId);
    if (!customerExists) {
      return NextResponse.json({ ok: false, error: "Customer not found." }, { status: 404 });
    }

    const titleExists = await ensureTitleExists(pool, titleId);
    if (!titleExists) {
      return NextResponse.json({ ok: false, error: "Title not found." }, { status: 400 });
    }

    const emailStatusId = await resolveEmailStatusId(pool, emailStatus);
    if (emailStatus && emailStatusId == null) {
      return NextResponse.json(
        { ok: false, error: `Email status "${emailStatus}" not found.` },
        { status: 400 },
      );
    }

    const secondEmailStatusId = await resolveEmailStatusId(pool, secondEmailStatus);
    if (secondEmailStatus && secondEmailStatusId == null) {
      return NextResponse.json(
        { ok: false, error: `Second email status "${secondEmailStatus}" not found.` },
        { status: 400 },
      );
    }

    const insertRequest = pool.request();
    insertRequest.input("customerId", sql.Int, customerId);
    insertRequest.input("titleId", sql.Int, titleId);
    insertRequest.input("firstName", sql.NVarChar(120), firstName);
    insertRequest.input("lastName", sql.NVarChar(120), lastName);
    insertRequest.input("position", sql.NVarChar(255), position);
    insertRequest.input("importance", sql.NVarChar(50), importance);
    insertRequest.input("enabled", sql.Bit, enabledValue ? 1 : 0);
    insertRequest.input("phone", sql.NVarChar(120), phone);
    insertRequest.input("mobile", sql.NVarChar(120), mobile);
    insertRequest.input("email", sql.NVarChar(320), email);
    insertRequest.input("emailStatusId", sql.Int, emailStatusId);
    insertRequest.input("secondEmail", sql.NVarChar(320), secondEmail);
    insertRequest.input("secondEmailStatusId", sql.Int, secondEmailStatusId);
    insertRequest.input("notes", sql.NVarChar(2000), notes);
    insertRequest.input("createdBy", sql.NVarChar(450), auditUserId ?? null);
    insertRequest.input("modifiedBy", sql.NVarChar(450), auditUserId ?? null);

    const insertResult = await insertRequest.query<{ ContactID: number }>(`
      INSERT INTO dbo.Contacts (
        CustomerID,
        TitleID,
        FirstName,
        LastName,
        Position,
        Importance,
        Enabled,
        Phone,
        Mobile,
        Email,
        EmailStatusID,
        SecondEmail,
        SecondEmailStatusID,
        Notes,
        CreatedOn,
        CreatedBy,
        ModifiedOn,
        ModifiedBy
      )
      OUTPUT INSERTED.ID AS ContactID
      VALUES (
        @customerId,
        @titleId,
        @firstName,
        @lastName,
        @position,
        @importance,
        @enabled,
        @phone,
        @mobile,
        @email,
        @emailStatusId,
        @secondEmail,
        @secondEmailStatusId,
        @notes,
        SYSUTCDATETIME(),
        @createdBy,
        SYSUTCDATETIME(),
        @modifiedBy
      );
    `);

    const createdId = insertResult.recordset?.[0]?.ContactID ?? null;
    if (createdId == null) {
      throw new Error("Unable to create contact.");
    }

    return NextResponse.json({ ok: true, contactId: createdId });
  } catch (err) {
    console.error("Failed to create contact", err);
    const message = err instanceof Error ? err.message : "Failed to create contact.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
