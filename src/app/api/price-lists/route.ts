import { NextRequest, NextResponse } from "next/server";
import sql from "mssql";
import { getPool } from "../../../lib/sql";

type TextFilterModel = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith";
  filter?: string;
};

type NumberFilterModel = {
  filterType: "number";
  type?:
    | "equals"
    | "notEqual"
    | "lessThan"
    | "greaterThan"
    | "lessThanOrEqual"
    | "greaterThanOrEqual"
    | "inRange";
  filter?: number;
  filterTo?: number;
};

type SetFilterModel = {
  filterType: "set";
  values?: Array<string | number | boolean>;
};

type DateFilterModel = {
  filterType: "date";
  type?:
    | "equals"
    | "notEqual"
    | "lessThan"
    | "greaterThan"
    | "lessThanOrEqual"
    | "greaterThanOrEqual"
    | "inRange";
  dateFrom?: string;
  dateTo?: string;
  filter?: string;
};

type KnownFilterModel = TextFilterModel | NumberFilterModel | SetFilterModel | DateFilterModel;

type GridRequest = {
  startRow: number;
  endRow: number;
  filterModel?: Record<string, KnownFilterModel> | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
};

type DeleteRequest = {
  PriceListIDs?: Array<number | string | null | undefined>;
};

type QueryParam = { key: string; value: string | number | boolean };

type PriceListRow = {
  PriceListID: number | null;
  Name: string | null;
  ValidFromDate: string | Date | null;
  ValidToDate: string | Date | null;
  Enabled: boolean | number | null;
  SupplierName: string | null;
  SupplierComment: string | null;
};

type PriceListRowWithCount = PriceListRow & { __totalCount: number | bigint | null };

const COLUMN_EXPRESSIONS: Record<string, string> = {
  PriceListID: "dbo.PriceLists.ID",
  Name: "dbo.PriceLists.Name",
  ValidFromDate: "dbo.PriceLists.ValidFromDate",
  ValidToDate: "dbo.PriceLists.ValidToDate",
  Enabled: "dbo.PriceLists.Enabled",
  SupplierName: "dbo.Suppliers.Name",
  SupplierComment: "dbo.PriceLists.SupplierComment",
};

function buildWhereAndParams(filterModel: GridRequest["filterModel"]) {
  if (!filterModel || Object.keys(filterModel).length === 0) return { where: "", params: [] as QueryParam[] };

  const parts: string[] = [];
  const params: QueryParam[] = [];
  const typedFilterModel = filterModel as Record<string, KnownFilterModel>;

  Object.entries(typedFilterModel).forEach(([col, fm], idx) => {
    const pBase = `${col}_${idx}`;
    const columnExpression = COLUMN_EXPRESSIONS[col] ?? `[${col}]`;
    switch (fm.filterType) {
      case "text": {
        const type = fm.type;
        const val = String(fm.filter ?? "");
        if (!val) break;
        if (type === "contains") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}%` });
        } else if (type === "equals") {
          parts.push(`${columnExpression} = @${pBase}`);
          params.push({ key: pBase, value: val });
        } else if (type === "startsWith") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `${val}%` });
        } else if (type === "endsWith") {
          parts.push(`${columnExpression} LIKE @${pBase}`);
          params.push({ key: pBase, value: `%${val}` });
        }
        break;
      }
      case "number": {
        const type = fm.type;
        const val = fm.filter !== undefined ? Number(fm.filter) : Number.NaN;
        const valTo = fm.filterTo !== undefined ? Number(fm.filterTo) : undefined;
        if (Number.isNaN(val)) break;
        if (type === "equals") parts.push(`${columnExpression} = @${pBase}`);
        if (type === "notEqual") parts.push(`${columnExpression} <> @${pBase}`);
        if (type === "lessThan") parts.push(`${columnExpression} < @${pBase}`);
        if (type === "greaterThan") parts.push(`${columnExpression} > @${pBase}`);
        if (type === "lessThanOrEqual") parts.push(`${columnExpression} <= @${pBase}`);
        if (type === "greaterThanOrEqual") parts.push(`${columnExpression} >= @${pBase}`);
        if (type === "inRange" && valTo !== undefined) {
          parts.push(`(${columnExpression} BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      case "set": {
        const rawValues = fm.values ?? [];
        if (rawValues.length === 0) break;

        const normalize = (value: string | number | boolean) => {
          if (value === true || value === "true") return 1;
          if (value === false || value === "false") return 0;
          return value;
        };

        const placeholders = rawValues.map((value, valueIdx) => {
          const key = `${pBase}_${valueIdx}`;
          params.push({ key, value: normalize(value) });
          return `@${key}`;
        });

        parts.push(`${columnExpression} IN (${placeholders.join(", ")})`);
        break;
      }
      case "date": {
        const type = fm.type;
        const val = fm.dateFrom || fm.filter;
        const valTo = fm.dateTo;
        if (!val) break;
        const dateExpression = `CAST(${columnExpression} AS date)`;
        if (type === "equals") parts.push(`${dateExpression} = @${pBase}`);
        if (type === "notEqual") parts.push(`${dateExpression} <> @${pBase}`);
        if (type === "lessThan") parts.push(`${dateExpression} < @${pBase}`);
        if (type === "greaterThan") parts.push(`${dateExpression} > @${pBase}`);
        if (type === "lessThanOrEqual") parts.push(`${dateExpression} <= @${pBase}`);
        if (type === "greaterThanOrEqual") parts.push(`${dateExpression} >= @${pBase}`);
        if (type === "inRange" && valTo) {
          parts.push(`(${dateExpression} BETWEEN @${pBase} AND @${pBase}_to)`);
          params.push({ key: `${pBase}_to`, value: valTo });
        }
        params.push({ key: pBase, value: val });
        break;
      }
      default:
        break;
    }
  });

  const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";
  return { where, params };
}

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
    /* swallow, use defaults */
  }
  return { startRow: 0, endRow: 100 };
}

