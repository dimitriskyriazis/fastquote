import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import type { Request as SqlRequest } from "mssql";
import { getPool } from "../../../lib/sql";
import { resolveAuditUserId } from "../../../lib/auditTrail";
import {
  buildQuickFilterClause,
  mergeWhereClauses,
  QueryParam,
} from "../../../lib/gridFilters";
import { requirePermission } from "../../../lib/authz";
import { KnownFilterModel } from "../../../lib/filterTypes";
import { processFilter } from "../../../lib/filterProcessing";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  rowGroupCols?: Array<{ field?: string | null; colId?: string | null }>;
  groupKeys?: Array<string | null>;
};

type SupplierRow = {
  SupplierID: number | null;
  Name: string | null;
  Address: string | null;
  AddressNo: string | null;
  City: string | null;
  Country: string | null;
  PostalCode: string | null;
  Phone: string | null;
  WebSite: string | null;
  Comments: string | null;
  Enabled: boolean | number | null;
};

type SupplierRowWithCount = SupplierRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  SupplierID: "dbo.Suppliers.ID",
  Name: "dbo.Suppliers.Name",
  Address: "dbo.Suppliers.Address",
  AddressNo: "dbo.Suppliers.AddressNo",
  City: "dbo.Cities.Name",
  Country: "dbo.Countries.Name",
  PostalCode: "dbo.Suppliers.PostalCode",
  Phone: "dbo.Suppliers.Phone",
  WebSite: "dbo.Suppliers.WebSite",
  Comments: "dbo.Suppliers.Comments",
  Enabled: "dbo.Suppliers.Enabled",
};

const QUICK_FILTER_COLUMNS = Object.entries(COLUMN_EXPRESSIONS).map(([colId, expression]) => ({
  colId,
  expression,
}));

type SupplierUpdateInput = {
  SupplierID?: number | string | null;
  field?: string | null;
  value?: unknown;
};

type NormalizedSupplierUpdate = {
  supplierId: number;
  field: keyof typeof COLUMN_EXPRESSIONS;
  value: unknown;
};

type SupplierDeleteBody = {
  SupplierIDs?: Array<number | string | null>;
};

class SupplierUpdateError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SupplierUpdateError";
    this.status = status;
  }
}

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) {
    return { where: "", params: [] as QueryParam[] };
  }

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typed = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typed).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;

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

  return {
    where: parts.length ? `WHERE ${parts.join(" AND ")}` : "",
    params,
  };
}

function buildOrder(sortModel: GridRequest["sortModel"]) {
  if (!sortModel || sortModel.length === 0) return "";
  const parts = sortModel.map((entry) => {
    const expr = COLUMN_EXPRESSIONS[entry.colId] ?? `[${entry.colId}]`;
    return `${expr} ${entry.sort.toUpperCase()}`;
  });
  return `ORDER BY ${parts.join(", ")}`;
}

const ensureEnabledFilterModel = (
  filterModel: GridRequest["filterModel"],
): Record<string, KnownFilterModel> => {
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

const normalizeSupplierId = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeBooleanInput = (value: unknown): boolean => {
  if (value === 1 || value === true || value === "1") return true;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y"].includes(normalized)) return true;
    if (["false", "no", "n", "0"].includes(normalized)) return false;
  }
  return false;
};

const normalizeTextValue = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  return String(value).trim();
};

