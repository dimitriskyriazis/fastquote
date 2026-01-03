import type { ColDef } from 'ag-grid-community';

export const productGridColumnDefs: ColDef[] = [
  {
    field: 'Brand',
    headerName: 'Brand',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
    minWidth: 160,
  },
  {
    field: 'ModelNumber',
    headerName: 'Model',
    filter: 'agTextColumnFilter',
    minWidth: 180,
    flex: 1,
  },
  {
    field: 'PartNumber',
    headerName: 'Part number',
    filter: 'agTextColumnFilter',
    minWidth: 180,
  },
  {
    field: 'ERPPartNumber',
    headerName: 'ERP part number',
    filter: 'agTextColumnFilter',
    minWidth: 180,
  },
  {
    field: 'Description',
    headerName: 'Description',
    filter: 'agTextColumnFilter',
    minWidth: 280,
    width: 320,
  },
  {
    field: 'Category',
    headerName: 'Category',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
    minWidth: 160,
  },
  {
    field: 'SubCategory',
    headerName: 'Sub-category',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
    minWidth: 160,
  },
  {
    field: 'Type',
    headerName: 'Type',
    enableRowGroup: true,
    filter: 'agTextColumnFilter',
    minWidth: 160,
  },
  {
    field: 'WebLink',
    headerName: 'Web link',
    filter: 'agTextColumnFilter',
    minWidth: 220,
    flex: 1,
  },
];

export const productDefaultColDef: ColDef = {
  sortable: true,
  resizable: true,
  filter: true,
};
