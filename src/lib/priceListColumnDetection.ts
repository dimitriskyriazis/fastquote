/**
 * Shared price-list column / header detection.
 *
 * Pure (no React, no DOM) logic for analysing an uploaded spreadsheet:
 * locating the header row, mapping each column to a known field via
 * multilingual synonym matching, and scoring/auto-selecting suggestions.
 *
 * Consumed by both the price-list importer (PriceListImportClient) and the
 * pricelist cleanup tool (PriceListCleanupClient) so the two stay in sync.
 */

import type * as XLSXTypes from "xlsx";

export type XlsxModule = typeof import("xlsx");

export const loadXlsx = () => import("xlsx");

export type HeaderColumnKey =
  | "partNumber"
  | "modelNumber"
  | "description"
  | "listPrice"
  | "costPrice"
  | "warning"
  | "moq"
  | "weblink"
  | "legacyPartNumber"
  | "servicePriceGR"
  | "servicePriceOutGR"
  | "serviceType";

export const columnKeywords: Record<HeaderColumnKey, string[]> = {
  partNumber: [
    "part ",
    "part_",
    "partno",
    "p/n",
    "sku",
    "item ",
    "item_",
    "article",
    "art ",
    "order ",
    "order_",
    "catalog",
    "cat ",
    " code",
    "product code",
    "prod code",
    "référence",
    "références",
    "réf ",
    "réf.",
    "codice",
    "codigo",
    "código",
    "κωδικός",
    "κωδικος",
    "κωδ.",
    "κωδ ",
    "κωδ_",
    "κωδικοσ",
    "κωδικο προϊόντος",
    "κωδικος προιοντος",
    "κωδ προιοντος",
    "κωδ προ",
    "αρ. είδους",
    "αριθμός είδους",
    "αριθμος ειδους",
    "κωδ παραγγελίας",
    "κωδικος παραγγελιας",
  ],

  modelNumber: [
    "model",
    "series",
    "type ",
    "type_",
    "mpn",
    "mfg",
    "family",
    "rev ",
    "revision",
    "μοντέλο",
    "μοντελο",
    "μτλο",
    "σειρά",
    "σειρα",
    "τύπος",
    "τυπος",
    "μοντ ",
    "μοντ_",
    "κωδ μοντέλου",
    "κωδ μοντελου",
    "κωδ τύπου",
    "κωδ τυπου",
  ],

  description: [
    "desc",
    "description",
    "name",
    "detail",
    "designation",
    "désignation",
    "produit",
    "produkt",
    "producto",
    "bezeichnung",
    "beschreibung",
    "descrizione",
    "descripción",
    "descripcion",
    "περιγραφή",
    "περιγραφη",
    "όνομα",
    "ονομα",
    "ονομασία",
    "ονομασια",
    "περ. ",
    "περ_",
    "λεπτομέρειες",
    "λεπτομερειες",
  ],

  listPrice: [
    "price",
    "list",
    "msrp",
    "rrp",
    "retail",
    "prix",
    "tarif",
    "preis",
    "prezzo",
    "precio",
    "τιμή",
    "τιμη",
    "λιανική",
    "λιανικη",
    "κατάλογ",
    "καταλογος",
    "λιστ",
    "χονδρική",
    "χονδρικη",
    "euros",
    "eur ",
    "ευρώ",
    "€",
    "dollars",
    "usd",
    "$",
  ],

  costPrice: [
    "costprice",
    "cost price",
    "cost",
    "net price",
    "netprice",
    "net ",
    "net_",
    "κόστος",
    "κοστος",
    "τιμή κόστους",
    "τιμη κοστους",
    "καθαρή τιμή",
    "καθαρη τιμη",
  ],

  warning: [
    "warn",
    "remark",
    "note",
    "notes",
    "σημείωση",
    "σημειωση",
    "σημ.",
    "προσοχή",
    "προσοχη",
    "παρατήρηση",
    "παρατηρηση",
    "παρατηρ.",
  ],

  moq: [
    "moq",
    "min order",
    "min_order",
    "minimum order",
    "minimum_order",
    "min qty",
    "min_qty",
    "minimum qty",
    "minimum quantity",
    "ελάχιστη παραγγελία",
    "ελαχιστη παραγγελια",
    "ελάχ. ποσ.",
  ],

  weblink: [
    "weblink",
    "web link",
    "weblnk",
    "url",
    "link",
    "hyperlink",
    "website",
    "web",
    "www",
    "http",
    "https",
    "σύνδεσμος",
    "συνδεσμος",
    "ιστοσελίδα",
    "ιστοσελιδα",
  ],

  legacyPartNumber: [
    "legacy",
    "old part",
    "old_part",
    "oldpart",
    "previous part",
    "previous_part",
    "previouspart",
    "former part",
    "former_part",
    "formerpart",
  ],
  servicePriceGR: [
    "servicepricegr",
    "service price gr",
    "service gr",
    "price gr",
    "τιμή gr",
    "τιμη gr",
  ],
  serviceType: [
    "servicetype",
    "service type",
    "type",
    "τύπος υπηρεσίας",
    "τυπος υπηρεσιας",
  ],
  servicePriceOutGR: [
    "servicepriceoutgr",
    "service price out gr",
    "service outgr",
    "price outgr",
    "τιμή outgr",
    "τιμη outgr",
  ],
};

