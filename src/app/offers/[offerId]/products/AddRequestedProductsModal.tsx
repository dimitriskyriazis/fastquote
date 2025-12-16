'use client';

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import * as XLSX from 'xlsx';
import styles from './AddRequestedProductsModal.module.css';
import { showToastMessage } from '../../../../lib/toast';

type Props = {
  offerId: string;
  onClose: () => void;
  onImported: (result: { inserted?: number; updated?: number; total?: number }) => void;
};

type HeaderColumnKey = 'itemNo' | 'brand' | 'modelNumber' | 'partNumber' | 'description' | 'description2' | 'description3' | 'quantity';

type ColumnOption = { index: number; label: string; normalized: string };

type SheetMapping = {
  name: string;
  headerRowIndex: number;
  columns: ColumnOption[];
  suggestions: Record<HeaderColumnKey, ColumnOption[]>;
  selection: Partial<Record<HeaderColumnKey, number | null>>;
  rowCount: number;
  enabled: boolean;
  includeHeaderRow: boolean;
  rawRows: unknown[][];
};

type FileValidation = {
  status: 'idle' | 'checking' | 'valid' | 'invalid';
  message: string | null;
  columns: Partial<Record<HeaderColumnKey, boolean>>;
  rowCount: number;
  sheets: SheetMapping[];
  activeSheetIndex: number;
};

type PayloadRow = {
  itemNo?: string | null;
  brand?: string | null;
  modelNumber?: string | null;
  partNumber?: string | null;
  description?: string | null;
  description2?: string | null;
  description3?: string | null;
  quantity?: string | number | null;
};

const columnKeywords: Record<HeaderColumnKey, string[]> = {
  itemNo: ['item', 'tree', 'ordering', 'no', '#', 'position'],
  brand: ['brand', 'maker', 'make', 'manufacturer', 'vendor'],
  modelNumber: ['model', 'series', 'type', 'model#'],
  partNumber: ['part', 'sku', 'code', 'p/n', 'article'],
  description: ['description', 'desc', 'name', 'details', 'product', 'information', 'info', 'specs', 'specifications'],
  description2: ['description', 'desc', 'name', 'details', 'product', 'information', 'info', 'specs', 'specifications'],
  description3: ['description', 'desc', 'name', 'details', 'product', 'information', 'info', 'specs', 'specifications'],
  quantity: ['qty', 'quantity', 'amount', 'pcs', 'pieces'],
};

const COLUMN_DISPLAY: Array<{ key: HeaderColumnKey; label: string }> = [
  { key: 'itemNo', label: 'Item No / Tree Ordering' },
  { key: 'brand', label: 'Brand' },
  { key: 'modelNumber', label: 'Model No' },
  { key: 'partNumber', label: 'Part No' },
  { key: 'description', label: 'Description' },
  { key: 'description2', label: 'Description 2' },
  { key: 'description3', label: 'Description 3' },
  { key: 'quantity', label: 'Quantity' },
];

const INITIAL_VALIDATION: FileValidation = {
  status: 'idle',
  message: null,
  columns: {},
  rowCount: 0,
  sheets: [],
  activeSheetIndex: 0,
};

const normalizeHeaderText = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const str = typeof value === 'number' ? String(value) : value;
  const normalized = str.trim().toLowerCase();
  return normalized || null;
};

const hasCellValue = (value: unknown) => {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
};

const detectHeaderRowIndex = (rows: unknown[][]) => {
  let bestIdx = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 25);
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const score = row.reduce<number>((count, cell) => (hasCellValue(cell) ? count + 1 : count), 0);
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }
  return bestIdx;
};

const buildColumns = (headerRow: unknown[]): ColumnOption[] =>
  headerRow.map((cell, idx) => {
    const normalized = normalizeHeaderText(cell) ?? '';
    let label = '';
    if (typeof cell === 'string') label = cell.trim();
    if (!label && typeof cell === 'number') label = String(cell);
    const safeLabel = label || `Column ${idx + 1}`;
    return { index: idx, label: safeLabel, normalized };
  });

const buildSuggestions = (columns: ColumnOption[]) => {
  const makeSuggestions = (key: HeaderColumnKey) => {
    const keywords = columnKeywords[key].map((kw) => kw.toLowerCase());
    return columns.filter((col) => keywords.some((kw) => col.normalized.includes(kw)));
  };
  return {
    itemNo: makeSuggestions('itemNo'),
    brand: makeSuggestions('brand'),
    modelNumber: makeSuggestions('modelNumber'),
    partNumber: makeSuggestions('partNumber'),
    description: makeSuggestions('description'),
    description2: makeSuggestions('description2'),
    description3: makeSuggestions('description3'),
    quantity: makeSuggestions('quantity'),
  };
};

