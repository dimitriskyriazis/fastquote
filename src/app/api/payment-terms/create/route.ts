import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { requirePermission } from "../../../../lib/authz";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { logAddAuditDetails } from "../../../../lib/mutationAudit";
import { handleApiError, createErrorResponse } from "../../../../lib/errorHandler";

// maxLength is always passed explicitly by the callers below: Name is NVARCHAR(512)
// and the descriptions are NVARCHAR(500), so the 255 default would silently truncate.
const normalizeTextValue = (value: unknown, maxLength = 255): string | null => {
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

export async function POST(req: NextRequest) {
  logRequest(req, '/api/payment-terms/create');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  // Hoisted so the duplicate-name branch in the catch can name the term.
  let name: string | null = null;
  try {
    const auth = await requirePermission(req, 'manageCustomerPaymentTerms');
    if (!auth.ok) return auth.response;

    const payload = (await req.json().catch(() => null)) as
      | { name?: unknown; descriptionGR?: unknown; descriptionEN?: unknown; enabled?: unknown }
      | null;
    if (!payload) {
      return NextResponse.json({ ok: false, error: 'Missing payload' }, { status: 400 });
    }

    name = normalizeTextValue(payload.name, 512);
    if (!name) {
      return NextResponse.json({ ok: false, error: 'Payment term name is required.' }, { status: 400 });
    }
    // Both descriptions are required: the columns are NVARCHAR(500) NOT NULL with no
    // default (a null bind raises SQL 515) and they are what actually prints.
    const descriptionGR = normalizeTextValue(payload.descriptionGR, 500);
    if (!descriptionGR) {
      return NextResponse.json({ ok: false, error: 'Greek description is required.' }, { status: 400 });
    }
    const descriptionEN = normalizeTextValue(payload.descriptionEN, 500);
    if (!descriptionEN) {
      return NextResponse.json({ ok: false, error: 'English description is required.' }, { status: 400 });
    }
    const enabled = normalizeBoolean(payload.enabled ?? true);

    const pool = await getPool();
    const insertRequest = pool.request();
    insertRequest.input('name', sql.NVarChar(512), name);
    insertRequest.input('descriptionGR', sql.NVarChar(500), descriptionGR);
    insertRequest.input('descriptionEN', sql.NVarChar(500), descriptionEN);
    insertRequest.input('enabled', sql.Bit, enabled ? 1 : 0);
    insertRequest.input('__userId', sql.NVarChar(450), userId ?? null);
    const insertResult = await insertRequest.query<{ ID: number; Name: string | null }>(`
      INSERT INTO dbo.PaymentTerms
        (Name, DescriptionGR, DescriptionEN, Enabled, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
      OUTPUT inserted.ID, inserted.Name
      VALUES (@name, @descriptionGR, @descriptionEN, @enabled,
              SYSUTCDATETIME(), @__userId, SYSUTCDATETIME(), @__userId)
    `);
    const insertedRow = insertResult.recordset?.[0] ?? null;
    const termId = insertedRow?.ID ?? null;
    if (termId == null) {
      throw new Error('Unable to create payment term.');
    }

    // Re-read in the grid's exact column shape, including both id aliases so the row
    // keys the same way a grid read would (AgGridAll's getRowId probes plain ID).
    const selectRequest = pool.request();
    selectRequest.input('termId', sql.Int, termId);
    const selectResult = await selectRequest.query<{
      PaymentTermID: number;
      ID: number;
      Name: string | null;
      DescriptionGR: string | null;
      DescriptionEN: string | null;
      CustomerCount: number;
      Enabled: boolean | number | null;
    }>(`
      SELECT
        ID AS PaymentTermID,
        ID AS ID,
        Name,
        DescriptionGR,
        DescriptionEN,
        0 AS CustomerCount,
        Enabled
      FROM dbo.PaymentTerms
      WHERE ID = @termId
    `);
    const paymentTerm = selectResult.recordset?.[0];
    if (!paymentTerm) {
      throw new Error('Unable to load created payment term.');
    }

    logAddAuditDetails({
      endpoint: '/api/payment-terms/create',
      method: 'POST',
      requestId,
      userId,
      targetEntity: 'paymentTerms',
      createdRows: [{ id: termId, name: insertedRow?.Name?.trim() || name }],
      message: 'Payment term created',
    });

    return NextResponse.json({ ok: true, paymentTerm });
  } catch (err) {
    // UQ_PaymentTerms_Name, and the collation is Greek_CI_AS so 'other' collides with
    // 'OTHER'. This runs before handleApiError, which masks the message in production.
    const sqlNumber = (err as { number?: number } | null)?.number;
    if (sqlNumber === 2627 || sqlNumber === 2601) {
      return await createErrorResponse(`A payment term named "${name}" already exists.`, 409,
        { requestId, endpoint: '/api/payment-terms/create', method: 'POST', userId });
    }
    return handleApiError(err, { requestId, endpoint: '/api/payment-terms/create', method: 'POST', userId });
  }
}
