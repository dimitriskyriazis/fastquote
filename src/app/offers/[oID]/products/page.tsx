import ClientProductsPage from './ClientProductsPage';

const buildHeading = (oID: string) =>
  /^[0-9]+$/.test(oID) ? `Offer ${oID}` : oID;

export default async function Page({ params }: { params: Promise<{ oID: string }> }) {
  const { oID } = await params;
  const decodedId = decodeURIComponent(oID);
  const headingText = `${buildHeading(decodedId)} - Products`;

  return <ClientProductsPage oID={decodedId} headingText={headingText} />;
}
