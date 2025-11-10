'use client';

import React, { useState } from 'react';
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

export default function Page({ params }: { params: { oID: string } }) {
  const decodedId = decodeURIComponent(params.oID);
  const headingText = `${buildHeading(decodedId)} - Products`;
  const [manualMode, setManualMode] = useState(false);

  return (
    <main style={pageShellStyle}>
      <div style={headerRowStyle}>
        <Link href="/offers" className="link-quiet" style={backLinkAbsoluteStyle}>
          <span aria-hidden="true">←</span>
          Back to offers
        </Link>
        <h1 style={headingStyle}>{headingText}</h1>
        <button
          type="button"
          className={`manual-mode-toggle${manualMode ? ' active' : ''}`}
          style={{ position: 'absolute', right: 0 }}
          onClick={() => setManualMode((prev) => !prev)}
        >
          Manual Mode
        </button>
      </div>
      <OfferProductsPanel oID={decodedId} manualMode={manualMode} />
    </main>
  );
}
