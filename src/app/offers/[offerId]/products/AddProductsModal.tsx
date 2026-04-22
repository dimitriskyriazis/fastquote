'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import type { CellValueChangedEvent, ColDef, GridApi, RowNode } from 'ag-grid-community';
import styles from './AddProductsModal.module.css';
import { showToastMessage } from '../../../../lib/toast';
import { priceListStatusClassRules } from '../../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../../lib/localeNumber';
import { useFarnellSearch, isFarnellRow, type FarnellSearchRow } from '../../../hooks/useFarnellSearch';
import { useFarnellProductResolver } from '../../../hooks/useFarnellProductResolver';
import {
  isFarnellBrand,
  buildRequestedFilterState,
  buildBasicRequestedFilterState,
  buildPromptFilterState,
  buildNegativeHiddenTokens,
  mergeExpansionsIntoHiddenTokens,
  type HiddenFilterTokens,
  type FilterExpansions,
  type PromptRouting,
} from '../offerProductsUtils';
import { useSmartFiltering } from '../../../hooks/useSmartFiltering';
import {
  AiSearchPromptPill,
  AI_GRID_LOCK_CLASS,
} from './AiSearch';

const AgGridAll = dynamic(() => import('../../../components/AgGridAll'), { ssr: false });

type PlacementAnchor = {
  label: string;
  treeOrdering: string;
  isRequested: boolean;
  offerDetailId?: number;
  parentPath?: number[];
  requestedBrand?: string | null;
  requestedPartNo?: string | null;
  requestedModelNo?: string | null;
  requestedDescription?: string | null;
};

type Props = {
  offerId: string;
  onClose: () => void;
  onAdded: (inserted: number, insertedOfferDetailIds?: number[]) => void;
  getInsertionAnchor?: () => { offerDetailId: number; parentPath: number[] } | null;
  standardPackageMode?: boolean;
  showRequestedColumns?: boolean;
  splitViewMode?: boolean;
  onRequestAddProduct?: () => void;
  newProductId?: number | null;
  onClearNewProductId?: () => void;
  onRequestPayloadConsumed?: () => void;
  refreshToken?: number;
  initialRequestedRowId?: number | null;
  onInitialRequestedRowConsumed?: () => void;
  placementAnchor?: PlacementAnchor | null;
  defaultPlacementMode?: 'fill' | 'below';
  onPlacementModeChange?: (mode: 'fill' | 'below') => void;
  getLastClickedRowId?: () => number | null;
  onRequestDetach?: () => void;
};

type CategoryRow = {
  OfferDetailID?: number | null;
  TreeOrdering?: string | null;
  Description?: string | null;
};

type ProductRow = {
  ProductID?: number | null;
  PartNumber?: string | null;
  Description?: string | null;
  BrandName?: string | null;
  ModelNumber?: string | null;
  PriceListName?: string | null;
  ListPrice?: number | string | null;
  CostPrice?: number | string | null;
  PriceListID?: number | null;
  PriceListItemID?: number | null;
  PriceListValidFromDate?: string | Date | null;
  PriceListValidToDate?: string | Date | null;
  PriceListEnabled?: boolean | number | null;
};

