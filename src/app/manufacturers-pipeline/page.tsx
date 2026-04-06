import BrandOffersClient from "./BrandOffersClient";
import { getPool } from "../../lib/sql";
import { toDropdownOptions, type RawDropdownRow } from "../../lib/dropdownOptions";

export const dynamic = "force-dynamic";

async function fetchBrands() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<RawDropdownRow>(`
      SELECT ID, Name
      FROM dbo.Brands
      WHERE Enabled = 1
      ORDER BY Name
    `);
    return toDropdownOptions(result.recordset);
  } catch (err) {
    console.error("Failed to fetch brands", err);
    return [];
  }
}

export default async function Page() {
  const brands = await fetchBrands();
  return <BrandOffersClient brands={brands} />;
}
