import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import BrandOfferProductsClient from "./BrandOfferProductsClient";

type OfferHeaderInfo = {
  title: string | null;
  description: string | null;
  customerName: string | null;
};

async function fetchOfferHeader(offerId: number): Promise<OfferHeaderInfo> {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("offerId", sql.Int, offerId);
    const result = await request.query<{
      Title: string | null;
      Description: string | null;
      CustomerName: string | null;
    }>(`
      SELECT
        o.Title,
        o.Description,
        c.Name AS CustomerName
      FROM dbo.Offer AS o
      LEFT JOIN dbo.Customers AS c ON c.ID = o.CustomerID
      WHERE o.ID = @offerId
    `);
    const row = result.recordset?.[0] ?? null;
    return {
      title: row?.Title?.trim() || null,
      description: row?.Description?.trim() || null,
      customerName: row?.CustomerName?.trim() || null,
    };
  } catch (err) {
    console.error("Failed to load offer header", err);
    return { title: null, description: null, customerName: null };
  }
}

async function fetchBrandName(brandId: number): Promise<string | null> {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("brandId", sql.Int, brandId);
    const result = await request.query<{ Name: string | null }>(`
      SELECT Name FROM dbo.Brands WHERE ID = @brandId
    `);
    return result.recordset?.[0]?.Name?.trim() || null;
  } catch {
    return null;
  }
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ offerId: string }>;
  searchParams: Promise<{ brandId?: string }>;
}) {
  const { offerId } = await params;
  const { brandId: rawBrandId } = await searchParams;
  const numericOfferId = Number.parseInt(offerId, 10);
  const numericBrandId = rawBrandId ? Number.parseInt(rawBrandId, 10) : null;

  const [offerHeader, brandName] = await Promise.all([
    Number.isFinite(numericOfferId) ? fetchOfferHeader(numericOfferId) : Promise.resolve({ title: null, description: null, customerName: null }),
    numericBrandId && Number.isFinite(numericBrandId) ? fetchBrandName(numericBrandId) : Promise.resolve(null),
  ]);

  const parts = [
    offerHeader.customerName,
    offerHeader.description,
    brandName,
  ].filter(Boolean);
  const heading = parts.length > 0 ? parts.join(" - ") : `Offer ${offerId}`;

  return (
    <BrandOfferProductsClient
      offerId={offerId}
      brandId={rawBrandId ?? ""}
      heading={heading}
    />
  );
}
