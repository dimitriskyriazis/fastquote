import Link from 'next/link';
import sql from 'mssql';
import OfferBasicDataPanel from '../OfferBasicDataPanel';
import CreateDraftOfferButton from './CreateDraftOfferButton';
import ViewStatusHistoryButton from './ViewStatusHistoryButton';
import ExportPdfButton from './ExportPdfButton';
import CreateNewVersionButton from './CreateNewVersionButton';
import CopyOfferButton from './CopyOfferButton';
import { getPool } from '../../../../lib/sql';
import styles from '../../offersDetail.module.css';

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

async function fetchOrderSignedDate(offerId: string): Promise<string | null> {
  const numericId = Number.parseInt(offerId, 10);
  if (!Number.isFinite(numericId)) return null;
  const pool = await getPool();
  const request = pool.request();
  request.input('offerId', sql.Int, numericId);
  const result = await request.query<{ OrderSignedDate: Date | string | null }>(
    'SELECT OrderSignedDate FROM dbo.Offer WHERE ID = @offerId',
  );
  const raw = result.recordset?.[0]?.OrderSignedDate ?? null;
  if (!raw) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const headingText = `${buildHeading(decodedId)} - Basic Data`;
  const orderSignedDate = await fetchOrderSignedDate(decodedId);

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div id="undo-portal" className={`${styles.headerSide} ${styles.headerSideStart}`}>
          <Link href="/offers" className={`${styles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to offers
          </Link>
          <CreateNewVersionButton
            offerId={decodedId}
            className={`${styles.headerActionButton} page-header-button`}
          />
          <CopyOfferButton
            offerId={decodedId}
            className={`${styles.headerActionButton} page-header-button`}
          />
        </div>
        <h1 className={`${styles.heading} ${styles.headingCentered}`}>{headingText}</h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
          <CreateDraftOfferButton
            offerId={decodedId}
            orderSignedDate={orderSignedDate}
            className={`${styles.headerActionButton} page-header-button`}
          />
          <ViewStatusHistoryButton
            offerId={decodedId}
            className={`${styles.headerActionButton} page-header-button`}
          />
          <ExportPdfButton
            offerId={decodedId}
            className={`${styles.headerActionButton} page-header-button`}
          />
          <Link
            href={`/offers/${encodeURIComponent(decodedId)}/products`}
            className={`${styles.headerActionButton} page-header-button`}
          >
            View Products
          </Link>
        </div>
      </div>
      <div className={styles.pageBody}>
        <OfferBasicDataPanel offerId={decodedId} />
      </div>
    </main>
  );
}
