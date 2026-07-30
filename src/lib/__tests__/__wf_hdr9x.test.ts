import { describe, it } from "vitest";
import * as NEW from "../priceListColumnDetection";
import * as OLD from "./__wf_hdr9x_old";
import * as MID from "./__wf_hdr9x_mid";
import * as FIX from "./__wf_hdr9x_fix";

type Mod = typeof NEW;

const i3Header = [
  "Category",
  "ProductId",
  "EAN",
  "Name",
  "Description",
  "Final Description",
  "MOQ",
  "Selling price",
  "Buying price",
];

const scenarios: { name: string; rows: unknown[][] }[] = [
  {
    name: "CLAIM A: 4-wide, Code/Description/2026/null",
    rows: [
      ["Code", "Description", "2026", null],
      ["A1", "Thing one", "10", "EUR"],
      ["A2", "Thing two", "20", "EUR"],
      ["A3", "Thing three", "30", "EUR"],
      ["A4", "Thing four", "40", "EUR"],
    ],
  },
  {
    name: "CLAIM B: 5-wide, Part No/Name/2026/null/null",
    rows: [
      ["Part No", "Name", "2026", null, null],
      ["A1", "Thing one", "10", "EUR", "Blue"],
      ["A2", "Thing two", "20", "EUR", "Red"],
      ["A3", "Thing three", "30", "EUR", "Green"],
      ["A4", "Thing four", "40", "EUR", "Black"],
    ],
  },
  {
    name: "CLAIM A but realistic description length (7+ words)",
    rows: [
      ["Code", "Description", "2026", null],
      ["A1", "65 inch interactive flat panel display with stand", "10", "EUR"],
      ["A2", "75 inch interactive flat panel display with stand", "20", "EUR"],
      ["A3", "86 inch interactive flat panel display with stand", "30", "EUR"],
      ["A4", "98 inch interactive flat panel display with stand", "40", "EUR"],
    ],
  },
  {
    name: "CLAIM A shape but no blank header cell (4 labels, 1 numeric = 0.25)",
    rows: [
      ["Code", "Description", "2026", "Currency"],
      ["A1", "Thing one", "10", "EUR"],
      ["A2", "Thing two", "20", "EUR"],
      ["A3", "Thing three", "30", "EUR"],
      ["A4", "Thing four", "40", "EUR"],
    ],
  },
  {
    name: "REAL BUG: i3 AVC4 header at row 0",
    rows: [
      i3Header,
      ["Displays", "i3-1", "123", "i3TOUCH X", "desc", "final desc", 1, " €768.00 ", " €384.00 "],
      ["Displays", "i3-2", "124", "i3CONNECT Lift 4 Wall/Common part", "d", "f", 1, " €500.00 ", " €250.00 "],
      ["Displays", "i3-3", "125", "i3TOUCH Y", "d", "f", 1, " €300.00 ", " €150.00 "],
      ["Displays", "i3-4", "126", "i3TOUCH Z", "d", "f", 1, " €200.00 ", " €100.00 "],
    ],
  },
  {
    name: "REAL BUG variant: i3 header with the 'ProductId' label replaced by unrecognised 'Ref' -> keyword fix cannot help",
    rows: [
      ["Category", "Artikel", "EAN", "Name", "Description", "Final Description", "MOQ", "Selling price", "Buying price"],
      ["Displays", "i3-1", "123", "i3TOUCH X", "desc", "final desc", 1, " €768.00 ", " €384.00 "],
      ["Displays", "i3-2", "124", "i3CONNECT Lift 4 Wall/Common part", "d", "f", 1, " €500.00 ", " €250.00 "],
      ["Displays", "i3-3", "125", "i3TOUCH Y", "d", "f", 1, " €300.00 ", " €150.00 "],
      ["Displays", "i3-4", "126", "i3TOUCH Z", "d", "f", 1, " €200.00 ", " €100.00 "],
    ],
  },
  {
    name: "MULTI-ROW HEADER regression check: 'Pricing' banner over List/Net Price",
    rows: [
      [null, null, "Pricing", null],
      ["Part No", "Description", "List Price", "Net Price"],
      ["A1", "Thing one", "10", "8"],
      ["A2", "Thing two", "20", "16"],
      ["A3", "Thing three", "30", "24"],
    ],
  },
  {
    name: "MULTI-ROW HEADER with year sublabels: 'Price' banner over 2025/2026",
    rows: [
      ["Part No", "Description", "Price", null],
      [null, null, "2025", "2026"],
      ["A1", "Thing one", "10", "12"],
      ["A2", "Thing two", "20", "22"],
      ["A3", "Thing three", "30", "32"],
    ],
  },
];

const report = (label: string, mod: Mod, rows: unknown[][]) => {
  const det = mod.detectHeaderRow(rows);
  const headerRow = det.mergedRow ?? rows[det.index] ?? [];
  const cols = mod.buildColumns(headerRow as unknown[]);
  const sugg = mod.buildSuggestions(cols);
  const sel = mod.autoSelectUniqueSuggestions(sugg);
  const sheet = mod.analyzeSheet("S", rows, rows, new Set<number>(), 0, true);
  const evaluation = mod.evaluateSelection([sheet], 0);
  const named = (k: string) => {
    const i = (sel as Record<string, number | null | undefined>)[k];
    return i == null ? "(none)" : `#${i}"${cols[i]?.label}"`;
  };
  console.log(
    `  ${label.padEnd(4)} idx=${det.index} span=${det.span} rowCount=${sheet.rowCount} status=${evaluation.status}` +
      ` | part=${named("partNumber")} list=${named("listPrice")} cost=${named("costPrice")} desc=${named("description")}` +
      ` | header=${JSON.stringify(headerRow)}`,
  );
};

describe("wf_hdr9x refutation harness", () => {
  it("OLD(HEAD) vs NEW(worktree) vs MID(no ratio guard) vs FIX(pass2 skips number-heavy)", () => {
    for (const sc of scenarios) {
      console.log(`\n=== ${sc.name} ===`);
      report("OLD", OLD as unknown as Mod, sc.rows);
      report("NEW", NEW, sc.rows);
      report("MID", MID as unknown as Mod, sc.rows);
      report("FIX", FIX as unknown as Mod, sc.rows);
    }
  });
});
