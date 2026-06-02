/**
 * Pricelist cleanup core (pure — no React/DOM).
 *
 * Takes the raw rows + column selection from a messy uploaded pricelist and
 * produces normalized, ready-to-import rows:
 *   - adds a Cost column when the file has none, via  Cost = ListPrice × (1 − discount%)
 *     (per-row discount column wins; a single file-wide discount % is the fallback),
 *   - trims junk rows (category/section headers, repeated headers, blanks) using the
 *     same skippable-row rule the importer applies (no Part Number OR no List Price),
 *   - writes an .xlsx whose headers exactly match the importer's standard columns.
 *
 * Consumed by PriceListCleanupClient. Detection/mapping lives in
 * ./priceListColumnDetection; this module only transforms the mapped data.
 */

import { parsePriceValue } from "./parsePriceValue";
import type { PriceListDecimalFormat } from "./priceListDecimalFormats";
import { roundTo } from "./pricing";
import {
  columnKeywords,
  headerContainsKeyword,
  normalizeHeaderText,
  type ColumnOption,
  type HeaderColumnKey,
  type XlsxModule,
} from "./priceListColumnDetection";

/* ── Discount column detection ───────────────────────────────────────────── */

// Kept local to cleanup (NOT added to the shared HeaderColumnKey union, which the
// importer consumes). Bare "%" is intentionally omitted — it false-matches price headers.
export const DISCOUNT_KEYWORDS = [
  "discount",
  "disc",
  "disc.",
  "rabais",
  "remise",
  "sconto",
  "descuento",
  "έκπτωση",
  "εκπτωση",
  "εκπτ",
];

/** Suggest the column that looks like a per-row discount, or null if none matches. */
export const suggestDiscountColumn = (columns: ColumnOption[]): number | null => {
  const hit = columns.find((col) =>
    DISCOUNT_KEYWORDS.some((keyword) => headerContainsKeyword(col.normalized, keyword)),
  );
  return hit ? hit.index : null;
};

/* ── Discount + cost math ────────────────────────────────────────────────── */

/**
 * Parse a discount value into a percentage in 0–100 units.
 *
 *   ""/null            → null  (caller falls back to the file-wide discount)
 *   "20" / "20%" / 20  → 20
 *   "0.20" / "0,2" / 0.2 → 20   (a bare fraction 0<v≤1 with a decimal separator is ×100)
 *   "0.2%"             → 0.2    (an explicit % is taken literally)
 *   "100"              → 100
 *   1                  → 1      (ambiguous integer; treated as 1%, documented)
 */
export const parseDiscountPercent = (
  value: unknown,
  format: PriceListDecimalFormat,
): number | null => {
  if (value == null) return null;
  const raw = typeof value === "string" ? value.trim() : value;
  if (typeof raw === "string" && raw === "") return null;

  const hadPercent = typeof raw === "string" && raw.includes("%");
  const magnitude = parsePriceValue(raw, format);
  if (magnitude == null) return null;

  // Explicit "%" → the number already is a percentage.
  if (hadPercent) return magnitude;

  // Bare value: treat as a 0–1 fraction only when it carried a decimal separator and
  // sits in (0, 1]. Otherwise it is already a percentage (e.g. 20 → 20%, 1 → 1%).
  const hasDecimalSeparator =
    typeof raw === "string" ? /[.,]/.test(raw) : !Number.isInteger(raw);
  if (hasDecimalSeparator && magnitude > 0 && magnitude <= 1) {
    return roundTo(magnitude * 100);
  }
  return magnitude;
};

/**
 * Cost = ListPrice × (1 − discount%). Returns null when the list price is missing or
 * not positive. Discounts < 0 clamp to 0; discounts > 100 cap the cost at 0.
 */
export const computeCost = (
  listPrice: number | null,
  discountPercent: number | null,
): number | null => {
  if (listPrice == null || !Number.isFinite(listPrice) || listPrice <= 0) return null;
  let pct = discountPercent ?? 0;
  if (!Number.isFinite(pct)) pct = 0;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return roundTo(listPrice * (1 - pct / 100), 4);
};

/* ── Row cleanup ─────────────────────────────────────────────────────────── */

/**
 * How the Cost Price column is produced:
 *   "compute"      → Cost = List × (1 − discount%)
 *   "keepExisting" → pass through the file's existing cost column
 *   "none"         → don't produce a cost (the column is omitted from the output)
 */
export type CostMode = "compute" | "keepExisting" | "none";

export type CleanupOptions = {
  selection: Partial<Record<HeaderColumnKey, number | null>>;
  discountColumnIndex: number | null;
  fileWideDiscountPercent: number | null;
  decimalFormat: PriceListDecimalFormat;
  costMode: CostMode;
  // When true, a product row whose List Price isn't a number (e.g. "CALL", "POA") is kept
  // with List Price 0 instead of being trimmed. Header/category rows are still dropped.
  keepNonNumericPrice?: boolean;
};

