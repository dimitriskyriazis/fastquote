import type { ColDef } from 'ag-grid-community';

export const productGridColumnDefs: ColDef[] = [
  {
    field: 'Brand',
    headerName: 'Brand',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
  },
  {
    field: 'ModelNumber',
    headerName: 'Model Number',
    filter: 'agTextColumnFilter',
    flex: 1,
  },
  {
    field: 'PartNumber',
    headerName: 'Part number',
    filter: 'agTextColumnFilter',
  },
  {
    field: 'ERPPartNumber',
    headerName: 'ERP part number',
    filter: 'agTextColumnFilter',
  },
  {
    field: 'Description',
    headerName: 'Description',
    filter: 'agTextColumnFilter',
    width: 320,
  },
  {
    field: 'Category',
    headerName: 'Category',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
  },
  {
    field: 'SubCategory',
    headerName: 'Sub-category',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
  },
  {
    field: 'Type',
    headerName: 'Type',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
  },
  {
    field: 'WebLink',
    headerName: 'Web link',
    filter: 'agTextColumnFilter',
    flex: 1,
  },
];

export const productDefaultColDef: ColDef = {
  sortable: true,
  resizable: true,
  filter: true,
};
