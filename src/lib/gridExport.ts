import type { GridApi, Column } from 'ag-grid-community';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

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
 * Check if a column is a utility column (drag handle, selection, etc.) that should be excluded from export
 */
function isUtilityColumn(col: Column): boolean {
  const colDef = col.getColDef();
  // Skip columns without a data field — these are drag handles, selection checkboxes, etc.
  if (!colDef.field || colDef.field.trim() === '') return true;
  return false;
}

/**
 * Detect an Excel number format for a cell by calling the column's valueFormatter.
 * Returns a format code like '#,##0.00" €"' or null if no format detected.
 */
function detectCellNumberFormat(
  formatter: unknown,
  value: unknown,
  rowData: unknown,
): string | null {
  if (!formatter || typeof formatter !== 'function') return null;
  if (value == null || value === '' || value === 0) return null;

  try {
    const formatted = (formatter as (params: Record<string, unknown>) => string)({ value, data: rowData });
    if (typeof formatted !== 'string' || formatted.length === 0) return null;

    if (formatted.includes('€')) return '#,##0.00" €"';
    if (formatted.includes('%')) return '#,##0.00" %"';

    // Extract currency/unit prefix before the number: "$ 1,234.56" → "$"
    const prefixMatch = formatted.match(/^([^\d.,\s][^\d.,]*?)\s*[\d.,]/);
    if (prefixMatch) {
      const prefix = prefixMatch[1].trim();
      if (prefix.length > 0 && prefix.length <= 5) {
        return `"${prefix} "#,##0.00`;
      }
    }

    // Extract currency/unit suffix after a space: "1,234.56 USD" → "USD"
    // Requires whitespace between the number and suffix to avoid false matches like "0.9" → "9"
    const suffixMatch = formatted.match(/\d\s+(.+)$/);
    if (suffixMatch) {
      const suffix = suffixMatch[1].trim();
      if (suffix.length > 0 && suffix.length <= 5 && !/^[\d.,]+$/.test(suffix)) {
        return `#,##0.00" ${suffix}"`;
      }
    }
  } catch { /* noop */ }

  return null;
}

/**
 * Resolve the hyperlink URL for a cell, or return '' if none applies.
 * Handles: PartNumber → WebLink, ModelNumber → WebLink (only when PartNumber absent),
 *          RequestedPartNo → RequestedWebLink, RequestedModelNo → RequestedWebLink (only when RequestedPartNo absent)
 */
function resolveHyperlinkUrl(
  field: string,
  rowData: Record<string, unknown>,
): string {
  if (field === 'PartNumber' || field === 'ModelNumber') {
    const webLink = typeof rowData.WebLink === 'string' ? rowData.WebLink.trim() : '';
    if (!webLink) return '';
    if (field === 'PartNumber') return webLink;
    // ModelNumber only gets the link when PartNumber is empty
    const partNumber = typeof rowData.PartNumber === 'string' ? rowData.PartNumber.trim() : '';
    return partNumber ? '' : webLink;
  }
  if (field === 'RequestedPartNo' || field === 'RequestedModelNo') {
    const webLink = typeof rowData.RequestedWebLink === 'string' ? (rowData.RequestedWebLink as string).trim() : '';
    if (!webLink) return '';
    if (field === 'RequestedPartNo') return webLink;
    const partNo = typeof rowData.RequestedPartNo === 'string' ? (rowData.RequestedPartNo as string).trim() : '';
    return partNo ? '' : webLink;
  }
  return '';
}

/**
 * Build a single Excel cell object with value, number format, and optional hyperlink.
 */
