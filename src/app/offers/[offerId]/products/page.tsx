import ClientProductsPage from './ClientProductsPage';

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const headingText = `${buildHeading(decodedId)} - Products`;

  return <ClientProductsPage offerId={decodedId} headingText={headingText} />;
}