export type CleanedRow = {
  partNumber: string;
  modelNumber: string | null;
  description: string | null;
  listPrice: number;
  costPrice: number | null;
  warning: string | null;
  moq: number | null;
  weblink: string | null;
  // Optional lifecycle/EOL annotation, added downstream (not produced by cleanupRows).
  status?: string | null;
};

export type CleanupSummary = {
  kept: number;        // product rows written
  trimmed: number;     // junk rows dropped (no part number / header / category rows)
  withCost: number;    // rows that ended with a cost value
  withoutCost: number; // rows left without a cost (e.g. list price ≤ 0)
  capped: number;      // rows where the discount exceeded 100% (cost capped at 0)
  zeroPriced: number;  // kept rows whose non-numeric price (e.g. "CALL") was set to 0
};

export type CleanupResult = { rows: CleanedRow[]; summary: CleanupSummary };

const getCell = (row: Record<number, unknown>, idx: number | null | undefined): unknown =>
  idx == null ? null : row[idx];

const cleanString = (value: unknown): string | null => {
  if (value == null) return null;
  const str = typeof value === "string" ? value.trim() : String(value).trim();
  return str.length ? str : null;
};

const parseInteger = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  const digits = String(value).replace(/[^\d-]/g, "");
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Decide whether a row with a Part Number but a NON-numeric price (e.g. "CALL", "POA") is a
 * real product worth keeping (price → 0), versus a header/category row that should be trimmed.
 * Rejects rows whose mapped cells look like header labels (≥2 keyword hits, e.g. a repeated
 * header), and requires some descriptive content so bare section labels are still dropped.
 */
const isKeepableUnpricedRow = (
  raw: Record<number, unknown>,
  selection: Partial<Record<HeaderColumnKey, number | null>>,
): boolean => {
  let headerKeyHits = 0;
  const countHeaderHit = (key: HeaderColumnKey) => {
    const idx = selection[key];
    if (idx == null) return;
    const normalized = normalizeHeaderText(getCell(raw, idx));
    if (normalized && columnKeywords[key].some((kw) => headerContainsKeyword(normalized, kw))) {
      headerKeyHits += 1;
    }
  };
  countHeaderHit("partNumber");
  countHeaderHit("modelNumber");
  countHeaderHit("description");
  countHeaderHit("listPrice");
  if (headerKeyHits >= 2) return false; // looks like a repeated header row

  const hasContext =
    cleanString(getCell(raw, selection.description ?? null)) != null ||
    cleanString(getCell(raw, selection.modelNumber ?? null)) != null;
  return hasContext;
};

/**
 * Transform raw mapped rows into normalized, cleaned rows. Junk rows are dropped using
 * the importer's skippable-row rule: a row must have a Part Number AND a parseable List
 * Price to be a real product (this naturally removes category/section/repeated headers
 * and blanks, whose "price" parses to null).
 */
export const cleanupRows = (
  allRows: Record<number, unknown>[],
  options: CleanupOptions,
): CleanupResult => {
  const {
    selection,
    discountColumnIndex,
    fileWideDiscountPercent,
    decimalFormat,
    costMode,
    keepNonNumericPrice = false,
  } = options;

  const pnIdx = selection.partNumber ?? null;
  const lpIdx = selection.listPrice ?? null;
  const costIdx = selection.costPrice ?? null;

  const rows: CleanedRow[] = [];
  let trimmed = 0;
  let withCost = 0;
  let withoutCost = 0;
  let capped = 0;
  let zeroPriced = 0;

  for (const raw of allRows) {
    const partNumber = cleanString(getCell(raw, pnIdx));
    if (!partNumber) {
      trimmed += 1;
      continue;
    }

    let listPrice = parsePriceValue(getCell(raw, lpIdx), decimalFormat);
    let pricedAsZero = false;
    if (listPrice == null) {
      // Non-numeric price (e.g. "CALL"). Keep it at 0 if the user opted in and the row is a
      // real product; otherwise treat it as junk (header/category/blank).
      if (keepNonNumericPrice && isKeepableUnpricedRow(raw, selection)) {
        listPrice = 0;
        pricedAsZero = true;
      } else {
        trimmed += 1;
        continue;
      }
    }

    let costPrice: number | null = null;
    if (costMode !== "none") {
      if (costMode === "keepExisting") {
        const existingCost =
          costIdx != null ? parsePriceValue(getCell(raw, costIdx), decimalFormat) : null;
        costPrice = existingCost != null ? roundTo(existingCost, 4) : null;
      } else {
        const rowDiscount =
          discountColumnIndex != null
            ? parseDiscountPercent(getCell(raw, discountColumnIndex), decimalFormat)
            : null;
        const effective = rowDiscount ?? fileWideDiscountPercent;
        costPrice = computeCost(listPrice, effective);
        if ((effective ?? 0) > 100 && costPrice != null) capped += 1;
      }

      if (costPrice != null) withCost += 1;
      else withoutCost += 1;
    }

    if (pricedAsZero) zeroPriced += 1;

    rows.push({
      partNumber,
      modelNumber: cleanString(getCell(raw, selection.modelNumber ?? null)),
      description: cleanString(getCell(raw, selection.description ?? null)),
      listPrice: roundTo(listPrice, 4),
      costPrice,
      warning: cleanString(getCell(raw, selection.warning ?? null)),
      moq: parseInteger(getCell(raw, selection.moq ?? null)),
      weblink: cleanString(getCell(raw, selection.weblink ?? null)),
    });
  }

  return {
    rows,
    summary: { kept: rows.length, trimmed, withCost, withoutCost, capped, zeroPriced },
  };
};

