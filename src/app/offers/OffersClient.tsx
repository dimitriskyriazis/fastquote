"use client";

import React, { useMemo, useCallback, useState, useEffect, useRef, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import dynamic from 'next/dynamic';
const AgGridAll = dynamic(() => import('../components/AgGridAll'), {
  ssr: false,
  loading: () => (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#475569' }}>
      Loading grid…
    </div>
  ),
});
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { createPortal } from 'react-dom';

const mainStyle: CSSProperties = {
  padding: '16px',
  boxSizing: 'border-box',
  height: '100vh',
  width: '100%',
  maxWidth: '100vw',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  overflow: 'hidden',
};

const headingStyle: CSSProperties = {
  margin: 0,
  fontSize: '24px',
};

export default function OffersClient() {
  const router = useRouter();

  const ActionCell = useCallback((params: ICellRendererParams<Record<string, unknown>>) => {
    // A small React component for the action menu
    const ActionMenu: React.FC = () => {
      const [open, setOpen] = useState(false);
      const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
      const btnRef = useRef<HTMLButtonElement | null>(null);
      const id = params?.data?.oID as string | number | undefined;
      const encodedId = id != null ? encodeURIComponent(String(id)) : '';

      const go = (suffix: 'products' | 'basic') => {
        if (!encodedId) return;
        router.push(`/offers/${encodedId}/${suffix}`);
      };

      const wrapperStyle: CSSProperties = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        height: '100%',
        position: 'relative',
      };

      const buttonStyle: CSSProperties = {
        border: '1px solid var(--border-subtle)',
        background: 'transparent',
        borderRadius: '6px',
        padding: '2px',
        cursor: encodedId ? 'pointer' : 'not-allowed',
        color: 'inherit',
        fontSize: '12px',
        width: 24,
        height: 24,
        appearance: 'none',
      };

      const menuStyle: CSSProperties = {
        position: 'fixed',
        top: menuPos?.top ?? 0,
        left: menuPos?.left ?? 0,
        background: '#ffffff',
        color: '#0f172a',
        border: '1px solid rgba(15, 23, 42, 0.12)',
        borderRadius: '8px',
        boxShadow: '0 12px 32px rgba(15, 23, 42, 0.12)',
        zIndex: 9999,
        minWidth: '160px',
        overflow: 'hidden',
      };

      const itemStyle: CSSProperties = {
        display: 'block',
        width: '100%',
        textAlign: 'left',
        border: 'none',
        padding: '5px 9px',
        cursor: 'pointer',
        fontSize: '12px',
        lineHeight: 1.2,
      };
      const preventRangeSelection = (event: React.SyntheticEvent) => {
        event.stopPropagation();
      };

      useEffect(() => {
        if (!open) return;
        const rect = btnRef.current?.getBoundingClientRect();
        if (rect) {
          setMenuPos({ top: rect.bottom + 6, left: rect.left });
        }
        const onDocClick = (e: MouseEvent) => {
          if (!btnRef.current) return setOpen(false);
          if (e.target instanceof Node && btnRef.current.contains(e.target)) return;
          setOpen(false);
        };
        window.addEventListener('click', onDocClick);
        return () => window.removeEventListener('click', onDocClick);
      }, [open]);

      const lines = (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="3" y="4" width="10" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="3" y="7.25" width="10" height="1.5" rx="0.75" fill="currentColor"/>
          <rect x="3" y="10.5" width="10" height="1.5" rx="0.75" fill="currentColor"/>
        </svg>
      );

      // No native listeners needed; React capture handler on the button is sufficient

      return (
        <div
          style={wrapperStyle}
          onMouseDownCapture={preventRangeSelection}
          onPointerDownCapture={preventRangeSelection}
        >
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            style={buttonStyle}
            className="offers-action-btn"
            onClick={() => setOpen(v => !v)}
            onMouseDownCapture={preventRangeSelection}
            onPointerDownCapture={preventRangeSelection}
            onContextMenuCapture={(e) => { e.preventDefault(); e.stopPropagation(); }}
            disabled={!encodedId}
            title={encodedId ? 'Open menu' : 'Missing oID'}
            ref={btnRef}
          >
            {lines}
          </button>
          {open && menuPos && createPortal(
            <div role="menu" style={menuStyle} className="offers-action-menu" onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}>
              <button
                type="button"
                role="menuitem"
                style={itemStyle}
                className="offers-action-item"
                onClick={() => go('products')}
              >
                View Products
              </button>
              <button
                type="button"
                role="menuitem"
                style={itemStyle}
                className="offers-action-item"
                onClick={() => go('basic')}
              >
                View Basic Data
              </button>
            </div>,
            document.body
          )}
        </div>
      );
    };

    return <ActionMenu />;
  }, [router]);

  const columnDefs: ColDef[] = useMemo(() => [
    {
      headerName: '',
      field: '__actions__',
      pinned: 'left',
      lockPinned: true,
      lockPosition: true,
      suppressNavigable: true,
      resizable: false,
      sortable: false,
      filter: false,
      suppressMovable: true,
      suppressSizeToFit: true,
      suppressColumnsToolPanel: true,
      maxWidth: 52,
      minWidth: 44,
      width: 48,
      cellStyle: { padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' },
      cellRenderer: ActionCell,
    },
    { field: 'Description', headerName: 'Description', filter: 'agTextColumnFilter' },
    { field: 'Title', headerName: 'Title', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'CustomerName', headerName: 'Customer Name', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'PricingPolicyName', headerName: 'Pricing Policy', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesMarket', headerName: 'Market', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesDivision', headerName: 'Sales Division', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesPerson', headerName: 'Sales Creation Person', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'OfferStatus', headerName: 'Status', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'ProjectID', headerName: 'Project ID', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    { field: 'oID', headerName: 'Offer ID', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    { field: 'CustomerRef', headerName: 'Customer Ref', filter: 'agTextColumnFilter' },
    { field: 'ProtocolNo', headerName: 'Protocol No', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    { field: 'OfferContact', headerName: 'Contact', filter: 'agTextColumnFilter' },
    { field: 'OfferVersion', headerName: 'Offer Version', filter: 'agNumberColumnFilter', type: 'numericColumn' },
    {
      field: 'Enabled',
      headerName: 'Enabled',
      filter: 'agSetColumnFilter',
      filterParams: {
        values: ['true', 'false'],
        comparator: (valueA: string, valueB: string) => (valueA === valueB ? 0 : valueA === 'true' ? -1 : 1),
      },
      enableRowGroup: true,
    },
  ], [ActionCell]);

  return (
    <main style={mainStyle}>
      <h1 style={headingStyle}>Offers</h1>
      <AgGridAll endpoint="/api/offers" columnDefs={columnDefs} />
    </main>
  );
}
