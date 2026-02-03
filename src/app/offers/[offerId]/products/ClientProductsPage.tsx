'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import Link from 'next/link';
import PageHeader from '../../../components/PageHeader';
import { GridQuickSearchProvider } from '../../../components/GridQuickSearchProvider';
import OfferProductsPanel, { type OfferProductsPanelHandle } from '../OfferProductsPanel';
import OfferProductsPivotPanel from './OfferProductsPivotPanel';
import { showToastMessage } from '../../../../lib/toast';
import { addRecentOffer } from '../../../lib/recentOffers';
import { useAuditUser } from '../../../components/AuditUserProvider';
import layoutStyles from '../../offersDetail.module.css';
import pageHeaderStyles from '../../../components/PageHeader.module.css';
import toolbarStyles from './ClientProductsPage.module.css';
import AddProductsModal from './AddProductsModal';
import AddRequestedProductsModal from './AddRequestedProductsModal';
import AddProductModal from '../../../products/AddProductModal';
type Props = {
  offerId: string;
  headingText: string;
};

type AddActionType = 'product' | 'category' | 'printable-comment' | 'non-printable-comment';
type CreatableActionType = Exclude<AddActionType, 'product'>;
type ProductsTableLayout = 'cust' | 'wCost' | 'wReq';

const LAYOUT_STORAGE_PREFIX = 'fastquote-offer-products-layout';

const addActionLabels: Record<AddActionType, string> = {
  product: 'Add Products',
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

const sanitizeStorageSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

const buildLayoutStorageKey = (userId: string | null | undefined) => {
  const normalizedUser = userId && userId.trim() ? userId.trim() : 'anon';
  return `${LAYOUT_STORAGE_PREFIX}:${sanitizeStorageSegment(normalizedUser)}`;
};

const readPersistedLayout = (key: string | null): ProductsTableLayout | null => {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'cust' || raw === 'wCost' || raw === 'wReq') {
      return raw;
    }
  } catch {
    /* noop */
  }
  return null;
};

