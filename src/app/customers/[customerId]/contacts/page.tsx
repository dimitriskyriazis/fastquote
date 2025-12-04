import { notFound } from "next/navigation";
import CustomerContactsClient from "./CustomerContactsClient";
import { getPool } from "../../../../lib/sql";

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
  const customerName = await fetchCustomerName(numericCustomerId);

  return (
    <CustomerContactsClient
      customerId={String(numericCustomerId)}
      customerName={customerName}
    />
  );
}
