import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql, { type ISqlTypeFactory } from "mssql";
import { getPool } from "../../../../../lib/sql";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";
import type {
  CustomerBasicRecord,
  CustomerBasicUpdateField,
} from "../../../../customers/[customerId]/CustomerBasicDataTypes";
import { sanitizeJsonUnsafeChars } from "../../../../../lib/normalize";
import { requirePermission } from "../../../../../lib/authz";
import { roleHasPermission, type Permission } from "../../../../../lib/roles";
import { getRequestId } from "../../../../../lib/requestId";
import { logEditAuditDetails } from "../../../../../lib/mutationAudit";
import { invalidateDuplicateScans } from "../../../../../lib/duplicateScanCache";

type UpdateInput = {
  field?: CustomerBasicUpdateField;
  value?: unknown;
};

type UpdateRequestBody = {
  updates?: UpdateInput[];
};

type FieldType = "string" | "number" | "date";
type NormalizedValue = string | number | Date | null;

type FieldConfig = {
  column: string;
  type: FieldType;
  length?: number;
  sqlType: ISqlTypeFactory;
};

type NormalizedUpdate = {
  field: CustomerBasicUpdateField;
  config: FieldConfig;
  value: NormalizedValue;
};

const FIELD_CONFIG: Record<CustomerBasicUpdateField, FieldConfig> = {
  Name: { column: "Name", type: "string", sqlType: sql.NVarChar, length: 512 },
  BrandName: { column: "BrandName", type: "string", sqlType: sql.NVarChar, length: 512 },
  TaxID: { column: "TaxID", type: "string", sqlType: sql.NVarChar, length: 128 },
  TaxOffice: { column: "TaxOffice", type: "string", sqlType: sql.NVarChar, length: 128 },
  Profession: { column: "Profession", type: "string", sqlType: sql.NVarChar, length: 256 },
  CustomerGroupID: { column: "CustomerGroupID", type: "number", sqlType: sql.Int },

  // The payment terms agreed with this customer. NULL means "not assigned" and
  // is deliberately kept distinct from a deliberate OTHER, so the bulk-assignment
  // coverage stays measurable. Administrator/Developer only — see
  // ADMIN_ONLY_FIELDS below.
  PaymentTermID: { column: "PaymentTermID", type: "number", sqlType: sql.Int },

  // ERPID = the numeric Soft1 TRDR (int column), also stamped by the draft-order wizard.
  // Soft1 codes like 'Δι.4082' are a different namespace and must be rejected, not stored.
  ERPID: { column: "ERPID", type: "number", sqlType: sql.Int },

  // ERPCode = the alphanumeric Soft1 dbo.TRDR.CODE (e.g. ΔΙ.3748), the companion
  // namespace to the numeric TRDR held in ERPID. Free text, so no numeric guard.
  ERPCode: { column: "ERPCode", type: "string", sqlType: sql.NVarChar, length: 25 },
  IsParent: { column: "IsParent", type: "number", sqlType: sql.Bit },
  ParentCustomerID: { column: "ParentCustomerID", type: "number", sqlType: sql.Int },
  PricingPolicyID: { column: "PricingPolicyID", type: "number", sqlType: sql.Int },
  Importance: { column: "Importance", type: "string", sqlType: sql.NVarChar, length: 128 },
  Enabled: { column: "Enabled", type: "number", sqlType: sql.Bit },
  Address: { column: "Address", type: "string", sqlType: sql.NVarChar, length: 2000 },
  CountryID: { column: "CountryID", type: "number", sqlType: sql.Int },
  City: { column: "City", type: "string", sqlType: sql.NVarChar, length: 256 },
  Phone: { column: "Phone", type: "string", sqlType: sql.NVarChar, length: 128 },
  Email: { column: "Email", type: "string", sqlType: sql.NVarChar, length: 256 },
  WebSite: { column: "WebSite", type: "string", sqlType: sql.NVarChar, length: 512 },
  Notes: { column: "Notes", type: "string", sqlType: sql.NVarChar, length: sql.MAX },
};

// Fields inside FIELD_CONFIG that need MORE than 'manageCustomersContacts'
// (which every role from Simple User up holds). Enforced server-side below; the
// client's adminOnly flag on the field definition is UX only and bypassable.
const ADMIN_ONLY_FIELDS: ReadonlySet<CustomerBasicUpdateField> = new Set([
  'PaymentTermID',
]);

