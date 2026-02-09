import ContactsClient from "./ContactsClient";
import { getPool } from "../../lib/sql";
import { IMPORTANCE_VALUES, fetchCustomers } from "../customers/[customerId]/customerBasicDataLookups";
import { toDropdownOptions, type RawDropdownRow, type DropdownOption } from "../../lib/dropdownOptions";

type LookupRow = RawDropdownRow & { ID: number | string | null };
type SearchParams = Record<string, string | string[] | undefined>;

const getFirstParam = (value: string | string[] | undefined): string | null => {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === "string" ? value : null;
};

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

async function fetchTitles(): Promise<DropdownOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Titles
      ORDER BY Name
    `);
    return toDropdownOptions(result.recordset);
  } catch (err) {
    console.error("Failed to fetch titles", err);
    return [];
  }
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const resolvedSearch = await searchParams;
  const initialContactName = getFirstParam(resolvedSearch.contactName)?.trim() ?? "";
  const initialContactFirstName = getFirstParam(resolvedSearch.firstName)?.trim() ?? "";
  const initialContactLastName = getFirstParam(resolvedSearch.lastName)?.trim() ?? "";
  const [statuses, customers, titles] = await Promise.all([
    fetchEmailStatuses(),
    fetchCustomers(),
    fetchTitles(),
  ]);
  return (
    <ContactsClient
      statuses={statuses}
      importances={IMPORTANCE_VALUES}
      customers={customers}
      titles={titles}
      initialContactName={initialContactName}
      initialContactFirstName={initialContactFirstName}
      initialContactLastName={initialContactLastName}
    />
  );
}
