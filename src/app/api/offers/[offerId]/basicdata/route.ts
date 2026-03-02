import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../../lib/apiHelpers';
import sql, { type ISqlTypeFactory } from 'mssql';
import { getPool } from '../../../../../lib/sql';
import { resolveAuditUserId } from '../../../../../lib/auditTrail';
import type { OfferBasicUpdateField } from '../../../../offers/[offerId]/OfferBasicDataTypes';
import { requirePermission } from '../../../../../lib/authz';

type UpdateInput = {
  field?: OfferBasicUpdateField;
  value?: unknown;
};

type UpdateRequestBody = {
  updates?: UpdateInput[];
};

type FieldType = 'string' | 'number' | 'date';
type NormalizedValue = string | number | Date | null;

type FieldConfig = {
  column: string;
  type: FieldType;
  length?: number;
  sqlType: ISqlTypeFactory;
};

type NormalizedUpdate = {
  field: OfferBasicUpdateField;
  config: FieldConfig;
  value: NormalizedValue;
};

const FIELD_CONFIG: Record<OfferBasicUpdateField, FieldConfig> = {
  CustomerID: { column: 'CustomerID', type: 'number', sqlType: sql.Int },
  SalesDivitionID: { column: 'SalesDivitionID', type: 'number', sqlType: sql.Int },
  CreatedBy: { column: 'CreatedBy', type: 'string', sqlType: sql.NVarChar, length: 450 },
  Title: { column: 'Title', type: 'string', sqlType: sql.NVarChar, length: 512 },
  Description: { column: 'Description', type: 'string', sqlType: sql.NVarChar, length: 2000 },
  PaymentTerms: { column: 'PaymentTerms', type: 'string', sqlType: sql.NVarChar, length: 500 },
  InstallationSchedule: { column: 'InstallationSchedule', type: 'string', sqlType: sql.NVarChar, length: 500 },
  OfferNotesClosing: { column: 'OfferNotesClosing', type: 'string', sqlType: sql.NVarChar, length: 2000 },
  OfferValidity: { column: 'OfferValidity', type: 'string', sqlType: sql.NVarChar, length: 500 },
  DeliveryTime: { column: 'DeliveryTime', type: 'string', sqlType: sql.NVarChar, length: 500 },
  OfferNotesIntroduction: { column: 'OfferNotesIntroduction', type: 'string', sqlType: sql.NVarChar, length: 2000 },
  Comments: { column: 'Comments', type: 'string', sqlType: sql.NVarChar, length: 2000 },
  OfferContact: { column: 'OfferContact', type: 'string', sqlType: sql.NVarChar, length: 500 },
  ContactID: { column: 'ContactID', type: 'number', sqlType: sql.Int },
  StatusID: { column: 'StatusID', type: 'number', sqlType: sql.Int },
  PricingPolicyID: { column: 'PricingPolicyID', type: 'number', sqlType: sql.Int },
  MarketID: { column: 'MarketID', type: 'number', sqlType: sql.Int },
  SalesPersonId: { column: 'SalesPersonId', type: 'string', sqlType: sql.NVarChar, length: 450 },
  ApprovalUserId: { column: 'ApprovalUserId', type: 'string', sqlType: sql.NVarChar, length: 450 },
  ERPProjectCode: { column: 'ERPProjectCode', type: 'string', sqlType: sql.NVarChar, length: 500 },
  ERPFWCProjectID: { column: 'ERPFWCProjectID', type: 'number', sqlType: sql.Int },
  Probability: { column: 'Probability', type: 'number', sqlType: sql.Int },
  CustomerRef: { column: 'CustomerRef', type: 'string', sqlType: sql.NVarChar, length: 500 },
  InitialRequest: { column: 'InitialRequest', type: 'date', sqlType: sql.DateTime2 },
  DraftOffer: { column: 'DraftOffer', type: 'date', sqlType: sql.DateTime2 },
  OfficialRequest: { column: 'OfficialRequest', type: 'date', sqlType: sql.DateTime2 },
  OfferDeadline: { column: 'OfferDeadline', type: 'date', sqlType: sql.DateTime2 },
  OfficialQuoteOffer: { column: 'OfficialQuoteOffer', type: 'date', sqlType: sql.DateTime2 },
  OrderSigned: { column: 'OrderSigned', type: 'date', sqlType: sql.DateTime2 },
  DeliveryDue: { column: 'DeliveryDue', type: 'date', sqlType: sql.DateTime2 },
  Delivery: { column: 'Delivery', type: 'date', sqlType: sql.DateTime2 },
  OfferDate: { column: 'OfferDate', type: 'date', sqlType: sql.DateTime2 },
};

