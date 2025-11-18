import Link from "next/link";
import sql from "mssql";
import { getPool } from "../../../../lib/sql";
import layoutStyles from "../../priceListDetail.module.css";
import styles from "./PriceListBasicPage.module.css";

type PriceListRecord = {
  Name: string | null;
  SupplierName: string | null;
  ValidFromDate: Date | string | null;
  ValidToDate: Date | string | null;
  Enabled: boolean | number | null;
  SupplierComment: string | null;
};

const buildFallbackHeading = (priceListId: string) =>
  /^[0-9]+$/.test(priceListId) ? `Price List ${priceListId}` : priceListId;

const formatDate = (value: Date | string | null | undefined) => {
  if (!value) return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
};

const formatEnabled = (value: PriceListRecord["Enabled"]) => {
  if (value === 1 || value === true) return "Yes";
  if (value === 0 || value === false) return "No";
  return "—";
};

async function fetchPriceListRecord(priceListId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("priceListId", sql.Int, priceListId);
    const result = await request.query<PriceListRecord>(`
      SELECT
        dbo.PriceLists.Name,
        dbo.PriceLists.ValidFromDate,
        dbo.PriceLists.ValidToDate,
        dbo.PriceLists.Enabled,
        dbo.PriceLists.SupplierComment,
        dbo.Suppliers.Name AS SupplierName
      FROM dbo.PriceLists
      LEFT JOIN dbo.Suppliers ON dbo.PriceLists.SupplierID = dbo.Suppliers.ID
      WHERE dbo.PriceLists.ID = @priceListId
    `);
    return result.recordset?.[0] ?? null;
  } catch (err) {
    console.error("Failed to load price list record", err);
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
  const numericId = Number(decodedId);

  const record =
    Number.isInteger(numericId) && numericId > 0
      ? await fetchPriceListRecord(numericId)
      : null;

  const headingBase = record?.Name ?? buildFallbackHeading(decodedId);
  const headingText = `${headingBase} - Basic Data`;

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/price-lists" className={layoutStyles.backLink}>
            <span aria-hidden="true">←</span>
            Back to price lists
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>
          {headingText}
        </h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`} />
      </div>
      <div className={layoutStyles.pageBody}>
        {record ? (
          <div className={styles.card}>
            <div className={styles.detailsGrid}>
              <div className={styles.label}>Supplier</div>
              <div className={styles.value}>{record.SupplierName ?? "—"}</div>
              <div className={styles.label}>Valid From</div>
              <div className={styles.value}>{formatDate(record.ValidFromDate)}</div>
              <div className={styles.label}>Valid To</div>
              <div className={styles.value}>{formatDate(record.ValidToDate)}</div>
              <div className={styles.label}>Enabled</div>
              <div className={styles.value}>{formatEnabled(record.Enabled)}</div>
            </div>
            {record.SupplierComment ? (
              <p className={styles.comment}>{record.SupplierComment}</p>
            ) : null}
          </div>
        ) : (
          <div className={styles.emptyState}>
            This price list could not be found or has been removed.
          </div>
        )}
      </div>
    </main>
  );
}
