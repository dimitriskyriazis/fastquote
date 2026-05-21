'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import ProductDetailsPanel from '../ProductDetailsPanel';
import layoutStyles from '../../../offers/offersDetail.module.css';

const buildHeading = (productId: string) => {
  if (!productId) return 'Product';
  return /^[0-9]+$/.test(productId) ? `Product ${productId}` : productId;
};

export default function Page() {
  const params = useParams<{ productId: string }>();
  const rawId = typeof params?.productId === 'string' ? params.productId : '';
  let decodedId = rawId;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    decodedId = rawId;
  }
  const headingText = `${buildHeading(decodedId)} – Details`;
  const encodedId = encodeURIComponent(decodedId);

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div
          id="undo-portal"
          className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}
        >
          <Link href="/products" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to products
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>{headingText}</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <Link
            href={`/products/${encodedId}/history`}
            className={`${layoutStyles.headerActionButton} page-header-button`}
          >
            View History
          </Link>
        </div>
      </div>
      <div className={layoutStyles.pageBody}>
        <ProductDetailsPanel productId={decodedId} />
      </div>
    </main>
  );
}