const PROBABILITY_MIN = 0;
const PROBABILITY_MAX = 100;

const normalizeValue = (value: unknown, type: FieldType): NormalizedValue => {
  if (value === null || value === undefined) return null;
  if (type === 'string') {
    const str = typeof value === 'string' ? value : String(value);
    const trimmed = str.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (type === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  if (type === 'date') {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'string') {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }
  return null;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ offerId: string }> },
) {
  logRequest(req, '/api/offers/[offerId]/basicdata');
  try {
    const auth = await requirePermission(req, "editOffers");
    if (!auth.ok) return auth.response;

    const { offerId: offerIdParam } = await params;
    const normalizedId = decodeURIComponent(String(offerIdParam ?? '')).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: 'Missing id' }, { status: 400 });
    }
    const offerId = Number(normalizedId);
    if (!Number.isInteger(offerId)) {
      return NextResponse.json({ ok: false, error: 'Invalid id' }, { status: 400 });
    }

    let body: UpdateRequestBody | null = null;
    try {
      body = (await req.json()) as UpdateRequestBody;
    } catch {
      body = null;
    }

    const rawUpdates = body?.updates;
    const updates: UpdateInput[] = Array.isArray(rawUpdates) ? rawUpdates : [];
    const normalizedUpdates: NormalizedUpdate[] = [];

    updates.forEach((entry) => {
      if (!entry?.field) return;
      const config = FIELD_CONFIG[entry.field];
      if (!config) return;
      const normalizedValue = normalizeValue(entry.value, config.type);
      normalizedUpdates.push({ field: entry.field, config, value: normalizedValue });
    });

    if (normalizedUpdates.length === 0) {
      return NextResponse.json({ ok: false, error: 'No valid updates provided' }, { status: 400 });
    }

    const probabilityUpdate = normalizedUpdates.find((entry) => entry.field === 'Probability');
    if (probabilityUpdate) {
      const value = probabilityUpdate.value;
      const isValidProbability = (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= PROBABILITY_MIN &&
        value <= PROBABILITY_MAX
      );
      if (!isValidProbability) {
        return NextResponse.json(
          { ok: false, error: 'Probability must be an integer between 0 and 100.' },
          { status: 400 },
        );
      }
    }

    const pool = await getPool();

    // Check if status/customer are being updated and store old values
    const statusUpdate = normalizedUpdates.find((u) => u.field === 'StatusID');
    const customerUpdate = normalizedUpdates.find((u) => u.field === 'CustomerID');
    let oldStatusID: number | null = null;
    let oldCustomerID: number | null = null;

    if (statusUpdate || customerUpdate) {
      const offerSnapshot = await pool.request()
        .input('__offerId', sql.Int, offerId)
        .query<{ StatusID: number | null; CustomerID: number | null }>(`
          SELECT StatusID, CustomerID
          FROM dbo.Offer
          WHERE ID = @__offerId
        `);
      oldStatusID = offerSnapshot.recordset[0]?.StatusID ?? null;
      oldCustomerID = offerSnapshot.recordset[0]?.CustomerID ?? null;
    }

    const hasContactUpdate = normalizedUpdates.some((entry) => entry.field === 'ContactID');
    const hasOfferContactUpdate = normalizedUpdates.some((entry) => entry.field === 'OfferContact');
    const nextCustomerID = (
      customerUpdate && typeof customerUpdate.value === 'number' && Number.isInteger(customerUpdate.value)
    ) ? customerUpdate.value : null;
    const customerChanged = customerUpdate ? nextCustomerID !== oldCustomerID : false;

    if (customerChanged && !hasContactUpdate) {
      normalizedUpdates.push({
        field: 'ContactID',
        config: FIELD_CONFIG.ContactID,
        value: null,
      });
      if (!hasOfferContactUpdate) {
        normalizedUpdates.push({
          field: 'OfferContact',
          config: FIELD_CONFIG.OfferContact,
          value: null,
        });
      }
    }

    const contactUpdate = normalizedUpdates.find((entry) => entry.field === 'ContactID');
    const hasOfferContactAfterAdjustments = normalizedUpdates.some((entry) => entry.field === 'OfferContact');
    if (contactUpdate && !hasOfferContactAfterAdjustments) {
      let contactFullName: string | null = null;
      const contactId = contactUpdate.value;
      if (typeof contactId === 'number' && Number.isInteger(contactId)) {
        try {
          const contactNameRequest = pool.request();
          contactNameRequest.input('__contactId', sql.Int, contactId);
          const contactResult = await contactNameRequest.query<{
            FirstName: string | null;
            LastName: string | null;
          }>(`
            SELECT FirstName, LastName
            FROM dbo.Contacts
            WHERE ID = @__contactId
          `);
          const row = contactResult.recordset?.[0];
          if (row) {
            contactFullName = [row.FirstName, row.LastName]
              .map((value) => value?.trim())
              .filter(Boolean)
              .join(' ');
          }
        } catch (err) {
          console.error('Unable to resolve contact name for offer update', err);
        }
      }
      const normalizedContactName = normalizeValue(
        contactFullName,
        FIELD_CONFIG.OfferContact.type,
      );
      normalizedUpdates.push({
        field: 'OfferContact',
        config: FIELD_CONFIG.OfferContact,
        value: normalizedContactName,
      });
    }

    const request = pool.request();
    request.input('__offerId', sql.Int, offerId);

    const setClauses: string[] = [];

    normalizedUpdates.forEach((update, idx) => {
      const paramName = `field_${idx}`;
      const { config, value } = update;
      if (config.sqlType === sql.NVarChar) {
        request.input(paramName, sql.NVarChar(config.length ?? sql.MAX), value);
      } else {
        request.input(paramName, config.sqlType, value);
      }
      setClauses.push(`[${config.column}] = @${paramName}`);
    });

    const auditUserId = resolveAuditUserId(req);
    if (auditUserId) {
      request.input('__modifiedBy', sql.NVarChar(450), auditUserId);
      setClauses.push('[ModifiedBy] = @__modifiedBy');
    }
    setClauses.push('[ModifiedOn] = SYSUTCDATETIME()');

    const query = `
      UPDATE dbo.Offer
      SET ${setClauses.join(', ')}
      WHERE ID = @__offerId;
    `;
    const result = await request.query(query);
    const rowsAffected = result.rowsAffected?.[0] ?? 0;

    // Log status change to history if status was updated
    if (statusUpdate && typeof statusUpdate.value === 'number') {
      const newStatusID = statusUpdate.value;
      // Only insert if status actually changed
      if (oldStatusID !== newStatusID) {
        const historyRequest = pool.request();
        historyRequest.input('__offerId', sql.Int, offerId);
        historyRequest.input('__statusId', sql.Int, newStatusID);
        if (auditUserId) {
          historyRequest.input('__createdBy', sql.NVarChar(450), auditUserId);
        }

        const historyQuery = `
          INSERT INTO dbo.OfferStatusHistory (
            OfferID, StatusID, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy, Enabled
          ) VALUES (
            @__offerId, @__statusId, SYSUTCDATETIME(),
            ${auditUserId ? '@__createdBy' : 'NULL'},
            SYSUTCDATETIME(),
            ${auditUserId ? '@__createdBy' : 'NULL'},
            1
          )
        `;

        await historyRequest.query(historyQuery);
      }
    }

    return NextResponse.json({ ok: true, updated: normalizedUpdates.length, rowsAffected });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
