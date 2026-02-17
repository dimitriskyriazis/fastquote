import sql from 'mssql';
import ClientProductsPage from './ClientProductsPage';
import { getPool } from '../../../../lib/sql';

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

type OfferHeaderInfo = {
  title: string | null;
  isStandardPackage: boolean;
};

async function fetchOfferHeaderInfo(offerId: number): Promise<OfferHeaderInfo> {
  type OfferHeaderRow = { Title: string | null; IsStandardPackage: number | boolean | null };
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('offerId', sql.Int, offerId);
    const result = await request.query<OfferHeaderRow>(`
      SELECT
        Title,
        IsStandardPackage
      FROM dbo.Offer
      WHERE ID = @offerId
    `);
    const row = result.recordset?.[0] ?? null;
    return {
      title: row?.Title?.trim() || null,
      isStandardPackage: row?.IsStandardPackage === true || row?.IsStandardPackage === 1,
    };
  } catch (err) {
    console.error('Failed to load offer title for products page', err);
    return { title: null, isStandardPackage: false };
  }
}

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const hasNumericOfferId = /^[0-9]+$/.test(decodedId);
  const normalizedId = Number.parseInt(decodedId, 10);
  const offerHeader = hasNumericOfferId
    ? await fetchOfferHeaderInfo(normalizedId)
    : { title: null, isStandardPackage: false };
  const offerTitle = offerHeader.title;
  const isStandardPackage = offerHeader.isStandardPackage;
  const headingText = `${offerTitle ?? buildHeading(decodedId)} - Products`;

  return (
    <ClientProductsPage
      offerId={decodedId}
      headingText={headingText}
      isStandardPackage={isStandardPackage}
    />
  );
}
