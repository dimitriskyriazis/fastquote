import ContactsClient from "./ContactsClient";
import { getPool } from "../../lib/sql";

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

async function fetchContactImportances(): Promise<string[]> {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<{ Importance: string | number | null }>(`
      SELECT DISTINCT Importance
      FROM dbo.Contacts
      WHERE Importance IS NOT NULL
      ORDER BY Importance
    `);
    const rows = result.recordset ?? [];
    const unique = new Set<string>();
    rows.forEach((row) => {
      const rawImportance = row.Importance;
      if (rawImportance == null) return;
      const importance = typeof rawImportance === "number"
        ? String(rawImportance)
        : String(rawImportance).trim();
      if (importance) unique.add(importance);
    });
    return Array.from(unique);
  } catch (err) {
    console.error("Failed to fetch contact importances", err);
    return [];
  }
}

export default async function Page() {
  const [statuses, importances] = await Promise.all([
    fetchEmailStatuses(),
    fetchContactImportances(),
  ]);
  return <ContactsClient statuses={statuses} importances={importances} />;
}
