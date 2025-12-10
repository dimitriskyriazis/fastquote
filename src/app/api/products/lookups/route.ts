import { NextRequest, NextResponse } from "next/server";
import { getPool } from "../../../../lib/sql";

type LookupRow = {
  ID: number | null;
  Name: string | null;
};

type SubCategoryRow = LookupRow & {
  CategoryID: number | null;
};

type LookupOption = {
  id: number;
  name: string;
};

type SubCategoryOption = LookupOption & {
  categoryId: number | null;
};

const normalizeName = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.trim();
};

const mapLookup = (rows: LookupRow[]): LookupOption[] =>
  (rows ?? [])
    .filter((row): row is LookupRow & { ID: number } => row?.ID != null)
    .map((row) => ({ id: Number(row.ID), name: normalizeName(row.Name) }));

const mapSubCategories = (rows: SubCategoryRow[]): SubCategoryOption[] =>
  (rows ?? [])
    .filter((row): row is SubCategoryRow & { ID: number } => row?.ID != null)
    .map((row) => ({
      id: Number(row.ID),
      name: normalizeName(row.Name),
      categoryId: row.CategoryID ?? null,
    }));

export async function GET(_req: NextRequest) {
  try {
    const pool = await getPool();
    const [brandsRes, categoriesRes, subCategoriesRes, typesRes] = await Promise.all([
      pool
        .request()
        .query<LookupRow>("SELECT ID, Name FROM dbo.Brands ORDER BY Name"),
      pool
        .request()
        .query<LookupRow>("SELECT ID, Name FROM dbo.ProductCategories ORDER BY Name"),
      pool
        .request()
        .query<SubCategoryRow>("SELECT ID, Name, CategoryID FROM dbo.ProductSubCategories ORDER BY Name"),
      pool
        .request()
        .query<LookupRow>("SELECT ID, Name FROM dbo.ProductTypes ORDER BY Name"),
    ]);

    return NextResponse.json({
      ok: true,
      brands: mapLookup(brandsRes.recordset ?? []),
      categories: mapLookup(categoriesRes.recordset ?? []),
      subCategories: mapSubCategories(subCategoriesRes.recordset ?? []),
      types: mapLookup(typesRes.recordset ?? []),
    });
  } catch (err) {
    console.error("Failed to load product lookups", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
