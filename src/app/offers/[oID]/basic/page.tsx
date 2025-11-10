import Link from 'next/link';
import OfferBasicDataPanel from '../OfferBasicDataPanel';

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

const headerRowStyle = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'center' as const,
  position: 'relative' as const,
  padding: '4px 0',
};

const backLinkAbsoluteStyle = {
  position: 'absolute' as const,
  left: 0,
};

const buildHeading = (oID: string) =>
  /^[0-9]+$/.test(oID) ? `Offer ${oID}` : oID;

export default async function Page({ params }: { params: Promise<{ oID: string }> }) {
  const { oID } = await params;
  const decodedId = decodeURIComponent(oID);
  const headingText = `${buildHeading(decodedId)} - Basic Data`;

  return (
    <main style={pageShellStyle}>
      <div style={headerRowStyle}>
        <Link href="/offers" className="link-quiet" style={backLinkAbsoluteStyle}>
          <span aria-hidden="true">←</span>
          Back to offers
        </Link>
        <h1 style={headingStyle}>{headingText}</h1>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <OfferBasicDataPanel oID={decodedId} />
      </div>
    </main>
  );
}
