import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import { getRequestId } from "../../../lib/requestId";
import { logAddAuditDetails, logDeleteAuditDetails } from "../../../lib/mutationAudit";
import type { DropdownOption } from "../../../lib/dropdownOptions";
import { requirePermission } from "../../../lib/authz";
import { checkDeletePermission } from "../../../lib/deletePermissions";

type CreateCityBody = {
  name?: string;
  countryId?: number | string | null;
  enabled?: unknown;
};

const normalizeCountryId = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeBoolean = (value: unknown): boolean | null => {
  if (value === true || value === "true" || value === "1" || value === 1) return true;
  if (value === false || value === "false" || value === "0" || value === 0) return false;
  return null;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/cities');
  const requestId = await getRequestId(req);
  try {
    const auth = await requirePermission(req, "manageCitiesCountries");
    if (!auth.ok) return auth.response;

    let payload: CreateCityBody | null = null;
    try {
      payload = (await req.json()) as CreateCityBody;
    } catch {
      payload = null;
    }

    const rawName = payload?.name ?? "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name) {
      return NextResponse.json({ ok: false, error: "City name is required" }, { status: 400 });
    }

    const countryId = normalizeCountryId(payload?.countryId ?? null);
    const enabledValue = normalizeBoolean(payload?.enabled);
    const enabled = enabledValue ?? true;

    const pool = await getPool();
    const request = pool.request();
    request.input("__name", sql.NVarChar(512), name);
    request.input("__countryId", sql.Int, countryId);
    request.input("__enabled", sql.Bit, enabled ? 1 : 0);
    const auditUserId = resolveAuditUserId(req);
    request.input("__userId", sql.NVarChar(450), auditUserId ?? null);

    const result = await request.query<{ ID: number; Name: string | null }>(`
      DECLARE @Inserted TABLE (ID INT, Name NVARCHAR(512));
      INSERT INTO dbo.Cities ([Name], [CountryID], [CreatedOn], [CreatedBy], [ModifiedOn], [ModifiedBy], [Enabled])
      OUTPUT INSERTED.ID, INSERTED.Name INTO @Inserted
      VALUES (@__name, @__countryId, SYSUTCDATETIME(), @__userId, SYSUTCDATETIME(), @__userId, @__enabled);
      SELECT TOP 1 ID, Name FROM @Inserted;
    `);

    const inserted = result.recordset?.[0];
    if (!inserted || inserted.ID == null) {
      throw new Error("Unable to create city");
    }

    const option: DropdownOption & { countryId: number | null } = {
      value: String(inserted.ID),
      label: inserted.Name?.trim() || name,
      countryId,
    };

    logAddAuditDetails({
      endpoint: '/api/cities',
      method: 'POST',
      requestId,
      userId: auditUserId,
      targetEntity: 'cities',
      createdRows: [{ id: inserted.ID, name: inserted.Name?.trim() || name }],
      message: 'City created',
    });

    return NextResponse.json({ ok: true, option });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  logRequest(req, '/api/cities');
  const requestId = await getRequestId(req);
  const userId = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "manageCitiesCountries");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as { CityIDs?: unknown } | null;
    const rawIds = Array.isArray(body?.CityIDs) ? body?.CityIDs : [];
    const ids = Array.from(
      new Set(
        rawIds
          .map((entry) => {
            if (typeof entry === "number" && Number.isFinite(entry)) {
              return Math.trunc(entry);
            }
            if (typeof entry === "string") {
              const parsed = Number.parseInt(entry, 10);
              if (Number.isFinite(parsed)) return parsed;
            }
            return null;
          })
          .filter((value): value is number => value != null),
      ),
    );

    if (ids.length === 0) {
      return NextResponse.json({ ok: false, error: "No cities selected for deletion" }, { status: 400 });
    }

    const deleteCheck = checkDeletePermission(auth.roles, ids.length, 'generic', 'manageCustomersContacts');
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const request = pool.request();
    const paramNames: string[] = [];
    ids.forEach((value, idx) => {
      const paramName = `city_${idx}`;
      paramNames.push(paramName);
      request.input(paramName, sql.Int, value);
    });
    const placeholders = paramNames.map((name) => `@${name}`).join(", ");

    const result = await request.query<{ CityID: number; Name: string | null }>(`
      DELETE FROM dbo.Cities
      OUTPUT DELETED.ID AS CityID, DELETED.Name
      WHERE ID IN (${placeholders});
    `);

    const deletedRows = (result.recordset ?? []).map((row) => ({
      id: row.CityID,
      name: row.Name?.trim() || null,
    }));
    logDeleteAuditDetails({
      endpoint: '/api/cities',
      requestId,
      userId,
      targetEntity: 'cities',
      requestedIds: ids,
      deletedRows,
      message: 'Cities deleted',
    });

    return NextResponse.json({ ok: true, deletedCities: result.rowsAffected?.[0] ?? 0 });
  } catch (err) {
    console.error("Failed to delete cities", err);
    const message = err instanceof Error ? err.message : "Unable to delete cities.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
