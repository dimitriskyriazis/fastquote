'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import PageHeader from '../../../components/PageHeader';
import { GridQuickSearchProvider } from '../../../components/GridQuickSearchProvider';
import OfferProductsPanel from '../OfferProductsPanel';
import { showToastMessage } from '../../../../lib/toast';
import { addRecentOffer } from '../../../lib/recentOffers';
import layoutStyles from '../../offersDetail.module.css';
import pageHeaderStyles from '../../../components/PageHeader.module.css';
import toolbarStyles from './ClientProductsPage.module.css';
import AddProductsModal from './AddProductsModal';
import AddRequestedProductsModal from './AddRequestedProductsModal';
type Props = {
  offerId: string;
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

export default function ClientProductsPage({ offerId, headingText }: Props) {
  useEffect(() => {
    void addRecentOffer({
      id: offerId,
      label: headingText,
      description: headingText.replace(/ - Products$/i, '').trim(),
      title: headingText.replace(/ - Products$/i, '').trim(),
    });
  }, [offerId, headingText]);

  const [manualMode, setManualMode] = useState(false);
  const [pendingAction, setPendingAction] = useState<CreatableActionType | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [showRequestedModal, setShowRequestedModal] = useState(false);
  const [showRequestedColumns, setShowRequestedColumns] = useState(true);
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
      const endpoint = `/api/offers/${encodeURIComponent(offerId)}/products`;
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
  }, [offerId, pendingAction]);

  const manualToggleClass = manualMode
    ? `${toolbarStyles.manualToggle} ${toolbarStyles.manualToggleActive} page-header-button`
    : `${toolbarStyles.manualToggle} page-header-button`;

  const handleProductsAdded = useCallback((count: number) => {
    void count;
    setRefreshToken((prev) => prev + 1);
  }, []);

  const handleCloseModal = useCallback(() => setShowAddProductModal(false), []);
  const handleCloseRequestedModal = useCallback(() => setShowRequestedModal(false), []);
  const handleRequestedImported = useCallback((result: { inserted?: number; updated?: number; total?: number }) => {
    void result;
    setRefreshToken((prev) => prev + 1);
  }, []);
  const handleToggleRequestedColumns = useCallback(() => {
    setShowRequestedColumns((prev) => !prev);
  }, []);

  const headerRightControls = (
    <div className={toolbarStyles.topControls}>
      <button
        type="button"
        className={manualToggleClass}
        onClick={() => setManualMode((prev) => !prev)}
      >
        Manual Mode
      </button>
      <Link
        href={`/offers/${encodeURIComponent(offerId)}/basicdata`}
        className={`${layoutStyles.headerActionButton} page-header-button`}
        target="_blank"
        rel="noopener noreferrer"
      >
        View Basic Data
      </Link>
    </div>
  );

  const addButtonGroup = (
    <div className={toolbarStyles.addButtons}>
      {addActionButtons.map((action) => {
        const disabled = pendingAction != null;
        const variantClass = buttonVariantClass[action.key];
        return (
          <button
            type="button"
            key={action.key}
            className={`${toolbarStyles.button} ${variantClass} page-header-button`}
            onClick={() => handleAddAction(action.key)}
            disabled={disabled}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );

  const addRequestedButton = (
    <button
      type="button"
      className={`${toolbarStyles.button} ${toolbarStyles.buttonAddRequested} page-header-button`}
      onClick={() => setShowRequestedModal(true)}
    >
      Add Requested Products
    </button>
  );

  const requestedToggleButton = (
    <button
      type="button"
      className={`${toolbarStyles.button} ${toolbarStyles.buttonToggleRequested} page-header-button`}
      onClick={handleToggleRequestedColumns}
    >
      {showRequestedColumns ? 'Hide Requested' : 'Show Requested'}
    </button>
  );

  return (
    <main className={layoutStyles.page}>
      <PageHeader
        title={headingText}
        className={pageHeaderStyles.headerRowTop}
        headingClassName={pageHeaderStyles.topTitle}
        leftActions={
          <Link href="/offers" className={`${layoutStyles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to offers
          </Link>
        }
        rightActions={headerRightControls}
      >
        <GridQuickSearchProvider>
          <PageHeader
            title={headingText}
            leftActions={
              <div className={toolbarStyles.leftRequestedRow}>
                {addRequestedButton}
                {requestedToggleButton}
              </div>
            }
            rightActions={addButtonGroup}
            className={pageHeaderStyles.headerRowBottom}
            hideTitle
          >
            <OfferProductsPanel
              offerId={offerId}
              manualMode={manualMode}
              refreshToken={refreshToken}
              showRequestedColumns={showRequestedColumns}
            />
            {showAddProductModal ? (
              <AddProductsModal offerId={offerId} onAdded={handleProductsAdded} onClose={handleCloseModal} />
            ) : null}
            {showRequestedModal ? (
              <AddRequestedProductsModal
                offerId={offerId}
                onClose={handleCloseRequestedModal}
                onImported={handleRequestedImported}
              />
            ) : null}
          </PageHeader>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
