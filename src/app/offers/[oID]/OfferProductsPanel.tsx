'use client';

import React, { useMemo, type CSSProperties, useCallback } from 'react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import dynamic from 'next/dynamic';
const AgGridAll = dynamic(() => import('../../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' }}>
      Loading products…
    </div>
  ),
});

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const compareTreeOrderingValues = (a: unknown, b: unknown) => {
  const sa = String(a ?? '').trim();
  const sb = String(b ?? '').trim();
  if (!sa && !sb) return 0;  // both empty/null
  if (!sa) return -1;        // empty/null first
  if (!sb) return 1;
  return collator.compare(sa, sb);
};

type Props = {
  oID: string;
  endpoint?: string;
  manualMode?: boolean;
};

const panelContainerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
};

const productsGridWrapperStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: '100%',
  display: 'flex',
};

const buildEndpointForOffer = (oID: string) =>
  `/api/offers/${encodeURIComponent(oID)}/products`;

export default function OfferProductsPanel({ oID, endpoint, manualMode = false }: Props) {
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    return buildEndpointForOffer(oID);
  }, [endpoint, oID]);

  // Row drag handle: starts native drag with row data (no visible selection)
  const RowDragHandle = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    const wrapperStyle: CSSProperties = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      userSelect: 'none',
    };

    const buttonStyle: CSSProperties = {
      background: 'transparent',
      border: 'none',
      outline: 'none',
      width: 28,
      height: 28,
      padding: 0,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      cursor: 'grab',
      color: '#9ca3af', // neutral gray similar to the mock
      appearance: 'none',
    };

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
      <div style={wrapperStyle}>
        <button
          type="button"
          aria-label="Drag row"
          title="Drag row"
          style={buttonStyle}
          className="drag-handle"
          draggable
          onDragStart={onDragStart}
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
      cellClassRules: {
        'brand-product-cell': (params) => Boolean((params.data as { BrandName?: string | null })?.BrandName),
      },
    },
    { field: 'PartNumber', headerName: 'Part Number', filter: 'agTextColumnFilter' },
    { field: 'ModelNumber', headerName: 'Model', filter: 'agTextColumnFilter' },
    { field: 'Quantity', headerName: 'Qty', filter: 'agNumberColumnFilter' },
    { field: 'Description', headerName: 'Description', minWidth: 220, filter: 'agTextColumnFilter' },
    { field: 'CustomerDiscount', headerName: 'Customer Discount', filter: 'agNumberColumnFilter' },
    { field: 'NetUnitPrice', headerName: 'Net Unit', filter: 'agNumberColumnFilter' },
    { field: 'TotalPrice', headerName: 'Total Price', filter: 'agNumberColumnFilter' },
    { field: 'TotalNet', headerName: 'Total Net', filter: 'agNumberColumnFilter' },
    { field: 'Warranty', headerName: 'Warranty', filter: 'agTextColumnFilter' },
    { field: 'ListPrice', headerName: 'List Price', filter: 'agNumberColumnFilter' },
    { field: 'TelmacoDiscount', headerName: 'Telmaco Discount', filter: 'agNumberColumnFilter' },
    { field: 'NetCost', headerName: 'Net Cost', filter: 'agNumberColumnFilter' },
    { field: 'Margin', headerName: 'Margin', filter: 'agNumberColumnFilter' },
    { field: 'GrossProfit', headerName: 'Gross Profit', filter: 'agNumberColumnFilter' },
    { field: 'TotalCost', headerName: 'Total Cost', filter: 'agNumberColumnFilter' },
  ], [RowDragHandle, manualMode]);

  return (
    <div style={panelContainerStyle}>
      <div style={productsGridWrapperStyle} className="offer-products-grid">
        <AgGridAll
          endpoint={resolvedEndpoint}
          columnDefs={productColumnDefs}
          manualMode={manualMode}
        />
      </div>
    </div>
  );
}
