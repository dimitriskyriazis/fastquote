'use client';

import React, { useMemo, useCallback, useState, useRef, useEffect } from 'react';
import type {
  ColDef,
  ICellRendererParams,
  ValueFormatterParams,
  ValueGetterParams,
  RowClassParams,
  GetContextMenuItemsParams,
  CellValueChangedEvent,
  GridApi,
  MenuItemDef,
  RowDoubleClickedEvent,
  RowHeightParams,
} from 'ag-grid-community';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import styles from './OfferProductsPanel.module.css';
import type { GridTotals } from '../../components/AgGridAll';

const AgGridAll = dynamic(() => import('../../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div className={styles.loading}>
      Loading products…
    </div>
  ),
});
import { showToastMessage } from '../../../lib/toast';
import { GridRowDeletion } from '../../../lib/gridRowDeletion';
import { resolveOfferProductRowType, isOfferProductProduct, isOfferProductCategory, isOfferProductComment } from '../../../lib/offerProductRows';
import { priceListStatusClassRules } from '../../../lib/priceListStatus';

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

const buildTreeOrderingKey = (segments: number[]) => segments.join('.');

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

const resolveOfferProductTypeLabel = (row: Record<string, unknown> | null | undefined) => {
  const rowType = resolveOfferProductRowType(row);
  if (rowType === 'category') return 'category';
  if (rowType === 'product') return 'product';
  if (rowType === 'printable-comment' || rowType === 'non-printable-comment') return 'comment';
  return 'record';
};

const normalizeDescriptionValue = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const isOfferProductCommentOrProduct = (row: Record<string, unknown> | null | undefined) =>
  isOfferProductProduct(row) || isOfferProductComment(row);

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
    if (!isOfferProductCommentOrProduct(candidateData)) return;
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

const roundMoney = (value: number, places = 4) => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

const recalcProductTotals = (
  event: CellValueChangedEvent<Record<string, unknown>>,
  quantityOverride?: number | null,
) => {
  const node = event.node;
  const data = event.data;
  if (!node || !data) return;

  const quantity = quantityOverride ?? coerceNumber((data as { Quantity?: unknown }).Quantity) ?? 0;
  const listPrice = coerceNumber((data as { ListPrice?: unknown }).ListPrice);
  const netUnitPrice = coerceNumber((data as { NetUnitPrice?: unknown }).NetUnitPrice);
  const netCost = coerceNumber((data as { NetCost?: unknown }).NetCost);

  const setValue = (field: 'TotalPrice' | 'TotalNet' | 'TotalCost' | 'GrossProfit', value: number | null) => {
    try {
      node.setDataValue(field, value);
    } catch {
      /* noop */
    }
  };

  setValue('TotalPrice', listPrice != null ? roundMoney(listPrice * quantity) : null);
  setValue('TotalNet', netUnitPrice != null ? roundMoney(netUnitPrice * quantity) : null);
  setValue('TotalCost', netCost != null ? roundMoney(netCost * quantity) : null);
  setValue(
    'GrossProfit',
    netUnitPrice != null && netCost != null ? roundMoney((netUnitPrice - netCost) * quantity) : null,
  );
};

const CATEGORY_TOTAL_COLUMNS: string[] = ['TotalPrice', 'TotalNet', 'TotalCost'];
const refreshCategoryAggregates = (api?: GridApi<Record<string, unknown>> | null) => {
  if (!api || typeof api.refreshCells !== 'function') return;
  try {
    api.refreshCells({ columns: CATEGORY_TOTAL_COLUMNS, force: true });
  } catch (err) {
    console.warn('Failed to refresh category aggregates', err);
  }
};

const categoryTotalPriceGetter = buildCategoryAggregateGetter('TotalPrice');
const categoryTotalNetGetter = buildCategoryAggregateGetter('TotalNet');
const categoryTotalCostGetter = buildCategoryAggregateGetter('TotalCost');

