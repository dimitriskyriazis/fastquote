import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";

type UpdateInput = {
  CountryID?: number | string | null;
  field?: string | null;
  value?: unknown;
  cityId?: number | string | null;
};

type NormalizedUpdate =
  | { kind: "Country"; countryId: number; value: string }
  | { kind: "City"; countryId: number; cityId: number; value: string };

const normalizeId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: UpdateInput[] } | null)?.updates)
      ? ((body as { updates?: UpdateInput[] }).updates ?? [])
      : [];

    const normalized: NormalizedUpdate[] = updates
      .map((entry) => {
        const countryId = normalizeId(entry?.CountryID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        const value = normalizeText(entry?.value);
        if (!countryId || !field) return null;
        if (field === "Country") {
          if (!value) return null;
          return { kind: "Country", countryId, value };
        }
        if (field.startsWith("City")) {
          const cityId = normalizeId(entry?.cityId ?? null);
          if (!cityId || !value) return null;
          return { kind: "City", countryId, cityId, value };
        }
        return null;
      })
      .filter((entry): entry is NormalizedUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    const userId = resolveAuditUserId(req);

    for (const update of normalized) {
      if (update.kind === "Country") {
        const request = pool.request();
        request.input("countryId", sql.Int, update.countryId);
        request.input("name", sql.NVarChar(512), update.value);
        request.input("userId", sql.NVarChar(450), userId ?? null);
        await request.query(`
          UPDATE dbo.Countries
          SET Name = @name,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
          WHERE ID = @countryId
        `);
      } else if (update.kind === "City") {
        const request = pool.request();
        request.input("cityId", sql.Int, update.cityId);
        request.input("countryId", sql.Int, update.countryId);
        request.input("name", sql.NVarChar(512), update.value);
        request.input("userId", sql.NVarChar(450), userId ?? null);
        await request.query(`
          UPDATE dbo.Cities
          SET Name = @name,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
          WHERE ID = @cityId AND CountryID = @countryId
        `);
      }
    }

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
