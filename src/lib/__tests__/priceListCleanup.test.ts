import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  parseDiscountPercent,
  computeCost,
  suggestDiscountColumn,
  cleanupRows,
  buildCleanedWorkbook,
  formatDecimalForExport,
  CLEANED_HEADERS,
  type CleanedRow,
} from "../priceListCleanup";
import type { ColumnOption } from "../priceListColumnDetection";

describe("parseDiscountPercent", () => {
  it("treats a bare integer as a percentage", () => {
    expect(parseDiscountPercent("20", "dotDecimal")).toBe(20);
    expect(parseDiscountPercent("100", "dotDecimal")).toBe(100);
  });

  it("respects an explicit percent sign literally", () => {
    expect(parseDiscountPercent("20%", "dotDecimal")).toBe(20);
    expect(parseDiscountPercent("0.2%", "dotDecimal")).toBe(0.2);
  });

  it("scales a 0–1 fraction with a decimal separator to a percentage", () => {
    expect(parseDiscountPercent("0.20", "dotDecimal")).toBe(20);
    expect(parseDiscountPercent("0,2", "commaDecimal")).toBe(20);
    expect(parseDiscountPercent(0.2, "auto")).toBe(20);
  });

  it("keeps decimal percentages above 1 as-is", () => {
    expect(parseDiscountPercent("20.5", "dotDecimal")).toBe(20.5);
  });

  it("treats the ambiguous integer 1 as 1%", () => {
    expect(parseDiscountPercent("1", "dotDecimal")).toBe(1);
    expect(parseDiscountPercent(1, "auto")).toBe(1);
  });

  it("returns null for empty/blank input", () => {
    expect(parseDiscountPercent("", "dotDecimal")).toBeNull();
    expect(parseDiscountPercent("   ", "dotDecimal")).toBeNull();
    expect(parseDiscountPercent(null, "dotDecimal")).toBeNull();
    expect(parseDiscountPercent(undefined, "dotDecimal")).toBeNull();
  });
});

describe("computeCost", () => {
  it("applies a straightforward discount", () => {
    expect(computeCost(100, 20)).toBe(80);
    expect(computeCost(100, 0)).toBe(100);
  });

  it("rounds to 4 decimal places", () => {
    expect(computeCost(99.99, 13)).toBe(86.9913);
  });

  it("caps a discount above 100% (cost floored at 0)", () => {
    expect(computeCost(100, 120)).toBe(0);
  });

  it("clamps a negative discount to 0", () => {
    expect(computeCost(100, -5)).toBe(100);
  });

  it("returns null for a missing or non-positive list price", () => {
    expect(computeCost(null, 20)).toBeNull();
    expect(computeCost(0, 20)).toBeNull();
    expect(computeCost(-10, 20)).toBeNull();
  });

  it("treats a null discount as 0%", () => {
    expect(computeCost(100, null)).toBe(100);
  });
});

describe("suggestDiscountColumn", () => {
  const col = (index: number, normalized: string): ColumnOption => ({
    index,
    label: normalized,
    normalized,
  });

  it("finds an English discount column", () => {
    const columns = [col(0, "part number"), col(1, "list price"), col(2, "discount")];
    expect(suggestDiscountColumn(columns)).toBe(2);
  });

  it("finds a Greek discount column", () => {
    const columns = [col(0, "κωδικος"), col(1, "τιμη"), col(2, "έκπτωση")];
    expect(suggestDiscountColumn(columns)).toBe(2);
  });

  it("returns null when no column looks like a discount", () => {
    const columns = [col(0, "part number"), col(1, "list price"), col(2, "description")];
    expect(suggestDiscountColumn(columns)).toBeNull();
  });
});

