'use client';

import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import PageHeader from '../../../components/PageHeader';
import { GridQuickSearchProvider } from '../../../components/GridQuickSearchProvider';
import type { OfferProductsPanelHandle } from '../OfferProductsPanel';

const OfferProductsPanel = dynamic(
  () => import('../OfferProductsPanel'),
  { ssr: false, loading: () => <div style={{ padding: '2rem', opacity: 0.5 }}>Loading products…</div> },
);
import { showToastMessage } from '../../../../lib/toast';
import { showConfirmDialog, showMultiChoiceDialog } from '../../../../lib/confirm';
import { addRecentOffer } from '../../../lib/recentOffers';
import { useAuditUser } from '../../../components/AuditUserProvider';
import layoutStyles from '../../offersDetail.module.css';
import pageHeaderStyles from '../../../components/PageHeader.module.css';
import toolbarStyles from './ClientProductsPage.module.css';
import lookupStyles from '../../../components/LookupModal.module.css';
import { mapRowToClipboardRow, readClipboard } from './productClipboard';

const OfferProductsPivotPanel = dynamic(() => import('./OfferProductsPivotPanel'), { ssr: false });
const AddRequestedProductsModal = dynamic(() => import('./AddRequestedProductsModal'), { ssr: false });
const AddProductModal = dynamic(() => import('../../../products/AddProductModal'), { ssr: false });
const AddProductsModal = dynamic(() => import('./AddProductsModal'), { ssr: false });
const PasteProductsDialog = dynamic(() => import('./PasteProductsDialog'), { ssr: false });
const LookupModal = dynamic(() => import('../../../components/LookupModal'), { ssr: false });

type Props = {
  offerId: string;
  headingText: string;
  headingTopText?: string | null;
  headingBottomText?: string | null;
  isStandardPackage: boolean;
  offerCreatedByUserId?: string | null;
  pricingPolicyName?: string | null;
  initialPricingHoldMarginOnCost?: boolean;
  initialExtraNetDiscount?: number | null;
  initialExtraNetDiscountMode?: 'pct' | 'abs';
  isReadOnly?: boolean;
};

type AddActionType = 'product' | 'category' | 'printable-comment' | 'non-printable-comment' | 'printable-service' | 'non-printable-service';
type CreatableActionType = Exclude<AddActionType, 'product'>;
type ProductsTableLayout = 'cust' | 'wCost' | 'wReq';
type PivotLayout = 'category' | 'brand' | 'brandPartNo';
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
  'printable-service': 'Add Printable Service',
  'non-printable-service': 'Add Non Printable Service',
};

const addActionDescriptionLabels: Record<CreatableActionType, string> = {
  category: 'New Category',
  'printable-comment': 'New Printable Comment',
  'non-printable-comment': 'New Non Printable Comment',
  'printable-service': 'New Printable Service',
  'non-printable-service': 'New Non Printable Service',
};

const addPrimaryButtons: Array<{ key: 'product' | 'category'; label: string }> = [
  { key: 'product', label: addActionLabels.product },
  { key: 'category', label: addActionLabels.category },
];

const addCommentOptions: Array<{ key: 'printable-comment' | 'non-printable-comment'; label: string }> = [
  { key: 'printable-comment', label: 'Printable' },
  { key: 'non-printable-comment', label: 'Non Printable' },
];

const addServiceOptions: Array<{ key: 'printable-service' | 'non-printable-service'; label: string }> = [
  { key: 'printable-service', label: 'Printable' },
  { key: 'non-printable-service', label: 'Non Printable' },
];

