'use client';

import React, { useMemo, useRef, useCallback, useState, type CSSProperties } from 'react';
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
  overflow: 'hidden',
  position: 'relative',
};

export default function AgGridAll({ endpoint, columnDefs, defaultColDef }: Props) {
  const gridRef = useRef<AgGridReact<RowData> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [gapTop, setGapTop] = useState<number | null>(null);
  const [rowHover, setRowHover] = useState<{ top: number; height: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const dcd: ColDef = useMemo(() => ({
    sortable: true,
    resizable: true,
    filter: true,
    floatingFilter: true,
    // Hide header menu icon and disable header menu on right-click
    suppressHeaderMenuButton: true,
    suppressHeaderContextMenu: true,
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

  const updateHoverFromPoint = useCallback((clientX: number, clientY: number, fromDrag = false) => {
    if (!fromDrag) return;
    const shell = shellRef.current;
    if (!shell) {
      setGapTop(null);
      setRowHover(null);
      setIsDragging(false);
      return;
    }

    const rowElements = Array.from(shell.querySelectorAll<HTMLElement>('.ag-center-cols-container .ag-row'));
    if (rowElements.length === 0) {
      setGapTop(null);
      setRowHover(null);
      setIsDragging(false);
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const offsetY = clientY - shellRect.top;
    const rows = rowElements
      .map((row) => {
        const rowRect = row.getBoundingClientRect();
        return {
          top: rowRect.top - shellRect.top,
          height: rowRect.height,
        };
      })
      .filter((rect) => Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0)
      .sort((a, b) => a.top - b.top);

    if (rows.length === 0) {
      setGapTop(null);
      setRowHover(null);
      setIsDragging(false);
      return;
    }

    const gapThreshold = 18;
    const rowInset = 6;
    let rowRect: { top: number; height: number } | null = null;
    let gapCandidate: { pos: number; distance: number } | null = null;

    for (let idx = 0; idx < rows.length; idx += 1) {
      const rect = rows[idx];
      const top = rect.top;
      const bottom = top + rect.height;
      if (offsetY >= top + rowInset && offsetY <= bottom - rowInset) {
        rowRect = rect;
        break;
      }
      const topDistance = Math.abs(offsetY - top);
      const bottomDistance = Math.abs(offsetY - bottom);
      if (topDistance <= gapThreshold) {
        if (!gapCandidate || topDistance < gapCandidate.distance) {
          gapCandidate = { pos: top, distance: topDistance };
        }
      }
      if (bottomDistance <= gapThreshold) {
        if (!gapCandidate || bottomDistance < gapCandidate.distance) {
          gapCandidate = { pos: bottom, distance: bottomDistance };
        }
      }
      const next = rows[idx + 1];
      if (next && offsetY > bottom && offsetY < next.top) {
        const gapDistance = Math.min(offsetY - bottom, next.top - offsetY);
        if (gapDistance <= gapThreshold && (!gapCandidate || gapDistance < gapCandidate.distance)) {
          gapCandidate = { pos: bottom, distance: gapDistance };
        }
      }
    }

    if (rowRect) {
      setRowHover({ top: rowRect.top, height: rowRect.height });
      setGapTop(null);
      setIsDragging(true);
      return;
    }
    if (gapCandidate && gapCandidate.distance <= gapThreshold) {
      setGapTop(gapCandidate.pos);
      setRowHover(null);
      setIsDragging(true);
      return;
    }

    setGapTop(null);
    setRowHover(null);
    setIsDragging(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setGapTop(null);
    setRowHover(null);
    setIsDragging(false);
  }, []);
  const allowDragOver = useCallback((e: React.DragEvent) => {
    // Ensure no OS "not-allowed" cursor while dragging inside grid
    e.preventDefault();
  }, []);
  const handleDragOver = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    updateHoverFromPoint(ev.clientX, ev.clientY, true);
  }, [updateHoverFromPoint]);
  const handleDragLeave = useCallback(() => {
    setGapTop(null);
    setRowHover(null);
    setIsDragging(false);
  }, []);

  const rowOverlayStyle = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    top: rowHover ? rowHover.top : -9999,
    height: rowHover ? rowHover.height : 0,
    background: 'var(--row-hover-bg, rgba(59, 130, 246, 0.08))',
    pointerEvents: 'none' as const,
    zIndex: 1000,
    opacity: isDragging && rowHover ? 1 : 0,
    transition: 'opacity 140ms ease',
  };

    const gapOverlayStyle = {
      position: 'absolute' as const,
      left: 0,
      right: 0,
    height: 4,
    borderRadius: 2,
    background: 'var(--gap-hover-color, rgba(59, 130, 246, 0.7))',
    boxShadow: '0 1px 3px rgba(15, 23, 42, 0.2)',
    top: gapTop ?? -9999,
    pointerEvents: 'none' as const,
    zIndex: 1001,
    opacity: isDragging && gapTop != null ? 1 : 0,
    transition: 'opacity 140ms ease',
  };

  return (
    <div style={containerStyle}>
      <div
        className="ag-theme-quartz"
        data-ag-grid-size="compact"
        style={gridShellStyle}
        ref={shellRef}
        onMouseLeave={handleMouseLeave}
        onDragOverCapture={allowDragOver}
        onDragEnterCapture={allowDragOver}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        <AgGridReact
          ref={gridRef}
          columnDefs={columnDefs}
          defaultColDef={dcd}

          // Server-Side model
          rowModelType="serverSide"

          // No selection needed for handle-only drag
          // rowSelection removed to avoid SSRM warning

          // Enterprise UX
          sideBar={sideBarDef}
          statusBar={{ statusPanels: [{ statusPanel: 'agAggregationComponent' }] }}
          suppressCellFocus={true}

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
        {/* Row hover overlay */}
        <div className="row-hover-overlay" style={rowOverlayStyle} />
        {/* Gap hover overlay */}
        <div className="gap-hover-line" style={gapOverlayStyle} />
      </div>
    </div>
  );
}
