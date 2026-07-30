import { describe, it } from "vitest";
import * as NEW from "../priceListColumnDetection";
import * as OLD from "./__wf_numratio_head";

type Mod = typeof NEW;

const nameOf = (cols: { index: number; label: string }[], idx: number | null | undefined) => {
  if (idx == null) return "-";
  const c = cols.find((x) => x.index === idx);
  return c ? `${idx}:${c.label}` : String(idx);
};

const run = (mod: Mod, label: string, rows: unknown[][]) => {
  const det = mod.detectHeaderRow(rows);
  const sheet = mod.analyzeSheet("S", rows, rows, new Set<number>(), 0, true);
  const ev = mod.evaluateSelection([sheet], 0);
  const cols = sheet.columns;
  console.log(
    `  ${label.padEnd(6)} hdrIdx=${String(det.index).padEnd(3)} span=${det.span} rowCount=${String(
      sheet.rowCount,
    ).padEnd(3)} status=${ev.status.padEnd(8)} PN=${nameOf(cols, sheet.selection.partNumber).padEnd(
      18,
    )} LP=${nameOf(cols, sheet.selection.listPrice).padEnd(20)} DESC=${nameOf(
      cols,
      sheet.selection.description,
    ).padEnd(18)} COST=${nameOf(cols, sheet.selection.costPrice)}`,
  );
  return { det, sheet, ev };
};

const compare = (title: string, rows: unknown[][]) => {
  console.log(`\n=== ${title} ===`);
  const o = run(OLD as unknown as Mod, "OLD", rows);
  const n = run(NEW, "NEW", rows);
  const changed =
    o.det.index !== n.det.index || o.sheet.rowCount !== n.sheet.rowCount || o.ev.status !== n.ev.status;
  console.log(`  -> ${changed ? "*** CHANGED ***" : "same"}`);
  return { o, n };
};

// ---------------- reviewer scenario 1 (exact) ----------------
const ACME_TWO_TABLES: unknown[][] = [
  ["ACME Displays Price List", null, null, null, null],
  [],
  ["Part No", "Description", "MOQ", "2025", "2026"],
  ["AC-100", "Display 55 inch", "1", "1000", "1100"],
  ["AC-101", "Display 65 inch", "1", "1500", "1650"],
  ["AC-102", "Display 75 inch", "1", "2000", "2200"],
  ["AC-103", "Display 86 inch", "1", "3000", "3300"],
  [],
  ["Accessories", null, null, null, null],
  ["Part No", "Description", "MOQ", "List Price", "Net Price"],
  ["AX-1", "Wall mount", "1", "100", "80"],
  ["AX-2", "Trolley", "1", "200", "160"],
];

// ---------------- reviewer scenario 2 (exact, Greek) ----------------
const GREEK_TWO_TABLES: unknown[][] = [
  ["Τιμοκατάλογος", null, null],
  [],
  ["Κωδικός", "Περιγραφή", "2026"],
  ["A1", "Οθόνη 55", "1000"],
  ["A2", "Οθόνη 65", "1500"],
  ["A3", "Οθόνη 75", "2000"],
  [],
  ["Υπηρεσίες", null, null],
  ["Κωδικός", "Περιγραφή", "Τιμή"],
  ["S1", "Εγκατάσταση", "200"],
];

// ---------------- same sheets WITHOUT the second table ----------------
const ACME_ONE_TABLE: unknown[][] = ACME_TWO_TABLES.slice(0, 7);
const GREEK_ONE_TABLE: unknown[][] = GREEK_TWO_TABLES.slice(0, 6);

// ---------------- realistic year labelling ----------------
const ACME_YEAR_PRICE_LABELS: unknown[][] = [
  ["ACME Displays Price List", null, null, null, null],
  [],
  ["Part No", "Description", "MOQ", "2025 Price", "2026 Price"],
  ["AC-100", "Display 55 inch", "1", "1000", "1100"],
  ["AC-101", "Display 65 inch", "1", "1500", "1650"],
  ["AC-102", "Display 75 inch", "1", "2000", "2200"],
  ["AC-103", "Display 86 inch", "1", "3000", "3300"],
  [],
  ["Accessories", null, null, null, null],
  ["Part No", "Description", "MOQ", "List Price", "Net Price"],
  ["AX-1", "Wall mount", "1", "100", "80"],
  ["AX-2", "Trolley", "1", "200", "160"],
];

// ---------------- qty-break tiers ----------------
const TIERS_TWO_TABLES: unknown[][] = [
  ["ACME Price List", null, null, null, null],
  [],
  ["Part No", "Description", "1-9", "10-49", "50+"],
  ["AC-100", "Display 55 inch", "1000", "950", "900"],
  ["AC-101", "Display 65 inch", "1500", "1425", "1350"],
  ["AC-102", "Display 75 inch", "2000", "1900", "1800"],
  [],
  ["Accessories", null, null, null, null],
  ["Part No", "Description", "MOQ", "List Price", "Net Price"],
  ["AX-1", "Wall mount", "1", "100", "80"],
  ["AX-2", "Trolley", "1", "200", "160"],
];

