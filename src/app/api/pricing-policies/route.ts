import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { requirePermission } from '../../../lib/authz';

type CreatePricingPolicyBody = {
  name?: unknown;
  enabled?: unknown;
};

type DeletePricingPolicyBody = {
  pricingPolicyId?: unknown;
  pricingPolicyIds?: unknown;
  ids?: unknown;
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

const normalizeIntArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const ids = value
    .map((entry) => normalizeInt(entry))
    .filter((id): id is number => id != null && Number.isFinite(id) && id > 0);
  return Array.from(new Set(ids));
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "managePricingPolicies");
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as CreatePricingPolicyBody | null;
    const name = normalizeString(payload?.name, 512);
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Name is required' }, { status: 400 });
    }
    const enabled = normalizeBoolean(payload?.enabled);
    if (enabled === null) {
      return NextResponse.json({ ok: false, error: 'Enabled value is required' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('__name', sql.NVarChar(512), name);
    request.input('__enabled', sql.Bit, enabled ? 1 : 0);

    const result = await request.query<{ ID: number; Name: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, Name NVARCHAR(512));
      INSERT INTO dbo.PricingPolicies (
        [Name],
        [Enabled]
      )
      OUTPUT INSERTED.ID, INSERTED.Name INTO @Inserted
      VALUES (@__name, @__enabled);
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

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "managePricingPolicies");
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as DeletePricingPolicyBody | null;
    const singleId = normalizeInt(payload?.pricingPolicyId);
    const listIds = normalizeIntArray(payload?.pricingPolicyIds ?? payload?.ids);
    const ids = singleId != null ? [singleId] : listIds;
    if (!ids || ids.length === 0) {
      return NextResponse.json({ ok: false, error: 'Pricing policy ID is required' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    const valuesSql = ids.map((_, idx) => `(@__id_${idx})`).join(', ');
    ids.forEach((id, idx) => request.input(`__id_${idx}`, sql.Int, id));

    const result = await request.query<{ deletedPolicies: number | null; deletedRules: number | null }>(`
      BEGIN TRY
        BEGIN TRAN;

        DECLARE @Ids TABLE (ID INT PRIMARY KEY);
        INSERT INTO @Ids (ID) VALUES ${valuesSql};

        DECLARE @DeletedRules INT = 0;
        DELETE r
        FROM dbo.PricingPolicyRules AS r
        INNER JOIN @Ids AS i ON i.ID = r.PricingPolicyID;
        SET @DeletedRules = @@ROWCOUNT;

        DECLARE @DeletedPolicies INT = 0;
        DELETE p
        FROM dbo.PricingPolicies AS p
        INNER JOIN @Ids AS i ON i.ID = p.ID;
        SET @DeletedPolicies = @@ROWCOUNT;

        COMMIT;
        SELECT @DeletedPolicies AS deletedPolicies, @DeletedRules AS deletedRules;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

    const deletedPolicies = Number(result.recordset?.[0]?.deletedPolicies ?? 0);
    const deletedRules = Number(result.recordset?.[0]?.deletedRules ?? 0);
    if (!Number.isFinite(deletedPolicies) || deletedPolicies <= 0) {
      return NextResponse.json(
        { ok: false, error: 'Pricing policy not found or could not be deleted' },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true, deletedPolicies, deletedRules });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
