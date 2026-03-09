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
}: ProductsGridPanelProps) {
  return (
    <div className={`${styles.sectionInner} ${styles.productsColumn}`}>
      <div
        className={`${styles.productsGridShell} offer-products-grid`}
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
          rowSelection="multiple"
          rowMultiSelectWithClick
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
  showRequestedColumns = true,
  splitViewMode = false,
  onRequestAddProduct,
  newProductId,
  onClearNewProductId,
  onRequestPayloadConsumed,
  refreshToken,
  initialRequestedRowId,
  onInitialRequestedRowConsumed,
}: Props) {
  const showRequestedItemNo = Boolean(showRequestedColumns);
  const [selectedCategory, setSelectedCategory] = useState<CategoryRow | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [comment, setComment] = useState('');
  const [requestedRows, setRequestedRows] = useState<RequestedRow[]>([]);
  const [requestedRowsLoading, setRequestedRowsLoading] = useState(false);
  const [requestedRowsError, setRequestedRowsError] = useState<string | null>(null);
  const [selectedRequestedRowId, setSelectedRequestedRowId] = useState<number | null>(null);
  const categoryApiRef = useRef<GridApi | null>(null);
  const productsApiRef = useRef<ProductsGridApi | null>(null);
  const requestedRowsFetchIdRef = useRef(0);
  const requestedRowsCacheRef = useRef<Record<string, RequestedRow[]>>({});
  const pendingSelectionProductIdRef = useRef<number | null>(null);
  const categoryRowClickHandlerRef = useRef<((event: { node?: RowNode }) => void) | null>(null);
  const requestedListRef = useRef<HTMLDivElement | null>(null);
  const initialRequestedRowConsumedRef = useRef(false);
  const categoryGridShellRef = useRef<HTMLDivElement | null>(null);
  const categoryLastScrollTopRef = useRef(0);
  const pendingCategoryScrollRestoreRef = useRef<number | null>(null);

  const getCategoryViewport = useCallback((): HTMLElement | null => {
    const root = categoryGridShellRef.current;
    if (!root) return null;
    return root.querySelector('.ag-body-viewport, .ag-center-cols-viewport');
  }, []);
  const queueCategoryViewportScrollRestore = useCallback((scrollTop: number) => {
    categoryLastScrollTopRef.current = scrollTop;
    if (scrollTop === 0) return;
    pendingCategoryScrollRestoreRef.current = scrollTop;
  }, []);
  const flushCategoryViewportScrollRestore = useCallback(() => {
    const pending = pendingCategoryScrollRestoreRef.current;
    if (pending == null) return;
    pendingCategoryScrollRestoreRef.current = null;
    const nextViewport = getCategoryViewport();
    if (!nextViewport) return;
    if (Math.abs(nextViewport.scrollTop - pending) <= 1) return;
    nextViewport.scrollTop = pending;
  }, [getCategoryViewport]);
  const categoryRequestPayload = useMemo(() => ({ action: 'categories' }), []);
  const productRequestPayload = useMemo(() => {
    const payload: Record<string, unknown> = { action: 'products' };
    if (newProductId != null) payload.newProductId = newProductId;
    return payload;
  }, [newProductId]);

  const handleCategorySelection = useCallback((rows: CategoryRow[]) => {
    const viewport = getCategoryViewport();
    const scrollTop = viewport?.scrollTop ?? 0;
    categoryLastScrollTopRef.current = scrollTop;
    setSelectedCategory(rows[0] ?? null);
    queueCategoryViewportScrollRestore(scrollTop);
  }, [getCategoryViewport, queueCategoryViewportScrollRestore]);

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
      // Scroll to the matched item in the requested list
      requestAnimationFrame(() => {
        const container = requestedListRef.current;
        if (!container) return;
        const button = container.querySelector(`[data-requested-id="${match.OfferDetailID}"]`);
        if (button) {
          button.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    }
  }, [initialRequestedRowId, requestedRows, requestedRowsLoading, onInitialRequestedRowConsumed]);

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
        width: 375,
      },
    ],
    [],
  );

  const productColumns: ColDef[] = useMemo(() => {
    const columns: ColDef[] = [
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
    ];
    if (!standardPackageMode) {
      columns.push(
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
      const insertionAnchor = !isAssigningRequestedRow
        ? (getInsertionAnchor?.() ?? null)
        : null;
      const baseCategory = selectedCategory?.OfferDetailID ?? null;
      const trimmedComment = comment.trim() || undefined;
      const payload = isAssigningRequestedRow
        ? {
            action: 'assign-requested',
            requestedRowId: selectedRequestedRowId,
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
      if (!isAssigningRequestedRow && insertionAnchor) {
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
        }
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
      if (isAssigningRequestedRow) {
        void fetchRequestedRows(baseCategory, { force: true });
      }
      setSelectedRequestedRowId(null);
      setSelectedProducts([]);
      setComment('');
      try { productsApiRef.current?.deselectAll?.(); } catch { /* noop */ }
    } catch (err) {
      console.error('Failed to add products to offer', err);
      showToastMessage('Unable to add products. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [
    comment,
    endpoint,
    fetchRequestedRows,
    getInsertionAnchor,
    onAdded,
    offerId,
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

  const selectedCategoryIdRef = useRef<number | null>(null);
  selectedCategoryIdRef.current = selectedCategory?.OfferDetailID ?? null;

  useEffect(() => {
    if (refreshToken == null) return;
    refreshCategoryGrid();
    refreshProductsGrid();
    void fetchRequestedRows(selectedCategoryIdRef.current, { force: true });
  }, [refreshToken, refreshCategoryGrid, refreshProductsGrid, fetchRequestedRows]);

  const handleCategoryGridReady = useCallback((api: GridApi) => {
    const previousApi = categoryApiRef.current;
    const existingHandler = categoryRowClickHandlerRef.current;
    if (previousApi && existingHandler) {
      previousApi.removeEventListener('rowClicked', existingHandler as unknown as (event: unknown) => void);
    }
    categoryApiRef.current = api;
    const handler = existingHandler ?? ((event: { node?: RowNode }) => {
      const node = event?.node;
      if (!node) return;
      const viewport = getCategoryViewport();
      const scrollTop = viewport?.scrollTop ?? 0;
      categoryLastScrollTopRef.current = scrollTop;
      if (node.isSelected()) {
        node.setSelected(false, true);
        queueCategoryViewportScrollRestore(scrollTop);
        return;
      }
      node.setSelected(true, true);
      queueCategoryViewportScrollRestore(scrollTop);
    });
    categoryRowClickHandlerRef.current = handler;
    api.addEventListener('rowClicked', handler as unknown as (event: unknown) => void);
  }, [getCategoryViewport, queueCategoryViewportScrollRestore]);

  useEffect(() => () => {
    const api = categoryApiRef.current;
    const handler = categoryRowClickHandlerRef.current;
    if (api && !api.isDestroyed?.() && handler) {
      api.removeEventListener('rowClicked', handler as unknown as (event: unknown) => void);
    }
  }, []);

  const handleProductsGridReady = useCallback((api: GridApi) => {
    productsApiRef.current = api as ProductsGridApi;
    ensureProductSort();
    trySelectPendingProduct(api as ProductsGridApi);
  }, [ensureProductSort, trySelectPendingProduct]);

  const handleCategoryGridModelUpdated = useCallback(() => {
    flushCategoryViewportScrollRestore();
  }, [flushCategoryViewportScrollRestore]);

  const handleProductsGridModelUpdated = useCallback(() => {
    const api = productsApiRef.current;
    if (!api) return;
    ensureProductSort();
    trySelectPendingProduct(api);
  }, [ensureProductSort, trySelectPendingProduct]);

  const selectedCategoryLabel = selectedCategory?.Description?.trim() || selectedCategory?.TreeOrdering || 'All';

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
            <div className={styles.subtitle}>Pick products to append. Category is optional.</div>
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
            {selectedProducts.length === 1 ? (
              <>
                <label className={styles.commentLabel}>Comment:</label>
                <input
                  type="text"
                  className={styles.commentInput}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  disabled={submitting}
                  placeholder=""
                  data-fastquote-keep-selection="true"
                />
              </>
            ) : null}
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
              <div className={styles.categoryGridShell} ref={categoryGridShellRef}>
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={categoryColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={categoryRequestPayload}
                  rowSelection="single"
                  rowDeselection
                  suppressRowClickSelection
                  onSelectionChanged={handleCategorySelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  rowGroupPanelShow="never"
                  autoSizeExclusions={['Description']}
                  suppressSideBar
                  allowCellSelectionInPerformanceMode={false}
                  onGridReady={handleCategoryGridReady}
                  onModelUpdated={handleCategoryGridModelUpdated}
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
              <div className={styles.requestedList} ref={requestedListRef}>
                {requestedRowsLoading ? (
                  <div className={styles.requestedRowEmpty}>Loading requested rows...</div>
                ) : requestedRowsError ? (
                  <div className={styles.requestedRowEmpty}>{requestedRowsError}</div>
                ) : requestedRows.length === 0 ? (
                  <div className={styles.requestedRowEmpty}>No requested items found.</div>
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
                        data-requested-id={row.OfferDetailID}
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
            />
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
            <div className={styles.subtitle}>Pick products to append. Category is optional.</div>
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
            {selectedProducts.length === 1 ? (
              <>
                <label className={styles.commentLabel}>Comment:</label>
                <input
                  type="text"
                  className={styles.commentInput}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  disabled={submitting}
                  placeholder=""
                  data-fastquote-keep-selection="true"
                />
              </>
            ) : null}
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
              <div className={styles.categoryGridShell} ref={categoryGridShellRef}>
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={categoryColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={categoryRequestPayload}
                  rowSelection="single"
                  rowDeselection
                  suppressRowClickSelection
                  onSelectionChanged={handleCategorySelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  rowGroupPanelShow="never"
                  autoSizeExclusions={['Description']}
                  suppressSideBar
                  allowCellSelectionInPerformanceMode={false}
                  onGridReady={handleCategoryGridReady}
                  onModelUpdated={handleCategoryGridModelUpdated}
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
              <div className={styles.requestedList} ref={requestedListRef}>
                {requestedRowsLoading ? (
                  <div className={styles.requestedRowEmpty}>Loading requested rows...</div>
                ) : requestedRowsError ? (
                  <div className={styles.requestedRowEmpty}>{requestedRowsError}</div>
                ) : requestedRows.length === 0 ? (
                  <div className={styles.requestedRowEmpty}>No requested items found.</div>
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
                        data-requested-id={row.OfferDetailID}
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
            />
          </section>
        </div>
      </div>
    </div>
  );
}