const analyzeSheet = (sheetName: string, rows: unknown[][], fallbackIndex: number, enabled: boolean): SheetMapping => {
  const headerRowIndex = detectHeaderRowIndex(rows);
  const headerRow = Array.isArray(rows[headerRowIndex]) ? rows[headerRowIndex] : [];
  const columns = buildColumns(headerRow);
  const suggestions = buildSuggestions(columns);
  const includeHeaderRow = Object.values(suggestions).some((match) => match.length > 0);
  const baseSheet: SheetMapping = {
    name: sheetName || `Sheet ${fallbackIndex + 1}`,
    headerRowIndex,
    columns,
    suggestions,
    selection: {},
    rowCount: 0,
    enabled,
    includeHeaderRow,
    rawRows: rows,
  };
  return enrichSheet(baseSheet);
};

const analyzeWorkbook = (workbook: XLSX.WorkBook): SheetMapping[] => {
  const sheets: SheetMapping[] = [];
  for (const sheetName of workbook.SheetNames ?? []) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
    if (!Array.isArray(rows)) continue;
    sheets.push(analyzeSheet(sheetName, rows, sheets.length, sheets.length === 0));
  }
  return sheets;
};

const evaluateSelection = (sheets: SheetMapping[], activeSheetIndex: number) => {
  const active = sheets[activeSheetIndex];
  if (!active) {
    return {
      status: 'invalid' as const,
      message: 'Upload a workbook to choose columns.',
      columns: {},
      rowCount: 0,
    };
  }
  const enabledSheets = sheets.filter((sheet) => sheet.enabled);
  const usableSheets = enabledSheets.filter((sheet) =>
    (Object.values(sheet.selection) as Array<number | null | undefined>).some((value) => value != null),
  );
  const columns: Partial<Record<HeaderColumnKey, boolean>> = {};
  (COLUMN_DISPLAY.map((col) => col.key) as HeaderColumnKey[]).forEach((key) => {
    columns[key] = active.selection[key] != null;
  });
  const status: FileValidation['status'] = usableSheets.length > 0 ? 'valid' : 'invalid';
  const message = usableSheets.length > 0
    ? `Using ${usableSheets.length} sheet${usableSheets.length === 1 ? '' : 's'} with mapped columns.`
    : 'Choose at least one column on an enabled sheet.';
  const rowCount = usableSheets.reduce((acc, sheet) => acc + sheet.rowCount, 0);
  return { status, message, columns, rowCount };
};

const normalizeCellText = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === 'string' ? value : String(value);
  const trimmed = str.trim();
  return trimmed || null;
};

const normalizeQuantityValue = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const str = typeof value === 'string' ? value.trim() : '';
  if (!str) return null;
  const parsed = Number.parseFloat(str.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};

const hasPayloadValues = (row: PayloadRow) => {
  return Boolean(
    (row.itemNo && row.itemNo.trim())
    || (row.brand && row.brand.trim())
    || (row.modelNumber && row.modelNumber.trim())
    || (row.partNumber && row.partNumber.trim())
    || (row.description && row.description.trim())
    || (row.description2 && row.description2.trim())
    || (row.description3 && row.description3.trim())
    || (row.quantity != null && row.quantity !== ''),
  );
};

const getSheetDataRows = (sheet: SheetMapping) => {
  const startIndex = sheet.includeHeaderRow ? sheet.headerRowIndex + 1 : sheet.headerRowIndex;
  return sheet.rawRows.slice(startIndex);
};

const computeSheetRowCount = (sheet: SheetMapping) => (
  getSheetDataRows(sheet).filter((row) => Array.isArray(row) && row.some(hasCellValue)).length
);

const enrichSheet = (sheet: SheetMapping): SheetMapping => ({
  ...sheet,
  rowCount: computeSheetRowCount(sheet),
});

const parsePastedText = (text: string): unknown[][] => {
  const lines = text.split(/\r?\n/);
  return lines
    .map((line) => line.split(/\t/).map((cell) => {
      const cleaned = cell.replace(/\r/g, '');
      const normalizedSpace = typeof cleaned === 'string' ? cleaned.replace(/\u00a0/g, ' ') : cleaned;
      const trimmed = typeof normalizedSpace === 'string' ? normalizedSpace.trim() : normalizedSpace;
      return trimmed === '' ? null : trimmed;
    }))
    .filter((row) => row.some(hasCellValue));
};

