'use client';

import React from 'react';
import AgGridAll from '../components/AgGridAll';
import type { ColDef } from 'ag-grid-community';

export default function OffersClient() {
  const columnDefs: ColDef[] = [
    { field: 'ID', headerName: 'ID', filter: 'agNumberColumnFilter', enableRowGroup: true, enableValue: true },
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'CustomerID', headerName: 'Customer', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'StatusID', headerName: 'Status', filter: 'agNumberColumnFilter', enableRowGroup: true, enableValue: true },
    { field: 'Description', headerName: 'Description', filter: 'agTextColumnFilter', editable: true },
    { field: 'CreatedOn', headerName: 'Created On', filter: 'agDateColumnFilter', enableValue: true },
  ];

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>Offers</h1>
      <AgGridAll endpoint="/api/offers" columnDefs={columnDefs} />
    </main>
  );
}
