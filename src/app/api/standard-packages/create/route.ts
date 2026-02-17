import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { requirePermission } from '../../../../lib/authz';

type CreateStandardPackageRequest = {
  description?: unknown;
  comments?: unknown;
  enabled?: unknown;
};

const normalizeText = (value: unknown, maxLength = 2000): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  if (!trimmed) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeEnabled = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') return true;
    if (normalized === '0' || normalized === 'false' || normalized === 'no') return false;
    return null;
  }
  return null;
};

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, 'createOffers');
    if (!auth.ok) return auth.response;

    let body: CreateStandardPackageRequest | null = null;
    try {
      body = (await req.json()) as CreateStandardPackageRequest;
    } catch {
      body = null;
    }

    const description = normalizeText(body?.description, 2000);
    if (!description) {
      return NextResponse.json(
        { ok: false, error: 'Description is required.' },
        { status: 400 },
      );
    }

    const comments = normalizeText(body?.comments, 2000);
    const enabled = normalizeEnabled(body?.enabled);
    if (enabled == null) {
      return NextResponse.json(
        { ok: false, error: 'Enabled must be Yes/No.' },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);
    const request = pool.request();
    request.input('__description', sql.NVarChar(2000), description);
    request.input('__comments', sql.NVarChar(2000), comments);
    request.input('__enabled', sql.Bit, enabled ? 1 : 0);
    request.input('__auditUserId', sql.NVarChar(450), auditUserId ?? null);

    const result = await request.query<{ OfferID: number }>(`
      ;WITH SourceOffer AS (
        SELECT TOP 1 *
        FROM dbo.Offer
        ORDER BY
          CASE WHEN ISNULL(IsStandardPackage, 0) = 1 THEN 0 ELSE 1 END,
          ID DESC
      )
      INSERT INTO dbo.Offer (
        CustomerID,
        StatusID,
        PricingPolicyID,
        MarketID,
        SalesDivitionID,
        SalesPersonId,
        SalesManagerID,
        CreatedBy,
        ModifiedBy,
        Title,
        Description,
        PaymentTerms,
        InstallationSchedule,
        OfferNotesClosing,
        OfferValidity,
        DeliveryTime,
        OfferNotesIntroduction,
        Comments,
        ContactID,
        OfferContact,
        ERPProjectID,
        ERPFWCProjectID,
        PrintLevelGroupingID,
        CustomerRef,
        InitialRequest,
        DraftOffer,
        OfficialRequest,
        OfferDeadline,
        OfficialQuoteOffer,
        OrderSigned,
        DeliveryDue,
        Delivery,
        OfferDate,
        ApprovalUserId,
        ParentOfferID,
        ProtocolNo,
        OfferVersion,
        Enabled,
        IsStandardPackage,
        CreatedOn,
        ModifiedOn
      )
      OUTPUT INSERTED.ID AS OfferID
      SELECT
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        COALESCE(@__auditUserId, src.CreatedBy),
        COALESCE(@__auditUserId, src.ModifiedBy),
        NULL,
        @__description,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        @__comments,
        NULL,
        NULL,
        NULL,
        src.ERPFWCProjectID,
        src.PrintLevelGroupingID,
        src.CustomerRef,
        src.InitialRequest,
        src.DraftOffer,
        src.OfficialRequest,
        src.OfferDeadline,
        src.OfficialQuoteOffer,
        src.OrderSigned,
        src.DeliveryDue,
        src.Delivery,
        src.OfferDate,
        NULL,
        NULL,
        src.ProtocolNo,
        1,
        @__enabled,
        1,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      FROM SourceOffer src;
    `);

    const offerId = result.recordset?.[0]?.OfferID ?? null;
    if (!offerId) {
      return NextResponse.json(
        { ok: false, error: 'Unable to create standard package.' },
        { status: 500 },
      );
    }

    return NextResponse.json({ ok: true, offerId });
  } catch (err) {
    console.error('Failed to create standard package', err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