const productHistoryMenuIcon = `
  <span class="fastquote-menu-icon fastquote-menu-icon--history" aria-hidden="true">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 5a7 7 0 1 1-7 7" />
      <path d="M12 9v4l2.6 1.5" />
      <path d="M5 7 4 4l3 1" />
    </svg>
  </span>
`;

const productAccentCellClassRules = {
  'offer-products-grid__cell--product-accent': (params: { data?: Record<string, unknown> | null }) =>
    isOfferProductProduct(params.data),
};

const productPriceListClassRules = priceListStatusClassRules((params) =>
  isOfferProductProduct(params.data) ? params.data : null,
);

const totalPriceCellClassRules = {
  ...productAccentCellClassRules,
  ...productPriceListClassRules,
};

const PRICING_FIELD_LABELS: Record<string, string> = {
  CustomerDiscount: 'Customer Discount',
  NetUnitPrice: 'Net Unit Price',
  TelmacoDiscount: 'Telmaco Discount',
  NetCost: 'Net Cost',
  Margin: 'Margin',
  ListPrice: 'List Price',
};

const PRICING_EDITABLE_FIELDS = new Set(Object.keys(PRICING_FIELD_LABELS));

type Props = {
  oID: string;
  endpoint?: string;
  manualMode?: boolean;
  refreshToken?: number;
};

const buildEndpointForOffer = (oID: string) =>
  `/api/offers/${encodeURIComponent(oID)}/products`;

