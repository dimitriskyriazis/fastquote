'use client';

import React, { useMemo, useCallback } from 'react';
import type {
  ColDef,
  ICellRendererParams,
  ValueFormatterParams,
  ValueGetterParams,
  RowClassParams,
  GetContextMenuItemsParams,
  MenuItemDef,
  GridApi,
  CellValueChangedEvent,
} from 'ag-grid-community';
import dynamic from 'next/dynamic';
import styles from './OfferProductsPanel.module.css';
const AgGridAll = dynamic(() => import('../../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading products…
    </div>
  ),
});
import { showToastMessage } from '../../../lib/toast';
import { showConfirmDialog } from '../../../lib/confirm';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment } from '../../../lib/offerProductRows';

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const decimalFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const plainNumberFormatter = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const coerceNumber = (value: unknown) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const formatPercentageValue = (value: unknown) => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  return `${decimalFormatter.format(num)} %`;
};

const formatEuroValue = (value: unknown) => {
  const num = coerceNumber(value);
  if (num == null || Object.is(num, 0)) return '';
  return `${decimalFormatter.format(num)} €`;
};

type FormatterParams = ValueFormatterParams<Record<string, unknown>, unknown>;
const percentageFormatter = ({ value }: FormatterParams) => formatPercentageValue(value);
const euroFormatter = ({ value }: FormatterParams) => formatEuroValue(value);
const zeroBlankNumberFormatter = ({ value }: FormatterParams) => {
  const num = coerceNumber(value);
  if (num == null) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
  }
  if (Object.is(num, 0)) return '';
  return plainNumberFormatter.format(num);
};

const compareTreeOrderingValues = (a: unknown, b: unknown) => {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa && !sb) return 0;  // both empty/null
  if (!sa) return -1;        // empty/null first
  if (!sb) return 1;
  return collator.compare(sa, sb);
};

const parseTreeOrderingPath = (value: unknown): number[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
};

const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const resolveRowLabel = (row: Record<string, unknown> | null | undefined, fallback: string) => {
  if (!row) return fallback;
  const partNumberRaw = (row as { PartNumber?: unknown }).PartNumber;
  const descriptionRaw = (row as { Description?: unknown }).Description;
  const brandRaw = (row as { BrandName?: unknown }).BrandName;
  const normalize = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const partNumber = normalize(partNumberRaw);
  const description = normalize(descriptionRaw);
  if (partNumber && description) return `${partNumber} – ${description}`;
  if (partNumber) return partNumber;
  if (description) return description;
  const brand = normalize(brandRaw);
  return brand || fallback;
};

const normalizeDescriptionValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const buildCategoryAggregateGetter = (field: 'TotalPrice' | 'TotalNet' | 'TotalCost') => (
  params: ValueGetterParams<Record<string, unknown>, unknown>,
) => {
  const rowData = params.data ?? null;
  if (!isOfferProductCategory(rowData)) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  const path = parseTreeOrderingPath((rowData as { TreeOrdering?: string | null })?.TreeOrdering);
  if (path.length === 0 || !params.api) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  let sum = 0;
  let count = 0;
  params.api.forEachNode((node) => {
    if (!node?.data || node === params.node) return;
    const candidateData = node.data as Record<string, unknown>;
    if (!isOfferProductProduct(candidateData)) return;
    const candidatePath = parseTreeOrderingPath((candidateData as { TreeOrdering?: string | null }).TreeOrdering);
    if (candidatePath.length <= path.length) return;
    const isDescendant = path.every((segment, idx) => candidatePath[idx] === segment);
    if (!isDescendant) return;
    const value = coerceNumber((candidateData as Record<string, unknown>)[field]);
    if (value == null) return;
    sum += value;
    count += 1;
  });
  if (count === 0) {
    return (rowData as Record<string, unknown> | undefined)?.[field] ?? null;
  }
  return sum;
};

