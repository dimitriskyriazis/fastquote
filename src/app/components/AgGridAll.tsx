'use client';

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  CellContextMenuEvent,
  CellEditingStartedEvent,
  CellMouseDownEvent,
  CellValueChangedEvent,
  Column,
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
  GridOptions,
  GridReadyEvent,
  RowNode,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  MenuItemDef,
  ModelUpdatedEvent,
  RowClassParams,
  RowDoubleClickedEvent,
  RowDragEndEvent,
  RowHeightParams,
  RowSelectionOptions,
  SelectionChangedEvent,
  SortChangedEvent,
  ServerSideRowSelectionState,
} from 'ag-grid-community';
import { AllEnterpriseModule, LicenseManager, ModuleRegistry } from 'ag-grid-enterprise';
import { usePathname } from 'next/navigation';
import { showToastMessage } from '../../lib/toast';
import styles from './AgGridAll.module.css';
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from './actionMenuMarkers';
import { setGridRowDeletionContextMenuSelectionSnapshot } from '../../lib/gridRowDeletion';
import { useAuditUser } from './AuditUserProvider';
import { GridQuickSearchContext } from './GridQuickSearchProvider';
import { restoreCaretSelection } from '../hooks/useCaretKeeper';

const ACTION_MENU_SELECTOR = `[${ACTION_MENU_TRIGGER_ATTRIBUTE}], [${ACTION_MENU_PANEL_ATTRIBUTE}]`;
const PRESERVE_SELECTION_SELECTOR = '[data-fastquote-keep-selection="true"]';


const resolveElementFromEventTarget = (target: EventTarget | null): Element | null => {
  let current: EventTarget | null = target;
  while (current) {
    if (current instanceof Element) return current;
    if (current instanceof Node) {
      current = current.parentNode;
      continue;
    }
    return null;
  }
  return null;
};

export type AgGridAllProps = Props;

const isActionMenuEventTarget = (target: EventTarget | null): boolean => {
  const element = resolveElementFromEventTarget(target);
  return Boolean(element?.closest(ACTION_MENU_SELECTOR));
};

const isSelectionPreservingTarget = (target: Element | null) =>
  Boolean(target?.closest(PRESERVE_SELECTION_SELECTOR));

const collectFieldIdsFromDefs = (defs: ColDef[] | null | undefined): string[] => {
  if (!defs) return [];
  const fields: string[] = [];
  const walk = (items: ColDef[]) => {
    items.forEach((def) => {
      if (!def) return;
      if (typeof def.field === 'string' && def.field.length > 0) {
        fields.push(def.field);
      }
      const children = (def as { children?: ColDef[] }).children;
      if (Array.isArray(children) && children.length > 0) {
        walk(children);
      }
    });
  };
  walk(defs);
  return fields;
};

const scheduleDeselectAllRows = (api?: GridApi<RowData> | null) => {
  if (!api || typeof api.deselectAll !== 'function') return;
  setTimeout(() => {
    if (api.isDestroyed?.()) return;
    try {
      api.deselectAll();
      if (typeof api.clearCellSelection === 'function') {
        api.clearCellSelection();
      }
      if (typeof api.clearFocusedCell === 'function') {
        api.clearFocusedCell();
      }
    } catch {
      /* noop */
    }
  }, 0);
};

const focusEditingInput = (editor?: HTMLElement | null) => {
  const input =
    (editor?.querySelector < HTMLInputElement | HTMLTextAreaElement >('input, textarea') ?? null) ??
    document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '.ag-cell-edit-wrapper input, .ag-cell-edit-wrapper textarea, .ag-cell-editing input, .ag-cell-editing textarea',
    );
  if (!input) return;
  restoreCaretSelection(input);
};

const QUICK_SEARCH_REFRESH_DEBOUNCE_MS = 220;

const useMutationCaret = () => {
  useEffect(() => {
    const handleNodes = (nodes: NodeList) => {
      nodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        const target = node.matches('input, textarea')
          ? (node as HTMLInputElement | HTMLTextAreaElement)
          : node.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
        if (target && target.closest('.ag-cell-editing')) {
          restoreCaretSelection(target);
        }
      });
    };
    const handleMutation = (records: MutationRecord[]) => {
      for (const record of records) {
        if (record.type === 'childList') {
          handleNodes(record.addedNodes);
        } else if (record.type === 'attributes') {
          const target = record.target;
          if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
            restoreCaretSelection(target);
          }
        }
      }
    };
    const observer = new MutationObserver(handleMutation);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['value'],
    });
    return () => observer.disconnect();
  }, []);
};

const focusFromEvent = (api: GridApi<RowData>, column: Column | null) => {
  const editors = typeof api.getCellEditorInstances === 'function'
    ? api.getCellEditorInstances({
        columns: column ? [column] : undefined,
      })
    : [];
  const editorInstance = editors?.[0] as unknown as { getGui?: () => HTMLElement | null };
  const editorGui =
    editorInstance && typeof editorInstance.getGui === 'function'
      ? editorInstance.getGui()
      : null;
  focusEditingInput(editorGui);
};

