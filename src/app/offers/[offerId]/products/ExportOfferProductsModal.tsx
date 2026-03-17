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
import type { OfferProductsTemplateExportRow } from '../OfferProductsPanel';

type XlsxModule = typeof import('xlsx');

const loadXlsx = () => import('xlsx');

type Props = {
  onClose: () => void;
  onRequestRows: () => Promise<OfferProductsTemplateExportRow[]>;
};

type ExportFieldKey =
  | 'no'
  | 'productReference'
  | 'manufacturer'
  | 'descriptionType'
  | 'qty'
  | 'unitPrice'
  | 'delayForDelivery'
  | 'comments';

type ExportFieldConfig = {
  key: ExportFieldKey;
  label: string;
  keywords: string[];
};

type ColumnOption = {
  index: number;
  label: string;
  normalized: string;
};

type SheetMapping = {
  name: string;
  headerRowIndex: number;
  columns: ColumnOption[];
  suggestions: Record<ExportFieldKey, ColumnOption[]>;
  selection: Partial<Record<ExportFieldKey, number | null>>;
  rowCount: number;
  rawRows: unknown[][];
};

type ValidationState = {
  status: 'idle' | 'checking' | 'valid' | 'invalid';
  message: string | null;
  sheets: SheetMapping[];
  activeSheetIndex: number;
  mappedColumnCount: number;
};

const EXPORT_FIELDS: ExportFieldConfig[] = [
  { key: 'no', label: 'No', keywords: ['no', 'item no', 'item', 'tree', 'ordering'] },
  { key: 'productReference', label: 'Product reference', keywords: ['product reference', 'part number', 'part no', 'reference', 'sku'] },
  { key: 'manufacturer', label: 'Manufacturer', keywords: ['manufacturer', 'brand', 'maker'] },
  { key: 'descriptionType', label: 'Description / Type', keywords: ['description / type', 'description', 'type', 'model', 'details'] },
  { key: 'qty', label: 'Qty', keywords: ['qty', 'quantity', 'pcs', 'pieces'] },
  { key: 'unitPrice', label: 'Unit price (RRP / Euro)', keywords: ['unit price', 'rrp', 'price', 'net unit price', 'euro'] },
  { key: 'comments', label: 'Comments', keywords: ['comments', 'comment', 'notes', 'remarks'] },
];

const INITIAL_VALIDATION: ValidationState = {
  status: 'idle',
  message: null,
  sheets: [],
  activeSheetIndex: 0,
  mappedColumnCount: 0,
};

const normalizeHeaderText = (value: unknown): string | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const raw = typeof value === 'number' ? String(value) : value;
  const normalized = raw.trim().toLowerCase();
  return normalized || null;
};

const hasCellValue = (value: unknown) => {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return true;
};

const ALL_EXPORT_KEYWORDS: string[] = EXPORT_FIELDS.flatMap((field) =>
  field.keywords.map((keyword) => keyword.toLowerCase()),
);

const detectHeaderRowIndex = (rows: unknown[][]): number => {
  let bestIndex = 0;
  let bestScore = -1;
  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    let keywordMatches = 0;
    let filledCells = 0;
    for (let colIdx = 0; colIdx < row.length; colIdx += 1) {
      if (!hasCellValue(row[colIdx])) continue;
      filledCells += 1;
      const normalized = normalizeHeaderText(row[colIdx]);
      if (normalized != null && ALL_EXPORT_KEYWORDS.some((kw) => normalized.includes(kw))) {
        keywordMatches += 1;
      }
    }
    // Heavily prefer rows that match export field keywords.
    // Each keyword match is worth 100 points; filled cells count as 1 point each
    // to break ties.
    const score = keywordMatches * 100 + filledCells;
    if (score > bestScore) {
      bestScore = score;
      bestIndex = idx;
    }
  }
  return bestIndex;
};

const determineColumnCount = (rows: unknown[][]): number => {
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

const columnHasAnyValue = (rows: unknown[][], headerRow: unknown[], columnIndex: number) => {
  const headerValue = columnIndex < headerRow.length ? headerRow[columnIndex] : null;
  if (hasCellValue(headerValue)) return true;
  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const value = columnIndex < row.length ? row[columnIndex] : null;
    if (hasCellValue(value)) return true;
  }
  return false;
};

const buildColumns = (rows: unknown[][], headerRowIndex: number): ColumnOption[] => {
  const headerRow = Array.isArray(rows[headerRowIndex]) ? rows[headerRowIndex] : [];
  const columnCount = Math.max(determineColumnCount(rows), headerRow.length);
  const columns: ColumnOption[] = [];
  for (let idx = 0; idx < columnCount; idx += 1) {
    if (!columnHasAnyValue(rows, headerRow, idx)) continue;
    const headerCell = idx < headerRow.length ? headerRow[idx] : null;
    const normalized = normalizeHeaderText(headerCell) ?? '';
    const label = typeof headerCell === 'string' && headerCell.trim().length > 0
      ? headerCell.trim()
      : typeof headerCell === 'number'
        ? String(headerCell)
        : `Column ${idx + 1}`;
    columns.push({ index: idx, label, normalized });
  }
  return columns;
};

const buildSuggestions = (columns: ColumnOption[]): Record<ExportFieldKey, ColumnOption[]> => {
  const suggestions = {} as Record<ExportFieldKey, ColumnOption[]>;
  EXPORT_FIELDS.forEach((field) => {
    const keywords = field.keywords.map((keyword) => keyword.toLowerCase());
    suggestions[field.key] = columns.filter((column) =>
      keywords.some((keyword) => column.normalized.includes(keyword)),
    );
  });
  return suggestions;
};

const autoSelectUniqueSuggestions = (
  suggestions: Record<ExportFieldKey, ColumnOption[]>,
): Partial<Record<ExportFieldKey, number | null>> => {
  const selected: Partial<Record<ExportFieldKey, number | null>> = {};
  const usedColumns = new Set<number>();
  EXPORT_FIELDS.forEach((field) => {
    const match = (suggestions[field.key] ?? []).find((option) => !usedColumns.has(option.index));
    if (!match) return;
    selected[field.key] = match.index;
    usedColumns.add(match.index);
  });
  return selected;
};

