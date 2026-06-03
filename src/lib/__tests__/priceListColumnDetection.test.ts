import { describe, it, expect } from "vitest";
import {
  detectHeaderRow,
  buildColumns,
  buildSuggestions,
  autoSelectUniqueSuggestions,
  headerContainsKeyword,
  buildValidationFromRows,
} from "../priceListColumnDetection";

describe("header detection", () => {
  // Regression: a pricelist whose identifier column is labelled "Product code" (preceded by a
  // title row, blanks and a category section row). The real header must win over data rows.
  const rows: unknown[][] = [
    ["CUE Price List | Valid from 1.6.2026", null, null, null, null, null, "EUR"],
    [],
    [null, "Product name", "Product code", "Description", "Warranty", "Category", "List Price"],
    [],
    [null, "CUE Solution 1-year Annual Licenses", null, null, null, null, null],
    [null, "CUE SaaS", "CS0622", "Cloud service annual fee", "–", "3", "CALL"],
    [null, "CUE Solution", "CS0604", "Mandatory license", "–", "2", "357 EUR"],
    [null, "POI Basic", "CS0642", "License for POI", "–", "2", "12 EUR"],
    ["New", "Reservation Panel App", "CS0662", "License for reservation interface", "–", "2", "149 EUR"],
  ];

  it("locates the real header row, not a data row", () => {
    const detection = detectHeaderRow(rows);
    expect(detection.index).toBe(2);
  });

  it("maps Part Number to a 'Product code' column", () => {
    const detection = detectHeaderRow(rows);
    const header = (detection.mergedRow ?? rows[detection.index]) as unknown[];
    const columns = buildColumns(header);
    const selection = autoSelectUniqueSuggestions(buildSuggestions(columns));
    expect(selection.partNumber).not.toBeNull();
    expect(columns[selection.partNumber as number].label).toBe("Product code");
    expect(selection.listPrice).not.toBeNull();
    expect(columns[selection.listPrice as number].label).toBe("List Price");
  });
});

describe("buildValidationFromRows (PDF-extracted rows)", () => {
  it("builds a valid single-sheet validation and maps required columns", () => {
    const aoa: unknown[][] = [
      ["Product code", "Description", "List Price"],
      ["CS0622", "Cloud service annual fee", "357 EUR"],
      ["CS0604", "Mandatory license", "120 EUR"],
    ];
    const validation = buildValidationFromRows("CUE PDF", aoa);
    expect(validation.status).toBe("valid");
    expect(validation.sheets).toHaveLength(1);
    const sheet = validation.sheets[0];
    expect(sheet.selection.partNumber).not.toBeNull();
    expect(sheet.selection.listPrice).not.toBeNull();
    expect(sheet.allRows).toHaveLength(2);
  });

  it("returns invalid for empty input", () => {
    expect(buildValidationFromRows("PDF", []).status).toBe("invalid");
  });
});

describe("headerContainsKeyword — ' code' boundary", () => {
  it("matches a standalone code word but not embedded 'code'", () => {
    expect(headerContainsKeyword("product code", " code")).toBe(true);
    expect(headerContainsKeyword("item code", " code")).toBe(true);
    expect(headerContainsKeyword("code", " code")).toBe(true);
    expect(headerContainsKeyword("barcode", " code")).toBe(false);
    expect(headerContainsKeyword("zipcode", " code")).toBe(false);
  });
});
