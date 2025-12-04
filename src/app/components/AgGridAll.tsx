'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  CellClickedEvent,
  CellContextMenuEvent,
  CellValueChangedEvent,
  ColumnPinnedType,
  ColumnState,
  ColDef,
  ContextMenuVisibleChangedEvent,
  DefaultMenuItem,
  FilterChangedEvent,
  FirstDataRenderedEvent,
  GetContextMenuItems,
  GetContextMenuItemsParams,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  MenuItemDef,
  ModelUpdatedEvent,
  RowClassParams,
  RowDoubleClickedEvent,
  RowHeightParams,
  RowNode,
  SelectionChangedEvent,
  SortChangedEvent,
} from 'ag-grid-community';
import { AllEnterpriseModule, LicenseManager, ModuleRegistry } from 'ag-grid-enterprise';
import { usePathname } from 'next/navigation';
import { resolveOfferProductRowType, type OfferProductRowType, describeOfferProductRowType } from '../../lib/offerProductRows';
import { showToastMessage } from '../../lib/toast';
import styles from './AgGridAll.module.css';
import { useAuditUser } from './AuditUserProvider';

// Prevent double registration during HMR/StrictMode
declare global {
  var __AG_ALL_REGISTERED__: boolean | undefined;
}
if (!globalThis.__AG_ALL_REGISTERED__) {
  ModuleRegistry.registerModules([AllEnterpriseModule]); // Brings SSRM, filters, editors, panels, etc.
  globalThis.__AG_ALL_REGISTERED__ = true;
}

LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE || '');

export type GridTotals = {
  totalListPrice: number;
  totalNetPrice: number;
  totalCost: number;
};

type Props = {
  endpoint: string;
  columnDefs: ColDef[];
  defaultColDef?: ColDef;
  manualMode?: boolean;
  requestPayload?: Record<string, unknown> | null;
  rowSelection?: 'single' | 'multiple';
  rowMultiSelectWithClick?: boolean;
  suppressRowClickSelection?: boolean;
  onGridReady?: (api: GridApi<RowData>) => void;
  onSelectionChanged?: (rows: RowData[], api: GridApi<RowData>) => void;
  onModelUpdated?: (api: GridApi<RowData>) => void;
  rowGroupPanelShow?: 'always' | 'onlyWhenGrouping' | 'never';
  getRowClass?: (params: RowClassParams<RowData>) => string | string[] | undefined;
  getContextMenuItems?: (params: GetContextMenuItemsParams<RowData>) => (MenuItemDef | string)[] | undefined;
  onCellValueChanged?: (event: CellValueChangedEvent<RowData>) => void;
  onRowDoubleClicked?: (event: RowDoubleClickedEvent<RowData>) => void;
  getRowHeight?: (params: RowHeightParams<RowData>) => number | undefined;
  refreshToken?: number;
  autoSizeExclusions?: string[];
  suppressColumnVirtualisation?: boolean;
  onTotalsChange?: (totals: GridTotals | null) => void;
  enableColumnStatePersistence?: boolean;
  columnStateNamespace?: string;
  onResponse?: (response: GridResponse | null) => void;
};

type RowData = Record<string, unknown>;