export default function AddRequestedProductsModal({ offerId, onClose, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [fileValidation, setFileValidation] = useState<FileValidation>(INITIAL_VALIDATION);
  const [pasteText, setPasteText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validationRunId = useRef(0);

  const applySheets = useCallback((sheets: SheetMapping[]) => {
    const normalizedSheets = sheets.map(enrichSheet);
    const evaluation = evaluateSelection(normalizedSheets, 0);
    setFileValidation({
      status: evaluation.status,
      message: evaluation.message,
      columns: evaluation.columns,
      rowCount: evaluation.rowCount,
      sheets: normalizedSheets,
      activeSheetIndex: 0,
    });
  }, []);

  const activeSheet = useMemo(
    () => fileValidation.sheets[fileValidation.activeSheetIndex] ?? null,
    [fileValidation.activeSheetIndex, fileValidation.sheets],
  );

  const handleSheetChange = useCallback((nextIndex: number) => {
    setFileValidation((prev) => {
      const boundedIndex = Math.max(0, Math.min(nextIndex, prev.sheets.length - 1));
      const evaluation = evaluateSelection(prev.sheets, boundedIndex);
      return { ...prev, ...evaluation, activeSheetIndex: boundedIndex };
    });
  }, []);

  const updateColumnSelection = useCallback((key: HeaderColumnKey, columnIndex: number | null) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) =>
        idx === prev.activeSheetIndex
          ? { ...sheet, selection: { ...sheet.selection, [key]: columnIndex } }
          : sheet,
      );
      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, []);

  const toggleSheetEnabled = useCallback((index: number, enabled: boolean) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) =>
        idx === index ? { ...sheet, enabled } : sheet,
      );
      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, []);

  const handleFileSelection = useCallback((nextFile: File | null) => {
    validationRunId.current += 1;
    const runId = validationRunId.current;
    setFile(nextFile);
    setPasteText('');
    setError(null);

    if (!nextFile) {
      setFileValidation(INITIAL_VALIDATION);
      return;
    }

    setFileValidation({
      status: 'checking',
      message: 'Analyzing workbook…',
      columns: {},
      rowCount: 0,
      sheets: [],
      activeSheetIndex: 0,
    });

    nextFile.arrayBuffer()
      .then((buffer) => {
        if (runId !== validationRunId.current) return;
        let sheets: SheetMapping[] = [];
        try {
          const workbook = XLSX.read(buffer, { type: 'array' });
          sheets = analyzeWorkbook(workbook);
        } catch (err) {
          console.error('Failed to parse workbook', err);
          sheets = [];
        }
        if (sheets.length === 0) {
          setFileValidation({
            ...INITIAL_VALIDATION,
            status: 'invalid',
            message: 'Unable to read any sheets. Please check the file.',
          });
          return;
        }
        applySheets(sheets);
      })
      .catch((err) => {
        console.error('Failed to read file', err);
        if (runId !== validationRunId.current) return;
        setFileValidation({
          ...INITIAL_VALIDATION,
          status: 'invalid',
          message: 'Unable to read the file. Please try another upload.',
        });
      });
  }, [applySheets]);

  const handlePasteInput = useCallback((value: string) => {
    setPasteText(value);
    if (!value.trim()) {
      setFileValidation(INITIAL_VALIDATION);
      setFile(null);
      setError(null);
      return;
    }
    const rows = parsePastedText(value);
    if (!rows.length) {
      setFileValidation({
        ...INITIAL_VALIDATION,
        status: 'invalid',
        message: 'Paste tab-separated rows from Excel.',
      });
      return;
    }
    const sheet = analyzeSheet('Pasted data', rows, 0, true);
    applySheets([sheet]);
    setFile(null);
    setError(null);
  }, [applySheets]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    event.target.value = '';
    handleFileSelection(nextFile);
  }, [handleFileSelection]);

  const handleFileDrop = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const droppedFile = event.dataTransfer?.files?.[0] ?? null;
    handleFileSelection(droppedFile);
  }, [handleFileSelection]);

  const handleDragOver = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const enabledSheets = useMemo(() => fileValidation.sheets.filter((sheet) => sheet.enabled), [fileValidation.sheets]);

  const sheetSummaries = useMemo(() => enabledSheets.map((sheet) => {
    const selectedColumns = (Object.values(sheet.selection) as Array<number | null | undefined>).filter((value) => value != null).length;
    return {
      name: sheet.name,
      rowCount: sheet.rowCount,
      selectedColumns,
    };
  }), [enabledSheets]);

  const extractRows = useCallback(() => {
    const payload: PayloadRow[] = [];
    fileValidation.sheets.forEach((sheet) => {
      if (!sheet.enabled) return;
      const selection = sheet.selection;
      const hasSelection = (Object.values(selection) as Array<number | null | undefined>).some((value) => value != null);
      if (!hasSelection) return;
      const dataRows = getSheetDataRows(sheet);
      dataRows.forEach((row) => {
        if (!Array.isArray(row)) return;
        const getCell = (index: number | null | undefined) => (typeof index === 'number' ? row[index] : null);
        const itemNo = normalizeCellText(getCell(selection.itemNo ?? null));
        const brand = normalizeCellText(getCell(selection.brand ?? null));
        const modelNumber = normalizeCellText(getCell(selection.modelNumber ?? null));
        const partNumber = normalizeCellText(getCell(selection.partNumber ?? null));
        const description = normalizeCellText(getCell(selection.description ?? null));
        const description2 = normalizeCellText(getCell(selection.description2 ?? null));
        const description3 = normalizeCellText(getCell(selection.description3 ?? null));
        const quantityRaw = getCell(selection.quantity ?? null);
        const quantity = normalizeQuantityValue(quantityRaw);
        const payloadRow: PayloadRow = {
          itemNo,
          brand,
          modelNumber,
          partNumber,
          description,
          description2,
          description3,
          quantity,
        };
        if (hasPayloadValues(payloadRow)) {
          payload.push(payloadRow);
        }
      });
    });
    return payload;
  }, [fileValidation.sheets]);

  const handleImport = useCallback(async () => {
    setError(null);
    if (fileValidation.status === 'checking') {
      setError('Please wait for the file analysis to finish.');
      return;
    }
    if (fileValidation.status !== 'valid') {
      setError('Select at least one column on an enabled sheet.');
      return;
    }
    if (!fileValidation.sheets.length) {
      setError('Provide data via paste or file upload before importing.');
      return;
    }
    const rows = extractRows();
    if (!rows.length) {
      setError('No rows detected using the selected columns.');
      return;
    }
    setSubmitting(true);
    try {
      const endpoint = `/api/offers/${encodeURIComponent(offerId)}/products/requested`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
      });
      const payload = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; inserted?: number; updated?: number; total?: number } | null;
      if (!res.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Failed to add requested products (status ${res.status})`);
      }
      showToastMessage('Requested products added', 'success');
      onImported(payload ?? {});
      onClose();
    } catch (err) {
      console.error('Failed to import requested products', err);
      const message = err instanceof Error ? err.message : 'Unable to add requested products. Please try again.';
      setError(message);
      showToastMessage('Unable to add requested products. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [
    extractRows,
    fileValidation.status,
    fileValidation.sheets.length,
    offerId,
    onClose,
    onImported,
  ]);

  const handleOverlayClick = useCallback(() => {
    if (submitting) return;
    onClose();
  }, [onClose, submitting]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const statusTitle = fileValidation.status === 'valid'
    ? 'Workbook ready'
    : fileValidation.status === 'invalid'
      ? 'Select the columns'
      : fileValidation.status === 'checking'
        ? 'Checking workbook'
        : 'Waiting for a file';

  const statusMessage = fileValidation.message
    ?? 'Pick the columns you want to import. None of them are mandatory.';

  const canSubmit = fileValidation.status === 'valid' && !submitting;

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={styles.card} role="dialog" aria-modal="true" aria-label="Add requested products" onClick={(event) => event.stopPropagation()}>
        <div className={styles.header}>
          <div className={styles.headerText}>
            <div className={styles.title}>Add Requested Products</div>
            <div className={styles.subtitle}>Upload the customer request and map the columns to import them.</div>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.ghostButton} onClick={onClose} disabled={submitting}>Cancel</button>
            <button type="button" className={styles.primaryButton} onClick={handleImport} disabled={!canSubmit}>
              {submitting ? 'Adding…' : 'Add requested products'}
            </button>
          </div>
        </div>
        <div className={styles.body}>
          <div className={styles.mappingColumn}>
            <label
              htmlFor="requested-products-file"
              className={`${styles.uploadLabel} ${isDragging ? styles.uploadLabelDragging : ''}`}
              onDrop={handleFileDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <input
                autoComplete="off"
                id="requested-products-file"
                type="file"
                accept=".xlsx,.xls,.csv"
                className={styles.fileInput}
                onChange={handleFileChange}
              />
              <div className={styles.uploadTitle}>{file ? 'Replace file' : 'Drop Excel file or click to browse'}</div>
              <div className={styles.uploadSubtitle}>Supported formats: .xlsx, .xls, .csv</div>
              {file ? <div className={styles.selectedFile}>{file.name}</div> : null}
            </label>
            <div className={styles.statusCard}>
              <div className={styles.statusTitle}>{statusTitle}</div>
              <div className={styles.statusText}>{statusMessage}</div>
              {fileValidation.rowCount > 0 ? (
                <div className={styles.helpText}>{`Detected approximately ${fileValidation.rowCount} rows in the enabled sheets.`}</div>
              ) : null}
            </div>
            <div className={styles.pasteCard}>
              <div className={styles.pasteHeader}>
                <div className={styles.pasteTitle}>Paste rows from Excel or Sheets</div>
                <div className={styles.pasteDescription}>Copy cells and paste them here; columns are separated by tabs.</div>
              </div>
              <textarea
                autoComplete="off"
                value={pasteText}
                onChange={(event) => handlePasteInput(event.target.value)}
                placeholder="Item No / Tree Ordering	Brand	Model No	Part No	Description	Description 2	Description 3	Quantity"
                className={styles.pasteTextarea}
              />
            </div>
            {fileValidation.sheets.length > 0 ? (
              <div className={styles.sheetTabs}>
                {fileValidation.sheets.map((sheet, idx) => {
                  const isActive = idx === fileValidation.activeSheetIndex;
                  const included = sheet.enabled;
                  const classNames = [styles.sheetTab];
                  if (isActive) classNames.push(styles.sheetTabActive);
                  if (included) classNames.push(styles.sheetTabIncluded);
                  return (
                    <button
                      type="button"
                      key={sheet.name || idx}
                      className={classNames.join(' ')}
                      onClick={() => handleSheetChange(idx)}
                    >
                      {sheet.name || `Sheet ${idx + 1}`}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {activeSheet && fileValidation.sheets.length > 1 ? (
              <label className={styles.sheetToggle}>
                <input
                  autoComplete="off"
                  type="checkbox"
                  checked={activeSheet.enabled}
                  onChange={(event) => toggleSheetEnabled(fileValidation.activeSheetIndex, event.target.checked)}
                />
                <span>{activeSheet.enabled ? 'Included in import' : 'Excluded from import'}</span>
              </label>
            ) : null}
            {activeSheet ? (
              <>
                <div className={styles.helpText}>
                  Select the corresponding column for each field. Suggested matches appear at the top.
                </div>
                <div className={styles.mappingGrid}>
                  {COLUMN_DISPLAY.map((column) => {
                    const selectionValue = activeSheet.selection[column.key] != null
                      ? String(activeSheet.selection[column.key])
                      : '';
                    const suggestions = activeSheet.suggestions[column.key] ?? [];
                    const suggestedIndexes = new Set(suggestions.map((opt) => opt.index));
                    const otherOptions = activeSheet.columns.filter((col) => !suggestedIndexes.has(col.index));
                    return (
                      <label key={column.key} className={styles.mappingField}>
                        <span className={styles.mappingLabel}>{column.label}</span>
                        <select
                          className={styles.select}
                          value={selectionValue}
                          onChange={(event) =>
                            updateColumnSelection(
                              column.key,
                              event.target.value === '' ? null : Number(event.target.value),
                            )
                          }
                        >
                          <option value="">Choose a column</option>
                          {suggestions.length > 0 ? (
                            <optgroup label="Suggested">
                              {suggestions.map((opt) => (
                                <option key={opt.index} value={opt.index}>
                                  {opt.label}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          {otherOptions.length > 0 ? (
                            <optgroup label="All columns">
                              {otherOptions.map((opt) => (
                                <option key={opt.index} value={opt.index}>
                                  {opt.label}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                        </select>
                      </label>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
          <div className={styles.previewColumn}>
            <div className={styles.statusCard}>
              <div className={styles.statusTitle}>Import summary</div>
              {sheetSummaries.length === 0 ? (
                <div className={styles.statusText}>No sheets are currently included.</div>
              ) : (
                <div className={styles.previewList}>
                  {sheetSummaries.map((sheet) => (
                    <div key={sheet.name} className={styles.previewItem}>
                      <div className={styles.previewCount}>{sheet.name}</div>
                      <div>{sheet.selectedColumns} mapped column{sheet.selectedColumns === 1 ? '' : 's'}</div>
                      <div>{sheet.rowCount} detected row{sheet.rowCount === 1 ? '' : 's'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {error ? <div className={styles.errorText}>{error}</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