export const COLUMN_DISPLAY: Array<{ key: HeaderColumnKey; label: string; required?: boolean; serviceOnly?: boolean }> = [
  { key: "partNumber", label: "Part Number", required: true },
  { key: "modelNumber", label: "Model Number (optional)", required: false },
  { key: "description", label: "Name / Description (optional)", required: false },
  { key: "listPrice", label: "List Price", required: true },
  { key: "costPrice", label: "Cost Price (optional)", required: false },
  { key: "warning", label: "Warning (optional)", required: false },
  { key: "moq", label: "MOQ (optional)", required: false },
  { key: "weblink", label: "Weblink (optional)", required: false },
  { key: "legacyPartNumber", label: "Legacy Part Number (optional)", required: false },
  { key: "servicePriceGR", label: "Service Price GR (optional)", required: false, serviceOnly: true },
  { key: "servicePriceOutGR", label: "Service Price OutGR (optional)", required: false, serviceOnly: true },
  { key: "serviceType", label: "Service Type (ServLot/ServPerUnit)", required: false, serviceOnly: true },
];

export const PREVIEW_COLUMN_KEYS: HeaderColumnKey[] = [
  "partNumber",
  "modelNumber",
  "description",
  "listPrice",
  "costPrice",
  "warning",
  "moq",
  "weblink",
  "legacyPartNumber",
  "servicePriceGR",
  "servicePriceOutGR",
  "serviceType",
];

export type ColumnOption = { index: number; label: string; normalized: string };

export type SheetMapping = {
  name: string;
  headerRowIndex: number;
  columns: ColumnOption[];
  suggestions: Record<HeaderColumnKey, ColumnOption[]>;
  selection: Partial<Record<HeaderColumnKey, number | null>>;
  rowCount: number;         // total non-empty data rows (including hidden)
  visibleRowCount: number;  // visible rows only (equals rowCount when no Excel filter)
  enabled: boolean;
  previewRows: Record<number, unknown>[];             // up to 20 visible rows
  allRows: Record<number, unknown>[];                 // all data rows
  visibleDataRowIndices: number[] | null; // null = no Excel filter; array = 0-based indices into allRows that are visible
};

export type FileValidation = {
  status: "idle" | "checking" | "valid" | "invalid";
  message: string | null;
  columns: Partial<Record<HeaderColumnKey, boolean>>;
  rowCount: number;
  sheetName: string | null;
  sheets: SheetMapping[];
  activeSheetIndex: number;
};

export const INITIAL_VALIDATION: FileValidation = {
  status: "idle",
  message: null,
  columns: {},
  rowCount: 0,
  sheetName: null,
  sheets: [],
  activeSheetIndex: 0,
};

export const normalizeHeaderText = (value: unknown): string | null => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const str = typeof value === "number" ? String(value) : value;
  const normalized = str
    .trim()
    .toLowerCase()
    .replace(/[ ]+/g, " ")
    .replace(/[|_/\\-]+/g, " ")
    .replace(/\s+/g, " ");
  return normalized || null;
};

export const normalizeHeaderCompact = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Max word count for a cell to be considered a plausible column header.
 * Real headers are short labels ("Part Number", "List Price").
 * Cells with more words are metadata/sentences (e.g. "This price list is issued to partners…").
 */
