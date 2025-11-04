'use client';

import React, { useMemo, useRef, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  ModuleRegistry,
  ColDef,
  IServerSideDatasource,
  GridReadyEvent,
  FilterChangedEvent,
} from 'ag-grid-community';
import { AllEnterpriseModule, LicenseManager } from 'ag-grid-enterprise';

// Prevent double registration during HMR/StrictMode
declare global {
  // eslint-disable-next-line no-var
  var __AG_ALL_REGISTERED__: boolean | undefined;
}
if (!globalThis.__AG_ALL_REGISTERED__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]); // ✅ brings SSRM, filters, editors, panels, etc.
  globalThis.__AG_ALL_REGISTERED__ = true;
}

// Empty string => Community mode; no “invalid key” banner
LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE || '');

type Props = {
  endpoint: string;
  columnDefs: ColDef[];
  defaultColDef?: ColDef;
};

const GUARDED_SET_FILTERS = new Set(['Enabled']);

export default function AgGridAll({ endpoint, columnDefs, defaultColDef }: Props) {
  const gridRef = useRef<AgGridReact<any>>(null);

  const dcd: ColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
    floatingFilter: true,
    minWidth: 150,
    ...defaultColDef,
  }), [defaultColDef]);

  const datasource: IServerSideDatasource = useMemo(() => ({
    getRows: async (params) => {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request: params.request }),
        });

        let data: any = null; let text = '';
        try { data = await res.json(); } catch { try { text = await res.text(); } catch {} }

        if (!res.ok || data?.ok === false) {
          console.error('Datasource error', { status: res.status, statusText: res.statusText, data, text });
          params.fail(); return;
        }
        params.success({ rowData: data.rows, rowCount: data.rowCount });
      } catch (e) {
        console.error('Datasource fetch exception', e);
        params.fail();
      }
    },
  }), [endpoint]);

  const onGridReady = (e: GridReadyEvent) => {
    // Works in v34 with SSRM available
    e.api.setGridOption('serverSideDatasource', datasource);
  };

  const handleFilterChanged = useCallback((event: FilterChangedEvent) => {
    const model = event.api.getFilterModel();
    const nextModel = { ...model } as Record<string, any>;
    let mutated = false;

    Object.entries(model).forEach(([colId, descriptor]) => {
      if (!GUARDED_SET_FILTERS.has(colId)) return;
      if (descriptor?.filterType !== 'set') return;
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
    <div className="ag-theme-quartz" data-ag-grid-size="compact" style={{ height: 700 }}>
      <AgGridReact
        ref={gridRef}
        columnDefs={columnDefs}
        defaultColDef={dcd}

        // Server-Side model
        rowModelType="serverSide"
        getRowId={(p) => String(p.data?.ID ?? p.data?.id ?? Math.random())}

        // Enterprise UX
        sideBar={['columns', 'filters']}
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
  );
}
