'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import type { ColDef, GridApi } from 'ag-grid-community';
import styles from './AddProductsModal.module.css';
import { showToastMessage } from '../../../../lib/toast';
import { priceListStatusClassRules } from '../../../../lib/priceListStatus';

const AgGridAll = dynamic(() => import('../../../components/AgGridAll'), { ssr: false });

type Props = {
  oID: string;
  onClose: () => void;
  onAdded: (inserted: number) => void;
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

export default function AddProductsModal({ oID, onClose, onAdded }: Props) {
  const [selectedCategory, setSelectedCategory] = useState<CategoryRow | null>(null);
  const [selectedProducts, setSelectedProducts] = useState<ProductRow[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const categoryApiRef = useRef<GridApi | null>(null);
  const productsApiRef = useRef<GridApi | null>(null);

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
    () => `/api/offers/${encodeURIComponent(oID)}/products/add`,
    [oID],
  );

  const categoryColumns: ColDef[] = useMemo(
    () => [
      {
        field: 'TreeOrdering',
        headerName: '#',
        width: 90,
        filter: 'agTextColumnFilter',
        sortingOrder: ['asc', 'desc', null],
      },
      {
        field: 'Description',
        headerName: 'Category',
        flex: 1,
        minWidth: 220,
        filter: 'agTextColumnFilter',
      },
    ],
    [],
  );

  const productColumns: ColDef[] = useMemo(
    () => [
      { field: 'PartNumber', headerName: 'Part Number', filter: 'agTextColumnFilter', width: 170, minWidth: 140 },
      {
        field: 'Description',
        headerName: 'Description',
        flex: 1,
        minWidth: 260,
        filter: 'agTextColumnFilter',
        suppressAutoSize: true,
        cellRenderer: DescriptionCellRenderer,
      },
      { field: 'BrandName', headerName: 'Brand', filter: 'agTextColumnFilter', width: 150, minWidth: 120 },
      { field: 'ModelNumber', headerName: 'Model Number', filter: 'agTextColumnFilter', width: 150, minWidth: 130 },
      { field: 'PriceListName', headerName: 'Price List', filter: 'agTextColumnFilter', width: 170, minWidth: 140 },
      {
        field: 'ListPrice',
        headerName: 'List Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: (params) => formatEuro(params.value),
        width: 140,
        cellClassRules: priceListStatusClassRules(),
      },
      {
        field: 'UnitPrice',
        headerName: 'Unit Price',
        filter: 'agNumberColumnFilter',
        type: 'numericColumn',
        valueFormatter: (params) => formatEuro(params.value),
        width: 140,
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
    if (!selectedCategory?.OfferDetailID) {
      showToastMessage('Select a category first', 'info');
      return;
    }
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
    setSubmitting(true);
    try {
      const payload = {
        action: 'add',
        categoryId: selectedCategory.OfferDetailID,
        products: productPayload,
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      let data: { ok?: boolean; inserted?: number; error?: string } | null = null;
      try {
        data = (await res.json()) as { ok?: boolean; inserted?: number; error?: string } | null;
      } catch {
        data = null;
      }
      if (!res.ok || !data?.ok) {
        throw new Error(data?.error ?? `Failed to add products (status ${res.status})`);
      }
      const inserted = typeof data.inserted === 'number' ? data.inserted : selectedProducts.length;
      showToastMessage('Products added', 'success');
      onAdded(inserted);
      // keep modal open for faster multi-category adds; clear selections
      setSelectedProducts([]);
      try { productsApiRef.current?.deselectAll?.(); } catch { /* noop */ }
    } catch (err) {
      console.error('Failed to add products to offer', err);
      showToastMessage('Unable to add products. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [endpoint, onAdded, selectedCategory?.OfferDetailID, selectedProducts]);

  const selectedCategoryLabel = selectedCategory?.Description?.trim() || selectedCategory?.TreeOrdering || 'None';

  return (
    <div className={styles.overlay} role="dialog" aria-modal="true" aria-label="Add products to offer">
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
                  <div className={styles.sectionTitle}>Categories (select one)</div>
                  <div className={styles.sectionHint}>Showing current offer categories (scroll for more).</div>
                </div>
                <div className={styles.selectedBadge}>
                  Selected: <span className={styles.selectedValue}>{selectedCategoryLabel}</span>
                </div>
              </div>
              <div className={styles.categoryGridShell}>
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={categoryColumns}
                  defaultColDef={defaultColDef}
                requestPayload={categoryRequestPayload}
                rowSelection="single"
                onSelectionChanged={handleCategorySelection as (rows: Record<string, unknown>[], api: GridApi) => void}
                rowGroupPanelShow="never"
                autoSizeExclusions={['Description']}
                onGridReady={(api) => { categoryApiRef.current = api; }}
              />
            </div>
            </div>

            <div className={`${styles.sectionInner} ${styles.productsColumn}`}>
              <div className={styles.sectionHeader}>
                <div>
                  <div className={styles.sectionTitle}>Products (multi-select)</div>
                  <div className={styles.sectionHint}>Filter and select products to add. List price colors show price list status.</div>
                </div>
                <div className={styles.selectedBadge}>
                  Selected products: <span className={styles.selectedValue}>{selectedProducts.length}</span>
                </div>
              </div>
              <div className={`${styles.productsGridShell} offer-products-grid`}>
                <AgGridAll
                  endpoint={endpoint}
                  columnDefs={productColumns}
                  defaultColDef={defaultColDef}
                  requestPayload={productRequestPayload}
                rowSelection="multiple"
                rowMultiSelectWithClick
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
