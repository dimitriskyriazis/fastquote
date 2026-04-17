import sql from 'mssql';
import ClientProductsPage from './ClientProductsPage';
import { getPool } from '../../../../lib/sql';

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

type OfferHeaderInfo = {
  title: string | null;
  description: string | null;
  customerName: string | null;
  isStandardPackage: boolean;
  createdByUserId: string | null;
};

async function fetchOfferHeaderInfo(offerId: number): Promise<OfferHeaderInfo> {
  type OfferHeaderRow = {
    Title: string | null;
    Description: string | null;
    CustomerName: string | null;
    IsStandardPackage: number | boolean | null;
    CreatedBy: number | string | null;
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
        o.CreatedBy
      FROM dbo.Offer AS o
      LEFT JOIN dbo.Customers AS c ON c.ID = o.CustomerID
      WHERE o.ID = @offerId
    `);
    const row = result.recordset?.[0] ?? null;
    return {
      title: row?.Title?.trim() || null,
      description: row?.Description?.trim() || null,
      customerName: row?.CustomerName?.trim() || null,
      isStandardPackage: row?.IsStandardPackage === true || row?.IsStandardPackage === 1,
      createdByUserId: row?.CreatedBy != null ? String(row.CreatedBy) : null,
    };
  } catch (err) {
    console.error('Failed to load offer title for products page', err);
    return {
      title: null,
      description: null,
      customerName: null,
      isStandardPackage: false,
      createdByUserId: null,
    };
  }
}

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const hasNumericOfferId = /^[0-9]+$/.test(decodedId);
  const normalizedId = Number.parseInt(decodedId, 10);
  const offerHeader = hasNumericOfferId
    ? await fetchOfferHeaderInfo(normalizedId)
    : {
        title: null,
        description: null,
        customerName: null,
        isStandardPackage: false,
        createdByUserId: null,
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

  return (
    <ClientProductsPage
      offerId={decodedId}
      headingText={headingText}
      headingTopText={headingTopText}
      headingBottomText={headingBottomText}
      isStandardPackage={isStandardPackage}
      offerCreatedByUserId={offerHeader.createdByUserId}
    />
  );
}