describe("cleanupRows", () => {
  const selection = { partNumber: 0, listPrice: 1, description: 2 };

  it("uses a per-row discount when present and the file-wide discount otherwise", () => {
    const rows: Record<number, unknown>[] = [
      { 0: "ABC-1", 1: "100", 2: "Widget", 3: "20" }, // per-row 20% → 80
      { 0: "ABC-2", 1: "250", 2: "Gadget" }, // no per-row → file-wide 30% → 175
    ];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: 3,
      fileWideDiscountPercent: 30,
      decimalFormat: "dotDecimal",
      costMode: "compute",
    });
    expect(out.map((r) => r.costPrice)).toEqual([80, 175]);
    expect(summary.kept).toBe(2);
    expect(summary.withCost).toBe(2);
  });

  it("trims category headers, repeated headers, blanks and price-less rows", () => {
    const rows: Record<number, unknown>[] = [
      { 0: "ABC-1", 1: "100", 2: "Widget" }, // valid
      { 0: "BRAKES" }, // category section header → no price
      { 0: "Part Number", 1: "List Price", 2: "Description" }, // repeated header → price not numeric
      {}, // blank
      { 0: "ABC-3", 1: "" }, // part number but no price
    ];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: null,
      fileWideDiscountPercent: 10,
      decimalFormat: "dotDecimal",
      costMode: "compute",
    });
    expect(out).toHaveLength(1);
    expect(out[0].partNumber).toBe("ABC-1");
    expect(summary.kept).toBe(1);
    expect(summary.trimmed).toBe(4);
  });

  it("counts capped rows when a discount exceeds 100%", () => {
    const rows: Record<number, unknown>[] = [{ 0: "ABC-1", 1: "100", 2: "Widget", 3: "150" }];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: 3,
      fileWideDiscountPercent: null,
      decimalFormat: "dotDecimal",
      costMode: "compute",
    });
    expect(out[0].costPrice).toBe(0);
    expect(summary.capped).toBe(1);
    expect(summary.withCost).toBe(1);
  });

  it("keeps existing cost values when costMode is keepExisting", () => {
    const rows: Record<number, unknown>[] = [{ 0: "ABC-1", 1: "100", 2: "Widget", 4: "73.5" }];
    const { rows: out } = cleanupRows(rows, {
      selection: { ...selection, costPrice: 4 },
      discountColumnIndex: 3,
      fileWideDiscountPercent: 30,
      decimalFormat: "dotDecimal",
      costMode: "keepExisting",
    });
    expect(out[0].costPrice).toBe(73.5);
  });

  it("produces no cost in 'none' mode", () => {
    const rows: Record<number, unknown>[] = [{ 0: "ABC-1", 1: "100", 2: "Widget", 3: "20" }];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: 3,
      fileWideDiscountPercent: 30,
      decimalFormat: "dotDecimal",
      costMode: "none",
    });
    expect(out).toHaveLength(1);
    expect(out[0].costPrice).toBeNull();
    expect(summary.withCost).toBe(0);
    expect(summary.withoutCost).toBe(0);
    expect(summary.kept).toBe(1);
  });

  it("keeps a non-numeric-price product at 0 when keepNonNumericPrice is on", () => {
    const rows: Record<number, unknown>[] = [
      { 0: "CS0622", 1: "CALL", 2: "Cloud service annual fee - price must be calculated" },
      { 0: "CS0604", 1: "357 EUR", 2: "Mandatory license" },
    ];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: null,
      fileWideDiscountPercent: null,
      decimalFormat: "dotDecimal",
      costMode: "none",
      keepNonNumericPrice: true,
    });
    expect(out).toHaveLength(2);
    expect(out[0].partNumber).toBe("CS0622");
    expect(out[0].listPrice).toBe(0);
    expect(out[1].listPrice).toBe(357);
    expect(summary.zeroPriced).toBe(1);
    expect(summary.kept).toBe(2);
  });

  it("still trims a non-numeric-price row when keepNonNumericPrice is off", () => {
    const rows: Record<number, unknown>[] = [
      { 0: "CS0622", 1: "CALL", 2: "Cloud service annual fee" },
    ];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: null,
      fileWideDiscountPercent: null,
      decimalFormat: "dotDecimal",
      costMode: "none",
      keepNonNumericPrice: false,
    });
    expect(out).toHaveLength(0);
    expect(summary.trimmed).toBe(1);
  });

  it("does not keep repeated-header or bare category rows even with keepNonNumericPrice on", () => {
    const rows: Record<number, unknown>[] = [
      { 0: "Product code", 1: "List Price", 2: "Description" }, // repeated header
      { 0: "CUE Solution 1-year Annual Licenses" }, // bare category label, no description
      { 0: "CS0622", 1: "CALL", 2: "Cloud service annual fee" }, // real product
    ];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: null,
      fileWideDiscountPercent: null,
      decimalFormat: "dotDecimal",
      costMode: "none",
      keepNonNumericPrice: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0].partNumber).toBe("CS0622");
    expect(summary.trimmed).toBe(2);
  });

  it("leaves cost blank for a zero list price and counts it", () => {
    const rows: Record<number, unknown>[] = [{ 0: "ABC-1", 1: "0", 2: "Freebie" }];
    const { rows: out, summary } = cleanupRows(rows, {
      selection,
      discountColumnIndex: null,
      fileWideDiscountPercent: 20,
      decimalFormat: "dotDecimal",
      costMode: "compute",
    });
    expect(out).toHaveLength(1);
    expect(out[0].costPrice).toBeNull();
    expect(summary.withoutCost).toBe(1);
  });
});

