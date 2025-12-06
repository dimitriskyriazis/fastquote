import ContactsClient from "./ContactsClient";
import { getPool } from "../../lib/sql";
import { IMPORTANCE_VALUES } from "../customers/[customerId]/customerBasicDataLookups";

async function fetchEmailStatuses(): Promise<string[]> {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<{ Name: string | null }>(`
      SELECT Name
      FROM dbo.EmailStatuses
      ORDER BY Name
    `);
    const rows = result.recordset ?? [];
    const unique = new Set<string>();
    rows.forEach((row) => {
      const name = row.Name?.trim();
      if (name) unique.add(name);
    });
    return Array.from(unique);
  } catch (err) {
    console.error("Failed to fetch email statuses", err);
    return [];
  }
}

export default async function Page() {
  const [statuses] = await Promise.all([fetchEmailStatuses()]);
  return <ContactsClient statuses={statuses} importances={IMPORTANCE_VALUES} />;
}
