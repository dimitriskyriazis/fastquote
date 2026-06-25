import { NextRequest, NextResponse } from "next/server";
import { logRequest } from '../../../../lib/apiHelpers';
import path from "node:path";
import fs from "node:fs/promises";
import * as XLSX from "xlsx";
import sql from "mssql";
import type { ConnectionPool } from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { getRequestId } from "../../../../lib/requestId";
import { logAddAuditDetails } from "../../../../lib/mutationAudit";
import { requirePermission } from "../../../../lib/authz";
import { clearPartModelNumberUpper } from "../../../../lib/partModelNumber";
import {
  applyBrandPattern,
  hasPatternConfig,
  normalizePatternConfig,
  type PartNumberPatternConfig,
} from "../../../../lib/partNumberPattern";
import {
  DEFAULT_PRICE_LIST_DECIMAL_FORMAT,
  normalizePriceListDecimalFormat,
  type PriceListDecimalFormat,
} from "../../../../lib/priceListDecimalFormats";
import { parsePriceValue } from "../../../../lib/parsePriceValue";

export const runtime = "nodejs";

type ParsedPriceListRow = {
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  listPrice: number | null;
  costPrice: number | null;
  servicePriceGR: number | null;
  servicePriceOutGR: number | null;
  serviceType: string | null;
  warning: string | null;
  moq: number | null;
  weblink: string | null;
  legacyPartNumber: string | null;
};

type ProductRow = {
  ID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandID: number | null;
  Description: string | null;
};

type HeaderColumnKey = "partNumber" | "modelNumber" | "description" | "listPrice" | "costPrice" | "servicePriceGR" | "servicePriceOutGR" | "serviceType" | "warning" | "moq" | "weblink" | "legacyPartNumber";

type ColumnMapping = {
  sheetName: string | null;
  headerRowIndex: number | null;
  columns: Partial<Record<HeaderColumnKey, number | null>>;
  rowIndices?: number[] | null; // 0-based data row indices to import (null = import all)
} | null;

const HEADER_SYNONYMS: Record<HeaderColumnKey, string[]> = {
  partNumber: [
    "partnumber", "part number", "partno", "part no", "p/n",
    "sku", "itemno", "item no", "item number", "itemnumber",
    "articleno", "article no", "article number", "articlenumber",
    "orderno", "order no", "order number", "ordernumber",
    "code", "catalog", "catalogno", "catalog no",
    "référence", "références", "réf",
    "codice", "codigo", "código",
    "κωδικός", "κωδικος", "κωδικοσ",
  ],
  modelNumber: [
    "modelnumber", "model number", "modelno", "model no",
    "series", "mpn", "mfg", "family",
    "μοντέλο", "μοντελο", "σειρά", "σειρα", "τύπος", "τυπος",
  ],
  description: [
    "name", "description", "desc", "detail", "details",
    "designation", "désignation", "produit", "produkt", "producto",
    "bezeichnung", "beschreibung", "descrizione", "descripción", "descripcion",
    "περιγραφή", "περιγραφη", "όνομα", "ονομα", "ονομασία", "ονομασια",
  ],
  listPrice: [
    "listprice", "list price", "price", "msrp", "rrp",
    "retail", "retailprice", "retail price",
    "prix", "tarif", "preis", "prezzo", "precio",
    "τιμή", "τιμη", "λιανική", "λιανικη", "κατάλογος", "καταλογος",
  ],
  costPrice: [
    "costprice", "cost price", "cost",
    "netprice", "net price", "net",
    "κόστος", "κοστος", "τιμή κόστους", "τιμη κοστους",
    "καθαρή τιμή", "καθαρη τιμη",
  ],
  servicePriceGR: [
    "servicepricegr", "service price gr", "service gr", "price gr",
    "τιμή gr", "τιμη gr", "List Gre",
  ],
  servicePriceOutGR: [
    "servicepriceoutgr", "service price out gr", "service outgr", "price outgr",
    "τιμή outgr", "τιμη outgr", "List Outside Gre"
  ],
  serviceType: [
    "servicetype", "service type", "type", "service kind",
    "τύπος υπηρεσίας", "τυπος υπηρεσιας",
  ],
  warning: [
    "warning", "warn", "note", "remark",
    "σημείωση", "σημειωση", "προσοχή", "προσοχη",
  ],
  moq: [
    "moq", "min order", "minimum order", "min qty", "minimum qty",
    "minimum quantity", "min order qty",
    "ελάχιστη παραγγελία", "ελαχιστη παραγγελια",
  ],
  weblink: [
    "weblink", "web link", "weblnk", "url", "link", "hyperlink",
    "website", "σύνδεσμος", "συνδεσμος", "ιστοσελίδα", "ιστοσελιδα",
  ],
  legacyPartNumber: [
    "legacypartnumber", "legacy part number", "legacypartno", "legacy part no",
    "oldpartnumber", "old part number", "oldpartno", "old part no",
    "previouspartnumber", "previous part number", "previouspartno", "previous part no",
    "formerpartnumber", "former part number", "formerpartno", "former part no",
  ],
};

const requirePriceListUploadRoot = (): string => {
  const raw = process.env.PRICELIST_UPLOAD_ROOT;
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new Error(
      "Missing PRICELIST_UPLOAD_ROOT. Set it in your environment (e.g. .env.local) to an absolute directory path.",
    );
  }
  return value;
};

type SqlTypeLike = unknown;

type RequestLike = {
  input: (name: string, type: SqlTypeLike, value: unknown) => RequestLike;
  query: (query: string) => Promise<{ recordset?: unknown[] }>;
};

type TransactionLike = {
  begin: () => Promise<void>;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

const createRequest = (owner: TransactionLike) => {
  const RequestCtor = sql.Request as unknown as new (o: TransactionLike) => RequestLike;
  return new RequestCtor(owner);
};

const getDecimalType = () => {
  const decimalFactory = (sql as unknown as {
    Decimal: (precision: number, scale: number) => SqlTypeLike;
  }).Decimal;
  return decimalFactory(18, 4);
};

const normalizeString = (value: unknown, maxLength = 500): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const str = String(value);
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
};

const normalizeUserId = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const str = String(value);
    return str.trim() || null;
  }
  return null;
};

const normalizeInt = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

const normalizeDecimal = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim().replace(",", ".");
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizeBool = (value: unknown): boolean | null => {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return null;
};

const normalizeDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const normalizeKey = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed || null;
};

const normalizeHeaderValue = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = typeof value === "number" ? String(value) : value;
  const trimmed = str
    .trim()
    .toLowerCase()
    .replace(/[\u00a0]+/g, " ")
    .replace(/[|_/\\-]+/g, " ")
    .replace(/\s+/g, " ");
  if (!trimmed) return null;
  // Skip long sentences — real headers are short labels, not metadata prose
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (wordCount > 6) return null;
  return trimmed.replace(/[^\p{L}\p{N}]+/gu, "");
};

const parsePrice = parsePriceValue;

const normalizeCellString = (value: unknown, maxLength = 1000): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const str = String(value);
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
};

const toClearedPartModel = (value: string | null | undefined) => {
  if (!value) return null;
  return clearPartModelNumberUpper(value);
};

// Extract hyperlink URL from Excel cell if it exists
const extractHyperlink = (sheet: XLSX.WorkSheet | null, rowIndex: number, colIndex: number): string | null => {
  if (!sheet) return null;
  try {
    // Convert 0-based row/col to Excel cell address (e.g., A1, B2)
    const cellAddress = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
    const cell = sheet[cellAddress];
    if (!cell) return null;
    
    // Check for hyperlink in cell's 'l' (link) property
    if (cell.l && Array.isArray(cell.l) && cell.l.length > 0) {
      const link = cell.l[0];
      // Link can have Target (URL) or Tooltip
      if (link.Target && typeof link.Target === "string") {
        const url = link.Target.trim();
        return url || null;
      }
    }
    
    // Also check for HYPERLINK formula
    if (cell.f && typeof cell.f === "string" && cell.f.startsWith("HYPERLINK(")) {
      // Extract URL from HYPERLINK formula: HYPERLINK("url","text")
      const match = cell.f.match(/HYPERLINK\s*\(\s*"([^"]+)"\s*,/);
      if (match && match[1]) {
        return match[1].trim();
      }
    }
  } catch {
    // Silently fail if hyperlink extraction fails
  }
  return null;
};

