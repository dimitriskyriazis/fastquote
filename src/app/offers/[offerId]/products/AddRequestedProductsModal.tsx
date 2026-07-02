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
import type * as XLSXTypes from 'xlsx';
import styles from './AddRequestedProductsModal.module.css';
import { useModalDragResize } from '../../../hooks/useModalDragResize';
import { showToastMessage } from '../../../../lib/toast';
import { parseLocaleNumber } from '../../../../lib/localeNumber';
import { isEpLincPricingPolicyName as isEpLincPricingPolicy } from '../../../../lib/epLincPricing';

type XlsxModule = typeof import('xlsx');

const loadXlsx = () => import('xlsx');

type Props = {
  offerId: string;
  onClose: () => void;
  onImported: (result: { inserted?: number; updated?: number; total?: number }) => void;
  // Name of the offer's pricing policy (dbo.PricingPolicies.Name). When it is an
  // EP LINC policy, the uploaded workbook is assumed to follow the EP LINC
  // "Request_List_Supplies" template and its columns are auto-mapped by exact
  // header name (see EP_LINC_REQUEST_HEADER_MAP).
  pricingPolicyName?: string | null;
};

type HeaderColumnKey = 'itemNo' | 'brand' | 'modelNumber' | 'partNumber' | 'webLink' | 'description' | 'description2' | 'description3' | 'quantity';

// Per-field lists of exact worksheet header names (already normalized: trimmed +
// lowercased) that should be matched verbatim, taking priority over the generic
// keyword matcher. Used for template-specific auto-mapping (e.g. EP LINC).
type ExactHeaderMap = Partial<Record<HeaderColumnKey, string[]>>;

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
  hyperlinkTargets: Record<string, string>;
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
  webLink?: string | null;
  description?: string | null;
  description2?: string | null;
  description3?: string | null;
  quantity?: string | number | null;
};

const columnKeywords: Record<HeaderColumnKey, string[]> = {
  itemNo: ['item', 'tree', 'ordering', '#', 'position'],
  brand: ['brand', 'maker', 'make', 'manufacturer', 'vendor'],
  modelNumber: ['model', 'series', 'model#'],
  partNumber: ['part', 'sku', 'p/n', 'article', 'product'],
  webLink: ['weblink', 'web link', 'url', 'link', 'website', 'site'],
  description: ['description', 'desc', 'name', 'details', 'information', 'info', 'specs', 'specifications'],
  description2: ['description', 'desc', 'name', 'details', 'information', 'info', 'specs', 'specifications'],
  description3: ['description', 'desc', 'name', 'details', 'information', 'info', 'specs', 'specifications'],
  quantity: ['qty', 'quantity', 'amount', 'pcs', 'pieces'],
};

// The EP LINC request workbook keeps its product list on this sheet.
const EP_LINC_REQUEST_SHEET_NAME = 'request_list_supplies';

// Exact (normalized: trimmed + lowercased) header names for the EP LINC
// "Request_List_Supplies" template. Keyword matching can't disambiguate
// Product_name (Model No) from Product_reference (Part No) — both contain
// "product" — and "No" matches no keyword at all, so EP LINC offers map by
// exact header instead. Space variants are included defensively.
const EP_LINC_REQUEST_HEADER_MAP: ExactHeaderMap = {
  itemNo: ['no'],
  brand: ['manufacturer_name', 'manufacturer name'],
  modelNumber: ['product_name', 'product name'],
  partNumber: ['product_reference', 'product reference'],
  description: ['description'],
  quantity: ['product_qty', 'product qty'],
};