export default function OfferProductsPanel({ oID, endpoint, manualMode = false, refreshToken = 0 }: Props) {
  const router = useRouter();
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    return buildEndpointForOffer(oID);
  }, [endpoint, oID]);
  const [totals, setTotals] = useState<{ totalListPrice: number; totalNetPrice: number; totalCost: number; totalMargin: number } | null>(null);
  const gridApiRef = useRef<GridApi<Record<string, unknown>> | null>(null);
  const [collapsedCategoryPaths, setCollapsedCategoryPaths] = useState<Set<string>>(() => new Set());
  const [categoryPathsWithChildren, setCategoryPathsWithChildren] = useState<Set<string>>(() => new Set());
  const [categoryChildrenKnown, setCategoryChildrenKnown] = useState(false);

  const defaultColDef = useMemo<ColDef>(() => ({
    editable: (params) => isOfferProductComment(params?.data ?? null),
  }), []);

  const handleTotalsChange = useCallback((payload: GridTotals | null) => {
    if (!payload) {
      setTotals(null);
      return;
    }
    const totalNetPrice = payload.totalNetPrice ?? 0;
    const totalListPrice = payload.totalListPrice ?? 0;
    const totalCost = payload.totalCost ?? 0;
    const marginBasis = Object.is(totalNetPrice, 0) ? 0 : totalNetPrice;
    const totalMargin = marginBasis === 0 ? 0 : ((totalNetPrice - totalCost) / marginBasis) * 100;
    setTotals((prev) => {
      if (
        prev
        && Object.is(prev.totalNetPrice, totalNetPrice)
        && Object.is(prev.totalListPrice, totalListPrice)
        && Object.is(prev.totalCost, totalCost)
        && Object.is(prev.totalMargin, totalMargin)
      ) {
        return prev;
      }
      return { totalNetPrice, totalListPrice, totalCost, totalMargin };
    });
  }, []);

  const updateCategoryAncestors = useCallback((api: GridApi<Record<string, unknown>>) => {
    const next = new Set<string>();
    let nodesSeen = false;
    api.forEachNode((node) => {
      if (!node.data) return;
      const data = node.data as Record<string, unknown>;
      nodesSeen = true;
      const path = parseTreeOrderingPath((data as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
      for (let idx = 1; idx < path.length; idx += 1) {
        const ancestorKey = buildTreeOrderingKey(path.slice(0, idx));
        if (ancestorKey) {
          next.add(ancestorKey);
        }
      }
    });
    setCategoryPathsWithChildren((prev) => {
      if (prev.size === next.size) {
        let identical = true;
        for (const value of prev) {
          if (!next.has(value)) {
            identical = false;
            break;
          }
        }
        if (identical) return prev;
      }
      return next;
    });
    setCollapsedCategoryPaths((prev) => {
      let changed = false;
      const nextCollapsed = new Set(prev);
      for (const value of prev) {
        if (!next.has(value)) {
          nextCollapsed.delete(value);
          changed = true;
        }
      }
      return changed ? nextCollapsed : prev;
    });
    if (nodesSeen) {
      setCategoryChildrenKnown(true);
    }
  }, []);

  const handleGridReady = useCallback((api: GridApi<Record<string, unknown>>) => {
    gridApiRef.current = api;
    updateCategoryAncestors(api);
  }, [updateCategoryAncestors]);

  useEffect(() => {
    const api = gridApiRef.current;
    if (api) {
      api.resetRowHeights();
      api.redrawRows();
      updateCategoryAncestors(api);
    }
  }, [collapsedCategoryPaths, updateCategoryAncestors]);

  const isRowHiddenByCollapsedAncestor = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!row) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    for (let idx = 1; idx < path.length; idx += 1) {
      const ancestorKey = buildTreeOrderingKey(path.slice(0, idx));
      if (ancestorKey && collapsedCategoryPaths.has(ancestorKey)) {
        return true;
      }
    }
    return false;
  }, [collapsedCategoryPaths]);

  const isCategoryRowCollapsed = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!row) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    return key.length > 0 && collapsedCategoryPaths.has(key);
  }, [collapsedCategoryPaths]);

  const hasCategoryChildren = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return false;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return false;
    const key = buildTreeOrderingKey(path);
    if (!categoryChildrenKnown) return true;
    return key.length > 0 && categoryPathsWithChildren.has(key);
  }, [categoryChildrenKnown, categoryPathsWithChildren]);

  const toggleCategoryCollapsed = useCallback((row: Record<string, unknown> | null | undefined) => {
    if (!isOfferProductCategory(row)) return;
    if (!hasCategoryChildren(row)) return;
    const path = parseTreeOrderingPath((row as { TreeOrdering?: string | null })?.TreeOrdering ?? null);
    if (path.length === 0) return;
    const key = buildTreeOrderingKey(path);
    if (!key) return;
    setCollapsedCategoryPaths((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, [hasCategoryChildren]);

  const getRowClass = useCallback((params: RowClassParams<Record<string, unknown>>) => {
    const rowType = resolveOfferProductRowType(params.data);
    let baseClass: string | undefined;
    switch (rowType) {
      case 'category':
        baseClass = 'offer-row offer-row--category';
        break;
      case 'product':
        baseClass = 'offer-row offer-row--product';
        break;
      case 'printable-comment':
        baseClass = 'offer-row offer-row--printable-comment';
        break;
      case 'non-printable-comment':
        baseClass = 'offer-row offer-row--nonprintable-comment';
        break;
      default:
        baseClass = undefined;
    }
    if (!baseClass) return undefined;
    const classes = [baseClass];
    if (rowType === 'category') {
      if (isCategoryRowCollapsed(params.data)) {
        classes.push('offer-row--category-collapsed');
      }
      if (!hasCategoryChildren(params.data)) {
        classes.push('offer-row--category-empty');
      }
    }
    if (isRowHiddenByCollapsedAncestor(params.data)) {
      classes.push('offer-row--collapsed-child');
    }
    return classes.join(' ');
  }, [isCategoryRowCollapsed, isRowHiddenByCollapsedAncestor, hasCategoryChildren]);

  const handleRowDoubleClicked = useCallback((params: RowDoubleClickedEvent<Record<string, unknown>>) => {
    toggleCategoryCollapsed(params.data ?? null);
  }, [toggleCategoryCollapsed]);

  const handleGridModelUpdated = useCallback((api: GridApi<Record<string, unknown>>) => {
    updateCategoryAncestors(api);
  }, [updateCategoryAncestors]);

  const TreeOrderingCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const value = params.value;
    const rowData = params.data ?? null;
    const isCategory = isOfferProductCategory(rowData);
    const hasChildren = isCategory && hasCategoryChildren(rowData);
    const collapsed = isCategory && isCategoryRowCollapsed(rowData);
    const indicator = isCategory
      ? hasChildren
        ? (collapsed ? '▸' : '▾')
        : '•'
      : null;
    const indicatorClass = isCategory
      ? hasChildren
        ? `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorArrow}`
        : `${styles.treeOrderingIndicator} ${styles.treeOrderingIndicatorEmpty}`
      : undefined;

    const handleIndicatorClick = (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      if (hasChildren) {
        toggleCategoryCollapsed(rowData);
      }
    };

    const indicatorLabel = hasChildren
      ? (collapsed ? 'Expand category' : 'Collapse category')
      : 'Category without child entries';

    return (
      <span className={styles.treeOrderingCell}>
        <span>{value ?? ''}</span>
        {indicator && (
          <button
            type="button"
            className={`${styles.treeOrderingIndicatorButton} ${indicatorClass ?? ''}`.trim()}
            onClick={handleIndicatorClick}
            aria-label={indicatorLabel}
            disabled={!hasChildren}
          >
            {indicator}
          </button>
        )}
      </span>
    );
  }, [hasCategoryChildren, isCategoryRowCollapsed, toggleCategoryCollapsed]);

  const getRowHeight = useCallback((params: RowHeightParams<Record<string, unknown>>) => (
    isRowHiddenByCollapsedAncestor(params.data) ? 0 : 32
  ), [isRowHiddenByCollapsedAncestor]);

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
        window.removeEventListener('fastquote-row-drop', dropCleanupHandler);
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
        e.dataTransfer.setData('application/x-fastquote-row+json', JSON.stringify(payload));
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
        window.addEventListener('fastquote-row-drop', dropCleanupHandler);
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
      field: 'ProductID',
      hide: true,
      lockVisible: true,
      suppressColumnsToolPanel: true,
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
      cellRenderer: TreeOrderingCell,
      cellClass: 'offer-products-tree-ordering-cell',
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
      field: 'Description',
      headerName: 'Description',
      minWidth: 280,
      width: 320,
      filter: 'agTextColumnFilter',
      editable: (params) => {
        const row = params?.data ?? null;
        return isOfferProductCategory(row) || isOfferProductComment(row);
      },
      singleClickEdit: true,
    },
    {
      field: 'ListPrice',
      headerName: 'List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: productPriceListClassRules,
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
    },
    {
      field: 'CustomerDiscount',
      headerName: 'Customer Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: percentageFormatter,
    },
    {
      field: 'NetUnitPrice',
      headerName: 'Net Unit Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: euroFormatter,
    },
    {
      field: 'Quantity',
      headerName: 'Qty',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: zeroBlankNumberFormatter,
    },
    {
      field: 'TotalPrice',
      headerName: 'Total List Price',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      valueGetter: categoryTotalPriceGetter,
      valueFormatter: (params) => {
        if (!isOfferProductCommentOrProduct(params.data ?? null)) return '';
        return euroFormatter(params);
      },
      cellClassRules: totalPriceCellClassRules,
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
      field: 'TelmacoDiscount',
      headerName: 'Telmaco Discount',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: percentageFormatter,
    },
    {
      field: 'NetCost',
      headerName: 'Net Cost',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
      valueFormatter: euroFormatter,
    },
    {
      field: 'Margin',
      headerName: 'Margin',
      filter: 'agNumberColumnFilter',
      type: 'numericColumn',
      editable: (params) => isOfferProductCommentOrProduct(params.data ?? null),
      singleClickEdit: true,
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
  ], [RowDragHandle, PartNumberCell, manualMode, TreeOrderingCell]);

  const productRowDeletion = useMemo(
    () =>
      new GridRowDeletion<Record<string, unknown>>({
        endpoint: resolvedEndpoint,
        resolveRowId: (row) =>
          normalizeOfferDetailId((row as { OfferDetailID?: unknown } | null | undefined)?.OfferDetailID ?? null),
        resolveRowLabel,
        resolveRowTypeLabel: resolveOfferProductTypeLabel,
        buildPayload: (ids) => ({ OfferDetailIDs: ids }),
        confirmTitle: 'Delete row',
        confirmConfirmLabel: 'Delete row',
        confirmCancelLabel: 'Keep row',
        successToastMessage: 'Row deleted',
        failureToastMessage: 'Unable to delete row. Please try again.',
      }),
    [resolvedEndpoint],
  );

  const productContextMenuItems = useCallback((
    params: GetContextMenuItemsParams<Record<string, unknown>>,
  ) => {
    const baseItems = productRowDeletion.getContextMenuItems(params) ?? [];
    const items = [...baseItems];
    const rowData = params.node?.data ?? null;
    if (!isOfferProductProduct(rowData)) {
      return items;
    }

    const rawProductId = (rowData as { ProductID?: unknown }).ProductID;
    const productId =
      typeof rawProductId === 'number'
        ? rawProductId
        : typeof rawProductId === 'string'
          ? Number.parseInt(rawProductId, 10)
          : null;
    if (!productId || !Number.isInteger(productId)) {
      return items;
    }

    const qs = new URLSearchParams();
    qs.set('backHref', `/offers/${encodeURIComponent(oID)}/products`);
    qs.set('backLabel', `offer ${oID}`);

    const historyItem: MenuItemDef = {
      name: "View Product's History",
      icon: productHistoryMenuIcon,
      action: () => {
        router.push(`/products/${encodeURIComponent(String(productId))}/history?${qs.toString()}`);
      },
    };

    const deleteIndex = items.findIndex((item) => (
      typeof item === 'object'
      && item != null
      && (item as MenuItemDef).name === 'Delete row'
    ));

    if (deleteIndex >= 0) {
      items.splice(deleteIndex, 0, historyItem);
      return items;
    }

    items.push(historyItem);
    return items;
  }, [productRowDeletion, router, oID]);

  const handleQuantityEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Quantity') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
      if (!isOfferProductCommentOrProduct(event.data)) {
        try {
          event.node?.setDataValue?.('Quantity', event.oldValue ?? '');
        } catch {
          /* noop */
        }
      return;
    }

    const normalizedOldValue = coerceNumber(event.oldValue);
    const normalizedNewValue = coerceNumber(event.newValue);
    if (normalizedNewValue == null || normalizedNewValue < 0) {
      showToastMessage('Please enter a valid quantity (zero or more).', 'error');
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }
    if (normalizedOldValue != null && Object.is(normalizedOldValue, normalizedNewValue)) {
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage('Unable to update quantity. Missing record identifier.', 'error');
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
      } catch {
        /* noop */
      }
      return;
    }

    const revertValue = () => {
      try {
        event.node?.setDataValue?.('Quantity', normalizedOldValue ?? '');
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
            updates: [{ OfferDetailID: offerDetailId, Quantity: normalizedNewValue }],
          }),
        });
        let payload: { ok?: boolean; error?: string } | null = null;
        try {
          payload = (await res.json()) as { ok?: boolean; error?: string } | null;
        } catch {
          payload = null;
        }
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update quantity (status ${res.status})`);
        }
        showToastMessage('Quantity updated', 'success');
        try {
          event.api?.refreshServerSide?.({ purge: false });
        } catch (refreshErr) {
          console.warn('Failed to refresh grid after quantity update', refreshErr);
        }
        recalcProductTotals(event, normalizedNewValue);
        refreshCategoryAggregates(event.api);
      } catch (err) {
        console.error('Failed to update quantity', err);
        showToastMessage('Unable to update quantity. Please try again.', 'error');
        revertValue();
      }
    };
    void runUpdate();
  }, [resolvedEndpoint]);

  const handleDescriptionEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    if (event.colDef.field !== 'Description') return;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;
    const normalizedOldValue = normalizeDescriptionValue(event.oldValue);
    const normalizedNewValue = normalizeDescriptionValue(event.newValue);
    if (normalizedOldValue === normalizedNewValue) {
      return;
    }
    if (isOfferProductProduct(event.data)) {
      event.node?.setDataValue?.('Description', normalizedOldValue ?? '');
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

  const handlePricingEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    const field = event.colDef.field;
    if (!field || !PRICING_EDITABLE_FIELDS.has(field)) return;
    const label = PRICING_FIELD_LABELS[field] ?? field;
    const source = (event as { source?: string }).source;
    if (source === 'api') return;

    if (!isOfferProductCommentOrProduct(event.data)) {
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      showToastMessage('Pricing can only be edited on product or comment rows.', 'error');
      return;
    }

    const offerDetailId = normalizeOfferDetailId((event.data as { OfferDetailID?: unknown } | undefined)?.OfferDetailID ?? null);
    if (offerDetailId == null) {
      showToastMessage(`Unable to update ${label}. Missing record identifier.`, 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }

    const normalizedNewValue = coerceNumber(event.newValue);
    if (normalizedNewValue == null || !Number.isFinite(normalizedNewValue)) {
      showToastMessage(`Please enter a valid ${label.toLowerCase()}.`, 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }
    if (field === 'Margin' && Math.abs(normalizedNewValue) >= 100) {
      showToastMessage('Margin must be between -100 and 100.', 'error');
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
      return;
    }

    const normalizedOldValue = coerceNumber(event.oldValue);
    if (normalizedOldValue != null && Object.is(normalizedOldValue, normalizedNewValue)) {
      return;
    }

    const revertValue = () => {
      try { event.node?.setDataValue?.(field, event.oldValue ?? ''); } catch { /* noop */ }
    };

    const runUpdate = async () => {
      try {
        const res = await fetch(resolvedEndpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates: [{ OfferDetailID: offerDetailId, [field]: normalizedNewValue }] }),
        });
        const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to update ${label} (status ${res.status})`);
        }
        showToastMessage(`${label} updated`, 'success');
        try {
          event.api?.refreshServerSide?.({ purge: false });
        } catch (refreshErr) {
          console.warn('Failed to refresh grid after pricing update', refreshErr);
        }
        recalcProductTotals(event);
        refreshCategoryAggregates(event.api);
      } catch (err) {
        console.error(`Failed to update ${label}`, err);
        showToastMessage(`Unable to update ${label}. Please try again.`, 'error');
        revertValue();
      }
    };

    void runUpdate();
  }, [resolvedEndpoint]);

  const handleCellEdit = useCallback((event: CellValueChangedEvent<Record<string, unknown>>) => {
    handleDescriptionEdit(event);
    handleQuantityEdit(event);
    handlePricingEdit(event);
  }, [handleDescriptionEdit, handleQuantityEdit, handlePricingEdit]);

  const formatEuroTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} €`;
  };
  const formatPercentTotal = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${decimalFormatter.format(value)} %`;
  };

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
          onCellValueChanged={handleCellEdit}
          refreshToken={refreshToken}
          onGridReady={handleGridReady}
          onRowDoubleClicked={handleRowDoubleClicked}
          autoSizeExclusions={['Description']}
          onTotalsChange={handleTotalsChange}
          rowGroupPanelShow="never"
          onModelUpdated={handleGridModelUpdated}
          getRowHeight={getRowHeight}
        />
      </div>
      <div className={styles.totalsBar}>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>Total Net Price</span>
          <span className={styles.totalValue}>{formatEuroTotal(totals?.totalNetPrice)}</span>
        </div>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>Total List Price</span>
          <span className={styles.totalValue}>{formatEuroTotal(totals?.totalListPrice)}</span>
        </div>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>Total Cost</span>
          <span className={styles.totalValue}>{formatEuroTotal(totals?.totalCost)}</span>
        </div>
        <div className={styles.totalItem}>
          <span className={styles.totalLabel}>Total Margin</span>
          <span className={styles.totalValue}>{formatPercentTotal(totals?.totalMargin)}</span>
        </div>
      </div>
    </div>
  );
}
