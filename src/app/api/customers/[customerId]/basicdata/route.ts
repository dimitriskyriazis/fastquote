import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql, { type ISqlTypeFactory } from "mssql";
import { getPool } from "../../../../../lib/sql";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";
import type { CustomerBasicUpdateField } from "../../../../customers/[customerId]/CustomerBasicDataTypes";
import { requirePermission } from "../../../../../lib/authz";

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
  ActivityCode: { column: "ActivityCode", type: "string", sqlType: sql.NVarChar, length: 128 },
  ERPID: { column: "ERPID", type: "string", sqlType: sql.NVarChar, length: 128 },
  IsParent: { column: "IsParent", type: "number", sqlType: sql.Bit },
  ParentCustomerID: { column: "ParentCustomerID", type: "number", sqlType: sql.Int },
  PricingPolicyID: { column: "PricingPolicyID", type: "number", sqlType: sql.Int },
  Importance: { column: "Importance", type: "string", sqlType: sql.NVarChar, length: 128 },
  Enabled: { column: "Enabled", type: "number", sqlType: sql.Bit },
  Address: { column: "Address", type: "string", sqlType: sql.NVarChar, length: 2000 },
  CountryID: { column: "CountryID", type: "number", sqlType: sql.Int },
  CityID: { column: "CityID", type: "number", sqlType: sql.Int },
  Phone: { column: "Phone", type: "string", sqlType: sql.NVarChar, length: 128 },
  Email: { column: "Email", type: "string", sqlType: sql.NVarChar, length: 256 },
  WebSite: { column: "WebSite", type: "string", sqlType: sql.NVarChar, length: 512 },
  Notes: { column: "Notes", type: "string", sqlType: sql.NVarChar, length: sql.MAX },
};

const normalizeValue = (value: unknown, type: FieldType): NormalizedValue => {
  if (value === null || value === undefined) return null;
  if (type === "string") {
    const str = typeof value === "string" ? value : String(value);
    const trimmed = str.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (type === "number") {
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

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ customerId: string }> },
) {
  logRequest(req, '/api/customers/[customerId]/basicdata');
  try {
    const auth = await requirePermission(req, "manageCustomersContacts");
    if (!auth.ok) return auth.response;

    const { customerId } = await params;
    const normalizedId = decodeURIComponent(String(customerId ?? "")).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
    }
    const parsedId = Number(normalizedId);
    if (!Number.isInteger(parsedId)) {
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

    updates.forEach((entry) => {
      if (!entry?.field) return;
      const config = FIELD_CONFIG[entry.field];
      if (!config) return;
      const normalizedValue = normalizeValue(entry.value, config.type);
      normalizedUpdates.push({ field: entry.field, config, value: normalizedValue });
    });

    if (normalizedUpdates.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
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

    return NextResponse.json({ ok: true, updated: normalizedUpdates.length, rowsAffected });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
