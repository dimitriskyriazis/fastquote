'use client';

import React, { useMemo, useCallback, useRef, useEffect } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';
import type { ColDef, GridApi, FirstDataRenderedEvent, Column } from 'ag-grid-community';
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
  const gridApiRef = useRef<GridApi | null>(null);

  const rowData = useMemo(
    () => [
      {
        PartNumber: partNumber || '—',
        ModelNumber: modelNumber || '—',
        Description: description || '—',
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
        flex: 1,
        minWidth: 280,
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

  const autoSizeAll = useCallback((api?: GridApi | null) => {
    const gridApi = api ?? gridApiRef.current;
    if (!gridApi || gridApi.isDestroyed?.()) return;
    const resize = () => {
      if (gridApi.isDestroyed?.()) return;
      const displayed: Column[] | null = gridApi.getAllDisplayedColumns?.() ?? null;
      if (!displayed || displayed.length === 0) return;
      const columnIds = displayed
        .map((col) => col.getColId?.())
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (columnIds.length === 0) return;
      gridApi.autoSizeColumns(columnIds, false);
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(resize);
    } else {
      setTimeout(resize, 0);
    }
  }, []);

  const handleGridReady = useCallback((params: { api: GridApi }) => {
    gridApiRef.current = params.api;
    autoSizeAll(params.api);
  }, [autoSizeAll]);

  const handleFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    autoSizeAll(event.api);
  }, [autoSizeAll]);

  useEffect(() => {
    autoSizeAll();
  }, [autoSizeAll]);

  return (
    <div className={`${styles.metaGridContainer} ${styles.bandedRows} offer-products-grid`}>
      <div className={`ag-theme-quartz ${styles.metaGridShell}`} data-ag-grid-size="compact">
        <AgGridReact
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
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
          onGridReady={handleGridReady}
          onFirstDataRendered={handleFirstDataRendered}
        />
      </div>
    </div>
  );
}
