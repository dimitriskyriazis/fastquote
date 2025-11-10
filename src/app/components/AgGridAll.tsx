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
  GridApi,
  RowNode,
  GetRowIdParams,
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

type DragPayload = {
  type: 'offer-product-row';
  rowId: string | null;
  rowIndex: number | null;
  data: RowData | null;
};

type RowHoverState = {
  top: number;
  height: number;
  rowId: string | null;
  rowIndex: number | null;
  data: RowData | null;
  path: number[];
  parentPath: number[];
};

type GapHoverState = {
  pos: number;
  position: 'before' | 'after';
  beforeRowId: string | null;
  beforeRowIndex: number | null;
  afterRowId: string | null;
  afterRowIndex: number | null;
  parentPath: number[];
};

type NodeOrderingInfo = {
  node: RowNode<RowData>;
  path: number[];
  parentPath: number[];
  leaf: number;
  initialPath: number[];
};

const ROOT_PARENT_KEY = '__root__';

const comparePaths = (a: number[], b: number[]) => {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const max = Math.max(a.length, b.length);
  for (let idx = 0; idx < max; idx += 1) {
    const hasA = idx < a.length;
    const hasB = idx < b.length;
    if (!hasA && !hasB) return 0;
    if (!hasA) return -1;
    if (!hasB) return 1;
    const va = a[idx];
    const vb = b[idx];
    if (va !== vb) return va - vb;
  }
  return 0;
};

const arraysEqual = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const parseTreeOrderingPath = (value: unknown): number[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .filter((segment) => Number.isFinite(segment));
};

const formatTreeOrderingPath = (path: number[]): string => path.join('.');

const parentKeyFromPath = (path: number[]): string => (path.length > 0 ? path.join('.') : ROOT_PARENT_KEY);

const parentPathFromKey = (key: string): number[] => (key === ROOT_PARENT_KEY ? [] : key
  .split('.')
  .map((segment) => Number.parseInt(segment, 10))
  .filter((segment) => Number.isFinite(segment)));

const buildOrderingInfo = (node: RowNode<RowData>): NodeOrderingInfo | null => {
  const path = parseTreeOrderingPath((node.data as RowData | undefined)?.TreeOrdering);
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const leaf = path[path.length - 1];
  return { node, path, parentPath, leaf, initialPath: path.slice() };
};

const updateNodePathWithDescendants = (
  target: NodeOrderingInfo,
  newPath: number[],
  orderingInfos: NodeOrderingInfo[],
) => {
  const oldPath = target.path.slice();
  const newPathCopy = newPath.slice();
  target.path = newPathCopy;
  target.parentPath = newPathCopy.slice(0, -1);
  target.leaf = newPathCopy[newPathCopy.length - 1] ?? 0;
  target.node.setDataValue('TreeOrdering', formatTreeOrderingPath(newPathCopy));

  if (oldPath.length === 0) return;
  orderingInfos.forEach((info) => {
    if (info === target) return;
    if (info.initialPath.length <= oldPath.length) return;
    for (let idx = 0; idx < oldPath.length; idx += 1) {
      if (info.initialPath[idx] !== oldPath[idx]) return;
    }
    const suffix = info.initialPath.slice(oldPath.length);
    const updatedPath = [...newPathCopy, ...suffix];
    info.path = updatedPath;
    info.parentPath = updatedPath.slice(0, -1);
    info.leaf = updatedPath[updatedPath.length - 1] ?? 0;
    info.node.setDataValue('TreeOrdering', formatTreeOrderingPath(updatedPath));
  });
};

const resequenceSiblings = (
  siblings: NodeOrderingInfo[],
  parentPath: number[],
  orderingInfos: NodeOrderingInfo[],
) => {
  const parentCopy = parentPath.slice();
  siblings.forEach((info, idx) => {
    const newLeaf = idx + 1;
    const newPath = parentCopy.length > 0 ? [...parentCopy, newLeaf] : [newLeaf];
    updateNodePathWithDescendants(info, newPath, orderingInfos);
  });
};

const longestCommonPrefix = (a: number[], b: number[]) => {
  const limit = Math.min(a.length, b.length);
  const prefix: number[] = [];
  for (let idx = 0; idx < limit; idx += 1) {
    if (a[idx] !== b[idx]) break;
    prefix.push(a[idx]);
  }
  return prefix;
};

const collectOrderingInfos = (api: GridApi<RowData>) => {
  const orderingInfos: NodeOrderingInfo[] = [];
  const infoByNodeId = new Map<string, NodeOrderingInfo>();
  api.forEachNode((node) => {
    if (!node.data) return;
    const info = buildOrderingInfo(node as RowNode<RowData>);
    if (info) {
      orderingInfos.push(info);
      if (node.id != null) infoByNodeId.set(node.id, info);
    }
  });
  return { orderingInfos, infoByNodeId };
};