/* ── Workbook output ─────────────────────────────────────────────────────── */

export const COST_PRICE_HEADER = "Cost Price";

// Header labels = the importer's primary synonyms, so the cleaned file re-imports with
// zero column mapping.
export const CLEANED_HEADERS = [
  "Part Number",
  "Model Number",
  "Description",
  "List Price",
  COST_PRICE_HEADER,
  "Warning",
  "MOQ",
  "Weblink",
  "Status",
] as const;

const cellForHeader = (header: string, row: CleanedRow): unknown => {
  switch (header) {
    case "Part Number":
      return row.partNumber;
    case "Model Number":
      return row.modelNumber;
    case "Description":
      return row.description;
    case "List Price":
      return row.listPrice;
    case COST_PRICE_HEADER:
      return row.costPrice;
    case "Warning":
      return row.warning;
    case "MOQ":
      return row.moq;
    case "Weblink":
      return row.weblink;
    case "Status":
      return row.status ?? null;
    default:
      return null;
  }
};

const PRICE_HEADERS: ReadonlySet<string> = new Set(["List Price", COST_PRICE_HEADER]);

// Always-present identity columns, even if (improbably) blank.
const ALWAYS_HEADERS: ReadonlySet<string> = new Set(["Part Number", "List Price"]);

const isBlankCell = (value: unknown): boolean =>
  value == null || (typeof value === "string" && value.trim() === "");

/**
 * The output columns that actually carry data: the normalized headers minus Cost Price (when
 * not included) and minus any optional column that is empty across every row (e.g. Model
 * Number / Warning / MOQ / Weblink when nothing was mapped to them). Part Number and List
 * Price are always kept.
 */
export const usedOutputHeaders = (rows: CleanedRow[], includeCost: boolean): string[] => {
  const candidates = includeCost
    ? [...CLEANED_HEADERS]
    : CLEANED_HEADERS.filter((header) => header !== COST_PRICE_HEADER);
  return candidates.filter(
    (header) =>
      ALWAYS_HEADERS.has(header) || rows.some((row) => !isBlankCell(cellForHeader(header, row))),
  );
};

/**
 * Format a number for export in the chosen decimal format, e.g.
 *   1234.5  → "1,234.50" (dotDecimal) / "1.234,50" (commaDecimal)
 * Keeps 2–4 decimals (2 minimum, trailing zeros beyond that trimmed) and groups thousands.
 */
export const formatDecimalForExport = (
  value: number,
  format: "dotDecimal" | "commaDecimal",
): string => {
  const decimalSep = format === "commaDecimal" ? "," : ".";
  const thousandSep = format === "commaDecimal" ? "." : ",";
  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(4);
  const dotIndex = fixed.indexOf(".");
  const intPart = fixed.slice(0, dotIndex);
  let decPart = fixed.slice(dotIndex + 1).replace(/0+$/, "");
  if (decPart.length < 2) decPart = decPart.padEnd(2, "0");
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousandSep);
  return `${negative ? "-" : ""}${grouped}${decimalSep}${decPart}`;
};

/**
 * Build an .xlsx ArrayBuffer from cleaned rows. Takes the xlsx module as a param so the
 * caller reuses its existing dynamic import. Options:
 *   - includeCost=false  → omit the Cost Price column entirely.
 *   - numberFormat        → write List Price / Cost Price as strings in that format (the one
 *     the user selected). Without it, prices stay numeric cells.
 * Columns that are empty across every row are dropped from the output.
 */
export const buildCleanedWorkbook = (
  rows: CleanedRow[],
  xlsx: XlsxModule,
  options: { includeCost?: boolean; numberFormat?: PriceListDecimalFormat } = {},
): ArrayBuffer => {
  const includeCost = options.includeCost ?? true;
  const fmt = options.numberFormat;
  const formatPrices = fmt === "dotDecimal" || fmt === "commaDecimal";
  const headers = usedOutputHeaders(rows, includeCost);

  const cellValue = (header: string, row: CleanedRow): unknown => {
    const raw = cellForHeader(header, row);
    if (formatPrices && typeof raw === "number" && PRICE_HEADERS.has(header)) {
      return formatDecimalForExport(raw, fmt as "dotDecimal" | "commaDecimal");
    }
    return raw;
  };

  const aoa: unknown[][] = [headers, ...rows.map((row) => headers.map((h) => cellValue(h, row)))];
  const worksheet = xlsx.utils.aoa_to_sheet(aoa);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, worksheet, "Cleaned");
  return xlsx.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
};
