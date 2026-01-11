'use client';

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  ColumnApiModule,
  ContextMenuVisibleChangedEvent,
  CellStyleModule,
  DateFilterModule,
  DefaultMenuItem,
  FilterChangedEvent,
  FirstDataRenderedEvent,
  GetContextMenuItems,
  GetMainMenuItems,
  GetContextMenuItemsParams,
  GetRowIdParams,
  GridApi,
  GridOptions,
  GridReadyEvent,
  IRowNode,
  RowNode,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  MenuItemDef,
  ModelUpdatedEvent,
  NumberFilterModule,
  RowClassParams,
  RowStyleModule,
  RowDoubleClickedEvent,
  RowDragEnterEvent,
  RowDragEndEvent,
  RowDragModule,
  RowDragMoveEvent,
  RowHeightParams,
  RowSelectionModule,
  RowSelectionOptions,
  SelectionChangedEvent,
  ServerSideRowSelectionState,
  SelectEditorModule,
  SortChangedEvent,
  TextEditorModule,
  TextFilterModule,
  EventApiModule,
  ModuleRegistry,
} from 'ag-grid-community';
import {
  AggregationModule,
  CellSelectionModule,
  ClipboardModule,
  ColumnMenuModule,
  ColumnsToolPanelModule,
  ContextMenuModule,
  FiltersToolPanelModule,
  LicenseManager,
  MenuModule,
  RowGroupingModule,
  RowGroupingPanelModule,
  ServerSideRowModelApiModule,
  ServerSideRowModelModule,
  SetFilterModule,
  SideBarModule,
  StatusBarModule,
} from 'ag-grid-enterprise';
import { usePathname } from 'next/navigation';
import { showToastMessage } from '../../lib/toast';
import styles from './AgGridAll.module.css';
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from './actionMenuMarkers';
import { setGridRowDeletionContextMenuSelectionSnapshot } from '../../lib/gridRowDeletion';
import { useAuditUser } from './AuditUserProvider';
import { GridQuickSearchContext } from './GridQuickSearchProvider';
import { restoreCaretSelection } from '../hooks/useCaretKeeper';
import { isOfferProductCategory } from '../../lib/offerProductRows';
import { resolveColumnWidthAssignments, ColumnWidthAssignment } from '../../lib/columnWidthPresets';

const ACTION_MENU_SELECTOR = `[${ACTION_MENU_TRIGGER_ATTRIBUTE}], [${ACTION_MENU_PANEL_ATTRIBUTE}]`;
const PRESERVE_SELECTION_SELECTOR = '[data-fastquote-keep-selection="true"]';
const GRID_ROW_HEIGHT = 32;
const DEBUG_ROW_DRAG = false;


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
    editor?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
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
  var __AG_GRID_MODULES_REGISTERED__: boolean | undefined;
}
if (!globalThis.__AG_GRID_MODULES_REGISTERED__) {
  ModuleRegistry.registerModules([
    ServerSideRowModelModule,
    ServerSideRowModelApiModule,
    RowGroupingModule,
    RowGroupingPanelModule,
    ColumnsToolPanelModule,
    FiltersToolPanelModule,
    SideBarModule,
    StatusBarModule,
    AggregationModule,
    MenuModule,
    ColumnMenuModule,
    ContextMenuModule,
    ClipboardModule,
    SetFilterModule,
    CellSelectionModule,
    TextFilterModule,
    NumberFilterModule,
    DateFilterModule,
    TextEditorModule,
    SelectEditorModule,
    RowSelectionModule,
    RowDragModule,
    EventApiModule,
    ColumnApiModule,
    RowStyleModule,
    CellStyleModule,
  ]);
  globalThis.__AG_GRID_MODULES_REGISTERED__ = true;
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
  columnWidthDefaults?: Record<string, ColumnWidthAssignment>;
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
  allowCellSelectionInPerformanceMode?: boolean;
  useAgGridRowDrag?: boolean;
};

type RowData = Record<string, unknown>;

type RowDropIndicator = {
  rowId: string;
  position: 'before' | 'after' | 'inside';
};

type ColumnFilterModel = {
  filterType: 'text' | 'number' | 'date' | 'set' | string;
  type?: string;
  filter?: unknown;
  values?: unknown;
  dateFrom?: string;
};

const coerceToString = (value: unknown): string | null => {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return String(value);
};

const toFilterDateString = (value: unknown): string | null => {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().split('T')[0];
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
};

