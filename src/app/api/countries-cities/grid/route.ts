import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import { getPool } from "../../../../lib/sql";
import { requirePermission } from "../../../../lib/authz";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  filterModel?: Record<string, KnownFilterModel> | null;
};

type GridBody = {
  request?: GridRequest | null;
};

type RawRow = {
  CountryID: number | null;
  Country: string | null;
  Enabled: boolean | number | null;
};

type TextFilterModel = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith";
  filter?: string;
};

type CompoundTextFilterModel = {
  filterType: "text";
  operator: "AND" | "OR";
  conditions: TextFilterModel[];
};

type SetFilterModel = {
  filterType: "set";
  values?: Array<string | number | boolean>;
};

type KnownFilterModel = TextFilterModel | CompoundTextFilterModel | SetFilterModel;

const applyQuickFilter = (rows: Record<string, unknown>[], query: string) => {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const values = Object.values(row).map((v) =>
      v == null ? "" : String(v).toLowerCase()
    );
    return terms.every((term) =>
      values.some((v) => v.includes(term))
    );
  });
};

const applyTextCondition = (value: unknown, model: TextFilterModel): boolean => {
  const filterValue = String(model.filter ?? "").toLowerCase();
  if (!filterValue) return true;
  const text = String(value ?? "").toLowerCase();
  switch (model.type ?? "contains") {
    case "equals":
      return text === filterValue;
    case "notEqual":
      return text !== filterValue;
    case "startsWith":
      return text.startsWith(filterValue);
    case "endsWith":
      return text.endsWith(filterValue);
    case "contains":
    default:
      return text.includes(filterValue);
  }
};

const applyTextFilter = (value: unknown, model: TextFilterModel | CompoundTextFilterModel): boolean => {
  if ("operator" in model && Array.isArray(model.conditions)) {
    const operator = model.operator === "OR" ? "OR" : "AND";
    const conditionResults = model.conditions
      .map((condition) => applyTextCondition(value, condition));
    if (conditionResults.length === 0) return true;
    if (operator === "OR") {
      return conditionResults.some(Boolean);
    }
    return conditionResults.every(Boolean);
  }
  return applyTextCondition(value, model);
};

const applySetFilter = (value: unknown, model: SetFilterModel): boolean => {
  const values = Array.isArray(model.values) ? model.values : [];
  if (values.length === 0) return true;
  return values.some((candidate) => String(candidate) === String(value ?? ""));
};

const applyFilterModel = (
  rows: Record<string, unknown>[],
  filterModel?: Record<string, KnownFilterModel> | null,
) => {
  if (!filterModel || Object.keys(filterModel).length === 0) return rows;
  return rows.filter((row) => {
    return Object.entries(filterModel).every(([field, model]) => {
      const value = row[field];
      if (!model) return true;
      if (model.filterType === "text") {
        return applyTextFilter(value, model as TextFilterModel | CompoundTextFilterModel);
      }
      if (model.filterType === "set") {
        return applySetFilter(value, model as SetFilterModel);
      }
      return true;
    });
  });
};

const applySort = (rows: Record<string, unknown>[], sortModel?: GridRequest["sortModel"]) => {
  if (!sortModel || sortModel.length === 0) return rows;
  const sorted = [...rows];
  sorted.sort((a, b) => {
    for (const entry of sortModel) {
      const key = entry.colId;
      const dir = entry.sort === "desc" ? -1 : 1;
      const av = a[key];
      const bv = b[key];
      if (av == null && bv == null) continue;
      if (av == null) return 1 * dir;
      if (bv == null) return -1 * dir;
      const aText = String(av);
      const bText = String(bv);
      const cmp = aText.localeCompare(bText, undefined, { sensitivity: "base" });
      if (cmp !== 0) return cmp * dir;
    }
    return 0;
  });
  return sorted;
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/countries-cities/grid');
  try {
    const auth = await requirePermission(req, "manageCitiesCountries");
    if (!auth.ok) return auth.response;

    const body = (await req.json().catch(() => null)) as GridBody | null;
    const request = body?.request ?? {};

    const pool = await getPool();
    const dbResult = await pool.request().query<RawRow>(`
      SELECT ID AS CountryID, Name AS Country, Enabled
      FROM dbo.Countries
      ORDER BY Name
    `);

    const rows: Record<string, unknown>[] = (dbResult.recordset ?? [])
      .filter((row) => row.CountryID != null)
      .map((row) => ({
        CountryID: row.CountryID,
        Country: row.Country?.trim() ?? "",
        Enabled: row.Enabled,
      }));

    const quickFiltered = request?.quickFilterText ? applyQuickFilter(rows, request.quickFilterText) : rows;
    const filtered = applyFilterModel(quickFiltered, request?.filterModel ?? null);
    const sorted = applySort(filtered, request?.sortModel);

    const startRow = request?.startRow ?? 0;
    const endRow = request?.endRow ?? startRow + 100;
    const pageSize = Math.max(1, endRow - startRow);
    const paged = sorted.slice(startRow, startRow + pageSize);

    return NextResponse.json({ ok: true, rows: paged, rowCount: sorted.length });
  } catch (err) {
    console.error(err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
