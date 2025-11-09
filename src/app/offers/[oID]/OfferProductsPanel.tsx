'use client';

import React, { useMemo, type CSSProperties } from 'react';
import type { ColDef } from 'ag-grid-community';
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

const emptyStateStyle: CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: '#475569',
  fontSize: '14px',
};

const buildEndpointForOffer = (oID: string) =>
  `/api/offers/${encodeURIComponent(oID)}/products`;

export default function OfferProductsPanel({ oID, endpoint }: Props) {
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    if (!oID) return null;
    return buildEndpointForOffer(oID);
  }, [endpoint, oID]);

  const productColumnDefs: ColDef[] = useMemo(() => [
    {
      field: 'TreeOrdering',
      headerName: '#',
      maxWidth: 90,
      filter: 'agTextColumnFilter',
      comparator: compareTreeOrderingValues,
    },
    { field: 'BrandName', headerName: 'Brand', filter: 'agTextColumnFilter' },
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
  ], []);

  return (
    <div style={panelContainerStyle}>
      <div style={productsGridWrapperStyle}>
        {resolvedEndpoint ? (
          <AgGridAll endpoint={resolvedEndpoint} columnDefs={productColumnDefs} />
        ) : (
          <div style={emptyStateStyle}>
            Select a valid offer to load products.
          </div>
        )}
      </div>
    </div>
  );
}
