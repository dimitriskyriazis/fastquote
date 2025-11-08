'use client';

import React, { useMemo, useCallback, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import AgGridAll from '../components/AgGridAll';
import type { ColDef, CellClickedEvent } from 'ag-grid-community';

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

  const handleDescriptionClick = useCallback((event: CellClickedEvent) => {
    const { value, data, node } = event;
    if (value === null || value === undefined || value === '') {
      return;
    }

    const rowData = (data ?? node?.data ?? {}) as Record<string, unknown>;
    const candidateOfferId =
      rowData?.OfferPK ??
      rowData?.OfferPk ??
      rowData?.offerPK ??
      rowData?.offerPk ??
      rowData?.OfferID ??
      rowData?.OfferId ??
      rowData?.offerID ??
      rowData?.offerId ??
      rowData?.ID ??
      rowData?.id ??
      null;

    const hasValue = (val: unknown): val is string | number =>
      val !== null && val !== undefined && val !== '';

    if (hasValue(candidateOfferId)) {
      const encodedId = encodeURIComponent(String(candidateOfferId));
      router.push(`/offers/${encodedId}`);
      return;
    }

    const fallbackCandidates: Array<unknown> = [
      rowData?.ProjectID,
      rowData?.ProtocolNo,
    ];

    let fallbackKey: string | number | null = null;

    for (const candidate of fallbackCandidates) {
      if (hasValue(candidate)) {
        fallbackKey = candidate as string | number;
        break;
      }
    }

    if (!hasValue(fallbackKey) && hasValue(rowData?.Description)) {
      const rowMarker = node?.id ? `--row-${node.id}` : '';
      fallbackKey = `${rowData.Description}${rowMarker}`;
    }

    if (!hasValue(fallbackKey) && hasValue(node?.id)) {
      fallbackKey = node?.id as string;
    }

    if (!hasValue(fallbackKey)) {
      console.warn('Missing Offer ID and fallback identifier for clicked row', rowData);
      return;
    }

    const encodedFallback = encodeURIComponent(String(fallbackKey));
    router.push(`/offers/${encodedFallback}`);
  }, [router]);

  const columnDefs: ColDef[] = useMemo(() => [
    { field: 'Description', headerName: 'Description', filter: 'agTextColumnFilter',
      cellClass: 'description-cell', onCellClicked: handleDescriptionClick },
    { field: 'Title', headerName: 'Title', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'CustomerName', headerName: 'Customer Name', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'PricingPolicyName', headerName: 'Pricing Policy', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesMarket', headerName: 'Market', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesDivision', headerName: 'Sales Division', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesPerson', headerName: 'Sales Creation Person', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'OfferStatus', headerName: 'Status', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'ProjectID', headerName: 'Project ID', filter: 'agNumberColumnFilter' },
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agNumberColumnFilter'},
    { field: 'CustomerRef', headerName: 'Customer Ref', filter: 'agTextColumnFilter' },
    { field: 'ProtocolNo', headerName: 'Protocol No', filter: 'agNumberColumnFilter'},
    { field: 'OfferContact', headerName: 'Contact', filter: 'agTextColumnFilter' },
    { field: 'OfferVersion', headerName: 'Offer Version', filter: 'agNumberColumnFilter' },
    { field: 'Enabled', headerName: 'Enabled', filter: 'agSetColumnFilter', filterParams: {
      values: ['true', 'false'],
      comparator: (valueA: string, valueB: string) => (valueA === valueB ? 0 : valueA === 'true' ? -1 : 1),
    }, enableRowGroup: true},
  ], [handleDescriptionClick]);

  return (
    <main style={mainStyle}>
      <h1 style={headingStyle}>Offers</h1>
      <AgGridAll endpoint="/api/offers" columnDefs={columnDefs} />
    </main>
  );
}
