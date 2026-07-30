import { describe, it } from "vitest";
import * as AFTER from "../priceListColumnDetection";
import * as BEFORE from "./__wf_pnoav_head";

type Mod = typeof AFTER;

const run = (mod: Mod, rows: unknown[][]) => {
  const det = mod.detectHeaderRow(rows);
  const sheet = mod.analyzeSheet("S1", rows, rows, new Set<number>(), 0, true);
  const ev = mod.evaluateSelection([sheet], 0);
  return { idx: det.index, rowCount: sheet.rowCount, status: ev.status };
};

const lifecycle = [
  ["NEW: Product not available", "Product not available"],
  ["NEW: Product no longer supplied", "Product no longer supplied"],
  ["OLD: Item not available", "Item not available"],
  ["OLD: Order discontinued", "Order discontinued"],
  ["OLD: See catalog for status", "See catalog for status"],
  ["OLD: Spare part not stocked", "Spare part not stocked"],
  ["OLD: No longer in article list", "No longer in article list"],
  ["OLD: EOL see replacement code", "EOL see replacement code"],
  ["neutral: Discontinued", "Discontinued"],
];

// price cell renderings, as they arrive from sheet_to_json(raw:false)
const priceForms: Array<[string, (n: number) => unknown]> = [
  ["numeric cell", (n) => n],
  ['"€40.00" (excel currency fmt)', (n) => `€${n}.00`],
  ['"40,00 €" (EU currency fmt)', (n) => `${n},00 €`],
  ['"40.00" (plain text)', (n) => `${n}.00`],
  ['"40.00 EUR" (unit suffix text)', (n) => `${n}.00 EUR`],
  ['"€ 40.00 /m" (per-unit text)', (n) => `€ ${n}.00 /m`],
];

describe("wf2: delta matrix", () => {
  it("matrix", () => {
    const mk = (priceFn: (n: number) => unknown, text: string): unknown[][] => [
      ["Product", "Description", "Price", "Availability"],
      ["AB-1", "Wall mount", priceFn(12), "In stock"],
      ["AB-2", "Floor stand", priceFn(30), "In stock"],
      ["AB-3", "Trolley", priceFn(40), text],
      ["AB-4", "Remote", priceFn(9), "In stock"],
      ["AB-5", "Cable kit", priceFn(8), "In stock"],
      ["AB-6", "Stylus", priceFn(5), "In stock"],
    ];

    console.log(
      "\npriceForm | lifecycle | BEFORE(idx/rows/status) -> AFTER(idx/rows/status)   [row0 = correct header, 6 rows]",
    );
    let beforeBad = 0;
    let afterBad = 0;
    let newlyBad = 0;
    let newlyFixed = 0;
    priceForms.forEach(([pLabel, pFn]) => {
      lifecycle.forEach(([lLabel, text]) => {
        const rows = mk(pFn, text);
        const b = run(BEFORE as unknown as Mod, rows);
        const a = run(AFTER, rows);
        const bBad = b.idx !== 0;
        const aBad = a.idx !== 0;
        if (bBad) beforeBad += 1;
        if (aBad) afterBad += 1;
        if (!bBad && aBad) newlyBad += 1;
        if (bBad && !aBad) newlyFixed += 1;
        const flag = !bBad && aBad ? "  <== NEW BREAK" : bBad && !aBad ? "  <== NEW FIX" : bBad && aBad ? "  (broken both)" : "";
        console.log(
          `${pLabel.padEnd(30)} | ${lLabel.padEnd(32)} | ${b.idx}/${b.rowCount}/${b.status} -> ${a.idx}/${a.rowCount}/${a.status}${flag}`,
        );
      });
    });
    console.log(
      `\nTOTALS over ${priceForms.length * lifecycle.length} sheets: BEFORE wrong-header=${beforeBad}, AFTER wrong-header=${afterBad}, newly broken=${newlyBad}, newly fixed=${newlyFixed}`,
    );

    console.log("\n########## the real i3 AVC4 header shape (the bug this diff fixed) ##########");
    const i3: unknown[][] = [
      ["Category", "ProductId", "EAN", "Name", "Description", "Final Description", "MOQ", "Selling price", "Buying price"],
    ];
    for (let i = 1; i <= 46; i += 1) {
      i3.push([
        "Displays",
        `PRD-${i}`,
        `50000000${i}`,
        i === 46 ? "i3CONNECT Lift 4 Wall/Common part" : `Product ${i}`,
        `Desc ${i}`,
        `Final ${i}`,
        1,
        " €768.00 ",
        " €384.00 ",
      ]);
    }
    const bi3 = run(BEFORE as unknown as Mod, i3);
    const ai3 = run(AFTER, i3);
    console.log(`  BEFORE idx=${bi3.idx} rows=${bi3.rowCount} status=${bi3.status}`);
    console.log(`  AFTER  idx=${ai3.idx} rows=${ai3.rowCount} status=${ai3.status}`);

    console.log("\n########## how narrow is the NEW keyword's exposure? ##########");
    [
      "Product not available",
      "Product no longer supplied",
      "Product notes",
      "Product Notice",
      "Product nomenclature",
      "Not a product",
      "This product no longer sold",
      "Availability",
      "Discontinued",
      "Out of stock",
      "EOL",
      "Not available",
      "No longer available",
      "Obsolete",
      "Replaced",
      "On request",
    ].forEach((raw) => {
      const cell = AFTER.normalizeHeaderText(raw)!;
      const b = (Object.keys(BEFORE.columnKeywords) as Array<keyof typeof BEFORE.columnKeywords>).filter((k) =>
        BEFORE.columnKeywords[k].some((kw) => BEFORE.headerContainsKeyword(cell, kw)),
      );
      const a = (Object.keys(AFTER.columnKeywords) as Array<keyof typeof AFTER.columnKeywords>).filter((k) =>
        AFTER.columnKeywords[k].some((kw) => AFTER.headerContainsKeyword(cell, kw)),
      );
      console.log(`  "${raw}".padEnd -> before=${JSON.stringify(b)} after=${JSON.stringify(a)}`);
    });

    console.log("\n########## candidate fix: boundary-safe keyword forms ##########");
    const candidates = ["product no ", "product no.", "product nr", "prod no ", "productno"];
    ["product no", "product no.", "product nr", "product no 12345", "productno", "product no", "product not available", "product no longer supplied", "product notes"].forEach(
      (cell) => {
        const hits = candidates.filter((kw) => AFTER.headerContainsKeyword(cell, kw));
        console.log(`  cell "${cell}" matched by: ${JSON.stringify(hits)}`);
      },
    );
  });
});