export const MAX_HEADER_CELL_WORDS = 6;

export const isPlausibleHeaderCell = (normalizedText: string): boolean => {
  const wordCount = normalizedText.split(/\s+/).filter(Boolean).length;
  return wordCount <= MAX_HEADER_CELL_WORDS;
};

export const headerContainsKeyword = (header: string, keyword: string) => {
  // Normalize keyword content but detect intentional word-boundary spaces.
  // Keywords like "part " use trailing space to avoid matching inside "partner".
  const normalized = keyword
    .toLowerCase()
    .replace(/[ ]+/g, " ")
    .replace(/[|_/\\-]+/g, " ")
    .replace(/\s+/g, " ");
  const core = normalized.trim();
  if (!core) return false;

  const needsLeadingBound = normalized.startsWith(" ");
  const needsTrailingBound = normalized.endsWith(" ");

  // Pad header so boundaries work at string start/end too
  const padded = ` ${header} `;
  const search =
    (needsLeadingBound ? " " : "") + core + (needsTrailingBound ? " " : "");
  if (padded.includes(search)) return true;

  // Compact fallback (handles "Part-Number" ↔ "partnumber") — only for keywords
  // without boundary requirements, otherwise "part" would match inside "partner"
  if (!needsLeadingBound && !needsTrailingBound) {
    const compactHeader = normalizeHeaderCompact(header);
    const compactKeyword = normalizeHeaderCompact(core);
    if (compactKeyword && compactHeader.includes(compactKeyword)) return true;
  }

  return false;
};

const LIST_PRICE_POSITIVE_HINTS = [
  "list",
  "msrp",
  "rrp",
  "retail",
  "catalog",
  "κατάλογ",
  "καταλογ",
  "λιαν",
  "€",
  "eur",
];

const LIST_PRICE_NEGATIVE_HINTS = [
  "discount",
  "disc",
  "net",
  "cost",
  "offer",
  "promo",
  "special",
];

export const scoreColumnForKey = (column: ColumnOption, key: HeaderColumnKey) => {
  const keywords = columnKeywords[key].map((kw) => kw.toLowerCase());
  const matchCount = keywords.reduce<number>(
    (count, keyword) => (headerContainsKeyword(column.normalized, keyword) ? count + 1 : count),
    0,
  );
  if (matchCount === 0) return -1;

  let score = matchCount * 10;
  if (key === "listPrice") {
    const hasPositiveHint = LIST_PRICE_POSITIVE_HINTS.some((hint) =>
      headerContainsKeyword(column.normalized, hint),
    );
    const hasNegativeHint = LIST_PRICE_NEGATIVE_HINTS.some((hint) =>
      headerContainsKeyword(column.normalized, hint),
    );
    if (hasPositiveHint) score += 40;
    if (hasNegativeHint && !hasPositiveHint) score -= 30;
  }

  return score;
};

const scoreHeaderRow = (row: unknown[]) => {
  const normalizedCells = row
    .map((cell) => normalizeHeaderText(cell))
    .filter((value): value is string => Boolean(value));
  if (normalizedCells.length === 0) return -1;

  const matchedKeys = new Set<HeaderColumnKey>();
  let keywordHits = 0;

  normalizedCells.forEach((cell) => {
    // Skip long sentences — they are metadata, not column headers
    if (!isPlausibleHeaderCell(cell)) return;
    (Object.keys(columnKeywords) as HeaderColumnKey[]).forEach((key) => {
      const matches = columnKeywords[key].some((keyword) => headerContainsKeyword(cell, keyword));
      if (!matches) return;
      keywordHits += 1;
      matchedKeys.add(key);
    });
  });

  return matchedKeys.size * 100 + keywordHits * 10 + normalizedCells.length;
};

const matchHeaderKeys = (row: unknown[]): Set<HeaderColumnKey> => {
  const matchedKeys = new Set<HeaderColumnKey>();
  row.forEach((cell) => {
    const normalized = normalizeHeaderText(cell);
    if (!normalized || !isPlausibleHeaderCell(normalized)) return;
    (Object.keys(columnKeywords) as HeaderColumnKey[]).forEach((key) => {
      if (columnKeywords[key].some((keyword) => headerContainsKeyword(normalized, keyword))) {
        matchedKeys.add(key);
      }
    });
  });
  return matchedKeys;
};

