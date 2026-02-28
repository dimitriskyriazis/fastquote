import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { z } from 'zod';
import { getPool } from '../../../../lib/sql';
import { resolveAuditUserId } from '../../../../lib/auditTrail';
import { getRequestId } from '../../../../lib/requestId';
import { handleApiError } from '../../../../lib/errorHandler';
import { validateRequest, stringSchema, positiveIntSchema, emailSchema, urlSchema } from '../../../../lib/validation';
import { requirePermission } from '../../../../lib/authz';

// Strict schema-based validation with rejection of unknown fields
const createCustomerSchema = z.object({
  name: stringSchema(512, 1).refine((val) => val !== null, {
    message: 'Customer name is required',
  }),
  brandName: stringSchema(512),
  taxId: stringSchema(128),
  taxOffice: stringSchema(128),
  profession: stringSchema(256),
  customerGroupId: positiveIntSchema,
  activityCode: stringSchema(128),
  erpId: stringSchema(128),
  isParent: z.union([z.literal(0), z.literal(1), z.boolean()]).transform((val) => {
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val;
  }).nullable().optional(),
  parentCustomerId: positiveIntSchema,
  pricingPolicyId: positiveIntSchema.refine((val) => val !== null && val !== undefined, {
    message: 'Pricing policy is required',
  }),
  importance: stringSchema(128, 1).refine((val) => val !== null, {
    message: 'Importance is required',
  }),
  enabled: z.union([z.literal(0), z.literal(1), z.boolean()]).transform((val) => {
    if (typeof val === 'boolean') return val ? 1 : 0;
    return val ?? 1;
  }).optional().default(1),
  address: stringSchema(2000),
  countryId: positiveIntSchema,
  city: stringSchema(256),
  phone: stringSchema(128),
  email: emailSchema,
  webSite: urlSchema,
  notes: stringSchema(4000), // Max reasonable length for notes field
}).strict(); // Reject unknown fields

export async function POST(req: NextRequest) {
  logRequest(req, '/api/customers/create');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);

  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    // Validate request body with strict schema
    const validation = await validateRequest(req, createCustomerSchema, {
      endpoint: '/api/customers/create',
      method: 'POST',
      rejectUnknownFields: true,
    });

    if (!validation.success) {
      return validation.response;
    }

    const body = validation.data;
    const name = body.name!; // Validated as required
    const brandName = body.brandName;
    const taxId = body.taxId;
    const taxOffice = body.taxOffice;
    const profession = body.profession;
    const customerGroupId = body.customerGroupId;
    const activityCode = body.activityCode;
    const erpId = body.erpId;
    const isParent = body.isParent ?? 0;
    const parentCustomerId = body.parentCustomerId;
    const pricingPolicyId = body.pricingPolicyId!; // Validated as required
    const importance = body.importance!; // Validated as required
    const enabled = body.enabled ?? 1;
    const address = body.address;
    const countryId = body.countryId;
    const city = body.city ?? null;
    const phone = body.phone;
    const email = body.email;
    const webSite = body.webSite;
    const notes = body.notes;

    const pool = await getPool();

    // Enforce that pricing policy exists and is enabled.
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
    request.input('City', sql.NVarChar(256), city);
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
        City,
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
        @City,
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
  } catch (err) {
    return await handleApiError(err, {
      requestId,
      endpoint: '/api/customers/create',
      method: 'POST',
      userId,
    });
  }
}
