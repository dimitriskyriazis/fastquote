'use client';

import React, { useMemo, useRef, useCallback, type CSSProperties } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  ModuleRegistry,
  ColDef,
  IServerSideDatasource,
  GridReadyEvent,
  FilterChangedEvent,
  IServerSideGetRowsParams,
} from 'ag-grid-community';
import { AllEnterpriseModule, LicenseManager } from 'ag-grid-enterprise';

// Prevent double registration during HMR/StrictMode
declare global {
  var __AG_ALL_REGISTERED__: boolean | undefined;
}
if (!globalThis.__AG_ALL_REGISTERED__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]); // Brings SSRM, filters, editors, panels, etc.
  globalThis.__AG_ALL_REGISTERED__ = true;
}

LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE || '');

type Props = {
  endpoint: string;
  columnDefs: ColDef[];
  defaultColDef?: ColDef;
};

type RowData = Record<string, unknown>;

type GridResponse = {
  ok: boolean;
  rows: RowData[];
  rowCount: number;
  error?: string;
};

type FilterDescriptor = {
  filterType?: string;
  values?: unknown;
};

const GUARDED_SET_FILTERS = new Set(['Enabled']);
const containerStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
  width: '100%',
};

const gridShellStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  width: '100%',
  height: '100%',
};

export default function AgGridAll({ endpoint, columnDefs, defaultColDef }: Props) {
  const gridRef = useRef<AgGridReact<RowData> | null>(null);

  const dcd: ColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
    floatingFilter: true,
    minWidth: 150,
    ...defaultColDef,
  }), [defaultColDef]);

  const datasource: IServerSideDatasource<RowData> = useMemo(() => ({
    getRows: async (params: IServerSideGetRowsParams<RowData>) => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: params.request }),
        });

        let data: GridResponse | null = null;
        let text = '';
        try {
          data = await res.json() as GridResponse;
        } catch {
          try { text = await res.text(); } catch { /* noop */ }
        }

        if (!res.ok || !data || !data.ok) {
          console.error('Datasource error', { status: res.status, statusText: res.statusText, data, text });
          params.fail();
          return;
        }
        params.success({ rowData: data.rows, rowCount: data.rowCount });
      } catch (e) {
        console.error('Datasource fetch exception', e);
        params.fail();
      }
    },
  }), [endpoint]);

  const sideBarDef = useMemo(() => ({
    toolPanels: ['columns', 'filters'],
  }), []);

  const onGridReady = (e: GridReadyEvent) => {
    e.api.setGridOption('serverSideDatasource', datasource);
    e.api.setSideBarVisible(true);
    e.api.closeToolPanel();
  };

  const handleFilterChanged = useCallback((event: FilterChangedEvent) => {
    const model = event.api.getFilterModel() as Record<string, FilterDescriptor> | null;
    if (!model) return;

    const nextModel: Record<string, FilterDescriptor> = { ...model };
    let mutated = false;

    Object.entries(model).forEach(([colId, descriptor]) => {
      if (!GUARDED_SET_FILTERS.has(colId)) return;
      if (!descriptor || typeof descriptor !== 'object') return;
      if (descriptor.filterType !== 'set') return;
      const values = Array.isArray(descriptor.values) ? descriptor.values : [];
      if (values.length > 0) return;

      delete nextModel[colId];
      mutated = true;
    });

    if (mutated) {
      event.api.setFilterModel(nextModel);
    }
  }, []);

  return (
    <div style={containerStyle}>
      <div className="ag-theme-quartz" data-ag-grid-size="compact" style={gridShellStyle}>
        <AgGridReact
          ref={gridRef}
          columnDefs={columnDefs}
          defaultColDef={dcd}

          // Server-Side model
          rowModelType="serverSide"
          getRowId={(p) => String(p.data?.ID ?? p.data?.id ?? Math.random())}

          // Enterprise UX
          sideBar={sideBarDef}
          statusBar={{ statusPanels: [{ statusPanel: 'agAggregationComponent' }] }}
          rowSelection={{ mode: 'multiRow' }}
          cellSelection={true}

          // Charts OFF for now (to avoid the AgCharts module requirement)
          enableCharts={false}

          // Grouping/pivot flags are fine; without a license they’re ignored, not crashed
          pivotMode={false}
          rowGroupPanelShow="always"

          // Cache settings
          cacheBlockSize={100}
          maxBlocksInCache={10}

          onGridReady={onGridReady}
          onFilterChanged={handleFilterChanged}
        />
      </div>
    </div>
  );
}
