import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';
import { requirePermission } from '../../../../../lib/authz';
import { resolveAuditUserId } from '../../../../../lib/auditTrail';
import { getRequestId } from '../../../../../lib/requestId';
import {
  logAddAuditDetails,
  logDeleteAuditDetails,
  logEditAuditDetails,
} from '../../../../../lib/mutationAudit';

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(_req, '/api/price-lists/[priceListId]/pricing-policies');
  try {
    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const parsedId = Number(normalizedId);
    if (!Number.isInteger(parsedId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('priceListId', sql.Int, parsedId);
    const result = await request.query<{
      ID: number;
      PriceListID: number;
      PricingPolicyID: number;
      PricingPolicyName: string | null;
    }>(`
      SELECT
        plpp.ID,
        plpp.PriceListID,
        plpp.PricingPolicyID,
        pp.Name AS PricingPolicyName
      FROM dbo.PriceListPricingPolicy AS plpp
      INNER JOIN dbo.PricingPolicies AS pp ON plpp.PricingPolicyID = pp.ID
      WHERE plpp.PriceListID = @priceListId
      ORDER BY pp.Name
    `);

    return NextResponse.json({
      ok: true,
      policies: (result.recordset ?? []).map((row) => ({
        id: row.ID,
        priceListId: row.PriceListID,
        pricingPolicyId: row.PricingPolicyID,
        pricingPolicyName: row.PricingPolicyName,
      })),
    });
  } catch (err) {
    console.error('Failed to fetch price list pricing policies', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

type AddPricingPolicyBody = {
  pricingPolicyId: number;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(req, '/api/price-lists/[priceListId]/pricing-policies');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const parsedId = Number(normalizedId);
    if (!Number.isInteger(parsedId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as AddPricingPolicyBody | null;
    const pricingPolicyId = normalizeInt(body?.pricingPolicyId);
    if (pricingPolicyId == null) {
      return NextResponse.json({ ok: false, error: 'Pricing policy ID is required' }, { status: 400 });
    }
    const pool = await getPool();
    const request = pool.request();
    request.input('priceListId', sql.Int, parsedId);
    request.input('pricingPolicyId', sql.Int, pricingPolicyId);

    const result = await request.query<{ ID: number; PricingPolicyName: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, PricingPolicyID INT);
      INSERT INTO dbo.PriceListPricingPolicy (
        PriceListID,
        PricingPolicyID
      )
      OUTPUT INSERTED.ID, INSERTED.PricingPolicyID INTO @Inserted
      VALUES (@priceListId, @pricingPolicyId);

      SELECT TOP 1 i.ID, pp.Name AS PricingPolicyName
      FROM @Inserted i
      LEFT JOIN dbo.PricingPolicies pp ON pp.ID = i.PricingPolicyID;
    `);

    const inserted = result.recordset?.[0];
    if (!inserted || inserted.ID == null) {
      throw new Error('Unable to create price list pricing policy');
    }

    logAddAuditDetails({
      endpoint: '/api/price-lists/[priceListId]/pricing-policies',
      method: 'POST',
      requestId,
      userId,
      targetEntity: 'priceListPricingPolicies',
      createdRows: [
        {
          id: inserted.ID,
          name: inserted.PricingPolicyName?.trim() || `Policy ${pricingPolicyId}`,
        },
      ],
      message: 'Price list pricing policy added',
      extra: { priceListId: parsedId, pricingPolicyId },
    });

    return NextResponse.json({ ok: true, id: inserted.ID });
  } catch (err) {
    console.error('Failed to add price list pricing policy', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

type UpdatePricingPolicyBody = {
  pricingPolicyId: number;
};

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(req, '/api/price-lists/[priceListId]/pricing-policies');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const parsedId = Number(normalizedId);
    if (!Number.isInteger(parsedId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    const url = new URL(req.url);
    const policyId = normalizeInt(url.searchParams.get('policyId'));
    if (policyId == null) {
      return NextResponse.json({ ok: false, error: 'Policy ID is required' }, { status: 400 });
    }

    const body = (await req.json().catch(() => null)) as UpdatePricingPolicyBody | null;
    const pricingPolicyId = normalizeInt(body?.pricingPolicyId);
    if (pricingPolicyId == null) {
      return NextResponse.json({ ok: false, error: 'Pricing policy ID is required' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('priceListId', sql.Int, parsedId);
    request.input('policyId', sql.Int, policyId);
    request.input('pricingPolicyId', sql.Int, pricingPolicyId);

    await request.query(`
      UPDATE dbo.PriceListPricingPolicy
      SET PricingPolicyID = @pricingPolicyId
      WHERE PriceListID = @priceListId
        AND ID = @policyId;
    `);

    logEditAuditDetails({
      endpoint: '/api/price-lists/[priceListId]/pricing-policies',
      method: 'PUT',
      requestId,
      userId,
      targetEntity: 'priceListPricingPolicies',
      targetIds: [policyId],
      changes: [
        {
          targetId: policyId,
          targetName: null,
          field: 'PricingPolicyID',
          before: null,
          after: pricingPolicyId,
        },
      ],
      message: 'Price list pricing policy updated',
      extra: { priceListId: parsedId },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Failed to update price list pricing policy', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(req, '/api/price-lists/[priceListId]/pricing-policies');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const parsedId = Number(normalizedId);
    if (!Number.isInteger(parsedId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    const url = new URL(req.url);
    const policyId = normalizeInt(url.searchParams.get('policyId'));
    if (policyId == null) {
      return NextResponse.json({ ok: false, error: 'Policy ID is required' }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('priceListId', sql.Int, parsedId);
    request.input('policyId', sql.Int, policyId);

    const result = await request.query<{ ID: number; PricingPolicyName: string | null }>(`
      DECLARE @Deleted TABLE (ID INT, PricingPolicyID INT);
      DELETE FROM dbo.PriceListPricingPolicy
      OUTPUT DELETED.ID, DELETED.PricingPolicyID INTO @Deleted
      WHERE PriceListID = @priceListId
        AND ID = @policyId;

      SELECT d.ID, pp.Name AS PricingPolicyName
      FROM @Deleted d
      LEFT JOIN dbo.PricingPolicies pp ON pp.ID = d.PricingPolicyID;
    `);

    const deletedRows = (result.recordset ?? []).map((row) => ({
      id: row.ID,
      name: row.PricingPolicyName?.trim() || null,
    }));

    logDeleteAuditDetails({
      endpoint: '/api/price-lists/[priceListId]/pricing-policies',
      requestId,
      userId,
      targetEntity: 'priceListPricingPolicies',
      requestedIds: [policyId],
      deletedRows,
      message: 'Price list pricing policy removed',
      extra: { priceListId: parsedId },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Failed to delete price list pricing policy', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
