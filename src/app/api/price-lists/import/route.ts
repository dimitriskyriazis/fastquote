import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import fs from "node:fs/promises";
import * as XLSX from "xlsx";
import sql from "mssql";
import type { ConnectionPool } from "mssql";
import { getPool } from "../../../../lib/sql";
import { resolveAuditUserId } from "../../../../lib/auditTrail";
import { requirePermission } from "../../../../lib/authz";
import { clearPartModelNumberUpper } from "../../../../lib/partModelNumber";
import {
  DEFAULT_PRICE_LIST_DECIMAL_FORMAT,
  normalizePriceListDecimalFormat,
  type PriceListDecimalFormat,
} from "../../../../lib/priceListDecimalFormats";

export const runtime = "nodejs";

type ParsedPriceListRow = {
  partNumber: string | null;
  modelNumber: string | null;
  description: string | null;
  listPrice: number | null;
  costPrice: number | null;
  warning: string | null;
  weblink: string | null;
};

type ProductRow = {
  ID: number;
  PartNumber: string | null;
  ModelNumber: string | null;
  BrandID: number | null;
  Description: string | null;
};

type HeaderColumnKey = "partNumber" | "modelNumber" | "description" | "listPrice" | "costPrice" | "warning" | "weblink";

type ColumnMapping = {
  sheetName: string | null;
  headerRowIndex: number | null;
  columns: Partial<Record<HeaderColumnKey, number | null>>;
} | null;

