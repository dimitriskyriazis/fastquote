'use client';

import React, { useMemo, useRef, useCallback, useState, useEffect, type CSSProperties } from 'react';
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
  CellValueChangedEvent,
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
  manualMode?: boolean;
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
  parent: NodeOrderingInfo | null;
  children: NodeOrderingInfo[];
};

type MoveFailureReason = 'target-product' | 'descendant' | 'invalid-target';

const ROOT_PARENT_KEY = '__root__';
const PERSISTED_TREE_KEY = '__persistedTreeOrdering';

type ToastTone = 'info' | 'error' | 'success';

const normalizeTreeOrderingValue = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const str = String(value).trim();
  return str.length > 0 ? str : null;
};

const normalizeOfferDetailId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

type TreeOrderingUpdate = {
  OfferDetailID: number;
  TreeOrdering: string | null;
};

type RowWithPersistedTree = RowData & {
  [PERSISTED_TREE_KEY]?: string | null;
};

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

const buildOrderingInfo = (node: RowNode<RowData>): NodeOrderingInfo | null => {
  const path = parseTreeOrderingPath((node.data as RowData | undefined)?.TreeOrdering);
  if (path.length === 0) return null;
  const parentPath = path.slice(0, -1);
  const leaf = path[path.length - 1];
  return {
    node,
    path,
    parentPath,
    leaf,
    parent: null,
    children: [],
  };
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

const buildTreeStructure = (orderingInfos: NodeOrderingInfo[]) => {
  const infoByPathKey = new Map<string, NodeOrderingInfo>();
  orderingInfos.forEach((info) => {
    info.parent = null;
    info.children = [];
    infoByPathKey.set(parentKeyFromPath(info.path), info);
  });

  const rootChildren: NodeOrderingInfo[] = [];
  orderingInfos.forEach((info) => {
    const parentKey = parentKeyFromPath(info.parentPath);
    if (parentKey === ROOT_PARENT_KEY) {
      rootChildren.push(info);
      return;
    }
    const parent = infoByPathKey.get(parentKey);
    if (parent) {
      info.parent = parent;
      parent.children.push(info);
    } else {
      rootChildren.push(info);
    }
  });

  const sortChildren = (nodes: NodeOrderingInfo[]) => {
    nodes.sort((a, b) => a.leaf - b.leaf);
    nodes.forEach((child) => {
      if (child.children.length > 0) sortChildren(child.children);
    });
  };
  sortChildren(rootChildren);

  return { rootChildren, infoByPathKey };
};

const applyPathToNode = (info: NodeOrderingInfo, newPath: number[]) => {
  const pathCopy = newPath.slice();
  info.path = pathCopy;
  info.parentPath = pathCopy.slice(0, -1);
  info.leaf = pathCopy[pathCopy.length - 1] ?? 0;
  info.node.setDataValue('TreeOrdering', formatTreeOrderingPath(pathCopy));
};

const assignPathsFrom = (nodes: NodeOrderingInfo[], parentPath: number[]) => {
  nodes.forEach((info, idx) => {
    const newPath = [...parentPath, idx + 1];
    applyPathToNode(info, newPath);
    if (info.children.length > 0) {
      assignPathsFrom(info.children, newPath);
    }
  });
};

const isDescendantOf = (candidateParent: NodeOrderingInfo | null, potentialAncestor: NodeOrderingInfo) => {
  let current: NodeOrderingInfo | null = candidateParent;
  while (current) {
    if (current === potentialAncestor) return true;
    current = current.parent;
  }
  return false;
};

const showInvalidDropMessage = (reason: MoveFailureReason | null) => {
  const messages: Record<MoveFailureReason, string> = {
    'target-product': 'Products cannot contain rows inside them. Drop into a category row or gap.',
    descendant: 'You cannot drop a row into itself or its descendants.',
    'invalid-target': 'That drop location is not allowed. Try a highlighted gap or category row.',
  };
  const message = reason ? messages[reason] : messages['invalid-target'];
  showToastMessage(message, 'error');
};

type MoveResult =
  | { success: true }
  | { success: false; reason: MoveFailureReason };

const applyOrderingMove = (
  api: GridApi<RowData>,
  sourceNode: RowNode<RowData>,
  insertParentPath: number[],
  beforeRowId: string | null,
  beforeRowIndex: number | null,
  afterRowId: string | null,
  afterRowIndex: number | null,
  position: 'before' | 'after',
): MoveResult => {
  const { orderingInfos, infoByNodeId } = collectOrderingInfos(api);
  if (orderingInfos.length === 0) return { success: false, reason: 'invalid-target' };
  const { rootChildren, infoByPathKey } = buildTreeStructure(orderingInfos);

  const sourceInfo = infoByNodeId.get(sourceNode.id ?? '')
    ?? orderingInfos.find((info) => info.node === sourceNode);
  if (!sourceInfo) return { success: false, reason: 'invalid-target' };

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

  const parentKey = parentKeyFromPath(insertParentPath);
  const targetParentNode = parentKey === ROOT_PARENT_KEY
    ? null
    : infoByPathKey.get(parentKey) ?? null;

  if (targetParentNode) {
    const parentData = targetParentNode.node.data as RowData | undefined;
    const parentBrand = (parentData as { BrandName?: string | null } | undefined)?.BrandName;
    const parentIsProduct = Boolean(parentBrand && parentBrand.trim().length > 0);
    if (parentIsProduct) return { success: false, reason: 'target-product' };
  }

  if (isDescendantOf(targetParentNode, sourceInfo)) {
    return { success: false, reason: 'descendant' };
  }

  const beforeInfo = resolveInfo(beforeRowId, beforeRowIndex);
  const afterInfo = resolveInfo(afterRowId, afterRowIndex);

  const getChildCollection = (parent: NodeOrderingInfo | null) => (parent ? parent.children : rootChildren);

  const removeFromParent = (info: NodeOrderingInfo) => {
    const collection = getChildCollection(info.parent);
    const idx = collection.findIndex((entry) => entry === info);
    if (idx >= 0) collection.splice(idx, 1);
    info.parent = null;
  };

  removeFromParent(sourceInfo);
  const targetSiblings = getChildCollection(targetParentNode);

  const indexOfSibling = (candidate: NodeOrderingInfo | null) => {
    if (!candidate) return -1;
    if (candidate === sourceInfo) return -1;
    if (candidate.parent !== targetParentNode) return -1;
    return targetSiblings.findIndex((entry) => entry === candidate);
  };

  let insertIndex = targetSiblings.length;
  if (position === 'before') {
    const afterIdx = indexOfSibling(afterInfo);
    if (afterIdx >= 0) {
      insertIndex = afterIdx;
    } else {
      const beforeIdx = indexOfSibling(beforeInfo);
      if (beforeIdx >= 0) insertIndex = beforeIdx + 1;
    }
  } else {
    const beforeIdx = indexOfSibling(beforeInfo);
    if (beforeIdx >= 0) {
      insertIndex = beforeIdx + 1;
    } else {
      const afterIdx = indexOfSibling(afterInfo);
      if (afterIdx >= 0) insertIndex = afterIdx;
    }
  }

  if (!Number.isFinite(insertIndex)) insertIndex = targetSiblings.length;
  const boundedIndex = Math.max(0, Math.min(insertIndex, targetSiblings.length));
  targetSiblings.splice(boundedIndex, 0, sourceInfo);
  sourceInfo.parent = targetParentNode;

  assignPathsFrom(rootChildren, []);

  return { success: true };
};

const collectTreeOrderingUpdates = (api: GridApi<RowData>): TreeOrderingUpdate[] => {
  const updates: TreeOrderingUpdate[] = [];
  api.forEachNode((node) => {
    if (!node.data) return;
    const data = node.data as RowWithPersistedTree;
    const offerDetailId = normalizeOfferDetailId((data as { OfferDetailID?: unknown }).OfferDetailID);
    if (offerDetailId == null) return;
    const currentOrdering = normalizeTreeOrderingValue((data as { TreeOrdering?: unknown }).TreeOrdering ?? null);
    const persistedOrdering = normalizeTreeOrderingValue(data[PERSISTED_TREE_KEY] ?? null);
    if (currentOrdering === persistedOrdering) return;
    updates.push({ OfferDetailID: offerDetailId, TreeOrdering: currentOrdering });
  });
  return updates;
};

const markOrderingPersisted = (api: GridApi<RowData>, updates: TreeOrderingUpdate[]) => {
  if (updates.length === 0) return;
  const map = new Map<number, string | null>();
  updates.forEach((entry) => {
    map.set(entry.OfferDetailID, normalizeTreeOrderingValue(entry.TreeOrdering));
  });
  api.forEachNode((node) => {
    if (!node.data) return;
    const data = node.data as RowWithPersistedTree;
    const offerDetailId = normalizeOfferDetailId((data as { OfferDetailID?: unknown }).OfferDetailID);
    if (offerDetailId == null) return;
    if (!map.has(offerDetailId)) return;
    data[PERSISTED_TREE_KEY] = map.get(offerDetailId) ?? null;
  });
};

const refreshServerSideData = (api?: GridApi<RowData>) => {
  if (!api || typeof api.refreshServerSide !== 'function') return;
  try {
    api.refreshServerSide({ purge: true });
  } catch (err) {
    console.error('Failed to refresh server-side rows', err);
  }
};

const showToastMessage = (message: string, tone: ToastTone = 'info') => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const containerId = 'telquote-drop-toast-container';
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    container.className = 'drop-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `drop-toast drop-toast--${tone}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });
  const removeToast = () => {
    toast.classList.remove('visible');
    window.setTimeout(() => {
      toast.remove();
      if (container && container.childElementCount === 0) {
        container.remove();
      }
    }, 220);
  };
  window.setTimeout(removeToast, 3200);
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

export default function AgGridAll({ endpoint, columnDefs, defaultColDef, manualMode = false }: Props) {
  const gridRef = useRef<AgGridReact<RowData> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [gapHover, setGapHover] = useState<GapHoverState | null>(null);
  const [rowHover, setRowHover] = useState<RowHoverState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

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
        const rawRows = Array.isArray(data.rows) ? data.rows : [];
        const normalizedRows: RowData[] = rawRows.map((row) => {
          const normalizedOrdering = normalizeTreeOrderingValue((row as { TreeOrdering?: unknown }).TreeOrdering ?? null);
          return {
            ...row,
            TreeOrdering: normalizedOrdering,
            [PERSISTED_TREE_KEY]: normalizedOrdering,
          };
        });
        const resolvedRowCount = typeof data.rowCount === 'number' ? data.rowCount : normalizedRows.length;
        params.success({ rowData: normalizedRows, rowCount: resolvedRowCount });
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

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    api.applyColumnState({
      state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: true,
    });
    if (!manualMode) {
      reorderRowsByTreeOrdering(api);
    }
  }, [manualMode]);

  const persistTreeOrderingChanges = useCallback(() => {
    const runSave = async () => {
      const api = gridRef.current?.api;
      if (!api) return;
      const updates = collectTreeOrderingUpdates(api);
      if (updates.length === 0) return;
      try {
        const res = await fetch(endpoint, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ updates }),
        });
        let payload: { ok?: boolean; error?: string } | null = null;
        try {
          payload = (await res.json()) as { ok?: boolean; error?: string } | null;
        } catch {
          payload = null;
        }
        if (!res.ok || !payload?.ok) {
          throw new Error(payload?.error ?? `Failed to save tree ordering (status ${res.status})`);
        }
        markOrderingPersisted(api, updates);
      } catch (err) {
        console.error('Failed to persist tree ordering', err);
        showToastMessage('Unable to save tree ordering. Reloading data…', 'error');
        refreshServerSideData(api);
        throw err;
      }
    };
    const chained = saveQueueRef.current.then(() => runSave());
    saveQueueRef.current = chained.catch(() => {});
    return chained;
  }, [endpoint]);

  const computeHoverState = useCallback((
    clientY: number,
  ): { row: RowHoverState | null; gap: GapHoverState | null; dragging: boolean } => {
    const shell = shellRef.current;
    const api = gridRef.current?.api;
    if (!shell || !api) {
      return { row: null, gap: null, dragging: false };
    }

    const rowElements = Array.from(shell.querySelectorAll<HTMLElement>('.ag-center-cols-container .ag-row'));
    if (rowElements.length === 0) {
      return { row: null, gap: null, dragging: false };
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
      return { row: null, gap: null, dragging: false };
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
      return { row: hoveredRow, gap: null, dragging: true };
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
      return {
        row: null,
        gap: {
          pos: gapCandidate.pos,
          position: gapCandidate.position,
          beforeRowId: gapCandidate.before?.rowId ?? null,
          beforeRowIndex: gapCandidate.before?.rowIndex ?? null,
          afterRowId: gapCandidate.after?.rowId ?? null,
          afterRowIndex: gapCandidate.after?.rowIndex ?? null,
          parentPath: deriveParentPath(),
        },
        dragging: true,
      };
    }

    return { row: null, gap: null, dragging: false };
  }, []);

  const updateHoverFromPoint = useCallback((_clientX: number, clientY: number, fromDrag = false) => {
    if (!fromDrag) return;
    const { row, gap, dragging } = computeHoverState(clientY);
    setRowHover(row);
    setGapHover(gap);
    setIsDragging(dragging);
  }, [computeHoverState]);

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
  const handleDragLeave = useCallback((ev: React.DragEvent) => {
    const shell = shellRef.current;
    const nextTarget = ev.relatedTarget as Node | null;
    if (shell) {
      if (nextTarget && shell.contains(nextTarget)) {
        return;
      }
      const rect = shell.getBoundingClientRect();
      const insideX = ev.clientX >= rect.left && ev.clientX <= rect.right;
      const insideY = ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      if (insideX && insideY) {
        return;
      }
    }
    setGapHover(null);
    setRowHover(null);
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    ev.stopPropagation();
    const api = gridRef.current?.api;
    if (!api) return;

    const liveHover = computeHoverState(ev.clientY);
    const gap = liveHover.gap ?? gapHover;
    const hoveredRowTarget = liveHover.row ?? rowHover;
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

    if (!gap && !hoveredRowTarget) {
      return;
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

    let failureReason: MoveFailureReason | null = null;
    const attemptMove = (
      targetParentPath: number[],
      beforeRowId: string | null,
      beforeRowIndex: number | null,
      afterRowId: string | null,
      afterRowIndex: number | null,
      position: 'before' | 'after',
    ) => {
      const result = applyOrderingMove(
        api,
        sourceNode,
        targetParentPath,
        beforeRowId,
        beforeRowIndex,
        afterRowId,
        afterRowIndex,
        position,
      );
      if (result.success) return true;
      failureReason = result.reason ?? failureReason;
      return false;
    };

    let moved = false;
    if (hoveredRowTarget) {
      const parentPath = hoveredRowTarget.path.slice();
      moved = attemptMove(parentPath, null, null, null, null, 'after');
    }
    if (!moved && gap) {
      const parentPath = Array.isArray(gap.parentPath) ? gap.parentPath.slice() : [];
      moved = attemptMove(parentPath, gap.beforeRowId, gap.beforeRowIndex, gap.afterRowId, gap.afterRowIndex, gap.position);
    }

    if (!moved) {
      console.warn('Drop detected but TreeOrdering could not be updated', { payload, gap, hoveredRowTarget });
      showInvalidDropMessage(failureReason);
      return;
    }

    api.applyColumnState({
      state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: true,
    });
    reorderRowsByTreeOrdering(api);
    if (manualMode) {
      api.refreshCells({ columns: ['TreeOrdering', 'BrandName'], force: true });
    }
    void persistTreeOrderingChanges();
  }, [gapHover, rowHover, manualMode, computeHoverState, persistTreeOrderingChanges]);

  const handleCellValueChanged = useCallback((event: CellValueChangedEvent<RowData>) => {
    if (!manualMode) return;
    if (event.colDef.field !== 'TreeOrdering') return;
    event.api.applyColumnState({
      state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: true,
    });
    reorderRowsByTreeOrdering(event.api);
    void persistTreeOrderingChanges();
  }, [manualMode, persistTreeOrderingChanges]);

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
          onCellValueChanged={handleCellValueChanged}
        />
        {/* Row hover overlay */}
        <div className="row-hover-overlay" style={rowOverlayStyle} />
        {/* Gap hover overlay */}
        <div className="gap-hover-line" style={gapOverlayStyle} />
      </div>
    </div>
  );
}
