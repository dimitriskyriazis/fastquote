import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import type { DropdownOption } from "../../../lib/dropdownOptions";

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
  try {
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

    return NextResponse.json({ ok: true, option });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
