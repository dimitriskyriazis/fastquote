'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
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
import AddRequestedProductsModal from './AddRequestedProductsModal';
import ExportOfferProductsModal from './ExportOfferProductsModal';
import AddProductModal from '../../../products/AddProductModal';
import PasteProductsDialog from './PasteProductsDialog';
import LookupModal from '../../../components/LookupModal';
import lookupStyles from '../../../components/LookupModal.module.css';
import { mapRowToClipboardRow, readClipboard } from './productClipboard';

const AddProductsModal = dynamic(() => import('./AddProductsModal'), { ssr: false });
type Props = {
  offerId: string;
  headingText: string;
  headingTopText?: string | null;
  headingBottomText?: string | null;
  isStandardPackage: boolean;
};

type AddActionType = 'product' | 'category' | 'printable-comment' | 'non-printable-comment';
type CreatableActionType = Exclude<AddActionType, 'product'>;
type ProductsTableLayout = 'cust' | 'wCost' | 'wReq';
type PivotLayout = 'category' | 'brand';
type StandardPackageOption = {
  id: number;
  description: string;
  version: number | null;
};

const LAYOUT_STORAGE_PREFIX = 'fastquote-offer-products-layout';
const MAX_CATEGORY_DEPTH = 3;

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

const addPrimaryButtons: Array<{ key: 'product' | 'category'; label: string }> = [
  { key: 'product', label: addActionLabels.product },
  { key: 'category', label: addActionLabels.category },
];

const addCommentOptions: Array<{ key: 'printable-comment' | 'non-printable-comment'; label: string }> = [
  { key: 'printable-comment', label: 'Printable' },
  { key: 'non-printable-comment', label: 'Non Printable' },
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

const normalizeBrandList = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
        .filter((entry) => entry.length > 0),
    ),
  );
};

