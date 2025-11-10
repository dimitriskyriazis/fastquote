'use client';

import React, { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import OfferProductsPanel from '../OfferProductsPanel';

type Props = {
  oID: string;
  headingText: string;
};

const pageShellStyle: CSSProperties = {
  padding: '16px',
  boxSizing: 'border-box',
  height: '100vh',
  width: '100%',
  maxWidth: '100vw',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  overflow: 'hidden',
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '24px',
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'center',
  position: 'relative',
  padding: '4px 0',
};

const backLinkAbsoluteStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
};

export default function ClientProductsPage({ oID, headingText }: Props) {
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
          style={{ position: 'absolute', right: 0, top: 0 }}
          onClick={() => setManualMode((prev) => !prev)}
        >
          Manual Mode
        </button>
      </div>
      <OfferProductsPanel oID={oID} manualMode={manualMode} />
    </main>
  );
}
