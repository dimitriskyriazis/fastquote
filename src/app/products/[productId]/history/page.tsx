import Link from "next/link";
import { notFound } from "next/navigation";
import sql from "mssql";
import styles from "../../../offers/offersDetail.module.css";
import historyStyles from "../../historyComponents/ProductHistory.module.css";
import ProductHistoryGrid, { type HistoryRow } from "../../historyComponents/ProductHistoryGrid";
import ProductHistoryMetaGrid from "../../historyComponents/ProductHistoryMetaGrid";
import { getPool } from "../../../../lib/sql";

const getFirstParam = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value ?? "";

const toNullable = (value: string | null | undefined) => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

async function fetchProductDetails(productId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("productId", sql.Int, productId);
    const result = await request.query<{
      PartNumber: string | null;
      ModelNumber: string | null;
      Description: string | null;
    }>(`
      SELECT
        NULLIF(LTRIM(RTRIM(PartNumber)), '') AS PartNumber,
        NULLIF(LTRIM(RTRIM(ModelNumber)), '') AS ModelNumber,
        NULLIF(LTRIM(RTRIM(Description)), '') AS Description
      FROM dbo.Products
      WHERE ID = @productId
    `);
    return result.recordset?.[0] ?? null;
  } catch (err) {
    console.error("Failed to load product details", err);
    return null;
  }
}

async function fetchProductHistoryRows(productId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("productId", sql.Int, productId);
    const result = await request.query<HistoryRow>(`
      SELECT
        od.OfferID,
        o.OfferDate,
        c.Name AS CustomerName,
        od.ListPrice,
        od.CustomerDiscount,
        od.NetUnitPrice,
        od.TelmacoDiscount,
        od.NetCost
      FROM dbo.OfferDetails AS od
      INNER JOIN dbo.Offer AS o ON od.OfferID = o.ID
      INNER JOIN dbo.Customers AS c ON o.CustomerID = c.ID
      WHERE od.ProductID = @productId
      ORDER BY o.OfferDate DESC, od.OfferID DESC
    `);
    return result.recordset ?? [];
  } catch (err) {
    console.error("Failed to load product history", err);
    return [];
  }
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { productId } = await params;
  const decodedId = decodeURIComponent(String(productId ?? "")).trim();
  const parsedId = Number(decodedId);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    notFound();
  }

  const resolvedSearch = await searchParams;
  const backHrefParam = toNullable(getFirstParam(resolvedSearch.backHref));
  const backLabelParam = toNullable(getFirstParam(resolvedSearch.backLabel));
  const resolvedBackHref = backHrefParam ?? "/products";
  const resolvedBackLabel = backLabelParam ?? "products";

  const productDetails = await fetchProductDetails(parsedId);
  if (!productDetails) {
    return (
      <main className={styles.page}>
        <div className={`${styles.headerRow} ${styles.headerRowCentered}`}>
          <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
            <Link href={resolvedBackHref} className={`${styles.backLink} page-header-button`}>
              <span aria-hidden="true">←</span>
              Back to {resolvedBackLabel}
            </Link>
          </div>
          <h1 className={`${styles.heading} ${styles.headingCentered}`}>Product history</h1>
          <div className={`${styles.headerSide} ${styles.headerSideEnd}`} aria-hidden="true" />
        </div>
        <div className={historyStyles.tableWrapper}>
          <div className={historyStyles.emptyState}>Product not found.</div>
        </div>
      </main>
    );
  }

  const historyRows = await fetchProductHistoryRows(parsedId);

  const renderHeader = () => (
    <div className={`${styles.headerRow} ${styles.headerRowCentered}`}>
      <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
        <Link href={resolvedBackHref} className={`${styles.backLink} page-header-button`}>
          <span aria-hidden="true">←</span>
          Back to {resolvedBackLabel}
        </Link>
      </div>
      <h1 className={`${styles.heading} ${styles.headingCentered}`}>Product history</h1>
      <div className={`${styles.headerSide} ${styles.headerSideEnd}`} aria-hidden="true" />
    </div>
  );

  return (
    <main className={styles.page}>
      {renderHeader()}
      <div className={styles.pageBody}>
        <ProductHistoryMetaGrid
          partNumber={productDetails.PartNumber}
          modelNumber={productDetails.ModelNumber}
          description={productDetails.Description}
        />
        <ProductHistoryGrid rows={historyRows} />
      </div>
    </main>
  );
}