const useEditorFocusHandlers = () => {
  const editingActiveRef = useRef(false);
  const pendingRefreshRef = useRef<(() => void) | null>(null);

  const flushPendingRefresh = useCallback(() => {
    const action = pendingRefreshRef.current;
    pendingRefreshRef.current = null;
    action?.();
  }, []);

  const handleEditingStart = useCallback((event: CellEditingStartedEvent<RowData>) => {
    editingActiveRef.current = true;
    focusFromEvent(event.api, event.column);
  }, []);

  const handleEditingStop = useCallback(() => {
    editingActiveRef.current = false;
    flushPendingRefresh();
  }, [flushPendingRefresh]);

  const requestRefresh = useCallback((action: () => void) => {
    if (editingActiveRef.current) {
      pendingRefreshRef.current = action;
      return;
    }
    action();
  }, []);

  return { handleEditingStart, handleEditingStop, requestRefresh };
};

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
  allowRowClickSelection?: boolean;
  onGridReady?: (api: GridApi<RowData>) => void;
  onSelectionChanged?: (rows: RowData[], api: GridApi<RowData>) => void;
  onModelUpdated?: (api: GridApi<RowData>) => void;
  rowGroupPanelShow?: 'always' | 'onlyWhenGrouping' | 'never';
  suppressRowGroup?: boolean;
  getRowClass?: (params: RowClassParams<RowData>) => string | string[] | undefined;
  getContextMenuItems?: (params: GetContextMenuItemsParams<RowData>) => Array<MenuItemDef<RowData> | DefaultMenuItem | string> | undefined;
  onCellValueChanged?: (event: CellValueChangedEvent<RowData>) => void;
  onRowDoubleClicked?: (event: RowDoubleClickedEvent<RowData>) => void;
  getRowHeight?: (params: RowHeightParams<RowData>) => number | undefined;
  refreshToken?: number;
  autoSizeExclusions?: string[];
  suppressColumnVirtualisation?: boolean;
  suppressMovableColumns?: boolean;
  onTotalsChange?: (totals: GridTotals | null) => void;
  enableColumnStatePersistence?: boolean;
  columnStateNamespace?: string;
  onResponse?: (response: GridResponse | null) => void;
  onRowsMoved?: (api: GridApi<RowData>) => void;
  rowDeselection?: boolean;
  disableAutoSize?: boolean;
  performanceMode?: boolean;
  allowQuickSearch?: boolean;
  quickSearchValue?: string;
  onServerRequest?: (request: ServerRequestWithQuickFilter) => void;
  serverSideEnableClientSideSort?: boolean;
  cacheBlockSize?: number;
  rowBuffer?: number;
  maxBlocksInCache?: number;
  floatingFilter?: boolean;
  onHeaderSelectAllChange?: (selected: boolean, api: GridApi<RowData> | null) => void;
  onRequestPayloadConsumed?: () => void;
};

type RowData = Record<string, unknown>;

export type ServerRequestWithQuickFilter = IServerSideGetRowsParams<RowData>["request"] & {
  quickFilterText?: string | null;
};

export type GridResponse = {
  ok: boolean;
  rows: RowData[];
  rowCount: number;
  totals?: GridTotals | null;
  error?: string;
  requestedColumns?: Record<string, boolean> | null;
  request?: ServerRequestWithQuickFilter | null;
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
  selectedRowIds?: Array<string | null>;
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

const PERSISTED_TREE_KEY = '__persistedTreeOrdering';
const GRID_COLUMN_STATE_STORAGE_PREFIX = 'fastquote-grid-column-state';
const GRID_COLUMN_STATE_DEFAULT_USER = 'anon';
const AUTO_SIZE_MIN_INTERVAL_MS = 400;

type SavedColumnStateEntry = {
  colId: string;
  pinned?: ColumnPinnedType | null;
  width?: number;
  flex?: number | null;
  rowGroup?: boolean;
  rowGroupIndex?: number | null;
};

const sanitizeStorageSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
};

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