const applyOrderingMove = (
  api: GridApi<RowData>,
  sourceNode: RowNode<RowData>,
  insertParentPath: number[],
  beforeRowId: string | null,
  beforeRowIndex: number | null,
  afterRowId: string | null,
  afterRowIndex: number | null,
  position: 'before' | 'after',
): boolean => {
  const { orderingInfos, infoByNodeId } = collectOrderingInfos(api);
  if (orderingInfos.length === 0) return false;

  const sourceInfo = infoByNodeId.get(sourceNode.id ?? '')
    ?? orderingInfos.find((info) => info.node === sourceNode);
  if (!sourceInfo) return false;

  const siblingsByParent = new Map<string, NodeOrderingInfo[]>();
  orderingInfos.forEach((info) => {
    const key = parentKeyFromPath(info.parentPath);
    const collection = siblingsByParent.get(key);
    if (collection) collection.push(info);
    else siblingsByParent.set(key, [info]);
  });

  siblingsByParent.forEach((collection) => {
    collection.sort((a, b) => a.leaf - b.leaf);
  });

  const resolveInfo = (rowId: string | null, rowIndex: number | null) => {
    if (rowId) {
      const found = infoByNodeId.get(rowId);
      if (found) return found;
    }
    if (rowIndex != null) {
      const nodeAtIndex = api.getDisplayedRowAtIndex(rowIndex);
      if (nodeAtIndex) {
        return orderingInfos.find((info) => info.node === nodeAtIndex) ?? null;
      }
    }
    return null;
  };

  const sourceParentKey = parentKeyFromPath(sourceInfo.parentPath);
  const targetParentKey = parentKeyFromPath(insertParentPath);
  const sourceSiblings = siblingsByParent.get(sourceParentKey);
  if (!sourceSiblings) return false;

  const removalIndex = sourceSiblings.findIndex((info) => info === sourceInfo);
  if (removalIndex < 0) return false;
  sourceSiblings.splice(removalIndex, 1);

  let targetSiblings = siblingsByParent.get(targetParentKey);
  if (!targetSiblings) {
    targetSiblings = [];
    siblingsByParent.set(targetParentKey, targetSiblings);
  }

  const beforeInfo = resolveInfo(beforeRowId, beforeRowIndex);
  const afterInfo = resolveInfo(afterRowId, afterRowIndex);
  const beforeIdx = beforeInfo ? targetSiblings.findIndex((info) => info === beforeInfo) : -1;
  const afterIdx = afterInfo ? targetSiblings.findIndex((info) => info === afterInfo) : -1;
  const beforeMatches = Boolean(
    beforeInfo
    && beforeInfo !== sourceInfo
    && beforeIdx >= 0
    && arraysEqual(beforeInfo.parentPath, insertParentPath),
  );
  const afterMatches = Boolean(
    afterInfo
    && afterInfo !== sourceInfo
    && afterIdx >= 0
    && arraysEqual(afterInfo.parentPath, insertParentPath),
  );

  let insertIndex = targetSiblings.length;
  if (position === 'before') {
    if (afterMatches) {
      insertIndex = afterIdx;
    } else if (beforeMatches) {
      insertIndex = beforeIdx + 1;
    }
  } else {
    if (beforeMatches) {
      insertIndex = beforeIdx + 1;
    } else if (afterMatches) {
      insertIndex = afterIdx;
    }
  }

  if (!Number.isFinite(insertIndex)) insertIndex = targetSiblings.length;

  if (sourceParentKey === targetParentKey && removalIndex < insertIndex) {
    insertIndex -= 1;
  }

  const boundedIndex = Math.max(0, Math.min(insertIndex, targetSiblings.length));
  sourceInfo.parentPath = insertParentPath.slice();
  targetSiblings.splice(boundedIndex, 0, sourceInfo);

  siblingsByParent.forEach((siblings, key) => {
    if (!siblings || siblings.length === 0) return;
    const parentPath = siblings[0]?.parentPath?.slice?.() ?? parentPathFromKey(key);
    resequenceSiblings(siblings, parentPath, orderingInfos);
  });

  return true;
};

const GUARDED_SET_FILTERS = new Set(['Enabled']);

