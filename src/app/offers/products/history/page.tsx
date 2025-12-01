import Link from 'next/link';
import sql from 'mssql';
import styles from '../../offersDetail.module.css';
import historyStyles from './ProductHistory.module.css';
import { getPool } from '../../../../lib/sql';
import ProductHistoryGrid, { type HistoryRow } from './ProductHistoryGrid';
import ProductHistoryMetaGrid from './ProductHistoryMetaGrid';
const getFirstParam = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value ?? '');

const toNullable = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

async function fetchProductHistory(partNumber: string | null, modelNumber: string | null) {
  if (!partNumber && !modelNumber) return [];
  try {
    const pool = await getPool();
    const request = pool.request();
    const filters: string[] = [];

    if (partNumber) {
      request.input('partNumber', sql.NVarChar(255), partNumber);
      filters.push('NULLIF(LTRIM(RTRIM(od.PartNumber)), \'\') = @partNumber');
    }
    if (modelNumber) {
      request.input('modelNumber', sql.NVarChar(255), modelNumber);
      filters.push('NULLIF(LTRIM(RTRIM(od.ModelNumber)), \'\') = @modelNumber');
    }

    const where = `WHERE ${filters.length === 1 ? filters[0] : `(${filters.join(' OR ')})`}`;

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
      ${where}
      ORDER BY o.OfferDate DESC, od.OfferID DESC
    `);
    return result.recordset ?? [];
  } catch (err) {
    console.error('Failed to load product history', err);
    return [];
  }
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolvedSearch = await searchParams;
  const partNumber = toNullable(getFirstParam(resolvedSearch.partNumber));
  const modelNumber = toNullable(getFirstParam(resolvedSearch.modelNumber));
  const offerId = toNullable(getFirstParam(resolvedSearch.offerId));
  const description = toNullable(getFirstParam(resolvedSearch.description));
  const backHrefParam = toNullable(getFirstParam(resolvedSearch.backHref));
  const backLabelParam = toNullable(getFirstParam(resolvedSearch.backLabel));

  const resolvedBackHref =
    backHrefParam ??
    (offerId ? `/offers/${encodeURIComponent(offerId)}/products` : '/offers');
  const resolvedBackLabel = backLabelParam ?? (offerId ? `offer ${offerId}` : 'offers');

  const renderHeader = () => (
    <div className={`${styles.headerRow} ${styles.headerRowCentered}`}>
      <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
        <Link href={resolvedBackHref} className={styles.backLink}>
          <span aria-hidden="true">←</span>
          Back to {resolvedBackLabel}
        </Link>
      </div>
      <h1 className={`${styles.heading} ${styles.headingCentered}`}>Product history</h1>
      <div className={`${styles.headerSide} ${styles.headerSideEnd}`} aria-hidden="true" />
    </div>
  );

  if (!partNumber && !modelNumber) {
    return (
      <main className={styles.page}>
        {renderHeader()}
        <div className={historyStyles.tableWrapper}>
          <div className={historyStyles.emptyState}>Select a product to view its history.</div>
        </div>
      </main>
    );
  }

  const historyRows = await fetchProductHistory(partNumber, modelNumber);
  return (
    <main className={styles.page}>
      {renderHeader()}

      <div className={styles.pageBody}>
        <ProductHistoryMetaGrid
          partNumber={partNumber}
          modelNumber={modelNumber}
          description={description}
        />
        <ProductHistoryGrid
          rows={historyRows}
        />
      </div>
    </main>
  );
}
