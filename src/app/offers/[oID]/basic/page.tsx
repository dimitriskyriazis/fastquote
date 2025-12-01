import Link from 'next/link';
import OfferBasicDataPanel from '../OfferBasicDataPanel';
import styles from '../../offersDetail.module.css';

const buildHeading = (oID: string) =>
  /^[0-9]+$/.test(oID) ? `Offer ${oID}` : oID;

export default async function Page({ params }: { params: Promise<{ oID: string }> }) {
  const { oID } = await params;
  const decodedId = decodeURIComponent(oID);
  const headingText = `${buildHeading(decodedId)} - Basic Data`;

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
          <Link href="/offers" className={styles.backLink}>
            <span aria-hidden="true">←</span>
            Back to offers
          </Link>
        </div>
        <h1 className={`${styles.heading} ${styles.headingCentered}`}>{headingText}</h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
          <Link
            href={`/offers/${encodeURIComponent(decodedId)}/products`}
            className={styles.headerActionButton}
          >
            View Products
          </Link>
        </div>
      </div>
      <div className={styles.pageBody}>
        <OfferBasicDataPanel oID={decodedId} />
      </div>
    </main>
  );
}
