import { NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';

type ContactRow = {
  ContactID: number;
  FirstName: string | null;
  LastName: string | null;
  FullName: string | null;
};

const normalizeCustomerId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ customerId: string }> },
) {
  try {
    const { customerId } = await params;
    const normalized = normalizeCustomerId(decodeURIComponent(customerId ?? ''));
    if (!normalized) {
      return NextResponse.json({ ok: false, error: 'Invalid customer id' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('customerId', sql.Int, normalized);
    const result = await request.query<ContactRow>(`
      SELECT
        cnt.ID AS ContactID,
        cnt.FirstName,
        cnt.LastName,
        LTRIM(RTRIM(CONCAT(
          ISNULL(cnt.FirstName, ''),
          CASE WHEN cnt.FirstName IS NOT NULL AND cnt.LastName IS NOT NULL THEN ' ' ELSE '' END,
          ISNULL(cnt.LastName, '')
        ))) AS FullName
      FROM dbo.Contacts AS cnt
      WHERE cnt.CustomerID = @customerId
      ORDER BY cnt.LastName, cnt.FirstName
    `);

    const contacts = (result.recordset ?? []).map((contact) => {
      const full = contact.FullName?.trim();
      const fallback = [contact.FirstName, contact.LastName]
        .map((value) => value?.trim())
        .filter(Boolean)
        .join(' ');
      return {
        ContactID: contact.ContactID,
        FirstName: contact.FirstName,
        LastName: contact.LastName,
        FullName: full && full.length > 0 ? full : (fallback || 'Contact'),
      };
    });

    return NextResponse.json({ ok: true, contacts });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
