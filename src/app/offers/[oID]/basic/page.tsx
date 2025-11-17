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
      <div className={`${styles.headerRow} ${styles.headerRowCentered}`}>
        <Link href="/offers" className={`${styles.backLink} ${styles.backLinkAbsolute}`}>
          <span aria-hidden="true">←</span>
          Back to offers
        </Link>
        <h1 className={styles.heading}>{headingText}</h1>
      </div>
      <div className={styles.pageBody}>
        <OfferBasicDataPanel oID={decodedId} />
      </div>
    </main>
  );
}
