import type { GridApi } from 'ag-grid-community';
import * as XLSX from 'xlsx';

/**
 * Export modes based on user selection state
 */
export type ExportMode = 'all' | 'selected-rows' | 'selected-cells';

/**
 * Detect the current export mode based on grid selection state
 */
export function detectExportMode<RowData>(api: GridApi<RowData> | null): ExportMode {
  if (!api) return 'all';

  // PRIORITY 1: Check for row selection (via checkboxes)
  // This takes precedence over cell ranges
  const selectedNodes = api.getSelectedNodes?.();
  if (selectedNodes && selectedNodes.length > 0) {
    console.log('[detectExportMode] Detected selected-rows mode, count:', selectedNodes.length);
    return 'selected-rows';
  }

  // PRIORITY 2: Check for meaningful cell range selection (user dragged to select cells)
  // AG Grid always has a cell range for the focused cell, so we need to check if it's a real selection
  const cellRanges = api.getCellRanges?.();
  if (cellRanges && cellRanges.length > 0) {
    // Check if any range covers more than one cell
    const hasMultiCellRange = cellRanges.some(range => {
      const columns = range.columns;
      const startRow = range.startRow;
      const endRow = range.endRow;

      // Check if range spans multiple columns OR multiple rows
      const multipleColumns = columns && columns.length > 1;
      const multipleRows = startRow && endRow && startRow.rowIndex !== endRow.rowIndex;

      return multipleColumns || multipleRows;
    });

    if (hasMultiCellRange) {
      console.log('[detectExportMode] Detected selected-cells mode, ranges:', cellRanges.length);
      return 'selected-cells';
    }
  }

  // PRIORITY 3: Default to exporting all filtered rows
  console.log('[detectExportMode] Detected all mode (no meaningful selection)');
  return 'all';
}

/**
 * Get all row data from server with current filters applied
 */
