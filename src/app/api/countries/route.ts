import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { logAddAuditDetails } from "../../../lib/mutationAudit";
import type { DropdownOption } from "../../../lib/dropdownOptions";
import { requirePermission } from "../../../lib/authz";

type CreateCountryBody = {
  name?: string;
  enabled?: unknown;
};

const normalizeBoolean = (value: unknown): boolean | null => {
  if (value === true || value === 'true' || value === '1' || value === 1) return true;
  if (value === false || value === 'false' || value === '0' || value === 0) return false;
  return null;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/countries');
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "manageCitiesCountries");
    if (!auth.ok) return auth.response;

    let payload: CreateCountryBody | null = null;
    try {
      payload = (await req.json()) as CreateCountryBody;
    } catch {
      payload = null;
    }

    const rawName = payload?.name ?? "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      return NextResponse.json({ ok: false, error: "Country name is required" }, { status: 400 });
    }

    const enabledValue = normalizeBoolean(payload?.enabled);
    const enabled = enabledValue ?? true;

    const pool = await getPool();
    const request = pool.request();
    request.input("__name", sql.NVarChar(512), name);
    request.input("__enabled", sql.Bit, enabled ? 1 : 0);
    const auditUserId = resolveAuditUserId(req);
    request.input("__userId", sql.NVarChar(450), auditUserId ?? null);

    const result = await request.query<{ ID: number; Name: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, Name NVARCHAR(512));
      INSERT INTO dbo.Countries ([Name], [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy], [Enabled])
      OUTPUT INSERTED.ID, INSERTED.Name INTO @Inserted
      VALUES (@__name, SYSUTCDATETIME(), @__userId, SYSUTCDATETIME(), @__userId, @__enabled);
      SELECT TOP 1 ID, Name FROM @Inserted;
    `);

    const inserted = result.recordset?.[0];
    if (!inserted || inserted.ID == null) {
      throw new Error("Unable to create country");
    }

    const option: DropdownOption = {
      value: String(inserted.ID),
      label: inserted.Name?.trim() || name,
    };

    logAddAuditDetails({
      endpoint: '/api/countries',
      method: 'POST',
      requestId,
      userId: auditUserId,
      targetEntity: 'countries',
      createdRows: [{ id: inserted.ID, name: inserted.Name?.trim() || name }],
      message: 'Country created',
    });

    return NextResponse.json({ ok: true, option });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
