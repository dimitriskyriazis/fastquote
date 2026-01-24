import PricingPoliciesClient, { PricingPolicyColumn } from "./PricingPoliciesClient";
import { getPool } from "../../lib/sql";

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

export default async function Page() {
  const pricingPolicies = await fetchPricingPolicies();
  return <PricingPoliciesClient pricingPolicies={pricingPolicies} />;
}

