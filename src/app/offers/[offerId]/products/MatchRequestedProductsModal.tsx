'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { CellClickedEvent, ColDef, GridApi, RowClassParams, RowDoubleClickedEvent, RowNode, RowStyle } from 'ag-grid-community';
import { PageHeaderContext } from '../../../components/PageHeader';
import { GridQuickSearchProvider } from '../../../components/GridQuickSearchProvider';
import { productDefaultColDef } from '../../../../lib/productColumns';
import { priceListStatusClassRules } from '../../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../../lib/localeNumber';
import styles from './MatchRequestedProductsModal.module.css';
import { useModalDragResize } from '../../../hooks/useModalDragResize';

const AgGridAll = dynamic(() => import('../../../components/AgGridAll'), {
  ssr: false,
});

type DetailEntry = {
  label: string;
  value: string;
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
  onAssign: (productId: number, comment: string) => Promise<boolean>;
  onSkip: () => void;
  onRequestAddProduct: () => void;
  newProductId?: number | null;
  onClearNewProductId: () => void;
  onRequestPayloadConsumed?: () => void;
  onSkipAll: () => void;
  prefetchedSuggestions?: MatcherRowData[] | null;
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
}: Props) {
  const { cardRef: setCardRef, cardStyle: dragCardStyle, headerProps: dragHeaderProps, resizeHandles } = useModalDragResize({ draggable: true, resizable: true });
  const [selectedProduct, setSelectedProduct] = useState<MatcherRowData | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [comment, setComment] = useState('');
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestedProducts, setSuggestedProducts] = useState<MatcherRowData[]>([]);
  const [suggestionsVisible, setSuggestionsVisible] = useState(true);
  const productsApiRef = useRef<MatcherGridApi | null>(null);
  const pendingSelectionProductIdRef = useRef<number | null>(null);
  const suggestedProductsRef = useRef<MatcherRowData[]>([]);
  const currentEntryIdRef = useRef(entry.offerDetailId);
  currentEntryIdRef.current = entry.offerDetailId;
  const gridShellRef = useRef<HTMLDivElement | null>(null);
  const userWantsSuggestionsRef = useRef(false);
  const userManuallySelectedRef = useRef(false);
  const autoSelectingRef = useRef(false);

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

  // Sync pinned rows when suggestedProducts or visibility changes
  useEffect(() => {
    if (suggestedProducts.length > 0 && suggestionsVisible) {
      setPinnedSuggestions(suggestedProducts);
    } else {
      clearPinnedTopRow();
    }
  }, [suggestedProducts, suggestionsVisible, setPinnedSuggestions, clearPinnedTopRow]);

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
      },
      {
        field: 'Description',
        headerName: 'Description',
        filter: 'agTextColumnFilter',
        cellRenderer: DescriptionCellRenderer,
      },
      { field: 'BrandName', headerName: 'Brand', filter: 'agTextColumnFilter' },
      {
        field: 'ModelNumber',
        headerName: 'Model Number',
        filter: 'agTextColumnFilter',
      },
      { field: 'PriceListName', headerName: 'Price List', filter: 'agTextColumnFilter' },
      {
        field: 'ListPrice',
        headerName: 'List Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: priceValueFormatter,
        cellClassRules: priceListClassRules,
      },
      {
        field: 'UnitPrice',
        headerName: 'Unit Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: priceValueFormatter,
      },
    ],
    [],
  );

  const requestedFilterModel = useMemo(() => {
    const filters: Record<string, { filterType: 'text'; type: 'contains'; filter: string }> = {};
    const applyFilter = (colId: string, value: string | null) => {
      if (!value) return;
      filters[colId] = { filterType: 'text', type: 'contains', filter: value };
    };
    applyFilter('BrandName', entry.requestedBrand);
    applyFilter('ModelNumber', entry.requestedModelNumber);
    applyFilter('PartNumber', entry.requestedPartNumber);
    applyFilter('Description', entry.requestedDescription);
    return Object.keys(filters).length > 0 ? filters : null;
  }, [entry.requestedBrand, entry.requestedModelNumber, entry.requestedPartNumber, entry.requestedDescription]);

  const requestPayload = useMemo(() => {
    const payload: Record<string, unknown> = { action: 'products' };
    if (newProductId != null) payload.newProductId = newProductId;
    return Object.keys(payload).length > 0 ? payload : null;
  }, [newProductId]);

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
      api.setFilterModel(filters);
    } catch {
      /* noop */
    }
    hasAppliedRequestedFiltersRef.current = true;
  }, [requestedFilterModel]);

  const selectedProductId = useMemo(
    () => normalizeProductId(selectedProduct?.ProductID ?? null),
    [selectedProduct],
  );

  // Highlight selected suggestion row via DOM class toggle.
  // ag-grid positions pinned rows with absolute CSS so DOM element order can
  // differ from visual order.  Match by row-id (= ProductID) instead.
  const updateSuggestionHighlight = useCallback(() => {
    const shell = gridShellRef.current;
    if (!shell) return;
    const sid = normalizeProductId(selectedProduct?.ProductID ?? null);
    const rows = shell.querySelectorAll<HTMLElement>('.ag-floating-top .ag-row');
    rows.forEach((row) => {
      const rowId = row.getAttribute('row-id');
      const rowProductId = rowId != null ? normalizeProductId(rowId) : null;
      if (sid != null && rowProductId != null && rowProductId === sid) {
        row.classList.add('suggestion-selected');
      } else {
        row.classList.remove('suggestion-selected');
      }
    });
  }, [selectedProduct]);

  useEffect(() => {
    // Run immediately for clicks on already-rendered rows
    updateSuggestionHighlight();
    // Also run after a frame so ag-grid has time to render new pinned rows
    const raf = requestAnimationFrame(updateSuggestionHighlight);
    return () => cancelAnimationFrame(raf);
  }, [updateSuggestionHighlight, suggestedProducts]);

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
      const success = await onAssign(productId, assignComment ?? comment);
      if (success) {
        setSelectedProduct(null);
        setComment('');
      }
    } finally {
      setAssigning(false);
    }
  }, [assigning, onAssign, comment]);

  const getSelectedProductIdFromApi = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return null;
    const rows =
      typeof api.getSelectedRows === 'function' ? api.getSelectedRows() : [];
    if (!rows || rows.length === 0) return null;
    const candidate = rows[rows.length - 1] as MatcherRowData;
    return normalizeProductId((candidate?.ProductID ?? null));
  }, []);

  const handleAssign = useCallback(() => {
    const id = selectedProductId ?? getSelectedProductIdFromApi();
    if (id == null) return;
    void handleAssignWithId(id);
  }, [selectedProductId, handleAssignWithId, getSelectedProductIdFromApi]);

  const handleRowDoubleClick = useCallback((event: RowDoubleClickedEvent<MatcherRowData>) => {
    const rawProductId = (event.data as { ProductID?: unknown }).ProductID ?? null;
    const productId = normalizeProductId(rawProductId);
    if (productId == null) return;
    void handleAssignWithId(productId, comment);
  }, [handleAssignWithId, comment]);

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

  useEffect(() => {
    if (newProductId == null && suggestedProducts.length === 0) {
      clearPinnedTopRow();
    }
  }, [newProductId, clearPinnedTopRow, suggestedProducts.length]);

  useEffect(() => () => {
    clearPinnedTopRow();
  }, [clearPinnedTopRow]);

  const applyProducts = useCallback((products: MatcherRowData[]) => {
    suggestedProductsRef.current = products;
    setSuggestedProducts(products);
    setSuggestionsVisible(true);
    if (products.length > 0) {
      try {
        productsApiRef.current?.deselectAll?.();
      } catch { /* noop */ }
      userManuallySelectedRef.current = false;
      setSelectedProduct(products[0]);
    }
  }, []);

  const handleSuggestProducts = useCallback(async () => {
    if (suggesting) return;
    userWantsSuggestionsRef.current = true;

    // Use prefetched suggestions if already available (instant)
    if (prefetchedSuggestions && prefetchedSuggestions.length > 0) {
      applyProducts(prefetchedSuggestions);
      return;
    }

    const targetEntryId = entry.offerDetailId;
    setSuggesting(true);
    try {
      const res = await fetch(`/api/offers/${encodeURIComponent(offerId)}/products/suggest`, {
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
      if (!res.ok) throw new Error('Failed to suggest products');
      // Discard result if the entry changed while we were fetching
      if (currentEntryIdRef.current !== targetEntryId) return;
      const data = (await res.json()) as { ok: boolean; products?: MatcherRowData[] };
      applyProducts(data.products ?? []);
    } catch (err) {
      console.error('AI suggest failed', err);
    } finally {
      setSuggesting(false);
    }
  }, [suggesting, offerId, entry, prefetchedSuggestions, applyProducts]);


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

  useEffect(() => {
    if (newProductId == null) return;
    ensureProductSort();
    pendingSelectionProductIdRef.current = newProductId;
    const timer = window.setTimeout(() => {
      refreshProductsGrid();
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [newProductId, ensureProductSort, refreshProductsGrid]);

  const handleGridReady = useCallback((api: MatcherGridApi) => {
    productsApiRef.current = api;
    ensureProductSort();
    trySelectPendingProduct(api);
    applyRequestedFilterModel(api);
    autoSelectTopProduct(api);
    attachCellClickListener(api);
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
  }, [applyRequestedFilterModel, autoSelectTopProduct, ensureProductSort, trySelectPendingProduct, attachCellClickListener, requestedFilterModel]);

  const handleGridModelUpdated = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    ensureProductSort();
    trySelectPendingProduct(api);
    applyRequestedFilterModel(api);
    autoSelectTopProduct(api);
  }, [applyRequestedFilterModel, autoSelectTopProduct, ensureProductSort, trySelectPendingProduct]);

  useEffect(() => {
    hasAppliedRequestedFiltersRef.current = false;
    // Prevent stale grid selection from a previous requested item.
    try {
      productsApiRef.current?.deselectAll?.();
    } catch {
      /* noop */
    }
    // Apply the new entry's filter directly instead of first clearing to null.
    // Clearing to null then re-applying caused two server-side reloads that
    // could race with user selections.
    try {
      productsApiRef.current?.setFilterModel(requestedFilterModel ?? null);
    } catch {
      /* noop */
    }
    hasAppliedRequestedFiltersRef.current = true;
    setSelectedProduct(null);
    setAssigning(false);
    setComment('');
    setSuggestedProducts([]);
    // Immediately update refs so autoSelectTopProduct (which runs in a later effect
    // during the same commit phase) sees the cleared values.
    suggestedProductsRef.current = [];
    userManuallySelectedRef.current = false;
    setSuggestionsVisible(true);
  }, [entry.offerDetailId, requestedFilterModel]);

  // Auto-apply prefetched suggestions when the user has previously opted in.
  // On the first product userWantsSuggestionsRef is false, so the user must
  // click "Suggest Products (AI)" to opt in.  After that, subsequent products
  // will auto-show suggestions until the user clicks "Hide suggestions".
  useEffect(() => {
    if (!userWantsSuggestionsRef.current) return;
    if (suggestedProductsRef.current.length > 0) return;
    if (!prefetchedSuggestions || prefetchedSuggestions.length === 0) return;
    applyProducts(prefetchedSuggestions);
  }, [prefetchedSuggestions, entry.offerDetailId, applyProducts]);

  useEffect(() => {
    applyRequestedFilterModel(productsApiRef.current);
  }, [applyRequestedFilterModel]);

  // Auto-selection on entry change is handled by handleGridModelUpdated when the
  // fresh server-side data arrives.  Running autoSelectTopProduct eagerly here
  // would pick up a stale row from the previous entry's data (filters haven't
  // taken effect yet), leaving selectedProduct pointing at a row that disappears
  // once the new block loads.

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
              {suggestedProducts.length === 0 && (
              <button
                type="button"
                className={styles.aiButton}
                onClick={handleSuggestProducts}
                disabled={suggesting || assigning}
              >
                {suggesting ? (
                  <>
                    <span className={styles.aiButtonSpinner} />
                    Suggesting…
                  </>
                ) : (
                  'Suggest Products (AI)'
                )}
              </button>
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
            <div className={`${styles.gridShell} offer-products-grid`} ref={gridShellRef}>
              <AgGridAll
                endpoint={endpoint}
                columnDefs={productColumns}
                defaultColDef={productDefaultColDef}
                columnWidthDefaults={emptyColumnWidthDefaults}
                requestPayload={requestPayload}
                serverSideEnableClientSideSort={false}
                cacheBlockSize={25}
                onRequestPayloadConsumed={onRequestPayloadConsumed}
                rowSelection="single"
                rowMultiSelectWithClick
                rowDeselection
                onSelectionChanged={handleSelectionChanged}
                onRowDoubleClicked={handleRowDoubleClick}
                onGridReady={handleGridReady}
                onModelUpdated={handleGridModelUpdated}
                allowRowClickSelection
                columnStateNamespace="match-requested-products-v2"
                applyColumnStateOrder={true}
                maintainColumnOrder={true}
                disableAutoSize={true}
                suppressCellSelection
                getRowStyle={getRowStyle}
              />
            </div>
            <div className={styles.actions}>
              <label className={styles.commentLabel}>Comment:</label>
              <input
                type="text"
                className={styles.commentInput}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                disabled={assigning || selectedProductId == null}
                placeholder=""
                data-fastquote-keep-selection="true"
              />
              <button
                type="button"
                className={styles.primaryButton}
                data-fastquote-keep-selection="true"
                onClick={handleAssign}
                disabled={assigning || selectedProductId == null}
              >
                {assigning ? 'Matching…' : 'Assign product'}
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
