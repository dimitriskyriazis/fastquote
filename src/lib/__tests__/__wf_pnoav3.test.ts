import { describe, it } from "vitest";
import * as AFTER from "../priceListColumnDetection";

const run = (rows: unknown[][]) => {
  const det = AFTER.detectHeaderRow(rows);
  const sheet = AFTER.analyzeSheet("S1", rows, rows, new Set<number>(), 0, true);
  const ev = AFTER.evaluateSelection([sheet], 0);
  return `idx=${det.index} rows=${sheet.rowCount} status=${ev.status} part=${
    sheet.selection.partNumber == null ? "—" : sheet.columns[sheet.selection.partNumber].label
  }`;
};

const sheets: Array<[string, unknown[][]]> = [
  [
    "reviewer S1 (hdr 'Product', '40.00 EUR', 'Product not available')",
    [
      ["Product", "Description", "Price", "Availability"],
      ["AB-1", "Wall mount", "12.00 EUR", "In stock"],
      ["AB-2", "Floor stand", "30.00 EUR", "In stock"],
      ["AB-3", "Trolley", "40.00 EUR", "Product not available"],
      ["AB-4", "Remote", "9.00 EUR", "In stock"],
      ["AB-5", "Cable kit", "8.00 EUR", "In stock"],
      ["AB-6", "Stylus", "5.00 EUR", "In stock"],
    ],
  ],
  [
    "reviewer S2 ('€ 40.00 /m', 'Product no longer supplied')",
    [
      ["Product", "Description", "Price", "Availability"],
      ["AB-1", "Wall mount", "€ 12.00 /m", "In stock"],
      ["AB-2", "Floor stand", "€ 30.00 /m", "In stock"],
      ["AB-3", "Trolley", "€ 40.00 /m", "Product no longer supplied"],
      ["AB-4", "Remote", "€ 9.00 /m", "In stock"],
      ["AB-5", "Cable kit", "€ 8.00 /m", "In stock"],
      ["AB-6", "Stylus", "€ 5.00 /m", "In stock"],
    ],
  ],
  [
    "intended fix target: hdr 'ProductId'",
    [
      ["Category", "ProductId", "EAN", "Name", "Description", "MOQ", "Selling price", "Buying price"],
      ["Displays", "PRD-1", "5000001", "i3 Panel", "Desc", 1, " €768.00 ", " €384.00 "],
      ["Displays", "PRD-2", "5000002", "i3 Panel 2", "Desc", 1, " €700.00 ", " €350.00 "],
      ["Displays", "PRD-3", "5000003", "i3CONNECT Lift 4 Wall/Common part", "Desc", 1, " €600.00 ", " €300.00 "],
    ],
  ],
  [
    "intended fix target: hdr 'Product No.'",
    [
      ["Product No.", "Description", "List Price"],
      ["AB-1", "Wall mount", " €12.00 "],
      ["AB-2", "Floor stand", " €30.00 "],
      ["AB-3", "Trolley", " €40.00 "],
    ],
  ],
  [
    "intended fix target: hdr 'Product No'",
    [
      ["Product No", "Description", "List Price"],
      ["AB-1", "Wall mount", " €12.00 "],
      ["AB-2", "Floor stand", " €30.00 "],
      ["AB-3", "Trolley", " €40.00 "],
    ],
  ],
  [
    "intended fix target: hdr 'Product Number'",
    [
      ["Product Number", "Description", "List Price"],
      ["AB-1", "Wall mount", " €12.00 "],
      ["AB-2", "Floor stand", " €30.00 "],
      ["AB-3", "Trolley", " €40.00 "],
    ],
  ],
];

describe("wf3: validate candidate fix by mutating the keyword array at runtime", () => {
  it("before/after keyword tightening", () => {
    const kw = AFTER.columnKeywords.partNumber;
    const original = [...kw];

    console.log("\n--- as-shipped keywords ---");
    sheets.forEach(([label, rows]) => console.log(`  ${label.padEnd(60)} ${run(rows)}`));

    // Candidate fix: replace the unbounded "product no" with boundary-anchored forms that
    // cannot reach "product not…" / "product no longer…" via the compact fallback.
    const patched = original.filter((k) => k !== "product no");
    patched.push(" product no ", " product no.", " prod no ", " prod no.");
    kw.length = 0;
    patched.forEach((k) => kw.push(k));

    console.log("\n--- patched keywords (removed 'product no'; added ' product no ', ' product no.', ' prod no ', ' prod no.') ---");
    sheets.forEach(([label, rows]) => console.log(`  ${label.padEnd(60)} ${run(rows)}`));

    console.log("\n--- keyword-level check with patched list ---");
    [
      "product no",
      "product no.",
      "product nos",
      "prod no",
      "prod no.",
      "productno",
      "product number",
      "productid",
      "product not available",
      "product no longer supplied",
      "product notes",
      "product notice",
      "product nomenclature",
    ].forEach((cell) => {
      const hit = kw.filter((k) => AFTER.headerContainsKeyword(cell, k));
      console.log(`  "${cell}".padEnd -> partNumber kws matched: ${JSON.stringify(hit)}`);
    });

    kw.length = 0;
    original.forEach((k) => kw.push(k));
  });
});
