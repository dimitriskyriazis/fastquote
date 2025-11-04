'use client';

import React, { type CSSProperties } from 'react';
import AgGridAll from '../components/AgGridAll';
import type { ColDef } from 'ag-grid-community';

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
};

export default function OffersClient() {
  const columnDefs: ColDef[] = [
    { field: 'Description', headerName: 'Description', filter: 'agTextColumnFilter', editable: true },
    { field: 'Title', headerName: 'Title', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'CustomerName', headerName: 'Customer Name', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'PricingPolicyName', headerName: 'Pricing Policy', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesMarket', headerName: 'Market', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'SalesDivision', headerName: 'Sales Division', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'Salesperson', headerName: 'Sales Creation Person', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'OfferStatus', headerName: 'Status', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'ProjectID', headerName: 'Project ID', filter: 'agNumberColumnFilter' },
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agNumberColumnFilter'},
    { field: 'CustomerRef', headerName: 'Customer Ref', filter: 'agTextColumnFilter' },
    { field: 'ProtocolNo', headerName: 'Protocol No', filter: 'agNumberColumnFilter'},
    { field: 'OfferContact', headerName: 'Contact', filter: 'agTextColumnFilter' },
    { field: 'OfferVersion', headerName: 'Offer Version', filter: 'agNumberColumnFilter' },
    { field: 'Enabled', headerName: 'Enabled', filter: 'agSetColumnFilter', filterParams: {values: ['true', 'false'],
      comparator: (valueA: string, valueB: string) => (valueA === valueB ? 0 : valueA === 'true' ? -1 : 1),}, enableRowGroup: true}
  ];

  return (
    <main style={mainStyle}>
      <h1 style={headingStyle}>Offers</h1>
      <AgGridAll endpoint="/api/offers" columnDefs={columnDefs} />
    </main>
  );
}