const countDataRows = (rows: unknown[][], headerRowIndex: number): number => {
  const startRow = headerRowIndex + 1;
  let count = 0;
  for (let idx = startRow; idx < rows.length; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    if (row.some(hasCellValue)) count += 1;
  }
  return count;
};

const findFirstWritableRowFromParsedRows = (sheet: SheetMapping): number => {
  // Start writing immediately after the header row. Template rows may contain
  // placeholders (row numbers, formulas, formatting) that should be overwritten.
  return Math.max(sheet.headerRowIndex + 1, 0) + 1;
};

const analyzeSheet = (name: string, rows: unknown[][], fallbackIndex: number): SheetMapping => {
  const headerRowIndex = detectHeaderRowIndex(rows);
  const columns = buildColumns(rows, headerRowIndex);
  const suggestions = buildSuggestions(columns);
  const selection = autoSelectUniqueSuggestions(suggestions);
  const rowCount = countDataRows(rows, headerRowIndex);
  return {
    name: name || `Sheet ${fallbackIndex + 1}`,
    headerRowIndex,
    columns,
    suggestions,
    selection,
    rowCount,
    rawRows: rows,
  };
};

const analyzeWorkbook = (workbook: XLSXTypes.WorkBook, xlsx: XlsxModule): SheetMapping[] => {
  const sheets: SheetMapping[] = [];
  for (const sheetName of workbook.SheetNames ?? []) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;
    const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
    if (!Array.isArray(rows)) continue;
    sheets.push(analyzeSheet(sheetName, rows, sheets.length));
  }
  return sheets;
};

const evaluateValidation = (sheets: SheetMapping[], activeSheetIndex: number) => {
  const activeSheet = sheets[activeSheetIndex];
  if (!activeSheet) {
    return {
      status: 'invalid' as const,
      message: 'Upload a workbook to detect columns.',
      mappedColumnCount: 0,
    };
  }
  const mappedColumnCount = EXPORT_FIELDS.reduce((acc, field) => (
    activeSheet.selection[field.key] != null ? acc + 1 : acc
  ), 0);
  if (mappedColumnCount <= 0) {
    return {
      status: 'invalid' as const,
      message: 'Select at least one target column.',
      mappedColumnCount,
    };
  }
  return {
    status: 'valid' as const,
    message: `Mapped ${mappedColumnCount} column${mappedColumnCount === 1 ? '' : 's'} on ${activeSheet.name}.`,
    mappedColumnCount,
  };
};

const padExportRowsForAlignment = (
  rows: OfferProductsTemplateExportRow[],
): OfferProductsTemplateExportRow[] => {
  // Only pad when ALL rows have positive integer `no` values.
  // Falls back to unchanged sequential offset for hierarchical numbering (1.1, 1.2) or text.
  const allPositiveIntegers = rows.length > 0 && rows.every((row) =>
    typeof row.no === 'number' && Number.isInteger(row.no) && row.no >= 1,
  );
  if (!allPositiveIntegers) return rows;

  const maxNo = Math.max(...rows.map((row) => row.no as number));
  const byNo = new Map<number, OfferProductsTemplateExportRow>();
  for (const row of rows) {
    byNo.set(row.no as number, row);
  }

  const padded: OfferProductsTemplateExportRow[] = [];
  for (let n = 1; n <= maxNo; n++) {
    const existing = byNo.get(n);
    if (existing) {
      padded.push(existing);
    } else {
      padded.push({
        no: n, productReference: '', manufacturer: '', descriptionType: '',
        qty: '', unitPrice: '', delayForDelivery: '', comments: '', skipRow: true,
      });
    }
  }
  return padded;
};

const resolveFieldValue = (
  row: OfferProductsTemplateExportRow,
  fieldKey: ExportFieldKey,
): string | number | null => {
  switch (fieldKey) {
    case 'no':
      return row.no;
    case 'productReference':
      return row.productReference;
    case 'manufacturer':
      return row.manufacturer;
    case 'descriptionType':
      return row.descriptionType;
    case 'qty':
      return row.qty === '' ? null : row.qty;
    case 'unitPrice':
      return row.unitPrice === '' ? null : row.unitPrice;
    case 'comments':
      return row.comments;
    default:
      return null;
  }
};

const formatPreviewValue = (value: string | number | null): string => {
  if (value == null) return '-';
  if (typeof value === 'number') return String(value);
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : '-';
};

const buildOutputFilename = (inputName: string, extension: 'xlsx' | 'xlsm' | 'xls'): string => {
  const baseName = inputName.replace(/\.[^.]+$/, '').trim() || 'template';
  return `${baseName}- Telmaco Offer.${extension}`;
};

const resolveWorkbookExtension = (fileName: string): 'xlsx' | 'xlsm' | 'xls' | null => {
  const normalized = fileName.trim().toLowerCase();
  if (normalized.endsWith('.xlsm')) return 'xlsm';
  if (normalized.endsWith('.xls')) return 'xls';
  if (normalized.endsWith('.xlsx')) return 'xlsx';
  return null;
};

const getWorkbookMimeType = (workbookType: 'xlsx' | 'xlsm' | 'xls') => {
  if (workbookType === 'xlsm') return 'application/vnd.ms-excel.sheet.macroEnabled.12';
  if (workbookType === 'xls') return 'application/vnd.ms-excel';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
};

