'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import BrandDetailsPanel from '../BrandDetailsPanel';
import layoutStyles from '../../../offers/offersDetail.module.css';

const buildHeading = (brandId: string) => {
  if (!brandId) return 'Brand';
  return /^[0-9]+$/.test(brandId) ? `Brand ${brandId}` : brandId;
};

export default function Page() {
  const params = useParams<{ brandId: string }>();
  const rawId = typeof params?.brandId === 'string' ? params.brandId : '';
  let decodedId = rawId;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    decodedId = rawId;
  }
  const headingText = `${buildHeading(decodedId)} – Details`;

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div
          id="undo-portal"
          className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}
        >
          <Link href="/brands" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to brands
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>{headingText}</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`} aria-hidden="true" />
      </div>
      <div className={layoutStyles.pageBody}>
        <BrandDetailsPanel brandId={decodedId} />
      </div>
    </main>
  );
}
