'use client';

import React, { useState, type CSSProperties } from 'react';
import Link from 'next/link';
import OfferBasicDataPanel from './OfferBasicDataPanel';
import OfferProductsPanel from './OfferProductsPanel';

type TabKey = 'basic' | 'products';

type Props = {
  offerId: string;
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

const backLinkStyle: CSSProperties = {
  alignSelf: 'flex-start',
};

const tabShellStyle: CSSProperties = {
  border: `1px solid var(--detail-panel-border)`,
  borderRadius: '16px',
  backgroundColor: 'var(--detail-panel-bg)',
  boxShadow: '0 24px 60px rgba(15, 23, 42, 0.08)',
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
  overflow: 'hidden',
};

const tabHeaderRowStyle: CSSProperties = {
  display: 'flex',
  gap: '8px',
  padding: '12px 16px',
  borderBottom: `1px solid var(--detail-panel-border)`,
  backgroundColor: 'var(--detail-panel-muted-bg)',
};

const tabPanelStyle: CSSProperties = {
  padding: '16px',
  flex: 1,
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflow: 'hidden',
  backgroundColor: 'var(--detail-panel-bg)',
};

const tabButtonBase: CSSProperties = {
  padding: '8px 16px',
  borderRadius: '999px',
  borderWidth: '1px',
  borderStyle: 'solid',
  borderColor: 'transparent',
  background: 'transparent',
  color: 'var(--detail-chip-inactive-fg)',
  fontWeight: 500,
  fontSize: '14px',
  cursor: 'pointer',
  transition: 'color 0.2s ease, background-color 0.2s ease, border-color 0.2s ease',
};

const activeTabStyles: CSSProperties = {
  backgroundColor: 'var(--detail-chip-active-bg)',
  color: 'var(--detail-chip-active-fg)',
  borderColor: 'var(--detail-panel-border)',
};

const inactiveTabStyles: CSSProperties = {
  backgroundColor: 'transparent',
};

const buildHeading = (offerId: string) =>
  /^[0-9]+$/.test(offerId) ? `Offer ${offerId}` : offerId;

export default function OfferDetailClient({ offerId }: Props) {
  const [activeTab, setActiveTab] = useState<TabKey>('basic');

  const buildButtonStyle = (tab: TabKey): CSSProperties => ({
    ...tabButtonBase,
    ...(activeTab === tab ? activeTabStyles : inactiveTabStyles),
  });

  const headingText = buildHeading(offerId);

  const activePanelId = activeTab === 'basic' ? 'offer-tabpanel-basic' : 'offer-tabpanel-products';
  const activeTabId = activeTab === 'basic' ? 'offer-tab-basic' : 'offer-tab-products';

  return (
    <main style={pageShellStyle}>
      <Link href="/offers" className="link-quiet" style={backLinkStyle}>
        <span aria-hidden="true">←</span>
        Back to offers
      </Link>
      <h1 style={headingStyle}>{headingText}</h1>

      <div style={tabShellStyle}>
        <nav style={tabHeaderRowStyle} aria-label="Offer detail tabs" role="tablist">
          <button
            type="button"
            style={buildButtonStyle('basic')}
            onClick={() => setActiveTab('basic')}
            aria-selected={activeTab === 'basic'}
            aria-controls="offer-tabpanel-basic"
            id="offer-tab-basic"
            role="tab"
          >
            Basic Data
          </button>
          <button
            type="button"
            style={buildButtonStyle('products')}
            onClick={() => setActiveTab('products')}
            aria-selected={activeTab === 'products'}
            aria-controls="offer-tabpanel-products"
            id="offer-tab-products"
            role="tab"
          >
            Products
          </button>
        </nav>

        <section
          style={tabPanelStyle}
          role="tabpanel"
          id={activePanelId}
          aria-labelledby={activeTabId}
        >
          {activeTab === 'basic' ? (
            <OfferBasicDataPanel offerId={offerId} />
          ) : (
            <OfferProductsPanel offerId={offerId} />
          )}
        </section>
      </div>
    </main>
  );
}