const downloadWorkbookFile = (buffer: ArrayBuffer, fileName: string, workbookType: 'xlsx' | 'xlsm' | 'xls') => {
  const blob = new Blob([buffer], { type: getWorkbookMimeType(workbookType) });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.setAttribute('download', fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const columnIndexToLetters = (columnIndex: number): string => {
  let value = columnIndex + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
};

const columnLettersToIndex = (letters: string): number => {
  let result = 0;
  const normalized = letters.toUpperCase();
  for (let idx = 0; idx < normalized.length; idx += 1) {
    const code = normalized.charCodeAt(idx);
    if (code < 65 || code > 90) return -1;
    result = (result * 26) + (code - 64);
  }
  return result - 1;
};

const parseCellReference = (value: string | null | undefined): { row: number; col: number } | null => {
  if (!value) return null;
  const match = /^([A-Za-z]+)(\d+)$/.exec(value.trim());
  if (!match) return null;
  const col = columnLettersToIndex(match[1]);
  const row = Number.parseInt(match[2], 10);
  if (!Number.isFinite(col) || col < 0 || !Number.isFinite(row) || row <= 0) return null;
  return { row, col };
};

const normalizeZipPath = (basePath: string, relativeTarget: string): string => {
  const initial = relativeTarget.startsWith('/')
    ? relativeTarget.slice(1)
    : `${basePath.replace(/\/+$/, '')}/${relativeTarget.replace(/^\.?\//, '')}`;
  const segments = initial.split('/');
  const resolved: string[] = [];
  segments.forEach((segment) => {
    if (!segment || segment === '.') return;
    if (segment === '..') {
      resolved.pop();
      return;
    }
    resolved.push(segment);
  });
  return resolved.join('/');
};

const uniqueElements = <T extends Element>(elements: T[]): T[] => Array.from(new Set(elements));

type ZipArchiveLike = {
  file: (path: string) => { async: (type: 'string' | 'arraybuffer') => Promise<string | ArrayBuffer> } | null;
};

const resolveWorksheetXmlPath = async (
  archive: ZipArchiveLike,
  worksheetName: string,
): Promise<string> => {
  const workbookXmlFile = archive.file('xl/workbook.xml');
  if (!workbookXmlFile) {
    throw new Error('Workbook metadata (xl/workbook.xml) was not found.');
  }
  const workbookXml = await workbookXmlFile.async('string') as string;
  const workbookDoc = new DOMParser().parseFromString(workbookXml, 'application/xml');
  const workbookRoot = workbookDoc.documentElement;
  const relNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const allSheets = uniqueElements([
    ...(Array.from(workbookRoot.getElementsByTagNameNS('*', 'sheet')) as Element[]),
    ...(Array.from(workbookRoot.getElementsByTagName('sheet')) as Element[]),
  ]);
  const sheetElement = allSheets.find((element) => element.getAttribute('name') === worksheetName);
  if (!sheetElement) {
    throw new Error(`Worksheet "${worksheetName}" was not found in workbook metadata.`);
  }
  const relationshipId =
    sheetElement.getAttributeNS(relNs, 'id')
    ?? sheetElement.getAttribute('r:id')
    ?? sheetElement.getAttribute('id');
  if (!relationshipId) {
    throw new Error(`Worksheet "${worksheetName}" is missing relationship ID.`);
  }

  const relationshipsXmlFile = archive.file('xl/_rels/workbook.xml.rels');
  if (!relationshipsXmlFile) {
    throw new Error('Workbook relationships (xl/_rels/workbook.xml.rels) were not found.');
  }
  const relationshipsXml = await relationshipsXmlFile.async('string') as string;
  const relationshipsDoc = new DOMParser().parseFromString(relationshipsXml, 'application/xml');
  const relationshipElements = Array.from(relationshipsDoc.documentElement.getElementsByTagName('Relationship'));
  const relationship = relationshipElements.find((element) => element.getAttribute('Id') === relationshipId);
  if (!relationship) {
    throw new Error(`Worksheet relationship "${relationshipId}" was not found.`);
  }
  const target = relationship.getAttribute('Target');
  if (!target) {
    throw new Error(`Worksheet relationship "${relationshipId}" has no target path.`);
  }
  return normalizeZipPath('xl', target);
};

type SheetXmlPatchResult = {
  sheetXml: string;
  startRow: number;
  mappedColumnCount: number;
};

const patchWorksheetXmlWithAppendedRows = (
  sheetXml: string,
  mapping: SheetMapping,
  rows: OfferProductsTemplateExportRow[],
): SheetXmlPatchResult => {
  const selectedMappings = EXPORT_FIELDS
    .map((field) => {
      const columnIndex = mapping.selection[field.key];
      return typeof columnIndex === 'number' ? { field, columnIndex } : null;
    })
    .filter((entry): entry is { field: ExportFieldConfig; columnIndex: number } => entry != null)
    .sort((a, b) => a.columnIndex - b.columnIndex);

  if (selectedMappings.length === 0) {
    throw new Error('No columns selected for export.');
  }

  const xmlDoc = new DOMParser().parseFromString(sheetXml, 'application/xml');
  if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Unable to parse worksheet XML.');
  }
  const worksheetElement = xmlDoc.documentElement;
  const ns = worksheetElement.namespaceURI ?? 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const sheetDataElement = worksheetElement.getElementsByTagNameNS(ns, 'sheetData')[0]
    ?? worksheetElement.getElementsByTagName('sheetData')[0];
  if (!sheetDataElement) {
    throw new Error('Worksheet XML is missing sheetData.');
  }

  const dataStartRow = Math.max(mapping.headerRowIndex + 2, 1);
  const rowElements = uniqueElements((
    Array.from(sheetDataElement.getElementsByTagNameNS(ns, 'row')) as Element[]
  ).concat(Array.from(sheetDataElement.getElementsByTagName('row')) as Element[]));
  const rowByIndex = new Map<number, Element>();
  let maxRowIndex = 0;

  rowElements.forEach((rowElement) => {
    const parsed = Number.parseInt(rowElement.getAttribute('r') ?? '', 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      rowByIndex.set(parsed, rowElement);
      maxRowIndex = Math.max(maxRowIndex, parsed);
    }
  });

  const templateRowElement = rowByIndex.get(dataStartRow) ?? null;
  const templateRowAttributes: Array<{ name: string; value: string }> = [];
  if (templateRowElement) {
    Array.from(templateRowElement.attributes).forEach((attribute) => {
      if (attribute.name === 'r' || attribute.name === 'spans') return;
      templateRowAttributes.push({ name: attribute.name, value: attribute.value });
    });
  }

  const styleByColumn = new Map<number, string>();
  if (templateRowElement) {
    const templateCells = uniqueElements((
      Array.from(templateRowElement.getElementsByTagNameNS(ns, 'c')) as Element[]
    ).concat(Array.from(templateRowElement.getElementsByTagName('c')) as Element[]));
    templateCells.forEach((cellElement) => {
      const parsedRef = parseCellReference(cellElement.getAttribute('r'));
      if (!parsedRef) return;
      const styleId = cellElement.getAttribute('s');
      if (styleId == null) return;
      styleByColumn.set(parsedRef.col, styleId);
    });
  }

  // Start writing at the first row after the header. Template rows may contain
  // placeholders (row numbers, formulas, formatting) that should be overwritten.
  const startRow = dataStartRow;
  if (rows.length === 0) {
    return {
      sheetXml,
      startRow,
      mappedColumnCount: selectedMappings.length,
    };
  }

  const directSheetRows = uniqueElements(
    Array.from(sheetDataElement.childNodes)
      .filter((node) => node.nodeType === Node.ELEMENT_NODE)
      .map((node) => node as Element)
      .filter((element) => element.localName === 'row' || element.nodeName.endsWith(':row') || element.nodeName === 'row'),
  );

  const insertRowElementSorted = (rowElement: Element, rowIndex: number) => {
    const nextRow = directSheetRows.find((candidate) => {
      const parsed = Number.parseInt(candidate.getAttribute('r') ?? '', 10);
      return Number.isFinite(parsed) && parsed > rowIndex;
    });
    if (nextRow?.parentNode) {
      nextRow.parentNode.insertBefore(rowElement, nextRow);
    } else {
      sheetDataElement.appendChild(rowElement);
    }
    directSheetRows.push(rowElement);
    directSheetRows.sort((left, right) => {
      const leftIndex = Number.parseInt(left.getAttribute('r') ?? '', 10) || 0;
      const rightIndex = Number.parseInt(right.getAttribute('r') ?? '', 10) || 0;
      return leftIndex - rightIndex;
    });
  };

  const getOrCreateRowElement = (rowIndex: number): Element => {
    const existing = rowByIndex.get(rowIndex);
    if (existing) return existing;
    const created = xmlDoc.createElementNS(ns, 'row');
    created.setAttribute('r', String(rowIndex));
    templateRowAttributes.forEach((attribute) => {
      created.setAttribute(attribute.name, attribute.value);
    });
    insertRowElementSorted(created, rowIndex);
    rowByIndex.set(rowIndex, created);
    return created;
  };

  const getDirectRowCells = (rowElement: Element): Element[] => uniqueElements(
    Array.from(rowElement.childNodes)
      .filter((node) => node.nodeType === Node.ELEMENT_NODE)
      .map((node) => node as Element)
      .filter((element) => element.localName === 'c' || element.nodeName.endsWith(':c') || element.nodeName === 'c'),
  );

  const insertCellElementSorted = (rowElement: Element, cellElement: Element, columnIndex: number) => {
    const currentCells = getDirectRowCells(rowElement);
    const nextCell = currentCells.find((candidate) => {
      const parsed = parseCellReference(candidate.getAttribute('r'));
      return parsed != null && parsed.col > columnIndex;
    });
    if (nextCell?.parentNode) {
      nextCell.parentNode.insertBefore(cellElement, nextCell);
    } else {
      rowElement.appendChild(cellElement);
    }
  };

  const getOrCreateCellElement = (rowElement: Element, rowIndex: number, columnIndex: number): Element => {
    const existing = getDirectRowCells(rowElement).find((cellElement) => {
      const parsed = parseCellReference(cellElement.getAttribute('r'));
      return parsed != null && parsed.col === columnIndex;
    });
    if (existing) {
      existing.setAttribute('r', `${columnIndexToLetters(columnIndex)}${rowIndex}`);
      return existing;
    }
    const created = xmlDoc.createElementNS(ns, 'c');
    created.setAttribute('r', `${columnIndexToLetters(columnIndex)}${rowIndex}`);
    insertCellElementSorted(rowElement, created, columnIndex);
    return created;
  };

  const clearCellContents = (cellElement: Element) => {
    while (cellElement.firstChild) {
      cellElement.removeChild(cellElement.firstChild);
    }
    cellElement.removeAttribute('t');
  };

  rows.forEach((row, rowOffset) => {
    const rowIndex = startRow + rowOffset;
    if (row.skipRow) return;
    const rowElement = getOrCreateRowElement(rowIndex);
    selectedMappings.forEach(({ field, columnIndex }) => {
      const value = resolveFieldValue(row, field.key);
      const cellElement = getOrCreateCellElement(rowElement, rowIndex, columnIndex);
      clearCellContents(cellElement);
      const styleId = cellElement.getAttribute('s') ?? styleByColumn.get(columnIndex) ?? null;
      if (styleId != null && styleId !== '') {
        cellElement.setAttribute('s', styleId);
      }
      if (value == null || value === '') {
        cellElement.setAttribute('t', 'inlineStr');
        const inlineStringElement = xmlDoc.createElementNS(ns, 'is');
        const textElement = xmlDoc.createElementNS(ns, 't');
        textElement.textContent = '';
        inlineStringElement.appendChild(textElement);
        cellElement.appendChild(inlineStringElement);
      } else if (typeof value === 'number' && Number.isFinite(value)) {
        const valueElement = xmlDoc.createElementNS(ns, 'v');
        valueElement.textContent = String(value);
        cellElement.appendChild(valueElement);
      } else {
        const text = String(value);
        cellElement.setAttribute('t', 'inlineStr');
        const inlineStringElement = xmlDoc.createElementNS(ns, 'is');
        const textElement = xmlDoc.createElementNS(ns, 't');
        if (text.trim() !== text) {
          textElement.setAttribute('xml:space', 'preserve');
        }
        textElement.textContent = text;
        inlineStringElement.appendChild(textElement);
        cellElement.appendChild(inlineStringElement);
      }
    });
  });

  const firstSelectedColumn = Math.min(...selectedMappings.map((entry) => entry.columnIndex));
  const lastSelectedColumn = Math.max(...selectedMappings.map((entry) => entry.columnIndex));
  const lastWrittenRow = startRow + Math.max(rows.length - 1, 0);
  const dimensionElement = worksheetElement.getElementsByTagNameNS(ns, 'dimension')[0]
    ?? worksheetElement.getElementsByTagName('dimension')[0];
  const currentRef = dimensionElement?.getAttribute('ref') ?? '';
  const refParts = currentRef.includes(':') ? currentRef.split(':', 2) : [currentRef, currentRef];
  const currentStart = parseCellReference(refParts[0] ?? null);
  const currentEnd = parseCellReference(refParts[1] ?? null);
  const minCol = Math.min(currentStart?.col ?? firstSelectedColumn, firstSelectedColumn);
  const minRow = Math.min(currentStart?.row ?? 1, 1);
  const maxCol = Math.max(currentEnd?.col ?? lastSelectedColumn, lastSelectedColumn);
  const maxRow = Math.max(currentEnd?.row ?? lastWrittenRow, lastWrittenRow);
  const nextRef = `${columnIndexToLetters(minCol)}${minRow}:${columnIndexToLetters(maxCol)}${maxRow}`;
  if (dimensionElement) {
    dimensionElement.setAttribute('ref', nextRef);
  }

  const serialized = new XMLSerializer().serializeToString(xmlDoc);
  return {
    sheetXml: serialized,
    startRow,
    mappedColumnCount: selectedMappings.length,
  };
};

const applyRowsToSheet = (
  xlsx: XlsxModule,
  sheet: XLSXTypes.WorkSheet,
  mapping: SheetMapping,
  rows: OfferProductsTemplateExportRow[],
) => {
  const selectedMappings = EXPORT_FIELDS
    .map((field) => {
      const columnIndex = mapping.selection[field.key];
      return typeof columnIndex === 'number' ? { field, columnIndex } : null;
    })
    .filter((entry): entry is { field: ExportFieldConfig; columnIndex: number } => entry != null);

  if (selectedMappings.length === 0) {
    throw new Error('No columns selected for export.');
  }

  const dataStartRow = Math.max(mapping.headerRowIndex + 1, 0);
  const existingRef = typeof sheet['!ref'] === 'string' && sheet['!ref'].trim().length > 0 ? sheet['!ref'] : 'A1:A1';
  const range = xlsx.utils.decode_range(existingRef);
  // Start writing at the first row after the header. Template rows may contain
  // placeholders (row numbers, formulas, formatting) that should be overwritten.
  const startRow = dataStartRow;
  if (rows.length === 0) {
    return {
      startRow: startRow + 1,
      mappedColumnCount: selectedMappings.length,
    };
  }
  const clonedTemplateByColumn = new Map<number, XLSXTypes.CellObject | null>();

  const cloneCellBase = (cell: XLSXTypes.CellObject | null | undefined): XLSXTypes.CellObject => {
    const next: XLSXTypes.CellObject = cell ? { ...cell } : { t: 's' };
    const mutable = next as XLSXTypes.CellObject & {
      v?: unknown;
      w?: string;
      r?: string;
      h?: string;
      f?: string;
      F?: string;
      D?: boolean;
    };
    delete mutable.v;
    delete mutable.w;
    delete mutable.r;
    delete mutable.h;
    delete mutable.f;
    delete mutable.F;
    delete mutable.D;
    return next;
  };

  const getTemplateCellForColumn = (columnIndex: number): XLSXTypes.CellObject | null => {
    if (clonedTemplateByColumn.has(columnIndex)) {
      return clonedTemplateByColumn.get(columnIndex) ?? null;
    }
    const templateAddress = xlsx.utils.encode_cell({ r: dataStartRow, c: columnIndex });
    const templateCell = sheet[templateAddress] as XLSXTypes.CellObject | undefined;
    const cloned = templateCell ? cloneCellBase(templateCell) : null;
    clonedTemplateByColumn.set(columnIndex, cloned);
    return cloned;
  };

  const setCellValuePreservingFormat = (rowIndex: number, columnIndex: number, value: string | number | null) => {
    const address = xlsx.utils.encode_cell({ r: rowIndex, c: columnIndex });
    const existingCell = sheet[address] as XLSXTypes.CellObject | undefined;
    const templateCell = getTemplateCellForColumn(columnIndex);
    const baseCell = cloneCellBase(existingCell ?? templateCell ?? undefined);
    if (value == null || value === '') {
      baseCell.t = 's';
      baseCell.v = '';
      sheet[address] = baseCell;
      return;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      baseCell.t = 'n';
      baseCell.v = value;
      sheet[address] = baseCell;
      return;
    }
    baseCell.t = 's';
    baseCell.v = String(value);
    sheet[address] = baseCell;
  };

  rows.forEach((row, rowOffset) => {
    const rowIndex = startRow + rowOffset;
    if (row.skipRow) return;
    selectedMappings.forEach(({ field, columnIndex }) => {
      const value = resolveFieldValue(row, field.key);
      setCellValuePreservingFormat(rowIndex, columnIndex, value);
    });
  });

  const firstSelectedColumn = Math.min(...selectedMappings.map((entry) => entry.columnIndex));
  const lastSelectedColumn = Math.max(...selectedMappings.map((entry) => entry.columnIndex));
  range.s.c = Math.min(range.s.c, firstSelectedColumn);
  range.e.c = Math.max(range.e.c, lastSelectedColumn);
  range.e.r = Math.max(range.e.r, startRow + Math.max(rows.length - 1, 0));
  sheet['!ref'] = xlsx.utils.encode_range(range);

  return {
    startRow: startRow + 1,
    mappedColumnCount: selectedMappings.length,
  };
};

const toArrayBuffer = (value: ArrayBuffer | Uint8Array): ArrayBuffer => {
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  const output = new ArrayBuffer(value.byteLength);
  new Uint8Array(output).set(value);
  return output;
};

export default function ExportOfferProductsModal({ onClose, onRequestRows }: Props) {
  const { cardRef: setCardRef, cardStyle: dragCardStyle, headerProps: dragHeaderProps, resizeHandles } = useModalDragResize({ draggable: true, resizable: true });
  const [file, setFile] = useState<File | null>(null);
  const [validation, setValidation] = useState<ValidationState>(INITIAL_VALIDATION);
  const [isDragging, setIsDragging] = useState(false);
  const [exportRows, setExportRows] = useState<OfferProductsTemplateExportRow[]>([]);
  const [rowsStatus, setRowsStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const analysisRunRef = useRef(0);
  const overlayPointerDownOnOverlayRef = useRef(false);

  useEffect(() => {
    let active = true;
    setRowsStatus('loading');
    setRowsError(null);
    onRequestRows()
      .then((rows) => {
        if (!active) return;
        setExportRows(Array.isArray(rows) ? rows : []);
        setRowsStatus('ready');
      })
      .catch((err) => {
        console.error('Failed to load export rows', err);
        if (!active) return;
        const message = err instanceof Error && err.message
          ? err.message
          : 'Unable to load rows from the offer products grid.';
        setRowsError(message);
        setRowsStatus('error');
      });
    return () => {
      active = false;
    };
  }, [onRequestRows]);

  const activeSheet = useMemo(
    () => validation.sheets[validation.activeSheetIndex] ?? null,
    [validation.activeSheetIndex, validation.sheets],
  );

  const applySheets = useCallback((sheets: SheetMapping[]) => {
    const evaluated = evaluateValidation(sheets, 0);
    setValidation({
      status: evaluated.status,
      message: evaluated.message,
      sheets,
      activeSheetIndex: 0,
      mappedColumnCount: evaluated.mappedColumnCount,
    });
  }, []);

  const handleFileSelection = useCallback((nextFile: File | null) => {
    analysisRunRef.current += 1;
    const runId = analysisRunRef.current;
    setFile(nextFile);
    setError(null);

    if (!nextFile) {
      setValidation(INITIAL_VALIDATION);
      return;
    }

    setValidation({
      status: 'checking',
      message: 'Analyzing workbook...',
      sheets: [],
      activeSheetIndex: 0,
      mappedColumnCount: 0,
    });

    nextFile.arrayBuffer()
      .then(async (buffer) => {
        if (runId !== analysisRunRef.current) return;
        let parsedSheets: SheetMapping[] = [];
        try {
          const xlsx = await loadXlsx();
          const workbook = xlsx.read(buffer, { type: 'array' });
          parsedSheets = analyzeWorkbook(workbook, xlsx);
        } catch (err) {
          console.error('Failed to parse workbook', err);
          parsedSheets = [];
        }
        if (parsedSheets.length === 0) {
          setValidation({
            status: 'invalid',
            message: 'Unable to detect worksheet columns. Please try another file.',
            sheets: [],
            activeSheetIndex: 0,
            mappedColumnCount: 0,
          });
          return;
        }
        applySheets(parsedSheets);
      })
      .catch((err) => {
        console.error('Failed to read workbook file', err);
        if (runId !== analysisRunRef.current) return;
        setValidation({
          status: 'invalid',
          message: 'Unable to read file. Please try again.',
          sheets: [],
          activeSheetIndex: 0,
          mappedColumnCount: 0,
        });
      });
  }, [applySheets]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    event.target.value = '';
    handleFileSelection(nextFile);
  }, [handleFileSelection]);

  const handleFileDrop = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const dropped = event.dataTransfer?.files?.[0] ?? null;
    handleFileSelection(dropped);
  }, [handleFileSelection]);

  const handleDragOver = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setIsDragging(false);
  }, []);

  const handleSheetChange = useCallback((nextSheetIndex: number) => {
    setValidation((previous) => {
      const bounded = Math.max(0, Math.min(nextSheetIndex, previous.sheets.length - 1));
      const evaluated = evaluateValidation(previous.sheets, bounded);
      return {
        ...previous,
        activeSheetIndex: bounded,
        status: evaluated.status,
        message: evaluated.message,
        mappedColumnCount: evaluated.mappedColumnCount,
      };
    });
  }, []);

  const updateSelection = useCallback((fieldKey: ExportFieldKey, columnIndex: number | null) => {
    setValidation((previous) => {
      const sheets = previous.sheets.map((sheet, index) => {
        if (index !== previous.activeSheetIndex) return sheet;
        const nextSelection: Partial<Record<ExportFieldKey, number | null>> = {
          ...sheet.selection,
          [fieldKey]: columnIndex,
        };
        if (columnIndex != null) {
          EXPORT_FIELDS.forEach((field) => {
            if (field.key === fieldKey) return;
            if (nextSelection[field.key] === columnIndex) {
              nextSelection[field.key] = null;
            }
          });
        }
        return { ...sheet, selection: nextSelection };
      });
      const evaluated = evaluateValidation(sheets, previous.activeSheetIndex);
      return {
        ...previous,
        sheets,
        status: evaluated.status,
        message: evaluated.message,
        mappedColumnCount: evaluated.mappedColumnCount,
      };
    });
  }, []);

  const selectedMappings = useMemo(() => {
    if (!activeSheet) return [];
    return EXPORT_FIELDS
      .map((field) => {
        const columnIndex = activeSheet.selection[field.key];
        if (typeof columnIndex !== 'number') return null;
        const column = activeSheet.columns.find((candidate) => candidate.index === columnIndex);
        if (!column) return null;
        return { field, column };
      })
      .filter((entry): entry is { field: ExportFieldConfig; column: ColumnOption } => entry != null);
  }, [activeSheet]);

  const previewStartRow = activeSheet
    ? findFirstWritableRowFromParsedRows(activeSheet)
    : 1;

  const previewRows = useMemo(() => (
    exportRows.slice(0, 3).map((row, index) => ({
      rowNumber: previewStartRow + index,
      values: selectedMappings.map(({ field, column }) => ({
        fieldLabel: field.label,
        targetColumn: column.label,
        value: resolveFieldValue(row, field.key),
      })),
    }))
  ), [exportRows, previewStartRow, selectedMappings]);

  const handleExport = useCallback(async () => {
    setError(null);

    if (rowsStatus === 'loading') {
      setError('Please wait until offer rows are loaded.');
      return;
    }
    if (rowsStatus === 'error') {
      setError(rowsError ?? 'Unable to load offer rows.');
      return;
    }
    if (!file) {
      setError('Choose an Excel file first.');
      return;
    }
    if (!activeSheet) {
      setError('No worksheet selected.');
      return;
    }
    if (validation.status !== 'valid') {
      setError('Select at least one column to export.');
      return;
    }

    setSubmitting(true);
    try {
      const xlsx = await loadXlsx();
      const workbookBuffer = await file.arrayBuffer();
      const workbookType = resolveWorkbookExtension(file.name);
      if (!workbookType) {
        throw new Error('Only .xlsx, .xlsm and .xls template files are supported.');
      }
      const outputFilename = buildOutputFilename(file.name, workbookType);
      let writeResult: { startRow: number; mappedColumnCount: number };
      let outputBuffer: ArrayBuffer;
      const alignedRows = padExportRowsForAlignment(exportRows);

      if (workbookType === 'xls') {
        // Legacy .xls is not ZIP-based, so use workbook rewrite fallback.
        const workbook = xlsx.read(workbookBuffer, { type: 'array' });
        const sheet = workbook.Sheets?.[activeSheet.name];
        if (!sheet) {
          throw new Error(`Worksheet "${activeSheet.name}" was not found in the selected file.`);
        }
        writeResult = applyRowsToSheet(xlsx, sheet, activeSheet, alignedRows);
        // Force Excel to recalculate all formulas when the file is opened.
        if (!workbook.Workbook) workbook.Workbook = {};
        const wbProps = workbook.Workbook as Record<string, unknown>;
        if (!wbProps.CalcPr) wbProps.CalcPr = {};
        (wbProps.CalcPr as Record<string, unknown>).fullCalcOnLoad = true;
        const binary = xlsx.write(workbook, {
          type: 'array',
          compression: true,
          bookType: workbookType,
        }) as ArrayBuffer | Uint8Array;
        outputBuffer = toArrayBuffer(binary);
      } else {
        const JSZipModule = await import('jszip');
        const JSZip = JSZipModule.default;
        const archive = await JSZip.loadAsync(workbookBuffer);
        const worksheetPath = await resolveWorksheetXmlPath(archive, activeSheet.name);
        const worksheetFile = archive.file(worksheetPath);
        if (!worksheetFile) {
          throw new Error(`Worksheet "${activeSheet.name}" XML was not found (${worksheetPath}).`);
        }
        const worksheetXml = await worksheetFile.async('string') as string;
        const patchResult = patchWorksheetXmlWithAppendedRows(worksheetXml, activeSheet, alignedRows);
        writeResult = { startRow: patchResult.startRow, mappedColumnCount: patchResult.mappedColumnCount };
        archive.file(worksheetPath, patchResult.sheetXml);

        // Force Excel to recalculate all formulas when the file is opened.
        const workbookXmlFile = archive.file('xl/workbook.xml');
        if (workbookXmlFile) {
          let wbXml = await workbookXmlFile.async('string') as string;
          if (wbXml.includes('<calcPr')) {
            wbXml = wbXml.replace(/<calcPr([^/>]*)\/?>/g, (match, attrs: string) => {
              const cleaned = attrs.replace(/\s*fullCalcOnLoad\s*=\s*"[^"]*"/g, '');
              return `<calcPr${cleaned} fullCalcOnLoad="1"/>`;
            });
          } else {
            wbXml = wbXml.replace(/<\/workbook>/i, '<calcPr fullCalcOnLoad="1"/></workbook>');
          }
          archive.file('xl/workbook.xml', wbXml);
        }

        outputBuffer = await archive.generateAsync({
          type: 'arraybuffer',
          compression: 'DEFLATE',
        });
      }

      downloadWorkbookFile(outputBuffer, outputFilename, workbookType);
      const writtenCount = alignedRows.filter((r) => !r.skipRow).length;
      showToastMessage(
        `Exported ${writtenCount} row${writtenCount === 1 ? '' : 's'} to "${activeSheet.name}" (from row ${writeResult.startRow}).`,
        'success',
      );
      onClose();
    } catch (err) {
      console.error('Failed to export offer products template', err);
      const message = err instanceof Error && err.message
        ? err.message
        : 'Unable to export the updated workbook.';
      setError(message);
      showToastMessage('Unable to export updated workbook. Please try again.', 'error');
    } finally {
      setSubmitting(false);
    }
  }, [activeSheet, exportRows, file, onClose, rowsError, rowsStatus, validation.status]);

  const handleOverlayPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    overlayPointerDownOnOverlayRef.current = event.target === event.currentTarget;
  }, []);

  const handleOverlayClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const shouldClose = overlayPointerDownOnOverlayRef.current && event.target === event.currentTarget;
    overlayPointerDownOnOverlayRef.current = false;
    if (!shouldClose || submitting) return;
    onClose();
  }, [onClose, submitting]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || submitting) return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, submitting]);

  const canExport = Boolean(
    !submitting
    && rowsStatus === 'ready'
    && validation.status === 'valid'
    && activeSheet
    && file,
  );

  const rowsStatusMessage = rowsStatus === 'loading'
    ? 'Loading offer rows from the current grid filters...'
    : rowsStatus === 'error'
      ? rowsError ?? 'Unable to load offer rows.'
      : `Ready to write ${exportRows.length} row${exportRows.length === 1 ? '' : 's'}.`;

  return (
    <div className={styles.overlay} onPointerDown={handleOverlayPointerDown} onClick={handleOverlayClick}>
      <div ref={setCardRef} className={styles.card} role="dialog" aria-modal="true" aria-label="Export offer products" onClick={(event) => event.stopPropagation()} style={dragCardStyle}>
        <div className={styles.header} onPointerDown={dragHeaderProps.onPointerDown} onDoubleClick={dragHeaderProps.onDoubleClick} style={dragHeaderProps.style}>
          <div className={styles.headerText}>
            <div className={styles.title}>Export Offer Products</div>
            <div className={styles.subtitle}>Use your own Excel template and map columns automatically.</div>
          </div>
          <div className={styles.headerActions}>
            <button type="button" className={styles.ghostButton} onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button type="button" className={styles.primaryButton} onClick={handleExport} disabled={!canExport}>
              {submitting ? 'Filling...' : 'Fill AVC4 Offer'}
            </button>
          </div>
        </div>
        <div className={`${styles.body} ${styles.exportBody}`}>
          <div className={`${styles.mappingColumn} ${styles.exportMappingColumn}`}>
            <label
              htmlFor="offer-products-export-file"
              className={`${styles.uploadLabel} ${isDragging ? styles.uploadLabelDragging : ''}`}
              onDrop={handleFileDrop}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
            >
              <input
                autoComplete="off"
                id="offer-products-export-file"
                type="file"
                accept=".xlsx,.xlsm,.xls"
                className={styles.fileInput}
                onChange={handleFileChange}
              />
              <div className={styles.uploadTitle}>{file ? 'Replace template file' : 'Drop Excel file or click to browse'}</div>
              <div className={styles.uploadSubtitle}>Supported formats: .xlsx, .xlsm, .xls</div>
              {file ? <div className={styles.selectedFile}>{file.name}</div> : null}
            </label>
            <div className={styles.statusCard}>
              <div className={styles.statusTitle}>Data source</div>
              <div className={styles.statusText}>{rowsStatusMessage}</div>
              {activeSheet ? (
                <div className={styles.helpText}>
                  {`Writing starts at row ${previewStartRow} on sheet "${activeSheet.name}".`}
                </div>
              ) : null}
            </div>
            <div className={styles.statusCard}>
              <div className={styles.statusTitle}>
                {validation.status === 'checking' ? 'Checking workbook' : 'Column mapping'}
              </div>
              <div className={styles.statusText}>
                {validation.message ?? 'Upload a workbook to detect and map columns.'}
              </div>
              {activeSheet ? (
                <div className={styles.helpText}>
                  {`Detected ${activeSheet.rowCount} existing row${activeSheet.rowCount === 1 ? '' : 's'} below the header.`}
                </div>
              ) : null}
            </div>
            {validation.sheets.length > 1 ? (
              <div className={styles.sheetTabs}>
                {validation.sheets.map((sheet, index) => {
                  const isActive = index === validation.activeSheetIndex;
                  const className = isActive
                    ? `${styles.sheetTab} ${styles.sheetTabActive}`
                    : styles.sheetTab;
                  return (
                    <button
                      type="button"
                      key={`${sheet.name}-${index}`}
                      className={className}
                      onClick={() => handleSheetChange(index)}
                    >
                      {sheet.name || `Sheet ${index + 1}`}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {activeSheet ? (
              <>
                <div className={styles.helpText}>
                  Suggested columns are pre-selected. Change any mapping manually before exporting.
                </div>
                <div className={styles.mappingGrid}>
                  {EXPORT_FIELDS.map((field) => {
                    const selectedValue = activeSheet.selection[field.key] != null
                      ? String(activeSheet.selection[field.key])
                      : '';
                    const suggestions = activeSheet.suggestions[field.key] ?? [];
                    const suggestedIndexes = new Set(suggestions.map((option) => option.index));
                    const otherColumns = activeSheet.columns.filter((column) => !suggestedIndexes.has(column.index));
                    return (
                      <label key={field.key} className={styles.mappingField}>
                        <span className={styles.mappingLabel}>{field.label}</span>
                        <select
                          className={styles.select}
                          value={selectedValue}
                          onChange={(event) =>
                            updateSelection(
                              field.key,
                              event.target.value === '' ? null : Number(event.target.value),
                            )
                          }
                        >
                          <option value="">Skip this field</option>
                          {suggestions.length > 0 ? (
                            <optgroup label="Suggested">
                              {suggestions.map((option) => (
                                <option key={`${field.key}-suggested-${option.index}`} value={option.index}>
                                  {option.label}
                                </option>
                              ))}
                            </optgroup>
                          ) : null}
                          {otherColumns.length > 0 ? (
                            <optgroup label="All columns">
                              {otherColumns.map((option) => (
                                <option key={`${field.key}-all-${option.index}`} value={option.index}>
                                  {option.label}
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
          <div className={`${styles.previewColumn} ${styles.exportPreviewColumn}`}>
            <div className={styles.statusCard}>
              <div className={styles.statusTitle}>Export preview</div>
              {selectedMappings.length === 0 ? (
                <div className={styles.statusText}>Map at least one column to preview written values.</div>
              ) : previewRows.length === 0 ? (
                <div className={styles.statusText}>No rows available from the current offer grid filters.</div>
              ) : (
                <div className={styles.previewTableWrapper}>
                  <table className={styles.previewTable}>
                    <thead>
                      <tr>
                        <th>Excel row</th>
                        {selectedMappings.map(({ column }) => (
                          <th key={`preview-head-${column.index}`}>{column.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {previewRows.map((previewRow) => (
                        <tr key={`preview-row-${previewRow.rowNumber}`}>
                          <td className={styles.previewRowNumber}>{previewRow.rowNumber}</td>
                          {previewRow.values.map((entry, idx) => (
                            <td key={`${previewRow.rowNumber}-${entry.fieldLabel}-${idx}`}>
                              {formatPreviewValue(entry.value)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {error ? <div className={styles.errorText}>{error}</div> : null}
          </div>
        </div>
        {resizeHandles}
      </div>
    </div>
  );
}
