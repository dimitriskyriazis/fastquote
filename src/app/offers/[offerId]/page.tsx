import OfferDetailClient from './OfferDetailClient';

type PageProps = {
  params: Promise<{ offerId: string }>;
};

export default async function OfferDetailPage({ params }: PageProps) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  return <OfferDetailClient offerId={decodedId} />;
}
