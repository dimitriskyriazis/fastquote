import sql from 'mssql';
import ClientProductsPage from './ClientProductsPage';
import { getPool } from '../../../../lib/sql';

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

const READ_ONLY_STATUSES = new Set(['Official Offer Sent', 'Order Signed']);

type OfferHeaderInfo = {
  title: string | null;
  description: string | null;
  customerName: string | null;
  isStandardPackage: boolean;
  createdByUserId: string | null;
  pricingPolicyName: string | null;
  pricingHoldMarginOnCost: boolean;
  extraNetDiscount: number | null;
  extraNetDiscountMode: 'pct' | 'abs';
  statusName: string | null;
};

const normalizeDiscountMode = (value: unknown): 'pct' | 'abs' =>
  value === 'abs' ? 'abs' : 'pct';
const normalizeDiscountValue = (value: unknown): number | null => {
  // SQL Server DECIMAL columns may surface as a number or a string depending on the
  // driver, so accept both.
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

async function fetchOfferHeaderInfo(offerId: number): Promise<OfferHeaderInfo> {
  type OfferHeaderRow = {
    Title: string | null;
    Description: string | null;
    CustomerName: string | null;
    IsStandardPackage: number | boolean | null;
    CreatedBy: number | string | null;
    PricingPolicyName: string | null;
    PricingHoldMarginOnCost: boolean | number | null;
    ExtraNetDiscount: number | null;
    ExtraNetDiscountMode: string | null;
    StatusName: string | null;
  };
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('offerId', sql.Int, offerId);
    const result = await request.query<OfferHeaderRow>(`
      SELECT
        o.Title,
        o.Description,
        c.Name AS CustomerName,
        o.IsStandardPackage,
        o.CreatedBy,
        pp.Name AS PricingPolicyName,
        o.PricingHoldMarginOnCost,
        o.ExtraNetDiscount,
        o.ExtraNetDiscountMode,
        os.Name AS StatusName
      FROM dbo.Offer AS o
      LEFT JOIN dbo.Customers AS c ON c.ID = o.CustomerID
      LEFT JOIN dbo.PricingPolicies AS pp ON pp.ID = o.PricingPolicyID
      LEFT JOIN dbo.OfferStatus AS os ON os.ID = o.StatusID
      WHERE o.ID = @offerId
    `);
    const row = result.recordset?.[0] ?? null;
    return {
      title: row?.Title?.trim() || null,
      description: row?.Description?.trim() || null,
      customerName: row?.CustomerName?.trim() || null,
      isStandardPackage: row?.IsStandardPackage === true || row?.IsStandardPackage === 1,
      createdByUserId: row?.CreatedBy != null ? String(row.CreatedBy) : null,
      pricingPolicyName: row?.PricingPolicyName?.trim() || null,
      pricingHoldMarginOnCost: row?.PricingHoldMarginOnCost === true || row?.PricingHoldMarginOnCost === 1,
      extraNetDiscount: normalizeDiscountValue(row?.ExtraNetDiscount),
      extraNetDiscountMode: normalizeDiscountMode(row?.ExtraNetDiscountMode),
      statusName: row?.StatusName?.trim() ?? null,
    };
  } catch (err) {
    console.error('Failed to load offer title for products page', err);
    return {
      title: null,
      description: null,
      customerName: null,
      isStandardPackage: false,
      createdByUserId: null,
      pricingPolicyName: null,
      pricingHoldMarginOnCost: false,
      extraNetDiscount: null,
      extraNetDiscountMode: 'pct',
      statusName: null,
    };
  }
}

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const hasNumericOfferId = /^[0-9]+$/.test(decodedId);
  const normalizedId = Number.parseInt(decodedId, 10);
  const offerHeader: OfferHeaderInfo = hasNumericOfferId
    ? await fetchOfferHeaderInfo(normalizedId)
    : {
        title: null,
        description: null,
        customerName: null,
        isStandardPackage: false,
        createdByUserId: null,
        pricingPolicyName: null,
        pricingHoldMarginOnCost: false,
        extraNetDiscount: null,
        extraNetDiscountMode: 'pct',
        statusName: null,
      };
  const offerTitle = offerHeader.title;
  const offerDescription = offerHeader.description;
  const customerName = offerHeader.customerName;
  const isStandardPackage = offerHeader.isStandardPackage;
  const headingBase = isStandardPackage
    ? (offerDescription ?? offerTitle ?? buildHeading(decodedId))
    : (offerTitle ?? buildHeading(decodedId));
  const headingText = isStandardPackage
    ? `SP - ${headingBase}`
    : `${headingBase} - Products`;
  const headingTopText = isStandardPackage ? null : customerName;
  const headingBottomText = isStandardPackage ? null : (offerDescription ?? offerTitle ?? null);

  const isReadOnly = !isStandardPackage && offerHeader.statusName != null && READ_ONLY_STATUSES.has(offerHeader.statusName);

  return (
    <ClientProductsPage
      offerId={decodedId}
      headingText={headingText}
      headingTopText={headingTopText}
      headingBottomText={headingBottomText}
      isStandardPackage={isStandardPackage}
      offerCreatedByUserId={offerHeader.createdByUserId}
      pricingPolicyName={offerHeader.pricingPolicyName}
      initialPricingHoldMarginOnCost={offerHeader.pricingHoldMarginOnCost}
      initialExtraNetDiscount={offerHeader.extraNetDiscount}
      initialExtraNetDiscountMode={offerHeader.extraNetDiscountMode}
      isReadOnly={isReadOnly}
    />
  );
}