const longestCommonPrefix = (a: number[], b: number[]): number[] => {
  const limit = Math.min(a.length, b.length);
  const prefix: number[] = [];
  for (let idx = 0; idx < limit; idx += 1) {
    if (a[idx] !== b[idx]) break;
    prefix.push(a[idx]);
  }
  return prefix;
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
  allowRowClickSelection: allowRowClickSelectionProp,
  rowDeselection,
  onGridReady: externalGridReadyHandler,
  onSelectionChanged: externalSelectionChangedHandler,
  onRowDoubleClicked: externalRowDoubleClickHandler,
  onRowsMoved,
  rowGroupPanelShow = 'always',
  suppressRowGroup = false,
  getRowClass,
  getContextMenuItems,
  onCellValueChanged: externalCellValueChangeHandler,
  getRowHeight,
  onModelUpdated,
  refreshToken = 0,
  autoSizeExclusions = [],
  onTotalsChange,
  suppressColumnVirtualisation = false,
  suppressMovableColumns = false,
  enableColumnStatePersistence = true,
  columnStateNamespace = '',
  onResponse,
  disableAutoSize = false,
  performanceMode,
  allowQuickSearch = true,
  quickSearchValue,
  onServerRequest,
  serverSideEnableClientSideSort = true,
  cacheBlockSize,
  rowBuffer = 5,
  maxBlocksInCache = 10,
  floatingFilter = true,
  onHeaderSelectAllChange,
  onRequestPayloadConsumed,
}: Props) {
  useMutationCaret();
  const { handleEditingStart, handleEditingStop, requestRefresh } = useEditorFocusHandlers();
  const wrapGridApiRefreshers = useCallback((api: GridApi<RowData> | null) => {
    if (!api || typeof requestRefresh !== 'function') return;
    const wrap = (method: 'refreshCells' | 'refreshServerSide' | 'redrawRows') => {
      const marker = `__fastquote_wrapped_${method}`;
      if ((api as unknown as Record<string, unknown>)[marker]) return;
      const original = (api as unknown as Record<string, unknown>)[method];
      if (typeof original !== 'function') return;
      (api as unknown as Record<string, unknown>)[marker] = true;
      const boundOriginal = (original as (...args: unknown[]) => unknown).bind(api);
      (api as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
        requestRefresh(() => boundOriginal(...args));
      };
    };
    wrap('refreshCells');
    wrap('refreshServerSide');
    wrap('redrawRows');
  }, [requestRefresh]);
  const gridRef = useRef<AgGridReact<RowData> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const gridApiRef = useRef<GridApi<RowData> | null>(null);
  const pendingScrollRestoreTopRef = useRef<number | null>(null);
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
  const resolvedPerformanceMode = performanceMode !== false;
  const resolvedDisableAutoSize = disableAutoSize || resolvedPerformanceMode;
  const resolvedCacheBlockSize =
    typeof cacheBlockSize === 'number' && Number.isFinite(cacheBlockSize) && cacheBlockSize > 0
      ? Math.floor(cacheBlockSize)
      : resolvedPerformanceMode
        ? 20
        : 100;
  const resolvedRowBuffer =
    typeof rowBuffer === 'number' && Number.isFinite(rowBuffer) && rowBuffer > 0
      ? Math.floor(rowBuffer)
      : resolvedPerformanceMode
        ? 5
        : 5;
  const resolvedMaxBlocksInCache =
    typeof maxBlocksInCache === 'number' && Number.isFinite(maxBlocksInCache) && maxBlocksInCache > 0
      ? Math.floor(maxBlocksInCache)
      : resolvedPerformanceMode
        ? 2
        : 10;
  const shouldApplyMaxBlocksInCache = typeof getRowHeight !== 'function';
  const resolvedColumnDefs = useMemo(() => {
    if (!suppressRowGroup) return columnDefs;
    return columnDefs.map((definition) => ({
      ...definition,
      enableRowGroup: false,
    }));
  }, [columnDefs, suppressRowGroup]);
  const [gapHover, setGapHover] = useState<GapHoverState | null>(null);
  const [rowHover, setRowHover] = useState<RowHoverState | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExternalRefreshRef = useRef<number | null>(null);
  const [contextMenuRowId, setContextMenuRowId] = useState<string | null>(null);
  const quickSearchFilterRef = useRef("");
  const quickSearchEnabled = allowQuickSearch !== false;
  const quickSearchContext = useContext(GridQuickSearchContext);
  const resolvedQuickSearchValue = quickSearchValue ?? quickSearchContext?.value ?? '';
  const quickSearchRefreshRequestedRef = useRef(false);
  const focusRetryTimerRef = useRef<number | null>(null);
  const quickSearchEffectInitializedRef = useRef(false);
  const quickSearchAutoFocusEnabledRef = useRef(false);
  const quickSearchRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runQuickSearchFocus = useCallback(() => {
    const focusFn = quickSearchContext?.focus;
    if (typeof focusFn !== 'function') return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(focusFn);
    } else {
      focusFn();
    }
  }, [quickSearchContext]);
  const stopQuickSearchFocusRetries = useCallback(() => {
    if (focusRetryTimerRef.current && typeof window !== 'undefined') {
      window.clearTimeout(focusRetryTimerRef.current);
      focusRetryTimerRef.current = null;
    }
  }, []);
  const startQuickSearchFocusRetries = useCallback(() => {
    runQuickSearchFocus();
    if (typeof window === 'undefined') return;
    const attempt = () => {
      if (focusRetryTimerRef.current) {
        window.clearTimeout(focusRetryTimerRef.current);
        focusRetryTimerRef.current = null;
      }
      focusRetryTimerRef.current = window.setTimeout(() => {
        runQuickSearchFocus();
        if (quickSearchRefreshRequestedRef.current) {
          attempt();
        } else {
          focusRetryTimerRef.current = null;
        }
      }, 80);
    };
    attempt();
  }, [runQuickSearchFocus]);

  const hasServerSideSelectAll = useCallback((api?: GridApi<RowData> | null) => {
    if (!api || typeof api.getServerSideSelectionState !== 'function') return false;
    const state = api.getServerSideSelectionState();
    return Boolean(state && 'selectAll' in state && Boolean((state as ServerSideRowSelectionState).selectAll));
  }, []);

  const captureSelectionSnapshot = useCallback((api: GridApi<RowData> | null) => {
    if (hasServerSideSelectAll(api)) {
      setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, []);
      return;
    }
    const selectedNodes = typeof api?.getSelectedNodes === 'function'
      ? (api.getSelectedNodes() as Array<RowNode<RowData>>)
      : [];
    setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, selectedNodes ?? []);
  }, [hasServerSideSelectAll]);

  const handleCellContextMenu = useCallback((event: CellContextMenuEvent<RowData>) => {
    captureSelectionSnapshot(event.api ?? null);
    setContextMenuRowId(event.node?.id ?? null);
  }, [captureSelectionSnapshot]);

  const handleCellMouseDown = useCallback((event: CellMouseDownEvent<RowData>) => {
    const domEvent = event.event;
    if (!(domEvent instanceof MouseEvent) || domEvent.button !== 2) return;
    captureSelectionSnapshot(event.api ?? null);
  }, [captureSelectionSnapshot]);

  const clearContextMenuRow = useCallback(() => {
    setContextMenuRowId(null);
  }, []);

  const handleContextMenuVisibleChanged = useCallback((event: ContextMenuVisibleChangedEvent<RowData>) => {
    if (!event.visible) {
      clearContextMenuRow();
    }
  }, [clearContextMenuRow]);

  useEffect(() => {
    if (typeof onHeaderSelectAllChange !== 'function') return;
    const shell = shellRef.current;
    if (!shell) return;
    let headerCheckbox: HTMLInputElement | null = null;
    const handleCheckboxChange = () => {
      if (!headerCheckbox) return;
      onHeaderSelectAllChange(headerCheckbox.checked, gridRef.current?.api ?? null);
    };

    const attachHeaderCheckbox = () => {
      const nextCheckbox = shell.querySelector<HTMLInputElement>('.ag-header-select-all input[type="checkbox"]');
      if (headerCheckbox === nextCheckbox) return;
      if (headerCheckbox) {
        headerCheckbox.removeEventListener('change', handleCheckboxChange);
      }
      headerCheckbox = nextCheckbox;
      if (headerCheckbox) {
        headerCheckbox.addEventListener('change', handleCheckboxChange);
      }
    };

    attachHeaderCheckbox();
    const observer = new MutationObserver(attachHeaderCheckbox);
    observer.observe(shell, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (headerCheckbox) {
        headerCheckbox.removeEventListener('change', handleCheckboxChange);
      }
    };
  }, [onHeaderSelectAllChange]);

  useEffect(() => {
    const getCurrentGridApi = () => gridApiRef.current ?? gridRef.current?.api ?? null;
    const isPageHeaderArea = (element: Element | null) =>
      Boolean(element?.closest('.PageHeader-module__YnWxqa__headerSide'));

    const handleClick = (event: Event) => {
      const target = event.target ?? null;
      if (isActionMenuEventTarget(target)) return;
      const element = resolveElementFromEventTarget(target);
      const clickedInsideShell = Boolean(element?.closest('.ag-root-wrapper'));
      const clickedOnPageHeader = isPageHeaderArea(element);
      const clickedInsidePersistentArea = isSelectionPreservingTarget(element);
      if ((!clickedInsideShell && !clickedInsidePersistentArea) || clickedOnPageHeader) {
        scheduleDeselectAllRows(getCurrentGridApi());
      }
      clearContextMenuRow();
    };
    const handleMouseDown = (event: MouseEvent) => {
      const element = resolveElementFromEventTarget(event.target ?? null);
      const clickedOnPageHeader = isPageHeaderArea(element);
      const clickedInsidePersistentArea = isSelectionPreservingTarget(element);
      if (!element || clickedOnPageHeader) {
        if (!clickedInsidePersistentArea) {
          scheduleDeselectAllRows(getCurrentGridApi());
        }
        return;
      }
      if (clickedInsidePersistentArea) {
        return;
      }
      if (
        element.closest('.ag-row') ||
        element.closest('.ag-cell') ||
        element.closest('.ag-header')
      ) {
        return;
      }
      scheduleDeselectAllRows(getCurrentGridApi());
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearContextMenuRow();
      }
    };
    document.addEventListener('click', handleClick, true);
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('click', handleClick, true);
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [clearContextMenuRow]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const handleMouseDownCapture = (event: MouseEvent) => {
      if (event.button !== 2) return;
      const element = resolveElementFromEventTarget(event.target ?? null);
      if (!element?.closest('.ag-cell')) return;
      captureSelectionSnapshot(gridRef.current?.api ?? null);
    };
    shell.addEventListener('mousedown', handleMouseDownCapture, true);
    return () => {
      shell.removeEventListener('mousedown', handleMouseDownCapture, true);
    };
  }, [captureSelectionSnapshot]);

  useEffect(() => {
    if (!quickSearchEnabled) return;
    quickSearchFilterRef.current = resolvedQuickSearchValue.trim();
    if (!isGridReady) return;
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api || api.isDestroyed?.()) return;
    quickSearchRefreshRequestedRef.current = true;

    if (quickSearchRefreshTimerRef.current) {
      clearTimeout(quickSearchRefreshTimerRef.current);
      quickSearchRefreshTimerRef.current = null;
    }

    const queueQuickSearchRefresh = () => {
      quickSearchRefreshTimerRef.current = null;
      requestRefresh(() => {
        const refreshAction = () => refreshServerSideData(api);
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(refreshAction);
        } else {
          refreshAction();
        }
      });
    };

    quickSearchRefreshTimerRef.current = setTimeout(queueQuickSearchRefresh, QUICK_SEARCH_REFRESH_DEBOUNCE_MS);

    if (!quickSearchEffectInitializedRef.current) {
      quickSearchEffectInitializedRef.current = true;
    } else if (quickSearchAutoFocusEnabledRef.current) {
      startQuickSearchFocusRetries();
    }

    return () => {
      if (quickSearchRefreshTimerRef.current) {
        clearTimeout(quickSearchRefreshTimerRef.current);
        quickSearchRefreshTimerRef.current = null;
      }
    };
  }, [isGridReady, quickSearchEnabled, resolvedQuickSearchValue, requestRefresh, startQuickSearchFocusRetries]);

  useEffect(() => stopQuickSearchFocusRetries, [stopQuickSearchFocusRetries]);

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
    if (autoSizeFrameRef.current) {
      if (typeof window !== 'undefined') {
        window.cancelAnimationFrame(autoSizeFrameRef.current);
        window.clearTimeout(autoSizeFrameRef.current);
      }
      autoSizeFrameRef.current = null;
    }
  }, []);

  const autoSizeCompletedRef = useRef(false);
  const lastAutoSizeAtRef = useRef(0);
  const pendingAutoSizeApiRef = useRef<GridApi<RowData> | null>(null);
  const autoSizePendingRef = useRef(false);
  const autoSizeFrameRef = useRef<number | null>(null);

  useEffect(() => {
    autoSizeCompletedRef.current = false;
  }, [endpoint, resolvedDisableAutoSize]);

  const runAutoSize = useCallback((gridApi: GridApi<RowData>) => {
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
  }, [autoSizeExclusions]);

  const autoSizeColumns = useCallback((api?: GridApi<RowData> | null, force = false) => {
    if (resolvedDisableAutoSize) return;
    const gridApi = api ?? gridRef.current?.api ?? null;
    if (!gridApi || gridApi.isDestroyed?.()) return;
    if (!force && autoSizeCompletedRef.current) return;
    const now = Date.now();
    if (!force && now - lastAutoSizeAtRef.current < AUTO_SIZE_MIN_INTERVAL_MS) return;
    pendingAutoSizeApiRef.current = gridApi;
    if (autoSizePendingRef.current) return;
    autoSizePendingRef.current = true;
    const execute = () => {
      autoSizePendingRef.current = false;
      autoSizeFrameRef.current = null;
      const target = pendingAutoSizeApiRef.current;
      if (!target) return;
      runAutoSize(target);
      autoSizeCompletedRef.current = true;
      lastAutoSizeAtRef.current = Date.now();
    };
    if (force) {
      execute();
    } else if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      autoSizeFrameRef.current = window.requestAnimationFrame(execute);
    } else {
      autoSizeFrameRef.current = window.setTimeout(execute, 0) as unknown as number;
    }
  }, [resolvedDisableAutoSize, runAutoSize]);

  const handleColumnVisible = useCallback(() => {
    autoSizeColumns(undefined, true);
    if (shouldPersistColumnState) {
      queuePersistColumnState();
    }
  }, [autoSizeColumns, queuePersistColumnState, shouldPersistColumnState]);

  const handleFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    autoSizeColumns(event.api, true);
    autoSizeCompletedRef.current = true;
  }, [autoSizeColumns]);

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
      floatingFilter,
      // Hide header menu icon and disable header menu on right-click
      suppressHeaderMenuButton: true,
      suppressHeaderContextMenu: true,
      width: 100,
      ...defaultColDef,
      filterParams: mergedFilterParams,
    };
  }, [defaultColDef, floatingFilter]);