export default function ClientProductsPage({
  offerId,
  headingText,
  headingTopText,
  headingBottomText,
  isStandardPackage,
}: Props) {
  const { userId } = useAuditUser();
  const normalizedHeadingTop = typeof headingTopText === 'string' ? headingTopText.trim() : '';
  const normalizedHeadingBottom = typeof headingBottomText === 'string' ? headingBottomText.trim() : '';
  const hasStackedHeading = !isStandardPackage && (normalizedHeadingTop.length > 0 || normalizedHeadingBottom.length > 0);
  const primaryHeadingLine = normalizedHeadingTop || headingText.replace(/ - Products$/i, '').trim();
  const secondaryHeadingLine = normalizedHeadingBottom || headingText.replace(/ - Products$/i, '').trim();

  const headingNode = hasStackedHeading
    ? (
      <span className={toolbarStyles.offerHeadingStack}>
        <span className={toolbarStyles.offerHeadingTop}>{primaryHeadingLine}</span>
        <span className={toolbarStyles.offerHeadingBottom}>{secondaryHeadingLine}</span>
      </span>
    )
    : headingText;

  useEffect(() => {
    if (isStandardPackage) return;
    const recentLabel = normalizedHeadingTop && normalizedHeadingBottom
      ? `${normalizedHeadingTop} - ${normalizedHeadingBottom}`
      : headingText;
    void addRecentOffer({
      id: offerId,
      label: recentLabel,
      customerName: normalizedHeadingTop || null,
      description: secondaryHeadingLine || null,
      title: secondaryHeadingLine || null,
    });
  }, [
    offerId,
    headingText,
    isStandardPackage,
    normalizedHeadingTop,
    normalizedHeadingBottom,
    secondaryHeadingLine,
  ]);

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
  const [showPasteDialog, setShowPasteDialog] = useState(false);
  const [pasteAnchor, setPasteAnchor] = useState<{ offerDetailId: number; treeOrdering: string } | null>(null);
  const [showAddStandardPackageModal, setShowAddStandardPackageModal] = useState(false);
  const [addStandardPackageAnchor, setAddStandardPackageAnchor] = useState<{ offerDetailId: number; treeOrdering: string } | null>(null);
  const [standardPackageOptions, setStandardPackageOptions] = useState<StandardPackageOption[]>([]);
  const [selectedStandardPackageId, setSelectedStandardPackageId] = useState<string>('');
  const [loadingStandardPackageOptions, setLoadingStandardPackageOptions] = useState(false);
  const [addingStandardPackage, setAddingStandardPackage] = useState(false);
  const [addStandardPackageError, setAddStandardPackageError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!isStandardPackage) return;
    setPivotView(false);
  }, [isStandardPackage]);

  useEffect(() => {
    if (!showAddStandardPackageModal) {
      setAddStandardPackageError(null);
      return;
    }
    let cancelled = false;
    const loadOptions = async () => {
      setLoadingStandardPackageOptions(true);
      setAddStandardPackageError(null);
      try {
        const response = await fetch('/api/standard-packages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request: {
              startRow: 0,
              endRow: 2000,
              sortModel: [
                { colId: 'Description', sort: 'asc' },
                { colId: 'OfferVersion', sort: 'desc' },
              ],
            },
            includeAllVersions: false,
          }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; rows?: Array<Record<string, unknown>>; error?: string }
          | null;
        if (!response.ok || !payload?.ok) {
          throw new Error(payload?.error ?? 'Unable to load standard packages.');
        }
        if (cancelled) return;
        const options = (payload.rows ?? [])
          .map((row) => {
            const idRaw = row.ID ?? row.offerId ?? null;
            const id = typeof idRaw === 'number'
              ? idRaw
              : typeof idRaw === 'string'
                ? Number.parseInt(idRaw.trim(), 10)
                : Number.NaN;
            if (!Number.isInteger(id) || id <= 0) return null;
            const description = typeof row.Description === 'string'
              ? row.Description.trim()
              : '';
            const versionRaw = row.OfferVersion ?? null;
            const version = typeof versionRaw === 'number'
              ? versionRaw
              : typeof versionRaw === 'string'
                ? Number.parseInt(versionRaw.trim(), 10)
                : null;
            return {
              id,
              description: description || `Standard package ${id}`,
              version: Number.isInteger(version) ? version : null,
            } satisfies StandardPackageOption;
          })
          .filter((option): option is StandardPackageOption => option != null);
        setStandardPackageOptions(options);
        setSelectedStandardPackageId((current) => {
          if (current && options.some((entry) => String(entry.id) === current)) return current;
          return options[0] ? String(options[0].id) : '';
        });
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load standard package options', err);
        setStandardPackageOptions([]);
        setSelectedStandardPackageId('');
        setAddStandardPackageError(err instanceof Error ? err.message : 'Unable to load standard packages.');
      } finally {
        if (!cancelled) {
          setLoadingStandardPackageOptions(false);
        }
      }
    };
    void loadOptions();
    return () => {
      cancelled = true;
    };
  }, [showAddStandardPackageModal]);

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
    if (action === 'category') {
      const nextCategoryDepth = (insertionAnchor?.parentPath.length ?? 0) + 1;
      if (nextCategoryDepth > MAX_CATEGORY_DEPTH) {
        showToastMessage('You can only create categories up to sub-sub category level.', 'error');
        return;
      }
    }
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
  const headerRowTopClassName = showAddProductModal
    ? `${pageHeaderStyles.headerRowTop} ${toolbarStyles.compactHeaderRow}`
    : `${pageHeaderStyles.headerRowTop} ${toolbarStyles.offerHeaderTopRow}`.trim();
  const headerRowBottomClassName = showAddProductModal
    ? `${pageHeaderStyles.headerRowBottom} ${toolbarStyles.compactHeaderRow}`
    : isStandardPackage
      ? `${pageHeaderStyles.headerRowBottom} ${toolbarStyles.standardPackageSpacerRow}`.trim()
      : `${pageHeaderStyles.headerRowBottom} ${toolbarStyles.offerHeaderBottomRow}`.trim();
  const headingClassName = `${pageHeaderStyles.topTitle} ${
    hasStackedHeading
      ? toolbarStyles.offerStackedTopTitle
      : isStandardPackage
        ? toolbarStyles.standardPackageTopTitle
        : ''
  }`.trim();
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
        | { ok?: boolean; error?: string; updated?: number; updatedBrands?: unknown; failedBrands?: unknown }
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Unable to update prices (status ${response.status})`);
      }
      const updatedCount = typeof payload?.updated === 'number' ? payload.updated : null;
      const updatedBrands = normalizeBrandList(payload?.updatedBrands);
      const failedBrands = normalizeBrandList(payload?.failedBrands);

      if (updatedBrands.length > 0) {
        showToastMessage(`Prices updated for brands: ${updatedBrands.join(', ')}`, 'success', 9000);
      } else if (updatedCount == null || updatedCount > 0) {
        const message = updatedCount == null
          ? 'Updated offer prices'
          : `Updated prices for ${updatedCount} product${updatedCount === 1 ? '' : 's'}`;
        showToastMessage(message, 'success', 9000);
      }
      if (failedBrands.length > 0) {
        showToastMessage(`Couldn't update prices for brands: ${failedBrands.join(', ')}`, 'error', 9000);
      }

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

  const handleRequestPaste = useCallback((anchorOfferDetailId: number | null, anchorTreeOrdering: string | null) => {
    if (anchorOfferDetailId != null && anchorTreeOrdering) {
      setPasteAnchor({ offerDetailId: anchorOfferDetailId, treeOrdering: anchorTreeOrdering });
    } else {
      setPasteAnchor(null);
    }
    setShowPasteDialog(true);
  }, []);

  const handleRequestAddStandardPackage = useCallback((anchorOfferDetailId: number, anchorTreeOrdering: string) => {
    setAddStandardPackageAnchor({ offerDetailId: anchorOfferDetailId, treeOrdering: anchorTreeOrdering });
    setShowAddStandardPackageModal(true);
    setAddStandardPackageError(null);
  }, []);

  const handleConfirmAddStandardPackage = useCallback(async () => {
    const sourcePackageId = Number.parseInt(selectedStandardPackageId, 10);
    if (!Number.isInteger(sourcePackageId) || sourcePackageId <= 0) {
      setAddStandardPackageError('Select a standard package first.');
      return;
    }
    if (!addStandardPackageAnchor?.offerDetailId) {
      setAddStandardPackageError('Missing insertion anchor.');
      return;
    }

    setAddingStandardPackage(true);
    setAddStandardPackageError(null);
    try {
      const sourceRowsResponse = await fetch(
        `/api/offers/${encodeURIComponent(String(sourcePackageId))}/products`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request: {
              allRows: true,
              startRow: 0,
              endRow: 5000,
              view: 'grid',
              sortModel: [{ colId: 'TreeOrdering', sort: 'asc' }],
            },
            fields: [
              'OfferDetailID',
              'ProductID',
              'IsCategory',
              'IsComment',
              'IsPrintable',
              'TreeOrdering',
              'BrandName',
              'PartNumber',
              'ModelNumber',
              'Description',
              'ProductDescription',
              'Quantity',
              'NetUnitPrice',
              'ListPrice',
              'CustomerDiscount',
              'TelmacoDiscount',
              'NetCost',
              'NetCostOtherCurrency',
              'Margin',
              'GrossProfit',
              'Comment',
              'Delivery',
              'Warranty',
              'OtherCurrencyID',
              'CurrencyCostModifier',
              'PriceListID',
              'PriceListItemID',
              'RequestedItemNo',
              'RequestedBrand',
              'RequestedPartNo',
              'RequestedModelNo',
              'RequestedWebLink',
              'RequestedDescription',
              'RequestedDescription2',
              'RequestedDescription3',
              'RequestedQuantity',
            ],
          }),
        },
      );
      const sourceRowsPayload = (await sourceRowsResponse.json().catch(() => null)) as
        | { ok?: boolean; rows?: Array<Record<string, unknown>>; error?: string }
        | null;
      if (!sourceRowsResponse.ok || !sourceRowsPayload?.ok) {
        throw new Error(sourceRowsPayload?.error ?? 'Unable to load standard package items.');
      }

      const clipboardRows = (sourceRowsPayload.rows ?? [])
        .map((row) => mapRowToClipboardRow(row))
        .filter((row) => typeof row.treeOrdering === 'string' && row.treeOrdering.trim().length > 0);
      if (clipboardRows.length === 0) {
        throw new Error('Selected standard package has no rows to insert.');
      }

      const pasteResponse = await fetch(
        `/api/offers/${encodeURIComponent(offerId)}/products/paste`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: clipboardRows,
            keepPricing: true,
            anchorOfferDetailId: addStandardPackageAnchor.offerDetailId,
          }),
        },
      );
      const pastePayload = (await pasteResponse.json().catch(() => null)) as
        | { ok?: boolean; inserted?: number; error?: string }
        | null;
      if (!pasteResponse.ok || !pastePayload?.ok) {
        throw new Error(pastePayload?.error ?? 'Unable to add standard package.');
      }
      const insertedCount = typeof pastePayload.inserted === 'number'
        ? pastePayload.inserted
        : clipboardRows.length;
      showToastMessage(`Added standard package (${insertedCount} row(s)).`, 'success');
      setShowAddStandardPackageModal(false);
      setAddStandardPackageAnchor(null);
      setRefreshToken((prev) => prev + 1);
    } catch (err) {
      console.error('Failed to add standard package', err);
      setAddStandardPackageError(err instanceof Error ? err.message : 'Unable to add standard package.');
    } finally {
      setAddingStandardPackage(false);
    }
  }, [addStandardPackageAnchor, offerId, selectedStandardPackageId]);

  const handlePasteProducts = useCallback(async (keepPricing: boolean) => {
    const clipboard = readClipboard();
    if (!clipboard || clipboard.rows.length === 0) {
      showToastMessage('Clipboard is empty or expired.', 'error');
      setShowPasteDialog(false);
      return;
    }
    setShowPasteDialog(false);
    try {
      const response = await fetch(
        `/api/offers/${encodeURIComponent(offerId)}/products/paste`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: clipboard.rows,
            keepPricing,
            sourceOfferId: clipboard.sourceOfferId,
            anchorOfferDetailId: pasteAnchor?.offerDetailId ?? null,
          }),
        },
      );
      const payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; inserted?: number }
        | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? 'Failed to paste products');
      }
      const insertedCount = typeof payload.inserted === 'number' ? payload.inserted : clipboard.rows.length;
      showToastMessage(
        `Pasted ${insertedCount} row(s) into this offer.`,
        'success',
      );
      setRefreshToken((prev) => prev + 1);
    } catch (err) {
      console.error('Paste failed', err);
      showToastMessage(
        err instanceof Error ? err.message : 'Unable to paste rows.',
        'error',
      );
    } finally {
      setPasteAnchor(null);
    }
  }, [offerId, pasteAnchor]);

  const headerRightControls = (
    <div className={toolbarStyles.topControls}>
      {pivotView || isStandardPackage ? null : (
        <>
          <button
            type="button"
            className={`${toolbarStyles.button} ${toolbarStyles.buttonPopulateOffer} page-header-button`}
            onClick={handlePopulateOffer}
            disabled={isPopulatingOffer}
          >
            {isPopulatingOffer ? 'Populating...' : 'Populate Offer'}
          </button>
          <button
            type="button"
            className={`${toolbarStyles.button} ${toolbarStyles.buttonUpdatePrices} page-header-button`}
            onClick={handleUpdatePrices}
            disabled={isUpdatingPrices}
          >
            {isUpdatingPrices ? 'Updating prices...' : 'Update Prices'}
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
      {isStandardPackage ? null : (
        <Link
          href={`/offers/${encodeURIComponent(offerId)}/basicdata`}
          className={`${layoutStyles.headerActionButton} page-header-button`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View Basic Data
        </Link>
      )}
    </div>
  );

  const addButtonGroup = (
    <div className={toolbarStyles.addButtons}>
      {addPrimaryButtons.map((action) => {
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
      <details className={toolbarStyles.commentDropdown}>
        <summary
          className={`${toolbarStyles.button} ${toolbarStyles.buttonComment} page-header-button`}
          aria-label="Add comment"
        >
          Add Comment
        </summary>
        <div className={toolbarStyles.commentMenu} role="menu" aria-label="Add comment options">
          {addCommentOptions.map((option) => (
            <button
              type="button"
              key={option.key}
              className={
                option.key === 'non-printable-comment'
                  ? `${toolbarStyles.commentMenuItem} ${toolbarStyles.commentMenuItemNonPrintable}`
                  : `${toolbarStyles.commentMenuItem} ${toolbarStyles.commentMenuItemPrintable}`
              }
              onClick={(event) => {
                event.currentTarget.closest('details')?.removeAttribute('open');
                void handleAddAction(option.key);
              }}
              disabled={pendingAction != null}
              role="menuitem"
            >
              {option.label}
            </button>
          ))}
        </div>
      </details>
    </div>
  );

  const topRightActions = isStandardPackage && !pivotView
    ? addButtonGroup
    : headerRightControls;

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
  const pivotToggleButton = isStandardPackage ? null : (
    <button
      type="button"
      className={pivotToggleClass}
      onClick={() => setPivotView((prev) => !prev)}
    >
      Pivot Mode
    </button>
  );

  const topLeftActions = (
    <div className={toolbarStyles.leftColumn}>
      <Link
        href={isStandardPackage ? '/standard-packages' : '/offers'}
        className={`${layoutStyles.backLink} page-header-button`}
      >
        <span aria-hidden="true">&larr;</span>
        {isStandardPackage ? 'Back to standard packages' : 'Back to offers'}
      </Link>
      {pivotView ? null : (
        <button
          type="button"
          className={manualToggleClass}
          onClick={() => setManualMode((prev) => !prev)}
        >
          Manual Mode
        </button>
      )}
    </div>
  );

  const secondaryHeaderLeftActions = isStandardPackage ? (
    <div className={toolbarStyles.leftRequestedRow} />
  ) : (
    <div className={toolbarStyles.leftRequestedRow}>
      {addRequestedButton}
      {layoutSelect}
      {pivotToggleButton}
    </div>
  );
  const pivotSecondaryHeaderLeftActions = (
    <div className={toolbarStyles.leftRequestedRow}>
      {pivotToggleButton}
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
              showRequestedColumns={isStandardPackage ? false : showRequestedColumns}
              standardPackageMode={isStandardPackage}
              tableLayout={tableLayout}
              hideTotals={isStandardPackage || showAddProductModal}
              initialSelectedOfferDetailIds={savedSelectionIds}
              initialViewportScrollTop={initialProductsViewportScrollTop}
              onRequestPaste={handleRequestPaste}
              onRequestAddStandardPackage={handleRequestAddStandardPackage}
            />
          </div>
          {showAddProductModal ? (
            <div className={toolbarStyles.splitRight}>
              <AddProductsModal
                offerId={offerId}
                onAdded={handleProductsAdded}
                onClose={handleCloseModal}
                getInsertionAnchor={handleGetAddInsertionAnchor}
                standardPackageMode={isStandardPackage}
                showRequestedColumns={isStandardPackage ? false : showRequestedColumns}
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
      {showPasteDialog ? (
        <PasteProductsDialog
          onConfirm={handlePasteProducts}
          onCancel={() => {
            setShowPasteDialog(false);
            setPasteAnchor(null);
          }}
        />
      ) : null}
      <LookupModal
        open={showAddStandardPackageModal}
        title="Add Standard Package"
        onClose={() => {
          if (addingStandardPackage) return;
          setShowAddStandardPackageModal(false);
          setAddStandardPackageAnchor(null);
          setAddStandardPackageError(null);
        }}
        onConfirm={() => {
          void handleConfirmAddStandardPackage();
        }}
        confirmLabel="Add"
        saving={addingStandardPackage}
        error={addStandardPackageError}
      >
        <div className={lookupStyles.fieldGrid}>
          <div className={lookupStyles.fieldFull}>
            <label className={lookupStyles.fieldLabel} htmlFor="standard-package-selector">
              Standard Package
            </label>
            <select
              id="standard-package-selector"
              className={lookupStyles.fieldControl}
              value={selectedStandardPackageId}
              onChange={(event) => {
                setSelectedStandardPackageId(event.target.value);
                setAddStandardPackageError(null);
              }}
              disabled={loadingStandardPackageOptions || addingStandardPackage}
            >
              {loadingStandardPackageOptions ? (
                <option value="">Loading standard packages...</option>
              ) : standardPackageOptions.length === 0 ? (
                <option value="">No standard packages found</option>
              ) : (
                standardPackageOptions.map((entry) => (
                  <option key={entry.id} value={String(entry.id)}>
                    {entry.description}{entry.version != null ? ` (v${entry.version})` : ''} [ID {entry.id}]
                  </option>
                ))
              )}
            </select>
          </div>
        </div>
      </LookupModal>
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
        title={headingNode}
        className={headerRowTopClassName}
        headingClassName={headingClassName}
        leftActions={topLeftActions}
        rightActions={topRightActions}
      >
        <GridQuickSearchProvider>
          {pivotView ? (
            <PageHeader
              title={headingNode}
              leftActions={pivotSecondaryHeaderLeftActions}
              className={headerRowBottomClassName}
              hideTitle
            >
              {panelContent}
            </PageHeader>
          ) : (
            <PageHeader
              title={headingNode}
              leftActions={secondaryHeaderLeftActions}
              rightActions={isStandardPackage ? null : addButtonGroup}
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