function buildExcelCell(
  value: unknown,
  field: string,
  formatter: unknown,
  rowData: Record<string, unknown>,
): XLSX.CellObject {
  const excelValue = formatExcelValue(value);

  // Create cell with correct type
  const cell: XLSX.CellObject = typeof excelValue === 'number'
    ? { v: excelValue, t: 'n' }
    : typeof excelValue === 'boolean'
      ? { v: excelValue, t: 'b' }
      : excelValue instanceof Date
        ? { v: excelValue, t: 'd' }
        : { v: String(excelValue), t: 's' };

  // Number format
  if (typeof cell.v === 'number') {
    const format = detectCellNumberFormat(formatter, cell.v, rowData);
    if (format) cell.z = format;
  }

  // Hyperlink — use both cell.l (XLSX relationship) and HYPERLINK formula for max compat
  if (cell.v != null && cell.v !== '') {
    const url = resolveHyperlinkUrl(field, rowData);
    if (url) {
      const displayText = String(cell.v);
      const escapedUrl = url.replace(/"/g, '""');
      const escapedText = displayText.replace(/"/g, '""');
      cell.l = { Target: url };
      cell.f = `HYPERLINK("${escapedUrl}","${escapedText}")`;
    }
  }

  return cell;
}

/**
 * Post-process an XLSX buffer to:
 * 1. Set default font to Calibri 12
 * 2. Inject proper Excel "Hyperlink" and "Followed Hyperlink" named styles
 *    using theme colors (theme 10 = #0563C1 blue, theme 11 = #954F72 purple)
 *    so visited links automatically turn purple
 * 3. Apply the hyperlink style to cells that contain hyperlinks
 */
async function applyHyperlinkStyles(xlsxBuffer: ArrayBuffer): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(xlsxBuffer);

  const stylesFile = zip.file('xl/styles.xml');
  const sheetFile = zip.file('xl/worksheets/sheet1.xml');
  if (!stylesFile || !sheetFile) return xlsxBuffer;

  let sheetXml = await sheetFile.async('string') as string;
  let stylesXml = await stylesFile.async('string') as string;

  // --- Change default font size from 11 to 12 ---
  stylesXml = stylesXml.replace(
    /(<fonts[^>]*>\s*<font>[^]*?)<sz val="\d+"\/>/,
    '$1<sz val="12"/>',
  );

  // --- Collect hyperlink cell refs from <hyperlink> elements only ---
  // (NOT from HYPERLINK formulas — that regex can span across cells and match headers)
  const hlRefs = new Set<string>();
  for (const m of sheetXml.matchAll(/<hyperlink ref="([^"]+)"/g)) hlRefs.add(m[1]);

  if (hlRefs.size === 0) {
    // Still save the font size change
    zip.file('xl/styles.xml', stylesXml);
    return await zip.generateAsync({ type: 'arraybuffer' });
  }

  // --- Add hyperlink fonts using theme colors ---
  // Hyperlink: underline + theme color 10 (blue #0563C1 in Office theme)
  const hlFont = '<font><u/><sz val="12"/><color theme="10"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
  // Followed Hyperlink: underline + theme color 11 (purple #954F72 in Office theme)
  const folHlFont = '<font><u/><sz val="12"/><color theme="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>';
  stylesXml = stylesXml.replace(/<\/fonts>/, hlFont + folHlFont + '</fonts>');
  stylesXml = stylesXml.replace(/(<fonts count=")(\d+)"/, (_: string, pre: string, n: string) => `${pre}${Number(n) + 2}"`);

  const fontCount = Number(stylesXml.match(/<fonts count="(\d+)"/)?.[1] ?? 2);
  const hlFontId = fontCount - 2;
  const folHlFontId = fontCount - 1;

  // --- Add base styles in cellStyleXfs (needed for named cellStyles) ---
  const hlBaseXf = `<xf numFmtId="0" fontId="${hlFontId}" fillId="0" borderId="0" applyFont="1"/>`;
  const folHlBaseXf = `<xf numFmtId="0" fontId="${folHlFontId}" fillId="0" borderId="0" applyFont="1"/>`;
  stylesXml = stylesXml.replace(/<\/cellStyleXfs>/, hlBaseXf + folHlBaseXf + '</cellStyleXfs>');
  stylesXml = stylesXml.replace(/(<cellStyleXfs count=")(\d+)"/, (_: string, pre: string, n: string) => `${pre}${Number(n) + 2}"`);

  const styleXfCount = Number(stylesXml.match(/<cellStyleXfs count="(\d+)"/)?.[1] ?? 2);
  const hlBaseXfId = styleXfCount - 2;
  const folHlBaseXfId = styleXfCount - 1;

  // --- Add cell format in cellXfs (references the base hyperlink style) ---
  const hlCellXf = `<xf numFmtId="0" fontId="${hlFontId}" fillId="0" borderId="0" xfId="${hlBaseXfId}" applyFont="1"/>`;
  stylesXml = stylesXml.replace(/<\/cellXfs>/, hlCellXf + '</cellXfs>');
  stylesXml = stylesXml.replace(/(<cellXfs count=")(\d+)"/, (_: string, pre: string, n: string) => `${pre}${Number(n) + 1}"`);

  const hlCellStyleIdx = Number(stylesXml.match(/<cellXfs count="(\d+)"/)?.[1] ?? 2) - 1;

  // --- Register named styles (builtinId 8 = Hyperlink, 9 = Followed Hyperlink) ---
  // This tells Excel to automatically switch visited links to the "Followed Hyperlink" style
  const hlNamedStyle = `<cellStyle name="Hyperlink" xfId="${hlBaseXfId}" builtinId="8"/>`;
  const folHlNamedStyle = `<cellStyle name="Followed Hyperlink" xfId="${folHlBaseXfId}" builtinId="9"/>`;
  stylesXml = stylesXml.replace(/<\/cellStyles>/, hlNamedStyle + folHlNamedStyle + '</cellStyles>');
  stylesXml = stylesXml.replace(/(<cellStyles count=")(\d+)"/, (_: string, pre: string, n: string) => `${pre}${Number(n) + 2}"`);

  zip.file('xl/styles.xml', stylesXml);

  // --- Patch sheet XML: apply hyperlink cellXf to hyperlink cells ---
  for (const ref of hlRefs) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    sheetXml = sheetXml.replace(
      new RegExp(`<c r="${escaped}"([^>]*)>`),
      (_: string, attrs: string) => {
        const cleanAttrs = attrs.replace(/\s*s="[^"]*"/, '');
        return `<c r="${ref}" s="${hlCellStyleIdx}"${cleanAttrs}>`;
      },
    );
  }

  zip.file('xl/worksheets/sheet1.xml', sheetXml);

  return await zip.generateAsync({ type: 'arraybuffer' });
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
  // Get visible columns, skipping utility columns (drag handles, selection checkboxes)
  const columns = (api.getAllDisplayedColumns?.() ?? []).filter(col => !isUtilityColumn(col));

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
 * Generate Excel file from rows.
 * Builds the worksheet cell-by-cell for full control over formatting and hyperlinks.
 */
async function generateExcelFromRows<RowData>(
  api: GridApi<RowData>,
  rows: RowData[],
): Promise<ArrayBuffer> {
  // Get visible columns, skipping utility columns (drag handles, selection checkboxes)
  const allColumns = api.getAllDisplayedColumns?.() ?? [];
  const columns = allColumns.filter(col => !isUtilityColumn(col));

  console.log('[generateExcelFromRows] Generating Excel for', rows.length, 'rows and', columns.length, 'columns (skipped', allColumns.length - columns.length, 'utility columns)');

  // Build column metadata
  const columnMeta = columns.map(col => {
    const colDef = col.getColDef();
    return {
      col,
      field: colDef.field ?? col.getColId(),
      headerName: colDef.headerName ?? col.getColId(),
      formatter: colDef.valueFormatter,
    };
  });

  // Build worksheet manually — this ensures cell.l and cell.f are set from the start
  const ws: XLSX.WorkSheet = {};
  const totalCols = columnMeta.length;
  const totalRows = rows.length + 1; // +1 for header

  ws['!ref'] = XLSX.utils.encode_range(
    { r: 0, c: 0 },
    { r: totalRows - 1, c: Math.max(totalCols - 1, 0) },
  );

  // Header row
  columnMeta.forEach((meta, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: meta.headerName, t: 's' };
  });

  // Data rows — each cell built with value + format + hyperlink in one go
  rows.forEach((row, rowIdx) => {
    const rowData = row as Record<string, unknown>;
    columnMeta.forEach((meta, colIdx) => {
      const cell = buildExcelCell(rowData[meta.field], meta.field, meta.formatter, rowData);
      ws[XLSX.utils.encode_cell({ r: rowIdx + 1, c: colIdx })] = cell;
    });
  });

  // Auto-size columns
  ws['!cols'] = columnMeta.map((meta) => {
    const headerLen = meta.headerName.length;
    let maxDataLen = headerLen;
    for (let r = 0; r < Math.min(rows.length, 100); r++) {
      const val = (rows[r] as Record<string, unknown>)[meta.field];
      const len = val != null ? String(val).length : 0;
      if (len > maxDataLen) maxDataLen = len;
    }
    return { wch: Math.min(maxDataLen + 2, 50) };
  });

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

  console.log('[generateExcelFromRows] Generated Excel file, applying hyperlink styles...');
  return await applyHyperlinkStyles(wbout);
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
    const rangeObj = range as { columns?: Column[]; startRow?: { rowIndex: number }; endRow?: { rowIndex: number } };
    // Filter out utility columns from the range
    const columns = (rangeObj.columns || []).filter(col => !isUtilityColumn(col));
    const startRow = rangeObj.startRow;
    const endRow = rangeObj.endRow;

    if (!startRow || !endRow) return;

    const startIndex = Math.min(startRow.rowIndex, endRow.rowIndex);
    const endIndex = Math.max(startRow.rowIndex, endRow.rowIndex);

    console.log(`[generateCsvFromCellRanges] Processing range: rows ${startIndex}-${endIndex}, columns:`, columns.length);

    // Add header row (only once)
    if (rows.length === 0) {
      const headers = columns.map((col) => {
        const colDef = col.getColDef?.() ?? {};
        return escapeCsvValue((colDef as { headerName?: string }).headerName ?? col.getColId());
      });
      rows.push(headers);
    }

    // Iterate through rows in the range
    for (let rowIndex = startIndex; rowIndex <= endIndex; rowIndex++) {
      const rowNode = api.getDisplayedRowAtIndex?.(rowIndex);
      if (!rowNode || !rowNode.data) continue;

      const rowData = rowNode.data;
      const rowValues = columns.map((col) => {
        const colDef = col.getColDef?.() ?? {};
        const field = (colDef as { field?: string }).field ?? col.getColId();
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

    const excelBuffer = await generateExcelFromRows(api, allRows);
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
 * Export selected rows as Excel (uses custom generation for formatting & hyperlinks)
 */
export async function exportSelectedRowsAsExcel<RowData>(
  api: GridApi<RowData> | null,
  fileName?: string,
): Promise<void> {
  if (!api) {
    console.warn('[exportSelectedRowsAsExcel] No API provided');
    return;
  }

  console.log('[exportSelectedRowsAsExcel] Starting selected rows export');

  const selectedNodes = api.getSelectedNodes?.() ?? [];
  const rows = selectedNodes
    .map(node => node.data)
    .filter((d): d is RowData => d != null);

  if (rows.length === 0) {
    console.warn('[exportSelectedRowsAsExcel] No selected rows');
    return;
  }

  const excelBuffer = await generateExcelFromRows(api, rows);
  const excelFileName = fileName ?? 'export.xlsx';
  downloadExcel(excelBuffer, excelFileName);

  console.log('[exportSelectedRowsAsExcel] Export completed:', excelFileName);
}

/**
 * Export selected cells as Excel
 */
export async function exportSelectedCellsAsExcel<RowData>(
  api: GridApi<RowData> | null,
  fileName?: string,
): Promise<void> {
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
    const excelBuffer = await generateExcelFromCellRanges(api, cellRanges);
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
 * Generate Excel file from selected cell ranges.
 * Builds the worksheet cell-by-cell for full control over formatting and hyperlinks.
 */
async function generateExcelFromCellRanges<RowData>(
  api: GridApi<RowData>,
  cellRanges: unknown[],
): Promise<ArrayBuffer> {
  // Collect rows and column metadata from ranges
  const sourceRows: Record<string, unknown>[] = [];
  let columnMeta: { col: Column; field: string; headerName: string; formatter: unknown }[] = [];

  cellRanges.forEach((range: unknown) => {
    const rangeObj = range as { columns?: Column[]; startRow?: { rowIndex: number }; endRow?: { rowIndex: number } };
    const allColumns: Column[] = rangeObj.columns || [];
    const columns = allColumns.filter(col => !isUtilityColumn(col));
    const startRow = rangeObj.startRow;
    const endRow = rangeObj.endRow;

    if (!startRow || !endRow) return;

    const startIndex = Math.min(startRow.rowIndex, endRow.rowIndex);
    const endIndex = Math.max(startRow.rowIndex, endRow.rowIndex);

    console.log(`[generateExcelFromCellRanges] Processing range: rows ${startIndex}-${endIndex}, columns:`, columns.length, '(skipped', allColumns.length - columns.length, 'utility)');

    if (columnMeta.length === 0) {
      columnMeta = columns.map(col => {
        const colDef = col.getColDef?.() ?? {};
        return {
          col,
          field: (colDef as { field?: string }).field ?? col.getColId(),
          headerName: (colDef as { headerName?: string }).headerName ?? col.getColId(),
          formatter: (colDef as { valueFormatter?: unknown }).valueFormatter,
        };
      });
    }

    for (let rowIndex = startIndex; rowIndex <= endIndex; rowIndex++) {
      const rowNode = api.getDisplayedRowAtIndex?.(rowIndex);
      if (!rowNode || !rowNode.data) continue;
      sourceRows.push(rowNode.data as Record<string, unknown>);
    }
  });

  // Build worksheet manually
  const ws: XLSX.WorkSheet = {};
  const totalCols = columnMeta.length;
  const totalRows = sourceRows.length + 1;

  ws['!ref'] = XLSX.utils.encode_range(
    { r: 0, c: 0 },
    { r: totalRows - 1, c: Math.max(totalCols - 1, 0) },
  );

  // Header row
  columnMeta.forEach((meta, c) => {
    ws[XLSX.utils.encode_cell({ r: 0, c })] = { v: meta.headerName, t: 's' };
  });

  // Data rows
  sourceRows.forEach((rowData, rowIdx) => {
    columnMeta.forEach((meta, colIdx) => {
      const cell = buildExcelCell(rowData[meta.field], meta.field, meta.formatter, rowData);
      ws[XLSX.utils.encode_cell({ r: rowIdx + 1, c: colIdx })] = cell;
    });
  });

  // Auto-size columns
  if (totalCols > 0) {
    ws['!cols'] = columnMeta.map((meta) => {
      const headerLen = meta.headerName.length;
      let maxDataLen = headerLen;
      for (let r = 0; r < Math.min(sourceRows.length, 100); r++) {
        const val = sourceRows[r][meta.field];
        const len = val != null ? String(val).length : 0;
        if (len > maxDataLen) maxDataLen = len;
      }
      return { wch: Math.min(maxDataLen + 2, 50) };
    });
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Export');
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });

  console.log('[generateExcelFromCellRanges] Generated Excel file with', totalRows, 'rows (including header), applying hyperlink styles...');
  return await applyHyperlinkStyles(wbout);
}
