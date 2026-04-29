'use client';

import React, {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { AgGridReact } from 'ag-grid-react';
import {
  CellContextMenuEvent,
  CellEditingStartedEvent,
  CellEditingStoppedEvent,
  CellClassParams,
  CellMouseDownEvent,
  CellRange,
  CellRangeParams,
  CellValueChangedEvent,
  ColumnVisibleEvent,
  Column,
  ColumnPinnedType,
  ColumnState,
  ColDef,
  ColumnApiModule,
  ColumnAutoSizeModule,
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
  RowApiModule,
  IServerSideDatasource,
  IServerSideGetRowsParams,
  MenuItemDef,
  ModelUpdatedEvent,
  NumberFilterModule,
  PinnedRowModule,
  RowClassParams,
  RowStyle,
  RowStyleModule,
  RowDoubleClickedEvent,
  RowDragEndEvent,
  RowDragEnterEvent,
  RowDragMoveEvent,
  RowDragModule,
  RowHeightParams,
  CellSelectionOptions,
  RowSelectionModule,
  RowSelectionOptions,
  SelectionChangedEvent,
  ServerSideRowSelectionState,
  SelectEditorModule,
  CustomEditorModule,
  CustomFilterModule,
  SortChangedEvent,
  TextEditorModule,
  TextFilterModule,
  EventApiModule,
  LocaleModule,
  ModuleRegistry,
  ColumnPivotModeChangedEvent,
  CsvExportModule,
  ValidationModule,
  ExternalFilterModule,
  ScrollApiModule,
  RowAutoHeightModule,
  RenderApiModule,
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
  ExcelExportModule,
  RichSelectModule,
} from 'ag-grid-enterprise';
import { usePathname } from 'next/navigation';
import { showToastMessage } from '../../lib/toast';
import {
  detectExportMode,
  exportAllFilteredRowsAsCsv,
  exportSelectedRowsAsCsv,
  exportSelectedCellsAsCsv,
  exportAllFilteredRowsAsExcel,
  exportSelectedRowsAsExcel,
  exportSelectedCellsAsExcel,
} from '../../lib/gridExport';
import styles from './AgGridAll.module.css';
import { PageHeaderContext } from './PageHeader';
import { ACTION_MENU_PANEL_ATTRIBUTE, ACTION_MENU_TRIGGER_ATTRIBUTE } from './actionMenuMarkers';
import { getServerSideDeselectedRowIds, setGridRowDeletionContextMenuSelectionSnapshot, setGridQuickFilterText } from '../../lib/gridRowDeletion';
import { useAuditUser } from './AuditUserProvider';
import { GridQuickSearchContext } from './GridQuickSearchProvider';
import { restoreCaretSelection } from '../hooks/useCaretKeeper';
import { isOfferProductCategory } from '../../lib/offerProductRows';
import { resolveColumnWidthAssignments, ColumnWidthAssignment } from '../../lib/columnWidthPresets';
import { useGridUrlState } from '../hooks/useGridUrlState';
import { parseGridSearchParams } from '../../lib/gridUrlState';

// CONSTANTS
const ACTION_MENU_SELECTOR = `[${ACTION_MENU_TRIGGER_ATTRIBUTE}], [${ACTION_MENU_PANEL_ATTRIBUTE}]`;
const PRESERVE_SELECTION_SELECTOR = '[data-fastquote-keep-selection="true"]';
const GRID_ROW_HEIGHT = 32;
const IGNORED_FILTER_COLS = new Set(['Enabled', 'IsParent']);
const FILTER_INPUT_SELECTOR = [
  '.ag-floating-filter input:not([type="checkbox"]):not([type="radio"])',
  '.ag-floating-filter textarea',
  '.ag-floating-filter select',
  '.ag-filter input:not([type="checkbox"]):not([type="radio"])',
  '.ag-filter textarea',
  '.ag-filter select',
].join(', ');

// UTILITY FUNCTIONS - Column & Cell Operations
const resolveColumnId = (column: string | Column): string => (
  typeof column === 'string' ? column : column.getColId()
);

const mapCellRangeToParams = (range: CellRange): CellRangeParams | null => {
  if (!range?.columns?.length) return null;
  const startRow = range.startRow;
  const endRow = range.endRow;
  if (startRow == null && endRow == null) return null;
  return {
    rowStartIndex: typeof startRow?.rowIndex === 'number' ? startRow.rowIndex : null,
    rowStartPinned: startRow?.rowPinned ?? null,
    rowEndIndex: typeof endRow?.rowIndex === 'number' ? endRow.rowIndex : null,
    rowEndPinned: endRow?.rowPinned ?? null,
    columns: range.columns.map(resolveColumnId),
  };
};

const restoreCellRanges = (api: GridApi<RowData>, ranges: CellRangeParams[]) => {
  if (!ranges?.length) return;
  api.clearRangeSelection();
  ranges.forEach((params) => {
    if (params.columns?.length) {
      api.addCellRange(params);
    }
  });
  const firstRange = ranges[0];
  const focusedRow = firstRange.rowStartIndex ?? firstRange.rowEndIndex;
  const focusedColumn = firstRange.columns?.[0];
  const focusedColumnId = focusedColumn
    ? typeof focusedColumn === 'string'
      ? focusedColumn
      : focusedColumn.getColId()
    : '';
  if (
    typeof focusedRow === 'number'
    && focusedColumnId.length > 0
  ) {
    api.setFocusedCell(
      focusedRow,
      focusedColumnId,
      firstRange.rowStartPinned ?? firstRange.rowEndPinned ?? undefined,
    );
  }
};

const isEditableColumnValue = (column: Column, node: IRowNode<RowData>) =>
  column.isCellEditable(node) && !column.isSuppressPaste(node);

const isNumericColumnDef = (colDef?: ColDef | null): boolean => {
  if (!colDef) return false;
  const type = colDef.type;
  if (type === 'numericColumn') return true;
  if (Array.isArray(type) && type.includes('numericColumn')) return true;
  return colDef.filter === 'agNumberColumnFilter';
};

const shouldZeroOnDelete = (colDef?: ColDef | null): boolean => {
  const field = colDef?.field ?? '';
  if (!field) return false;
  return /(price|cost)/i.test(field) || isNumericColumnDef(colDef);
};

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

const suppressFilterFieldBrowserSuggestions = (field: HTMLElement) => {
  if (
    !(field instanceof HTMLInputElement)
    && !(field instanceof HTMLTextAreaElement)
    && !(field instanceof HTMLSelectElement)
  ) {
    return;
  }

  if (field instanceof HTMLInputElement) {
    const type = (field.type || 'text').toLowerCase();
    if (['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)) return;

    // `new-password` is more reliable than `off` in Chromium for suppressing saved-value suggestions.
    if (field.getAttribute('autocomplete') !== 'new-password') {
      field.setAttribute('autocomplete', 'new-password');
    }
  } else if (field.getAttribute('autocomplete') !== 'off') {
    field.setAttribute('autocomplete', 'off');
  }

  if (field.getAttribute('autocorrect') !== 'off') {
    field.setAttribute('autocorrect', 'off');
  }
  if (field.getAttribute('autocapitalize') !== 'off') {
    field.setAttribute('autocapitalize', 'off');
  }
  if (field.getAttribute('spellcheck') !== 'false') {
    field.setAttribute('spellcheck', 'false');
  }
};

const suppressBrowserSuggestionsInFilterInputs = (root: ParentNode | null) => {
  if (!root || typeof root.querySelectorAll !== 'function') return;

  if (root instanceof HTMLElement && root.matches(FILTER_INPUT_SELECTOR)) {
    suppressFilterFieldBrowserSuggestions(root);
  }

  root.querySelectorAll<HTMLElement>(FILTER_INPUT_SELECTOR).forEach((field) => {
    suppressFilterFieldBrowserSuggestions(field);
  });
};

export type AgGridAllProps = Props;

const isActionMenuEventTarget = (target: EventTarget | null): boolean => {
  const element = resolveElementFromEventTarget(target);
  return Boolean(element?.closest(ACTION_MENU_SELECTOR));
};

const isSelectionPreservingTarget = (target: Element | null) => {
  if (!target) return false;
  // Check if the element itself or any ancestor has the preserve selection attribute
  const preservingElement = target.closest(PRESERVE_SELECTION_SELECTOR);
  if (preservingElement) return true;
  // Also check if the element is inside any AG Grid within a preserving area
  const agRoot = target.closest('.ag-root-wrapper');
  if (agRoot) {
    const preservingContainer = agRoot.closest(PRESERVE_SELECTION_SELECTOR);
    if (preservingContainer) return true;
  }
  return false;
};

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

/** Build a stable fingerprint from columnDefs so we can detect when columns are added/removed. */
export const buildColumnFingerprint = (defs: ColDef[] | null | undefined): string => {
  if (!defs) return '';
  const ids: string[] = [];
  const walk = (items: ColDef[]) => {
    items.forEach((def) => {
      if (!def) return;
      const id = (typeof def.colId === 'string' && def.colId) || (typeof def.field === 'string' && def.field) || '';
      if (id) ids.push(id);
      const children = (def as { children?: ColDef[] }).children;
      if (Array.isArray(children) && children.length > 0) {
        walk(children);
      }
    });
  };
  walk(defs);
  return ids.sort().join('|');
};

// UTILITY FUNCTIONS - Selection Management
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

const QUICK_SEARCH_REFRESH_DEBOUNCE_MS = 800;
const BASE_COMPOUND_FILTER_PARAMS = {
  debounceMs: 800,
  buttons: ['reset'] as const,
  maxNumConditions: 2,
  alwaysShowBothConditions: true,
  defaultJoinOperator: 'AND' as const,
};

const normalizeFilterButtons = (buttons?: readonly string[]) => {
  if (!Array.isArray(buttons) || buttons.length === 0) return buttons;
  return buttons.map((button) => (button === 'clear' ? 'reset' : button));
};

const mergeCompoundFilterParams = (incoming?: unknown) => {
  const merged = typeof incoming === 'object' && incoming !== null
    ? { ...BASE_COMPOUND_FILTER_PARAMS, ...incoming }
    : { ...BASE_COMPOUND_FILTER_PARAMS };
  return {
    ...merged,
    buttons: normalizeFilterButtons(merged.buttons as readonly string[] | undefined),
  };
};

// HOOKS - Caret & Editor Focus Management
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

const resolveEditingInputFromEvent = (
  api: GridApi<RowData>,
  column: Column | null,
): HTMLInputElement | HTMLTextAreaElement | null => {
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
  return (
    editorGui?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input, textarea') ??
    document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      '.ag-cell-edit-wrapper input, .ag-cell-edit-wrapper textarea, .ag-cell-editing input, .ag-cell-editing textarea',
    ) ??
    null
  );
};

const focusFromEvent = (api: GridApi<RowData>, column: Column | null) => {
  const input = resolveEditingInputFromEvent(api, column);
  if (!input) return;
  restoreCaretSelection(input);
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

    if (!isNumericColumnDef(event.colDef)) return;

    const clearNumericZero = () => {
      const input = resolveEditingInputFromEvent(event.api, event.column);
      if (!input || input.value !== '0') return;
      input.value = '';
    };

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(clearNumericZero);
    } else {
      setTimeout(clearNumericZero, 0);
    }
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

// AG GRID MODULE REGISTRATION
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
    CsvExportModule,
    ExcelExportModule,
    SetFilterModule,
    CellSelectionModule,
    TextFilterModule,
    NumberFilterModule,
    DateFilterModule,
    TextEditorModule,
    SelectEditorModule,
    RichSelectModule,
    CustomEditorModule,
    CustomFilterModule,
    RowSelectionModule,
    RowDragModule,
    EventApiModule,
    ColumnApiModule,
    ColumnAutoSizeModule,
    RowStyleModule,
    CellStyleModule,
    RowApiModule,
    PinnedRowModule,
    ExternalFilterModule,
    ScrollApiModule,
    ValidationModule,
    LocaleModule,
    RowAutoHeightModule,
    RenderApiModule,
  ]);
  globalThis.__AG_GRID_MODULES_REGISTERED__ = true;
}

LicenseManager.setLicenseKey(process.env.NEXT_PUBLIC_AG_GRID_LICENSE || '');

// TYPE DEFINITIONS
export type GridTotals = {
  totalListPrice: number;
  totalNetPrice: number;
  totalCost: number;
  totalInstallation: number;
  totalElInstalation: number;
  totalCommissioning: number;
};

type Props = {
  endpoint: string;
  // Optional override used ONLY for persistence keys (column state/filter/sort).
  // This lets pages share layouts across multiple endpoints (e.g. all offers).
  persistenceEndpoint?: string;
  columnDefs: ColDef[];
  columnWidthDefaults?: Record<string, ColumnWidthAssignment>;
  defaultColDef?: ColDef;
  enablePivotMode?: boolean;
  onPivotModeChanged?: (enabled: boolean, api: GridApi<RowData>) => void;
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
  getRowStyle?: (params: RowClassParams<RowData>) => RowStyle | undefined;
  isExternalFilterPresent?: () => boolean;
  doesExternalFilterPass?: (node: IRowNode<RowData>) => boolean;
  getContextMenuItems?: (params: GetContextMenuItemsParams<RowData>) => Array<MenuItemDef<RowData> | DefaultMenuItem | string> | undefined;
  getHeaderMenuItems?: GetMainMenuItems<RowData>;
  suppressContextMenu?: boolean;
  onCellValueChanged?: (event: CellValueChangedEvent<RowData>) => void;
  onCellEditingStarted?: (event: CellEditingStartedEvent<RowData>) => void;
  onCellEditingStopped?: (event: CellEditingStoppedEvent<RowData>) => void;
  onRowDoubleClicked?: (event: RowDoubleClickedEvent<RowData>) => void;
  getRowHeight?: (params: RowHeightParams<RowData>) => number | undefined;
  refreshToken?: number;
  autoSizeExclusions?: string[];
  suppressColumnVirtualisation?: boolean;
  suppressMovableColumns?: boolean;
  onTotalsChange?: (totals: GridTotals | null) => void;
  enableColumnStatePersistence?: boolean;
  autoPersistColumnState?: boolean;
  applyColumnStateOrder?: boolean;
  maintainColumnOrder?: boolean;
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
  suppressCellSelection?: boolean;
  allowMultiCellDeletion?: boolean;
  useAgGridRowDrag?: boolean;
  suppressSideBar?: boolean;
  suppressNoRowsOverlay?: boolean;
  serverSideHeaderSelectMode?: 'loaded' | 'all';
  suppressColumnMoveAnimation?: boolean;
  onColumnStateRestored?: () => void;
  /** Called for each row returned by the server before it enters the grid.
   *  Return false to exclude the row. Uses a ref internally so the callback
   *  identity does not need to be stable. */
  filterServerRow?: (row: RowData) => boolean;
  /** Sync grid filter/sort/quick-search state to URL query parameters. Default true. */
  syncStateToUrl?: boolean;
  /** Pre-fetched response for the first block of rows (startRow: 0). When
   *  provided, the datasource returns it directly for the next getRows call
   *  instead of hitting the network, and is consumed exactly once per
   *  distinct prop reference (i.e. re-supply a fresh object to reuse). */
  prefetchedFirstPage?: GridResponse | null;
  /** Pre-fetched responses for arbitrary blocks, keyed by startRow.  The
   *  datasource consults this map before issuing a network request.  The
   *  parent is responsible for ensuring the cached responses correspond to
   *  the current filter/sort shape — pass a fresh Map (new identity) when
   *  invalidating.  Each block is consumed at most once per Map identity
   *  (deletes the entry on use), so repeated getRows for the same block
   *  fall through to the network on subsequent calls. */
  prefetchedBlocks?: Map<number, GridResponse> | null;
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

// UTILITY FUNCTIONS - Data Transformation & Filtering
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
      return { filterType: 'text', type: 'contains', filter: stringValue };
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

// COLUMN STATE PERSISTENCE - Constants & Storage Keys
const PERSISTED_TREE_KEY = '__persistedTreeOrdering';
const GRID_COLUMN_STATE_STORAGE_PREFIX = 'fastquote-grid-column-state';
const GRID_FILTER_STATE_STORAGE_PREFIX = 'fastquote-grid-filter-state';
const GRID_SORT_STATE_STORAGE_PREFIX = 'fastquote-grid-sort-state';
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

export const buildGridColumnStateStorageKey = (endpoint: string, userId: string, context: string): string => {
  const normalizedEndpoint = sanitizeStorageSegment(endpoint || '');
  const normalizedUser = userId && userId.trim() ? userId.trim() : GRID_COLUMN_STATE_DEFAULT_USER;
  const normalizedContext = sanitizeStorageSegment(context || '');
  const endpointPart = normalizedEndpoint || 'grid';
  const contextPart = normalizedContext || 'grid';
  return `${GRID_COLUMN_STATE_STORAGE_PREFIX}:${normalizedUser}:${endpointPart}:${contextPart}`;
};

type ColumnOrderMap = Map<string, number>;

export const collectPersistableColumnState = (
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

const readPersistedColumnState = (key: string, currentFingerprint?: string): SavedColumnStateEntry[] | null => {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.columns)) return null;
    // If columns were added or removed, discard the saved state for this grid.
    if (currentFingerprint && typeof parsed.fingerprint === 'string' && parsed.fingerprint !== currentFingerprint) {
      console.log('[AgGridAll] Column fingerprint mismatch — discarding saved state', {
        key,
        storedFingerprint: parsed.fingerprint,
        currentFingerprint,
      });
      window.localStorage.removeItem(key);
      return null;
    }
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

export const writePersistedColumnState = (key: string, columns: SavedColumnStateEntry[], columnFingerprint?: string) => {
  if (typeof window === 'undefined' || !key) return;
  try {
    if (columns.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ columns, ...(columnFingerprint ? { fingerprint: columnFingerprint } : {}) }));
  } catch (err) {
    console.warn('Failed to save column state', err);
  }
};

