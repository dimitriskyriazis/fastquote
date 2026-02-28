import SuppliersClient from "./SuppliersClient";
import { getPool } from "../../lib/sql";

async function fetchCountries(): Promise<Array<{ id: number; name: string }>> {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<{ ID: number; Name: string | null }>(`
      SELECT ID, Name
      FROM dbo.Countries
      ORDER BY Name
    `);
    const rows = result.recordset ?? [];
    return rows
      .filter((row): row is { ID: number; Name: string } =>
        row.ID != null && row.Name != null && row.Name.trim().length > 0
      )
      .map((row) => ({ id: row.ID, name: row.Name.trim() }));
  } catch (err) {
    console.error("Failed to fetch countries", err);
    return [];
  }
}

export default async function Page() {
  const countries = await fetchCountries();
  return <SuppliersClient countries={countries} />;
}
