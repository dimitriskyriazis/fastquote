'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { CellValueChangedEvent, ColDef, GridApi, RowNode } from 'ag-grid-community';
import styles from './AddProductsModal.module.css';
import { showToastMessage } from '../../../../lib/toast';
import { priceListStatusClassRules } from '../../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../../lib/localeNumber';

const AgGridAll = dynamic(() => import('../../../components/AgGridAll'), { ssr: false });

type Props = {
  offerId: string;
  onClose: () => void;
  onAdded: (inserted: number) => void;
  showRequestedColumns?: boolean;
  splitViewMode?: boolean;
  onRequestAddProduct?: () => void;
  newProductId?: number | null;
  onClearNewProductId?: () => void;
  onRequestPayloadConsumed?: () => void;
  refreshToken?: number;
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
  UnitPrice?: number | string | null;
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

const resolveRequestedRowLabel = (row: RequestedRow, showRequestedItemNo: boolean): string => {
  const candidates = [
    row.RequestedDescription,
    row.RequestedDescription2,
    row.RequestedPartNo,
    row.RequestedModelNo,
    row.RequestedBrand,
    ...(showRequestedItemNo ? [row.RequestedItemNo] : []),
    row.TreeOrdering,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return 'Requested item';
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

const DescriptionCellRenderer = ({ value }: { value?: unknown }) => {
  const [expanded, setExpanded] = useState(false);
  const text = value == null ? '' : String(value);
  const hasLongText = text.length > 60;
  const toggle = (event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    setExpanded((v) => !v);
  };
  return (
    <div className={styles.descriptionCell}>
      <div className={styles.descriptionText} data-expanded={expanded}>
        {text}
      </div>
      {hasLongText ? (
        <button type="button" className={styles.descriptionToggle} onClick={toggle}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      ) : null}
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
  showRequestedColumns = true,
  splitViewMode = false,
  onRequestAddProduct,
  newProductId,
  onClearNewProductId,
  onRequestPayloadConsumed,
  refreshToken,
}: Props) {
  const showRequestedItemNo = Boolean(showRequestedColumns);
  const [selectedCategory, setSelectedCategory] = useState<CategoryRow | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [requestedRows, setRequestedRows] = useState<RequestedRow[]>([]);
  const [requestedRowsLoading, setRequestedRowsLoading] = useState(false);
  const [requestedRowsError, setRequestedRowsError] = useState<string | null>(null);
  const [selectedRequestedRowId, setSelectedRequestedRowId] = useState<number | null>(null);
  const categoryApiRef = useRef<GridApi | null>(null);
  const productsApiRef = useRef<ProductsGridApi | null>(null);
  const requestedRowsFetchIdRef = useRef(0);
  const requestedRowsCacheRef = useRef<Record<number, RequestedRow[]>>({});
  const pendingSelectionProductIdRef = useRef<number | null>(null);

  const categoryRequestPayload = useMemo(() => ({ action: 'categories' }), []);
  const productRequestPayload = useMemo(() => {
    const payload: Record<string, unknown> = { action: 'products' };
    if (newProductId != null) payload.newProductId = newProductId;
    return payload;
  }, [newProductId]);

  const handleCategorySelection = useCallback((rows: CategoryRow[]) => {
    setSelectedCategory(rows[0] ?? null);
  }, []);

  const handleProductSelection = useCallback((rows: ProductRow[]) => {
    setSelectedProducts(rows ?? []);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const endpoint = useMemo(
    () => `/api/offers/${encodeURIComponent(offerId)}/products/add`,
    [offerId],
  );

  const fetchRequestedRows = useCallback(
    async (categoryId: number, options?: { force?: boolean }) => {
      const forceRefresh = Boolean(options?.force);
      if (!forceRefresh) {
        const cached = requestedRowsCacheRef.current[categoryId];
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
      params.set('categoryId', String(categoryId));
      const res = await fetch(
        `/api/offers/${encodeURIComponent(offerId)}/products/requests?${params.toString()}`,
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
        requestedRowsCacheRef.current[categoryId] = rows;
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
    if (categoryId == null) {
      requestedRowsFetchIdRef.current += 1;
      setRequestedRows([]);
      setRequestedRowsError(null);
      setRequestedRowsLoading(false);
      return;
    }
    void fetchRequestedRows(categoryId);
  }, [selectedCategory, fetchRequestedRows]);

  const categoryColumns: ColDef[] = useMemo(
    () => [
      {
        field: 'TreeOrdering',
        headerName: '#',
        width: 50,
        filter: 'agTextColumnFilter',
        sortingOrder: ['asc', 'desc', null],
      },
      {
        field: 'Description',
        headerName: 'Category',
        filter: 'agTextColumnFilter',
      },
    ],
    [],
  );

  const productColumns: ColDef[] = useMemo(
    () => [
      {
        field: 'PartNumber',
        headerName: 'Part Number',
        filter: 'agTextColumnFilter',
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
        cellRenderer: DescriptionCellRenderer,
        editable: true,
        valueParser: (params) => {
          const raw = params.newValue;
          if (raw == null) return null;
          const trimmed = String(raw).trim();
          return trimmed.length > 0 ? trimmed : null;
        },
      },
      { field: 'BrandName', headerName: 'Brand', filter: 'agTextColumnFilter', width: 150 },
      {
        field: 'ModelNumber',
        headerName: 'Model Number',
        filter: 'agTextColumnFilter',
        width: 150,
        editable: true,
        valueParser: (params) => {
          const raw = params.newValue;
          if (raw == null) return null;
          const trimmed = String(raw).trim();
          return trimmed.length > 0 ? trimmed : null;
        },
      },
      { field: 'PriceListName', headerName: 'Price List', filter: 'agTextColumnFilter', width: 170 },
      {
        field: 'ListPrice',
        headerName: 'List Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: (params) => formatEuro(params.value),
        cellClassRules: priceListStatusClassRules(),
      },
      {
        field: 'UnitPrice',
        headerName: 'Unit Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: (params) => formatEuro(params.value),
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      filter: true,
    }),
    [],
  );

  const handleProductCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
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
    const productPayload = selectedProducts
      .map((row, idx) => ({
        productId: row.ProductID,
        sequence: idx + 1,
      }))
      .filter((entry) => entry.productId != null);
    if (!productPayload.length) {
      showToastMessage('Select one or more valid products first', 'info');
      return;
    }
    const isAssigningRequestedRow = selectedRequestedRowId != null;
    if (isAssigningRequestedRow && productPayload.length !== 1) {
      showToastMessage('Select exactly one valid product to fill the requested row', 'info');
      return;
    }
    setSubmitting(true);
    try {
      const baseCategory = selectedCategory?.OfferDetailID ?? null;
      const payload = isAssigningRequestedRow
        ? {
            action: 'assign-requested',
            requestedRowId: selectedRequestedRowId,
            categoryId: baseCategory,
            productId: productPayload[0].productId,
          }
        : {
            action: 'add',
            ...(baseCategory != null ? { categoryId: baseCategory } : {}),
            products: productPayload,
          };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data: { ok?: boolean; inserted?: number; updated?: number; error?: string } | null = null;
      try {
        data = (await res.json()) as { ok?: boolean; inserted?: number; updated?: number; error?: string } | null;
      } catch {
        data = null;
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `Failed to add products (status ${res.status})`);
      }
      const addedCount = isAssigningRequestedRow
        ? 1
        : typeof data.inserted === 'number'
          ? data.inserted
          : productPayload.length;
      showToastMessage(
        isAssigningRequestedRow ? 'Requested item filled' : 'Products added',
        'success',
      );
      onAdded(addedCount);
      if (isAssigningRequestedRow && baseCategory != null) {
        void fetchRequestedRows(baseCategory, { force: true });
      }
      setSelectedRequestedRowId(null);
      setSelectedProducts([]);
      try { productsApiRef.current?.deselectAll?.(); } catch { /* noop */ }
    } catch (err) {
      console.error('Failed to add products to offer', err);
      showToastMessage('Unable to add products. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [
    endpoint,
    fetchRequestedRows,
    onAdded,
    selectedCategory?.OfferDetailID,
    selectedProducts,
    selectedRequestedRowId,
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

  useEffect(() => {
    if (newProductId == null) {
      clearPinnedTopRow();
      // Clear ProductID DESC sort when newProductId is cleared
      const api = productsApiRef.current;
      if (api) {
        const sortModelGetter = api.getSortModel;
        const sortModel = typeof sortModelGetter === 'function' ? sortModelGetter() : [];
        const hasProductIdDesc = sortModel.some(
          (entry: { colId: string; sort: 'asc' | 'desc' }) => entry.colId === 'ProductID' && entry.sort === 'desc',
        );
        if (hasProductIdDesc) {
          // Remove ProductID DESC from sort, keep other sorts
          const filteredSort = sortModel.filter(
            (entry: { colId: string; sort: 'asc' | 'desc' }) => !(entry.colId === 'ProductID' && entry.sort === 'desc'),
          );
          const setter = api.setSortModel;
          if (typeof setter === 'function') {
            setter(filteredSort.length > 0 ? filteredSort : []);
          }
        }
      }
    }
  }, [newProductId, clearPinnedTopRow]);

  useEffect(() => () => {
    clearPinnedTopRow();
  }, [clearPinnedTopRow]);

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

  useEffect(() => {
    if (refreshToken == null) return;
    refreshCategoryGrid();
    refreshProductsGrid();
    const categoryId = selectedCategory?.OfferDetailID ?? null;
    if (categoryId != null) {
      void fetchRequestedRows(categoryId, { force: true });
    }
  }, [
    refreshToken,
    refreshCategoryGrid,
    refreshProductsGrid,
    fetchRequestedRows,
    selectedCategory?.OfferDetailID,
  ]);

  const handleProductsGridReady = useCallback((api: GridApi) => {
    productsApiRef.current = api as ProductsGridApi;
    ensureProductSort();
    trySelectPendingProduct(api as ProductsGridApi);
  }, [ensureProductSort, trySelectPendingProduct]);

  const handleProductsGridModelUpdated = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    ensureProductSort();
    trySelectPendingProduct(api);
  }, [ensureProductSort, trySelectPendingProduct]);

  const selectedCategoryLabel = selectedCategory?.Description?.trim() || selectedCategory?.TreeOrdering || 'None';

  if (splitViewMode) {
    return (
      <div 
        className={styles.splitViewContainer} 
        role="dialog" 
        aria-label="Add products to offer"
        data-fastquote-keep-selection="true"
      >
        <div className={styles.splitViewCard}>
          <div className={styles.header}>
          <div>
            <div className={styles.title}>Add Products</div>
            <div className={styles.subtitle}>Choose a category and pick products to append.</div>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.headerMeta}>
              <div className={styles.headerMetaItem}>
                <span className={styles.headerMetaLabel}>Category:</span>
                <span className={styles.headerMetaValue}>{selectedCategoryLabel}</span>
              </div>
              <div className={styles.headerMetaItem}>
                <span className={styles.headerMetaLabel}>Products selected:</span>
                <span className={styles.headerMetaValue}>{selectedProducts.length}</span>
              </div>
            </div>
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
              disabled={submitting}
            >
              Add {selectedProducts.length > 0 ? `(${selectedProducts.length})` : ''}
            </button>
            <button type="button" className={styles.ghostButton} onClick={onClose} disabled={submitting}>
              Close
            </button>
          </div>
        </div>

        <div className={styles.body}>
          <section className={`${styles.section} ${styles.splitPane}`}>
            <div className={`${styles.sectionInner} ${styles.categoriesColumn}`}>
              <div className={styles.categoryGridShell}>
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={categoryColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={categoryRequestPayload}
                  rowSelection="single"
                  rowDeselection
                  allowRowClickSelection
                  onSelectionChanged={handleCategorySelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  rowGroupPanelShow="never"
                  autoSizeExclusions={['Description']}
                  suppressSideBar
                  onGridReady={(api) => { categoryApiRef.current = api; }}
                />
              </div>
            <div 
              className={styles.requestedSection}
              data-fastquote-keep-selection="true"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className={styles.requestedSectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>Requested Items</div>
                </div>
              </div>
              <div className={styles.requestedList}>
                {!selectedCategory ? (
                  <div className={styles.requestedRowEmpty}>Select a category to view its requested items.</div>
                ) : requestedRowsLoading ? (
                  <div className={styles.requestedRowEmpty}>Loading requested rows…</div>
                ) : requestedRowsError ? (
                  <div className={styles.requestedRowEmpty}>{requestedRowsError}</div>
                ) : requestedRows.length === 0 ? (
                  <div className={styles.requestedRowEmpty}>No requested items found for this category.</div>
                ) : (
                  requestedRows.map((row) => {
                    const isSelected = selectedRequestedRowId === row.OfferDetailID;
                    const metaParts: string[] = [];
                    if (row.TreeOrdering) metaParts.push(`Tree ${row.TreeOrdering}`);
                    if (row.RequestedItemNo && showRequestedItemNo) metaParts.push(`Item ${row.RequestedItemNo}`);
                    if (row.RequestedQuantity != null) metaParts.push(`Qty ${row.RequestedQuantity}`);
                    return (
                      <button
                        type="button"
                        key={row.OfferDetailID}
                        className={`${styles.requestedRow} ${isSelected ? styles.requestedRowSelected : ''}`}
                        aria-pressed={isSelected}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          setSelectedRequestedRowId((prev) => (prev === row.OfferDetailID ? null : row.OfferDetailID));
                        }}
                      >
                        <div className={styles.requestedRowLabel}>
                          {resolveRequestedRowLabel(row, showRequestedItemNo)}
                        </div>
                        <div className={styles.requestedRowMeta}>
                          {metaParts.map((item) => (
                            <span key={item} className={styles.requestedRowMetaItem}>{item}</span>
                          ))}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            </div>

            <div className={`${styles.sectionInner} ${styles.productsColumn}`}>
              <div 
                className={`${styles.productsGridShell} offer-products-grid`}
                data-fastquote-keep-selection="true"
              >
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={productColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={productRequestPayload}
                  cacheBlockSize={200}
                  rowBuffer={40}
                  maxBlocksInCache={10}
                  rowSelection="multiple"
                  rowMultiSelectWithClick
                  rowDeselection
                  allowRowClickSelection
                  rowGroupPanelShow="never"
                  onSelectionChanged={handleProductSelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  autoSizeExclusions={['Description']}
                  onCellValueChanged={handleProductCellEdit}
                  onGridReady={handleProductsGridReady}
                  onModelUpdated={handleProductsGridModelUpdated}
                  onRequestPayloadConsumed={onRequestPayloadConsumed}
                />
              </div>
            </div>
          </section>
        </div>
        </div>
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
    >
      <div className={styles.card}>
        <div className={styles.header}>
          <div>
            <div className={styles.title}>Add Products</div>
            <div className={styles.subtitle}>Choose a category and pick products to append.</div>
          </div>
          <div className={styles.headerActions}>
            <div className={styles.headerMeta}>
              <div className={styles.headerMetaItem}>
                <span className={styles.headerMetaLabel}>Category:</span>
                <span className={styles.headerMetaValue}>{selectedCategoryLabel}</span>
              </div>
              <div className={styles.headerMetaItem}>
                <span className={styles.headerMetaLabel}>Products selected:</span>
                <span className={styles.headerMetaValue}>{selectedProducts.length}</span>
              </div>
            </div>
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
              disabled={submitting}
            >
              Add {selectedProducts.length > 0 ? `(${selectedProducts.length})` : ''}
            </button>
            <button type="button" className={styles.ghostButton} onClick={onClose} disabled={submitting}>
              Close
            </button>
          </div>
        </div>

        <div className={styles.body}>
          <section className={`${styles.section} ${styles.splitPane}`}>
            <div className={`${styles.sectionInner} ${styles.categoriesColumn}`}>
              <div className={styles.categoryGridShell}>
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={categoryColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={categoryRequestPayload}
                  rowSelection="single"
                  rowDeselection
                  allowRowClickSelection
                  onSelectionChanged={handleCategorySelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  rowGroupPanelShow="never"
                  autoSizeExclusions={['Description']}
                  suppressSideBar
                  onGridReady={(api) => { categoryApiRef.current = api; }}
                />
              </div>
            <div 
              className={styles.requestedSection}
              data-fastquote-keep-selection="true"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className={styles.requestedSectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>Requested Items</div>
                </div>
              </div>
              <div className={styles.requestedList}>
                {!selectedCategory ? (
                  <div className={styles.requestedRowEmpty}>Select a category to view its requested items.</div>
                ) : requestedRowsLoading ? (
                  <div className={styles.requestedRowEmpty}>Loading requested rows…</div>
                ) : requestedRowsError ? (
                  <div className={styles.requestedRowEmpty}>{requestedRowsError}</div>
                ) : requestedRows.length === 0 ? (
                  <div className={styles.requestedRowEmpty}>No requested items found for this category.</div>
                ) : (
                  requestedRows.map((row) => {
                    const isSelected = selectedRequestedRowId === row.OfferDetailID;
                    const metaParts: string[] = [];
                    if (row.TreeOrdering) metaParts.push(`Tree ${row.TreeOrdering}`);
                    if (row.RequestedItemNo && showRequestedItemNo) metaParts.push(`Item ${row.RequestedItemNo}`);
                    if (row.RequestedQuantity != null) metaParts.push(`Qty ${row.RequestedQuantity}`);
                    return (
                      <button
                        type="button"
                        key={row.OfferDetailID}
                        className={`${styles.requestedRow} ${isSelected ? styles.requestedRowSelected : ''}`}
                        aria-pressed={isSelected}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          setSelectedRequestedRowId((prev) => (prev === row.OfferDetailID ? null : row.OfferDetailID));
                        }}
                      >
                        <div className={styles.requestedRowLabel}>
                          {resolveRequestedRowLabel(row, showRequestedItemNo)}
                        </div>
                        <div className={styles.requestedRowMeta}>
                          {metaParts.map((item) => (
                            <span key={item} className={styles.requestedRowMetaItem}>{item}</span>
                          ))}
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            </div>

            <div className={`${styles.sectionInner} ${styles.productsColumn}`}>
              <div 
                className={`${styles.productsGridShell} offer-products-grid`}
                data-fastquote-keep-selection="true"
              >
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={productColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={productRequestPayload}
                  cacheBlockSize={200}
                  rowBuffer={40}
                  maxBlocksInCache={10}
                  rowSelection="multiple"
                  rowMultiSelectWithClick
                  rowDeselection
                  allowRowClickSelection
                  rowGroupPanelShow="never"
                  onSelectionChanged={handleProductSelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  autoSizeExclusions={['Description']}
                  onCellValueChanged={handleProductCellEdit}
                  onGridReady={handleProductsGridReady}
                  onModelUpdated={handleProductsGridModelUpdated}
                  onRequestPayloadConsumed={onRequestPayloadConsumed}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
