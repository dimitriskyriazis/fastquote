'use client';

import React, { useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import OfferProductsPanel from '../OfferProductsPanel';
import { showToastMessage } from '../../../../lib/toast';
import layoutStyles from '../../offersDetail.module.css';
import toolbarStyles from './ClientProductsPage.module.css';
import AddProductsModal from './AddProductsModal';

type Props = {
  oID: string;
  headingText: string;
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

const buttonVariantClass: Record<AddActionType, string> = {
  product: toolbarStyles.buttonProduct,
  category: toolbarStyles.buttonCategory,
  'printable-comment': toolbarStyles.buttonPrintableComment,
  'non-printable-comment': toolbarStyles.buttonNonPrintableComment,
};

export default function ClientProductsPage({ oID, headingText }: Props) {
  const [manualMode, setManualMode] = useState(false);
  const [pendingAction, setPendingAction] = useState<CreatableActionType | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const creationCountersRef = useRef<Record<CreatableActionType, number>>({
    category: 0,
    'printable-comment': 0,
    'non-printable-comment': 0,
  });

  const handleAddAction = useCallback(async (action: AddActionType) => {
    if (action === 'product') {
      setShowAddProductModal(true);
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

  const manualToggleClass = manualMode
    ? `${toolbarStyles.manualToggle} ${toolbarStyles.manualToggleActive}`
    : toolbarStyles.manualToggle;

  const handleProductsAdded = useCallback((count: number) => {
    void count;
    setRefreshToken((prev) => prev + 1);
  }, []);

  const handleCloseModal = useCallback(() => setShowAddProductModal(false), []);

  return (
    <main className={layoutStyles.page}>
      <div className={layoutStyles.headerRow}>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideStart}`}>
          <Link href="/offers" className={layoutStyles.backLink}>
            <span aria-hidden="true">←</span>
            Back to offers
          </Link>
        </div>
        <h1 className={`${layoutStyles.heading} ${layoutStyles.headingCentered}`}>{headingText}</h1>
        <div className={`${layoutStyles.headerSide} ${layoutStyles.headerSideEnd}`}>
          <div className={toolbarStyles.toolbar}>
            <div className={toolbarStyles.topControls}>
              <button
                type="button"
                className={manualToggleClass}
                onClick={() => setManualMode((prev) => !prev)}
              >
                Manual Mode
              </button>
              <Link
                href={`/offers/${encodeURIComponent(oID)}/basic`}
                className={layoutStyles.headerActionButton}
              >
                View basic data
              </Link>
            </div>
            <div className={toolbarStyles.addButtons}>
              {addActionButtons.map((action) => {
                const disabled = pendingAction != null;
                const variantClass = buttonVariantClass[action.key];
                return (
                  <button
                    type="button"
                    key={action.key}
                    className={`${toolbarStyles.button} ${variantClass}`}
                    onClick={() => handleAddAction(action.key)}
                    disabled={disabled}
                  >
                    {action.label}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <OfferProductsPanel oID={oID} manualMode={manualMode} refreshToken={refreshToken} />
      {showAddProductModal ? (
        <AddProductsModal oID={oID} onAdded={handleProductsAdded} onClose={handleCloseModal} />
      ) : null}
    </main>
  );
}
