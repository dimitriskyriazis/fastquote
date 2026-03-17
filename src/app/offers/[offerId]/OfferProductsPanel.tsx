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
  ValueGetterParams,
  ValueSetterParams,
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
import { showConfirmDialog, showMultiChoiceDialog } from '../../../lib/confirm';
import { GridRowDeletion, getContextMenuSelectionSnapshot, setGridRowDeletionContextMenuSelectionSnapshot } from '../../../lib/gridRowDeletion';
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

import MultilineTextCellEditor from './MultilineTextCellEditor';
import {
  productHistoryMenuIcon,
  enhanceDescriptionMenuIcon,
  addWebLinkMenuIcon,
  categoryMenuIcon,
  commentMenuIcon,
  brandBulkEditMenuIcon,
  copyRowsMenuIcon,
  pasteRowsMenuIcon,
  addStandardPackageMenuIcon,
} from './offerProductsIcons';
import {
  decimalFormatter,
  DEFAULT_ROW_HEIGHT,
  MAX_CATEGORY_DEPTH,
  ADD_WEBLINK_MAX_PRODUCTS,
  ENHANCE_DESC_MAX_PRODUCTS,
  readCollapsedCategoryPathsFromCookie,
  writeCollapsedCategoryPathsToCookie,
  coerceNumber,
  percentageFormatter,
  euroFormatter,
  zeroBlankNumberFormatter,
  normalizeProductId,
  compareTreeOrderingValues,
  parseTreeOrderingPath,
  buildTreeOrderingKey,
  normalizeOfferDetailId,
  resolveRowLabel,
  resolveOfferProductTypeLabel,
  isRequestedRow,
  isRequestedDescriptionField,
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
  categoryTotalPriceGetter,
  categoryTotalNetGetter,
  categoryTotalCostGetter,
  productAccentCellClassRules,
  productPriceListClassRules,
  totalPriceCellClassRules,
  PRICING_FIELD_LABELS,
  PRICING_EDITABLE_FIELDS,
  COST_ANALYSIS_COLUMNS,
  STANDARD_PACKAGE_PRODUCTS_FIELDS,
  isOfferProductCommentOrProduct,
  findDeleteMenuItemIndex,
  buildEndpointForOffer,
  type RequestedDisplayFieldKey,
  REQUESTED_DISPLAY_FIELD_KEYS,
  REQUESTED_FIELD_LABELS,
  isRequestedFieldKey,
  type ProductSummary,
  type FarnellLookupResponse,
} from './offerProductsUtils';

type GridRowNode = RowNode<Record<string, unknown>> | IRowNode<Record<string, unknown>>;

type Props = {
  offerId: string;
  endpoint?: string;
  manualMode?: boolean;
  standardPackageMode?: boolean;
  refreshToken?: number;
  showRequestedColumns?: boolean;
  tableLayout?: 'cust' | 'wCost' | 'wReq';
  hideTotals?: boolean;
  initialSelectedOfferDetailIds?: number[];
  initialViewportScrollTop?: number | null;
  onRequestPaste?: (anchorOfferDetailId: number | null, anchorTreeOrdering: string | null) => void;
  onRequestAddStandardPackage?: (anchorOfferDetailId: number, anchorTreeOrdering: string) => void;
  onUndoStateChange?: (state: { canUndo: boolean; lastLabel: string | undefined }) => void;
  offerCreatedByUserId?: string | null;
};

export type OfferProductsPanelHandle = {
  populateOffer: () => Promise<void>;
  getTemplateExportRows: () => Promise<OfferProductsTemplateExportRow[]>;
  getAddInsertionAnchor: () => { offerDetailId: number; parentPath: number[] } | null;
  getSelectedOfferDetailIdsForPriceUpdate: () => Promise<number[]>;
  getSelectedOfferDetailIds: () => Promise<number[]>;
  getSelectedRequestedOfferDetailId: () => number | null;
  forceReapplyRequestedColumnsVisibility: () => void;
  getViewportScrollTop: () => number;
  getSelectedRowData: () => Array<Record<string, unknown>>;
  getAllVisibleRowData: () => Array<Record<string, unknown>>;
  canUndo: boolean;
  performUndo: () => Promise<void>;
  lastUndoLabel: string | undefined;
};

export type OfferProductsTemplateExportRow = {
  no: string | number;
  productReference: string;
  manufacturer: string;
  descriptionType: string;
  qty: number | '';
  unitPrice: number | '';
  delayForDelivery: string;
  comments: string;
  skipRow?: boolean;
};

