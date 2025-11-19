import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../../lib/sql';
import type { OfferBasicUpdateField } from '../../../offers/[oID]/OfferBasicDataTypes';

type UpdateInput = {
  field?: OfferBasicUpdateField;
  value?: unknown;
};

type UpdateRequestBody = {
  updates?: UpdateInput[];
};

type FieldType = 'string' | 'number' | 'date';

type FieldConfig = {
  column: string;
  type: FieldType;
  length?: number;
  sqlType: sql.ISqlTypeFactory;
};

const FIELD_CONFIG: Record<OfferBasicUpdateField, FieldConfig> = {
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
  StatusID: { column: 'StatusID', type: 'number', sqlType: sql.Int },
  PricingPolicyID: { column: 'PricingPolicyID', type: 'number', sqlType: sql.Int },
  MarketID: { column: 'MarketID', type: 'number', sqlType: sql.Int },
  SalesPersonId: { column: 'SalesPersonId', type: 'string', sqlType: sql.NVarChar, length: 450 },
  ApprovalUserId: { column: 'ApprovalUserId', type: 'string', sqlType: sql.NVarChar, length: 450 },
  DefaultCalcMethodFormulasID: { column: 'DefaultCalcMethodFormulasID', type: 'string', sqlType: sql.NVarChar, length: 100 },
  ProjectID: { column: 'ProjectID', type: 'number', sqlType: sql.Int },
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

const normalizeValue = (value: unknown, type: FieldType) => {
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
  { params }: { params: Promise<{ oID: string }> },
) {
  try {
    const { oID } = await params;
    const normalizedId = decodeURIComponent(String(oID ?? '')).trim();
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

    const updates = Array.isArray(body?.updates) ? body?.updates : [];
    const normalizedUpdates = updates
      .map((entry) => {
        if (!entry?.field) return null;
        const config = FIELD_CONFIG[entry.field];
        if (!config) return null;
        const normalizedValue = normalizeValue(entry.value, config.type);
        return { field: entry.field, config, value: normalizedValue };
      })
      .filter((entry): entry is { field: OfferBasicUpdateField; config: FieldConfig; value: unknown } => entry != null);

    if (normalizedUpdates.length === 0) {
      return NextResponse.json({ ok: false, error: 'No valid updates provided' }, { status: 400 });
    }

    const pool = await getPool();
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

    const query = `
      UPDATE dbo.Offer
      SET ${setClauses.join(', ')}
      WHERE ID = @__offerId;
    `;
    const result = await request.query(query);
    const rowsAffected = result.rowsAffected?.[0] ?? 0;

    return NextResponse.json({ ok: true, updated: normalizedUpdates.length, rowsAffected });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