const parseColumnMapping = (value: unknown): ColumnMapping => {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as {
      sheetName?: unknown;
      headerRowIndex?: unknown;
      columns?: unknown;
      rowIndices?: unknown;
    };
    const sheetName =
      typeof parsed.sheetName === "string" && parsed.sheetName.trim()
        ? parsed.sheetName.trim()
        : null;
    const headerRowIndex =
      typeof parsed.headerRowIndex === "number" && Number.isInteger(parsed.headerRowIndex)
        ? parsed.headerRowIndex
        : null;
    const rawColumns = parsed.columns;
    const columns: Partial<Record<HeaderColumnKey, number | null>> = {};
    if (rawColumns && typeof rawColumns === "object") {
      (Object.keys(rawColumns) as HeaderColumnKey[]).forEach((key) => {
        const rawValue = (rawColumns as Record<HeaderColumnKey, unknown>)[key];
        if (rawValue === null) {
          columns[key] = null;
        } else if (typeof rawValue === "number" && Number.isInteger(rawValue) && rawValue >= 0) {
          columns[key] = rawValue;
        }
      });
    }
    const rowIndices: number[] | null = Array.isArray(parsed.rowIndices)
      ? (parsed.rowIndices as unknown[]).filter(
          (n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0,
        )
      : null;
    return { sheetName, headerRowIndex, columns, rowIndices: rowIndices?.length ? rowIndices : null };
  } catch (err) {
    console.error("Failed to parse column mapping", err);
    return null;
  }
};

const parseColumnMappings = (value: unknown): ColumnMapping[] => {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((entry) => parseColumnMapping(JSON.stringify(entry)))
        .filter((val): val is ColumnMapping => Boolean(val));
    }
    const single = parseColumnMapping(value);
    return single ? [single] : [];
  } catch (err) {
    console.error("Failed to parse column mappings", err);
    return [];
  }
};

const findHeaderRow = (rows: unknown[][]) => {
  let bestResult: { headerRowIndex: number; columnMap: Partial<Record<HeaderColumnKey, number>> } | null = null;
  let bestScore = 0;
  const limit = Math.min(rows.length, 100);

  const matchesHeaderKey = (normalizedCell: string, key: HeaderColumnKey) =>
    HEADER_SYNONYMS[key].some((candidate) => {
      const normalizedCandidate = normalizeHeaderValue(candidate);
      if (!normalizedCandidate) return false;
      return (
        normalizedCell === normalizedCandidate ||
        normalizedCell.includes(normalizedCandidate) ||
        normalizedCandidate.includes(normalizedCell)
      );
    });

  const buildColumnMap = (row: unknown[]) => {
    const columnMap: Partial<Record<HeaderColumnKey, number>> = {};
    row.forEach((cell, colIdx) => {
      const normalized = normalizeHeaderValue(cell);
      if (!normalized) return;
      (Object.keys(HEADER_SYNONYMS) as HeaderColumnKey[]).forEach((key) => {
        if (columnMap[key] != null) return;
        if (matchesHeaderKey(normalized, key)) columnMap[key] = colIdx;
      });
    });
    return columnMap;
  };

  const isLikelyHeaderRow = (row: unknown[]) => {
    const matchedKeys = new Set<HeaderColumnKey>();
    row.forEach((cell) => {
      const normalized = normalizeHeaderValue(cell);
      if (!normalized) return;
      (Object.keys(HEADER_SYNONYMS) as HeaderColumnKey[]).forEach((key) => {
        if (matchesHeaderKey(normalized, key)) matchedKeys.add(key);
      });
    });
    const hasIdentifier = matchedKeys.has("partNumber") || matchedKeys.has("modelNumber");
    const hasSecondary =
      matchedKeys.has("description") || matchedKeys.has("listPrice");
    return hasIdentifier && hasSecondary && matchedKeys.size >= 2;
  };

  const hasCellVal = (v: unknown) => v !== null && v !== undefined && (typeof v !== "string" || v.trim().length > 0);

  /** Merge two adjacent rows for multi-row header detection. */
  const mergeRows = (row1: unknown[], row2: unknown[]): unknown[] => {
    const len = Math.max(row1.length, row2.length);
    const merged: unknown[] = [];
    for (let i = 0; i < len; i += 1) {
      merged[i] = hasCellVal(row1[i]) ? row1[i] : row2[i] ?? null;
    }
    return merged;
  };

  // Pass 1: prefer the first strongly matching single header row.
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    if (isLikelyHeaderRow(row)) {
      return { headerRowIndex: idx, columnMap: buildColumnMap(row) };
    }
  }

  // Pass 2: try multi-row headers — merge row[idx] with row[idx+1] and check.
  for (let idx = 0; idx < limit - 1; idx += 1) {
    const row = rows[idx];
    const nextRow = rows[idx + 1];
    if (!Array.isArray(row) || !Array.isArray(nextRow)) continue;
    const merged = mergeRows(row, nextRow);
    if (isLikelyHeaderRow(merged)) {
      return { headerRowIndex: idx, columnMap: buildColumnMap(merged) };
    }
  }

  // Pass 3: fallback scoring.
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const columnMap = buildColumnMap(row);
    const detectedCount = Object.keys(columnMap).length;
    if (detectedCount > bestScore) {
      bestScore = detectedCount;
      bestResult = { headerRowIndex: idx, columnMap };
    }
  }

  // Require at least 2 matched columns to avoid false positives from metadata rows
  if (bestScore < 2) return null;
  return bestResult;
};

const parseSheetWithMapping = (
  rows: unknown[][],
  rawRows: unknown[][],
  headerRowIndex: number,
  columnMap: Partial<Record<HeaderColumnKey, number | null>>,
  decimalFormat: PriceListDecimalFormat,
  sheet: XLSX.WorkSheet | null = null,
  allowedDataRowIndices?: Set<number> | null,
) => {
  const requiredKeys: HeaderColumnKey[] = ["partNumber", "listPrice"];
  const hasAllRequired = requiredKeys.every((key) => typeof columnMap[key] === "number");
  if (!hasAllRequired) return [] as ParsedPriceListRow[];

  const safeHeaderRowIndex = Math.max(0, Math.min(headerRowIndex, rows.length > 0 ? rows.length - 1 : 0));
  const parsed: ParsedPriceListRow[] = [];

  const getValue = (row: unknown[], key: HeaderColumnKey) => {
    const idx = columnMap[key];
    if (idx == null || typeof idx !== "number" || idx < 0) return null;
    return row[idx] ?? null;
  };
  // For numeric columns, prefer the raw underlying value (a JS number when Excel
  // stored a number) — sheetjs's text formatter is locale-blind and corrupts
  // values like 1000.549 → "1000.549", which our parser can't disambiguate from
  // a thousands-separated integer.
  const getRawValue = (rawRow: unknown[] | undefined, key: HeaderColumnKey) => {
    const idx = columnMap[key];
    if (idx == null || typeof idx !== "number" || idx < 0) return null;
    return rawRow?.[idx] ?? null;
  };
  const pickPriceSource = (row: unknown[], rawRow: unknown[] | undefined, key: HeaderColumnKey) => {
    const raw = getRawValue(rawRow, key);
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    return getValue(row, key);
  };

  for (let rIdx = safeHeaderRowIndex + 1; rIdx < rows.length; rIdx += 1) {
    // When a row filter is active, skip rows whose 0-based data index is not in the allowed set.
    if (allowedDataRowIndices && !allowedDataRowIndices.has(rIdx - safeHeaderRowIndex - 1)) continue;
    const row = rows[rIdx];
    if (!Array.isArray(row)) continue;
    const rawRow = rawRows[rIdx];
    const partNumber = normalizeCellString(getValue(row, "partNumber"), 50);
    const modelNumber = normalizeCellString(getValue(row, "modelNumber"), 50);
    const description = normalizeCellString(getValue(row, "description"), 2000);
    const listPrice = parsePrice(pickPriceSource(row, rawRow, "listPrice"), decimalFormat);
    const costPrice = parsePrice(pickPriceSource(row, rawRow, "costPrice"), decimalFormat);
    const servicePriceGR = parsePrice(pickPriceSource(row, rawRow, "servicePriceGR"), decimalFormat);
    const servicePriceOutGR = parsePrice(pickPriceSource(row, rawRow, "servicePriceOutGR"), decimalFormat);
    const serviceTypeRaw = normalizeCellString(getValue(row, "serviceType"), 20);
    const serviceType = serviceTypeRaw === "ServLot" || serviceTypeRaw === "ServPerUnit" ? serviceTypeRaw : null;
    const warning = normalizeCellString(getValue(row, "warning"), 1000);
    const moqRaw = getRawValue(rawRow, "moq");
    const moq = normalizeInt(moqRaw != null ? moqRaw : getValue(row, "moq"));
    const legacyPartNumber = normalizeCellString(getValue(row, "legacyPartNumber"), 50);

    // Extract weblink: first try hyperlink, then fall back to cell value
    const weblinkColIdx = columnMap.weblink;
    let weblink: string | null = null;
    if (weblinkColIdx != null && typeof weblinkColIdx === "number" && weblinkColIdx >= 0) {
      // Try to extract hyperlink URL first
      weblink = extractHyperlink(sheet, rIdx, weblinkColIdx);
      // If no hyperlink found, use the cell value
      if (!weblink) {
        weblink = normalizeCellString(getValue(row, "weblink"), 1000);
      }
    } else {
      weblink = normalizeCellString(getValue(row, "weblink"), 1000);
    }

    if (!partNumber && !modelNumber && !description && listPrice == null && costPrice == null && !warning && !weblink) continue;
    if (!partNumber || listPrice == null) continue;

    parsed.push({
      partNumber,
      modelNumber,
      description,
      listPrice,
      costPrice,
      servicePriceGR,
      servicePriceOutGR,
      serviceType,
      warning,
      moq,
      weblink,
      legacyPartNumber,
    });
  }

  return parsed;
};

