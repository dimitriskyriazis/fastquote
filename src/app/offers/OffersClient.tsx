'use client';

import React from 'react';
import AgGridAll from '../components/AgGridAll';
import type { ColDef } from 'ag-grid-community';

export default function OffersClient() {
  const columnDefs: ColDef[] = [
    { field: 'Description', headerName: 'Description', filter: 'agTextColumnFilter', editable: true },
    { field: 'Title', headerName: 'Title', filter: 'agTextColumnFilter', enableRowGroup: true },
    //{ field: 'CustomerName', headerName: 'CustomerName', filter: 'agTextColumnFilter', enableRowGroup: true },
    //{ field: 'PricingPolicyName', headerName: 'Pricing Policy', filter: 'agTextColumnFilter' },
    //{ field: 'SalesMarket', headerName: 'Market', filter: 'agTextColumnFilter', enableRowGroup: true },
    //{ field: 'SalesDivision', headerName: 'Sales Division', filter: 'agTextColumnFilter' },
    //{ field: 'Salesperson', headerName: 'Sales Creation Person', filter: 'agTextColumnFilter' },
    //{ field: 'OfferStatus', headerName: 'Status', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'ProjectID', headerName: 'Project ID', filter: 'agNumberColumnFilter', enableRowGroup: true, enableValue: true },
    { field: 'OfferID', headerName: 'Offer ID', filter: 'agTextColumnFilter', enableRowGroup: true },
    { field: 'CustomerRef', headerName: 'Customer Ref', filter: 'agTextColumnFilter' },
    { field: 'ProtocolNo', headerName: 'Protocol No', filter: 'agTextColumnFilter' },
    { field: 'Contact', headerName: 'Contact', filter: 'agTextColumnFilter' },
    { field: 'OfferVersion', headerName: 'Offer Version', filter: 'agNumberColumnFilter', enableValue: true },
    {
      field: 'Enabled',
      headerName: 'Enabled',
      filter: 'agSetColumnFilter',
      filterParams: {
        values: ['true', 'false'],
        valueFormatter: ({value}) => (value === 'true' ? 'True' : 'False'),
        comparator: (a, b) => {
          if (a === b) return 0;
          return a === 'true' ? -1 : 1;
        },
      },
      enableRowGroup: true,
      enableValue: true,
    },
  ];

  return (
    <main style={{ padding: 16 }}>
      <h1 style={{ marginBottom: 12 }}>Offers</h1>
      <AgGridAll endpoint="/api/offers" columnDefs={columnDefs} />
    </main>
  );
}
