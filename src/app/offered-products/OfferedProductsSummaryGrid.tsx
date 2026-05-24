'use client';

import React from 'react';
import { AgGridReact } from 'ag-grid-react';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';
import type { ColDef } from 'ag-grid-community';

declare global {
  var __FASTQUOTE_OFFERED_SUMMARY_AG__: boolean | undefined;
}
if (!globalThis.__FASTQUOTE_OFFERED_SUMMARY_AG__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  globalThis.__FASTQUOTE_OFFERED_SUMMARY_AG__ = true;
}

type Props = {
  columnDefs: ColDef[];
  rowData: Record<string, unknown>[];
  defaultColDef?: ColDef;
};

export default function OfferedProductsSummaryGrid({ columnDefs, rowData, defaultColDef }: Props) {
  return (
    <div
      className="ag-theme-quartz"
      data-ag-grid-size="compact"
      style={{ width: '100%', height: '100%' }}
    >
      <AgGridReact
        columnDefs={columnDefs}
        rowData={rowData}
        defaultColDef={defaultColDef ?? { resizable: true, sortable: true }}
        rowHeight={32}
        headerHeight={38}
        rowGroupPanelShow="never"
        sideBar={false}
        animateRows={false}
      />
    </div>
  );
}
