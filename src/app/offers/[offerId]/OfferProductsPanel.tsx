'use client';

import React, { useMemo, useCallback, useState, useRef, useEffect, useImperativeHandle } from 'react';
import type {
  CellValueChangedEvent,
  ColDef,
  ColumnEventType,
  ColumnMovedEvent,
  ColumnPinnedEvent,
  ColumnResizedEvent,
  ColumnVisibleEvent,
  DefaultMenuItem,
  GetContextMenuItemsParams,
  GridApi,
  ICellRendererParams,
  IRowNode,
  MenuItemDef,
  RowClassParams,
  RowDoubleClickedEvent,
  RowNode,
} from 'ag-grid-community';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import styles from './OfferProductsPanel.module.css';
import type {
  AgGridAllProps,
  GridTotals,
  GridResponse,
  ServerRequestWithQuickFilter,
} from '../../components/AgGridAll';
import {
  buildGridColumnStateStorageKey,
  collectPersistableColumnState,
  writePersistedColumnState,
} from '../../components/AgGridAll';

import {
  writeClipboard,
  isClipboardPopulated,
  mapRowToClipboardRow,
  type ProductClipboard,
} from './products/productClipboard';

const AgGridAll = dynamic<AgGridAllProps>(() => import('../../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading products…
    </div>
  ),
});
import { showToastMessage } from '../../../lib/toast';
import { useUndoStack } from '../../hooks/useUndoStack';
import { pushCellEditUndo } from '../../../lib/undoHelpers';
import { showConfirmDialog, showMultiChoiceDialog } from '../../../lib/confirm';
import { GridRowDeletion, getContextMenuSelectionSnapshot, getServerSideDeselectedRowIds, setGridRowDeletionContextMenuSelectionSnapshot } from '../../../lib/gridRowDeletion';
import { checkDeletePermissionForClient } from '../../../lib/deletePermissions';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment } from '../../../lib/offerProductRows';
import { useRealtimeGridUpdates } from '../../hooks/useRealtimeGridUpdates';
import MatchRequestedProductsModal, {
  type RequestedProductMatchEntry,
} from './products/MatchRequestedProductsModal';
import AddProductModal, { type AddProductInitialValues } from '../../products/AddProductModal';
import { useAuditUser } from '../../components/AuditUserProvider';
import LookupModal from '../../components/LookupModal';
import lookupStyles from '../../components/LookupModal.module.css';

import {
  productHistoryMenuIcon,
  enhanceDescriptionMenuIcon,
  addWebLinkMenuIcon,
  categoryMenuIcon,
  commentMenuIcon,
  brandBulkEditMenuIcon,
  costModifierMenuIcon,
  copyRowsMenuIcon,
  pasteRowsMenuIcon,
  addStandardPackageMenuIcon,
  createNewProductMenuIcon,
  viewProductMenuIcon,
} from './offerProductsIcons';
import type {
  GridRowNode,
  OfferProductsPanelProps as Props,
  OfferProductsPanelHandle,
  OfferProductsTemplateExportRow,
  OfferExportRow,
} from './offerProductsPanelTypes';
import { buildRequestedColumnDefsMap, buildProductColumnDefs } from './offerProductsColumnDefs';
import {
  decimalFormatter,
  DEFAULT_ROW_HEIGHT,
  MAX_CATEGORY_DEPTH,
  ADD_WEBLINK_MAX_PRODUCTS,
  ENHANCE_DESC_MAX_PRODUCTS,
  readCollapsedCategoryPathsFromCookie,
  writeCollapsedCategoryPathsToCookie,
  coerceNumber,
  normalizeProductId,
  compareTreeOrderingValues,
  parseTreeOrderingPath,
  buildTreeOrderingKey,
  computeDisplayOrderingMap,
  normalizeOfferDetailId,
  resolveRowLabel,
  resolveOfferProductTypeLabel,
  isRequestedRow,
  canEditRequestedField,
  normalizeDescriptionValue,
  getNormalizedRequestedDescriptionValues,
  normalizeRequestedItemNoValue,
  normalizeRequestedLookupValue,
  getExactTextValue,
  normalizeRequestedQuantityValue,
  buildRequestedProductMatchEntry,
  hasRequestedRowData,
  hasRequestedPseudoFields,
  buildRequestedLookupInfo,
  type RequestedLookupInfo,
  resolveProductIdFromRequestedInfo,
  fetchProductSummary,
  isFarnellBrand,
  fetchFarnellLookup,
  resolveFarnellProductByPartNumber,
  createFarnellProduct,
  buildFarnellPricingPatch,
  OFFER_PRODUCTS_EXPORT_FIELDS,
  normalizeNoForExport,
  recalcProductTotals,
  refreshCategoryAggregates,
  roundMoney,
  PRICING_FIELD_LABELS,
  PRICING_EDITABLE_FIELDS,
  DESCRIPTION_PASTE_BLOCKLIST,
  COST_ANALYSIS_COLUMNS,
  STANDARD_PACKAGE_PRODUCTS_FIELDS,
  isOfferProductCommentOrProduct,
  findDeleteMenuItemIndex,
  buildEndpointForOffer,
  buildRequestedFilterState,
  buildNegativeHiddenTokens,
  type RequestedDisplayFieldKey,
  REQUESTED_DISPLAY_FIELD_KEYS,
  REQUESTED_FIELD_LABELS,
  isRequestedFieldKey,
  type ProductSummary,
  type FarnellLookupResponse,
  type FilterExpansions,
  type HiddenFilterTokens,
} from './offerProductsUtils';

export type { OfferProductsPanelHandle, OfferProductsTemplateExportRow } from './offerProductsPanelTypes';