export const buildGridFilterStateStorageKey = (endpoint: string, userId: string, context: string): string => {
  const normalizedEndpoint = sanitizeStorageSegment(endpoint || '');
  const normalizedUser = userId && userId.trim() ? userId.trim() : GRID_COLUMN_STATE_DEFAULT_USER;
  const normalizedContext = sanitizeStorageSegment(context || '');
  const endpointPart = normalizedEndpoint || 'grid';
  const contextPart = normalizedContext || 'grid';
  return `${GRID_FILTER_STATE_STORAGE_PREFIX}:${normalizedUser}:${endpointPart}:${contextPart}`;
};

export const buildGridSortStateStorageKey = (endpoint: string, userId: string, context: string): string => {
  const normalizedEndpoint = sanitizeStorageSegment(endpoint || '');
  const normalizedUser = userId && userId.trim() ? userId.trim() : GRID_COLUMN_STATE_DEFAULT_USER;
  const normalizedContext = sanitizeStorageSegment(context || '');
  const endpointPart = normalizedEndpoint || 'grid';
  const contextPart = normalizedContext || 'grid';
  return `${GRID_SORT_STATE_STORAGE_PREFIX}:${normalizedUser}:${endpointPart}:${contextPart}`;
};

const readPersistedFilterModel = (key: string): Record<string, FilterDescriptor> | null => {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.filterModel !== 'object' || parsed.filterModel === null) return null;
    return parsed.filterModel as Record<string, FilterDescriptor>;
  } catch (err) {
    console.warn('Failed to read saved filter model', err);
    return null;
  }
};

const writePersistedFilterModel = (key: string, filterModel: Record<string, FilterDescriptor> | null) => {
  if (typeof window === 'undefined' || !key) return;
  try {
    if (!filterModel || Object.keys(filterModel).length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ filterModel }));
  } catch (err) {
    console.warn('Failed to save filter model', err);
  }
};

const readPersistedSortModel = (key: string): { colId: string; sort: 'asc' | 'desc' }[] | null => {
  if (typeof window === 'undefined' || !key) return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.sortModel)) return null;
    const sortModel: { colId: string; sort: 'asc' | 'desc' }[] = [];
    for (const entry of parsed.sortModel) {
      if (!entry || typeof entry !== 'object') continue;
      const colId = typeof entry.colId === 'string' ? entry.colId : '';
      const sort = entry.sort === 'asc' || entry.sort === 'desc' ? entry.sort : null;
      if (colId && sort) {
        sortModel.push({ colId, sort });
      }
    }
    return sortModel.length > 0 ? sortModel : null;
  } catch (err) {
    console.warn('Failed to read saved sort model', err);
    return null;
  }
};

const writePersistedSortModel = (key: string, sortModel: { colId: string; sort: 'asc' | 'desc' }[] | null) => {
  if (typeof window === 'undefined' || !key) return;
  try {
    if (!sortModel || sortModel.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify({ sortModel }));
  } catch (err) {
    console.warn('Failed to save sort model', err);
  }
};

// UTILITY FUNCTIONS - Tree Ordering Management
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
  const data = payload as {
    totalListPrice?: unknown;
    totalNetPrice?: unknown;
    totalCost?: unknown;
    totalInstallation?: unknown;
    totalElInstalation?: unknown;
    totalCommissioning?: unknown;
  };
  return {
    totalListPrice: normalizeAggregateValue(data.totalListPrice ?? 0),
    totalNetPrice: normalizeAggregateValue(data.totalNetPrice ?? 0),
    totalCost: normalizeAggregateValue(data.totalCost ?? 0),
    totalInstallation: normalizeAggregateValue(data.totalInstallation ?? 0),
    totalElInstalation: normalizeAggregateValue(data.totalElInstalation ?? 0),
    totalCommissioning: normalizeAggregateValue(data.totalCommissioning ?? 0),
  };
};

type TreeOrderingUpdate = {
  OfferDetailID: number;
  TreeOrdering: string | null;
};

type RowWithPersistedTree = RowData & {
  [PERSISTED_TREE_KEY]?: string | null;
};

type TreeOrderingSegment = { numeric: number } | { text: string };
type ParsedTreeOrdering = { segments: TreeOrderingSegment[]; allNumeric: boolean; raw: string };

const parseTreeOrderingPath = (value: unknown): string[] => {
  if (value == null) return [];
  const trimmed = String(value).trim();
  if (!trimmed) return [];
  return trimmed
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
};

const parseTreeOrderingFull = (value: unknown): ParsedTreeOrdering => {
  if (value == null) return { segments: [], allNumeric: true, raw: '' };
  const raw = String(value).trim();
  if (!raw) return { segments: [], allNumeric: true, raw };
  const parts = raw.split('.');
  let allNumeric = true;
  const segments: TreeOrderingSegment[] = parts.map((part) => {
    const num = Number.parseInt(part, 10);
    if (Number.isFinite(num) && String(num) === part.trim()) return { numeric: num };
    allNumeric = false;
    return { text: part.trim() };
  });
  return { segments, allNumeric, raw };
};

const compareSegments = (a: TreeOrderingSegment, b: TreeOrderingSegment): number => {
  const aNum = 'numeric' in a;
  const bNum = 'numeric' in b;
  if (aNum && bNum) return a.numeric - b.numeric;
  if (aNum) return -1;
  if (bNum) return 1;
  return (a as { text: string }).text.localeCompare((b as { text: string }).text);
};


const compareFullPaths = (a: ParsedTreeOrdering, b: ParsedTreeOrdering): number => {
  if (a.segments.length === 0 && b.segments.length === 0) return 0;
  if (a.segments.length === 0) return 1;
  if (b.segments.length === 0) return -1;
  if (a.allNumeric && !b.allNumeric) return -1;
  if (!a.allNumeric && b.allNumeric) return 1;
  const max = Math.max(a.segments.length, b.segments.length);
  for (let idx = 0; idx < max; idx += 1) {
    if (idx >= a.segments.length) return -1;
    if (idx >= b.segments.length) return 1;
    const cmp = compareSegments(a.segments[idx], b.segments[idx]);
    if (cmp !== 0) return cmp;
  }
  return 0;
};