const normalizeDragTextValue = (value: unknown): string | null => {
  if (value == null) return null;
  const raw = typeof value === 'string' ? value : String(value);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const truncateDragText = (value: string, max = 80): string => {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
};

const getDragRowDescription = (data: RowData | null | undefined): string | null => {
  if (!data) return null;
  const description = normalizeDragTextValue((data as { Description?: unknown }).Description);
  if (description) return description;
  const requested = normalizeDragTextValue((data as { RequestedDescription?: unknown }).RequestedDescription);
  if (requested) return requested;
  const requested2 = normalizeDragTextValue((data as { RequestedDescription2?: unknown }).RequestedDescription2);
  if (requested2) return requested2;
  const requested3 = normalizeDragTextValue((data as { RequestedDescription3?: unknown }).RequestedDescription3);
  if (requested3) return requested3;
  return null;
};

const buildFilterModelForColumnValue = (colDef: ColDef | null | undefined, value: unknown): ColumnFilterModel | null => {
  if (!colDef || colDef.filter === false) return null;
  if (value == null) return null;
  const filterSetting = typeof colDef.filter === 'string' ? colDef.filter : 'agTextColumnFilter';
  switch (filterSetting) {
    case 'agSetColumnFilter': {
      const stringValue = coerceToString(value);
      if (stringValue == null) return null;
      return { filterType: 'set', values: [stringValue] };
    }
    case 'agNumberColumnFilter': {
      const trimmed = String(value).trim();
      if (trimmed.length === 0) return null;
      const numericValue = Number(trimmed);
      if (!Number.isFinite(numericValue)) return null;
      return { filterType: 'number', type: 'equals', filter: numericValue };
    }
    case 'agDateColumnFilter': {
      const dateValue = toFilterDateString(value);
      if (!dateValue) return null;
      return { filterType: 'date', type: 'equals', dateFrom: dateValue };
    }
    default: {
      const stringValue = coerceToString(value);
      if (stringValue == null) return null;
      return { filterType: 'text', type: 'equals', filter: stringValue };
    }
  }
};

const createFilterByMenuItem = (params: GetContextMenuItemsParams<RowData>): MenuItemDef<RowData> | null => {
  const column = params.column;
  const api = params.api;
  if (!column) return null;
  const colId = column.getColId();
  if (!colId || !api) return null;
  const model = buildFilterModelForColumnValue(column.getColDef(), params.value);
  if (!model) return null;
  return {
    name: 'Filter By',
    icon: `
      <span class="fastquote-menu-icon fastquote-menu-icon--filter" aria-hidden="true">
        <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 4h14l-5.5 5.5v5l-3-1.5v-3.5L3 4z" />
        </svg>
      </span>
    `,
    action: () => {
      const existingModel = api.getFilterModel() as Record<string, ColumnFilterModel> | null;
      const nextModel = { ...(existingModel ?? {}) };
      nextModel[colId] = model;
      api.setFilterModel(nextModel);
    },
  };
};

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

const canDropIntoRow = (row: RowData | null) => {
  return Boolean(isOfferProductCategory(row));
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
  hide?: boolean;
  order?: number;
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

type ColumnOrderMap = Map<string, number>;

const collectPersistableColumnState = (
  state: ColumnState[],
  columnOrderMap?: ColumnOrderMap,
): SavedColumnStateEntry[] =>
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
        hide: typeof entry.hide === 'boolean' ? entry.hide : undefined,
        order: (() => {
          const id = entry.colId ?? '';
          if (!id || !columnOrderMap) return undefined;
          const value = columnOrderMap.get(id);
          return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
        })(),
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
      if ('hide' in candidate) {
        const hideFlag = (candidate as { hide?: unknown }).hide;
        if (typeof hideFlag === 'boolean') {
          entry.hide = hideFlag;
        }
      }
      if ('order' in candidate) {
        const orderValue = (candidate as { order?: number }).order;
        entry.order =
          typeof orderValue === 'number' && Number.isFinite(orderValue) ? orderValue : undefined;
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

const logRowDragDebug = (label: string, details: Record<string, unknown>) => {
  if (!DEBUG_ROW_DRAG) return;
  try {
    console.log(`[AgGridAll] ${label}`, details);
  } catch {
    /* noop */
  }
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
const ROW_DRAG_EDGE_THRESHOLD = 10;

export default function AgGridAll({
  endpoint,
  columnDefs,
  columnWidthDefaults = {},
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
  performanceMode = true,
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
  allowCellSelectionInPerformanceMode = performanceMode === true,
  useAgGridRowDrag = false,
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
  const columnStateLoadedRef = useRef(false);
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
  useEffect(() => {
    columnStateLoadedRef.current = false;
  }, [columnStateStorageKey]);
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
  const resolvedColumnWidthDefaults = useMemo(
    () => resolveColumnWidthAssignments(columnWidthDefaults),
    [columnWidthDefaults],
  );
  type ColumnDefinitionWithChildren = ColDef & { children?: ColDef[] };
  const persistedColumnWidths = useMemo<Record<string, number>>(() => {
    if (!shouldPersistColumnState || !columnStateStorageKey || typeof window === 'undefined') {
      return {};
    }
    const persisted = readPersistedColumnState(columnStateStorageKey);
    if (!persisted || persisted.length === 0) return {};
    const widths: Record<string, number> = {};
    persisted.forEach((entry) => {
      if (!entry || typeof entry.colId !== 'string' || !entry.colId) return;
      if (typeof entry.width !== 'number') return;
      widths[entry.colId] = entry.width;
    });
    return widths;
  }, [columnStateStorageKey, shouldPersistColumnState]);

  const resolvedColumnDefs = useMemo(() => {
    const base = !suppressRowGroup
      ? columnDefs
      : columnDefs.map((definition) => ({
          ...definition,
          enableRowGroup: false,
        }));
    const applyDefaults = (definitions: ColumnDefinitionWithChildren[]): ColumnDefinitionWithChildren[] => definitions.map(
      (definition) => {
        const next: ColumnDefinitionWithChildren = { ...definition };
        const colId = typeof next.colId === 'string'
          ? next.colId
          : typeof next.field === 'string'
            ? next.field
            : '';
        if (colId && resolvedColumnWidthDefaults[colId] != null) {
          const currentWidth = typeof next.width === 'number' && Number.isFinite(next.width)
            ? next.width
            : null;
          if (currentWidth == null) {
            next.width = resolvedColumnWidthDefaults[colId];
          }
        }
        const children = definition.children;
        if (Array.isArray(children) && children.length > 0) {
          next.children = applyDefaults(children);
        }
        return next;
      },
    );
    const baseWithDefaults = applyDefaults(base);
    if (!shouldPersistColumnState || Object.keys(persistedColumnWidths).length === 0) {
      return baseWithDefaults;
    }
    const applyWidths = (definitions: ColumnDefinitionWithChildren[]): ColumnDefinitionWithChildren[] => definitions.map(
      (definition) => {
        const next: ColumnDefinitionWithChildren = { ...definition };
        const colId = typeof next.colId === 'string'
          ? next.colId
          : typeof next.field === 'string'
            ? next.field
            : '';
        if (colId && persistedColumnWidths[colId] != null) {
          next.width = persistedColumnWidths[colId];
        }
        const children = definition.children;
        if (Array.isArray(children) && children.length > 0) {
          next.children = applyWidths(children);
        }
        return next;
      },
    );
    return applyWidths(baseWithDefaults);
  }, [columnDefs, persistedColumnWidths, shouldPersistColumnState, resolvedColumnWidthDefaults, suppressRowGroup]);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExternalRefreshRef = useRef<number | null>(null);
  const [contextMenuRowId, setContextMenuRowId] = useState<string | null>(null);
  const dropIndicatorRef = useRef<RowDropIndicator | null>(null);
  const dropIndicatorFrameRef = useRef<number | null>(null);
  const lastDragNodeRef = useRef<IRowNode<RowData> | null>(null);
  const lastDragInspectRef = useRef(0);
  const lastDragInspectKeyRef = useRef('');
  const captureDragDomState = useCallback((label: string) => {
    if (!DEBUG_ROW_DRAG) return;
    if (label !== 'rowDragEnd') return;
    const shell = shellRef.current;
    if (!shell) return;
    const rows = Array.from(
      shell.querySelectorAll<HTMLElement>(
        '.ag-row--drop-before, .ag-row--drop-after, .ag-row--drop-inside, .ag-row-highlight-above, .ag-row-highlight-below, .ag-row-highlight-inside, .ag-row-dragging',
      ),
    );
    const rowState = rows.map((row) => ({
      rowId: row.getAttribute('row-id') ?? null,
      classes: Array.from(row.classList).filter((name) =>
        name.startsWith('ag-row--drop')
        || name.startsWith('ag-row-highlight-')
        || name === 'ag-row-dragging',
      ),
    }));
    const ghosts = Array.from(document.querySelectorAll<HTMLElement>('.ag-dnd-ghost')).map((ghost) => ({
      text: ghost.textContent?.trim() ?? '',
      className: ghost.className,
    }));
    logRowDragDebug(label, { rowState, ghosts, serialized: JSON.stringify({ rowState, ghosts }) });
  }, []);
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

  const clearDropIndicatorDom = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const rows = Array.from(
      shell.querySelectorAll<HTMLElement>(
        '.ag-row--drop-before, .ag-row--drop-after, .ag-row--drop-inside, .ag-row-highlight-above, .ag-row-highlight-below, .ag-row-highlight-inside, .ag-row-dragging',
      ),
    );
    rows.forEach((row) => {
      row.classList.remove('ag-row--drop-before', 'ag-row--drop-after', 'ag-row--drop-inside');
      row.classList.remove('ag-row-highlight-above', 'ag-row-highlight-below', 'ag-row-highlight-inside');
      row.classList.remove('ag-row-dragging');
    });
  }, []);

  const clearDragGhostDom = useCallback(() => {
    if (typeof document === 'undefined') return;
    const ghosts = Array.from(document.querySelectorAll<HTMLElement>('.ag-dnd-ghost'));
    ghosts.forEach((ghost) => ghost.remove());
  }, []);

  const updateDropIndicatorDom = useCallback(() => {
    clearDropIndicatorDom();
    const shell = shellRef.current;
    if (!shell) return;
    const indicator = dropIndicatorRef.current;
    if (!indicator) return;
    const className =
      indicator.position === 'before'
        ? 'ag-row--drop-before'
        : indicator.position === 'after'
          ? 'ag-row--drop-after'
          : 'ag-row--drop-inside';
    const targets = Array.from(shell.querySelectorAll<HTMLElement>(`.ag-row[row-id="${indicator.rowId}"]`));
    targets.forEach((row) => row.classList.add(className));
  }, [clearDropIndicatorDom]);

  const scheduleDropIndicatorUpdate = useCallback(() => {
    if (dropIndicatorFrameRef.current != null) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      dropIndicatorFrameRef.current = window.requestAnimationFrame(() => {
        dropIndicatorFrameRef.current = null;
        updateDropIndicatorDom();
      });
    } else {
      updateDropIndicatorDom();
    }
  }, [updateDropIndicatorDom]);

  const setDropIndicator = useCallback((indicator: RowDropIndicator | null) => {
    const current = dropIndicatorRef.current;
    if (!indicator && !current) return;
    if (indicator && current && indicator.rowId === current.rowId && indicator.position === current.position) {
      return;
    }
    dropIndicatorRef.current = indicator;
    scheduleDropIndicatorUpdate();
  }, [scheduleDropIndicatorUpdate]);

  const clearDropIndicator = useCallback(() => {
    dropIndicatorRef.current = null;
    if (dropIndicatorFrameRef.current != null) {
      if (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(dropIndicatorFrameRef.current);
      }
      dropIndicatorFrameRef.current = null;
    }
    clearDropIndicatorDom();
  }, [clearDropIndicatorDom]);

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

  const applySavedColumnState = useCallback((api: GridApi<RowData>) => {
    if (!shouldPersistColumnState || !columnStateStorageKey) return;
    if (columnStateLoadedRef.current) return;
    const persisted = readPersistedColumnState(columnStateStorageKey);
    if (!persisted || persisted.length === 0) {
      columnStateLoadedRef.current = true;
      return;
    }
    
    // Create a map of persisted state by colId for quick lookup
    const persistedMap = new Map<string, SavedColumnStateEntry>();
    persisted.forEach((entry) => {
      if (entry.colId) {
        persistedMap.set(entry.colId, entry);
      }
    });
    
    // Get current column state for properties
    const currentState = api.getColumnState();
    if (!currentState || currentState.length === 0) {
      columnStateLoadedRef.current = true;
      return;
    }
    
    // Build a map of persisted order
    const orderMap = new Map<string, number>();
    persisted.forEach((entry) => {
      if (entry.colId && typeof entry.order === 'number' && Number.isFinite(entry.order)) {
        orderMap.set(entry.colId, entry.order);
      }
    });
    
    // Apply other properties (width, hide, etc.) without reordering
    const stateToApply = currentState.map((entry) => {
      const persistedEntry = persistedMap.get(entry.colId ?? '');
      if (!persistedEntry) return entry;
      return {
        ...entry,
        width: persistedEntry.width ?? entry.width,
        flex: persistedEntry.flex ?? entry.flex,
        pinned: persistedEntry.pinned ?? entry.pinned,
        rowGroup: persistedEntry.rowGroup ?? entry.rowGroup,
        rowGroupIndex: persistedEntry.rowGroupIndex ?? entry.rowGroupIndex,
        hide: typeof persistedEntry.hide === 'boolean' ? persistedEntry.hide : entry.hide,
      };
    });
    
    try {
      // Apply properties first (without order)
      api.applyColumnState({ state: stateToApply, applyOrder: false, defaultState: { hide: null } });
      
      // Now apply column order using moveColumns API
      // Use requestAnimationFrame to ensure grid is ready
      if (typeof api.moveColumns === 'function' && orderMap.size > 0) {
        const applyOrder = () => {
          // Get current displayed columns after applying state
          let currentDisplayed = typeof api.getAllDisplayedColumns === 'function' 
            ? api.getAllDisplayedColumns() 
            : [];
          
          if (currentDisplayed.length === 0) return;
          
          // Create desired order array: columns with saved order first, then others
          const columnsWithOrder: Array<{ colId: string; order: number; column: Column }> = [];
          const columnsWithoutOrder: Array<{ colId: string; column: Column }> = [];
          
          currentDisplayed.forEach((column) => {
            const colId = typeof column.getColId === 'function' ? column.getColId() : '';
            if (!colId) return;
            
            const order = orderMap.get(colId);
            if (typeof order === 'number' && Number.isFinite(order)) {
              columnsWithOrder.push({ colId, order, column });
            } else {
              columnsWithoutOrder.push({ colId, column });
            }
          });
          
          // Sort columns with order by their saved order
          columnsWithOrder.sort((a, b) => a.order - b.order);
          
          // Build the desired order: ordered columns first, then unordered ones
          const desiredOrder = [
            ...columnsWithOrder.map(item => item.column),
            ...columnsWithoutOrder.map(item => item.column),
          ];
          
          // Move columns to their correct positions
          // Move from right to left (highest index to lowest) to avoid index shifting
          for (let targetIndex = desiredOrder.length - 1; targetIndex >= 0; targetIndex--) {
            const targetColumn = desiredOrder[targetIndex];
            if (!targetColumn) continue;
            
            const targetColId = typeof targetColumn.getColId === 'function' ? targetColumn.getColId() : '';
            if (!targetColId) continue;
            
            // Refresh to get current positions after previous moves
            currentDisplayed = typeof api.getAllDisplayedColumns === 'function' 
              ? api.getAllDisplayedColumns() 
              : [];
            
            // Find current position
            const currentIndex = currentDisplayed.findIndex((col) => {
              const id = typeof col.getColId === 'function' ? col.getColId() : '';
              return id === targetColId;
            });
            
            // Only move if not already in correct position
            if (currentIndex >= 0 && currentIndex !== targetIndex) {
              try {
                api.moveColumns([targetColId], targetIndex);
              } catch (err) {
                console.warn(`Failed to move column ${targetColId} to position ${targetIndex}`, err);
              }
            }
          }
        };
        
        // Use requestAnimationFrame to ensure grid is ready
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(applyOrder);
        } else {
          applyOrder();
        }
      }
      
      columnStateLoadedRef.current = true;
    } catch (err) {
      console.warn('Failed to apply saved column state', err);
      columnStateLoadedRef.current = true;
    }
  }, [columnStateStorageKey, shouldPersistColumnState]);

  const persistColumnState = useCallback(() => {
    if (!shouldPersistColumnState || !columnStateStorageKey) return;
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) return;
    const displayedColumns =
      typeof api.getAllDisplayedColumns === 'function' ? api.getAllDisplayedColumns() : [];
    const columnOrderMap: ColumnOrderMap = new Map();
    displayedColumns.forEach((column, index) => {
      const colId =
        typeof column.getColId === 'function'
          ? column.getColId()
          : typeof (column as { getId?: () => string }).getId === 'function'
            ? (column as { getId?: () => string }).getId?.()
            : null;
      if (typeof colId === 'string' && colId.length > 0) {
        columnOrderMap.set(colId, index);
      }
    });
    const nextState = collectPersistableColumnState(api.getColumnState(), columnOrderMap);
    writePersistedColumnState(columnStateStorageKey, nextState);
  }, [columnStateStorageKey, shouldPersistColumnState]);

  const queuePersistColumnState = useCallback(() => {
    if (!shouldPersistColumnState || typeof window === 'undefined') return;
    if (!columnStateLoadedRef.current) return;
    if (columnSaveTimerRef.current) {
      window.clearTimeout(columnSaveTimerRef.current);
    }
    columnSaveTimerRef.current = window.setTimeout(() => {
      columnSaveTimerRef.current = null;
      persistColumnState();
    }, 200);
  }, [persistColumnState, shouldPersistColumnState]);

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
    if (shouldPersistColumnState && columnStateLoadedRef.current) {
      queuePersistColumnState();
    }
  }, [autoSizeColumns, queuePersistColumnState, shouldPersistColumnState]);

  const handleFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    autoSizeColumns(event.api, true);
    autoSizeCompletedRef.current = true;
    // Ensure column order is applied after data is rendered
    if (shouldPersistColumnState && !columnStateLoadedRef.current) {
      applySavedColumnState(event.api);
    }
  }, [autoSizeColumns, shouldPersistColumnState, applySavedColumnState]);

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
      // Hide header menu icon (right-click still shows menu)
      suppressHeaderMenuButton: true,
      width: 100,
      ...defaultColDef,
      filterParams: mergedFilterParams,
    };
  }, [defaultColDef, floatingFilter]);