const isLikelyHeaderRow = (row: unknown[]) => {
  const normalizedCells = row
    .map((cell) => normalizeHeaderText(cell))
    .filter((value): value is string => Boolean(value));
  // Require at least 3 filled cells — metadata rows with 2 cells (e.g. "Version:" + "MSRP ONLY PRICE LIST")
  // can accidentally match keywords. Real header rows have 3+ columns.
  if (normalizedCells.length < 3) return false;

  const matchedKeys = matchHeaderKeys(row);
  // Accept partNumber OR modelNumber as the identifier column —
  // some pricelists use "Model" instead of "Part Number".
  const hasIdentifier = matchedKeys.has("partNumber") || matchedKeys.has("modelNumber");
  const hasSecondaryKey =
    matchedKeys.has("description") || matchedKeys.has("listPrice");
  return hasIdentifier && hasSecondaryKey && matchedKeys.size >= 2;
};

/**
 * Merge two adjacent rows into one virtual row for multi-row header detection.
 * For each column, prefer the non-empty cell (row2 fills gaps left by row1).
 */
const mergeHeaderRows = (row1: unknown[], row2: unknown[]): unknown[] => {
  const len = Math.max(row1.length, row2.length);
  const merged: unknown[] = [];
  for (let i = 0; i < len; i += 1) {
    merged[i] = hasCellValue(row1[i]) ? row1[i] : row2[i] ?? null;
  }
  return merged;
};

export const hasCellValue = (value: unknown) => {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
};

/** Check if a cell value looks numeric (numbers, prices, percentages). */
const isCellNumeric = (value: unknown): boolean => {
  if (typeof value === "number") return true;
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Strip currency symbols, thousands separators, whitespace, and percent
  const cleaned = trimmed.replace(/[€$£¥%,.\s ]/g, "");
  return cleaned.length > 0 && /^\d+$/.test(cleaned);
};

/**
 * Score how "tabular" the data below a candidate header row looks.
 * A true header row should have consistent, structured data rows following it.
 */
const scoreDataBelow = (rows: unknown[][], headerIdx: number): number => {
  const sampleSize = Math.min(10, rows.length - headerIdx - 1);
  if (sampleSize <= 0) return 0;

  const headerRow = rows[headerIdx];
  let headerWidth = 0;
  if (Array.isArray(headerRow)) {
    headerRow.forEach((cell) => { if (hasCellValue(cell)) headerWidth += 1; });
  }
  if (headerWidth < 2) return 0;

  let nonEmptyRows = 0;
  let totalNumericCells = 0;
  let totalFilledCells = 0;

  for (let offset = 1; offset <= sampleSize; offset += 1) {
    const dataRow = rows[headerIdx + offset];
    if (!Array.isArray(dataRow)) continue;
    const filled = dataRow.filter(hasCellValue).length;
    if (filled === 0) continue;
    nonEmptyRows += 1;
    totalFilledCells += filled;
    dataRow.forEach((cell) => { if (isCellNumeric(cell)) totalNumericCells += 1; });
  }

  if (nonEmptyRows < 2) return 0;

  // Bonus for having consistent data rows below
  let bonus = nonEmptyRows * 5;

  // Bonus if data contains numeric values (prices, quantities)
  if (totalNumericCells > 0) bonus += Math.min(totalNumericCells * 2, 30);

  // Bonus for width consistency: data rows should have similar width to header
  const avgWidth = totalFilledCells / nonEmptyRows;
  if (avgWidth >= headerWidth * 0.5) bonus += 20;

  return bonus;
};

/** Check if a row contains any cell that looks like a long sentence (metadata/title). */
const hasLongTextCell = (row: unknown[]): boolean =>
  row.some((cell) => {
    const normalized = normalizeHeaderText(cell);
    return normalized !== null && !isPlausibleHeaderCell(normalized);
  });

type HeaderDetectionResult = { index: number; span: number; mergedRow: unknown[] | null };

