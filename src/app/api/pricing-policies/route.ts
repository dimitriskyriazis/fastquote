import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { requirePermission } from '../../../lib/authz';
import { checkDeletePermission } from '../../../lib/deletePermissions';
import { resolveAuditUserId } from '../../../lib/auditTrail';
import { getRequestId } from '../../../lib/requestId';
import { logAddAuditDetails, logDeleteAuditDetails } from '../../../lib/mutationAudit';

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
  logRequest(req, '/api/pricing-policies');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
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

    logAddAuditDetails({
      endpoint: '/api/pricing-policies',
      method: 'POST',
      requestId,
      userId,
      targetEntity: 'pricingPolicies',
      createdRows: [{ id: inserted.ID, name: inserted.Name?.trim() || name }],
      message: 'Pricing policy created',
    });

    return NextResponse.json({ ok: true, option });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/pricing-policies');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
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

    const deleteCheck = checkDeletePermission(auth.roles, ids.length, 'pricingPolicies', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const request = pool.request();
    const valuesSql = ids.map((_, idx) => `(@__id_${idx})`).join(', ');
    ids.forEach((id, idx) => request.input(`__id_${idx}`, sql.Int, id));

    const result = await request.query<{
      deletedPolicies: number | null;
      deletedRules: number | null;
      DeletedID: number | null;
      DeletedName: string | null;
    }>(`
      BEGIN TRY
        BEGIN TRAN;

        DECLARE @Ids TABLE (ID INT PRIMARY KEY);
        INSERT INTO @Ids (ID) VALUES ${valuesSql};

        DECLARE @DeletedRules INT = 0;
        DELETE r
        FROM dbo.PricingPolicyRules AS r
        INNER JOIN @Ids AS i ON i.ID = r.PricingPolicyID;
        SET @DeletedRules = @@ROWCOUNT;

        DECLARE @DeletedPoliciesTable TABLE (ID INT, Name NVARCHAR(512));
        DELETE p
        OUTPUT DELETED.ID, DELETED.Name INTO @DeletedPoliciesTable
        FROM dbo.PricingPolicies AS p
        INNER JOIN @Ids AS i ON i.ID = p.ID;

        DECLARE @DeletedPolicies INT = (SELECT COUNT(1) FROM @DeletedPoliciesTable);

        COMMIT;
        SELECT
          @DeletedPolicies AS deletedPolicies,
          @DeletedRules AS deletedRules,
          d.ID AS DeletedID,
          d.Name AS DeletedName
        FROM @DeletedPoliciesTable d;
      END TRY
      BEGIN CATCH
        IF @@TRANCOUNT > 0 ROLLBACK;
        THROW;
      END CATCH
    `);

    const rows = result.recordset ?? [];
    const deletedPolicies = Number(rows[0]?.deletedPolicies ?? 0);
    const deletedRules = Number(rows[0]?.deletedRules ?? 0);
    if (!Number.isFinite(deletedPolicies) || deletedPolicies <= 0) {
      return NextResponse.json(
        { ok: false, error: 'Pricing policy not found or could not be deleted' },
        { status: 404 },
      );
    }

    const deletedRows = rows
      .filter((row) => row.DeletedID != null)
      .map((row) => ({
        id: row.DeletedID as number,
        name: row.DeletedName?.trim() || null,
      }));

    logDeleteAuditDetails({
      endpoint: '/api/pricing-policies',
      requestId,
      userId,
      targetEntity: 'pricingPolicies',
      requestedIds: ids,
      deletedRows,
      message: 'Pricing policies deleted',
      extra: { deletedRules },
    });

    return NextResponse.json({ ok: true, deletedPolicies, deletedRules });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
