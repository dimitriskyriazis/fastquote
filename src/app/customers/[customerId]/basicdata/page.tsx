"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import CustomerBasicDataPanel from "../CustomerBasicDataPanel";
import layoutStyles from "../../customerDetail.module.css";

const buildFallbackHeading = (customerId: string) => {
  if (!customerId) return 'Customer';
  return /^[0-9]+$/.test(customerId) ? `Customer ${customerId}` : customerId;
};

export default function Page() {
  const params = useParams<{ customerId: string }>();
  const rawCustomerId = typeof params?.customerId === "string" ? params.customerId : "";
  let decodedId = rawCustomerId;
  try {
    decodedId = decodeURIComponent(rawCustomerId);
  } catch {
    decodedId = rawCustomerId;
  }
  const headingBase = buildFallbackHeading(decodedId);
  const headingText = `${headingBase} - Basic Data`;
  const encodedId = encodeURIComponent(decodedId);

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/customers" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to customers
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>{headingText}</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <Link
            href={`/offers/create?customerId=${encodedId}`}
            className={`${layoutStyles.headerActionButton} page-header-button`}
          >
            Create Offer for Customer
          </Link>
          <Link
            href={`/customers/${encodedId}/contacts`}
            className={`${layoutStyles.headerActionButton} page-header-button`}
            target="_blank"
            rel="noopener noreferrer"
          >
            View Contacts
          </Link>
        </div>
      </div>
      <div className={layoutStyles.pageBody}>
        <CustomerBasicDataPanel customerId={decodedId} />
      </div>
    </main>
  );
}