export type GridResponse = {
  ok: boolean;
  rows: RowData[];
  rowCount: number;
  totals?: GridTotals | null;
  error?: string;
  requestedColumns?: Record<string, boolean> | null;
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

type MoveFailureReason = 'target-non-category' | 'descendant' | 'invalid-target';

const ROOT_PARENT_KEY = '__root__';
const PERSISTED_TREE_KEY = '__persistedTreeOrdering';
const GRID_COLUMN_STATE_STORAGE_PREFIX = 'fastquote-grid-column-state';
const GRID_COLUMN_STATE_DEFAULT_USER = 'anon';

type SavedColumnStateEntry = {
  colId: string;
  pinned?: ColumnPinnedType | null;
  width?: number;
  flex?: number | null;
  rowGroup?: boolean;
  rowGroupIndex?: number | null;
};

const sanitizeStorageSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

const buildGridColumnStateStorageKey = (endpoint: string, userId: string, context: string): string => {
  const normalizedEndpoint = sanitizeStorageSegment(endpoint || '');
  const normalizedUser = userId && userId.trim() ? userId.trim() : GRID_COLUMN_STATE_DEFAULT_USER;
  const normalizedContext = sanitizeStorageSegment(context || '');
  const endpointPart = normalizedEndpoint || 'grid';
  const contextPart = normalizedContext || 'grid';
  return `${GRID_COLUMN_STATE_STORAGE_PREFIX}:${normalizedUser}:${endpointPart}:${contextPart}`;
};

const collectPersistableColumnState = (state: ColumnState[]): SavedColumnStateEntry[] =>
  state
    .map((entry) => {
      const width =
        typeof entry.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
          ? entry.width
          : undefined;
      return {
        colId: entry.colId ?? '',
        pinned: (entry.pinned ?? null) as ColumnPinnedType | null,
        width,
        flex: entry.flex ?? null,
        rowGroup: entry.rowGroup ?? undefined,
        rowGroupIndex:
          typeof entry.rowGroupIndex === 'number' && Number.isFinite(entry.rowGroupIndex)
            ? entry.rowGroupIndex
            : undefined,
      };
    })
    .filter((entry) => typeof entry.colId === 'string' && entry.colId.length > 0);

const readPersistedColumnState = (key: string): SavedColumnStateEntry[] | null => {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.columns)) return null;
    const entries: SavedColumnStateEntry[] = [];
    for (const candidate of parsed.columns) {
      if (!candidate || typeof candidate !== 'object') continue;
      const colId = typeof (candidate as { colId?: unknown }).colId === 'string'
        ? (candidate as { colId?: string }).colId
        : '';
      if (!colId) continue;
      const entry: SavedColumnStateEntry = { colId };
      if ('pinned' in candidate) {
        entry.pinned = (candidate as { pinned?: ColumnPinnedType | null }).pinned ?? null;
      }
      if ('width' in candidate) {
        entry.width = typeof (candidate as { width?: number }).width === 'number'
          ? (candidate as { width?: number }).width
          : undefined;
      }
      if ('flex' in candidate) {
        entry.flex = (candidate as { flex?: number | null }).flex ?? null;
      }
      if ('rowGroup' in candidate) {
        entry.rowGroup = Boolean((candidate as { rowGroup?: boolean }).rowGroup);
      }
      if ('rowGroupIndex' in candidate) {
        const idx = (candidate as { rowGroupIndex?: number }).rowGroupIndex;
        entry.rowGroupIndex =
          typeof idx === 'number' && Number.isFinite(idx) ? idx : undefined;
      }
      entries.push(entry);
    }
    return entries.length > 0 ? entries : null;
  } catch (err) {
    console.warn('Failed to read saved column state', err);
    return null;
  }
};

const writePersistedColumnState = (key: string, columns: SavedColumnStateEntry[]) => {
  if (typeof window === 'undefined' || !key) return;
  try {
    if (columns.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ columns }));
  } catch (err) {
    console.warn('Failed to save column state', err);
  }
};

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