const COLUMN_DISPLAY: Array<{ key: HeaderColumnKey; label: string }> = [
  { key: 'itemNo', label: 'Item No' },
  { key: 'brand', label: 'Brand' },
  { key: 'modelNumber', label: 'Model No' },
  { key: 'partNumber', label: 'Part No' },
  { key: 'webLink', label: 'Web Link' },
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
  const limit = Math.min(rows.length, 50);
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

const determineColumnCount = (rows: unknown[][]) => {
  let maxColumns = 0;
  rows.forEach((row) => {
    if (!Array.isArray(row)) return;
    for (let idx = row.length - 1; idx >= 0; idx -= 1) {
      if (hasCellValue(row[idx])) {
        maxColumns = Math.max(maxColumns, idx + 1);
        break;
      }
    }
  });
  return maxColumns;
};

const buildColumns = (headerRow: unknown[], columnCount: number): ColumnOption[] => {
  const columns: ColumnOption[] = [];
  for (let idx = 0; idx < columnCount; idx += 1) {
    const cell = idx < headerRow.length ? headerRow[idx] : null;
    const normalized = normalizeHeaderText(cell) ?? '';
    let label = '';
    if (typeof cell === 'string') label = cell.trim();
    if (!label && typeof cell === 'number') label = String(cell);
    const safeLabel = label || `Column ${idx + 1}`;
    columns.push({ index: idx, label: safeLabel, normalized });
  }
  return columns;
};

const buildSuggestions = (columns: ColumnOption[], exactHeaderMap?: ExactHeaderMap | null) => {
  const makeSuggestions = (key: HeaderColumnKey) => {
    // Exact header matches (e.g. EP LINC template) lead the suggestion list so
    // the first-suggestion auto-selector picks them over ambiguous keyword hits.
    const exactHeaders = exactHeaderMap?.[key];
    const exactMatches = exactHeaders
      ? columns.filter((col) => exactHeaders.includes(col.normalized))
      : [];
    const keywords = columnKeywords[key].map((kw) => kw.toLowerCase());
    const keywordMatches = columns.filter((col) => keywords.some((kw) => col.normalized.includes(kw)));
    const seen = new Set<number>();
    const combined: ColumnOption[] = [];
    for (const col of [...exactMatches, ...keywordMatches]) {
      if (seen.has(col.index)) continue;
      seen.add(col.index);
      combined.push(col);
    }
    return combined;
  };
  return {
    itemNo: makeSuggestions('itemNo'),
    brand: makeSuggestions('brand'),
    modelNumber: makeSuggestions('modelNumber'),
    partNumber: makeSuggestions('partNumber'),
    webLink: makeSuggestions('webLink'),
    description: makeSuggestions('description'),
    description2: makeSuggestions('description2'),
    description3: makeSuggestions('description3'),
    quantity: makeSuggestions('quantity'),
  };
};

const autoSelectUniqueSuggestions = (
  suggestions: Record<HeaderColumnKey, ColumnOption[]>,
  allowedKeys?: Set<HeaderColumnKey> | null,
): Partial<Record<HeaderColumnKey, number | null>> => {
  const selection: Partial<Record<HeaderColumnKey, number | null>> = {};
  const usedIndexes = new Set<number>();

  COLUMN_DISPLAY.forEach((column) => {
    // Under a fixed template (allowedKeys), only auto-map the template's own
    // fields. Extra columns like "Description_FMS" keyword-match Description 2/3,
    // but those aren't part of the template, so they must stay empty.
    if (allowedKeys && !allowedKeys.has(column.key)) return;
    const match = (suggestions[column.key] ?? []).find((opt) => !usedIndexes.has(opt.index));
    if (!match) return;
    selection[column.key] = match.index;
    usedIndexes.add(match.index);
  });

  return selection;
};

const columnHasValue = (rows: unknown[][], headerRow: unknown[], columnIndex: number) => {
  const headerCell = columnIndex < headerRow.length ? headerRow[columnIndex] : null;
  if (hasCellValue(headerCell)) return true;
  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const cell = columnIndex < row.length ? row[columnIndex] : null;
    if (hasCellValue(cell)) return true;
  }
  return false;
};

