import { notFound } from "next/navigation";
import CustomerContactsClient from "./CustomerContactsClient";
import { getPool } from "../../../../lib/sql";
import { IMPORTANCE_VALUES } from "../customerBasicDataLookups";
import { toDropdownOptions, type DropdownOption } from "../../../../lib/dropdownOptions";

type LookupRow = { ID: number | string | null; Name: string | null };

async function fetchEmailStatuses(): Promise<string[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<{ Name: string | null }>(`
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

async function fetchCustomerName(customerId: number): Promise<string | null> {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("customerId", customerId);
    const result = await request.query<{ Name: string | null }>(`
      SELECT TOP 1 Name
      FROM dbo.Customers
      WHERE ID = @customerId
    `);
    const name = result.recordset?.[0]?.Name ?? null;
    return name && name.trim().length > 0 ? name.trim() : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

const normalizeCustomerId = (value: string | null | undefined) => {
  if (!value) return null;
  const decoded = decodeURIComponent(value);
  const parsed = Number.parseInt(decoded, 10);
  if (Number.isNaN(parsed) || !Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
};

export default async function Page({ params }: { params: Promise<{ customerId: string }> }) {
  const { customerId } = await params;
  const numericCustomerId = normalizeCustomerId(customerId ?? null);
  if (!numericCustomerId) {
    notFound();
  }
  const [customerName, statuses, titles] = await Promise.all([
    fetchCustomerName(numericCustomerId),
    fetchEmailStatuses(),
    fetchTitles(),
  ]);

  return (
    <CustomerContactsClient
      customerId={String(numericCustomerId)}
      customerName={customerName}
      statuses={statuses}
      importances={IMPORTANCE_VALUES}
      titles={titles}
    />
  );
}