const requestPayloadRef = useRef(requestPayload);
requestPayloadRef.current = requestPayload;
const requestCacheRef = useRef(new Map<string, Promise<GridResponse>>());
  const getRowPath = useCallback((node: IRowNode<RowData> | null | undefined): number[] => {
    if (!node) return [];
    const data = node.data as { TreeOrdering?: string | null } | undefined;
    return parseTreeOrderingPath(data?.TreeOrdering ?? null);
  }, []);

  const getParentPath = useCallback((path: number[]) => {
    return path.length > 0 ? path.slice(0, -1) : [];
  }, []);

  const deriveParentPathFromNeighbors = useCallback((
    beforeNode: IRowNode<RowData> | null,
    afterNode: IRowNode<RowData> | null,
    position: 'before' | 'after',
  ): number[] => {
    const beforePath = beforeNode ? getRowPath(beforeNode) : null;
    const afterPath = afterNode ? getRowPath(afterNode) : null;

    if (!afterPath && position === 'after') {
      return [];
    }

    if (beforePath && afterPath) {
      const prefix = longestCommonPrefix(beforePath, afterPath);
      const beforeIsPrefix = prefix.length === beforePath.length && afterPath.length > prefix.length;
      const afterIsPrefix = prefix.length === afterPath.length && beforePath.length > prefix.length;
      if (position === 'after' && beforeIsPrefix) {
        return beforePath.slice();
      }
      if (position === 'before' && afterIsPrefix) {
        return getParentPath(afterPath);
      }
      return prefix;
    }

    if (beforePath) {
      return getParentPath(beforePath);
    }

    if (afterPath) {
      return getParentPath(afterPath);
    }

    return [];
  }, [getParentPath, getRowPath]);

  const sharedGridOptions = useMemo(() => {
    const options: GridOptions<RowData> = {
      cellSelection: {
        handle: {
          mode: 'range',
        },
      },
    };
      if (useAgGridRowDrag) {
        options.rowDragMultiRow = true;
        options.suppressMoveWhenRowDragging = true;
        options.rowDragText = (params: { rowNodes?: Array<IRowNode<RowData>>; rowNode?: IRowNode<RowData> }) => {
          const nodes = Array.isArray(params.rowNodes) ? params.rowNodes : [];
          const rowNode = params.rowNode ?? lastDragNodeRef.current ?? null;
          const hasRowNode = rowNode
            ? nodes.some((node) => node?.id != null && node.id === rowNode.id)
            : false;
          const effectiveNodes = nodes.length > 0 && hasRowNode
            ? nodes
            : rowNode
              ? [rowNode]
              : nodes;
          const count = effectiveNodes.length > 0 ? effectiveNodes.length : 1;
          const primaryNode = effectiveNodes[0] ?? rowNode ?? null;
          const description = getDragRowDescription(primaryNode?.data as RowData | null);
          if (count === 1) {
            return description ? truncateDragText(description) : 'Move 1 row';
          }
        if (description) {
          return `Move ${count} items: ${truncateDragText(description)}`;
        }
        return `Move ${count} items`;
      };
    }
    return options;
  }, [useAgGridRowDrag]);

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
    
    // Apply saved column state (including order) as early as possible
    if (shouldPersistColumnState) {
      // Use setTimeout to ensure columns are initialized
      setTimeout(() => {
        if (!e.api.isDestroyed?.()) {
          applySavedColumnState(e.api);
        }
      }, 0);
    }
    
    if (typeof externalGridReadyHandler === 'function') {
      externalGridReadyHandler(e.api);
    }
  }, [datasource, handleContextMenuVisibleChanged, externalGridReadyHandler, wrapGridApiRefreshers, shouldPersistColumnState, applySavedColumnState]);
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
    const resolveMenuItems = () => {
      if (typeof getContextMenuItems !== 'function') {
        return defaultItems;
      }
      const result = getContextMenuItems(params);
      if (Array.isArray(result)) {
        return result;
      }
      if (result) {
        return [result];
      }
      return defaultItems;
    };

    const menuItems = resolveMenuItems();
    const filterByItem = createFilterByMenuItem(params);

    if (!filterByItem) {
      return wrapActions(menuItems);
    }

    const isExportMenuItem = (
      item: MenuItemDef<RowData> | DefaultMenuItem | string,
    ): item is DefaultMenuItem | MenuItemDef<RowData> => {
      if (item === 'export') return true;
      if (typeof item === 'object' && item && typeof item.name === 'string') {
        return item.name.toLowerCase() === 'export';
      }
      return false;
    };

    const itemsWithFilter = [...menuItems];
    const exportIndex = itemsWithFilter.findIndex((item) => isExportMenuItem(item));
    if (exportIndex >= 0) {
      itemsWithFilter.splice(exportIndex, 0, filterByItem);
    } else {
      itemsWithFilter.unshift(filterByItem);
    }

    return wrapActions(itemsWithFilter);
  }, [clearContextMenuRow, getContextMenuItems]);

  const headerMenuItemsHandler = useCallback<GetMainMenuItems<RowData>>((params) => {
    const column = params.column;
    if (!column) {
      return params.defaultItems;
    }
    const colId = column.getColId();
    if (!colId) {
      return params.defaultItems;
    }
    const api = params.api;
    const visibleColumns = api?.getAllDisplayedColumns() ?? [];
    const currentIndex = visibleColumns.findIndex((col: Column) => col.getColId() === colId);
    const columnDef = column.getColDef();
    const allowMove =
      !!api
      && typeof api.moveColumns === 'function'
      && !columnDef?.suppressMovable
      && !columnDef?.lockPosition
      && currentIndex >= 0
      && visibleColumns.length > 1;

    const moveColumnToIndex = (index: number) => {
      if (!api || !allowMove) return;
      const clamped = Math.max(0, Math.min(visibleColumns.length - 1, index));
      if (clamped === currentIndex) return;
      api.moveColumns([colId], clamped);
    };

    const moveLeftItem: MenuItemDef<RowData> = {
      name: 'Move Column Left',
      disabled: !allowMove || currentIndex <= 0,
      action: () => moveColumnToIndex(currentIndex - 1),
    };
    const moveRightItem: MenuItemDef<RowData> = {
      name: 'Move Column Right',
      disabled: !allowMove || currentIndex < 0 || currentIndex >= visibleColumns.length - 1,
      action: () => moveColumnToIndex(currentIndex + 1),
    };

    const hideColumnItem: MenuItemDef<RowData> = {
      name: 'Hide Column',
      icon: `
        <span class="fastquote-menu-icon fastquote-menu-icon--hide" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M2 8c1.333-2 4-4 7-4s5.667 2 7 4c-1.333 2-4 4-7 4s-5.667-2-7-4z" />
            <path d="M4 12l12-8" />
          </svg>
        </span>
      `,
      action: () => params.api.setColumnsVisible([colId], false),
    };

    const defaults = params.defaultItems ?? [];
    const items: Array<MenuItemDef<RowData> | DefaultMenuItem> = [...defaults];
    const targetIndex = items.findIndex(
      (item) => item === 'columnChooser' || item === 'resetColumns',
    );
    const insertionIndex = targetIndex >= 0 ? targetIndex : items.length;
    const extraItems = allowMove ? [moveLeftItem, moveRightItem, hideColumnItem] : [hideColumnItem];
    items.splice(insertionIndex, 0, ...extraItems);
    return items;
  }, []);

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
    if (shouldPersistColumnState) {
      applySavedColumnState(event.api);
    }
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
  }, [
    applySavedColumnState,
    autoSizeColumns,
    getViewportElement,
    onModelUpdated,
    runQuickSearchFocus,
    shouldPersistColumnState,
    stopQuickSearchFocusRetries,
  ]);

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
    const columnState = typeof api.getColumnState === 'function' ? api.getColumnState() : [];
    const hasTreeOrderingColumn = Array.isArray(columnState)
      ? columnState.some((entry) => entry.colId === 'TreeOrdering')
      : false;
    if (!hasTreeOrderingColumn) return;
    api.applyColumnState({
      state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
      defaultState: { sort: null },
      applyOrder: false,
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

  const deriveDropTargetContext = useCallback((event: RowDragEndEvent<RowData>): ReorderContext | null => {
    const api = event.api;
    const overNode = event.rowsDrop?.target ?? event.rowsDrop?.overNode ?? event.overNode ?? null;
    if (!overNode) return null;

    const rowTop = typeof overNode.rowTop === 'number' ? overNode.rowTop : 0;
    const rowHeight = typeof overNode.rowHeight === 'number' ? overNode.rowHeight : GRID_ROW_HEIGHT;
    const offset = event.y - rowTop;
    const edgeBand = Math.min(ROW_DRAG_EDGE_THRESHOLD, Math.max(6, Math.round(rowHeight * 0.2)));
    let position: 'before' | 'after' | 'inside' = 'after';

    if (offset <= edgeBand) {
      position = 'before';
    } else if (offset >= rowHeight - edgeBand) {
      position = 'after';
    } else if (canDropIntoRow((overNode.data as RowData | undefined) ?? null)) {
      position = 'inside';
    } else {
      position = offset < rowHeight / 2 ? 'before' : 'after';
    }

    if (position === 'inside') {
      return {
        parentPath: getRowPath(overNode),
        position: 'after',
        beforeId: null,
        afterId: null,
      };
    }

    const effectiveIndex = typeof overNode.rowIndex === 'number'
      ? overNode.rowIndex
      : event.overIndex;
    const beforeNode = position === 'before'
      ? (effectiveIndex > 0 ? api.getDisplayedRowAtIndex(effectiveIndex - 1) ?? null : null)
      : overNode;
    const afterNode = position === 'before'
      ? overNode
      : (effectiveIndex >= 0 ? api.getDisplayedRowAtIndex(effectiveIndex + 1) ?? null : null);

    return {
      parentPath: deriveParentPathFromNeighbors(beforeNode, afterNode, position),
      position,
      beforeId: beforeNode?.id ?? null,
      afterId: afterNode?.id ?? null,
    };
  }, [deriveParentPathFromNeighbors, getRowPath]);

  const resolveDropIndicator = useCallback((event: RowDragMoveEvent<RowData>): RowDropIndicator | null => {
    const overNode = event.overNode ?? null;
    const rowId = overNode?.id ?? null;
    if (!overNode || !rowId) return null;
    const rowTop = typeof overNode.rowTop === 'number' ? overNode.rowTop : 0;
    const rowHeight = typeof overNode.rowHeight === 'number' ? overNode.rowHeight : GRID_ROW_HEIGHT;
    const pointerY = typeof event.y === 'number' ? event.y : rowTop;
    const offset = pointerY - rowTop;
    const edgeBand = Math.min(ROW_DRAG_EDGE_THRESHOLD, Math.max(6, Math.round(rowHeight * 0.2)));
    let position: 'before' | 'after' | 'inside' = 'after';

    if (offset <= edgeBand) {
      position = 'before';
    } else if (offset >= rowHeight - edgeBand) {
      position = 'after';
    } else if (canDropIntoRow((overNode.data as RowData | undefined) ?? null)) {
      position = 'inside';
    } else {
      position = offset < rowHeight / 2 ? 'before' : 'after';
    }

    return { rowId, position };
  }, []);

  const handleRowDragMove = useCallback((event: RowDragMoveEvent<RowData>) => {
    if (!useAgGridRowDrag) return;
    lastDragNodeRef.current = event.node ?? lastDragNodeRef.current;
    setDropIndicator(resolveDropIndicator(event));
    captureDragDomState('rowDragMove');
    if (DEBUG_ROW_DRAG) {
      const now = Date.now();
      if (now - lastDragInspectRef.current > 200) {
        lastDragInspectRef.current = now;
        const dragEvent = event.event;
        if (dragEvent) {
          const el = document.elementFromPoint(dragEvent.clientX, dragEvent.clientY);
          const rowEl = el?.closest?.('.ag-row') as HTMLElement | null;
          const key = `${el?.tagName ?? 'null'}:${el?.className ?? ''}:${rowEl?.getAttribute?.('row-id') ?? ''}`;
          if (key !== lastDragInspectKeyRef.current) {
            lastDragInspectKeyRef.current = key;
            logRowDragDebug('rowDragInspect', {
              point: { x: dragEvent.clientX, y: dragEvent.clientY },
              element: el ? { tag: el.tagName, className: el.className } : null,
              row: rowEl ? { rowId: rowEl.getAttribute('row-id'), className: rowEl.className } : null,
            });
          }
        }
      }
    }
  }, [captureDragDomState, resolveDropIndicator, setDropIndicator, useAgGridRowDrag]);

  const handleRowDragEnter = useCallback((event: RowDragEnterEvent<RowData>) => {
    if (!useAgGridRowDrag) return;
    clearDropIndicator();
    lastDragNodeRef.current = event.node ?? lastDragNodeRef.current;
  }, [clearDropIndicator, useAgGridRowDrag]);

  const handleRowDragLeave = useCallback(() => {
    clearDropIndicator();
    captureDragDomState('rowDragLeave');
  }, [captureDragDomState, clearDropIndicator]);

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
    lastDragNodeRef.current = null;
    clearDropIndicator();
    clearDragGhostDom();
    captureDragDomState('rowDragEnd');
    if (!useAgGridRowDrag) {
      if (typeof onRowsMoved === 'function') {
        onRowsMoved(event.api);
      }
      return;
    }

    const api = event.api;
    const rawNodes = Array.isArray(event.nodes) && event.nodes.length > 0
      ? event.nodes
      : (event.node ? [event.node] : []);
    const orderedNodes = rawNodes
      .filter((node): node is IRowNode<RowData> => Boolean(node))
      .slice()
      .sort((a, b) => {
        const aIndex = typeof a.rowIndex === 'number' ? a.rowIndex : Number.MAX_SAFE_INTEGER;
        const bIndex = typeof b.rowIndex === 'number' ? b.rowIndex : Number.MAX_SAFE_INTEGER;
        return aIndex - bIndex;
      });
    const sourceIds = orderedNodes
      .map((node) => node.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (sourceIds.length === 0) {
      if (typeof onRowsMoved === 'function') {
        onRowsMoved(api);
      }
      return;
    }

    const targetContext = deriveDropTargetContext(event);
    if (!targetContext) {
      if (typeof onRowsMoved === 'function') {
        onRowsMoved(api);
      }
      return;
    }

    const reorderContext: ReorderContext = {
      ...targetContext,
      sourceId: sourceIds[0],
      sourceIds: sourceIds.length > 1 ? sourceIds : undefined,
    };

    const executeReorder = async () => {
      try {
        await reorderRowOnServer(reorderContext);
        const viewport = getViewportElement();
        if (viewport) {
          pendingScrollRestoreTopRef.current = viewport.scrollTop;
        }
        refreshServerSideData(api, { purge: false });
        scheduleDeselectAllRows(api);
      } catch (err) {
        console.error('Failed to reorder rows', err);
        showToastMessage('Unable to reorder rows. Refreshing data™??', 'error');
        const viewport = getViewportElement();
        if (viewport) {
          pendingScrollRestoreTopRef.current = viewport.scrollTop;
        }
        refreshServerSideData(api, { purge: false });
        scheduleDeselectAllRows(api);
      }
    };
    void executeReorder();

    if (typeof onRowsMoved === 'function') {
      onRowsMoved(api);
    }
  }, [
    clearDropIndicator,
    captureDragDomState,
    clearDragGhostDom,
    deriveDropTargetContext,
    getViewportElement,
    onRowsMoved,
    reorderRowOnServer,
    useAgGridRowDrag,
  ]);

  useEffect(() => {
    if (!useAgGridRowDrag) return;
    if (typeof window === 'undefined') return;
    const handleDragEnd = () => {
      clearDropIndicator();
    };
    window.addEventListener('mouseup', handleDragEnd);
    window.addEventListener('dragend', handleDragEnd);
    window.addEventListener('touchend', handleDragEnd);
    return () => {
      window.removeEventListener('mouseup', handleDragEnd);
      window.removeEventListener('dragend', handleDragEnd);
      window.removeEventListener('touchend', handleDragEnd);
    };
  }, [clearDropIndicator, useAgGridRowDrag]);

  useEffect(() => {
    if (!DEBUG_ROW_DRAG) return;
    if (typeof window === 'undefined') return;
    const win = window as Window & { __dumpRowGapState?: () => unknown };
    win.__dumpRowGapState = () => {
      const shell = shellRef.current;
      if (!shell) return null;
      const rows = Array.from(shell.querySelectorAll<HTMLElement>('.ag-row'));
      const hiddenRows = rows
        .map((row) => {
          const style = window.getComputedStyle(row);
          const opacity = Number.parseFloat(style.opacity || '1');
          const visibility = style.visibility || 'visible';
          const display = style.display || 'block';
          if (opacity >= 0.1 && visibility !== 'hidden' && display !== 'none') {
            return null;
          }
          return {
            rowId: row.getAttribute('row-id'),
            className: row.className,
            opacity,
            visibility,
            display,
            height: Math.round(row.getBoundingClientRect().height),
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      const emptyRows = rows
        .map((row) => {
          const text = row.textContent?.replace(/\s+/g, ' ').trim() ?? '';
          if (text.length > 0) return null;
          return {
            rowId: row.getAttribute('row-id'),
            className: row.className,
            height: Math.round(row.getBoundingClientRect().height),
          };
        })
        .filter((row): row is NonNullable<typeof row> => Boolean(row));
      const rowInfo = rows
        .map((row) => {
          const rect = row.getBoundingClientRect();
          return {
            rowId: row.getAttribute('row-id'),
            top: Math.round(rect.top),
            height: Math.round(rect.height),
            className: row.className,
            inlineTop: row.style.top,
            inlineTransform: row.style.transform,
          };
        })
        .sort((a, b) => a.top - b.top);
      const gaps: Array<{
        delta: number;
        before: (typeof rowInfo)[number];
        after: (typeof rowInfo)[number];
      }> = [];
      for (let idx = 1; idx < rowInfo.length; idx += 1) {
        const prev = rowInfo[idx - 1];
        const next = rowInfo[idx];
        const delta = next.top - prev.top;
        if (delta > GRID_ROW_HEIGHT + 2) {
          gaps.push({ delta, before: prev, after: next });
        }
      }
      const payload = { rowCount: rowInfo.length, gaps, hiddenRows, emptyRows };
      logRowDragDebug('rowGapDump', payload as Record<string, unknown>);
      return payload;
    };
    return () => {
      delete win.__dumpRowGapState;
    };
  }, []);

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

  return (
    <div className={styles.container}>
      <div
        className={`ag-theme-quartz ${styles.gridShell}`}
        data-ag-grid-size="compact"
        ref={shellRef}
      >
        <AgGridReact
          gridOptions={sharedGridOptions}
          ref={gridRef}
          columnDefs={resolvedColumnDefs}
          defaultColDef={dcd}
          getRowId={getRowId}
          getRowClass={mergedGetRowClass}
          getMainMenuItems={headerMenuItemsHandler}
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
          cellSelection={!resolvedPerformanceMode || allowCellSelectionInPerformanceMode}

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
          onRowDragEnter={handleRowDragEnter}
          onRowDragEnd={handleRowDragEnd}
          onRowDragMove={handleRowDragMove}
          onRowDragLeave={handleRowDragLeave}
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
      </div>
    </div>
  );
}
