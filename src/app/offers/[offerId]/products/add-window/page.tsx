import DetachedAddProductsClient from './DetachedAddProductsClient';

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  return <DetachedAddProductsClient offerId={decodedId} />;
}
