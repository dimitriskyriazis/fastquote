'use client';

import React, { useMemo, type CSSProperties } from 'react';
import type { ColDef } from 'ag-grid-community';
import AgGridAll from '../../components/AgGridAll';

type TreeOrderingParseResult = {
  rawValue: string;
  isNumeric: boolean;
  segments: number[];
};

const parseTreeOrderingValue = (value: unknown): TreeOrderingParseResult => {
  if (value === null || value === undefined) {
    return { rawValue: '', isNumeric: false, segments: [] };
  }

  const raw = String(value).trim();
  if (!raw) {
    return { rawValue: '', isNumeric: false, segments: [] };
  }

  const segments = raw.split('.').map(segment => {
    const parsed = Number(segment);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  });

  const isNumeric = segments.every(Number.isFinite);
  return {
    rawValue: raw,
    isNumeric,
    segments: isNumeric ? segments : [],
  };
};

const compareTreeOrderingValues = (valueA: unknown, valueB: unknown) => {
  if (valueA == null && valueB == null) {
    return 0;
  }
  if (valueA == null) {
    return -1;
  }
  if (valueB == null) {
    return 1;
  }

  const parsedA = parseTreeOrderingValue(valueA);
  const parsedB = parseTreeOrderingValue(valueB);

  if (!parsedA.rawValue && !parsedB.rawValue) {
    return 0;
  }
  if (!parsedA.rawValue) {
    return -1;
  }
  if (!parsedB.rawValue) {
    return 1;
  }

  if (parsedA.isNumeric && parsedB.isNumeric) {
    const maxLength = Math.max(parsedA.segments.length, parsedB.segments.length);
    for (let i = 0; i < maxLength; i += 1) {
      const segmentA = parsedA.segments[i] ?? 0;
      const segmentB = parsedB.segments[i] ?? 0;
      if (segmentA !== segmentB) {
        return segmentA - segmentB;
      }
    }
    return 0;
  }

  return parsedA.rawValue.localeCompare(parsedB.rawValue, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
};

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