const parseSheet = (
  rows: unknown[][],
  rawRows: unknown[][],
  decimalFormat: PriceListDecimalFormat,
  sheet: XLSX.WorkSheet | null = null,
): ParsedPriceListRow[] | null => {
  const header = findHeaderRow(rows);
  if (!header) return null;
  const { headerRowIndex, columnMap } = header;
  const parsed: ParsedPriceListRow[] = [];

  const getValue = (row: unknown[], key: HeaderColumnKey) => {
    const idx = columnMap[key];
    if (idx == null) return null;
    return row[idx] ?? null;
  };
  const getRawValue = (rawRow: unknown[] | undefined, key: HeaderColumnKey) => {
    const idx = columnMap[key];
    if (idx == null) return null;
    return rawRow?.[idx] ?? null;
  };
  const pickPriceSource = (row: unknown[], rawRow: unknown[] | undefined, key: HeaderColumnKey) => {
    const raw = getRawValue(rawRow, key);
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    return getValue(row, key);
  };

  for (let rIdx = headerRowIndex + 1; rIdx < rows.length; rIdx += 1) {
    const row = rows[rIdx];
    if (!Array.isArray(row)) continue;
    const rawRow = rawRows[rIdx];
    const partNumber = normalizeCellString(getValue(row, "partNumber"), 50);
    const modelNumber = normalizeCellString(getValue(row, "modelNumber"), 50);
    const description = normalizeCellString(getValue(row, "description"), 2000);
    const listPrice = parsePrice(pickPriceSource(row, rawRow, "listPrice"), decimalFormat);
    const costPrice = parsePrice(pickPriceSource(row, rawRow, "costPrice"), decimalFormat);
    const servicePriceGR = parsePrice(pickPriceSource(row, rawRow, "servicePriceGR"), decimalFormat);
    const servicePriceOutGR = parsePrice(pickPriceSource(row, rawRow, "servicePriceOutGR"), decimalFormat);
    const serviceTypeRaw2 = normalizeCellString(getValue(row, "serviceType"), 20);
    const serviceType = serviceTypeRaw2 === "ServLot" || serviceTypeRaw2 === "ServPerUnit" ? serviceTypeRaw2 : null;
    const warning = normalizeCellString(getValue(row, "warning"), 1000);
    const moqRaw2 = getRawValue(rawRow, "moq");
    const moq = normalizeInt(moqRaw2 != null ? moqRaw2 : getValue(row, "moq"));
    const legacyPartNumber = normalizeCellString(getValue(row, "legacyPartNumber"), 50);

    // Extract weblink: first try hyperlink, then fall back to cell value
    const weblinkColIdx = columnMap.weblink;
    let weblink: string | null = null;
    if (weblinkColIdx != null && typeof weblinkColIdx === "number" && weblinkColIdx >= 0) {
      // Try to extract hyperlink URL first
      weblink = extractHyperlink(sheet, rIdx, weblinkColIdx);
      // If no hyperlink found, use the cell value
      if (!weblink) {
        weblink = normalizeCellString(getValue(row, "weblink"), 1000);
      }
    } else {
      weblink = normalizeCellString(getValue(row, "weblink"), 1000);
    }

    if (!partNumber && !modelNumber && !description && listPrice == null && costPrice == null && !warning && !weblink) continue;
    if (!partNumber || listPrice == null) continue;

    parsed.push({
      partNumber,
      modelNumber,
      description,
      listPrice,
      costPrice,
      servicePriceGR,
      servicePriceOutGR,
      serviceType,
      warning,
      moq,
      weblink,
      legacyPartNumber,
    });
  }

  return parsed;
};

const parseWorkbook = (
  buffer: Buffer,
  columnMappings?: ColumnMapping[],
  decimalFormat: PriceListDecimalFormat = DEFAULT_PRICE_LIST_DECIMAL_FORMAT,
): ParsedPriceListRow[] => {
  try {
    const wb = XLSX.read(buffer, { type: "buffer" });

    if (columnMappings && columnMappings.length > 0 && wb.SheetNames?.length) {
      const allParsed: ParsedPriceListRow[] = [];
      columnMappings.forEach((columnMapping) => {
        if (!columnMapping) return;
        const targetName = columnMapping.sheetName;
        const resolvedName =
          (targetName &&
            wb.SheetNames.find(
              (name) =>
                name === targetName ||
                name.trim() === targetName.trim() ||
                name.toLowerCase() === targetName.toLowerCase(),
            )) ||
          wb.SheetNames[0];
        if (resolvedName) {
          const sheet = wb.Sheets[resolvedName];
          if (sheet) {
            const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
            const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
            const headerRowIndex =
              typeof columnMapping.headerRowIndex === "number" && columnMapping.headerRowIndex >= 0
                ? columnMapping.headerRowIndex
                : 0;
            const allowedDataRowIndices =
              columnMapping.rowIndices && columnMapping.rowIndices.length > 0
                ? new Set(columnMapping.rowIndices)
                : null;
            const parsed = parseSheetWithMapping(
              rows,
              rawRows,
              headerRowIndex,
              columnMapping.columns ?? {},
              decimalFormat,
              sheet,
              allowedDataRowIndices,
            );
            if (parsed.length > 0) {
              allParsed.push(...parsed);
            }
          }
        }
      });
      return allParsed;
    }

    for (const sheetName of wb.SheetNames ?? []) {
      const sheet = wb.Sheets[sheetName];
      if (!sheet) continue;
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
      const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
      const parsed = parseSheet(rows, rawRows, decimalFormat, sheet);
      if (parsed && parsed.length > 0) return parsed;
    }
  } catch (err) {
    console.error("Failed to parse uploaded workbook", err);
  }
  return [];
};

const formatDisplayTimestamp = (date: Date) => {
  const pad = (val: number) => val.toString().padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ${pad(
    date.getHours(),
  )}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
};

const sanitizeFileStem = (value: string | null | undefined, fallback: string) => {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return fallback;
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.length > 120 ? cleaned.slice(0, 120).trim() : cleaned;
};

const saveUploadedFile = async (
  buffer: Buffer,
  originalName: string | null | undefined,
  priceListName: string | null | undefined,
) => {
  const uploadRoot = requirePriceListUploadRoot();
  await fs.mkdir(uploadRoot, { recursive: true });
  const timestamp = formatDisplayTimestamp(new Date());
  const ext = (typeof originalName === "string" && path.extname(originalName)) || ".xlsx";
  const safeExt = ext.trim() || ".xlsx";
  const safeName = sanitizeFileStem(priceListName, "price list");
  const fileName = `${safeName} (${timestamp})${safeExt}`;
  const absolutePath = path.join(uploadRoot, fileName);
  await fs.writeFile(absolutePath, buffer);
  const relativePath = path.relative(process.cwd(), absolutePath);
  return { absolutePath, relativePath, fileName };
};

const chunkArray = <T>(source: readonly T[], size: number) => {
  const chunks: T[][] = [];
  for (let idx = 0; idx < source.length; idx += size) {
    chunks.push(source.slice(idx, idx + size));
  }
  return chunks;
};

const fetchProductsByKeys = async (
  pool: ConnectionPool,
  keys: readonly string[],
  columnName: "PartNumber" | "ModelNumber",
  brandId: number,
) => {
  if (keys.length === 0) return [] as ProductRow[];

  const columnExpression = `LOWER(LTRIM(RTRIM(${columnName})))`;
  const rows: ProductRow[] = [];
  const chunks = chunkArray(keys, 900);

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
    const chunk = chunks[chunkIdx];
    const request = pool.request();
    request.input("brandId", sql.Int, brandId);
    const paramNames = chunk.map((val, idx) => {
      const param = `${columnName.toLowerCase()}_${chunkIdx}_${idx}`;
      request.input(param, sql.NVarChar(255), val);
      return `@${param}`;
    });

    const result = await request.query(`
      SELECT ID, PartNumber, ModelNumber, BrandID, Description
      FROM dbo.Products
      WHERE BrandID = @brandId
        AND ${columnExpression} IN (${paramNames.join(", ")})
    `);
    rows.push(...((result.recordset ?? []) as ProductRow[]));
  }

  return rows;
};

