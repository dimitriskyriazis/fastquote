import CountriesCitiesClient from "./CountriesCitiesClient";
import { getPool } from "../../lib/sql";

export type CountryRow = {
  id: number;
  name: string;
  cities: string[];
};

type RawRow = {
  CountryID: number | null;
  Country: string | null;
  City: string | null;
};

async function fetchCountriesCities(): Promise<CountryRow[]> {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<RawRow>(`
      SELECT c.ID AS CountryID, c.Name AS Country, ct.Name AS City
      FROM dbo.Countries c
      LEFT JOIN dbo.Cities ct
        ON c.ID = ct.CountryID
       AND ct.Enabled = 1
      WHERE c.Enabled = 1
      ORDER BY c.Name, ct.Name
    `);

    const rows = result.recordset ?? [];
    const ordered: CountryRow[] = [];
    const indexById = new Map<number, CountryRow>();

    for (const row of rows) {
      const id = row.CountryID;
      const name = row.Country?.trim() ?? "";
      if (id == null || !name) continue;

      let entry = indexById.get(id);
      if (!entry) {
        entry = { id, name, cities: [] };
        indexById.set(id, entry);
        ordered.push(entry);
      }

      const cityName = row.City?.trim();
      if (cityName) {
        entry.cities.push(cityName);
      }
    }

    return ordered;
  } catch (err) {
    console.error("Failed to fetch countries & cities", err);
    return [];
  }
}

export default async function Page() {
  const countries = await fetchCountriesCities();
  return <CountriesCitiesClient countries={countries} />;
}
