import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../../lib/apiHelpers';
import sql from "mssql";
import { getPool } from "../../../../../lib/sql";
import { buildAuditContext, resolveAuditUserId } from "../../../../../lib/auditTrail";
import { fetchUserRoles } from "../../../../../lib/authz";
import { checkDeletePermission } from "../../../../../lib/deletePermissions";
import { KnownFilterModel, TextCondition, isCompoundFilter } from "../../../../../lib/filterTypes";
import { processFilter } from "../../../../../lib/filterProcessing";
import { clearPartModelNumberUpper } from "../../../../../lib/partModelNumber";

type GridRequest = {
  startRow: number;
  endRow: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type QueryParam = { key: string; value: string | number | boolean };

type PriceListProductRow = {
  ProductID: number | null;
  Description: string | null;
  ListPrice: string | number | null;
  CostPrice: string | number | null;
  CostPriceOtherCurrency: string | number | null;
  CostCurrencyName: string | null;
  Warning: string | number | boolean | null;
  Enabled: boolean | number | null;
  PartNumber: string | null;
  ModelNumber: string | null;
  PriceListID: number | null;
  PriceListItemID: number | null;
};

type PriceListProductRowWithCount = PriceListProductRow & {
  __totalCount: number | bigint | null;
};

type PriceListProductUpdateInput = {
  PriceListItemID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedPriceListProductUpdate = {
  priceListItemId: number;
  field: "Enabled" | "ModelNumber";
  value: unknown;
};

const COLUMN_EXPRESSIONS: Record<string, string> = {
  ProductID: "dbo.Products.ID",
  Description: "dbo.Products.Description",
  ModelNumber: "dbo.Products.ModelNumber",
  ListPrice: "dbo.PriceListItems.ListPrice",
  // Display cost in EUR by applying the price list's currency cost modifier.
  // PriceListItems.CostPrice stores the supplier cost in the price list's cost currency.
  CostPrice: "(dbo.PriceListItems.CostPrice * COALESCE(pl.CurrencyCostModifier, 1))",
  CostPriceOtherCurrency: "dbo.PriceListItems.CostPrice",
  CostCurrencyName: "costCur.Name",
  Warning: "dbo.PriceListItems.Warning",
  Enabled: "dbo.PriceListItems.Enabled",
  PartNumber: "dbo.Products.PartNumber",
  PriceListID: "dbo.PriceListItems.PriceListID",
  PriceListItemID: "dbo.PriceListItems.ID" };

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return Boolean(value);
};

const normalizeModelNumberInput = (value: unknown): string | null => {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text;
};

// Normalize part/model numbers by removing special characters and uppercasing.
const normalizePartModelNumber = (value: string): string => clearPartModelNumberUpper(value);

// Uses the existing PartNumberCleared and ModelNumberCleared columns for better performance.
const partModelNumberSql = (expr: string) => {
  if (expr.includes(".PartNumber")) {
    return `UPPER(ISNULL(${expr.replace(".PartNumber", ".PartNumberCleared")}, ''))`;
  }
  if (expr.includes(".ModelNumber")) {
    return `UPPER(ISNULL(${expr.replace(".ModelNumber", ".ModelNumberCleared")}, ''))`;
  }
  return `UPPER(ISNULL(${expr}, ''))`;
};

const buildWhereAndParams = (filterModel: GridRequest["filterModel"]) => {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  const descriptionSql = (expr: string) =>
    `UPPER(COALESCE(CAST(${expr} AS NVARCHAR(MAX)), ''))`;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    const isPartNumber = col === "PartNumber";
    const isModelNumber = col === "ModelNumber";
    const isDescription = col === "Description";
    const isPartOrModel = isPartNumber || isModelNumber;

    // Match products page behavior: cleared + reverse-search for part/model single text condition.
    if (isPartOrModel && fm.filterType === "text" && !isCompoundFilter(fm)) {
      const typedFm = fm as TextCondition;
      const type = typedFm.type;
      const val = String(typedFm.filter ?? "");
      if (!val) return;

      const normalizedVal = normalizePartModelNumber(val);
      const rawVal = val.trim().toUpperCase();
      const otherColumnExpression = isPartNumber
        ? COLUMN_EXPRESSIONS.ModelNumber
        : COLUMN_EXPRESSIONS.PartNumber;

      // Cross-search: ModelNumber also searches Description (raw value)
      const descExpr = isModelNumber ? COLUMN_EXPRESSIONS.Description : null;
      const descParam = `${pBase}_desc`;

      if (type === "contains") {
        let clause = `(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase}`;
        params.push({ key: pBase, value: `%${normalizedVal}%` });
        if (descExpr) {
          clause += ` OR ${descriptionSql(descExpr)} LIKE @${descParam}`;
          params.push({ key: descParam, value: `%${rawVal}%` });
        }
        parts.push(`${clause})`);
        return;
      }
      if (type === "equals") {
        let clause = `(${partModelNumberSql(columnExpression)} = @${pBase} OR ${partModelNumberSql(otherColumnExpression)} = @${pBase}`;
        params.push({ key: pBase, value: normalizedVal });
        if (descExpr) {
          clause += ` OR ${descriptionSql(descExpr)} = @${descParam}`;
          params.push({ key: descParam, value: rawVal });
        }
        parts.push(`${clause})`);
        return;
      }
      if (type === "startsWith") {
        let clause = `(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase}`;
        params.push({ key: pBase, value: `${normalizedVal}%` });
        if (descExpr) {
          clause += ` OR ${descriptionSql(descExpr)} LIKE @${descParam}`;
          params.push({ key: descParam, value: `${rawVal}%` });
        }
        parts.push(`${clause})`);
        return;
      }
      if (type === "endsWith") {
        let clause = `(${partModelNumberSql(columnExpression)} LIKE @${pBase} OR ${partModelNumberSql(otherColumnExpression)} LIKE @${pBase}`;
        params.push({ key: pBase, value: `%${normalizedVal}` });
        if (descExpr) {
          clause += ` OR ${descriptionSql(descExpr)} LIKE @${descParam}`;
          params.push({ key: descParam, value: `%${rawVal}` });
        }
        parts.push(`${clause})`);
        return;
      }
    }

    // Cross-search: Description also searches ModelNumber
    if (isDescription && fm.filterType === "text" && !isCompoundFilter(fm)) {
      const typedFm = fm as TextCondition;
      const type = typedFm.type;
      const val = String(typedFm.filter ?? "");
      if (!val) return;

      const rawVal = val.trim().toUpperCase();
      const modelExpr = COLUMN_EXPRESSIONS.ModelNumber;
      const modelParam = `${pBase}_model`;
      const descExpr = descriptionSql(columnExpression);

      if (type === "contains") {
        parts.push(`(${descExpr} LIKE @${pBase} OR ${partModelNumberSql(modelExpr)} LIKE @${modelParam})`);
        params.push({ key: pBase, value: `%${rawVal}%` });
        params.push({ key: modelParam, value: `%${rawVal}%` });
        return;
      }
      if (type === "equals") {
        parts.push(`(${descExpr} = @${pBase} OR ${partModelNumberSql(modelExpr)} = @${modelParam})`);
        params.push({ key: pBase, value: rawVal });
        params.push({ key: modelParam, value: rawVal });
        return;
      }
      if (type === "startsWith") {
        parts.push(`(${descExpr} LIKE @${pBase} OR ${partModelNumberSql(modelExpr)} LIKE @${modelParam})`);
        params.push({ key: pBase, value: `${rawVal}%` });
        params.push({ key: modelParam, value: `${rawVal}%` });
        return;
      }
      if (type === "endsWith") {
        parts.push(`(${descExpr} LIKE @${pBase} OR ${partModelNumberSql(modelExpr)} LIKE @${modelParam})`);
        params.push({ key: pBase, value: `%${rawVal}` });
        params.push({ key: modelParam, value: `%${rawVal}` });
        return;
      }
    }

    // Use centralized filter processor
    const result = processFilter(fm, {
      columnExpression,
      columnId: col,
      paramBase: pBase,
    });

    if (result.clause) {
      parts.push(result.clause);
      params.push(...result.params);
    }
  });

  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return { where, params };
};

