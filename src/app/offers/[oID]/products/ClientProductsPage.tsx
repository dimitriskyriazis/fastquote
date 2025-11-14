'use client';

import React, { useState, useCallback, useRef, type CSSProperties } from 'react';
import Link from 'next/link';
import OfferProductsPanel from '../OfferProductsPanel';
import { showToastMessage } from '../../../../lib/toast';

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
  textAlign: 'center',
  flexShrink: 0,
};

const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '4px 0',
};

const headerSideCommonStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
};

const backLinkWrapperStyle: CSSProperties = {
  ...headerSideCommonStyle,
  justifyContent: 'flex-start',
};

const controlsWrapperStyle: CSSProperties = {
  ...headerSideCommonStyle,
  justifyContent: 'flex-end',
};

const backLinkStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  whiteSpace: 'nowrap',
};

type AddActionType = 'product' | 'category' | 'printable-comment' | 'non-printable-comment';
type CreatableActionType = Exclude<AddActionType, 'product'>;

const addActionLabels: Record<AddActionType, string> = {
  product: 'Add Product',
  category: 'Add Category',
  'printable-comment': 'Add Printable Comment',
  'non-printable-comment': 'Add Non Printable Comment',
};

const addActionDescriptionLabels: Record<CreatableActionType, string> = {
  category: 'New Category',
  'printable-comment': 'New Printable Comment',
  'non-printable-comment': 'New Non Printable Comment',
};

const addActionButtons: Array<{ key: AddActionType; label: string }> = [
  { key: 'product', label: addActionLabels.product },
  { key: 'category', label: addActionLabels.category },
  { key: 'printable-comment', label: addActionLabels['printable-comment'] },
  { key: 'non-printable-comment', label: addActionLabels['non-printable-comment'] },
];

export default function ClientProductsPage({ oID, headingText }: Props) {
  const [manualMode, setManualMode] = useState(false);
  const [pendingAction, setPendingAction] = useState<CreatableActionType | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const creationCountersRef = useRef<Record<CreatableActionType, number>>({
    category: 0,
    'printable-comment': 0,
    'non-printable-comment': 0,
  });

  const handleAddAction = useCallback(async (action: AddActionType) => {
    if (action === 'product') {
      const label = addActionLabels[action] ?? 'Add Product';
      showToastMessage(`${label} coming soon`, 'info');
      return;
    }
    if (pendingAction) {
      return;
    }
    const nextIndex = (creationCountersRef.current[action] ?? 0) + 1;
    const baseLabel = addActionDescriptionLabels[action] ?? 'New Entry';
    const description = `${baseLabel} (${nextIndex})`;
    setPendingAction(action);
    try {
      const endpoint = `/api/offers/${encodeURIComponent(oID)}/products`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create',
          type: action,
          description,
        }),
      });
      let payload: { ok?: boolean; error?: string } | null = null;
      try {
        payload = (await res.json()) as { ok?: boolean; error?: string } | null;
      } catch {
        payload = null;
      }
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to add row (status ${res.status})`);
      }
      creationCountersRef.current[action] = nextIndex;
      setRefreshToken((prev) => prev + 1);
      showToastMessage(`${baseLabel} added`, 'success');
    } catch (err) {
      console.error('Failed to add offer row', err);
      showToastMessage('Unable to add row. Please try again.', 'error');
    } finally {
      setPendingAction(null);
    }
  }, [oID, pendingAction]);

  return (
    <main style={pageShellStyle}>
      <div style={headerRowStyle}>
        <div style={backLinkWrapperStyle}>
          <Link href="/offers" className="link-quiet" style={backLinkStyle}>
            <span aria-hidden="true">←</span>
            Back to offers
          </Link>
        </div>
        <h1 style={headingStyle}>{headingText}</h1>
        <div style={controlsWrapperStyle}>
          <div className="offer-products-toolbar">
            {addActionButtons.map((action) => {
              const disabled = pendingAction != null;
              return (
                <button
                  type="button"
                  key={action.key}
                  className={`offer-products-toolbar__button offer-products-toolbar__button--${action.key}`}
                  onClick={() => handleAddAction(action.key)}
                  disabled={disabled}
                >
                  {action.label}
                </button>
              );
            })}
            <button
              type="button"
              className={`manual-mode-toggle${manualMode ? ' active' : ''}`}
              onClick={() => setManualMode((prev) => !prev)}
            >
              Manual Mode
            </button>
          </div>
        </div>
      </div>
      <OfferProductsPanel oID={oID} manualMode={manualMode} refreshToken={refreshToken} />
    </main>
  );
}
