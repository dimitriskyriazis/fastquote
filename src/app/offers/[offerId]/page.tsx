import OfferDetailClient from './OfferDetailClient';

type PageProps = {
  params: { offerId: string };
};

export default function OfferDetailPage({ params }: PageProps) {
  const decodedId = decodeURIComponent(params.offerId);
  return <OfferDetailClient offerId={decodedId} />;
}