const requestPayloadRef = useRef(requestPayload);
requestPayloadRef.current = requestPayload;
const requestCacheRef = useRef(new Map<string, Promise<GridResponse>>());

  const sharedGridOptions = useMemo(
    () => ({
      cellSelection: {
        handle: {
          mode: 'range',
        },
      },
    }) as unknown as GridOptions<RowData>,
    [],
  );

const datasource: IServerSideDatasource<RowData> = useMemo(() => ({
    getRows: async (params: IServerSideGetRowsParams<RowData>) => {
      try {
        const payload = requestPayloadRef.current && typeof requestPayloadRef.current === 'object'
          ? { ...requestPayloadRef.current }
          : {};
        if (payload && 'newProductId' in payload && typeof onRequestPayloadConsumed === 'function') {
          onRequestPayloadConsumed();
        }
        const serverRequest: ServerRequestWithQuickFilter = { ...params.request };
        if (typeof onServerRequest === 'function') {
          onServerRequest(serverRequest);
        }
        if (quickSearchEnabled) {
          const quickFilterText = quickSearchFilterRef.current;
          if (typeof quickFilterText === 'string' && quickFilterText.length > 0) {
            serverRequest.quickFilterText = quickFilterText;
          } else {
            delete serverRequest.quickFilterText;
          }
        }
        const visibleFields = params.api?.getAllDisplayedColumns?.()
          ?.map((column) => column.getColDef()?.field)
          .filter((field): field is string => typeof field === 'string' && field.length > 0) ?? [];
        const fallbackFields = collectFieldIdsFromDefs(resolvedColumnDefs);
        const fields = visibleFields.length > 0 ? visibleFields : fallbackFields;
        const bodyRequest = { ...payload, request: serverRequest, fields };
        const cacheKey = `${endpoint}:${safeStringify(payload)}:${safeStringify(serverRequest)}:${safeStringify(fields)}`;
          let responsePromise = requestCacheRef.current.get(cacheKey);
          if (!responsePromise) {
            responsePromise = (async () => {
              const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(bodyRequest),
            });

            let data: GridResponse | null = null;
            let text = '';
            try {
              data = (await res.json()) as GridResponse;
            } catch {
              try {
                text = await res.text();
              } catch {
                /* noop */
              }
            }

            if (!res.ok || !data || !data.ok) {
              console.error('Datasource error', { status: res.status, statusText: res.statusText, data, text });
              throw new Error('Datasource response error');
            }
            return data;
          })();
          requestCacheRef.current.set(cacheKey, responsePromise);
          responsePromise.finally(() => {
            requestCacheRef.current.delete(cacheKey);
          });
        }

        const data = await responsePromise;
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
          onResponse({ ...data, request: serverRequest });
        }
        params.success({ rowData: normalizedRows, rowCount: resolvedRowCount });
      } catch (e) {
        console.error('Datasource fetch exception', e);
        params.fail();
      }
    },
  }), [
    endpoint,
    onResponse,
    onRequestPayloadConsumed,
    onServerRequest,
    onTotalsChange,
    quickSearchEnabled,
    resolvedColumnDefs,
  ]);

  const resolvedAllowRowClickSelection =
    typeof allowRowClickSelectionProp === 'boolean' ? allowRowClickSelectionProp : rowSelection !== 'multiple';
  const isServerSideRowModel = true;
  const rowSelectionConfig = useMemo<RowSelectionOptions | undefined>(() => {
    if (!rowSelection) return undefined;
    const isMultiRow = rowSelection === 'multiple';
    const clickSelectionEnabled =
      Boolean(resolvedAllowRowClickSelection) && !Boolean(suppressRowClickSelection);
    const allowMultiselectClick = isMultiRow && Boolean(rowMultiSelectWithClick) && clickSelectionEnabled;
    const allowDeselection = Boolean(rowDeselection) && clickSelectionEnabled;

    if (isMultiRow) {
      const config: RowSelectionOptions = {
        mode: 'multiRow',
        checkboxes: true,
        groupSelects: 'self',
        enableSelectionWithoutKeys: allowMultiselectClick,
        enableClickSelection: allowMultiselectClick || allowDeselection,
      };
      if (!isServerSideRowModel) {
        config.headerCheckbox = true;
        config.selectAll = 'filtered';
      }
      return config;
    }

    return {
      mode: 'singleRow',
      checkboxes: false,
      enableSelectionWithoutKeys: allowMultiselectClick,
      enableClickSelection: allowDeselection,
    };
  }, [
    rowSelection,
    rowDeselection,
    rowMultiSelectWithClick,
    resolvedAllowRowClickSelection,
    suppressRowClickSelection,
    isServerSideRowModel,
  ]);

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
    wrapGridApiRefreshers(e.api);
    gridApiRef.current.addEventListener('contextMenuVisibleChanged', handleContextMenuVisibleChanged);
    setIsGridReady(true);
    if (typeof externalGridReadyHandler === 'function') {
      externalGridReadyHandler(e.api);
    }
  }, [datasource, handleContextMenuVisibleChanged, externalGridReadyHandler, wrapGridApiRefreshers]);
  const contextMenuItemsHandler = useCallback<GetContextMenuItems<RowData>>((params) => {
    const wrapActions = (items: Array<MenuItemDef<RowData> | DefaultMenuItem | string>) =>
      items.map((item) => {
        if (typeof item === 'string') return item as DefaultMenuItem;
        if (!item || typeof item !== 'object' || !item.action) return item;
        const original = item.action;
        return {
          ...item,
          action: (actionParams: Parameters<NonNullable<MenuItemDef<RowData>['action']>>[0]) => {
            clearContextMenuRow();
            const runCleanup = () => scheduleDeselectAllRows(actionParams.api ?? null);
            const result = original(actionParams);
            const isPromise =
              typeof result === 'object' &&
              result !== null &&
              typeof (result as Promise<unknown>).then === 'function';
            if (isPromise) {
              return (result as Promise<unknown>).finally(runCleanup);
            }
            runCleanup();
            return result;
          },
        };
      }) as Array<DefaultMenuItem | MenuItemDef<RowData>>;
    const defaultItems = Array.isArray(params.defaultItems) ? params.defaultItems : [];
    if (typeof getContextMenuItems !== 'function') {
      return wrapActions(defaultItems);
    }
    const result = getContextMenuItems(params);
    if (!result || (Array.isArray(result) && result.length === 0)) {
      return wrapActions(defaultItems);
    }
    return Array.isArray(result) ? wrapActions(result) : result;
  }, [clearContextMenuRow, getContextMenuItems]);

  const handleColumnRowGroupChanged = () => {
    autoSizeColumns(undefined, true);
  };

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

  const getViewportElement = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return null;
    return shell.querySelector<HTMLElement>('.ag-center-cols-viewport, .ag-body-viewport') ?? null;
  }, []);

  const handleSortChanged = useCallback((event: SortChangedEvent<RowData>) => {
    // Keep rows visible for responsiveness while requesting the sorted data set from the server
    refreshServerSideData(event.api, { purge: false });
  }, []);

  const handleModelUpdated = useCallback((event: ModelUpdatedEvent<RowData>) => {
    autoSizeColumns(event.api, true);
    if (quickSearchRefreshRequestedRef.current) {
      quickSearchRefreshRequestedRef.current = false;
      stopQuickSearchFocusRetries();
      if (quickSearchAutoFocusEnabledRef.current) {
        runQuickSearchFocus();
      } else {
        quickSearchAutoFocusEnabledRef.current = true;
      }
    }
    if (typeof onModelUpdated === 'function') {
      onModelUpdated(event.api);
    }
    const restoreTop = pendingScrollRestoreTopRef.current;
    if (restoreTop != null) {
      pendingScrollRestoreTopRef.current = null;
      const viewport = getViewportElement();
      if (viewport) {
        const restore = () => {
          viewport.scrollTop = restoreTop;
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(restore);
        } else {
          setTimeout(restore, 0);
        }
      }
    }
  }, [autoSizeColumns, getViewportElement, onModelUpdated, runQuickSearchFocus, stopQuickSearchFocusRetries]);

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
    return parts.length === 0 ? undefined : parts;
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
    requestRefresh(() => refreshServerSideData(api));
  }, [refreshToken, requestRefresh]);

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
        refreshServerSideData(api, { purge: false });
        throw err;
      }
    };
    const chained = saveQueueRef.current.then(() => runSave());
    saveQueueRef.current = chained.catch(() => {});
    return chained;
  }, [endpoint]);

  type ReorderContext = {
    sourceId?: string | null;
    sourceIds?: string[];
    parentPath: number[];
    position: 'before' | 'after';
    beforeId: string | null;
    afterId: string | null;
  };

  const reorderRowOnServer = useCallback(async (context: ReorderContext) => {
    const payload = {
      action: 'reorder',
      sourceId: context.sourceId,
      sourceIds: context.sourceIds,
      parentPath: context.parentPath,
      position: context.position,
      beforeId: context.beforeId,
      afterId: context.afterId,
    };
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let data: { ok?: boolean; error?: string } | null = null;
    try {
      data = (await res.json()) as { ok?: boolean; error?: string };
    } catch {
      data = null;
    }
    if (!res.ok || !data?.ok) {
      throw new Error(data?.error ?? `Reorder request failed (status ${res.status})`);
    }
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
  const scrollDeltaRef = useRef(0);
  const scrollAnimationRef = useRef<number | null>(null);

  const runScrollAnimation = useCallback(() => {
    const viewport = getViewportElement();
    const delta = scrollDeltaRef.current;
    if (viewport && delta !== 0) {
      viewport.scrollTop = Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        Math.max(0, viewport.scrollTop + delta),
      );
    }
    scrollAnimationRef.current = null;
  }, [getViewportElement]);

  const scheduleScroll = useCallback(() => {
    if (scrollAnimationRef.current != null || typeof window === 'undefined') return;
    scrollAnimationRef.current = window.requestAnimationFrame(runScrollAnimation);
  }, [runScrollAnimation]);

  const autoScrollViewport = useCallback((clientY: number) => {
    const viewport = getViewportElement();
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const zone = 48;
    const step = 32;
    if (clientY < rect.top + zone) {
      scrollDeltaRef.current = -step;
      scheduleScroll();
    } else if (clientY > rect.bottom - zone) {
      scrollDeltaRef.current = step;
      scheduleScroll();
    } else {
      scrollDeltaRef.current = 0;
    }
  }, [getViewportElement, scheduleScroll]);

  const allowDragOver = useCallback((e: React.DragEvent) => {
    // Ensure no OS "not-allowed" cursor while dragging inside grid
    e.preventDefault();
  }, []);
  const handleDragOver = useCallback((ev: React.DragEvent) => {
    ev.preventDefault();
    autoScrollViewport(ev.clientY);
    updateHoverFromPoint(ev.clientX, ev.clientY, true);
  }, [autoScrollViewport, updateHoverFromPoint]);
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
    scrollDeltaRef.current = 0;
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

    const selectedRowIds = Array.isArray(payload.selectedRowIds)
      ? payload.selectedRowIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];

    const resolveRowIndex = (rowId: string): number => {
      const node = api.getRowNode(rowId);
      const idx = node?.rowIndex;
      return typeof idx === 'number' && Number.isFinite(idx) ? idx : Number.MAX_SAFE_INTEGER;
    };

    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    [...selectedRowIds, payload.rowId].forEach((rowId) => {
      if (!rowId) return;
      if (seen.has(rowId)) return;
      seen.add(rowId);
      uniqueIds.push(rowId);
    });

    const orderedSourceIds = uniqueIds.sort((a, b) => resolveRowIndex(a) - resolveRowIndex(b));
    if (orderedSourceIds.length === 0) return;

    const primarySourceId = orderedSourceIds[0];

    const targetContext = (() => {
      if (hoveredRowTarget) {
        return {
          parentPath: hoveredRowTarget.path.slice(),
          beforeRowId: null,
          beforeRowIndex: null,
          afterRowId: null,
          afterRowIndex: null,
          position: 'after' as const,
        };
      }
      if (gap) {
        return {
          parentPath: Array.isArray(gap.parentPath) ? gap.parentPath.slice() : [],
          beforeRowId: gap.beforeRowId,
          beforeRowIndex: gap.beforeRowIndex,
          afterRowId: gap.afterRowId,
          afterRowIndex: gap.afterRowIndex,
          position: gap.position,
        };
      }
      return null;
    })();
    if (!targetContext) return;

    const reorderContext: ReorderContext = {
      sourceId: primarySourceId,
      sourceIds: orderedSourceIds.length > 1 ? orderedSourceIds : undefined,
      parentPath: targetContext.parentPath,
      position: targetContext.position,
      beforeId: targetContext.beforeRowId,
      afterId: targetContext.afterRowId,
    };

    const executeReorder = async () => {
      try {
        await reorderRowOnServer(reorderContext);
        const viewport = getViewportElement();
        if (viewport) {
          pendingScrollRestoreTopRef.current = viewport.scrollTop;
        }
        scrollDeltaRef.current = 0;
        refreshServerSideData(api, { purge: false });
        scheduleDeselectAllRows(api);
      } catch (err) {
        console.error('Failed to reorder rows', err);
        showToastMessage('Unable to reorder rows. Refreshing data…', 'error');
        const viewport = getViewportElement();
        if (viewport) {
          pendingScrollRestoreTopRef.current = viewport.scrollTop;
        }
        scrollDeltaRef.current = 0;
        refreshServerSideData(api, { purge: false });
        scheduleDeselectAllRows(api);
      }
    };
    void executeReorder();
  }, [gapHover, rowHover, computeHoverState, reorderRowOnServer, getViewportElement]);

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
      requestRefresh(() => event.api.refreshCells({ columns: TREE_DEPENDENT_COLUMNS, force: true }));
      void persistTreeOrderingChanges();
    }
    if (typeof externalCellValueChangeHandler === 'function') {
      externalCellValueChangeHandler(event);
    }
  }, [manualMode, persistTreeOrderingChanges, externalCellValueChangeHandler, requestRefresh]);

  const handleSelectionChanged = useCallback((event: SelectionChangedEvent<RowData>) => {
    if (typeof externalSelectionChangedHandler !== 'function') return;
    const isSelectAll = hasServerSideSelectAll(event.api ?? null);
    let rows: RowData[] = [];
    if (!isSelectAll) {
      try {
        rows = typeof event.api.getSelectedRows === 'function' ? event.api.getSelectedRows() : [];
      } catch (err) {
        console.warn('Failed to read selected rows', err);
        rows = [];
      }
    }
    externalSelectionChangedHandler(rows ?? [], event.api);
    let selectedNodes: Array<RowNode<RowData>> = [];
    if (!isSelectAll) {
      try {
        selectedNodes = typeof event.api.getSelectedNodes === 'function'
          ? (event.api.getSelectedNodes() as Array<RowNode<RowData>>)
          : [];
      } catch (err) {
        console.warn('Failed to read selected nodes', err);
        selectedNodes = [];
      }
    }
    setGridRowDeletionContextMenuSelectionSnapshot(event.api ?? null, selectedNodes ?? []);
  }, [externalSelectionChangedHandler, hasServerSideSelectAll]);

  const handleRowDragEnd = useCallback((event: RowDragEndEvent<RowData>) => {
    if (typeof onRowsMoved === 'function') {
      onRowsMoved(event.api);
    }
  }, [onRowsMoved]);

  useEffect(() => {
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    return () => {
      if (!api || api.isDestroyed?.()) return;
      api.removeEventListener('contextMenuVisibleChanged', handleContextMenuVisibleChanged);
    };
  }, [handleContextMenuVisibleChanged]);

  useEffect(() => {
    wrapGridApiRefreshers(gridApiRef.current);
  }, [wrapGridApiRefreshers]);

  useEffect(() => {
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) return;
    requestRefresh(() => api.refreshCells({ force: true }));
  }, [contextMenuRowId, requestRefresh]);

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
          gridOptions={sharedGridOptions}
          ref={gridRef}
          columnDefs={resolvedColumnDefs}
          defaultColDef={dcd}
          getRowId={getRowId}
          getRowClass={mergedGetRowClass}
          getContextMenuItems={getContextMenuItems ? contextMenuItemsHandler : undefined}
          onFirstDataRendered={handleFirstDataRendered}
          onCellContextMenu={handleCellContextMenu}
          onCellMouseDown={handleCellMouseDown}
          rowHeight={32}
          headerHeight={38}
          rowSelection={rowSelectionConfig}

          // Server-Side model
          rowModelType="serverSide"
          serverSideEnableClientSideSort={serverSideEnableClientSideSort}

          // No selection needed for handle-only drag
          // rowSelection removed to avoid SSRM warning

          // Enterprise UX
          sideBar={sideBarDef}
          statusBar={{ statusPanels: [{ statusPanel: 'agAggregationComponent' }] }}
          suppressCellFocus={true}
          cellSelection={!resolvedPerformanceMode}

          // Charts OFF for now (to avoid the AgCharts module requirement)
          enableCharts={false}

          // Grouping/pivot flags are fine; without a license they’re ignored, not crashed
          pivotMode={false}
          rowGroupPanelShow={rowGroupPanelShow}
          getRowHeight={getRowHeight}
          suppressColumnVirtualisation={suppressColumnVirtualisation}
          suppressMovableColumns={suppressMovableColumns}

          // Cache settings
          cacheBlockSize={resolvedCacheBlockSize}
          rowBuffer={resolvedRowBuffer}
          {...(shouldApplyMaxBlocksInCache ? { maxBlocksInCache: resolvedMaxBlocksInCache } : {})}
          onGridReady={onGridReady}
          onFilterChanged={handleFilterChanged}
          onSortChanged={handleSortChanged}
          onModelUpdated={handleModelUpdated}
          onRowDoubleClicked={handleRowDoubleClick}
          onRowDragEnd={handleRowDragEnd}
          onCellValueChanged={handleCellValueChanged}
          onSelectionChanged={handleSelectionChanged}
          onCellEditingStarted={handleEditingStart}
          onCellEditingStopped={handleEditingStop}
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
