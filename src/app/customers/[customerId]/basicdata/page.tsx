import Link from "next/link";
import CustomerBasicDataPanel, { fetchCustomerBasicRecord } from "../CustomerBasicDataPanel";
import layoutStyles from "../../customerDetail.module.css";

const buildFallbackHeading = (customerId: string) => {
  if (!customerId) return 'Customer';
  return /^[0-9]+$/.test(customerId) ? `Customer ${customerId}` : customerId;
};

export default async function Page({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const { customerId } = await params;
  const decodedId = decodeURIComponent(customerId);
  const numericId = Number(decodedId);

  const record =
    Number.isInteger(numericId) && numericId > 0
      ? await fetchCustomerBasicRecord(numericId)
      : null;

  const headingBase = record?.Name ?? buildFallbackHeading(decodedId);
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
          >
            View Contacts
          </Link>
        </div>
      </div>
      <div className={layoutStyles.pageBody}>
        <CustomerBasicDataPanel customerId={decodedId} initialRecord={record} />
      </div>
    </main>
  );
}
