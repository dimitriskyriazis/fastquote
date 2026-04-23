'use client';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { CellClickedEvent, ColDef, GetContextMenuItemsParams, GridApi, MenuItemDef, RowClassParams, RowDoubleClickedEvent, RowNode, RowStyle } from 'ag-grid-community';
import { PageHeaderContext } from '../../../components/PageHeader';
import { GridQuickSearchProvider } from '../../../components/GridQuickSearchProvider';
import { productDefaultColDef } from '../../../../lib/productColumns';
import { priceListStatusClassRules } from '../../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../../lib/localeNumber';
import styles from './MatchRequestedProductsModal.module.css';
import { useModalDragResize } from '../../../hooks/useModalDragResize';
import { useFarnellSearch, isFarnellRow, type FarnellSearchRow } from '../../../hooks/useFarnellSearch';
import { useFarnellProductResolver } from '../../../hooks/useFarnellProductResolver';
import {
  isFarnellBrand,
  buildRequestedFilterState,
  buildPromptFilterState,
  buildNegativeHiddenTokens,
  mergeExpansionsIntoFilterModel,
  type FuzzyTextFilter,
  type HiddenFilterTokens,
  type FilterExpansions,
  type PromptRouting,
} from '../offerProductsUtils';
import {
  AiSearchPromptPill,
  AI_GRID_LOCK_CLASS,
} from './AiSearch';
import { showConfirmDialog } from '../../../../lib/confirm';

const AgGridAll = dynamic(() => import('../../../components/AgGridAll'), {
  ssr: false,
});

import type { GridResponse } from '../../../components/AgGridAll';

type DetailEntry = {
  label: string;
  value: string;
};

// Structured assignment-accuracy metrics captured at assign-button click
// time.  Flows through onAssign → the parent's assignRequestedRowToProduct
// → server, where it's logged with category 'assignment-metrics' for later
// MRR / top-K analysis.  rank is 1-based in the visible grid; -1 means the
// assigned product wasn't in the visible rows (prompt search, pinned
// suggestion, Farnell, etc.).
export type AssignmentMetrics = {
  rank: number;
  totalRows: number;
  hadRerank: boolean;
  hadPrefetchedExpansion: boolean;
  entryBrand: string | null;
  entryPart: string | null;
  entryModel: string | null;
  entryDesc: string | null;
};

export type RequestedProductMatchEntry = {
  offerDetailId: number;
  parentCategoryId: number | null;
  label: string;
  quantity: number | null;
  details: DetailEntry[];
  requestedBrand: string | null;
  requestedModelNumber: string | null;
  requestedPartNumber: string | null;
  requestedWebLink: string | null;
  requestedDescription: string | null;
  requestedDescription2: string | null;
  requestedDescription3: string | null;
};

type MatcherRowData = Record<string, unknown>;
type MatcherSortEntry = { colId: string; sort: 'asc' | 'desc' };
type MatcherGridApi = GridApi<MatcherRowData> & {
  getSortModel?: () => MatcherSortEntry[];
  setSortModel?: (model: MatcherSortEntry[]) => void;
  purgeServerSideCache?: () => void;
  refreshServerSide?: (params?: { purge?: boolean }) => void;
  setPinnedTopRowData?: (data: MatcherRowData[]) => void;
};

type MatcherRowNode = RowNode<MatcherRowData> & {
  ensureVisible?: (params?: { position?: 'top' | 'middle' | 'bottom' }) => void;
};

type Props = {
  offerId: string;
  entry: RequestedProductMatchEntry;
  position: number;
  total: number;
  onAssign: (productId: number, comment: string, metrics?: AssignmentMetrics | null) => Promise<boolean>;
  onSkip: () => void;
  onRequestAddProduct: () => void;
  newProductId?: number | null;
  onClearNewProductId: () => void;
  onRequestPayloadConsumed?: () => void;
  onSkipAll: () => void;
  prefetchedSuggestions?: MatcherRowData[] | null;
  prefetchedExpansion?: FilterExpansions | null;
  prefetchedFirstPage?: GridResponse | null;
  onCurrentEntryReady?: () => void;
};

