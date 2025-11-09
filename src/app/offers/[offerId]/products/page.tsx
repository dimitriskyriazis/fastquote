import Link from 'next/link';
import OfferProductsPanel from '../OfferProductsPanel';

const pageShellStyle = {
  padding: '16px',
  boxSizing: 'border-box' as const,
  height: '100vh',
  width: '100%',
  maxWidth: '100vw',
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '12px',
  overflow: 'hidden',
};

const headingStyle = {
  margin: 0,
  fontSize: '24px',
};

const backLinkStyle = {
  alignSelf: 'flex-start' as const,
};

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

export default async function Page({ params }: { params: Promise<{ offerId: string }> }) {
  const { offerId } = await params;
  const decodedId = decodeURIComponent(offerId);
  const headingText = `${buildHeading(decodedId)} - Products`;

  return (
    <main style={pageShellStyle}>
      <Link href="/offers" className="link-quiet" style={backLinkStyle}>
        <span aria-hidden="true">←</span>
        Back to offers
      </Link>
      <h1 style={headingStyle}>{headingText}</h1>
      <OfferProductsPanel offerId={decodedId} />
    </main>
  );
}

