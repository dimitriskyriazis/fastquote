import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { resolveAuditUserId } from '../../../lib/auditTrail';

type CreateTitleBody = {
  name?: unknown;
  enabled?: unknown;
  greek?: unknown;
  description?: unknown;
};

const normalizeString = (value: unknown, maxLength: number): string | null => {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  const coerced = String(value);
  const trimmed = coerced.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeBoolean = (value: unknown): boolean | null => {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return null;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/titles');
  try {
    const payload = (await req.json().catch(() => null)) as CreateTitleBody | null;
    const name = normalizeString(payload?.name, 512);
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 });
    }
    const enabled = normalizeBoolean(payload?.enabled);
    if (enabled === null) {
      return NextResponse.json({ ok: false, error: 'Enabled value is required' }, { status: 400 });
    }
    const greek = normalizeBoolean(payload?.greek);
    if (greek === null) {
      return NextResponse.json({ ok: false, error: 'Greek flag is required' }, { status: 400 });
    }
    const description = normalizeString(payload?.description, 2000);

    const pool = await getPool();
    const request = pool.request();
    request.input('__name', sql.NVarChar(512), name);
    request.input('__description', sql.NVarChar(2000), description ?? null);
    request.input('__greek', sql.Bit, greek ? 1 : 0);
    request.input('__enabled', sql.Bit, enabled ? 1 : 0);
    const auditUserId = resolveAuditUserId(req);
    request.input('__userId', sql.NVarChar(450), auditUserId ?? null);

    const result = await request.query<{ ID: number; Name: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, Name NVARCHAR(512));
      INSERT INTO dbo.Titles (
        [Name],
        [Description],
        [Greek],
        [Enabled],
        [CreatedOn],
        [CreatedBy],
        [ModifiedOn],
        [ModifiedBy]
      )
      OUTPUT INSERTED.ID, INSERTED.Name INTO @Inserted
      VALUES (
        @__name,
        @__description,
        @__greek,
        @__enabled,
        SYSUTCDATETIME(),
        @__userId,
        SYSUTCDATETIME(),
        @__userId
      );
      SELECT TOP 1 ID, Name FROM @Inserted;
    `);

    const inserted = result.recordset?.[0];
    if (!inserted || inserted.ID == null) {
      throw new Error('Unable to create title');
    }

    const option = {
      value: String(inserted.ID),
      label: inserted.Name?.trim() || name,
    };

    return NextResponse.json({ ok: true, option });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
