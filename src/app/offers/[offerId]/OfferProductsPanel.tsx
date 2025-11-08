'use client';

import React, { useMemo, type CSSProperties } from 'react';
import type { ColDef } from 'ag-grid-community';
import AgGridAll from '../../components/AgGridAll';

type Props = {
  offerId: string;
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

const buildEndpointForOffer = (offerId: string) =>
  `/api/offers/${encodeURIComponent(offerId)}/products`;

export default function OfferProductsPanel({ offerId, endpoint }: Props) {
  const resolvedEndpoint = useMemo(() => {
    if (endpoint) return endpoint;
    if (!offerId) return null;
    return buildEndpointForOffer(offerId);
  }, [endpoint, offerId]);

  const productColumnDefs: ColDef[] = useMemo(() => [
    { field: 'TreeOrdering', headerName: '#', maxWidth: 90, filter: 'agNumberColumnFilter' },
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