const ADMIN_ONLY_FIELD_PERMISSION: Permission = 'managePaymentTerms';

const normalizeValue = (value: unknown, type: FieldType): NormalizedValue => {
  if (value === null || value === undefined) return null;
  if (type === "string") {
    const str = typeof value === "string" ? value : String(value);
    const trimmed = str.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (type === "number") {
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
  if (type === "date") {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === "string") {
      const parsed = new Date(value);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    }
    return null;
  }
  return null;
};

const parseCustomerId = async (
  params: Promise<{ customerId: string }>,
): Promise<number | null> => {
  const { customerId } = await params;
  let normalizedId = String(customerId ?? "");
  try {
    normalizedId = decodeURIComponent(normalizedId);
  } catch {
    normalizedId = String(customerId ?? "");
  }
  normalizedId = normalizedId.trim();
  if (!normalizedId) return null;
  const parsedId = Number(normalizedId);
  if (!Number.isInteger(parsedId)) return null;
  return parsedId;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  logRequest(req, '/api/customers/[customerId]/basicdata');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const parsedId = await parseCustomerId(params);
    if (!parsedId) {
      return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
    }

    const pool = await getPool();
    const request = pool.request();
    request.input("customerId", sql.Int, parsedId);
    const result = await request.query<CustomerBasicRecord>(`
      SELECT TOP 1
        c.ID AS CustomerID,
        c.Name,
        c.BrandName,
        c.TaxID,
        c.TaxOffice,
        c.Profession,
        c.CustomerGroupID,
        cg.Name AS CustomerGroupName,
        c.PaymentTermID,
        pt.Name AS PaymentTermName,

        c.ERPID,
        c.ERPCode,
        c.IsParent,
        c.ParentCustomerID,
        parent.Name AS ParentCustomerName,
        c.PricingPolicyID,
        pp.Name AS PricingPolicyName,
        c.Importance,
        c.Enabled,
        c.Address,
        c.CountryID,
        country.Name AS CountryName,
        c.City,
        c.Phone,
        c.Email,
        c.WebSite,
        c.Notes
      FROM dbo.Customers AS c
      LEFT JOIN dbo.CustomerGroups AS cg ON c.CustomerGroupID = cg.ID
      LEFT JOIN dbo.Customers AS parent ON c.ParentCustomerID = parent.ID
      LEFT JOIN dbo.Countries AS country ON c.CountryID = country.ID
      LEFT JOIN dbo.PricingPolicies AS pp ON c.PricingPolicyID = pp.ID
      LEFT JOIN dbo.PaymentTerms AS pt ON c.PaymentTermID = pt.ID
      WHERE c.ID = @customerId
    `);
    const record = result.recordset?.[0] ?? null;
    if (!record) {
      return NextResponse.json({ ok: false, error: "Customer not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, record });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  logRequest(req, '/api/customers/[customerId]/basicdata');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    // Two doors in. manageCustomersContacts (every job role) edits any field;
    // managePaymentTerms alone (a Finance Manager with no other role) is also
    // let through here, and the field filter further down then confines that
    // caller to the payment-term field. Denial has no side effects, so asking
    // twice is free.
    let paymentTermsOnly = false;
    let auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) {
      const finance = await requirePermission(req, ADMIN_ONLY_FIELD_PERMISSION);
      if (!finance.ok) return auth.response;
      auth = finance;
      paymentTermsOnly = true;
    }

    const parsedId = await parseCustomerId(params);
    if (!parsedId) {
      return NextResponse.json({ ok: false, error: "Invalid id" }, { status: 400 });
    }

    let body: UpdateRequestBody | null = null;
    try {
      body = (await req.json()) as UpdateRequestBody;
    } catch {
      body = null;
    }

    const updates = Array.isArray(body?.updates) ? body.updates : [];
    const normalizedUpdates: NormalizedUpdate[] = [];
    const JSON_SANITIZED_FIELDS: ReadonlySet<CustomerBasicUpdateField> = new Set(['Name', 'BrandName']);

    updates.forEach((entry) => {
      if (!entry?.field) return;
      const config = FIELD_CONFIG[entry.field];
      if (!config) return;
      let normalizedValue = normalizeValue(entry.value, config.type);
      if (JSON_SANITIZED_FIELDS.has(entry.field) && typeof normalizedValue === 'string') {
        normalizedValue = sanitizeJsonUnsafeChars(normalizedValue);
      }
      normalizedUpdates.push({ field: entry.field, config, value: normalizedValue });
    });

    // Reject the whole batch if it touches an admin-only field without the
    // rights for it. Rejecting the batch rather than dropping the field means a
    // caller can never half-apply an update and believe it succeeded.
    const attemptedAdminFields = normalizedUpdates
      .map((u) => u.field)
      .filter((field) => ADMIN_ONLY_FIELDS.has(field));
    if (
      attemptedAdminFields.length > 0
      && !roleHasPermission(auth.roles, ADMIN_ONLY_FIELD_PERMISSION)
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: `Only a Finance Manager or Administrator can change ${attemptedAdminFields.join(', ')}.`,
          requiredPermission: ADMIN_ONLY_FIELD_PERMISSION,
        },
        { status: 403 },
      );
    }
    if (paymentTermsOnly) {
      const outside = normalizedUpdates
        .map((u) => u.field)
        .filter((field) => !ADMIN_ONLY_FIELDS.has(field));
      if (outside.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `A Finance Manager can only change payment terms here, not ${outside.join(', ')}.`,
            requiredPermission: 'manageCustomersContacts',
          },
          { status: 403 },
        );
      }
    }

    // A non-numeric ERPID normalizes to null; erroring beats silently clearing the TRDR.
    const invalidErpId = normalizedUpdates.find(
      (u) => u.field === 'ERPID' && u.value === null
        && String(updates.find((e) => e?.field === 'ERPID')?.value ?? '').trim() !== '',
    );
    if (invalidErpId) {
      return NextResponse.json(
        { ok: false, error: 'ERP ID must be a number (the numeric Soft1 id, not a code like "Δι.4082").' },
        { status: 400 },
      );
    }

    if (normalizedUpdates.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();

    // Validate PaymentTermID before the UPDATE. Without this the FK raises 547
    // and surfaces as a raw 500; and a disabled term would be accepted, since
    // the FK only checks existence.
    const paymentTermUpdate = normalizedUpdates.find((u) => u.field === 'PaymentTermID');
    if (paymentTermUpdate && paymentTermUpdate.value !== null) {
      const termCheck = await pool
        .request()
        .input('paymentTermId', sql.Int, paymentTermUpdate.value as number)
        .query<{ ID: number }>(
          'SELECT ID FROM dbo.PaymentTerms WHERE ID = @paymentTermId AND Enabled = 1',
        );
      if (!termCheck.recordset?.[0]) {
        return NextResponse.json(
          { ok: false, error: 'Unknown or disabled payment term.' },
          { status: 400 },
        );
      }
    }
    const request = pool.request();
    request.input("__customerId", sql.Int, parsedId);

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
      request.input("__modifiedBy", sql.NVarChar(450), auditUserId);
      setClauses.push("[ModifiedBy] = @__modifiedBy");
    }
    setClauses.push("[ModifiedOn] = SYSUTCDATETIME()");

    const query = `
      UPDATE dbo.Customers
      SET ${setClauses.join(", ")}
      WHERE ID = @__customerId;
    `;
    const result = await request.query(query);
    const rowsAffected = result.rowsAffected?.[0] ?? 0;

    // Renaming a customer, or changing its tax/ERP id, changes what the
    // duplicate scanner would report, so any cached scan is now describing
    // customers that no longer look like that.
    invalidateDuplicateScans();

    const changes = normalizedUpdates.map((u) => ({
      targetId: parsedId,
      field: u.field,
      before: null,
      after: u.value,
    }));
    logEditAuditDetails({
      endpoint: '/api/customers/[customerId]/basicdata',
      method: 'PATCH',
      requestId,
      userId,
      targetEntity: 'customers',
      targetIds: [parsedId],
      changes,
      message: 'Customer fields updated',
    });

    return NextResponse.json({ ok: true, updated: normalizedUpdates.length, rowsAffected });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