const analyzeSheet = (
  sheetName: string,
  rows: unknown[][],
  fallbackIndex: number,
  enabled: boolean,
  hyperlinkTargets: Record<string, string> = {},
  exactHeaderMap?: ExactHeaderMap | null,
): SheetMapping => {
  const headerRowIndex = detectHeaderRowIndex(rows);
  const headerRow = Array.isArray(rows[headerRowIndex]) ? rows[headerRowIndex] : [];
  const columnCount = Math.max(determineColumnCount(rows), headerRow.length);
  const baseColumns = columnCount > 0 ? buildColumns(headerRow, columnCount) : [];
  const columns = baseColumns.filter((column) => columnHasValue(rows, headerRow, column.index));
  const suggestions = buildSuggestions(columns, exactHeaderMap);
  const includeHeaderRow = Object.values(suggestions).some((match) => match.length > 0);

  // With a fixed template, restrict auto-mapping to the template's own fields so
  // fields it doesn't cover (e.g. Description 2/3) stay empty even when other
  // columns keyword-match them.
  const allowedKeys = exactHeaderMap
    ? new Set(Object.keys(exactHeaderMap) as HeaderColumnKey[])
    : null;

  // Auto-select suggested columns, but do not map the same source column twice.
  const selection = autoSelectUniqueSuggestions(suggestions, allowedKeys);
  
  const baseSheet: SheetMapping = {
    name: sheetName || `Sheet ${fallbackIndex + 1}`,
    headerRowIndex,
    columns,
    suggestions,
    selection,
    rowCount: 0,
    enabled,
    includeHeaderRow,
    rawRows: rows,
    hyperlinkTargets,
  };
  return enrichSheet(baseSheet);
};

const analyzeWorkbook = (
  workbook: XLSXTypes.WorkBook,
  xlsx: XlsxModule,
  exactHeaderMap?: ExactHeaderMap | null,
): SheetMapping[] => {
  const sheets: SheetMapping[] = [];
  for (const sheetName of workbook.SheetNames ?? []) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;
    const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
    if (!Array.isArray(rows)) continue;
    const hyperlinkTargets = extractSheetHyperlinkTargets(sheet, xlsx);
    sheets.push(analyzeSheet(sheetName, rows, sheets.length, sheets.length === 0, hyperlinkTargets, exactHeaderMap));
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
  return parseLocaleNumber(value);
};

const hasPayloadValues = (row: PayloadRow) => {
  return Boolean(
    (row.itemNo && row.itemNo.trim())
    || (row.brand && row.brand.trim())
    || (row.modelNumber && row.modelNumber.trim())
    || (row.partNumber && row.partNumber.trim())
    || (row.webLink && row.webLink.trim())
    || (row.description && row.description.trim())
    || (row.description2 && row.description2.trim())
    || (row.description3 && row.description3.trim())
    || (row.quantity != null && row.quantity !== ''),
  );
};

const getSheetDataRows = (sheet: SheetMapping) => {
  const startIndex = sheet.includeHeaderRow ? sheet.headerRowIndex + 1 : 0;
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
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = '';
  let inQuotes = false;

  const pushCell = () => {
    currentRow.push(currentCell);
    currentCell = '';
  };

  const pushRow = () => {
    pushCell();
    rows.push(currentRow);
    currentRow = [];
  };

  for (let idx = 0; idx < text.length; idx += 1) {
    const char = text[idx];

    if (char === '"') {
      if (inQuotes) {
        const nextChar = text[idx + 1];
        if (nextChar === '"') {
          currentCell += '"';
          idx += 1;
        } else {
          inQuotes = false;
        }
      } else if (currentCell.length === 0) {
        // Only enter quote mode at the very start of a cell (standard CSV/TSV behaviour).
        inQuotes = true;
      } else {
        // Mid-cell quote (e.g. 55-65"): treat as a literal character.
        currentCell += '"';
      }
      continue;
    }

    if (!inQuotes && char === '\t') {
      pushCell();
      continue;
    }

    if (!inQuotes && (char === '\n' || char === '\r')) {
      if (char === '\r' && text[idx + 1] === '\n') {
        idx += 1;
      }
      pushRow();
      continue;
    }

    currentCell += char;
  }

  // Capture the last row when clipboard text does not end with a newline.
  if (currentCell.length > 0 || currentRow.length > 0) {
    pushRow();
  }

  return rows
    .map((row) => row.map((cell) => {
      const normalizedSpace = cell.replace(/\u00a0/g, ' ');
      const trimmed = normalizedSpace.trim();
      return trimmed === '' ? null : trimmed;
    }))
    .filter((row) => row.some(hasCellValue));
};