const HEADER_SYNONYMS: Record<HeaderColumnKey, string[]> = {
  partNumber: [
    "partnumber", "part number", "partno", "part no", "p/n",
    "sku", "itemno", "item no", "item number", "itemnumber",
    "articleno", "article no", "article number", "articlenumber",
    "orderno", "order no", "order number", "ordernumber",
    "code", "catalog", "catalogno", "catalog no",
    "κωδικός", "κωδικος", "κωδικοσ",
  ],
  modelNumber: [
    "modelnumber", "model number", "modelno", "model no",
    "series", "mpn", "mfg", "family",
    "μοντέλο", "μοντελο", "σειρά", "σειρα", "τύπος", "τυπος",
  ],
  description: [
    "name", "description", "desc", "detail", "details",
    "περιγραφή", "περιγραφη", "όνομα", "ονομα", "ονομασία", "ονομασια",
  ],
  listPrice: [
    "listprice", "list price", "price", "msrp", "rrp",
    "retail", "retailprice", "retail price",
    "τιμή", "τιμη", "λιανική", "λιανικη", "κατάλογος", "καταλογος",
  ],
  costPrice: [
    "costprice", "cost price", "cost",
    "κόστος", "κοστος", "τιμή κόστους", "τιμη κοστους",
  ],
  warning: [
    "warning", "warn", "note", "remark",
    "σημείωση", "σημειωση", "προσοχή", "προσοχη",
  ],
  weblink: [
    "weblink", "web link", "weblnk", "url", "link", "hyperlink",
    "website", "σύνδεσμος", "συνδεσμος", "ιστοσελίδα", "ιστοσελιδα",
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
  return trimmed.replace(/[^\p{L}\p{N}]+/gu, "");
};

const formatNumericPortion = (numericPortion: string, format: PriceListDecimalFormat) => {
  if (format === "dotDecimal") {
    return numericPortion.replace(/,/g, "");
  }
  if (format === "commaDecimal") {
    return numericPortion.replace(/\./g, "").replace(/,/g, ".");
  }
  const commaCount = (numericPortion.match(/,/g) || []).length;
  const dotCount = (numericPortion.match(/\./g) || []).length;
  if (commaCount > 0 && dotCount > 0) {
    // Infer decimal separator from the right-most separator.
    const lastComma = numericPortion.lastIndexOf(",");
    const lastDot = numericPortion.lastIndexOf(".");
    if (lastComma > lastDot) {
      return numericPortion.replace(/\./g, "").replace(/,/g, ".");
    }
    return numericPortion.replace(/,/g, "");
  }
  if (commaCount > 0 && dotCount === 0) {
    return numericPortion.replace(/,/g, ".");
  }
  return numericPortion.replace(/,/g, "");
};

const parsePrice = (value: unknown, format: PriceListDecimalFormat): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const numericPortion = raw.replace(/[^\d.,-]/g, "");
  if (!numericPortion) return null;
  const normalized = formatNumericPortion(numericPortion, format);
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

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
    return { sheetName, headerRowIndex, columns };
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

  const isLikelyHeaderRow = (row: unknown[]) => {
    const matchedKeys = new Set<HeaderColumnKey>();
    row.forEach((cell) => {
      const normalized = normalizeHeaderValue(cell);
      if (!normalized) return;
      (Object.keys(HEADER_SYNONYMS) as HeaderColumnKey[]).forEach((key) => {
        if (matchesHeaderKey(normalized, key)) matchedKeys.add(key);
      });
    });
    const hasPart = matchedKeys.has("partNumber");
    const hasSecondary =
      matchedKeys.has("description") || matchedKeys.has("modelNumber") || matchedKeys.has("listPrice");
    return hasPart && hasSecondary && matchedKeys.size >= 2;
  };

  // Prefer the first strongly matching header row to avoid treating data rows as headers.
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    if (isLikelyHeaderRow(row)) {
      const columnMap: Partial<Record<HeaderColumnKey, number>> = {};
      row.forEach((cell, colIdx) => {
        const normalized = normalizeHeaderValue(cell);
        if (!normalized) return;
        (Object.keys(HEADER_SYNONYMS) as HeaderColumnKey[]).forEach((key) => {
          if (columnMap[key] != null) return;
          if (matchesHeaderKey(normalized, key)) columnMap[key] = colIdx;
        });
      });
      return { headerRowIndex: idx, columnMap };
    }
  }

  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    const columnMap: Partial<Record<HeaderColumnKey, number>> = {};
    row.forEach((cell, colIdx) => {
      const normalized = normalizeHeaderValue(cell);
      if (!normalized) return;
      (Object.keys(HEADER_SYNONYMS) as HeaderColumnKey[]).forEach((key) => {
        if (columnMap[key] != null) return;
        const matchesHeader = matchesHeaderKey(normalized, key);
        if (matchesHeader) {
          columnMap[key] = colIdx;
        }
      });
    });

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
  headerRowIndex: number,
  columnMap: Partial<Record<HeaderColumnKey, number | null>>,
  decimalFormat: PriceListDecimalFormat,
  sheet: XLSX.WorkSheet | null = null,
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

  for (let rIdx = safeHeaderRowIndex + 1; rIdx < rows.length; rIdx += 1) {
    const row = rows[rIdx];
    if (!Array.isArray(row)) continue;
    const partNumber = normalizeCellString(getValue(row, "partNumber"), 50);
    const modelNumber = normalizeCellString(getValue(row, "modelNumber"), 50);
    const description = normalizeCellString(getValue(row, "description"), 2000);
    const listPrice = parsePrice(getValue(row, "listPrice"), decimalFormat);
    const costPrice = parsePrice(getValue(row, "costPrice"), decimalFormat);
    const warning = normalizeCellString(getValue(row, "warning"), 1000);
    
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
      warning,
      weblink,
    });
  }

  return parsed;
};