const currencyFormatter = new Intl.NumberFormat(getUserNumberLocale(), {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatEuro = (value: unknown) => {
  if (value == null) return '';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${currencyFormatter.format(num)} €`;
};

const priceListClassRules = priceListStatusClassRules();

const priceValueFormatter = (params: { value: unknown }) => formatEuro(params.value);

const emptyColumnWidthDefaults = {};

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const PartNumberCellRenderer = ({ value, data }: { value?: unknown; data?: Record<string, unknown> }) => {
  const text = value == null ? '' : String(value);
  const webLink = data?.WebLink;
  if (webLink && typeof webLink === 'string' && webLink.trim()) {
    return (
      <a href={webLink} target="_blank" rel="noopener noreferrer" title={webLink}>
        {text}
      </a>
    );
  }
  return <>{text}</>;
};

const DescriptionCellRenderer = ({ value }: { value?: unknown }) => {
  const text = value == null ? '' : String(value);
  return (
    <div className={styles.descriptionCell}>
      <div className={styles.descriptionText}>
        {text}
      </div>
    </div>
  );
};

export default function MatchRequestedProductsModal({
  offerId,
  entry,
  position,
  total,
  onAssign,
  onSkip,
  onRequestAddProduct,
  newProductId,
  onClearNewProductId,
  onRequestPayloadConsumed,
  onSkipAll,
  prefetchedSuggestions,
  prefetchedExpansion,
  prefetchedFirstPage,
  onCurrentEntryReady,
}: Props) {
  const { cardRef: setCardRef, cardStyle: dragCardStyle, headerProps: dragHeaderProps, resizeHandles } = useModalDragResize({ draggable: true, resizable: true });
  const [selectedProduct, setSelectedProduct] = useState<MatcherRowData | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [comment, setComment] = useState('');
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestedProducts, setSuggestedProducts] = useState<MatcherRowData[]>([]);
  const [suggestionsVisible, setSuggestionsVisible] = useState(true);
  const [noSuggestionsFound, setNoSuggestionsFound] = useState(false);
  const [promptText, setPromptText] = useState('');
  const productsApiRef = useRef<MatcherGridApi | null>(null);
  const pendingSelectionProductIdRef = useRef<number | null>(null);
  const suggestedProductsRef = useRef<MatcherRowData[]>([]);
  const currentEntryIdRef = useRef(entry.offerDetailId);
  currentEntryIdRef.current = entry.offerDetailId;
  const gridShellRef = useRef<HTMLDivElement | null>(null);
  const userWantsSuggestionsRef = useRef(false);
  const userManuallySelectedRef = useRef(false);
  const autoSelectingRef = useRef(false);
  const handleSuggestProductsRef = useRef<(() => void) | null>(null);

  // Farnell search state
  const [brandFilterIsFarnell, setBrandFilterIsFarnell] = useState(() => isFarnellBrand(entry.requestedBrand));
  const [farnellVisible, setFarnellVisible] = useState(true);
  const [farnellPartNumber, setFarnellPartNumber] = useState<string | null>(entry.requestedPartNumber ?? null);
  const [farnellDescription, setFarnellDescription] = useState<string | null>(entry.requestedDescription ?? null);

  const { farnellResults, farnellLoading, noFarnellResults, searchFarnell, clearFarnellResults } = useFarnellSearch({
    partNumber: farnellPartNumber,
    description: farnellDescription,
    quantity: entry.quantity ?? undefined,
  });
  const farnellResultsRef = useRef<FarnellSearchRow[]>([]);
  farnellResultsRef.current = farnellResults;

  const { resolveFarnellProduct, resolving: farnellResolving } = useFarnellProductResolver();

  // Keep ref in sync so event listeners can read current value
  suggestedProductsRef.current = suggestedProducts;

  const setPinnedSuggestions = useCallback((products: MatcherRowData[]) => {
    const api = productsApiRef.current;
    if (!api) return;
    try {
      api.setGridOption('pinnedTopRowData', products);
    } catch { /* noop */ }
  }, []);

  const clearPinnedTopRow = useCallback(() => {
    setPinnedSuggestions([]);
  }, [setPinnedSuggestions]);

  const handleHideSuggestions = useCallback(() => {
    userWantsSuggestionsRef.current = false;
    setSuggestionsVisible(false);
    clearPinnedTopRow();
  }, [clearPinnedTopRow]);

  const handleShowSuggestions = useCallback(() => {
    userWantsSuggestionsRef.current = true;
    setSuggestionsVisible(true);
    const products = suggestedProductsRef.current;
    setPinnedSuggestions(products);
    if (products.length > 0) {
      try {
        productsApiRef.current?.deselectAll?.();
      } catch { /* noop */ }
      setSelectedProduct(products[0]);
    }
  }, [setPinnedSuggestions]);

  // Sync pinned rows when suggestedProducts, farnellResults, or visibility changes
  useEffect(() => {
    const rows: MatcherRowData[] = [];
    if (suggestedProducts.length > 0 && suggestionsVisible) {
      rows.push(...suggestedProducts);
    }
    if (farnellResults.length > 0 && farnellVisible) {
      rows.push(...farnellResults);
    }
    if (rows.length > 0) {
      setPinnedSuggestions(rows);
    } else {
      clearPinnedTopRow();
    }
  }, [suggestedProducts, suggestionsVisible, farnellResults, farnellVisible, setPinnedSuggestions, clearPinnedTopRow]);

  const getRowStyle = useCallback((params: RowClassParams): RowStyle | undefined => {
    // Pinned top row default/hover/selected styling handled via CSS on .ag-floating-top
    if (params.node.rowPinned === 'top') return undefined;
    return undefined;
  }, []);

  const productColumns: ColDef[] = useMemo(
    () => [
      {
        field: 'PartNumber',
        headerName: 'Part Number',
        filter: 'agTextColumnFilter',
        cellRenderer: PartNumberCellRenderer,
        width: 225,
      },
      {
        field: 'Description',
        headerName: 'Description',
        filter: 'agTextColumnFilter',
        cellRenderer: DescriptionCellRenderer,
        width: 500,
      },
      { field: 'BrandName', headerName: 'Brand', filter: 'agTextColumnFilter', width: 200 },
      {
        field: 'ModelNumber',
        headerName: 'Model Number',
        filter: 'agTextColumnFilter',
        width: 225,
      },
      {
        field: 'ListPrice',
        headerName: 'List Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: priceValueFormatter,
        cellClassRules: priceListClassRules,
        width: 150,
      },
      {
        field: 'CostPrice',
        headerName: 'Cost Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: priceValueFormatter,
        width: 150,
      },
      { field: 'PriceListName', headerName: 'Price List', filter: 'agTextColumnFilter', width: 225 },
    ],
    [],
  );

  // Live AI expansion for the current entry, fetched by the modal when the
  // parent didn't prefetch.  Populated in the useEffect further down; folded
  // into the filter model via effectiveExpansion so the initial grid query
  // includes the widened hidden tokens and we avoid a second round-trip.
  const [liveExpansion, setLiveExpansion] = useState<FilterExpansions | null>(null);

  // Build the filter model along with a per-column "hidden tokens" sidecar.
  // The visible filter is kept minimal (one condition per column) so AG Grid's
  // filter popup stays readable; the full set of fuzzy tokens / synonyms /
  // cross-fold terms ride along in requestPayload.hiddenFilterTokens and are
  // applied server-side with identical WHERE + relevance-score semantics.
  // Semantics shared with AddProductsModal via the common helper.
  //
  // Effective expansion: prefer the parent's prefetched response if present,
  // otherwise use the modal's own /expand fetch (liveExpansion).
  const effectiveExpansion = prefetchedExpansion ?? liveExpansion;
  const { requestedFilterModel, hiddenFilterTokens } = useMemo(() => {
    const { visibleModel, hiddenTokens } = buildRequestedFilterState({
      requestedBrand: entry.requestedBrand,
      requestedPartNumber: entry.requestedPartNumber,
      requestedModelNumber: entry.requestedModelNumber,
      requestedDescriptions: [
        entry.requestedDescription,
        entry.requestedDescription2,
        entry.requestedDescription3,
      ],
      prefetchedExpansion: effectiveExpansion,
    });
    return { requestedFilterModel: visibleModel, hiddenFilterTokens: hiddenTokens };
  }, [
    entry.requestedBrand,
    entry.requestedModelNumber,
    entry.requestedPartNumber,
    entry.requestedDescription,
    entry.requestedDescription2,
    entry.requestedDescription3,
    effectiveExpansion,
  ]);

  // When the user submits a prompt or the auto-expand AI response lands, we
  // override the hidden-token payload so the in-flight query picks up the
  // extended terms.  Cleared on entry change so each row starts fresh.
  const [overrideHiddenTokens, setOverrideHiddenTokens] = useState<HiddenFilterTokens | null>(null);
  const effectiveHiddenTokens = overrideHiddenTokens ?? hiddenFilterTokens;
  // Refetch the grid whenever the hidden-token payload changes AFTER the
  // initial render for this entry.  AgGridAll reads requestPayload from a
  // ref at fetch time and does NOT auto-refetch on prop change, so without
  // this effect the widened-recall hidden tokens that /expand writes after
  // the user's filter-change debounce never actually reach the server.
  //
  // The initial-fire skip is critical: on entry change we remount with
  // prefetchedFirstPage + prefetchedExpansion-derived tokens already
  // correct, so firing a purged refresh on mount would wipe the just-
  // consumed cached first page and force a redundant ~1s SQL round-trip.
  // The skip is reset on every entry change so the NEXT entry also gets
  // its one-free-pass.
  const hiddenTokensInitialFireRef = useRef(true);
  useEffect(() => {
    hiddenTokensInitialFireRef.current = true;
  }, [entry.offerDetailId]);
  useEffect(() => {
    if (hiddenTokensInitialFireRef.current) {
      hiddenTokensInitialFireRef.current = false;
      return;
    }
    const api = productsApiRef.current as unknown as { refreshServerSide?: (p?: { purge?: boolean }) => void; isDestroyed?: () => boolean } | null;
    if (!api || api.isDestroyed?.()) return;
    try { api.refreshServerSide?.({ purge: true }); } catch { /* noop */ }
  }, [effectiveHiddenTokens]);
  // Prompt-driven AI search lock state (mirrors AddProductsModal).  When
  // true: prompt input becomes read-only, the column filter row is hidden,
  // and a banner in the filter-row slot shows the AI's interpretation.
  const [promptSubmitted, setPromptSubmitted] = useState(false);
  const promptSubmittedRef = useRef(false);
  promptSubmittedRef.current = promptSubmitted;
  // Debounced filter-change-driven semantic expansion (same mechanism as
  // AddProductsModal).
  const semanticExpandTimerRef = useRef<number | null>(null);
  const semanticExpandAbortRef = useRef<AbortController | null>(null);
  const lastSemanticSigRef = useRef<string>('');
  // Forward ref for triggerSemanticFromFilters — attachFilterListener runs
  // earlier in the file than the trigger is defined, so we thread it
  // through a ref that's populated after the callback is created below.
  const triggerSemanticFromFiltersRef = useRef<((api: MatcherGridApi) => void) | null>(null);

  // Rerank is now server-inline (see products/add route) so no client state
  // or refetch dance is needed.  The grid's first response already arrives
  // in LLM-determined order.

  // Tracks whether the user has manually edited the filter row since the
  // entry's auto-populated chips were applied.  Once true, rerank is
  // suppressed — the filters no longer represent the entry's original
  // spec, so reranking against that spec would drag results back toward
  // things the user is explicitly filtering away from.  Mirrors the plain
  // keyword-score behavior of AddProductsModal so the two modals feel
  // identical once the user takes manual control.  Reset on entry change
  // and after prompt-exit.  Declared here (above requestPayload) so the
  // memo can read it; the setter is wired into the filter-change listener
  // further down.
  const [userTouchedFilters, setUserTouchedFilters] = useState(false);
  const suppressNextFilterChangeRef = useRef(0);
  const markProgrammaticFilterChange = useCallback(() => {
    suppressNextFilterChangeRef.current += 1;
  }, []);

  const requestPayload = useMemo(() => {
    // Keep BrandName in the cross-column OR group.  A strict Brand AND-gate
    // silently drops valid rebrands (e.g. Logickeyboard keyboards catalogued
    // under "Canford Audio", Ross Video resold under a house brand).  The
    // brand term is mirrored as a hidden Description token in
    // buildRequestedFilterState, so rebranded rows still match via
    // Description and the scoring pushes correct-brand rows up without
    // censoring valid distributor listings.
    const payload: Record<string, unknown> = {
      action: 'products',
      orFilterColumns: ['BrandName', 'PartNumber', 'ModelNumber', 'Description'],
    };
    // Raw requested spec for the server's inline LLM rerank on first-page
    // loads.  Sent as a sibling of filterModel (not derived from it) so the
    // rerank prompt sees the original chip text — the filterModel's
    // BrandName gets normalized (lowercase, spaces stripped) for LIKE
    // matching which would make "TVOne" look like "tvone" in the prompt.
    //
    // Only included when the auto-populated entry filters are still in
    // effect — i.e. the user has NOT submitted an AI prompt and has NOT
    // manually edited the filter chips.  Once either happens, the filter
    // state no longer represents the entry's original spec, so reranking
    // against that spec would drag results back toward things the user is
    // trying to move away from.  Omitting `requested` matches the plain
    // keyword-score behavior of AddProductsModal so the two modals feel
    // identical once the user takes manual control.
    if (!promptSubmitted && !userTouchedFilters) {
      payload.requested = {
        brand: entry.requestedBrand,
        partNumber: entry.requestedPartNumber,
        modelNumber: entry.requestedModelNumber,
        description: entry.requestedDescription,
        description2: entry.requestedDescription2,
        description3: entry.requestedDescription3,
      };
    }
    if (effectiveHiddenTokens) payload.hiddenFilterTokens = effectiveHiddenTokens;
    const negative = buildNegativeHiddenTokens(effectiveExpansion, effectiveHiddenTokens);
    if (negative) payload.negativeHiddenTokens = negative;
    // newProductId is intentionally NOT forwarded to the server.  The old
    // flow also asked the server to order the new product first, which
    // produced a duplicate rendering (the regular row served by the server
    // plus the client-side pinned row below).  We now show the new product
    // only as a client-side pinned top row.
    return Object.keys(payload).length > 0 ? payload : null;
  }, [effectiveHiddenTokens, effectiveExpansion, entry, promptSubmitted, userTouchedFilters]);

  const endpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products/add`,
    [offerId],
  );

  const hasAppliedRequestedFiltersRef = useRef(false);

  const applyRequestedFilterModel = useCallback((api: MatcherGridApi | null) => {
    if (!api) return;
    if (hasAppliedRequestedFiltersRef.current) return;
    const filters = requestedFilterModel ?? null;
    if (!filters) return;
    try {
      markProgrammaticFilterChange();
      api.setFilterModel(filters);
    } catch {
      /* noop */
    }
    hasAppliedRequestedFiltersRef.current = true;
  }, [requestedFilterModel, markProgrammaticFilterChange]);

  const selectedProductId = useMemo(
    () => normalizeProductId(selectedProduct?.ProductID ?? null),
    [selectedProduct],
  );

  const selectedProductIsFarnell = isFarnellRow(selectedProduct as Record<string, unknown> | null);

  // Highlight selected suggestion row via DOM class toggle.
  // ag-grid positions pinned rows with absolute CSS so DOM element order can
  // differ from visual order.  Match by row-id (= ProductID) instead.
  const updateSuggestionHighlight = useCallback(() => {
    const shell = gridShellRef.current;
    if (!shell) return;
    const selectedId = selectedProduct?.ProductID != null ? String(selectedProduct.ProductID) : null;
    const rows = shell.querySelectorAll<HTMLElement>('.ag-floating-top .ag-row');
    rows.forEach((row) => {
      const rowId = row.getAttribute('row-id');
      if (selectedId != null && rowId === selectedId) {
        row.classList.add('suggestion-selected');
      } else {
        row.classList.remove('suggestion-selected');
      }
    });
  }, [selectedProduct]);

  useEffect(() => {
    // Run immediately for clicks on already-rendered rows.
    updateSuggestionHighlight();
    // After a fresh entry/suggestion swap AG Grid can take more than one frame
    // to render the pinned-top rows, so a single requestAnimationFrame would
    // sometimes paint before the rows appear and the .suggestion-selected class
    // never gets attached. Poll for the rows up to ~10 frames, stop once we
    // either see them or run out of attempts.
    let cancelled = false;
    let attemptsLeft = 10;
    const shell = gridShellRef.current;
    let raf = 0;
    const tick = () => {
      if (cancelled) return;
      updateSuggestionHighlight();
      const rendered = shell?.querySelectorAll('.ag-floating-top .ag-row').length ?? 0;
      if (rendered > 0 || --attemptsLeft <= 0) return;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
    };
  }, [updateSuggestionHighlight, suggestedProducts, farnellResults]);

  const handleSlotRef = useCallback((node: HTMLDivElement | null) => {
    setSearchSlot(node);
  }, []);

  const handleSelectionChanged = useCallback(
    (rows: MatcherRowData[]) => {
      // When a normal grid row is selected, use it (this clears any pinned row selection)
      if (rows.length > 0) {
        setSelectedProduct(rows[rows.length - 1]);
        // selectionChanged fires on mousedown, before cellClicked (which fires on
        // click).  Set the manual flag here so autoSelectTopProduct cannot override
        // the user's choice even if modelUpdated fires between the two events.
        if (!autoSelectingRef.current) {
          userManuallySelectedRef.current = true;
        }
      }
    },
    [],
  );

  const autoSelectTopProduct = useCallback((api: MatcherGridApi | null) => {
    if (!api) return;
    if (userManuallySelectedRef.current) return;
    if (pendingSelectionProductIdRef.current != null) return;
    // Don't auto-select grid row if we have suggestions selected
    if (suggestedProductsRef.current.length > 0) return;
    try {
      const selectedNodes =
        typeof api.getSelectedNodes === 'function' ? (api.getSelectedNodes() as Array<RowNode<MatcherRowData>>) : [];
      if (selectedNodes.length > 0) return;
    } catch {
      /* noop */
    }
    try {
      const firstNode = (api as unknown as { getDisplayedRowAtIndex?: (idx: number) => MatcherRowNode | null })
        .getDisplayedRowAtIndex?.(0);
      if (!firstNode?.data) return;
      autoSelectingRef.current = true;
      firstNode.setSelected(true);
      setSelectedProduct(firstNode.data as MatcherRowData);
      autoSelectingRef.current = false;
    } catch {
      autoSelectingRef.current = false;
    }
  }, []);

  const handleAssignWithId = useCallback(async (productId: number, assignComment?: string) => {
    if (assigning) return;
    setAssigning(true);
    try {
      // Capture assignment-accuracy metrics at click time.  Feeds a
      // structured server log (category: assignment-metrics) so we can
      // compute MRR / top-K accuracy over real assignments without
      // relying on eyeballing.  Rank 1 = user picked the top row; rank
      // >20 suggests the ranker missed; rank -1 = product wasn't in the
      // visible rows (e.g. via prompt search or clipboard paste).
      const metrics = (() => {
        try {
          const api = productsApiRef.current as unknown as {
            getDisplayedRowCount?: () => number;
            forEachNode?: (cb: (node: { data?: { ProductID?: unknown } }, idx: number) => void) => void;
          } | null;
          let rank = -1;
          let totalRows = 0;
          if (api) {
            try { totalRows = api.getDisplayedRowCount?.() ?? 0; } catch { /* noop */ }
            try {
              api.forEachNode?.((node, idx) => {
                if (rank >= 0) return;
                const rid = node?.data?.ProductID;
                const rn = typeof rid === 'number' ? rid : Number(rid);
                if (Number.isFinite(rn) && rn === productId) rank = idx + 1;
              });
            } catch { /* noop */ }
          }
          return {
            rank,
            totalRows,
            // Rerank is always applied server-side on first-page loads when
            // a Description is present, so this is effectively true for any
            // real match run.  Kept in the metric for historical continuity.
            hadRerank: Boolean(entry.requestedDescription && entry.requestedDescription.trim()),
            hadPrefetchedExpansion: Boolean(prefetchedExpansion),
            entryBrand: entry.requestedBrand ?? null,
            entryPart: entry.requestedPartNumber ?? null,
            entryModel: entry.requestedModelNumber ?? null,
            entryDesc: entry.requestedDescription ?? null,
          };
        } catch {
          return null;
        }
      })();
      await onAssign(productId, assignComment ?? comment, metrics);
      // Don't reset selectedProduct/comment here — the cleanup effect handles
      // it when the entry changes (which now happens optimistically inside onAssign,
      // so the microtask resolution of this await would override autoSelectTopProduct).
    } finally {
      setAssigning(false);
    }
  }, [assigning, onAssign, comment, prefetchedExpansion, entry]);

  const getSelectedProductIdFromApi = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return null;
    const rows =
      typeof api.getSelectedRows === 'function' ? api.getSelectedRows() : [];
    if (!rows || rows.length === 0) return null;
    const candidate = rows[rows.length - 1] as MatcherRowData;
    return normalizeProductId((candidate?.ProductID ?? null));
  }, []);

  const handleAssign = useCallback(async () => {
    // Handle Farnell row: resolve/create product first
    if (selectedProductIsFarnell && selectedProduct) {
      const resolvedId = await resolveFarnellProduct(selectedProduct as unknown as FarnellSearchRow);
      if (resolvedId == null) return;
      void handleAssignWithId(resolvedId);
      return;
    }
    const id = selectedProductId ?? getSelectedProductIdFromApi();
    if (id == null) return;
    void handleAssignWithId(id);
  }, [selectedProductId, selectedProductIsFarnell, selectedProduct, handleAssignWithId, getSelectedProductIdFromApi, resolveFarnellProduct]);

  const handleRowDoubleClick = useCallback(async (event: RowDoubleClickedEvent<MatcherRowData>) => {
    const data = event.data as MatcherRowData;
    // Handle Farnell row
    if (isFarnellRow(data as Record<string, unknown>)) {
      const resolvedId = await resolveFarnellProduct(data as unknown as FarnellSearchRow);
      if (resolvedId == null) return;
      void handleAssignWithId(resolvedId, comment);
      return;
    }
    const rawProductId = (data as { ProductID?: unknown }).ProductID ?? null;
    const productId = normalizeProductId(rawProductId);
    if (productId == null) return;
    void handleAssignWithId(productId, comment);
  }, [handleAssignWithId, comment, resolveFarnellProduct]);

  const trySelectPendingProduct = useCallback((api: MatcherGridApi) => {
    const targetId = pendingSelectionProductIdRef.current;
    if (targetId == null) return;
    let found = false;
    api.forEachNode((node) => {
      if (found) return;
      if (!node.data) return;
      const candidateId = normalizeProductId((node.data as { ProductID?: unknown }).ProductID ?? null);
      if (candidateId === targetId) {
        const rowData = node.data as MatcherRowData;
        node.setSelected(true);
        setSelectedProduct(rowData);
        try {
          api.setGridOption('pinnedTopRowData', [rowData]);
        } catch {
          /* noop */
        }
        const typedNode = node as MatcherRowNode;
        const ensureVisible = typedNode.ensureVisible;
        if (typeof ensureVisible === 'function') {
          try {
            ensureVisible.call(typedNode, { position: 'top' });
          } catch {
            /* noop */
          }
        }
        found = true;
      }
    });
    if (found) {
      pendingSelectionProductIdRef.current = null;
      onClearNewProductId?.();
    }
  }, [onClearNewProductId]);

  // Attach a cellClicked listener to handle pinned row clicks for selection
  const cellClickListenerRef = useRef<((event: CellClickedEvent<MatcherRowData>) => void) | null>(null);

  const attachCellClickListener = useCallback((api: MatcherGridApi) => {
    // Remove previous listener if any
    if (cellClickListenerRef.current) {
      try {
        api.removeEventListener('cellClicked', cellClickListenerRef.current as never);
      } catch { /* noop */ }
    }
    const listener = (event: CellClickedEvent<MatcherRowData>) => {
      if (event.node.rowPinned === 'top' && event.data) {
        // Deselect any normal row selection
        try {
          api.deselectAll?.();
        } catch { /* noop */ }
        userManuallySelectedRef.current = false;
        setSelectedProduct(event.data as MatcherRowData);
      }
    };
    cellClickListenerRef.current = listener;
    try {
      api.addEventListener('cellClicked', listener as never);
    } catch { /* noop */ }
  }, []);

  // Attach filter change listener to detect when BrandName filter is Farnell
  const filterListenerRef = useRef<(() => void) | null>(null);

  const attachFilterListener = useCallback((api: MatcherGridApi) => {
    if (filterListenerRef.current) {
      try {
        api.removeEventListener('filterChanged', filterListenerRef.current as never);
      } catch { /* noop */ }
    }
    const listener = () => {
      // Flip userTouchedFilters on genuine user edits only — programmatic
      // setFilterModel calls (entry-auto-apply, prompt override, AI merge)
      // increment suppressNextFilterChangeRef.current first, and we
      // consume one token per fire here.
      const wasProgrammatic = suppressNextFilterChangeRef.current > 0;
      if (wasProgrammatic) {
        suppressNextFilterChangeRef.current -= 1;
      } else {
        setUserTouchedFilters(true);
      }
      try {
        const model = api.getFilterModel?.() ?? {};
        const brandFilter = (model as Record<string, { filter?: string }>).BrandName;
        const brandValue = brandFilter?.filter ?? '';
        setBrandFilterIsFarnell(
          typeof brandValue === 'string' && brandValue.toLowerCase().includes('farnell'),
        );
        // Track current filter values for Farnell search
        const partFilter = (model as Record<string, { filter?: string }>).PartNumber;
        const descFilter = (model as Record<string, { filter?: string }>).Description;
        setFarnellPartNumber(partFilter?.filter ?? null);
        setFarnellDescription(descFilter?.filter ?? null);
      } catch { /* noop */ }
      // Only schedule the debounced /expand for genuine user edits.  For
      // programmatic setFilterModel calls (entry-auto-apply, prompt, AI
      // merge) the hidden tokens are already correct from the prefetched
      // expansion — firing /expand again would just produce the same tokens
      // and trigger a wasteful grid refetch a few seconds later that
      // manifests as the "rows flash, then reload" regression after
      // advancing to an entry with a prefetched first page.
      if (wasProgrammatic) {
        if (semanticExpandTimerRef.current != null) {
          window.clearTimeout(semanticExpandTimerRef.current);
          semanticExpandTimerRef.current = null;
        }
        return;
      }
      if (semanticExpandTimerRef.current != null) {
        window.clearTimeout(semanticExpandTimerRef.current);
      }
      semanticExpandTimerRef.current = window.setTimeout(() => {
        semanticExpandTimerRef.current = null;
        triggerSemanticFromFiltersRef.current?.(api);
      }, 500);
    };
    filterListenerRef.current = listener;
    try {
      api.addEventListener('filterChanged', listener as never);
    } catch { /* noop */ }
  }, []);

  useEffect(() => () => {
    clearPinnedTopRow();
  }, [clearPinnedTopRow]);

  const runExpand = useCallback(async (options?: { prompt?: string; silent?: boolean }) => {
    const targetEntryId = entry.offerDetailId;
    const promptText = options?.prompt?.trim() || null;
    if (!options?.silent) {
      setSuggesting(true);
      setNoSuggestionsFound(false);
    }
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
          prompt: promptText,
        }),
      });
      if (!res.ok) throw new Error('Failed to expand filters');
      if (currentEntryIdRef.current !== targetEntryId) return;
      const data = (await res.json()) as {
        ok: boolean;
        expansions?: FilterExpansions;
        routed?: PromptRouting | null;
      };
      const expansions = data.expansions ?? {};
      const routed = data.routed ?? null;
      const api = productsApiRef.current;
      if (!api) return;
      if (promptText) {
        // Prompt submitted: shared helper wipes the pre-populated requested-row
        // filters and routes prompt fragments to the correct visible-filter
        // columns (brand / part / model / description), folding AI expansion
        // tokens into the hidden sidecar.
        const { visibleModel, hiddenTokens } = buildPromptFilterState(promptText, expansions, routed);
        setOverrideHiddenTokens(hiddenTokens);
        try {
          markProgrammaticFilterChange();
          api.setFilterModel(visibleModel);
        } catch { /* noop */ }
        setPromptSubmitted(true);
        return;
      }
      // Silent auto-expand: merge into whatever filter is already there.
      const totalTokens =
        (expansions.brand?.length ?? 0)
        + (expansions.partNumber?.length ?? 0)
        + (expansions.modelNumber?.length ?? 0)
        + (expansions.description?.length ?? 0);
      if (totalTokens === 0) {
        if (!options?.silent) setNoSuggestionsFound(true);
        return;
      }
      const current = (api.getFilterModel?.() ?? null) as Record<string, FuzzyTextFilter> | null;
      const merged = mergeExpansionsIntoFilterModel(current, expansions);
      try {
        markProgrammaticFilterChange();
        api.setFilterModel(merged);
      } catch { /* noop */ }
    } catch (err) {
      console.error('AI expansion failed', err);
    } finally {
      if (!options?.silent) setSuggesting(false);
    }
  }, [offerId, entry, markProgrammaticFilterChange]);

  // Auto-expand filters with AI whenever the requested entry changes.  To
  // avoid the expensive double-fetch (initial basic query then a second
  // widened-filter query after /expand lands), we fetch /expand *before* the
  // grid is allowed to mount: store the result in liveExpansion, which the
  // requestedFilterModel memo folds into hidden tokens.  The grid then mounts
  // once with the full filter already in place and fires a single getRows.
  //
  // A 2s timeout prevents a slow /expand from freezing the UI — if it hasn't
  // answered by then we unblock the grid and fall back to basic filter; the
  // expansion still lands asynchronously and a manual refresh picks it up.
  // Simplified flow: always mount the grid immediately.  If the parent
  // has a prefetched expansion, use it; otherwise the modal's own
  // /expand fires in the background and populates liveExpansion when
  // it returns.  No gating, no timeouts.  Grid renders keyword results
  // fast; LLM rerank (triggered on first grid response) handles
  // relevance.
  useEffect(() => {
    if (prefetchedExpansion) { setLiveExpansion(null); return; }
    setLiveExpansion(null);
    const targetEntryId = entry.offerDetailId;
    (async () => {
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
        if (currentEntryIdRef.current !== targetEntryId) return;
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; expansions?: FilterExpansions };
        const expansion = data.expansions ?? null;
        if (currentEntryIdRef.current !== targetEntryId) return;
        setLiveExpansion(expansion);
      } catch {
        /* network — fall through to basic filter */
      }
    })();
  }, [
    entry.offerDetailId,
    entry.requestedBrand,
    entry.requestedModelNumber,
    entry.requestedPartNumber,
    entry.requestedDescription,
    entry.requestedDescription2,
    entry.requestedDescription3,
    prefetchedExpansion,
    offerId,
  ]);

  const handlePromptSubmit = useCallback(() => {
    const trimmed = promptText.trim();
    if (!trimmed || suggesting) return;
    void runExpand({ prompt: trimmed });
  }, [promptText, suggesting, runExpand]);

  // Exit AI search mode — clears the prompt-driven override so the grid
  // returns to the requested-row-driven filter state that was active before
  // the prompt submission.
  const handleClearAIPrompt = useCallback(() => {
    setPromptText('');
    setPromptSubmitted(false);
    setOverrideHiddenTokens(null);
    setNoSuggestionsFound(false);
    lastSemanticSigRef.current = '';
    hasAppliedRequestedFiltersRef.current = false;
    setUserTouchedFilters(false);
    const api = productsApiRef.current;
    if (api) {
      // Fall back to the requested-row's filter model (the state the user
      // was in before they typed the prompt).
      try {
        markProgrammaticFilterChange();
        api.setFilterModel(requestedFilterModel ?? null);
      } catch { /* noop */ }
      hasAppliedRequestedFiltersRef.current = true;
    }
  }, [requestedFilterModel, markProgrammaticFilterChange]);

  // Filter-change-driven semantic expansion.  When the user edits column
  // filters directly, debounce and fire /expand with the current values so
  // we fold both AI expansion tokens and fuzzy/synonym expansion into the
  // hidden-tokens sidecar — same recall as the prompt path.  Suppressed
  // while a prompt-driven search is active (the prompt owns filter state).
  const triggerSemanticFromFilters = useCallback((api: MatcherGridApi) => {
    if (promptSubmittedRef.current) return;
    const model = (api.getFilterModel?.() ?? {}) as Record<string, { filter?: string }>;
    const pick = (colId: string): string | null => {
      const v = model[colId]?.filter;
      if (typeof v !== 'string') return null;
      const t = v.trim();
      return t.length >= 2 ? t : null;
    };
    const requestedBrand = pick('BrandName');
    const requestedPartNumber = pick('PartNumber');
    const requestedModelNumber = pick('ModelNumber');
    const requestedDescription = pick('Description');
    const anyValue = requestedBrand || requestedPartNumber || requestedModelNumber || requestedDescription;
    const sig = `${requestedBrand ?? ''}|${requestedPartNumber ?? ''}|${requestedModelNumber ?? ''}|${requestedDescription ?? ''}`;
    if (sig === lastSemanticSigRef.current) return;
    lastSemanticSigRef.current = sig;
    if (!anyValue) {
      setOverrideHiddenTokens(null);
      return;
    }
    // Precise-code mode: when the user has typed into Part or Model, they're
    // searching by a specific identifier and smart expansion does more harm
    // than good — "sec" in Model would /expand to SEC→SECURE/SECURITY and
    // bleed into Description matches via hidden tokens, returning unrelated
    // rows (e.g. "Secure mounting bracket" when the user wanted a SEC-4
    // model).  Skip the /expand entirely and drop any previously-applied
    // override tokens so the grid runs plain visible-filter matching.
    if (requestedPartNumber || requestedModelNumber) {
      setOverrideHiddenTokens(null);
      return;
    }
    semanticExpandAbortRef.current?.abort();
    const controller = new AbortController();
    semanticExpandAbortRef.current = controller;
    (async () => {
      try {
        const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products/expand`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestedBrand,
            requestedPartNumber,
            requestedModelNumber,
            requestedDescription,
          }),
          signal: controller.signal,
        });
        if (!res.ok || controller.signal.aborted) return;
        const data = (await res.json()) as {
          ok?: boolean;
          expansions?: FilterExpansions;
        };
        if (controller.signal.aborted) return;
        const expansions = data.expansions ?? {};
        const { hiddenTokens } = buildRequestedFilterState({
          requestedBrand,
          requestedPartNumber,
          requestedModelNumber,
          requestedDescriptions: requestedDescription ? [requestedDescription] : [],
          prefetchedExpansion: expansions,
        });
        setOverrideHiddenTokens(hiddenTokens);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        console.warn('Semantic filter expansion failed', err);
      }
    })();
  }, [offerId]);

  triggerSemanticFromFiltersRef.current = triggerSemanticFromFilters;

  useEffect(() => () => {
    if (semanticExpandTimerRef.current != null) {
      window.clearTimeout(semanticExpandTimerRef.current);
    }
    semanticExpandAbortRef.current?.abort();
  }, []);

  // Preserved name for the legacy button path in case anywhere still references it.
  const handleSuggestProducts = useCallback(() => {
    void runExpand();
  }, [runExpand]);
  void handleSuggestProducts;

  // Keep ref in sync so the auto-suggest timer can call the latest version
  handleSuggestProductsRef.current = handleSuggestProducts;

  const ensureProductSort = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    const sortModelGetter = api.getSortModel;
    const sortModel = typeof sortModelGetter === 'function' ? sortModelGetter() : [];
    const hasProductIdDesc = sortModel.some(
      (entry: MatcherSortEntry) => entry.colId === 'ProductID' && entry.sort === 'desc',
    );
    if (!hasProductIdDesc) {
      const setter = api.setSortModel;
      if (typeof setter === 'function') {
        setter([{ colId: 'ProductID', sort: 'desc' }]);
      }
    }
  }, []);

  // After creating a new product via the "Add product" dialog, prompt the
  // user whether to assign it straight away to the current requested item.
  // "Yes" advances the queue via the normal assign flow; "No" just drops
  // the id and leaves the matcher on the current requested row so the user
  // can keep searching.  Neither branch refetches the grid — the new
  // product will appear naturally on the next normal load.
  useEffect(() => {
    if (newProductId == null) return;
    const targetId = newProductId;
    let cancelled = false;
    (async () => {
      const proceed = await showConfirmDialog({
        title: 'Assign newly added product?',
        message: 'Assign the newly added product to this requested item?',
        confirmLabel: 'Assign',
        cancelLabel: 'Keep searching',
      });
      if (cancelled) return;
      if (proceed) {
        void handleAssignWithId(targetId);
      }
      onClearNewProductId?.();
    })();
    return () => { cancelled = true; };
  }, [newProductId, handleAssignWithId, onClearNewProductId]);

  const handleGridReady = useCallback((api: MatcherGridApi) => {
    productsApiRef.current = api;
    ensureProductSort();
    trySelectPendingProduct(api);
    applyRequestedFilterModel(api);
    autoSelectTopProduct(api);
    attachCellClickListener(api);
    attachFilterListener(api);
    // The grid restores persisted filter state asynchronously via requestAnimationFrame,
    // which can overwrite the programmatic filters we just set for the current product.
    // Re-apply only if the persisted restoration actually changed the filter model,
    // avoiding a redundant second server-side data reload.
    requestAnimationFrame(() => {
      if ((api as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) return;
      try {
        const current = JSON.stringify(api.getFilterModel?.() ?? {});
        const target = JSON.stringify(requestedFilterModel ?? {});
        if (current === target) return;
      } catch { /* noop */ }
      hasAppliedRequestedFiltersRef.current = false;
      applyRequestedFilterModel(api);
    });
  }, [applyRequestedFilterModel, autoSelectTopProduct, ensureProductSort, trySelectPendingProduct, attachCellClickListener, attachFilterListener, requestedFilterModel]);

  const handleGridModelUpdated = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    ensureProductSort();
    trySelectPendingProduct(api);
    applyRequestedFilterModel(api);
    autoSelectTopProduct(api);
  }, [applyRequestedFilterModel, autoSelectTopProduct, ensureProductSort, trySelectPendingProduct]);

  // Fires once per entry when the grid's first server response lands.  Parent
  // uses this to delay the queue-wide prefetch until the current entry has
  // actually returned results — otherwise entries 2+ race entry 1 for OpenAI
  // and SQL quota and the user waits longer for the one they're looking at.
  //
  // LLM rerank is now performed inline on the server for the first page
  // (see products/add route), so the rows arriving here are already in
  // LLM-determined order — no client-side /rerank fetch or grid refetch
  // needed.
  const firstLoadFiredRef = useRef(false);
  useEffect(() => { firstLoadFiredRef.current = false; }, [entry.offerDetailId]);
  const handleFirstGridResponse = useCallback(() => {
    if (firstLoadFiredRef.current) return;
    firstLoadFiredRef.current = true;
    onCurrentEntryReady?.();
  }, [onCurrentEntryReady]);

  // Entry-change reset — fires ONLY when the entry actually changes.  Do
  // NOT add requestedFilterModel / effectiveExpansion / prefetched* to this
  // dep list: those memos recompute as late-arriving /expand results land,
  // which would re-fire the whole reset and wipe state the eager /expand
  // just populated (logs showed semanticCandidates: 50 → 0 flip-flop
  // because the reset ran a second time after setLiveExpansion bumped the
  // filter-model memo).  Entry-scoped state resets belong to entry changes
  // only.
  useEffect(() => {
    hasAppliedRequestedFiltersRef.current = false;
    setUserTouchedFilters(false);
    // Prevent stale grid selection from a previous requested item.
    try {
      productsApiRef.current?.deselectAll?.();
    } catch {
      /* noop */
    }
    // Reset sort for every new entry so the server-side relevance ranking
    // (score DESC, ProductID DESC tiebreak) drives ordering.
    try {
      const api = productsApiRef.current;
      const setter = api?.setSortModel;
      if (typeof setter === 'function') setter([{ colId: 'ProductID', sort: 'desc' }]);
    } catch {
      /* noop */
    }
    hasAppliedRequestedFiltersRef.current = true;
    setAssigning(false);
    setComment('');
    setPromptText('');
    setOverrideHiddenTokens(null);
    setPromptSubmitted(false);
    lastSemanticSigRef.current = '';
    userManuallySelectedRef.current = false;
    setSuggestionsVisible(true);
    // Reset Farnell state for the new entry
    clearFarnellResults();
    setBrandFilterIsFarnell(isFarnellBrand(entry.requestedBrand));
    setFarnellVisible(true);
    setFarnellPartNumber(entry.requestedPartNumber ?? null);
    setFarnellDescription(entry.requestedDescription ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.offerDetailId]);

  // Apply the current filter model to the grid API whenever the model
  // changes (entry change, late /expand result landing, prompt submission).
  // Split from the reset effect so re-running this on requestedFilterModel
  // changes doesn't also wipe semantic / comment / assign state.
  useEffect(() => {
    try {
      markProgrammaticFilterChange();
      productsApiRef.current?.setFilterModel(requestedFilterModel ?? null);
    } catch {
      /* noop */
    }
  }, [requestedFilterModel, markProgrammaticFilterChange]);

  // Reset transient match state when the entry changes.  The AI-expand flow
  // writes directly into the grid's filter model, so there's no prefetched
  // suggestions payload to apply here.
  useLayoutEffect(() => {
    setSelectedProduct(null);
    suggestedProductsRef.current = [];
    setSuggestedProducts([]);
    setNoSuggestionsFound(false);
    setSuggesting(false);
    void prefetchedSuggestions;
  }, [prefetchedSuggestions, entry.offerDetailId]);

  useEffect(() => {
    applyRequestedFilterModel(productsApiRef.current);
  }, [applyRequestedFilterModel]);

  // Auto-selection is primarily handled by handleGridModelUpdated when fresh data
  // arrives.  This retry loop covers the first-mount race where modelUpdated
  // fires before the API ref is set or data is loaded.
  useEffect(() => {
    let cancelled = false;
    let remaining = 6;
    const trySelect = () => {
      if (cancelled || remaining-- <= 0) return;
      const api = productsApiRef.current;
      if (!api) { setTimeout(trySelect, 400); return; }
      if (userManuallySelectedRef.current) return;
      if (suggestedProductsRef.current.length > 0) return;
      const nodes = api.getSelectedNodes?.() ?? [];
      if (nodes.length > 0) return;
      autoSelectTopProduct(api);
      // If it didn't find data yet, retry
      const nodesAfter = api.getSelectedNodes?.() ?? [];
      if (nodesAfter.length === 0) setTimeout(trySelect, 400);
    };
    setTimeout(trySelect, 300);
    return () => { cancelled = true; };
  }, [autoSelectTopProduct, entry.offerDetailId]);

  const handleContextMenuItems = useCallback(
    (params: GetContextMenuItemsParams<MatcherRowData>) => {
      const items: Array<MenuItemDef<MatcherRowData> | string> = [];
      if (params.node?.data) {
        items.push({
          name: 'Copy row',
          icon: '<span class="ag-icon ag-icon-copy" aria-hidden="true"></span>',
          action: () => {
            const data = params.node?.data as Record<string, unknown> | undefined;
            if (!data) return;
            const cols = params.api.getAllDisplayedColumns?.() ?? [];
            const values = cols.map((col) => {
              const def = col.getColDef();
              const field = def.field ?? col.getColId();
              const raw = data[field];
              const fmt = def.valueFormatter;
              if (typeof fmt === 'function') {
                try {
                  const out = (fmt as (p: { value: unknown }) => unknown)({ value: raw });
                  if (out != null) return String(out);
                } catch { /* fall through to raw */ }
              }
              return raw == null ? '' : String(raw);
            });
            const text = values.join(' | ');
            navigator.clipboard?.writeText?.(text).catch(() => { /* noop */ });
          },
        });
        items.push('separator');
      }
      const defaults = Array.isArray(params.defaultItems) ? params.defaultItems : [];
      items.push(...defaults);
      return items;
    },
    [],
  );

  const remaining = Math.max(0, total - position);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Match requested product">
      <div ref={setCardRef} className={styles.card} style={dragCardStyle}>
        <PageHeaderContext.Provider value={searchSlot}>
          <div className={styles.header} onPointerDown={dragHeaderProps.onPointerDown} onDoubleClick={dragHeaderProps.onDoubleClick} style={dragHeaderProps.style}>
            <div>
              <div className={styles.title}>Match requested product</div>
              <div className={styles.subtitle}>{entry.label}</div>
              <div className={styles.counter}>
                Resolving {position} of {total}
                {remaining > 0 ? ` • ${remaining} remaining` : ''}
              </div>
            </div>
            <div className={styles.headerActions}>
              <AiSearchPromptPill
                promptText={promptText}
                onPromptTextChange={setPromptText}
                onSubmit={handlePromptSubmit}
                onClear={handleClearAIPrompt}
                submitted={promptSubmitted}
                busy={suggesting}
                disabled={assigning}
              />
              {noSuggestionsFound && !suggesting && (
                <span className={styles.noSuggestionsLabel}>No extra terms to add</span>
              )}
              {suggestedProducts.length > 0 && suggestionsVisible && (
                <button
                  type="button"
                  className={styles.aiButton}
                  onClick={handleHideSuggestions}
                  disabled={suggesting || assigning}
                >
                  Hide suggestions (AI)
                </button>
              )}
              {suggestedProducts.length > 0 && !suggestionsVisible && (
                <button
                  type="button"
                  className={styles.aiButton}
                  onClick={handleShowSuggestions}
                  disabled={suggesting || assigning}
                >
                  Show suggestions (AI)
                </button>
              )}
              {brandFilterIsFarnell && (
                <button
                  type="button"
                  className={styles.farnellButton}
                  onClick={() => { clearFarnellResults(); void searchFarnell(); }}
                  disabled={farnellLoading || assigning}
                >
                  {farnellLoading ? (
                    <>
                      <span className={styles.farnellButtonSpinner} />
                      Searching Farnell…
                    </>
                  ) : (
                    'Look up Farnell'
                  )}
                </button>
              )}
              {brandFilterIsFarnell && noFarnellResults && farnellResults.length === 0 && !farnellLoading && (
                <span className={styles.noFarnellLabel}>No Farnell results</span>
              )}
              {farnellResults.length > 0 && farnellVisible && (
                <button
                  type="button"
                  className={styles.farnellButton}
                  onClick={() => setFarnellVisible(false)}
                  disabled={assigning}
                >
                  Hide Farnell ({farnellResults.length})
                </button>
              )}
              {farnellResults.length > 0 && !farnellVisible && (
                <button
                  type="button"
                  className={styles.farnellButton}
                  onClick={() => setFarnellVisible(true)}
                  disabled={assigning}
                >
                  Show Farnell ({farnellResults.length})
                </button>
              )}
              <button type="button" className={styles.secondaryButton} onClick={onRequestAddProduct}>
                Add product
              </button>
            </div>
          </div>
          <div className={styles.searchSlot} ref={handleSlotRef} />
          <GridQuickSearchProvider>
            <div className={styles.hint}>Use the filters or quick search to find a matching product.</div>
            <div className={styles.details}>
              {entry.details.length > 0 ? entry.details.map((detail: DetailEntry) => (
                <div key={detail.label} className={styles.detailItem}>
                  <span className={styles.detailLabel}>{detail.label}</span>
                  <span className={styles.detailValue}>{detail.value}</span>
                </div>
              )) : (
                <div className={styles.detailEmpty}>No requested metadata available.</div>
              )}
              {entry.quantity != null ? (
                <div className={styles.detailItem}>
                  <span className={styles.detailLabel}>Requested quantity</span>
                  <span className={styles.detailValue}>{entry.quantity}</span>
                </div>
              ) : null}
            </div>
            <div
              className={`${styles.gridShell} offer-products-grid ${promptSubmitted ? AI_GRID_LOCK_CLASS : ''}`}
              ref={gridShellRef}
            >
              {/* Grid mounts immediately on every entry — no "Preparing
                  smart search…" gate.  The grid endpoint itself does a
                  server-side semantic fallback (with a 1.5s timeout so it
                  can't hang) and the late-arrival refetch effect re-fires
                  getRows when semantic candidates land after the initial
                  fetch, so we get the right rows without paying a gate
                  delay on every single entry. */}
              <AgGridAll
                endpoint={endpoint}
                columnDefs={productColumns}
                defaultColDef={productDefaultColDef}
                columnWidthDefaults={emptyColumnWidthDefaults}
                requestPayload={requestPayload}
                onResponse={handleFirstGridResponse}
                serverSideEnableClientSideSort={false}
                // Larger block + generous in-memory cache so scrolling
                // through smart-filtered results doesn't refire the
                // expensive fuzzy/hidden-token query on every 25 rows.
                // 200 rows/block keeps the server cost amortized and
                // matches the prefetched first page's size.
                cacheBlockSize={200}
                maxBlocksInCache={20}
                prefetchedFirstPage={prefetchedFirstPage ?? null}
                onRequestPayloadConsumed={onRequestPayloadConsumed}
                rowSelection="single"
                rowMultiSelectWithClick
                rowDeselection
                onSelectionChanged={handleSelectionChanged}
                onRowDoubleClicked={handleRowDoubleClick}
                onGridReady={handleGridReady}
                onModelUpdated={handleGridModelUpdated}
                allowRowClickSelection
                columnStateNamespace="match-requested-products-v3"
                applyColumnStateOrder={true}
                maintainColumnOrder={true}
                disableAutoSize={true}
                suppressCellSelection
                getContextMenuItems={handleContextMenuItems}
                suppressNoRowsOverlay={
                  (suggestedProducts.length > 0 && suggestionsVisible) ||
                  (farnellResults.length > 0 && farnellVisible)
                }
                getRowStyle={getRowStyle}
              />
            </div>
            <div className={styles.actions}>
              <label className={styles.commentLabel}>Comment:</label>
              <textarea
                className={styles.commentInput}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (e.altKey) {
                      e.preventDefault();
                      const target = e.currentTarget;
                      const start = target.selectionStart;
                      const end = target.selectionEnd;
                      const next = comment.substring(0, start) + '\n' + comment.substring(end);
                      setComment(next);
                      requestAnimationFrame(() => {
                        target.selectionStart = target.selectionEnd = start + 1;
                      });
                    } else {
                      e.preventDefault();
                      void handleAssign();
                    }
                  }
                }}
                disabled={assigning || farnellResolving || (selectedProductId == null && !selectedProductIsFarnell)}
                placeholder=""
                rows={1}
                data-fastquote-keep-selection="true"
              />
              <button
                type="button"
                className={styles.primaryButton}
                data-fastquote-keep-selection="true"
                onClick={handleAssign}
                disabled={assigning || farnellResolving || (selectedProductId == null && !selectedProductIsFarnell)}
              >
                {assigning || farnellResolving ? 'Matching…' : 'Assign product'}
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onSkip}
                disabled={assigning}
              >
                Skip
              </button>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onSkipAll}
                disabled={assigning}
              >
                Skip all
              </button>
            </div>
          </GridQuickSearchProvider>
        </PageHeaderContext.Provider>
        {resizeHandles}
      </div>
    </div>
  );
}
