'use client';

import React, { useState, type CSSProperties } from 'react';
import Link from 'next/link';

type TabKey = 'basic' | 'products';

type Props = {
  offerId: string;
};

const containerStyle: CSSProperties = {
  padding: '32px 24px',
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  gap: '24px',
  width: '100%',
  maxWidth: 'var(--layout-max-width)',
  margin: '0 auto',
};

const headerGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const headingRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: '12px',
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '32px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const subHeadingStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: '16px',
  lineHeight: 1.6,
  maxWidth: '720px',
};

const tabContainerStyle: CSSProperties = {
  border: `1px solid var(--border-subtle)`,
  borderRadius: '16px',
  backgroundColor: 'var(--surface-raised)',
  boxShadow: `0 18px 36px var(--panel-shadow)`,
  overflow: 'hidden',
};

const tabHeaderRowStyle: CSSProperties = {
  display: 'flex',
  gap: '6px',
  padding: '12px 16px 0',
  backgroundColor: 'var(--surface-raised)',
  borderBottom: `1px solid var(--border-subtle)`,
};

const tabPanelStyle: CSSProperties = {
  padding: '24px 24px 28px',
  backgroundColor: 'var(--surface-raised)',
  color: 'var(--foreground)',
  minHeight: '220px',
};

const tabButtonBase: CSSProperties = {
  padding: '10px 16px',
  borderRadius: '10px 10px 0 0',
  border: '1px solid transparent',
  borderBottom: 'none',
  background: 'transparent',
  color: 'var(--text-muted)',
  fontWeight: 500,
  fontSize: '14px',
  cursor: 'pointer',
  transition: 'color 0.2s ease, background-color 0.2s ease, border-color 0.2s ease',
};

const activeTabStyles: CSSProperties = {
  backgroundColor: 'var(--tab-active-bg)',
  color: 'var(--foreground)',
  borderColor: 'var(--border-subtle)',
  borderBottom: 'none',
};

const inactiveTabStyles: CSSProperties = {
  backgroundColor: 'transparent',
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '20px',
  fontWeight: 600,
  letterSpacing: '-0.01em',
};

const sectionDescriptionStyle: CSSProperties = {
  margin: '8px 0 20px',
  color: 'var(--text-muted)',
  maxWidth: '720px',
};

const infoGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
  gap: '16px',
  margin: 0,
};

const infoItemStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
};

const infoLabelStyle: CSSProperties = {
  margin: 0,
  fontSize: '12px',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--text-muted)',
};

const infoValueStyle: CSSProperties = {
  margin: 0,
  fontSize: '15px',
  fontWeight: 600,
};

const placeholderTextStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontStyle: 'italic',
};

const secondaryParagraphStyle: CSSProperties = {
  margin: '12px 0 0',
  color: 'var(--text-muted)',
  maxWidth: '720px',
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
    <main style={containerStyle}>
      <Link href="/offers" className="link-quiet">
        <span aria-hidden="true">←</span>
        Back to offers
      </Link>

      <header style={headerGroupStyle}>
        <div style={headingRowStyle}>
          <h1 style={headingStyle}>{headingText}</h1>
        </div>
        <p style={subHeadingStyle}>
          Review the basic information and product breakdown for this offer. We’ll hydrate this view
          with live data shortly.
        </p>
      </header>

      <div style={tabContainerStyle}>
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
            <div>
              <h2 style={sectionTitleStyle}>Basic Data</h2>
              <p style={sectionDescriptionStyle}>
                This section will surface metadata such as customer contacts, opportunity status, and
                commercial terms when the API is wired in.
              </p>
              <dl style={infoGridStyle}>
                <div style={infoItemStyle}>
                  <dt style={infoLabelStyle}>Offer Identifier</dt>
                  <dd style={infoValueStyle}>{offerId || <span style={placeholderTextStyle}>Unknown</span>}</dd>
                </div>
                <div style={infoItemStyle}>
                  <dt style={infoLabelStyle}>Status</dt>
                  <dd style={infoValueStyle}>
                    <span style={placeholderTextStyle}>(coming soon)</span>
                  </dd>
                </div>
                <div style={infoItemStyle}>
                  <dt style={infoLabelStyle}>Customer</dt>
                  <dd style={infoValueStyle}>
                    <span style={placeholderTextStyle}>(coming soon)</span>
                  </dd>
                </div>
                <div style={infoItemStyle}>
                  <dt style={infoLabelStyle}>Pricing Policy</dt>
                  <dd style={infoValueStyle}>
                    <span style={placeholderTextStyle}>(coming soon)</span>
                  </dd>
                </div>
              </dl>
            </div>
          ) : (
            <div>
              <h2 style={sectionTitleStyle}>Products</h2>
              <p style={sectionDescriptionStyle}>
                Product-level details will surface here once the product feed is wired in.
              </p>
              <p style={secondaryParagraphStyle}>
                Use this space to show line items, pricing breakdowns, or attach supporting documents
                when the data becomes available.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