const normalizeAggregateValue = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const parseTotalsPayload = (payload: unknown): GridTotals | null => {
  if (!payload || typeof payload !== 'object') return null;
  const data = payload as { totalListPrice?: unknown; totalNetPrice?: unknown; totalCost?: unknown };
  return {
    totalListPrice: normalizeAggregateValue(data.totalListPrice ?? 0),
    totalNetPrice: normalizeAggregateValue(data.totalNetPrice ?? 0),
    totalCost: normalizeAggregateValue(data.totalCost ?? 0),
  };
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

const showInvalidDropMessage = (reason: MoveFailureReason | null, targetType?: OfferProductRowType | null) => {
  let message: string;
  if (reason === 'target-non-category') {
    const friendly = describeOfferProductRowType(targetType);
    message = `${friendly} cannot contain rows. Drop into a category row or a highlighted gap instead.`;
  } else if (reason === 'descendant') {
    message = 'You cannot drop a row into itself or its descendants.';
  } else {
    message = 'That drop location is not allowed. Try a highlighted gap or category row.';
  }
  showToastMessage(message, 'error');
};

type MoveResult =
  | { success: true }
  | { success: false; reason: MoveFailureReason; targetType?: OfferProductRowType | null };

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
    const parentType = resolveOfferProductRowType(parentData);
    if (parentType !== 'unknown' && parentType !== 'category') {
      return { success: false, reason: 'target-non-category', targetType: parentType };
    }
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

const refreshServerSideData = (api?: GridApi<RowData>, opts?: { purge?: boolean }) => {
  if (!api || typeof api.refreshServerSide !== 'function' || api.isDestroyed?.()) return;
  try {
    const purge = opts?.purge ?? true;
    api.refreshServerSide({ purge });
  } catch (err) {
    console.error('Failed to refresh server-side rows', err);
  }
};

const GUARDED_SET_FILTERS = new Map<string, string[]>([
  ['Enabled', ['true', 'false']],
  ['IsParent', ['true', 'false']],
]);

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
const TREE_DEPENDENT_COLUMNS = ['TreeOrdering', 'BrandName', 'TotalPrice', 'TotalNet', 'TotalCost'];

export default function AgGridAll({
  endpoint,
  columnDefs,
  defaultColDef,
  manualMode = false,
  requestPayload = null,
  rowSelection,
  rowMultiSelectWithClick,
  suppressRowClickSelection,
  onGridReady: externalGridReadyHandler,
  onSelectionChanged: externalSelectionChangedHandler,
  onRowDoubleClicked: externalRowDoubleClickHandler,
  rowGroupPanelShow = 'always',
  getRowClass,
  getContextMenuItems,
  onCellValueChanged: externalCellValueChangeHandler,
  getRowHeight,
  onModelUpdated,
  refreshToken = 0,
  autoSizeExclusions = [],
  onTotalsChange,
  suppressColumnVirtualisation = false,
  enableColumnStatePersistence = true,
  columnStateNamespace = '',
  onResponse,
}: Props) {
  const gridRef = useRef<AgGridReact<RowData> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const gridApiRef = useRef<GridApi<RowData> | null>(null);
  const columnSaveTimerRef = useRef<number | null>(null);
  const [isGridReady, setIsGridReady] = useState(false);
  const { userId } = useAuditUser();
  const pathname = usePathname();
  const shouldPersistColumnState = enableColumnStatePersistence !== false;
  const columnStateStorageKey = useMemo(
    () => {
      if (!shouldPersistColumnState) return '';
      const context = columnStateNamespace || pathname || '';
      return buildGridColumnStateStorageKey(endpoint, userId, context ?? '');
    },
    [columnStateNamespace, endpoint, pathname, userId, shouldPersistColumnState],
  );
  const [gapHover, setGapHover] = useState<GapHoverState | null>(null);
  const [rowHover, setRowHover] = useState<RowHoverState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExternalRefreshRef = useRef<number | null>(null);
  const [contextMenuRowId, setContextMenuRowId] = useState<string | null>(null);

  const handleCellContextMenu = useCallback((event: CellContextMenuEvent<RowData>) => {
    setContextMenuRowId(event.node?.id ?? null);
  }, []);

  const clearContextMenuRow = useCallback(() => {
    setContextMenuRowId(null);
  }, []);

  const handleContextMenuVisibleChanged = useCallback((event: ContextMenuVisibleChangedEvent<RowData>) => {
    if (!event.visible) {
      clearContextMenuRow();
    }
  }, [clearContextMenuRow]);

  useEffect(() => {
    const handleClick = () => clearContextMenuRow();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearContextMenuRow();
      }
    };
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [clearContextMenuRow]);

  const persistColumnState = useCallback(() => {
    if (!shouldPersistColumnState || !columnStateStorageKey) return;
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) return;
    const nextState = collectPersistableColumnState(api.getColumnState());
    writePersistedColumnState(columnStateStorageKey, nextState);
  }, [columnStateStorageKey, shouldPersistColumnState]);

  const queuePersistColumnState = useCallback(() => {
    if (!shouldPersistColumnState || typeof window === 'undefined') return;
    if (columnSaveTimerRef.current) {
      window.clearTimeout(columnSaveTimerRef.current);
    }
    columnSaveTimerRef.current = window.setTimeout(() => {
      columnSaveTimerRef.current = null;
      persistColumnState();
    }, 200);
  }, [persistColumnState, shouldPersistColumnState]);

  const applySavedColumnState = useCallback((api: GridApi<RowData>) => {
    if (!shouldPersistColumnState || !columnStateStorageKey) return;
    const persisted = readPersistedColumnState(columnStateStorageKey);
    if (!persisted || persisted.length === 0) return;
    const currentColumnIds = new Set(
      api
        .getColumnState()
        .map((entry) => entry.colId ?? '')
        .filter((colId): colId is string => typeof colId === 'string' && colId.length > 0),
    );
    const filtered = persisted.filter((entry) => currentColumnIds.has(entry.colId));
    if (filtered.length === 0) return;
    const sanitizedState = filtered.map((entry) => ({
      colId: entry.colId,
      width: entry.width,
      flex: entry.flex ?? undefined,
      pinned: entry.pinned ?? undefined,
      rowGroup: entry.rowGroup ?? undefined,
      rowGroupIndex: entry.rowGroup ? entry.rowGroupIndex ?? 0 : undefined,
    }));
    try {
      api.applyColumnState({ state: sanitizedState, applyOrder: true, defaultState: { hide: null } });
    } catch (err) {
      console.warn('Failed to apply saved column state', err);
    }
  }, [columnStateStorageKey, shouldPersistColumnState]);

  useEffect(() => () => {
    if (columnSaveTimerRef.current) {
      window.clearTimeout(columnSaveTimerRef.current);
      columnSaveTimerRef.current = null;
    }
  }, []);

  const autoSizeColumns = useCallback((api?: GridApi<RowData> | null) => {
    const gridApi = api ?? gridRef.current?.api ?? null;
    if (!gridApi || gridApi.isDestroyed?.()) return;
    const resize = () => {
      if (gridApi.isDestroyed?.()) return;
      const displayed = typeof gridApi.getAllDisplayedColumns === 'function' ? gridApi.getAllDisplayedColumns() : null;
      if (!displayed || displayed.length === 0) return;
      const exclusions = new Set(autoSizeExclusions ?? []);
      const columnsToSize = displayed.filter((col) => {
        const colId = typeof col.getColId === 'function'
          ? col.getColId()
          : (typeof (col as { getId?: () => string }).getId === 'function'
            ? (col as { getId?: () => string }).getId?.()
            : null);
        if (!colId) return true;
        return !exclusions.has(colId);
      });
      if (columnsToSize.length === 0) return;
      const columnIds = columnsToSize
        .map((col) => {
          if (typeof col.getColId === 'function') return col.getColId();
          if (typeof (col as { getId?: () => string }).getId === 'function') return (col as { getId?: () => string }).getId?.();
          return null;
        })
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      if (columnIds.length === 0) return;
      gridApi.autoSizeColumns(columnIds, false);
    };
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(resize);
    } else {
      setTimeout(resize, 0);
    }
  }, [autoSizeExclusions]);

  const handleColumnVisible = useCallback(() => {
    autoSizeColumns();
    if (shouldPersistColumnState) {
      queuePersistColumnState();
    }
  }, [autoSizeColumns, queuePersistColumnState, shouldPersistColumnState]);

  const handleFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    autoSizeColumns(event.api);
  }, [autoSizeColumns]);

  useEffect(() => {
    autoSizeColumns();
  }, [autoSizeColumns, manualMode]);

  const dcd: ColDef = useMemo(() => {
    const baseFilterParams = {
      buttons: ['apply', 'clear'] as const,
      closeOnApply: true,
    };
    const incomingFilterParams = defaultColDef?.filterParams;
    const mergedFilterParams = typeof incomingFilterParams === 'object' && incomingFilterParams !== null
      ? { ...baseFilterParams, ...incomingFilterParams }
      : baseFilterParams;

    return {
      sortable: true,
      resizable: true,
      filter: true,
      floatingFilter: true,
      // Hide header menu icon and disable header menu on right-click
      suppressHeaderMenuButton: true,
      suppressHeaderContextMenu: true,
      width: 100,
      ...defaultColDef,
      filterParams: mergedFilterParams,
    };
  }, [defaultColDef]);

  const datasource: IServerSideDatasource<RowData> = useMemo(() => ({
    getRows: async (params: IServerSideGetRowsParams<RowData>) => {
      try {
        const payload = requestPayload && typeof requestPayload === 'object'
          ? { ...requestPayload }
          : {};
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payload, request: params.request }),
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
        if (typeof onTotalsChange === 'function') {
          const parsedTotals = parseTotalsPayload(data.totals ?? null);
          onTotalsChange(parsedTotals);
        }
        if (typeof onResponse === 'function') {
          onResponse(data);
        }
        params.success({ rowData: normalizedRows, rowCount: resolvedRowCount });
      } catch (e) {
        console.error('Datasource fetch exception', e);
        params.fail();
      }
    },
  }), [endpoint, onResponse, onTotalsChange, requestPayload]);

  const sideBarDef = useMemo(() => ({
    toolPanels: ['columns', 'filters'],
  }), []);

  const getRowId = useCallback((params: GetRowIdParams<RowData>) => {
    const data = params.data as Record<string, unknown> | undefined;
    if (!data) return `row_${Date.now()}_${Math.random()}`;
    const toKey = (value: unknown) => (value == null ? null : String(value));
    const key =
      toKey((data as { OfferDetailID?: number | string }).OfferDetailID) ??
      toKey((data as { ProductID?: number | string }).ProductID) ??
      toKey((data as { ContactID?: number | string }).ContactID) ??
      toKey((data as { CustomerGroupID?: number | string }).CustomerGroupID) ??
      toKey((data as { MarketID?: number | string }).MarketID) ??
      toKey((data as { ID?: number | string }).ID) ??
      toKey((data as { TreeOrdering?: string }).TreeOrdering);
    if (key) return key;
    return `row_${Date.now()}_${Math.random()}`;
  }, []);

  const onGridReady = useCallback((e: GridReadyEvent) => {
    e.api.setGridOption('serverSideDatasource', datasource);
    e.api.setSideBarVisible(true);
    e.api.closeToolPanel();
    if (pendingExternalRefreshRef.current != null) {
      pendingExternalRefreshRef.current = null;
      refreshServerSideData(e.api);
    }

    // Rebind context menu visibility listener to the current API
    if (gridApiRef.current && gridApiRef.current !== e.api) {
      gridApiRef.current.removeEventListener('contextMenuVisibleChanged', handleContextMenuVisibleChanged);
    }
    gridApiRef.current = e.api;
    gridApiRef.current.addEventListener('contextMenuVisibleChanged', handleContextMenuVisibleChanged);
    setIsGridReady(true);
    autoSizeColumns(e.api);
    if (typeof externalGridReadyHandler === 'function') {
      externalGridReadyHandler(e.api);
    }
  }, [autoSizeColumns, datasource, handleContextMenuVisibleChanged, externalGridReadyHandler]);
  const contextMenuItemsHandler = useCallback<GetContextMenuItems<RowData>>((params) => {
    if (typeof getContextMenuItems !== 'function') {
      return params.defaultItems ?? [];
    }
    const result = getContextMenuItems(params);
    if (!result || (Array.isArray(result) && result.length === 0 && params.defaultItems)) {
      return params.defaultItems ?? [];
    }
    const wrapActions = (items: Array<MenuItemDef<RowData> | DefaultMenuItem>) =>
      items.map((item) => {
        if (typeof item === 'string') return item;
        if (item.action) {
          const original = item.action;
          return {
            ...item,
            action: (actionParams: Parameters<NonNullable<MenuItemDef<RowData>['action']>>[0]) => {
              clearContextMenuRow();
              original(actionParams);
            },
          };
        }
        return item;
      });
    return Array.isArray(result)
      ? wrapActions(result as Array<MenuItemDef<RowData> | DefaultMenuItem>)
      : result;
  }, [getContextMenuItems, clearContextMenuRow]);

  const handleColumnRowGroupChanged = useCallback(() => {
    autoSizeColumns();
  }, [autoSizeColumns]);

  // Apply/remove the context menu highlight directly on row elements so it always clears
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const rows = Array.from(shell.querySelectorAll<HTMLElement>('.ag-row'));
    rows.forEach((row) => row.classList.remove('ag-row--context-menu-active'));
    if (!contextMenuRowId) return;
    // Row IDs are set by ag-Grid as the row-id attribute (applies to pinned/center containers)
    const targets = Array.from(shell.querySelectorAll<HTMLElement>(`.ag-row[row-id="${contextMenuRowId}"]`));
    targets.forEach((row) => row.classList.add('ag-row--context-menu-active'));
  }, [contextMenuRowId]);

  const handleFilterChanged = useCallback((event: FilterChangedEvent) => {
    const model = event.api.getFilterModel() as Record<string, FilterDescriptor> | null;
    if (!model) return;

    const nextModel: Record<string, FilterDescriptor> = { ...model };
    let mutated = false;

    Object.entries(model).forEach(([colId, descriptor]) => {
      const guardValues = GUARDED_SET_FILTERS.get(colId);
      if (!guardValues) return;
      if (!descriptor || typeof descriptor !== 'object') return;
      if (descriptor.filterType !== 'set') return;
      const values = Array.isArray(descriptor.values) ? descriptor.values : [];
      if (values.length > 0) return;

      nextModel[colId] = { ...descriptor, values: [...guardValues] };
      mutated = true;
    });

    if (mutated) {
      event.api.setFilterModel(nextModel);
    }
  }, []);

  const handleSortChanged = useCallback((event: SortChangedEvent<RowData>) => {
    // Keep rows visible for responsiveness while requesting the sorted data set from the server
    refreshServerSideData(event.api, { purge: false });
  }, []);

  const handleModelUpdated = useCallback((event: ModelUpdatedEvent<RowData>) => {
    autoSizeColumns(event.api);
    if (typeof onModelUpdated === 'function') {
      onModelUpdated(event.api);
    }
  }, [autoSizeColumns, onModelUpdated]);

  const mergedGetRowClass = useCallback((params: RowClassParams<RowData>) => {
    const parts: string[] = [];
    if (typeof getRowClass === 'function') {
      const result = getRowClass(params);
      if (typeof result === 'string') {
        parts.push(result);
      } else if (Array.isArray(result)) {
        parts.push(...result);
      }
    }
    if (contextMenuRowId && params.node?.id === contextMenuRowId) {
      parts.push('ag-row--context-menu-active');
    }
    if (parts.length === 0) return undefined;
    return parts;
  }, [getRowClass, contextMenuRowId]);

  useEffect(() => {
    if (!isGridReady || !shouldPersistColumnState) return;
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) return;
    applySavedColumnState(api);
    const hasTreeOrderingColumn = api
      .getColumnState()
      .some((entry) => entry.colId === 'TreeOrdering');
    if (!hasTreeOrderingColumn) return;
    api.applyColumnState({
      state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: true,
    });
    if (!manualMode) {
      reorderRowsByTreeOrdering(api);
    }
  }, [applySavedColumnState, isGridReady, manualMode, shouldPersistColumnState]);

  useEffect(() => {
    if (refreshToken === 0) return;
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) {
      pendingExternalRefreshRef.current = refreshToken;
      return;
    }
    pendingExternalRefreshRef.current = null;
    refreshServerSideData(api);
  }, [refreshToken]);

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
        // Special case: dropping after the very last row should append as a new root-level entry
        // rather than being nested under the last row's parent.
        if (!afterPath && gapCandidate.position === 'after') {
          return [];
        }
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
        window.dispatchEvent(new CustomEvent('fastquote-row-drop'));
      } catch {
        /* noop */
      }
    }

    if (!gap && !hoveredRowTarget) {
      return;
    }

    const rawPayload = ev.dataTransfer?.getData('application/x-fastquote-row+json')
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
    let failureTargetType: OfferProductRowType | null | undefined;
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
      failureTargetType = result.targetType ?? failureTargetType;
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
      showInvalidDropMessage(failureReason, failureTargetType);
      return;
    }

    api.applyColumnState({
      state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: true,
    });
    reorderRowsByTreeOrdering(api);
    api.refreshCells({ columns: TREE_DEPENDENT_COLUMNS, force: true });
    void persistTreeOrderingChanges();
  }, [gapHover, rowHover, computeHoverState, persistTreeOrderingChanges]);

  const handleActionCellClick = useCallback((params: CellClickedEvent<RowData>) => {
    if (params.column?.getColId() === '__actions__') {
      params.event?.preventDefault();
      params.event?.stopPropagation();
      if (typeof params.api.clearCellSelection === 'function') {
        params.api.clearCellSelection();
      }
    }
  }, []);

  const handleRowDoubleClick = useCallback((event: RowDoubleClickedEvent<RowData>) => {
    if (typeof externalRowDoubleClickHandler === 'function') {
      externalRowDoubleClickHandler(event);
    }
  }, [externalRowDoubleClickHandler]);

  const handleCellValueChanged = useCallback((event: CellValueChangedEvent<RowData>) => {
    if (manualMode && event.colDef.field === 'TreeOrdering') {
      event.api.applyColumnState({
        state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
        defaultState: { sort: null },
        applyOrder: true,
      });
      reorderRowsByTreeOrdering(event.api);
      event.api.refreshCells({ columns: TREE_DEPENDENT_COLUMNS, force: true });
      void persistTreeOrderingChanges();
    }
    if (typeof externalCellValueChangeHandler === 'function') {
      externalCellValueChangeHandler(event);
    }
  }, [manualMode, persistTreeOrderingChanges, externalCellValueChangeHandler]);

  const handleSelectionChanged = useCallback((event: SelectionChangedEvent<RowData>) => {
    if (typeof externalSelectionChangedHandler !== 'function') return;
    try {
      const rows = typeof event.api.getSelectedRows === 'function' ? event.api.getSelectedRows() : [];
      externalSelectionChangedHandler(rows ?? [], event.api);
    } catch (err) {
      console.warn('Failed to read selected rows', err);
      externalSelectionChangedHandler([], event.api);
    }
  }, [externalSelectionChangedHandler]);

  const clearGridSelection = useCallback(() => {
    const api = gridRef.current?.api;
    if (!api) return;
    let cleared = false;
    try {
      if (typeof api.clearCellSelection === 'function') {
        api.clearCellSelection();
        cleared = true;
      }
    } catch (err) {
      console.warn('Failed to clear cell selection', err);
    }
    if (!cleared && typeof api.deselectAll === 'function') {
      try { api.deselectAll(); } catch { /* noop */ }
    }
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (shell && target && shell.contains(target)) return;
      clearGridSelection();
    };
    document.addEventListener('mousedown', handlePointerDown, true);
    document.addEventListener('touchstart', handlePointerDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown, true);
      document.removeEventListener('touchstart', handlePointerDown, true);
    };
  }, [clearGridSelection]);

  useEffect(() => {
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    return () => {
      if (!api || api.isDestroyed?.()) return;
      api.removeEventListener('contextMenuVisibleChanged', handleContextMenuVisibleChanged);
    };
  }, [handleContextMenuVisibleChanged]);

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) return;
    api.refreshCells({ force: true });
  }, [contextMenuRowId]);

  const rowOverlayStyle: CSSProperties = {
    top: rowHover ? rowHover.top : -9999,
    height: rowHover ? rowHover.height : 0,
    opacity: isDragging && rowHover ? 1 : 0,
  };

  const gapOverlayStyle: CSSProperties = {
    top: gapHover?.pos ?? -9999,
    opacity: isDragging && gapHover ? 1 : 0,
  };

  return (
    <div className={styles.container}>
      <div
        className={`ag-theme-quartz ${styles.gridShell}`}
        data-ag-grid-size="compact"
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
          getRowClass={mergedGetRowClass}
          getContextMenuItems={getContextMenuItems ? contextMenuItemsHandler : undefined}
          onFirstDataRendered={handleFirstDataRendered}
          onCellContextMenu={handleCellContextMenu}
          rowHeight={32}
          headerHeight={38}
          rowSelection={rowSelection}
          rowMultiSelectWithClick={rowMultiSelectWithClick}
          suppressRowClickSelection={suppressRowClickSelection}

          // Server-Side model
          rowModelType="serverSide"
          serverSideEnableClientSideSort={true}

          // No selection needed for handle-only drag
          // rowSelection removed to avoid SSRM warning

          // Enterprise UX
          sideBar={sideBarDef}
          statusBar={{ statusPanels: [{ statusPanel: 'agAggregationComponent' }] }}
          suppressCellFocus={true}
          cellSelection={true}

          // Charts OFF for now (to avoid the AgCharts module requirement)
          enableCharts={false}

          // Grouping/pivot flags are fine; without a license they’re ignored, not crashed
          pivotMode={false}
          rowGroupPanelShow={rowGroupPanelShow}
          getRowHeight={getRowHeight}
          suppressColumnVirtualisation={suppressColumnVirtualisation}

          // Cache settings
          cacheBlockSize={100}
          maxBlocksInCache={10}

          onGridReady={onGridReady}
          onFilterChanged={handleFilterChanged}
          onSortChanged={handleSortChanged}
          onModelUpdated={handleModelUpdated}
          onCellClicked={handleActionCellClick}
          onRowDoubleClicked={handleRowDoubleClick}
          onCellValueChanged={handleCellValueChanged}
          onSelectionChanged={externalSelectionChangedHandler ? handleSelectionChanged : undefined}
          onColumnMoved={shouldPersistColumnState ? queuePersistColumnState : undefined}
          onColumnPinned={shouldPersistColumnState ? queuePersistColumnState : undefined}
          onColumnVisible={handleColumnVisible}
          onColumnResized={shouldPersistColumnState ? queuePersistColumnState : undefined}
          onColumnRowGroupChanged={handleColumnRowGroupChanged}
        />
        {/* Row hover overlay */}
        <div
          className={styles.rowHoverOverlay}
          data-active={rowHover ? 'true' : 'false'}
          style={rowOverlayStyle}
        />
        {/* Gap hover overlay */}
        <div className={styles.gapHoverLine} style={gapOverlayStyle} />
      </div>
    </div>
  );
}