const categoryTotalPriceGetter = buildCategoryAggregateGetter('TotalPrice');
const categoryTotalNetGetter = buildCategoryAggregateGetter('TotalNet');
const categoryTotalCostGetter = buildCategoryAggregateGetter('TotalCost');

const productAccentCellClassRules = {
  'offer-products-grid__cell--product-accent': (params: { data?: Record<string, unknown> | null }) =>
    isOfferProductProduct(params.data),
};

const deleteRecordMenuIcon = `
  <span class="telquote-menu-icon telquote-menu-icon--danger" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 7L18.2 19.2C18.1 20.8 16.8 22 15.2 22H8.8C7.2 22 5.9 20.8 5.8 19.2L5 7" />
      <path d="M10 11V17" />
      <path d="M14 11V17" />
      <path d="M4 7H20" />
      <path d="M9 7V4.8C9 3.8 9.8 3 10.8 3H13.2C14.2 3 15 3.8 15 4.8V7" />
    </svg>
  </span>
`;

type Props = {
  oID: string;
  endpoint?: string;
  manualMode?: boolean;
  refreshToken?: number;
};

const buildEndpointForOffer = (oID: string) =>
  `/api/offers/${encodeURIComponent(oID)}/products`;

export default function OfferProductsPanel({ oID, endpoint, manualMode = false, refreshToken = 0 }: Props) {
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    return buildEndpointForOffer(oID);
  }, [endpoint, oID]);
  const defaultColDef = useMemo<ColDef>(() => ({
    editable: (params) => isOfferProductComment(params?.data ?? null),
  }), []);

  const getRowClass = useCallback((params: RowClassParams<Record<string, unknown>>) => {
    const rowType = resolveOfferProductRowType(params.data);
    switch (rowType) {
      case 'category':
        return 'offer-row offer-row--category';
      case 'product':
        return 'offer-row offer-row--product';
      case 'printable-comment':
        return 'offer-row offer-row--printable-comment';
      case 'non-printable-comment':
        return 'offer-row offer-row--nonprintable-comment';
      default:
        return undefined;
    }
  }, []);

  // Row drag handle: starts native drag with row data (no visible selection)
  const RowDragHandle = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const sixDots = (
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <circle cx="4" cy="3" r="1.5" fill="currentColor" />
        <circle cx="10" cy="3" r="1.5" fill="currentColor" />
        <circle cx="4" cy="7" r="1.5" fill="currentColor" />
        <circle cx="10" cy="7" r="1.5" fill="currentColor" />
        <circle cx="4" cy="11" r="1.5" fill="currentColor" />
        <circle cx="10" cy="11" r="1.5" fill="currentColor" />
      </svg>
    );
    const preventRangeSelection = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    // Temporary elements/listeners used only during drag
    let previewEl: HTMLElement | null = null; // 1x1 px canvas to hide native ghost
    let overlayEl: HTMLElement | null = null; // in-window ghost that follows cursor
    let cleanupListeners: (() => void) | null = null;
    let dx = 0; // cursor offset within row at drag start
    let dy = 0;
    let dropCleanupHandler: (() => void) | null = null;

    const cleanupDragArtifacts = () => {
      if (cleanupListeners) {
        cleanupListeners();
        cleanupListeners = null;
      }
      document.documentElement.classList.remove('dragging');
      if (previewEl && previewEl.parentNode) {
        previewEl.parentNode.removeChild(previewEl);
      }
      previewEl = null;
      if (overlayEl && overlayEl.parentNode) {
        overlayEl.parentNode.removeChild(overlayEl);
      }
      overlayEl = null;
      if (dropCleanupHandler && typeof window !== 'undefined') {
        window.removeEventListener('telquote-row-drop', dropCleanupHandler);
      }
      dropCleanupHandler = null;
    };

    const onDragStart = (e: React.DragEvent) => {
      // Provide row identity/data for drop targets so TreeOrdering can be recomputed client-side
      const resolvedRowIndex = typeof params.node?.rowIndex === 'number'
        ? params.node.rowIndex
        : null;

      const payload = {
        type: 'offer-product-row',
        rowId: params.node?.id ?? null,
        rowIndex: resolvedRowIndex,
        data: params.data ?? null,
      };
      try {
        e.dataTransfer.setData('application/x-telquote-row+json', JSON.stringify(payload));
      } catch { /* noop */ }
      try {
        e.dataTransfer.setData('text/plain', JSON.stringify(payload));
      } catch { /* noop */ }
      e.dataTransfer.effectAllowed = 'move';
      // Hide the native OS drag ghost so we can render our own overlay inside the window only
      const px = document.createElement('canvas');
      px.width = 1; px.height = 1;
      px.style.position = 'absolute';
      px.style.top = '-10000px';
      px.style.left = '-10000px';
      document.body.appendChild(px);
      previewEl = px;
      try { e.dataTransfer.setDragImage(px, 0, 0); } catch { /* noop */ }

      // Create an in-window overlay that mirrors the dragged row and follows the cursor
      const handle = e.currentTarget as HTMLElement;
      const rowEl = handle.closest('.ag-row') as HTMLElement | null;
      if (rowEl) {
        const rect = rowEl.getBoundingClientRect();
        dx = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        dy = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
        const clone = rowEl.cloneNode(true) as HTMLElement;
        clone.style.position = 'fixed';
        clone.style.pointerEvents = 'none';
        clone.style.top = '0';
        clone.style.left = '0';
        clone.style.width = `${rect.width}px`;
        clone.style.height = `${rect.height}px`;
        clone.style.transform = `translate(${e.clientX - dx}px, ${e.clientY - dy}px)`;
        clone.style.zIndex = '999999';
        clone.style.background = getComputedStyle(rowEl).backgroundColor || '#ffffff';
        clone.style.boxShadow = '0 8px 24px rgba(15, 23, 42, 0.16)';
        clone.classList.add('drag-overlay-row');
        document.body.appendChild(clone);
        overlayEl = clone;
      }

      // While dragging, mark the whole document as a valid drop target to avoid the OS "not-allowed" cursor
      const handler: EventListener = (evt: Event) => {
        const ev = evt as DragEvent;
        ev.preventDefault();
        try { if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'; } catch { /* noop */ }
        if (overlayEl) {
          const x = Math.max(0, ev.clientX - dx);
          const y = Math.max(0, ev.clientY - dy);
          overlayEl.style.transform = `translate(${x}px, ${y}px)`;
        }
      };
      const opts: AddEventListenerOptions = { capture: true };
      document.addEventListener('dragover', handler, opts);
      document.addEventListener('dragenter', handler, opts);
      window.addEventListener('dragover', handler, opts);
      document.body.addEventListener('dragover', handler, opts);
      cleanupListeners = () => {
        document.removeEventListener('dragover', handler, opts);
        document.removeEventListener('dragenter', handler, opts);
        window.removeEventListener('dragover', handler, opts);
        document.body.removeEventListener('dragover', handler, opts);
      };
      document.documentElement.classList.add('dragging');

      if (typeof window !== 'undefined') {
        dropCleanupHandler = () => {
          cleanupDragArtifacts();
        };
        window.addEventListener('telquote-row-drop', dropCleanupHandler);
      }
    };

    return (
      <div className={styles.dragCellWrapper} onMouseDownCapture={preventRangeSelection} onPointerDownCapture={preventRangeSelection}>
        <button
          type="button"
          aria-label="Drag row"
          title="Drag row"
          className={styles.dragButton}
          draggable
          onDragStart={onDragStart}
          onMouseDownCapture={preventRangeSelection}
          onPointerDownCapture={preventRangeSelection}
          onDragEnd={(e) => {
            e.stopPropagation();
            cleanupDragArtifacts();
          }}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDoubleClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onMouseDown={(e) => { e.stopPropagation(); }}
        >
          {sixDots}
        </button>
      </div>
    );
  }, []);

  const PartNumberCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const rawValue = params.value;
    if (rawValue == null) return '';
    const partNumber = String(rawValue).trim();
    if (!partNumber) return '';

    const rawLink = (params.data as { WebLink?: string | null } | undefined)?.WebLink;
    const normalizedLink = typeof rawLink === 'string' ? rawLink.trim() : '';
    if (!normalizedLink) return partNumber;

    const stop = (event: React.SyntheticEvent) => {
      event.stopPropagation();
    };

    return (
      <a
        href={normalizedLink}
        target="_blank"
        rel="noreferrer noopener"
        className={styles.partNumberLink}
        onClick={stop}
        onMouseDown={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
        title="Open product link"
      >
        {partNumber}
      </a>
    );
  }, []);

  const productColumnDefs: ColDef[] = useMemo(() => [
    {
      headerName: '',
      colId: '__row_drag__',
      lockPosition: true,
      suppressMovable: true,
      suppressSizeToFit: true,
      suppressColumnsToolPanel: true,
      resizable: false,
      sortable: false,
      filter: false,
      maxWidth: 52,
      minWidth: 40,
      width: 44,
      cellStyle: { padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      cellRenderer: RowDragHandle,
    },
    {
      field: 'TreeOrdering',
      headerName: '#',
      maxWidth: 90,
      filter: 'agTextColumnFilter',
      type: 'numericColumn',
      comparator: compareTreeOrderingValues,
      sort: 'asc',
      sortingOrder: ['asc', 'desc', null],
      sortIndex: 0,
      editable: manualMode,
      singleClickEdit: manualMode,
    },
    {
      field: 'BrandName',
      headerName: 'Brand',
      filter: 'agTextColumnFilter',
      cellClassRules: productAccentCellClassRules,
    },
    {
      field: 'PartNumber',
      headerName: 'Part Number',
      filter: 'agTextColumnFilter',
      cellRenderer: PartNumberCell,
    },
    { field: 'ModelNumber', headerName: 'Model Number', filter: 'agTextColumnFilter' },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: zeroBlankNumberFormatter,
    },
    {
      field: 'Description',
      headerName: 'Description',
      minWidth: 280,
      width: 320,
      filter: 'agTextColumnFilter',
      editable: true,
      singleClickEdit: true,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Customer Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: percentageFormatter,
    },
    {
      field: 'NetUnitPrice',
      headerName: 'Net Unit Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: euroFormatter,
    },
    {
      field: 'TotalPrice',
      headerName: 'Total List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueGetter: categoryTotalPriceGetter,
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
    },
    {
      field: 'TotalNet',
      headerName: 'Total Net',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueGetter: categoryTotalNetGetter,
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
    },
    {
      field: 'Warranty',
      headerName: 'Warranty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: zeroBlankNumberFormatter,
    },
    {
      field: 'ListPrice',
      headerName: 'List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: euroFormatter,
    },
    {
      field: 'TelmacoDiscount',
      headerName: 'Telmaco Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: percentageFormatter,
    },
    {
      field: 'NetCost',
      headerName: 'Net Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: euroFormatter,
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: percentageFormatter,
    },
    {
      field: 'GrossProfit',
      headerName: 'Gross Profit',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: euroFormatter,
      cellClassRules: productAccentCellClassRules,
    },
    {
      field: 'TotalCost',
      headerName: 'Total Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: euroFormatter,
      valueGetter: categoryTotalCostGetter,
      cellClassRules: productAccentCellClassRules,
    },
  ], [RowDragHandle, PartNumberCell, manualMode]);

  const deleteRow = useCallback(async (
    offerDetailId: number,
    rowData: Record<string, unknown> | null,
    api: GridApi<Record<string, unknown>> | null,
  ) => {
    const fallbackLabel = `record #${offerDetailId}`;
    const rowLabel = resolveRowLabel(rowData, fallbackLabel);
    const rowType = resolveOfferProductRowType(rowData);
    const typeLabel = rowType === 'category'
      ? 'category'
      : rowType === 'product'
        ? 'product'
        : rowType === 'printable-comment' || rowType === 'non-printable-comment'
          ? 'comment'
          : 'record';
    const confirmed = await showConfirmDialog({
      title: 'Delete record',
      message: `Delete ${typeLabel} ${rowLabel}? This action cannot be undone.`,
      confirmLabel: 'Delete record',
      cancelLabel: 'Keep record',
      tone: 'danger',
    });
    if (!confirmed) return;
    try {
      const res = await fetch(resolvedEndpoint, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ OfferDetailIDs: [offerDetailId] }),
      });
      let payload: { ok?: boolean; error?: string } | null = null;
      try {
        payload = (await res.json()) as { ok?: boolean; error?: string } | null;
      } catch {
        payload = null;
      }
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to delete record (status ${res.status})`);
      }
      showToastMessage('Record deleted', 'success');
      try {
        api?.refreshServerSide?.({ purge: true });
      } catch (err) {
        console.warn('Failed to refresh products after deletion', err);
      }
    } catch (err) {
      console.error('Failed to delete record', err);
      showToastMessage('Unable to delete record. Please try again.', 'error');
    }
  }, [resolvedEndpoint]);

  const productContextMenuItems = useCallback((
    params: GetContextMenuItemsParams<Record<string, unknown>>,
  ) => {
    const baseItems = Array.isArray(params.defaultItems) ? [...params.defaultItems] : [];
    const rowData = params.node?.data as Record<string, unknown> | null | undefined;
    const rawId = (rowData as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null;
    const offerDetailId = normalizeOfferDetailId(rawId);
    if (offerDetailId == null) {
      return baseItems;
    }
    const nextItems: Array<MenuItemDef | string> = [...baseItems];
    if (nextItems.length > 0 && nextItems[nextItems.length - 1] !== 'separator') {
      nextItems.push('separator');
    }
    const deleteItem: MenuItemDef = {
      name: 'Delete record',
      icon: deleteRecordMenuIcon,
      action: () => {
        void deleteRow(offerDetailId, rowData ?? null, params.api ?? null);
      },
    };
    nextItems.push(deleteItem);
    return nextItems;
  }, [deleteRow]);

  const handleDescriptionEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Description') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    const normalizedOldValue = normalizeDescriptionValue(event.oldValue);
    const normalizedNewValue = normalizeDescriptionValue(event.newValue);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }
    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update description. Missing record identifier.', 'error');
      event.node?.setDataValue?.('Description', normalizedOldValue ?? '');
      return;
    }
    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Description', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
    };
    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            updates: [{ OfferDetailID: offerDetailId, Description: normalizedNewValue }],
          }),
        });
        let payload: { ok?: boolean; error?: string } | null = null;
        try {
          payload = (await res.json()) as { ok?: boolean; error?: string } | null;
        } catch {
          payload = null;
        }
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update description (status ${res.status})`);
        }
        showToastMessage('Description updated', 'success');
      } catch (err) {
        console.error('Failed to update description', err);
        showToastMessage('Unable to update description. Please try again.', 'error');
        revertValue();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint]);

  return (
    <div className={styles.panel}>
      <div className={`${styles.gridWrapper} offer-products-grid`}>
        <AgGridAll
          endpoint={resolvedEndpoint}
          columnDefs={productColumnDefs}
          defaultColDef={defaultColDef}
          manualMode={manualMode}
          getRowClass={getRowClass}
          getContextMenuItems={productContextMenuItems}
          onCellValueChanged={handleDescriptionEdit}
          refreshToken={refreshToken}
          autoSizeExclusions={['Description']}
        />
      </div>
    </div>
  );
}
