import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { logRequest } from '../../../../lib/apiHelpers';
import { getPool } from '../../../../lib/sql';
import { requirePermission } from '../../../../lib/authz';
import { getRequestId } from '../../../../lib/requestId';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { logEditAuditDetails } from '../../../../lib/mutationAudit';

// Bulk-set Customers.PaymentTermID from the customers grid.
//
// Gated by 'manageCustomerPaymentTerms' (Administrator + Developer only), the
// same permission that guards the single-customer PATCH and the /payment-terms
// catalogue. Payment terms are a commercial commitment, so this deliberately
// does NOT ride on 'manageCustomersContacts', which every role from Simple User
// up already holds.
type BulkBody = {
  customerIds?: unknown;
  paymentTermId?: unknown;   // null / omitted clears the term
};

// A right-click on a hand-made selection. Anything larger is a filter-wide
// "select all", which is never a deliberate gesture for a commercial field.
const MAX_BULK = 500;

export async function PATCH(req: NextRequest) {
  logRequest(req, '/api/customers/payment-term');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const auth = await requirePermission(req, 'manageCustomerPaymentTerms');
    if (!auth.ok) return auth.response;

    let body: BulkBody | null = null;
    try {
      body = (await req.json()) as BulkBody;
    } catch {
      body = null;
    }

    const rawIds = Array.isArray(body?.customerIds) ? body!.customerIds : [];
    const customerIds = Array.from(new Set(
      rawIds
        .map((v) => Number(v))
        .filter((v) => Number.isInteger(v) && v > 0),
    ));

    if (customerIds.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'No customers selected.' },
        { status: 400 },
      );
    }
    if (customerIds.length > MAX_BULK) {
      return NextResponse.json(
        { ok: false, error: `Too many customers selected (${customerIds.length}); the limit is ${MAX_BULK}.` },
        { status: 400 },
      );
    }

    const rawTerm = body?.paymentTermId;
    const paymentTermId = rawTerm === null || rawTerm === undefined || rawTerm === ''
      ? null
      : Number(rawTerm);
    if (paymentTermId !== null && !Number.isInteger(paymentTermId)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid payment term.' },
        { status: 400 },
      );
    }

    const pool = await getPool();

    // Validate before writing. The FK only checks existence, so a disabled term
    // would slip through, and a bad id would surface as a raw 547 -> 500.
    let termName: string | null = null;
    if (paymentTermId !== null) {
      const check = await pool.request()
        .input('termId', sql.Int, paymentTermId)
        .query<{ ID: number; Name: string }>(
          'SELECT TOP 1 ID, Name FROM dbo.PaymentTerms WHERE ID = @termId AND ISNULL(Enabled, 0) = 1',
        );
      const row = check.recordset?.[0];
      if (!row) {
        return NextResponse.json(
          { ok: false, error: 'Unknown or disabled payment term.' },
          { status: 400 },
        );
      }
      termName = row.Name;
    }

    // Refuse to write to a record the app does not treat as an assignable
    // customer: a disabled row or an IsParent group header. Payment terms belong
    // on the invoiced customer.
    const request = pool.request();
    const placeholders = customerIds
      .map((id, i) => { request.input(`id${i}`, sql.Int, id); return `@id${i}`; })
      .join(', ');
    request.input('termId', sql.Int, paymentTermId);
    request.input('modifiedBy', sql.NVarChar(450), userId);

    const result = await request.query<{ ID: number }>(`
      UPDATE dbo.Customers
      SET PaymentTermID = @termId,
          ModifiedBy    = COALESCE(@modifiedBy, ModifiedBy),
          ModifiedOn    = SYSUTCDATETIME()
      OUTPUT INSERTED.ID
      WHERE ID IN (${placeholders})
        AND ISNULL(Enabled, 0) = 1
        AND ISNULL(IsParent, 0) = 0
        AND ISNULL(PaymentTermID, -1) <> ISNULL(@termId, -1);
    `);

    const updatedIds = (result.recordset ?? []).map((r) => r.ID);

    // One FieldChange per customer, so the audit names every record that moved
    // rather than a single lumped entry.
    logEditAuditDetails({
      endpoint: '/api/customers/payment-term',
      method: 'PATCH',
      requestId,
      userId,
      targetEntity: 'customers',
      targetIds: updatedIds,
      changes: updatedIds.map((id) => ({
        targetId: id,
        field: 'PaymentTermID',
        before: null,
        after: paymentTermId === null ? null : `${paymentTermId} (${termName})`,
      })),
      message: paymentTermId === null
        ? 'Customer payment terms cleared (bulk)'
        : 'Customer payment terms set (bulk)',
    });

    return NextResponse.json({
      ok: true,
      requested: customerIds.length,
      updated: updatedIds.length,
      skipped: customerIds.length - updatedIds.length,
      termId: paymentTermId,
      termName,
    });
  } catch (err) {
    console.error('Bulk payment-term update failed', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
