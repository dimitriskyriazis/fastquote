'use client';

import React, { useMemo } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';
import type { ColDef } from 'ag-grid-community';
import styles from './ProductHistory.module.css';

declare global {
  // Prevent double registration during HMR/StrictMode
  var __FASTQUOTE_HISTORY_AG__META__: boolean | undefined;
}

if (!globalThis.__FASTQUOTE_HISTORY_AG__META__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  globalThis.__FASTQUOTE_HISTORY_AG__META__ = true;
}

type Props = {
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
};

export default function ProductHistoryMetaGrid({ partNumber, modelNumber, description }: Props) {

  const rowData = useMemo(
    () => [
      {
        PartNumber: partNumber || '-',
        ModelNumber: modelNumber || '-',
        Description: description || '-',
      },
    ],
    [partNumber, modelNumber, description],
  );

  const columnDefs = useMemo<ColDef[]>(
    () => [
      { field: 'PartNumber', headerName: 'Part Number', width: 180, filter: false, sortable: false },
      { field: 'ModelNumber', headerName: 'Model Number', width: 180, filter: false, sortable: false },
      {
        field: 'Description',
        headerName: 'Description',
        filter: false,
        sortable: false,
      },
    ],
    [],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      resizable: true,
      suppressMenu: true,
      suppressHeaderMenuButton: true,
      enableRowGroup: false,
      editable: false,
      filter: false,
      sortable: false,
    }),
    [],
  );

  return (
    <div className={`${styles.metaGridContainer} ${styles.bandedRows} offer-products-grid`}>
      <div className={`ag-theme-quartz ${styles.metaGridShell}`} data-ag-grid-size="compact">
        <AgGridReact
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          popupParent={typeof document !== 'undefined' ? document.body : undefined}
          domLayout="autoHeight"
          headerHeight={38}
          rowHeight={32}
          animateRows={false}
          rowGroupPanelShow="never"
          sideBar={false}
          suppressCellFocus
          suppressMovableColumns
          suppressDragLeaveHidesColumns
          suppressPaginationPanel
        />
      </div>
    </div>
  );
}
