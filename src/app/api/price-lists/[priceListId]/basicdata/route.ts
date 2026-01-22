import { NextRequest, NextResponse } from "next/server";
import sql, { type ISqlTypeFactory } from "mssql";
import { getPool } from "../../../../../lib/sql";
import { resolveAuditUserId } from "../../../../../lib/auditTrail";
import type { PriceListBasicUpdateField } from "../../../../price-lists/[priceListId]/PriceListBasicDataTypes";

type UpdateInput = {
  field?: PriceListBasicUpdateField;
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
  sqlType: ISqlTypeFactory | unknown;
};

type NormalizedUpdate = {
  field: PriceListBasicUpdateField;
  config: FieldConfig;
  value: NormalizedValue;
};

const FIELD_CONFIG: Record<PriceListBasicUpdateField, FieldConfig> = {
  Name: { column: "Name", type: "string", sqlType: sql.NVarChar, length: 512 },
  ValidFromDate: { column: "ValidFromDate", type: "date", sqlType: sql.DateTime2 },
  ValidToDate: { column: "ValidToDate", type: "date", sqlType: sql.DateTime2 },
  Comments: { column: "Comments", type: "string", sqlType: sql.NVarChar, length: 2000 },
  SupplierComment: { column: "SupplierComment", type: "string", sqlType: sql.NVarChar, length: 2000 },
  FilePath: { column: "FilePath", type: "string", sqlType: sql.NVarChar, length: 1000 },
  BrandID: { column: "BrandID", type: "number", sqlType: sql.Int },
  CountryId: { column: "CountryId", type: "number", sqlType: sql.Int },
  SupplierID: { column: "SupplierID", type: "number", sqlType: sql.Int },
  CurrencyId: { column: "CurrencyId", type: "number", sqlType: sql.Int },
  CostCurrencyID: { column: "CostCurrencyID", type: "number", sqlType: sql.Int },
  CurrencyCostModifier: {
    column: "CurrencyCostModifier",
    type: "number",
    sqlType: (sql as unknown as { Decimal: (precision: number, scale: number) => unknown }).Decimal(18, 4),
  },
  ResponsibleUserId: { column: "ResponsibleUserId", type: "string", sqlType: sql.NVarChar, length: 450 },
  Enabled: { column: "Enabled", type: "number", sqlType: sql.Bit },
  HasDuty: { column: "HasDuty", type: "number", sqlType: sql.Bit },
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
  { params }: { params: Promise<{ priceListId: string }> },
) {
  try {
    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? "")).trim();
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

    const updates = body && Array.isArray(body.updates) ? body.updates : [];
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

    // Currency is always EUR. Resolve EUR currency ID (for enforcing cost modifier = 1 when cost currency is EUR/null).
    const eurLookup = await pool.request().query<{ ID: number; Name: string | null }>(`
      SELECT TOP 1 ID, Name
      FROM dbo.Currencies
      ORDER BY
        CASE
          WHEN Name = N'€' THEN 0
          WHEN LOWER(Name) LIKE '%eur%' THEN 1
          WHEN LOWER(Name) LIKE '%euro%' THEN 2
          ELSE 3
        END,
        Name
    `);
    const eurCurrencyId = eurLookup.recordset?.[0]?.ID ?? null;

    // Determine effective cost currency (incoming update or current DB value).
    const incomingCostCurrency = normalizedUpdates.find((u) => u.field === "CostCurrencyID")?.value;
    const currentRow = await pool
      .request()
      .input("__priceListId", sql.Int, parsedId)
      .query<{ CostCurrencyID: number | null }>(`
        SELECT TOP 1 CostCurrencyID
        FROM dbo.PriceLists
        WHERE ID = @__priceListId
      `);
    const currentCostCurrencyId = currentRow.recordset?.[0]?.CostCurrencyID ?? null;
    const effectiveCostCurrencyId =
      incomingCostCurrency !== undefined ? (incomingCostCurrency as number | null) : currentCostCurrencyId;
    const isEuroCostCurrency =
      effectiveCostCurrencyId == null || (eurCurrencyId != null && effectiveCostCurrencyId === eurCurrencyId);

    const filteredUpdates = normalizedUpdates.filter((u) => {
      if (u.field === "CurrencyCostModifier" && isEuroCostCurrency) return false;
      return true;
    });
    if (filteredUpdates.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const request = pool.request();
    request.input("__priceListId", sql.Int, parsedId);

    const setClauses: string[] = [];

    filteredUpdates.forEach((update, idx) => {
      const paramName = `field_${idx}`;
      const { config, value } = update;
      if (config.sqlType === sql.NVarChar) {
        request.input(paramName, sql.NVarChar(config.length ?? sql.MAX), value);
      } else {
        request.input(paramName, config.sqlType, value);
      }
      setClauses.push(`[${config.column}] = @${paramName}`);
    });

    if (isEuroCostCurrency) {
      setClauses.push("[CurrencyCostModifier] = 1");
    }

    const auditUserId = resolveAuditUserId(req);
    if (auditUserId) {
      request.input("__modifiedBy", sql.NVarChar(450), auditUserId);
      setClauses.push("[ModifiedBy] = @__modifiedBy");
    }
    setClauses.push("[ModifiedOn] = SYSUTCDATETIME()");

    const query = `
      UPDATE dbo.PriceLists
      SET ${setClauses.join(", ")}
      WHERE ID = @__priceListId;
    `;
    const result = await request.query(query);
    const rowsAffected = result.rowsAffected?.[0] ?? 0;

    return NextResponse.json({ ok: true, updated: filteredUpdates.length, rowsAffected });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
