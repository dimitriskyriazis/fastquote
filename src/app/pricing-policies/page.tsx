import PricingPoliciesClient, { PricingPolicyColumn } from "./PricingPoliciesClient";
import { getPool } from "../../lib/sql";
import { toDropdownOptions, type DropdownOption, type RawDropdownRow } from "../../lib/dropdownOptions";

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

type LookupRow = RawDropdownRow & { ID: number | string | null; Name: string | null };

async function fetchCalcMethodFormulas(): Promise<DropdownOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.CalcMethodFormulas
      ORDER BY Name
    `);
    return toDropdownOptions(result.recordset, "Formula");
  } catch (err) {
    console.error("Failed to fetch calc method formulas", err);
    return [];
  }
}

export default async function Page() {
  const [pricingPolicies, calcMethodFormulas] = await Promise.all([
    fetchPricingPolicies(),
    fetchCalcMethodFormulas(),
  ]);
  return <PricingPoliciesClient pricingPolicies={pricingPolicies} calcMethodFormulas={calcMethodFormulas} />;
}