const ensureEnabledFilterModel = (
  filterModel: GridRequest["filterModel"],
) => {
  const base =
    (filterModel && typeof filterModel === "object" ? { ...filterModel } : {}) as Record<
      string,
      KnownFilterModel
    >;
  if ("Enabled" in base) {
    return base;
  }
  base.Enabled = { filterType: "set", values: ["true"] };
  return base;
};


function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((s) => {
    const expression = COLUMN_EXPRESSIONS[s.colId] ?? `[${s.colId}]`;
    return `${expression} ${s.sort.toUpperCase()}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
}

async function readGridRequest(req: NextRequest): Promise<GridRequest> {
  try {
    const payload = await req.json();
    if (payload && typeof payload === "object" && "request" in payload) {
      const inner = (payload as { request?: GridRequest }).request;
      if (inner && typeof inner === "object") return inner;
    }
  } catch {
    /* ignore */
  }
  return { startRow: 0, endRow: 100 };
}

type DeleteRequest = {
  PriceListItemIDs?: Array<number | string | null | undefined>;
};

const normalizePriceListItemId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(req, '/api/price-lists/[priceListId]/products');
  try {
    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? "")).trim();
    if (!normalizedId) {
      return NextResponse.json(
        { ok: false, error: "Missing price list id", rows: [], rowCount: 0 },
        { status: 400 },
      );
    }
    const idValue = Number(normalizedId);
    if (!Number.isFinite(idValue) || !Number.isInteger(idValue)) {
      return NextResponse.json(
        { ok: false, error: "Invalid price list id", rows: [], rowCount: 0 },
        { status: 400 },
      );
    }

    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = Math.max(0, startRow);

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Products.ID AS ProductID,
        dbo.Products.Description,
        dbo.Products.ModelNumber,
        dbo.PriceListItems.ListPrice,
        (dbo.PriceListItems.CostPrice * COALESCE(pl.CurrencyCostModifier, 1)) AS CostPrice,
        dbo.PriceListItems.CostPrice AS CostPriceOtherCurrency,
        costCur.Name AS CostCurrencyName,
        dbo.PriceListItems.Warning,
        dbo.PriceListItems.Enabled,
        dbo.Products.PartNumber,
        dbo.PriceListItems.ID AS PriceListItemID,
        dbo.PriceListItems.PriceListID
    `;

    const from = `
      FROM dbo.PriceListItems
      INNER JOIN dbo.PriceLists pl ON dbo.PriceListItems.PriceListID = pl.ID
      INNER JOIN dbo.Products ON dbo.PriceListItems.ProductID = dbo.Products.ID
      LEFT JOIN dbo.Currencies costCur ON pl.CostCurrencyID = costCur.ID
    `;

    const baseWhere = "WHERE dbo.PriceListItems.PriceListID = @__priceListId";
    const normalizedFilterModel = ensureEnabledFilterModel(requestPayload.filterModel);
    const { where, params: whereParams } = buildWhereAndParams(normalizedFilterModel);
    const trimmedWhere = where.trim().replace(/^WHERE\s+/i, "");
    const combinedWhere = trimmedWhere
      ? `${baseWhere} AND ${trimmedWhere}`
      : baseWhere;
    const order = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.Products.Description";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const query = `${select} ${from} ${combinedWhere} ${order} ${paging}`;

    const pool = await getPool();
    const sqlRequest = pool.request();
    sqlRequest.input("__priceListId", sql.Int, idValue);
    whereParams.forEach((p) => sqlRequest.input(p.key, p.value));
    sqlRequest.input("__offset", sql.Int, offset);
    sqlRequest.input("__limit", sql.Int, pageSize);

    const result = await sqlRequest.query<PriceListProductRowWithCount>(query);
    const rowsWithCount = result.recordset ?? [];
    const rowCount =
      rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json(
      { ok: false, error: message, rows: [], rowCount: 0 },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(req, '/api/price-lists/[priceListId]/products');
  try {
    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? "")).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: "Missing price list id" }, { status: 400 });
    }
    const idValue = Number(normalizedId);
    if (!Number.isFinite(idValue) || !Number.isInteger(idValue)) {
      return NextResponse.json({ ok: false, error: "Invalid price list id" }, { status: 400 });
    }

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: PriceListProductUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: PriceListProductUpdateInput[] }).updates ?? [])
      : [];

    const normalized: NormalizedPriceListProductUpdate[] = updates
      .map((entry) => {
        const itemId = normalizePriceListItemId(entry?.PriceListItemID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (itemId == null || (field !== "Enabled" && field !== "ModelNumber")) return null;
        if (field === "Enabled") {
          return { priceListItemId: itemId, field: "Enabled", value: entry?.value };
        }
        const normalizedValue = normalizeModelNumberInput(entry?.value);
        if (normalizedValue != null && normalizedValue.length > 255) return null;
        return { priceListItemId: itemId, field: "ModelNumber", value: normalizedValue };
      })
      .filter((entry): entry is NormalizedPriceListProductUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);
    for (const update of normalized) {
      const request = pool.request();
      request.input("__priceListId", sql.Int, idValue);
      request.input("__itemId", sql.Int, update.priceListItemId);
      request.input("__modifiedBy", sql.NVarChar(450), auditUserId ?? null);
      if (update.field === "Enabled") {
        request.input("__enabled", sql.Bit, normalizeBooleanInput(update.value) ? 1 : 0);
        await request.query(`
          UPDATE dbo.PriceListItems
          SET Enabled = @__enabled,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @__modifiedBy
          WHERE ID = @__itemId
            AND PriceListID = @__priceListId
        `);
        continue;
      }

      const modelNumber = normalizeModelNumberInput(update.value);
      request.input("__modelNumber", sql.NVarChar(255), modelNumber);
      request.input(
        "__modelNumberCleared",
        sql.NVarChar(255),
        modelNumber ? clearPartModelNumberUpper(modelNumber) : null,
      );
      await request.query(`
        UPDATE p
        SET p.ModelNumber = @__modelNumber,
          p.ModelNumberCleared = @__modelNumberCleared,
          p.ModifiedOn = SYSUTCDATETIME(),
          p.ModifiedBy = @__modifiedBy
        FROM dbo.Products p
        INNER JOIN dbo.PriceListItems pli ON pli.ProductID = p.ID
        WHERE pli.ID = @__itemId
          AND pli.PriceListID = @__priceListId
      `);
    }

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ priceListId: string }> },
) {
  logRequest(req, '/api/price-lists/[priceListId]/products');
  try {
    const { priceListId } = await params;
    const normalizedId = decodeURIComponent(String(priceListId ?? "")).trim();
    if (!normalizedId) {
      return NextResponse.json({ ok: false, error: "Missing price list id" }, { status: 400 });
    }
    const idValue = Number(normalizedId);
    if (!Number.isFinite(idValue) || !Number.isInteger(idValue)) {
      return NextResponse.json({ ok: false, error: "Invalid price list id" }, { status: 400 });
    }

    let body: DeleteRequest | null = null;
    try {
      body = (await req.json()) as DeleteRequest;
    } catch {
      body = null;
    }

    const rawIds = Array.isArray(body?.PriceListItemIDs) ? (body?.PriceListItemIDs ?? []) : [];
    const normalizedIds = Array.from(
      new Set(
        rawIds
          .map((value) => normalizePriceListItemId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No rows selected for deletion" }, { status: 400 });
    }

    const audit = buildAuditContext(req);
    const roles = await fetchUserRoles(audit.userId);
    const deleteCheck = checkDeletePermission(roles, normalizedIds.length, 'generic', null);
    if (!deleteCheck.allowed) {
      return NextResponse.json({ ok: false, error: deleteCheck.reason }, { status: 403 });
    }

    const pool = await getPool();
    const chunkSize = 200;
    let deleted = 0;

    for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
      const chunk = normalizedIds.slice(idx, idx + chunkSize);
      if (chunk.length === 0) continue;
      const request = pool.request();
      request.input("__priceListId", sql.Int, idValue);
      const paramNames: string[] = [];
      chunk.forEach((id, chunkIdx) => {
        const paramName = `pli_${chunkIdx}`;
        request.input(paramName, sql.Int, id);
        paramNames.push(`@${paramName}`);
      });
      const query = `
        DELETE FROM dbo.PriceListItems
        WHERE PriceListID = @__priceListId
          AND ID IN (${paramNames.join(", ")})
      `;
      const result = await request.query(query);
      deleted += result.rowsAffected?.[0] ?? 0;
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