type RequestedRow = {
  OfferDetailID: number;
  TreeOrdering: string | null;
  RequestedItemNo: string | null;
  RequestedBrand: string | null;
  RequestedModelNo: string | null;
  RequestedPartNo: string | null;
  RequestedDescription: string | null;
  RequestedDescription2: string | null;
  RequestedQuantity: number | null;
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

const computeNextItemNo = (treeOrdering: string): string => {
  const parts = treeOrdering.split('.');
  const last = Number.parseInt(parts[parts.length - 1] ?? '0', 10);
  const next = Number.isFinite(last) ? last + 1 : 1;
  return [...parts.slice(0, -1), String(next)].join('.');
};

const emptyColumnWidthDefaults = {};
const productAutoSizeExclusions = ['Description'];

type ProductsGridPanelProps = {
  endpoint: string;
  productColumns: ColDef[];
  defaultColDef: ColDef;
  productRequestPayload: Record<string, unknown>;
  handleProductSelection: (rows: Record<string, unknown>[], api: GridApi) => void;
  handleProductCellEdit: (event: CellValueChangedEvent<Record<string, unknown>>) => void;
  handleProductsGridReady: (api: GridApi) => void;
  handleProductsGridModelUpdated: (api: GridApi) => void;
  onRequestPayloadConsumed?: () => void;
  aiLocked?: boolean;
};

const ProductsGridPanel = React.memo(function ProductsGridPanel({
  endpoint,
  productColumns,
  defaultColDef,
  productRequestPayload,
  handleProductSelection,
  handleProductCellEdit,
  handleProductsGridReady,
  handleProductsGridModelUpdated,
  onRequestPayloadConsumed,
  aiLocked,
}: ProductsGridPanelProps) {
  return (
    <div className={`${styles.sectionInner} ${styles.productsColumn}`}>
      <div
        className={`${styles.productsGridShell} offer-products-grid ${aiLocked ? AI_GRID_LOCK_CLASS : ''}`}
        data-fastquote-keep-selection="true"
      >
        <AgGridAll
          endpoint={endpoint}
          columnDefs={productColumns}
          defaultColDef={defaultColDef}
          columnWidthDefaults={emptyColumnWidthDefaults}
          requestPayload={productRequestPayload}
          cacheBlockSize={200}
          rowBuffer={8}
          maxBlocksInCache={4}
          rowSelection="single"
          rowDeselection
          allowRowClickSelection
          rowGroupPanelShow="never"
          onSelectionChanged={handleProductSelection}
          autoSizeExclusions={productAutoSizeExclusions}
          onCellValueChanged={handleProductCellEdit}
          onGridReady={handleProductsGridReady}
          onModelUpdated={handleProductsGridModelUpdated}
          onRequestPayloadConsumed={onRequestPayloadConsumed}
          columnStateNamespace="add-products-modal-v2"
          applyColumnStateOrder={true}
          maintainColumnOrder={true}
          disableAutoSize={true}
          allowCellSelectionInPerformanceMode={false}
        />
      </div>
    </div>
  );
});

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const normalizeEditableValue = (value: unknown): string | null => {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
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

type ProductsGridApi = GridApi & {
  getSortModel?: () => Array<{ colId: string; sort: 'asc' | 'desc' }>;
  setSortModel?: (model: Array<{ colId: string; sort: 'asc' | 'desc' }>) => void;
  purgeServerSideCache?: () => void;
  refreshServerSide?: (params?: { purge?: boolean }) => void;
  setPinnedTopRowData?: (data: Record<string, unknown>[]) => void;
};

type ProductsRowNode = RowNode & {
  ensureVisible?: (params?: { position?: 'top' | 'middle' | 'bottom' }) => void;
};

export default function AddProductsModal({
  offerId,
  onClose,
  onAdded,
  getInsertionAnchor,
  standardPackageMode = false,
  splitViewMode = false,
  onRequestAddProduct,
  newProductId,
  onClearNewProductId,
  onRequestPayloadConsumed,
  refreshToken,
  initialRequestedRowId,
  onInitialRequestedRowConsumed,
  placementAnchor,
  defaultPlacementMode,
  onPlacementModeChange,
  getLastClickedRowId: _getLastClickedRowId,
  onRequestDetach,
}: Props) {
  void _getLastClickedRowId;
  const [detachMenu, setDetachMenu] = useState<{ x: number; y: number } | null>(null);
  const [selectedCategory] = useState<CategoryRow | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([]);
  // Tracks a locally-pinned new product row (created via "Add product").
  // The pinned-rows sync effect merges this with Farnell results so the new
  // product sits on top and isn't wiped when Farnell results clear.
  const [pinnedNewProductRow, setPinnedNewProductRow] = useState<Record<string, unknown> | null>(null);
  const [smartFilteringEnabled, setSmartFilteringEnabled] = useSmartFiltering();
  const smartFilteringEnabledRef = useRef(smartFilteringEnabled);
  smartFilteringEnabledRef.current = smartFilteringEnabled;
  const [submitting, setSubmitting] = useState(false);
  const [comment, setComment] = useState('');
  const [requestedRows, setRequestedRows] = useState<RequestedRow[]>([]);
  const [requestedRowsLoading, setRequestedRowsLoading] = useState(false);
  const [, setRequestedRowsError] = useState<string | null>(null);
  const [selectedRequestedRowId, setSelectedRequestedRowId] = useState<number | null>(null);
  const [placementMode, setPlacementMode] = useState<'fill' | 'below'>('fill');
  const [belowItemNo, setBelowItemNo] = useState('');
  const categoryApiRef = useRef<GridApi | null>(null);
  const productsApiRef = useRef<ProductsGridApi | null>(null);
  const requestedRowsFetchIdRef = useRef(0);
  const requestedRowsCacheRef = useRef<Record<string, RequestedRow[]>>({});
  const pendingSelectionProductIdRef = useRef<number | null>(null);
  const pendingFilterClearRef = useRef(false);
  const categoryRowClickHandlerRef = useRef<((event: { node?: RowNode }) => void) | null>(null);
  const initialRequestedRowConsumedRef = useRef(false);

  // AI expansion / hidden-token state
  const [promptText, setPromptText] = useState('');
  const [suggesting, setSuggesting] = useState(false);
  const [noSuggestionsFound, setNoSuggestionsFound] = useState(false);
  const [hiddenFilterTokens, setHiddenFilterTokens] = useState<HiddenFilterTokens | null>(null);
  // LLM-derived anti-intent tokens that deprioritize accessories / spare parts
  // / carrying cases.  Stored as the negativeDescription array straight from
  // /expand and folded into the request payload via buildNegativeHiddenTokens.
  const [negativeDescriptionTerms, setNegativeDescriptionTerms] = useState<string[] | null>(null);
  // ProductIDs surfaced by the server-side semantic (vector) search for the
  // current prompt.  Feeds into requestPayload as a ranking bonus only.
  const [semanticCandidates, setSemanticCandidates] = useState<number[] | null>(null);
  // True while a user-submitted AI search prompt is driving the grid.  While
  // this is on: the prompt input is read-only (until cleared), the column
  // filter row is visually locked, and the filter-change-driven semantic
  // expansion is suppressed (the prompt owns the filter state).
  const [promptSubmitted, setPromptSubmitted] = useState(false);
  const promptSubmittedRef = useRef(false);
  promptSubmittedRef.current = promptSubmitted;
  // Refs for filter-change-driven semantic expansion.  Declared here (above
  // the handlers that consume them) so the clear handler can reset them.
  const semanticExpandTimerRef = useRef<number | null>(null);
  const semanticExpandAbortRef = useRef<AbortController | null>(null);
  const lastSemanticSigRef = useRef<string>('');

  // Comment modal state — keeps the header clean.  Draft is a scratch buffer
  // so cancelling doesn't wipe a saved comment.
  const [commentModalOpen, setCommentModalOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const openCommentModal = useCallback(() => {
    setCommentDraft(comment);
    setCommentModalOpen(true);
  }, [comment]);
  const saveCommentModal = useCallback(() => {
    setComment(commentDraft);
    setCommentModalOpen(false);
  }, [commentDraft]);
  const cancelCommentModal = useCallback(() => {
    setCommentModalOpen(false);
  }, []);
  const currentAnchorIdRef = useRef<number | null | undefined>(placementAnchor?.offerDetailId ?? null);
  currentAnchorIdRef.current = placementAnchor?.offerDetailId ?? null;

  // Farnell search state
  const [brandFilterIsFarnell, setBrandFilterIsFarnell] = useState(() => isFarnellBrand(placementAnchor?.requestedBrand ?? null));
  const [farnellVisible, setFarnellVisible] = useState(true);
  const [farnellPartNumber, setFarnellPartNumber] = useState<string | null>(placementAnchor?.requestedPartNo ?? null);
  const [farnellDescription, setFarnellDescription] = useState<string | null>(placementAnchor?.requestedDescription ?? null);

  const { farnellResults, farnellLoading, noFarnellResults, searchFarnell, clearFarnellResults } = useFarnellSearch({
    partNumber: farnellPartNumber,
    description: farnellDescription,
  });
  const { resolveFarnellProduct, resolving: farnellResolving } = useFarnellProductResolver();

  const productRequestPayload = useMemo(() => {
    // BrandName stays in the cross-column OR group.  Strict brand AND-gating
    // drops valid rebrands (manufacturer products resold under distributor
    // brands) — the brand term is mirrored as a hidden Description token in
    // buildRequestedFilterState so rebranded rows still match via
    // Description, while correct-brand rows rank higher via scoring.
    const payload: Record<string, unknown> = {
      action: 'products',
      orFilterColumns: ['BrandName', 'PartNumber', 'ModelNumber', 'Description'],
    };
    if (hiddenFilterTokens) payload.hiddenFilterTokens = hiddenFilterTokens;
    if (semanticCandidates && semanticCandidates.length > 0) payload.semanticCandidates = semanticCandidates;
    const negative = buildNegativeHiddenTokens(
      negativeDescriptionTerms ? { negativeDescription: negativeDescriptionTerms } : null,
    );
    if (negative) payload.negativeHiddenTokens = negative;
    // newProductId is intentionally NOT forwarded to the server.  The old
    // flow also asked the server to order the new product first, which
    // rendered the new product twice (the server row plus the client-side
    // pinned row).  The new product is now shown only as a pinned top row.
    return payload;
  }, [hiddenFilterTokens, semanticCandidates, negativeDescriptionTerms]);

  const handleProductSelection = useCallback((rows: ProductRow[]) => {
    setSelectedProducts(rows ?? []);
  }, []);

  // AI-driven filter expansion.  `prompt` path: user typed a free-text query —
  // wipes existing visible filter, shows only the prompt, folds prompt tokens
  // + AI synonyms into the hidden-tokens payload.  Silent mode (no prompt)
  // merges AI tokens into the currently-applied hidden payload without
  // touching the visible filter.
  const runExpand = useCallback(async (options?: { prompt?: string; silent?: boolean }) => {
    const targetAnchorId = currentAnchorIdRef.current;
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
          requestedBrand: placementAnchor?.requestedBrand ?? null,
          requestedModelNumber: placementAnchor?.requestedModelNo ?? null,
          requestedPartNumber: placementAnchor?.requestedPartNo ?? null,
          requestedDescription: placementAnchor?.requestedDescription ?? null,
          prompt: promptText,
        }),
      });
      if (!res.ok) throw new Error('Failed to expand filters');
      if (currentAnchorIdRef.current !== targetAnchorId) return;
      const data = (await res.json()) as {
        ok: boolean;
        expansions?: FilterExpansions;
        routed?: PromptRouting | null;
        semanticCandidates?: number[];
      };
      const expansions = data.expansions ?? {};
      const routed = data.routed ?? null;
      const semantic = Array.isArray(data.semanticCandidates) ? data.semanticCandidates : [];
      setSemanticCandidates(semantic.length > 0 ? semantic : null);
      const negatives = Array.isArray(expansions.negativeDescription) ? expansions.negativeDescription : [];
      setNegativeDescriptionTerms(negatives.length > 0 ? negatives : null);
      const api = productsApiRef.current;
      if (!api) return;

      if (promptText) {
        // Prompt submitted — shared helper routes the prompt fragments to the
        // correct visible-filter columns (brand → BrandName chip, part code →
        // PartNumber chip, residual → Description chip) and folds the AI
        // expansion tokens into the hidden sidecar.  Falls back to a single
        // Description chip if the AI didn't classify.
        const { visibleModel, hiddenTokens } = buildPromptFilterState(promptText, expansions, routed);
        setHiddenFilterTokens(hiddenTokens);
        try { api.setFilterModel(visibleModel); } catch { /* noop */ }
        // Lock the grid + prompt UI until the user clicks the clear (✕)
        // button — tells them at a glance that AI search is driving results.
        setPromptSubmitted(true);
        return;
      }

      // Silent auto-expand — merge AI tokens into the existing hidden payload.
      const totalTokens =
        (expansions.brand?.length ?? 0)
        + (expansions.partNumber?.length ?? 0)
        + (expansions.modelNumber?.length ?? 0)
        + (expansions.description?.length ?? 0);
      if (totalTokens === 0) {
        if (!options?.silent) setNoSuggestionsFound(true);
        return;
      }
      setHiddenFilterTokens((prev) => mergeExpansionsIntoHiddenTokens(prev, expansions));
    } catch (err) {
      console.error('AI expansion failed', err);
    } finally {
      if (!options?.silent) setSuggesting(false);
    }
  }, [offerId, placementAnchor]);

  const handlePromptSubmit = useCallback(() => {
    const trimmed = promptText.trim();
    if (!trimmed || suggesting) return;
    void runExpand({ prompt: trimmed });
  }, [promptText, suggesting, runExpand]);

  // Exit AI search mode — wipes the prompt, clears the expansion hidden
  // tokens and semantic candidates, and resets the grid's filter model so
  // the user is back to plain keyword browsing.
  const handleClearAIPrompt = useCallback(() => {
    setPromptText('');
    setPromptSubmitted(false);
    setHiddenFilterTokens(null);
    setSemanticCandidates(null);
    setNoSuggestionsFound(false);
    lastSemanticSigRef.current = '';
    const api = productsApiRef.current;
    if (api) {
      try { api.setFilterModel(null); } catch { /* noop */ }
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        if (detachMenu) {
          setDetachMenu(null);
          return;
        }
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, detachMenu]);

  // Right-click on the modal's empty space shows a small context menu with a
  // "Detach to new window" action.  We deliberately skip interactive elements
  // (buttons, inputs, links) and the ag-grid area so the native browser menu
  // or ag-grid's own menu still work where they're expected.
  const handleModalContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!onRequestDetach) return;
    const target = event.target as HTMLElement | null;
    // Only skip cases where the native menu is genuinely useful: text inputs
    // (copy/paste) and anything opted out via data-detach-menu-skip.  Everything
    // else — buttons, labels, header background, body background, and the
    // products-grid background — counts as "empty space" for the detach menu.
    if (
      target && target.closest(
        'input, textarea, select, [contenteditable="true"], [data-detach-menu-skip="true"]',
      )
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Clamp to viewport so the popup doesn't render as a thin sliver when the
    // click lands near the right/bottom edge.
    const menuW = 220;
    const menuH = 48;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const x = Math.min(event.clientX, Math.max(0, vw - menuW - 4));
    const y = Math.min(event.clientY, Math.max(0, vh - menuH - 4));
    setDetachMenu({ x, y });
  }, [onRequestDetach]);

  useEffect(() => {
    if (!detachMenu) return;
    const onDown = () => setDetachMenu(null);
    const onScroll = () => setDetachMenu(null);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [detachMenu]);

  const handleDetachClick = useCallback(() => {
    setDetachMenu(null);
    onRequestDetach?.();
  }, [onRequestDetach]);

  const detachMenuNode = detachMenu && typeof document !== 'undefined'
    ? createPortal(
        (
          <div
            className={styles.detachMenu}
            style={{ top: detachMenu.y, left: detachMenu.x }}
            role="menu"
            onMouseDown={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.preventDefault()}
            data-detach-menu-skip="true"
          >
            <button
              type="button"
              className={styles.detachMenuItem}
              onClick={handleDetachClick}
              role="menuitem"
            >
              Detach to new window
            </button>
          </div>
        ),
        document.body,
      )
    : null;

  // Reset placement mode and Farnell state when anchor changes
  useEffect(() => {
    const mode = defaultPlacementMode ?? 'fill';
    setPlacementMode(mode);
    setBelowItemNo(placementAnchor?.treeOrdering ? computeNextItemNo(placementAnchor.treeOrdering) : '');
    onPlacementModeChange?.(mode);
    // Reset Farnell state for new anchor
    clearFarnellResults();
    setBrandFilterIsFarnell(isFarnellBrand(placementAnchor?.requestedBrand ?? null));
    setFarnellVisible(true);
    setFarnellPartNumber(placementAnchor?.requestedPartNo ?? null);
    setFarnellDescription(placementAnchor?.requestedDescription ?? null);
    setPromptText('');
    setNoSuggestionsFound(false);
    setSemanticCandidates(null);
    setPromptSubmitted(false);
    lastSemanticSigRef.current = '';
  }, [placementAnchor, defaultPlacementMode, onPlacementModeChange, clearFarnellResults]);

  // Apply requested data as filters on the products grid when selecting a row to fill.
  // Produces a two-layer filter: the visible filter model (single raw value per
  // column — clean AG Grid popup) plus a hidden-tokens sidecar (all expansion
  // tokens + synonyms + cross-fold codes) that rides along in requestPayload.
  // Semantics match the Match-Requested modal one-for-one (shared helper).
  useEffect(() => {
    const api = productsApiRef.current;
    if (!api) return;
    if (defaultPlacementMode !== 'fill' || !placementAnchor) {
      // Deselected / below-mode: keep existing filters untouched.
      return;
    }
    if (!smartFilteringEnabled) {
      const { visibleModel } = buildBasicRequestedFilterState({
        requestedPartNumber: placementAnchor.requestedPartNo,
        requestedModelNumber: placementAnchor.requestedModelNo,
      });
      api.setFilterModel(visibleModel);
      setHiddenFilterTokens(null);
      return;
    }
    const { visibleModel, hiddenTokens } = buildRequestedFilterState({
      requestedBrand: placementAnchor.requestedBrand,
      requestedPartNumber: placementAnchor.requestedPartNo,
      requestedModelNumber: placementAnchor.requestedModelNo,
      requestedDescriptions: [placementAnchor.requestedDescription],
    });
    api.setFilterModel(visibleModel);
    setHiddenFilterTokens(hiddenTokens);
  }, [placementAnchor, defaultPlacementMode, smartFilteringEnabled]);

  // Sync selectedRequestedRowId with placement mode for anchor-based requested rows
  useEffect(() => {
    if (!placementAnchor?.isRequested) return;
    if (placementMode === 'fill' && initialRequestedRowId != null) {
      setSelectedRequestedRowId(initialRequestedRowId);
    } else if (placementMode === 'below') {
      setSelectedRequestedRowId((prev) => {
        // Only clear if the current selection is the anchor's requested row
        if (prev === initialRequestedRowId) return null;
        return prev;
      });
    }
  }, [placementMode, placementAnchor?.isRequested, initialRequestedRowId]);

  const endpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products/add`,
    [offerId],
  );

  const fetchRequestedRows = useCallback(
    async (categoryId: number | null, options?: { force?: boolean }) => {
      const forceRefresh = Boolean(options?.force);
      const cacheKey = categoryId == null ? '__all__' : String(categoryId);
      if (!forceRefresh) {
        const cached = requestedRowsCacheRef.current[cacheKey];
        if (cached) {
          setRequestedRows(cached);
          setRequestedRowsError(null);
          setRequestedRowsLoading(false);
          return;
        }
      }
      const fetchId = ++requestedRowsFetchIdRef.current;
      setRequestedRowsLoading(true);
      setRequestedRowsError(null);
      try {
        const params = new URLSearchParams();
        if (categoryId != null) {
          params.set('categoryId', String(categoryId));
        }
        const query = params.toString();
        const res = await fetch(
          `/api/offers/${encodeURIComponent(offerId)}/products/requests${query ? `?${query}` : ''}`,
        );
        const payload = (await res.json().catch(() => null)) as {
          ok?: boolean;
          rows?: RequestedRow[];
          error?: string;
        } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to load requested rows (status ${res.status})`);
        }
        if (requestedRowsFetchIdRef.current !== fetchId) {
          return;
        }
        const rows = Array.isArray(payload.rows) ? payload.rows : [];
        setRequestedRows(rows);
        requestedRowsCacheRef.current[cacheKey] = rows;
      } catch (err) {
        if (requestedRowsFetchIdRef.current !== fetchId) {
          return;
        }
        console.error('Failed to load requested rows', err);
        setRequestedRows([]);
        setRequestedRowsError(err instanceof Error ? err.message : 'Unable to load requested rows.');
      } finally {
        if (requestedRowsFetchIdRef.current === fetchId) {
          setRequestedRowsLoading(false);
        }
      }
    },
    [offerId],
  );

  useEffect(() => {
    setSelectedRequestedRowId(null);
    const categoryId = selectedCategory?.OfferDetailID ?? null;
    void fetchRequestedRows(categoryId);
  }, [selectedCategory, fetchRequestedRows]);

  // Auto-select and scroll to the initial requested row when requested rows finish loading
  useEffect(() => {
    if (initialRequestedRowConsumedRef.current) return;
    if (initialRequestedRowId == null) return;
    if (requestedRowsLoading) return;
    if (requestedRows.length === 0) return;
    const match = requestedRows.find((r) => r.OfferDetailID === initialRequestedRowId);
    if (match) {
      initialRequestedRowConsumedRef.current = true;
      setSelectedRequestedRowId(match.OfferDetailID);
      onInitialRequestedRowConsumed?.();
    }
  }, [initialRequestedRowId, requestedRows, requestedRowsLoading, onInitialRequestedRowConsumed]);

  const productColumns: ColDef[] = useMemo(() => {
    const columns: ColDef[] = [
      { field: 'BrandName', headerName: 'Brand', filter: 'agTextColumnFilter', width: 150 },
      {
        field: 'PartNumber',
        headerName: 'Part Number',
        filter: 'agTextColumnFilter',
        cellRenderer: PartNumberCellRenderer,
        width: 170,
        editable: true,
        valueParser: (params) => {
          const raw = params.newValue;
          if (raw == null) return null;
          const trimmed = String(raw).trim();
          return trimmed.length > 0 ? trimmed : null;
        },
      },
      {
        field: 'Description',
        headerName: 'Description',
        filter: 'agTextColumnFilter',
        width: 550,
        cellRenderer: DescriptionCellRenderer,
        editable: true,
        valueParser: (params) => {
          const raw = params.newValue;
          if (raw == null) return null;
          const trimmed = String(raw).trim();
          return trimmed.length > 0 ? trimmed : null;
        },
      },
      {
        field: 'ModelNumber',
        headerName: 'Model Number',
        filter: 'agTextColumnFilter',
        width: 200,
        editable: true,
        valueParser: (params) => {
          const raw = params.newValue;
          if (raw == null) return null;
          const trimmed = String(raw).trim();
          return trimmed.length > 0 ? trimmed : null;
        },
      },
    ];
    if (!standardPackageMode) {
      columns.push(
        {
          field: 'ListPrice',
          headerName: 'List Price',
          filter: 'agNumberColumnFilter',
          type: 'numericColumn',
          width: 130,
          valueFormatter: (params) => formatEuro(params.value),
          cellClassRules: priceListStatusClassRules(),
        },
        {
          field: 'CostPrice',
          headerName: 'Cost Price',
          filter: 'agNumberColumnFilter',
          type: 'numericColumn',
          width: 130,
          valueFormatter: (params) => formatEuro(params.value),
          cellClassRules: priceListStatusClassRules(),
        },
        { field: 'PriceListName', headerName: 'Price List', filter: 'agTextColumnFilter', width: 170 },
      );
    }
    return columns;
  }, [standardPackageMode]);

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
    }),
    [],
  );

  const handleProductCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    // Skip editing for Farnell pinned rows
    if (event.node?.rowPinned === 'top' && isFarnellRow(event.data as Record<string, unknown> | null)) return;
    const field = typeof event.colDef?.field === 'string' ? event.colDef.field : null;
    if (!field) return;
    const editableFields: Record<string, { label: string; payloadKey: 'partNumber' | 'modelNumber' | 'description' }> = {
      PartNumber: { label: 'Part number', payloadKey: 'partNumber' },
      ModelNumber: { label: 'Model number', payloadKey: 'modelNumber' },
      Description: { label: 'Description', payloadKey: 'description' },
    };
    const config = editableFields[field];
    if (!config) return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;

    const productId = normalizeProductId((event.data as ProductRow | null | undefined)?.ProductID ?? null);
    if (productId == null) {
      showToastMessage(`Unable to update ${config.label.toLowerCase()}. Missing product id.`, 'error');
      try {
        event.node?.setDataValue?.(field, event.oldValue ?? null);
      } catch {
        /* noop */
      }
      return;
    }

    const normalizedOld = normalizeEditableValue(event.oldValue ?? null);
    const normalizedNew = normalizeEditableValue(event.newValue ?? null);
    if (normalizedOld === normalizedNew) return;

    const revertValue = () => {
      try {
        event.node?.setDataValue?.(field, normalizedOld ?? null);
      } catch {
        /* noop */
      }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(`/api/products/${encodeURIComponent(String(productId))}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [config.payloadKey]: normalizedNew }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${config.label.toLowerCase()} (status ${res.status})`);
        }
        showToastMessage(`${config.label} updated`, 'success');
      } catch (err) {
        console.error(`Failed to update ${config.label}`, err);
        showToastMessage(`Unable to update ${config.label.toLowerCase()}. Please try again.`, 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, []);

  const handleAddProducts = useCallback(async () => {
    if (!selectedProducts.length) {
      showToastMessage('Select one or more products first', 'info');
      return;
    }
    // Resolve Farnell products before proceeding
    const resolvedProducts = [...selectedProducts];
    for (let i = 0; i < resolvedProducts.length; i++) {
      const row = resolvedProducts[i];
      if (isFarnellRow(row as Record<string, unknown>)) {
        const resolvedId = await resolveFarnellProduct(row as unknown as FarnellSearchRow);
        if (resolvedId == null) {
          showToastMessage('Unable to create Farnell product. Please try again.', 'error');
          return;
        }
        resolvedProducts[i] = { ...row, ProductID: resolvedId };
      }
    }
    const productPayload = resolvedProducts
      .map((row, idx) => ({
        productId: row.ProductID,
        sequence: idx + 1,
      }))
      .filter((entry) => entry.productId != null);
    if (!productPayload.length) {
      showToastMessage('Select one or more valid products first', 'info');
      return;
    }
    const fillRequestedRowId = placementMode === 'fill'
      ? ((placementAnchor?.isRequested ? placementAnchor.offerDetailId : null) ?? selectedRequestedRowId ?? null)
      : null;
    const isAssigningRequestedRow = fillRequestedRowId != null;
    if (isAssigningRequestedRow && productPayload.length !== 1) {
      showToastMessage('Select exactly one product to fill the row', 'info');
      return;
    }
    setSubmitting(true);
    try {
      // Use placementAnchor directly when in "below" mode (grid selection may have been cleared)
      const insertionAnchor = !isAssigningRequestedRow
        ? (placementMode === 'below' && placementAnchor?.offerDetailId != null && placementAnchor?.parentPath != null
          ? { offerDetailId: placementAnchor.offerDetailId, parentPath: placementAnchor.parentPath }
          : (getInsertionAnchor?.() ?? null))
        : null;
      const baseCategory = selectedCategory?.OfferDetailID ?? null;
      const trimmedComment = comment.trim() || undefined;
      const payload = isAssigningRequestedRow
        ? {
            action: 'assign-requested',
            requestedRowId: fillRequestedRowId,
            categoryId: baseCategory,
            productId: productPayload[0].productId,
            ...(trimmedComment ? { comment: trimmedComment } : {}),
          }
        : {
            action: 'add',
            ...(baseCategory != null ? { categoryId: baseCategory } : {}),
            products: productPayload,
            ...(trimmedComment && productPayload.length === 1 ? { comment: trimmedComment } : {}),
          };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data:
        | {
            ok?: boolean;
            inserted?: number;
            updated?: number;
            insertedOfferDetailIds?: Array<number | string | null>;
            error?: string;
          }
        | null = null;
      try {
        data = (await res.json()) as {
          ok?: boolean;
          inserted?: number;
          updated?: number;
          insertedOfferDetailIds?: Array<number | string | null>;
          error?: string;
        } | null;
      } catch {
        data = null;
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `Failed to add products (status ${res.status})`);
      }
      if (!isAssigningRequestedRow) {
        const insertedIds = Array.isArray(data?.insertedOfferDetailIds)
          ? data.insertedOfferDetailIds
            .map((value: number | string | null) => {
              if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
              if (typeof value === 'string') {
                const parsed = Number.parseInt(value.trim(), 10);
                return Number.isFinite(parsed) ? parsed : null;
              }
              return null;
            })
            .filter((value: number | null): value is number => value != null)
          : [];
        if (insertedIds.length > 0) {
          const desiredItemNo = placementMode === 'below' ? belowItemNo.trim() : '';
          const autoItemNo = placementAnchor?.treeOrdering ? computeNextItemNo(placementAnchor.treeOrdering) : '';
          const hasCustomItemNo = desiredItemNo && desiredItemNo !== autoItemNo;

          if (hasCustomItemNo && insertedIds.length === 1) {
            // User typed a custom item number — set it directly (grid sorts by TreeOrdering)
            try {
              const patchRes = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  updates: [{ OfferDetailID: insertedIds[0], TreeOrdering: desiredItemNo }],
                }),
              });
              const patchPayload = (await patchRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
              if (!patchRes.ok || !patchPayload?.ok) {
                showToastMessage('Product added, but could not set the desired item number.', 'error');
              }
            } catch {
              showToastMessage('Product added, but could not set the desired item number.', 'error');
            }
          } else if (insertionAnchor) {
            // Standard reorder: place after the anchor row
            const reorderRes = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'reorder',
                sourceIds: insertedIds,
                position: 'after',
                beforeId: insertionAnchor.offerDetailId,
                parentPath: insertionAnchor.parentPath,
              }),
            });
            const reorderPayload = (await reorderRes.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
            if (!reorderRes.ok || !reorderPayload?.ok) {
              showToastMessage(
                'Products were added, but could not be positioned below the selected row.',
                'error',
              );
            }
            // The reorder + resequence already assigned the correct TreeOrdering;
            // do NOT overwrite it with the stale auto-computed desiredItemNo
            // (which was based on the original anchor TreeOrdering before resequencing).
          }
        }
      }
      const addedCount = isAssigningRequestedRow
        ? 1
        : typeof data.inserted === 'number'
          ? data.inserted
          : productPayload.length;
      // Collect all affected row IDs for flash effect
      const affectedIds: number[] = isAssigningRequestedRow && fillRequestedRowId != null
        ? [fillRequestedRowId]
        : (Array.isArray(data?.insertedOfferDetailIds)
          ? data.insertedOfferDetailIds
              .map((v: number | string | null) => typeof v === 'number' ? Math.trunc(v) : typeof v === 'string' ? Number.parseInt(v, 10) : NaN)
              .filter((v: number) => Number.isFinite(v))
          : []);
      // Apply Farnell prices for any Farnell-brand products that were added.
      // Two paths:
      //  A) Farnell search rows: price already in the row — PATCH directly (no extra API call)
      //  B) Regular grid rows with Farnell brand: price unknown — call update-prices to fetch it
      const farnellPricePatches: Array<{ OfferDetailID: number; ListPrice: number }> = [];
      const regularFarnellIds: number[] = [];
      for (let i = 0; i < resolvedProducts.length; i++) {
        const row = resolvedProducts[i];
        const affectedId = isAssigningRequestedRow ? fillRequestedRowId : (affectedIds[i] ?? null);
        if (affectedId == null) continue;
        if (isFarnellRow(row as Record<string, unknown>)) {
          // Path A: price known from search result
          const farnellRow = row as unknown as FarnellSearchRow;
          const listPrice = farnellRow.ListPrice ?? farnellRow.__farnellProduct?.matchedPrice ?? null;
          if (listPrice != null && Number.isFinite(listPrice) && listPrice > 0) {
            farnellPricePatches.push({ OfferDetailID: affectedId, ListPrice: listPrice });
          }
        } else if (isFarnellBrand((row as ProductRow).BrandName)) {
          // Path B: price must be fetched from Farnell API
          regularFarnellIds.push(affectedId);
        }
      }
      // Path A: direct price patch
      if (farnellPricePatches.length > 0) {
        try {
          await fetch(`/api/offers/${encodeURIComponent(offerId)}/products`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ updates: farnellPricePatches }),
          });
        } catch {
          // Non-blocking
        }
      }
      // Path B: fetch live prices via update-prices endpoint
      if (regularFarnellIds.length > 0) {
        try {
          await fetch(`/api/offers/${encodeURIComponent(offerId)}/products/update-prices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ offerDetailIds: regularFarnellIds }),
          });
        } catch {
          // Non-blocking
        }
      }
      showToastMessage(
        isAssigningRequestedRow ? 'Row filled' : 'Products added',
        'success',
      );
      onAdded(addedCount, affectedIds);
      setSelectedRequestedRowId(null);
      setSelectedProducts([]);
      setComment('');
      try { productsApiRef.current?.deselectAll?.(); } catch { /* noop */ }
      pendingFilterClearRef.current = true;
    } catch (err) {
      console.error('Failed to add products to offer', err);
      showToastMessage('Unable to add products. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [
    belowItemNo,
    comment,
    endpoint,
    getInsertionAnchor,
    onAdded,
    offerId,
    placementAnchor,
    placementMode,
    selectedCategory?.OfferDetailID,
    selectedProducts,
    selectedRequestedRowId,
    resolveFarnellProduct,
  ]);

  const clearPinnedTopRow = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    const setter = api.setPinnedTopRowData;
    if (typeof setter === 'function') {
      try {
        setter([]);
      } catch {
        /* noop */
      }
    }
  }, []);

  const refreshProductsGrid = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    const refreshFn = api.refreshServerSide;
    if (typeof refreshFn === 'function') {
      try {
        refreshFn.call(api, { purge: true });
        return;
      } catch {
        /* noop */
      }
    }
    const purgeFn = api.purgeServerSideCache;
    if (typeof purgeFn === 'function') {
      try {
        purgeFn.call(api);
      } catch {
        /* noop */
      }
    }
  }, []);

  const refreshCategoryGrid = useCallback(() => {
    const api = categoryApiRef.current;
    if (!api) return;
    const refreshFn = (api as GridApi & { refreshServerSide?: (params?: { purge?: boolean }) => void })
      .refreshServerSide;
    if (typeof refreshFn === 'function') {
      try {
        refreshFn.call(api, { purge: true });
        return;
      } catch {
        /* noop */
      }
    }
    const purgeFn = (api as GridApi & { purgeServerSideCache?: () => void }).purgeServerSideCache;
    if (typeof purgeFn === 'function') {
      try {
        purgeFn.call(api);
      } catch {
        /* noop */
      }
    }
  }, []);

  const ensureProductSort = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    // Only set ProductID DESC sort if we have a newProductId to highlight
    // Otherwise, let the default sort (PartNumber ASC) remain
    if (newProductId == null) return;
    const sortModelGetter = api.getSortModel;
    const sortModel = typeof sortModelGetter === 'function' ? sortModelGetter() : [];
    const hasProductIdDesc = sortModel.some(
      (entry: { colId: string; sort: 'asc' | 'desc' }) => entry.colId === 'ProductID' && entry.sort === 'desc',
    );
    if (!hasProductIdDesc) {
      const setter = api.setSortModel;
      if (typeof setter === 'function') {
        setter([{ colId: 'ProductID', sort: 'desc' }]);
      }
    }
  }, [newProductId]);

  const trySelectPendingProduct = useCallback((api: ProductsGridApi) => {
    const targetId = pendingSelectionProductIdRef.current;
    if (targetId == null) return;
    let found = false;
    api.forEachNode((node) => {
      if (found) return;
      if (!node.data) return;
      const candidateId = normalizeProductId((node.data as { ProductID?: unknown }).ProductID ?? null);
      if (candidateId === targetId) {
        const rowData = node.data as Record<string, unknown>;
        node.setSelected(true);
        const pinnedSetter = api.setPinnedTopRowData;
        if (typeof pinnedSetter === 'function') {
          try {
            pinnedSetter([rowData]);
          } catch {
            /* noop */
          }
        }
        const typedNode = node as ProductsRowNode;
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

  // When newProductId is cleared, drop any transient ProductID DESC sort
  // that ensureProductSort may have applied while the prop was set.  The
  // pinned-rows sync effect handles pin teardown independently.
  useEffect(() => {
    if (newProductId != null) return;
    const api = productsApiRef.current;
    if (!api) return;
    const sortModelGetter = api.getSortModel;
    const sortModel = typeof sortModelGetter === 'function' ? sortModelGetter() : [];
    const hasProductIdDesc = sortModel.some(
      (entry: { colId: string; sort: 'asc' | 'desc' }) => entry.colId === 'ProductID' && entry.sort === 'desc',
    );
    if (!hasProductIdDesc) return;
    const filteredSort = sortModel.filter(
      (entry: { colId: string; sort: 'asc' | 'desc' }) => !(entry.colId === 'ProductID' && entry.sort === 'desc'),
    );
    const setter = api.setSortModel;
    if (typeof setter === 'function') {
      setter(filteredSort.length > 0 ? filteredSort : []);
    }
  }, [newProductId]);

  useEffect(() => () => {
    clearPinnedTopRow();
  }, [clearPinnedTopRow]);

  // After creating a new product via the "Add product" dialog, don't refetch
  // the whole grid — fetch just the new row and let the pinned-rows sync
  // effect render it on top.  Old flow did a full purge + refresh AND asked
  // the server to order the new product first, which rendered it twice (the
  // server row plus the client pinned row).
  useEffect(() => {
    if (newProductId == null) return;
    const targetId = newProductId;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/products/${targetId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { ok?: boolean; product?: Record<string, unknown> | null } | null;
        if (cancelled || !data?.ok || !data.product) return;
        const rowData = data.product;
        setPinnedNewProductRow(rowData);
        try { productsApiRef.current?.deselectAll?.(); } catch { /* noop */ }
        setSelectedProducts([rowData as ProductRow]);
        onClearNewProductId?.();
      } catch { /* noop */ }
    })();
    return () => { cancelled = true; };
  }, [newProductId, onClearNewProductId]);

  const selectedCategoryIdRef = useRef<number | null>(null);
  selectedCategoryIdRef.current = selectedCategory?.OfferDetailID ?? null;

  useEffect(() => {
    if (refreshToken == null) return;
    refreshCategoryGrid();
    if (pendingFilterClearRef.current) {
      pendingFilterClearRef.current = false;
      try { productsApiRef.current?.setFilterModel?.(null); } catch { /* noop */ }
    }
    refreshProductsGrid();
    void fetchRequestedRows(selectedCategoryIdRef.current, { force: true });
  }, [refreshToken, refreshCategoryGrid, refreshProductsGrid, fetchRequestedRows]);

  useEffect(() => () => {
    const api = categoryApiRef.current;
    const handler = categoryRowClickHandlerRef.current;
    if (api && !api.isDestroyed?.() && handler) {
      api.removeEventListener('rowClicked', handler as unknown as (event: unknown) => void);
    }
  }, []);

  // Farnell filter listener
  const filterListenerRef = useRef<(() => void) | null>(null);
  // Debounced semantic-expansion trigger for column-filter edits.  Without
  // this the user only gets semantic-search help when they type into the
  // "Search (AI)" box — typing directly into the Brand / Description column
  // filters falls back to pure keyword matching.  Refs declared near the
  // state block so the clear handler can reset them.
  const triggerSemanticFromFilters = useCallback((api: GridApi) => {
    // Skip while a prompt-driven search is active — the prompt owns the
    // filter and hidden-token state; we must not overwrite it.
    if (promptSubmittedRef.current) return;
    const model = (api.getFilterModel?.() ?? {}) as Record<string, { filter?: string }>;
    const pick = (colId: string): string | null => {
      const v = model[colId]?.filter;
      if (typeof v !== 'string') return null;
      const t = v.trim();
      // Below 2 chars the embedding is too noisy to be useful.
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
      setSemanticCandidates(null);
      setHiddenFilterTokens(null);
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
          semanticCandidates?: number[];
        };
        if (controller.signal.aborted) return;
        // Fold the full requested-filter state — fuzzy + synonym expansion of
        // each column's value plus the AI-supplied expansions — into the
        // hidden-tokens sidecar.  Without this, column-filter queries only
        // match literal text and miss the family-name/synonym recall that
        // the "Search (AI)" prompt path already gets.
        const expansions = data.expansions ?? {};
        const { hiddenTokens } = buildRequestedFilterState({
          requestedBrand,
          requestedPartNumber,
          requestedModelNumber,
          requestedDescriptions: requestedDescription ? [requestedDescription] : [],
          prefetchedExpansion: expansions,
        });
        setHiddenFilterTokens(hiddenTokens);
        const semantic = Array.isArray(data.semanticCandidates) ? data.semanticCandidates : [];
        setSemanticCandidates(semantic.length > 0 ? semantic : null);
        const negatives = Array.isArray(expansions.negativeDescription) ? expansions.negativeDescription : [];
        setNegativeDescriptionTerms(negatives.length > 0 ? negatives : null);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        console.warn('Semantic filter expansion failed', err);
      }
    })();
  }, [offerId]);

  const attachFilterListener = useCallback((api: GridApi) => {
    if (filterListenerRef.current) {
      try {
        api.removeEventListener('filterChanged', filterListenerRef.current as never);
      } catch { /* noop */ }
    }
    const listener = () => {
      try {
        const model = api.getFilterModel?.() ?? {};
        const brandFilter = (model as Record<string, { filter?: string }>).BrandName;
        const brandValue = brandFilter?.filter ?? '';
        setBrandFilterIsFarnell(
          typeof brandValue === 'string' && brandValue.toLowerCase().includes('farnell'),
        );
        const partFilter = (model as Record<string, { filter?: string }>).PartNumber;
        const descFilter = (model as Record<string, { filter?: string }>).Description;
        setFarnellPartNumber(partFilter?.filter ?? null);
        setFarnellDescription(descFilter?.filter ?? null);
      } catch { /* noop */ }
      // Debounce semantic expansion — wait for typing to pause before
      // issuing the embedding call.  Skipped when "Smart filtering" is off.
      if (semanticExpandTimerRef.current != null) {
        window.clearTimeout(semanticExpandTimerRef.current);
      }
      if (!smartFilteringEnabledRef.current) return;
      semanticExpandTimerRef.current = window.setTimeout(() => {
        semanticExpandTimerRef.current = null;
        triggerSemanticFromFilters(api);
      }, 500);
    };
    filterListenerRef.current = listener;
    try {
      api.addEventListener('filterChanged', listener as never);
    } catch { /* noop */ }
  }, [triggerSemanticFromFilters]);

  // Clean up any pending debounce / abort when the modal unmounts.
  useEffect(() => () => {
    if (semanticExpandTimerRef.current != null) {
      window.clearTimeout(semanticExpandTimerRef.current);
    }
    semanticExpandAbortRef.current?.abort();
  }, []);

  // Sync pinned rows: a locally-pinned new product sits on top, followed
  // by any visible Farnell results.  When neither is present the pin is
  // cleared.
  useEffect(() => {
    const api = productsApiRef.current;
    if (!api) return;
    const setter = api.setPinnedTopRowData;
    if (typeof setter !== 'function') return;
    const rows: Record<string, unknown>[] = [];
    if (pinnedNewProductRow) rows.push(pinnedNewProductRow);
    if (farnellResults.length > 0 && farnellVisible) {
      rows.push(...(farnellResults as unknown as Record<string, unknown>[]));
    }
    try { setter(rows); } catch { /* noop */ }
  }, [pinnedNewProductRow, farnellResults, farnellVisible]);

  // Attach cell click listener for Farnell pinned rows
  const farnellCellClickRef = useRef<((event: { node?: RowNode; data?: unknown }) => void) | null>(null);

  const attachFarnellCellClickListener = useCallback((api: GridApi) => {
    if (farnellCellClickRef.current) {
      try { api.removeEventListener('cellClicked', farnellCellClickRef.current as never); } catch { /* noop */ }
    }
    const listener = (event: { node?: RowNode; data?: unknown }) => {
      if (event.node?.rowPinned === 'top' && event.data && isFarnellRow(event.data as Record<string, unknown>)) {
        try { api.deselectAll?.(); } catch { /* noop */ }
        setSelectedProducts([event.data as ProductRow]);
      }
    };
    farnellCellClickRef.current = listener;
    try { api.addEventListener('cellClicked', listener as never); } catch { /* noop */ }
  }, []);

  const handleProductsGridReady = useCallback((api: GridApi) => {
    productsApiRef.current = api as ProductsGridApi;
    ensureProductSort();
    trySelectPendingProduct(api as ProductsGridApi);
    attachFilterListener(api);
    attachFarnellCellClickListener(api);
  }, [ensureProductSort, trySelectPendingProduct, attachFilterListener, attachFarnellCellClickListener]);

  const handleProductsGridModelUpdated = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    ensureProductSort();
    trySelectPendingProduct(api);
  }, [ensureProductSort, trySelectPendingProduct]);

  // Comment button — replaces the inline comment input.  Only shown when
  // exactly one product is selected.  Clicking opens a modal.  The button
  // label reflects whether a comment has been entered.
  const commentButton = selectedProducts.length === 1 ? (
    <button
      type="button"
      className={styles.secondaryButton}
      onClick={openCommentModal}
      disabled={submitting}
    >
      {comment.trim() ? '✓ Edit comment' : '+ Add comment'}
    </button>
  ) : null;

  const commentPopup = commentModalOpen ? (
    <div
      className={styles.commentPopupOverlay}
      role="dialog"
      aria-modal="true"
      aria-label="Add comment to product"
      onClick={cancelCommentModal}
    >
      <div className={styles.commentPopupCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.commentPopupTitle}>Add comment to product</div>
        <textarea
          className={styles.commentPopupTextarea}
          value={commentDraft}
          onChange={(e) => setCommentDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              saveCommentModal();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelCommentModal();
            }
          }}
          autoFocus
          placeholder="Enter a note for this product…"
          data-fastquote-keep-selection="true"
        />
        <div className={styles.commentPopupActions}>
          <button
            type="button"
            className={styles.ghostButton}
            onClick={cancelCommentModal}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primaryButton}
            onClick={saveCommentModal}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // AI prompt input — shared pill component used across modal + split view.
  const promptInput = (
    <>
      <label
        className={styles.smartFilterToggle}
        title="Smart filtering: when ON the modal folds description, brand and AI synonyms into the filter. When OFF only part/model number filters are emitted."
      >
        <input
          type="checkbox"
          checked={smartFilteringEnabled}
          onChange={(e) => setSmartFilteringEnabled(e.target.checked)}
          disabled={submitting}
        />
        <span>Smart filtering</span>
      </label>
      <AiSearchPromptPill
        promptText={promptText}
        onPromptTextChange={setPromptText}
        onSubmit={handlePromptSubmit}
        onClear={handleClearAIPrompt}
        submitted={promptSubmitted}
        busy={suggesting}
        disabled={submitting || !smartFilteringEnabled}
      />
      {noSuggestionsFound && !suggesting && (
        <span className={styles.noPromptLabel}>No extra terms to add</span>
      )}
    </>
  );

  // Farnell button fragment — shared between split view and modal view
  const farnellButtons = brandFilterIsFarnell ? (
    <>
      <button
        type="button"
        className={styles.farnellButton}
        onClick={() => { clearFarnellResults(); void searchFarnell(); }}
        disabled={farnellLoading || submitting}
      >
        {farnellLoading ? 'Searching Farnell…' : 'Look up Farnell'}
      </button>
      {noFarnellResults && farnellResults.length === 0 && !farnellLoading && (
        <span className={styles.noFarnellLabel}>No Farnell results</span>
      )}
      {farnellResults.length > 0 && farnellVisible && (
        <button
          type="button"
          className={styles.farnellButton}
          onClick={() => setFarnellVisible(false)}
          disabled={submitting}
        >
          Hide Farnell ({farnellResults.length})
        </button>
      )}
      {farnellResults.length > 0 && !farnellVisible && (
        <button
          type="button"
          className={styles.farnellButton}
          onClick={() => setFarnellVisible(true)}
          disabled={submitting}
        >
          Show Farnell ({farnellResults.length})
        </button>
      )}
    </>
  ) : null;

  // Build placement indicator content
  // "below" default = user clicked "+" between rows → only show "Add below"
  // "fill" default = user selected a row → show "Fill row" with option to switch
  const placementIndicator = placementAnchor ? (
    defaultPlacementMode === 'below' ? (
      <div className={styles.placementIndicator}>
        <span className={styles.placementText}>
          Add below ({placementAnchor.treeOrdering})
        </span>
        <span className={styles.placementNewItemNo}>
          New Item No
          <input
            type="text"
            className={styles.placementItemNoInput}
            value={belowItemNo}
            onChange={(e) => setBelowItemNo(e.target.value)}
            disabled={submitting}
            data-fastquote-keep-selection="true"
          />
        </span>
      </div>
    ) : (
      <div className={styles.placementIndicator}>
        <label className={styles.placementRadioLabel}>
          <input
            type="radio"
            name="placementMode"
            className={styles.placementRadio}
            checked={placementMode === 'fill'}
            onChange={() => { setPlacementMode('fill'); onPlacementModeChange?.('fill'); }}
            disabled={submitting}
          />
          Fill row
        </label>
        <label className={styles.placementRadioLabel}>
          <input
            type="radio"
            name="placementMode"
            className={styles.placementRadio}
            checked={placementMode === 'below'}
            onChange={() => { setPlacementMode('below'); onPlacementModeChange?.('below'); }}
            disabled={submitting}
          />
          Add below ({placementAnchor.treeOrdering})
        </label>
        {placementMode === 'below' ? (
          <span className={styles.placementNewItemNo}>
            New Item No
            <input
              type="text"
              className={styles.placementItemNoInput}
              value={belowItemNo}
              onChange={(e) => setBelowItemNo(e.target.value)}
              disabled={submitting}
              data-fastquote-keep-selection="true"
            />
          </span>
        ) : null}
      </div>
    )
  ) : (
    <div className={styles.placementIndicator}>
      <div className={styles.placementTextColumn}>
        <span className={styles.placementText}>Adding product at the end of the list</span>
        <span className={styles.placementText}>select a row to fill or click between rows to insert there</span>
      </div>
    </div>
  );

  if (splitViewMode) {
    return (
      <div
        className={styles.splitViewContainer}
        role="dialog"
        aria-label="Add products to offer"
        data-fastquote-keep-selection="true"
        onContextMenu={handleModalContextMenu}
      >
        <div className={styles.splitViewCard} onContextMenu={handleModalContextMenu}>
          <div className={styles.header}>
          <div className={styles.headerTopRow}>
            <div className={styles.title}>Add Products</div>
            {placementIndicator}
          </div>
          <div className={styles.headerActions}>
            {promptInput}
            <div className={styles.headerMeta}>
              <div className={styles.headerMetaItem}>
                <span className={styles.headerMetaLabel}>Products selected:</span>
                <span className={styles.headerMetaValue}>{selectedProducts.length}</span>
              </div>
            </div>
            {farnellButtons}
            {commentButton}
            {onRequestAddProduct ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onRequestAddProduct}
                disabled={submitting}
              >
                Add New Product
              </button>
            ) : null}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleAddProducts}
              disabled={submitting || farnellResolving}
            >
              {farnellResolving ? 'Creating…' : `Add ${selectedProducts.length > 0 ? `(${selectedProducts.length})` : ''}`}
            </button>
            <button type="button" className={styles.ghostButton} onClick={onClose} disabled={submitting}>
              Close
            </button>
          </div>
        </div>

        <div className={styles.body}>
          <section className={styles.section}>
            <ProductsGridPanel
              endpoint={endpoint}
              productColumns={productColumns}
              defaultColDef={defaultColDef}
              productRequestPayload={productRequestPayload}
              handleProductSelection={handleProductSelection as (rows: Record<string, unknown>[], api: GridApi) => void}
              handleProductCellEdit={handleProductCellEdit}
              handleProductsGridReady={handleProductsGridReady}
              handleProductsGridModelUpdated={handleProductsGridModelUpdated}
              onRequestPayloadConsumed={onRequestPayloadConsumed}
              aiLocked={promptSubmitted}
            />
          </section>
        </div>
        </div>
        {commentPopup}
        {detachMenuNode}
      </div>
    );
  }

  return (
    <div
      className={styles.overlay}
      role="dialog"
      aria-modal="true"
      aria-label="Add products to offer"
      data-fastquote-keep-selection="true"
      onContextMenu={handleModalContextMenu}
    >
      <div className={styles.card} onContextMenu={handleModalContextMenu}>
        <div className={styles.header}>
          <div className={styles.headerTopRow}>
            <div className={styles.title}>Add Products</div>
            {placementIndicator}
          </div>
          <div className={styles.headerActions}>
            {promptInput}
            <div className={styles.headerMeta}>
              <div className={styles.headerMetaItem}>
                <span className={styles.headerMetaLabel}>Products selected:</span>
                <span className={styles.headerMetaValue}>{selectedProducts.length}</span>
              </div>
            </div>
            {farnellButtons}
            {onRequestAddProduct ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={onRequestAddProduct}
                disabled={submitting}
              >
                Add product
              </button>
            ) : null}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={handleAddProducts}
              disabled={submitting || farnellResolving}
            >
              {farnellResolving ? 'Creating…' : `Add ${selectedProducts.length > 0 ? `(${selectedProducts.length})` : ''}`}
            </button>
            <button type="button" className={styles.ghostButton} onClick={onClose} disabled={submitting}>
              Close
            </button>
          </div>
        </div>

        <div className={styles.body}>
          <section className={styles.section}>
            <ProductsGridPanel
              endpoint={endpoint}
              productColumns={productColumns}
              defaultColDef={defaultColDef}
              productRequestPayload={productRequestPayload}
              handleProductSelection={handleProductSelection as (rows: Record<string, unknown>[], api: GridApi) => void}
              handleProductCellEdit={handleProductCellEdit}
              handleProductsGridReady={handleProductsGridReady}
              handleProductsGridModelUpdated={handleProductsGridModelUpdated}
              onRequestPayloadConsumed={onRequestPayloadConsumed}
              aiLocked={promptSubmitted}
            />
          </section>
        </div>
      </div>
      {commentPopup}
      {detachMenuNode}
    </div>
  );
}