const OfferProductsPanel = React.forwardRef<OfferProductsPanelHandle, Props>(({
  offerId,
  endpoint,
  manualMode = false,
  standardPackageMode = false,
  refreshToken = 0,
  showRequestedColumns = true,
  tableLayout = 'wReq',
  hideTotals = false,
  initialSelectedOfferDetailIds,
  initialViewportScrollTop = null,
  onRequestPaste,
  onRequestAddStandardPackage,
  onUndoStateChange,
  offerCreatedByUserId,
  onMainGridSelectionChanged,
  onRequestInsertProduct,
  showInsertLineOnHover = false,
}: Props, ref) => {
  const router = useRouter();
  const { userId, roles } = useAuditUser();
  const isOfferCreator = Boolean(userId && offerCreatedByUserId && String(userId) === String(offerCreatedByUserId));
  useEffect(() => {
    deferInitialHeavyWorkRef.current = true;
  }, [offerId]);
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    return buildEndpointForOffer(offerId);
  }, [endpoint, offerId]);
  const dataEndpoint = resolvedEndpoint;
  // Persist Offer Products layouts globally (shared across all offers).
  // Still separated per table layout via `columnStateNamespace`.
  const persistenceEndpoint = '/api/offers/products';
  const columnStateNamespace = useMemo(
    () => (standardPackageMode ? 'standard-package-products' : `offer-products-${tableLayout}`),
    [standardPackageMode, tableLayout],
  );
  const columnStateStorageKey = useMemo(
    () => buildGridColumnStateStorageKey(persistenceEndpoint, userId, columnStateNamespace),
    [columnStateNamespace, persistenceEndpoint, userId],
  );
  const standardPackageRequestPayload = useMemo(
    () => (standardPackageMode ? { fields: [...STANDARD_PACKAGE_PRODUCTS_FIELDS] } : null),
    [standardPackageMode],
  );
  const pricingToastDedupRef = useRef<Map<string, number>>(new Map());
  const { pushUndo, performUndo, canUndo, lastLabel } = useUndoStack();
  useEffect(() => {
    onUndoStateChange?.({ canUndo, lastLabel });
  }, [canUndo, lastLabel, onUndoStateChange]);
  const realtimeCellUpdateRef = useRef<Map<string, number>>(new Map());
  const registerRealtimeCellUpdate = useCallback((rowId: number, field: string, value: unknown) => {
    const key = `${rowId}:${field}:${String(value)}`;
    realtimeCellUpdateRef.current.set(key, Date.now());
  }, []);
  const shouldSkipRealtimeCellEdit = useCallback(
    (event: CellValueChangedEvent<Record<string, unknown>>) => {
      const field = event.colDef.field;
      if (!field) return false;
      const rowId = normalizeOfferDetailId(
        (event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null,
      );
      if (rowId == null) return false;
      const key = `${rowId}:${field}:${String(event.newValue)}`;
      const lastSeen = realtimeCellUpdateRef.current.get(key);
      if (!lastSeen) return false;
      if (Date.now() - lastSeen > 1500) {
        realtimeCellUpdateRef.current.delete(key);
        return false;
      }
      realtimeCellUpdateRef.current.delete(key);
      return true;
    },
    [],
  );
  const { savedColumnOrder, savedHiddenMap } = useMemo(() => {
    if (typeof window === 'undefined' || !columnStateStorageKey) {
      return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
    }

    // If the audit user id is resolved after the page loads, the storage key changes from
    // "anon" to the real user id. If we read before any migration happens, we’ll treat the
    // new key as empty and re-render the grid with default column visibility/order (and
    // AG Grid may also reset widths).
    //
    // Migrate the previous anon state forward before we read.
    try {
      const hasRealUser = typeof userId === 'string' && userId.trim().length > 0;
      if (hasRealUser) {
        const existing = window.localStorage.getItem(columnStateStorageKey);
        if (!existing) {
          const anonKey = buildGridColumnStateStorageKey(persistenceEndpoint, '', columnStateNamespace);
          const anonRaw = window.localStorage.getItem(anonKey);
          if (anonRaw) {
            window.localStorage.setItem(columnStateStorageKey, anonRaw);
          }
        }
      }
    } catch {
      /* noop */
    }

    try {
      const raw = window.localStorage.getItem(columnStateStorageKey);
      if (!raw) {
        return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
      }
      const parsed = JSON.parse(raw) as {
        columns?: Array<{ colId?: unknown; order?: unknown; hide?: unknown }>;
      } | null;
      if (!parsed || !Array.isArray(parsed.columns)) {
        return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
      }
      const savedColumnOrder = parsed.columns
        .filter((entry) => typeof entry?.colId === 'string' && typeof entry?.order === 'number')
        .sort((a, b) => (a.order as number) - (b.order as number))
        .map((entry) => entry.colId as string);
      const savedHiddenMap: Record<string, boolean> = {};
      parsed.columns.forEach((entry) => {
        const colId = typeof entry?.colId === 'string' ? entry.colId : '';
        if (!colId) return;
        if (typeof entry?.hide === 'boolean') {
          savedHiddenMap[colId] = entry.hide;
        }
      });
      return { savedColumnOrder, savedHiddenMap };
    } catch {
      return { savedColumnOrder: [] as string[], savedHiddenMap: {} as Record<string, boolean> };
    }
  }, [columnStateNamespace, columnStateStorageKey, userId]);
  const addProductsEndpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products/add`,
    [offerId],
  );
  const assignRequestedRowToProduct = useCallback(
    async (
      requestedRowId: number,
      productId: number,
      categoryId: number | null,
      comment?: string,
      metrics?: Record<string, unknown> | null,
    ) => {
      try {
        const body: Record<string, unknown> = {
          action: 'assign-requested',
          requestedRowId,
          productId,
        };
        if (categoryId != null) {
          body.categoryId = categoryId;
        }
        if (comment) {
          body.comment = comment;
        }
        if (metrics) {
          body.metrics = metrics;
        }
        const res = await fetch(addProductsEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = (await res.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          pricing?: {
            quantity?: unknown;
            customerDiscount?: unknown;
            telmacoDiscount?: unknown;
          } | null;
        } | null;
        if (!res.ok || !payload?.ok) {
          console.error('Failed to assign requested row to product', payload?.error ?? `status ${res.status}`);
          return null;
        }
        const pricingPayload = payload.pricing && typeof payload.pricing === 'object'
          ? payload.pricing
          : null;
        return {
          pricing: pricingPayload
            ? {
                quantity: coerceNumber(pricingPayload.quantity ?? null),
                customerDiscount: coerceNumber(pricingPayload.customerDiscount ?? null),
                telmacoDiscount: coerceNumber(pricingPayload.telmacoDiscount ?? null),
              }
            : null,
        };
      } catch (err) {
        console.error('Failed to assign requested row to product', err);
        return null;
      }
    },
    [addProductsEndpoint],
  );
  const [totals, setTotals] = useState<{ totalListPrice: number; totalNetPrice: number; totalCost: number; totalMargin: number } | null>(null);
  const [totalNetEditing, setTotalNetEditing] = useState(false);
  const [totalNetInputValue, setTotalNetInputValue] = useState('');
  const [totalNetApplying, setTotalNetApplying] = useState(false);
  const totalNetSubmitPendingRef = useRef(false);
  const [totalMarginEditing, setTotalMarginEditing] = useState(false);
  const [totalMarginInputValue, setTotalMarginInputValue] = useState('');
  const totalMarginSubmitPendingRef = useRef(false);
  const [requestedColumnVisibility, setRequestedColumnVisibility] = useState<Record<RequestedDisplayFieldKey, boolean>>({
    RequestedBrand: false,
    RequestedModelNo: false,
    RequestedPartNo: false,
    RequestedWebLink: false,
    RequestedDescription: false,
    RequestedDescription2: false,
    RequestedDescription3: false,
    RequestedQuantity: false,
  });
  const [requestedItemNoVisible, setRequestedItemNoVisible] = useState(false);
  const requestedColumnVisibilityRef = useRef(requestedColumnVisibility);
  requestedColumnVisibilityRef.current = requestedColumnVisibility;
  const requestedItemNoVisibleRef = useRef(requestedItemNoVisible);
  requestedItemNoVisibleRef.current = requestedItemNoVisible;
  const [isAddingWebLinks, setIsAddingWebLinks] = useState(false);
  const [isEnhancingDescriptions, setIsEnhancingDescriptions] = useState(false);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const gridWrapperRef = useRef<HTMLDivElement | null>(null);
  const [requestedColumnsReady, setRequestedColumnsReadyFlag] = useState(false);
  const [offerCurrencyName, setOfferCurrencyName] = useState<string | null>(null);
  const [requestedMatchQueue, setRequestedMatchQueue] = useState<RequestedProductMatchEntry[]>([]);
  const [processedRequestedMatches, setProcessedRequestedMatches] = useState(0);

  // --- Smart filtering toggle ---
  // Read-only here — the modals own the UI control; we mirror the value so
  // background prefetch generates rows that match what the modal actually
  // sends on first paint.
  // --- AI expansion prefetch cache ---
  // Fetches expansion tokens for every requested entry in the queue upfront
  // with bounded concurrency (4 in-flight).  Modal folds cached tokens into
  // the initial filter model so the grid fetches data exactly once per
  // entry — no second round-trip after AI returns.
  const expansionCacheRef = useRef<Map<number, FilterExpansions>>(new Map());
  const expansionPrefetchingRef = useRef<Set<number>>(new Set());
  const expansionPrefetchStartedRef = useRef(false);
  const [expansionCacheVersion, setExpansionCacheVersion] = useState(0);

  // --- Product first-page prefetch cache ---
  // Chained off the expansion prefetch: as soon as the AI expansion for an
  // entry lands, we fire the same POST /products/add the modal would send
  // for its first block of rows and stash the response keyed by
  // offerDetailId.  The modal (via AgGridAll's prefetchedFirstPage prop)
  // consumes the cached block on first paint, so navigating through the
  // queue doesn't incur a server round-trip per product.
  const productPageCacheRef = useRef<Map<number, GridResponse>>(new Map());
  const productPagePrefetchingRef = useRef<Set<number>>(new Set());
  const [productPageCacheVersion, setProductPageCacheVersion] = useState(0);

  const prefetchProductPage = useCallback(async (
    entry: RequestedProductMatchEntry,
    expansion: FilterExpansions | null,
  ) => {
    const id = entry.offerDetailId;
    if (productPageCacheRef.current.has(id) || productPagePrefetchingRef.current.has(id)) return;
    productPagePrefetchingRef.current.add(id);
    try {
      // Match the modal's filter-model build exactly — fuzzy + hidden
      // tokens from the full expansion flow, same helper the modal uses.
      const built = buildRequestedFilterState({
        requestedBrand: entry.requestedBrand,
        requestedPartNumber: entry.requestedPartNumber,
        requestedModelNumber: entry.requestedModelNumber,
        requestedDescriptions: [
          entry.requestedDescription,
          entry.requestedDescription2,
          entry.requestedDescription3,
        ],
        prefetchedExpansion: expansion,
      });
      const filterModel: Record<string, unknown> = built.visibleModel ?? {};
      const hiddenTokens: HiddenFilterTokens | null = built.hiddenTokens ?? null;
      const body: Record<string, unknown> = {
        action: 'products',
        orFilterColumns: ['BrandName', 'PartNumber', 'ModelNumber', 'Description'],
        // Send `requested` so the server runs its inline LLM rerank on the
        // prefetched first page too.  Without this, the cached page the
        // modal consumes is keyword-ordered only, and because AgGridAll's
        // prefetch-consumption path never re-fetches block 0, rerank would
        // be silently skipped for any entry the user advances into.
        requested: {
          brand: entry.requestedBrand,
          partNumber: entry.requestedPartNumber,
          modelNumber: entry.requestedModelNumber,
          description: entry.requestedDescription,
          description2: entry.requestedDescription2,
          description3: entry.requestedDescription3,
        },
        request: {
          startRow: 0,
          // Must match the modal grid's cacheBlockSize (200) — AG Grid
          // caches the first getRows response as block 0, and if the
          // prefetch returned only 25 rows the grid would skip rows 25-199
          // on the next scroll block.
          endRow: 200,
          filterModel,
          sortModel: [{ colId: 'ProductID', sort: 'desc' }],
          rowGroupCols: [],
          valueCols: [],
          pivotCols: [],
          pivotMode: false,
          groupKeys: [],
        },
        fields: ['PartNumber', 'Description', 'BrandName', 'ModelNumber', 'ListPrice', 'CostPrice', 'PriceListName'],
      };
      if (hiddenTokens) body.hiddenFilterTokens = hiddenTokens;
      const negative = buildNegativeHiddenTokens(expansion, hiddenTokens);
      if (negative) body.negativeHiddenTokens = negative;
      const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) return;
      const data = (await res.json()) as GridResponse;
      if (data && data.ok) {
        productPageCacheRef.current.set(id, data);
        setProductPageCacheVersion((v) => v + 1);
      }
    } catch { /* noop */ }
    finally {
      productPagePrefetchingRef.current.delete(id);
    }
  }, [offerId]);

  const prefetchExpansion = useCallback(async (entry: RequestedProductMatchEntry) => {
    const id = entry.offerDetailId;
    if (expansionCacheRef.current.has(id) || expansionPrefetchingRef.current.has(id)) return;
    expansionPrefetchingRef.current.add(id);
    try {
      const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products/expand`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestedBrand: entry.requestedBrand,
          requestedModelNumber: entry.requestedModelNumber,
          requestedPartNumber: entry.requestedPartNumber,
          requestedDescription: entry.requestedDescription,
          requestedDescription2: entry.requestedDescription2,
          requestedDescription3: entry.requestedDescription3,
        }),
      });
      let expansion: FilterExpansions | null = null;
      if (res.ok) {
        const data = (await res.json()) as { ok: boolean; expansions?: FilterExpansions };
        expansion = data.expansions ?? {};
        expansionCacheRef.current.set(id, expansion);
        setExpansionCacheVersion((v) => v + 1);
      }
      // Chain the product-page prefetch once we know the expansion tokens, so
      // the cached first block uses the exact same hiddenFilterTokens the
      // modal would send.  If the expansion call failed, we still prefetch
      // without expansion (the modal would too).
      void prefetchProductPage(entry, expansion);
    } catch { /* noop */ }
    finally {
      expansionPrefetchingRef.current.delete(id);
    }
  }, [offerId, prefetchProductPage]);

  // Background prefetch for upcoming entries.  Held off until the current
  // entry's modal has actually loaded its grid data — otherwise entries 2+
  // race entry 1 for the same OpenAI + SQL quota and the user waits longer
  // for the one they're looking at.  The modal calls onCurrentEntryReady
  // when its first /products/add response arrives, which flips
  // firstEntryReady and lets the background workers start.
  const [firstEntryReady, setFirstEntryReady] = useState(false);
  const handleCurrentEntryReady = useCallback(() => {
    setFirstEntryReady(true);
  }, []);
  const currentQueueHeadId = requestedMatchQueue[0]?.offerDetailId ?? null;
  useEffect(() => {
    // New head (fresh batch or user skipped) — re-gate the prefetch so the
    // background workers wait for the new head to load before chasing
    // entries 2+ again.
    setFirstEntryReady(false);
    expansionPrefetchStartedRef.current = false;
  }, [currentQueueHeadId]);
  useEffect(() => {
    if (requestedMatchQueue.length === 0) return;
    if (!firstEntryReady) return;
    if (expansionPrefetchStartedRef.current) return;
    expansionPrefetchStartedRef.current = true;
    // Skip index 0: the modal itself is fetching the current entry.
    // prefetchExpansion is a no-op for already-cached ids, so re-queuing
    // a previously-prefetched entry is cheap.
    const entries = requestedMatchQueue.slice(1);
    if (entries.length === 0) return;
    // MAX_CONCURRENT 3: originally 4 → 2 → 1 to avoid OpenAI chat TPM
    // queueing, but with /expand now short-timeout-ing the chat call
    // (300ms, continues in background) the blocking factor is just the
    // embedding call which has a much higher rate limit.  3 in-flight
    // keeps entries 2-4 warm for the user while staying well under
    // embeddings TPM.
    const MAX_CONCURRENT = 3;
    let idx = 0;
    const worker = async () => {
      while (idx < entries.length) {
        const next = entries[idx++];
        await prefetchExpansion(next);
      }
    };
    const workers = Array.from({ length: Math.min(MAX_CONCURRENT, entries.length) }, () => worker());
    void Promise.all(workers);
  }, [requestedMatchQueue, prefetchExpansion, firstEntryReady]);
  const [collapsedCategoryPaths, setCollapsedCategoryPaths] = useState<Set<string>>(() =>
    readCollapsedCategoryPathsFromCookie(offerId),
  );
  const [categoryPathsWithChildren, setCategoryPathsWithChildren] = useState<Set<string>>(() => new Set());
  const [categoryChildrenKnown, setCategoryChildrenKnown] = useState(false);
  const collapsedCategoryPathsRef = useRef(collapsedCategoryPaths);
  collapsedCategoryPathsRef.current = collapsedCategoryPaths;
  const categoryPathsWithChildrenRef = useRef(categoryPathsWithChildren);
  categoryPathsWithChildrenRef.current = categoryPathsWithChildren;
  const categoryChildrenKnownRef = useRef(categoryChildrenKnown);
  categoryChildrenKnownRef.current = categoryChildrenKnown;
  const treeOrderingRootMapRef = useRef<Map<string, number>>(new Map());
  const allRowsForDisplayRef = useRef<Map<string, Record<string, unknown>>>(new Map());
  const displayOrderingMapRef = useRef<Map<string, string>>(new Map());
  const serverRowsRef = useRef<Array<Record<string, unknown>>>([]);
  const appliedRequestedColumnVisibilityRef = useRef<Record<RequestedDisplayFieldKey, boolean> | null>(null);
  const appliedRequestedItemNoVisibleRef = useRef<boolean | null>(null);
  const forceFreshRequestedVisibilityRef = useRef(false);
  const appliedShowRequestedColumnsRef = useRef<boolean | null>(null);
  const appliedTableLayoutRef = useRef<'cust' | 'wCost' | 'wReq' | null>(null);
  const lastServerRequestRef = useRef<ServerRequestWithQuickFilter | null>(null);
  const lastRowCountRef = useRef<number | null>(null);
  const lastRequestStartRef = useRef<number | null>(null);
  const deferInitialHeavyWorkRef = useRef(true);
  const skipModelUpdateRef = useRef(false);
  const collapseSkipUntilRef = useRef<number | null>(null);
  const pendingContextMenuSelectionClearRef = useRef(false);
  const toggleCategoryCollapsedRef = useRef<(row: Record<string, unknown> | null | undefined) => void>(() => {});
  const [matchAddProductOpen, setMatchAddProductOpen] = useState(false);
  const [matchAddedProductId, setMatchAddedProductId] = useState<number | null>(null);
  const clearMatchAddedProductId = useCallback(() => setMatchAddedProductId(null), []);
  const [rowAddProductOpen, setRowAddProductOpen] = useState(false);
  const [rowAddProductInitialValues, setRowAddProductInitialValues] = useState<AddProductInitialValues | null>(null);
  const [brandBulkEditOpen, setBrandBulkEditOpen] = useState(false);
  const [brandBulkEditField, setBrandBulkEditField] = useState<'CurrencyCostModifier' | 'Margin' | 'CustomerDiscount' | 'TelmacoDiscount'>('CurrencyCostModifier');
  const [brandBulkEditBrandName, setBrandBulkEditBrandName] = useState('');
  const [brandBulkEditValue, setBrandBulkEditValue] = useState('');
  const [brandBulkEditSaving, setBrandBulkEditSaving] = useState(false);
  const [brandBulkEditError, setBrandBulkEditError] = useState<string | null>(null);
  const [brandBulkEditScope, setBrandBulkEditScope] = useState<'brand' | 'offer'>('brand');
  const [demotePromptOpen, setDemotePromptOpen] = useState(false);
  const [demotePromptQuantity, setDemotePromptQuantity] = useState('');
  const [demotePromptError, setDemotePromptError] = useState<string | null>(null);
  const [demotePromptSaving, setDemotePromptSaving] = useState(false);
  const demotePromptPayloadRef = useRef<{ node: GridRowNode; row: Record<string, unknown>; detailId: number } | null>(null);
  const hasNonEuroCostCurrencyRef = useRef(false);
  const refreshScheduledRef = useRef(false);
  const pendingRefreshPurgeRef = useRef<boolean | null>(null);
  const captureColumnWidths = useCallback((api: GridApi<Record<string, unknown>>) => {
    const stateNow = typeof api.getColumnState === 'function' ? api.getColumnState() : [];
    return (Array.isArray(stateNow) ? stateNow : [])
      .map((entry) => {
        const colId = typeof entry?.colId === 'string' ? entry.colId : '';
        const width = typeof entry?.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
          ? entry.width
          : null;
        if (!colId || width == null) return null;
        return { colId, width };
      })
      .filter((entry): entry is { colId: string; width: number } => entry != null);
  }, []);
  const restoreColumnWidths = useCallback((
    api: GridApi<Record<string, unknown>>,
    widths: Array<{ colId: string; width: number }>,
  ) => {
    if (!widths.length) return;
    try {
      api.applyColumnState({
        state: widths,
        applyOrder: false,
      });
    } catch {
      /* noop */
    }
  }, []);
  const rebuildTreeOrderingRootMap = useCallback((rows?: Array<Record<string, unknown>>, reset = false) => {
    const map = reset ? new Map<string, number>() : new Map(treeOrderingRootMapRef.current);
    (rows ?? []).forEach((row) => {
      if (!row) return;
      const path = parseTreeOrderingPath((row as Record<string, unknown>)?.TreeOrdering ?? null);
      if (path.length === 0) return;
      const key = String(path[0]);
      if (!map.has(key)) {
        map.set(key, map.size + 1);
      }
    });
    treeOrderingRootMapRef.current = map;
  }, []);
  const rebuildDisplayOrderingMap = useCallback((rows?: Array<Record<string, unknown>>, reset = false) => {
    if (reset) allRowsForDisplayRef.current = new Map();
    (rows ?? []).forEach((row) => {
      if (!row) return;
      const key = String((row as Record<string, unknown>)?.TreeOrdering ?? '').trim();
      if (key) allRowsForDisplayRef.current.set(key, row as Record<string, unknown>);
    });
    displayOrderingMapRef.current = computeDisplayOrderingMap(
      Array.from(allRowsForDisplayRef.current.values()),
    );
  }, []);
  const formatDisplayTreeOrdering = useCallback((value: unknown) => {
    if (value == null) return '';
    const trimmed = String(value).trim();
    if (!trimmed) return '';

    // Keep the root map updated (used elsewhere), but do not renumber the displayed value.
    const path = parseTreeOrderingPath(trimmed);
    if (path.length > 0) {
      const map = treeOrderingRootMapRef.current;
      const key = String(path[0]);
      if (!map.has(key)) {
        map.set(key, map.size + 1);
      }
    }

    return trimmed;
  }, []);

  const applyRequestedColumnVisibility = useCallback((visibility: Partial<Record<RequestedDisplayFieldKey, boolean>> | null | undefined, replace = false) => {
    const resetState = {
      RequestedBrand: false,
      RequestedModelNo: false,
      RequestedPartNo: false,
      RequestedWebLink: false,
      RequestedDescription: false,
      RequestedDescription2: false,
      RequestedDescription3: false,
      RequestedQuantity: false,
    };
    const stickyWReq = showRequestedColumns && tableLayout === 'wReq';
    if (!visibility) {
      if (!replace) return;
      if (stickyWReq) return;
      setRequestedColumnVisibility((prev) => {
        const next = { ...resetState };
        const hasChanged = REQUESTED_DISPLAY_FIELD_KEYS.some((key) => prev[key] !== next[key]);
        return hasChanged ? next : prev;
      });
      return;
    }
    setRequestedColumnVisibility((prev) => {
      const next = replace
        ? (stickyWReq ? { ...prev } : { ...resetState })
        : { ...prev };
      REQUESTED_DISPLAY_FIELD_KEYS.forEach((key) => {
        if (visibility[key] == null) return;
        const nextValue = Boolean(visibility[key]);
        next[key] = stickyWReq ? (Boolean(next[key]) || nextValue) : nextValue;
      });
      const hasChanged = REQUESTED_DISPLAY_FIELD_KEYS.some((key) => prev[key] !== next[key]);
      return hasChanged ? next : prev;
    });
  }, [showRequestedColumns, tableLayout]);

  const applyRequestedVisibilityToGrid = useCallback((
    visibility: Record<RequestedDisplayFieldKey, boolean>,
    itemNoVisible: boolean,
    options?: { defer?: boolean; force?: boolean },
  ) => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    const keys = REQUESTED_DISPLAY_FIELD_KEYS;
    const forceShowRequestedColumns = showRequestedColumns && tableLayout === 'wReq';
    const savedRequestedHidden = (key: string) => savedHiddenMap[key] === true;
    const effectiveVisibility = showRequestedColumns
      ? keys.reduce<Record<RequestedDisplayFieldKey, boolean>>((acc, key) => {
        const baseVisible = visibility[key];
        acc[key] = forceShowRequestedColumns
          ? Boolean(baseVisible)
          : Boolean(baseVisible) && !savedRequestedHidden(key);
        return acc;
      }, {} as Record<RequestedDisplayFieldKey, boolean>)
      : keys.reduce<Record<RequestedDisplayFieldKey, boolean>>((acc, key) => {
        acc[key] = false;
        return acc;
      }, {} as Record<RequestedDisplayFieldKey, boolean>);
    const effectiveItemNoVisible = showRequestedColumns
      ? forceShowRequestedColumns
        ? Boolean(itemNoVisible)
        : Boolean(itemNoVisible) && !savedRequestedHidden('RequestedItemNo')
      : false;

    const previousVisibility = appliedRequestedColumnVisibilityRef.current;
    const visibilityChanged = !previousVisibility
      || appliedShowRequestedColumnsRef.current !== showRequestedColumns
      || keys.some((key) => previousVisibility?.[key] !== effectiveVisibility[key]);
    const itemNoVisibilityChanged = appliedRequestedItemNoVisibleRef.current !== effectiveItemNoVisible;

    if (!options?.force && !visibilityChanged && !itemNoVisibilityChanged) {
      return;
    }

    const state: Array<{ colId: string; hide: boolean }> = keys.map((key) => ({
      colId: key,
      hide: !effectiveVisibility[key],
    }));
    state.push({ colId: 'RequestedItemNo', hide: !effectiveItemNoVisible });

    const applyState = () => {
      const activeApi = gridApiRef.current;
      if (!activeApi || activeApi.isDestroyed?.()) return;
      try {
        activeApi.applyColumnState({ state, applyOrder: false });
      } catch {
        /* noop */
      }
    };

    applyState();
    appliedRequestedColumnVisibilityRef.current = { ...effectiveVisibility };
    appliedRequestedItemNoVisibleRef.current = effectiveItemNoVisible;
    appliedShowRequestedColumnsRef.current = showRequestedColumns;
    if (!options?.defer || typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        applyState();
      });
    });
  }, [savedHiddenMap, showRequestedColumns, tableLayout]);

  const reapplyRequestedColumnsVisibility = useCallback((options?: { defer?: boolean }) => {
    if (!requestedColumnsReady) return;
    // Read from refs to avoid stale-closure issues when called from RAF callbacks
    // (e.g. handleGridModelUpdated schedules a RAF that may capture an old closure
    // before React has flushed state updates from handleGridResponse).
    applyRequestedVisibilityToGrid(requestedColumnVisibilityRef.current, requestedItemNoVisibleRef.current, options);
  }, [
    applyRequestedVisibilityToGrid,
    requestedColumnsReady,
  ]);

  const defaultColDef = useMemo<ColDef>(() => ({
    editable: (params) => (
      isOfferProductProduct(params?.data ?? null)
      || isOfferProductComment(params?.data ?? null)
    ),
    sortable: false,
    cellStyle: {
      display: 'flex',
      alignItems: 'center',
    },
  }), []);

  const applyRowTotalsDelta = useCallback((
    oldRow: { TotalPrice: number; TotalNet: number; TotalCost: number },
    newRow: { TotalPrice: number; TotalNet: number; TotalCost: number },
  ) => {
    const dTP = newRow.TotalPrice - oldRow.TotalPrice;
    const dTN = newRow.TotalNet - oldRow.TotalNet;
    const dTC = newRow.TotalCost - oldRow.TotalCost;
    if (dTP === 0 && dTN === 0 && dTC === 0) return;
    setTotals((prev) => {
      if (!prev) return prev;
      const totalListPrice = prev.totalListPrice + dTP;
      const totalNetPrice = prev.totalNetPrice + dTN;
      const totalCost = prev.totalCost + dTC;
      const marginBasis = Object.is(totalNetPrice, 0) ? 0 : totalNetPrice;
      const totalMargin = marginBasis === 0 ? 0 : ((totalNetPrice - totalCost) / marginBasis) * 100;
      return { totalListPrice, totalNetPrice, totalCost, totalMargin };
    });
  }, []);

  const snapshotRowTotals = useCallback((data: Record<string, unknown> | null | undefined) => {
    if (!data) return { TotalPrice: 0, TotalNet: 0, TotalCost: 0 };
    return {
      TotalPrice: coerceNumber((data as { TotalPrice?: unknown }).TotalPrice) ?? 0,
      TotalNet: coerceNumber((data as { TotalNet?: unknown }).TotalNet) ?? 0,
      TotalCost: coerceNumber((data as { TotalCost?: unknown }).TotalCost) ?? 0,
    };
  }, []);

  const handleTotalsChange = useCallback((payload: GridTotals | null) => {
    if (!payload) {
      setTotals(null);
      return;
    }
    const totalNetPrice = payload.totalNetPrice ?? 0;
    const totalListPrice = payload.totalListPrice ?? 0;
    const totalCost = payload.totalCost ?? 0;
    const marginBasis = Object.is(totalNetPrice, 0) ? 0 : totalNetPrice;
    const totalMargin = marginBasis === 0 ? 0 : ((totalNetPrice - totalCost) / marginBasis) * 100;
    setTotals((prev) => {
      if (
        prev
        && Object.is(prev.totalNetPrice, totalNetPrice)
        && Object.is(prev.totalListPrice, totalListPrice)
        && Object.is(prev.totalCost, totalCost)
        && Object.is(prev.totalMargin, totalMargin)
      ) {
        return prev;
      }
      return { totalNetPrice, totalListPrice, totalCost, totalMargin };
    });
  }, []);

  const updateCategoryAncestors = useCallback(() => {
    const api = gridApiRef.current;
    const loadedRows: Record<string, unknown>[] = [];
    if (api && !api.isDestroyed?.()) {
      api.forEachNode((node) => {
        if (node?.data) {
          loadedRows.push(node.data as Record<string, unknown>);
        }
      });
    }
    const rows = loadedRows.length > 0 ? loadedRows : serverRowsRef.current;
    if (rows.length === 0) {
      setCategoryPathsWithChildren((prev) => (prev.size === 0 ? prev : new Set()));
      setCollapsedCategoryPaths((prev) => (prev.size === 0 ? prev : new Set()));
      setCategoryChildrenKnown(false);
      return;
    }
    const rowsByPath = new Map<string, Record<string, unknown>>();
    rows.forEach((rowData) => {
      if (!rowData) return;
      const path = parseTreeOrderingPath((rowData as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      if (path.length === 0) return;
      const key = buildTreeOrderingKey(path);
      if (!key) return;
      rowsByPath.set(key, rowData);
    });
    if (rowsByPath.size === 0) {
      setCategoryPathsWithChildren((prev) => (prev.size === 0 ? prev : new Set()));
      setCategoryChildrenKnown(false);
      return;
    }
    const categoryKeys = new Set<string>();
    rowsByPath.forEach((rowData, key) => {
      if (isOfferProductCategory(rowData)) {
        categoryKeys.add(key);
      }
    });
    const next = new Set<string>();
    rowsByPath.forEach((rowData) => {
      const path = parseTreeOrderingPath((rowData as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      if (path.length <= 1) return;
      const parentKey = buildTreeOrderingKey(path.slice(0, -1));
      if (parentKey && categoryKeys.has(parentKey)) {
        next.add(parentKey);
      }
    });
    // Preserve collapsed categories: their children have been removed from the
    // grid so forEachNode won't find them, but we know they have children
    // (otherwise they couldn't have been collapsed).
    collapsedCategoryPathsRef.current.forEach((key) => {
      if (categoryKeys.has(key)) {
        next.add(key);
      }
    });
    setCategoryPathsWithChildren((prev) => {
      if (prev.size === next.size && Array.from(next).every((value) => prev.has(value))) {
        return prev;
      }
      return next;
    });
    setCategoryChildrenKnown(true);
    const newDisplayMap = computeDisplayOrderingMap(rows);
    displayOrderingMapRef.current = newDisplayMap;
    if (api && !api.isDestroyed?.()) {
      api.refreshCells({ columns: ['TreeOrdering'], force: true });
    }
  }, []);
  const categoryAncestorsUpdateQueuedRef = useRef(false);
  const scheduleCategoryAncestorsUpdate = useCallback(() => {
    if (categoryAncestorsUpdateQueuedRef.current) return;
    categoryAncestorsUpdateQueuedRef.current = true;
    if (typeof window === 'undefined') {
      categoryAncestorsUpdateQueuedRef.current = false;
      updateCategoryAncestors();
      return;
    }
    window.requestAnimationFrame(() => {
      categoryAncestorsUpdateQueuedRef.current = false;
      updateCategoryAncestors();
    });
  }, [updateCategoryAncestors]);

  useEffect(() => {
    if (!requestedColumnsReady) return;
    const api = gridApiRef.current;
    if (!api) return;
    const widthSnapshot = captureColumnWidths(api);

    const keys = REQUESTED_DISPLAY_FIELD_KEYS;
    const forcedHiddenVisibility = keys.reduce<Record<RequestedDisplayFieldKey, boolean>>((acc, key) => {
      acc[key] = false;
      return acc;
    }, {} as Record<RequestedDisplayFieldKey, boolean>);
    const savedRequestedHidden = (key: string) => savedHiddenMap[key] === true;
    const forceShowRequestedColumns = showRequestedColumns && tableLayout === 'wReq';
    const effectiveVisibility = showRequestedColumns
      ? keys.reduce<Record<RequestedDisplayFieldKey, boolean>>((acc, key) => {
        const baseVisible = requestedColumnVisibility[key];
        acc[key] = forceShowRequestedColumns
          ? Boolean(baseVisible)
          : Boolean(baseVisible) && !savedRequestedHidden(key);
        return acc;
      }, {} as Record<RequestedDisplayFieldKey, boolean>)
      : forcedHiddenVisibility;
    const effectiveItemNoVisible = showRequestedColumns
      ? forceShowRequestedColumns
        ? requestedItemNoVisible
        : requestedItemNoVisible && !savedRequestedHidden('RequestedItemNo')
      : false;

    const previousVisibility = appliedRequestedColumnVisibilityRef.current;
    const visibilityChanged = !previousVisibility
      || appliedShowRequestedColumnsRef.current !== showRequestedColumns
      || keys.some((key) => previousVisibility?.[key] !== effectiveVisibility[key]);
    const itemNoVisibilityChanged = appliedRequestedItemNoVisibleRef.current !== effectiveItemNoVisible;
    if (!visibilityChanged && !itemNoVisibilityChanged) {
      return;
    }

    const visibilityState: Array<{ colId: string; hide: boolean }> = keys.map((key) => ({
      colId: key,
      hide: !effectiveVisibility[key],
    }));
    visibilityState.push({ colId: 'RequestedItemNo', hide: !effectiveItemNoVisible });

    const applyVisibilityState = () => {
      const activeApi = gridApiRef.current;
      if (!activeApi || activeApi.isDestroyed?.()) return;
      try {
        activeApi.applyColumnState({ state: visibilityState, applyOrder: false });
      } catch {
        /* noop */
      }
    };

    try {
      applyVisibilityState();
    } catch {
      /* noop */
    }
    restoreColumnWidths(api, widthSnapshot);

    // AG Grid can sometimes drift hidden "Requested…" columns into unexpected positions.
    // Always keep the full Requested block (visible + hidden) at the start (right after the
    // drag handle) so it comes back in the correct place across all layouts.
    if (typeof window !== 'undefined' && typeof api.getColumnState === 'function' && typeof api.moveColumns === 'function') {
      const applyOrder = () => {
        try {
          const stateNow = api.getColumnState();
          const currentOrder = Array.isArray(stateNow)
            ? stateNow.map((entry) => (typeof entry?.colId === 'string' ? entry.colId : '')).filter((id) => id)
            : [];
          if (currentOrder.length === 0) return;
          const dragIndex = currentOrder.indexOf('__row_drag__');
          const anchorIndex = dragIndex >= 0 ? dragIndex + 1 : 0;

          const desiredStartIds = ['ProductID', 'RequestedItemNo', ...keys, 'TreeOrdering'];
          const toMove = desiredStartIds.filter((id) => currentOrder.includes(id));
          if (toMove.length === 0) return;
          api.moveColumns(toMove, anchorIndex);
        } catch {
          /* noop */
        } finally {
          restoreColumnWidths(api, widthSnapshot);
        }
      };
      // Run twice to avoid races with internal column-state restoration.
      window.requestAnimationFrame(() => window.requestAnimationFrame(applyOrder));
    } else {
      restoreColumnWidths(api, widthSnapshot);
    }

    appliedRequestedColumnVisibilityRef.current = { ...effectiveVisibility };
    appliedRequestedItemNoVisibleRef.current = effectiveItemNoVisible;
    appliedShowRequestedColumnsRef.current = showRequestedColumns;

    if (typeof window === 'undefined') return;
    const rafId = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        applyVisibilityState();
      });
    });
    const timeoutId = window.setTimeout(() => {
      applyVisibilityState();
    }, 120);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timeoutId);
    };
  }, [
    captureColumnWidths,
    columnStateStorageKey,
    requestedColumnVisibility,
    requestedColumnsReady,
    requestedItemNoVisible,
    restoreColumnWidths,
    savedHiddenMap,
    showRequestedColumns,
    tableLayout,
  ]);

  useEffect(() => {
    if (!requestedColumnsReady) return;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    if (appliedTableLayoutRef.current === tableLayout) return;
    const widthSnapshot = captureColumnWidths(api);

    const showCostAnalysis = tableLayout !== 'cust';
    try {
      const state = COST_ANALYSIS_COLUMNS.map((colId) => ({
        colId,
        hide: !showCostAnalysis,
      }));
      api.applyColumnState({ state, applyOrder: false });
    } catch {
      /* noop */
    }
    restoreColumnWidths(api, widthSnapshot);

    appliedTableLayoutRef.current = tableLayout;
  }, [captureColumnWidths, requestedColumnsReady, restoreColumnWidths, tableLayout]);

  const flashIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashPhaseRef = useRef<'paint' | 'fade' | null>(null);

  const paintFlashCells = useCallback(() => {
    const flashIds = pendingFlashIdsRef.current;
    if (!flashIds || flashIds.size === 0) return;
    const wrapper = gridWrapperRef.current;
    const api = gridApiRef.current;
    if (!wrapper || !api || api.isDestroyed?.()) return;
    const agRows = wrapper.querySelectorAll('.ag-row');
    const seen = new Set<string>();
    for (const agRow of agRows) {
      const idx = agRow.getAttribute('row-index');
      if (idx == null || seen.has(idx)) continue;
      seen.add(idx);
      const node = api.getDisplayedRowAtIndex(Number.parseInt(idx, 10));
      const rowId = normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown } | null)?.OfferDetailID ?? null);
      if (rowId != null && flashIds.has(rowId)) {
        const allRowEls = wrapper.querySelectorAll(`.ag-row[row-index="${idx}"]`);
        for (const rowEl of allRowEls) {
          const cells = (rowEl as HTMLElement).querySelectorAll(':scope > .ag-cell');
          for (const cell of cells) {
            const colId = cell.getAttribute('col-id') ?? '';
            if (colId.startsWith('Requested')
              || colId === 'ag-Grid-AutoColumn'
              || colId === ''
              || cell.classList.contains('ag-selection-checkbox')
              || cell.querySelector('.ag-selection-checkbox, .ag-row-drag, .ag-drag-handle')
            ) continue;
            const el = cell as HTMLElement;
            if (flashPhaseRef.current === 'paint') {
              el.style.setProperty('background-color', '#d4f3ff', 'important');
              el.style.removeProperty('transition');
            }
          }
        }
      }
    }
  }, []);

  const stopFlash = useCallback(() => {
    if (flashIntervalRef.current) {
      clearInterval(flashIntervalRef.current);
      flashIntervalRef.current = null;
    }
    flashPhaseRef.current = null;
    // Apply fade-out to all currently highlighted cells
    const wrapper = gridWrapperRef.current;
    if (!wrapper) return;
    const flashIds = pendingFlashIdsRef.current;
    pendingFlashIdsRef.current = null;
    if (!flashIds) return;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    const agRows = wrapper.querySelectorAll('.ag-row');
    const seen = new Set<string>();
    for (const agRow of agRows) {
      const idx = agRow.getAttribute('row-index');
      if (idx == null || seen.has(idx)) continue;
      seen.add(idx);
      const node = api.getDisplayedRowAtIndex(Number.parseInt(idx, 10));
      const rowId = normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown } | null)?.OfferDetailID ?? null);
      if (rowId != null && flashIds.has(rowId)) {
        const allRowEls = wrapper.querySelectorAll(`.ag-row[row-index="${idx}"]`);
        for (const rowEl of allRowEls) {
          const cells = (rowEl as HTMLElement).querySelectorAll(':scope > .ag-cell');
          for (const cell of cells) {
            const el = cell as HTMLElement;
            el.style.setProperty('transition', 'background-color 2s ease-out', 'important');
            el.style.removeProperty('background-color');
          }
          setTimeout(() => {
            for (const cell of cells) {
              (cell as HTMLElement).style.removeProperty('transition');
            }
          }, 2200);
        }
      }
    }
  }, []);

  const handleGridResponse = useCallback((response: GridResponse | null) => {
    if (!response) return;
    // Start flash painting when new data arrives (after grid renders the rows)
    if (pendingFlashIdsRef.current && pendingFlashIdsRef.current.size > 0 && flashPhaseRef.current === 'paint' && !flashIntervalRef.current) {
      requestAnimationFrame(() => {
        paintFlashCells();
        flashIntervalRef.current = setInterval(paintFlashCells, 200);
        setTimeout(() => stopFlash(), 1500);
      });
    }
    lastRowCountRef.current = response?.rowCount ?? null;
    const hasRows = Boolean(response?.rowCount && response.rowCount > 0);
    serverRowsRef.current = response && Array.isArray(response.rows) ? response.rows : [];
    {
      const rawCurrencyName = (response as { offerCurrencyName?: unknown } | null | undefined)?.offerCurrencyName;
      if (typeof rawCurrencyName === 'string') {
        const trimmed = rawCurrencyName.trim();
        const next = trimmed.length > 0 ? trimmed : null;
        setOfferCurrencyName((prev) => (prev === next ? prev : next));
      } else if (rawCurrencyName === null) {
        setOfferCurrencyName((prev) => (prev === null ? prev : null));
      }
    }
    const shouldResetRoots = response?.request?.startRow === 0;
    rebuildTreeOrderingRootMap(response?.rows as Array<Record<string, unknown>> | undefined, shouldResetRoots);
    rebuildDisplayOrderingMap(response?.rows as Array<Record<string, unknown>> | undefined, shouldResetRoots);
    const preserveWReqVisibility = showRequestedColumns && tableLayout === 'wReq';
    const isFirstPage = (response?.request?.startRow ?? 0) === 0;
    if (preserveWReqVisibility) {
      const hasRequestedItemInRows = (response?.rows ?? []).some((row) => normalizeRequestedItemNoValue(
        (row as Record<string, unknown>)?.RequestedItemNo ?? null,
      ) != null);
      const responseRequestedItemNo = Boolean(response?.requestedColumns?.RequestedItemNo) || hasRequestedItemInRows;
      if (isFirstPage) {
        // First page: OR-merge with previous visibility so columns that were already
        // visible stay visible across grid refreshes (e.g. after Populate Offer).
        // On the very first load the previous state is all-false, so this is equivalent
        // to a full reset — empty columns are still hidden on launch.
        const freshVisibility = REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
          (acc, key) => {
            acc[key] = Boolean(response?.requestedColumns?.[key]);
            return acc;
          },
          {} as Record<RequestedDisplayFieldKey, boolean>,
        );
        const useFresh = forceFreshRequestedVisibilityRef.current;
        const previousVisibility = appliedRequestedColumnVisibilityRef.current ?? requestedColumnVisibility;
        const mergedVisibility = useFresh
          ? freshVisibility
          : REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
              (acc, key) => {
                acc[key] = Boolean(previousVisibility?.[key]) || freshVisibility[key];
                return acc;
              },
              {} as Record<RequestedDisplayFieldKey, boolean>,
            );
        setRequestedColumnVisibility((prev) => {
          const hasChanged = REQUESTED_DISPLAY_FIELD_KEYS.some((key) => prev[key] !== mergedVisibility[key]);
          return hasChanged ? mergedVisibility : prev;
        });
        const mergedItemNoVisible = useFresh
          ? responseRequestedItemNo
          : (appliedRequestedItemNoVisibleRef.current ?? requestedItemNoVisible) || responseRequestedItemNo;
        setRequestedItemNoVisible(mergedItemNoVisible);
        applyRequestedVisibilityToGrid(mergedVisibility, mergedItemNoVisible, { force: true, defer: true });
        if (useFresh) forceFreshRequestedVisibilityRef.current = false;
      } else {
        // Subsequent pages: OR-merge so columns don't disappear while scrolling through pages.
        const previousVisibility = appliedRequestedColumnVisibilityRef.current ?? requestedColumnVisibility;
        const mergedVisibility = REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
          (acc, key) => {
            const fromResponse = response?.requestedColumns?.[key];
            const previous = Boolean(previousVisibility?.[key]);
            acc[key] = previous || Boolean(fromResponse);
            return acc;
          },
          {} as Record<RequestedDisplayFieldKey, boolean>,
        );
        const mergedItemNoVisible = (appliedRequestedItemNoVisibleRef.current ?? requestedItemNoVisible) || responseRequestedItemNo;
        applyRequestedColumnVisibility(mergedVisibility, true);
        setRequestedItemNoVisible((prev) => prev || responseRequestedItemNo);
        applyRequestedVisibilityToGrid(mergedVisibility, mergedItemNoVisible, { force: true, defer: true });
      }
    } else {
      const hasRequestedItemInRows = (response?.rows ?? []).some((row) => normalizeRequestedItemNoValue(
        (row as Record<string, unknown>)?.RequestedItemNo ?? null,
      ) != null);
      const responseRequestedItemNo = Boolean(response?.requestedColumns?.RequestedItemNo) || hasRequestedItemInRows;
      const freshVisibility = REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
        (acc, key) => {
          acc[key] = Boolean(response?.requestedColumns?.[key]);
          return acc;
        },
        {} as Record<RequestedDisplayFieldKey, boolean>,
      );
      if (isFirstPage) {
        // First page: OR-merge with previous visibility so columns that were already
        // visible stay visible across grid refreshes (e.g. after a cell edit triggers
        // refreshServerSide).  On the very first load the previous state is all-false,
        // so this is equivalent to a full reset — empty columns are still hidden on launch.
        const useFresh = forceFreshRequestedVisibilityRef.current;
        const previousVisibility = appliedRequestedColumnVisibilityRef.current ?? requestedColumnVisibility;
        const mergedVisibility = useFresh
          ? freshVisibility
          : REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
              (acc, key) => {
                acc[key] = Boolean(previousVisibility?.[key]) || freshVisibility[key];
                return acc;
              },
              {} as Record<RequestedDisplayFieldKey, boolean>,
            );
        setRequestedColumnVisibility((prev) => {
          const hasChanged = REQUESTED_DISPLAY_FIELD_KEYS.some((key) => prev[key] !== mergedVisibility[key]);
          return hasChanged ? mergedVisibility : prev;
        });
        const mergedItemNoVisible = useFresh
          ? responseRequestedItemNo
          : (appliedRequestedItemNoVisibleRef.current ?? requestedItemNoVisible) || responseRequestedItemNo;
        setRequestedItemNoVisible(mergedItemNoVisible);
        applyRequestedVisibilityToGrid(mergedVisibility, mergedItemNoVisible, { force: true, defer: true });
        if (useFresh) forceFreshRequestedVisibilityRef.current = false;
      } else {
        // Subsequent pages: OR-merge so columns don't disappear while scrolling.
        const previousVisibility = appliedRequestedColumnVisibilityRef.current ?? requestedColumnVisibility;
        const mergedVisibility = REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
          (acc, key) => {
            const fromResponse = response?.requestedColumns?.[key];
            const previous = Boolean(previousVisibility?.[key]);
            acc[key] = previous || Boolean(fromResponse);
            return acc;
          },
          {} as Record<RequestedDisplayFieldKey, boolean>,
        );
        const mergedItemNoVisible = (appliedRequestedItemNoVisibleRef.current ?? requestedItemNoVisible) || responseRequestedItemNo;
        applyRequestedColumnVisibility(mergedVisibility, true);
        setRequestedItemNoVisible((prev) => prev || responseRequestedItemNo);
        applyRequestedVisibilityToGrid(mergedVisibility, mergedItemNoVisible, { force: true, defer: true });
      }
    }
    // Auto-hide NetCostOtherCurrency and CurrencyCostModifier when all rows have cost in offer currency
    {
      const rows = Array.isArray(response?.rows) ? response.rows as Array<Record<string, unknown>> : [];
      const pageHasOtherCurrency = rows.some((row) => {
        const name = typeof row?.OtherCurrencyName === 'string' ? row.OtherCurrencyName.trim() : '';
        return name.length > 0;
      });
      if (isFirstPage) {
        hasNonEuroCostCurrencyRef.current = pageHasOtherCurrency;
      } else {
        hasNonEuroCostCurrencyRef.current = hasNonEuroCostCurrencyRef.current || pageHasOtherCurrency;
      }
      const api = gridApiRef.current;
      if (api && isFirstPage) {
        const showCostCurrencyCols = hasNonEuroCostCurrencyRef.current;
        api.applyColumnState({
          state: [
            { colId: 'NetCostOtherCurrency', hide: !showCostCurrencyCols },
            { colId: 'CurrencyCostModifier', hide: !showCostCurrencyCols },
          ],
          applyOrder: false,
        });
      }
    }
    const runHeavyUpdates = () => {
      scheduleCategoryAncestorsUpdate();
    };
    const shouldDeferHeavy = hasRows && deferInitialHeavyWorkRef.current;
    if (shouldDeferHeavy && typeof window !== 'undefined') {
      deferInitialHeavyWorkRef.current = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(runHeavyUpdates);
      });
    } else {
      deferInitialHeavyWorkRef.current = false;
      runHeavyUpdates();
    }
  }, [
    applyRequestedVisibilityToGrid,
    applyRequestedColumnVisibility,
    paintFlashCells,
    rebuildDisplayOrderingMap,
    rebuildTreeOrderingRootMap,
    requestedColumnVisibility,
    requestedItemNoVisible,
    scheduleCategoryAncestorsUpdate,
    showRequestedColumns,
    stopFlash,
    tableLayout,
  ]);

  const handleServerRequest = useCallback((request: ServerRequestWithQuickFilter) => {
    lastRequestStartRef.current = performance.now();
    lastServerRequestRef.current = request;
  }, []);

  const [gridReadyApi, setGridReadyApi] = useState<GridApi<Record<string, unknown>> | null>(null);
  const lastClickedRowRef = useRef<Record<string, unknown> | null>(null);
  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    gridApiRef.current = api;
    setGridReadyApi(api);

    // Track the last clicked row for "Fill row" functionality
    api.addEventListener('rowClicked', ((event: { data?: Record<string, unknown> }) => {
      lastClickedRowRef.current = event.data ?? null;
    }) as unknown as (event: unknown) => void);

    // Real-time updates are handled by useRealtimeGridUpdates hook below
    setRequestedColumnsReadyFlag(true);
  }, [setRequestedColumnsReadyFlag]);
  const selectedRowHighlightRef = useRef<HTMLElement[]>([]);
  const selectedRowIdRef = useRef<number | null>(null);
  const selectedRowHighlightIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearSelectedRowHighlight = useCallback(() => {
    for (const el of selectedRowHighlightRef.current) {
      el.style.removeProperty('background-color');
    }
    selectedRowHighlightRef.current = [];
    selectedRowIdRef.current = null;
    if (selectedRowHighlightIntervalRef.current) {
      clearInterval(selectedRowHighlightIntervalRef.current);
      selectedRowHighlightIntervalRef.current = null;
    }
  }, []);

  const applySelectedRowHighlight = useCallback(() => {
    const rowId = selectedRowIdRef.current;
    if (rowId == null) return;
    const wrapper = gridWrapperRef.current;
    const api = gridApiRef.current;
    if (!wrapper || !api || api.isDestroyed?.()) return;
    // Clear previous
    for (const el of selectedRowHighlightRef.current) el.style.removeProperty('background-color');
    selectedRowHighlightRef.current = [];
    // Find target row-index from any visible row
    let targetIdx: string | null = null;
    const anyRows = wrapper.querySelectorAll('.ag-row');
    for (const agRow of anyRows) {
      const idx = agRow.getAttribute('row-index');
      if (idx == null) continue;
      const node = api.getDisplayedRowAtIndex(Number.parseInt(idx, 10));
      const id = normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown } | null)?.OfferDetailID ?? null);
      if (id === rowId) { targetIdx = idx; break; }
    }
    if (targetIdx == null) return;
    // Paint ALL row elements with this row-index across all containers
    const allRowEls = wrapper.querySelectorAll(`.ag-row[row-index="${targetIdx}"]`);
    for (const rowEl of allRowEls) {
      const cells = (rowEl as HTMLElement).querySelectorAll(':scope > .ag-cell');
      for (const cell of cells) {
        const colId = cell.getAttribute('col-id') ?? '';
        if (colId.startsWith('Requested')
          || colId === 'ag-Grid-AutoColumn'
          || colId === ''
          || cell.classList.contains('ag-selection-checkbox')
          || cell.querySelector('.ag-selection-checkbox, .ag-row-drag, .ag-drag-handle')
        ) continue;
        (cell as HTMLElement).style.setProperty('background-color', '#93c5fd', 'important');
        selectedRowHighlightRef.current.push(cell as HTMLElement);
      }
    }
  }, []);

  const handleMainGridSelectionChanged = useCallback((rows: Record<string, unknown>[]) => {
    if (!rows || rows.length === 0) {
      clearSelectedRowHighlight();
      onMainGridSelectionChanged?.(null);
      return;
    }
    // Use the last row in the array — with multi-select+click, the most recent click
    // appends to the end of the selected rows array from forEachNode (display order).
    // For single clicks (after deselectAll), there's only one row.
    const row = rows[rows.length - 1];
    if (!row) {
      onMainGridSelectionChanged?.(null);
      return;
    }
    const offerDetailId = normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
    if (offerDetailId == null) {
      onMainGridSelectionChanged?.(null);
      return;
    }
    const treeOrderingRaw = (row as { TreeOrdering?: unknown }).TreeOrdering ?? null;
    const path = parseTreeOrderingPath(treeOrderingRaw);
    const treeOrdering = typeof treeOrderingRaw === 'string' ? treeOrderingRaw.trim() : buildTreeOrderingKey(path);
    const label = resolveRowLabel(row, '');
    const requested = isRequestedRow(row);
    const strField = (key: string) => {
      const v = (row as Record<string, unknown>)[key];
      return typeof v === 'string' ? v.trim() || null : null;
    };
    // Highlight the selected row's product columns (only when add products is open)
    clearSelectedRowHighlight();
    if (showInsertLineOnHover) {
      selectedRowIdRef.current = offerDetailId;
      applySelectedRowHighlight();
      selectedRowHighlightIntervalRef.current = setInterval(applySelectedRowHighlight, 200);
    }

    onMainGridSelectionChanged?.({
      offerDetailId,
      treeOrdering,
      label,
      isRequested: requested,
      parentPath: path.slice(0, -1),
      requestedBrand: strField('RequestedBrand'),
      requestedPartNo: strField('RequestedPartNo'),
      requestedModelNo: strField('RequestedModelNo'),
      requestedDescription: strField('RequestedDescription'),
    });
  }, [onMainGridSelectionChanged, clearSelectedRowHighlight, applySelectedRowHighlight, showInsertLineOnHover]);

  // Called by AgGridAll after it restores persisted column state (hide/show/width).
  // AgGridAll may restore stale hide:true values for req columns from a previous session.
  // Resetting the applied-visibility ref forces the next reapply call to re-apply the
  // correct data-driven visibility, overriding whatever AgGridAll just restored.
  const forceReapplyRequestedColumnsVisibility = useCallback(() => {
    appliedRequestedColumnVisibilityRef.current = null;
    appliedRequestedItemNoVisibleRef.current = null;
    reapplyRequestedColumnsVisibility({ defer: true });
  }, [reapplyRequestedColumnsVisibility]);
  const forceReapplyRef = useRef(forceReapplyRequestedColumnsVisibility);
  forceReapplyRef.current = forceReapplyRequestedColumnsVisibility;
  const handleColumnStateRestored = useCallback(() => {
    forceReapplyRequestedColumnsVisibility();
  }, [forceReapplyRequestedColumnsVisibility]);

  const saveLayout = useCallback((options?: { silent?: boolean }) => {
    if (typeof window === 'undefined') return false;
    if (!columnStateStorageKey) return false;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      if (!options?.silent) {
        showToastMessage('Unable to save layout. Please try again.', 'error');
      }
      return false;
    }
    const currentState = api.getColumnState();
    const columnOrderMap = new Map<string, number>();
    const displayedOrder = (typeof api.getAllDisplayedColumns === 'function'
      ? api.getAllDisplayedColumns()
      : [])
      .map((column) => (typeof column.getColId === 'function' ? column.getColId() : ''))
      .filter((colId) => colId);
    const currentOrder = currentState
      .map((entry) => (typeof entry.colId === 'string' ? entry.colId : ''))
      .filter((colId) => colId);
    const visibleOrderSource = displayedOrder;
    const visibleSet = new Set(visibleOrderSource);
    const visibleQueue = visibleOrderSource.filter((colId) => currentOrder.includes(colId));
    const mergedOrder = currentOrder.map((colId) => (visibleSet.has(colId) ? visibleQueue.shift() ?? colId : colId));
    mergedOrder.forEach((colId, index) => {
      if (colId) columnOrderMap.set(colId, index);
    });

    // Some AG Grid configurations (and some column types) can yield column state entries
    // without a reliable `width`, even though the UI is clearly showing custom widths.
    // If we persist a layout without widths, the grid will fall back to default widths.
    //
    // To prevent that, we always fill missing widths from:
    // - the live column actual widths (preferred)
    // - the previously saved widths (fallback)
    const existingWidthByColId = new Map<string, number>();
    try {
      const rawExisting = window.localStorage.getItem(columnStateStorageKey);
      if (rawExisting) {
        const parsedExisting = JSON.parse(rawExisting) as { columns?: Array<{ colId?: unknown; width?: unknown }> } | null;
        if (parsedExisting && Array.isArray(parsedExisting.columns)) {
          parsedExisting.columns.forEach((entry) => {
            const colId = typeof entry?.colId === 'string' ? entry.colId : '';
            const width = typeof entry?.width === 'number' ? entry.width : null;
            if (colId && width != null && Number.isFinite(width) && width > 0) {
              existingWidthByColId.set(colId, width);
            }
          });
        }
      }
    } catch {
      /* noop */
    }

    const actualWidthByColId = new Map<string, number>();
    try {
      const apiWithAllGridColumns = api as unknown as {
        getAllGridColumns?: () => Array<{ getColId?: () => string; getActualWidth?: () => number }>;
      };
      const columns = typeof apiWithAllGridColumns.getAllGridColumns === 'function'
        ? apiWithAllGridColumns.getAllGridColumns()
        : (typeof api.getAllDisplayedColumns === 'function' ? api.getAllDisplayedColumns() : []);
      if (Array.isArray(columns)) {
        columns.forEach((column) => {
          const colId = typeof column?.getColId === 'function' ? column.getColId() : '';
          const width = typeof column?.getActualWidth === 'function' ? column.getActualWidth() : null;
          if (colId && width != null && Number.isFinite(width) && width > 0) {
            actualWidthByColId.set(colId, width);
          }
        });
      }
    } catch {
      /* noop */
    }

    const reqColumnIdSet = new Set<string>(['RequestedItemNo', ...REQUESTED_DISPLAY_FIELD_KEYS]);
    const nextState = collectPersistableColumnState(currentState, columnOrderMap).map((entry) => {
      const widthCandidate = typeof entry.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
        ? entry.width
        : actualWidthByColId.get(entry.colId) ?? existingWidthByColId.get(entry.colId);
      const withWidth = widthCandidate != null && Number.isFinite(widthCandidate) && widthCandidate > 0
        ? { ...entry, width: widthCandidate }
        : entry;
      // Never persist hide state for req columns — their visibility is always driven
      // by data (requestedColumns from the API) and managed by the visibility effect.
      // Persisting hide would cause applySavedColumnState to override the effect on load.
      if (reqColumnIdSet.has(withWidth.colId)) {
        const { hide: _hide, ...withoutHide } = withWidth;
        void _hide;
        return withoutHide;
      }
      return withWidth;
    });
    // Derive fingerprint from the grid's live column IDs so saved state
    // auto-invalidates when columns are added or removed.
    const liveColIds: string[] = [];
    try {
      const allCols = (api as unknown as { getAllGridColumns?: () => Array<{ getColId?: () => string }> }).getAllGridColumns?.();
      if (Array.isArray(allCols)) {
        allCols.forEach((col) => {
          const id = typeof col?.getColId === 'function' ? col.getColId() : '';
          if (id) liveColIds.push(id);
        });
      }
    } catch { /* noop */ }
    const fingerprint = liveColIds.length > 0 ? liveColIds.sort().join('|') : undefined;
    writePersistedColumnState(columnStateStorageKey, nextState, fingerprint);
    if (!options?.silent) {
      showToastMessage('Layout saved', 'success');
    }
    return true;
  }, [columnStateStorageKey]);

  const autoSaveTimerRef = useRef<number | null>(null);
  const queueAutoSaveLayout = useCallback(() => {
    if (typeof window === 'undefined') return;
    if (autoSaveTimerRef.current) {
      window.clearTimeout(autoSaveTimerRef.current);
    }
    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      saveLayout({ silent: true });
    }, 200);
  }, [saveLayout]);

  const shouldAutoSaveFromColumnEvent = useCallback((source: ColumnEventType) => (
    source.startsWith('ui')
    || source === 'toolPanelUi'
    || source === 'toolPanelDragAndDrop'
    || source === 'columnMenu'
    || source === 'contextMenu'
  ), []);

  useEffect(() => () => {
    if (autoSaveTimerRef.current && typeof window !== 'undefined') {
      window.clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    const api = gridReadyApi;
    if (!api || api.isDestroyed?.()) return undefined;

    const handleColumnMoved = (event: ColumnMovedEvent<Record<string, unknown>>) => {
      if (!event.finished) return;
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };
    const handleColumnResized = (event: ColumnResizedEvent<Record<string, unknown>>) => {
      if (!event.finished) return;
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };
    const handleColumnVisible = (event: ColumnVisibleEvent<Record<string, unknown>>) => {
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };
    const handleColumnPinned = (event: ColumnPinnedEvent<Record<string, unknown>>) => {
      if (!shouldAutoSaveFromColumnEvent(event.source)) return;
      queueAutoSaveLayout();
    };

    api.addEventListener('columnMoved', handleColumnMoved);
    api.addEventListener('columnResized', handleColumnResized);
    api.addEventListener('columnVisible', handleColumnVisible);
    api.addEventListener('columnPinned', handleColumnPinned);

    return () => {
      if (api.isDestroyed?.()) return;
      api.removeEventListener('columnMoved', handleColumnMoved);
      api.removeEventListener('columnResized', handleColumnResized);
      api.removeEventListener('columnVisible', handleColumnVisible);
      api.removeEventListener('columnPinned', handleColumnPinned);
    };
  }, [gridReadyApi, queueAutoSaveLayout, shouldAutoSaveFromColumnEvent]);

  const isCategoryRowCollapsed = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!row) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    return key.length > 0 && collapsedCategoryPaths.has(key);
  }, [collapsedCategoryPaths]);

  const hasCategoryChildren = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    if (!categoryChildrenKnown) return true;
    return key.length > 0 && categoryPathsWithChildren.has(key);
  }, [categoryChildrenKnown, categoryPathsWithChildren]);

  const isCategoryRowCollapsedForRenderer = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!row) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    return key.length > 0 && collapsedCategoryPathsRef.current.has(key);
  }, []);

  const hasCategoryChildrenForRenderer = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    if (!categoryChildrenKnownRef.current) return true;
    return key.length > 0 && categoryPathsWithChildrenRef.current.has(key);
  }, []);

  const hasCollapsedAncestorInSet = useCallback((path: number[], collapsedSet: Set<string>) => {
    for (let idx = 1; idx < path.length; idx += 1) {
      const ancestorKey = buildTreeOrderingKey(path.slice(0, idx));
      if (ancestorKey && collapsedSet.has(ancestorKey)) {
        return true;
      }
    }
    return false;
  }, []);

  const filterServerRow = useCallback((row: Record<string, unknown>) => {
    const collapsed = collapsedCategoryPathsRef.current;
    if (collapsed.size === 0) return true;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return true;
    return !hasCollapsedAncestorInSet(path, collapsed);
  }, [hasCollapsedAncestorInSet]);

  const determineRowHeight = useCallback((params: { data?: Record<string, unknown> }) => {
    const row = params.data;
    if (!row) return DEFAULT_ROW_HEIGHT;

    // Cells use whiteSpace: 'pre' (no soft-wrapping), so line count == newlines + 1.
    // Pre-computing height from the string is ~free; letting AG Grid auto-measure
    // the DOM caused scroll lag on pages with multiline rows.
    const MULTILINE_LINE_PX = 21; // 14px font * 1.5 line-height
    const MULTILINE_PADDING_PX = 11;

    const fields: Array<unknown> = [
      row.ProductDescription,
      row.Description,
      row.Comment,
      row.RequestedDescription,
      row.RequestedDescription2,
      row.RequestedDescription3,
    ];

    let maxLines = 1;
    for (const value of fields) {
      if (typeof value !== 'string' || value.length === 0) continue;
      let lines = 1;
      for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) === 10) lines++;
      }
      if (lines > maxLines) maxLines = lines;
    }

    if (maxLines === 1) return DEFAULT_ROW_HEIGHT;
    return Math.max(
      DEFAULT_ROW_HEIGHT,
      maxLines * MULTILINE_LINE_PX + MULTILINE_PADDING_PX,
    );
  }, []);

  const getRowHeight = useCallback(
    (params: { data?: Record<string, unknown> }) => determineRowHeight(params),
    [determineRowHeight],
  );

  const pendingInitialSelectionRestoreRef = useRef<(() => void) | null>(null);
  const modelUpdateRafRef = useRef<number | null>(null);
  const pendingInitialViewportScrollTopRef = useRef<number | null>(
    typeof initialViewportScrollTop === 'number' ? initialViewportScrollTop : null,
  );
  const initialViewportScrollRestoredRef = useRef(false);

  const getGridViewportElement = useCallback((): HTMLElement | null => {
    const root = gridWrapperRef.current;
    if (!root) return null;
    return root.querySelector('.ag-body-viewport, .ag-center-cols-viewport');
  }, []);

  const tryRestoreInitialViewportScroll = useCallback(() => {
    if (initialViewportScrollRestoredRef.current) return;
    const scrollTop = pendingInitialViewportScrollTopRef.current;
    if (typeof scrollTop !== 'number') return;
    const viewport = getGridViewportElement();
    if (!viewport) return;
    const restore = () => {
      const currentViewport = getGridViewportElement();
      if (!currentViewport) return;
      currentViewport.scrollTop = scrollTop;
    };
    requestAnimationFrame(() => requestAnimationFrame(restore));
    window.setTimeout(restore, 60);
    initialViewportScrollRestoredRef.current = true;
    pendingInitialViewportScrollTopRef.current = null;
  }, [getGridViewportElement]);

  useEffect(() => {
    pendingInitialViewportScrollTopRef.current = typeof initialViewportScrollTop === 'number'
      ? initialViewportScrollTop
      : null;
    initialViewportScrollRestoredRef.current = false;
  }, [initialViewportScrollTop]);

  useEffect(() => {
    if (!gridReadyApi || gridReadyApi.isDestroyed?.()) return;
    tryRestoreInitialViewportScroll();
  }, [gridReadyApi, tryRestoreInitialViewportScroll]);

  useEffect(() => () => {
    if (typeof window === 'undefined') return;
    if (modelUpdateRafRef.current != null) {
      window.cancelAnimationFrame(modelUpdateRafRef.current);
      modelUpdateRafRef.current = null;
    }
  }, []);

  const removeCollapsedDescendantsFromGrid = useCallback((collapsedSet: Set<string>) => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    if (collapsedSet.size === 0) return;
    const rowsToRemove: Array<Record<string, unknown>> = [];
    api.forEachNode((node) => {
      const row = node.data ?? null;
      if (!row) return;
      const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      if (path.length === 0) return;
      if (hasCollapsedAncestorInSet(path, collapsedSet)) {
        rowsToRemove.push(row);
      }
    });
    if (rowsToRemove.length > 0) {
      try {
        api.applyServerSideTransaction({ remove: rowsToRemove });
      } catch {
        /* noop */
      }
    }
  }, [hasCollapsedAncestorInSet]);

  const handleGridModelUpdated = useCallback(() => {
    if (skipModelUpdateRef.current) {
      skipModelUpdateRef.current = false;
      return;
    }
    const skipUntil = collapseSkipUntilRef.current;
    if (typeof skipUntil === 'number' && Date.now() <= skipUntil) {
      return;
    }
    scheduleCategoryAncestorsUpdate();
    if (modelUpdateRafRef.current != null || typeof window === 'undefined') return;
    modelUpdateRafRef.current = window.requestAnimationFrame(() => {
      modelUpdateRafRef.current = null;
      // Force-reapply requested column visibility on every model update.
      // AG Grid may internally revert columns to their definition state (hide: true)
      // after certain operations (e.g. setDataValue, applyServerSideTransaction).
      // Without force, the applied-visibility refs may think the columns are already
      // visible and skip re-applying, leaving them hidden.
      forceReapplyRef.current();
      pendingInitialSelectionRestoreRef.current?.();
      tryRestoreInitialViewportScroll();
      // Restore grid viewport scroll after refreshOfferProductGrid-triggered refreshes
      const restoreTop = pendingGridScrollRestoreRef.current;
      if (restoreTop != null) {
        const viewport = getGridViewportElement();
        if (viewport) {
          viewport.scrollTop = restoreTop;
          if (viewport.scrollTop > 0 || restoreTop === 0) {
            pendingGridScrollRestoreRef.current = null;
          }
        }
      }
      // When the add-products modal is open and no insertion point is pinned,
      // auto-show the insertion line below the last row so the user sees where
      // a new product will be appended.
      if (showInsertLineOnHoverRef.current && !insertLinePinnedRef.current) {
        setInsertLineVisibleRef.current?.(true, true);
      }
      // AgGridAll hides the floating filter row while the grid is empty; the
      // resulting layout shift when rows arrive/disappear leaves the pinned
      // line's cached top at a stale position (ending up on the first product
      // instead of below it). After any row-count change while the add modal
      // is open, recompute the at-end pin once the filter row DOM change has
      // settled. A short timeout is more reliable than double-RAF because AG
      // Grid + React need time to commit the filter-row visibility flip.
      const api = gridApiRef.current;
      const currentRowCount = api && !api.isDestroyed?.() ? api.getDisplayedRowCount() : 0;
      const prevRowCount = prevDisplayedRowCountRef.current;
      prevDisplayedRowCountRef.current = currentRowCount;
      if (currentRowCount !== prevRowCount && showInsertLineOnHoverRef.current) {
        const repin = () => {
          if (!showInsertLineOnHoverRef.current) return;
          // Never override a pin that's anchored to a specific row.
          if (insertLinePinnedRef.current && !insertLinePinnedAtEndRef.current) return;
          setInsertLineVisibleRef.current?.(true, true);
        };
        window.setTimeout(repin, 80);
        window.setTimeout(repin, 220);
      }
    });
  }, [getGridViewportElement, scheduleCategoryAncestorsUpdate, tryRestoreInitialViewportScroll]);

  const toggleCategoryCollapsed = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return;
    if (!hasCategoryChildren(row)) return;
    collapseSkipUntilRef.current = Date.now() + 200;
    skipModelUpdateRef.current = true;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return;
    const key = buildTreeOrderingKey(path);
    if (!key) return;
    setCollapsedCategoryPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [hasCategoryChildren]);
  toggleCategoryCollapsedRef.current = toggleCategoryCollapsed;

  const pendingFlashIdsRef = useRef<Set<number> | null>(null);

  const getRowClass = useCallback((params: RowClassParams<Record<string, unknown>>) => {
    const rowType = resolveOfferProductRowType(params.data);
    let baseClass: string | undefined;
    switch (rowType) {
      case 'category':
        baseClass = 'offer-row offer-row--category';
        break;
      case 'product':
        baseClass = 'offer-row offer-row--product';
        break;
      case 'printable-comment':
        baseClass = 'offer-row offer-row--printable-comment';
        break;
      case 'non-printable-comment':
        baseClass = 'offer-row offer-row--nonprintable-comment';
        break;
      default:
        baseClass = undefined;
    }
    const classes: string[] = [];
    if (baseClass) {
      classes.push(baseClass);
      if (rowType === 'category') {
        if (isCategoryRowCollapsed(params.data)) {
          classes.push('offer-row--category-collapsed');
        }
        if (!hasCategoryChildren(params.data)) {
          classes.push('offer-row--category-empty');
        }
      }
    }
    if (classes.length === 0) {
      return undefined;
    }
    return classes.join(' ');
  }, [isCategoryRowCollapsed, hasCategoryChildren]);

  const handleRowDoubleClicked = useCallback((params: RowDoubleClickedEvent<Record<string, unknown>>) => {
    const target = params.event?.target;
    if (target instanceof Element) {
      const isDescriptionCell = Boolean(target.closest('[col-id="Description"]'));
      const isRequestedDescriptionCell = Boolean(target.closest('[col-id="RequestedDescription"]'));
      const isRequestedDescription2Cell = Boolean(target.closest('[col-id="RequestedDescription2"]'));
      const isRequestedDescription3Cell = Boolean(target.closest('[col-id="RequestedDescription3"]'));
      if (isDescriptionCell || isRequestedDescriptionCell || isRequestedDescription2Cell || isRequestedDescription3Cell) {
        // Prevent collapsing the category when double-clicking a description cell.
        return;
      }
    }
    toggleCategoryCollapsed(params.data ?? null);
  }, [toggleCategoryCollapsed]);

  const TreeOrderingCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const rawValue = params.value ?? (params.data as { TreeOrdering?: unknown } | undefined)?.TreeOrdering ?? null;
    formatDisplayTreeOrdering(rawValue); // side-effect: keep treeOrderingRootMapRef updated
    const rowData = params.data ?? null;
    const isCategory = isOfferProductCategory(rowData);
    const shouldShowIndicator = isCategory;
    const hasChildren = isCategory && hasCategoryChildrenForRenderer(rowData);
    const collapsed = isCategory && isCategoryRowCollapsedForRenderer(rowData);
    const indicator = shouldShowIndicator
      ? hasChildren
        ? (collapsed ? '▸' : '▾')
        : '•'
      : null;
    const indicatorClass = shouldShowIndicator
      ? hasChildren
        ? `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorArrow}`
        : `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorEmpty}`
      : undefined;

    const handleIndicatorClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (hasChildren) {
        toggleCategoryCollapsedRef.current(rowData);
      }
    };

    const indicatorLabel = hasChildren
      ? (collapsed ? 'Expand category' : 'Collapse category')
      : 'Category without child entries';

    const rowType = resolveOfferProductRowType(rowData);
    let display: string;
    if (rowType === 'non-printable-comment') {
      display = '';
    } else {
      const actualKey = rawValue != null ? String(rawValue).trim() : '';
      display = actualKey
        ? (displayOrderingMapRef.current.get(actualKey) ?? formatDisplayTreeOrdering(rawValue))
        : formatDisplayTreeOrdering(rawValue);
    }
    return (
      <span className={styles.treeOrderingCell}>
        {indicator && (
          <button
            type="button"
            className={`${styles.treeOrderingIndicatorButton} ${indicatorClass ?? ''}`.trim()}
            onClick={handleIndicatorClick}
            aria-label={indicatorLabel}
            disabled={!hasChildren}
          >
            {indicator}
          </button>
        )}
        <span className={styles.treeOrderingText}>{display}</span>
      </span>
    );
  }, [formatDisplayTreeOrdering, hasCategoryChildrenForRenderer, isCategoryRowCollapsedForRenderer]);

const RequestedItemNoCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
  const value = params.value;
  const rowData = params.data ?? null;
  const isCategory = isOfferProductCategory(rowData);
  const shouldShowIndicator = isCategory && isRequestedRow(rowData);
  const hasChildren = shouldShowIndicator && hasCategoryChildrenForRenderer(rowData);
  const collapsed = shouldShowIndicator && isCategoryRowCollapsedForRenderer(rowData);
  const indicator = shouldShowIndicator
    ? hasChildren
      ? (collapsed ? '▸' : '▾')
      : '•'
    : null;
  const indicatorClass = shouldShowIndicator
    ? hasChildren
      ? `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorArrow}`
      : `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorEmpty}`
    : undefined;

    const handleIndicatorClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (hasChildren) {
        toggleCategoryCollapsedRef.current(rowData);
      }
    };

    const indicatorLabel = hasChildren
      ? (collapsed ? 'Expand category' : 'Collapse category')
      : 'Category without child entries';

    return (
      <span className={styles.treeOrderingCell}>
        {indicator && (
          <button
            type="button"
            className={`${styles.treeOrderingIndicatorButton} ${indicatorClass ?? ''}`.trim()}
            onClick={handleIndicatorClick}
            aria-label={indicatorLabel}
            disabled={!hasChildren}
          >
            {indicator}
          </button>
        )}
        <span className={styles.treeOrderingText}>{value ?? ''}</span>
      </span>
    );
  }, [hasCategoryChildrenForRenderer, isCategoryRowCollapsedForRenderer]);

const PartNumberCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const rawValue = params.value;
    if (rawValue == null) return '';
    const partNumber = String(rawValue).trim();
    if (!partNumber) return '';

    const rawLink = (params.data as { WebLink?: string | null } | undefined)?.WebLink;
    const normalizedLink = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!normalizedLink) return partNumber;

    const stopLink = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <a
        href={normalizedLink}
        target="_blank"
        rel="noreferrer noopener"
        className={styles.partNumberLink}
        onClick={stopLink}
        onMouseDown={stopLink}
        onDoubleClick={stopLink}
        onContextMenu={stopLink}
        title="Open product link"
      >
        {partNumber}
      </a>
    );
}, []);

const ModelNumberCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const rawValue = params.value;
    if (rawValue == null) return '';
    const modelNumber = String(rawValue).trim();
    if (!modelNumber) return '';

    // Only show link if PartNumber is empty
    const partNumberRaw = (params.data as { PartNumber?: unknown } | undefined)?.PartNumber;
    const partNumber = typeof partNumberRaw === 'string' ? partNumberRaw.trim() : '';
    if (partNumber) return modelNumber; // PartNumber exists, don't show link on ModelNumber

    const rawLink = (params.data as { WebLink?: string | null } | undefined)?.WebLink;
    const normalizedLink = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!normalizedLink) return modelNumber;

    const stopLink = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <a
        href={normalizedLink}
        target="_blank"
        rel="noreferrer noopener"
        className={styles.partNumberLink}
        onClick={stopLink}
        onMouseDown={stopLink}
        onDoubleClick={stopLink}
        onContextMenu={stopLink}
        title="Open product link"
      >
        {modelNumber}
      </a>
    );
}, []);

  const REQUESTED_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--requested';
  const ACTUAL_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--actual';
  const TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS = 'offer-products-grid__cell--truncate';
  const truncateCellStyle = useMemo(
    () => ({
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      display: 'flex',
      alignItems: 'center',
      minWidth: 0,
    } as const),
    [],
  );

  const actualNumericCellClass = useMemo(
    () => [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS, 'ag-right-aligned'],
    [],
  );
  const actualNumericCellStyle = useMemo(
    () => ({
      ...truncateCellStyle,
      justifyContent: 'flex-end',
      textAlign: 'right',
    } as const),
    [truncateCellStyle],
  );

  const requestedCellClassRules = useMemo(() => ({
    [styles.requestedColumnCell]: (params: { data?: Record<string, unknown> | null }) =>
      isOfferProductCategory(params.data ?? null),
    [REQUESTED_COLUMN_GLOBAL_CLASS]: (params: { data?: Record<string, unknown> | null }) =>
      isOfferProductCategory(params.data ?? null),
  }), []);

  const clearRequestedFlags = useCallback((node: GridRowNode | null) => {
    if (!node) return;
    try {
      node.setDataValue('__isRequestedRow', 0);
    } catch {
      /* noop */
    }
  }, []);

  const refreshRowNodes = useCallback((node: GridRowNode | null) => {
    if (!node) return;
    const api = gridApiRef.current;
    if (!api) return;
    try {
      api.refreshCells({ rowNodes: [node], force: true });
    } catch {
      /* noop */
    }
  }, []);

  const promoteNodeToCategory = useCallback((
    node: GridRowNode | null,
    treeOrdering: string | null,
    description: string | null,
    requestedItemNo: string | null = null,
  ) => {
    if (!node) return;
    try {
      node.setDataValue('IsCategory', 1);
      node.setDataValue('IsComment', false);
      node.setDataValue('IsPrintable', null);
    } catch {
      /* noop */
    }
    clearRequestedFlags(node);
    if (treeOrdering != null) {
      try {
        node.setDataValue('TreeOrdering', treeOrdering);
      } catch {
        /* noop */
      }
    }
    if (requestedItemNo != null) {
      try {
        node.setDataValue('RequestedItemNo', requestedItemNo);
      } catch {
        /* noop */
      }
    }
    if (description != null) {
      try {
        node.setDataValue('Description', description, 'api');
      } catch {
        /* noop */
      }
    }
    refreshRowNodes(node);
  }, [clearRequestedFlags, refreshRowNodes]);

  const promoteNodeToProduct = useCallback((
    node: GridRowNode | null,
    productMeta: ProductSummary,
    partNumber: string | null,
    modelNumber: string | null,
    brandName: string | null,
    description: string | null,
  ) => {
    if (!node) return;
    try {
      node.setDataValue('IsCategory', 0);
      node.setDataValue('ProductID', productMeta.ProductID);
    } catch {
      /* noop */
    }
    clearRequestedFlags(node);
    try {
      node.setDataValue('PartNumber', partNumber ?? null);
      node.setDataValue('ModelNumber', modelNumber ?? null);
      node.setDataValue('BrandName', brandName ?? null);
      node.setDataValue('ProductDescription', description ?? null, 'api');
      node.setDataValue('Description', description ?? null, 'api');
    } catch {
      /* noop */
    }
    refreshRowNodes(node);
  }, [clearRequestedFlags, refreshRowNodes]);

