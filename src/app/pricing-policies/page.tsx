import PricingPoliciesClient, { PricingPolicyColumn } from "./PricingPoliciesClient";
import { getPool } from "../../lib/sql";
import { toDropdownOptions, type RawDropdownRow } from "../../lib/dropdownOptions";

async function fetchPricingPolicies(): Promise<PricingPolicyColumn[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<{ ID: number | null; Name: string | null }>(`
      SELECT ID, Name
      FROM dbo.PricingPolicies
      ORDER BY Name
    `);
    return (result.recordset ?? [])
      .filter((row): row is { ID: number; Name: string | null } => row?.ID != null)
      .map((row) => ({
        id: row.ID,
        name: row.Name?.trim() || `Policy ${row.ID}`,
      }));
  } catch (err) {
    console.error("Failed to fetch pricing policies", err);
    return [];
  }
}

async function fetchBrands() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<RawDropdownRow>(`
      SELECT ID, Name
      FROM dbo.Brands
      ORDER BY Name
    `);
    return toDropdownOptions(result.recordset);
  } catch (err) {
    console.error("Failed to fetch brands", err);
    return [];
  }
}

export default async function Page() {
  const [pricingPolicies, brands] = await Promise.all([
    fetchPricingPolicies(),
    fetchBrands(),
  ]);
  return <PricingPoliciesClient pricingPolicies={pricingPolicies} brands={brands} />;
}