// ---------------- the bug the diff fixed (AVC4 shape) ----------------
const AVC4: unknown[][] = [
  ["Category", "ProductId", "EAN", "Name", "Description", "Final Description", "MOQ", "Selling price", "Buying price"],
  ...Array.from({ length: 45 }, (_, i) => [
    "Displays",
    `i3-${1000 + i}`,
    `50000000${i}`,
    `i3TOUCH product ${i}`,
    `desc ${i}`,
    `final ${i}`,
    " 1 ",
    ` €${100 + i}.00 `,
    ` €${50 + i}.00 `,
  ]),
  ["Accessories", "i3-9999", "5000009999", "i3CONNECT Lift 4 Wall/Common part", "d", "f", " 1 ", " €768.00 ", " €384.00 "],
  ...Array.from({ length: 36 }, (_, i) => [
    "Accessories",
    `i3-${2000 + i}`,
    `60000000${i}`,
    `accessory ${i}`,
    `desc ${i}`,
    `final ${i}`,
    " 1 ",
    ` €${10 + i}.00 `,
    ` €${5 + i}.00 `,
  ]),
];

// ---------------- OLD's own fragility in a two-table sheet ----------------
// Identical to the reviewer's scenario except the first table's data contains a keyword
// in a product name (exactly the AVC4 failure mode) and the header is fully labelled.
const TWO_TABLES_KEYWORD_IN_DATA: unknown[][] = [
  ["ACME Displays Price List", null, null, null, null],
  [],
  ["Reference", "Naming", "MOQ", "Tariff", "Netto"],
  ["AC-100", "Lift 4 Wall/Common part", "1", "€1000.00", "€800.00"],
  ["AC-101", "Display 65 inch", "1", "€1500.00", "€1200.00"],
  ["AC-102", "Display 75 inch", "1", "€2000.00", "€1600.00"],
  ["AC-103", "Display 86 inch", "1", "€3000.00", "€2400.00"],
];

describe("MAX_HEADER_NUMERIC_RATIO regression claim", () => {
  it("runs scenarios", () => {
    compare("R1: reviewer ACME two tables (exact)", ACME_TWO_TABLES);
    compare("R2: reviewer Greek two tables (exact)", GREEK_TWO_TABLES);
    compare("R3: ACME year header, SINGLE table (no 2nd table)", ACME_ONE_TABLE);
    compare("R4: Greek year header, SINGLE table", GREEK_ONE_TABLE);
    compare("R5: '2025 Price'/'2026 Price' labels + 2nd table", ACME_YEAR_PRICE_LABELS);
    compare("R6: qty-break tiers 1-9/10-49/50+ + 2nd table", TIERS_TWO_TABLES);
    compare("R7: AVC4 shape (the bug the diff fixed)", AVC4);
    compare("R8: fully-labelled header, keyword inside data row", TWO_TABLES_KEYWORD_IN_DATA);
  });

  it("ratio boundary probe", () => {
    console.log("\n=== ratio boundary (header = Part No, Description, k numeric labels) ===");
    const mk = (numericLabels: number, extraTextLabels: number): unknown[][] => {
      const hdr: unknown[] = ["Part No", "Description"];
      for (let i = 0; i < extraTextLabels; i += 1) hdr.push(`Label ${i}`);
      for (let i = 0; i < numericLabels; i += 1) hdr.push(String(2020 + i));
      return [
        ["Title", null, null],
        [],
        hdr,
        hdr.map((_, i) => (i < 2 ? `v${i}` : "100")),
        hdr.map((_, i) => (i < 2 ? `w${i}` : "200")),
        [],
        ["Part No", "Description", "MOQ", "List Price", "Net Price"],
        ["AX-1", "Wall mount", "1", "100", "80"],
        ["AX-2", "Trolley", "1", "200", "160"],
      ];
    };
    for (const [k, extra] of [[1, 0], [1, 1], [1, 2], [2, 0], [2, 1], [2, 2], [2, 3], [2, 4], [3, 0], [3, 7]] as [number, number][]) {
      const rows = mk(k, extra);
      const total = 2 + extra + k;
      const o = OLD.detectHeaderRow(rows).index;
      const n = NEW.detectHeaderRow(rows).index;
      console.log(
        `  numeric ${k}/${total} = ${(k / total).toFixed(3)}  OLD hdr=${o}  NEW hdr=${n}  ${o !== n ? "*** DIFF ***" : ""}`,
      );
    }
  });

  it("shows what pass 3 does when pass 1+2 reject everything", () => {
    console.log("\n=== pass-3-only behaviour on the reviewer's rows (2nd table removed) ===");
    // Confirm the pass-1 rejection is/isn't recovered by pass 3 scoring.
    const rows = ACME_ONE_TABLE;
    console.log(`  NEW scoreHeaderRow-driven pick = ${NEW.detectHeaderRow(rows).index}`);
    console.log(`  MAX_HEADER_NUMERIC_RATIO = ${NEW.MAX_HEADER_NUMERIC_RATIO}`);
  });
});
