'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { GridApi, RowDoubleClickedEvent, RowNode } from 'ag-grid-community';
import { PageHeaderContext } from '../../../components/PageHeader';
import { GridQuickSearchProvider } from '../../../components/GridQuickSearchProvider';
import { productGridColumnDefs, productDefaultColDef } from '../../../../lib/productColumns';
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
  entry: RequestedProductMatchEntry;
  position: number;
  total: number;
  onAssign: (productId: number) => Promise<boolean>;
  onSkip: () => void;
  onRequestAddProduct: () => void;
  newProductId?: number | null;
  onClearNewProductId: () => void;
  onRequestPayloadConsumed?: () => void;
};

const normalizeProductId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

export default function MatchRequestedProductsModal({
  entry,
  position,
  total,
  onAssign,
  onSkip,
  onRequestAddProduct,
  newProductId,
  onClearNewProductId,
  onRequestPayloadConsumed,
}: Props) {
  const [selectedProduct, setSelectedProduct] = useState<MatcherRowData | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [searchSlot, setSearchSlot] = useState<HTMLDivElement | null>(null);
  const productsApiRef = useRef<MatcherGridApi | null>(null);
  const pendingSelectionProductIdRef = useRef<number | null>(null);
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

  const highlightRequestPayload = useMemo(
    () => (newProductId != null ? { newProductId } : null),
    [newProductId],
  );

  const selectedProductId = useMemo(
    () => normalizeProductId(selectedProduct?.ProductID ?? null),
    [selectedProduct],
  );

  const handleSlotRef = useCallback((node: HTMLDivElement | null) => {
    setSearchSlot(node);
  }, []);

  const handleSelectionChanged = useCallback(
    (rows: MatcherRowData[]) => {
      setSelectedProduct(rows.length > 0 ? rows[rows.length - 1] : null);
    },
    [],
  );

  const handleAssignWithId = useCallback(async (productId: number) => {
    if (assigning) return;
    setAssigning(true);
    try {
      const success = await onAssign(productId);
      if (success) {
        setSelectedProduct(null);
      }
    } finally {
      setAssigning(false);
    }
  }, [assigning, onAssign]);

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
    void handleAssignWithId(productId);
  }, [handleAssignWithId]);

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
          const pinnedSetter = api.setPinnedTopRowData;
          if (typeof pinnedSetter === 'function') {
            try {
              pinnedSetter([rowData]);
            } catch {
              /* noop */
            }
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

  useEffect(() => {
    if (newProductId == null) {
      clearPinnedTopRow();
    }
  }, [newProductId, clearPinnedTopRow]);

  useEffect(() => () => {
    clearPinnedTopRow();
  }, [clearPinnedTopRow]);

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
  }, [ensureProductSort, trySelectPendingProduct]);

  const handleGridModelUpdated = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    ensureProductSort();
    trySelectPendingProduct(api);
  }, [ensureProductSort, trySelectPendingProduct]);

  useEffect(() => {
    setSelectedProduct(null);
    setAssigning(false);
  }, [entry.offerDetailId]);

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
            <div className={styles.gridShell}>
              <AgGridAll
                endpoint="/api/products"
                columnDefs={productGridColumnDefs}
                defaultColDef={productDefaultColDef}
                requestPayload={highlightRequestPayload}
                serverSideEnableClientSideSort={false}
                cacheBlockSize={25}
                onRequestPayloadConsumed={onRequestPayloadConsumed}
                rowSelection="single"
                rowMultiSelectWithClick
                rowDeselection
                autoSizeExclusions={["Description"]}
                onSelectionChanged={handleSelectionChanged}
                onRowDoubleClicked={handleRowDoubleClick}
                onGridReady={handleGridReady}
                onModelUpdated={handleGridModelUpdated}
                allowRowClickSelection
              />
            </div>
            <div className={styles.actions}>
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
            </div>
          </GridQuickSearchProvider>
        </PageHeaderContext.Provider>
      </div>
    </div>
  );
}
