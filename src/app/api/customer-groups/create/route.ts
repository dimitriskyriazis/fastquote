import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";

const normalizeTextValue = (value: unknown, maxLength = 255): string | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  const coerced = String(value);
  const trimmed = coerced.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
};

const normalizeBoolean = (value: unknown): boolean => {
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(lowered)) return true;
    if (["false", "no", "n"].includes(lowered)) return false;
  }
  return false;
};

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json().catch(() => null)) as
      | { name?: unknown; enabled?: unknown }
      | null;
    if (!payload) {
      return NextResponse.json({ ok: false, error: "Missing payload" }, { status: 400 });
    }
    const name = normalizeTextValue(payload.name, 255);
    if (!name) {
      return NextResponse.json({ ok: false, error: "Group name is required." }, { status: 400 });
    }
    const enabled = normalizeBoolean(payload.enabled ?? true);
    const auditUserId = resolveAuditUserId(req);

    const pool = await getPool();
    const insertRequest = pool.request();
    insertRequest.input("name", sql.NVarChar(255), name);
    insertRequest.input("enabled", sql.Bit, enabled ? 1 : 0);
    insertRequest.input("createdBy", sql.NVarChar(450), auditUserId ?? null);
    insertRequest.input("modifiedBy", sql.NVarChar(450), auditUserId ?? null);
    const insertResult = await insertRequest.query<{ ID: number }>(`
      INSERT INTO dbo.CustomerGroups (Name, Enabled, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
      OUTPUT inserted.ID
      VALUES (@name, @enabled, SYSUTCDATETIME(), @createdBy, SYSUTCDATETIME(), @modifiedBy)
    `);
    const groupId = insertResult.recordset?.[0]?.ID ?? null;
    if (groupId == null) {
      throw new Error("Unable to create customer group.");
    }

    const selectRequest = pool.request();
    selectRequest.input("groupId", sql.Int, groupId);
    const selectResult = await selectRequest.query<{
      CustomerGroupID: number;
      Name: string | null;
      Enabled: boolean | number | null;
      CreatedOn: string | Date | null;
    }>(`
      SELECT
        ID AS CustomerGroupID,
        Name,
        Enabled,
        CreatedOn
      FROM dbo.CustomerGroups
      WHERE ID = @groupId
    `);
    const group = selectResult.recordset?.[0];
    if (!group) {
      throw new Error("Unable to load created customer group.");
    }

    return NextResponse.json({ ok: true, group });
  } catch (err) {
    console.error("Failed to create customer group", err);
    const message = err instanceof Error ? err.message : "Failed to create customer group.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
