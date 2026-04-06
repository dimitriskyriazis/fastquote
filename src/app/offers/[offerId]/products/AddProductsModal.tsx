'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { CellValueChangedEvent, ColDef, GridApi, RowNode } from 'ag-grid-community';
import styles from './AddProductsModal.module.css';
import { showToastMessage } from '../../../../lib/toast';
import { priceListStatusClassRules } from '../../../../lib/priceListStatus';
import { getUserNumberLocale } from '../../../../lib/localeNumber';
import { useFarnellSearch, isFarnellRow, type FarnellSearchRow } from '../../../hooks/useFarnellSearch';
import { useFarnellProductResolver } from '../../../hooks/useFarnellProductResolver';
import { isFarnellBrand } from '../offerProductsUtils';

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
}: Props) {
  void _getLastClickedRowId;
  const [selectedCategory] = useState<CategoryRow | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([]);
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
  const categoryRowClickHandlerRef = useRef<((event: { node?: RowNode }) => void) | null>(null);
  const initialRequestedRowConsumedRef = useRef(false);

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
    const payload: Record<string, unknown> = { action: 'products' };
    if (newProductId != null) payload.newProductId = newProductId;
    return payload;
  }, [newProductId]);

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
  }, [placementAnchor, defaultPlacementMode, onPlacementModeChange, clearFarnellResults]);

  // Apply requested data as filters on the products grid when selecting a row to fill.
  // Only update filters when a row is actively selected in "fill" mode — never clear
  // the filter model on deselection or mode switch so that filters persist when the
  // user clicks between rows or stays idle.
  useEffect(() => {
    const api = productsApiRef.current;
    if (!api) return;
    if (defaultPlacementMode === 'fill' && placementAnchor) {
      const { requestedBrand, requestedPartNo, requestedModelNo, requestedDescription } = placementAnchor;
      const hasAnyFilter = requestedBrand || requestedPartNo || requestedModelNo || requestedDescription;
      if (hasAnyFilter) {
        const filterModel: Record<string, { filterType: string; type: string; filter: string }> = {};
        if (requestedPartNo) filterModel.PartNumber = { filterType: 'text', type: 'contains', filter: requestedPartNo };
        if (requestedBrand) filterModel.BrandName = { filterType: 'text', type: 'contains', filter: requestedBrand };
        if (requestedModelNo) filterModel.ModelNumber = { filterType: 'text', type: 'contains', filter: requestedModelNo };
        if (requestedDescription) filterModel.Description = { filterType: 'text', type: 'contains', filter: requestedDescription };
        api.setFilterModel(filterModel);
      } else {
        api.setFilterModel(null);
      }
    }
    // When placementAnchor is null (deselected / between rows) or mode is "below",
    // keep existing filters so they are not erased while the user is idle.
  }, [placementAnchor, defaultPlacementMode]);

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
      try { productsApiRef.current?.setFilterModel?.(null); } catch { /* noop */ }
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

  useEffect(() => () => {
    const api = categoryApiRef.current;
    const handler = categoryRowClickHandlerRef.current;
    if (api && !api.isDestroyed?.() && handler) {
      api.removeEventListener('rowClicked', handler as unknown as (event: unknown) => void);
    }
  }, []);

  // Farnell filter listener
  const filterListenerRef = useRef<(() => void) | null>(null);

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
    };
    filterListenerRef.current = listener;
    try {
      api.addEventListener('filterChanged', listener as never);
    } catch { /* noop */ }
  }, []);

  // Sync Farnell pinned rows
  useEffect(() => {
    const api = productsApiRef.current;
    if (!api) return;
    const setter = api.setPinnedTopRowData;
    if (typeof setter !== 'function') return;
    if (farnellResults.length > 0 && farnellVisible) {
      try { setter(farnellResults as unknown as Record<string, unknown>[]); } catch { /* noop */ }
    } else if (newProductId == null) {
      try { setter([]); } catch { /* noop */ }
    }
  }, [farnellResults, farnellVisible, newProductId]);

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
      <span className={styles.placementText}>Adding product at the end of the list — select a row to fill or click between rows to insert there</span>
    </div>
  );

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
          <div className={styles.title}>Add Products</div>
          {placementIndicator}
          <div className={styles.headerActions}>
            <div className={styles.headerMeta}>
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
            {farnellButtons}
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
            {placementIndicator}
          </div>
          <div className={styles.headerActions}>
            <div className={styles.headerMeta}>
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
            />
          </section>
        </div>
      </div>
    </div>
  );
}
