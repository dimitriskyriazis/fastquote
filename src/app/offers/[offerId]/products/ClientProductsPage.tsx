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
import ExportOfferProductsModal from './ExportOfferProductsModal';
import AddProductModal from '../../../products/AddProductModal';
type Props = {
  offerId: string;
  headingText: string;
};

type AddActionType = 'product' | 'category' | 'printable-comment' | 'non-printable-comment';
type CreatableActionType = Exclude<AddActionType, 'product'>;
type ProductsTableLayout = 'cust' | 'wCost' | 'wReq';
type PivotLayout = 'category' | 'brand';

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
  const [showExportModal, setShowExportModal] = useState(false);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [savedSelectionIds, setSavedSelectionIds] = useState<number[]>([]);
  const [showRequestedModal, setShowRequestedModal] = useState(false);
  const [showAddProductFormModal, setShowAddProductFormModal] = useState(false);
  const [newProductId, setNewProductId] = useState<number | null>(null);
  const [initialProductsViewportScrollTop, setInitialProductsViewportScrollTop] = useState<number | null>(null);
  const [tableLayout, setTableLayout] = useState<ProductsTableLayout>('wReq');
  const [pivotView, setPivotView] = useState(false);
  const [pivotLayout, setPivotLayout] = useState<PivotLayout>('brand');
  const offerProductsPanelRef = useRef<OfferProductsPanelHandle | null>(null);
  const splitLeftRef = useRef<HTMLDivElement | null>(null);
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

  const [initialRequestedRowId, setInitialRequestedRowId] = useState<number | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const pendingPageScrollRestoreRef = useRef<{ pageScrollTop: number; windowScrollY: number } | null>(null);

  const handleAddAction = useCallback(async (action: AddActionType) => {
    if (action === 'product') {
      const ids = offerProductsPanelRef.current?.getSelectedOfferDetailIds?.() ?? [];
      const requestedId = offerProductsPanelRef.current?.getSelectedRequestedOfferDetailId?.() ?? null;
      setSavedSelectionIds(ids);
      setInitialRequestedRowId(requestedId);
      setInitialProductsViewportScrollTop(
        offerProductsPanelRef.current?.getViewportScrollTop?.() ?? 0,
      );
      const page = pageRef.current;
      pendingPageScrollRestoreRef.current = {
        pageScrollTop: page?.scrollTop ?? 0,
        windowScrollY: typeof window !== 'undefined' ? window.scrollY : 0,
      };
      if (requestedId != null) {
        setTableLayout('wReq');
      }
      setShowAddProductModal(true);
      return;
    }
    if (pendingAction) {
      return;
    }
    const nextIndex = (creationCountersRef.current[action] ?? 0) + 1;
    const baseLabel = addActionDescriptionLabels[action] ?? 'New Entry';
    const description = `${baseLabel} (${nextIndex})`;
    const insertionAnchor = offerProductsPanelRef.current?.getAddInsertionAnchor?.() ?? null;
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
      let payload: { ok?: boolean; error?: string; created?: { OfferDetailID?: number | string | null } | null } | null = null;
      try {
        payload = (await res.json()) as {
          ok?: boolean;
          error?: string;
          created?: { OfferDetailID?: number | string | null } | null;
        } | null;
      } catch {
        payload = null;
      }
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to add row (status ${res.status})`);
      }
      const createdIdRaw = payload.created?.OfferDetailID ?? null;
      const createdId = typeof createdIdRaw === 'number'
        ? (Number.isFinite(createdIdRaw) ? Math.trunc(createdIdRaw) : null)
        : typeof createdIdRaw === 'string'
          ? (() => {
              const parsed = Number.parseInt(createdIdRaw.trim(), 10);
              return Number.isFinite(parsed) ? parsed : null;
            })()
          : null;
      if (insertionAnchor && createdId != null) {
        const reorderRes = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'reorder',
            sourceId: createdId,
            position: 'after',
            beforeId: insertionAnchor.offerDetailId,
            parentPath: insertionAnchor.parentPath,
          }),
        });
        const reorderPayload = (await reorderRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!reorderRes.ok || !reorderPayload?.ok) {
          showToastMessage(
            `${baseLabel} was added, but could not be positioned below the selected row.`,
            'error',
          );
        }
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

  useEffect(() => {
    if (!showAddProductModal) return;
    const snapshot = pendingPageScrollRestoreRef.current;
    if (!snapshot) return;
    pendingPageScrollRestoreRef.current = null;
    const restore = () => {
      const page = pageRef.current;
      if (page) {
        page.scrollTop = snapshot.pageScrollTop;
      }
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: snapshot.windowScrollY, behavior: 'auto' });
      }
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(restore);
    });
    const t1 = window.setTimeout(restore, 40);
    const t2 = window.setTimeout(restore, 120);
    const t3 = window.setTimeout(restore, 280);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
    };
  }, [showAddProductModal]);

  useEffect(() => {
    if (!showAddProductModal) return;
    if (initialProductsViewportScrollTop == null) return;
    const restoreGridViewport = () => {
      const host = splitLeftRef.current;
      if (!host) return;
      const viewport = host.querySelector<HTMLElement>('.ag-body-viewport, .ag-center-cols-viewport');
      if (!viewport) return;
      viewport.scrollTop = initialProductsViewportScrollTop;
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(restoreGridViewport);
    });
    const t1 = window.setTimeout(restoreGridViewport, 50);
    const t2 = window.setTimeout(restoreGridViewport, 140);
    const t3 = window.setTimeout(restoreGridViewport, 280);
    const t4 = window.setTimeout(restoreGridViewport, 520);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.clearTimeout(t4);
    };
  }, [initialProductsViewportScrollTop, showAddProductModal]);

  const manualToggleClass = manualMode
    ? `${toolbarStyles.manualToggle} ${toolbarStyles.manualToggleActive} page-header-button`
    : `${toolbarStyles.manualToggle} page-header-button`;

  const pivotToggleClass = pivotView
    ? `${toolbarStyles.pivotToggle} ${toolbarStyles.pivotToggleActive} page-header-button`
    : `${toolbarStyles.pivotToggle} page-header-button`;

  const handleProductsAdded = useCallback((count: number) => {
    void count;
    setRefreshToken((prev) => prev + 1);
  }, []);
  const handleGetAddInsertionAnchor = useCallback(
    () => offerProductsPanelRef.current?.getAddInsertionAnchor?.() ?? null,
    [],
  );

  const handleCloseModal = useCallback(() => setShowAddProductModal(false), []);
  const handleCloseRequestedModal = useCallback(() => setShowRequestedModal(false), []);
  const handleOpenAddProductForm = useCallback(() => setShowAddProductFormModal(true), []);
  const handleCloseAddProductForm = useCallback(() => setShowAddProductFormModal(false), []);
  const handleClearNewProductId = useCallback(() => setNewProductId(null), []);
  const handleRequestedImported = useCallback((result: { inserted?: number; updated?: number; total?: number }) => {
    void result;
    setTableLayout('wReq');
    setRefreshToken((prev) => prev + 1);
  }, []);
  const showRequestedColumns = tableLayout === 'wReq';
  const headerRowTopClassName = pivotView
    ? undefined
    : showAddProductModal
      ? `${pageHeaderStyles.headerRowTop} ${toolbarStyles.compactHeaderRow}`
      : pageHeaderStyles.headerRowTop;
  const headerRowBottomClassName = showAddProductModal
    ? `${pageHeaderStyles.headerRowBottom} ${toolbarStyles.compactHeaderRow}`
    : pageHeaderStyles.headerRowBottom;
  const headingClassName = pivotView ? undefined : pageHeaderStyles.topTitle;
  const updatePricesEndpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products/update-prices`,
    [offerId],
  );

  const handleUpdatePrices = useCallback(async () => {
    if (isUpdatingPrices) return;
    const selectedOfferDetailIds = offerProductsPanelRef.current?.getSelectedOfferDetailIdsForPriceUpdate?.() ?? [];
    setIsUpdatingPrices(true);
    try {
      const response = await fetch(updatePricesEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerDetailIds: selectedOfferDetailIds }),
      });
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
      const message = err instanceof Error
        ? err.message
        : 'Unable to update product prices. Please try again.';
      showToastMessage(message, 'error');
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

  const handleOpenExportModal = useCallback(() => {
    setShowExportModal(true);
  }, []);

  const handleCloseExportModal = useCallback(() => {
    setShowExportModal(false);
  }, []);

  const handleRequestTemplateExportRows = useCallback(async () => {
    const panel = offerProductsPanelRef.current;
    if (!panel) {
      throw new Error('Products grid is not ready yet.');
    }
    return panel.getTemplateExportRows();
  }, []);

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
          <button
            type="button"
            className={`${toolbarStyles.button} ${toolbarStyles.buttonExport} page-header-button`}
            onClick={handleOpenExportModal}
          >
            Export
          </button>
        </>
      )}
      <button
        type="button"
        className={pivotToggleClass}
        onClick={() => setPivotView((prev) => !prev)}
      >
        Pivot Mode
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
      <option value="brand">Layout: Brand</option>
      <option value="category">Layout: Category</option>
    </select>
  ) : null;

  const topLeftActions = (
    <div className={toolbarStyles.leftColumn}>
      <Link href="/offers" className={`${layoutStyles.backLink} page-header-button`}>
        <span aria-hidden="true">←</span>
        Back to offers
      </Link>
      {pivotLayoutSelect}
    </div>
  );

  const contentArea = (
    <div className={toolbarStyles.contentArea}>
      {pivotView ? (
        <OfferProductsPivotPanel
          offerId={offerId}
          refreshToken={refreshToken}
          layout={pivotLayout}
          onExitPivot={() => setPivotView(false)}
        />
      ) : (
        <div className={toolbarStyles.splitLayout}>
          <div className={toolbarStyles.splitLeft} ref={splitLeftRef}>
            <OfferProductsPanel
              ref={offerProductsPanelRef}
              offerId={offerId}
              manualMode={manualMode}
              refreshToken={refreshToken}
              showRequestedColumns={showRequestedColumns}
              tableLayout={tableLayout}
              hideTotals={showAddProductModal}
              initialSelectedOfferDetailIds={savedSelectionIds}
              initialViewportScrollTop={initialProductsViewportScrollTop}
            />
          </div>
          {showAddProductModal ? (
            <div className={toolbarStyles.splitRight}>
              <AddProductsModal
                offerId={offerId}
                onAdded={handleProductsAdded}
                onClose={handleCloseModal}
                getInsertionAnchor={handleGetAddInsertionAnchor}
                showRequestedColumns={showRequestedColumns}
                splitViewMode
                refreshToken={refreshToken}
                onRequestAddProduct={handleOpenAddProductForm}
                newProductId={newProductId}
                onClearNewProductId={handleClearNewProductId}
                onRequestPayloadConsumed={handleClearNewProductId}
                initialRequestedRowId={initialRequestedRowId}
                onInitialRequestedRowConsumed={() => setInitialRequestedRowId(null)}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  );

  const panelContent = (
    <>
      {contentArea}
      {showRequestedModal ? (
        <AddRequestedProductsModal
          offerId={offerId}
          onClose={handleCloseRequestedModal}
          onImported={handleRequestedImported}
        />
      ) : null}
      {showExportModal ? (
        <ExportOfferProductsModal
          onClose={handleCloseExportModal}
          onRequestRows={handleRequestTemplateExportRows}
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
    </>
  );

  return (
    <main className={layoutStyles.page} ref={pageRef}>
      <PageHeader
        title={headingText}
        className={headerRowTopClassName}
        headingClassName={headingClassName}
        leftActions={topLeftActions}
        rightActions={headerRightControls}
      >
        <GridQuickSearchProvider>
          {pivotView ? (
            panelContent
          ) : (
            <PageHeader
              title={headingText}
              leftActions={
                <div className={toolbarStyles.leftRequestedRow}>
                  {addRequestedButton}
                  {layoutSelect}
                </div>
              }
              rightActions={addButtonGroup}
              className={headerRowBottomClassName}
              hideTitle
            >
              {panelContent}
            </PageHeader>
          )}
        </GridQuickSearchProvider>
      </PageHeader>
    </main>
  );
}
