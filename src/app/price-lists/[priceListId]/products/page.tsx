import sql from "mssql";
import PriceListProductsClient from "./PriceListProductsClient";
import { getPool } from "../../../../lib/sql";

const buildFallbackHeading = (priceListId: string) =>
  /^[0-9]+$/.test(priceListId) ? `Price List ${priceListId}` : priceListId;

async function fetchPriceListName(priceListId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("priceListId", sql.Int, priceListId);
    const result = await request.query<{ Name: string | null }>(`
      SELECT Name FROM dbo.PriceLists WHERE ID = @priceListId
    `);
    return result.recordset?.[0]?.Name ?? null;
  } catch (err) {
    console.error("Failed to fetch price list name", err);
    return null;
  }
}

export default async function Page({
  params,
}: {
  params: Promise<{ priceListId: string }>;
}) {
  const { priceListId } = await params;
  const decodedId = decodeURIComponent(priceListId);
  const parsedId = Number(decodedId);
  const priceListName =
    Number.isInteger(parsedId) && parsedId > 0
      ? await fetchPriceListName(parsedId)
      : null;
  const headingBase = priceListName ?? buildFallbackHeading(decodedId);
  const headingText = `${headingBase} - Products`;

  return (
    <PriceListProductsClient
      priceListId={decodedId}
      headingText={headingText}
      priceListLabel={headingBase}
    />
  );
}
