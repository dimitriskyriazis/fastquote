import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { requirePermission } from '../../../../lib/authz';

type CreateOfferRequestBody = {
  title?: string | null;
  description?: string | null;
  paymentTerms?: string | null;
  deliveryTime?: string | null;
  offerValidity?: string | null;
  customerId?: number | string | null;
  statusId?: number | string | null;
  contactId?: number | string | null;
  pricingPolicyId?: number | string | null;
  marketId?: number | string | null;
  salesDivisionId?: number | string | null;
  salesCreationPersonId?: string | null;
  salesPersonId?: string | null;
  approvalUserId?: string | null;
  installationSchedule?: string | null;
  closingNote?: string | null;
  introNote?: string | null;
  telmacoNote?: string | null;
  projectCode?: string | null;
  erpFwcProjectId?: number | string | null;
  customerRef?: string | null;
  probability?: number | string | null;
  initialRequest?: string | Date | null;
  draftOffer?: string | Date | null;
  officialRequest?: string | Date | null;
  offerDeadline?: string | Date | null;
  officialQuoteOffer?: string | Date | null;
  orderSigned?: string | Date | null;
  deliveryDue?: string | Date | null;
  delivery?: string | Date | null;
  offerDate?: string | Date | null;
};

type ContactLookupRow = {
  ContactID: number;
  CustomerID: number | null;
  FirstName: string | null;
  LastName: string | null;
  FullName: string | null;
};

const normalizeString = (value: unknown, maxLength = 500): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const str = String(value);
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
};

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeUserId = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number') {
    const str = String(value);
    return str.trim() || null;
  }
  return null;
};

const normalizeDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const PROBABILITY_MIN = 0;
const PROBABILITY_MAX = 100;