async function readGridRequest(req: NextRequest): Promise<GridRequest> {
  try {
    const payload = await req.json();
    if (payload && typeof payload === "object" && "request" in payload) {
      const inner = (payload as { request?: GridRequest }).request;
      if (inner && typeof inner === "object") return inner;
    }
  } catch {
    /* noop */
  }
  return { startRow: 0, endRow: 100 };
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const gridRequest = await readGridRequest(req);
    const startRow = gridRequest.startRow ?? 0;
    const endRow = gridRequest.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const normalizedFilterModel = ensureEnabledFilterModel(gridRequest.filterModel);
    const { where, params: whereParams } = buildWhereAndParams(normalizedFilterModel);
    const quickFilterClause = buildQuickFilterClause(gridRequest.quickFilterText, QUICK_FILTER_COLUMNS);
    const combinedWhere = mergeWhereClauses(where, quickFilterClause.clause);
    const combinedParams = [...whereParams, ...quickFilterClause.params];
    const orderClause = buildOrder(gridRequest.sortModel) || "ORDER BY dbo.Suppliers.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.Suppliers.ID AS SupplierID,
        dbo.Suppliers.Name,
        dbo.Suppliers.Address,
        dbo.Suppliers.AddressNo,
        dbo.Cities.Name AS City,
        dbo.Countries.Name AS Country,
        dbo.Suppliers.PostalCode,
        dbo.Suppliers.Phone,
        dbo.Suppliers.WebSite,
        dbo.Suppliers.Comments,
        dbo.Suppliers.Enabled
      FROM dbo.Suppliers
      LEFT OUTER JOIN dbo.Cities ON dbo.Suppliers.CityID = dbo.Cities.ID
      LEFT OUTER JOIN dbo.Countries ON dbo.Suppliers.CountryID = dbo.Countries.ID
    `;

    const pool = await getPool();
    const bindParams = (request: SqlRequest, paramsList: QueryParam[]) => {
      paramsList.forEach((param) => request.input(param.key, param.value));
      return request;
    };

    const dataSql = `${select} ${combinedWhere} ${orderClause} ${paging}`;
    const dataReq = bindParams(pool.request(), combinedParams);
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    const dataRes = await dataReq.query<SupplierRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = await req.json().catch(() => null);
    const updates = Array.isArray((body as { updates?: SupplierUpdateInput[] } | null)?.updates)
      ? ((body as { updates?: SupplierUpdateInput[] }).updates ?? [])
      : [];
    const normalized: NormalizedSupplierUpdate[] = updates
      .map((entry) => {
        const supplierId = normalizeSupplierId(entry?.SupplierID ?? null);
        const field = typeof entry?.field === "string" ? entry.field : null;
        if (
          supplierId == null ||
          !field ||
          !(field in COLUMN_EXPRESSIONS)
        ) {
          return null;
        }
        return {
          supplierId,
          field: field as keyof typeof COLUMN_EXPRESSIONS,
          value: entry?.value,
        } as NormalizedSupplierUpdate;
      })
      .filter((entry): entry is NormalizedSupplierUpdate => entry != null);

    if (normalized.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid updates provided" }, { status: 400 });
    }

    const pool = await getPool();
    const auditUserId = resolveAuditUserId(req);

    for (const update of normalized) {
      const request = pool.request();
      request.input("supplierId", sql.Int, update.supplierId);
      request.input("userId", sql.NVarChar(450), auditUserId ?? null);

      if (update.field === "Enabled") {
        request.input("value", sql.Bit, normalizeBooleanInput(update.value) ? 1 : 0);
        await request.query(`
          UPDATE dbo.Suppliers
          SET Enabled = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @supplierId
        `);
      } else if (update.field === "City") {
        const cityName = normalizeTextValue(update.value);
        if (!cityName) {
          request.input("cityId", sql.Int, null);
          await request.query(`
            UPDATE dbo.Suppliers
            SET CityID = @cityId,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
            WHERE ID = @supplierId
          `);
        } else {
          const lookup = pool.request();
          lookup.input("cityName", sql.NVarChar, cityName);
          const lookupResult = await lookup.query<{ ID: number }>(`
            SELECT TOP 1 ID
            FROM dbo.Cities
            WHERE Name = @cityName
            ORDER BY ID
          `);
          const cityId = lookupResult.recordset?.[0]?.ID ?? null;
          if (cityId == null) {
            throw new SupplierUpdateError(`City "${cityName}" not found`, 400);
          }
          request.input("cityId", sql.Int, cityId);
          await request.query(`
            UPDATE dbo.Suppliers
            SET CityID = @cityId,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
            WHERE ID = @supplierId
          `);
        }
      } else if (update.field === "Country") {
        const countryName = normalizeTextValue(update.value);
        if (!countryName) {
          request.input("countryId", sql.Int, null);
          await request.query(`
            UPDATE dbo.Suppliers
            SET CountryID = @countryId,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
            WHERE ID = @supplierId
          `);
        } else {
          const lookup = pool.request();
          lookup.input("countryName", sql.NVarChar, countryName);
          const lookupResult = await lookup.query<{ ID: number }>(`
            SELECT TOP 1 ID
            FROM dbo.Countries
            WHERE Name = @countryName
            ORDER BY ID
          `);
          const countryId = lookupResult.recordset?.[0]?.ID ?? null;
          if (countryId == null) {
            throw new SupplierUpdateError(`Country "${countryName}" not found`, 400);
          }
          request.input("countryId", sql.Int, countryId);
          await request.query(`
            UPDATE dbo.Suppliers
            SET CountryID = @countryId,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @userId
            WHERE ID = @supplierId
          `);
        }
      } else {
        request.input("value", sql.NVarChar, normalizeTextValue(update.value));
        const columnName = update.field === 'SupplierID' ? 'ID' : update.field;
        await request.query(`
          UPDATE dbo.Suppliers
          SET [${columnName}] = @value,
            ModifiedOn = SYSUTCDATETIME(),
            ModifiedBy = @userId
          WHERE ID = @supplierId
        `);
      }
    }

    return NextResponse.json({ ok: true, updated: normalized.length });
  } catch (err) {
    console.error(err);
    if (err instanceof SupplierUpdateError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: err.status });
    }
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const auth = await requirePermission(req, "manageBrandsSuppliers");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as SupplierDeleteBody | null;
    const rawIds = Array.isArray(body?.SupplierIDs) ? body.SupplierIDs : [];
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
      return NextResponse.json({ ok: false, error: "No suppliers provided" }, { status: 400 });
    }
    const pool = await getPool();
    const request = pool.request();
    ids.forEach((value, idx) => {
      request.input(`id${idx}`, sql.Int, value);
    });
    await request.query(`
      DELETE FROM dbo.Suppliers
      WHERE ID IN (${ids.map((_, idx) => `@id${idx}`).join(", ")})
    `);
    return NextResponse.json({ ok: true, deleted: ids.length });
  } catch (err) {
    console.error("Failed to delete suppliers", err);
    const message = err instanceof Error ? err.message : "Unable to delete suppliers.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