type OfferExportRow = {
  TreeOrdering: string | null;
  PartNumber: string | null;
  BrandName: string | null;
  AVC4BrandName: string | null;
  ModelNumber: string | null;
  Description: string | null;
  Quantity: number | null;
  NetUnitPrice: number | null;
  Delivery: string | null;
  Comment: string | null;
  IsPrintable?: boolean | null;
  IsComment?: boolean | null;
  IsCategory?: boolean | null;
};

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
    async (requestedRowId: number, productId: number, categoryId: number | null, comment?: string) => {
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
  const [requestedMatchQueue, setRequestedMatchQueue] = useState<RequestedProductMatchEntry[]>([]);
  const [processedRequestedMatches, setProcessedRequestedMatches] = useState(0);

  // --- AI suggestion prefetch cache (batch) ---
  const suggestionCacheRef = useRef<Map<number, Record<string, unknown>[]>>(new Map());
  const batchPrefetchedRef = useRef(false);
  const [suggestionCacheVersion, setSuggestionCacheVersion] = useState(0);

  const prefetchAllSuggestions = useCallback((entries: RequestedProductMatchEntry[]) => {
    if (batchPrefetchedRef.current) return;
    const uncached = entries.filter((e) => !suggestionCacheRef.current.has(e.offerDetailId));
    if (uncached.length === 0) return;
    batchPrefetchedRef.current = true;
    fetch(`/api/offers/${encodeURIComponent(offerId)}/products/suggest-batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: uncached.map((e) => ({
          offerDetailId: e.offerDetailId,
          requestedBrand: e.requestedBrand,
          requestedModelNumber: e.requestedModelNumber,
          requestedPartNumber: e.requestedPartNumber,
          requestedDescription: e.requestedDescription,
          requestedDescription2: e.requestedDescription2,
          requestedDescription3: e.requestedDescription3,
        })),
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        const results = (data as { results?: Record<string, Record<string, unknown>[]> } | null)?.results;
        if (results) {
          for (const [idStr, products] of Object.entries(results)) {
            suggestionCacheRef.current.set(Number(idStr), products);
          }
          setSuggestionCacheVersion((v) => v + 1);
        }
      })
      .catch(() => { /* noop */ });
  }, [offerId]);

  // Prefetch suggestions for ALL entries in one batch request
  useEffect(() => {
    if (requestedMatchQueue.length === 0) return;
    prefetchAllSuggestions(requestedMatchQueue);
  }, [requestedMatchQueue, prefetchAllSuggestions]);
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
  const serverRowsRef = useRef<Array<Record<string, unknown>>>([]);
  const appliedRequestedColumnVisibilityRef = useRef<Record<RequestedDisplayFieldKey, boolean> | null>(null);
  const appliedRequestedItemNoVisibleRef = useRef<boolean | null>(null);
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
  const [brandBulkEditOpen, setBrandBulkEditOpen] = useState(false);
  const [brandBulkEditField, setBrandBulkEditField] = useState<'CurrencyCostModifier' | 'Margin'>('CurrencyCostModifier');
  const [brandBulkEditBrandName, setBrandBulkEditBrandName] = useState('');
  const [brandBulkEditValue, setBrandBulkEditValue] = useState('');
  const [brandBulkEditSaving, setBrandBulkEditSaving] = useState(false);
  const [brandBulkEditError, setBrandBulkEditError] = useState<string | null>(null);
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

  const handleGridResponse = useCallback((response: GridResponse | null) => {
    if (!response) return;
    lastRowCountRef.current = response?.rowCount ?? null;
    const hasRows = Boolean(response?.rowCount && response.rowCount > 0);
    serverRowsRef.current = response && Array.isArray(response.rows) ? response.rows : [];
    const shouldResetRoots = response?.request?.startRow === 0;
    rebuildTreeOrderingRootMap(response?.rows as Array<Record<string, unknown>> | undefined, shouldResetRoots);
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
        const previousVisibility = appliedRequestedColumnVisibilityRef.current ?? requestedColumnVisibility;
        const mergedVisibility = REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
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
        const mergedItemNoVisible = (appliedRequestedItemNoVisibleRef.current ?? requestedItemNoVisible) || responseRequestedItemNo;
        setRequestedItemNoVisible(mergedItemNoVisible);
        applyRequestedVisibilityToGrid(mergedVisibility, mergedItemNoVisible, { force: true, defer: true });
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
        const previousVisibility = appliedRequestedColumnVisibilityRef.current ?? requestedColumnVisibility;
        const mergedVisibility = REQUESTED_DISPLAY_FIELD_KEYS.reduce<Record<RequestedDisplayFieldKey, boolean>>(
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
        const mergedItemNoVisible = (appliedRequestedItemNoVisibleRef.current ?? requestedItemNoVisible) || responseRequestedItemNo;
        setRequestedItemNoVisible(mergedItemNoVisible);
        applyRequestedVisibilityToGrid(mergedVisibility, mergedItemNoVisible, { force: true, defer: true });
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
    rebuildTreeOrderingRootMap,
    requestedColumnVisibility,
    requestedItemNoVisible,
    scheduleCategoryAncestorsUpdate,
    showRequestedColumns,
    tableLayout,
  ]);

  const handleServerRequest = useCallback((request: ServerRequestWithQuickFilter) => {
    lastRequestStartRef.current = performance.now();
    lastServerRequestRef.current = request;
  }, []);

  const [gridReadyApi, setGridReadyApi] = useState<GridApi<Record<string, unknown>> | null>(null);
  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    gridApiRef.current = api;
    setGridReadyApi(api);

    // Real-time updates are handled by useRealtimeGridUpdates hook below
    setRequestedColumnsReadyFlag(true);
  }, [setRequestedColumnsReadyFlag]);

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

  const determineRowHeight = useCallback((params: { data?: Record<string, unknown> }) => {
    const row = params.data;
    if (!row) return DEFAULT_ROW_HEIGHT;

    // Check if Description or Comment fields contain line breaks
    const description = (row.ProductDescription ?? row.Description ?? '') as string;
    const comment = (row.Comment ?? '') as string;

    // If either field contains newlines, return undefined to let AG Grid auto-calculate height
    if (description.includes('\n') || comment.includes('\n')) {
      return undefined;
    }

    return DEFAULT_ROW_HEIGHT;
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
    const value = formatDisplayTreeOrdering(rawValue);
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

    const display = value;
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

    const stop = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <a
        href={normalizedLink}
        target="_blank"
        rel="noreferrer noopener"
        className={styles.partNumberLink}
        onClick={stop}
        onMouseDown={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
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

    const stop = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <a
        href={normalizedLink}
        target="_blank"
        rel="noreferrer noopener"
        className={styles.partNumberLink}
        onClick={stop}
        onMouseDown={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
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

const requestedColumnDefsMap = useMemo<Record<RequestedDisplayFieldKey, ColDef>>(() => {
  const buildTextRequestedColumn = (
    field: RequestedDisplayFieldKey,
    headerName: string
  ) => {
    const isDescription = isRequestedDescriptionField(field);
    const supportsWebLink = field === 'RequestedPartNo' || field === 'RequestedModelNo';
    const column: ColDef = {
      field,
      headerName,
      hide: true,
      filter: 'agTextColumnFilter',
      headerClass: styles.requestedHeader,
      cellClassRules: requestedCellClassRules,
      cellClass: isDescription ? ACTUAL_COLUMN_GLOBAL_CLASS : TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
      cellStyle: isDescription
        ? (params) => {
            const row = params.data as Record<string, unknown> | null | undefined;
            const description = (row?.[field] ?? '') as string;
            const hasLineBreaks = description.includes('\n');

            return {
              whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
              lineHeight: '1.5',
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
              textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
            };
          }
        : truncateCellStyle,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField(field, params.data ?? null),
      cellEditor: isDescription ? MultilineTextCellEditor : 'agTextCellEditor',
      valueGetter: (params: ValueGetterParams<Record<string, unknown>, unknown>) => {
        const row = params.data ?? null;
        const rawValue = row ? row[field] : null;
        if (isDescription) {
          return normalizeDescriptionValue(rawValue) ?? '';
        }
        if (typeof rawValue === 'string') return rawValue.trim();
        return rawValue;
      },
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        const normalized = isDescription
          ? normalizeDescriptionValue(newValue)
          : normalizeRequestedLookupValue(newValue);
        (data as Record<string, unknown>)[field] = normalized;
        return true;
      },
      cellRenderer: supportsWebLink
        ? (params: ICellRendererParams<Record<string, unknown>>) => {
            const rawValue = params.value;
            if (rawValue == null) return '';
            const displayValue = String(rawValue).trim();
            if (!displayValue) return '';

            if (field === 'RequestedModelNo') {
              const partNoRaw = (params.data as { RequestedPartNo?: unknown } | undefined)?.RequestedPartNo ?? null;
              const partNo = normalizeRequestedLookupValue(partNoRaw);
              if (partNo) return displayValue;
            }

            const rawLink = (params.data as { RequestedWebLink?: unknown } | undefined)?.RequestedWebLink ?? null;
            const normalizedLink = normalizeRequestedLookupValue(rawLink);
            if (!normalizedLink) return displayValue;

            const stop = (event: React.SyntheticEvent) => {
              event.stopPropagation();
            };

            return (
              <a
                href={normalizedLink}
                target="_blank"
                rel="noreferrer noopener"
                className={styles.partNumberLink}
                onClick={stop}
                onMouseDown={stop}
                onDoubleClick={stop}
                onContextMenu={stop}
                title="Open requested product link"
              >
                {displayValue}
              </a>
            );
          }
        : undefined,
      autoHeight: isDescription ? true : undefined,
    };
    return column;
  };

  return {
    RequestedBrand: buildTextRequestedColumn('RequestedBrand', 'Req. Brand'),
    RequestedPartNo: buildTextRequestedColumn('RequestedPartNo', 'Req. Part Number'),
    RequestedModelNo: buildTextRequestedColumn('RequestedModelNo', 'Req. Model Number'),
    RequestedWebLink: buildTextRequestedColumn('RequestedWebLink', 'Req. Web Link'),
    RequestedDescription: buildTextRequestedColumn('RequestedDescription', 'Req. Description'),
    RequestedDescription2: buildTextRequestedColumn('RequestedDescription2', 'Req. Description 2'),
    RequestedDescription3: buildTextRequestedColumn('RequestedDescription3', 'Req. Description 3'),
    RequestedQuantity: {
      field: 'RequestedQuantity',
      headerName: 'Req. Qty',
      hide: true,
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: zeroBlankNumberFormatter,
      headerClass: [styles.requestedHeader, 'ag-right-aligned-header'],
      cellClassRules: requestedCellClassRules,
      cellClass: 'ag-right-aligned',
      cellStyle: actualNumericCellStyle,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField('RequestedQuantity', params.data ?? null),
      cellEditor: 'agTextCellEditor',
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        (data as Record<string, unknown>).RequestedQuantity = normalizeRequestedQuantityValue(newValue);
        return true;
      },
    },
  };
}, [actualNumericCellStyle, requestedCellClassRules, truncateCellStyle]);

  const productColumnDefs: ColDef[] = useMemo(() => {
    if (standardPackageMode) {
      return [
        {
          headerName: '',
          colId: '__row_drag__',
          pinned: 'left',
          lockPosition: true,
          suppressMovable: true,
          suppressSizeToFit: true,
          suppressColumnsToolPanel: true,
          resizable: false,
          sortable: false,
          filter: false,
          width: 44,
          rowDrag: true,
          cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
        },
        {
          field: 'ProductID',
          hide: true,
          lockVisible: true,
          suppressColumnsToolPanel: true,
        },
        {
          field: 'TreeOrdering',
          headerName: 'Item No',
          filter: 'agTextColumnFilter',
          type: 'numericColumn',
          comparator: compareTreeOrderingValues,
          editable: manualMode,
          cellRenderer: TreeOrderingCell,
          headerClass: 'ag-right-aligned-header',
          cellClass: [
            'offer-products-tree-ordering-cell',
            ACTUAL_COLUMN_GLOBAL_CLASS,
            TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
            'ag-right-aligned',
          ],
          cellStyle: truncateCellStyle,
          valueGetter: ({ data }) => {
            const row = data as { TreeOrdering?: unknown } | null | undefined;
            const value = row?.TreeOrdering;
            if (value == null) return '';
            return typeof value === 'string' ? value.trim() : String(value);
          },
        },
        {
          field: 'BrandName',
          headerName: 'Brand',
          filter: 'agTextColumnFilter',
          cellClassRules: productAccentCellClassRules,
          cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
          cellStyle: truncateCellStyle,
        },
        {
          field: 'PartNumber',
          headerName: 'Part Number',
          filter: 'agTextColumnFilter',
          cellRenderer: PartNumberCell,
          cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
          cellStyle: truncateCellStyle,
        },
        {
          field: 'ModelNumber',
          headerName: 'Model Number',
          filter: 'agTextColumnFilter',
          cellRenderer: ModelNumberCell,
          cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
          cellStyle: truncateCellStyle,
        },
        {
          field: 'Description',
          headerName: 'Description',
          filter: 'agTextColumnFilter',
          valueGetter: ({ data }) => {
            const row = data as Record<string, unknown> | null | undefined;
            const rawProductId = (row as { ProductID?: unknown } | null | undefined)?.ProductID ?? null;
            const hasProductId =
              typeof rawProductId === 'number'
                ? Number.isFinite(rawProductId)
                : typeof rawProductId === 'string'
                  ? rawProductId.trim().length > 0
                  : false;
            const isAssignedProduct = isOfferProductProduct(row) || hasProductId;
            if (isRequestedRow(row) && !isAssignedProduct) return '';
            const manual = normalizeDescriptionValue(row?.ProductDescription ?? null);
            if (manual != null) return manual;
            if (!isOfferProductCategory(row) && !isOfferProductProduct(row) && !isOfferProductComment(row)) {
              return '';
            }
            return normalizeDescriptionValue(row?.Description ?? null) ?? '';
          },
          valueSetter: ({ data, newValue }) => {
            if (!data) return false;
            const normalized = normalizeDescriptionValue(newValue);
            (data as Record<string, unknown>).ProductDescription = normalized;
            (data as Record<string, unknown>).Description = normalized;
            return true;
          },
          editable: (params) => {
            const row = params?.data ?? null;
            return (
              isOfferProductCategory(row)
              || isOfferProductComment(row)
              || isOfferProductProduct(row)
            );
          },
          cellEditor: MultilineTextCellEditor,
          cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
          cellStyle: (params) => {
            const row = params.data as Record<string, unknown> | null | undefined;
            const description = (row?.ProductDescription ?? row?.Description ?? '') as string;
            const hasLineBreaks = description.includes('\n');
            return {
              whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
              lineHeight: '1.5',
              display: 'flex',
              alignItems: 'center',
              overflow: 'hidden',
              textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
            };
          },
          autoHeight: true,
        },
        {
          field: 'Quantity',
          headerName: 'Qty',
          filter: 'agNumberColumnFilter',
          type: 'numericColumn',
          headerClass: 'ag-right-aligned-header',
          editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
          valueFormatter: zeroBlankNumberFormatter,
          cellClass: actualNumericCellClass,
          cellStyle: actualNumericCellStyle,
        },
      ];
    }

    const requestedColumns: ColDef[] = [];
    REQUESTED_DISPLAY_FIELD_KEYS.forEach((key) => {
      const baseColDef = requestedColumnDefsMap[key];
      if (!baseColDef) return;
      requestedColumns.push({ ...baseColDef });
    });

    const treeColumn: ColDef = {
      field: 'TreeOrdering',
      headerName: 'Item No',
      filter: 'agTextColumnFilter',
      type: 'numericColumn',
      comparator: compareTreeOrderingValues,
      editable: manualMode,
      cellRenderer: TreeOrderingCell,
      headerClass: 'ag-right-aligned-header',
      cellClass: [
        'offer-products-tree-ordering-cell',
        ACTUAL_COLUMN_GLOBAL_CLASS,
        TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS,
        'ag-right-aligned',
      ],
      cellStyle: truncateCellStyle,
    valueGetter: ({ data }) => {
      const row = data as {
        __isRequestedRow?: number | null;
        TreeOrdering?: unknown;
      } | null | undefined;
      const treeValue = row?.TreeOrdering;
      if (treeValue != null) {
        return typeof treeValue === 'string' ? treeValue.trim() : String(treeValue);
      }
      return '';
    },
  };

    const requestedItemNoColumn: ColDef = {
      field: 'RequestedItemNo',
      headerName: 'Req. Item No',
      hide: true,
      filter: 'agTextColumnFilter',
      headerClass: [styles.requestedHeader, 'ag-right-aligned-header'],
      cellClassRules: requestedCellClassRules,
      cellClass: [TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS, 'ag-right-aligned'],
      cellStyle: truncateCellStyle,
      editable: (params: { data?: Record<string, unknown> | null }) =>
        canEditRequestedField('RequestedItemNo', params.data ?? null),
      cellEditor: 'agTextCellEditor',
      valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
        if (!data) return false;
        const normalized = normalizeRequestedItemNoValue(newValue);
        (data as Record<string, unknown>).RequestedItemNo = normalized;
        return true;
      },
      valueGetter: ({ data }) => {
        if (!data) return '';
        const requestedItemNo = normalizeRequestedItemNoValue(
          (data as Record<string, unknown>).RequestedItemNo ?? null,
        );
        return requestedItemNo ?? '';
      },
      cellRenderer: RequestedItemNoCell,
    };

    const baseColumns: ColDef[] = [
      {
        headerName: '',
        colId: '__row_drag__',
        pinned: 'left',
        lockPosition: true,
        suppressMovable: true,
        suppressSizeToFit: true,
        suppressColumnsToolPanel: true,
        resizable: false,
        sortable: false,
        filter: false,
        width: 44,
        rowDrag: true,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
      },
      {
        field: 'ProductID',
        hide: true,
        lockVisible: true,
        suppressColumnsToolPanel: true,
      },
      requestedItemNoColumn,
      ...requestedColumns,
      treeColumn,
      {
        field: 'BrandName',
        headerName: 'Brand',
        filter: 'agTextColumnFilter',
        cellClassRules: productAccentCellClassRules,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'PartNumber',
        headerName: 'Part Number',
        filter: 'agTextColumnFilter',
        cellRenderer: PartNumberCell,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'ModelNumber',
        headerName: 'Model Number',
        filter: 'agTextColumnFilter',
        cellRenderer: ModelNumberCell,
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
      {
        field: 'Description',
        headerName: 'Description',
        filter: 'agTextColumnFilter',
        valueGetter: ({ data }) => {
          const row = data as Record<string, unknown> | null | undefined;
          const rawProductId = (row as { ProductID?: unknown } | null | undefined)?.ProductID ?? null;
          const hasProductId =
            typeof rawProductId === 'number'
              ? Number.isFinite(rawProductId)
              : typeof rawProductId === 'string'
                ? rawProductId.trim().length > 0
                : false;
          const isAssignedProduct = isOfferProductProduct(row) || hasProductId;
          if (isRequestedRow(row) && !isAssignedProduct) return '';
          const manual = normalizeDescriptionValue(row?.ProductDescription ?? null);
          if (manual != null) return manual;
          if (!isOfferProductCategory(row) && !isOfferProductProduct(row) && !isOfferProductComment(row)) {
            return '';
          }
          return normalizeDescriptionValue(row?.Description ?? null) ?? '';
        },
        valueSetter: ({ data, newValue }) => {
          if (!data) return false;
          const normalized = normalizeDescriptionValue(newValue);
          (data as Record<string, unknown>).ProductDescription = normalized;
          (data as Record<string, unknown>).Description = normalized;
          return true;
        },
        editable: (params) => {
          const row = params?.data ?? null;
          return (
            isOfferProductCategory(row)
            || isOfferProductComment(row)
            || isOfferProductProduct(row)
          );
        },
        cellEditor: MultilineTextCellEditor,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
        cellStyle: (params) => {
          const row = params.data as Record<string, unknown> | null | undefined;
          const description = (row?.ProductDescription ?? row?.Description ?? '') as string;
          const hasLineBreaks = description.includes('\n');

          return {
            whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
          };
        },
        autoHeight: true,
      },
    {
      field: 'ListPrice',
      headerName: 'List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: productPriceListClassRules,
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Customer Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: percentageFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'NetUnitPrice',
      headerName: 'Net Unit Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: euroFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'TotalPrice',
      headerName: 'Total List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueGetter: categoryTotalPriceGetter,
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null) && !isOfferProductCategory(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: totalPriceCellClassRules,
      editable: false,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'TotalNet',
      headerName: 'Total Net',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueGetter: categoryTotalNetGetter,
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
    {
      field: 'Warranty',
      headerName: 'Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: actualNumericCellClass,
      cellStyle: actualNumericCellStyle,
    },
      {
        field: 'Comment',
        headerName: 'Comment',
        filter: 'agTextColumnFilter',
        editable: (params) => {
          const row = params?.data ?? null;
          return (
            isOfferProductCategory(row)
            || isOfferProductComment(row)
            || isOfferProductProduct(row)
          );
        },
        cellEditor: MultilineTextCellEditor,
        cellClass: ACTUAL_COLUMN_GLOBAL_CLASS,
        cellStyle: (params) => {
          const row = params.data as Record<string, unknown> | null | undefined;
          const comment = (row?.Comment ?? '') as string;
          const hasLineBreaks = comment.includes('\n');

          return {
            whiteSpace: hasLineBreaks ? 'pre' : 'nowrap',
            lineHeight: '1.5',
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            textOverflow: hasLineBreaks ? 'clip' : 'ellipsis',
          };
        },
        autoHeight: true,
      },
      {
        field: 'Delivery',
        headerName: 'Delivery',
        filter: 'agTextColumnFilter',
        editable: (params) => {
          const row = params?.data ?? null;
          return (
            isOfferProductCategory(row)
            || isOfferProductComment(row)
            || isOfferProductProduct(row)
          );
        },
        valueGetter: ({ data }) => {
          const raw = (data as { Delivery?: unknown } | null | undefined)?.Delivery;
          return raw == null ? '' : String(raw).trim();
        },
        valueSetter: ({ data, newValue }: ValueSetterParams<Record<string, unknown>, unknown>) => {
          if (!data) return false;
          (data as Record<string, unknown>).Delivery = normalizeRequestedLookupValue(newValue ?? null);
          return true;
        },
        cellClass: [ACTUAL_COLUMN_GLOBAL_CLASS, TEXT_TRUNCATE_COLUMN_GLOBAL_CLASS],
        cellStyle: truncateCellStyle,
      },
    {
      field: 'TelmacoDiscount',
      headerName: 'Telmaco Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: percentageFormatter,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'NetCost',
      headerName: 'Net Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: euroFormatter,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      valueFormatter: percentageFormatter,
      cellClassRules: {
        'offer-products-grid__cell--negative-margin': (params) => {
          const value = coerceNumber(
            params.value
            ?? (params.data as { Margin?: unknown } | null | undefined)?.Margin
            ?? null,
          );
          return value != null && value < 0;
        },
      },
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    {
      field: 'GrossProfit',
      headerName: 'Gross Profit',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
      editable: false,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
      {
        field: 'TotalCost',
        headerName: 'Total Cost',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        headerClass: 'ag-right-aligned-header',
        valueFormatter: euroFormatter,
        valueGetter: categoryTotalCostGetter,
        cellClassRules: productAccentCellClassRules,
        editable: false,
        cellClass: [...actualNumericCellClass, styles.redDataCell],
        cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
      },
    {
      field: 'TelmacoWarranty',
      headerName: 'Telmaco Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      headerClass: 'ag-right-aligned-header',
      valueFormatter: zeroBlankNumberFormatter,
      cellClass: [...actualNumericCellClass, styles.redDataCell],
      cellStyle: { ...actualNumericCellStyle, color: '#dc2626' },
    },
    ];
    const columnMap = new Map<string, ColDef>();
    baseColumns.forEach((column) => {
      const id = typeof column.colId === 'string'
        ? column.colId
        : typeof column.field === 'string'
          ? column.field
          : '';
      if (!id) return;
      columnMap.set(id, column);
    });
    const ordered: ColDef[] = [];

    // Keep Requested columns first (and in-order) across all layouts, even if hidden.
    const fixedStartIds = [
      '__row_drag__',
      'ProductID',
      'RequestedItemNo',
      ...REQUESTED_DISPLAY_FIELD_KEYS,
      'TreeOrdering',
    ];
    const fixedStartSet = new Set(fixedStartIds);
    fixedStartIds.forEach((id) => {
      const column = columnMap.get(id);
      if (!column) return;
      ordered.push(column);
      columnMap.delete(id);
    });

    savedColumnOrder
      .filter((id) => !fixedStartSet.has(id))
      .forEach((id) => {
        const column = columnMap.get(id);
        if (!column) return;
        ordered.push(column);
        columnMap.delete(id);
      });
    columnMap.forEach((column) => ordered.push(column));
    // Sync requested column hide state with the current requestedColumnVisibility so
    // that the column *definitions* always reflect the desired visibility.  If AG Grid
    // ever re-applies column defs (e.g. after setDataValue triggers an internal column
    // model refresh), columns whose definitions have hide=false will stay visible instead
    // of snapping back to hide=true from the original requestedColumnDefsMap.
    const requestedColumnIds = new Set<string>(['RequestedItemNo', ...REQUESTED_DISPLAY_FIELD_KEYS]);
    const hasSavedHidden = Object.keys(savedHiddenMap).length > 0;
    return ordered.map((column) => {
      const id = typeof column.colId === 'string'
        ? column.colId
        : typeof column.field === 'string'
          ? column.field
          : '';
      if (!id) return column;
      // For requested columns: derive hide from requestedColumnVisibility state
      if (requestedColumnIds.has(id)) {
        const isVisible = id === 'RequestedItemNo'
          ? requestedItemNoVisible
          : Boolean(requestedColumnVisibility[id as RequestedDisplayFieldKey]);
        const shouldHide = !showRequestedColumns || !isVisible;
        if (column.hide !== shouldHide) {
          return { ...column, hide: shouldHide };
        }
        return column;
      }
      // For non-requested columns: apply savedHiddenMap if present
      if (hasSavedHidden && savedHiddenMap[id] != null) {
        return { ...column, hide: savedHiddenMap[id] };
      }
      return column;
    });
  }, [
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
  ]);

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
      removeCollapsedDescendantsFromGrid(next);
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
        resolveRowTypeLabel: resolveOfferProductTypeLabel,
        resolveMultiRowTypeLabel: (rows) => {
          const types = new Set(
            rows.map((row) => resolveOfferProductTypeLabel(row)).filter((value) => value && value.trim().length > 0),
          );
          if (types.size !== 1) return 'items';
          const [type] = Array.from(types);
          if (type === 'category') return 'categories';
          if (type === 'product') return 'products';
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

  const populateRequestedRowsToOffer = useCallback(async (nodes: RowNode<Record<string, unknown>>[]) => {
    const requestedNodes = nodes.filter((node) => isRequestedRow(node?.data ?? null) || hasRequestedPseudoFields(node?.data ?? null));
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

    // Clear actual product data from already-populated rows so they can be re-populated
    const alreadyPopulatedNodes = requestedNodes.filter((node) => {
      const data = node?.data ?? null;
      if (!data) return false;
      const productId = (data as { ProductID?: unknown }).ProductID;
      return productId != null && productId !== 0;
    });
    if (alreadyPopulatedNodes.length > 0) {
      const idsToUnassign = alreadyPopulatedNodes
        .map((node) => normalizeOfferDetailId((node?.data as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
        .filter((id): id is number => id != null);
      if (idsToUnassign.length > 0) {
        try {
          const res = await fetch(addProductsEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'unassign-requested', offerDetailIds: idsToUnassign }),
          });
          const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
          if (!res.ok || !payload?.ok) {
            showToastMessage(payload?.error ?? 'Failed to clear existing product data for re-population.', 'error');
            return;
          }
          // Reset local node data directly (without setDataValue) to avoid
          // triggering cell-changed handlers that spam validation toasts.
          // The grid will be purge-refreshed at the end of populate anyway.
          for (const node of alreadyPopulatedNodes) {
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

    try {
      for (const node of requestedNodes) {
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

          const productMeta = await fetchProductSummary(productId);
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
          const requestedPartNumberRaw = getExactTextValue(
            (data as { RequestedPartNo?: unknown }).RequestedPartNo ?? null,
          );
          const requestedModelNumberRaw = getExactTextValue(
            (data as { RequestedModelNo?: unknown }).RequestedModelNo ?? null,
          );
          const requestedBrandRaw = getExactTextValue(
            (data as { RequestedBrand?: unknown }).RequestedBrand ?? null,
          );
          const partNumber = requestedPartNumberRaw
            ?? getExactTextValue((data as { PartNumber?: unknown }).PartNumber ?? null)
            ?? productMeta?.PartNumber
            ?? null;
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
      const shouldRefresh = updates.length > 0 || productsAdded > 0;
      if (shouldRefresh) {
        try {
          window.requestAnimationFrame(() => refreshOfferProductGrid(null, { purge: true }));
        } catch {
          refreshOfferProductGrid(null, { purge: true });
        }
      }
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
  }, [addProductsEndpoint, assignRequestedRowToProduct, promoteNodeToCategory, promoteNodeToProduct, refreshOfferProductGrid, resolvedEndpoint]);

  const currentRequestedMatch = requestedMatchQueue[0] ?? null;
  void suggestionCacheVersion; // trigger re-read from ref on cache update
  const currentPrefetchedSuggestions = currentRequestedMatch
    ? suggestionCacheRef.current.get(currentRequestedMatch.offerDetailId) ?? null
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

  const advanceMatchQueue = useCallback(() => {
    setRequestedMatchQueue((prev) => (prev.length > 0 ? prev.slice(1) : prev));
    setProcessedRequestedMatches((prev) => prev + 1);
  }, []);

  const handleManualAssign = useCallback(async (productId: number, comment: string) => {
    if (!currentRequestedMatch) return false;
    const assignment = await assignRequestedRowToProduct(
      currentRequestedMatch.offerDetailId,
      productId,
      currentRequestedMatch.parentCategoryId,
      comment,
    );
    if (assignment) {
      showToastMessage('Requested item filled', 'success');
      try {
        refreshOfferProductGrid(null, { purge: true });
      } catch {
        /* noop */
      }
      advanceMatchQueue();
      return true;
    }
    showToastMessage('Unable to assign requested item. Please try again.', 'error');
    return false;
  }, [advanceMatchQueue, assignRequestedRowToProduct, currentRequestedMatch, refreshOfferProductGrid]);

  const handleManualSkip = useCallback(() => {
    if (!currentRequestedMatch) return;
    showToastMessage('Skipped requested item.', 'info');
    advanceMatchQueue();
    // Force re-show requested columns that may have been hidden during the
    // populate/match flow.  A deferred RAF handles AG Grid internal timing.
    if (typeof window !== 'undefined') {
      window.requestAnimationFrame(() => {
        forceReapplyRequestedColumnsVisibility();
      });
    }
  }, [advanceMatchQueue, currentRequestedMatch, forceReapplyRequestedColumnsVisibility]);

  const handleManualSkipAll = useCallback(() => {
    if (requestedMatchQueue.length === 0) return;
    showToastMessage('Skipped all requested items.', 'info');
    setRequestedMatchQueue([]);
    setProcessedRequestedMatches(0);
    batchPrefetchedRef.current = false;
    suggestionCacheRef.current.clear();
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
    return payload.rows;
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
        // getSelectedNodes/forEachNode only return loaded rows
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

      await populateRequestedRowsToOffer(requestedNodes);
    } finally {
      populateOfferBusyRef.current = false;
    }
  }, [populateRequestedRowsToOffer, fetchAllFilteredRows]);

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
    return Array.from(new Set(
      payload.rows
        .map((row) => normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
        .filter((id): id is number => id != null),
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
        fields: ['ProductID'],
      }),
    });
    const payload = (await response.json().catch(() => null)) as
      | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
      | null;
    if (!response.ok || !payload?.ok || !Array.isArray(payload.rows)) {
      throw new Error(payload?.error ?? `Failed to load selected rows (status ${response.status})`);
    }
    return Array.from(new Set(
      payload.rows
        .map((row) => normalizeProductId((row as { ProductID?: unknown })?.ProductID ?? null))
        .filter((id): id is number => id != null),
    ));
  }, [dataEndpoint]);

  const buildTemplateExportRows = useCallback((rows: OfferExportRow[]): OfferProductsTemplateExportRow[] => {
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
      const netUnitPrice = coerceNumber(row.NetUnitPrice);
      const qtyForExport = qty != null && !Object.is(qty, 0) ? qty : null;
      const deliveryRaw = row.Delivery == null ? '' : String(row.Delivery).trim();
      const deliveryValue = deliveryRaw.length > 0 ? deliveryRaw : 'unknown';
      const isUnmatchedProduct = rowType === 'product'
        && !row.PartNumber?.toString().trim()
        && !row.BrandName?.toString().trim()
        && !model
        && !description
        && netUnitPrice == null;
      return {
        no: normalizeNoForExport(row.TreeOrdering),
        productReference: row.PartNumber?.toString().trim() ?? '',
        manufacturer: (row.AVC4BrandName?.toString().trim() || row.BrandName?.toString().trim()) ?? '',
        descriptionType,
        qty: qtyForExport ?? '',
        unitPrice: netUnitPrice ?? '',
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

  const getAddInsertionAnchor = useCallback((): { offerDetailId: number; parentPath: number[] } | null => {
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
        const path = parseTreeOrderingPath((row as { TreeOrdering?: unknown } | null)?.TreeOrdering ?? null);
        if (path.length === 0) continue;
        return { offerDetailId, parentPath: path.slice(0, -1) };
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
    }),
    [canUndo, forceReapplyRequestedColumnsVisibility, getAddInsertionAnchor, getAllVisibleRowData, getSelectedOfferDetailIds, getSelectedOfferDetailIdsForPriceUpdate, getSelectedRequestedOfferDetailId, getSelectedRowData, getTemplateExportRows, getViewportScrollTop, lastLabel, performUndo, populateOffer],
  );


  const manualMatchTotal = processedRequestedMatches + requestedMatchQueue.length;
  const manualMatchPosition = currentRequestedMatch ? processedRequestedMatches + 1 : 0;

  const openBrandBulkEdit = useCallback((
    field: 'CurrencyCostModifier' | 'Margin',
    brandName: string,
    currentValue?: unknown,
  ) => {
    const normalizedBrand = brandName.trim();
    if (!normalizedBrand) {
      showToastMessage('Missing brand name for bulk edit.', 'error');
      return;
    }
    setBrandBulkEditField(field);
    setBrandBulkEditBrandName(normalizedBrand);
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
    const brandName = brandBulkEditBrandName.trim();
    if (!brandName) {
      setBrandBulkEditError('Brand is required.');
      return;
    }
    const valueNumber = coerceNumber(brandBulkEditValue);
    const label = brandBulkEditField === 'CurrencyCostModifier' ? 'Cost modifier' : 'Margin';
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
      // Fetch all product rows for this brand (pivot view excludes categories and requested-only rows).
      const res = await fetch(resolvedEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request: {
            allRows: true,
            view: 'pivot',
            filterModel: {
              BrandName: {
                filterType: 'text',
                type: 'equals',
                filter: brandName,
              },
            },
          },
        }),
      });
      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string; rows?: Array<Record<string, unknown>> }
        | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Unable to load brand rows (status ${res.status})`);
      }
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      const ids = rows
        .map((row) => normalizeOfferDetailId((row as { OfferDetailID?: unknown })?.OfferDetailID ?? null))
        .filter((id): id is number => id != null);
      if (ids.length === 0) {
        throw new Error('No product rows found for this brand.');
      }

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

      showToastMessage(`${label} updated for ${brandName} (${ids.length} items)`, 'success');
      setBrandBulkEditOpen(false);
      refreshOfferProductGrid(null, { purge: false });
    } catch (err) {
      console.error('Brand bulk edit failed', err);
      setBrandBulkEditError(err instanceof Error ? err.message : 'Unable to apply changes.');
    } finally {
      setBrandBulkEditSaving(false);
    }
  }, [
    brandBulkEditBrandName,
    brandBulkEditField,
    brandBulkEditSaving,
    brandBulkEditValue,
    refreshOfferProductGrid,
    resolvedEndpoint,
  ]);

  const productContextMenuItems = useCallback((
    params: GetContextMenuItemsParams<Record<string, unknown>>,
  ) => {
    const baseItems = productRowDeletion.getContextMenuItems(params) ?? [];
    const items = [...baseItems];
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

    // Copy/Paste clipboard items (placed first in custom actions section)
    const selectedNodesForCopy = api && typeof api.getSelectedNodes === 'function'
      ? (api.getSelectedNodes() as Array<RowNode<Record<string, unknown>>>)
      : [];
    const hasSelection = selectedNodesForCopy.length > 0;
    const copyItem: MenuItemDef = {
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
    const clipboardItems: Array<MenuItemDef<Record<string, unknown>> | DefaultMenuItem | string> = [copyItem];
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
      const deleteIndexForClipboard = findDeleteMenuItemIndex(items);
      if (deleteIndexForClipboard >= 0) {
        items.splice(
          deleteIndexForClipboard,
          0,
          'separator' as unknown as DefaultMenuItem,
          ...clipboardItems,
          'separator' as unknown as DefaultMenuItem,
        );
      } else {
        items.push(
          'separator' as unknown as DefaultMenuItem,
          ...clipboardItems,
          'separator' as unknown as DefaultMenuItem,
        );
      }
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

    const rowHasRequestedFields = hasRequestedPseudoFields(rowData);

    let deleteIndexAfterHistory = findDeleteMenuItemIndex(items);

    const rowBrandName = typeof (rowData as { BrandName?: unknown } | null | undefined)?.BrandName === 'string'
      ? String((rowData as { BrandName?: unknown }).BrandName).trim()
      : '';
    const canBulkEditBrand = rowBrandName.length > 0 && isOfferProductProduct(rowData);
    if (canBulkEditBrand) {
      const currentModifier = (rowData as { CurrencyCostModifier?: unknown }).CurrencyCostModifier ?? null;
      const currentMargin = (rowData as { Margin?: unknown }).Margin ?? null;
      const otherCurrencyName = typeof (rowData as { OtherCurrencyName?: unknown } | null | undefined)?.OtherCurrencyName === 'string'
        ? String((rowData as { OtherCurrencyName?: unknown }).OtherCurrencyName).trim()
        : '';
      const isEuroCostCurrency =
        !otherCurrencyName ||
        otherCurrencyName === '€' ||
        otherCurrencyName.toLowerCase().includes('eur') ||
        otherCurrencyName.toLowerCase().includes('euro');
      const setModifierItem: MenuItemDef = {
        name: 'Set cost modifier for this brand',
        icon: brandBulkEditMenuIcon,
        action: () => openBrandBulkEdit('CurrencyCostModifier', rowBrandName, currentModifier),
      };
      const setMarginItem: MenuItemDef = {
        name: 'Set margin for this brand',
        icon: brandBulkEditMenuIcon,
        action: () => openBrandBulkEdit('Margin', rowBrandName, currentMargin),
      };
      const bulkItems: MenuItemDef[] = [];
      if (!isEuroCostCurrency) {
        bulkItems.push(setModifierItem);
      }
      bulkItems.push(setMarginItem);
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
            name: 'Delete Products',
            disabled: !deleteCheck.allowed,
            tooltip: deleteCheck.allowed ? undefined : deleteCheck.reason,
            action: async () => {
              try {
                const ids = await fetchAllFilteredOfferDetailIds();
                if (ids.length === 0) {
                  showToastMessage('No products selected for deletion.', 'info');
                  return;
                }
                const countLabel = ids.length === 1 ? 'product' : 'products';
                const confirmLabel = ids.length === 1 ? 'Delete product' : 'Delete products';
                const keepLabel = ids.length === 1 ? 'Keep product' : 'Keep products';
                const confirmed = await showConfirmDialog({
                  title: confirmLabel,
                  message: `Delete ${ids.length} ${countLabel}? This action cannot be undone.`,
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
                const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
                if (!res.ok || !payload?.ok) {
                  throw new Error(payload?.error ?? `Failed to delete rows (status ${res.status})`);
                }
                showToastMessage(ids.length === 1 ? 'Product deleted' : `${ids.length} products deleted`, 'success');
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
            showToastMessage('Marked as category', 'success');
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
                rowNode.setDataValue('Description', previousDescription ?? null);
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
          showToastMessage(
            commentTargetNodes.length === 1
              ? `Marked as ${label}`
              : `${commentTargetNodes.length} rows marked as ${label}`,
            'success',
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

    // --- Add web links item (product rows only) ---
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
      const deleteIdx = findDeleteMenuItemIndex(items);
      items.splice(deleteIdx >= 0 ? deleteIdx : items.length, 0, webLinkItem);
    }

    // --- Enhance description item (product rows only) ---
    if (targetIds.length > 0 || isSelectAllActive) {
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
              // For select-all we only have product IDs; we need offer detail IDs too
              const allDetailIds = await fetchAllFilteredOfferDetailIds();
              // Pair them: fetch from grid rows if possible
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
      const enhanceDeleteIdx = findDeleteMenuItemIndex(items);
      items.splice(enhanceDeleteIdx >= 0 ? enhanceDeleteIdx : items.length, 0, enhanceDescItem);
    }

    return items;
  }, [
    fetchAllFilteredOfferDetailIds,
    fetchAllFilteredOfferProductIds,
    isAddingWebLinks,
    isEnhancingDescriptions,
    pushUndo,
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
        showToastMessage(`Unable to update ${friendlyLabel}. Please try again.`, 'error');
        revertValue();
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
      } catch (err) {
        console.error('Failed to update quantity', err);
        showToastMessage('Unable to update quantity. Please try again.', 'error');
        revertValue();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

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
          event.node?.setDataValue?.('Description', normalizedNewValue ?? '');
          event.node?.setDataValue?.('ProductDescription', normalizedNewValue ?? '');
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
              event.node?.setDataValue?.('Description', capturedOldDesc ?? '');
              event.node?.setDataValue?.('ProductDescription', capturedOldDesc ?? '');
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
        showToastMessage('Unable to update description. Please try again.', 'error');
        revertValue();
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
        showToastMessage('Unable to update comment. Please try again.', 'error');
        revertValue();
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
        showToastMessage('Unable to update delivery. Please try again.', 'error');
        revertValue();
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
      return;
    }
    if (field === 'Margin' && Math.abs(normalizedNewValue) >= 100) {
      showToastMessage('Margin must be between -100 and 100.', 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }
    if (field === 'CurrencyCostModifier') {
      if (!Number.isFinite(normalizedNewValue) || !(normalizedNewValue > 0)) {
        showToastMessage('Cost modifier must be greater than 0.', 'error');
        try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
        return;
      }
    }

    const normalizedOldValue = coerceNumber(event.oldValue);
    if (normalizedOldValue != null && Object.is(normalizedOldValue, normalizedNewValue)) {
      return;
    }

    const revertValue = () => {
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ OfferDetailID: offerDetailId, [field]: normalizedNewValue }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label} (status ${res.status})`);
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
        try {
          refreshOfferProductGrid(event.api ?? null, { purge: false });
        } catch {
          /* noop */
        }
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, [refreshOfferProductGrid, resolvedEndpoint, shouldSkipRealtimeCellEdit, pushUndo, performUndo]);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    handleDescriptionEdit(event);
    handleCommentEdit(event);
    handleDeliveryEdit(event);
    handleRequestedFieldEdit(event);
    handleQuantityEdit(event);
    handlePricingEdit(event);
  }, [handleDescriptionEdit, handleCommentEdit, handleDeliveryEdit, handleRequestedFieldEdit, handleQuantityEdit, handlePricingEdit]);

  const formatEuroTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} €`;
  };
  const formatPercentTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} %`;
  };

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
          />
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
              <span className={styles.totalLabel}>Total Net Price:</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalNetPrice)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total List Price:</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalListPrice)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Cost:</span>
              <span className={styles.totalValue}>{formatEuroTotal(totals?.totalCost)}</span>
            </div>
            <div className={styles.totalItem}>
              <span className={styles.totalLabel}>Total Margin:</span>
              <span className={styles.totalValue}>{formatPercentTotal(totals?.totalMargin)}</span>
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
        />
      ) : null}
      <AddProductModal
        open={matchAddProductOpen}
        onAdded={handleMatchProductAdded}
        onClose={closeMatchAddProduct}
        initialValues={matchAddProductInitialValues}
      />
      <LookupModal
        open={brandBulkEditOpen}
        title={brandBulkEditField === 'CurrencyCostModifier' ? 'Bulk edit cost modifier by brand' : 'Bulk edit margin by brand'}
        onClose={closeBrandBulkEdit}
        onConfirm={confirmBrandBulkEdit}
        confirmLabel="Apply"
        saving={brandBulkEditSaving}
        error={brandBulkEditError}
      >
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
        <div className={lookupStyles.field}>
          <label className={lookupStyles.fieldLabel} htmlFor="bulk-edit-brand-value">
            {brandBulkEditField === 'CurrencyCostModifier' ? 'Cost modifier' : 'Margin (%)'}
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
    </>
  );
});

OfferProductsPanel.displayName = 'OfferProductsPanel';

export default React.memo(OfferProductsPanel);
