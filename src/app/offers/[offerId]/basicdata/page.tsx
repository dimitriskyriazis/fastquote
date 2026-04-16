import Link from 'next/link';
import OfferBasicDataPanel from '../OfferBasicDataPanel';
import CreateDraftOfferButton from './CreateDraftOfferButton';
import ViewStatusHistoryButton from './ViewStatusHistoryButton';
import ExportPdfButton from './ExportPdfButton';
import styles from '../../offersDetail.module.css';

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const headingText = `${buildHeading(decodedId)} - Basic Data`;

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div id="undo-portal" className={`${styles.headerSide} ${styles.headerSideStart}`}>
          <Link href="/offers" className={`${styles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to offers
          </Link>
        </div>
        <h1 className={`${styles.heading} ${styles.headingCentered}`}>{headingText}</h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
          <CreateDraftOfferButton
            offerId={decodedId}
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
            target="_blank"
            rel="noopener noreferrer"
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
