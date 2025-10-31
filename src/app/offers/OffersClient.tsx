'use client';

import React from 'react';
import AgGridAll from '../components/AgGridAll';
import type { ColDef } from 'ag-grid-community';

export default function OffersClient() {
  const columnDefs: ColDef[] = [
    { field: 'Description', headerName: 'Description', filter: 'agTextColumnFilter', editable: true },
    { field: 'Title', headerName: 'Title', filter: 'agTextColumnFilter', enableRowGroup: true },
    //{ field: 'CustomerName', headerName: 'Customer', filter: 'agTextColumnFilter', enableRowGroup: true }
    //{ field: 'pricing Policy', headerName: 'Pricing Policy', filter: 'agTextColumnFilter' },
    //{ field: 'Market', headerName: 'Market', filter: 'agTextColumnFilter', enableRowGroup: true },
    //{ field: 'Sales Divition', headerName: 'Sales Division', filter: 'agTextColumnFilter' },
    //{ field: 'Sales Creation Person', headerName: 'Sales Creation Person', filter: 'agTextColumnFilter' },
    //{ field: 'Status', headerName: 'Status', filter: 'agTextColumnFilter', enableRowGroup: true },
    //{ field: 'ProjectID', headerName: 'Project ID', filter: 'agNumberColumnFilter', enableRowGroup: true, enableValue: true },
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agTextColumnFilter', enableRowGroup: true }
    //{ field: 'Customer Ref', headerName: 'Customer Ref', filter: 'agTextColumnFilter' },
    //{ field: 'Protovol No', headerName: 'Protocol No', filter: 'agTextColumnFilter' },
    //{ field: 'Contact', headerName: 'Contact', filter: 'agTextColumnFilter' },
    //{ field: 'Offer Version', headerName: 'Offer Version', filter: 'agNumberColumnFilter', enableValue: true },
    //{ field: 'Enabled', headerName: 'Enabled', filter: 'agSetColumnFilter' },
  ];

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>Offers</h1>
      <AgGridAll endpoint="/api/offers" columnDefs={columnDefs} />
    </main>
  );
}
