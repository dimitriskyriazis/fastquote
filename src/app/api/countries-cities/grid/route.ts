import { NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../lib/sql";

type GridRequest = {
  startRow?: number;
  endRow?: number;
  quickFilterText?: string | null;
  sortModel?: Array<{ colId: string; sort: "asc" | "desc" }>;
  filterModel?: Record<string, KnownFilterModel> | null;
};

type GridBody = {
  request?: GridRequest | null;
  fields?: string[] | null;
};

type RawRow = {
  CountryID: number | null;
  Country: string | null;
  CityID: number | null;
  City: string | null;
};

type CountryRow = {
  CountryID: number;
  Country: string;
  cities: Array<{ id: number; name: string }>;
};

const CITY_FIELD_PREFIX = "City";

const parseCityFieldIndex = (field: string): number | null => {
  if (!field.startsWith(CITY_FIELD_PREFIX)) return null;
  const suffix = field.slice(CITY_FIELD_PREFIX.length);
  if (!suffix) return null;
  const parsed = Number.parseInt(suffix, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

type TextFilterModel = {
  filterType: "text";
  type?: "contains" | "equals" | "notEqual" | "startsWith" | "endsWith";
  filter?: string;
};

type SetFilterModel = {
  filterType: "set";
  values?: Array<string | number | boolean>;
};

type KnownFilterModel = TextFilterModel | SetFilterModel;

const applyQuickFilter = (rows: Record<string, unknown>[], query: string) => {
  const needle = query.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter((row) => {
    return Object.values(row).some((value) => {
      if (value == null) return false;
      const text = String(value).toLowerCase();
      return text.includes(needle);
    });
  });
};

const applyTextFilter = (value: unknown, model: TextFilterModel): boolean => {
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
        return applyTextFilter(value, model as TextFilterModel);
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
  try {
    const body = (await req.json().catch(() => null)) as GridBody | null;
    const request = body?.request ?? {};
    const fields = Array.isArray(body?.fields) ? body?.fields.filter((f) => typeof f === "string") : [];

    const pool = await getPool();
    const dbResult = await pool.request().query<RawRow>(`
      SELECT c.ID AS CountryID, c.Name AS Country, ct.ID AS CityID, ct.Name AS City
      FROM dbo.Countries c
      LEFT JOIN dbo.Cities ct
        ON c.ID = ct.CountryID
       AND ct.Enabled = 1
      WHERE c.Enabled = 1
      ORDER BY c.Name, ct.Name
    `);

    const ordered: CountryRow[] = [];
    const indexById = new Map<number, CountryRow>();
    for (const row of dbResult.recordset ?? []) {
      const id = row.CountryID;
      const name = row.Country?.trim() ?? "";
      if (id == null || !name) continue;
      let entry = indexById.get(id);
      if (!entry) {
        entry = { CountryID: id, Country: name, cities: [] };
        indexById.set(id, entry);
        ordered.push(entry);
      }
      const cityName = row.City?.trim();
      const cityId = row.CityID;
      if (cityName && typeof cityId === "number") entry.cities.push({ id: cityId, name: cityName });
    }

    const maxCityField = fields
      .map((field) => parseCityFieldIndex(field) ?? 0)
      .reduce((max, idx) => Math.max(max, idx), 0);

    const maxCities = maxCityField > 0
      ? maxCityField
      : ordered.reduce((max, row) => Math.max(max, row.cities.length), 0);

    const rows = ordered.map((row) => {
      const record: Record<string, unknown> = {
        CountryID: row.CountryID,
        Country: row.Country,
      };
      for (let i = 0; i < maxCities; i += 1) {
        record[`City${i + 1}`] = row.cities[i]?.name ?? "";
        record[`City${i + 1}Id`] = row.cities[i]?.id ?? null;
      }
      return record;
    });

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
