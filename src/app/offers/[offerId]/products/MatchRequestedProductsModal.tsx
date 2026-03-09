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
}: Props) {
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
    setSuggestionsVisible(false);
    clearPinnedTopRow();
  }, [clearPinnedTopRow]);

  const handleShowSuggestions = useCallback(() => {
    setSuggestionsVisible(true);
    setPinnedSuggestions(suggestedProductsRef.current);
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
    if (params.node.rowPinned === 'top') {
      return { background: '#dbeafe' };
    }
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
    return Object.keys(filters).length > 0 ? filters : null;
  }, [entry.requestedBrand, entry.requestedModelNumber, entry.requestedPartNumber]);

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

  const handleSlotRef = useCallback((node: HTMLDivElement | null) => {
    setSearchSlot(node);
  }, []);

  const handleSelectionChanged = useCallback(
    (rows: MatcherRowData[]) => {
      // When a normal grid row is selected, use it (this clears any pinned row selection)
      if (rows.length > 0) {
        setSelectedProduct(rows[rows.length - 1]);
      }
    },
    [],
  );

  const autoSelectTopProduct = useCallback((api: MatcherGridApi | null) => {
    if (!api) return;
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
      firstNode.setSelected(true);
      setSelectedProduct(firstNode.data as MatcherRowData);
    } catch {
      /* noop */
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

  const handleSuggestProducts = useCallback(async () => {
    if (suggesting) return;
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
      const data = (await res.json()) as { ok: boolean; products?: MatcherRowData[] };
      const products = data.products ?? [];
      setSuggestedProducts(products);
      setSuggestionsVisible(true);
      if (products.length > 0) {
        try {
          productsApiRef.current?.deselectAll?.();
        } catch { /* noop */ }
        setSelectedProduct(products[0]);
      }
    } catch (err) {
      console.error('AI suggest failed', err);
    } finally {
      setSuggesting(false);
    }
  }, [suggesting, offerId, entry]);

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
    // Schedule a re-application that runs after the persisted restoration.
    requestAnimationFrame(() => {
      if ((api as unknown as { isDestroyed?: () => boolean }).isDestroyed?.()) return;
      hasAppliedRequestedFiltersRef.current = false;
      applyRequestedFilterModel(api);
    });
  }, [applyRequestedFilterModel, autoSelectTopProduct, ensureProductSort, trySelectPendingProduct, attachCellClickListener]);

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
    // Clear any filters that were manually applied by the user
    try {
      productsApiRef.current?.setFilterModel(null);
    } catch {
      /* noop */
    }
    setSelectedProduct(null);
    setAssigning(false);
    setComment('');
    setSuggestedProducts([]);
    setSuggestionsVisible(true);
  }, [entry.offerDetailId]);

  useEffect(() => {
    applyRequestedFilterModel(productsApiRef.current);
  }, [applyRequestedFilterModel]);

  useEffect(() => {
    // If the grid already has data loaded for the new requested item,
    // make sure we still have a deterministic selection.
    autoSelectTopProduct(productsApiRef.current);
  }, [autoSelectTopProduct, entry.offerDetailId]);

  const remaining = Math.max(0, total - position);

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Match requested product">
      <div className={styles.card}>
        <PageHeaderContext.Provider value={searchSlot}>
          <div className={styles.header}>
            <div>
              <div className={styles.title}>Match requested product</div>
              <div className={styles.subtitle}>{entry.label}</div>
              <div className={styles.counter}>
                Resolving {position} of {total}
                {remaining > 0 ? ` • ${remaining} remaining` : ''}
              </div>
            </div>
            <div className={styles.headerActions}>
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
              {suggestedProducts.length > 0 && suggestionsVisible && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={handleHideSuggestions}
                  disabled={suggesting || assigning}
                >
                  Hide suggestions
                </button>
              )}
              {suggestedProducts.length > 0 && !suggestionsVisible && (
                <button
                  type="button"
                  className={styles.secondaryButton}
                  onClick={handleShowSuggestions}
                  disabled={suggesting || assigning}
                >
                  Show suggestions
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
            <div className={`${styles.gridShell} offer-products-grid`}>
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
      </div>
    </div>
  );
}
