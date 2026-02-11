import sql from 'mssql';
import ClientProductsPage from './ClientProductsPage';
import { getPool } from '../../../../lib/sql';

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

async function fetchOfferTitle(offerId: number): Promise<string | null> {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('offerId', sql.Int, offerId);
    const result = await request.query<{ Title: string | null }>(`
      SELECT Title
      FROM dbo.Offer
      WHERE ID = @offerId
    `);
    const title = result.recordset?.[0]?.Title;
    if (typeof title !== 'string') return null;
    const trimmedTitle = title.trim();
    return trimmedTitle.length > 0 ? trimmedTitle : null;
  } catch (err) {
    console.error('Failed to load offer title for products page', err);
    return null;
  }
}

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const hasNumericOfferId = /^[0-9]+$/.test(decodedId);
  const normalizedId = Number.parseInt(decodedId, 10);
  const offerTitle = hasNumericOfferId ? await fetchOfferTitle(normalizedId) : null;
  const headingText = `${offerTitle ?? buildHeading(decodedId)} - Products`;

  return <ClientProductsPage offerId={decodedId} headingText={headingText} />;
}