const requestedColumnDefsMap = useMemo(
    () => buildRequestedColumnDefsMap({ requestedCellClassRules, truncateCellStyle, actualNumericCellStyle }),
    [actualNumericCellStyle, requestedCellClassRules, truncateCellStyle],
  );

  const productColumnDefs: ColDef[] = useMemo(() => buildProductColumnDefs({
      standardPackageMode,
      manualMode,
      showRequestedColumns,
      requestedColumnDefsMap,
      requestedCellClassRules,
      requestedColumnVisibility,
      requestedItemNoVisible,
      savedHiddenMap,
      savedColumnOrder,
      truncateCellStyle,
      actualNumericCellClass,
      actualNumericCellStyle,
      TreeOrderingCell,
      PartNumberCell,
      ModelNumberCell,
      RequestedItemNoCell,
      offerCurrencySymbol: offerCurrencyName ?? '€',
    }), [
    actualNumericCellClass,
    actualNumericCellStyle,
    PartNumberCell,
    ModelNumberCell,
    manualMode,
    TreeOrderingCell,
    requestedColumnDefsMap,
    RequestedItemNoCell,
    requestedCellClassRules,
    requestedColumnVisibility,
    requestedItemNoVisible,
    savedHiddenMap,
    showRequestedColumns,
    standardPackageMode,
    savedColumnOrder,
    truncateCellStyle,
    offerCurrencyName,
  ]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    api.refreshCells({ force: true });
  }, [offerCurrencyName]);


  const pendingGridScrollRestoreRef = useRef<number | null>(null);

  const refreshOfferProductGrid = useCallback((api: GridApi<Record<string, unknown>> | null, options?: { refresh?: boolean; purge?: boolean; redraw?: boolean }) => {
    const targetApi = api ?? gridApiRef.current;
    if (!targetApi) return;
    const shouldRefresh = options?.refresh ?? true;
    const shouldRedraw = options?.redraw ?? false;
    if (shouldRefresh && typeof targetApi.refreshServerSide === 'function') {
      // Save grid viewport scroll before refresh so it can be restored after data loads
      const viewport = getGridViewportElement();
      if (viewport) {
        pendingGridScrollRestoreRef.current = viewport.scrollTop;
      }
      const requestedPurge = options?.purge ?? false;
      if (pendingRefreshPurgeRef.current == null) {
        pendingRefreshPurgeRef.current = requestedPurge;
      } else {
        pendingRefreshPurgeRef.current = pendingRefreshPurgeRef.current || requestedPurge;
      }
      if (!refreshScheduledRef.current) {
        refreshScheduledRef.current = true;
        Promise.resolve().then(() => {
          refreshScheduledRef.current = false;
          const apiForRefresh = gridApiRef.current;
          const purge = pendingRefreshPurgeRef.current ?? false;
          pendingRefreshPurgeRef.current = null;
          if (!apiForRefresh) return;
          try {
            apiForRefresh.refreshServerSide?.({ purge });
          } catch (err) {
            console.warn('Failed to refresh grid after row deletion', err);
          }
        });
      }
    }
    if (shouldRedraw) {
      try {
        targetApi.redrawRows();
      } catch (err) {
        console.warn('Failed to refresh category metadata after row deletion', err);
      }
    }
  }, [getGridViewportElement]);

  useEffect(() => {
    if (requestedMatchQueue.length === 0 && processedRequestedMatches !== 0) {
      setProcessedRequestedMatches(0);
    }
  }, [processedRequestedMatches, requestedMatchQueue.length]);

  // When the match queue empties (end of populate/skip flow), force-reapply
  // requested column visibility.  Something in the populate → modal → skip
  // lifecycle can leave the AG Grid column state out of sync with React state.
  const prevMatchQueueLengthRef = useRef(requestedMatchQueue.length);
  useEffect(() => {
    const prevLen = prevMatchQueueLengthRef.current;
    prevMatchQueueLengthRef.current = requestedMatchQueue.length;
    if (prevLen > 0 && requestedMatchQueue.length === 0) {
      // Queue just emptied — modal is closing.  Re-apply visibility immediately
      // and again after a RAF to cover any async AG Grid state drift.
      forceReapplyRequestedColumnsVisibility();
      if (typeof window !== 'undefined') {
        const rafId = window.requestAnimationFrame(() => {
          forceReapplyRequestedColumnsVisibility();
        });
        return () => window.cancelAnimationFrame(rafId);
      }
    }
    return undefined;
  }, [requestedMatchQueue.length, forceReapplyRequestedColumnsVisibility]);

  const previousCollapsedPathsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    const prev = previousCollapsedPathsRef.current;
    const next = collapsedCategoryPaths;
    const added = Array.from(next).filter((key) => !prev.has(key));
    const removed = Array.from(prev).filter((key) => !next.has(key));
    if (added.length > 0) {
      // Remove loaded descendants immediately, then refresh so the grid
      // re-fetches with the datasource filter active and gets a correct
      // rowCount (avoids "Loading" placeholders for unloaded blocks).
      removeCollapsedDescendantsFromGrid(next);
      api.refreshServerSide?.({ purge: false });
    }
    if (removed.length > 0) {
      api.refreshServerSide?.({ purge: false });
    }
    previousCollapsedPathsRef.current = new Set(next);
  }, [collapsedCategoryPaths, removeCollapsedDescendantsFromGrid]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    try {
      api.redrawRows();
    } catch {
      /* noop */
    }
  }, [collapsedCategoryPaths]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    try {
      api.redrawRows();
    } catch {
      /* noop */
    }
  }, [categoryPathsWithChildren]);

  const prevOfferIdForCookieRef = useRef(offerId);
  useEffect(() => {
    if (prevOfferIdForCookieRef.current !== offerId) {
      prevOfferIdForCookieRef.current = offerId;
      return;
    }
    writeCollapsedCategoryPathsToCookie(offerId, collapsedCategoryPaths);
  }, [offerId, collapsedCategoryPaths]);

  useEffect(() => {
    setCollapsedCategoryPaths(readCollapsedCategoryPathsFromCookie(offerId));
    prevOfferIdForCookieRef.current = offerId;
  }, [offerId]);

  const productRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: resolvedEndpoint,
        dataEndpoint: resolvedEndpoint,
        idField: 'OfferDetailID',
        resolveRowId: (row) =>
          normalizeOfferDetailId((row as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null),
        resolveRowLabel,
        resolveRowTypeLabel: (row) => {
          const base = resolveOfferProductTypeLabel(row);
          if (base === 'product') return 'product row';
          return base;
        },
        resolveMultiRowTypeLabel: (rows) => {
          const types = new Set(
            rows.map((row) => resolveOfferProductTypeLabel(row)).filter((value) => value && value.trim().length > 0),
          );
          if (types.size !== 1) return 'rows';
          const [type] = Array.from(types);
          if (type === 'category') return 'categories';
          if (type === 'product') return 'product rows';
          if (type === 'comment') return 'comments';
          if (type.endsWith('s')) return type;
          return `${type}s`;
        },
        buildPayload: (ids) => ({ OfferDetailIDs: ids }),
        confirmTitle: ({ typeLabel }) => `Delete ${typeLabel}`,
        confirmConfirmLabel: ({ typeLabel }) => `Delete ${typeLabel}`,
        confirmCancelLabel: ({ typeLabel }) => `Keep ${typeLabel}`,
        successToastMessage: 'Row deleted',
        failureToastMessage: 'Unable to delete row. Please try again.',
        refreshHandler: (api) => refreshOfferProductGrid(api, { purge: true }),
        canDelete: (count) => {
          return checkDeletePermissionForClient(roles, count, 'offerProducts', 'editOffers', { isCreator: isOfferCreator });
        },
        restoreEndpoint: `${resolvedEndpoint}/restore`,
        onDeleteSuccess: (deletedRows) => {
          const anyRequested = deletedRows.some((row) => {
            const r = row as Record<string, unknown> | null;
            if (!r) return false;
            return isRequestedRow(r) || hasRequestedPseudoFields(r);
          });
          if (anyRequested) {
            forceFreshRequestedVisibilityRef.current = true;
          }
          if (deletedRows.length > 0) {
            pushUndo({
              label: 'Row deleted',
              undo: async () => {
                const res = await fetch(`${resolvedEndpoint}/restore`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ rows: deletedRows }),
                });
                const result = (await res.json().catch(() => null)) as { ok?: boolean } | null;
                if (!res.ok || !result?.ok) throw new Error('Failed to restore');
                refreshOfferProductGrid(null, { purge: true });
              },
            });
          }
        },
      }),
    [resolvedEndpoint, refreshOfferProductGrid, roles, isOfferCreator, pushUndo],
  );

  const populateRequestedRowsToOffer = useCallback(async (nodes: RowNode<Record<string, unknown>>[], options?: { skipInternalUndoPush?: boolean }) => {
    const requestedNodes = nodes.filter((node) => {
      const data = node?.data ?? null;
      if (!data) return false;
      if (isRequestedRow(data)) return true;
      // Include hasRequestedPseudoFields rows only if they don't already have a product assigned
      if (hasRequestedPseudoFields(data)) {
        const productId = (data as { ProductID?: unknown }).ProductID;
        return productId == null || productId === 0;
      }
      return false;
    });
    if (requestedNodes.length === 0) return;

    try {
      gridApiRef.current?.deselectAll?.();
    } catch {
      /* noop */
    }
    setGridRowDeletionContextMenuSelectionSnapshot(gridApiRef.current, []);
    pendingContextMenuSelectionClearRef.current = true;

    const finalizeSelection = () => {
      requestedNodes.forEach((node) => {
        try {
          node?.setSelected?.(false);
        } catch {
          /* noop */
        }
      });
      setGridRowDeletionContextMenuSelectionSnapshot(gridApiRef.current, []);
      pendingContextMenuSelectionClearRef.current = true;
      try {
        gridApiRef.current?.deselectAll?.();
      } catch {
        /* noop */
      }
    };

    // Check which genuine requested rows (__isRequestedRow=1) already have products assigned
    const alreadyPopulatedNodes = requestedNodes.filter((node) => {
      const data = node?.data ?? null;
      if (!data) return false;
      if (!isRequestedRow(data)) return false;
      const productId = (data as { ProductID?: unknown }).ProductID;
      return productId != null && productId !== 0;
    });

    // If some rows are already populated, ask the user whether to re-populate or keep them
    let nodesToProcess = requestedNodes;
    if (alreadyPopulatedNodes.length > 0) {
      const choice = await showMultiChoiceDialog({
        title: 'Some rows already have products',
        message: `${alreadyPopulatedNodes.length} row(s) already have products assigned. What would you like to do with them?`,
        choices: [
          { label: 'Re-populate from scratch', value: 'repopulate' },
          { label: 'Keep existing', value: 'keep' },
          { label: 'Cancel', value: 'cancel' },
        ],
      });
      if (!choice || choice === 'cancel') return;
      if (choice === 'keep') {
        const alreadyPopulatedSet = new Set(alreadyPopulatedNodes);
        nodesToProcess = requestedNodes.filter((n) => !alreadyPopulatedSet.has(n));
        if (nodesToProcess.length === 0) {
          showToastMessage('No new rows to populate.', 'info');
          return;
        }
      }
    }

    // Clear actual product data from already-populated rows so they can be re-populated
    const nodesToUnassign = alreadyPopulatedNodes.filter((n) => nodesToProcess.includes(n));
    if (nodesToUnassign.length > 0) {
      const idsToUnassign = nodesToUnassign
        .map((node) => normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
        .filter((id): id is number => id != null);
      if (idsToUnassign.length > 0) {
        try {
          const res = await fetch(addProductsEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'unassign-requested', offerDetailIds: idsToUnassign }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; previousRows?: Record<string, unknown>[] } | null;
          if (!res.ok || !payload?.ok) {
            showToastMessage(payload?.error ?? 'Failed to clear existing product data for re-population.', 'error');
            return;
          }
          // Push undo so the user can restore the previously-assigned product data
          const previousRows = Array.isArray(payload?.previousRows) ? payload.previousRows : [];
          if (previousRows.length > 0 && !options?.skipInternalUndoPush) {
            const capturedEndpoint = resolvedEndpoint;
            pushUndo({
              label: `Unassign ${previousRows.length} requested product(s)`,
              undo: async () => {
                const updates = previousRows.map((row) => {
                  const { OfferDetailID, ...fields } = row;
                  return { OfferDetailID, ...fields };
                });
                const undoRes = await fetch(capturedEndpoint, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ updates }),
                });
                const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
                if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to restore unassigned data');
                refreshOfferProductGrid(null, { purge: true });
              },
            });
          }
          // Reset local node data directly (without setDataValue) to avoid
          // triggering cell-changed handlers that spam validation toasts.
          // The grid will be purge-refreshed at the end of populate anyway.
          for (const node of nodesToUnassign) {
            const d = node.data;
            if (!d) continue;
            d.__isRequestedRow = 1;
            d.ProductID = null;
            d.BrandID = null;
            d.BrandName = null;
            d.PartNumber = null;
            d.ModelNumber = null;
            d.ProductDescription = null;
            d.Description = null;
            d.ListPrice = null;
            d.NetUnitPrice = null;
            d.TotalPrice = null;
            d.TotalNet = null;
            d.TelmacoDiscount = null;
            d.CustomerDiscount = null;
            d.NetCost = null;
            d.Margin = null;
            d.GrossProfit = null;
            d.TotalCost = null;
            d.Quantity = null;
            d.IsCategory = 0;
          }
        } catch (err) {
          console.error('Failed to clear existing product data for re-population', err);
          showToastMessage('Unable to clear existing product data. Please try again.', 'error');
          return;
        }
      }
    }

    const updates: Array<Record<string, unknown>> = [];
    let categoriesAdded = 0;
    let productsAdded = 0;
    const unmatchedRequestedRows: RequestedProductMatchEntry[] = [];
    const unfoundFarnellPartNumbers: string[] = [];
    const brandMismatchPending: Array<{
      node: (typeof nodesToProcess)[0];
      data: Record<string, unknown>;
      offerDetailId: number;
      productId: number;
      productMeta: ProductSummary;
      lookupInfo: RequestedLookupInfo;
      brandIsFarnell: boolean;
      farnellLookupResponse: FarnellLookupResponse | null;
      parentCategoryId: number | null;
      requestedQuantityValue: number | null;
      actualQuantityValue: number | null;
      descriptionOverride: string | null;
      requestedBrand: string;
      matchedBrand: string;
    }> = [];
    const farnellProductCache = new Map<string, number>();
    const farnellLookupCache = new Map<string, FarnellLookupResponse | null>();
    const getFarnellLookupCacheKey = (partNumber: string, quantity: number, searchType: 'id' | 'manuPartNum' = 'id') => `${searchType}::${partNumber}::${quantity}`;
    const getFarnellLookupCached = async (partNumber: string, quantity: number, searchType: 'id' | 'manuPartNum' = 'id') => {
      const normalizedQuantity = quantity > 0 ? Math.trunc(quantity) : 1;
      const cacheKey = getFarnellLookupCacheKey(partNumber, normalizedQuantity, searchType);
      if (farnellLookupCache.has(cacheKey)) {
        return farnellLookupCache.get(cacheKey) ?? null;
      }
      const response = await fetchFarnellLookup(partNumber, normalizedQuantity, searchType);
      farnellLookupCache.set(cacheKey, response);
      return response;
    };
    const baseRootCategoryCount = treeOrderingRootMapRef.current.size;
    let sequentialCategoryCount = 0;
    let lastAssignedCategoryOrdinal: string | null = null;
    const productChildCounters = new Map<string, number>();

    // Prewarm lookup + summary caches in parallel so the sequential loop below
    // only waits for the per-row assignment write. Without this, each row blocks
    // on resolve → summary → assign roundtrips, so the first product only
    // appears after three serial server hits.
    try {
      const prewarmInfos: RequestedLookupInfo[] = [];
      for (const node of nodesToProcess) {
        const data = node?.data ?? null;
        if (!data || typeof data !== 'object') continue;
        const info = buildRequestedLookupInfo(data);
        if (!info.partNumber && !info.modelNumber) continue;
        if (isFarnellBrand(info.brand)) continue;
        prewarmInfos.push(info);
      }
      if (prewarmInfos.length > 0) {
        const productIds = await Promise.all(
          prewarmInfos.map((info) => resolveProductIdFromRequestedInfo(info).catch(() => null)),
        );
        const uniqueIds = Array.from(
          new Set(productIds.filter((id): id is number => id != null)),
        );
        if (uniqueIds.length > 0) {
          await Promise.all(uniqueIds.map((id) => fetchProductSummary(id).catch(() => null)));
        }
      }
    } catch {
      /* prewarm is best-effort; the sequential loop falls back to per-row fetches */
    }

    try {
      for (const node of nodesToProcess) {
        const data = node?.data ?? null;
        if (!data || typeof data !== 'object') continue;
        const offerDetailId = normalizeOfferDetailId((data as { OfferDetailID?: unknown }).OfferDetailID ?? null);
        if (offerDetailId == null) continue;

        const lookupInfo = buildRequestedLookupInfo(data);
        const hasRequestedIdentifiers = Boolean(lookupInfo.partNumber || lookupInfo.modelNumber);
        const requestedDescriptionPrimary = normalizeDescriptionValue(
          (data as { RequestedDescription?: unknown }).RequestedDescription ?? null,
        );
        const requestedDescriptionSecondary = normalizeDescriptionValue(
          (data as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
        );
        const requestedDescriptionTertiary = normalizeDescriptionValue(
          (data as { RequestedDescription3?: unknown }).RequestedDescription3 ?? null,
        );
        const descriptionOverrideRaw = getExactTextValue(
          (data as { Description?: unknown }).Description ?? null,
        );
        const requestedTree = normalizeRequestedItemNoValue((data as { RequestedItemNo?: unknown }).RequestedItemNo ?? null);
        const treeOrderingRaw = (data as { TreeOrdering?: unknown }).TreeOrdering;
        let treeOrderingValue = requestedTree || (typeof treeOrderingRaw === 'string'
          ? treeOrderingRaw.trim()
          : null);
        const requestedDescriptionValue = requestedDescriptionPrimary ?? requestedDescriptionSecondary ?? requestedDescriptionTertiary;
        const descriptionOverride = normalizeDescriptionValue(descriptionOverrideRaw);
        const normalizedDescriptionValues = getNormalizedRequestedDescriptionValues(data);
        const hasSingleDescriptionOnly = normalizedDescriptionValues.length > 0
          && new Set(normalizedDescriptionValues).size === 1;
        const requestedQuantityValue = normalizeRequestedQuantityValue(
          (data as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
        );
        const actualQuantityValue = coerceNumber((data as { Quantity?: unknown }).Quantity ?? null);
        const hasRequestedQuantity = requestedQuantityValue != null && !Object.is(requestedQuantityValue, 0);
        const hasActualQuantity = actualQuantityValue != null && !Object.is(actualQuantityValue, 0);
        const hasQuantity = hasRequestedQuantity || hasActualQuantity;
        const isAlreadyPopulated = !isRequestedRow(data);
        const shouldPromoteToCategory = (
          !isAlreadyPopulated
          && !hasRequestedIdentifiers
          && hasSingleDescriptionOnly
          && !hasQuantity
        );
        if (shouldPromoteToCategory) {
          const categoryDescription = requestedDescriptionValue ?? descriptionOverride ?? null;
          const payloadEntry: Record<string, unknown> = {
            OfferDetailID: offerDetailId,
            IsCategory: 1,
          };
          if (!treeOrderingValue) {
            sequentialCategoryCount += 1;
            treeOrderingValue = String(baseRootCategoryCount + sequentialCategoryCount);
          }
          lastAssignedCategoryOrdinal = treeOrderingValue;
          productChildCounters.set(treeOrderingValue, 0);
          if (categoryDescription != null) {
            payloadEntry.Description = categoryDescription;
          }
          if (treeOrderingValue != null) {
            payloadEntry.TreeOrdering = treeOrderingValue;
            if (requestedTree != null) {
              payloadEntry.RequestedItemNo = requestedTree;
            }
          }
          if (requestedDescriptionPrimary != null) {
            payloadEntry.RequestedDescription = requestedDescriptionPrimary;
          }
          if (requestedDescriptionSecondary != null) {
            payloadEntry.RequestedDescription2 = requestedDescriptionSecondary;
          }
          if (requestedDescriptionTertiary != null) {
            payloadEntry.RequestedDescription3 = requestedDescriptionTertiary;
          }
          updates.push(payloadEntry);
          promoteNodeToCategory(
            node,
            treeOrderingValue ?? null,
            categoryDescription,
            requestedTree,
          );
          categoriesAdded += 1;
          continue;
        }

        if (!treeOrderingValue && lastAssignedCategoryOrdinal) {
          const nextChildIndex = (productChildCounters.get(lastAssignedCategoryOrdinal) ?? 0) + 1;
          productChildCounters.set(lastAssignedCategoryOrdinal, nextChildIndex);
          treeOrderingValue = `${lastAssignedCategoryOrdinal}.${nextChildIndex}`;
        }

        if (!hasRequestedIdentifiers) {
          unmatchedRequestedRows.push(buildRequestedProductMatchEntry(data, offerDetailId));
          continue;
        }

        try {
          const brandIsFarnell = isFarnellBrand(lookupInfo.brand);
          let farnellLookupResponse: FarnellLookupResponse | null = null;
          let productId: number | null = null;

          if (brandIsFarnell && lookupInfo.partNumber) {
            const partKey = lookupInfo.partNumber;

            // Check dedup cache first (same part number already processed in this batch)
            if (farnellProductCache.has(partKey)) {
              productId = farnellProductCache.get(partKey) ?? null;
            } else {
              // Strict brand-matched lookup to avoid cross-brand matches
              productId = await resolveFarnellProductByPartNumber(partKey);
            }

            // Auto-create product if not found
            if (productId == null) {
              // Fetch from Farnell API by item code (also returns the Farnell brand ID from DB)
              if (lookupInfo.partNumber) {
                farnellLookupResponse = await getFarnellLookupCached(lookupInfo.partNumber, 1);
              }

              // Fallback: retry the same part number as a manufacturer part number search
              if (!farnellLookupResponse && partKey) {
                farnellLookupResponse = await getFarnellLookupCached(partKey, 1, 'manuPartNum');
              }

              const farnellBrandId = farnellLookupResponse?.farnellBrandId ?? null;
              if (farnellBrandId != null && farnellLookupResponse) {
                productId = await createFarnellProduct(
                  farnellBrandId,
                  farnellLookupResponse.product,
                  partKey,
                );
              }
            }

            // Cache for dedup within this batch
            if (productId != null) {
              farnellProductCache.set(partKey, productId);
            }
          } else {
            productId = await resolveProductIdFromRequestedInfo(lookupInfo);
          }

          if (productId == null) {
            if (brandIsFarnell && lookupInfo.partNumber) {
              unfoundFarnellPartNumbers.push(lookupInfo.partNumber);
            } else {
              unmatchedRequestedRows.push(buildRequestedProductMatchEntry(data, offerDetailId));
            }
            continue;
          }

          // Fetch product summary early so we can check for brand mismatch before assignment
          const productMeta = await fetchProductSummary(productId);
          const requestedBrandNorm = lookupInfo.brand
            ? lookupInfo.brand.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
            : null;
          const matchedBrandNorm = productMeta?.BrandName
            ? productMeta.BrandName.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
            : null;
          if (requestedBrandNorm && matchedBrandNorm && requestedBrandNorm !== matchedBrandNorm) {
            const parentCategoryId = normalizeOfferDetailId(
              (data as { ParentOfferDetailID?: unknown }).ParentOfferDetailID ?? null,
            );
            brandMismatchPending.push({
              node,
              data,
              offerDetailId,
              productId,
              productMeta: productMeta!,
              lookupInfo,
              brandIsFarnell,
              farnellLookupResponse,
              parentCategoryId,
              requestedQuantityValue,
              actualQuantityValue,
              descriptionOverride,
              requestedBrand: lookupInfo.brand!,
              matchedBrand: productMeta!.BrandName!,
            });
            continue;
          }

          const parentCategoryId = normalizeOfferDetailId(
            (data as { ParentOfferDetailID?: unknown }).ParentOfferDetailID ?? null,
          );
          const assignment = await assignRequestedRowToProduct(offerDetailId, productId, parentCategoryId);
          if (!assignment) {
            if (brandIsFarnell && lookupInfo.partNumber) {
              unfoundFarnellPartNumbers.push(lookupInfo.partNumber);
            } else {
              unmatchedRequestedRows.push(buildRequestedProductMatchEntry(data, offerDetailId));
            }
            continue;
          }

          // productMeta already fetched above (before brand mismatch check)
          const assignedProductBrandIsFarnell = brandIsFarnell || isFarnellBrand(productMeta?.BrandName ?? null);
          const productPartNumber = typeof productMeta?.PartNumber === 'string'
            ? productMeta.PartNumber.trim()
            : '';
          const assignedPartNumber = lookupInfo.partNumber
            ?? (productPartNumber.length > 0 ? productPartNumber : null);

          if (assignedProductBrandIsFarnell && assignedPartNumber) {
            const quantityForLookupRaw = assignment.pricing?.quantity ?? requestedQuantityValue ?? actualQuantityValue ?? 1;
            const quantityForLookup = quantityForLookupRaw > 0 ? Math.trunc(quantityForLookupRaw) : 1;
            let lookupResponse = farnellLookupResponse;
            if (!lookupResponse || quantityForLookup !== 1 || lookupInfo.partNumber !== assignedPartNumber) {
              lookupResponse = await getFarnellLookupCached(assignedPartNumber, quantityForLookup);
            }
            if (lookupResponse?.product.matchedPrice != null) {
              const farnellPatch = buildFarnellPricingPatch(
                offerDetailId,
                lookupResponse.product.matchedPrice,
                assignment.pricing,
              );
              if (farnellPatch) {
                updates.push(farnellPatch);
              }
            }
          }

          const productDescription = normalizeDescriptionValue(productMeta?.Description ?? null);
          const description = productDescription ?? descriptionOverride ?? null;
          const requestedModelNumberRaw = getExactTextValue(
            (data as { RequestedModelNo?: unknown }).RequestedModelNo ?? null,
          );
          const requestedBrandRaw = getExactTextValue(
            (data as { RequestedBrand?: unknown }).RequestedBrand ?? null,
          );
          const partNumber = productMeta?.PartNumber ?? null;
          const modelNumber = requestedModelNumberRaw
            ?? getExactTextValue((data as { ModelNumber?: unknown }).ModelNumber ?? null)
            ?? productMeta?.ModelNumber
            ?? null;
          const brandName = requestedBrandRaw
            ?? getExactTextValue((data as { BrandName?: unknown }).BrandName ?? null)
            ?? productMeta?.BrandName
            ?? null;
          const fallbackProductMeta: ProductSummary = {
            ProductID: productId,
            PartNumber: null,
            ModelNumber: null,
            BrandName: null,
            Description: null,
          };
          const summary = productMeta ?? fallbackProductMeta;
          promoteNodeToProduct(
            node,
            summary,
            partNumber ?? null,
            modelNumber ?? null,
            brandName ?? null,
            description ?? null,
          );
          productsAdded += 1;
        } catch (err) {
          console.error('Failed to populate requested row in offer', err);
        }
        continue;
      }

      // Handle brand-mismatched items: prompt user before assigning
      if (brandMismatchPending.length > 0) {
        const mismatchSummary = brandMismatchPending
          .map((item) => `${item.requestedBrand} → ${item.matchedBrand}`)
          .join(', ');
        const confirmed = await showConfirmDialog({
          title: 'Brand mismatch detected',
          message: `${brandMismatchPending.length} product${brandMismatchPending.length === 1 ? '' : 's'} matched with a different brand than requested (${mismatchSummary}). Accept these brand changes or send them to manual matching?`,
          confirmLabel: 'Accept Changes',
          cancelLabel: 'Manual Match',
        });
        if (confirmed) {
          for (const pending of brandMismatchPending) {
            try {
              const assignment = await assignRequestedRowToProduct(
                pending.offerDetailId,
                pending.productId,
                pending.parentCategoryId,
              );
              if (!assignment) {
                unmatchedRequestedRows.push(buildRequestedProductMatchEntry(pending.data, pending.offerDetailId));
                continue;
              }

              const pm = pending.productMeta;
              const assignedProductBrandIsFarnell = pending.brandIsFarnell || isFarnellBrand(pm?.BrandName ?? null);
              const productPartNumber = typeof pm?.PartNumber === 'string' ? pm.PartNumber.trim() : '';
              const assignedPartNumber = pending.lookupInfo.partNumber
                ?? (productPartNumber.length > 0 ? productPartNumber : null);

              if (assignedProductBrandIsFarnell && assignedPartNumber) {
                const quantityForLookupRaw = assignment.pricing?.quantity ?? pending.requestedQuantityValue ?? pending.actualQuantityValue ?? 1;
                const quantityForLookup = quantityForLookupRaw > 0 ? Math.trunc(quantityForLookupRaw) : 1;
                let lookupResponse = pending.farnellLookupResponse;
                if (!lookupResponse || quantityForLookup !== 1 || pending.lookupInfo.partNumber !== assignedPartNumber) {
                  lookupResponse = await getFarnellLookupCached(assignedPartNumber, quantityForLookup);
                }
                if (lookupResponse?.product.matchedPrice != null) {
                  const farnellPatch = buildFarnellPricingPatch(
                    pending.offerDetailId,
                    lookupResponse.product.matchedPrice,
                    assignment.pricing,
                  );
                  if (farnellPatch) {
                    updates.push(farnellPatch);
                  }
                }
              }

              const productDescription = normalizeDescriptionValue(pm?.Description ?? null);
              const description = productDescription ?? pending.descriptionOverride ?? null;
              const requestedModelNumberRaw = getExactTextValue(
                (pending.data as { RequestedModelNo?: unknown }).RequestedModelNo ?? null,
              );
              const requestedBrandRaw = getExactTextValue(
                (pending.data as { RequestedBrand?: unknown }).RequestedBrand ?? null,
              );
              const partNumber = pm?.PartNumber ?? null;
              const modelNumber = requestedModelNumberRaw
                ?? getExactTextValue((pending.data as { ModelNumber?: unknown }).ModelNumber ?? null)
                ?? pm?.ModelNumber
                ?? null;
              const brandName = requestedBrandRaw
                ?? getExactTextValue((pending.data as { BrandName?: unknown }).BrandName ?? null)
                ?? pm?.BrandName
                ?? null;
              const fallbackProductMeta: ProductSummary = {
                ProductID: pending.productId,
                PartNumber: null,
                ModelNumber: null,
                BrandName: null,
                Description: null,
              };
              const summary = pm ?? fallbackProductMeta;
              promoteNodeToProduct(
                pending.node,
                summary,
                partNumber ?? null,
                modelNumber ?? null,
                brandName ?? null,
                description ?? null,
              );
              productsAdded += 1;
            } catch (err) {
              console.error('Failed to assign brand-mismatched row', err);
            }
          }
        } else {
          // User declined — send all brand-mismatched items to manual matching
          for (const pending of brandMismatchPending) {
            unmatchedRequestedRows.push(buildRequestedProductMatchEntry(pending.data, pending.offerDetailId));
          }
        }
      }

      if (updates.length > 0) {
        try {
          const res = await fetch(resolvedEndpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payload?.ok) {
            throw new Error(payload?.error ?? `Failed to populate requested rows (status ${res.status})`);
          }
        } catch (err) {
          console.error('Failed to populate requested rows', err);
          const message = err instanceof Error && err.message
            ? err.message
            : 'Unable to populate the offer with requested rows. Please try again.';
          showToastMessage(message, 'error');
          return;
        }
      }

      if (unfoundFarnellPartNumbers.length > 0) {
        const uniqueParts = [...new Set(unfoundFarnellPartNumbers)];
        if (uniqueParts.length === 1) {
          showToastMessage(
            `Couldn't find a Farnell product with this item code: ${uniqueParts[0]}`,
            'error',
          );
        } else {
          showToastMessage(
            `Couldn't find Farnell products with these item codes: ${uniqueParts.join(', ')}`,
            'error',
          );
        }
      }
      const manualMatchesRequired = unmatchedRequestedRows.length > 0;
      if (manualMatchesRequired) {
        setRequestedMatchQueue((prev) => [...prev, ...unmatchedRequestedRows]);
      }
      // Also refresh when we unassigned rows (re-populate from scratch) — the local
      // node data was reset without setDataValue, so AG Grid needs a purge refresh
      // to redraw those cells even if nothing auto-matched afterwards.
      const shouldRefresh = updates.length > 0 || productsAdded > 0 || nodesToUnassign.length > 0;
      if (shouldRefresh) {
        try {
          window.requestAnimationFrame(() => refreshOfferProductGrid(null, { purge: true }));
        } catch {
          refreshOfferProductGrid(null, { purge: true });
        }
      }
      const parts: string[] = [];
      if (categoriesAdded > 0) parts.push(`${categoriesAdded} categor${categoriesAdded === 1 ? 'y' : 'ies'}`);
      if (productsAdded > 0) parts.push(`${productsAdded} product${productsAdded === 1 ? '' : 's'}`);
      if (parts.length === 0) {
        if (manualMatchesRequired) {
          showToastMessage(
            'Some requested products require manual matching. Please resolve them using the matcher.',
            'info',
          );
        }
        return;
      }
      showToastMessage(`Populated ${parts.join(' and ')} in the offer.`, 'success');
      if (manualMatchesRequired) {
        showToastMessage(
          'Some requested products require manual matching. Please resolve them using the matcher.',
          'info',
        );
      }
    } finally {
      finalizeSelection();
      // Force re-apply requested column visibility after populate to counter any
      // AG Grid state drift caused by cell updates or grid refreshes.
      forceReapplyRef.current?.();
    }
  }, [addProductsEndpoint, assignRequestedRowToProduct, promoteNodeToCategory, promoteNodeToProduct, pushUndo, refreshOfferProductGrid, resolvedEndpoint]);

  const currentRequestedMatch = requestedMatchQueue[0] ?? null;
  const currentPrefetchedSuggestions = null;
  void expansionCacheVersion; // trigger re-read from ref on cache update
  void productPageCacheVersion; // trigger re-read from ref on cache update
  const currentPrefetchedExpansion: FilterExpansions | null = currentRequestedMatch
    ? expansionCacheRef.current.get(currentRequestedMatch.offerDetailId) ?? null
    : null;
  const currentPrefetchedFirstPage: GridResponse | null = currentRequestedMatch
    ? productPageCacheRef.current.get(currentRequestedMatch.offerDetailId) ?? null
    : null;
  const matchAddProductInitialValues = useMemo<AddProductInitialValues | null>(() => {
    if (!currentRequestedMatch) return null;
    const descriptionParts = [
      currentRequestedMatch.requestedDescription,
      currentRequestedMatch.requestedDescription2,
      currentRequestedMatch.requestedDescription3,
    ]
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter((value) => value.length > 0);
    return {
      brandName: currentRequestedMatch.requestedBrand,
      modelNumber: currentRequestedMatch.requestedModelNumber,
      partNumber: currentRequestedMatch.requestedPartNumber,
      description: descriptionParts.join('\n'),
      weblink: currentRequestedMatch.requestedWebLink,
    };
  }, [currentRequestedMatch]);
  const openMatchAddProduct = useCallback(() => setMatchAddProductOpen(true), []);
  const closeMatchAddProduct = useCallback(() => setMatchAddProductOpen(false), []);
  const handleMatchProductAdded = useCallback((result?: { productId?: number | null }) => {
    if (result?.productId != null) {
      setMatchAddedProductId(result.productId);
    }
    try {
      refreshOfferProductGrid(null, { purge: true });
    } catch {
      /* noop */
    }
    closeMatchAddProduct();
  }, [closeMatchAddProduct, refreshOfferProductGrid]);

  const closeRowAddProduct = useCallback(() => {
    setRowAddProductOpen(false);
    setRowAddProductInitialValues(null);
  }, []);
  const handleRowAddProductAdded = useCallback(() => {
    try {
      refreshOfferProductGrid(null, { purge: true });
    } catch {
      /* noop */
    }
    closeRowAddProduct();
  }, [closeRowAddProduct, refreshOfferProductGrid]);

  // Drop the head of the queue plus every subsequent entry whose requested
  // fields are identical (case- and whitespace-insensitive) to the head, and
  // bump processed count by everything we removed. Returns the removed
  // duplicate entries so callers (e.g. assign) can apply the same action to
  // them.
  const consumeQueueHeadWithDuplicates = useCallback((head: RequestedProductMatchEntry) => {
    const norm = (v: string | null | undefined) =>
      (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
    const isDuplicate = (other: RequestedProductMatchEntry) =>
      other.offerDetailId !== head.offerDetailId
      && norm(other.requestedBrand) === norm(head.requestedBrand)
      && norm(other.requestedModelNumber) === norm(head.requestedModelNumber)
      && norm(other.requestedPartNumber) === norm(head.requestedPartNumber)
      && norm(other.requestedDescription) === norm(head.requestedDescription)
      && norm(other.requestedDescription2) === norm(head.requestedDescription2)
      && norm(other.requestedDescription3) === norm(head.requestedDescription3);

    const duplicates = requestedMatchQueue.slice(1).filter(isDuplicate);
    setRequestedMatchQueue((prev) => {
      if (prev.length === 0) return prev;
      return prev.slice(1).filter((entry) => !isDuplicate(entry));
    });
    setProcessedRequestedMatches((prev) => prev + 1 + duplicates.length);
    return duplicates;
  }, [requestedMatchQueue]);

  const handleManualAssign = useCallback(async (
    productId: number,
    comment: string,
    metrics?: Record<string, unknown> | null,
  ) => {
    if (!currentRequestedMatch) return false;
    const match = currentRequestedMatch;

    const duplicates = consumeQueueHeadWithDuplicates(match);
    const duplicateCount = duplicates.length;

    // Metrics only attached to the head-row assignment, not to duplicate
    // auto-fills — rank is only meaningful for the user's actual click.
    Promise.all([
      assignRequestedRowToProduct(match.offerDetailId, productId, match.parentCategoryId, comment, metrics ?? null),
      ...duplicates.map((dup) =>
        assignRequestedRowToProduct(dup.offerDetailId, productId, dup.parentCategoryId, comment),
      ),
    ])
      .then((results) => {
        const failed = results.filter((r) => !r).length;
        if (failed === 0) {
          const msg = duplicateCount > 0
            ? `Requested item filled (+${duplicateCount} identical row${duplicateCount === 1 ? '' : 's'})`
            : 'Requested item filled';
          showToastMessage(msg, 'success');
          try {
            refreshOfferProductGrid(null, { purge: true });
          } catch { /* noop */ }
        } else if (failed === results.length) {
          showToastMessage('Unable to assign requested item. Please try again.', 'error');
        } else {
          showToastMessage(
            `Assigned ${results.length - failed} of ${results.length} rows; ${failed} failed.`,
            'error',
          );
          try {
            refreshOfferProductGrid(null, { purge: true });
          } catch { /* noop */ }
        }
      })
      .catch(() => {
        showToastMessage('Unable to assign requested item. Please try again.', 'error');
      });

    return true;
  }, [assignRequestedRowToProduct, consumeQueueHeadWithDuplicates, currentRequestedMatch, refreshOfferProductGrid]);

  const handleManualSkip = useCallback(() => {
    if (!currentRequestedMatch) return;
    const match = currentRequestedMatch;

    const duplicateCount = consumeQueueHeadWithDuplicates(match).length;

    const msg = duplicateCount > 0
      ? `Skipped requested item (+${duplicateCount} identical row${duplicateCount === 1 ? '' : 's'}).`
      : 'Skipped requested item.';
    showToastMessage(msg, 'info');
    // Force re-show requested columns that may have been hidden during the
    // populate/match flow.  A deferred RAF handles AG Grid internal timing.
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        forceReapplyRequestedColumnsVisibility();
      });
    }
  }, [consumeQueueHeadWithDuplicates, currentRequestedMatch, forceReapplyRequestedColumnsVisibility]);

  const handleManualSkipAll = useCallback(() => {
    if (requestedMatchQueue.length === 0) return;
    showToastMessage('Skipped all requested items.', 'info');
    setRequestedMatchQueue([]);
    setProcessedRequestedMatches(0);
    expansionCacheRef.current.clear();
    expansionPrefetchingRef.current.clear();
    expansionPrefetchStartedRef.current = false;
    productPageCacheRef.current.clear();
    productPagePrefetchingRef.current.clear();
    // Force re-show requested columns that may have been hidden during the
    // populate/match flow.
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        forceReapplyRequestedColumnsVisibility();
      });
    }
  }, [requestedMatchQueue.length, forceReapplyRequestedColumnsVisibility]);

  const fetchAllFilteredRows = useCallback(async (): Promise<Array<Record<string, unknown>>> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      throw new Error('Grid is not ready yet.');
    }
    const filterModel = api.getFilterModel?.() ?? {};
    const sortModel = api.getColumnState?.()
      ?.filter((col) => col.sort === 'asc' || col.sort === 'desc')
      .map((col) => ({ colId: col.colId, sort: col.sort as 'asc' | 'desc' })) ?? [];
    const quickFilterText = typeof lastServerRequestRef.current?.quickFilterText === 'string'
      ? lastServerRequestRef.current.quickFilterText
      : null;
    const request: Record<string, unknown> = {
      startRow: 0,
      endRow: 1000,
      allRows: true,
      filterModel,
      sortModel,
    };
    if (quickFilterText && quickFilterText.trim().length > 0) {
      request.quickFilterText = quickFilterText.trim();
    }

    const response = await fetch(dataEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to load all rows (status ${response.status})`);
    }
    const deselectedIds = getServerSideDeselectedRowIds(api);
    if (deselectedIds.size === 0) return payload.rows;
    return payload.rows.filter((row) => {
      const id = (row as { OfferDetailID?: unknown }).OfferDetailID;
      return id == null || !deselectedIds.has(String(id));
    });
  }, [dataEndpoint]);

  const populateOfferBusyRef = useRef(false);
  const populateOffer = useCallback(async () => {
    if (populateOfferBusyRef.current) return;
    populateOfferBusyRef.current = true;
    try {
      const api = gridApiRef.current;
      if (!api || api.isDestroyed?.()) {
        showToastMessage('Grid is not ready yet.', 'error');
        return;
      }

      // Check if server-side select-all is active
      let isSelectAllActive = false;
      if (typeof api.getServerSideSelectionState === 'function') {
        const state = api.getServerSideSelectionState();
        isSelectAllActive = Boolean(state && 'selectAll' in state && Boolean((state as { selectAll?: boolean }).selectAll));
      }

      let requestedNodes: Array<RowNode<Record<string, unknown>>> = [];
      let selectedRequestedNodes: Array<RowNode<Record<string, unknown>>> = [];
      let allRequestedNodes: Array<RowNode<Record<string, unknown>>> = [];

      if (isSelectAllActive) {
        // When select-all is active, fetch ALL rows from server since
        // getSelectedNodes/forEachNode only return loaded rows.
        // fetchAllFilteredRows already excludes toggledNodes (deselected rows).
        try {
          const allRows = await fetchAllFilteredRows();
          const wrapAsNode = (data: Record<string, unknown>) => ({ data, setSelected: () => {} } as unknown as RowNode<Record<string, unknown>>);
          const allWrapped = allRows.map(wrapAsNode);
          selectedRequestedNodes = allWrapped.filter((node) => isRequestedRow(node.data) || hasRequestedPseudoFields(node.data));
          allRequestedNodes = selectedRequestedNodes;
        } catch (err) {
          console.error('Failed to fetch all rows for populate', err);
          showToastMessage(
            err instanceof Error ? err.message : 'Failed to load all rows. Please try again.',
            'error',
          );
          return;
        }
      } else {
        // Prefer explicit selection when present.
        try {
          const selected = typeof api.getSelectedNodes === 'function'
            ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
            : [];
          selectedRequestedNodes = selected.filter((node) => isRequestedRow(node?.data ?? null) || hasRequestedPseudoFields(node?.data ?? null));
        } catch {
          /* noop */
        }

        try {
          if (typeof api.forEachNode === 'function') {
            const allRequested: Array<RowNode<Record<string, unknown>>> = [];
            api.forEachNode((node) => {
              if (isRequestedRow(node?.data ?? null) || hasRequestedPseudoFields(node?.data ?? null)) {
                allRequested.push(node as RowNode<Record<string, unknown>>);
              }
            });
            allRequestedNodes = allRequested;
          }
        } catch {
          /* noop */
        }
      }

      requestedNodes = selectedRequestedNodes.length > 0 ? selectedRequestedNodes : allRequestedNodes;

      if (requestedNodes.length === 0) {
        showToastMessage('No rows with requested data found to populate.', 'info');
        return;
      }

      const allRequestedCount = allRequestedNodes.length;
      const selectedRequestedCount = selectedRequestedNodes.length;
      const shouldWarnNoSelection = selectedRequestedCount === 0 && allRequestedCount > 0;
      const shouldWarnAllSelected = selectedRequestedCount > 0 && selectedRequestedCount === allRequestedCount;
      if (shouldWarnNoSelection || shouldWarnAllSelected) {
        const title = shouldWarnNoSelection
          ? 'Populate all requested rows?'
          : 'Populate selected requested rows?';
        const targetLabel = shouldWarnNoSelection
          ? 'all requested rows'
          : 'all selected requested rows';
        const confirmed = await showConfirmDialog({
          title,
          message: `Populate Offer will process ${targetLabel}. It will try to auto-match products by requested part/model queue unmatched rows for manual matching. Existing products manually matched with requested items will be lost. Continue?`,
          confirmLabel: 'Proceed',
          cancelLabel: 'Cancel',
        });
        if (!confirmed) return;
      }

      // 1. Collect IDs to snapshot before populate
      const idsToSnapshot = requestedNodes
        .map((node) =>
          normalizeOfferDetailId(
            (node?.data as { OfferDetailID?: unknown })?.OfferDetailID ?? null,
          ),
        )
        .filter((id): id is number => id != null);

      // 2. Fetch pre-populate row state so we can fully restore on undo
      let snapshotRows: Record<string, unknown>[] = [];
      if (idsToSnapshot.length > 0) {
        try {
          const snapRes = await fetch(addProductsEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'snapshot-rows', offerDetailIds: idsToSnapshot }),
          });
          const snapPayload = (await snapRes.json().catch(() => null)) as
            | { ok?: boolean; rows?: Record<string, unknown>[] }
            | null;
          if (snapRes.ok && snapPayload?.ok && Array.isArray(snapPayload.rows)) {
            snapshotRows = snapPayload.rows;
          }
        } catch (snapErr) {
          console.error('Failed to snapshot rows before populate', snapErr);
          // Non-fatal — proceed without undo for this run
        }
      }

      // 3. Run populate, suppressing the per-unassign internal undo entry
      await populateRequestedRowsToOffer(requestedNodes, { skipInternalUndoPush: true });

      // 4. Push ONE atomic undo entry covering the entire populate
      if (snapshotRows.length > 0) {
        const capturedSnapshot = snapshotRows;
        const capturedAddEndpoint = addProductsEndpoint;
        pushCellEditUndo(pushUndo, performUndo, 'Populate offer', async () => {
          const undoRes = await fetch(capturedAddEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'restore-rows', rows: capturedSnapshot }),
          });
          const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
          if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert populate');
          refreshOfferProductGrid(null, { purge: true });
        });
      }
    } finally {
      populateOfferBusyRef.current = false;
    }
  }, [populateRequestedRowsToOffer, fetchAllFilteredRows, addProductsEndpoint, pushUndo, performUndo, refreshOfferProductGrid]);

  const fetchExportRows = useCallback(async (): Promise<OfferExportRow[]> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      throw new Error('Grid is not ready yet.');
    }
    const filterModel = api.getFilterModel?.() ?? {};
    const sortModel = api.getColumnState?.()
      ?.filter((col) => col.sort === 'asc' || col.sort === 'desc')
      .map((col) => ({ colId: col.colId, sort: col.sort as 'asc' | 'desc' })) ?? [];
    const quickFilterText = typeof lastServerRequestRef.current?.quickFilterText === 'string'
      ? lastServerRequestRef.current.quickFilterText
      : null;
    const request: Record<string, unknown> = {
      startRow: 0,
      endRow: 1000,
      allRows: true,
      filterModel,
      sortModel,
    };
    if (quickFilterText && quickFilterText.trim().length > 0) {
      request.quickFilterText = quickFilterText.trim();
    }

    const response = await fetch(dataEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request,
        fields: [...OFFER_PRODUCTS_EXPORT_FIELDS],
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: OfferExportRow[] }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to fetch export rows (status ${response.status})`);
    }
    return payload.rows;
  }, [dataEndpoint]);

  const fetchAllFilteredOfferDetailIds = useCallback(async (): Promise<number[]> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      throw new Error('Grid is not ready yet.');
    }
    const filterModel = api.getFilterModel?.() ?? {};
    const sortModel = api.getColumnState?.()
      ?.filter((col) => col.sort === 'asc' || col.sort === 'desc')
      .map((col) => ({ colId: col.colId, sort: col.sort as 'asc' | 'desc' })) ?? [];
    const quickFilterText = typeof lastServerRequestRef.current?.quickFilterText === 'string'
      ? lastServerRequestRef.current.quickFilterText
      : null;
    const request: Record<string, unknown> = {
      startRow: 0,
      endRow: 1000,
      allRows: true,
      filterModel,
      sortModel,
    };
    if (quickFilterText && quickFilterText.trim().length > 0) {
      request.quickFilterText = quickFilterText.trim();
    }

    const response = await fetch(dataEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request,
        fields: ['OfferDetailID'],
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to load selected rows (status ${response.status})`);
    }
    const deselectedIds = getServerSideDeselectedRowIds(api);
    return Array.from(new Set(
      payload.rows
        .map((row) => normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
        .filter((id): id is number => id != null)
        .filter((id) => deselectedIds.size === 0 || !deselectedIds.has(String(id))),
    ));
  }, [dataEndpoint]);

  const fetchAllFilteredOfferProductIds = useCallback(async (): Promise<number[]> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) {
      throw new Error('Grid is not ready yet.');
    }
    const filterModel = api.getFilterModel?.() ?? {};
    const sortModel = api.getColumnState?.()
      ?.filter((col) => col.sort === 'asc' || col.sort === 'desc')
      .map((col) => ({ colId: col.colId, sort: col.sort as 'asc' | 'desc' })) ?? [];
    const quickFilterText = typeof lastServerRequestRef.current?.quickFilterText === 'string'
      ? lastServerRequestRef.current.quickFilterText
      : null;
    const request: Record<string, unknown> = {
      startRow: 0,
      endRow: 1000,
      allRows: true,
      filterModel,
      sortModel,
    };
    if (quickFilterText && quickFilterText.trim().length > 0) {
      request.quickFilterText = quickFilterText.trim();
    }

    const response = await fetch(dataEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request,
        fields: ['ProductID', 'OfferDetailID'],
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to load selected rows (status ${response.status})`);
    }
    const deselectedIds = getServerSideDeselectedRowIds(api);
    const filteredRows = deselectedIds.size === 0
      ? payload.rows
      : payload.rows.filter((row) => {
          const id = (row as { OfferDetailID?: unknown })?.OfferDetailID;
          return id == null || !deselectedIds.has(String(id));
        });
    return Array.from(new Set(
      filteredRows
        .map((row) => normalizeProductId((row as { ProductID?: unknown })?.ProductID ?? null))
        .filter((id): id is number => id != null),
    ));
  }, [dataEndpoint]);

  const buildTemplateExportRows = useCallback((rows: OfferExportRow[]): OfferProductsTemplateExportRow[] => {
    const displayMap = computeDisplayOrderingMap(rows as unknown as Record<string, unknown>[]);
    const includedRows = rows.filter((row) => {
      const rowType = resolveOfferProductRowType(row as unknown as Record<string, unknown>);
      return rowType === 'product' || rowType === 'category' || rowType === 'printable-comment';
    });

    return includedRows.map((row) => {
      const rowType = resolveOfferProductRowType(row as unknown as Record<string, unknown>);
      const model = (row.ModelNumber ?? '').toString().trim();
      const description = (row.Description ?? '').toString().trim();
      const descriptionType = [model, description].filter((part) => part.length > 0).join(' ').trim();
      const qty = coerceNumber(row.Quantity);
      const listPrice = coerceNumber(row.ListPrice);
      const qtyForExport = qty != null && !Object.is(qty, 0) ? qty : null;
      const deliveryRaw = row.Delivery == null ? '' : String(row.Delivery).trim();
      const deliveryValue = deliveryRaw.length > 0 ? deliveryRaw : 'unknown';
      const isUnmatchedProduct = rowType === 'product'
        && !row.PartNumber?.toString().trim()
        && !row.BrandName?.toString().trim()
        && !model
        && !description
        && listPrice == null;
      const actualKey = String(row.TreeOrdering ?? '').trim();
      return {
        no: normalizeNoForExport(displayMap.get(actualKey) ?? row.TreeOrdering),
        productReference: row.PartNumber?.toString().trim() ?? '',
        manufacturer: (row.AVC4BrandName?.toString().trim() || row.BrandName?.toString().trim()) ?? '',
        descriptionType,
        qty: qtyForExport ?? '',
        unitPrice: listPrice ?? '',
        delayForDelivery: deliveryValue,
        comments: row.Comment?.toString() ?? '',
        ...(isUnmatchedProduct ? { skipRow: true } : undefined),
      };
    });
  }, []);

  const getTemplateExportRows = useCallback(async (): Promise<OfferProductsTemplateExportRow[]> => {
    const rows = await fetchExportRows();
    return buildTemplateExportRows(rows);
  }, [buildTemplateExportRows, fetchExportRows]);

  const getAddInsertionAnchor = useCallback((): { offerDetailId: number; parentPath: number[]; label: string; treeOrdering: string; isRequested: boolean } | null => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return null;
    try {
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      if (selectedNodes.length === 0) return null;
      for (let idx = selectedNodes.length - 1; idx >= 0; idx -= 1) {
        const row = selectedNodes[idx]?.data ?? null;
        const offerDetailId = normalizeOfferDetailId((row as { OfferDetailID?: unknown } | null)?.OfferDetailID ?? null);
        if (offerDetailId == null) continue;
        const treeOrderingRaw = (row as { TreeOrdering?: unknown } | null)?.TreeOrdering ?? null;
        const path = parseTreeOrderingPath(treeOrderingRaw);
        if (path.length === 0) continue;
        const treeOrdering = typeof treeOrderingRaw === 'string' ? treeOrderingRaw.trim() : buildTreeOrderingKey(path);
        const label = resolveRowLabel(row as Record<string, unknown> | null, '');
        const requested = isRequestedRow(row as Record<string, unknown> | null);
        return { offerDetailId, parentPath: path.slice(0, -1), label, treeOrdering, isRequested: requested };
      }
    } catch {
      /* noop */
    }
    return null;
  }, []);

  const getSelectedOfferDetailIdsForPriceUpdate = useCallback(async (): Promise<number[]> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return [];
    try {
      // Check if server-side select-all is active
      if (typeof api.getServerSideSelectionState === 'function') {
        const state = api.getServerSideSelectionState();
        if (state && 'selectAll' in state && Boolean((state as { selectAll?: boolean }).selectAll)) {
          // Fetch all filtered IDs from server — the update-prices API filters to products
          return await fetchAllFilteredOfferDetailIds();
        }
      }
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      if (selectedNodes.length === 0) return [];
      const ids = selectedNodes
        .filter((node) => isOfferProductProduct(node?.data ?? null))
        .map((node) =>
          normalizeOfferDetailId(
            (node?.data as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null,
          ),
        )
        .filter((id): id is number => id != null);
      return Array.from(new Set(ids));
    } catch {
      return [];
    }
  }, [fetchAllFilteredOfferDetailIds]);

  const getSelectedOfferDetailIds = useCallback(async (): Promise<number[]> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return [];
    try {
      // Check if server-side select-all is active
      if (typeof api.getServerSideSelectionState === 'function') {
        const state = api.getServerSideSelectionState();
        if (state && 'selectAll' in state && Boolean((state as { selectAll?: boolean }).selectAll)) {
          return await fetchAllFilteredOfferDetailIds();
        }
      }
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      if (selectedNodes.length === 0) return [];
      const ids = selectedNodes
        .map((node) =>
          normalizeOfferDetailId(
            (node?.data as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null,
          ),
        )
        .filter((id): id is number => id != null);
      return Array.from(new Set(ids));
    } catch {
      return [];
    }
  }, [fetchAllFilteredOfferDetailIds]);

  const getSelectedRowData = useCallback((): Array<Record<string, unknown>> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return [];
    try {
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      return selectedNodes
        .filter((node) => node.data != null)
        .map((node) => node.data as Record<string, unknown>);
    } catch {
      return [];
    }
  }, []);

  const getAllVisibleRowData = useCallback((): Array<Record<string, unknown>> => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return [];
    try {
      const rows: Array<Record<string, unknown>> = [];
      api.forEachNode((node: IRowNode<Record<string, unknown>>) => {
        if (node.data) rows.push(node.data as Record<string, unknown>);
      });
      return rows;
    } catch {
      return [];
    }
  }, []);

  const getSelectedRequestedOfferDetailId = useCallback((): number | null => {
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return null;
    try {
      const selectedNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
        : [];
      if (selectedNodes.length !== 1) return null;
      const row = selectedNodes[0]?.data ?? null;
      if (!row || typeof row !== 'object') return null;
      if (!hasRequestedRowData(row)) return null;
      return normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
    } catch {
      return null;
    }
  }, []);

  const getViewportScrollTop = useCallback((): number => {
    const viewport = getGridViewportElement();
    return viewport?.scrollTop ?? 0;
  }, [getGridViewportElement]);

  // Restore selection from initialSelectedOfferDetailIds after grid data loads
  const initialSelectionRestoredRef = useRef(false);
  const pendingInitialSelectionRef = useRef<number[] | null>(
    initialSelectedOfferDetailIds?.length ? initialSelectedOfferDetailIds : null,
  );
  const [emptyGridPasteMenu, setEmptyGridPasteMenu] = useState<{ x: number; y: number } | null>(null);

  const tryRestoreInitialSelection = useCallback(() => {
    if (initialSelectionRestoredRef.current) return;
    const ids = pendingInitialSelectionRef.current;
    if (!ids || ids.length === 0) return;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    const idSet = new Set(ids);
    let found = false;
    api.forEachNode((node) => {
      if (!node.data) return;
      const offerDetailId = normalizeOfferDetailId(
        (node.data as { OfferDetailID?: unknown }).OfferDetailID ?? null,
      );
      if (offerDetailId != null && idSet.has(offerDetailId)) {
        node.setSelected(true);
        found = true;
      }
    });
    if (found) {
      initialSelectionRestoredRef.current = true;
      pendingInitialSelectionRef.current = null;
      pendingInitialSelectionRestoreRef.current = null;
    }
  }, []);

  // Wire up the restore function so handleGridModelUpdated can call it
  pendingInitialSelectionRestoreRef.current = pendingInitialSelectionRef.current?.length
    ? tryRestoreInitialSelection
    : null;

  const setInsertLineVisibleRef = useRef<((visible: boolean, atEnd?: boolean) => void) | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      populateOffer,
      getTemplateExportRows,
      getAddInsertionAnchor,
      getSelectedOfferDetailIdsForPriceUpdate,
      getSelectedOfferDetailIds,
      getSelectedRequestedOfferDetailId,
      forceReapplyRequestedColumnsVisibility,
      getViewportScrollTop,
      getSelectedRowData,
      getAllVisibleRowData,
      canUndo,
      performUndo,
      lastUndoLabel: lastLabel,
      pushUndo,
      setInsertLineVisible: (visible: boolean, atEnd?: boolean) => setInsertLineVisibleRef.current?.(visible, atEnd),
      deselectAllRows: () => {
        const api = gridApiRef.current;
        if (api && !api.isDestroyed?.()) {
          try { api.deselectAll(); } catch { /* noop */ }
        }
      },
      getLastClickedRowId: () => {
        const row = lastClickedRowRef.current;
        return row ? normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null) : null;
      },
      flashRows: (offerDetailIds: number[]) => {
        // Clear any existing flash
        if (flashIntervalRef.current) {
          clearInterval(flashIntervalRef.current);
          flashIntervalRef.current = null;
        }
        pendingFlashIdsRef.current = new Set(offerDetailIds);
        flashPhaseRef.current = 'paint';
        // Don't paint yet — wait for handleGridResponse to signal new data has arrived
      },
      clearSelectedRowHighlight,
    }),
    [canUndo, clearSelectedRowHighlight, forceReapplyRequestedColumnsVisibility, getAddInsertionAnchor, getAllVisibleRowData, getSelectedOfferDetailIds, getSelectedOfferDetailIdsForPriceUpdate, getSelectedRequestedOfferDetailId, getSelectedRowData, getTemplateExportRows, getViewportScrollTop, lastLabel, performUndo, populateOffer, pushUndo],
  );


  const manualMatchTotal = processedRequestedMatches + requestedMatchQueue.length;
  const manualMatchPosition = currentRequestedMatch ? processedRequestedMatches + 1 : 0;

  const openBrandBulkEdit = useCallback((
    field: 'CurrencyCostModifier' | 'Margin' | 'CustomerDiscount' | 'TelmacoDiscount',
    brandName: string,
    currentValue?: unknown,
    scope: 'brand' | 'offer' = 'brand',
  ) => {
    if (scope === 'brand') {
      const normalizedBrand = brandName.trim();
      if (!normalizedBrand) {
        showToastMessage('Missing brand name for bulk edit.', 'error');
        return;
      }
      setBrandBulkEditBrandName(normalizedBrand);
    } else {
      setBrandBulkEditBrandName('');
    }
    setBrandBulkEditField(field);
    setBrandBulkEditScope(scope);
    setBrandBulkEditError(null);
    const numericCurrent = coerceNumber(currentValue);
    if (field === 'CurrencyCostModifier') {
      setBrandBulkEditValue(String(numericCurrent ?? 1));
    } else {
      setBrandBulkEditValue(String(numericCurrent ?? 0));
    }
    setBrandBulkEditOpen(true);
  }, []);

  const closeBrandBulkEdit = useCallback(() => {
    if (brandBulkEditSaving) return;
    setBrandBulkEditOpen(false);
  }, [brandBulkEditSaving]);

  const confirmBrandBulkEdit = useCallback(async () => {
    if (brandBulkEditSaving) return;
    const isOfferScope = brandBulkEditScope === 'offer';
    const brandName = brandBulkEditBrandName.trim();
    if (!isOfferScope && !brandName) {
      setBrandBulkEditError('Brand is required.');
      return;
    }
    const valueNumber = coerceNumber(brandBulkEditValue);
    const label = brandBulkEditField === 'CurrencyCostModifier' ? 'Cost modifier'
      : brandBulkEditField === 'CustomerDiscount' ? 'Customer discount'
      : brandBulkEditField === 'TelmacoDiscount' ? 'Telmaco discount'
      : 'Margin';
    if (valueNumber == null || !Number.isFinite(valueNumber)) {
      setBrandBulkEditError(`Please enter a valid ${label.toLowerCase()}.`);
      return;
    }
    if (brandBulkEditField === 'CurrencyCostModifier' && !(valueNumber > 0)) {
      setBrandBulkEditError('Cost modifier must be greater than 0.');
      return;
    }
    if (brandBulkEditField === 'Margin' && Math.abs(valueNumber) >= 100) {
      setBrandBulkEditError('Margin must be between -100 and 100.');
      return;
    }

    setBrandBulkEditSaving(true);
    setBrandBulkEditError(null);
    try {
      // Fetch all product rows, optionally filtered by brand (pivot view excludes categories and requested-only rows).
      const filterModel: Record<string, unknown> = {};
      if (!isOfferScope && brandName) {
        filterModel.BrandName = {
          filterType: 'text',
          type: 'equals',
          filter: brandName,
        };
      }
      const fetchFields = isOfferScope && brandBulkEditField === 'CurrencyCostModifier'
        ? ['OfferDetailID', 'OtherCurrencyID', 'OtherCurrencyName', brandBulkEditField]
        : ['OfferDetailID', brandBulkEditField];
      const res = await fetch(resolvedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            allRows: true,
            view: 'pivot',
            filterModel: Object.keys(filterModel).length > 0 ? filterModel : undefined,
          },
          fields: fetchFields,
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
        | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Unable to load rows (status ${res.status})`);
      }
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      // For offer-scope cost modifier, only update rows with cost in a different currency than the offer
      const filteredRows = isOfferScope && brandBulkEditField === 'CurrencyCostModifier'
        ? rows.filter((row) => {
            const name = typeof (row as { OtherCurrencyName?: unknown }).OtherCurrencyName === 'string'
              ? String((row as { OtherCurrencyName?: unknown }).OtherCurrencyName).trim()
              : '';
            return name.length > 0;
          })
        : rows;
      const ids = filteredRows
        .map((row) => normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
        .filter((id): id is number => id != null);
      if (ids.length === 0) {
        throw new Error(isOfferScope ? 'No cross-currency product rows found in this offer.' : 'No product rows found for this brand.');
      }

      // Capture old values for undo before overwriting
      const capturedField = brandBulkEditField;
      const capturedOldValues = filteredRows.map((row) => ({
        OfferDetailID: normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null),
        value: (row as Record<string, unknown>)[capturedField] ?? null,
      }));

      const chunkSize = 200;
      for (let idx = 0; idx < ids.length; idx += chunkSize) {
        const chunk = ids.slice(idx, idx + chunkSize);
        const updates = chunk.map((OfferDetailID) => ({
          OfferDetailID,
          [brandBulkEditField]: valueNumber,
        }));
        const updateRes = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });
        const updatePayload = (await updateRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!updateRes.ok || !updatePayload?.ok) {
          throw new Error(updatePayload?.error ?? `Bulk update failed (status ${updateRes.status})`);
        }
      }

      const capturedEndpoint = resolvedEndpoint;
      pushUndo({
        label: `${label} bulk update (${ids.length} items)`,
        undo: async () => {
          const undoChunkSize = 200;
          for (let idx = 0; idx < capturedOldValues.length; idx += undoChunkSize) {
            const chunk = capturedOldValues.slice(idx, idx + undoChunkSize);
            const updates = chunk.map((entry) => ({
              OfferDetailID: entry.OfferDetailID,
              [capturedField]: entry.value,
            }));
            const undoRes = await fetch(capturedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert bulk edit');
          }
          refreshOfferProductGrid(null, { purge: false });
        },
      });

      const target = isOfferScope ? 'this offer' : brandName;
      showToastMessage(`${label} updated for ${target} (${ids.length} items)`, 'success', 5500, {
        label: 'Undo',
        onClick: () => performUndo(),
      });
      setBrandBulkEditOpen(false);
      refreshOfferProductGrid(null, { purge: false });
    } catch (err) {
      console.error('Bulk edit failed', err);
      setBrandBulkEditError(err instanceof Error ? err.message : 'Unable to apply changes.');
    } finally {
      setBrandBulkEditSaving(false);
    }
  }, [
    brandBulkEditBrandName,
    brandBulkEditField,
    brandBulkEditSaving,
    brandBulkEditScope,
    brandBulkEditValue,
    pushUndo,
    performUndo,
    refreshOfferProductGrid,
    resolvedEndpoint,
  ]);

  const closeDemoteToRequestedPrompt = useCallback(() => {
    if (demotePromptSaving) return;
    setDemotePromptOpen(false);
    setDemotePromptError(null);
    demotePromptPayloadRef.current = null;
  }, [demotePromptSaving]);

  const confirmDemoteToRequested = useCallback(async () => {
    const payload = demotePromptPayloadRef.current;
    if (!payload) {
      setDemotePromptOpen(false);
      return;
    }
    const requestedQuantity = normalizeRequestedQuantityValue(demotePromptQuantity);
    if (requestedQuantity == null || requestedQuantity <= 0) {
      setDemotePromptError('Please enter a valid quantity greater than zero.');
      return;
    }

    const { node: demoteNode, row: demoteRow, detailId: demoteDetailId } = payload;
    const previous = {
      IsCategory: (demoteRow as { IsCategory?: unknown }).IsCategory ?? null,
      IsComment: (demoteRow as { IsComment?: unknown }).IsComment ?? null,
      IsPrintable: (demoteRow as { IsPrintable?: unknown }).IsPrintable ?? null,
      Description: (demoteRow as { Description?: unknown }).Description ?? null,
      RequestedQuantity: (demoteRow as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
    };

    setDemotePromptSaving(true);
    setDemotePromptError(null);

    try { demoteNode.setDataValue('IsCategory', 0); } catch { /* noop */ }
    try { demoteNode.setDataValue('IsComment', false); } catch { /* noop */ }
    try { demoteNode.setDataValue('IsPrintable', null); } catch { /* noop */ }
    try { demoteNode.setDataValue('Description', null, 'api'); } catch { /* noop */ }
    try { demoteNode.setDataValue('RequestedQuantity', requestedQuantity); } catch { /* noop */ }
    try { demoteNode.setDataValue('__isRequestedRow', 1); } catch { /* noop */ }
    try {
      gridApiRef.current?.refreshCells?.({ rowNodes: [demoteNode], force: true });
    } catch { /* noop */ }

    try {
      const payloadEntry: Record<string, unknown> = {
        OfferDetailID: demoteDetailId,
        IsCategory: 0,
        IsComment: false,
        IsPrintable: null,
        Description: null,
        RequestedQuantity: requestedQuantity,
      };
      const res = await fetch(resolvedEndpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [payloadEntry] }),
      });
      const result = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !result?.ok) {
        throw new Error(result?.error ?? `Unable to set as requested (status ${res.status})`);
      }
      const capturedUndo: Record<string, unknown> = {
        OfferDetailID: demoteDetailId,
        IsCategory: previous.IsCategory,
        IsComment: previous.IsComment,
        IsPrintable: previous.IsPrintable,
        Description: previous.Description,
        RequestedQuantity: previous.RequestedQuantity,
      };
      pushUndo({
        label: 'Set as Requested product',
        undo: async () => {
          const undoRes = await fetch(resolvedEndpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: [capturedUndo] }),
          });
          const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
          if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
          refreshOfferProductGrid(null, { purge: true });
        },
      });
      showToastMessage('Marked as requested product', 'success', 5500, {
        label: 'Undo',
        onClick: () => performUndo(),
      });
      refreshOfferProductGrid(null, { purge: true });
      demotePromptPayloadRef.current = null;
      setDemotePromptOpen(false);
    } catch (err) {
      try { demoteNode.setDataValue('IsCategory', previous.IsCategory ?? null); } catch { /* noop */ }
      try { demoteNode.setDataValue('IsComment', previous.IsComment ?? null); } catch { /* noop */ }
      try { demoteNode.setDataValue('IsPrintable', previous.IsPrintable ?? null); } catch { /* noop */ }
      try { demoteNode.setDataValue('Description', previous.Description ?? null, 'api'); } catch { /* noop */ }
      try { demoteNode.setDataValue('RequestedQuantity', previous.RequestedQuantity ?? null); } catch { /* noop */ }
      try { demoteNode.setDataValue('__isRequestedRow', 0); } catch { /* noop */ }
      try {
        gridApiRef.current?.refreshCells?.({ rowNodes: [demoteNode], force: true });
      } catch { /* noop */ }
      console.error('Failed to set as requested product', err);
      setDemotePromptError(err instanceof Error ? err.message : 'Unable to set row as requested product. Please try again.');
    } finally {
      setDemotePromptSaving(false);
    }
  }, [demotePromptQuantity, resolvedEndpoint, pushUndo, performUndo, refreshOfferProductGrid]);

  const productContextMenuItems = useCallback((
    params: GetContextMenuItemsParams<Record<string, unknown>>,
  ) => {
    const baseItems = productRowDeletion.getContextMenuItems(params) ?? [];
    const items = [...baseItems].filter((item) => item !== 'copy' && item !== 'copyWithHeaders' && item !== 'copyWithGroupHeaders' && item !== 'cut' && item !== 'paste');
    if (pendingContextMenuSelectionClearRef.current) {
      pendingContextMenuSelectionClearRef.current = false;
      setGridRowDeletionContextMenuSelectionSnapshot(params.api ?? null, []);
    }
    const rowNode = params.node ?? null;
    
    // Check if server-side select-all is active
    const api = params.api ?? null;
    const isSelectAllActive = api && typeof api.getServerSideSelectionState === 'function'
      ? (() => {
          const state = api.getServerSideSelectionState();
          return Boolean(state && 'selectAll' in state && Boolean((state as { selectAll?: boolean }).selectAll));
        })()
      : false;
    
    // Get current actual selection from the grid API
    const currentSelectedNodes = !isSelectAllActive && api && typeof api.getSelectedNodes === 'function'
      ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
      : [];
    
    const snapshotNodes = getContextMenuSelectionSnapshot(params.api ?? null);
    
    // Use current selection if available, otherwise fall back to snapshot
    // If snapshot exists but current selection is different (was cleared), use current selection
    const hasCurrentSelection = currentSelectedNodes.length > 0;
    const hasSnapshotSelection = snapshotNodes.length > 0;
    const shouldUseCurrentSelection = hasCurrentSelection || (!hasSnapshotSelection && !isSelectAllActive);
    
    const nodesToConsider = shouldUseCurrentSelection ? currentSelectedNodes : snapshotNodes;
    
    const requestedSelectionIds = nodesToConsider
      .map((node) => normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown })?.OfferDetailID ?? null));
    const clickedRowId = normalizeOfferDetailId(
      (rowNode?.data as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null,
    );
    const snapshotMatchesClick = clickedRowId != null && requestedSelectionIds.some((id) => id === clickedRowId);
    const relevantNodes = nodesToConsider.length > 0 && (snapshotMatchesClick || !rowNode || !rowNode.data)
      ? nodesToConsider
      : rowNode && rowNode.data
        ? [rowNode as RowNode<Record<string, unknown>>]
        : [];
    const fallbackAnchorRowData = !rowNode?.data && api && typeof api.forEachNode === 'function'
      ? (() => {
          let candidate: Record<string, unknown> | null = null;
          api.forEachNode((node) => {
            const nodeData = node?.data as Record<string, unknown> | null | undefined;
            if (!nodeData) return;
            if (!candidate) {
              candidate = nodeData;
              return;
            }
            const treeCompare = compareTreeOrderingValues(
              (nodeData as { TreeOrdering?: unknown }).TreeOrdering ?? null,
              (candidate as { TreeOrdering?: unknown }).TreeOrdering ?? null,
            );
            if (treeCompare > 0) {
              candidate = nodeData;
              return;
            }
            if (treeCompare === 0) {
              const nodeId = normalizeOfferDetailId((nodeData as { OfferDetailID?: unknown }).OfferDetailID ?? null);
              const candidateId = normalizeOfferDetailId((candidate as { OfferDetailID?: unknown }).OfferDetailID ?? null);
              if (nodeId != null && (candidateId == null || nodeId > candidateId)) {
                candidate = nodeData;
              }
            }
          });
          return candidate;
        })()
      : null;
    const rowData = rowNode?.data ?? relevantNodes[0]?.data ?? fallbackAnchorRowData ?? null;
    const isEmptySpaceClick = !rowNode?.data;
    if (!rowData) {
      return items;
    }
    const anchorId = normalizeOfferDetailId(
      (rowData as { OfferDetailID?: unknown }).OfferDetailID ?? null,
    );
    const anchorTree = typeof (rowData as { TreeOrdering?: unknown }).TreeOrdering === 'string'
      ? String((rowData as { TreeOrdering?: unknown }).TreeOrdering).trim()
      : '';
    const clipboardHasRows = isClipboardPopulated();

    if (isEmptySpaceClick) {
      const canPaste = Boolean(onRequestPaste && clipboardHasRows);
      const pasteOnlyItem: MenuItemDef = {
        name: 'Paste Rows',
        icon: pasteRowsMenuIcon,
        disabled: !canPaste,
        tooltip: canPaste ? undefined : 'Clipboard is empty.',
        action: () => {
          if (anchorId != null && anchorTree && onRequestPaste) {
            onRequestPaste(anchorId, anchorTree);
          } else if (onRequestPaste) {
            onRequestPaste(null, null);
          } else {
            showToastMessage('Unable to determine paste position.', 'error');
          }
        },
      };
      return [pasteOnlyItem];
    }

    // Copy (plain) + Copy with… submenu (Headers + Group Headers) + Copy Rows
    const selectedNodesForCopy = api && typeof api.getSelectedNodes === 'function'
      ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
      : [];
    const hasSelection = selectedNodesForCopy.length > 0;
    const copyRowsItem: MenuItemDef = {
      name: 'Copy Rows',
      icon: copyRowsMenuIcon,
      disabled: !hasSelection,
      tooltip: hasSelection ? undefined : 'Select rows to copy first',
      action: () => {
        const selectedData = selectedNodesForCopy
          .filter((node) => node.data != null)
          .map((node) => node.data as Record<string, unknown>);
        if (selectedData.length === 0) {
          showToastMessage('No rows selected to copy.', 'error');
          return;
        }
        const clipboardRows = selectedData.map(mapRowToClipboardRow);
        clipboardRows.sort((a, b) =>
          a.treeOrdering.localeCompare(b.treeOrdering, undefined, { numeric: true }),
        );
        const clipboard: ProductClipboard = {
          sourceOfferId: offerId,
          copiedAt: new Date().toISOString(),
          rows: clipboardRows,
        };
        writeClipboard(clipboard);
        showToastMessage(`Copied ${clipboardRows.length} row(s) to clipboard.`, 'success');
      },
    };
    const copyWithSubmenu: MenuItemDef = {
      name: 'Copy with',
      icon: '<span class="ag-icon ag-icon-copy"></span>',
      subMenu: [
        'copyWithHeaders' as unknown as MenuItemDef,
        'copyWithGroupHeaders' as unknown as MenuItemDef,
      ],
    };
    const clipboardItems: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string> = [
      'copy' as unknown as MenuItemDef,
      copyWithSubmenu,
      'paste' as unknown as MenuItemDef,
    ];
    clipboardItems.push(copyRowsItem);
    if (onRequestPaste && clipboardHasRows) {
      const pasteItem: MenuItemDef = {
        name: 'Paste Rows',
        icon: pasteRowsMenuIcon,
        action: () => {
          if (anchorId != null && anchorTree && onRequestPaste) {
            onRequestPaste(anchorId, anchorTree);
          } else {
            showToastMessage('Unable to determine paste position.', 'error');
          }
        },
      };
      clipboardItems.push(pasteItem);
    }
    if (!standardPackageMode && onRequestAddStandardPackage) {
      const addStandardPackageItem: MenuItemDef = {
        name: 'Add Standard Package',
        icon: addStandardPackageMenuIcon,
        action: () => {
          if (anchorId != null && anchorTree && onRequestAddStandardPackage) {
            onRequestAddStandardPackage(anchorId, anchorTree);
          } else {
            showToastMessage('Unable to determine insertion position.', 'error');
          }
        },
      };
      clipboardItems.push(addStandardPackageItem);
    }
    if (clipboardItems.length > 0) {
      items.unshift(
        ...clipboardItems,
        'separator' as unknown as DefaultMenuItem,
      );
    }

    const rawProductId = (rowData as { ProductID?: unknown }).ProductID;
    const parsedProductId =
      typeof rawProductId === 'number'
        ? rawProductId
        : typeof rawProductId === 'string'
          ? Number.parseInt(rawProductId, 10)
          : null;
    const resolvedProductId =
      typeof parsedProductId === 'number' &&
      Number.isInteger(parsedProductId) &&
      parsedProductId > 0
        ? parsedProductId
        : null;
    const requestedLookup = buildRequestedLookupInfo(rowData);
    const hasRequestedLookupFields = Boolean(requestedLookup.partNumber || requestedLookup.modelNumber);
    const canViewHistory = Boolean(resolvedProductId) || hasRequestedLookupFields;
    if (canViewHistory) {
      const qs = new URLSearchParams();
      qs.set('backHref', `/offers/${encodeURIComponent(offerId)}/products`);
      qs.set('backLabel', `offer ${offerId}`);

      const historyItem: MenuItemDef = {
        name: "View Product's History",
        icon: productHistoryMenuIcon,
        action: async () => {
          let targetProductId = resolvedProductId;
          if (!targetProductId) {
            const fetchedId = await resolveProductIdFromRequestedInfo(requestedLookup);
            if (!fetchedId) {
              showToastMessage('Unable to find a product for the requested entry.', 'error');
              return;
            }
            targetProductId = fetchedId;
          }
          router.push(`/products/${encodeURIComponent(String(targetProductId))}/history?${qs.toString()}`);
        },
      };

      const deleteIndex = findDeleteMenuItemIndex(items);

      if (deleteIndex >= 0) {
        items.splice(deleteIndex, 0, historyItem);
      } else {
        items.push(historyItem);
      }
    }

    const viewProductPartNumber = normalizeRequestedLookupValue(
      (rowData as { PartNumber?: unknown }).PartNumber ??
        (rowData as { RequestedPartNo?: unknown }).RequestedPartNo ?? null,
    );
    const viewProductDescription = normalizeDescriptionValue(
      (rowData as { Description?: unknown }).Description ??
        (rowData as { RequestedDescription?: unknown }).RequestedDescription ?? null,
    );
    if (viewProductPartNumber || viewProductDescription) {
      const viewProductQs = new URLSearchParams();
      if (viewProductPartNumber) viewProductQs.set('partNumber', viewProductPartNumber);
      if (viewProductDescription) viewProductQs.set('description', viewProductDescription);
      const rawPriceListId = (rowData as { PriceListID?: unknown }).PriceListID;
      const parsedPriceListId =
        typeof rawPriceListId === 'number'
          ? rawPriceListId
          : typeof rawPriceListId === 'string'
            ? Number.parseInt(rawPriceListId, 10)
            : null;
      const resolvedPriceListId =
        typeof parsedPriceListId === 'number' &&
        Number.isInteger(parsedPriceListId) &&
        parsedPriceListId > 0
          ? parsedPriceListId
          : null;
      const viewProductSubItems: MenuItemDef[] = [
        {
          name: 'View Product in Products page',
          icon: viewProductMenuIcon,
          action: () => {
            router.push(`/products?${viewProductQs.toString()}`);
          },
        },
      ];
      if (resolvedPriceListId != null) {
        viewProductSubItems.push({
          name: 'View Product in PriceList',
          icon: viewProductMenuIcon,
          action: () => {
            router.push(
              `/price-lists/${encodeURIComponent(String(resolvedPriceListId))}/products?${viewProductQs.toString()}`,
            );
          },
        });
      }
      const viewProductItem: MenuItemDef = {
        name: 'View Product',
        icon: viewProductMenuIcon,
        subMenu: viewProductSubItems,
      };
      const historyIdx = items.findIndex(
        (item) => typeof item === 'object' && item != null && (item as MenuItemDef).name === "View Product's History",
      );
      if (historyIdx >= 0) {
        items.splice(historyIdx, 0, viewProductItem);
      } else {
        const fallbackIdx = findDeleteMenuItemIndex(items);
        if (fallbackIdx >= 0) {
          items.splice(fallbackIdx, 0, viewProductItem);
        } else {
          items.push(viewProductItem);
        }
      }
    }

    const rowHasRequestedFields = hasRequestedPseudoFields(rowData);
    const rowIsActualProduct = isOfferProductProduct(rowData);

    if (rowHasRequestedFields && !rowIsActualProduct) {
      const requestedBrand = normalizeRequestedLookupValue(
        (rowData as { RequestedBrand?: unknown }).RequestedBrand ?? null,
      );
      const requestedPartNo = normalizeRequestedLookupValue(
        (rowData as { RequestedPartNo?: unknown }).RequestedPartNo ?? null,
      );
      const requestedModelNo = normalizeRequestedLookupValue(
        (rowData as { RequestedModelNo?: unknown }).RequestedModelNo ?? null,
      );
      const requestedWebLink = normalizeRequestedLookupValue(
        (rowData as { RequestedWebLink?: unknown }).RequestedWebLink ?? null,
      );
      const requestedDescriptionParts = [
        normalizeDescriptionValue((rowData as { RequestedDescription?: unknown }).RequestedDescription ?? null),
        normalizeDescriptionValue((rowData as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null),
        normalizeDescriptionValue((rowData as { RequestedDescription3?: unknown }).RequestedDescription3 ?? null),
      ].filter((value): value is string => typeof value === 'string' && value.length > 0);
      const requestedDescription = requestedDescriptionParts.length > 0
        ? requestedDescriptionParts.join('\n')
        : null;
      const createNewProductItem: MenuItemDef = {
        name: 'Create New Product',
        icon: createNewProductMenuIcon,
        action: () => {
          setRowAddProductInitialValues({
            brandName: requestedBrand,
            partNumber: requestedPartNo,
            modelNumber: requestedModelNo,
            description: requestedDescription,
            weblink: requestedWebLink,
          });
          setRowAddProductOpen(true);
        },
      };
      const historyIndex = items.findIndex(
        (item) => typeof item === 'object' && item != null && (item as MenuItemDef).name === "View Product's History",
      );
      if (historyIndex >= 0) {
        items.splice(historyIndex, 0, createNewProductItem);
      } else {
        const fallbackIndex = findDeleteMenuItemIndex(items);
        if (fallbackIndex >= 0) {
          items.splice(fallbackIndex, 0, createNewProductItem);
        } else {
          items.push(createNewProductItem);
        }
      }
    }

    let deleteIndexAfterHistory = findDeleteMenuItemIndex(items);

    const rowBrandName = typeof (rowData as { BrandName?: unknown } | null | undefined)?.BrandName === 'string'
      ? String((rowData as { BrandName?: unknown }).BrandName).trim()
      : '';
    const canBulkEditBrand = rowBrandName.length > 0 && isOfferProductProduct(rowData);
    if (canBulkEditBrand) {
      const currentModifier = (rowData as { CurrencyCostModifier?: unknown }).CurrencyCostModifier ?? null;
      const currentMargin = (rowData as { Margin?: unknown }).Margin ?? null;
      const rowCurrencyName = typeof (rowData as { OtherCurrencyName?: unknown } | null | undefined)?.OtherCurrencyName === 'string'
        ? String((rowData as { OtherCurrencyName?: unknown }).OtherCurrencyName).trim()
        : '';
      const rowIsOfferCurrency = rowCurrencyName.length === 0;
      const rowHasModifier = !rowIsOfferCurrency && currentModifier != null && currentModifier !== '' && currentModifier !== 0;
      const setModifierItem: MenuItemDef = {
        name: 'Set cost modifier for this brand',
        icon: costModifierMenuIcon,
        action: () => openBrandBulkEdit('CurrencyCostModifier', rowBrandName, currentModifier, 'brand'),
      };
      const currentCustomerDiscount = (rowData as { CustomerDiscount?: unknown }).CustomerDiscount ?? null;
      const currentTelmacoDiscount = (rowData as { TelmacoDiscount?: unknown }).TelmacoDiscount ?? null;
      // Brand submenu: margin + discounts
      const brandSubmenu: MenuItemDef = {
        name: 'Set for this brand',
        icon: brandBulkEditMenuIcon,
        subMenu: [
          {
            name: 'Margin',
            icon: brandBulkEditMenuIcon,
            action: () => openBrandBulkEdit('Margin', rowBrandName, currentMargin, 'brand'),
          },
          {
            name: 'Customer Discount',
            icon: brandBulkEditMenuIcon,
            action: () => openBrandBulkEdit('CustomerDiscount', rowBrandName, currentCustomerDiscount, 'brand'),
          },
          {
            name: 'Telmaco Discount',
            icon: brandBulkEditMenuIcon,
            action: () => openBrandBulkEdit('TelmacoDiscount', rowBrandName, currentTelmacoDiscount, 'brand'),
          },
        ],
      };
      const bulkItems: MenuItemDef[] = [];
      if (rowHasModifier) {
        bulkItems.push(setModifierItem);
      }
      bulkItems.push(brandSubmenu);
      if (bulkItems.length > 0) {
        if (deleteIndexAfterHistory >= 0) {
          items.splice(deleteIndexAfterHistory, 0, ...bulkItems);
        } else {
          items.push(...bulkItems);
        }
      }
      deleteIndexAfterHistory = findDeleteMenuItemIndex(items);
    }

    if (isSelectAllActive) {
      const deleteItemIndex = findDeleteMenuItemIndex(items);
      if (deleteItemIndex >= 0) {
        const existingDeleteItem = items[deleteItemIndex];
        if (existingDeleteItem && typeof existingDeleteItem === 'object') {
          const totalSelected = Math.max(lastRowCountRef.current ?? 0, 0);
          const deleteCheck = checkDeletePermissionForClient(roles, Math.max(totalSelected, 1), 'offerProducts', 'editOffers', { isCreator: isOfferCreator });
          items[deleteItemIndex] = {
            ...(existingDeleteItem as MenuItemDef),
            name: 'Delete product rows',
            disabled: !deleteCheck.allowed,
            tooltip: deleteCheck.allowed ? undefined : deleteCheck.reason,
            action: async () => {
              try {
                const ids = await fetchAllFilteredOfferDetailIds();
                if (ids.length === 0) {
                  showToastMessage('No product rows selected for deletion.', 'info');
                  return;
                }
                const countLabel = ids.length === 1 ? 'product row' : 'product rows';
                const confirmLabel = ids.length === 1 ? 'Delete product row' : 'Delete product rows';
                const keepLabel = ids.length === 1 ? 'Keep product row' : 'Keep product rows';
                const confirmed = await showConfirmDialog({
                  title: confirmLabel,
                  message: `Delete ${ids.length} ${countLabel}?`,
                  confirmLabel,
                  cancelLabel: keepLabel,
                  tone: 'danger',
                });
                if (!confirmed) return;

                const res = await fetch(resolvedEndpoint, {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ OfferDetailIDs: ids }),
                });
                const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; deletedRows?: Record<string, unknown>[] } | null;
                if (!res.ok || !payload?.ok) {
                  throw new Error(payload?.error ?? `Failed to delete rows (status ${res.status})`);
                }
                const deletedRows = Array.isArray(payload?.deletedRows) ? payload.deletedRows : [];
                if (deletedRows.length > 0) {
                  pushUndo({
                    label: ids.length === 1 ? 'Product deleted' : `${ids.length} products deleted`,
                    undo: async () => {
                      const undoRes = await fetch(`${resolvedEndpoint}/restore`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ rows: deletedRows }),
                      });
                      const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
                      if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to restore');
                      refreshOfferProductGrid(null, { purge: true });
                    },
                  });
                }
                showToastMessage(ids.length === 1 ? 'Product deleted' : `${ids.length} products deleted`, 'success', 5500, {
                  label: 'Undo',
                  onClick: () => performUndo(),
                });
                refreshOfferProductGrid(params.api ?? null, { purge: true });
              } catch (err) {
                console.error('Failed to delete selected products', err);
                showToastMessage(
                  err instanceof Error ? err.message : 'Unable to delete selected products. Please try again.',
                  'error',
                );
              }
            },
          } as MenuItemDef;
        }
      }
    }

    const offerDetailId = normalizeOfferDetailId((rowData as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null);
    const rowCategoryDepth = parseTreeOrderingPath((rowData as { TreeOrdering?: unknown } | null | undefined)?.TreeOrdering ?? null).length;
    const canPromoteAtDepth = rowCategoryDepth === 0 || rowCategoryDepth <= MAX_CATEGORY_DEPTH;
    const canMarkCategory = (
      offerDetailId != null
      && !isOfferProductCategory(rowData)
      && !rowHasRequestedFields
      && canPromoteAtDepth
    );
    if (canMarkCategory) {
      const makeCategoryItem: MenuItemDef = {
        name: 'Set as Category',
        icon: categoryMenuIcon,
        action: async () => {
          const previousIsCategory = rowNode?.data ? (rowNode.data as { IsCategory?: unknown }).IsCategory : null;
          const previousIsComment = rowNode?.data ? (rowNode.data as { IsComment?: unknown }).IsComment : null;
          const previousIsPrintable = rowNode?.data ? (rowNode.data as { IsPrintable?: unknown }).IsPrintable : null;
          const previousDescription = rowNode?.data ? (rowNode.data as { Description?: unknown }).Description : null;
          const previousTreeOrdering = rowNode?.data ? (rowNode.data as { TreeOrdering?: unknown }).TreeOrdering : null;
          const previousRequestedFlag = rowNode?.data ? (rowNode.data as { __isRequestedRow?: unknown }).__isRequestedRow : null;
          const requestedDescriptionPrimary = normalizeDescriptionValue(
            (rowData as { RequestedDescription?: unknown }).RequestedDescription ?? null,
          );
          const requestedDescriptionSecondary = normalizeDescriptionValue(
            (rowData as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
          );
          const requestedDescriptionValue = requestedDescriptionPrimary ?? requestedDescriptionSecondary;
          const descriptionValue = requestedDescriptionValue
            ?? normalizeDescriptionValue((rowData as { Description?: unknown }).Description ?? null);
          const requestedTree = normalizeRequestedItemNoValue((rowData as { RequestedItemNo?: unknown }).RequestedItemNo ?? null);
          const treeOrderingRaw = (rowData as { TreeOrdering?: unknown }).TreeOrdering;
          const treeOrderingValue = requestedTree || (typeof treeOrderingRaw === 'string'
            ? treeOrderingRaw.trim()
            : null);
          const nextCategoryDepth = parseTreeOrderingPath(treeOrderingValue ?? null).length;
          if (nextCategoryDepth > MAX_CATEGORY_DEPTH) {
            showToastMessage('You can only create categories up to sub-sub category level.', 'error');
            return;
          }
          promoteNodeToCategory(
            rowNode,
            treeOrderingValue ?? null,
            descriptionValue ?? null,
            requestedTree,
          );
          try {
            const payloadEntry: Record<string, unknown> = {
              OfferDetailID: offerDetailId,
              IsCategory: 1,
              IsComment: false,
              IsPrintable: null,
            };
            if (descriptionValue != null) {
              payloadEntry.Description = descriptionValue;
            }
            if (treeOrderingValue != null) {
              payloadEntry.TreeOrdering = treeOrderingValue;
              if (requestedTree != null) {
                payloadEntry.RequestedItemNo = requestedTree;
              }
            }
            if (requestedDescriptionPrimary != null) {
              payloadEntry.RequestedDescription = requestedDescriptionPrimary;
            }
            if (requestedDescriptionSecondary != null) {
              payloadEntry.RequestedDescription2 = requestedDescriptionSecondary;
            }
            const res = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                updates: [payloadEntry],
              }),
            });
            const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
            if (!res.ok || !payload?.ok) {
              throw new Error(payload?.error ?? `Unable to mark category (status ${res.status})`);
            }
            const capturedDetailId = offerDetailId;
            const capturedPrev: Record<string, unknown> = { OfferDetailID: capturedDetailId };
            if (previousIsCategory != null) capturedPrev.IsCategory = previousIsCategory;
            if (previousIsComment != null) capturedPrev.IsComment = previousIsComment;
            if (previousIsPrintable != null) capturedPrev.IsPrintable = previousIsPrintable;
            if (previousDescription != null) capturedPrev.Description = previousDescription;
            if (previousTreeOrdering != null) capturedPrev.TreeOrdering = previousTreeOrdering;
            pushUndo({
              label: 'Set as category',
              undo: async () => {
                const undoRes = await fetch(resolvedEndpoint, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ updates: [capturedPrev] }),
                });
                const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
                if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
                refreshOfferProductGrid(null, { purge: true });
              },
            });
            showToastMessage('Marked as category', 'success', 5500, {
              label: 'Undo',
              onClick: () => performUndo(),
            });
            refreshOfferProductGrid(null, { purge: true });
          } catch (err) {
            if (rowNode) {
              try {
                rowNode.setDataValue('IsCategory', previousIsCategory ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('IsComment', previousIsComment ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('IsPrintable', previousIsPrintable ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('Description', previousDescription ?? null, 'api');
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('__isRequestedRow', previousRequestedFlag ?? null);
              } catch {
                /* noop */
              }
              try {
                rowNode.setDataValue('TreeOrdering', previousTreeOrdering ?? null);
              } catch {
                /* noop */
              }
            }
            console.error('Failed to mark category', err);
            showToastMessage('Unable to mark row as category. Please try again.', 'error');
          }
        },
      };
      if (deleteIndexAfterHistory >= 0) {
        items.splice(deleteIndexAfterHistory, 0, makeCategoryItem);
      } else {
        items.push(makeCategoryItem);
      }
    }

    // --- "Set as Comment" for category rows (supports multi-selection) ---
    const commentTargetNodes = relevantNodes.filter((n) => {
      const d = n.data;
      if (!isOfferProductCategory(d)) return false;
      const id = normalizeOfferDetailId((d as { OfferDetailID?: unknown })?.OfferDetailID ?? null);
      return id != null;
    });
    if (commentTargetNodes.length > 0) {
      const buildSetAsCommentAction = (printable: boolean) => async () => {
        // Save previous values for rollback
        const prevStates = commentTargetNodes.map((n) => ({
          node: n,
          IsCategory: n.data ? (n.data as { IsCategory?: unknown }).IsCategory : null,
          IsComment: n.data ? (n.data as { IsComment?: unknown }).IsComment : null,
          IsPrintable: n.data ? (n.data as { IsPrintable?: unknown }).IsPrintable : null,
        }));
        // Optimistic UI update
        for (const n of commentTargetNodes) {
          try {
            n.setDataValue('IsCategory', 0);
            n.setDataValue('IsComment', true);
            n.setDataValue('IsPrintable', printable);
          } catch { /* noop */ }
        }
        const api = gridApiRef.current;
        try {
          api?.refreshCells?.({ rowNodes: commentTargetNodes as GridRowNode[], force: true });
        } catch { /* noop */ }
        try {
          const updates = commentTargetNodes.map((n) => ({
            OfferDetailID: normalizeOfferDetailId((n.data as { OfferDetailID?: unknown })?.OfferDetailID ?? null),
            IsCategory: 0,
            IsComment: true,
            IsPrintable: printable,
          }));
          const res = await fetch(resolvedEndpoint, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payload?.ok) {
            throw new Error(payload?.error ?? `Unable to mark as comment (status ${res.status})`);
          }
          const label = printable ? 'printable comment' : 'non-printable comment';
          const capturedUndoUpdates = prevStates.map((prev) => ({
            OfferDetailID: normalizeOfferDetailId((prev.node.data as { OfferDetailID?: unknown })?.OfferDetailID ?? null),
            IsCategory: prev.IsCategory,
            IsComment: prev.IsComment,
            IsPrintable: prev.IsPrintable,
          }));
          pushUndo({
            label: commentTargetNodes.length === 1 ? `Set as ${label}` : `${commentTargetNodes.length} rows set as ${label}`,
            undo: async () => {
              const undoRes = await fetch(resolvedEndpoint, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ updates: capturedUndoUpdates }),
              });
              const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
              if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
              refreshOfferProductGrid(null, { purge: true });
            },
          });
          showToastMessage(
            commentTargetNodes.length === 1
              ? `Marked as ${label}`
              : `${commentTargetNodes.length} rows marked as ${label}`,
            'success',
            5500,
            { label: 'Undo', onClick: () => performUndo() },
          );
          try { api?.deselectAll?.(); } catch { /* noop */ }
          refreshOfferProductGrid(null, { purge: true });
        } catch (err) {
          // Rollback
          for (const prev of prevStates) {
            try { prev.node.setDataValue('IsCategory', prev.IsCategory ?? null); } catch { /* noop */ }
            try { prev.node.setDataValue('IsComment', prev.IsComment ?? null); } catch { /* noop */ }
            try { prev.node.setDataValue('IsPrintable', prev.IsPrintable ?? null); } catch { /* noop */ }
          }
          try {
            api?.refreshCells?.({ rowNodes: commentTargetNodes as GridRowNode[], force: true });
          } catch { /* noop */ }
          console.error('Failed to mark as comment', err);
          showToastMessage('Unable to mark row(s) as comment. Please try again.', 'error');
        }
      };
      const commentCount = commentTargetNodes.length;
      const makeCommentItem: MenuItemDef = {
        name: commentCount > 1 ? `Set as Comment (${commentCount})` : 'Set as Comment',
        icon: commentMenuIcon,
        subMenu: [
          {
            name: 'Printable',
            action: buildSetAsCommentAction(true),
          },
          {
            name: 'Non Printable',
            action: buildSetAsCommentAction(false),
          },
        ],
      };
      if (deleteIndexAfterHistory >= 0) {
        items.splice(deleteIndexAfterHistory, 0, makeCommentItem);
      } else {
        items.push(makeCommentItem);
      }
    }

    // --- "Set as Requested product" for category rows carrying RequestedDescription ---
    // Reverses the auto-promotion step where a requested row with only a
    // description (no identifiers, no quantity) was turned into a category.
    // With IsCategory=0 and existing RequestedDescription*, the server's
    // __isRequestedRow expression evaluates to 1, so the row re-enters the
    // match flow as an unmatched requested product.
    const requestedDemoteCandidate = relevantNodes.length === 1 ? relevantNodes[0] : null;
    const requestedDemoteRowData = requestedDemoteCandidate?.data as Record<string, unknown> | null | undefined;
    const requestedDemoteEligible = (() => {
      if (!requestedDemoteRowData) return false;
      if (!isOfferProductCategory(requestedDemoteRowData)) return false;
      const id = normalizeOfferDetailId(
        (requestedDemoteRowData as { OfferDetailID?: unknown }).OfferDetailID ?? null,
      );
      if (id == null) return false;
      const d1 = normalizeDescriptionValue(
        (requestedDemoteRowData as { RequestedDescription?: unknown }).RequestedDescription ?? null,
      );
      const d2 = normalizeDescriptionValue(
        (requestedDemoteRowData as { RequestedDescription2?: unknown }).RequestedDescription2 ?? null,
      );
      const d3 = normalizeDescriptionValue(
        (requestedDemoteRowData as { RequestedDescription3?: unknown }).RequestedDescription3 ?? null,
      );
      return Boolean(d1 || d2 || d3);
    })();
    if (requestedDemoteEligible && requestedDemoteCandidate) {
      const demoteNode = requestedDemoteCandidate;
      const demoteRow = requestedDemoteRowData as Record<string, unknown>;
      const demoteDetailId = normalizeOfferDetailId(
        (demoteRow as { OfferDetailID?: unknown }).OfferDetailID ?? null,
      );
      const makeRequestedItem: MenuItemDef = {
        name: 'Set as Requested product',
        icon: categoryMenuIcon,
        action: () => {
          if (demoteDetailId == null) return;
          const existingRequestedQuantity = normalizeRequestedQuantityValue(
            (demoteRow as { RequestedQuantity?: unknown }).RequestedQuantity ?? null,
          );
          demotePromptPayloadRef.current = {
            node: demoteNode as GridRowNode,
            row: demoteRow,
            detailId: demoteDetailId,
          };
          setDemotePromptQuantity(
            existingRequestedQuantity != null && existingRequestedQuantity > 0
              ? String(existingRequestedQuantity)
              : '',
          );
          setDemotePromptError(null);
          setDemotePromptOpen(true);
        },
      };
      if (deleteIndexAfterHistory >= 0) {
        items.splice(deleteIndexAfterHistory, 0, makeRequestedItem);
      } else {
        items.push(makeRequestedItem);
      }
    }

    // --- AI features submenu (web links + enhance description, product rows only) ---
    const selectedNodes = getContextMenuSelectionSnapshot(params.api ?? null);
    const targetNodes = selectedNodes.length > 0 ? selectedNodes : (params.node ? [params.node] : []);
    const targetProductNodes = targetNodes.filter((n) => isOfferProductProduct(n.data));
    const targetProducts = targetProductNodes.map((n) => n.data).filter(Boolean) as Record<string, unknown>[];
    const targetIds = targetProducts
      .map((p) => {
        const raw = p.ProductID;
        if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
        if (typeof raw === 'string') {
          const parsed = Number.parseInt(raw.trim(), 10);
          if (Number.isInteger(parsed)) return parsed;
        }
        return null;
      })
      .filter((id): id is number => id !== null);

    if (targetIds.length > 0 || isSelectAllActive) {
      const productsWithLinks = targetProducts.filter((p) => !!p.WebLink);
      const webLinkItem: MenuItemDef = {
        name: isSelectAllActive
          ? 'Add web links (all filtered)'
          : targetIds.length > 1
            ? `Add web links (${targetIds.length})`
            : 'Add web link',
        icon: addWebLinkMenuIcon,
        disabled: isAddingWebLinks,
        action: async () => {
          let idsToProcess: number[] = [];
          if (isSelectAllActive) {
            const confirmed = await showConfirmDialog({
              title: 'Add web links for all filtered products',
              message: 'This will overwrite any existing web links for the filtered rows. Continue?',
              confirmLabel: 'Continue',
              cancelLabel: 'Cancel',
            });
            if (!confirmed) return;
            try {
              idsToProcess = await fetchAllFilteredOfferProductIds();
            } catch (err) {
              showToastMessage(
                err instanceof Error ? err.message : 'Failed to resolve selected products.',
                'error',
              );
              return;
            }
          } else {
            idsToProcess = [...targetIds];
            if (productsWithLinks.length > 0) {
              const choice = await showMultiChoiceDialog({
                title: 'Existing web links found',
                message:
                  productsWithLinks.length === targetIds.length
                    ? `All ${targetIds.length} selected product(s) already have a web link. Overwrite them?`
                    : `${productsWithLinks.length} of ${targetIds.length} selected product(s) already have a web link.`,
                choices: [
                  { label: 'Overwrite all', value: 'overwrite' },
                  { label: 'Skip existing', value: 'skip' },
                  { label: 'Cancel', value: 'cancel' },
                ],
              });
              if (!choice || choice === 'cancel') return;
              if (choice === 'skip') {
                idsToProcess = targetProducts
                  .filter((p) => !p.WebLink)
                  .map((p) => {
                    const raw = p.ProductID;
                    if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
                    if (typeof raw === 'string') {
                      const parsed = Number.parseInt(raw.trim(), 10);
                      if (Number.isInteger(parsed)) return parsed;
                    }
                    return null;
                  })
                  .filter((id): id is number => id !== null);
              }
            }
          }

          if (idsToProcess.length === 0) {
            showToastMessage('No products selected for web link lookup.', 'info');
            return;
          }
          if (idsToProcess.length > ADD_WEBLINK_MAX_PRODUCTS) {
            showToastMessage(`Cannot process more than ${ADD_WEBLINK_MAX_PRODUCTS} products at once. Please filter first.`, 'error');
            return;
          }

          setIsAddingWebLinks(true);
          const dismissLoadingToast = showToastMessage('Searching for web links\u2026', 'info', 60000);
          try {
            const res = await fetch('/api/products/add-weblinks', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ productIds: idsToProcess }),
            });
            const data = (await res.json()) as {
              ok: boolean;
              updatedCount?: number;
              failedCount?: number;
              error?: string;
            };
            dismissLoadingToast();
            if (data.ok) {
              const msg = data.failedCount
                ? `Updated ${data.updatedCount} web link(s), ${data.failedCount} could not be found.`
                : `Updated ${data.updatedCount} web link(s).`;
              showToastMessage(msg, 'success');
              refreshOfferProductGrid(null, { purge: true });
              router.refresh();
            } else {
              showToastMessage(data.error ?? 'Failed to find web links. Please try again.', 'error');
            }
          } catch {
            dismissLoadingToast();
            showToastMessage('Failed to find web links. Please try again.', 'error');
          } finally {
            setIsAddingWebLinks(false);
          }
        },
      };

      const targetOfferDetailIds = targetProducts
        .map((p) => {
          const pid = (() => {
            const raw = p.ProductID;
            if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
            if (typeof raw === 'string') {
              const parsed = Number.parseInt(raw.trim(), 10);
              if (Number.isInteger(parsed)) return parsed;
            }
            return null;
          })();
          const odId = (() => {
            const raw = p.OfferDetailID;
            if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
            if (typeof raw === 'string') {
              const parsed = Number.parseInt(raw.trim(), 10);
              if (Number.isInteger(parsed)) return parsed;
            }
            return null;
          })();
          return pid !== null && odId !== null ? { productId: pid, offerDetailId: odId } : null;
        })
        .filter((x): x is { productId: number; offerDetailId: number } => x !== null);

      const enhanceDescItem: MenuItemDef = {
        name: isSelectAllActive
          ? 'Enhance descriptions (all filtered)'
          : targetIds.length > 1
            ? `Enhance descriptions (${targetIds.length})`
            : 'Enhance description',
        icon: enhanceDescriptionMenuIcon,
        disabled: isEnhancingDescriptions,
        action: async () => {
          let idsToProcess: Array<{ productId: number; offerDetailId: number }> = [];
          if (isSelectAllActive) {
            const confirmed = await showConfirmDialog({
              title: 'Enhance descriptions for all filtered products',
              message: 'This will overwrite descriptions for the filtered rows. Continue?',
              confirmLabel: 'Continue',
              cancelLabel: 'Cancel',
            });
            if (!confirmed) return;
            try {
              const allProductIds = await fetchAllFilteredOfferProductIds();
              const allDetailIds = await fetchAllFilteredOfferDetailIds();
              idsToProcess = allProductIds.map((pid, i) => ({
                productId: pid,
                offerDetailId: allDetailIds[i] ?? 0,
              })).filter((x) => x.offerDetailId > 0);
            } catch (err) {
              showToastMessage(
                err instanceof Error ? err.message : 'Failed to resolve selected products.',
                'error',
              );
              return;
            }
          } else {
            idsToProcess = [...targetOfferDetailIds];
          }

          if (idsToProcess.length === 0) {
            showToastMessage('No products selected for description enhancement.', 'info');
            return;
          }
          if (idsToProcess.length > ENHANCE_DESC_MAX_PRODUCTS) {
            showToastMessage(`Cannot process more than ${ENHANCE_DESC_MAX_PRODUCTS} products at once. Please filter first.`, 'error');
            return;
          }

          setIsEnhancingDescriptions(true);
          const dismissLoadingToast = showToastMessage('Enhancing descriptions\u2026', 'info', 120000);
          try {
            const res = await fetch('/api/products/enhance-descriptions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ offerDetailIds: idsToProcess }),
            });
            const data = (await res.json()) as {
              ok: boolean;
              updatedCount?: number;
              failedCount?: number;
              results?: Array<{
                productId: number;
                offerDetailId?: number;
                oldDescription: string | null;
                oldOfferDescription?: string | null;
                newDescription: string | null;
                status: string;
              }>;
              error?: string;
            };
            dismissLoadingToast();
            if (data.ok) {
              const msg = data.failedCount
                ? `Enhanced ${data.updatedCount} description(s), ${data.failedCount} could not be enhanced.`
                : `Enhanced ${data.updatedCount} description(s).`;
              showToastMessage(msg, 'success');
              refreshOfferProductGrid(null, { purge: true });
              router.refresh();

              // Push undo entry
              const updatedResults = (data.results ?? []).filter((r) => r.status === 'updated');
              if (updatedResults.length > 0) {
                pushUndo({
                  label: `Enhance ${updatedResults.length} description(s)`,
                  undo: async () => {
                    await fetch('/api/products/enhance-descriptions', {
                      method: 'PUT',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        items: updatedResults.map((r) => ({
                          productId: r.productId,
                          offerDetailId: r.offerDetailId,
                          description: r.oldDescription ?? '',
                          offerDescription: r.oldOfferDescription ?? '',
                        })),
                      }),
                    });
                    refreshOfferProductGrid(null, { purge: true });
                    router.refresh();
                  },
                });
              }
            } else {
              showToastMessage(data.error ?? 'Failed to enhance descriptions. Please try again.', 'error');
            }
          } catch {
            dismissLoadingToast();
            showToastMessage('Failed to enhance descriptions. Please try again.', 'error');
          } finally {
            setIsEnhancingDescriptions(false);
          }
        },
      };

      const aiSubmenu: MenuItemDef = {
        name: 'AI features',
        icon: enhanceDescriptionMenuIcon,
        subMenu: [webLinkItem, enhanceDescItem],
      };
      const aiDeleteIdx = findDeleteMenuItemIndex(items);
      items.splice(aiDeleteIdx >= 0 ? aiDeleteIdx : items.length, 0, aiSubmenu);
    }

    return items;
  }, [
    fetchAllFilteredOfferDetailIds,
    fetchAllFilteredOfferProductIds,
    isAddingWebLinks,
    isEnhancingDescriptions,
    pushUndo,
    performUndo,
    refreshOfferProductGrid,
    roles,
    isOfferCreator,
    productRowDeletion,
    router,
    offerId,
    promoteNodeToCategory,
    resolvedEndpoint,
    openBrandBulkEdit,
    onRequestPaste,
    onRequestAddStandardPackage,
    standardPackageMode,
  ]);

  const handleEmptyGridWrapperContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!onRequestPaste) return;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.() || typeof api.forEachNode !== 'function') return;
    let hasRows = false;
    api.forEachNode(() => {
      hasRows = true;
    });
    if (hasRows) {
      setEmptyGridPasteMenu(null);
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setEmptyGridPasteMenu({ x: event.clientX, y: event.clientY });
  }, [onRequestPaste]);

  const handleEmptyGridPasteRows = useCallback(() => {
    setEmptyGridPasteMenu(null);
    if (!onRequestPaste) return;
    onRequestPaste(null, null);
  }, [onRequestPaste]);

  useEffect(() => {
    if (!emptyGridPasteMenu) return;
    const closeMenu = () => setEmptyGridPasteMenu(null);
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu();
    };
    window.addEventListener('mousedown', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('resize', closeMenu);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [emptyGridPasteMenu]);

  const getCellEditorRawValue = (
    event: CellValueChangedEvent<Record<string, unknown>>,
  ): string | null => {
    const domEvent = (event as { event?: Event }).event;
    if (!domEvent) return null;
    const target = domEvent.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return target.value ?? null;
    }
    return null;
  };

  const handleRequestedFieldEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!isRequestedFieldKey(field)) return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;
    if (!canEditRequestedField(field, event.data)) return;

    const label = REQUESTED_FIELD_LABELS[field];
    const friendlyLabel = `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
    let normalizedOldValue: string | number | null = null;
    let normalizedNewValue: string | number | null = null;

    if (field === 'RequestedQuantity') {
      const rawInput = getCellEditorRawValue(event);
      const candidateValue = rawInput ?? event.newValue;
      normalizedNewValue = normalizeRequestedQuantityValue(candidateValue ?? null);
      normalizedOldValue = normalizeRequestedQuantityValue(event.oldValue ?? null);
      const hasProvidedValue = Boolean(
        (rawInput != null && rawInput.trim().length > 0)
        || (typeof event.newValue === 'number' && Number.isFinite(event.newValue)),
      );
      if (hasProvidedValue && normalizedNewValue == null) {
        showToastMessage('Please enter a valid requested quantity (zero or more).', 'error');
        try {
          event.node?.setDataValue?.(field, normalizedOldValue ?? '');
        } catch {
          /* noop */
        }
        return;
      }
    } else if (field === 'RequestedItemNo') {
      normalizedNewValue = normalizeRequestedItemNoValue(event.newValue ?? null);
      normalizedOldValue = normalizeRequestedItemNoValue(event.oldValue ?? null);
    } else {
      normalizedNewValue = normalizeRequestedLookupValue(event.newValue ?? null);
      normalizedOldValue = normalizeRequestedLookupValue(event.oldValue ?? null);
    }

    if (Object.is(normalizedNewValue, normalizedOldValue)) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId(
      (event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null,
    );
    if (offerDetailId == null) {
      showToastMessage(`Unable to update ${friendlyLabel}. Missing record identifier.`, 'error');
      try {
        event.node?.setDataValue?.(field, normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.(field, normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, [field]: normalizedNewValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${friendlyLabel} (status ${res.status})`);
        }
        const capturedOldValue = normalizedOldValue;
        const capturedDetailId = offerDetailId;
        const capturedField = field;
        pushUndo({
          label: `${friendlyLabel} updated`,
          undo: async () => {
            const undoRes = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates: [{ OfferDetailID: capturedDetailId, [capturedField]: capturedOldValue }] }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
            try { event.node?.setDataValue(capturedField, capturedOldValue); } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage(`${friendlyLabel} updated`, 'success', 5500, {
          label: 'Undo',
          onClick: () => performUndo(),
        });
      } catch (err) {
        console.error(`Failed to update ${friendlyLabel}`, err);
        showToastMessage(`Unable to update ${friendlyLabel}: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

  const handleQuantityEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Quantity') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;
      if (!isOfferProductCommentOrProduct(event.data)) {
        try {
          event.node?.setDataValue?.('Quantity', event.oldValue ?? '');
        } catch {
          /* noop */
        }
      return;
    }

    const normalizedOldValue = coerceNumber(event.oldValue);
    const normalizedNewValue = coerceNumber(event.newValue);
    if (normalizedNewValue == null || normalizedNewValue < 0) {
      showToastMessage('Please enter a valid quantity (zero or more).', 'error');
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }
    if (normalizedOldValue != null && Object.is(normalizedOldValue, normalizedNewValue)) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update quantity. Missing record identifier.', 'error');
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const oldRowTotalsSnapshot = snapshotRowTotals(event.data as Record<string, unknown>);

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, Quantity: normalizedNewValue }],
          }),
        });
        let payload: { ok?: boolean; error?: string } | null = null;
        try {
          payload = (await res.json()) as { ok?: boolean; error?: string } | null;
        } catch {
          payload = null;
        }
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update quantity (status ${res.status})`);
        }
        const capturedOldQty = normalizedOldValue;
        const capturedDetailId = offerDetailId;
        pushUndo({
          label: 'Quantity updated',
          undo: async () => {
            const undoRes = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates: [{ OfferDetailID: capturedDetailId, Quantity: capturedOldQty }] }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
            try { event.node?.setDataValue('Quantity', capturedOldQty); } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage('Quantity updated', 'success', 5500, {
          label: 'Undo',
          onClick: () => performUndo(),
        });
        recalcProductTotals(event, normalizedNewValue);
        refreshCategoryAggregates(event.api);
        if (event.data) {
          const newRowTotals = snapshotRowTotals(event.data as Record<string, unknown>);
          applyRowTotalsDelta(oldRowTotalsSnapshot, newRowTotals);
        }
      } catch (err) {
        console.error('Failed to update quantity', err);
        showToastMessage(`Unable to update quantity: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo, snapshotRowTotals, applyRowTotalsDelta]);

  const handleDescriptionEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const editedField = event.colDef.field;
    if (editedField !== 'Description' && editedField !== 'ProductDescription') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;
    const normalizedOldValue = normalizeDescriptionValue(event.oldValue);
    const normalizedNewValue = normalizeDescriptionValue(event.newValue);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }
    // Reject values that match toolbar button labels (accidental clipboard paste).
    if (normalizedNewValue != null && DESCRIPTION_PASTE_BLOCKLIST.has(normalizedNewValue)) {
      try { event.node?.setDataValue?.(editedField, normalizedOldValue ?? '', 'api'); } catch { /* noop */ }
      return;
    }
    // All edits here target the offer-specific ProductDescription so shared product rows stay untouched.
    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update description. Missing record identifier.', 'error');
      event.node?.setDataValue?.(editedField, normalizedOldValue ?? '');
      return;
    }
    const revertValue = () => {
      try {
        event.node?.setDataValue?.(editedField, normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };
    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates: [{ OfferDetailID: offerDetailId, ProductDescription: normalizedNewValue }],
        }),
        });
        let payload: { ok?: boolean; error?: string } | null = null;
        try {
          payload = (await res.json()) as { ok?: boolean; error?: string } | null;
        } catch {
          payload = null;
        }
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update description (status ${res.status})`);
        }
        try {
          event.node?.setDataValue?.('Description', normalizedNewValue ?? '', 'api');
          event.node?.setDataValue?.('ProductDescription', normalizedNewValue ?? '', 'api');
        } catch {
          /* noop */
        }
        const capturedOldDesc = normalizedOldValue;
        const capturedDetailId = offerDetailId;
        pushUndo({
          label: 'Description updated',
          undo: async () => {
            const undoRes = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates: [{ OfferDetailID: capturedDetailId, ProductDescription: capturedOldDesc }] }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
            try {
              event.node?.setDataValue?.('Description', capturedOldDesc ?? '', 'api');
              event.node?.setDataValue?.('ProductDescription', capturedOldDesc ?? '', 'api');
            } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage('Description updated', 'success', 5500, {
          label: 'Undo',
          onClick: () => performUndo(),
        });
      } catch (err) {
        console.error('Failed to update description', err);
        showToastMessage(`Unable to update description: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

  const handleCommentEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Comment') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    const row = event.data ?? null;
    if (!isOfferProductCategory(row) && !isOfferProductComment(row) && !isOfferProductProduct(row)) {
      try {
        event.node?.setDataValue?.('Comment', event.oldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const normalizedOldValue = normalizeDescriptionValue(event.oldValue);
    const normalizedNewValue = normalizeDescriptionValue(event.newValue);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update comment. Missing record identifier.', 'error');
      try {
        event.node?.setDataValue?.('Comment', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Comment', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, Comment: normalizedNewValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update comment (status ${res.status})`);
        }
        const capturedOldComment = normalizedOldValue;
        const capturedDetailId = offerDetailId;
        pushUndo({
          label: 'Comment updated',
          undo: async () => {
            const undoRes = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates: [{ OfferDetailID: capturedDetailId, Comment: capturedOldComment }] }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
            try { event.node?.setDataValue?.('Comment', capturedOldComment ?? ''); } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage('Comment updated', 'success', 5500, {
          label: 'Undo',
          onClick: () => performUndo(),
        });
      } catch (err) {
        console.error('Failed to update comment', err);
        showToastMessage(`Unable to update comment: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

  const handleDeliveryEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Delivery') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    const normalizedOldValue = normalizeRequestedLookupValue(event.oldValue ?? null);
    const normalizedNewValue = normalizeRequestedLookupValue(event.newValue ?? null);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update delivery. Missing record identifier.', 'error');
      try {
        event.node?.setDataValue?.('Delivery', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Delivery', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, Delivery: normalizedNewValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update delivery (status ${res.status})`);
        }
        const capturedOldDelivery = normalizedOldValue;
        const capturedDetailId = offerDetailId;
        pushUndo({
          label: 'Delivery updated',
          undo: async () => {
            const undoRes = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates: [{ OfferDetailID: capturedDetailId, Delivery: capturedOldDelivery }] }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
            try { event.node?.setDataValue?.('Delivery', capturedOldDelivery ?? ''); } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage('Delivery updated', 'success', 5500, {
          label: 'Undo',
          onClick: () => performUndo(),
        });
      } catch (err) {
        console.error('Failed to update delivery', err);
        showToastMessage(`Unable to update delivery: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

  const handlePartModelNumberEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (field !== 'PartNumber' && field !== 'ModelNumber') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    const normalizedOldValue = typeof event.oldValue === 'string' ? event.oldValue.trim() || null : null;
    const rawNew = typeof event.newValue === 'string' ? event.newValue.trim() || null : null;
    const normalizedNewValue = rawNew;
    if (normalizedOldValue === normalizedNewValue) return;

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage(`Unable to update ${field}. Missing record identifier.`, 'error');
      try { event.node?.setDataValue?.(field, normalizedOldValue ?? ''); } catch { /* noop */ }
      return;
    }

    const revertValue = () => {
      try { event.node?.setDataValue?.(field, normalizedOldValue ?? ''); } catch { /* noop */ }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, [field]: normalizedNewValue }],
          }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${field} (status ${res.status})`);
        }
        const capturedOldValue = normalizedOldValue;
        const capturedDetailId = offerDetailId;
        pushUndo({
          label: `${field} updated`,
          undo: async () => {
            const undoRes = await fetch(resolvedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates: [{ OfferDetailID: capturedDetailId, [field]: capturedOldValue }] }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
            try { event.node?.setDataValue?.(field, capturedOldValue ?? ''); } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage(`${field} updated`, 'success', 5500, {
          label: 'Undo',
          onClick: () => performUndo(),
        });
      } catch (err) {
        console.error(`Failed to update ${field}`, err);
        showToastMessage(`Unable to update ${field}: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

  const handlePricingEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !PRICING_EDITABLE_FIELDS.has(field)) return;
    const label = PRICING_FIELD_LABELS[field] ?? field;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    if (!isOfferProductCommentOrProduct(event.data)) {
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      showToastMessage('Pricing can only be edited on product or comment rows.', 'error');
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage(`Unable to update ${label}. Missing record identifier.`, 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }

    let normalizedNewValue = coerceNumber(event.newValue);
    if (field === 'CurrencyCostModifier') {
      if (source === 'delete' && normalizedNewValue == null) {
        normalizedNewValue = 1;
      }
      if (normalizedNewValue == null && String(event.newValue ?? '').trim() === '') {
        normalizedNewValue = 1;
      }
    } else {
      if (source === 'delete' && normalizedNewValue == null) {
        normalizedNewValue = 0;
      }
      if (normalizedNewValue == null && String(event.newValue ?? '').trim() === '') {
        normalizedNewValue = 0;
      }
    }
    if (normalizedNewValue == null || !Number.isFinite(normalizedNewValue)) {
      showToastMessage(`Please enter a valid ${label.toLowerCase()}.`, 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      event.api?.stopEditing?.();
      event.api?.clearFocusedCell?.();
      return;
    }
    if (field === 'Margin' && Math.abs(normalizedNewValue) >= 100) {
      showToastMessage('Margin must be between -100 and 100.', 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      event.api?.stopEditing?.();
      event.api?.clearFocusedCell?.();
      return;
    }
    if (field === 'CurrencyCostModifier' && !(normalizedNewValue > 0)) {
      showToastMessage('Cost modifier must be greater than 0.', 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      event.api?.stopEditing?.();
      event.api?.clearFocusedCell?.();
      return;
    }

    const normalizedOldValue = coerceNumber(event.oldValue);
    if (normalizedOldValue != null && Object.is(normalizedOldValue, normalizedNewValue)) {
      return;
    }

    const revertValue = () => {
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
    };

    const oldRowTotalsSnapshot = isOfferProductCommentOrProduct(event.data)
      ? snapshotRowTotals(event.data as Record<string, unknown>)
      : null;

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ OfferDetailID: offerDetailId, [field]: normalizedNewValue }] }),
        });
        const payload = (await res.json().catch(() => null)) as {
          ok?: boolean;
          error?: string;
          resolvedRows?: Array<Record<string, unknown> & { OfferDetailID?: number }>;
        } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label} (status ${res.status})`);
        }
        const resolved = payload.resolvedRows?.find(
          (row) => normalizeOfferDetailId(row?.OfferDetailID ?? null) === offerDetailId,
        );
        if (resolved && event.node && event.data) {
          const derivedFields: Array<keyof typeof resolved> = [
            'CustomerDiscount',
            'TelmacoDiscount',
            'NetUnitPrice',
            'NetCost',
            'Margin',
            'ListPrice',
            'NetCostOtherCurrency',
            'OtherCurrencyID',
            'CurrencyCostModifier',
            'TotalPrice',
            'TotalNet',
            'TotalCost',
            'GrossProfit',
          ];
          derivedFields.forEach((derivedField) => {
            if (derivedField === field) return;
            const newDerived = (resolved as Record<string, unknown>)[derivedField as string] ?? null;
            const currentDerived = (event.data as Record<string, unknown>)[derivedField as string] ?? null;
            const a = coerceNumber(newDerived);
            const b = coerceNumber(currentDerived);
            if (a == null && b == null) return;
            if (a != null && b != null && Object.is(a, b)) return;
            registerRealtimeCellUpdate(offerDetailId, derivedField as string, newDerived);
            try { event.node?.setDataValue(derivedField as string, newDerived); } catch { /* noop */ }
          });
        }
        const toastKey = `${offerDetailId}:${field}:${String(normalizedNewValue)}`;
        const now = Date.now();
        const lastShown = pricingToastDedupRef.current.get(toastKey) ?? 0;
        if (now - lastShown > 800) {
          pricingToastDedupRef.current.set(toastKey, now);
          const capturedOldPricing = normalizedOldValue;
          const capturedDetailId = offerDetailId;
          const capturedField = field;
          pushUndo({
            label: `${label} updated`,
            undo: async () => {
              const undoRes = await fetch(resolvedEndpoint, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ updates: [{ OfferDetailID: capturedDetailId, [capturedField]: capturedOldPricing }] }),
              });
              const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
              if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
              try { event.node?.setDataValue(capturedField, capturedOldPricing); } catch { /* noop */ }
              event.api?.refreshServerSide?.({ purge: false });
            },
          });
          showToastMessage(`${label} updated`, 'success', 5500, {
            label: 'Undo',
            onClick: () => performUndo(),
          });
        }
        recalcProductTotals(event);
        refreshCategoryAggregates(event.api);
        if (oldRowTotalsSnapshot && event.data) {
          const newRowTotals = snapshotRowTotals(event.data as Record<string, unknown>);
          applyRowTotalsDelta(oldRowTotalsSnapshot, newRowTotals);
        }
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo, registerRealtimeCellUpdate, snapshotRowTotals, applyRowTotalsDelta]);

  const handleOriginEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Origin') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    if (shouldSkipRealtimeCellEdit(event)) return;

    const normalizeOrigin = (value: unknown): string | null => {
      if (value == null) return null;
      const trimmed = String(value).trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const oldValue = normalizeOrigin(event.oldValue ?? null);
    const newValue = normalizeOrigin(event.newValue ?? null);
    if (oldValue === newValue) return;

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Origin', oldValue);
      } catch {
        /* noop */
      }
    };

    const rawProductId = (event.data as { ProductID?: unknown } | undefined)?.ProductID ?? null;
    const productId = typeof rawProductId === 'number' && Number.isFinite(rawProductId)
      ? Math.trunc(rawProductId)
      : typeof rawProductId === 'string'
        ? Number.parseInt(rawProductId.trim(), 10)
        : NaN;
    if (!Number.isFinite(productId) || !Number.isInteger(productId) || productId <= 0) {
      showToastMessage('Unable to update origin. Missing product id.', 'error');
      revertValue();
      return;
    }

    const runUpdate = async () => {
      try {
        const res = await fetch(`/api/products/${encodeURIComponent(String(productId))}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ origin: newValue }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update origin (status ${res.status})`);
        }
        const capturedOldValue = oldValue;
        const capturedProductId = productId;
        pushUndo({
          label: 'Origin updated',
          undo: async () => {
            const undoRes = await fetch(`/api/products/${encodeURIComponent(String(capturedProductId))}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ origin: capturedOldValue }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert');
            try { event.node?.setDataValue?.('Origin', capturedOldValue); } catch { /* noop */ }
            event.api?.refreshServerSide?.({ purge: false });
          },
        });
        showToastMessage('Origin updated', 'success', 5500, {
          label: 'Undo',
          onClick: () => performUndo(),
        });
      } catch (err) {
        console.error('Failed to update origin', err);
        showToastMessage(`Unable to update origin: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
        revertValue();
        event.api?.stopEditing?.();
        event.api?.clearFocusedCell?.();
      }
    };

    void runUpdate();
  }, [shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    handleDescriptionEdit(event);
    handleCommentEdit(event);
    handleDeliveryEdit(event);
    handleRequestedFieldEdit(event);
    handleQuantityEdit(event);
    handlePricingEdit(event);
    handlePartModelNumberEdit(event);
    handleOriginEdit(event);
  }, [handleDescriptionEdit, handleCommentEdit, handleDeliveryEdit, handleRequestedFieldEdit, handleQuantityEdit, handlePricingEdit, handlePartModelNumberEdit, handleOriginEdit]);

  const offerCurrencySymbol = offerCurrencyName ?? '€';
  const withCurrency = (formatted: string) =>
    offerCurrencySymbol === '$' ? `${offerCurrencySymbol} ${formatted}` : `${formatted} ${offerCurrencySymbol}`;
  const formatEuroTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return withCurrency(decimalFormatter.format(value));
  };
  const formatPercentTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} %`;
  };
  const formatDiscountTotal = (listPrice: number | null | undefined, netPrice: number | null | undefined) => {
    if (
      listPrice == null
      || netPrice == null
      || !Number.isFinite(listPrice)
      || !Number.isFinite(netPrice)
    ) {
      return '—';
    }
    const discount = listPrice - netPrice;
    const percent = Math.abs(listPrice) < 1e-9 ? 0 : (discount / listPrice) * 100;
    return `${withCurrency(decimalFormatter.format(discount))} (${decimalFormatter.format(percent)} %)`;
  };

  const beginEditTotalNet = useCallback(() => {
    if (totalNetApplying) return;
    const current = totals?.totalNetPrice;
    const initial = current != null && Number.isFinite(current) ? String(roundMoney(current, 2)) : '';
    setTotalNetInputValue(initial);
    setTotalNetEditing(true);
  }, [totalNetApplying, totals]);

  const cancelEditTotalNet = useCallback(() => {
    totalNetSubmitPendingRef.current = false;
    setTotalNetEditing(false);
    setTotalNetInputValue('');
  }, []);

  const applyTotalNetPriceScale = useCallback(async (targetTotal: number) => {
    if (totalNetApplying) return;
    const currentTotal = totals?.totalNetPrice ?? 0;
    if (!Number.isFinite(currentTotal) || Math.abs(currentTotal) < 1e-9) {
      showToastMessage('Cannot scale from a zero total. Set at least one product net price first.', 'error');
      return;
    }
    if (!Number.isFinite(targetTotal)) {
      showToastMessage('Please enter a valid total net price.', 'error');
      return;
    }
    if (Math.abs(targetTotal - currentTotal) < 1e-4) {
      cancelEditTotalNet();
      return;
    }

    const confirmed = await showConfirmDialog({
      title: 'Adjust all Net Unit Prices?',
      message: `This will proportionally rescale the Net Unit Price of every product row so the offer total matches ${formatEuroTotal(targetTotal)} (currently ${formatEuroTotal(currentTotal)}). This change affects all priced product rows and cannot be undone in a single step.`,
      confirmLabel: 'Rescale prices',
      cancelLabel: 'Keep as-is',
      tone: 'danger',
    });
    if (!confirmed) {
      cancelEditTotalNet();
      return;
    }

    setTotalNetApplying(true);
    try {
      const fetchRes = await fetch(resolvedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: { allRows: true, view: 'pivot' },
          fields: ['OfferDetailID', 'NetUnitPrice', 'Quantity', 'RowType'],
        }),
      });
      const fetchPayload = (await fetchRes.json().catch(() => null)) as
        | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
        | null;
      if (!fetchRes.ok || !fetchPayload?.ok) {
        throw new Error(fetchPayload?.error ?? `Unable to load rows (status ${fetchRes.status})`);
      }
      const rows = Array.isArray(fetchPayload?.rows) ? fetchPayload.rows : [];

      type Entry = { OfferDetailID: number; oldNet: number; quantity: number; newNet: number };
      const entries: Entry[] = [];
      let recomputedTotal = 0;
      for (const row of rows) {
        if (!isOfferProductProduct(row)) continue;
        const id = normalizeOfferDetailId((row as { OfferDetailID?: unknown }).OfferDetailID ?? null);
        if (id == null) continue;
        const net = coerceNumber((row as { NetUnitPrice?: unknown }).NetUnitPrice);
        const qty = coerceNumber((row as { Quantity?: unknown }).Quantity);
        if (net == null || qty == null) continue;
        entries.push({ OfferDetailID: id, oldNet: net, quantity: qty, newNet: net });
        recomputedTotal += net * qty;
      }

      if (entries.length === 0 || Math.abs(recomputedTotal) < 1e-9) {
        showToastMessage('No product rows with a priced quantity to rescale.', 'error');
        return;
      }

      const scale = targetTotal / recomputedTotal;

      // Group entries that currently share the same net price — identical products
      // must keep identical prices after rescale, even when distributing residual.
      type PriceGroup = { entries: Entry[]; newNet: number; totalQty: number };
      const groupMap = new Map<number, PriceGroup>();
      for (const entry of entries) {
        let group = groupMap.get(entry.oldNet);
        if (!group) {
          group = { entries: [], newNet: roundMoney(entry.oldNet * scale, 2), totalQty: 0 };
          groupMap.set(entry.oldNet, group);
        }
        group.entries.push(entry);
        group.totalQty += Math.round(entry.quantity);
        entry.newNet = group.newNet;
      }
      const groups = [...groupMap.values()];

      // Close the 0.01 residual by shifting whole groups (keeps identical prices in lockstep).
      // Each 0.01 step on a group moves the achieved total by totalQty * 0.01.
      const toUnits = (x: number) => Math.round(x * 100);
      const fromUnits = (u: number) => u / 100;
      const setGroupNet = (group: PriceGroup, unitValue: number) => {
        group.newNet = fromUnits(unitValue);
        for (const e of group.entries) e.newNet = group.newNet;
      };
      const targetUnits = toUnits(targetTotal);
      const achievedUnits = groups.reduce((s, g) => s + toUnits(g.newNet) * g.totalQty, 0);
      let diffUnits = targetUnits - achievedUnits;

      if (diffUnits !== 0) {
        // Pass 1: largest-quantity groups first, take whole steps.
        const byQtyDesc = groups.filter((g) => g.totalQty > 0).sort((a, b) => b.totalQty - a.totalQty);
        for (const g of byQtyDesc) {
          if (diffUnits === 0) break;
          const steps = diffUnits > 0 ? Math.floor(diffUnits / g.totalQty) : Math.ceil(diffUnits / g.totalQty);
          if (steps === 0) continue;
          setGroupNet(g, toUnits(g.newNet) + steps);
          diffUnits -= steps * g.totalQty;
        }
        // Pass 2: one step on the smallest-qty group if it moves closer to target
        // (may overshoot). Preserves equal-price rule; can't always hit exact target.
        if (diffUnits !== 0) {
          const byQtyAsc = groups.filter((g) => g.totalQty > 0).sort((a, b) => a.totalQty - b.totalQty);
          for (const g of byQtyAsc) {
            if (diffUnits === 0) break;
            const dir = diffUnits > 0 ? 1 : -1;
            const delta = dir * g.totalQty;
            if (Math.abs(diffUnits - delta) < Math.abs(diffUnits)) {
              setGroupNet(g, toUnits(g.newNet) + dir);
              diffUnits -= delta;
            }
          }
        }
      }

      const chunkSize = 200;
      for (let idx = 0; idx < entries.length; idx += chunkSize) {
        const chunk = entries.slice(idx, idx + chunkSize);
        const updates = chunk.map((e) => ({ OfferDetailID: e.OfferDetailID, NetUnitPrice: e.newNet }));
        const updateRes = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });
        const updatePayload = (await updateRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!updateRes.ok || !updatePayload?.ok) {
          throw new Error(updatePayload?.error ?? `Rescale failed (status ${updateRes.status})`);
        }
      }

      const capturedEntries = entries.map((e) => ({ OfferDetailID: e.OfferDetailID, oldNet: e.oldNet }));
      const capturedEndpoint = resolvedEndpoint;
      pushUndo({
        label: `Total Net Price rescaled (${entries.length} items)`,
        undo: async () => {
          for (let idx = 0; idx < capturedEntries.length; idx += chunkSize) {
            const chunk = capturedEntries.slice(idx, idx + chunkSize);
            const updates = chunk.map((e) => ({ OfferDetailID: e.OfferDetailID, NetUnitPrice: e.oldNet }));
            const undoRes = await fetch(capturedEndpoint, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ updates }),
            });
            const undoPayload = (await undoRes.json().catch(() => null)) as { ok?: boolean } | null;
            if (!undoRes.ok || !undoPayload?.ok) throw new Error('Failed to revert rescale');
          }
          refreshOfferProductGrid(null, { purge: false });
        },
      });

      showToastMessage(`Total Net Price set to ${formatEuroTotal(targetTotal)} (${entries.length} items updated)`, 'success', 5500, {
        label: 'Undo',
        onClick: () => performUndo(),
      });
      setTotalNetEditing(false);
      setTotalNetInputValue('');
      refreshOfferProductGrid(null, { purge: false });
    } catch (err) {
      console.error('Total Net Price rescale failed', err);
      showToastMessage(`Unable to rescale: ${err instanceof Error ? err.message : 'Please try again.'}`, 'error');
    } finally {
      setTotalNetApplying(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cancelEditTotalNet, formatEuroTotal, offerCurrencySymbol, performUndo, pushUndo, refreshOfferProductGrid, resolvedEndpoint, totalNetApplying, totals]);

  const submitTotalNetEdit = useCallback(() => {
    if (totalNetSubmitPendingRef.current) return;
    const parsed = coerceNumber(totalNetInputValue);
    if (parsed == null) {
      showToastMessage('Please enter a valid total net price.', 'error');
      setTotalNetEditing(false);
      setTotalNetInputValue('');
      return;
    }
    totalNetSubmitPendingRef.current = true;
    void applyTotalNetPriceScale(parsed).finally(() => {
      totalNetSubmitPendingRef.current = false;
    });
  }, [applyTotalNetPriceScale, totalNetInputValue]);

  const beginEditTotalMargin = useCallback(() => {
    if (totalNetApplying) return;
    const current = totals?.totalMargin;
    const initial = current != null && Number.isFinite(current) ? String(roundMoney(current, 2)) : '';
    setTotalMarginInputValue(initial);
    setTotalMarginEditing(true);
  }, [totalNetApplying, totals]);

  const cancelEditTotalMargin = useCallback(() => {
    totalMarginSubmitPendingRef.current = false;
    setTotalMarginEditing(false);
    setTotalMarginInputValue('');
  }, []);

  const submitTotalMarginEdit = useCallback(() => {
    if (totalMarginSubmitPendingRef.current) return;
    const parsed = coerceNumber(totalMarginInputValue);
    if (parsed == null || !Number.isFinite(parsed)) {
      showToastMessage('Please enter a valid total margin.', 'error');
      setTotalMarginEditing(false);
      setTotalMarginInputValue('');
      return;
    }
    if (parsed >= 100) {
      showToastMessage('Total margin must be less than 100.', 'error');
      return;
    }
    const currentCost = totals?.totalCost ?? 0;
    if (!Number.isFinite(currentCost) || Math.abs(currentCost) < 1e-9) {
      showToastMessage('Cannot derive target from a zero total cost.', 'error');
      setTotalMarginEditing(false);
      setTotalMarginInputValue('');
      return;
    }
    const targetTotalNet = currentCost / (1 - parsed / 100);
    if (!Number.isFinite(targetTotalNet)) {
      showToastMessage('Unable to compute a valid target net price.', 'error');
      return;
    }
    totalMarginSubmitPendingRef.current = true;
    void applyTotalNetPriceScale(roundMoney(targetTotalNet, 2)).finally(() => {
      totalMarginSubmitPendingRef.current = false;
      setTotalMarginEditing(false);
      setTotalMarginInputValue('');
    });
  }, [applyTotalNetPriceScale, totalMarginInputValue, totals]);

  // Real-time updates for collaborative editing
  // showNotifications: false - only the person making the edit sees toasts from their own actions
  useRealtimeGridUpdates({
    resource: `offer:${offerId}:products`,
    gridApi: gridApiRef.current,
    enabled: true,
    showNotifications: false,
    onBeforeCellUpdate: (info) => {
      registerRealtimeCellUpdate(info.rowId, info.field, info.value);
    },
  });

  // Floating "+" insertion line between rows on hover
  const insertLineRef = useRef<HTMLDivElement | null>(null); // hover "+" line
  const pinnedLineRef = useRef<HTMLDivElement | null>(null); // pinned thick line (separate element)
  const insertLineDataRef = useRef<{ offerDetailId: number; parentPath: number[]; label: string; treeOrdering: string; isRequested: boolean } | null>(null);
  const insertLinePinnedRef = useRef(false);
  const insertLinePinnedAtRef = useRef(0);
  const insertLinePinTopRef = useRef(0);
  const insertLinePinScrollRef = useRef(0);
  const insertLineAtEndPendingRef = useRef(false);
  const insertLinePinnedAtEndRef = useRef(false);
  const prevDisplayedRowCountRef = useRef(0);
  const showInsertLineOnHoverRef = useRef(showInsertLineOnHover);
  showInsertLineOnHoverRef.current = showInsertLineOnHover;
  const onRequestInsertProductRef = useRef(onRequestInsertProduct);
  onRequestInsertProductRef.current = onRequestInsertProduct;

  const getLineWidth = useCallback(() => {
    const wrapper = gridWrapperRef.current;
    if (!wrapper) return '100%';
    const sidebar = wrapper.querySelector('.ag-side-bar') as HTMLElement | null;
    const sidebarWidth = sidebar ? sidebar.offsetWidth : 0;
    return `${wrapper.offsetWidth - sidebarWidth}px`;
  }, []);

  useEffect(() => {
    const wrapper = gridWrapperRef.current;
    if (!wrapper) return;

    const hide = () => {
      // Always hide the hover "+" line (pinned line is a separate element)
      const line = insertLineRef.current;
      if (line) line.style.display = 'none';
    };

    const handleMouseMove = (e: MouseEvent) => {
      const line = insertLineRef.current;
      if (!line) return;
      const target = e.target as HTMLElement;
      if (!showInsertLineOnHoverRef.current) {
        if (!insertLinePinnedRef.current) hide();
        return;
      }
      if (line.contains(target)) return;
      // When pinned, still show the hover "+" so user can pick a new position
      const agRow = target.closest('.ag-row') as HTMLElement | null;
      if (!agRow) {
        // Show "+" below the last row when hovering in empty viewport space
        const vpEl = target.closest('.ag-body-viewport, .ag-center-cols-viewport, .ag-center-cols-container') as HTMLElement | null;
        if (vpEl) {
          const api = gridApiRef.current;
          if (api && !api.isDestroyed?.()) {
            const rowCount = api.getDisplayedRowCount();
            if (rowCount > 0) {
              const lastNode = api.getDisplayedRowAtIndex(rowCount - 1);
              const lastData = lastNode?.data as Record<string, unknown> | null | undefined;
              if (lastData) {
                const lastId = normalizeOfferDetailId((lastData as { OfferDetailID?: unknown }).OfferDetailID ?? null);
                const lastTreeRaw = (lastData as { TreeOrdering?: unknown }).TreeOrdering ?? null;
                const lastPath = parseTreeOrderingPath(lastTreeRaw);
                if (lastId != null && lastPath.length > 0) {
                  // Find the last row element to get its bottom position
                  const viewport = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
                  if (viewport) {
                    let lastRowEl: HTMLElement | null = null;
                    let lastRowIdx = -1;
                    const rowEls = viewport.querySelectorAll('.ag-row');
                    for (const row of rowEls) {
                      const idx = row.getAttribute('row-index');
                      if (idx == null) continue;
                      const rowIdx = Number.parseInt(idx, 10);
                      if (rowIdx > lastRowIdx) { lastRowIdx = rowIdx; lastRowEl = row as HTMLElement; }
                    }
                    if (lastRowEl) {
                      const wrapperRect = wrapper.getBoundingClientRect();
                      const viewportEl = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
                      const viewportRect = viewportEl?.getBoundingClientRect();
                      const lastRowRect = lastRowEl.getBoundingClientRect();
                      if (viewportRect && lastRowRect.bottom >= viewportRect.top && lastRowRect.bottom <= viewportRect.bottom) {
                        line.style.display = 'flex';
                        line.style.top = `${lastRowRect.bottom - wrapperRect.top}px`;
                        line.style.width = getLineWidth();
                        const lastTree = typeof lastTreeRaw === 'string' ? lastTreeRaw.trim() : buildTreeOrderingKey(lastPath);
                        const lastLabel = resolveRowLabel(lastData, '');
                        const lastRequested = isRequestedRow(lastData);
                        insertLineDataRef.current = { offerDetailId: lastId, parentPath: lastPath.slice(0, -1), label: lastLabel, treeOrdering: lastTree, isRequested: lastRequested };
                        return;
                      }
                    }
                  }
                }
              }
            }
          }
        }
        hide();
        return;
      }
      const rowRect = agRow.getBoundingClientRect();
      const mouseYInRow = e.clientY - rowRect.top;
      const inBottomHalf = mouseYInRow > rowRect.height / 2;
      if (!inBottomHalf) {
        const rowIndexAttr = agRow.getAttribute('row-index');
        const rowIndex = rowIndexAttr != null ? Number.parseInt(rowIndexAttr, 10) : NaN;
        if (Number.isFinite(rowIndex) && rowIndex > 0) {
          const api = gridApiRef.current;
          if (api && !api.isDestroyed?.()) {
            const prevNode = api.getDisplayedRowAtIndex(rowIndex - 1);
            const prevData = prevNode?.data as Record<string, unknown> | null | undefined;
            if (prevData) {
              const prevId = normalizeOfferDetailId((prevData as { OfferDetailID?: unknown }).OfferDetailID ?? null);
              const prevTreeRaw = (prevData as { TreeOrdering?: unknown }).TreeOrdering ?? null;
              const prevPath = parseTreeOrderingPath(prevTreeRaw);
              if (prevId != null && prevPath.length > 0) {
                const wrapperRect = wrapper.getBoundingClientRect();
                const viewportEl = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
                if (viewportEl) {
                  const viewportRect = viewportEl.getBoundingClientRect();
                  if (rowRect.top >= viewportRect.top && rowRect.top <= viewportRect.bottom) {
                    line.style.display = 'flex';
                    line.style.top = `${rowRect.top - wrapperRect.top}px`;
                    line.style.width = getLineWidth();
                    const prevTree = typeof prevTreeRaw === 'string' ? prevTreeRaw.trim() : buildTreeOrderingKey(prevPath);
                    const prevLabel = resolveRowLabel(prevData, '');
                    const prevRequested = isRequestedRow(prevData);
                    insertLineDataRef.current = { offerDetailId: prevId, parentPath: prevPath.slice(0, -1), label: prevLabel, treeOrdering: prevTree, isRequested: prevRequested };
                    return;
                  }
                }
              }
            }
          }
        }
        hide();
        return;
      }
      const rowIndexAttr = agRow.getAttribute('row-index');
      if (rowIndexAttr == null) { hide(); return; }
      const rowIndex = Number.parseInt(rowIndexAttr, 10);
      if (!Number.isFinite(rowIndex)) { hide(); return; }
      const api = gridApiRef.current;
      if (!api || api.isDestroyed?.()) { hide(); return; }
      const rowNode = api.getDisplayedRowAtIndex(rowIndex);
      const rowData = rowNode?.data as Record<string, unknown> | null | undefined;
      if (!rowData) { hide(); return; }
      const offerDetailId = normalizeOfferDetailId((rowData as { OfferDetailID?: unknown }).OfferDetailID ?? null);
      if (offerDetailId == null) { hide(); return; }
      const treeOrderingRaw = (rowData as { TreeOrdering?: unknown }).TreeOrdering ?? null;
      const path = parseTreeOrderingPath(treeOrderingRaw);
      if (path.length === 0) { hide(); return; }
      const wrapperRect = wrapper.getBoundingClientRect();
      const viewportEl = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
      if (!viewportEl) { hide(); return; }
      const viewportRect = viewportEl.getBoundingClientRect();
      if (rowRect.bottom < viewportRect.top || rowRect.bottom > viewportRect.bottom) { hide(); return; }
      line.style.display = 'flex';
      line.style.top = `${rowRect.bottom - wrapperRect.top}px`;
      line.style.width = getLineWidth();
      const treeOrdering = typeof treeOrderingRaw === 'string' ? treeOrderingRaw.trim() : buildTreeOrderingKey(path);
      const label = resolveRowLabel(rowData, '');
      const requested = isRequestedRow(rowData);
      insertLineDataRef.current = { offerDetailId, parentPath: path.slice(0, -1), label, treeOrdering, isRequested: requested };
    };

    const handleScroll = () => {
      if (insertLinePinnedRef.current) {
        const pinLine = pinnedLineRef.current;
        if (!pinLine) return;
        const vp = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
        if (!vp) return;
        const scrollDelta = vp.scrollTop - insertLinePinScrollRef.current;
        const newTop = insertLinePinTopRef.current - scrollDelta;
        const vpRect = vp.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        const vpTopInWrapper = vpRect.top - wrapperRect.top;
        const vpBottomInWrapper = vpRect.bottom - wrapperRect.top;
        if (newTop < vpTopInWrapper || newTop > vpBottomInWrapper) {
          pinLine.style.display = 'none';
        } else {
          pinLine.style.display = 'flex';
          pinLine.style.top = `${newTop}px`;
          pinLine.style.width = getLineWidth();
        }
      } else if (insertLineAtEndPendingRef.current) {
        // User scrolled — wait for AG Grid to render, then check if last row is visible
        requestAnimationFrame(() => {
          if (insertLineAtEndPendingRef.current && !insertLinePinnedRef.current) {
            setInsertLineVisibleRef.current?.(true, true);
          }
        });
      } else {
        hide();
      }
    };

    wrapper.addEventListener('mousemove', handleMouseMove);
    wrapper.addEventListener('mouseleave', hide);
    // Use capture phase on wrapper — scroll events don't bubble, and
    // ag-body-viewport may not exist yet at mount time
    wrapper.addEventListener('scroll', handleScroll, true);
    return () => {
      wrapper.removeEventListener('mousemove', handleMouseMove);
      wrapper.removeEventListener('mouseleave', hide);
      wrapper.removeEventListener('scroll', handleScroll, true);
    };
  }, [getLineWidth]);

  const shiftIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const shiftInsertYRef = useRef<number | null>(null);

  const applyRowShift = useCallback(() => {
    const insertY = shiftInsertYRef.current;
    if (insertY == null) return;
    const wrapper = gridWrapperRef.current;
    if (!wrapper) return;
    const vp = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
    if (!vp) return;
    const gap = 32;
    const rows = vp.querySelectorAll('.ag-row');
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    for (const row of rows) {
      const el = row as HTMLElement;
      const idx = el.getAttribute('row-index');
      if (idx == null) continue;
      const node = api.getDisplayedRowAtIndex(Number.parseInt(idx, 10));
      const rowTop = node?.rowTop;
      if (rowTop == null) continue;
      // Only shift rows at/below the insertion point downward.
      // Don't shift rows above upward — that pushes the top row
      // out of the scrollable area.
      const shift = rowTop >= insertY ? gap : 0;
      el.style.transform = `translateY(${rowTop + shift}px)`;
    }
    // Sync the pinned line position to match the insertY in screen coordinates
    const pinLine = pinnedLineRef.current;
    if (pinLine) {
      const wrapper = gridWrapperRef.current;
      if (wrapper) {
        const vpRect = vp.getBoundingClientRect();
        const wrapperRect = wrapper.getBoundingClientRect();
        const vpOffset = vpRect.top - wrapperRect.top;
        // +16 so the 32px highlight bar sits in the gap below the anchor row
        // (rows below shift down by 32px, rows above stay put)
        const pinTop = insertY - vp.scrollTop + vpOffset + 16;
        if (pinTop < vpOffset || pinTop > vpOffset + vpRect.height) {
          pinLine.style.display = 'none';
        } else {
          pinLine.style.display = 'flex';
          pinLine.style.top = `${pinTop}px`;
          pinLine.style.width = getLineWidth();
        }
      }
    }
  }, [getLineWidth]);

  const startRowShift = useCallback(() => {
    // Use the anchor row's rowTop from the grid API as the insertion Y
    const data = insertLineDataRef.current;
    if (!data) return;
    const api = gridApiRef.current;
    if (!api || api.isDestroyed?.()) return;
    // Find the anchor row's rowTop
    let anchorRowTop: number | null = null;
    api.forEachNode((node) => {
      if (anchorRowTop != null) return;
      const rowId = normalizeOfferDetailId((node.data as { OfferDetailID?: unknown } | null)?.OfferDetailID ?? null);
      if (rowId === data.offerDetailId) {
        anchorRowTop = (node.rowTop ?? 0) + (node.rowHeight ?? 32);
      }
    });
    if (anchorRowTop == null) return;
    shiftInsertYRef.current = anchorRowTop;
    applyRowShift();
    if (shiftIntervalRef.current) clearInterval(shiftIntervalRef.current);
    shiftIntervalRef.current = setInterval(applyRowShift, 80);
  }, [applyRowShift]);

  const stopRowShift = useCallback(() => {
    if (shiftIntervalRef.current) {
      clearInterval(shiftIntervalRef.current);
      shiftIntervalRef.current = null;
    }
    shiftInsertYRef.current = null;
    // Restore original transforms using grid API
    const wrapper = gridWrapperRef.current;
    const vp = wrapper?.querySelector('.ag-body-viewport') as HTMLElement | null;
    const api = gridApiRef.current;
    if (vp && api && !api.isDestroyed?.()) {
      const rows = vp.querySelectorAll('.ag-row');
      for (const row of rows) {
        const el = row as HTMLElement;
        const idx = el.getAttribute('row-index');
        if (idx == null) continue;
        const node = api.getDisplayedRowAtIndex(Number.parseInt(idx, 10));
        if (node?.rowTop != null) {
          el.style.transform = `translateY(${node.rowTop}px)`;
        }
      }
    }
  }, []);

  const handleInsertLineClick = useCallback(() => {
    const data = insertLineDataRef.current;
    if (!data) return;
    // Clear row highlight and deselect rows in main grid
    clearSelectedRowHighlight();
    const api = gridApiRef.current;
    if (api && !api.isDestroyed?.()) {
      try { api.deselectAll(); } catch { /* noop */ }
    }
    insertLinePinnedRef.current = true;
    insertLinePinnedAtRef.current = Date.now();
    const hoverLine = insertLineRef.current;
    const pinLine = pinnedLineRef.current;
    if (hoverLine && pinLine) {
      const topVal = hoverLine.style.top;
      pinLine.style.top = topVal;
      pinLine.style.display = 'flex';
      pinLine.style.width = getLineWidth();
      insertLinePinTopRef.current = parseFloat(topVal) || 0;
      const wrapper = gridWrapperRef.current;
      const vp = wrapper?.querySelector('.ag-body-viewport') as HTMLElement | null;
      insertLinePinScrollRef.current = vp?.scrollTop ?? 0;
      startRowShift();
    }
    onRequestInsertProductRef.current?.(data);
  }, [clearSelectedRowHighlight, getLineWidth, startRowShift]);

  const setInsertLineVisible = useCallback((visible: boolean, atEnd?: boolean) => {
    const pinLine = pinnedLineRef.current;
    if (!pinLine) return;
    if (visible) {
      // When atEnd is explicitly requested, clear any prior pinned position
      // so we always re-compute from the last row.
      if (atEnd) insertLineDataRef.current = null;
      const anchor = atEnd ? null : getAddInsertionAnchor();
      let positioned = false;
      let positionedAtEnd = false;
      const api = gridApiRef.current;
      const wrapper = gridWrapperRef.current;
      if (anchor) {
        // Position the line below the selected row
        insertLineDataRef.current = anchor;
        if (api && wrapper && !api.isDestroyed?.()) {
          const viewport = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
          if (viewport) {
            insertLinePinScrollRef.current = viewport.scrollTop;
            const rows = viewport.querySelectorAll('.ag-row');
            for (const row of rows) {
              const idx = row.getAttribute('row-index');
              if (idx == null) continue;
              const node = api.getDisplayedRowAtIndex(Number.parseInt(idx, 10));
              const rowId = normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown } | null)?.OfferDetailID ?? null);
              if (rowId === anchor.offerDetailId) {
                const wrapperRect = wrapper.getBoundingClientRect();
                const rowRect = (row as HTMLElement).getBoundingClientRect();
                const topPos = rowRect.bottom - wrapperRect.top;
                pinLine.style.top = `${topPos}px`;
                insertLinePinTopRef.current = topPos;
                positioned = true;
                break;
              }
            }
          }
        }
      } else if (insertLineDataRef.current) {
        // Prior pinned position exists (e.g. from an insertion line click) — keep it
        positioned = true;
      } else if (api && wrapper && !api.isDestroyed?.()) {
        // No selection and no prior pin — show below the last row only if it's visible
        const viewport = wrapper.querySelector('.ag-body-viewport') as HTMLElement | null;
        if (viewport) {
          const totalRows = api.getDisplayedRowCount();
          if (totalRows > 0) {
            const lastIdx = totalRows - 1;
            // Check if the last row is rendered in the DOM and visible
            const vpRect = viewport.getBoundingClientRect();
            const rowEls = viewport.querySelectorAll('.ag-row');
            let lastRowEl: HTMLElement | null = null;
            for (const row of rowEls) {
              const idx = row.getAttribute('row-index');
              if (idx != null && Number.parseInt(idx, 10) === lastIdx) {
                lastRowEl = row as HTMLElement;
                break;
              }
            }
            if (lastRowEl) {
              const rowRect = lastRowEl.getBoundingClientRect();
              // Only show if the last row's bottom is within the viewport
              if (rowRect.bottom >= vpRect.top && rowRect.bottom <= vpRect.bottom + 32) {
                const node = api.getDisplayedRowAtIndex(lastIdx);
                const rowData = node?.data as Record<string, unknown> | null | undefined;
                if (rowData) {
                  const lastId = normalizeOfferDetailId((rowData as { OfferDetailID?: unknown }).OfferDetailID ?? null);
                  const treeOrderingRaw = (rowData as { TreeOrdering?: unknown }).TreeOrdering ?? null;
                  const path = parseTreeOrderingPath(treeOrderingRaw);
                  if (lastId != null && path.length > 0) {
                    const treeOrdering = typeof treeOrderingRaw === 'string' ? treeOrderingRaw.trim() : buildTreeOrderingKey(path);
                    insertLineDataRef.current = { offerDetailId: lastId, parentPath: path.slice(0, -1), label: resolveRowLabel(rowData, ''), treeOrdering, isRequested: isRequestedRow(rowData) };
                    const wrapperRect = wrapper.getBoundingClientRect();
                    const topPos = rowRect.bottom - wrapperRect.top + 16;
                    pinLine.style.top = `${topPos}px`;
                    insertLinePinScrollRef.current = viewport.scrollTop;
                    insertLinePinTopRef.current = topPos;
                    positioned = true;
                    positionedAtEnd = true;
                  }
                }
              }
            }
            // If last row isn't visible yet, mark pending so scroll handler shows it
            // when user scrolls there
            if (!positioned) {
              insertLineAtEndPendingRef.current = true;
            } else {
              insertLineAtEndPendingRef.current = false;
            }
          }
        }
      }
      // Only show the line if we actually have a valid position
      if (positioned) {
        insertLinePinnedRef.current = true;
        insertLinePinnedAtEndRef.current = positionedAtEnd;
        insertLinePinnedAtRef.current = Date.now();
        pinLine.className = `${styles.insertLine} ${styles.insertLinePinned}`;
        pinLine.style.display = 'flex';
        pinLine.style.width = getLineWidth();
        if (!positionedAtEnd) startRowShift();
      } else if (atEnd) {
        // Asked to pin at end but the grid has no rows to anchor against —
        // hide any prior pin so a stale line doesn't linger after the grid
        // empties out.
        insertLinePinnedRef.current = false;
        insertLinePinnedAtEndRef.current = false;
        pinLine.style.display = 'none';
        stopRowShift();
      }
    } else {
      insertLinePinnedRef.current = false;
      insertLinePinnedAtEndRef.current = false;
      insertLineAtEndPendingRef.current = false;
      pinLine.style.display = 'none';
      pinLine.className = `${styles.insertLine} ${styles.insertLinePinned}`;
      insertLineDataRef.current = null;
      stopRowShift();
    }
  }, [getAddInsertionAnchor, getLineWidth, startRowShift, stopRowShift]);
  setInsertLineVisibleRef.current = setInsertLineVisible;


  return (
    <>
      <div className={styles.panel}>
        <div
          className={`${styles.gridWrapper} offer-products-grid`}
          ref={gridWrapperRef}
          onContextMenu={handleEmptyGridWrapperContextMenu}
        >
          <AgGridAll
            endpoint={dataEndpoint}
            persistenceEndpoint={persistenceEndpoint}
            columnDefs={productColumnDefs}
            defaultColDef={defaultColDef}
            manualMode={manualMode}
            getRowClass={getRowClass}
            getContextMenuItems={productContextMenuItems}
            onCellValueChanged={handleCellEdit}
            refreshToken={refreshToken}
            onGridReady={handleGridReady}
            onSelectionChanged={handleMainGridSelectionChanged}
            onModelUpdated={handleGridModelUpdated}
            onRowDoubleClicked={handleRowDoubleClicked}
            enableColumnStatePersistence
            autoPersistColumnState={false}
            applyColumnStateOrder
            maintainColumnOrder
            columnStateNamespace={columnStateNamespace}
            onTotalsChange={handleTotalsChange}
            onResponse={handleGridResponse}
            onColumnStateRestored={handleColumnStateRestored}
            onServerRequest={handleServerRequest}
            requestPayload={standardPackageRequestPayload}
            getRowHeight={getRowHeight}
            floatingFilter
            rowGroupPanelShow="never"
            rowSelection="multiple"
            rowMultiSelectWithClick
            rowDeselection
            useAgGridRowDrag
            suppressColumnVirtualisation={false}
            cacheBlockSize={100}
            rowBuffer={5}
            maxBlocksInCache={5}
            filterServerRow={filterServerRow}
            allowMultiCellDeletion
          />
          <div
            ref={insertLineRef}
            className={styles.insertLine}
            style={{ display: 'none' }}
            onClick={handleInsertLineClick}
            onMouseDown={(e) => e.stopPropagation()}
            data-fastquote-keep-selection="true"
            role="button"
            tabIndex={-1}
            aria-label="Insert product here"
          >
            <div className={styles.insertLineBar} />
            <div className={styles.insertLineButton}>+</div>
            <div className={styles.insertLineBar} />
          </div>
          <div
            ref={pinnedLineRef}
            className={`${styles.insertLine} ${styles.insertLinePinned}`}
            style={{ display: 'none' }}
            data-fastquote-keep-selection="true"
          >
            <div className={styles.insertLineBar} />
          </div>
          {emptyGridPasteMenu ? (
            <div
              className={styles.emptyGridContextMenu}
              style={{ left: `${emptyGridPasteMenu.x}px`, top: `${emptyGridPasteMenu.y}px` }}
              role="menu"
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
            >
              <button
                type="button"
                className={styles.emptyGridContextMenuItem}
                role="menuitem"
                disabled={!isClipboardPopulated()}
                onClick={handleEmptyGridPasteRows}
              >
                <span
                  className="fastquote-menu-icon"
                  aria-hidden="true"
                  // biome-ignore lint: dangerouslySetInnerHTML needed for SVG icon
                  dangerouslySetInnerHTML={{
                    __html: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4h8" /><rect x="6" y="2" width="12" height="4" rx="1.5" /><path d="M6 8h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2z" /><path d="M12 12v6" /><path d="M9 15h6" /></svg>`,
                  }}
                />
                Paste Rows
              </button>
            </div>
          ) : null}
        </div>
        {hideTotals ? null : (
          <div className={styles.totalsBar}>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total List:</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalListPrice)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Net:</span>
              {totalNetEditing ? (
                <input
                  className={styles.totalNetInput}
                  autoFocus
                  inputMode="decimal"
                  value={totalNetInputValue}
                  disabled={totalNetApplying}
                  onChange={(e) => setTotalNetInputValue(e.target.value)}
                  onBlur={submitTotalNetEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitTotalNetEdit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEditTotalNet();
                    }
                  }}
                />
              ) : (
                <span
                  className={`${styles.totalValue} ${styles.totalNetEditable}`}
                  role="button"
                  tabIndex={0}
                  title="Click to rescale all Net Unit Prices to match a target total"
                  onClick={beginEditTotalNet}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      beginEditTotalNet();
                    }
                  }}
                >
                  {formatEuroTotal(totals?.totalNetPrice)}
                </span>
              )}
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Discount:</span>
              <span className={styles.totalValue}>{formatDiscountTotal(totals?.totalListPrice, totals?.totalNetPrice)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Cost:</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalCost)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Margin:</span>
              {totalMarginEditing ? (
                <input
                  className={styles.totalNetInput}
                  autoFocus
                  inputMode="decimal"
                  value={totalMarginInputValue}
                  disabled={totalNetApplying}
                  onChange={(e) => setTotalMarginInputValue(e.target.value)}
                  onBlur={submitTotalMarginEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      submitTotalMarginEdit();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEditTotalMargin();
                    }
                  }}
                />
              ) : (
                <span
                  className={`${styles.totalValue} ${styles.totalNetEditable}`}
                  role="button"
                  tabIndex={0}
                  title="Click to rescale all Net Unit Prices to match a target total margin"
                  onClick={beginEditTotalMargin}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      beginEditTotalMargin();
                    }
                  }}
                >
                  {formatPercentTotal(totals?.totalMargin)}
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      {currentRequestedMatch ? (
      <MatchRequestedProductsModal
        offerId={offerId}
        entry={currentRequestedMatch}
        position={manualMatchPosition}
        total={manualMatchTotal}
        onAssign={handleManualAssign}
        onSkip={handleManualSkip}
        onSkipAll={handleManualSkipAll}
        onRequestAddProduct={openMatchAddProduct}
        newProductId={matchAddedProductId}
          onClearNewProductId={clearMatchAddedProductId}
          onRequestPayloadConsumed={clearMatchAddedProductId}
          prefetchedSuggestions={currentPrefetchedSuggestions}
          prefetchedExpansion={currentPrefetchedExpansion}
          prefetchedFirstPage={currentPrefetchedFirstPage}
          onCurrentEntryReady={handleCurrentEntryReady}
        />
      ) : null}
      <AddProductModal
        open={matchAddProductOpen}
        onAdded={handleMatchProductAdded}
        onClose={closeMatchAddProduct}
        initialValues={matchAddProductInitialValues}
      />
      <AddProductModal
        open={rowAddProductOpen}
        onAdded={handleRowAddProductAdded}
        onClose={closeRowAddProduct}
        initialValues={rowAddProductInitialValues}
      />
      <LookupModal
        open={brandBulkEditOpen}
        title={
          brandBulkEditScope === 'offer'
            ? (brandBulkEditField === 'CurrencyCostModifier' ? 'Bulk edit cost modifier for offer'
              : brandBulkEditField === 'CustomerDiscount' ? 'Bulk edit customer discount for offer'
              : brandBulkEditField === 'TelmacoDiscount' ? 'Bulk edit telmaco discount for offer'
              : 'Bulk edit margin for offer')
            : (brandBulkEditField === 'CurrencyCostModifier' ? 'Bulk edit cost modifier by brand'
              : brandBulkEditField === 'CustomerDiscount' ? 'Bulk edit customer discount by brand'
              : brandBulkEditField === 'TelmacoDiscount' ? 'Bulk edit telmaco discount by brand'
              : 'Bulk edit margin by brand')
        }
        onClose={closeBrandBulkEdit}
        onConfirm={confirmBrandBulkEdit}
        confirmLabel="Apply"
        saving={brandBulkEditSaving}
        error={brandBulkEditError}
      >
        {brandBulkEditScope === 'brand' && (
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="bulk-edit-brand-name">
            Brand
          </label>
          <input
            id="bulk-edit-brand-name"
            className={lookupStyles.fieldControl}
            value={brandBulkEditBrandName}
            readOnly
          />
        </div>
        )}
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="bulk-edit-brand-value">
            {brandBulkEditField === 'CurrencyCostModifier' ? 'Cost modifier'
              : brandBulkEditField === 'CustomerDiscount' ? 'Customer discount (%)'
              : brandBulkEditField === 'TelmacoDiscount' ? 'Telmaco discount (%)'
              : 'Margin (%)'}
          </label>
          <input
            id="bulk-edit-brand-value"
            className={lookupStyles.fieldControl}
            value={brandBulkEditValue}
            inputMode="decimal"
            onChange={(e) => setBrandBulkEditValue(e.target.value)}
          />
        </div>
      </LookupModal>
      <LookupModal
        open={demotePromptOpen}
        title="Set as Requested product"
        onClose={closeDemoteToRequestedPrompt}
        onConfirm={confirmDemoteToRequested}
        confirmLabel="Set as Requested"
        saving={demotePromptSaving}
        error={demotePromptError}
      >
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="demote-requested-quantity">
            Requested quantity <span className={lookupStyles.requiredMark}>*</span>
          </label>
          <input
            id="demote-requested-quantity"
            className={lookupStyles.fieldControl}
            value={demotePromptQuantity}
            inputMode="decimal"
            autoFocus
            onChange={(e) => setDemotePromptQuantity(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void confirmDemoteToRequested();
              }
            }}
          />
        </div>
      </LookupModal>
    </>
  );
});

OfferProductsPanel.displayName = 'OfferProductsPanel';

export default React.memo(OfferProductsPanel);