const buildCellKey = (rowIndex: number, columnIndex: number) => `${rowIndex}:${columnIndex}`;

const extractSheetHyperlinkTargets = (
  sheet: XLSXTypes.WorkSheet,
  xlsx: XlsxModule,
): Record<string, string> => {
  const targets: Record<string, string> = {};
  const rangeRef = typeof sheet['!ref'] === 'string' ? sheet['!ref'] : null;
  if (!rangeRef) return targets;
  let range;
  try {
    range = xlsx.utils.decode_range(rangeRef);
  } catch {
    return targets;
  }
  for (let rowIndex = range.s.r; rowIndex <= range.e.r; rowIndex += 1) {
    for (let columnIndex = range.s.c; columnIndex <= range.e.c; columnIndex += 1) {
      const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
      const cell = sheet[address] as (XLSXTypes.CellObject & { l?: { Target?: unknown } }) | undefined;
      const target = cell?.l?.Target;
      if (typeof target !== 'string') continue;
      const trimmed = target.trim();
      if (!trimmed) continue;
      targets[buildCellKey(rowIndex, columnIndex)] = trimmed;
    }
  }
  return targets;
};

export default function AddRequestedProductsModal({ offerId, onClose, onImported, pricingPolicyName }: Props) {
  const { cardRef: setCardRef, cardStyle: dragCardStyle, headerProps: dragHeaderProps, resizeHandles } = useModalDragResize({ draggable: true, resizable: true });
  const [file, setFile] = useState<File | null>(null);
  const [fileValidation, setFileValidation] = useState<FileValidation>(INITIAL_VALIDATION);
  const [pasteText, setPasteText] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const validationRunId = useRef(0);
  const [showSheetSelector, setShowSheetSelector] = useState(false);
  const [multiSelectEnabled, setMultiSelectEnabled] = useState(false);
  const [manualRows, setManualRows] = useState<PayloadRow[]>([]);
  const [manualRow, setManualRow] = useState<PayloadRow>({});
  const [existingItemNos, setExistingItemNos] = useState<Set<string>>(new Set());

  // EP LINC offers: the uploaded workbook follows the EP LINC request template,
  // so map its columns by exact header name and prefer its known product sheet.
  const isEpLinc = useMemo(() => isEpLincPricingPolicy(pricingPolicyName), [pricingPolicyName]);
  const requestColumnMap = useMemo(() => (isEpLinc ? EP_LINC_REQUEST_HEADER_MAP : null), [isEpLinc]);
  const preferredSheetName = useMemo(() => (isEpLinc ? EP_LINC_REQUEST_SHEET_NAME : null), [isEpLinc]);

  const applySheets = useCallback((sheets: SheetMapping[]) => {
    let normalizedSheets = sheets.map(enrichSheet);

    let activeIndex = 0;
    if (normalizedSheets.length > 1) {
      // Prefer the template's named sheet (e.g. EP LINC -> "Request_List_Supplies")
      // so the auto-mapped columns are on the active sheet; otherwise fall back
      // to the largest sheet.
      const preferredIndex = preferredSheetName
        ? normalizedSheets.findIndex((sheet) => sheet.name.trim().toLowerCase() === preferredSheetName)
        : -1;
      if (preferredIndex >= 0) {
        activeIndex = preferredIndex;
      } else {
        let biggestRowCount = -1;
        normalizedSheets.forEach((sheet, idx) => {
          if (sheet.rowCount > biggestRowCount) {
            biggestRowCount = sheet.rowCount;
            activeIndex = idx;
          }
        });
      }
      normalizedSheets = normalizedSheets.map((sheet, idx) => ({
        ...sheet,
        enabled: idx === activeIndex,
      }));
    }

    const evaluation = evaluateSelection(normalizedSheets, activeIndex);
    setFileValidation({
      status: evaluation.status,
      message: evaluation.message,
      columns: evaluation.columns,
      rowCount: evaluation.rowCount,
      sheets: normalizedSheets,
      activeSheetIndex: activeIndex,
    });

    if (normalizedSheets.length > 1) {
      setShowSheetSelector(true);
    }
  }, [preferredSheetName]);

  const activeSheet = useMemo(
    () => fileValidation.sheets[fileValidation.activeSheetIndex] ?? null,
    [fileValidation.activeSheetIndex, fileValidation.sheets],
  );

  const previewColumns = useMemo(() => {
    if (!activeSheet) return [];
    return COLUMN_DISPLAY
      .map((col) => {
        const columnIndex = activeSheet.selection[col.key];
        if (columnIndex == null) return null;
        return { key: col.key, label: col.label, columnIndex };
      })
      .filter((col): col is { key: HeaderColumnKey; label: string; columnIndex: number } => col !== null);
  }, [activeSheet]);

  const previewRows = useMemo(() => {
    if (!activeSheet) return [];
    return getSheetDataRows(activeSheet)
      .filter((row) => Array.isArray(row) && row.some(hasCellValue))
      .slice(0, 3)
      .map((row) => {
        const preview: Record<number, string> = {};
        (row as unknown[]).forEach((cell, idx) => {
          if (cell != null) {
            const str = typeof cell === 'string' ? cell.trim() : String(cell);
            if (str) preview[idx] = str;
          }
        });
        return preview;
      });
  }, [activeSheet]);

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

  const toggleIncludeHeaderRow = useCallback((include: boolean) => {
    setFileValidation((prev) => {
      const sheets = prev.sheets.map((sheet, idx) => {
        if (idx !== prev.activeSheetIndex) return sheet;

        const headerRow = Array.isArray(sheet.rawRows[sheet.headerRowIndex])
          ? (sheet.rawRows[sheet.headerRowIndex] as unknown[])
          : [];
        const columnCount = Math.max(determineColumnCount(sheet.rawRows), headerRow.length);

        let columns: ColumnOption[];
        let suggestions: Record<HeaderColumnKey, ColumnOption[]>;

        if (include) {
          const baseColumns = columnCount > 0 ? buildColumns(headerRow, columnCount) : [];
          columns = baseColumns.filter((col) => columnHasValue(sheet.rawRows, headerRow, col.index));
          suggestions = buildSuggestions(columns, requestColumnMap);
        } else {
          const emptyRow: unknown[] = Array.from({ length: columnCount }, () => null);
          const baseColumns = columnCount > 0 ? buildColumns(emptyRow, columnCount) : [];
          columns = baseColumns.filter((col) => columnHasValue(sheet.rawRows, emptyRow, col.index));
          suggestions = buildSuggestions(columns, requestColumnMap);
        }

        // Preserve existing column selections where the index is still valid
        const validIndexes = new Set(columns.map((c) => c.index));
        const selection: Partial<Record<HeaderColumnKey, number | null>> = {};
        for (const [key, value] of Object.entries(sheet.selection)) {
          if (value != null && validIndexes.has(value as number)) {
            selection[key as HeaderColumnKey] = value as number;
          }
        }

        const updatedSheet: SheetMapping = {
          ...sheet,
          includeHeaderRow: include,
          columns,
          suggestions,
          selection,
        };
        return enrichSheet(updatedSheet);
      });

      const evaluation = evaluateSelection(sheets, prev.activeSheetIndex);
      return { ...prev, ...evaluation, sheets };
    });
  }, [requestColumnMap]);

  const updateManualRowField = useCallback((key: HeaderColumnKey, value: string) => {
    setManualRow((prev) => ({ ...prev, [key]: value || null }));
  }, []);

  const manualItemNoConflict = useMemo(() => {
    const raw = ((manualRow.itemNo as string) ?? '').trim().replace(/\s+/g, '');
    if (!raw) return false;
    return existingItemNos.has(raw);
  }, [manualRow.itemNo, existingItemNos]);

  const addManualRow = useCallback(() => {
    if (!hasPayloadValues(manualRow)) return;
    if (manualItemNoConflict) return;
    setManualRows((prev) => [...prev, manualRow]);
    setManualRow({});
  }, [manualRow, manualItemNoConflict]);

  const removeManualRow = useCallback((index: number) => {
    setManualRows((prev) => prev.filter((_, i) => i !== index));
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
      .then(async (buffer) => {
        if (runId !== validationRunId.current) return;
        let sheets: SheetMapping[] = [];
        try {
          const xlsx = await loadXlsx();
          const workbook = xlsx.read(buffer, { type: 'array' });
          sheets = analyzeWorkbook(workbook, xlsx, requestColumnMap);
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
  }, [applySheets, requestColumnMap]);

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
    const sheet = analyzeSheet('Pasted data', rows, 0, true, {}, requestColumnMap);
    applySheets([sheet]);
    setFile(null);
    setError(null);
  }, [applySheets, requestColumnMap]);

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
      const startIndex = sheet.includeHeaderRow ? sheet.headerRowIndex + 1 : sheet.headerRowIndex;
      const dataRows = getSheetDataRows(sheet);
      dataRows.forEach((row, rowOffset) => {
        if (!Array.isArray(row)) return;
        const getCell = (index: number | null | undefined) => (typeof index === 'number' ? row[index] : null);
        const getHyperlink = (index: number | null | undefined) => {
          if (typeof index !== 'number') return null;
          const absoluteRowIndex = startIndex + rowOffset;
          return sheet.hyperlinkTargets[buildCellKey(absoluteRowIndex, index)] ?? null;
        };
        const itemNo = normalizeCellText(getCell(selection.itemNo ?? null));
        const brand = normalizeCellText(getCell(selection.brand ?? null));
        const modelNumber = normalizeCellText(getCell(selection.modelNumber ?? null));
        const partNumber = normalizeCellText(getCell(selection.partNumber ?? null));
        const webLink = normalizeCellText(getHyperlink(selection.webLink ?? null) ?? getCell(selection.webLink ?? null));
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
          webLink,
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
    manualRows.forEach((row) => {
      if (hasPayloadValues(row)) payload.push(row);
    });
    return payload;
  }, [fileValidation.sheets, manualRows]);

  const handleImport = useCallback(async () => {
    setError(null);
    if (fileValidation.status === 'checking') {
      setError('Please wait for the file analysis to finish.');
      return;
    }
    const hasSheetData = fileValidation.status === 'valid' && fileValidation.sheets.length > 0;
    const hasManualData = manualRows.length > 0;
    if (!hasSheetData && !hasManualData) {
      setError('Provide data via paste, file upload, or add rows manually before importing.');
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
    manualRows.length,
    offerId,
    onClose,
    onImported,
  ]);

  const overlayPointerDownOnOverlayRef = useRef(false);

  const handleOverlayPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    overlayPointerDownOnOverlayRef.current = event.target === event.currentTarget;
  }, []);

  const handleOverlayClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const shouldClose =
      overlayPointerDownOnOverlayRef.current && event.target === event.currentTarget;
    overlayPointerDownOnOverlayRef.current = false;
    if (!shouldClose) return;
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

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/offers/${encodeURIComponent(offerId)}/products/requested`)
      .then((res) => res.json())
      .then((data: { ok?: boolean; itemNos?: string[] }) => {
        if (cancelled || !data?.ok) return;
        setExistingItemNos(new Set((data.itemNos ?? []).map((v) => v.trim().replace(/\s+/g, ''))));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [offerId]);

  const statusTitle = fileValidation.status === 'valid'
    ? 'Workbook ready'
    : fileValidation.status === 'invalid'
      ? 'Select the columns'
      : fileValidation.status === 'checking'
        ? 'Checking workbook'
        : 'Waiting for a file';

  const statusMessage = fileValidation.message
    ?? 'Pick the columns you want to import. None of them are mandatory.';

  const canSubmit = (fileValidation.status === 'valid' || manualRows.length > 0) && !submitting;

  return (
    <>
    <div className={styles.overlay} onPointerDown={handleOverlayPointerDown} onClick={handleOverlayClick}>
      <div ref={setCardRef} className={styles.card} role="dialog" aria-modal="true" aria-label="Add requested products" onClick={(event) => event.stopPropagation()} style={dragCardStyle}>
        <div className={styles.header} onPointerDown={dragHeaderProps.onPointerDown} onDoubleClick={dragHeaderProps.onDoubleClick} style={dragHeaderProps.style}>
          <div className={styles.headerText}>
            <div className={styles.title}>Add Requested Products</div>
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
                accept=".xlsx,.xlsm,.xls,.csv"
                className={styles.fileInput}
                onChange={handleFileChange}
              />
              <div className={styles.uploadTitle}>{file ? 'Replace file' : 'Drop Excel file or click to browse'}</div>
              <div className={styles.uploadSubtitle}>Supported formats: .xlsx, .xlsm, .xls, .csv</div>
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
                placeholder="Item No	Brand	Model No	Part No	Web Link	Description	Description 2	Description 3	Quantity"
                className={styles.pasteTextarea}
              />
            </div>
            {fileValidation.sheets.length > 0 ? (
              <>
                {fileValidation.sheets.length > 1 ? (
                  <div className={styles.sheetToggle}>
                    <span>Multi-select</span>
                    <button
                      type="button"
                      className={`${styles.toggleSwitch} ${multiSelectEnabled ? styles.toggleSwitchOn : ''}`}
                      onClick={() => setMultiSelectEnabled((prev) => !prev)}
                    >
                      <span className={styles.toggleKnob} />
                    </button>
                  </div>
                ) : null}
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
                        onClick={() => {
                          if (!multiSelectEnabled && fileValidation.sheets.length > 1) {
                            setFileValidation((prev) => {
                              const sheets = prev.sheets.map((s, i) => ({ ...s, enabled: i === idx }));
                              const evaluation = evaluateSelection(sheets, idx);
                              return { ...prev, ...evaluation, sheets, activeSheetIndex: idx };
                            });
                          } else {
                            handleSheetChange(idx);
                          }
                        }}
                      >
                        {multiSelectEnabled && fileValidation.sheets.length > 1 ? (
                          <input
                            type="checkbox"
                            checked={included}
                            className={styles.sheetTabCheckbox}
                            onChange={(e) => {
                              e.stopPropagation();
                              toggleSheetEnabled(idx, e.target.checked);
                            }}
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : null}
                        {sheet.name || `Sheet ${idx + 1}`}
                        <span className={styles.sheetTabRows}>{sheet.rowCount} rows</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : null}
            {activeSheet ? (
              <>
                <div className={styles.headerRowToggle}>
                  <span>First row contains column headers</span>
                  <button
                    type="button"
                    className={`${styles.toggleSwitch} ${activeSheet.includeHeaderRow ? styles.toggleSwitchOn : ''}`}
                    onClick={() => toggleIncludeHeaderRow(!activeSheet.includeHeaderRow)}
                  >
                    <span className={styles.toggleKnob} />
                  </button>
                </div>
                <div className={styles.helpText}>
                  <strong>{activeSheet.name || 'Sheet'}</strong> - Select the corresponding column for each field.{activeSheet.includeHeaderRow ? ' Suggested matches appear at the top.' : ''}
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
                {previewColumns.length > 0 && previewRows.length > 0 ? (
                  <div className={styles.previewSection}>
                    <div className={styles.previewHeading}>
                      <span>Sample rows (first {previewRows.length})</span>
                      <span className={styles.previewHint}>Showing mapped columns only.</span>
                    </div>
                    <div className={styles.previewTableWrapper}>
                      <table className={styles.previewTable}>
                        <thead>
                          <tr>
                            {previewColumns.map((col) => (
                              <th key={col.key}>{col.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {previewRows.map((row, rowIdx) => (
                            <tr key={rowIdx}>
                              {previewColumns.map((col) => (
                                <td key={col.key}>{row[col.columnIndex] ?? ''}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </>
            ) : null}
            <div className={styles.manualEntryCard}>
              <div className={styles.manualEntryHeader}>
                <div className={styles.manualEntryTitle}>Add rows manually</div>
                <div className={styles.manualEntryDescription}>Fill in the fields below and click &quot;Add row&quot; to append a row.</div>
              </div>
              <div className={styles.manualEntryFields}>
                {COLUMN_DISPLAY.map((col) => {
                  const itemNoValue = col.key === 'itemNo' ? ((manualRow.itemNo as string) ?? '').trim().replace(/\s+/g, '') : '';
                  const itemNoExists = col.key === 'itemNo' && itemNoValue !== '' && existingItemNos.has(itemNoValue);
                  return (
                    <label key={col.key} className={styles.manualEntryField}>
                      <span className={styles.manualEntryFieldLabel}>{col.label}</span>
                      <input
                        type={col.key === 'quantity' ? 'number' : 'text'}
                        className={`${styles.manualEntryInput} ${itemNoExists ? styles.manualEntryInputWarning : ''}`}
                        value={(manualRow[col.key] as string) ?? ''}
                        onChange={(e) => updateManualRowField(col.key, e.target.value)}
                        placeholder={col.label}
                        onKeyDown={(e) => { if (e.key === 'Enter') addManualRow(); }}
                      />
                      {itemNoExists ? (
                        <span className={styles.manualEntryWarning}>Item {itemNoValue} already exists - use a different number</span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                className={styles.addRowButton}
                onClick={addManualRow}
                disabled={!hasPayloadValues(manualRow) || manualItemNoConflict}
              >
                + Add row
              </button>
              {manualRows.length > 0 ? (
                <div className={styles.manualRowsList}>
                  <div className={styles.manualRowsCount}>{manualRows.length} manual row{manualRows.length === 1 ? '' : 's'}</div>
                  {manualRows.map((row, idx) => {
                    const summary = [row.brand, row.modelNumber, row.partNumber, row.description]
                      .filter(Boolean)
                      .join(' - ');
                    return (
                      <div key={idx} className={styles.manualRowItem}>
                        <span className={styles.manualRowIndex}>{idx + 1}</span>
                        <span className={styles.manualRowSummary}>{summary || 'Row'}</span>
                        {row.quantity != null && row.quantity !== '' ? <span className={styles.manualRowQty}>×{row.quantity}</span> : null}
                        <button
                          type="button"
                          className={styles.manualRowRemove}
                          onClick={() => removeManualRow(idx)}
                          aria-label="Remove row"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
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
        {resizeHandles}
      </div>
    </div>
    {showSheetSelector && fileValidation.sheets.length > 1 ? (
      <div className={styles.sheetSelectorOverlay}>
        <div className={styles.sheetSelectorPopup} onClick={(e) => e.stopPropagation()}>
          <div className={styles.sheetSelectorHeader}>
            <div className={styles.sheetSelectorTitle}>Sheet Selection</div>
            <button
              type="button"
              className={styles.sheetSelectorClose}
              aria-label="Close dialog"
              onClick={() => setShowSheetSelector(false)}
            >
              ×
            </button>
          </div>
          <div className={styles.sheetSelectorDescription}>
            {`I have found ${fileValidation.sheets.length} sheets. Please select the appropriate sheet or multiple ones, after you close this window.`}
          </div>
          <div className={styles.sheetSelectorList}>
            {fileValidation.sheets.map((sheet, idx) => {
              const selected = sheet.enabled;
              return (
                <div
                  key={sheet.name || idx}
                  className={`${styles.sheetSelectorItem} ${selected ? styles.sheetSelectorItemSelected : ''}`}
                >
                  <span className={styles.sheetSelectorItemName}>{sheet.name || `Sheet ${idx + 1}`}</span>
                  <span className={styles.sheetSelectorItemRows}>{sheet.rowCount} rows</span>
                </div>
              );
            })}
          </div>
          {(() => {
            const enabled = fileValidation.sheets.filter((s) => s.enabled);
            if (enabled.length === 1) {
              const matchedPreferred = preferredSheetName != null
                && enabled[0].name.trim().toLowerCase() === preferredSheetName;
              const reason = matchedPreferred ? 'matched template' : 'largest sheet';
              return (
                <div className={styles.sheetSelectorDescription}>
                  {'Auto-selected '}
                  <strong>{enabled[0].name}</strong>
                  {` with ${enabled[0].rowCount} rows (${reason}).`}
                </div>
              );
            }
            return null;
          })()}
        </div>
      </div>
    ) : null}
    </>
  );
}
