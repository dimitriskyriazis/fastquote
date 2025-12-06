import { NextRequest, NextResponse } from 'next/server';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';
import { resolveAuditUserId } from '../../../../lib/auditTrail';

type CreateCustomerRequestBody = {
  name?: string | null;
  brandName?: string | null;
  taxId?: string | null;
  taxOffice?: string | null;
  profession?: string | null;
  customerGroupId?: number | string | null;
  activityCode?: string | null;
  erpId?: string | null;
  isParent?: number | string | null;
  parentCustomerId?: number | string | null;
  pricingPolicyId?: number | string | null;
  importance?: string | null;
  enabled?: number | string | null;
  address?: string | null;
  countryId?: number | string | null;
  cityId?: number | string | null;
  phone?: string | null;
  email?: string | null;
  webSite?: string | null;
  notes?: string | null;
};

const normalizeString = (value: unknown, maxLength: number): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === 'number') {
    const stringValue = String(value);
    return stringValue.length > maxLength ? stringValue.slice(0, maxLength) : stringValue;
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

const normalizeBoolean = (value: unknown): number | null => {
  if (value === 1 || value === '1') return 1;
  if (value === 0 || value === '0') return 0;
  return null;
};

export async function POST(req: NextRequest) {
  try {
    let body: CreateCustomerRequestBody | null = null;
    try {
      body = (await req.json()) as CreateCustomerRequestBody;
    } catch {
      body = null;
    }

    const name = normalizeString(body?.name, 512);
    const brandName = normalizeString(body?.brandName, 512);
    const taxId = normalizeString(body?.taxId, 128);
    const taxOffice = normalizeString(body?.taxOffice, 128);
    const profession = normalizeString(body?.profession, 256);
    const customerGroupId = normalizeInt(body?.customerGroupId);
    const activityCode = normalizeString(body?.activityCode, 128);
    const erpId = normalizeString(body?.erpId, 128);
    const isParent = normalizeBoolean(body?.isParent);
    const parentCustomerId = normalizeInt(body?.parentCustomerId);
    const pricingPolicyId = normalizeInt(body?.pricingPolicyId);
    const importance = normalizeString(body?.importance, 128);
    const enabled = normalizeBoolean(body?.enabled);
    const address = normalizeString(body?.address, 2000);
    const countryId = normalizeInt(body?.countryId);
    const cityId = normalizeInt(body?.cityId);
    const phone = normalizeString(body?.phone, 128);
    const email = normalizeString(body?.email, 256);
    const webSite = normalizeString(body?.webSite, 512);
    const notes = normalizeString(body?.notes, sql.MAX);

    const validationErrors: string[] = [];
    if (!name) validationErrors.push('Customer name is required.');
    if (!pricingPolicyId) validationErrors.push('Pricing policy is required.');
    if (!importance) validationErrors.push('Importance is required.');

    if (validationErrors.length > 0) {
      return NextResponse.json(
        { ok: false, error: validationErrors.join(' ') },
        { status: 400 },
      );
    }

    const pool = await getPool();
    const request = pool.request();
    request.input('Name', sql.NVarChar(512), name);
    request.input('BrandName', sql.NVarChar(512), brandName);
    request.input('TaxID', sql.NVarChar(128), taxId);
    request.input('TaxOffice', sql.NVarChar(128), taxOffice);
    request.input('Profession', sql.NVarChar(256), profession);
    request.input('CustomerGroupID', sql.Int, customerGroupId);
    request.input('ActivityCode', sql.NVarChar(128), activityCode);
    request.input('ERPID', sql.NVarChar(128), erpId);
    request.input('IsParent', sql.Bit, isParent ?? 0);
    request.input('ParentCustomerID', sql.Int, parentCustomerId);
    request.input('PricingPolicyID', sql.Int, pricingPolicyId);
    request.input('Importance', sql.NVarChar(128), importance);
    request.input('Enabled', sql.Bit, enabled ?? 1);
    request.input('Address', sql.NVarChar(2000), address);
    request.input('CountryID', sql.Int, countryId);
    request.input('CityID', sql.Int, cityId);
    request.input('Phone', sql.NVarChar(128), phone);
    request.input('Email', sql.NVarChar(256), email);
    request.input('WebSite', sql.NVarChar(512), webSite);
    request.input('Notes', sql.NVarChar(sql.MAX), notes);

    const auditUserId = resolveAuditUserId(req);
    request.input('CreatedBy', sql.NVarChar(450), auditUserId);
    request.input('ModifiedBy', sql.NVarChar(450), auditUserId);

    const insertResult = await request.query<{ CustomerID: number }>(`
      INSERT INTO dbo.Customers (
        Name,
        BrandName,
        TaxID,
        TaxOffice,
        Profession,
        CustomerGroupID,
        ActivityCode,
        ERPID,
        IsParent,
        ParentCustomerID,
        PricingPolicyID,
        Importance,
        Enabled,
        Address,
        CountryID,
        CityID,
        Phone,
        Email,
        WebSite,
        Notes,
        CreatedBy,
        ModifiedBy,
        CreatedOn,
        ModifiedOn
      )
      OUTPUT INSERTED.ID AS CustomerID
      VALUES (
        @Name,
        @BrandName,
        @TaxID,
        @TaxOffice,
        @Profession,
        @CustomerGroupID,
        @ActivityCode,
        @ERPID,
        @IsParent,
        @ParentCustomerID,
        @PricingPolicyID,
        @Importance,
        @Enabled,
        @Address,
        @CountryID,
        @CityID,
        @Phone,
        @Email,
        @WebSite,
        @Notes,
        @CreatedBy,
        @ModifiedBy,
        SYSUTCDATETIME(),
        SYSUTCDATETIME()
      );
    `);

    const createdId = insertResult.recordset?.[0]?.CustomerID;
    if (!createdId) {
      return NextResponse.json({ ok: false, error: 'Unable to create customer.' }, { status: 500 });
    }

    return NextResponse.json({ ok: true, customerId: createdId });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : 'Server error';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
