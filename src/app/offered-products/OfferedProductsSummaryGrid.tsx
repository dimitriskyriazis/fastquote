'use client';

import React from 'react';
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react';
import { AllEnterpriseModule, ModuleRegistry } from 'ag-grid-enterprise';

declare global {
  var __FASTQUOTE_OFFERED_SUMMARY_AG__: boolean | undefined;
}
if (!globalThis.__FASTQUOTE_OFFERED_SUMMARY_AG__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]);
  globalThis.__FASTQUOTE_OFFERED_SUMMARY_AG__ = true;
}

type Props = AgGridReactProps & { containerClassName?: string };

export default function OfferedProductsSummaryGrid({ containerClassName, ...props }: Props) {
  return (
    <div
      className={`ag-theme-quartz${containerClassName ? ` ${containerClassName}` : ''}`}
      data-ag-grid-size="compact"
      style={{ width: '100%', height: '100%' }}
    >
      <AgGridReact
        defaultColDef={{ resizable: true, sortable: true }}
        // Body-parented popups get viewport-px positioning from AG Grid, which
        // the global overlay corrector (lib/bodyScale) rescales for body zoom.
        popupParent={typeof document !== 'undefined' ? document.body : undefined}
        rowHeight={32}
        headerHeight={38}
        rowGroupPanelShow="never"
        sideBar={false}
        animateRows={false}
        {...props}
      />
    </div>
  );
}
