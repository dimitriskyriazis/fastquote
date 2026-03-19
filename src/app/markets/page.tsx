import MarketsClient from "./MarketsClient";
import { getPool } from "../../lib/sql";

export const dynamic = "force-dynamic";

async function fetchSalesDivisions(): Promise<string[]> {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<{ Name: string | null }>(`
      SELECT Name
      FROM dbo.SalesDivision
      ORDER BY Name
    `);
    const rows: Array<{ Name: string | null }> = result.recordset ?? [];
    const unique = new Set<string>();
    rows.forEach((row: { Name: string | null }) => {
      const name = row.Name?.trim();
      if (name) unique.add(name);
    });
    return Array.from(unique);
  } catch (err) {
    console.error("Failed to fetch sales divisions", err);
    return [];
  }
}

export default async function Page() {
  const salesDivisions = await fetchSalesDivisions();
  return <MarketsClient salesDivisions={salesDivisions} />;
}