const loadBrandPatternConfig = async (
  pool: ConnectionPool,
  brandId: number,
): Promise<PartNumberPatternConfig> => {
  const result = await pool
    .request()
    .input("BrandID", sql.Int, brandId)
    .query<{
      PartNumberSuffix: string | null;
      PartNumberPattern1: string | null;
      PartNumberPattern2: string | null;
    }>(`
      SELECT PartNumberSuffix, PartNumberPattern1, PartNumberPattern2
      FROM dbo.Brands
      WHERE ID = @BrandID
    `);
  const row = result.recordset?.[0];
  return normalizePatternConfig({
    suffix: row?.PartNumberSuffix ?? null,
    patterns: [row?.PartNumberPattern1 ?? null, row?.PartNumberPattern2 ?? null],
  });
};

const loadExistingProducts = async (pool: ConnectionPool, parsedRows: ParsedPriceListRow[], brandId: number) => {
  const partKeys = Array.from(
    new Set(
      parsedRows
        .map((row) => normalizeKey(row.partNumber))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const modelKeys = Array.from(
    new Set(
      parsedRows
        .map((row) => normalizeKey(row.modelNumber))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  // Collect legacy part number keys - these match against existing products' current PartNumber
  const legacyKeys = Array.from(
    new Set(
      parsedRows
        .map((row) => normalizeKey(row.legacyPartNumber))
        .filter((value): value is string => Boolean(value)),
    ),
  );

  if (partKeys.length === 0 && modelKeys.length === 0 && legacyKeys.length === 0) return [] as ProductRow[];

  const [partProducts, modelProducts, legacyProducts] = await Promise.all([
    fetchProductsByKeys(pool, partKeys, "PartNumber", brandId),
    fetchProductsByKeys(pool, modelKeys, "ModelNumber", brandId),
    fetchProductsByKeys(pool, legacyKeys, "PartNumber", brandId),
  ]);

  const allProducts = [...partProducts, ...modelProducts, ...legacyProducts];
  const seen = new Set<number>();
  const uniqueProducts: ProductRow[] = [];
  for (const product of allProducts) {
    if (seen.has(product.ID)) continue;
    seen.add(product.ID);
    uniqueProducts.push(product);
  }

  return uniqueProducts;
};

const createProduct = async (
  transaction: TransactionLike,
  row: ParsedPriceListRow,
  brandId: number,
  auditUserId: string | null,
  isService: boolean | null,
  serviceType: string | null,
) => {
  const partNumberCleared = toClearedPartModel(row.partNumber);
  const modelNumberCleared = toClearedPartModel(row.modelNumber);
  const request = createRequest(transaction);
  request.input("BrandID", sql.Int, brandId);
  request.input("PartNumber", sql.NVarChar(255), row.partNumber);
  request.input("ModelNumber", sql.NVarChar(255), row.modelNumber);
  request.input("PartNumberCleared", sql.NVarChar(255), partNumberCleared);
  request.input("ModelNumberCleared", sql.NVarChar(255), modelNumberCleared);
  request.input("LegacyPartNo", sql.NVarChar(255), null);
  request.input("LegacyPartNoCleaned", sql.NVarChar(255), null);
  request.input("Description", sql.NVarChar(2000), row.description);
  request.input("WebLink", sql.NVarChar(1000), row.weblink);
  request.input("IsService", sql.Bit, isService ?? null);
  request.input("ServiceType", sql.NVarChar(20), serviceType ?? null);
  request.input("CreatedBy", sql.NVarChar(450), auditUserId);
  request.input("ModifiedBy", sql.NVarChar(450), auditUserId);

  const insertResult = await request.query(`
    INSERT INTO dbo.Products (
      BrandID,
      PartNumber,
      ModelNumber,
      PartNumberCleared,
      ModelNumberCleared,
      LegacyPartNo,
      LegacyPartNoCleaned,
      Description,
      WebLink,
      IsService,
      ServiceType,
      Enabled,
      CreatedOn,
      CreatedBy,
      ModifiedOn,
      ModifiedBy
    )
    OUTPUT INSERTED.ID AS ProductID
    VALUES (
      @BrandID,
      @PartNumber,
      @ModelNumber,
      @PartNumberCleared,
      @ModelNumberCleared,
      @LegacyPartNo,
      @LegacyPartNoCleaned,
      @Description,
      @WebLink,
      @IsService,
      @ServiceType,
      1,
      SYSUTCDATETIME(),
      @CreatedBy,
      SYSUTCDATETIME(),
      @ModifiedBy
    )
  `);

  const productId = (insertResult.recordset?.[0] as { ProductID?: number } | undefined)?.ProductID ?? null;
  if (!productId) throw new Error("Failed to create product");
  return productId;
};

const insertPriceListItem = async (
  transaction: TransactionLike,
  priceListId: number,
  productId: number,
  row: ParsedPriceListRow,
  auditUserId: string | null,
) => {
  const request = createRequest(transaction);
  request.input("PriceListID", sql.Int, priceListId);
  request.input("ProductID", sql.Int, productId);
  const listPrice = row.listPrice == null ? undefined : Number(row.listPrice);
  const costPrice = row.costPrice == null ? undefined : Number(row.costPrice);
  const servicePriceGR = row.servicePriceGR == null ? undefined : Number(row.servicePriceGR);
  const servicePriceOutGR = row.servicePriceOutGR == null ? undefined : Number(row.servicePriceOutGR);
  const decimalType = getDecimalType();
  request.input("ListPrice", decimalType, listPrice);
  request.input("CostPrice", decimalType, costPrice);
  request.input("ServicePriceGR", decimalType, servicePriceGR ?? null);
  request.input("ServicePriceOutGR", decimalType, servicePriceOutGR ?? null);
  request.input("ServiceType", sql.NVarChar(20), row.serviceType ?? null);
  request.input("Warning", sql.NVarChar(1000), row.warning);
  request.input("MOQ", sql.Int, row.moq ?? null);
  request.input("CreatedBy", sql.NVarChar(450), auditUserId);
  request.input("ModifiedBy", sql.NVarChar(450), auditUserId);

  await request.query(`
    INSERT INTO dbo.PriceListItems (
      PriceListID,
      ProductID,
      ListPrice,
      CostPrice,
      ServicePriceGR,
      ServicePriceOutGR,
      ServiceType,
      Warning,
      MOQ,
      Enabled,
      CreatedOn,
      CreatedBy,
      ModifiedOn,
      ModifiedBy
    )
    VALUES (
      @PriceListID,
      @ProductID,
      @ListPrice,
      @CostPrice,
      @ServicePriceGR,
      @ServicePriceOutGR,
      @ServiceType,
      @Warning,
      @MOQ,
      1,
      SYSUTCDATETIME(),
      @CreatedBy,
      SYSUTCDATETIME(),
      @ModifiedBy
    )
  `);
};

export async function POST(req: NextRequest) {
  logRequest(req, '/api/price-lists/import');
  const requestId = await getRequestId(req);
  const userIdForLog = resolveAuditUserId(req);
  try {
    const auth = await requirePermission(req, "managePriceLists");
    if (!auth.ok) return auth.response;

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Please attach an Excel file." }, { status: 400 });
    }

    const name = normalizeString(formData.get("name"), 255);
    const comments = normalizeString(formData.get("comments"), 2000);
    const supplierComments = normalizeString(formData.get("supplierComments"), 2000);
    const pricingPoliciesRaw = formData.get("pricingPolicies");
    const responsibleUserId = normalizeUserId(formData.get("responsibleUserId"));
    const supplierId = normalizeInt(formData.get("supplierId"));
    const hasDuty = normalizeBool(formData.get("hasDuty"));
    const isService = normalizeBool(formData.get("isService"));
    const costCurrencyId = normalizeInt(formData.get("costCurrencyId"));
    const currencyCostModifier = normalizeDecimal(formData.get("currencyCostModifier"));
    const countryId = normalizeInt(formData.get("countryId"));
    const validFromDate = normalizeDate(formData.get("validFromDate"));
    const validToDate = normalizeDate(formData.get("validToDate"));
    let brandId = normalizeInt(formData.get("brandId"));
    const previousPriceListId = normalizeInt(formData.get("previousPriceListId"));
    const appendToPriceListId = normalizeInt(formData.get("appendToPriceListId"));
    const isAppendMode = appendToPriceListId != null;
    const columnMappings = parseColumnMappings(formData.get("columnMappings"));
    const decimalFormat = normalizePriceListDecimalFormat(formData.get("decimalFormat"));
    // Part/Model swap warning handshake: the first submit detects rows whose
    // Part/Model look swapped vs existing products and returns them (409) without
    // committing. The user then re-submits with acknowledgeSwapWarnings=1 and,
    // optionally, swapCorrections=[rowIndex,...] for the rows to auto-swap back.
    const acknowledgeSwapWarnings = normalizeBool(formData.get("acknowledgeSwapWarnings")) === true;
    const swapCorrections: number[] = (() => {
      const raw = formData.get("swapCorrections");
      if (typeof raw !== "string") return [];
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0);
      } catch {
        return [];
      }
    })();

    const parsePricingPolicies = (value: unknown): Array<{ pricingPolicyId: number }> => {
      if (typeof value !== "string") return [];
      try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) return null;
            const policyId = normalizeInt((entry as { pricingPolicyId?: unknown }).pricingPolicyId);
            if (policyId == null) return null;
            return { pricingPolicyId: policyId };
          })
          .filter((val): val is { pricingPolicyId: number } => val !== null);
      } catch {
        return [];
      }
    };

    const pricingPolicies = parsePricingPolicies(pricingPoliciesRaw);

    const errors: string[] = [];
    if (!isAppendMode) {
      if (!name) errors.push("Price list name is required.");
      if (!brandId) errors.push("Brand is required.");
      if (pricingPolicies.length === 0) errors.push("At least one pricing policy is required.");
      if (!responsibleUserId) errors.push("Responsible user is required.");
      if (!validFromDate) errors.push("Valid from date is required.");
      if (!validToDate) errors.push("Valid to date is required.");

      if (currencyCostModifier != null && currencyCostModifier <= 0) {
        errors.push("Currency cost modifier must be greater than 0.");
      }

      if (validFromDate && validToDate && validFromDate > validToDate) {
        errors.push("Valid from date cannot be after valid to date.");
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ ok: false, error: errors.join(" ") }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const parsedRows = parseWorkbook(buffer, columnMappings, decimalFormat);
    if (!parsedRows.length) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "No valid rows found. Please confirm your column selections include Part Number and List Price data.",
        },
        { status: 400 },
      );
    }

    // Apply user-confirmed Part/Model swap corrections before any downstream
    // processing (brand pattern, existing-product matching) so the corrected
    // values flow through the normal pipeline and match the right product.
    if (acknowledgeSwapWarnings && swapCorrections.length > 0) {
      const correctionSet = new Set(swapCorrections);
      parsedRows.forEach((row, idx) => {
        if (!correctionSet.has(idx)) return;
        const oldPart = row.partNumber;
        row.partNumber = row.modelNumber;
        row.modelNumber = oldPart;
      });
    }

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();

    // In append mode, override brandId from the target pricelist so all downstream
    // lookups (brand pattern, existing products) operate against the correct brand.
    // Also load the set of existing ProductIDs in that pricelist so we can skip
    // duplicates instead of failing on the unique constraint.
    let appendModeName: string | null = null;
    const existingPriceListProductIds = new Set<number>();
    if (isAppendMode && appendToPriceListId != null) {
      const headerReq = pool.request();
      headerReq.input("PLId_append", sql.Int, appendToPriceListId);
      const headerRes = await headerReq.query<{
        ID: number;
        Name: string | null;
        BrandID: number | null;
      }>(`
        SELECT ID, Name, BrandID
        FROM dbo.PriceLists
        WHERE ID = @PLId_append
      `);
      const header = headerRes.recordset?.[0];
      if (!header) {
        return NextResponse.json(
          { ok: false, error: "Target price list not found." },
          { status: 404 },
        );
      }
      if (header.BrandID == null) {
        return NextResponse.json(
          { ok: false, error: "Target price list has no brand assigned." },
          { status: 400 },
        );
      }
      brandId = header.BrandID;
      appendModeName = header.Name;

      const itemsReq = pool.request();
      itemsReq.input("PLId_items", sql.Int, appendToPriceListId);
      const itemsRes = await itemsReq.query<{ ProductID: number }>(`
        SELECT ProductID FROM dbo.PriceListItems WHERE PriceListID = @PLId_items
      `);
      for (const r of itemsRes.recordset ?? []) {
        if (r.ProductID != null) existingPriceListProductIds.add(r.ProductID);
      }
    }

    // Currency is always EUR. Resolve the EUR currency ID from the database and ignore any incoming currencyId.
    const eurLookup = await pool.request().query<{ ID: number; Name: string | null }>(`
      SELECT TOP 1 ID, Name
      FROM dbo.Currencies
      ORDER BY
        CASE
          WHEN Name = N'€' THEN 0
          WHEN LOWER(Name) LIKE '%eur%' THEN 1
          WHEN LOWER(Name) LIKE '%euro%' THEN 2
          ELSE 3
        END,
        Name
    `);
    const eurCurrencyId = eurLookup.recordset?.[0]?.ID ?? null;
    if (!eurCurrencyId) {
      return NextResponse.json(
        { ok: false, error: 'EUR currency is not configured in dbo.Currencies (expected Name like "€" or "EUR").' },
        { status: 400 },
      );
    }

    // Validate all pricing policies have applicable rules
    for (const policy of pricingPolicies) {
      // Validate policy has applicable rules for this brand
      const policyRuleCheck = await pool.request()
        .input('__ppid', sql.Int, policy.pricingPolicyId)
        .input('__brandId', sql.Int, brandId)
        .query<{ cnt: number }>(`
          SELECT COUNT(1) AS cnt
          FROM dbo.PricingPolicyRules ppr
          WHERE ppr.PricingPolicyID = @__ppid
            AND (ppr.BrandID = @__brandId OR ppr.BrandID IS NULL)
        `);
      const applicableRuleCount = policyRuleCheck.recordset?.[0]?.cnt ?? 0;
      if (applicableRuleCount <= 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `Pricing policy ${policy.pricingPolicyId} has no applicable rules for brand ${brandId}. Create a default (All brands) rule or a brand-specific rule first.`,
          },
          { status: 400 },
        );
      }
    }

    // Apply brand-defined part number pattern (e.g. append suffix like "-RT",
    // or insert separators if the imported file has only the digits).
    const brandPatternConfig = await loadBrandPatternConfig(pool, brandId!);
    if (hasPatternConfig(brandPatternConfig)) {
      for (const row of parsedRows) {
        if (!row.partNumber) continue;
        const result = applyBrandPattern(row.partNumber, brandPatternConfig);
        if (result.ok) row.partNumber = result.value;
      }
    }

    const existingProducts = await loadExistingProducts(pool, parsedRows, brandId!);

    const byPartNumber = new Map<string, ProductRow>();
    const byModelNumber = new Map<string, ProductRow>();

    existingProducts.forEach((product: ProductRow) => {
      const partKey = normalizeKey(product.PartNumber);
      const modelKey = normalizeKey(product.ModelNumber);
      if (partKey && !byPartNumber.has(partKey)) byPartNumber.set(partKey, product);
      if (modelKey && !byModelNumber.has(modelKey)) byModelNumber.set(modelKey, product);
    });

    // Build a map from legacy part number -> existing product (keyed by existing PartNumber)
    // This allows matching when the import has a legacyPartNumber column
    const byLegacyPartNumber = new Map<string, ProductRow>();
    parsedRows.forEach((row) => {
      const legacyKey = normalizeKey(row.legacyPartNumber);
      if (legacyKey && byPartNumber.has(legacyKey) && !byLegacyPartNumber.has(legacyKey)) {
        byLegacyPartNumber.set(legacyKey, byPartNumber.get(legacyKey)!);
      }
    });

    // Pre-flight: detect rows whose PartNumber would collide with the
    // global UNIQUE constraint on dbo.Products.PartNumber.  A row is a
    // blocker when it would INSERT a new product (no match found inside
    // this brand) AND its PartNumber already exists under any brand.
    {
      const partNumbersToCheck = Array.from(
        new Set(
          parsedRows
            .map((row) => row.partNumber?.trim() ?? null)
            .filter((value): value is string => Boolean(value)),
        ),
      );

      const globalCollisions = new Map<
        string,
        { id: number; brandId: number | null; brandName: string | null }
      >();
      if (partNumbersToCheck.length > 0) {
        const chunks = chunkArray(partNumbersToCheck, 900);
        for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
          const chunk = chunks[chunkIdx];
          const checkRequest = pool.request();
          const paramNames = chunk.map((val, idx) => {
            const param = `pn_${chunkIdx}_${idx}`;
            checkRequest.input(param, sql.NVarChar(255), val);
            return `@${param}`;
          });
          const result = await checkRequest.query<{
            ID: number;
            PartNumber: string | null;
            BrandID: number | null;
            BrandName: string | null;
          }>(`
            SELECT p.ID, p.PartNumber, p.BrandID, b.Name AS BrandName
            FROM dbo.Products p
            LEFT JOIN dbo.Brands b ON b.ID = p.BrandID
            WHERE p.PartNumber IN (${paramNames.join(", ")})
          `);
          for (const r of result.recordset ?? []) {
            const key = (r.PartNumber ?? "").trim().toLowerCase();
            if (key && !globalCollisions.has(key)) {
              globalCollisions.set(key, {
                id: r.ID,
                brandId: r.BrandID,
                brandName: r.BrandName,
              });
            }
          }
        }
      }

      type ImportBlocker = {
        rowIndex: number;
        partNumber: string;
        modelNumber: string | null;
        description: string | null;
        conflictProductId: number;
        conflictBrandId: number | null;
        conflictBrandName: string | null;
      };
      const blockers: ImportBlocker[] = [];

      parsedRows.forEach((row, idx) => {
        const partKey = normalizeKey(row.partNumber);
        if (!partKey) return;
        const modelKey = normalizeKey(row.modelNumber);
        const legacyKey = normalizeKey(row.legacyPartNumber);

        const sameBrandPartMatch = byPartNumber.has(partKey);
        const legacyMatch = legacyKey ? byLegacyPartNumber.has(legacyKey) : false;
        let modelMatch = false;
        if (!sameBrandPartMatch && !legacyMatch && modelKey && byModelNumber.has(modelKey)) {
          const candidate = byModelNumber.get(modelKey);
          const candidatePartKey = normalizeKey(candidate?.PartNumber);
          modelMatch = !partKey || (candidatePartKey != null && partKey === candidatePartKey);
        }
        if (sameBrandPartMatch || legacyMatch || modelMatch) return;

        const collision = globalCollisions.get(partKey);
        if (collision) {
          blockers.push({
            rowIndex: idx,
            partNumber: row.partNumber!.trim(),
            modelNumber: row.modelNumber,
            description: row.description,
            conflictProductId: collision.id,
            conflictBrandId: collision.brandId,
            conflictBrandName: collision.brandName,
          });
        }
      });

      if (blockers.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `Import cancelled: ${blockers.length} part number${blockers.length > 1 ? "s" : ""} already exist in the database under a different brand.`,
            blockers,
          },
          { status: 409 },
        );
      }
    }

    // Pre-flight: detect rows whose Part/Model columns look SWAPPED vs existing
    // products of this brand. A row that would CREATE a new product (no normal
    // match) but whose imported PartNumber equals an existing product's
    // ModelNumber (or whose imported ModelNumber equals an existing PartNumber)
    // almost always means the file has the two columns reversed — importing
    // as-is would create a reversed-duplicate product. Return them (409) so the
    // user can cancel, import as-is, or auto-swap the chosen rows. Skipped once
    // acknowledged so the re-submit can proceed.
    if (!acknowledgeSwapWarnings) {
      const swapPartKeys = Array.from(
        new Set(parsedRows.map((r) => normalizeKey(r.partNumber)).filter((v): v is string => Boolean(v))),
      );
      const swapModelKeys = Array.from(
        new Set(parsedRows.map((r) => normalizeKey(r.modelNumber)).filter((v): v is string => Boolean(v))),
      );

      const [productsModelEqImportedPart, productsPartEqImportedModel] = await Promise.all([
        fetchProductsByKeys(pool, swapPartKeys, "ModelNumber", brandId!),
        fetchProductsByKeys(pool, swapModelKeys, "PartNumber", brandId!),
      ]);

      const existingModelToProduct = new Map<string, ProductRow>();
      for (const p of productsModelEqImportedPart) {
        const k = normalizeKey(p.ModelNumber);
        if (k && !existingModelToProduct.has(k)) existingModelToProduct.set(k, p);
      }
      const existingPartToProduct = new Map<string, ProductRow>();
      for (const p of productsPartEqImportedModel) {
        const k = normalizeKey(p.PartNumber);
        if (k && !existingPartToProduct.has(k)) existingPartToProduct.set(k, p);
      }

      type SwapWarning = {
        rowIndex: number;
        importedPart: string | null;
        importedModel: string | null;
        description: string | null;
        matchedProductId: number;
        matchedPart: string | null;
        matchedModel: string | null;
        kind: "fullSwap" | "partIsExistingModel" | "modelIsExistingPart";
      };
      const swapWarnings: SwapWarning[] = [];

      parsedRows.forEach((row, idx) => {
        const partKey = normalizeKey(row.partNumber);
        const modelKey = normalizeKey(row.modelNumber);
        const legacyKey = normalizeKey(row.legacyPartNumber);
        if (!partKey && !modelKey) return;

        // If the row matches an existing product the normal way, it is not a swap.
        const sameBrandPartMatch = partKey ? byPartNumber.has(partKey) : false;
        const legacyMatch = legacyKey ? byLegacyPartNumber.has(legacyKey) : false;
        let modelMatch = false;
        if (!sameBrandPartMatch && !legacyMatch && modelKey && byModelNumber.has(modelKey)) {
          const candidate = byModelNumber.get(modelKey);
          const candidatePartKey = normalizeKey(candidate?.PartNumber);
          modelMatch = !partKey || (candidatePartKey != null && partKey === candidatePartKey);
        }
        if (sameBrandPartMatch || legacyMatch || modelMatch) return;

        const byPart = partKey ? existingModelToProduct.get(partKey) : undefined; // imported Part == existing Model
        const byModel = modelKey ? existingPartToProduct.get(modelKey) : undefined; // imported Model == existing Part
        if (!byPart && !byModel) return;

        const matched = byPart ?? byModel!;
        const kind: SwapWarning["kind"] =
          byPart && byModel && byPart.ID === byModel.ID
            ? "fullSwap"
            : byPart
              ? "partIsExistingModel"
              : "modelIsExistingPart";
        swapWarnings.push({
          rowIndex: idx,
          importedPart: row.partNumber,
          importedModel: row.modelNumber,
          description: row.description,
          matchedProductId: matched.ID,
          matchedPart: matched.PartNumber,
          matchedModel: matched.ModelNumber,
          kind,
        });
      });

      if (swapWarnings.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            error: `${swapWarnings.length} row${swapWarnings.length > 1 ? "s" : ""} look like the Part and Model columns are swapped versus existing products.`,
            partModelSwapWarnings: swapWarnings,
          },
          { status: 409 },
        );
      }
    }

    // Load previous prices for import summary comparison
    const previousPriceMap = new Map<number, { listPrice: number | null; costPrice: number | null }>();
    {
      let comparePriceListId = previousPriceListId;
      if (!comparePriceListId) {
        const latestReq = pool.request();
        latestReq.input("BrandID_cmp", sql.Int, brandId);
        const latestResult = await latestReq.query<{ ID: number }>(`
          SELECT TOP 1 ID FROM dbo.PriceLists
          WHERE BrandID = @BrandID_cmp AND Enabled = 1
          ORDER BY CreatedOn DESC
        `);
        comparePriceListId = latestResult.recordset?.[0]?.ID ?? null;
      }
      if (comparePriceListId) {
        const prevReq = pool.request();
        prevReq.input("PLId_cmp", sql.Int, comparePriceListId);
        const prevResult = await prevReq.query<{ ProductID: number; ListPrice: number | null; CostPrice: number | null }>(`
          SELECT ProductID, ListPrice, CostPrice FROM dbo.PriceListItems
          WHERE PriceListID = @PLId_cmp AND Enabled = 1
        `);
        for (const item of prevResult.recordset) {
          previousPriceMap.set(item.ProductID, { listPrice: item.ListPrice, costPrice: item.CostPrice });
        }
      }
    }

    const { relativePath, fileName, absolutePath } = isAppendMode
      ? { relativePath: null as string | null, fileName: "", absolutePath: "" }
      : await saveUploadedFile(buffer, file.name, name);

    const TransactionCtor = (sql as unknown as {
      Transaction: new (pool: ConnectionPool) => TransactionLike;
    }).Transaction;
    const transaction = new TransactionCtor(pool);

    await transaction.begin();

    try {
      let priceListId: number | null = null;

      if (isAppendMode) {
        priceListId = appendToPriceListId;
        if (!priceListId) throw new Error("Missing target price list id for append.");
      } else {
      const resolvedCurrencyId = eurCurrencyId;
      const resolvedCostCurrencyId = costCurrencyId ?? eurCurrencyId;
      const resolvedCurrencyCostModifier =
        resolvedCostCurrencyId === eurCurrencyId ? 1 : (currencyCostModifier ?? 1);

      const priceListRequest = createRequest(transaction);
      priceListRequest.input("Name", sql.NVarChar(255), name);
      priceListRequest.input("BrandID", sql.Int, brandId);
      priceListRequest.input("Comments", sql.NVarChar(2000), comments);
      priceListRequest.input("ValidityComment", sql.NVarChar(2000), supplierComments);
      priceListRequest.input("ResponsibleUserId", sql.NVarChar(450), responsibleUserId);
      priceListRequest.input("SupplierID", sql.Int, supplierId);
      priceListRequest.input("HasDuty", sql.Bit, hasDuty ?? false);
      priceListRequest.input("IsService", sql.Bit, isService ?? false);
      priceListRequest.input("CurrencyId", sql.Int, resolvedCurrencyId);
      priceListRequest.input("CostCurrencyID", sql.Int, resolvedCostCurrencyId);
      priceListRequest.input("CurrencyCostModifier", getDecimalType(), resolvedCurrencyCostModifier);
      priceListRequest.input("CountryId", sql.Int, countryId);
      priceListRequest.input("ValidFromDate", sql.DateTime2, validFromDate);
      priceListRequest.input("ValidToDate", sql.DateTime2, validToDate);
      priceListRequest.input("FilePath", sql.NVarChar(1000), relativePath || fileName);
      priceListRequest.input("CreatedBy", sql.NVarChar(450), auditUserId);
      priceListRequest.input("ModifiedBy", sql.NVarChar(450), auditUserId);

      const insertPriceList = await priceListRequest.query(`
        INSERT INTO dbo.PriceLists (
          Name,
          BrandID,
          Comments,
          ValidityComment,
          ResponsibleUserId,
          SupplierID,
          HasDuty,
          IsService,
          CurrencyId,
          CostCurrencyID,
          CurrencyCostModifier,
          CountryId,
          ValidFromDate,
          ValidToDate,
          Enabled,
          Finalized,
          FilePath,
          CreatedOn,
          CreatedBy,
          ModifiedOn,
          ModifiedBy
        )
        OUTPUT INSERTED.ID AS PriceListID
        VALUES (
          @Name,
          @BrandID,
          @Comments,
          @ValidityComment,
          @ResponsibleUserId,
          @SupplierID,
          @HasDuty,
          @IsService,
          @CurrencyId,
          @CostCurrencyID,
          @CurrencyCostModifier,
          @CountryId,
          @ValidFromDate,
          @ValidToDate,
          1,
          1,
          @FilePath,
          SYSUTCDATETIME(),
          @CreatedBy,
          SYSUTCDATETIME(),
          @ModifiedBy
        )
      `);

      priceListId =
        (insertPriceList.recordset?.[0] as { PriceListID?: number } | undefined)?.PriceListID ?? null;
      if (!priceListId) throw new Error("Failed to create price list");

      // Create PriceListPricingPolicy entries for each pricing policy
      for (const policy of pricingPolicies) {
        const policyRequest = createRequest(transaction);
        policyRequest.input("PriceListID", sql.Int, priceListId);
        policyRequest.input("PricingPolicyID", sql.Int, policy.pricingPolicyId);
        await policyRequest.query(`
          INSERT INTO dbo.PriceListPricingPolicy (
            PriceListID,
            PricingPolicyID
          )
          VALUES (
            @PriceListID,
            @PricingPolicyID
          )
        `);
      }

      if (previousPriceListId) {
        const disableRequest = createRequest(transaction);
        disableRequest.input("PreviousID", sql.Int, previousPriceListId);
        disableRequest.input("ModifiedBy", sql.NVarChar(450), auditUserId);
        await disableRequest.query(`
          UPDATE dbo.PriceLists
          SET Enabled = 0,
              ModifiedOn = SYSUTCDATETIME(),
              ModifiedBy = @ModifiedBy
          WHERE ID = @PreviousID
        `);
      }
      } // end !isAppendMode branch

      const createdProducts = new Map<string, number>();
      const seenProducts = new Set<number>();
      let createdProductCount = 0;
      let matchedProductCount = 0;
      let skippedRows = 0;
      // Track descriptions of processed products for all-caps detection
      const processedProductDescriptions: Array<{ productId: number; description: string | null }> = [];
      const descriptionMismatches: { productId: number; partNumber: string; oldDescription: string; newDescription: string }[] = [];
      const modelNumberMismatches: { productId: number; partNumber: string; oldModelNumber: string; newModelNumber: string }[] = [];
      const newProductDetails: Array<{
        partNumber: string | null;
        description: string | null;
        listPrice: number | null;
        costPrice: number | null;
      }> = [];
      const priceChangeDetails: Array<{
        partNumber: string | null;
        description: string | null;
        oldListPrice: number | null;
        newListPrice: number | null;
        oldCostPrice: number | null;
        newCostPrice: number | null;
      }> = [];
      const skippedRowDetails: Array<{
        partNumber: string | null;
        modelNumber: string | null;
        description: string | null;
        listPrice: number | null;
        reason: string;
      }> = [];

      let legacyUpdatedCount = 0;

      for (const row of parsedRows) {
        const partKey = normalizeKey(row.partNumber);
        const modelKey = normalizeKey(row.modelNumber);
        const legacyKey = normalizeKey(row.legacyPartNumber);
        if (!partKey && !modelKey) {
          skippedRows += 1;
          skippedRowDetails.push({
            partNumber: row.partNumber,
            modelNumber: row.modelNumber,
            description: row.description,
            listPrice: row.listPrice,
            reason: "Missing part number and model number",
          });
          continue;
        }
        if (row.listPrice == null) {
          skippedRows += 1;
          skippedRowDetails.push({
            partNumber: row.partNumber,
            modelNumber: row.modelNumber,
            description: row.description,
            listPrice: row.listPrice,
            reason: "Missing list price",
          });
          continue;
        }

        let productId: number | null = null;
        let isExistingProduct = false;
        let existingProduct: ProductRow | undefined;
        let matchedByLegacy = false;

        if (partKey && byPartNumber.has(partKey)) {
          existingProduct = byPartNumber.get(partKey);
          productId = existingProduct?.ID ?? null;
          isExistingProduct = productId != null;
        } else if (legacyKey && byLegacyPartNumber.has(legacyKey)) {
          // Match by legacy part number: the existing product's current PartNumber matches the legacy key
          existingProduct = byLegacyPartNumber.get(legacyKey);
          productId = existingProduct?.ID ?? null;
          isExistingProduct = productId != null;
          matchedByLegacy = productId != null;
        } else if (modelKey && byModelNumber.has(modelKey)) {
          const candidate = byModelNumber.get(modelKey);
          const candidatePartKey = normalizeKey(candidate?.PartNumber);
          // If import row has a part number, require exact part-number agreement for model fallback.
          // This prevents different part numbers sharing the same model from collapsing into one product.
          const canMatchByModel = !partKey || (candidatePartKey != null && partKey === candidatePartKey);
          if (canMatchByModel) {
            existingProduct = candidate;
            productId = existingProduct?.ID ?? null;
            isExistingProduct = productId != null;
          }
        }

        if (!productId && partKey && createdProducts.has(partKey)) {
          productId = createdProducts.get(partKey) ?? null;
        } else if (!productId && modelKey && !partKey && createdProducts.has(modelKey)) {
          productId = createdProducts.get(modelKey) ?? null;
        }

        if (!productId) {
          productId = await createProduct(transaction, row, brandId!, auditUserId, isService ?? null, row.serviceType);
          createdProductCount += 1;
          newProductDetails.push({
            partNumber: row.partNumber,
            description: row.description,
            listPrice: row.listPrice,
            costPrice: row.costPrice,
          });
        }

        if (!productId || seenProducts.has(productId)) {
          skippedRows += 1;
          skippedRowDetails.push({
            partNumber: row.partNumber,
            modelNumber: row.modelNumber,
            description: row.description,
            listPrice: row.listPrice,
            reason: !productId ? "Could not resolve product" : "Duplicate product in file",
          });
          continue;
        }

        if (isAppendMode && existingPriceListProductIds.has(productId)) {
          skippedRows += 1;
          skippedRowDetails.push({
            partNumber: row.partNumber,
            modelNumber: row.modelNumber,
            description: row.description,
            listPrice: row.listPrice,
            reason: "Already in price list",
          });
          continue;
        }

        if (isExistingProduct) {
          matchedProductCount += 1;

          const oldPrice = previousPriceMap.get(productId!);
          if (oldPrice) {
            const listChanged = oldPrice.listPrice != null && row.listPrice != null && oldPrice.listPrice !== row.listPrice;
            const costChanged = oldPrice.costPrice != null && row.costPrice != null && oldPrice.costPrice !== row.costPrice;
            if (listChanged || costChanged) {
              priceChangeDetails.push({
                partNumber: row.partNumber ?? existingProduct?.PartNumber ?? null,
                description: row.description ?? existingProduct?.Description ?? null,
                oldListPrice: oldPrice.listPrice,
                newListPrice: row.listPrice,
                oldCostPrice: oldPrice.costPrice,
                newCostPrice: row.costPrice,
              });
            }
          }

          // When matched by legacy part number AND a new part number is available,
          // swap old->new part number and store the legacy.
          if (matchedByLegacy && partKey && existingProduct) {
            const updateReq = createRequest(transaction);
            updateReq.input("ProductID", sql.Int, productId);
            updateReq.input("NewPartNumber", sql.NVarChar(255), row.partNumber);
            updateReq.input("NewPartNumberCleared", sql.NVarChar(255), toClearedPartModel(row.partNumber));
            updateReq.input("LegacyPartNo", sql.NVarChar(255), existingProduct.PartNumber);
            updateReq.input("LegacyPartNoCleaned", sql.NVarChar(255), toClearedPartModel(existingProduct.PartNumber));
            updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
            await updateReq.query(`
              UPDATE dbo.Products
              SET PartNumber = @NewPartNumber,
                  PartNumberCleared = @NewPartNumberCleared,
                  LegacyPartNo = @LegacyPartNo,
                  LegacyPartNoCleaned = @LegacyPartNoCleaned,
                  ModifiedOn = SYSUTCDATETIME(),
                  ModifiedBy = @ModifiedBy
              WHERE ID = @ProductID
            `);
            legacyUpdatedCount += 1;
          } else if (legacyKey && isExistingProduct) {
            // Store the legacy part number from the import even when matched by partKey or modelKey,
            // or when matched by legacy but no new part number is available.
            const legacyValue = row.legacyPartNumber?.trim() || null;
            if (legacyValue) {
              const updateReq = createRequest(transaction);
              updateReq.input("ProductID", sql.Int, productId);
              updateReq.input("LegacyPartNo", sql.NVarChar(255), legacyValue);
              updateReq.input("LegacyPartNoCleaned", sql.NVarChar(255), toClearedPartModel(legacyValue));
              updateReq.input("ModifiedBy", sql.NVarChar(450), auditUserId);
              await updateReq.query(`
                UPDATE dbo.Products
                SET LegacyPartNo = @LegacyPartNo,
                    LegacyPartNoCleaned = @LegacyPartNoCleaned,
                    ModifiedOn = SYSUTCDATETIME(),
                    ModifiedBy = @ModifiedBy
                WHERE ID = @ProductID
              `);
              legacyUpdatedCount += 1;
            }
          }

          // Detect description mismatches
          const importDesc = row.description?.trim() || "";
          const existingDesc = existingProduct?.Description?.trim() || "";
          if (importDesc && importDesc.toLowerCase() !== existingDesc.toLowerCase()) {
            descriptionMismatches.push({ productId: productId!, partNumber: existingProduct?.PartNumber || row.partNumber || "", oldDescription: existingDesc, newDescription: row.description! });
          }

          // Detect model number mismatches
          const importModel = row.modelNumber?.trim() || "";
          const existingModel = existingProduct?.ModelNumber?.trim() || "";
          if (importModel && importModel.toLowerCase() !== existingModel.toLowerCase()) {
            modelNumberMismatches.push({ productId: productId!, partNumber: existingProduct?.PartNumber || row.partNumber || "", oldModelNumber: existingModel, newModelNumber: row.modelNumber! });
          }

          // Update WebLink if provided in the import
          if (row.weblink) {
            const updateRequest = createRequest(transaction);
            updateRequest.input("ProductID", sql.Int, productId);
            updateRequest.input("WebLink", sql.NVarChar(1000), row.weblink);
            updateRequest.input("ModifiedBy", sql.NVarChar(450), auditUserId);
            await updateRequest.query(`
              UPDATE dbo.Products
              SET WebLink = @WebLink,
                  ModifiedOn = SYSUTCDATETIME(),
                  ModifiedBy = @ModifiedBy
              WHERE ID = @ProductID
            `);
          }
        }

        const productRecord: ProductRow = {
          ID: productId,
          PartNumber: row.partNumber,
          ModelNumber: row.modelNumber,
          BrandID: brandId,
          Description: row.description,
        };

        if (partKey) {
          createdProducts.set(partKey, productId);
          if (!byPartNumber.has(partKey)) byPartNumber.set(partKey, productRecord);
        }
        if (modelKey) {
          createdProducts.set(modelKey, productId);
          if (!byModelNumber.has(modelKey)) byModelNumber.set(modelKey, productRecord);
        }

        await insertPriceListItem(transaction, priceListId, productId, row, auditUserId);
        seenProducts.add(productId);

        // Track this product's effective description for all-caps detection
        // For new products: use the imported description (that's what was just saved)
        // For existing products: use the existing description (we didn't change it)
        const effectiveDescription = isExistingProduct
          ? (existingProduct?.Description ?? null)
          : row.description;
        processedProductDescriptions.push({ productId, description: effectiveDescription });
      }

      await transaction.commit();

      logAddAuditDetails({
        endpoint: '/api/price-lists/import',
        method: 'POST',
        requestId,
        userId: userIdForLog,
        targetEntity: 'priceListRows',
        createdRows: [{ id: priceListId, name: (isAppendMode ? appendModeName : name) ?? null }],
        message: isAppendMode ? 'Products appended to price list' : 'Price list imported',
        extra: {
          priceListId,
          totalRows: parsedRows.length,
          createdProductCount,
          matchedProductCount,
          legacyUpdatedCount,
          skippedRows,
        },
      });

      // Detect badly-capitalised descriptions.
      //
      // Strategy: look for alphabetic word tokens (punctuation/digits stripped) that are
      // Detect descriptions that are predominantly ALL-CAPS and need fixing.
      //
      // We require that at least 40% of alphabetic tokens (≥5 chars) are fully uppercase
      // AND at least 3 such tokens exist. This avoids false positives from descriptions
      // that merely contain a single acronym (e.g. DANTE, HEVC, UPMAX) embedded in an
      // otherwise correctly-capitalised sentence.
      //
      // Examples that DO trigger (>= 40% caps tokens, >= 3 caps tokens):
      //   "CLICKSHARE HUB PRO EU WITH 2 BUTTONS"   → 4/4 tokens all-caps
      //   "CLICKSHARE BAR CB Core EU WITH 1 BUTTON" → 3/4 tokens all-caps (75%)
      //
      // Examples that do NOT trigger:
      //   "Supports the import of data from multiple file types"  → 0 caps tokens
      //   "Linear Acoustic UPMAX downmix processor"               → 1/3 tokens caps (33%)
      //   "Does NOT include 1st year Premium Support"             → 0 tokens ≥5 chars caps
      const isLikelyBadlyCapitalised = (desc: string | null | undefined): boolean => {
        if (!desc) return false;
        // Split on whitespace and common separators, then strip non-alpha chars from each token
        const tokens = desc
          .split(/[\s|\/,;()\[\]]+/)
          .map((t) => t.replace(/[^a-zA-Z]/g, ""))
          .filter((t) => t.length >= 5);
        if (tokens.length === 0) return false;
        const capsCount = tokens.filter((t) => t === t.toUpperCase()).length;
        // Require at least 3 all-caps tokens AND they make up ≥40% of qualifying tokens
        return capsCount >= 3 && capsCount / tokens.length >= 0.4;
      };

      const allCapsEntries = processedProductDescriptions.filter(({ description }) =>
        isLikelyBadlyCapitalised(description),
      );
      // Offer the fix when ≥2 descriptions are flagged
      const allCapsProductIds = allCapsEntries.length >= 2
        ? allCapsEntries.map(({ productId }) => productId)
        : [];

      return NextResponse.json({
        ok: true,
        priceListId,
        filePath: relativePath || fileName,
        createdProductCount,
        matchedProductCount,
        legacyUpdatedCount,
        skippedRows,
        totalRows: parsedRows.length,
        descriptionMismatches,
        modelNumberMismatches,
        priceChanges: priceChangeDetails,
        newProducts: newProductDetails,
        skippedRowDetails,
        allCapsProductIds,
        allCapsDescriptionCount: allCapsProductIds.length,
      });
    } catch (err) {
      await transaction.rollback();
      if (absolutePath) await fs.rm(absolutePath, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    const sqlNumber = (err as { number?: number } | null)?.number;
    if (sqlNumber === 2627 || sqlNumber === 2601) {
      console.error("Price list import aborted: duplicate part number", err);
      return NextResponse.json(
        {
          ok: false,
          error:
            "Import cancelled: one or more part numbers in the file already exist in the database. Please remove or fix the duplicates and re-upload.",
        },
        { status: 409 },
      );
    }
    console.error("Failed to import price list", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