export async function fetchAllFilteredRows<RowData>(
  api: GridApi<RowData> | null,
  endpoint: string,
  requestPayload?: Record<string, unknown>,
  quickFilterText?: string | null,
): Promise<RowData[]> {
  if (!api) {
    console.warn('[fetchAllFilteredRows] No API provided');
    return [];
  }

  console.log('[fetchAllFilteredRows] Starting fetch', { endpoint });

  try {
    // Get current filter model
    const filterModel = api.getFilterModel?.() ?? {};
    console.log('[fetchAllFilteredRows] Filter model:', filterModel);

    // Get current sort model
    const sortModel = api.getColumnState?.()
      ?.filter(col => col.sort != null)
      .map(col => ({
        colId: col.colId,
        sort: col.sort,
      })) ?? [];
    console.log('[fetchAllFilteredRows] Sort model:', sortModel);

    // Get visible fields
    const visibleFields = api.getAllDisplayedColumns?.()
      ?.map((column) => column.getColDef()?.field)
      .filter((field): field is string => typeof field === 'string' && field.length > 0) ?? [];
    console.log('[fetchAllFilteredRows] Visible fields:', visibleFields.length);

    const MAX_ROWS = 5000; // Maximum rows to fetch
    const BATCH_SIZE = 1000; // Rows per request (server limit)
    const allRows: RowData[] = [];
    let currentRow = 0;

    // Fetch data in batches until we reach MAX_ROWS or get all data
    while (currentRow < MAX_ROWS) {
      // Build request similar to AG Grid's server-side datasource
      const serverRequest: Record<string, unknown> = {
        filterModel,
        sortModel,
        startRow: currentRow,
        endRow: Math.min(currentRow + BATCH_SIZE, MAX_ROWS),
        groupKeys: [],
        rowGroupCols: [],
        valueCols: [],
        pivotCols: [],
        pivotMode: false,
      };

      // Add quick filter text if present
      if (typeof quickFilterText === 'string' && quickFilterText.length > 0) {
        serverRequest.quickFilterText = quickFilterText;
      }

      // Match the format used in AgGridAll datasource
      const bodyRequest = {
        ...(requestPayload ?? {}),
        request: serverRequest,
        fields: visibleFields,
      };

      console.log(`[fetchAllFilteredRows] Fetching batch: rows ${currentRow}-${currentRow + BATCH_SIZE}`);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyRequest),
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch data: ${response.status}`);
      }

      const data = await response.json() as { rows?: RowData[]; data?: RowData[]; rowCount?: number };
      const batchRows = data.rows ?? data.data ?? [];

      console.log(`[fetchAllFilteredRows] Batch received: ${batchRows.length} rows, total rowCount: ${data.rowCount}`);

      if (batchRows.length === 0) {
        // No more data available
        break;
      }

      allRows.push(...batchRows);
      currentRow += batchRows.length;

      // Check if we've reached the end of available data
      if (data.rowCount && currentRow >= data.rowCount) {
        console.log('[fetchAllFilteredRows] Reached end of available data');
        break;
      }

      // Check if this batch was smaller than expected (indicates end of data)
      if (batchRows.length < BATCH_SIZE) {
        console.log('[fetchAllFilteredRows] Received partial batch, assuming end of data');
        break;
      }
    }

    console.log('[fetchAllFilteredRows] Total rows fetched:', allRows.length);
    return allRows;
  } catch (err) {
    console.error('[fetchAllFilteredRows] Failed to fetch all filtered rows for export:', err);
    throw err;
  }
}

/**
 * Export data as CSV with all filtered rows
 */
export async function exportAllFilteredRowsAsCsv<RowData>(
  api: GridApi<RowData> | null,
  endpoint: string,
  fileName?: string,
  requestPayload?: Record<string, unknown>,
  quickFilterText?: string | null,
): Promise<void> {
  if (!api) {
    console.warn('[exportAllFilteredRowsAsCsv] No API provided');
    return;
  }

  console.log('[exportAllFilteredRowsAsCsv] Starting export', { endpoint, fileName, requestPayload, quickFilterText });

  try {
    const allRows = await fetchAllFilteredRows(api, endpoint, requestPayload, quickFilterText);
    console.log('[exportAllFilteredRowsAsCsv] Fetched rows:', allRows.length);

    const csv = generateCsvFromRows(api, allRows);
    console.log('[exportAllFilteredRowsAsCsv] Generated CSV, length:', csv.length);

    downloadCsv(csv, fileName ?? 'export.csv');
    console.log('[exportAllFilteredRowsAsCsv] Download initiated');
  } catch (err) {
    console.error('[exportAllFilteredRowsAsCsv] Failed to export all filtered rows:', err);
    throw err;
  }
}

/**
 * Generate CSV content from rows
 */
function generateCsvFromRows<RowData>(
  api: GridApi<RowData>,
  rows: RowData[],
): string {
  // Get visible columns
  const columns = api.getAllDisplayedColumns?.() ?? [];

  console.log('[generateCsvFromRows] Generating CSV for', rows.length, 'rows and', columns.length, 'columns');

  // Generate header row
  const headers = columns.map(col => {
    const headerName = col.getColDef().headerName ?? col.getColId();
    return escapeCsvValue(headerName);
  });

  // Generate data rows
  const dataRows = rows.map(row => {
    return columns.map(col => {
      const colDef = col.getColDef();
      // Use field name from column definition, fallback to colId
      const field = colDef.field ?? col.getColId();
      const value = (row as Record<string, unknown>)[field];
      return escapeCsvValue(formatCellValue(value));
    });
  });

  // Combine into CSV string
  const allRows = [headers, ...dataRows];
  const csv = allRows.map(row => row.join(',')).join('\n');

  console.log('[generateCsvFromRows] Generated CSV with', allRows.length, 'rows (including header)');

  return csv;
}

/**
 * Escape CSV value
 */
function escapeCsvValue(value: string): string {
  if (value == null) return '';
  const stringValue = String(value);

  // If contains comma, quote, or newline, wrap in quotes and escape quotes
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Format cell value for CSV
 */
function formatCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/**
 * Download CSV content as file
 */
function downloadCsv(content: string, fileName: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', fileName);
  link.style.visibility = 'hidden';

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

/**
 * Generate Excel file from rows
 */
function generateExcelFromRows<RowData>(
  api: GridApi<RowData>,
  rows: RowData[],
): ArrayBuffer {
  // Get visible columns
  const columns = api.getAllDisplayedColumns?.() ?? [];

  console.log('[generateExcelFromRows] Generating Excel for', rows.length, 'rows and', columns.length, 'columns');

  // Create worksheet data
  const wsData: unknown[][] = [];

  // Add header row
  const headers = columns.map(col => {
    const colDef = col.getColDef();
    return colDef.headerName ?? col.getColId();
  });
  wsData.push(headers);

  // Add data rows
  rows.forEach(row => {
    const rowData = columns.map(col => {
      const colDef = col.getColDef();
      const field = colDef.field ?? col.getColId();
      const value = (row as Record<string, unknown>)[field];
      return formatExcelValue(value);
    });
    wsData.push(rowData);
  });

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Auto-size columns
  const colWidths = headers.map((header, i) => {
    const headerLen = String(header).length;
    const maxDataLen = Math.max(
      ...wsData.slice(1).map(row => String(row[i] ?? '').length).slice(0, 100), // Sample first 100 rows
    );
    return { wch: Math.min(Math.max(headerLen, maxDataLen) + 2, 50) };
  });
  ws['!cols'] = colWidths;

  XLSX.utils.book_append_sheet(wb, ws, 'Export');

  // Generate Excel file
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

  console.log('[generateExcelFromRows] Generated Excel file');

  return wbout;
}

/**
 * Format value for Excel export
 */
function formatExcelValue(value: unknown): string | number | boolean | Date {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value;
  return String(value);
}

/**
 * Download Excel file
 */
function downloadExcel(buffer: ArrayBuffer, fileName: string): void {
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', fileName);
  link.style.visibility = 'hidden';

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

/**
 * Export selected rows as CSV
 */
export function exportSelectedRowsAsCsv<RowData>(
  api: GridApi<RowData> | null,
  fileName?: string,
): void {
  if (!api) {
    console.warn('[exportSelectedRowsAsCsv] No API provided');
    return;
  }

  console.log('[exportSelectedRowsAsCsv] Starting selected rows export');

  const selectedNodes = api.getSelectedNodes?.();
  console.log('[exportSelectedRowsAsCsv] Selected nodes:', selectedNodes?.length);

  api.exportDataAsCsv?.({
    fileName: fileName ?? 'export.csv',
    onlySelected: true,
  });

  console.log('[exportSelectedRowsAsCsv] Export initiated');
}

/**
 * Export selected cells as CSV
 */
export function exportSelectedCellsAsCsv<RowData>(
  api: GridApi<RowData> | null,
  fileName?: string,
): void {
  if (!api) {
    console.warn('[exportSelectedCellsAsCsv] No API provided');
    return;
  }

  console.log('[exportSelectedCellsAsCsv] Starting cell range export');

  // Get cell ranges
  const cellRanges = api.getCellRanges?.();
  console.log('[exportSelectedCellsAsCsv] Cell ranges:', cellRanges?.length);

  if (!cellRanges || cellRanges.length === 0) {
    console.warn('[exportSelectedCellsAsCsv] No cell ranges found');
    return;
  }

  // For Server-Side Row Model, we need to manually extract cell range data
  // because AG Grid's built-in export doesn't work well with SSRM
  try {
    const csv = generateCsvFromCellRanges(api, cellRanges);
    downloadCsv(csv, fileName ?? 'export.csv');
    console.log('[exportSelectedCellsAsCsv] Export completed');
  } catch (err) {
    console.error('[exportSelectedCellsAsCsv] Failed to export cell ranges:', err);
    // Fallback to AG Grid's built-in export
    api.exportDataAsCsv?.({
      fileName: fileName ?? 'export.csv',
    });
  }
}

/**
 * Generate CSV from selected cell ranges
 */
function generateCsvFromCellRanges<RowData>(
  api: GridApi<RowData>,
  cellRanges: unknown[],
): string {
  const rows: string[][] = [];

  // Process each cell range
  cellRanges.forEach((range: unknown) => {
    const rangeObj = range as { columns?: unknown[]; startRow?: { rowIndex: number }; endRow?: { rowIndex: number } };
    const columns = rangeObj.columns || [];
    const startRow = rangeObj.startRow;
    const endRow = rangeObj.endRow;

    if (!startRow || !endRow) return;

    const startIndex = Math.min(startRow.rowIndex, endRow.rowIndex);
    const endIndex = Math.max(startRow.rowIndex, endRow.rowIndex);

    console.log(`[generateCsvFromCellRanges] Processing range: rows ${startIndex}-${endIndex}, columns:`, columns.length);

    // Add header row (only once)
    if (rows.length === 0) {
      const headers = columns.map((col: unknown) => {
        const colObj = col as { getColDef?: () => { headerName?: string }; getColId: () => string };
        const colDef = colObj.getColDef?.() ?? {};
        return escapeCsvValue(colDef.headerName ?? colObj.getColId());
      });
      rows.push(headers);
    }

    // Iterate through rows in the range
    for (let rowIndex = startIndex; rowIndex <= endIndex; rowIndex++) {
      const rowNode = api.getDisplayedRowAtIndex?.(rowIndex);
      if (!rowNode || !rowNode.data) continue;

      const rowData = rowNode.data;
      const rowValues = columns.map((col: unknown) => {
        const colObj = col as { getColDef?: () => { field?: string }; getColId: () => string };
        const colDef = colObj.getColDef?.() ?? {};
        const field = colDef.field ?? colObj.getColId();
        const value = (rowData as Record<string, unknown>)[field];
        return escapeCsvValue(formatCellValue(value));
      });

      rows.push(rowValues);
    }
  });

  const csv = rows.map(row => row.join(',')).join('\n');
  console.log('[generateCsvFromCellRanges] Generated CSV with', rows.length, 'rows (including header)');
  return csv;
}

/**
 * Export all filtered rows as Excel
 */
export async function exportAllFilteredRowsAsExcel<RowData>(
  api: GridApi<RowData> | null,
  endpoint: string,
  fileName?: string,
  requestPayload?: Record<string, unknown>,
  quickFilterText?: string | null,
): Promise<void> {
  if (!api) {
    console.warn('[exportAllFilteredRowsAsExcel] No API provided');
    return;
  }

  console.log('[exportAllFilteredRowsAsExcel] Starting export', { endpoint, fileName });

  try {
    const allRows = await fetchAllFilteredRows(api, endpoint, requestPayload, quickFilterText);
    console.log('[exportAllFilteredRowsAsExcel] Fetched rows:', allRows.length);

    const excelBuffer = generateExcelFromRows(api, allRows);
    console.log('[exportAllFilteredRowsAsExcel] Generated Excel file');

    const excelFileName = fileName ?? 'export.xlsx';
    downloadExcel(excelBuffer, excelFileName);
    console.log('[exportAllFilteredRowsAsExcel] Download initiated:', excelFileName);
  } catch (err) {
    console.error('[exportAllFilteredRowsAsExcel] Failed to export all filtered rows as Excel:', err);
    throw err;
  }
}

/**
 * Export selected rows as Excel
 */
export function exportSelectedRowsAsExcel<RowData>(
  api: GridApi<RowData> | null,
  fileName?: string,
): void {
  if (!api) {
    console.warn('[exportSelectedRowsAsExcel] No API provided');
    return;
  }

  console.log('[exportSelectedRowsAsExcel] Starting selected rows export');

  api.exportDataAsExcel?.({
    fileName: fileName ?? 'export.xlsx',
    onlySelected: true,
  });

  console.log('[exportSelectedRowsAsExcel] Export initiated');
}

/**
 * Export selected cells as Excel
 */
export function exportSelectedCellsAsExcel<RowData>(
  api: GridApi<RowData> | null,
  fileName?: string,
): void {
  if (!api) {
    console.warn('[exportSelectedCellsAsExcel] No API provided');
    return;
  }

  console.log('[exportSelectedCellsAsExcel] Starting cell range export');

  const cellRanges = api.getCellRanges?.();
  console.log('[exportSelectedCellsAsExcel] Cell ranges:', cellRanges?.length);

  if (!cellRanges || cellRanges.length === 0) {
    console.warn('[exportSelectedCellsAsExcel] No cell ranges found');
    return;
  }

  // For Server-Side Row Model, generate Excel from cell ranges
  try {
    const excelBuffer = generateExcelFromCellRanges(api, cellRanges);
    const excelFileName = fileName ?? 'export.xlsx';
    downloadExcel(excelBuffer, excelFileName);
    console.log('[exportSelectedCellsAsExcel] Export completed:', excelFileName);
  } catch (err) {
    console.error('[exportSelectedCellsAsExcel] Failed to export cell ranges:', err);
    // Fallback to AG Grid's built-in export
    api.exportDataAsExcel?.({
      fileName: fileName ?? 'export.xlsx',
    });
  }
}

/**
 * Generate Excel file from selected cell ranges
 */
function generateExcelFromCellRanges<RowData>(
  api: GridApi<RowData>,
  cellRanges: unknown[],
): ArrayBuffer {
  const wsData: unknown[][] = [];

  // Process each cell range
  cellRanges.forEach((range: unknown) => {
    const rangeObj = range as { columns?: unknown[]; startRow?: { rowIndex: number }; endRow?: { rowIndex: number } };
    const columns = rangeObj.columns || [];
    const startRow = rangeObj.startRow;
    const endRow = rangeObj.endRow;

    if (!startRow || !endRow) return;

    const startIndex = Math.min(startRow.rowIndex, endRow.rowIndex);
    const endIndex = Math.max(startRow.rowIndex, endRow.rowIndex);

    console.log(`[generateExcelFromCellRanges] Processing range: rows ${startIndex}-${endIndex}, columns:`, columns.length);

    // Add header row (only once)
    if (wsData.length === 0) {
      const headers = columns.map((col: unknown) => {
        const colObj = col as { getColDef?: () => { headerName?: string }; getColId: () => string };
        const colDef = colObj.getColDef?.() ?? {};
        return colDef.headerName ?? colObj.getColId();
      });
      wsData.push(headers);
    }

    // Iterate through rows in the range
    for (let rowIndex = startIndex; rowIndex <= endIndex; rowIndex++) {
      const rowNode = api.getDisplayedRowAtIndex?.(rowIndex);
      if (!rowNode || !rowNode.data) continue;

      const rowData = rowNode.data;
      const rowValues = columns.map((col: unknown) => {
        const colObj = col as { getColDef?: () => { field?: string }; getColId: () => string };
        const colDef = colObj.getColDef?.() ?? {};
        const field = colDef.field ?? colObj.getColId();
        const value = (rowData as Record<string, unknown>)[field];
        return formatExcelValue(value);
      });

      wsData.push(rowValues);
    }
  });

  // Create workbook and worksheet
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // Auto-size columns
  if (wsData.length > 0) {
    const headers = wsData[0] as unknown[];
    const colWidths = headers.map((header, i) => {
      const headerLen = String(header).length;
      const maxDataLen = Math.max(
        ...wsData.slice(1).map(row => String(row[i] ?? '').length),
      );
      return { wch: Math.min(Math.max(headerLen, maxDataLen) + 2, 50) };
    });
    ws['!cols'] = colWidths;
  }

  XLSX.utils.book_append_sheet(wb, ws, 'Export');

  // Generate Excel file
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

  console.log('[generateExcelFromCellRanges] Generated Excel file with', wsData.length, 'rows (including header)');

  return wbout;
}