export const detectHeaderRow = (rows: unknown[][]): HeaderDetectionResult => {
  const limit = Math.min(rows.length, 100);

  // Pass 1: prefer the first strongly matching single header row.
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;
    if (isLikelyHeaderRow(row)) return { index: idx, span: 1, mergedRow: null };
  }

  // Pass 2: try multi-row headers — merge row[idx] with row[idx+1] and check.
  // Handles cases like "Pricing" spanning above "List Price" / "Net Price".
  for (let idx = 0; idx < limit - 1; idx += 1) {
    const row = rows[idx];
    const nextRow = rows[idx + 1];
    if (!Array.isArray(row) || !Array.isArray(nextRow)) continue;
    if (hasLongTextCell(row) || hasLongTextCell(nextRow)) continue;
    const merged = mergeHeaderRows(row, nextRow);
    if (isLikelyHeaderRow(merged)) return { index: idx, span: 2, mergedRow: merged };
  }

  // Pass 3: fallback scoring — find the row that most looks like a header.
  let bestIdx = 0;
  let bestScore = -1;
  for (let idx = 0; idx < limit; idx += 1) {
    const row = rows[idx];
    if (!Array.isArray(row)) continue;

    // 1. Keyword-based score (primary signal)
    const keywordScore = scoreHeaderRow(row);
    const base = keywordScore >= 0 ? keywordScore : 0;

    // 2. "Tabular data below" bonus — a true header has consistent data rows after it
    const dataBelow = scoreDataBelow(rows, idx);

    // 3. Penalty for rows that look mostly numeric (likely data rows, not headers)
    const filledCells = row.filter(hasCellValue);
    const numericCount = filledCells.filter(isCellNumeric).length;
    const numericPenalty =
      filledCells.length >= 3 && numericCount / filledCells.length > 0.5 ? 50 : 0;

    // 4. Penalty for very sparse rows (1-2 cells) without strong keyword matches —
    //    these are likely title/metadata rows, not headers
    const sparsePenalty = filledCells.length <= 2 && base <= 100 ? 30 : 0;

    // 5. Bonus for wide rows — real headers have many columns (4+),
    //    metadata rows typically have 1-3 filled cells
    const widthBonus = filledCells.length >= 4 ? Math.min(filledCells.length * 3, 30) : 0;

    // 6. Heavy penalty if the row contains any long-text cell (sentence/paragraph) —
    //    real header rows only have short labels, never prose
    const longTextPenalty = hasLongTextCell(row) ? 200 : 0;

    const score = base + dataBelow + widthBonus - numericPenalty - sparsePenalty - longTextPenalty;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = idx;
    }
  }
  return { index: bestIdx, span: 1, mergedRow: null };
};

export const buildColumns = (headerRow: unknown[]): ColumnOption[] =>
  headerRow.map((cell, idx) => {
    const normalized = normalizeHeaderText(cell) ?? "";
    const label =
      typeof cell === "string"
        ? cell.trim()
        : typeof cell === "number"
          ? String(cell)
          : "";
    const safeLabel = label || `Column ${idx + 1}`;
    return { index: idx, label: safeLabel, normalized };
  });