const reorderRowsByTreeOrdering = (api: GridApi<RowData>) => {
  if (typeof api.applyServerSideTransaction !== 'function') return;
  const entries: Array<{ data: RowData; path: number[] }> = [];
  api.forEachNode((node) => {
    if (!node.data) return;
    const data = node.data as RowData;
    const path = parseTreeOrderingPath((data as { TreeOrdering?: string | null }).TreeOrdering ?? null);
    entries.push({ data, path });
  });
  if (entries.length === 0) return;
  entries.sort((a, b) => comparePaths(a.path, b.path));
  const sortedData = entries.map(entry => entry.data);
  try {
    api.applyServerSideTransaction({ route: [], remove: sortedData });
    api.applyServerSideTransaction({ route: [], add: sortedData, addIndex: 0 });
  } catch (err) {
    console.warn('Failed to reorder rows using server-side transaction', err);
  }
};
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
  const [gapHover, setGapHover] = useState<GapHoverState | null>(null);
  const [rowHover, setRowHover] = useState<RowHoverState | null>(null);
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

  const getRowId = useCallback((params: GetRowIdParams<RowData>) => {
    const data = params.data as { OfferDetailID?: number | string; TreeOrdering?: string } | undefined;
    if (data && data.OfferDetailID != null) return String(data.OfferDetailID);
    if (data && data.TreeOrdering) return String(data.TreeOrdering);
    return `row_${Date.now()}_${Math.random()}`;
  }, []);

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

  const updateHoverFromPoint = useCallback((_clientX: number, clientY: number, fromDrag = false) => {
    if (!fromDrag) return;
    const shell = shellRef.current;
    const api = gridRef.current?.api;
    if (!shell || !api) {
      setGapHover(null);
      setRowHover(null);
      setIsDragging(false);
      return;
    }

    const rowElements = Array.from(shell.querySelectorAll<HTMLElement>('.ag-center-cols-container .ag-row'));
    if (rowElements.length === 0) {
      setGapHover(null);
      setRowHover(null);
      setIsDragging(false);
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const offsetY = clientY - shellRect.top;
    const rows: RowHoverState[] = rowElements
      .map((rowEl) => {
        const rowRect = rowEl.getBoundingClientRect();
        const rowIndexAttr = rowEl.getAttribute('row-index');
        const rowIndex = rowIndexAttr && rowIndexAttr.length > 0 ? Number.parseInt(rowIndexAttr, 10) : null;
        const rowId = rowEl.getAttribute('row-id');
        const node = rowId
          ? api.getRowNode(rowId)
          : (rowIndex != null ? api.getDisplayedRowAtIndex(rowIndex) : undefined);
        const data = (node?.data as RowData | undefined) ?? null;
        const path = node ? parseTreeOrderingPath((node.data as RowData | undefined)?.TreeOrdering) : [];
        const parentPath = path.length > 0 ? path.slice(0, -1) : [];
        return {
          top: rowRect.top - shellRect.top,
          height: rowRect.height,
          rowId: rowId ?? null,
          rowIndex,
          data,
          path,
          parentPath,
        } satisfies RowHoverState;
      })
      .filter((rect) => Number.isFinite(rect.top) && Number.isFinite(rect.height) && rect.height > 0)
      .sort((a, b) => a.top - b.top);

    if (rows.length === 0) {
      setGapHover(null);
      setRowHover(null);
      setIsDragging(false);
      return;
    }

    const gapThreshold = 18;
    const rowInset = 6;
    let hoveredRow: RowHoverState | null = null;
    type GapCandidate = {
      pos: number;
      distance: number;
      position: 'before' | 'after';
      before: RowHoverState | null;
      after: RowHoverState | null;
    };
    let gapCandidate: GapCandidate | null = null;

    for (let idx = 0; idx < rows.length; idx += 1) {
      const rect = rows[idx];
      const top = rect.top;
      const bottom = top + rect.height;
      if (offsetY >= top + rowInset && offsetY <= bottom - rowInset) {
        hoveredRow = rect;
        break;
      }

      const prevRow = rows[idx - 1] ?? null;
      const topDistance = Math.abs(offsetY - top);
      if (topDistance <= gapThreshold && (!gapCandidate || topDistance < gapCandidate.distance)) {
        gapCandidate = {
          pos: top,
          distance: topDistance,
          position: 'before',
          before: prevRow,
          after: rect,
        };
      }

      const bottomDistance = Math.abs(offsetY - bottom);
      if (bottomDistance <= gapThreshold && (!gapCandidate || bottomDistance < gapCandidate.distance)) {
        gapCandidate = {
          pos: bottom,
          distance: bottomDistance,
          position: 'after',
          before: rect,
          after: rows[idx + 1] ?? null,
        };
      }

      const next = rows[idx + 1];
      if (next && offsetY > bottom && offsetY < next.top) {
        const gapDistance = Math.min(offsetY - bottom, next.top - offsetY);
        if (gapDistance <= gapThreshold && (!gapCandidate || gapDistance < gapCandidate.distance)) {
          gapCandidate = {
            pos: bottom,
            distance: gapDistance,
            position: 'after',
            before: rect,
            after: next,
          };
        }
      }
    }

    if (hoveredRow) {
      setRowHover(hoveredRow);
      setGapHover(null);
      setIsDragging(true);
      return;
    }

    if (gapCandidate) {
      const deriveParentPath = () => {
        const beforePath = gapCandidate.before?.path ?? null;
        const afterPath = gapCandidate.after?.path ?? null;
        if (beforePath && afterPath) {
          const prefix = longestCommonPrefix(beforePath, afterPath);
          const beforeIsPrefix = prefix.length === beforePath.length && afterPath.length > prefix.length;
          const afterIsPrefix = prefix.length === afterPath.length && beforePath.length > prefix.length;
          if (gapCandidate.position === 'after' && beforeIsPrefix) {
            return gapCandidate.before?.path.slice() ?? prefix;
          }
          if (gapCandidate.position === 'before' && afterIsPrefix) {
            return gapCandidate.after?.parentPath.slice() ?? [];
          }
          return prefix;
        }
        if (beforePath) {
          return gapCandidate.before?.parentPath.slice() ?? [];
        }
        if (afterPath) {
          return gapCandidate.after?.parentPath.slice() ?? [];
        }
        return [];
      };
      setGapHover({
        pos: gapCandidate.pos,
        position: gapCandidate.position,
        beforeRowId: gapCandidate.before?.rowId ?? null,
        beforeRowIndex: gapCandidate.before?.rowIndex ?? null,
        afterRowId: gapCandidate.after?.rowId ?? null,
        afterRowIndex: gapCandidate.after?.rowIndex ?? null,
        parentPath: deriveParentPath(),
      });
      setRowHover(null);
      setIsDragging(true);
      return;
    }

    setGapHover(null);
    setRowHover(null);
    setIsDragging(false);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setGapHover(null);
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
    setGapHover(null);
    setRowHover(null);
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const api = gridRef.current?.api;
    if (!api) return;

    const gap = gapHover;
    setGapHover(null);
    setRowHover(null);
    setIsDragging(false);

    if (typeof window !== 'undefined') {
      try {
        window.dispatchEvent(new CustomEvent('telquote-row-drop'));
      } catch {
        /* noop */
      }
    }

    if (!gap) {
      return; // Row-level drops will be considered later
    }

    const rawPayload = ev.dataTransfer?.getData('application/x-telquote-row+json')
      || ev.dataTransfer?.getData('text/plain');
    if (!rawPayload) return;

    let payload: DragPayload | null = null;
    try {
      payload = JSON.parse(rawPayload) as DragPayload;
    } catch {
      payload = null;
    }
    if (!payload || payload.type !== 'offer-product-row') return;

    const resolveNode = (rowId: string | null, rowIndex: number | null) => {
      if (rowId) {
        const nodeById = api.getRowNode(rowId);
        if (nodeById) return nodeById as RowNode<RowData>;
      }
      if (rowIndex != null) {
        const nodeByIndex = api.getDisplayedRowAtIndex(rowIndex);
        if (nodeByIndex) return nodeByIndex as RowNode<RowData>;
      }
      return null;
    };

    const sourceNode = resolveNode(payload.rowId, payload.rowIndex);
    if (!sourceNode) return;

    const parentPath = Array.isArray(gap.parentPath) ? gap.parentPath.slice() : [];
    const sourcePath = parseTreeOrderingPath((sourceNode.data as RowData | undefined)?.TreeOrdering ?? null);
    const sourceParentPath = sourcePath.slice(0, -1);
    const parentIsAncestor = parentPath.length < sourceParentPath.length
      && arraysEqual(parentPath, sourceParentPath.slice(0, parentPath.length));
    if (parentIsAncestor) {
      return;
    }
    const moved = applyOrderingMove(
      api,
      sourceNode,
      parentPath,
      gap.beforeRowId,
      gap.beforeRowIndex,
      gap.afterRowId,
      gap.afterRowIndex,
      gap.position,
    );
    if (!moved) {
      console.warn('Drop detected but TreeOrdering could not be updated', { payload, gap });
      return;
    }

    api.applyColumnState({
      state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: true,
    });
    api.refreshCells({ columns: ['TreeOrdering'], force: true });
    reorderRowsByTreeOrdering(api);
  }, [gapHover]);

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
    top: gapHover?.pos ?? -9999,
    pointerEvents: 'none' as const,
    zIndex: 1001,
    opacity: isDragging && gapHover ? 1 : 0,
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
        onDrop={handleDrop}
      >
        <AgGridReact
          ref={gridRef}
          columnDefs={columnDefs}
          defaultColDef={dcd}
          getRowId={getRowId}

          // Server-Side model
          rowModelType="serverSide"
          serverSideEnableClientSideSort={true}

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
