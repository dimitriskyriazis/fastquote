import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import { getPool } from "../../../../lib/sql";

type LookupRow = {
  ID: number | null;
  Name: string | null;
};

type BrandLookupRow = LookupRow & {
  PartNumberSuffix: string | null;
  PartNumberPattern1: string | null;
  PartNumberPattern2: string | null;
};

type SubCategoryRow = LookupRow & {
  CategoryID: number | null;
};

type LookupOption = {
  id: number;
  name: string;
};

type BrandLookupOption = LookupOption & {
  partNumberSuffix: string | null;
  partNumberPatterns: string[];
};

type SubCategoryOption = LookupOption & {
  categoryId: number | null;
};

const normalizeName = (value: string | null | undefined): string => {
  if (!value) return "";
  return value.trim();
};

const normalizeNullableText = (value: string | null | undefined): string | null => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
};

const mapLookup = (rows: LookupRow[]): LookupOption[] =>
  (rows ?? [])
    .filter((row): row is LookupRow & { ID: number } => row?.ID != null)
    .map((row) => ({ id: Number(row.ID), name: normalizeName(row.Name) }));

const mapBrandLookup = (rows: BrandLookupRow[]): BrandLookupOption[] =>
  (rows ?? [])
    .filter((row): row is BrandLookupRow & { ID: number } => row?.ID != null)
    .map((row) => {
      const patterns = [row.PartNumberPattern1, row.PartNumberPattern2]
        .map(normalizeNullableText)
        .filter((value): value is string => value !== null);
      return {
        id: Number(row.ID),
        name: normalizeName(row.Name),
        partNumberSuffix: normalizeNullableText(row.PartNumberSuffix),
        partNumberPatterns: patterns,
      };
    });

const mapSubCategories = (rows: SubCategoryRow[]): SubCategoryOption[] =>
  (rows ?? [])
    .filter((row): row is SubCategoryRow & { ID: number } => row?.ID != null)
    .map((row) => ({
      id: Number(row.ID),
      name: normalizeName(row.Name),
      categoryId: row.CategoryID ?? null,
    }));

export async function GET(req: NextRequest) {
  logRequest(req, '/api/products/lookups');
  try {
    const pool = await getPool();
    const [brandsRes, categoriesRes, subCategoriesRes, typesRes] = await Promise.all([
      pool
        .request()
        .query<BrandLookupRow>(
          "SELECT ID, Name, PartNumberSuffix, PartNumberPattern1, PartNumberPattern2 FROM dbo.Brands ORDER BY Name",
        ),
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
      brands: mapBrandLookup(brandsRes.recordset ?? []),
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