export const buildSuggestions = (columns: ColumnOption[]) => {
  const makeSuggestions = (key: HeaderColumnKey) => {
    return columns
      .map((col) => ({ col, score: scoreColumnForKey(col, key) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.col.index - b.col.index;
      })
      .map((entry) => entry.col);
  };

  return {
    partNumber: makeSuggestions("partNumber"),
    modelNumber: makeSuggestions("modelNumber"),
    description: makeSuggestions("description"),
    listPrice: makeSuggestions("listPrice"),
    costPrice: makeSuggestions("costPrice"),
    warning: makeSuggestions("warning"),
    moq: makeSuggestions("moq"),
    weblink: makeSuggestions("weblink"),
    legacyPartNumber: makeSuggestions("legacyPartNumber"),
    servicePriceGR: makeSuggestions("servicePriceGR"),
    servicePriceOutGR: makeSuggestions("servicePriceOutGR"),
    serviceType: makeSuggestions("serviceType"),
  };
};

export const autoSelectUniqueSuggestions = (
  suggestions: Record<HeaderColumnKey, ColumnOption[]>,
): Partial<Record<HeaderColumnKey, number | null>> => {
  const selection: Partial<Record<HeaderColumnKey, number | null>> = {};
  const usedIndexes = new Set<number>();

  COLUMN_DISPLAY.forEach((column) => {
    const match = (suggestions[column.key] ?? []).find((opt) => !usedIndexes.has(opt.index));
    if (!match) return;
    selection[column.key] = match.index;
    usedIndexes.add(match.index);
  });

  return selection;
};

export const analyzeSheet = (
  sheetName: string,
  rows: unknown[][],
  rawRows: unknown[][],
  hiddenRowIndices: Set<number>, // 0-based sheet row indices that are hidden in Excel
  fallbackIndex: number,
  enabled: boolean,
): SheetMapping => {
  const detection = detectHeaderRow(rows);
  const headerRow = detection.mergedRow ?? (Array.isArray(rows[detection.index]) ? rows[detection.index] : []);
  const dataStartIndex = detection.index + detection.span;
  const columns = buildColumns(headerRow);
  const suggestions = buildSuggestions(columns);
  const selection = autoSelectUniqueSuggestions(suggestions);

  // Track each data row together with its original index in rawRows (= sheet row index).
  const rawDataRowsIndexed: { row: unknown[]; sheetRowIdx: number }[] = [];
  rawRows.slice(dataStartIndex).forEach((row, relIdx) => {
    if (Array.isArray(row) && row.some(hasCellValue)) {
      rawDataRowsIndexed.push({ row, sheetRowIdx: dataStartIndex + relIdx });
    }
  });

  const rowCount = rawDataRowsIndexed.length;

  const allRows: Record<number, unknown>[] = rawDataRowsIndexed.map(({ row }) => {
    const obj: Record<number, unknown> = {};
    row.forEach((cell, colIdx) => { obj[colIdx] = cell; });
    return obj;
  });

  // Detect Excel filter: any data row whose sheet row index is hidden.
  const hasHiddenDataRows =
    hiddenRowIndices.size > 0 &&
    rawDataRowsIndexed.some(({ sheetRowIdx }) => hiddenRowIndices.has(sheetRowIdx));

  const visibleDataRowIndices: number[] | null = hasHiddenDataRows
    ? rawDataRowsIndexed
        .map(({ sheetRowIdx }, idx) => ({ idx, sheetRowIdx }))
        .filter(({ sheetRowIdx }) => !hiddenRowIndices.has(sheetRowIdx))
        .map(({ idx }) => idx)
    : null;

  const visibleRowCount = visibleDataRowIndices !== null ? visibleDataRowIndices.length : rowCount;

  // Preview shows visible rows only (matches what the user sees in Excel).
  const previewSourceIndices = visibleDataRowIndices ?? allRows.map((_, i) => i);
  const previewRows = previewSourceIndices.slice(0, 20).map((i) => allRows[i]);

  return {
    name: sheetName || `Sheet ${fallbackIndex + 1}`,
    headerRowIndex: detection.index,
    columns,
    suggestions,
    selection,
    rowCount,
    visibleRowCount,
    enabled,
    previewRows,
    allRows,
    visibleDataRowIndices,
  };
};

export const analyzeWorkbook = (workbook: XLSXTypes.WorkBook, xlsx: XlsxModule): SheetMapping[] => {
  const sheets: SheetMapping[] = [];
  for (const sheetName of workbook.SheetNames ?? []) {
    const sheet = workbook.Sheets?.[sheetName];
    if (!sheet) continue;

    // Build a set of 0-based sheet row indices that Excel has hidden (via row filter or manual hide).
    const hiddenRowIndices = new Set<number>();
    const rowsInfo = (sheet as Record<string, unknown>)["!rows"] as
      | Array<{ hidden?: boolean } | null | undefined>
      | undefined;
    if (Array.isArray(rowsInfo)) {
      rowsInfo.forEach((info, idx) => {
        if (info?.hidden) hiddenRowIndices.add(idx);
      });
    }

    const rows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
    const rawRows = xlsx.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
    if (!Array.isArray(rows) || !Array.isArray(rawRows)) continue;
    sheets.push(analyzeSheet(sheetName, rows, rawRows, hiddenRowIndices, sheets.length, sheets.length === 0));
  }
  return sheets;
};

export const evaluateSelection = (sheets: SheetMapping[], activeSheetIndex: number) => {
  const active = sheets[activeSheetIndex];
  if (!active) {
    return {
      status: "invalid" as const,
      message: "Please upload a workbook to choose columns.",
      columns: {},
      rowCount: 0,
      sheetName: null,
    };
  }

  const enabledSheets = sheets.filter((sheet) => sheet.enabled);
  const validSheets = enabledSheets.filter((sheet) => {
    const selection = sheet.selection;
    return selection.partNumber != null && selection.listPrice != null;
  });

  const selection = active.selection;
  const columns: Partial<Record<HeaderColumnKey, boolean>> = {
    partNumber: selection.partNumber != null,
    modelNumber: selection.modelNumber != null,
    description: selection.description != null,
    listPrice: selection.listPrice != null,
    costPrice: selection.costPrice != null,
    warning: selection.warning != null,
    moq: selection.moq != null,
    weblink: selection.weblink != null,
    legacyPartNumber: selection.legacyPartNumber != null,
    servicePriceGR: selection.servicePriceGR != null,
    servicePriceOutGR: selection.servicePriceOutGR != null,
    serviceType: selection.serviceType != null,
  };

  const status: FileValidation["status"] = validSheets.length > 0 ? "valid" : "invalid";
  const message =
    validSheets.length === 0
      ? "Select columns for at least one enabled sheet (Part Number and List Price)."
      : `Using ${validSheets.length} sheet${validSheets.length === 1 ? "" : "s"} with selected columns.`;

  const rowCount = validSheets.reduce((acc, sheet) => acc + sheet.rowCount, 0);

  return { status, message, columns, rowCount, sheetName: active.name };
};

export const validateFileStructure = async (uploadFile: File): Promise<FileValidation> => {
  try {
    const buffer = await uploadFile.arrayBuffer();
    const xlsx = await loadXlsx();
    // cellStyles: true is required for SheetJS to populate !rows[i].hidden,
    // which is how we detect rows hidden by Excel's row filter.
    const workbook = xlsx.read(buffer, { type: "array", cellStyles: true });
    const sheets = analyzeWorkbook(workbook, xlsx);

    if (sheets.length === 0) {
      return {
        ...INITIAL_VALIDATION,
        status: "invalid",
        message: "Could not read any sheets. Please check your file and try again.",
      };
    }

    let activeIndex = 0;
    if (sheets.length > 1) {
      let biggestRowCount = -1;
      sheets.forEach((sheet, idx) => {
        if (sheet.rowCount > biggestRowCount) {
          biggestRowCount = sheet.rowCount;
          activeIndex = idx;
        }
      });
      sheets.forEach((sheet, idx) => {
        sheet.enabled = idx === activeIndex;
      });
    }

    const evaluation = evaluateSelection(sheets, activeIndex);

    return {
      status: evaluation.status,
      message: evaluation.message,
      columns: evaluation.columns,
      rowCount: evaluation.rowCount,
      sheetName: evaluation.sheetName,
      sheets,
      activeSheetIndex: activeIndex,
    };
  } catch (err) {
    console.error("Failed to validate uploaded file", err);
    return {
      ...INITIAL_VALIDATION,
      status: "invalid",
      message: "Unable to read the file. Please upload a valid .xlsx, .xlsm, .xls, or .csv.",
    };
  }
};

/**
 * Build a FileValidation from an already-extracted array-of-arrays (e.g. rows pulled out of a
 * PDF). Runs the same header detection / column mapping as a real workbook, producing a single
 * synthetic sheet.
 */
export const buildValidationFromRows = (sheetName: string, aoa: unknown[][]): FileValidation => {
  const rows = Array.isArray(aoa) ? aoa.filter((r) => Array.isArray(r)) : [];
  if (rows.length === 0) {
    return {
      ...INITIAL_VALIDATION,
      status: "invalid",
      message: "No rows could be extracted from the PDF.",
    };
  }
  const sheet = analyzeSheet(sheetName, rows, rows, new Set<number>(), 0, true);
  const evaluation = evaluateSelection([sheet], 0);
  return {
    status: evaluation.status,
    message: evaluation.message,
    columns: evaluation.columns,
    rowCount: evaluation.rowCount,
    sheetName: evaluation.sheetName,
    sheets: [sheet],
    activeSheetIndex: 0,
  };
};