const parseSheet = (rows: unknown[][], decimalFormat: PriceListDecimalFormat, sheet: XLSX.WorkSheet | null = null): ParsedPriceListRow[] | null => {
  const header = findHeaderRow(rows);
  if (!header) return null;
  const { headerRowIndex, columnMap } = header;
  const parsed: ParsedPriceListRow[] = [];

  const getValue = (row: unknown[], key: HeaderColumnKey) => {
    const idx = columnMap[key];
    if (idx == null) return null;
    return row[idx] ?? null;
  };

  for (let rIdx = headerRowIndex + 1; rIdx < rows.length; rIdx += 1) {
    const row = rows[rIdx];
    if (!Array.isArray(row)) continue;
    const partNumber = normalizeCellString(getValue(row, "partNumber"), 50);
    const modelNumber = normalizeCellString(getValue(row, "modelNumber"), 50);
    const description = normalizeCellString(getValue(row, "description"), 2000);
    const listPrice = parsePrice(getValue(row, "listPrice"), decimalFormat);
    const costPrice = parsePrice(getValue(row, "costPrice"), decimalFormat);
    const warning = normalizeCellString(getValue(row, "warning"), 1000);
    
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
      warning,
      weblink,
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
            const headerRowIndex =
              typeof columnMapping.headerRowIndex === "number" && columnMapping.headerRowIndex >= 0
                ? columnMapping.headerRowIndex
                : 0;
            const parsed = parseSheetWithMapping(
              rows,
              headerRowIndex,
              columnMapping.columns ?? {},
              decimalFormat,
              sheet,
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
      const parsed = parseSheet(rows, decimalFormat, sheet);
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
) => {
  if (keys.length === 0) return [] as ProductRow[];

  const columnExpression = `LOWER(LTRIM(RTRIM(${columnName})))`;
  const rows: ProductRow[] = [];
  const chunks = chunkArray(keys, 900);

  for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx += 1) {
    const chunk = chunks[chunkIdx];
    const request = pool.request();
    const paramNames = chunk.map((val, idx) => {
      const param = `${columnName.toLowerCase()}_${chunkIdx}_${idx}`;
      request.input(param, sql.NVarChar(255), val);
      return `@${param}`;
    });

    const result = await request.query(`
      SELECT ID, PartNumber, ModelNumber, BrandID, Description
      FROM dbo.Products
      WHERE ${columnExpression} IN (${paramNames.join(", ")})
    `);
    rows.push(...((result.recordset ?? []) as ProductRow[]));
  }

  return rows;
};

const loadExistingProducts = async (pool: ConnectionPool, parsedRows: ParsedPriceListRow[]) => {
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

  if (partKeys.length === 0 && modelKeys.length === 0) return [] as ProductRow[];

  const [partProducts, modelProducts] = await Promise.all([
    fetchProductsByKeys(pool, partKeys, "PartNumber"),
    fetchProductsByKeys(pool, modelKeys, "ModelNumber"),
  ]);

  const allProducts = [...partProducts, ...modelProducts];
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
) => {
  const partNumberCleared = toClearedPartModel(row.partNumber);
  const modelNumberCleared = toClearedPartModel(row.modelNumber);
  const request = createRequest(transaction);
  request.input("BrandID", sql.Int, brandId);
  request.input("PartNumber", sql.NVarChar(255), row.partNumber);
  request.input("ModelNumber", sql.NVarChar(255), row.modelNumber);
  request.input("PartNumberCleared", sql.NVarChar(255), partNumberCleared);
  request.input("ModelNumberCleared", sql.NVarChar(255), modelNumberCleared);
  request.input("Description", sql.NVarChar(2000), row.description);
  request.input("WebLink", sql.NVarChar(1000), row.weblink);
  request.input("CreatedBy", sql.NVarChar(450), auditUserId);
  request.input("ModifiedBy", sql.NVarChar(450), auditUserId);

  const insertResult = await request.query(`
    INSERT INTO dbo.Products (
      BrandID,
      PartNumber,
      ModelNumber,
      PartNumberCleared,
      ModelNumberCleared,
      Description,
      WebLink,
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
      @Description,
      @WebLink,
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
  const decimalType = getDecimalType();
  request.input("ListPrice", decimalType, listPrice);
  request.input("CostPrice", decimalType, costPrice);
  request.input("Warning", sql.NVarChar(1000), row.warning);
  request.input("CreatedBy", sql.NVarChar(450), auditUserId);
  request.input("ModifiedBy", sql.NVarChar(450), auditUserId);

  await request.query(`
    INSERT INTO dbo.PriceListItems (
      PriceListID,
      ProductID,
      ListPrice,
      CostPrice,
      Warning,
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
      @Warning,
      1,
      SYSUTCDATETIME(),
      @CreatedBy,
      SYSUTCDATETIME(),
      @ModifiedBy
    )
  `);
};

export async function POST(req: NextRequest) {
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
    const costCurrencyId = normalizeInt(formData.get("costCurrencyId"));
    const currencyCostModifier = normalizeDecimal(formData.get("currencyCostModifier"));
    const countryId = normalizeInt(formData.get("countryId"));
    const validFromDate = normalizeDate(formData.get("validFromDate"));
    const validToDate = normalizeDate(formData.get("validToDate"));
    const brandId = normalizeInt(formData.get("brandId"));
    const previousPriceListId = normalizeInt(formData.get("previousPriceListId"));
    const columnMappings = parseColumnMappings(formData.get("columnMappings"));
    const decimalFormat = normalizePriceListDecimalFormat(formData.get("decimalFormat"));

    const parsePricingPolicies = (value: unknown): Array<{ pricingPolicyId: number; pricingPolicyRuleId: number | null }> => {
      if (typeof value !== "string") return [];
      try {
        const parsed = JSON.parse(value) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) return null;
            const policyId = normalizeInt((entry as { pricingPolicyId?: unknown }).pricingPolicyId);
            const ruleId = normalizeInt((entry as { pricingPolicyRuleId?: unknown }).pricingPolicyRuleId);
            if (policyId == null) return null;
            return { pricingPolicyId: policyId, pricingPolicyRuleId: ruleId };
          })
          .filter((val): val is { pricingPolicyId: number; pricingPolicyRuleId: number | null } => val !== null);
      } catch {
        return [];
      }
    };

    const pricingPolicies = parsePricingPolicies(pricingPoliciesRaw);

    const errors: string[] = [];
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

    const auditUserId = resolveAuditUserId(req);
    const pool = await getPool();

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
      if (policy.pricingPolicyRuleId != null) {
        // Validate specific rule matches policy and brand
        const ruleCheck = await pool.request()
          .input('__ruleId', sql.Int, policy.pricingPolicyRuleId)
          .input('__ppid', sql.Int, policy.pricingPolicyId)
          .input('__brandId', sql.Int, brandId)
          .query<{ cnt: number }>(`
            SELECT COUNT(1) AS cnt
            FROM dbo.PricingPolicyRules ppr
            WHERE ppr.ID = @__ruleId
              AND ppr.PricingPolicyID = @__ppid
              AND (ppr.BrandID = @__brandId OR ppr.BrandID IS NULL)
          `);
        const validRuleCount = ruleCheck.recordset?.[0]?.cnt ?? 0;
        if (validRuleCount <= 0) {
          return NextResponse.json(
            {
              ok: false,
              error: `Pricing policy rule ${policy.pricingPolicyRuleId} does not match policy ${policy.pricingPolicyId} and brand ${brandId}.`,
            },
            { status: 400 },
          );
        }
      } else {
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
    }

    const existingProducts = await loadExistingProducts(pool, parsedRows);

    const byPartNumber = new Map<string, ProductRow>();
    const byModelNumber = new Map<string, ProductRow>();

    existingProducts.forEach((product: ProductRow) => {
      const partKey = normalizeKey(product.PartNumber);
      const modelKey = normalizeKey(product.ModelNumber);
      if (partKey && !byPartNumber.has(partKey)) byPartNumber.set(partKey, product);
      if (modelKey && !byModelNumber.has(modelKey)) byModelNumber.set(modelKey, product);
    });

    const { relativePath, fileName, absolutePath } = await saveUploadedFile(buffer, file.name, name);

    const TransactionCtor = (sql as unknown as {
      Transaction: new (pool: ConnectionPool) => TransactionLike;
    }).Transaction;
    const transaction = new TransactionCtor(pool);

    await transaction.begin();

    try {
      const resolvedCurrencyId = eurCurrencyId;
      const resolvedCostCurrencyId = costCurrencyId ?? eurCurrencyId;
      const resolvedCurrencyCostModifier =
        resolvedCostCurrencyId === eurCurrencyId ? 1 : (currencyCostModifier ?? 1);

      const priceListRequest = createRequest(transaction);
      priceListRequest.input("Name", sql.NVarChar(255), name);
      priceListRequest.input("BrandID", sql.Int, brandId);
      priceListRequest.input("Comments", sql.NVarChar(2000), comments);
      priceListRequest.input("SupplierComment", sql.NVarChar(2000), supplierComments);
      priceListRequest.input("ResponsibleUserId", sql.NVarChar(450), responsibleUserId);
      priceListRequest.input("SupplierID", sql.Int, supplierId);
      priceListRequest.input("HasDuty", sql.Bit, hasDuty ?? false);
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
          SupplierComment,
          ResponsibleUserId,
          SupplierID,
          HasDuty,
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
          @SupplierComment,
          @ResponsibleUserId,
          @SupplierID,
          @HasDuty,
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

      const priceListId =
        (insertPriceList.recordset?.[0] as { PriceListID?: number } | undefined)?.PriceListID ?? null;
      if (!priceListId) throw new Error("Failed to create price list");

      // Create PriceListPricingPolicy entries for each pricing policy
      for (const policy of pricingPolicies) {
        const policyRequest = createRequest(transaction);
        policyRequest.input("PriceListID", sql.Int, priceListId);
        policyRequest.input("PricingPolicyID", sql.Int, policy.pricingPolicyId);
        policyRequest.input("PricingPolicyRuleID", sql.Int, policy.pricingPolicyRuleId);
        await policyRequest.query(`
          INSERT INTO dbo.PriceListPricingPolicy (
            PriceListID,
            PricingPolicyID,
            PricingPolicyRuleID
          )
          VALUES (
            @PriceListID,
            @PricingPolicyID,
            @PricingPolicyRuleID
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

      const createdProducts = new Map<string, number>();
      const seenProducts = new Set<number>();
      let createdProductCount = 0;
      let matchedProductCount = 0;
      let skippedRows = 0;
      const descriptionMismatches: { productId: number; newDescription: string }[] = [];

      for (const row of parsedRows) {
        const partKey = normalizeKey(row.partNumber);
        const modelKey = normalizeKey(row.modelNumber);
        if (!partKey && !modelKey) {
          skippedRows += 1;
          continue;
        }
        if (row.listPrice == null) {
          skippedRows += 1;
          continue;
        }

        let productId: number | null = null;
        let isExistingProduct = false;
        let existingProduct: ProductRow | undefined;

        if (partKey && byPartNumber.has(partKey)) {
          existingProduct = byPartNumber.get(partKey);
          productId = existingProduct?.ID ?? null;
          isExistingProduct = productId != null;
        } else if (modelKey && byModelNumber.has(modelKey)) {
          existingProduct = byModelNumber.get(modelKey);
          productId = existingProduct?.ID ?? null;
          isExistingProduct = productId != null;
        } else if (partKey && createdProducts.has(partKey)) {
          productId = createdProducts.get(partKey) ?? null;
        } else if (modelKey && createdProducts.has(modelKey)) {
          productId = createdProducts.get(modelKey) ?? null;
        }

        if (!productId) {
          productId = await createProduct(transaction, row, brandId!, auditUserId);
          createdProductCount += 1;
        }

        if (!productId || seenProducts.has(productId)) {
          skippedRows += 1;
          continue;
        }

        if (isExistingProduct) {
          matchedProductCount += 1;

          // Detect description mismatches
          const importDesc = row.description?.trim() || "";
          const existingDesc = existingProduct?.Description?.trim() || "";
          if (importDesc && existingDesc && importDesc.toLowerCase() !== existingDesc.toLowerCase()) {
            descriptionMismatches.push({ productId: productId!, newDescription: row.description! });
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
      }

      await transaction.commit();
      return NextResponse.json({
        ok: true,
        priceListId,
        filePath: relativePath || fileName,
        createdProductCount,
        matchedProductCount,
        skippedRows,
        totalRows: parsedRows.length,
        descriptionMismatches,
      });
    } catch (err) {
      await transaction.rollback();
      await fs.rm(absolutePath, { force: true }).catch(() => {});
      throw err;
    }
  } catch (err) {
    console.error("Failed to import price list", err);
    const message = err instanceof Error ? err.message : "Server error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