const buttonVariantClass: Record<AddActionType, string> = {
  product: toolbarStyles.buttonProduct,
  category: toolbarStyles.buttonCategory,
  'printable-comment': toolbarStyles.buttonPrintableComment,
  'non-printable-comment': toolbarStyles.buttonNonPrintableComment,
  'printable-service': toolbarStyles.buttonService,
  'non-printable-service': toolbarStyles.buttonService,
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
  offerCreatedByUserId,
  pricingPolicyName,
  initialPricingHoldMarginOnCost = false,
  initialExtraNetDiscount = null,
  initialExtraNetDiscountMode = 'pct',
  isReadOnly = false,
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
  const [collapseAllCategories, setCollapseAllCategories] = useState(false);
  const [startingItemNo, setStartingItemNo] = useState<number>(1);
  const [startingItemNoInput, setStartingItemNoInput] = useState<string>('1');
  const [startingItemNoApplying, setStartingItemNoApplying] = useState(false);
  const [pendingAction, setPendingAction] = useState<CreatableActionType | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [isUpdatingPrices, setIsUpdatingPrices] = useState(false);
  const [isPopulatingOffer, setIsPopulatingOffer] = useState(false);
  const [isUpdatingProductData, setIsUpdatingProductData] = useState(false);
  const [showAddProductModal, setShowAddProductModal] = useState(false);
  const [showAddServiceModal, setShowAddServiceModal] = useState(false);
  const [addServiceIsPrintable, setAddServiceIsPrintable] = useState(true);
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
  const [undoState, setUndoState] = useState<{ canUndo: boolean; lastLabel: string | undefined }>({ canUndo: false, lastLabel: undefined });
  const [pricingHoldMarginOnCost, setPricingHoldMarginOnCost] = useState(initialPricingHoldMarginOnCost);
  // Offer-level "additional discount" applied on top of the Net total. Persisted on
  // the offer; surfaced as its own line in the totals bar and the generated PDF.
  const [extraNetDiscount, setExtraNetDiscount] = useState<number | null>(initialExtraNetDiscount);
  const [extraNetDiscountMode, setExtraNetDiscountMode] = useState<'pct' | 'abs'>(initialExtraNetDiscountMode);
  const saveExtraDiscounts = useCallback(async (next: {
    netValue: number | null;
    netMode: 'pct' | 'abs';
  }) => {
    setExtraNetDiscount(next.netValue);
    setExtraNetDiscountMode(next.netMode);
    // Let failures propagate so the panel can surface them via a toast.
    const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/basicdata`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        updates: [
          { field: 'ExtraNetDiscount', value: next.netValue },
          { field: 'ExtraNetDiscountMode', value: next.netMode },
        ],
      }),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = typeof body?.error === 'string' ? `: ${body.error}` : '';
      } catch { /* ignore */ }
      throw new Error(`Save failed (${res.status})${detail}`);
    }
  }, [offerId]);
  const [pricingMenuOpen, setPricingMenuOpen] = useState(false);
  const pricingMenuRef = useRef<HTMLDetailsElement | null>(null);
  const savePricingMode = useCallback(async (holdMargin: boolean) => {
    try {
      await fetch(`/api/offers/${encodeURIComponent(offerId)}/basicdata`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: [
            { field: 'PricingHoldMarginOnCost', value: holdMargin ? 1 : 0 },
          ],
        }),
      });
    } catch (err) {
      console.error('Failed to save pricing mode', err);
    }
  }, [offerId]);
  const [placementAnchor, setPlacementAnchor] = useState<{ label: string; treeOrdering: string; isRequested: boolean; offerDetailId?: number; parentPath?: number[]; requestedBrand?: string | null; requestedPartNo?: string | null; requestedModelNo?: string | null; requestedDescription?: string | null } | null>(null);
  const [defaultPlacementMode, setDefaultPlacementMode] = useState<'fill' | 'below'>('fill');
  const offerProductsPanelRef = useRef<OfferProductsPanelHandle | null>(null);
  const showAddProductModalRef = useRef(showAddProductModal);
  showAddProductModalRef.current = showAddProductModal;
  const [detachedWindowOpen, setDetachedWindowOpen] = useState(false);
  const detachedWindowRef = useRef<Window | null>(null);
  const detachedWindowOpenRef = useRef(false);
  detachedWindowOpenRef.current = detachedWindowOpen;
  const splitLeftRef = useRef<HTMLDivElement | null>(null);
  const layoutStorageKey = useMemo(() => buildLayoutStorageKey(userId), [userId]);
  const layoutStorageKeyRef = useRef(layoutStorageKey);
  layoutStorageKeyRef.current = layoutStorageKey;
  const creationCountersRef = useRef<Record<CreatableActionType, number>>({
    category: 0,
    'printable-comment': 0,
    'non-printable-comment': 0,
    'printable-service': 0,
    'non-printable-service': 0,
  });

  useEffect(() => {
    if (!layoutStorageKey) return;
    const persisted = readPersistedLayout(layoutStorageKey);
    if (persisted) {
      setTableLayout((current) => (current === persisted ? current : persisted));
    }
  }, [layoutStorageKey]);

  // Persist the layout ONLY on explicit user changes (via changeTableLayout),
  // never from the load effect above. The previous save-in-effect approach
  // raced the async layout load (userId from useAuditUser resolves after mount)
  // and overwrote the stored value with the default 'wReq' on mount — notably
  // under React StrictMode's double-invoked dev effects — so the user's choice
  // never survived a refresh.
  const changeTableLayout = useCallback((next: ProductsTableLayout) => {
    setTableLayout(next);
    const key = layoutStorageKeyRef.current;
    if (typeof window === 'undefined' || !key) return;
    try {
      window.localStorage.setItem(key, next);
    } catch {
      /* noop */
    }
  }, []);

  const [initialRequestedRowId, setInitialRequestedRowId] = useState<number | null>(null);
  const pageRef = useRef<HTMLElement | null>(null);
  const pendingPageScrollRestoreRef = useRef<{ pageScrollTop: number; windowScrollY: number } | null>(null);
  const forceReapplyRequestedColumnsVisibility = useCallback(() => {
    offerProductsPanelRef.current?.forceReapplyRequestedColumnsVisibility?.();
  }, []);

  const startingItemNoCommitInFlightRef = useRef(false);
  const commitStartingItemNo = useCallback(async () => {
    if (startingItemNoCommitInFlightRef.current) return;
    const parsed = Number.parseInt(startingItemNoInput.trim(), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      showToastMessage('Starting Item No must be a whole number ≥ 1.', 'error');
      setStartingItemNoInput(String(startingItemNo));
      return;
    }
    if (parsed === startingItemNo) return;
    const handle = offerProductsPanelRef.current;
    if (!handle?.applyStartingItemNoShift) return;
    startingItemNoCommitInFlightRef.current = true;
    try {
      const delta = parsed - startingItemNo;
      const confirmed = await showConfirmDialog({
        title: 'Shift all Item Numbers?',
        message: `This will change the starting Item No from ${startingItemNo} to ${parsed} (${delta > 0 ? '+' : ''}${delta}). Every root row and its descendants will be renumbered.`,
        confirmLabel: 'Shift',
        cancelLabel: 'Cancel',
        tone: 'danger',
      });
      if (!confirmed) {
        setStartingItemNoInput(String(startingItemNo));
        return;
      }
      setStartingItemNoApplying(true);
      try {
        const result = await handle.applyStartingItemNoShift(parsed);
        if (result.ok) {
          setStartingItemNo(parsed);
          setStartingItemNoInput(String(parsed));
          setRefreshToken((prev) => prev + 1);
        } else {
          setStartingItemNoInput(String(startingItemNo));
        }
      } finally {
        setStartingItemNoApplying(false);
      }
    } finally {
      startingItemNoCommitInFlightRef.current = false;
    }
  }, [startingItemNo, startingItemNoInput]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      forceReapplyRequestedColumnsVisibility();
      return undefined;
    }
    const run = () => {
      forceReapplyRequestedColumnsVisibility();
    };
    const rafId = window.requestAnimationFrame(() => {
      run();
      window.requestAnimationFrame(run);
    });
    const timeoutId = window.setTimeout(run, 120);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [
    forceReapplyRequestedColumnsVisibility,
    showAddProductModal,
    showRequestedModal,
    tableLayout,
  ]);

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
      const ids = await offerProductsPanelRef.current?.getSelectedOfferDetailIds?.() ?? [];
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
        changeTableLayout('wReq');
      }
      setShowAddServiceModal(false);
      setShowAddProductModal(true);
      // If no row is selected, show insertion line at end after layout settles
      const anchor = offerProductsPanelRef.current?.getAddInsertionAnchor?.() ?? null;
      if (!anchor) {
        const show = () => offerProductsPanelRef.current?.setInsertLineVisible?.(true, true);
        setTimeout(show, 300);
        setTimeout(show, 700);
      }
      return;
    }
    if (action === 'printable-service' || action === 'non-printable-service') {
      setAddServiceIsPrintable(action === 'printable-service');
      setShowAddProductModal(false);
      setShowAddServiceModal(true);
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
      if (createdId != null) {
        const undoId = createdId;
        offerProductsPanelRef.current?.pushUndo?.({
          label: `Add ${baseLabel}`,
          undo: async () => {
            const res = await fetch(endpoint, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ OfferDetailIDs: [undoId] }),
            });
            const payload = (await res.json().catch(() => null)) as { ok?: boolean } | null;
            if (!res.ok || !payload?.ok) throw new Error('Failed to undo add row');
            setRefreshToken((prev) => prev + 1);
          },
        });
      }
    } catch (err) {
      console.error('Failed to add offer row', err);
      showToastMessage('Unable to add row. Please try again.', 'error');
    } finally {
      setPendingAction(null);
    }
  }, [offerId, pendingAction, changeTableLayout]);

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
    ? `${toolbarStyles.button} ${toolbarStyles.manualToggle} ${toolbarStyles.manualToggleActive} page-header-button`
    : `${toolbarStyles.button} ${toolbarStyles.manualToggle} page-header-button`;

  const pivotToggleClass = pivotView
    ? `${toolbarStyles.button} ${toolbarStyles.pivotToggle} ${toolbarStyles.pivotToggleActive} page-header-button`
    : `${toolbarStyles.button} ${toolbarStyles.pivotToggle} page-header-button`;

  const collapseAllToggleClass = collapseAllCategories
    ? `${toolbarStyles.button} ${toolbarStyles.collapseAllToggle} ${toolbarStyles.collapseAllToggleActive} page-header-button`
    : `${toolbarStyles.button} ${toolbarStyles.collapseAllToggle} page-header-button`;

  const handleProductsAdded = useCallback((count: number, insertedOfferDetailIds?: number[]) => {
    // Capture before clearing — a placement anchor means the server resequenced
    // the new row to land below the anchor. The optimistic in-place insert
    // below can race with that resequence and briefly show the row at its
    // pre-reorder TreeOrdering (e.g. "11" before "10.6.2"), so we skip it.
    const hadPlacementAnchor = placementAnchor != null;
    // Clear placement selection and deselect rows after adding
    skipSelectionChangeUntilRef.current = Date.now() + 200;
    setPlacementAnchor(null);
    setDefaultPlacementMode('fill');
    offerProductsPanelRef.current?.setInsertLineVisible?.(false);
    offerProductsPanelRef.current?.clearSelectedRowHighlight?.();
    offerProductsPanelRef.current?.deselectAllRows?.();
    // Save scroll positions before refresh
    const pageScrollY = window.scrollY;
    const page = pageRef.current;
    const pageScrollTop = page?.scrollTop ?? 0;
    const gridHost = splitLeftRef.current;
    const gridViewport = gridHost?.querySelector<HTMLElement>('.ag-body-viewport, .ag-center-cols-viewport');
    const gridScrollTop = gridViewport?.scrollTop ?? 0;
    // Set flash IDs BEFORE triggering refresh so handleGridModelUpdated picks them up
    if (insertedOfferDetailIds && insertedOfferDetailIds.length > 0) {
      offerProductsPanelRef.current?.flashRows?.(insertedOfferDetailIds);
    }
    if (insertedOfferDetailIds && insertedOfferDetailIds.length > 0) {
      const ids = [...insertedOfferDetailIds];
      const label = `Add ${count === 1 ? 'Product' : `${count} Products`}`;
      offerProductsPanelRef.current?.pushUndo?.({
        label,
        undo: async () => {
          const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ OfferDetailIDs: ids }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean } | null;
          if (!res.ok || !payload?.ok) throw new Error('Failed to undo add products');
          setRefreshToken((prev) => prev + 1);
        },
      });
    }
    // Fetch the full row data for the newly inserted rows, then splice them
    // into the grid via applyServerSideTransaction. This mirrors the delete
    // flow — no purge, no white flash, and avoids AG Grid's purge:false
    // limitation where row-count deltas aren't picked up until manual refresh.
    // Stack subsequent adds below the just-inserted row: queue a pin that
    // re-anchors the insertion line below the last inserted row once the
    // refresh has rendered it. Without this, the line stays at its old pixel
    // position (e.g. "below 8.6.7") and visually overlaps the new row.
    const lastInsertedId = insertedOfferDetailIds && insertedOfferDetailIds.length > 0
      ? insertedOfferDetailIds[insertedOfferDetailIds.length - 1]
      : null;
    if (lastInsertedId != null && (showAddProductModalRef.current || detachedWindowOpenRef.current)) {
      offerProductsPanelRef.current?.pinInsertLineBelowRowId?.(lastInsertedId, hadPlacementAnchor);
    }
    if (insertedOfferDetailIds && insertedOfferDetailIds.length > 0) {
      if (hadPlacementAnchor) {
        // Placement-anchor add: skip the optimistic in-place insert and rely on
        // a full refresh — the server-side reorder may not yet be visible to a
        // follow-up fetch, which would render the row at its pre-reorder
        // TreeOrdering for a frame before snapping into place.
        setRefreshToken((prev) => prev + 1);
      } else {
        const ids = [...insertedOfferDetailIds];
        void (async () => {
          try {
            const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                request: {
                  allRows: true,
                  filterModel: {
                    OfferDetailID: { filterType: 'set', values: ids },
                  },
                },
              }),
            });
            const payload = (await res.json().catch(() => null)) as { ok?: boolean; rows?: Array<Record<string, unknown>> } | null;
            if (!res.ok || !payload?.ok || !Array.isArray(payload.rows)) return;
            offerProductsPanelRef.current?.applyAddedRows?.(payload.rows);
            // Trigger a background refresh so totals get recomputed from the
            // server. The grid rows themselves are already updated via the
            // transaction above.
            setRefreshToken((prev) => prev + 1);
          } catch (err) {
            console.warn('Failed to fetch new rows for in-place insert', err);
          }
        })();
      }
    }
    // Anchor scroll positions every animation frame for ~500ms. Snapping
    // pre-paint (via rAF) avoids the one-frame flash that scroll-event
    // listeners leave behind (events fire after the browser already painted
    // the scrolled position).
    const startTs = performance.now();
    let rafId = 0;
    const pin = () => {
      if (page && page.scrollTop !== pageScrollTop) page.scrollTop = pageScrollTop;
      if (window.scrollY !== pageScrollY) window.scrollTo({ top: pageScrollY, behavior: 'auto' });
      if (gridViewport && gridViewport.scrollTop !== gridScrollTop) gridViewport.scrollTop = gridScrollTop;
      if (performance.now() - startTs < 500) {
        rafId = requestAnimationFrame(pin);
      }
    };
    rafId = requestAnimationFrame(pin);
    window.setTimeout(() => cancelAnimationFrame(rafId), 600);
  }, [offerId, placementAnchor]);
  const handleGetAddInsertionAnchor = useCallback(
    () => offerProductsPanelRef.current?.getAddInsertionAnchor?.() ?? null,
    [],
  );

  const skipSelectionChangeUntilRef = useRef(0);

  const postToDetached = useCallback((payload: Record<string, unknown>) => {
    const win = detachedWindowRef.current;
    if (!win || win.closed) return;
    try {
      win.postMessage(payload, window.location.origin);
    } catch {
      /* noop */
    }
  }, []);

  const handleMainGridSelectionChanged = useCallback((selectedRow: { offerDetailId: number; treeOrdering: string; label: string; isRequested: boolean; parentPath: number[]; requestedBrand?: string | null; requestedPartNo?: string | null; requestedModelNo?: string | null; requestedDescription?: string | null } | null) => {
    if (Date.now() < skipSelectionChangeUntilRef.current) {
      return;
    }
    if (selectedRow) {
      const nextAnchor = {
        label: selectedRow.label,
        treeOrdering: selectedRow.treeOrdering,
        isRequested: selectedRow.isRequested,
        offerDetailId: selectedRow.offerDetailId,
        parentPath: selectedRow.parentPath,
        requestedBrand: selectedRow.requestedBrand,
        requestedPartNo: selectedRow.requestedPartNo,
        requestedModelNo: selectedRow.requestedModelNo,
        requestedDescription: selectedRow.requestedDescription,
      };
      setPlacementAnchor(nextAnchor);
      setDefaultPlacementMode('fill');
      offerProductsPanelRef.current?.setInsertLineVisible?.(false);
      if (detachedWindowOpenRef.current) {
        postToDetached({
          type: 'fastquote:detached-add-products:anchor',
          anchor: nextAnchor,
          defaultPlacementMode: 'fill',
          initialRequestedRowId: selectedRow.isRequested ? selectedRow.offerDetailId : null,
        });
        try { detachedWindowRef.current?.focus(); } catch { /* noop */ }
      }
    } else {
      setPlacementAnchor(null);
      // When the add modal is open and no row is selected, show the insertion
      // line below the last row so the user sees where the product will go.
      // Skip if a row-specific pin is pending (from a recent add) — the pin
      // will position the line correctly once the row lands in the DOM.
      if (
        (showAddProductModalRef.current || detachedWindowOpenRef.current) &&
        !offerProductsPanelRef.current?.hasPendingInsertLinePin?.()
      ) {
        offerProductsPanelRef.current?.setInsertLineVisible?.(true, true);
      }
      if (detachedWindowOpenRef.current) {
        postToDetached({
          type: 'fastquote:detached-add-products:anchor',
          anchor: null,
          defaultPlacementMode: 'fill',
          initialRequestedRowId: null,
        });
      }
    }
  }, [postToDetached]);

  const handleRequestInsertProduct = useCallback((anchor: { offerDetailId: number; parentPath: number[]; label: string; treeOrdering: string; isRequested: boolean }) => {
    skipSelectionChangeUntilRef.current = Date.now() + 200;
    const nextAnchor = { label: anchor.label, treeOrdering: anchor.treeOrdering, isRequested: anchor.isRequested, offerDetailId: anchor.offerDetailId, parentPath: anchor.parentPath };
    setPlacementAnchor(nextAnchor);
    setDefaultPlacementMode('below');
    if (anchor.isRequested) {
      setInitialRequestedRowId(anchor.offerDetailId);
    }
    if (detachedWindowOpenRef.current) {
      postToDetached({
        type: 'fastquote:detached-add-products:anchor',
        anchor: nextAnchor,
        defaultPlacementMode: 'below',
        initialRequestedRowId: anchor.isRequested ? anchor.offerDetailId : null,
      });
      try { detachedWindowRef.current?.focus(); } catch { /* noop */ }
      return;
    }
    setShowAddServiceModal(false);
    setShowAddProductModal(true);
  }, [postToDetached]);

  const handlePlacementModeChange = useCallback((mode: 'fill' | 'below') => {
    if (mode === 'below') {
      skipSelectionChangeUntilRef.current = Date.now() + 200;
      offerProductsPanelRef.current?.deselectAllRows?.();
    }
    offerProductsPanelRef.current?.setInsertLineVisible?.(mode === 'below');
  }, []);

  const handleCloseModal = useCallback(() => {
    setShowAddProductModal(false);
    setPlacementAnchor(null);
    setDefaultPlacementMode('fill');
    offerProductsPanelRef.current?.setInsertLineVisible?.(false);
    offerProductsPanelRef.current?.deselectAllRows?.();
  }, []);

  const handleRequestDetachAddProducts = useCallback(() => {
    if (typeof window === 'undefined') return;
    const context = {
      placementAnchor,
      defaultPlacementMode,
      initialRequestedRowId,
      isStandardPackage,
      showRequestedColumns: isStandardPackage ? false : tableLayout === 'wReq',
    };
    try {
      window.sessionStorage.setItem(
        `fastquote-detached-add-products:${offerId}`,
        JSON.stringify(context),
      );
    } catch {
      /* noop */
    }
    const url = `/offers/${encodeURIComponent(offerId)}/products/add-window`;
    const features = 'popup=yes,width=1400,height=900,menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=yes';
    const win = window.open(url, `fastquote-add-products-${offerId}`, features);
    if (!win) {
      showToastMessage('Popup blocked. Allow popups to detach the modal.', 'error');
      return;
    }
    try { win.focus(); } catch { /* noop */ }
    detachedWindowRef.current = win;
    setDetachedWindowOpen(true);
    setShowAddProductModal(false);
  }, [offerId, placementAnchor, defaultPlacementMode, initialRequestedRowId, isStandardPackage, tableLayout]);

  useEffect(() => {
    if (!detachedWindowOpen) return;
    const interval = window.setInterval(() => {
      const win = detachedWindowRef.current;
      if (!win || win.closed) {
        detachedWindowRef.current = null;
        setDetachedWindowOpen(false);
        setPlacementAnchor(null);
        setDefaultPlacementMode('fill');
        offerProductsPanelRef.current?.setInsertLineVisible?.(false);
      }
    }, 500);
    return () => window.clearInterval(interval);
  }, [detachedWindowOpen]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; offerId?: string; count?: number; insertedOfferDetailIds?: unknown } | null;
      if (!data || typeof data !== 'object') return;
      if (data.offerId !== offerId) return;
      if (data.type === 'fastquote:detached-add-products:added') {
        const ids = Array.isArray(data.insertedOfferDetailIds)
          ? data.insertedOfferDetailIds
              .map((v) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null))
              .filter((v): v is number => v != null)
          : [];
        handleProductsAdded(typeof data.count === 'number' ? data.count : ids.length, ids);
        return;
      }
      if (data.type === 'fastquote:detached-add-products:closed') {
        detachedWindowRef.current = null;
        setDetachedWindowOpen(false);
        setPlacementAnchor(null);
        setDefaultPlacementMode('fill');
        offerProductsPanelRef.current?.setInsertLineVisible?.(false);
        return;
      }
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [offerId, handleProductsAdded]);

  // On mount: consume any pending reprice signal written by basicdata page.
  // The flag is written before the PATCH fires, so we schedule a refresh at
  // least 2s after the change timestamp to ensure any in-flight PATCH has
  // committed to the DB before the grid re-fetches.
  useEffect(() => {
    const key = `fastquote:services-repriced:${offerId}`;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    try {
      const ts = localStorage.getItem(key);
      localStorage.removeItem(key);
      if (ts) {
        const changeTime = Number(ts);
        const elapsed = Date.now() - changeTime;
        if (elapsed < 60_000) {
          const delay = Math.max(0, 2000 - elapsed);
          timerId = setTimeout(() => setRefreshToken((prev) => prev + 1), delay);
        }
      }
    } catch { /* noop */ }
    return () => { if (timerId != null) clearTimeout(timerId); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const bump = () => setRefreshToken((prev) => prev + 1);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('fastquote:offer-events');
      bc.onmessage = (ev: MessageEvent) => {
        if (
          ev.data?.type === 'services-location-changed' &&
          String(ev.data?.offerId) === String(offerId)
        ) {
          bump();
        }
      };
    } catch {
      // BroadcastChannel not available (SSR/old browser) — fall back to same-page event
    }
    window.addEventListener('fastquote:services-location-changed', bump);
    return () => {
      bc?.close();
      window.removeEventListener('fastquote:services-location-changed', bump);
    };
  }, [offerId]);

  const handleCloseRequestedModal = useCallback(() => setShowRequestedModal(false), []);
  const handleOpenAddProductForm = useCallback(() => setShowAddProductFormModal(true), []);
  const handleCloseAddProductForm = useCallback(() => setShowAddProductFormModal(false), []);
  const handleClearNewProductId = useCallback(() => setNewProductId(null), []);
  const handleRequestedImported = useCallback((result: { inserted?: number; updated?: number; total?: number }) => {
    void result;
    changeTableLayout('wReq');
    setRefreshToken((prev) => prev + 1);
  }, [changeTableLayout]);
  const showRequestedColumns = tableLayout === 'wReq';
  const splitModalOpen = showAddProductModal || showAddServiceModal;
  const headerRowTopClassName = splitModalOpen
    ? `${pageHeaderStyles.headerRowTop} ${toolbarStyles.compactHeaderRow}`
    : `${pageHeaderStyles.headerRowTop} ${toolbarStyles.offerHeaderTopRow}`.trim();
  const headerRowBottomClassName = splitModalOpen
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
    const selectedOfferDetailIds = await offerProductsPanelRef.current?.getSelectedOfferDetailIdsForPriceUpdate?.() ?? [];

    let willUpdate: number | null = null;
    try {
      const previewRes = await fetch(updatePricesEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offerDetailIds: selectedOfferDetailIds, dryRun: true }),
      });
      const previewPayload = (await previewRes.json().catch(() => null)) as
        | { ok?: boolean; willUpdate?: number } | null;
      if (previewRes.ok && previewPayload?.ok && typeof previewPayload.willUpdate === 'number') {
        willUpdate = previewPayload.willUpdate;
      }
    } catch (err) {
      console.warn('Failed to preview price update count', err);
    }

    const scopeLabel = selectedOfferDetailIds.length > 0 ? 'selected ' : '';
    const message = willUpdate == null
      ? `Update prices for the ${scopeLabel}rows? Rows without a matching pricelist will keep their existing prices.`
      : willUpdate === 0
        ? `No ${scopeLabel}rows have prices available from pricelists or Farnell. Nothing will be updated.`
        : `${willUpdate} ${scopeLabel}row${willUpdate === 1 ? '' : 's'} will have prices updated. Rows without a matching pricelist will keep their existing prices.`;

    if (willUpdate === 0) {
      showToastMessage(message, 'info', 6000);
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Update Prices',
      message,
      confirmLabel: 'Update',
      cancelLabel: 'Cancel',
    });
    if (!confirmed) return;

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

  const handleUpdateProductData = useCallback(async () => {
    if (isUpdatingProductData) return;
    const panel = offerProductsPanelRef.current;
    if (!panel) {
      showToastMessage('Products grid is not ready yet.', 'error');
      return;
    }
    setIsUpdatingProductData(true);
    try {
      await panel.updateProductData();
    } finally {
      setIsUpdatingProductData(false);
    }
  }, [isUpdatingProductData]);

  const handleRequestPaste = useCallback((anchorOfferDetailId: number | null, anchorTreeOrdering: string | null) => {
    if (anchorOfferDetailId != null && anchorTreeOrdering) {
      setPasteAnchor({ offerDetailId: anchorOfferDetailId, treeOrdering: anchorTreeOrdering });
    } else {
      setPasteAnchor(null);
    }
    setShowPasteDialog(true);
  }, []);

  const handleRequestAddStandardPackage = useCallback((anchorOfferDetailId: number | null, anchorTreeOrdering: string | null) => {
    if (anchorOfferDetailId != null && anchorTreeOrdering) {
      setAddStandardPackageAnchor({ offerDetailId: anchorOfferDetailId, treeOrdering: anchorTreeOrdering });
    } else {
      setAddStandardPackageAnchor(null);
    }
    setShowAddStandardPackageModal(true);
    setAddStandardPackageError(null);
  }, []);

  const handleConfirmAddStandardPackage = useCallback(async () => {
    const sourcePackageId = Number.parseInt(selectedStandardPackageId, 10);
    if (!Number.isInteger(sourcePackageId) || sourcePackageId <= 0) {
      setAddStandardPackageError('Select a standard package first.');
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
              'IsService',
              'ServiceType',
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

      const doPaste = () => fetch(
        `/api/offers/${encodeURIComponent(offerId)}/products/paste`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            rows: clipboardRows,
            keepPricing: true,
            anchorOfferDetailId: addStandardPackageAnchor?.offerDetailId ?? null,
          }),
        },
      );

      let pasteResponse = await doPaste();
      let pastePayload = (await pasteResponse.json().catch(() => null)) as
        | { ok?: boolean; inserted?: number; error?: string; requiresServicesLocation?: boolean }
        | null;

      // If service rows need a location, prompt the user then retry
      if (!pasteResponse.ok && pastePayload?.requiresServicesLocation === true) {
        const location = await showMultiChoiceDialog({
          title: 'Services Location Required',
          message: 'This standard package includes service products. Please select the Services Location for this offer:',
          choices: [
            { label: 'Ath (Athens)', value: 'Ath' },
            { label: 'GR (Greece)', value: 'GR' },
            { label: 'outGR (Outside GR)', value: 'outGR' },
          ],
        });
        if (!location) {
          setAddStandardPackageError('Services Location is required to add service products.');
          return;
        }
        await fetch(`/api/offers/${encodeURIComponent(offerId)}/basicdata`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ field: 'ServicesLocation', value: location }] }),
        });
        pasteResponse = await doPaste();
        pastePayload = (await pasteResponse.json().catch(() => null)) as
          | { ok?: boolean; inserted?: number; error?: string }
          | null;
      }

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
      const doPaste = () => fetch(
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

      let response = await doPaste();
      let payload = (await response.json().catch(() => null)) as
        | { ok?: boolean; error?: string; inserted?: number; requiresServicesLocation?: boolean }
        | null;

      // If service rows need a location, prompt the user then retry
      if (!response.ok && payload?.requiresServicesLocation === true) {
        const location = await showMultiChoiceDialog({
          title: 'Services Location Required',
          message: 'The rows being pasted include service products. Please select the Services Location for this offer:',
          choices: [
            { label: 'Ath (Athens)', value: 'Ath' },
            { label: 'GR (Greece)', value: 'GR' },
            { label: 'outGR (Outside GR)', value: 'outGR' },
          ],
        });
        if (!location) return; // user cancelled — silently abort
        await fetch(`/api/offers/${encodeURIComponent(offerId)}/basicdata`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ field: 'ServicesLocation', value: location }] }),
        });
        response = await doPaste();
        payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; error?: string; inserted?: number }
          | null;
      }

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

  const pricingMenuDetails = (
    <details
      ref={pricingMenuRef}
      className={toolbarStyles.commentDropdown}
      open={pricingMenuOpen}
      onToggle={(e) => setPricingMenuOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary
        className={[
          toolbarStyles.button,
          toolbarStyles.buttonUpdatePrices,
          'page-header-button',
        ].join(' ')}
        style={{ cursor: 'pointer', userSelect: 'none', background: 'white', display: 'inline-flex', alignItems: 'center', gap: 6 }}
      >
        <span style={{ color: '#c62828', fontWeight: 700 }}>{pricingHoldMarginOnCost ? 'Keep Margin' : 'Keep Net'}</span>
      </summary>
      <div className={toolbarStyles.commentMenu} style={{ minWidth: 280, right: 0, left: 'auto' }}>
        <div style={{ padding: '4px 8px 6px', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#475569' }}>
          Pricing Behaviour
        </div>
        <div style={{ padding: '2px 8px 6px', fontSize: '0.8rem', fontWeight: 600, color: '#475569' }}>
          When Net Cost or Telmaco Discount changes:
        </div>
        {([false, true] as const).map((holdMargin) => {
          const label = holdMargin ? 'Keep Margin' : 'Keep Net';
          const active = pricingHoldMarginOnCost === holdMargin;
          return (
            <button
              key={String(holdMargin)}
              type="button"
              className={toolbarStyles.commentMenuItem}
              style={{
                background: active ? '#e0f2fe' : '#f8fafc',
                color: active ? '#0c4a6e' : '#0f172a',
                borderColor: active ? 'rgba(7,89,133,0.3)' : 'rgba(15,23,42,0.1)',
                fontWeight: active ? 600 : 400,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
              onClick={() => {
                setPricingHoldMarginOnCost(holdMargin);
                void savePricingMode(holdMargin);
                if (pricingMenuRef.current) pricingMenuRef.current.open = false;
                setPricingMenuOpen(false);
              }}
            >
              <span style={{ width: 14, textAlign: 'center', flexShrink: 0 }}>{active ? '✓' : ''}</span>
              {label}
            </button>
          );
        })}
      </div>
    </details>
  );

  const headerRightControls = (
    <div className={toolbarStyles.topControls}>
      {!isReadOnly && !pivotView && !isStandardPackage ? (
        <>
          <button
            type="button"
            className={`${toolbarStyles.button} ${toolbarStyles.buttonUpdateProductData} page-header-button`}
            onClick={handleUpdateProductData}
            disabled={isUpdatingProductData}
          >
            {isUpdatingProductData ? 'Updating...' : 'Update Product'}
          </button>
          <button
            type="button"
            className={`${toolbarStyles.button} ${toolbarStyles.buttonUpdatePrices} page-header-button`}
            onClick={handleUpdatePrices}
            disabled={isUpdatingPrices}
          >
            {isUpdatingPrices ? 'Updating prices...' : 'Update Prices'}
          </button>
        </>
      ) : null}
      {isStandardPackage || isReadOnly ? null : pricingMenuDetails}
      {isStandardPackage ? null : (
        <Link
          href={`/offers/${encodeURIComponent(offerId)}/basicdata`}
          className={`${layoutStyles.headerActionButton} page-header-button`}
        >
          View Basic Data
        </Link>
      )}
    </div>
  );

  const addButtonGroup = isReadOnly ? null : (
    <div className={toolbarStyles.addButtons}>
      {!isStandardPackage && !pivotView ? (
        <button
          type="button"
          className={`${toolbarStyles.button} ${toolbarStyles.buttonPopulateOffer} page-header-button`}
          onClick={handlePopulateOffer}
          disabled={isPopulatingOffer}
        >
          {isPopulatingOffer ? 'Populating...' : 'Populate'}
        </button>
      ) : null}
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
      <details className={toolbarStyles.commentDropdown}>
        <summary
          className={`${toolbarStyles.button} ${toolbarStyles.buttonService} page-header-button`}
          aria-label="Add service"
        >
          Add Service
        </summary>
        <div className={toolbarStyles.commentMenu} role="menu" aria-label="Add service options">
          {addServiceOptions.map((option) => (
            <button
              type="button"
              key={option.key}
              className={
                option.key === 'non-printable-service'
                  ? `${toolbarStyles.commentMenuItem} ${toolbarStyles.serviceMenuItemNonPrintable}`
                  : `${toolbarStyles.commentMenuItem} ${toolbarStyles.serviceMenuItemPrintable}`
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

  const addRequestedButton = isReadOnly ? null : (
    <button
      type="button"
      className={`${toolbarStyles.button} ${toolbarStyles.buttonAddRequested} page-header-button`}
      onClick={() => { changeTableLayout('wReq'); setShowRequestedModal(true); }}
    >
      Add Requested
    </button>
  );

  const layoutSelect = (
    <select
      className={`${toolbarStyles.layoutSelect} page-header-button`}
      value={tableLayout}
      onChange={(event) => changeTableLayout(event.target.value as ProductsTableLayout)}
      aria-label="Table layout"
      suppressHydrationWarning
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
      <option value="brandPartNo">Layout: Brand w PartNo</option>
      <option value="category">Layout: Category</option>
    </select>
  ) : null;
  const pivotToggleButton = isStandardPackage ? null : (
    <button
      type="button"
      className={pivotToggleClass}
      onClick={() => setPivotView((prev) => !prev)}
    >
      Pivot
    </button>
  );

  const collapseAllToggleButton = pivotView ? null : (
    <button
      type="button"
      className={collapseAllToggleClass}
      onClick={() => setCollapseAllCategories((prev) => !prev)}
      title={collapseAllCategories ? 'Show all rows' : 'Collapse all categories'}
    >
      {collapseAllCategories ? 'Expand Categories' : 'Collapse Categories'}
    </button>
  );

  const topLeftActions = (
    <div className={toolbarStyles.leftColumn}>
      <Link
        href={isStandardPackage ? '/standard-packages' : '/offers'}
        className={`${layoutStyles.backLink} page-header-button`}
        title={isStandardPackage ? 'Back to standard packages' : 'Back to offers'}
        aria-label={isStandardPackage ? 'Back to standard packages' : 'Back to offers'}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 12px' }}
      >
        <span aria-hidden="true" style={{ fontSize: '20px', lineHeight: 1 }}>&larr;</span>
      </Link>
      {pivotToggleButton}
      {!isReadOnly && !pivotView && (
        <button
          type="button"
          className={manualToggleClass}
          onClick={() => {
            void (async () => {
              if (!manualMode) {
                setManualMode(true);
                return;
              }
              // Leaving manual mode: refuse if there are duplicate Item Nos.
              try {
                const dups = await offerProductsPanelRef.current?.findItemNoDuplicates?.() ?? [];
                if (dups.length > 0) {
                  const lines = dups.slice(0, 8).map((g) => {
                    const ids = g.rows.map((r) => r.OfferDetailID).join(', ');
                    return `• Item No "${g.treeOrdering}" — used by ${g.rows.length} rows (IDs ${ids})`;
                  });
                  const more = dups.length > 8 ? `\n…and ${dups.length - 8} more.` : '';
                  showToastMessage(
                    `Cannot leave manual mode — ${dups.length} duplicate Item No${dups.length === 1 ? '' : 's'} need to be resolved first:\n${lines.join('\n')}${more}`,
                    'error',
                    12000,
                  );
                  return;
                }
                setManualMode(false);
              } catch (err) {
                console.error('Failed to check for duplicate Item Nos', err);
                showToastMessage(
                  'Could not verify Item No uniqueness. Try again.',
                  'error',
                );
              }
            })();
          }}
        >
          Manual
        </button>
      )}
      {isStandardPackage ? collapseAllToggleButton : null}
    </div>
  );

  const undoButton = !isReadOnly && undoState.canUndo ? (
    <button
      type="button"
      className={`${toolbarStyles.button} page-header-button`}
      onClick={() => void offerProductsPanelRef.current?.performUndo()}
      title={undoState.lastLabel ? `Undo: ${undoState.lastLabel}` : 'Undo'}
    >
      ↩ Undo
    </button>
  ) : null;

  const startingItemNoControl = pivotView || !manualMode ? null : (
    <label className={toolbarStyles.startingItemNo}>
      Starting Item No
      <input
        type="number"
        min={1}
        step={1}
        value={startingItemNoInput}
        disabled={startingItemNoApplying}
        className={toolbarStyles.startingItemNoInput}
        onChange={(e) => setStartingItemNoInput(e.target.value)}
        onBlur={() => { void commitStartingItemNo(); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setStartingItemNoInput(String(startingItemNo));
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );

  const secondaryHeaderLeftActions = isStandardPackage ? (
    <div className={toolbarStyles.leftRequestedRow}>
      {undoButton}
      {startingItemNoControl}
    </div>
  ) : (
    <div className={toolbarStyles.leftRequestedRow}>
      {undoButton}
      {collapseAllToggleButton}
      {addRequestedButton}
      {layoutSelect}
      {startingItemNoControl}
    </div>
  );
  const pivotSecondaryHeaderLeftActions = (
    <div className={toolbarStyles.leftRequestedRow}>
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
          onDataChanged={() => setRefreshToken((prev) => prev + 1)}
          readOnly={isReadOnly}
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
              pricingPolicyName={pricingPolicyName}
              hideTotals={isStandardPackage || splitModalOpen}
              initialSelectedOfferDetailIds={savedSelectionIds}
              initialViewportScrollTop={initialProductsViewportScrollTop}
              onRequestPaste={handleRequestPaste}
              onRequestAddStandardPackage={handleRequestAddStandardPackage}
              onUndoStateChange={setUndoState}
              offerCreatedByUserId={offerCreatedByUserId}
              onMainGridSelectionChanged={handleMainGridSelectionChanged}
              onRequestInsertProduct={handleRequestInsertProduct}
              showInsertLineOnHover={splitModalOpen || detachedWindowOpen}
              extraBottomScrollSpace={splitModalOpen}
              onStartingItemNoChanged={(current) => {
                const next = current ?? 1;
                setStartingItemNo(next);
                setStartingItemNoInput(String(next));
              }}
              collapseAllCategories={collapseAllCategories}
              offerPricingHoldMarginOnCost={pricingHoldMarginOnCost}
              onOfferPricingHoldMarginOnCostChange={(next) => {
                setPricingHoldMarginOnCost(next);
                void savePricingMode(next);
              }}
              offerExtraNetDiscount={extraNetDiscount}
              offerExtraNetDiscountMode={extraNetDiscountMode}
              onOfferExtraDiscountsChange={saveExtraDiscounts}
              readOnly={isReadOnly}
            />
          </div>
          {showAddProductModal || showAddServiceModal ? (
            <div className={toolbarStyles.splitRight}>
              {showAddServiceModal ? (
                <AddProductsModal
                  offerId={offerId}
                  serviceOnly
                  defaultIsPrintable={addServiceIsPrintable}
                  onAdded={(inserted, insertedIds) => {
                    if (inserted > 0) {
                      if (insertedIds && insertedIds.length > 0) {
                        offerProductsPanelRef.current?.flashRows?.(insertedIds);
                      }
                      setRefreshToken((prev) => prev + 1);
                    }
                  }}
                  onClose={() => {
                    setShowAddServiceModal(false);
                    offerProductsPanelRef.current?.setInsertLineVisible?.(false);
                    offerProductsPanelRef.current?.deselectAllRows?.();
                  }}
                  getInsertionAnchor={handleGetAddInsertionAnchor}
                  splitViewMode
                  refreshToken={refreshToken}
                />
              ) : (
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
                placementAnchor={placementAnchor}
                defaultPlacementMode={defaultPlacementMode}
                onPlacementModeChange={handlePlacementModeChange}
                getLastClickedRowId={() => offerProductsPanelRef.current?.getLastClickedRowId?.() ?? null}
                onRequestDetach={handleRequestDetachAddProducts}
              />
              )}
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
          // Don't bump refreshToken here — the AddProductsModal handles the
          // new product via a pinned top row + single-row fetch, and the
          // outer offer grid doesn't need to refresh just because a product
          // was created in the global catalog.
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