export default function ClientProductsPage({ offerId, headingText }: Props) {
  const { userId } = useAuditUser();
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
  const [isUpdatingPrices, setIsUpdatingPrices] = useState(false);
  const [isPopulatingOffer, setIsPopulatingOffer] = useState(false);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [showRequestedModal, setShowRequestedModal] = useState(false);
  const [showAddProductFormModal, setShowAddProductFormModal] = useState(false);
  const [newProductId, setNewProductId] = useState<number | null>(null);
  const [tableLayout, setTableLayout] = useState<ProductsTableLayout>('wReq');
  const [pivotView, setPivotView] = useState(false);
  const [pivotLayout, setPivotLayout] = useState<'category' | 'brand' | 'categoryBrand' | 'discount'>('category');
  const offerProductsPanelRef = useRef<OfferProductsPanelHandle | null>(null);
  const handleRequestPivot = useCallback(() => setPivotView(true), []);
  const layoutStorageKey = useMemo(() => buildLayoutStorageKey(userId), [userId]);
  const layoutLoadedRef = useRef<string | null>(null);
  const creationCountersRef = useRef<Record<CreatableActionType, number>>({
    category: 0,
    'printable-comment': 0,
    'non-printable-comment': 0,
  });

  useEffect(() => {
    if (!layoutStorageKey) return;
    layoutLoadedRef.current = layoutStorageKey;
    const persisted = readPersistedLayout(layoutStorageKey);
    if (persisted) {
      setTableLayout((current) => (current === persisted ? current : persisted));
    }
  }, [layoutStorageKey]);

  useEffect(() => {
    if (typeof window === 'undefined' || !layoutStorageKey) return;
    if (layoutLoadedRef.current !== layoutStorageKey) return;
    try {
      window.localStorage.setItem(layoutStorageKey, tableLayout);
    } catch {
      /* noop */
    }
  }, [layoutStorageKey, tableLayout]);

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
  const handleOpenAddProductForm = useCallback(() => setShowAddProductFormModal(true), []);
  const handleCloseAddProductForm = useCallback(() => setShowAddProductFormModal(false), []);
  const handleClearNewProductId = useCallback(() => setNewProductId(null), []);
  const handleRequestedImported = useCallback((result: { inserted?: number; updated?: number; total?: number }) => {
    void result;
    setRefreshToken((prev) => prev + 1);
  }, []);
  const showRequestedColumns = tableLayout === 'wReq';
  const headerRowTopClassName = showAddProductModal
    ? `${pageHeaderStyles.headerRowTop} ${toolbarStyles.compactHeaderRow}`
    : pageHeaderStyles.headerRowTop;
  const headerRowBottomClassName = showAddProductModal
    ? `${pageHeaderStyles.headerRowBottom} ${toolbarStyles.compactHeaderRow}`
    : pageHeaderStyles.headerRowBottom;
  const updatePricesEndpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products/update-prices`,
    [offerId],
  );

  const handleUpdatePrices = useCallback(async () => {
    if (isUpdatingPrices) return;
    setIsUpdatingPrices(true);
    try {
      const response = await fetch(updatePricesEndpoint, { method: 'POST' });
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; updated?: number }
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Unable to update prices (status ${response.status})`);
      }
      const updatedCount = typeof payload?.updated === 'number' ? payload.updated : null;
      const message = updatedCount == null
        ? 'Updated offer prices'
        : `Updated prices for ${updatedCount} product${updatedCount === 1 ? '' : 's'}`;
      showToastMessage(message, 'success');
      setRefreshToken((prev) => prev + 1);
    } catch (err) {
      console.error('Failed to update offer prices', err);
      showToastMessage('Unable to update product prices. Please try again.', 'error');
    } finally {
      setIsUpdatingPrices(false);
    }
  }, [isUpdatingPrices, updatePricesEndpoint]);

  const handlePopulateOffer = useCallback(async () => {
    if (isPopulatingOffer) return;
    const panel = offerProductsPanelRef.current;
    if (!panel) {
      showToastMessage('Products grid is not ready yet.', 'error');
      return;
    }
    setIsPopulatingOffer(true);
    try {
      await panel.populateOffer();
    } finally {
      setIsPopulatingOffer(false);
    }
  }, [isPopulatingOffer]);

  const headerRightControls = (
    <div className={toolbarStyles.topControls}>
      {pivotView ? null : (
        <>
          <button
            type="button"
            className={`${toolbarStyles.button} ${toolbarStyles.buttonPopulateOffer} page-header-button`}
            onClick={handlePopulateOffer}
            disabled={isPopulatingOffer}
          >
            {isPopulatingOffer ? 'Populating…' : 'Populate Offer'}
          </button>
          <button
            type="button"
            className={`${toolbarStyles.button} ${toolbarStyles.buttonUpdatePrices} page-header-button`}
            onClick={handleUpdatePrices}
            disabled={isUpdatingPrices}
          >
            {isUpdatingPrices ? 'Updating prices…' : 'Update Prices'}
          </button>
          <button
            type="button"
            className={manualToggleClass}
            onClick={() => setManualMode((prev) => !prev)}
          >
            Manual Mode
          </button>
        </>
      )}
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

  const layoutSelect = (
    <select
      className={`${toolbarStyles.layoutSelect} page-header-button`}
      value={tableLayout}
      onChange={(event) => setTableLayout(event.target.value as ProductsTableLayout)}
      aria-label="Table layout"
    >
      <option value="cust">Cust</option>
      <option value="wCost">wCost</option>
      <option value="wReq">wReq</option>
    </select>
  );
  const pivotLayoutSelect = pivotView ? (
    <select
      className={`${toolbarStyles.layoutSelect} ${toolbarStyles.pivotLayoutSelect} page-header-button`}
      value={pivotLayout}
      onChange={(event) => setPivotLayout(event.target.value as typeof pivotLayout)}
      aria-label="Pivot layout"
    >
      <option value="category">Pivot: Category</option>
      <option value="brand">Pivot: Brand</option>
      <option value="categoryBrand">Pivot: Category × Brand</option>
      <option value="discount">Pivot: Discounts</option>
    </select>
  ) : null;

  return (
    <main className={layoutStyles.page}>
      <PageHeader
        title={headingText}
        className={headerRowTopClassName}
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
                {pivotView ? (
                  pivotLayoutSelect
                ) : (
                  <>
                    {addRequestedButton}
                    {layoutSelect}
                  </>
                )}
              </div>
            }
            rightActions={pivotView ? null : addButtonGroup}
            className={headerRowBottomClassName}
            hideTitle
          >
            <div className={toolbarStyles.contentArea}>
              {pivotView ? (
                <OfferProductsPivotPanel
                  offerId={offerId}
                  refreshToken={refreshToken}
                  layout={pivotLayout}
                  onExitPivot={() => setPivotView(false)}
                />
              ) : showAddProductModal ? (
                <div className={toolbarStyles.splitLayout}>
                  <div className={toolbarStyles.splitLeft}>
                    <OfferProductsPanel
                      ref={offerProductsPanelRef}
                      offerId={offerId}
                      manualMode={manualMode}
                      refreshToken={refreshToken}
                      showRequestedColumns={showRequestedColumns}
                      tableLayout={tableLayout}
                      onRequestPivot={handleRequestPivot}
                    />
                  </div>
                  <div className={toolbarStyles.splitRight}>
                  <AddProductsModal
                      offerId={offerId}
                      onAdded={handleProductsAdded}
                      onClose={handleCloseModal}
                      showRequestedColumns={showRequestedColumns}
                      splitViewMode
                      refreshToken={refreshToken}
                      onRequestAddProduct={handleOpenAddProductForm}
                      newProductId={newProductId}
                      onClearNewProductId={handleClearNewProductId}
                      onRequestPayloadConsumed={handleClearNewProductId}
                    />
                  </div>
                </div>
              ) : (
                <OfferProductsPanel
                  ref={offerProductsPanelRef}
                  offerId={offerId}
                  manualMode={manualMode}
                  refreshToken={refreshToken}
                  showRequestedColumns={showRequestedColumns}
                  tableLayout={tableLayout}
                  onRequestPivot={handleRequestPivot}
                />
              )}
            </div>
            {showRequestedModal ? (
              <AddRequestedProductsModal
                offerId={offerId}
                onClose={handleCloseRequestedModal}
                onImported={handleRequestedImported}
              />
            ) : null}
            <AddProductModal
              open={showAddProductFormModal}
              onClose={handleCloseAddProductForm}
              onAdded={(result) => {
                if (result?.productId != null) {
                  setNewProductId(result.productId);
                }
                handleCloseAddProductForm();
                setRefreshToken((prev) => prev + 1);
              }}
            />
          </PageHeader>
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
