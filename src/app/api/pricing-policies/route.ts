import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';

type CreatePricingPolicyBody = {
  name?: unknown;
  enabled?: unknown;
  calcMethodFormulasId?: unknown;
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

const normalizeInt = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return null;
};

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json().catch(() => null)) as CreatePricingPolicyBody | null;
    const name = normalizeString(payload?.name, 512);
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 });
    }
    const enabled = normalizeBoolean(payload?.enabled);
    if (enabled === null) {
      return NextResponse.json({ ok: false, error: 'Enabled value is required' }, { status: 400 });
    }
    const calcMethodFormulasId = normalizeInt(payload?.calcMethodFormulasId);
    if (calcMethodFormulasId == null) {
      return NextResponse.json(
        { ok: false, error: 'Calc method formula is required' },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('__name', sql.NVarChar(512), name);
    request.input('__enabled', sql.Bit, enabled ? 1 : 0);
    request.input('__calcId', sql.Int, calcMethodFormulasId);

    const result = await request.query<{ ID: number; Name: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, Name NVARCHAR(512));
      INSERT INTO dbo.PricingPolicies (
        [Name],
        [Enabled],
        [CalcMethodFormulasID]
      )
      OUTPUT INSERTED.ID, INSERTED.Name INTO @Inserted
      VALUES (@__name, @__enabled, @__calcId);
      SELECT TOP 1 ID, Name FROM @Inserted;
    `);

    const inserted = result.recordset?.[0];
    if (!inserted || inserted.ID == null) {
      throw new Error('Unable to create pricing policy');
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