const normalizeProbability = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return null;
    return value >= PROBABILITY_MIN && value <= PROBABILITY_MAX ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed)) return null;
    return parsed >= PROBABILITY_MIN && parsed <= PROBABILITY_MAX ? parsed : null;
  }
  return null;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/offers/create');
  try {
    const auth = await requirePermission(req, "createOffers");
    if (!auth.ok) return auth.response;

    let body: CreateOfferRequestBody | null = null;
    try {
      body = (await req.json()) as CreateOfferRequestBody;
    } catch {
      body = null;
    }

    const title = normalizeString(body?.title, 512);
    const description = normalizeString(body?.description, 2000);
    const paymentTerms = normalizeString(body?.paymentTerms, 500);
    const deliveryTime = normalizeString(body?.deliveryTime, 500);
    const offerValidity = normalizeString(body?.offerValidity, 500);
    const customerId = normalizeInt(body?.customerId);
    const statusId = normalizeInt(body?.statusId);
    const contactId = normalizeInt(body?.contactId);
    const pricingPolicyId = normalizeInt(body?.pricingPolicyId);
    const marketId = normalizeInt(body?.marketId);
    const salesDivisionId = normalizeInt(body?.salesDivisionId);
    const customerRef = normalizeString(body?.customerRef, 500);
    const probabilityInput = body?.probability;
    const probabilityWasProvided = !(
      probabilityInput === undefined ||
      probabilityInput === null ||
      (typeof probabilityInput === 'string' && probabilityInput.trim() === '')
    );
    const normalizedProbability = normalizeProbability(probabilityInput);
    const probability = normalizedProbability ?? 0;
    const installationSchedule = normalizeString(body?.installationSchedule, 500);
    const closingNote = normalizeString(body?.closingNote, 2000);
    const introNote = normalizeString(body?.introNote, 2000);
  const telmacoNote = normalizeString(body?.telmacoNote, 2000);
  const approvalUserId = normalizeUserId(body?.approvalUserId);

  const auditUserId = resolveAuditUserId(req);
  const salesCreationPersonId =
    normalizeUserId(body?.salesCreationPersonId) ?? auditUserId ?? null;
  const salesPersonId =
    normalizeUserId(body?.salesPersonId) ?? salesCreationPersonId ?? auditUserId ?? null;
  const salesManagerId = salesCreationPersonId;
  const erpProjectCode = body?.projectCode?.trim() || null;
  const erpFwcProjectId = normalizeInt(body?.erpFwcProjectId);

    const dateFields = {
      initialRequest: normalizeDate(body?.initialRequest),
      draftOffer: normalizeDate(body?.draftOffer),
      officialRequest: normalizeDate(body?.officialRequest),
      offerDeadline: normalizeDate(body?.offerDeadline),
      officialQuoteOffer: normalizeDate(body?.officialQuoteOffer),
      orderSigned: normalizeDate(body?.orderSigned),
      deliveryDue: normalizeDate(body?.deliveryDue),
      delivery: normalizeDate(body?.delivery),
      offerDate: normalizeDate(body?.offerDate),
    };

    const errors: string[] = [];
    if (!title) errors.push('Title is required.');
    if (!description) errors.push('Description is required.');
    if (!paymentTerms) errors.push('Payment terms are required.');
    if (!deliveryTime) errors.push('Delivery time is required.');
    if (!offerValidity) errors.push('Offer validity is required.');
    if (!customerId) errors.push('Customer is required.');
    if (!statusId) errors.push('Status is required.');
    if (!contactId) errors.push('Contact is required.');
    if (!pricingPolicyId) errors.push('Pricing policy is required.');
    if (!marketId) errors.push('Market is required.');
    if (!salesDivisionId) errors.push('Sales division is required.');
    if (!salesCreationPersonId) errors.push('Sales creation person is required.');
    if (!salesPersonId) errors.push('Sales person is required.');
    if (probabilityWasProvided && normalizedProbability == null) {
      errors.push('Probability must be an integer between 0 and 100.');
    }

    if (errors.length > 0) {
      return NextResponse.json(
        { ok: false, error: errors.join(' ') },
        { status: 400 },
      );
    }

    const pool = await getPool();

    // Enforce that pricing policy exists and has at least one rule.
    // Brand-specific rules are allowed; a default (All brands) rule is recommended but not required
    // at offer creation time. Missing rules for a specific brand will be enforced when adding
    // products / recalculating prices.
    const policyExists = await pool.request()
      .input('__ppid', sql.Int, pricingPolicyId)
      .query<{ ID: number }>(`
        SELECT TOP 1 ID
        FROM dbo.PricingPolicies
        WHERE ID = @__ppid
          AND ISNULL(Enabled, 0) = 1
      `);
    if (!policyExists.recordset?.[0]?.ID) {
      return NextResponse.json(
        { ok: false, error: 'Selected pricing policy was not found or is disabled.' },
        { status: 400 },
      );
    }
    const anyRuleCheck = await pool.request()
      .input('__ppid', sql.Int, pricingPolicyId)
      .query<{ cnt: number | bigint | null }>(`
        SELECT COUNT(1) AS cnt
        FROM dbo.PricingPolicyRules
        WHERE PricingPolicyID = @__ppid
      `);
    const ruleCount = Number(anyRuleCheck.recordset?.[0]?.cnt ?? 0);
    if (!Number.isFinite(ruleCount) || ruleCount <= 0) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'Selected pricing policy has no pricing rules. Please add a default (All brands) rule or brand-specific rules first.',
        },
        { status: 400 },
      );
    }

    // Validate contact belongs to customer and capture a display name
    const contactLookup = await pool
      .request()
      .input('contactId', sql.Int, contactId)
      .query<ContactLookupRow>(`
        SELECT
          cnt.ID AS ContactID,
          cnt.CustomerID,
          cnt.FirstName,
          cnt.LastName,
          LTRIM(RTRIM(CONCAT(
            ISNULL(cnt.FirstName, ''),
            CASE WHEN cnt.FirstName IS NOT NULL AND cnt.LastName IS NOT NULL THEN ' ' ELSE '' END,
            ISNULL(cnt.LastName, '')
          ))) AS FullName
        FROM dbo.Contacts AS cnt
        WHERE cnt.ID = @contactId
      `);

    const contactRow = contactLookup.recordset?.[0];
    if (!contactRow?.ContactID) {
      return NextResponse.json(
        { ok: false, error: 'Selected contact was not found.' },
        { status: 400 },
      );
    }
    if (contactRow.CustomerID && customerId && contactRow.CustomerID !== customerId) {
      return NextResponse.json(
        { ok: false, error: 'Contact does not belong to the selected customer.' },
        { status: 400 },
      );
    }
    const offerContact =
      contactRow.FullName?.trim()
      || [contactRow.FirstName, contactRow.LastName].map((v) => v?.trim()).filter(Boolean).join(' ')
      || `Contact ${contactRow.ContactID}`;

    const request = pool.request();
    request.input('CustomerID', sql.Int, customerId);
    request.input('StatusID', sql.Int, statusId);
    request.input('PricingPolicyID', sql.Int, pricingPolicyId);
    request.input('MarketID', sql.Int, marketId);
    request.input('SalesDivitionID', sql.Int, salesDivisionId);
    request.input('SalesPersonId', sql.NVarChar(450), salesPersonId);
    request.input('SalesManagerID', sql.NVarChar(450), salesManagerId);
    request.input('CreatedBy', sql.NVarChar(450), salesCreationPersonId);
    request.input('ModifiedBy', sql.NVarChar(450), salesCreationPersonId);
    request.input('Title', sql.NVarChar(512), title);
    request.input('Description', sql.NVarChar(2000), description);
    request.input('PaymentTerms', sql.NVarChar(500), paymentTerms);
    request.input('InstallationSchedule', sql.NVarChar(500), installationSchedule);
    request.input('OfferNotesClosing', sql.NVarChar(2000), closingNote);
    request.input('OfferValidity', sql.NVarChar(500), offerValidity);
    request.input('DeliveryTime', sql.NVarChar(500), deliveryTime);
    request.input('OfferNotesIntroduction', sql.NVarChar(2000), introNote);
    request.input('Comments', sql.NVarChar(2000), telmacoNote);
    request.input('ContactID', sql.Int, contactId);
    request.input('OfferContact', sql.NVarChar(500), offerContact);
    request.input('ERPProjectCode', sql.NVarChar(500), erpProjectCode);
    request.input('ERPFWCProjectID', sql.Int, erpFwcProjectId);
    request.input('PrintLevelGroupingID', sql.Int, 1);
    request.input('CustomerRef', sql.NVarChar(500), customerRef);
    request.input('Probability', sql.Int, probability);
    request.input('InitialRequest', sql.DateTime2, dateFields.initialRequest);
    request.input('DraftOffer', sql.DateTime2, dateFields.draftOffer);
    request.input('OfficialRequest', sql.DateTime2, dateFields.officialRequest);
    request.input('OfferDeadline', sql.DateTime2, dateFields.offerDeadline);
    request.input('OfficialQuoteOffer', sql.DateTime2, dateFields.officialQuoteOffer);
    request.input('OrderSigned', sql.DateTime2, dateFields.orderSigned);
    request.input('DeliveryDue', sql.DateTime2, dateFields.deliveryDue);
    request.input('Delivery', sql.DateTime2, dateFields.delivery);
    request.input('OfferDate', sql.DateTime2, dateFields.offerDate);
    request.input('ApprovalUserId', sql.NVarChar(450), approvalUserId);

    const insertResult = await request.query<{ OfferID: number }>(`
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
        ERPProjectCode,
        ERPFWCProjectID,
        PrintLevelGroupingID,
        CustomerRef,
        Probability,
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
        OfferVersion,
        Enabled,
        CreatedOn,
        ModifiedOn
      )
      OUTPUT INSERTED.ID AS OfferID
      VALUES (
        @CustomerID,
        @StatusID,
        @PricingPolicyID,
        @MarketID,
        @SalesDivitionID,
        @SalesPersonId,
        @SalesManagerID,
        @CreatedBy,
        @ModifiedBy,
        @Title,
        @Description,
        @PaymentTerms,
        @InstallationSchedule,
        @OfferNotesClosing,
        @OfferValidity,
        @DeliveryTime,
        @OfferNotesIntroduction,
        @Comments,
        @ContactID,
        @OfferContact,
        @ERPProjectCode,
        @ERPFWCProjectID,
        @PrintLevelGroupingID,
        @CustomerRef,
        @Probability,
        @InitialRequest,
        @DraftOffer,
        @OfficialRequest,
        @OfferDeadline,
        @OfficialQuoteOffer,
        @OrderSigned,
        @DeliveryDue,
        @Delivery,
        @OfferDate,
        @ApprovalUserId,
        1,
        1,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      );
    `);

    const created = insertResult.recordset?.[0]?.OfferID;
    if (!created) {
      return NextResponse.json({ ok: false, error: 'Unable to create offer.' }, { status: 500 });
    }

    // Log initial status to history
    if (statusId) {
      const historyRequest = pool.request();
      historyRequest.input('__offerId', sql.Int, created);
      historyRequest.input('__statusId', sql.Int, statusId);
      if (salesCreationPersonId) {
        historyRequest.input('__createdBy', sql.NVarChar(450), salesCreationPersonId);
      }

      await historyRequest.query(`
        INSERT INTO dbo.OfferStatusHistory (
          OfferID, StatusID, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy, Enabled
        ) VALUES (
          @__offerId, @__statusId, SYSUTCDATETIME(),
          ${salesCreationPersonId ? '@__createdBy' : 'NULL'},
          SYSUTCDATETIME(),
          ${salesCreationPersonId ? '@__createdBy' : 'NULL'},
          1
        )
      `);
    }

    return NextResponse.json({ ok: true, offerId: created });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
