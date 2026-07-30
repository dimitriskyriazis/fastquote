import { describe, it } from "vitest";
import * as AFTER from "../priceListColumnDetection";
import * as BEFORE from "./__wf_pnoav_head";

type Mod = typeof AFTER;

const report = (label: string, mod: Mod, rows: unknown[][]) => {
  const det = mod.detectHeaderRow(rows);
  const sheet = mod.analyzeSheet("S1", rows, rows, new Set<number>(), 0, true);
  const evaluation = mod.evaluateSelection([sheet], 0);
  const sel = sheet.selection;
  const lbl = (i: number | null | undefined) =>
    i == null ? "—" : `${i}:${sheet.columns[i]?.label ?? "?"}`;
  console.log(
    `  ${label.padEnd(8)} hdrIdx=${det.index} span=${det.span} ` +
      `hdrLabels=${JSON.stringify(sheet.columns.map((c) => c.label))} ` +
      `rowCount=${sheet.rowCount} status=${evaluation.status} ` +
      `part=${lbl(sel.partNumber)} list=${lbl(sel.listPrice)} desc=${lbl(sel.description)} model=${lbl(sel.modelNumber)}`,
  );
  return { det, sheet, evaluation };
};

const compare = (name: string, rows: unknown[][]) => {
  console.log(`\n=== ${name} ===`);
  rows.forEach((r, i) => console.log(`  row${i}: ${JSON.stringify(r)}`));
  const b = report("BEFORE", BEFORE as unknown as Mod, rows);
  const a = report("AFTER", AFTER, rows);
  const changed =
    b.det.index !== a.det.index ||
    b.sheet.rowCount !== a.sheet.rowCount ||
    b.evaluation.status !== a.evaluation.status;
  console.log(`  >>> ${changed ? "*** CHANGED ***" : "same"}`);
};

// ---- Reviewer's exact scenario 1 ----
const S1: unknown[][] = [
  ["Product", "Description", "Price", "Availability"],
  ["AB-1", "Wall mount", "12.00 EUR", "In stock"],
  ["AB-2", "Floor stand", "30.00 EUR", "In stock"],
  ["AB-3", "Trolley", "40.00 EUR", "Product not available"],
  ["AB-4", "Remote", "9.00 EUR", "In stock"],
  ["AB-5", "Cable kit", "8.00 EUR", "In stock"],
  ["AB-6", "Stylus", "5.00 EUR", "In stock"],
];

// ---- Reviewer's scenario 2: "€ 40.00 /m" prices + "Product no longer supplied" ----
const S2: unknown[][] = [
  ["Product", "Description", "Price", "Availability"],
  ["AB-1", "Wall mount", "€ 12.00 /m", "In stock"],
  ["AB-2", "Floor stand", "€ 30.00 /m", "In stock"],
  ["AB-3", "Trolley", "€ 40.00 /m", "Product no longer supplied"],
  ["AB-4", "Remote", "€ 9.00 /m", "In stock"],
  ["AB-5", "Cable kit", "€ 8.00 /m", "In stock"],
  ["AB-6", "Stylus", "€ 5.00 /m", "In stock"],
];

// ---- Reviewer's scenario 3: "Price on request" ----
const S3: unknown[][] = [
  ["Product", "Description", "Price", "Availability"],
  ["AB-1", "Wall mount", "12.00 EUR", "In stock"],
  ["AB-2", "Floor stand", "Price on request", "Product not available"],
  ["AB-3", "Trolley", "40.00 EUR", "In stock"],
  ["AB-4", "Remote", "9.00 EUR", "In stock"],
  ["AB-5", "Cable kit", "8.00 EUR", "In stock"],
];

// ---- Same sheets but with a header that has a real identifier label ----
const withRealHeader = (rows: unknown[][], hdr: unknown[]) => [hdr, ...rows.slice(1)];

// ---- Same shape, but PRE-EXISTING keywords supply the identifier ----
const variants: Array<[string, string]> = [
  ["product not available (NEW kw 'product no')", "Product not available"],
  ["item not available (OLD kw 'item ')", "Item not available"],
  ["order discontinued (OLD kw 'order ')", "Order discontinued"],
  ["see catalog for status (OLD kw 'catalog')", "See catalog for status"],
  ["spare part not stocked (OLD kw 'part ')", "Spare part not stocked"],
  ["no longer in article list (OLD kw 'article')", "No longer in article list"],
  ["model retired (OLD kw 'model')", "Model retired"],
  ["EOL - see replacement code (OLD kw ' code')", "EOL see replacement code"],
];

describe("wf: 'product no' data-row-as-header claim", () => {
  it("runs", () => {
    compare("Reviewer scenario 1 (40.00 EUR text prices)", S1);
    compare("Reviewer scenario 2 (€ 40.00 /m)", S2);
    compare("Reviewer scenario 3 (Price on request)", S3);

    console.log("\n########## SAME SHEET, lifecycle text varied (does HEAD already hijack?) ##########");
    variants.forEach(([label, text]) => {
      const rows = S1.map((r) => [...r]);
      rows[3][3] = text;
      compare(`variant: ${label}`, rows);
    });

    console.log("\n########## REALISTIC numeric price cells (the normal case) ##########");
    const numericPrices: unknown[][] = [
      ["Product", "Description", "Price", "Availability"],
      ["AB-1", "Wall mount", 12, "In stock"],
      ["AB-2", "Floor stand", 30, "In stock"],
      ["AB-3", "Trolley", 40, "Product not available"],
      ["AB-4", "Remote", 9, "In stock"],
      ["AB-5", "Cable kit", 8, "In stock"],
      ["AB-6", "Stylus", 5, "In stock"],
    ];
    compare("numeric prices + 'Product not available'", numericPrices);

    const numericStr: unknown[][] = numericPrices.map((r, i) =>
      i === 0 ? r : [r[0], r[1], `€${r[2]}.00`, r[3]],
    );
    compare("'€40.00' string prices + 'Product not available'", numericStr);

    console.log("\n########## Headers that DO carry an identifier label ##########");
    compare("hdr 'Product Code' + lifecycle row", withRealHeader(S1, ["Product Code", "Description", "Price", "Availability"]));
    compare("hdr 'SKU' + lifecycle row", withRealHeader(S1, ["SKU", "Description", "Price", "Availability"]));
    compare("hdr 'Model' + lifecycle row", withRealHeader(S1, ["Model", "Description", "Price", "Availability"]));
    compare("hdr 'ProductId' + lifecycle row", withRealHeader(S1, ["ProductId", "Description", "Price", "Availability"]));

    console.log("\n########## keyword mechanics ##########");
    ["product not available", "product no longer supplied", "40.00 eur", "price on request", "€ 40.00 m", "in stock", "product", "availability", "trolley", "ab 3"].forEach(
      (cell) => {
        const hitsAfter = (Object.keys(AFTER.columnKeywords) as Array<keyof typeof AFTER.columnKeywords>)
          .filter((k) => AFTER.columnKeywords[k].some((kw) => AFTER.headerContainsKeyword(cell, kw)));
        const hitsBefore = (Object.keys(BEFORE.columnKeywords) as Array<keyof typeof BEFORE.columnKeywords>)
          .filter((k) => BEFORE.columnKeywords[k].some((kw) => BEFORE.headerContainsKeyword(cell, kw)));
        console.log(
          `  "${cell}" plausible=${AFTER.isPlausibleHeaderCell(cell)} beforeKeys=${JSON.stringify(hitsBefore)} afterKeys=${JSON.stringify(hitsAfter)}`,
        );
      },
    );
  });
});
