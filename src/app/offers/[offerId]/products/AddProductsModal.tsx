'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { ColDef, GridApi } from 'ag-grid-community';
import styles from './AddProductsModal.module.css';
import { showToastMessage } from '../../../../lib/toast';
import { priceListStatusClassRules } from '../../../../lib/priceListStatus';

const AgGridAll = dynamic(() => import('../../../components/AgGridAll'), { ssr: false });

type Props = {
  offerId: string;
  onClose: () => void;
  onAdded: (inserted: number) => void;
  showRequestedColumns?: boolean;
  splitViewMode?: boolean;
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

const currencyFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const formatEuro = (value: unknown) => {
  if (value == null) return '';
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return String(value);
  return `${currencyFormatter.format(num)} €`;
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

export default function AddProductsModal({
  offerId,
  onClose,
  onAdded,
  showRequestedColumns = true,
  splitViewMode = false,
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
  const productsApiRef = useRef<GridApi | null>(null);
  const requestedRowsFetchIdRef = useRef(0);
  const requestedRowsCacheRef = useRef<Record<number, RequestedRow[]>>({});

  const categoryRequestPayload = useMemo(() => ({ action: 'categories' }), []);
  const productRequestPayload = useMemo(() => ({ action: 'products' }), []);

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
      { field: 'PartNumber', headerName: 'Part Number', filter: 'agTextColumnFilter', width: 170 },
      {
        field: 'Description',
        headerName: 'Description',
        filter: 'agTextColumnFilter',
        cellRenderer: DescriptionCellRenderer,
      },
      { field: 'BrandName', headerName: 'Brand', filter: 'agTextColumnFilter', width: 150 },
      { field: 'ModelNumber', headerName: 'Model Number', filter: 'agTextColumnFilter', width: 150 },
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
              <div className={styles.sectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>Categories</div>
                  <div className={styles.selectedBadge}>
                    Selected: <span className={styles.selectedValue}>{selectedCategoryLabel}</span>
                  </div>
                </div>
              </div>
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
              <div className={styles.sectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>Products (multi-select)</div>
                </div>
                <div className={styles.selectedBadge}>
                  Selected products: <span className={styles.selectedValue}>{selectedProducts.length}</span>
                </div>
              </div>
              <div 
                className={`${styles.productsGridShell} offer-products-grid`}
                data-fastquote-keep-selection="true"
              >
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={productColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={productRequestPayload}
                  rowSelection="multiple"
                  rowMultiSelectWithClick
                  rowDeselection
                  allowRowClickSelection
                  rowGroupPanelShow="never"
                  onSelectionChanged={handleProductSelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  autoSizeExclusions={['Description']}
                  onGridReady={(api) => { productsApiRef.current = api; }}
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
              <div className={styles.sectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>Categories</div>
                  <div className={styles.selectedBadge}>
                    Selected: <span className={styles.selectedValue}>{selectedCategoryLabel}</span>
                  </div>
                </div>
              </div>
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
              <div className={styles.sectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>Products (multi-select)</div>
                </div>
                <div className={styles.selectedBadge}>
                  Selected products: <span className={styles.selectedValue}>{selectedProducts.length}</span>
                </div>
              </div>
              <div 
                className={`${styles.productsGridShell} offer-products-grid`}
                data-fastquote-keep-selection="true"
              >
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={productColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={productRequestPayload}
                  rowSelection="multiple"
                  rowMultiSelectWithClick
                  rowDeselection
                  allowRowClickSelection
                  rowGroupPanelShow="never"
                  onSelectionChanged={handleProductSelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                  autoSizeExclusions={['Description']}
                  onGridReady={(api) => { productsApiRef.current = api; }}
                />
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