describe("formatDecimalForExport", () => {
  it("formats dotDecimal with comma thousands and dot decimals", () => {
    expect(formatDecimalForExport(1234.5, "dotDecimal")).toBe("1,234.50");
    expect(formatDecimalForExport(175, "dotDecimal")).toBe("175.00");
    expect(formatDecimalForExport(1000000, "dotDecimal")).toBe("1,000,000.00");
  });

  it("formats commaDecimal with dot thousands and comma decimals", () => {
    expect(formatDecimalForExport(1234.5, "commaDecimal")).toBe("1.234,50");
    expect(formatDecimalForExport(175, "commaDecimal")).toBe("175,00");
  });

  it("keeps up to 4 decimals, trimming trailing zeros beyond 2", () => {
    expect(formatDecimalForExport(86.9913, "dotDecimal")).toBe("86.9913");
    expect(formatDecimalForExport(86.991, "dotDecimal")).toBe("86.991");
    expect(formatDecimalForExport(86.9, "commaDecimal")).toBe("86,90");
  });

  it("handles negatives", () => {
    expect(formatDecimalForExport(-12.5, "dotDecimal")).toBe("-12.50");
  });
});

describe("buildCleanedWorkbook", () => {
  const rows: CleanedRow[] = [
    {
      partNumber: "ABC-1",
      modelNumber: "M1",
      description: "Widget",
      listPrice: 100,
      costPrice: 80,
      warning: null,
      moq: 5,
      weblink: null,
    },
    {
      partNumber: "ABC-2",
      modelNumber: null,
      description: "Gadget",
      listPrice: 250,
      costPrice: 175,
      warning: "Lead time 6w",
      moq: null,
      weblink: "https://example.com",
    },
  ];

  it("round-trips with normalized headers and numeric price cells", () => {
    const buffer = buildCleanedWorkbook(rows, XLSX);
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];

    // Header row order matches the importer's standard columns.
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(aoa[0]).toEqual([...CLEANED_HEADERS]);

    // List Price (col 3) and Cost Price (col 4) are stored as numeric cells.
    const listCell = ws["D2"]; // row 1 data
    const costCell = ws["E2"];
    expect(listCell.t).toBe("n");
    expect(listCell.v).toBe(100);
    expect(costCell.t).toBe("n");
    expect(costCell.v).toBe(80);
  });

  it("drops optional columns that are empty across all rows", () => {
    const emptyOptionalRows: CleanedRow[] = [
      {
        partNumber: "CS0622",
        modelNumber: null,
        description: "Cloud service annual fee",
        listPrice: 0,
        costPrice: null,
        warning: null,
        moq: null,
        weblink: null,
      },
      {
        partNumber: "CS0604",
        modelNumber: null,
        description: "Mandatory license",
        listPrice: 357,
        costPrice: null,
        warning: null,
        moq: null,
        weblink: null,
      },
    ];
    const buffer = buildCleanedWorkbook(emptyOptionalRows, XLSX, { includeCost: false });
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(aoa[0]).toEqual(["Part Number", "Description", "List Price"]);
  });

  it("omits the Cost Price column when includeCost is false", () => {
    const buffer = buildCleanedWorkbook(rows, XLSX, { includeCost: false });
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 });
    expect(aoa[0]).toEqual([
      "Part Number",
      "Model Number",
      "Description",
      "List Price",
      "Warning",
      "MOQ",
      "Weblink",
    ]);
    expect((aoa[0] as string[]).includes("Cost Price")).toBe(false);
  });

  it("writes prices as strings in the selected number format", () => {
    const buffer = buildCleanedWorkbook(rows, XLSX, { numberFormat: "commaDecimal" });
    const wb = XLSX.read(buffer, { type: "array" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const listCell = ws["D2"]; // List Price, first data row (100)
    const costCell = ws["E2"]; // Cost Price (80)
    expect(listCell.t).toBe("s");
    expect(listCell.v).toBe("100,00");
    expect(costCell.t).toBe("s");
    expect(costCell.v).toBe("80,00");
  });
});
