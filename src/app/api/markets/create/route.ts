import { NextRequest, NextResponse } from "next/server";
import sql, { ConnectionPool } from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";

const normalizeTextValue = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const coerced = String(value ?? "");
  const trimmed = coerced.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeBooleanInput = (value: unknown): boolean => {
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

const findSalesDivisionId = async (pool: ConnectionPool, divisionName: string): Promise<number | null> => {
  const lookup = pool.request();
  lookup.input("divisionName", sql.NVarChar, divisionName);
  const result = await lookup.query<{ ID: number }>(`
    SELECT TOP 1 ID
    FROM dbo.SalesDivision
    WHERE Name = @divisionName
    ORDER BY ID
  `);
  return result.recordset?.[0]?.ID ?? null;
};

export async function POST(req: NextRequest) {
  try {
    const payload = (await req.json().catch(() => null)) as
      | {
          name?: unknown;
          salesDivision?: unknown;
          enabled?: unknown;
        }
      | null;
    const name = normalizeTextValue(payload?.name);
    if (!name) {
      return NextResponse.json({ ok: false, error: "Market name is required." }, { status: 400 });
    }
    const divisionName = normalizeTextValue(payload?.salesDivision);
    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);
    let divisionId: number | null = null;
    if (divisionName) {
      divisionId = await findSalesDivisionId(pool, divisionName);
      if (divisionId == null) {
        return NextResponse.json(
          { ok: false, error: `Sales division "${divisionName}" not found.` },
          { status: 400 },
        );
      }
    }
    const enabled = normalizeBooleanInput(payload?.enabled ?? true);
    const insertRequest = pool.request();
    insertRequest.input("name", sql.NVarChar, name);
    insertRequest.input("divisionId", sql.Int, divisionId);
    insertRequest.input("enabled", sql.Bit, enabled ? 1 : 0);
    insertRequest.input("__userId", sql.NVarChar(450), auditUserId ?? null);
    const insertResult = await insertRequest.query<{ ID: number }>(`
      INSERT INTO dbo.Markets (Name, SalesDivisionID, Enabled, CreatedOn, CreatedBy, ModifiedOn, ModifiedBy)
      OUTPUT inserted.ID
      VALUES (@name, @divisionId, @enabled, SYSUTCDATETIME(), @__userId, SYSUTCDATETIME(), @__userId)
    `);
    const marketId = insertResult.recordset?.[0]?.ID ?? null;
    if (marketId == null) {
      throw new Error("Unable to create market.");
    }
    const selectRequest = pool.request();
    selectRequest.input("marketId", sql.Int, marketId);
    const selectResult = await selectRequest.query<{
      MarketID: number;
      Name: string | null;
      SalesDivision: string | null;
      Enabled: boolean | number | null;
    }>(`
      SELECT
        dbo.Markets.ID AS MarketID,
        dbo.Markets.Name,
        dbo.SalesDivision.Name AS SalesDivision,
        dbo.Markets.Enabled
      FROM dbo.Markets
      LEFT JOIN dbo.SalesDivision ON dbo.Markets.SalesDivisionID = dbo.SalesDivision.ID
      WHERE dbo.Markets.ID = @marketId
    `);
    const market = selectResult.recordset?.[0] ?? null;
    if (!market) {
      throw new Error("Unable to load created market.");
    }
    return NextResponse.json({ ok: true, market });
  } catch (err) {
    console.error("Failed to create market", err);
    const message = err instanceof Error ? err.message : "Failed to create market.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
