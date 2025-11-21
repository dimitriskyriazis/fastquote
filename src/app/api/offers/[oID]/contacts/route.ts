import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';
import { resolveAuditUserId } from '../../../../../lib/auditTrail';

type ContactRequestBody = {
  firstName?: string;
  lastName?: string;
  titleId?: number | string | null;
  position?: string;
  importance?: number | string | null;
  enabled?: boolean | number | string;
  phone?: string;
  mobile?: string;
  email?: string;
  emailStatusId?: number | string | null;
  secondEmail?: string;
  secondEmailStatusId?: number | string | null;
  notes?: string;
};

type CreatedContactRow = {
  ContactID: number;
  FirstName: string | null;
  LastName: string | null;
};

const normalizeString = (value: unknown, maxLength = 500): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeInt = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeBoolean = (value: unknown): boolean =>
  !(value === false || value === 'false' || value === 0 || value === '0');

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ oID: string }> },
) {
  try {
    const { oID } = await params;
    const normalizedId = decodeURIComponent(String(oID ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing offer id' }, { status: 400 });
    }
    const offerId = Number(normalizedId);
    if (!Number.isInteger(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid offer id' }, { status: 400 });
    }

    let body: ContactRequestBody | null = null;
    try {
      body = (await req.json()) as ContactRequestBody;
    } catch {
      body = null;
    }

    const firstName = normalizeString(body?.firstName, 120);
    const lastName = normalizeString(body?.lastName, 120);
    const titleId = normalizeInt(body?.titleId);
    const position = normalizeString(body?.position, 200);
    const importance = normalizeInt(body?.importance);
    const enabled = normalizeBoolean(body?.enabled ?? true);
    const phone = normalizeString(body?.phone, 120);
    const mobile = normalizeString(body?.mobile, 120);
    const email = normalizeString(body?.email, 320);
    const emailStatusId = normalizeInt(body?.emailStatusId);
    const secondEmail = normalizeString(body?.secondEmail, 320);
    const secondEmailStatusId = normalizeInt(body?.secondEmailStatusId);
    const notes = normalizeString(body?.notes, 2000);

    if (!firstName && !lastName) {
      return NextResponse.json(
        { ok: false, error: 'Please provide at least a first or last name.' },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const offerLookup = await pool
      .request()
      .input('offerId', sql.Int, offerId)
      .query<{ CustomerID: number | null }>(`
        SELECT o.CustomerID
        FROM dbo.Offer AS o
        WHERE o.ID = @offerId
      `);

    const customerId = offerLookup.recordset?.[0]?.CustomerID ?? null;
    if (!customerId) {
      return NextResponse.json(
        { ok: false, error: 'Customer not found for this offer.' },
        { status: 404 },
      );
    }

    const auditUserId = resolveAuditUserId(req);
    const request = pool.request();
    request.input('customerId', sql.Int, customerId);
    request.input('titleId', sql.Int, titleId);
    request.input('firstName', sql.NVarChar(255), firstName);
    request.input('lastName', sql.NVarChar(255), lastName);
    request.input('position', sql.NVarChar(255), position);
    request.input('importance', sql.Int, importance);
    request.input('enabled', sql.Bit, enabled ? 1 : 0);
    request.input('phone', sql.NVarChar(120), phone);
    request.input('mobile', sql.NVarChar(120), mobile);
    request.input('email', sql.NVarChar(320), email);
    request.input('emailStatusId', sql.Int, emailStatusId);
    request.input('secondEmail', sql.NVarChar(320), secondEmail);
    request.input('secondEmailStatusId', sql.Int, secondEmailStatusId);
    request.input('notes', sql.NVarChar(2000), notes);
    request.input('createdBy', sql.NVarChar(450), auditUserId);

    const insertResult = await request.query<CreatedContactRow>(`
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
        CreatedBy
      )
      OUTPUT INSERTED.ID AS ContactID, INSERTED.FirstName, INSERTED.LastName
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
        @createdBy
      );
    `);

    const created = insertResult.recordset?.[0];
    if (!created?.ContactID) {
      return NextResponse.json({ ok: false, error: 'Unable to create contact.' }, { status: 500 });
    }

    const fullName = [created.FirstName, created.LastName]
      .map((value) => value?.trim())
      .filter(Boolean)
      .join(' ');

    return NextResponse.json({
      ok: true,
      contact: {
        ContactID: created.ContactID,
        FirstName: created.FirstName ?? null,
        LastName: created.LastName ?? null,
        FullName: fullName || 'New Contact',
      },
    });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
