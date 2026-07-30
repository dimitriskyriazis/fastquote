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

describe("header detection — i3 AVC4 shape (header on row 1)", () => {
  // Regression: the real header row was skipped ("ProductId" matched no part-number keyword) and a
  // data row 46 rows down won instead — its name "…Wall/Common part" hit the "part " keyword and its
  // " €768.00 " price cells hit the bare "€" list-price keyword. Only the rows below it imported.
  const rows: unknown[][] = [
    ["Category", "ProductId", "EAN", "Name", "Description", "Final Description", "MOQ", "Selling price", "Buying price"],
    ["Aspen 4", "10010820", "5425035707086", "i3CONNECT Aspen 4 55 Inch", "Android 15 | QLED", "i3CONNECT Aspen 4 55 Inch Android 15", "6", " €2,518.00 ", " €1,259.00 "],
    ["Aspen 4", "10010821", "5425035707093", "i3CONNECT Aspen 4 65 Inch", "Android 15 | QLED", "i3CONNECT Aspen 4 65 Inch Android 15", "6", " €2,886.00 ", " €1,443.00 "],
    ["Mounting", "10010881", "5425035707239", "i3CONNECT Lift 4 Wall/Common part", "Height adjustable wall lift", "i3CONNECT Lift 4 Wall/Common part Height adjustable", null, " €768.00 ", " €384.00 "],
    ["Mounting", "10010880", "5425035707222", "i3CONNECT Lift 4 Mobile foot", "Add this to Lift 4", "i3CONNECT Lift 4 Mobile foot Add this", null, " €156.00 ", " €78.00 "],
    ["Software", "20000370", null, "Cortex Basic", "Remote management", "Cortex Basic Remote management", null, null, null],
  ];

  it("locates the header row at the top, not a data row further down", () => {
    expect(detectHeaderRow(rows).index).toBe(0);
  });

  it("keeps every data row (a data row posing as the header truncated the import)", () => {
    const validation = buildValidationFromRows("Distri Added Value EUR", rows);
    expect(validation.status).toBe("valid");
    expect(validation.sheets[0].allRows).toHaveLength(rows.length - 1);
    expect(validation.rowCount).toBe(rows.length - 1);
  });

  it("maps ProductId to Part Number and splits selling/buying price", () => {
    const columns = buildColumns(rows[0]);
    const selection = autoSelectUniqueSuggestions(buildSuggestions(columns));
    expect(columns[selection.partNumber as number].label).toBe("ProductId");
    expect(columns[selection.listPrice as number].label).toBe("Selling price");
    expect(columns[selection.costPrice as number].label).toBe("Buying price");
  });

  it("does not treat a price value as a list-price header keyword", () => {
    const priceRow: unknown[] = ["Mounting", "10010881", "i3CONNECT Lift 4 Wall/Common part", " €768.00 ", " €384.00 "];
    expect(detectHeaderRow([...rows, priceRow]).index).toBe(0);
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
