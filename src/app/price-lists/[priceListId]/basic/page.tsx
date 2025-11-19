import Link from "next/link";
import PriceListBasicDataPanel, { fetchPriceListBasicRecord } from "../PriceListBasicDataPanel";
import layoutStyles from "../../priceListDetail.module.css";

const buildFallbackHeading = (priceListId: string) =>
  /^[0-9]+$/.test(priceListId) ? `Price List ${priceListId}` : priceListId;

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
      ? await fetchPriceListBasicRecord(numericId)
      : null;

  const headingBase = record?.Name ?? buildFallbackHeading(decodedId);
  const headingText = `${headingBase} - Basic Data`;

  return (
    <main className={layoutStyles.page}>
      <div className={`${layoutStyles.headerRow} ${layoutStyles.headerRowCentered}`}>
        <Link href="/price-lists" className={`${layoutStyles.backLink} ${layoutStyles.backLinkAbsolute}`}>
          <span aria-hidden="true">←</span>
          Back to price lists
        </Link>
        <h1 className={layoutStyles.heading}>{headingText}</h1>
      </div>
      <div className={layoutStyles.pageBody}>
        <PriceListBasicDataPanel priceListId={decodedId} initialRecord={record} />
      </div>
    </main>
  );
}