const normalizePriceListId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export async function POST(req: NextRequest) {
  try {
    const requestPayload = await readGridRequest(req);
    const startRow = requestPayload.startRow ?? 0;
    const endRow = requestPayload.endRow ?? startRow + 100;
    const pageSize = Math.max(1, Math.min(1000, endRow - startRow));
    const offset = startRow;

    const select = `
      SELECT
        COUNT_BIG(1) OVER () AS __totalCount,
        dbo.PriceLists.ID AS PriceListID,
        dbo.PriceLists.Name,
        dbo.PriceLists.ValidFromDate,
        dbo.PriceLists.ValidToDate,
        dbo.PriceLists.Enabled,
        dbo.Suppliers.Name AS SupplierName,
        dbo.PriceLists.SupplierComment
    `;

    const from = `
      FROM dbo.PriceLists
      INNER JOIN dbo.Suppliers ON dbo.PriceLists.SupplierID = dbo.Suppliers.ID
    `;

    const { where, params: whereParams } = buildWhereAndParams(requestPayload.filterModel);
    const order = buildOrder(requestPayload.sortModel) || "ORDER BY dbo.PriceLists.Name";
    const paging = `OFFSET @__offset ROWS FETCH NEXT @__limit ROWS ONLY`;

    const dataSql = `${select} ${from} ${where} ${order} ${paging}`;

    const pool = await getPool();
    const dataReq = pool.request();
    whereParams.forEach((p) => dataReq.input(p.key, p.value));
    dataReq.input("__offset", sql.Int, offset);
    dataReq.input("__limit", sql.Int, pageSize);
    const dataRes = await dataReq.query<PriceListRowWithCount>(dataSql);

    const rowsWithCount = dataRes.recordset ?? [];
    const rowCount = rowsWithCount.length > 0 ? Number(rowsWithCount[0].__totalCount ?? 0) : 0;
    const rows = rowsWithCount.map((row: PriceListRowWithCount) => {
      const { __totalCount, ...rest } = row;
      void __totalCount;
      return rest;
    });

    return NextResponse.json({ ok: true, rows, rowCount });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    let body: DeleteRequest | null = null;
    try {
      body = (await req.json()) as DeleteRequest;
    } catch {
      body = null;
    }

    const rawIds = Array.isArray(body?.PriceListIDs) ? body.PriceListIDs : [];
    const normalizedIds = Array.from(
      new Set(
        rawIds
          .map((value) => normalizePriceListId(value ?? null))
          .filter((value): value is number => value != null),
      ),
    );

    if (normalizedIds.length === 0) {
      return NextResponse.json({ ok: false, error: "No price lists selected for deletion" }, { status: 400 });
    }

    const pool = await getPool();
    const chunkSize = 200;
    let deleted = 0;

    const transaction = new sql.Transaction(pool);
    await transaction.begin();

    try {
      for (let idx = 0; idx < normalizedIds.length; idx += chunkSize) {
        const chunk = normalizedIds.slice(idx, idx + chunkSize);
        if (chunk.length === 0) continue;

        const params = chunk.map((id, chunkIdx) => ({ name: `pl_${chunkIdx}`, value: id }));
        const paramNames = params.map((p) => `@${p.name}`);

        const deleteItemsReq = new sql.Request(transaction);
        params.forEach((p) => deleteItemsReq.input(p.name, sql.Int, p.value));
        await deleteItemsReq.query(`
          DELETE FROM dbo.PriceListItems
          WHERE PriceListID IN (${paramNames.join(", ")})
        `);

        const deletePriceListsReq = new sql.Request(transaction);
        params.forEach((p) => deletePriceListsReq.input(p.name, sql.Int, p.value));
        const result = await deletePriceListsReq.query(`
          DELETE dbo.PriceLists
          WHERE ID IN (${paramNames.join(", ")})
        `);

        deleted += result.rowsAffected?.[0] ?? 0;
      }

      await transaction.commit();
    } catch (txErr) {
      await transaction.rollback();
      throw txErr;
    }

    return NextResponse.json({ ok: true, deleted });
  } catch (err: unknown) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