const longestCommonPrefix = (a: string[], b: string[]): string[] => {
  const limit = Math.min(a.length, b.length);
  const prefix: string[] = [];
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

// UTILITY FUNCTIONS - Server-Side Data & Row Management
const reorderRowsByTreeOrdering = (api: GridApi<RowData>) => {
  if (typeof api.applyServerSideTransaction !== 'function') return;
  const entries: Array<{ data: RowData; parsed: ParsedTreeOrdering }> = [];
  api.forEachNode((node) => {
    if (!node.data) return;
    const data = node.data as RowData;
    const parsed = parseTreeOrderingFull((data as { TreeOrdering?: string | null }).TreeOrdering ?? null);
    entries.push({ data, parsed });
  });
  if (entries.length === 0) return;
  entries.sort((a, b) => compareFullPaths(a.parsed, b.parsed));
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

// Stable default values for object/array props to avoid creating new references on every render.
// Unstable defaults (e.g. `= {}` or `= []` in the parameter list) cause useMemo chains
// (resolvedColumnWidthDefaults → resolvedColumnDefs → datasource) to recompute each render,
// which makes AG Grid re-process column definitions and reset user-resized column widths.
const EMPTY_COLUMN_WIDTH_DEFAULTS: Record<string, ColumnWidthAssignment> = {};
const EMPTY_AUTO_SIZE_EXCLUSIONS: string[] = [];

// Active filters indicator — renders into PageHeader's search slot via portal when
// user-meaningful filters (anything not in IGNORED_FILTER_COLS) are active.
function ActiveFiltersIndicator({
  activeFilterCount,
  displayedRowCount,
  onClear,
}: {
  activeFilterCount: number;
  displayedRowCount: number | null;
  onClear: () => void;
}) {
  const slot = useContext(PageHeaderContext);
  if (!slot || activeFilterCount <= 0) return null;
  const rowLabel = displayedRowCount == null
    ? ''
    : `Showing ${displayedRowCount.toLocaleString()} row${displayedRowCount === 1 ? '' : 's'} with `;
  const filterLabel = `${activeFilterCount} filter${activeFilterCount === 1 ? '' : 's'}`;
  return createPortal(
    <div className={styles.activeFiltersIndicator} role="status" aria-live="polite">
      <span className={styles.activeFiltersLabel}>
        {rowLabel}{filterLabel}
      </span>
      <button
        type="button"
        className={styles.activeFiltersClearButton}
        onClick={onClear}
        aria-label="Clear filters"
        title="Clear filters"
      >
        ×
      </button>
    </div>,
    slot,
  );
}

// MAIN COMPONENT - AgGridAll
export default function AgGridAll({
  endpoint,
  persistenceEndpoint,
  columnDefs,
  columnWidthDefaults = EMPTY_COLUMN_WIDTH_DEFAULTS,
  defaultColDef,
  enablePivotMode = false,
  onPivotModeChanged,
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
  getRowStyle,
  isExternalFilterPresent,
  doesExternalFilterPass,
  getContextMenuItems,
  getHeaderMenuItems,
  suppressContextMenu = false,
  onCellValueChanged: externalCellValueChangeHandler,
  onCellEditingStarted: externalCellEditingStartedHandler,
  onCellEditingStopped: externalCellEditingStoppedHandler,
  getRowHeight,
  onModelUpdated,
  refreshToken = 0,
  autoSizeExclusions = EMPTY_AUTO_SIZE_EXCLUSIONS,
  onTotalsChange,
  suppressColumnVirtualisation = false,
  suppressMovableColumns = false,
  enableColumnStatePersistence = true,
  autoPersistColumnState = true,
  applyColumnStateOrder = false,
  maintainColumnOrder = false,
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
  suppressCellSelection = false,
  allowMultiCellDeletion = false,
  useAgGridRowDrag = false,
  suppressSideBar = false,
  suppressNoRowsOverlay = false,
  serverSideHeaderSelectMode = 'all',
  suppressColumnMoveAnimation = false,
  onColumnStateRestored,
  filterServerRow,
  syncStateToUrl = true,
  prefetchedFirstPage = null,
  prefetchedBlocks = null,
}: Props) {
  // Initialize editor focus management hooks
  useMutationCaret();
  const { handleEditingStart, handleEditingStop, requestRefresh } = useEditorFocusHandlers();
  const persistColumnStateNowRef = useRef<(() => void) | null>(null);

  // REFS - Grid References & State Tracking
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
        if (method === 'refreshServerSide') {
          try {
            persistColumnStateNowRef.current?.();
          } catch {
            /* noop */
          }
        }
        requestRefresh(() => boundOriginal(...args));
      };
    };
    wrap('refreshCells');
    wrap('refreshServerSide');
    wrap('redrawRows');
  }, [requestRefresh]);
  const gridRef = useRef<AgGridReact<RowData> | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const preservedRangeSelectionRef = useRef<CellRangeParams[] | null>(null);

  // CELL SELECTION & PASTE HANDLING
  const captureCurrentRangeSelection = useCallback(() => {
    const api = gridRef.current?.api ?? null;
    if (!api) return null;
    const ranges = api.getCellRanges();
    if (!ranges?.length) return null;
    const params = ranges
      .map((range) => mapCellRangeToParams(range))
      .filter((value): value is CellRangeParams => value !== null);
    return params.length > 0 ? params : null;
  }, [gridRef]);

  const handlePasteStart = useCallback(() => {
    preservedRangeSelectionRef.current = captureCurrentRangeSelection();
  }, [captureCurrentRangeSelection]);

  const handlePasteEnd = useCallback(() => {
    const api = gridRef.current?.api ?? null;
    if (!api) return;
    const ranges = preservedRangeSelectionRef.current;
    if (!ranges?.length) return;
    restoreCellRanges(api, ranges);
  }, [gridRef]);

  const clearSelectedCellValues = useCallback((apiOverride?: GridApi<RowData> | null) => {
    const api = apiOverride ?? gridRef.current?.api ?? null;
    if (!api) return;
    const ranges = api.getCellRanges();
    if (!ranges?.length) return;
    ranges.forEach((range) => {
      if (!range.columns?.length) return;
      const startRow = range.startRow ?? range.endRow;
      const endRow = range.endRow ?? range.startRow;
      if (!startRow || !endRow) return;
      if (startRow.rowPinned || endRow.rowPinned) return;
      const rowStartIndex = Math.min(startRow.rowIndex, endRow.rowIndex);
      const rowEndIndex = Math.max(startRow.rowIndex, endRow.rowIndex);
      for (let rowIndex = rowStartIndex; rowIndex <= rowEndIndex; rowIndex += 1) {
        const node = api.getDisplayedRowAtIndex(rowIndex);
        if (!node) continue;
        range.columns.forEach((column) => {
          if (!isEditableColumnValue(column, node)) return;
          const colDef = column.getColDef();
          const colKey = colDef?.field ?? column.getColId();
          if (!colKey) return;
          const nextValue = shouldZeroOnDelete(colDef) ? 0 : null;
          node.setDataValue(colKey, nextValue, 'delete');
        });
      }
    });
  }, [gridRef]);

  const deleteSelectionValues = useCallback((apiOverride?: GridApi<RowData> | null) => {
    const api = apiOverride ?? gridRef.current?.api ?? null;
    if (!api) return;
    const ranges = api.getCellRanges();
    if (!ranges?.length) {
      const focused = typeof api.getFocusedCell === 'function' ? api.getFocusedCell() : null;
      if (!focused?.column || typeof focused.rowIndex !== 'number') return;
      const node = api.getDisplayedRowAtIndex(focused.rowIndex);
      if (!node) return;
      const column = focused.column;
      if (!isEditableColumnValue(column, node)) return;
      const colDef = column.getColDef();
      const colKey = colDef?.field ?? column.getColId();
      if (!colKey) return;
      const nextValue = shouldZeroOnDelete(colDef) ? 0 : null;
      node.setDataValue(colKey, nextValue, 'delete');
      return;
    }
    if (!allowMultiCellDeletion) return;
    clearSelectedCellValues(api);
  }, [allowMultiCellDeletion, clearSelectedCellValues, gridRef]);

  const gridApiRef = useRef<GridApi<RowData> | null>(null);
  const pendingScrollRestoreTopRef = useRef<number | null>(null);
  const columnSaveTimerRef = useRef<number | null>(null);
  const columnStateLoadedRef = useRef(false);
  const filterStateLoadedRef = useRef(false);
  const sortStateLoadedRef = useRef(false);
  const filterStateRestoringRef = useRef(false);
  const sortStateRestoringRef = useRef(false);
  const pendingSortRefreshAfterRestoreRef = useRef(false);
  const pendingFilterWidthRestoreRef = useRef<Array<{ colId: string; width: number }> | null>(null);
  const firstDataRenderedRef = useRef(false);
  const [isGridReady, setIsGridReady] = useState(false);
  const [gridEmpty, setGridEmpty] = useState(true);
  const gridEmptyRef = useRef(true);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [blockZeroLoading, setBlockZeroLoading] = useState(false);
  const [hasUserFilters, setHasUserFilters] = useState(false);
  const [activeFilterCount, setActiveFilterCount] = useState(0);
  const [displayedRowCount, setDisplayedRowCount] = useState<number | null>(null);
  const { userId } = useAuditUser();
  const pathname = usePathname();

  // URL STATE SYNC
  const gridUrlState = useGridUrlState({
    enabled: syncStateToUrl !== false && enableColumnStatePersistence !== false,
    namespace: columnStateNamespace || undefined,
  });

  // COLUMN STATE PERSISTENCE - Storage Keys & Configuration
  const shouldPersistColumnState = enableColumnStatePersistence !== false;
  const shouldAutoPersistColumnState = shouldPersistColumnState && autoPersistColumnState !== false;
  const persistenceKeyBase = persistenceEndpoint ?? endpoint;
  const columnStateStorageKey = useMemo(
    () => {
      if (!shouldPersistColumnState) return '';
      const context = columnStateNamespace || pathname || '';
      return buildGridColumnStateStorageKey(persistenceKeyBase, userId, context ?? '');
    },
    [columnStateNamespace, persistenceKeyBase, pathname, userId, shouldPersistColumnState],
  );
  const filterStateStorageKey = useMemo(
    () => {
      if (!shouldPersistColumnState) return '';
      const context = columnStateNamespace || pathname || '';
      return buildGridFilterStateStorageKey(persistenceKeyBase, userId, context ?? '');
    },
    [columnStateNamespace, persistenceKeyBase, pathname, userId, shouldPersistColumnState],
  );
  const sortStateStorageKey = useMemo(
    () => {
      if (!shouldPersistColumnState) return '';
      const context = columnStateNamespace || pathname || '';
      return buildGridSortStateStorageKey(persistenceKeyBase, userId, context ?? '');
    },
    [columnStateNamespace, persistenceKeyBase, pathname, userId, shouldPersistColumnState],
  );
  const columnFingerprint = useMemo(() => buildColumnFingerprint(columnDefs), [columnDefs]);

  const previousStorageKeysRef = useRef<{ column: string; filter: string; sort: string }>({
    column: '',
    filter: '',
    sort: '',
  });
  const previousColumnStateKeyRef = useRef<string>(''); // legacy (kept for minimal changes)
  if (previousStorageKeysRef.current.column !== columnStateStorageKey) {
    const prev = previousStorageKeysRef.current;
    const next = { column: columnStateStorageKey, filter: filterStateStorageKey, sort: sortStateStorageKey };

    const extractUserSegment = (key: string): string => {
      const parts = String(key ?? '').split(':');
      return parts.length >= 2 ? parts[1] ?? '' : '';
    };
    const migrateIfNeeded = (fromKey: string, toKey: string) => {
      if (typeof window === 'undefined') return;
      if (!fromKey || !toKey || fromKey === toKey) return;
      const fromUser = extractUserSegment(fromKey);
      const toUser = extractUserSegment(toKey);
      if (!fromUser || !toUser) return;
      if (fromUser !== GRID_COLUMN_STATE_DEFAULT_USER) return;
      if (toUser === GRID_COLUMN_STATE_DEFAULT_USER) return;
      try {
        const existing = window.localStorage.getItem(toKey);
        if (existing) return;
        const raw = window.localStorage.getItem(fromKey);
        if (!raw) return;
        window.localStorage.setItem(toKey, raw);
      } catch {
        /* noop */
      }
    };

    migrateIfNeeded(prev.column, next.column);
    migrateIfNeeded(prev.filter, next.filter);
    migrateIfNeeded(prev.sort, next.sort);

    previousStorageKeysRef.current = next;
    previousColumnStateKeyRef.current = columnStateStorageKey;
    columnStateLoadedRef.current = false;
    // IMPORTANT: do NOT reset `firstDataRenderedRef` here.
    // The grid may have already rendered data; if we set this to false, the new persisted
    // column state will never be applied (because the apply effect waits for firstDataRendered).
    filterStateLoadedRef.current = false;
    sortStateLoadedRef.current = false;
    filterStateRestoringRef.current = false;
    sortStateRestoringRef.current = false;
    pendingSortRefreshAfterRestoreRef.current = false;
  }
  const resolvedPerformanceMode = performanceMode !== false;
  const resolvedDisableAutoSize = disableAutoSize;

  // PERFORMANCE & CACHING CONFIGURATION
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
  const cellSelectionEnabled = !suppressCellSelection && (!resolvedPerformanceMode || allowCellSelectionInPerformanceMode);
  const cellSelectionConfig = useMemo<CellSelectionOptions<RowData> | false>(() => (
    cellSelectionEnabled
      ? {} // Range handle disabled - no handle property
      : false
  ), [cellSelectionEnabled]);

  const captureColumnWidths = useCallback((api: GridApi<RowData>): Array<{ colId: string; width: number }> => {
    if (!api || api.isDestroyed?.()) return [];
    const columnState = typeof api.getColumnState === 'function' ? api.getColumnState() : [];
    if (!Array.isArray(columnState) || columnState.length === 0) return [];
    return columnState
      .map((entry) => {
        const colId = typeof entry?.colId === 'string' ? entry.colId : '';
        const width = typeof entry?.width === 'number' && Number.isFinite(entry.width) && entry.width > 0
          ? entry.width
          : null;
        if (!colId || width == null) return null;
        return { colId, width };
      })
      .filter((entry): entry is { colId: string; width: number } => entry != null);
  }, []);

  const restoreColumnWidths = useCallback((api: GridApi<RowData>, widths: Array<{ colId: string; width: number }> | null) => {
    if (!api || api.isDestroyed?.() || !widths || widths.length === 0) return;
    try {
      api.applyColumnState({
        state: widths,
        applyOrder: false,
      });
    } catch {
      /* noop */
    }
  }, []);

  // COLUMN DEFINITIONS - Processing & Width Management
  type ColumnDefinitionWithChildren = ColDef & { children?: ColDef[] };
  const invalidCellKeysRef = useRef<Set<string>>(new Set());
  const makeInvalidCellKey = useCallback((rowId: string, colId: string) => `${rowId}::${colId}`, []);
  const invalidCellClassName = 'fastquote-invalid-cell';
  const isInvalidCell = useCallback((params: CellClassParams<RowData>) => {
    const rowId = params.node?.id ?? null;
    const colId =
      params.column?.getColId?.()
      ?? (typeof params.colDef?.colId === 'string' ? params.colDef.colId : null)
      ?? (typeof params.colDef?.field === 'string' ? params.colDef.field : null);
    if (!rowId || !colId) return false;
    return invalidCellKeysRef.current.has(makeInvalidCellKey(String(rowId), String(colId)));
  }, [makeInvalidCellKey]);

  const persistedColumnWidths = useMemo<Record<string, number>>(() => {
    if (!shouldPersistColumnState || !columnStateStorageKey || typeof window === 'undefined') {
      return {};
    }
    const persisted = readPersistedColumnState(columnStateStorageKey, columnFingerprint);
    if (!persisted || persisted.length === 0) return {};
    const widths: Record<string, number> = {};
    persisted.forEach((entry) => {
      if (!entry || typeof entry.colId !== 'string' || !entry.colId) return;
      if (typeof entry.width !== 'number') return;
      widths[entry.colId] = entry.width;
    });
    return widths;
  }, [columnStateStorageKey, shouldPersistColumnState, columnFingerprint]);

  const resolvedColumnDefs = useMemo(() => {
    const base = !suppressRowGroup
      ? columnDefs
      : columnDefs.map((definition) => ({
          ...definition,
          enableRowGroup: false,
        }));
    const attachValidationClassRules = (definitions: ColumnDefinitionWithChildren[]): ColumnDefinitionWithChildren[] => (
      definitions.map((definition) => {
        const next: ColumnDefinitionWithChildren = { ...definition };
        const existingRules =
          typeof next.cellClassRules === 'object' && next.cellClassRules !== null
            ? next.cellClassRules
            : {};
        next.cellClassRules = {
          ...existingRules,
          [invalidCellClassName]: isInvalidCell,
        };
        const children = definition.children;
        if (Array.isArray(children) && children.length > 0) {
          next.children = attachValidationClassRules(children);
        }
        return next;
      })
    );
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
        if (next.singleClickEdit) {
          next.singleClickEdit = false;
        }
        if (next.filter !== false) {
          next.filterParams = mergeCompoundFilterParams(next.filterParams);
        }
        const children = definition.children;
        if (Array.isArray(children) && children.length > 0) {
          next.children = applyDefaults(children);
        }
        return next;
      },
    );
    const baseWithDefaults = applyDefaults(attachValidationClassRules(base));
    if (
      !shouldPersistColumnState
      || Object.keys(persistedColumnWidths).length === 0
      || columnStateLoadedRef.current
    ) {
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
  }, [
    columnDefs,
    invalidCellClassName,
    isInvalidCell,
    persistedColumnWidths,
    shouldPersistColumnState,
    resolvedColumnWidthDefaults,
    suppressRowGroup,
  ]);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingExternalRefreshRef = useRef<number | null>(null);
  const contextMenuRowIdRef = useRef<string | null>(null);
  const dropIndicatorRef = useRef<RowDropIndicator | null>(null);
  const dropIndicatorFrameRef = useRef<number | null>(null);
  const lastDragNodeRef = useRef<IRowNode<RowData> | null>(null);
  // QUICK SEARCH - Configuration & State
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

  // CONTEXT MENU - Row Highlighting & Selection Snapshot
  const hasServerSideSelectAll = useCallback((api?: GridApi<RowData> | null) => {
    if (!api || typeof api.getServerSideSelectionState !== 'function') return false;
    const state = api.getServerSideSelectionState();
    return Boolean(state && 'selectAll' in state && Boolean((state as ServerSideRowSelectionState).selectAll));
  }, []);

  const captureSelectionSnapshot = useCallback((api: GridApi<RowData> | null) => {
    if (hasServerSideSelectAll(api)) {
      // Collect all loaded nodes so the delete context menu can use them,
      // excluding any rows the user has toggled off.
      const deselectedIds = getServerSideDeselectedRowIds(api);
      const allNodes: Array<RowNode<RowData>> = [];
      if (api && typeof api.forEachNode === 'function') {
        api.forEachNode((node) => {
          if (!node?.data) return;
          if (deselectedIds.size > 0 && node.id != null && deselectedIds.has(String(node.id))) return;
          allNodes.push(node as RowNode<RowData>);
        });
      }
      setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, allNodes);
      return;
    }
    const selectedNodes = typeof api?.getSelectedNodes === 'function'
      ? (api.getSelectedNodes() as Array<RowNode<RowData>>)
      : [];
    setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, selectedNodes ?? []);
  }, [hasServerSideSelectAll]);

  const updateContextMenuRowClass = useCallback((rowId: string | null) => {
    const shell = shellRef.current;
    if (!shell) return;
    const rows = Array.from(shell.querySelectorAll<HTMLElement>('.ag-row'));
    rows.forEach((row) => row.classList.remove('ag-row--context-menu-active'));
    if (!rowId) return;
    const targets = Array.from(shell.querySelectorAll<HTMLElement>(`.ag-row[row-id="${rowId}"]`));
    targets.forEach((row) => row.classList.add('ag-row--context-menu-active'));
  }, []);

  const handleCellContextMenu = useCallback((event: CellContextMenuEvent<RowData>) => {
    captureSelectionSnapshot(event.api ?? null);
    contextMenuRowIdRef.current = event.node?.id ?? null;
    updateContextMenuRowClass(contextMenuRowIdRef.current);
  }, [captureSelectionSnapshot, updateContextMenuRowClass]);

  const handleCellMouseDown = useCallback((event: CellMouseDownEvent<RowData>) => {
    const domEvent = event.event;
    if (!(domEvent instanceof MouseEvent) || domEvent.button !== 2) return;
    captureSelectionSnapshot(event.api ?? null);
  }, [captureSelectionSnapshot]);

  const clearContextMenuRow = useCallback(() => {
    contextMenuRowIdRef.current = null;
    updateContextMenuRowClass(null);
  }, [updateContextMenuRowClass]);

  const handleContextMenuVisibleChanged = useCallback((event: ContextMenuVisibleChangedEvent<RowData>) => {
    if (!event.visible) {
      clearContextMenuRow();
    }
  }, [clearContextMenuRow]);

  // ROW DRAG & DROP - Drop Indicator Management
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
    // Remove top drop line element if it exists
    const topDropLine = shell.querySelector<HTMLElement>('.ag-drop-line-top');
    if (topDropLine) {
      topDropLine.remove();
    }
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

    // If position is "before", check if this row is at the top and add top drop line
    if (indicator.position === 'before' && targets.length > 0) {
      const targetRow = targets[0];
      const viewport = shell.querySelector<HTMLElement>('.ag-center-cols-viewport, .ag-body-viewport');
      if (viewport && targetRow) {
        const viewportRect = viewport.getBoundingClientRect();
        const rowRect = targetRow.getBoundingClientRect();
        // Check if row is at or near the top of the viewport (within 3px tolerance)
        const isAtTop = rowRect.top <= viewportRect.top + 3;

        if (isAtTop) {
          // Create or update the top drop line element
          let topDropLine = shell.querySelector<HTMLElement>('.ag-drop-line-top');
          if (!topDropLine) {
            topDropLine = document.createElement('div');
            topDropLine.className = 'ag-drop-line-top';
            topDropLine.style.cssText = `
              position: absolute;
              left: 0;
              right: 0;
              height: 2px;
              background: var(--row-drop-line, rgba(37, 99, 235, 0.85));
              pointer-events: none;
              z-index: 1002;
            `;
            shell.appendChild(topDropLine);
          }
          // Position it at the top of the viewport relative to the shell
          const viewportTop = viewport.getBoundingClientRect().top;
          const shellTop = shell.getBoundingClientRect().top;
          topDropLine.style.top = `${viewportTop - shellTop}px`;
        }
      }
    }
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
    // Wait for grid to be ready
    if (!isGridReady) return;
    
    const shell = shellRef.current;
    if (!shell) return;
    
    // Use gridApiRef which is set in onGridReady
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api) return;
    
    let headerCheckbox: HTMLInputElement | null = null;
    let isHandling = false;
    
    const handleCheckboxClick = (event: MouseEvent) => {
      if (!headerCheckbox || isHandling) return;
      
      // Prevent AG Grid's default handler first
      event.stopPropagation();
      event.preventDefault();
      
      // Check the actual selection state to determine what to do
      // Don't rely on checkbox state as it might be out of sync
      const selectedCount = typeof api.getSelectedNodes === 'function' 
        ? api.getSelectedNodes().length 
        : 0;
      let hasServerSideSelectAll = false;
      if (typeof api.getServerSideSelectionState === 'function') {
        const state = api.getServerSideSelectionState();
        hasServerSideSelectAll = Boolean(
          state && 
          'selectAll' in state && 
          (state as ServerSideRowSelectionState).selectAll
        );
      }
      
      // Determine if we should select or deselect based on actual selection state
      // If there are selected nodes or server-side selectAll is true, we should deselect
      // Otherwise, we should select
      const shouldSelect = selectedCount === 0 && !hasServerSideSelectAll;
      const isChecked = shouldSelect;
      
      // Process the selection/deselection
      isHandling = true;
      
      // Update checkbox visual state to match our decision
      headerCheckbox.checked = isChecked;
      
      // Select/deselect all visible nodes directly
      // This works with both client-side and server-side row models
      if (isChecked) {
        if (serverSideHeaderSelectMode === 'all' && typeof api.setServerSideSelectionState === 'function') {
          // For 'all' mode: set server-side selectAll state so newly loaded rows
          // also appear selected as the user scrolls
          try {
            api.setServerSideSelectionState({
              selectAll: true,
              toggledNodes: [],
            });
          } catch {
            // Ignore errors
          }
        } else {
          // For 'loaded' mode: clear any server-side selectAll state first
          if (typeof api.setServerSideSelectionState === 'function') {
            try {
              api.setServerSideSelectionState({
                selectAll: false,
                toggledNodes: [],
              });
            } catch {
              // Ignore errors
            }
          }
        }

        // Also select all currently loaded nodes for immediate visual feedback
        if (typeof api.forEachNode === 'function') {
          api.forEachNode((node) => {
            if (node.selectable !== false && !node.isRowPinned()) {
              node.setSelected(true);
            }
          });
        } else if (typeof api.selectAll === 'function') {
          api.selectAll();
        }
      } else {
        // First clear server-side selection state to prevent conflicts
        if (typeof api.setServerSideSelectionState === 'function') {
          try {
            api.setServerSideSelectionState({
              selectAll: false,
              toggledNodes: [],
            });
          } catch {
            // Ignore errors when clearing server-side state
          }
        }
        
        // Deselect all nodes
        if (typeof api.deselectAll === 'function') {
          api.deselectAll();
        }
        
        // Also manually deselect all visible nodes to ensure they're cleared
        if (typeof api.forEachNode === 'function') {
          api.forEachNode((node) => {
            if (node.selectable !== false && !node.isRowPinned() && node.isSelected()) {
              node.setSelected(false);
            }
          });
        }
      }
      // Call the callback if provided
      if (typeof onHeaderSelectAllChange === 'function') {
        setTimeout(() => {
          onHeaderSelectAllChange(isChecked, api);
          isHandling = false;
        }, 0);
      } else {
        isHandling = false;
      }
    };

    const attachHeaderCheckbox = () => {
      const nextCheckbox = shell.querySelector<HTMLInputElement>('.ag-header-select-all input[type="checkbox"]');
      if (headerCheckbox === nextCheckbox) return;
      if (headerCheckbox) {
        headerCheckbox.removeEventListener('click', handleCheckboxClick, true);
      }
      headerCheckbox = nextCheckbox;
      if (headerCheckbox) {
        // Listen to click event in capture phase to intercept before AG Grid
        headerCheckbox.addEventListener('click', handleCheckboxClick, true);
      }
    };

    attachHeaderCheckbox();
    const observer = new MutationObserver(attachHeaderCheckbox);
    observer.observe(shell, { childList: true, subtree: true });
    
    // Also try attaching after a short delay in case checkbox appears later
    const delayedAttach = setTimeout(() => {
      attachHeaderCheckbox();
    }, 100);
    
    return () => {
      clearTimeout(delayedAttach);
      observer.disconnect();
      if (headerCheckbox) {
        headerCheckbox.removeEventListener('click', handleCheckboxClick, true);
      }
    };
  }, [isGridReady, onHeaderSelectAllChange, serverSideHeaderSelectMode]);

  // GLOBAL EVENT HANDLERS - Click, Keyboard, Paste
  useEffect(() => {
    const getCurrentGridApi = () => gridApiRef.current ?? gridRef.current?.api ?? null;
    const isPageHeaderArea = (element: Element | null) =>
      Boolean(element?.closest('.PageHeader-module__YnWxqa__headerSide'));
    
    // Check if click is inside THIS grid's shell
    const isClickInsideThisGrid = (element: Element | null) => {
      if (!element) return false;
      const shell = shellRef.current;
      if (!shell) return false;
      
      // Check if element is inside the shell or inside the AG Grid root wrapper within this shell
      if (shell.contains(element)) {
        return true;
      }
      
      // Also check if element is inside any .ag-root-wrapper that's inside this shell
      const rootWrapper = shell.querySelector('.ag-root-wrapper');
      if (rootWrapper && rootWrapper.contains(element)) {
        return true;
      }
      
      return false;
    };

    const handleClick = (event: Event) => {
      if (event instanceof MouseEvent && event.button === 2) {
        return;
      }
      const target = event.target ?? null;
      if (isActionMenuEventTarget(target)) return;
      const element = resolveElementFromEventTarget(target);
      const clickedInsideThisGrid = isClickInsideThisGrid(element);
      const clickedOnPageHeader = isPageHeaderArea(element);
      const clickedInsidePersistentArea = isSelectionPreservingTarget(element);
      
      const clickedOnSelectionElement = Boolean(
        element?.closest('.ag-selection-checkbox') ||
        element?.closest('input[type="checkbox"]') ||
        element?.closest('.ag-row') ||
        element?.closest('.ag-cell')
      );
      
      const shouldPreserveSelection = clickedInsideThisGrid || clickedInsidePersistentArea || clickedOnSelectionElement || rowSelection === 'multiple';
      
      if (shouldPreserveSelection) {
        clearContextMenuRow();
        return;
      }
      
      if (clickedOnPageHeader) {
        scheduleDeselectAllRows(getCurrentGridApi());
      } else if (!clickedInsideThisGrid && !clickedInsidePersistentArea) {
        scheduleDeselectAllRows(getCurrentGridApi());
      }
      clearContextMenuRow();
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button === 2) return;
      const element = resolveElementFromEventTarget(event.target ?? null);
      const clickedInsideThisGrid = isClickInsideThisGrid(element);
      const clickedOnPageHeader = isPageHeaderArea(element);
      const clickedInsidePersistentArea = isSelectionPreservingTarget(element);
      
      // Don't deselect if clicking inside THIS grid's shell, selection-preserving area, or on selection elements
      // Also don't deselect if this grid has row selection enabled
      const clickedOnSelectionElement = Boolean(
        element?.closest('.ag-row') ||
        element?.closest('.ag-cell') ||
        element?.closest('.ag-header') ||
        element?.closest('.ag-selection-checkbox') ||
        element?.closest('input[type="checkbox"]')
      );
      
      const shouldPreserveSelection = clickedInsideThisGrid || clickedInsidePersistentArea || clickedOnSelectionElement || rowSelection === 'multiple';
      
      if (shouldPreserveSelection) {
        return;
      }
      
      if (!element || clickedOnPageHeader) {
        if (!clickedInsidePersistentArea) {
          scheduleDeselectAllRows(getCurrentGridApi());
        }
        return;
      }
      
      scheduleDeselectAllRows(getCurrentGridApi());
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearContextMenuRow();
        return;
      }
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const element = resolveElementFromEventTarget(event.target ?? null);
      if (!element?.closest('.ag-root')) return;
      const api = gridRef.current?.api ?? null;
      if (!api) return;
      const isEditingCell = Boolean(element.closest('.ag-cell-editing'));
      const isFormField = Boolean(element.closest('input, textarea, [contenteditable="true"]'));
      if (isEditingCell) {
        const focused = typeof api.getFocusedCell === 'function' ? api.getFocusedCell() : null;
        if (!focused?.column || typeof focused.rowIndex !== 'number') return;
        const node = api.getDisplayedRowAtIndex(focused.rowIndex);
        if (!node) return;
        const column = focused.column;
        if (!isEditableColumnValue(column, node)) return;
        const colDef = column.getColDef();
        const colKey = colDef?.field ?? column.getColId();
        if (!colKey) return;
        event.preventDefault();
        event.stopPropagation();
        if (typeof api.stopEditing === 'function') {
          api.stopEditing(true);
        }
        const nextValue = shouldZeroOnDelete(colDef) ? 0 : null;
        node.setDataValue(colKey, nextValue, 'delete');
        return;
      }
      if (isFormField) return;
      event.preventDefault();
      event.stopPropagation();
      deleteSelectionValues(api);
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
  }, [clearContextMenuRow, deleteSelectionValues, rowSelection]);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const handleFilterTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const element = resolveElementFromEventTarget(event.target ?? null);
      if (!element?.closest('.ag-floating-filter')) return;
      const activeField = element.matches('input, select, textarea, [contenteditable="true"]')
        ? (element as HTMLElement)
        : (element.closest('input, select, textarea, [contenteditable="true"]') as HTMLElement | null);
      if (!activeField) return;
      const focusables = Array.from(
        shell.querySelectorAll<HTMLElement>(
          '.ag-floating-filter input, .ag-floating-filter select, .ag-floating-filter textarea, .ag-floating-filter [contenteditable="true"]',
        ),
      ).filter((node) => {
        if (node.tabIndex < 0) return false;
        if (node.getAttribute('aria-disabled') === 'true') return false;
        if (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) {
          if (node.disabled) return false;
        }
        return node.offsetParent !== null;
      });
      const currentIndex = focusables.indexOf(activeField);
      if (currentIndex === -1) return;
      const nextIndex = currentIndex + (event.shiftKey ? -1 : 1);
      const nextField = focusables[nextIndex];
      if (!nextField) return;
      event.preventDefault();
      event.stopPropagation();
      nextField.focus();
    };
    shell.addEventListener('keydown', handleFilterTab, true);
    return () => {
      shell.removeEventListener('keydown', handleFilterTab, true);
    };
  }, []);

  useEffect(() => {
    if (typeof document === 'undefined') return;

    suppressBrowserSuggestionsInFilterInputs(document);

    const handleFocusIn = (event: FocusEvent) => {
      const element = resolveElementFromEventTarget(event.target ?? null);
      if (!element) return;
      const filterField = element.matches(FILTER_INPUT_SELECTOR)
        ? element
        : element.closest(FILTER_INPUT_SELECTOR);
      if (!(filterField instanceof HTMLElement)) return;
      suppressFilterFieldBrowserSuggestions(filterField);
    };

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type !== 'childList') continue;
        record.addedNodes.forEach((node) => {
          if (!(node instanceof Element)) return;
          if (
            !node.matches('input, textarea, select, .ag-filter, .ag-floating-filter, .ag-popup')
            && node.querySelector('.ag-filter, .ag-floating-filter, .ag-popup') == null
          ) {
            return;
          }
          suppressBrowserSuggestionsInFilterInputs(node);
        });
      }
    });

    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
    document.addEventListener('focusin', handleFocusIn, true);
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', handleFocusIn, true);
    };
  }, []);

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
    const handlePaste = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      const element = resolveElementFromEventTarget(event.target ?? null);
      if (!element?.closest('.ag-root')) return;
      if (element.closest('input, textarea, [contenteditable="true"], .ag-filter, .ag-floating-filter')) return;
      event.preventDefault();
      const api = gridRef.current?.api ?? null;
      if (!api || typeof api.pasteFromClipboard !== 'function') return;
      api.pasteFromClipboard();
    };
    shell.addEventListener('paste', handlePaste);
    return () => {
      shell.removeEventListener('mousedown', handleMouseDownCapture, true);
      shell.removeEventListener('paste', handlePaste);
    };
  }, [captureSelectionSnapshot]);

  // Seed quick search from URL on mount
  const urlQuickSearchSeededRef = useRef(false);
  useEffect(() => {
    if (urlQuickSearchSeededRef.current) return;
    if (!gridUrlState.hasUrlState) return;
    const urlQuickSearch = gridUrlState.readInitialQuickSearch();
    if (urlQuickSearch && quickSearchContext) {
      urlQuickSearchSeededRef.current = true;
      quickSearchContext.onChange(urlQuickSearch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!quickSearchEnabled) return;
    const trimmedQuickSearch = resolvedQuickSearchValue.trim();
    quickSearchFilterRef.current = trimmedQuickSearch;
    // Sync quick search to URL (skip initial empty value)
    if (quickSearchEffectInitializedRef.current) {
      gridUrlState.writeQuickSearchToUrl(trimmedQuickSearch);
    }
    if (!isGridReady) return;
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api || api.isDestroyed?.()) return;
    setGridQuickFilterText(api as GridApi<unknown>, trimmedQuickSearch);
    if (!quickSearchEffectInitializedRef.current && trimmedQuickSearch.length === 0) {
      quickSearchEffectInitializedRef.current = true;
      return;
    }
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
  }, [isGridReady, quickSearchEnabled, resolvedQuickSearchValue, requestRefresh, startQuickSearchFocusRetries, gridUrlState]);

  useEffect(() => stopQuickSearchFocusRetries, [stopQuickSearchFocusRetries]);

  // URL STATE - Handle browser back/forward
  useEffect(() => {
    return gridUrlState.onPopState(() => {
      const api = gridApiRef.current ?? gridRef.current?.api ?? null;
      if (!api || api.isDestroyed?.()) return;

      const urlState = parseGridSearchParams(
        window.location.search,
        columnStateNamespace || undefined,
      );

      // Restore filter
      filterStateRestoringRef.current = true;
      if (urlState.filterModel && Object.keys(urlState.filterModel).length > 0) {
        api.setFilterModel(urlState.filterModel as Record<string, FilterDescriptor>);
      } else {
        api.setFilterModel(null);
      }
      setTimeout(() => { filterStateRestoringRef.current = false; }, 0);

      // Restore sort
      if (urlState.sortModel && urlState.sortModel.length > 0) {
        sortStateRestoringRef.current = true;
        api.applyColumnState({
          state: urlState.sortModel.map((e, i) => ({
            colId: e.colId,
            sort: e.sort,
            sortIndex: i,
          })),
          defaultState: { sort: null },
        });
        setTimeout(() => { sortStateRestoringRef.current = false; }, 0);
      }

      // Restore quick search
      if (urlState.quickSearch !== null && quickSearchContext) {
        quickSearchContext.onChange(urlState.quickSearch);
      }

      refreshServerSideData(api, { purge: true });
    });
  }, [gridUrlState, columnStateNamespace, quickSearchContext]);

  // COLUMN STATE PERSISTENCE - Apply Saved State
  const applySavedColumnState = useCallback((api: GridApi<RowData>) => {
    if (!shouldPersistColumnState || !columnStateStorageKey) return;
    if (columnStateLoadedRef.current) return;
    const persisted = readPersistedColumnState(columnStateStorageKey, columnFingerprint);
    if (!persisted || persisted.length === 0) {
      // Reset to columnDef defaults so columns don't keep hide/pinned from a previous
      // storage key (e.g. layout switch on Offer Products). Without this, the grid
      // retains state from the prior key when the new key has nothing saved yet.
      try {
        api.applyColumnState({
          state: [],
          applyOrder: false,
          defaultState: { pinned: null },
        });
      } catch { /* noop */ }
      columnStateLoadedRef.current = true;
      onColumnStateRestored?.();
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
      onColumnStateRestored?.();
      return;
    }

    // Build a map of persisted order
    const orderMap = new Map<string, number>();
    persisted.forEach((entry) => {
      if (entry.colId && typeof entry.order === 'number' && Number.isFinite(entry.order)) {
        orderMap.set(entry.colId, entry.order);
      }
    });

    // Build state ONLY from persisted entries. Columns NOT in persisted state get
    // reset to columnDef defaults via defaultState below — so a layout switch
    // doesn't carry over hide/pinned values that the user set in the previous layout.
    const stateToApply = currentState
      .filter((entry) => persistedMap.has(entry.colId ?? ''))
      .map((entry) => {
        const persistedEntry = persistedMap.get(entry.colId ?? '')!;
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
      if (applyColumnStateOrder) {
        const stateWithOrder = [...stateToApply];
        const ordered = stateWithOrder
          .map((entry) => ({
            entry,
            order: orderMap.get(entry.colId ?? ''),
          }))
          .filter(({ entry }) => entry.colId)
          .sort((a, b) => {
            const aOrder = typeof a.order === 'number' ? a.order : Number.POSITIVE_INFINITY;
            const bOrder = typeof b.order === 'number' ? b.order : Number.POSITIVE_INFINITY;
            return aOrder - bOrder;
          })
          .map(({ entry }) => entry);
        api.applyColumnState({ state: ordered, applyOrder: true, defaultState: { pinned: null } });
        const orderedColIds = persisted
          .filter((entry) => typeof entry.order === 'number' && Number.isFinite(entry.order))
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((entry) => entry.colId)
          .filter((colId): colId is string => typeof colId === 'string' && colId.length > 0);
        if (orderedColIds.length > 0 && typeof api.moveColumns === 'function') {
          const applyOrder = () => {
            try {
              api.moveColumns(orderedColIds, 0);
            } catch (err) {
              console.warn('Failed to apply column order', err);
            }
          };
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
            window.requestAnimationFrame(applyOrder);
          } else {
            applyOrder();
          }
        }
        columnStateLoadedRef.current = true;
        onColumnStateRestored?.();
        return;
      }

      // Apply properties first (without order)
      api.applyColumnState({ state: stateToApply, applyOrder: false, defaultState: { pinned: null } });
      // Force selection column back to its defined width after state restore
      if (rowSelection === 'multiple') {
        api.applyColumnState({
          state: [
            { colId: 'ag-Grid-SelectionColumn', width: 42 },
            { colId: 'agSelectionColumn', width: 42 },
          ],
          applyOrder: false,
        });
      }

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
      onColumnStateRestored?.();
    } catch (err) {
      console.warn('Failed to apply saved column state', err);
      columnStateLoadedRef.current = true;
      onColumnStateRestored?.();
    }
  }, [applyColumnStateOrder, columnFingerprint, columnStateStorageKey, onColumnStateRestored, rowSelection, shouldPersistColumnState]);

  useEffect(() => {
    if (!shouldPersistColumnState) return;
    if (!columnStateStorageKey) return;
    if (!isGridReady) return;
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api || api.isDestroyed?.()) return;
    if (!firstDataRenderedRef.current) return;
    if (columnStateLoadedRef.current) return;
    applySavedColumnState(api);
  }, [applySavedColumnState, columnStateStorageKey, isGridReady, shouldPersistColumnState]);

  // FILTER & SORT STATE PERSISTENCE
  const applySavedFilterModel = useCallback((api: GridApi<RowData>) => {
    if (!shouldPersistColumnState || !filterStateStorageKey) return;
    if (filterStateLoadedRef.current) return;

    // URL params take priority over localStorage
    const persisted = gridUrlState.hasUrlState
      ? gridUrlState.readInitialFilterModel() as Record<string, FilterDescriptor> | null
      : readPersistedFilterModel(filterStateStorageKey);

    filterStateLoadedRef.current = true;
    if (!persisted || Object.keys(persisted).length === 0) {
      return;
    }
    try {
      filterStateRestoringRef.current = true;
      setTimeout(() => {
        if (api.isDestroyed?.()) {
          filterStateRestoringRef.current = false;
          return;
        }
        api.setFilterModel(persisted);
        setTimeout(() => {
          if (api.isDestroyed?.()) {
            filterStateRestoringRef.current = false;
            return;
          }
          refreshServerSideData(api, { purge: true });
          filterStateRestoringRef.current = false;
        }, 100);
      }, 200);
    } catch (err) {
      filterStateRestoringRef.current = false;
      console.warn('Failed to apply saved filter model', err);
    }
  }, [filterStateStorageKey, shouldPersistColumnState, gridUrlState]);

  const applySavedSortModel = useCallback((api: GridApi<RowData>) => {
    if (!shouldPersistColumnState || !sortStateStorageKey) return;
    if (sortStateLoadedRef.current) return;

    // URL params take priority over localStorage
    if (gridUrlState.hasUrlState) {
      const urlSort = gridUrlState.readInitialSortModel();
      sortStateLoadedRef.current = true;
      if (urlSort && urlSort.length > 0) {
        try {
          sortStateRestoringRef.current = true;
          pendingSortRefreshAfterRestoreRef.current = true;
          api.applyColumnState({
            state: urlSort.map((entry, index) => ({
              colId: entry.colId,
              sort: entry.sort,
              sortIndex: index,
            })),
            defaultState: { sort: null },
          });
          setTimeout(() => {
            sortStateRestoringRef.current = false;
            if (pendingSortRefreshAfterRestoreRef.current) {
              pendingSortRefreshAfterRestoreRef.current = false;
              refreshServerSideData(api, { purge: false });
            }
          }, 0);
        } catch (err) {
          sortStateRestoringRef.current = false;
          pendingSortRefreshAfterRestoreRef.current = false;
          console.warn('Failed to apply URL sort model', err);
        }
        return;
      }
      // URL had state but no sort — fall through to localStorage
    }

    const persisted = readPersistedSortModel(sortStateStorageKey);
    // Mark as loaded first so persistence can work after restoration
    sortStateLoadedRef.current = true;
    if (!persisted || persisted.length === 0) {
      return;
    }
    try {
      sortStateRestoringRef.current = true;
      pendingSortRefreshAfterRestoreRef.current = true;
      api.applyColumnState({
        state: persisted.map((entry, index) => ({
          colId: entry.colId,
          sort: entry.sort,
          sortIndex: index,
        })),
        defaultState: { sort: null },
      });
      setTimeout(() => {
        sortStateRestoringRef.current = false;
        if (pendingSortRefreshAfterRestoreRef.current) {
          pendingSortRefreshAfterRestoreRef.current = false;
          refreshServerSideData(api, { purge: false });
        }
      }, 0);
    } catch (err) {
      sortStateRestoringRef.current = false;
      pendingSortRefreshAfterRestoreRef.current = false;
      console.warn('Failed to apply saved sort model', err);
    }
  }, [sortStateStorageKey, shouldPersistColumnState, gridUrlState]);

  useEffect(() => {
    if (!shouldPersistColumnState) return;
    if (!filterStateStorageKey) return;
    if (!isGridReady) return;
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api || api.isDestroyed?.()) return;
    if (!firstDataRenderedRef.current) return;
    if (filterStateLoadedRef.current) return;
    applySavedFilterModel(api);
  }, [applySavedFilterModel, filterStateStorageKey, isGridReady, shouldPersistColumnState]);

  useEffect(() => {
    if (!shouldPersistColumnState) return;
    if (!sortStateStorageKey) return;
    if (!isGridReady) return;
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api || api.isDestroyed?.()) return;
    if (!firstDataRenderedRef.current) return;
    if (sortStateLoadedRef.current) return;
    applySavedSortModel(api);
  }, [applySavedSortModel, sortStateStorageKey, isGridReady, shouldPersistColumnState]);

  // COLUMN STATE PERSISTENCE - Save State
  const persistColumnState = useCallback(() => {
    if (!shouldPersistColumnState || !columnStateStorageKey) return;
    // Don't write before the saved state has been loaded for the current key.
    // Otherwise refreshServerSide (which calls this via persistColumnStateNowRef)
    // can clobber the new key with state carried over from the previous key —
    // particularly after a layout switch on Offer Products.
    if (!columnStateLoadedRef.current) return;
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) return;
    const columnOrderMap: ColumnOrderMap = new Map();

    // IMPORTANT:
    // Use the *full* column order (visible + hidden). If we derive order only from displayed columns,
    // hidden columns lose their position and will reappear in the wrong place when shown again.
    const apiWithAllGridColumns = api as unknown as {
      getAllGridColumns?: () => Column[];
    };
    const allGridColumns =
      typeof apiWithAllGridColumns.getAllGridColumns === 'function'
        ? apiWithAllGridColumns.getAllGridColumns()
        : null;
    if (Array.isArray(allGridColumns) && allGridColumns.length > 0) {
      allGridColumns.forEach((column, index) => {
        const colId =
          typeof column?.getColId === 'function'
            ? column.getColId()
            : typeof (column as { getId?: () => string }).getId === 'function'
              ? (column as { getId?: () => string }).getId?.()
              : null;
        if (typeof colId === 'string' && colId.length > 0) {
          columnOrderMap.set(colId, index);
        }
      });
    } else {
      const fullState = typeof api.getColumnState === 'function' ? api.getColumnState() : [];
      fullState.forEach((entry, index) => {
        const colId = typeof entry?.colId === 'string' ? entry.colId : '';
        if (colId) {
          columnOrderMap.set(colId, index);
        }
      });
    }

    const nextState = collectPersistableColumnState(api.getColumnState(), columnOrderMap);
    writePersistedColumnState(columnStateStorageKey, nextState, columnFingerprint);
  }, [columnFingerprint, columnStateStorageKey, shouldPersistColumnState]);
  persistColumnStateNowRef.current = persistColumnState;

  const queuePersistColumnState = useCallback(() => {
    if (!shouldAutoPersistColumnState || typeof window === 'undefined') return;
    if (!columnStateLoadedRef.current) return;
    if (columnSaveTimerRef.current) {
      window.clearTimeout(columnSaveTimerRef.current);
    }
    columnSaveTimerRef.current = window.setTimeout(() => {
      columnSaveTimerRef.current = null;
      persistColumnState();
    }, 200);
  }, [persistColumnState, shouldAutoPersistColumnState]);

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
  const autoSizeAllowedRef = useRef(false);

  useEffect(() => {
    autoSizeCompletedRef.current = false;
    autoSizeAllowedRef.current = false;
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

  // AUTO-SIZE COLUMNS - Implementation & Menu Items
  const autoSizeColumns = useCallback((api?: GridApi<RowData> | null, force = false) => {
    if (resolvedDisableAutoSize) return;
    if (!force && !autoSizeAllowedRef.current) return;
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

  const resolveAutoSizeMenuItems = useCallback(
    (params: { api?: GridApi<RowData> | null; column?: Column | null }) => {
      if (resolvedDisableAutoSize) return [];
      const api = params.api ?? null;
      if (!api) return [];
      const exclusions = new Set(autoSizeExclusions ?? []);
      const displayed = typeof api.getAllDisplayedColumns === 'function' ? api.getAllDisplayedColumns() : [];
      const visibleColumns = displayed.filter((col) => {
        const colId = typeof col.getColId === 'function' ? col.getColId() : null;
        return !colId || !exclusions.has(colId);
      });
      const canAutoSizeAny = visibleColumns.length > 0;
      const colId = params.column?.getColId();
      const canAutoSizeColumn = Boolean(colId) && !exclusions.has(colId as string);
      const items: MenuItemDef<RowData>[] = [];
      if (colId) {
        items.push({
          name: 'Auto Size Column',
          disabled: !canAutoSizeColumn,
          action: () => {
            if (!canAutoSizeColumn) return;
            api.autoSizeColumns([colId], false);
          },
        });
      }
      items.push({
        name: 'Auto Size All Columns',
        disabled: !canAutoSizeAny,
        action: () => autoSizeColumns(api, true),
      });
      return items;
    },
    [autoSizeColumns, autoSizeExclusions, resolvedDisableAutoSize],
  );

  const handleColumnVisibleWithReorder = useCallback((event: ColumnVisibleEvent<RowData>) => {
    // Persist hide/unhide toggles
    if (shouldAutoPersistColumnState && columnStateLoadedRef.current) {
      queuePersistColumnState();
    }

    // When a column is re-enabled (made visible), ensure it returns to its saved position.
    // Without this, some hide/show flows can re-insert the column at the end of the visible list.
    if (!columnStateLoadedRef.current) return;
    if (!shouldPersistColumnState || !columnStateStorageKey) return;
    if (!event?.visible) return; // only reposition on "show", not "hide"

    const api = event.api;
    if (!api || api.isDestroyed?.()) return;
    if (typeof api.getAllDisplayedColumns !== 'function' || typeof api.moveColumns !== 'function') return;

    const persisted = readPersistedColumnState(columnStateStorageKey, columnFingerprint);
    if (!persisted || persisted.length === 0) return;

    const orderMap = new Map<string, number>();
    persisted.forEach((entry) => {
      if (entry?.colId && typeof entry.order === 'number' && Number.isFinite(entry.order)) {
        orderMap.set(entry.colId, entry.order);
      }
    });
    if (orderMap.size === 0) return;

    const displayed = api.getAllDisplayedColumns();
    if (!Array.isArray(displayed) || displayed.length === 0) return;

    const desired = [...displayed].sort((a, b) => {
      const aId = typeof a?.getColId === 'function' ? a.getColId() : '';
      const bId = typeof b?.getColId === 'function' ? b.getColId() : '';
      const aOrder = orderMap.get(aId);
      const bOrder = orderMap.get(bId);
      const aVal = typeof aOrder === 'number' ? aOrder : Number.POSITIVE_INFINITY;
      const bVal = typeof bOrder === 'number' ? bOrder : Number.POSITIVE_INFINITY;
      return aVal - bVal;
    });

    // Move from right-to-left to minimize index shifts.
    for (let targetIndex = desired.length - 1; targetIndex >= 0; targetIndex--) {
      const col = desired[targetIndex];
      const colId = typeof col?.getColId === 'function' ? col.getColId() : '';
      if (!colId) continue;
      const currentDisplayed = api.getAllDisplayedColumns();
      const currentIndex = currentDisplayed.findIndex((c) => c.getColId() === colId);
      if (currentIndex >= 0 && currentIndex !== targetIndex) {
        try {
          api.moveColumns([colId], targetIndex);
        } catch {
          /* noop */
        }
      }
    }
  }, [
    columnFingerprint,
    columnStateStorageKey,
    queuePersistColumnState,
    shouldAutoPersistColumnState,
    shouldPersistColumnState,
  ]);

  const handleColumnResized = useCallback((event: { finished?: boolean; source?: string }) => {
    if (!shouldAutoPersistColumnState || !columnStateLoadedRef.current) return;
    if (event?.finished === false) return;
    // Don't persist column state if we're about to restore widths from a filter operation
    if (pendingFilterWidthRestoreRef.current) return;
    // Don't persist column state if resize is triggered by API (e.g., during filtering)
    // Only persist user-initiated resizes
    if (event?.source === 'api' || event?.source === 'autosizeColumns' || event?.source === 'sizeColumnsToFit') return;
    queuePersistColumnState();
  }, [queuePersistColumnState, shouldAutoPersistColumnState]);

  // GRID CONFIGURATION - Default Column Def & Auto Group Column Def
  const handleFirstDataRendered = useCallback((event: FirstDataRenderedEvent) => {
    firstDataRenderedRef.current = true;
    autoSizeAllowedRef.current = true;
    if (shouldPersistColumnState && !columnStateLoadedRef.current) {
      const applyState = () => {
        if (!event.api.isDestroyed?.()) {
          applySavedColumnState(event.api);
        }
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(applyState);
      } else {
        setTimeout(applyState, 0);
      }
    }
  }, [shouldPersistColumnState, applySavedColumnState]);

  const dcd: ColDef = useMemo(() => {
    const mergedFilterParams = mergeCompoundFilterParams(defaultColDef?.filterParams);

    // Note: CSS handles cursor styling (arrow for single clicks, text for editing cells)
    // We pass through cellStyle from defaultColDef without modification

    return {
      sortable: true,
      resizable: true,
      suppressAutoSize: false,
      filter: true,
      floatingFilter: floatingFilter && (!gridEmpty || hasUserFilters),
      // Hide header menu icon (right-click still shows menu)
      suppressHeaderMenuButton: true,
      width: 100,
      ...defaultColDef,
      ...(enablePivotMode
        ? {
            enableRowGroup: true,
            enableValue: true,
            enablePivot: true,
          }
        : null),
      filterParams: mergedFilterParams,
    };
  }, [defaultColDef, enablePivotMode, floatingFilter, gridEmpty, hasUserFilters]);

  const autoGroupColumnDef = useMemo<ColDef>(() => ({
    width: 210,
    resizable: true,
    suppressAutoSize: true,
  }), []);

  // SERVER-SIDE DATASOURCE - Request Payload & Cache Management
const requestPayloadRef = useRef(requestPayload);
requestPayloadRef.current = requestPayload;
const filterServerRowRef = useRef(filterServerRow);
filterServerRowRef.current = filterServerRow;
const requestCacheRef = useRef(new Map<string, Promise<GridResponse>>());
// Consume prefetchedFirstPage exactly once per distinct prop reference.  The
// parent re-supplies a fresh GridResponse each time a new first block is
// ready (e.g. after navigating to the next requested product in the
// matcher), and we want to serve that block for the grid's next
// startRow === 0 request before falling back to the network.
const prefetchedFirstPageRef = useRef<GridResponse | null>(null);
const lastPrefetchedFirstPageIdentityRef = useRef<GridResponse | null | undefined>(undefined);
if (lastPrefetchedFirstPageIdentityRef.current !== prefetchedFirstPage) {
  prefetchedFirstPageRef.current = prefetchedFirstPage ?? null;
  lastPrefetchedFirstPageIdentityRef.current = prefetchedFirstPage;
}
// Multi-block prefetch cache.  Re-armed whenever the parent supplies a new
// Map identity; consumed entry-by-entry as the grid scrolls through blocks.
const prefetchedBlocksRef = useRef<Map<number, GridResponse> | null>(null);
const lastPrefetchedBlocksIdentityRef = useRef<Map<number, GridResponse> | null | undefined>(undefined);
if (lastPrefetchedBlocksIdentityRef.current !== prefetchedBlocks) {
  // Take a copy so consumption (delete-on-use) doesn't mutate the parent's Map.
  prefetchedBlocksRef.current = prefetchedBlocks ? new Map(prefetchedBlocks) : null;
  lastPrefetchedBlocksIdentityRef.current = prefetchedBlocks;
}

  // TREE ORDERING - Path Calculation & Parent Path Derivation
  const getRowPath = useCallback((node: IRowNode<RowData> | null | undefined): string[] => {
    if (!node) return [];
    const data = node.data as { TreeOrdering?: string | null } | undefined;
    return parseTreeOrderingPath(data?.TreeOrdering ?? null);
  }, []);

  const getParentPath = useCallback((path: string[]) => {
    return path.length > 0 ? path.slice(0, -1) : [];
  }, []);

  const deriveParentPathFromNeighbors = useCallback((
    beforeNode: IRowNode<RowData> | null,
    afterNode: IRowNode<RowData> | null,
    position: 'before' | 'after',
  ): string[] => {
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
      cellSelection: true,
      maintainColumnOrder,
      tooltipShowDelay: 300,
      tooltipHideDelay: 10000,
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
  }, [maintainColumnOrder, useAgGridRowDrag]);

  // SERVER-SIDE DATASOURCE - Implementation
  const datasource: IServerSideDatasource<RowData> = useMemo(() => ({
    getRows: async (params: IServerSideGetRowsParams<RowData>) => {
      const isBlockZero = (params.request.startRow ?? 0) === 0;
      if (isBlockZero) setBlockZeroLoading(true);
      try {
        const payload = requestPayloadRef.current && typeof requestPayloadRef.current === 'object'
          ? { ...requestPayloadRef.current }
          : {};
        if (payload && 'newProductId' in payload && typeof onRequestPayloadConsumed === 'function') {
          onRequestPayloadConsumed();
        }
        const serverRequest: ServerRequestWithQuickFilter = { ...params.request };
        if (quickSearchEnabled) {
          const quickFilterText = quickSearchFilterRef.current;
          if (typeof quickFilterText === 'string' && quickFilterText.length > 0) {
            serverRequest.quickFilterText = quickFilterText;
          } else {
            delete serverRequest.quickFilterText;
          }
        }
        if (typeof onServerRequest === 'function') {
          onServerRequest(serverRequest);
        }
        const visibleFields = params.api?.getAllDisplayedColumns?.()
          ?.map((column) => column.getColDef()?.field)
          .filter((field): field is string => typeof field === 'string' && field.length > 0) ?? [];
        const fallbackFields = collectFieldIdsFromDefs(resolvedColumnDefs);
        const fields = visibleFields.length > 0 ? visibleFields : fallbackFields;
        const bodyRequest = { ...payload, request: serverRequest, fields };
        const cacheKey = `${endpoint}:${safeStringify(payload)}:${safeStringify(serverRequest)}:${safeStringify(fields)}`;
          let responsePromise = requestCacheRef.current.get(cacheKey);
          // Cached prefetched blocks are only valid when the request shape
          // they were fetched for matches the current request.  Without this
          // check, a filter change triggers refreshServerSide → AG Grid asks
          // the datasource for block 0 → onServerRequest queues a parent
          // state update to invalidate the cache → but the parent's state
          // update is async, so we still see the stale Map identity here in
          // the same tick and serve the previous filter's rows.  Comparing
          // filter/sort/group/quick on the cached request itself sidesteps
          // the race entirely.
          const requestShapeMatches = (cached: GridResponse | null | undefined) => {
            const cachedReq = cached?.request;
            if (!cachedReq) return true;
            return (
              safeStringify(cachedReq.filterModel ?? null) === safeStringify(serverRequest.filterModel ?? null)
              && safeStringify(cachedReq.sortModel ?? null) === safeStringify(serverRequest.sortModel ?? null)
              && safeStringify(cachedReq.groupKeys ?? null) === safeStringify(serverRequest.groupKeys ?? null)
              && (cachedReq.quickFilterText ?? null) === (serverRequest.quickFilterText ?? null)
            );
          };
          // Consume a pre-fetched first block when available.  Only applies
          // to the first request (startRow === 0) and is consumed exactly
          // once per distinct prefetchedFirstPage prop reference, so
          // subsequent scroll-triggered blocks fall through to the network.
          const startRowForRequest = serverRequest.startRow ?? 0;
          if (
            !responsePromise
            && startRowForRequest === 0
            && prefetchedFirstPageRef.current
          ) {
            const cached = prefetchedFirstPageRef.current;
            prefetchedFirstPageRef.current = null;
            if (requestShapeMatches(cached)) {
              responsePromise = Promise.resolve(cached);
            }
          }
          // Consume a pre-fetched block from the multi-block cache when the
          // requested startRow matches.  Each block is taken at most once
          // per Map identity — re-supply a fresh Map to refill.
          if (!responsePromise && prefetchedBlocksRef.current) {
            const cachedBlock = prefetchedBlocksRef.current.get(startRowForRequest);
            if (cachedBlock) {
              prefetchedBlocksRef.current.delete(startRowForRequest);
              if (requestShapeMatches(cachedBlock)) {
                responsePromise = Promise.resolve(cachedBlock);
              }
            }
          }
          if (!responsePromise) {
            responsePromise = (async () => {
              const perfStart = performance.now();
              const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(bodyRequest),
            });
              if (endpoint.includes('/products/add')) {
                console.log('[populate-perf] AgGrid natural fetch', {
                  endpoint,
                  startRow: startRowForRequest,
                  durationMs: Math.round(performance.now() - perfStart),
                  hasOrFilterColumns: Boolean((bodyRequest as Record<string, unknown>).orFilterColumns),
                });
              }

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
        const filterFn = filterServerRowRef.current;
        const hasFilter = typeof filterFn === 'function';
        const filteredRows = hasFilter
          ? normalizedRows.filter(filterFn)
          : normalizedRows;
        const serverRowCount = typeof data.rowCount === 'number' ? data.rowCount : normalizedRows.length;
        const startRow = params.request.startRow ?? 0;
        const isLastServerBlock = startRow + normalizedRows.length >= serverRowCount;
        // When a client-side filter is active, don't report rowCount for
        // intermediate blocks — AG Grid stays in partial/lazy mode and won't
        // show "Loading" placeholders for filtered-out positions.  For the
        // last block, report the adjusted total so the grid knows the end.
        let resolvedRowCount: number | undefined;
        if (hasFilter && isLastServerBlock) {
          resolvedRowCount = startRow + filteredRows.length;
        } else if (hasFilter) {
          resolvedRowCount = undefined;
        } else {
          resolvedRowCount = serverRowCount;
        }
        if (typeof onTotalsChange === 'function') {
          const parsedTotals = parseTotalsPayload(data.totals ?? null);
          onTotalsChange(parsedTotals);
        }
        if (typeof onResponse === 'function') {
          onResponse({ ...data, request: serverRequest });
        }
        params.success({ rowData: filteredRows, rowCount: resolvedRowCount });
        if (startRow === 0) {
          const empty = filteredRows.length === 0;
          gridEmptyRef.current = empty;
          setGridEmpty(empty);
          setHasLoadedOnce(true);
        }
      } catch (e) {
        console.error('Datasource fetch exception', e);
        params.fail();
      } finally {
        if (isBlockZero) setBlockZeroLoading(false);
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

  // ROW SELECTION CONFIGURATION
  const resolvedAllowRowClickSelection =
    typeof allowRowClickSelectionProp === 'boolean' ? allowRowClickSelectionProp : rowSelection !== 'multiple';
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
        headerCheckbox: true,
        selectAll: 'all', // 'filtered' is invalid for server-side row models
      };
      return config;
    }

    return {
      mode: 'singleRow',
      checkboxes: false,
      enableSelectionWithoutKeys: allowMultiselectClick,
      enableClickSelection: clickSelectionEnabled || allowDeselection,
    };
  }, [
    rowSelection,
    rowDeselection,
    rowMultiSelectWithClick,
    resolvedAllowRowClickSelection,
    suppressRowClickSelection,
  ]);

  const sideBarDef = useMemo(() => {
    if (suppressSideBar) return false;
    return {
      toolPanels: [
        {
          id: 'columns',
          labelDefault: 'Columns',
          labelKey: 'columns',
          iconKey: 'columns',
          toolPanel: 'agColumnsToolPanel',
          toolPanelParams: {
            suppressPivotMode: !enablePivotMode,
            suppressPivots: !enablePivotMode,
          },
        },
        {
          id: 'filters',
          labelDefault: 'Filters',
          labelKey: 'filters',
          iconKey: 'filter',
          toolPanel: 'agFiltersToolPanel',
        },
      ],
    };
  }, [enablePivotMode, suppressSideBar]);

  // GRID CONFIGURATION - Sidebar, Row ID, & Menu Handlers
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

  // GRID EVENT HANDLERS - Grid Ready, Context Menu, Headers
  const onGridReady = useCallback((e: GridReadyEvent) => {
    e.api.setGridOption('serverSideDatasource', datasource);
    
    // Apply saved filters and sort before external grid-ready handlers run.
    // This prevents page-level default filters from overwriting persisted filters.
    // URL params take priority over localStorage when present.
    if (shouldPersistColumnState) {
      if (!e.api.isDestroyed?.()) {
        if (!filterStateLoadedRef.current && filterStateStorageKey) {
          // URL params take priority over localStorage (both are synchronous)
          const persisted = gridUrlState.hasUrlState
            ? gridUrlState.readInitialFilterModel() as Record<string, FilterDescriptor> | null
            : readPersistedFilterModel(filterStateStorageKey);
          filterStateLoadedRef.current = true;
          if (persisted && Object.keys(persisted).length > 0) {
            filterStateRestoringRef.current = true;
            e.api.setFilterModel(persisted);
            setTimeout(() => {
              filterStateRestoringRef.current = false;
            }, 0);
          }
        }
        if (!sortStateLoadedRef.current && sortStateStorageKey) {
          if (gridUrlState.hasUrlState) {
            const urlSort = gridUrlState.readInitialSortModel();
            if (urlSort && urlSort.length > 0) {
              sortStateLoadedRef.current = true;
              sortStateRestoringRef.current = true;
              e.api.applyColumnState({
                state: urlSort.map((entry, index) => ({
                  colId: entry.colId,
                  sort: entry.sort,
                  sortIndex: index,
                })),
                defaultState: { sort: null },
              });
              setTimeout(() => {
                sortStateRestoringRef.current = false;
              }, 0);
            } else {
              applySavedSortModel(e.api);
            }
          } else {
            applySavedSortModel(e.api);
          }
        }
      }
    }
    
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
  }, [datasource, externalGridReadyHandler, handleContextMenuVisibleChanged, wrapGridApiRefreshers, shouldPersistColumnState, filterStateStorageKey, sortStateStorageKey, applySavedSortModel, gridUrlState]);

  const handleColumnPivotModeChanged = useCallback((event: ColumnPivotModeChangedEvent<RowData>) => {
    const api = event.api ?? gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api || api.isDestroyed?.()) return;
    const enabled = typeof api.isPivotMode === 'function'
      ? api.isPivotMode()
      : typeof api.getGridOption === 'function'
        ? Boolean(api.getGridOption('pivotMode'))
        : false;
    if (typeof onPivotModeChanged === 'function') {
      onPivotModeChanged(enabled, api);
    }
  }, [onPivotModeChanged]);

  // MENU HANDLERS - Context Menu & Header Menu
  const contextMenuItemsHandler = useCallback<GetContextMenuItems<RowData>>((params) => {
    const hasRowNode = Boolean(params.node);
    const autoSizeItems = hasRowNode ? resolveAutoSizeMenuItems(params) : [];
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

    const menuItems = resolveMenuItems().filter((item) => item !== 'cut');
    const deleteMenuItem: MenuItemDef<RowData> = {
      name: 'Delete',
      action: (actionParams) => {
        deleteSelectionValues(actionParams.api ?? null);
      },
    };
    const replaceDeleteItem = (
      items: Array<MenuItemDef<RowData> | DefaultMenuItem | string>,
    ): Array<MenuItemDef<RowData> | DefaultMenuItem | string> => (
      items.map((item) => {
        if (item === 'delete') return deleteMenuItem;
        if (typeof item === 'object' && item && typeof item.name === 'string') {
          const normalized = item.name.trim().toLowerCase();
          if (normalized === 'delete') return deleteMenuItem;
        }
        return item;
      })
    );

    // Custom export menu items
    const csvExportIcon = `
      <span class="ag-icon ag-icon-csv" aria-hidden="true"></span>
    `;
    const excelExportIcon = `
      <span class="ag-icon ag-icon-excel" aria-hidden="true"></span>
    `;

    const createCustomExportMenuItem = (): MenuItemDef<RowData> => {
      return {
        name: 'Export',
        icon: '<span class="ag-icon ag-icon-save" aria-hidden="true"></span>',
        subMenu: [
          {
            name: 'Excel Export',
            icon: excelExportIcon,
            action: async (actionParams) => {
              const api = actionParams.api ?? null;
              console.log('[Excel Export] Starting export, api:', !!api);
              const mode = detectExportMode(api);
              console.log('[Excel Export] Export mode:', mode);

              try {
                if (mode === 'selected-cells') {
                  console.log('[Excel Export] Exporting selected cells');
                  await exportSelectedCellsAsExcel(api);
                } else if (mode === 'selected-rows') {
                  if (hasServerSideSelectAll(api)) {
                    console.log('[Excel Export] SSRM selectAll active — fetching all filtered rows');
                    const payload = requestPayloadRef.current && typeof requestPayloadRef.current === 'object'
                      ? { ...requestPayloadRef.current }
                      : undefined;
                    const quickFilter = allowQuickSearch !== false ? quickSearchFilterRef.current : null;
                    const excludeIds = getServerSideDeselectedRowIds(api);
                    await exportAllFilteredRowsAsExcel(api, endpoint, 'export.xlsx', payload, quickFilter, excludeIds);
                    console.log('[Excel Export] Export completed');
                  } else {
                    console.log('[Excel Export] Exporting selected rows');
                    await exportSelectedRowsAsExcel(api);
                  }
                } else {
                  console.log('[Excel Export] Exporting all filtered rows');
                  // Export all filtered rows
                  const payload = requestPayloadRef.current && typeof requestPayloadRef.current === 'object'
                    ? { ...requestPayloadRef.current }
                    : undefined;
                  const quickFilter = allowQuickSearch !== false ? quickSearchFilterRef.current : null;
                  console.log('[Excel Export] Payload:', payload, 'QuickFilter:', quickFilter);
                  await exportAllFilteredRowsAsExcel(api, endpoint, 'export.xlsx', payload, quickFilter);
                  console.log('[Excel Export] Export completed');
                }
              } catch (err) {
                console.error('[Excel Export] Export failed:', err);
                showToastMessage('Failed to export Excel', 'error');
              }
            },
          },
          {
            name: 'CSV Export',
            icon: csvExportIcon,
            action: async (actionParams) => {
              const api = actionParams.api ?? null;
              console.log('[CSV Export] Starting export, api:', !!api);
              const mode = detectExportMode(api);
              console.log('[CSV Export] Export mode:', mode);

              try {
                if (mode === 'selected-cells') {
                  console.log('[CSV Export] Exporting selected cells');
                  exportSelectedCellsAsCsv(api);
                } else if (mode === 'selected-rows') {
                  if (hasServerSideSelectAll(api)) {
                    console.log('[CSV Export] SSRM selectAll active — fetching all filtered rows');
                    const payload = requestPayloadRef.current && typeof requestPayloadRef.current === 'object'
                      ? { ...requestPayloadRef.current }
                      : undefined;
                    const quickFilter = allowQuickSearch !== false ? quickSearchFilterRef.current : null;
                    const excludeIds = getServerSideDeselectedRowIds(api);
                    await exportAllFilteredRowsAsCsv(api, endpoint, 'export.csv', payload, quickFilter, excludeIds);
                    console.log('[CSV Export] Export completed');
                  } else {
                    console.log('[CSV Export] Exporting selected rows');
                    exportSelectedRowsAsCsv(api);
                  }
                } else {
                  console.log('[CSV Export] Exporting all filtered rows');
                  // Export all filtered rows
                  const payload = requestPayloadRef.current && typeof requestPayloadRef.current === 'object'
                    ? { ...requestPayloadRef.current }
                    : undefined;
                  const quickFilter = allowQuickSearch !== false ? quickSearchFilterRef.current : null;
                  console.log('[CSV Export] Payload:', payload, 'QuickFilter:', quickFilter);
                  await exportAllFilteredRowsAsCsv(api, endpoint, 'export.csv', payload, quickFilter);
                  console.log('[CSV Export] Export completed');
                }
              } catch (err) {
                console.error('[CSV Export] Export failed:', err);
                showToastMessage('Failed to export CSV', 'error');
              }
            },
          },
        ],
      };
    };

    const replaceExportItem = (
      items: Array<MenuItemDef<RowData> | DefaultMenuItem | string>,
    ): Array<MenuItemDef<RowData> | DefaultMenuItem | string> => {
      const customExportItem = createCustomExportMenuItem();
      return items.map((item) => {
        if (item === 'export') return customExportItem;
        if (typeof item === 'object' && item && typeof item.name === 'string') {
          const normalized = item.name.trim().toLowerCase();
          if (normalized === 'export') return customExportItem;
        }
        return item;
      });
    };

    const filterByItem = hasRowNode ? createFilterByMenuItem(params) : null;

    // If the caller returned custom leading items (MenuItemDef objects before the first separator),
    // place injected utilities (Filter By / Auto Size) after that separator instead of at position 0,
    // so page-specific actions stay on top.
    const firstSeparatorIdx = menuItems.findIndex((item) => item === 'separator');
    const leadingBlock = firstSeparatorIdx >= 0 ? menuItems.slice(0, firstSeparatorIdx) : menuItems;
    const hasLeadingCustomItems = leadingBlock.some((item) => typeof item === 'object' && item !== null);
    const topInsertIdx = hasLeadingCustomItems && firstSeparatorIdx >= 0 ? firstSeparatorIdx + 1 : 0;

    const isExportMenuItem = (
      item: MenuItemDef<RowData> | DefaultMenuItem | string,
    ): item is DefaultMenuItem | MenuItemDef<RowData> => {
      if (item === 'export') return true;
      if (typeof item === 'object' && item && typeof item.name === 'string') {
        return item.name.toLowerCase() === 'export';
      }
      return false;
    };

    if (!filterByItem) {
      if (autoSizeItems.length === 0) {
        return wrapActions(replaceExportItem(replaceDeleteItem(menuItems)));
      }
      const itemsWithAutoSize = [...menuItems];
      itemsWithAutoSize.splice(topInsertIdx, 0, ...autoSizeItems);
      return wrapActions(replaceExportItem(replaceDeleteItem(itemsWithAutoSize)));
    }

    const itemsWithFilter = [...menuItems];
    const exportIndex = itemsWithFilter.findIndex((item) => isExportMenuItem(item));
    const filterInsertIdx = exportIndex >= 0 ? exportIndex : topInsertIdx;
    itemsWithFilter.splice(filterInsertIdx, 0, filterByItem);

    if (autoSizeItems.length > 0) {
      const insertionIndex = itemsWithFilter.indexOf(filterByItem) + 1;
      const safeIndex = Math.max(0, Math.min(itemsWithFilter.length, insertionIndex));
      itemsWithFilter.splice(safeIndex, 0, ...autoSizeItems);
    }

    return wrapActions(replaceExportItem(replaceDeleteItem(itemsWithFilter)));
  }, [clearContextMenuRow, deleteSelectionValues, getContextMenuItems, resolveAutoSizeMenuItems, endpoint, allowQuickSearch, hasServerSideSelectAll]);

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

    const customDefaults =
      typeof getHeaderMenuItems === 'function'
        ? (getHeaderMenuItems(params) ?? params.defaultItems ?? [])
        : (params.defaultItems ?? []);
    const autoSizeItems = resolveAutoSizeMenuItems({ api, column });
    const items: Array<MenuItemDef<RowData> | DefaultMenuItem> = [...autoSizeItems, ...customDefaults];
    const targetIndex = items.findIndex(
      (item) => item === 'columnChooser' || item === 'resetColumns',
    );
    const insertionIndex = targetIndex >= 0 ? targetIndex : items.length;
    const extraItems = allowMove ? [moveLeftItem, moveRightItem, hideColumnItem] : [hideColumnItem];
    items.splice(insertionIndex, 0, ...extraItems);
    return items;
  }, [getHeaderMenuItems, resolveAutoSizeMenuItems]);

  const handleColumnRowGroupChanged = () => {
    // No automatic auto-size.
  };

  // GRID EVENT HANDLERS - Filter, Sort, Model Updates
  const handleFilterChanged = useCallback((event: FilterChangedEvent) => {
    // ALWAYS capture column widths before any filter operation (apply or remove)
    if (!filterStateRestoringRef.current) {
      const widthSnapshot = captureColumnWidths(event.api);
      pendingFilterWidthRestoreRef.current = widthSnapshot.length > 0 ? widthSnapshot : null;
    }

    const model = event.api.getFilterModel() as Record<string, FilterDescriptor> | null;

    // Track whether any user-meaningful filters are active (ignore Enabled/IsParent)
    const meaningfulKeys = model ? Object.keys(model).filter(k => !IGNORED_FILTER_COLS.has(k)) : [];
    setHasUserFilters(meaningfulKeys.length > 0);
    setActiveFilterCount(meaningfulKeys.length);

    if (!model) {
      // Persist empty filter model when filters are cleared (skip during restoration)
      if (!filterStateRestoringRef.current && filterStateStorageKey) {
        writePersistedFilterModel(filterStateStorageKey, null);
        gridUrlState.writeFilterModelToUrl(null);
      }
      if (!filterStateRestoringRef.current) {
        refreshServerSideData(event.api, { purge: true });
      }
      return;
    }
    if (Object.keys(model).length === 0) {
      // Normalize empty models to null so floating filters and SSRM stay in sync.
      event.api.setFilterModel(null);
      if (!filterStateRestoringRef.current && filterStateStorageKey) {
        writePersistedFilterModel(filterStateStorageKey, null);
        gridUrlState.writeFilterModelToUrl(null);
      }
      if (!filterStateRestoringRef.current) {
        refreshServerSideData(event.api, { purge: true });
      }
      return;
    }

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
      return;
    }

    // Persist filter model (skip during restoration)
    if (!filterStateRestoringRef.current && filterStateStorageKey) {
      const finalModel = mutated ? nextModel : model;
      const modelToSave = Object.keys(finalModel).length > 0 ? finalModel : null;
      writePersistedFilterModel(filterStateStorageKey, modelToSave);
      gridUrlState.writeFilterModelToUrl(modelToSave);
    }
    if (!filterStateRestoringRef.current) {
      refreshServerSideData(event.api, { purge: true });
    }
  }, [captureColumnWidths, filterStateStorageKey, gridUrlState]);

  const getViewportElement = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return null;
    return shell.querySelector<HTMLElement>('.ag-center-cols-viewport, .ag-body-viewport') ?? null;
  }, []);

  const handleSortChanged = useCallback((event: SortChangedEvent<RowData>) => {
    if (!firstDataRenderedRef.current) return;
    const source = (event as SortChangedEvent<RowData> & { source?: string }).source;
    if (source === 'api') return;
    if (sortStateRestoringRef.current) {
      pendingSortRefreshAfterRestoreRef.current = true;
      return;
    }
    // Keep rows visible for responsiveness while requesting the sorted data set from the server
    refreshServerSideData(event.api, { purge: false });

    // Persist sort model (skip during restoration)
    // Use getColumnState to get sort since getSortModel may not work with server-side row model
    if (!sortStateRestoringRef.current && sortStateStorageKey) {
      setTimeout(() => {
        if (sortStateRestoringRef.current) return; // Don't save if we're restoring
        const columnState = event.api.getColumnState();
        const sortModel: { colId: string; sort: 'asc' | 'desc' }[] = [];
        if (columnState && Array.isArray(columnState)) {
          columnState.forEach((col) => {
            if (col.sort && (col.sort === 'asc' || col.sort === 'desc') && col.colId) {
              sortModel.push({ colId: col.colId, sort: col.sort });
            }
          });
          // Sort by sortIndex to maintain order
          sortModel.sort((a, b) => {
            const aState = columnState.find((c) => c.colId === a.colId);
            const bState = columnState.find((c) => c.colId === b.colId);
            const aIndex = typeof aState?.sortIndex === 'number' ? aState.sortIndex : 999;
            const bIndex = typeof bState?.sortIndex === 'number' ? bState.sortIndex : 999;
            return aIndex - bIndex;
          });
        }
        const modelToSave = sortModel.length > 0 ? sortModel : null;
        writePersistedSortModel(sortStateStorageKey, modelToSave);
        gridUrlState.writeSortModelToUrl(modelToSave);
      }, 0);
    }
  }, [sortStateStorageKey, gridUrlState]);

  const handleModelUpdated = useCallback((event: ModelUpdatedEvent<RowData>) => {
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
    try {
      const count = event.api.getDisplayedRowCount?.();
      setDisplayedRowCount(typeof count === 'number' ? count : null);
    } catch {
      /* api not ready yet */
    }
    const pendingWidthSnapshot = pendingFilterWidthRestoreRef.current;
    if (pendingWidthSnapshot && pendingWidthSnapshot.length > 0) {
      pendingFilterWidthRestoreRef.current = null;
      const runRestore = () => {
        if (event.api.isDestroyed?.()) return;
        restoreColumnWidths(event.api, pendingWidthSnapshot);
        // Apply multiple times to ensure it sticks
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => {
            restoreColumnWidths(event.api, pendingWidthSnapshot);
            // One more time with delay
            setTimeout(() => restoreColumnWidths(event.api, pendingWidthSnapshot), 100);
          });
        } else {
          setTimeout(() => {
            restoreColumnWidths(event.api, pendingWidthSnapshot);
            setTimeout(() => restoreColumnWidths(event.api, pendingWidthSnapshot), 100);
          }, 0);
        }
      };
      if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(runRestore);
      } else {
        setTimeout(runRestore, 0);
      }
    }
    const restoreTop = pendingScrollRestoreTopRef.current;
    if (restoreTop != null) {
      const viewport = getViewportElement();
      if (viewport) {
        const restore = () => {
          viewport.scrollTop = restoreTop;
          // Only clear if the scroll actually stuck (viewport has enough content)
          if (viewport.scrollTop > 0 || restoreTop === 0) {
            pendingScrollRestoreTopRef.current = null;
          }
        };
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(restore);
        } else {
          setTimeout(restore, 0);
        }
      }
    }
  }, [
    getViewportElement,
    onModelUpdated,
    restoreColumnWidths,
    runQuickSearchFocus,
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
    return parts.length === 0 ? undefined : parts;
  }, [getRowClass]);

  useEffect(() => {
    if (!isGridReady || !shouldPersistColumnState) return;
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) return;
    if (!columnStateLoadedRef.current || !firstDataRenderedRef.current) return;
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
  }, [isGridReady, manualMode, shouldPersistColumnState]);

  // EFFECTS - Tree Ordering, Refresh Token, Lifecycle
  useEffect(() => {
    if (refreshToken === 0) return;
    const api = gridRef.current?.api;
    if (!api || api.isDestroyed?.()) {
      pendingExternalRefreshRef.current = refreshToken;
      return;
    }
    pendingExternalRefreshRef.current = null;
    requestCacheRef.current.clear();
    // Save scroll position before refresh so it's restored after data loads
    const viewport = getViewportElement();
    if (viewport) {
      pendingScrollRestoreTopRef.current = viewport.scrollTop;
    }
    requestRefresh(() => refreshServerSideData(api));
  }, [refreshToken, requestRefresh, getViewportElement]);

  // TREE ORDERING - Persistence & Server Reordering
  const persistTreeOrderingChanges = useCallback(() => {
    const runSave = async () => {
      const api = gridRef.current?.api;
      if (!api) return;
      const updates = collectTreeOrderingUpdates(api);
      if (updates.length === 0) return;
      const invalid = updates.filter((entry) => normalizeTreeOrderingValue(entry.TreeOrdering) == null);
      if (invalid.length > 0) {
        invalid.forEach((entry) => {
          const rowId = String(entry.OfferDetailID);
          invalidCellKeysRef.current.add(makeInvalidCellKey(rowId, 'TreeOrdering'));
        });
        requestRefresh(() => api.refreshCells({ columns: ['TreeOrdering'], force: true }));
        showToastMessage('Item No is required. Please fill the missing cells highlighted in red.', 'error');
        return;
      }
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
        try {
          api.forEachNode((node) => {
            const rowId = node?.id ? String(node.id) : null;
            if (!rowId) return;
            const currentOrdering = normalizeTreeOrderingValue((node.data as { TreeOrdering?: unknown } | null | undefined)?.TreeOrdering ?? null);
            const key = makeInvalidCellKey(rowId, 'TreeOrdering');
            if (currentOrdering == null) {
              invalidCellKeysRef.current.add(key);
            } else {
              invalidCellKeysRef.current.delete(key);
            }
          });
          requestRefresh(() => api.refreshCells({ columns: ['TreeOrdering'], force: true }));
        } catch {
          /* noop */
        }
        refreshServerSideData(api, { purge: false });
        throw err;
      }
    };
    const chained = saveQueueRef.current.then(() => runSave());
    saveQueueRef.current = chained.catch(() => {});
    return chained;
  }, [endpoint, makeInvalidCellKey, requestRefresh]);

  type ReorderContext = {
    sourceId?: string | null;
    sourceIds?: string[];
    parentPath: string[];
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

  // ROW DRAG & DROP - Drop Indicator & Drag Handlers
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
  }, [resolveDropIndicator, setDropIndicator, useAgGridRowDrag]);

  const handleRowDragEnter = useCallback((event: RowDragEnterEvent<RowData>) => {
    if (!useAgGridRowDrag) return;
    clearDropIndicator();
    lastDragNodeRef.current = event.node ?? lastDragNodeRef.current;
  }, [clearDropIndicator, useAgGridRowDrag]);

  const handleRowDragLeave = useCallback(() => {
    clearDropIndicator();
  }, [clearDropIndicator]);

  // GRID EVENT HANDLERS - Row & Cell Value Changes
  const handleRowDoubleClick = useCallback((event: RowDoubleClickedEvent<RowData>) => {
    if (typeof externalRowDoubleClickHandler === 'function') {
      externalRowDoubleClickHandler(event);
    }
  }, [externalRowDoubleClickHandler]);

  const handleCellValueChanged = useCallback((event: CellValueChangedEvent<RowData>) => {
    if (manualMode && event.colDef.field === 'TreeOrdering') {
      const rowId = event.node?.id ? String(event.node.id) : null;
      const normalized = normalizeTreeOrderingValue(event.newValue ?? null);
      if (rowId) {
        const key = makeInvalidCellKey(rowId, 'TreeOrdering');
        if (normalized == null) {
          invalidCellKeysRef.current.add(key);
          requestRefresh(() => event.api.refreshCells({ rowNodes: [event.node], columns: ['TreeOrdering'], force: true }));
          showToastMessage('Item No is required.', 'error');
          return;
        }
        invalidCellKeysRef.current.delete(key);
      }
      event.api.applyColumnState({
        state: [{ colId: 'TreeOrdering', sort: 'asc', sortIndex: 0 }],
        defaultState: { sort: null },
        applyOrder: false,
      });
      reorderRowsByTreeOrdering(event.api);
      requestRefresh(() => event.api.refreshCells({ columns: TREE_DEPENDENT_COLUMNS, force: true }));
      void persistTreeOrderingChanges();
    }
    if (typeof externalCellValueChangeHandler === 'function') {
      externalCellValueChangeHandler(event);
    }
  }, [externalCellValueChangeHandler, makeInvalidCellKey, manualMode, persistTreeOrderingChanges, requestRefresh]);

  const handleSelectionChanged = useCallback((event: SelectionChangedEvent<RowData>) => {
    if (typeof externalSelectionChangedHandler !== 'function') return;
    const api = event.api;
    if (!api) {
      externalSelectionChangedHandler([], api);
      return;
    }
    
    let rows: RowData[] = [];
    let selectedNodes: Array<RowNode<RowData>> = [];
    
    try {
      const collectedNodes: Array<IRowNode<RowData>> = [];
      if (typeof api.forEachNode === 'function') {
        api.forEachNode((node) => {
          if (node.isSelected()) {
            collectedNodes.push(node);
          }
        });
      }
      
      const directNodes = typeof api.getSelectedNodes === 'function'
        ? (api.getSelectedNodes() as Array<RowNode<RowData>>)
        : [];
      
      if (collectedNodes.length >= directNodes.length) {
        selectedNodes = collectedNodes as Array<RowNode<RowData>>;
      } else {
        selectedNodes = directNodes;
      }
      
      rows = selectedNodes
        .map((node) => node.data)
        .filter((data): data is RowData => data != null);
      
      if (rows.length === 0) {
        const fallbackRows = typeof api.getSelectedRows === 'function' ? api.getSelectedRows() : [];
        if (fallbackRows.length > 0) {
          rows = fallbackRows;
        }
      }
    } catch (err) {
      console.warn('Failed to read selected rows/nodes', err);
      rows = [];
      selectedNodes = [];
    }
    
    externalSelectionChangedHandler(rows ?? [], api);
    setGridRowDeletionContextMenuSelectionSnapshot(api ?? null, selectedNodes ?? []);
  }, [externalSelectionChangedHandler]);

  const handleCellEditingStarted = useCallback(
    (event: CellEditingStartedEvent<RowData>) => {
      handleEditingStart(event);
      if (typeof externalCellEditingStartedHandler === 'function') {
        externalCellEditingStartedHandler(event);
      }
    },
    [externalCellEditingStartedHandler, handleEditingStart],
  );

  const handleCellEditingStopped = useCallback(
    (event: CellEditingStoppedEvent<RowData>) => {
      handleEditingStop();
      if (typeof externalCellEditingStoppedHandler === 'function') {
        externalCellEditingStoppedHandler(event);
      }
    },
    [externalCellEditingStoppedHandler, handleEditingStop],
  );

  const handleRowDragEnd = useCallback((event: RowDragEndEvent<RowData>) => {
    lastDragNodeRef.current = null;
    clearDropIndicator();
    clearDragGhostDom();
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

  // EFFECTS - Row Drag, Context Menu Cleanup, API Refresh Wrapping
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

  // CLIPBOARD - Write HTML to clipboard so hyperlinks survive paste into Excel
  const sendToClipboard = useCallback((params: { data: string }) => {
    const api = gridRef.current?.api ?? null;
    if (!api) {
      navigator.clipboard?.writeText(params.data).catch(() => { /* noop */ });
      return;
    }

    const cellRanges = api.getCellRanges?.();
    if (!cellRanges || cellRanges.length === 0) {
      navigator.clipboard?.writeText(params.data).catch(() => { /* noop */ });
      return;
    }

    // Build HTML table from cell range data, embedding <a> tags for hyperlinked cells
    let hasLinks = false;
    const htmlRows: string[] = [];

    const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    cellRanges.forEach(range => {
      const columns: Column[] = (range as { columns?: Column[] }).columns ?? [];
      const startIdx = Math.min(
        (range as { startRow?: { rowIndex: number } }).startRow?.rowIndex ?? 0,
        (range as { endRow?: { rowIndex: number } }).endRow?.rowIndex ?? 0,
      );
      const endIdx = Math.max(
        (range as { startRow?: { rowIndex: number } }).startRow?.rowIndex ?? 0,
        (range as { endRow?: { rowIndex: number } }).endRow?.rowIndex ?? 0,
      );

      for (let rowIdx = startIdx; rowIdx <= endIdx; rowIdx++) {
        const rowNode = api.getDisplayedRowAtIndex(rowIdx);
        if (!rowNode?.data) continue;
        const rowData = rowNode.data as Record<string, unknown>;

        const cells = columns.map(col => {
          const colDef = col.getColDef();
          const field = colDef.field ?? col.getColId();
          const rawValue = rowData[field];
          const displayValue = rawValue != null ? String(rawValue) : '';

          // Check for hyperlink
          let link = '';
          if (field === 'PartNumber' || field === 'ModelNumber') {
            const webLink = typeof rowData.WebLink === 'string' ? rowData.WebLink.trim() : '';
            if (webLink) {
              if (field === 'PartNumber') {
                link = webLink;
              } else {
                const pn = typeof rowData.PartNumber === 'string' ? rowData.PartNumber.trim() : '';
                if (!pn) link = webLink;
              }
            }
          } else if (field === 'RequestedPartNo' || field === 'RequestedModelNo') {
            const webLink = typeof rowData.RequestedWebLink === 'string' ? (rowData.RequestedWebLink as string).trim() : '';
            if (webLink) {
              if (field === 'RequestedPartNo') {
                link = webLink;
              } else {
                const pn = typeof rowData.RequestedPartNo === 'string' ? (rowData.RequestedPartNo as string).trim() : '';
                if (!pn) link = webLink;
              }
            }
          }

          if (link) {
            hasLinks = true;
            return `<td><a href="${escHtml(link)}">${escHtml(displayValue)}</a></td>`;
          }
          return `<td>${escHtml(displayValue)}</td>`;
        });

        htmlRows.push(`<tr>${cells.join('')}</tr>`);
      }
    });

    const writeTextFallback = (text: string) => {
      // Async Clipboard API – works when the page has focus & permissions
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).catch(() => {
          // Fallback: use a hidden textarea + execCommand for cross-browser support
          try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
          } catch { /* last resort – nothing we can do */ }
        });
      } else {
        try {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
        } catch { /* noop */ }
      }
    };

    if (hasLinks && typeof navigator?.clipboard?.write === 'function') {
      const html = `<table>${htmlRows.join('')}</table>`;
      navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([params.data], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' }),
        }),
      ]).catch(() => {
        writeTextFallback(params.data);
      });
    } else {
      writeTextFallback(params.data);
    }
  }, []);

  const handleClearUserFilters = useCallback(() => {
    const api = gridApiRef.current ?? gridRef.current?.api ?? null;
    if (!api || api.isDestroyed?.()) return;
    const current = (api.getFilterModel() as Record<string, unknown> | null) ?? {};
    const next: Record<string, unknown> = {};
    Object.entries(current).forEach(([key, value]) => {
      if (IGNORED_FILTER_COLS.has(key)) next[key] = value;
    });
    api.setFilterModel(Object.keys(next).length > 0 ? next : null);
  }, []);

  // RENDER - AgGridReact Component with All Props
  return (
    <div className={styles.container}>
      <ActiveFiltersIndicator
        activeFilterCount={activeFilterCount}
        displayedRowCount={displayedRowCount}
        onClear={handleClearUserFilters}
      />
      <div
        className={`ag-theme-quartz ${styles.gridShell}`}
        data-ag-grid-size="compact"
        data-suppress-sidebar={suppressSideBar}
        ref={shellRef}
      >
        {gridEmpty && isGridReady && hasLoadedOnce && !blockZeroLoading && !suppressNoRowsOverlay && (
          <div className={styles.noRowsOverlay}>No data to display</div>
        )}
        <AgGridReact
          gridOptions={sharedGridOptions}
          ref={gridRef}
          columnDefs={resolvedColumnDefs}
          defaultColDef={dcd}
          autoGroupColumnDef={autoGroupColumnDef}
          getRowId={getRowId}
          getRowClass={mergedGetRowClass}
          getRowStyle={getRowStyle}
          isExternalFilterPresent={isExternalFilterPresent}
          doesExternalFilterPass={doesExternalFilterPass}
          getMainMenuItems={headerMenuItemsHandler}
          getContextMenuItems={contextMenuItemsHandler}
          suppressContextMenu={suppressContextMenu}
          onFirstDataRendered={handleFirstDataRendered}
          onCellContextMenu={handleCellContextMenu}
          onCellMouseDown={handleCellMouseDown}
          rowHeight={32}
          headerHeight={38}
          rowSelection={rowSelectionConfig}
          selectionColumnDef={rowSelection === 'multiple' ? { width: 42, minWidth: 42, maxWidth: 42, pinned: 'left', lockPosition: true, suppressMovable: true, suppressHeaderMenuButton: true, resizable: false, suppressSizeToFit: true } : undefined}

          // Server-Side model
          rowModelType="serverSide"
          serverSideEnableClientSideSort={serverSideEnableClientSideSort}

          // No selection needed for handle-only drag
          // rowSelection removed to avoid SSRM warning

          // Enterprise UX
          sideBar={sideBarDef}
          statusBar={{ statusPanels: [{ statusPanel: 'agAggregationComponent' }] }}
          suppressCellFocus={!cellSelectionEnabled}
          cellSelection={cellSelectionConfig}

          // Charts OFF for now (to avoid the AgCharts module requirement)
          enableCharts={false}

          // Grouping flags are fine; without a license they’re ignored, not crashed
          rowGroupPanelShow={rowGroupPanelShow}
          getRowHeight={getRowHeight}
      suppressColumnVirtualisation={suppressColumnVirtualisation}
      suppressMovableColumns={suppressMovableColumns}
      localeText={{ resetFilter: 'Clear' }}

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
          suppressLastEmptyLineOnPaste
          sendToClipboard={sendToClipboard}
          onPasteStart={handlePasteStart}
          onPasteEnd={handlePasteEnd}
          onCellValueChanged={handleCellValueChanged}
          onSelectionChanged={handleSelectionChanged}
          onCellEditingStarted={handleCellEditingStarted}
          onCellEditingStopped={handleCellEditingStopped}
          onColumnMoved={shouldAutoPersistColumnState ? queuePersistColumnState : undefined}
          onColumnPinned={shouldAutoPersistColumnState ? queuePersistColumnState : undefined}
          onColumnVisible={handleColumnVisibleWithReorder}
          onColumnResized={handleColumnResized}
          onColumnRowGroupChanged={handleColumnRowGroupChanged}
          onColumnPivotModeChanged={handleColumnPivotModeChanged}
          suppressColumnMoveAnimation={suppressColumnMoveAnimation}
        />
      </div>
    </div>
  );
}
