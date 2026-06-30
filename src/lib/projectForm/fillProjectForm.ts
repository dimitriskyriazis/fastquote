// Fills the TELMACO "Project Handover / Budget" Word template (.docx) with an
// offer's data. The template carries NO placeholder tokens — it is the blank
// form — so we locate each fill point by matching the Greek/English LABELS
// in the document and write the resolved value into the adjacent cell (or append
// it inline after the label).
//
// The document body is a heading paragraph followed by 5 tables:
//   T0 Section-1 form      → inline-append value after each label cell
//   T1 budget header       → write into the empty value cell (c1)
//   T2 services budget     → per profile row: Qty into c1, Cost into c2
//   T3 total-cost summary  → write into the empty value cell (c1)
//   T4 timeline            → left untouched (no data source)
//
// Tables are identified by a header/label signature and matched table-scoped, so
// the timeline table (which reuses profile names like "Installation",
// "Commissioning", "Programming", "Training") never gets Qty/Cost written into it.

import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { ProjectFormData, ServiceProfileId } from './projectFormData';

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

// ── Formatting (EUR-first money, Greek decimals, dd/MM/yyyy dates) ───────────
const moneyFmt = new Intl.NumberFormat('el-GR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qtyFmt = new Intl.NumberFormat('el-GR', { maximumFractionDigits: 2 });

const fmtMoneyPlain = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v) || v === 0) return '';
  return moneyFmt.format(v);
};
const fmtMoneyEur = (v: number | null | undefined): string => {
  const s = fmtMoneyPlain(v);
  return s ? `${s} €` : '';
};
// Floor (never round up) to 2 decimals before formatting, mirroring the offer
// products totals bar (offerProductsUtils.floorTo) so the form's margin matches
// what FastQuote shows and never overstates it — e.g. 32.118% reads 32,11 here
// too, not 32,12. The 1e-7 epsilon absorbs float noise (an exact 32.80 won't
// floor to 32.79).
const fmtPercentPlain = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v) || v === 0) return '';
  const floored = Math.floor(v * 100 + 1e-7) / 100;
  return moneyFmt.format(floored);
};
const fmtQty = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v) || v === 0) return '';
  return qtyFmt.format(v);
};
const fmtDate = (d: Date | null | undefined): string => {
  if (!d || Number.isNaN(d.getTime())) return '';
  const pad = (n: number, l: number) => String(Math.abs(n)).padStart(l, '0');
  return `${pad(d.getDate(), 2)}/${pad(d.getMonth() + 1, 2)}/${pad(d.getFullYear(), 4)}`;
};

// ── Minimal structural DOM typing (xmldom Node surface we actually use) ──────
// xmldom's full types are awkward to thread through traversal helpers, so we
// model just the members we touch and cast the parsed document into this shape.
interface NodeListLike {
  length: number;
  item(i: number): WNode | null;
}
interface WNode {
  nodeName: string;
  nodeType: number;
  nodeValue: string | null;
  childNodes: NodeListLike;
  appendChild(n: WNode): WNode;
  cloneNode(deep: boolean): WNode;
  getElementsByTagName(tag: string): NodeListLike;
}
interface WElement extends WNode {
  setAttribute(name: string, value: string): void;
}
interface WDocument {
  createElementNS(ns: string, qualifiedName: string): WElement;
  createTextNode(text: string): WNode;
  getElementsByTagName(tag: string): NodeListLike;
}

const TEXT_NODE = 3;

const asNodes = (list: NodeListLike): WNode[] => {
  const out: WNode[] = [];
  for (let i = 0; i < list.length; i++) {
    const n = list.item(i);
    if (n) out.push(n);
  }
  return out;
};

// Direct child elements with the given qualified tag name (e.g. 'w:tr').
const childrenByTag = (parent: WNode, tag: string): WNode[] =>
  asNodes(parent.childNodes).filter((n) => n.nodeName === tag);

// Concatenated visible text of a node: w:t text + tabs/breaks as whitespace.
const textOf = (node: WNode): string => {
  let s = '';
  const walk = (n: WNode) => {
    if (n.nodeName === 'w:t') {
      for (const c of asNodes(n.childNodes)) if (c.nodeType === TEXT_NODE) s += c.nodeValue ?? '';
      return;
    }
    if (n.nodeName === 'w:tab') {
      s += '\t';
      return;
    }
    if (n.nodeName === 'w:br') {
      s += '\n';
      return;
    }
    for (const c of asNodes(n.childNodes)) walk(c);
  };
  walk(node);
  return s;
};

const cellsOf = (row: WNode): WNode[] => childrenByTag(row, 'w:tc');

export interface FillSummary {
  filled: string[];
  skipped: string[];
}

export async function fillProjectForm(
  templateBuffer: Buffer,
  data: ProjectFormData,
): Promise<{ buffer: Buffer; summary: FillSummary }> {
  const zip = await JSZip.loadAsync(templateBuffer);
  const docFile = zip.file('word/document.xml');
  if (!docFile) throw new Error('Not a valid .docx: word/document.xml is missing');
  const xml = (await docFile.async('string')) as string;

  const parsed = new DOMParser().parseFromString(xml, 'text/xml');
  const doc = parsed as unknown as WDocument;

  const summary: FillSummary = { filled: [], skipped: [] };

  // Clone the first <w:rPr> within `scope` (so inserted text matches the
  // surrounding font), or null when none exists.
  const firstRpr = (scope: WNode): WNode | null => {
    for (const r of asNodes(scope.getElementsByTagName('w:r'))) {
      const rpr = childrenByTag(r, 'w:rPr')[0];
      if (rpr) return rpr;
    }
    return null;
  };

  const buildRun = (text: string, templateRpr: WNode | null): WNode => {
    const r = doc.createElementNS(W_NS, 'w:r');
    if (templateRpr) r.appendChild(templateRpr.cloneNode(true));
    const t = doc.createElementNS(W_NS, 'w:t');
    t.setAttribute('xml:space', 'preserve');
    t.appendChild(doc.createTextNode(text));
    r.appendChild(t);
    return r;
  };

  // Append " value" to the last paragraph of a label cell (inline form fields).
  const appendInline = (cell: WNode, value: string, label: string): void => {
    if (!value) {
      summary.skipped.push(label);
      return;
    }
    const paras = childrenByTag(cell, 'w:p');
    const target = paras[paras.length - 1];
    if (!target) {
      summary.skipped.push(label);
      return;
    }
    target.appendChild(buildRun(` ${value}`, firstRpr(cell)));
    summary.filled.push(label);
  };

  // Write a value into a (typically empty) target cell's first paragraph.
  // A leading space is added so the text isn't flush against the cell edge/label.
  const setCell = (cell: WNode, value: string, label: string): void => {
    if (!value) {
      summary.skipped.push(label);
      return;
    }
    let para = childrenByTag(cell, 'w:p')[0];
    if (!para) {
      para = doc.createElementNS(W_NS, 'w:p');
      cell.appendChild(para);
    }
    para.appendChild(buildRun(` ${value}`, firstRpr(cell)));
    summary.filled.push(label);
  };

  for (const table of asNodes(doc.getElementsByTagName('w:tbl'))) {
    const rows = childrenByTag(table, 'w:tr');
    const tableText = rows.map((r) => cellsOf(r).map(textOf).join(' | ')).join('\n');

    if (tableText.includes('Μεροκάματα')) {
      fillServicesTable(rows, setCell, data);
    } else if (tableText.includes('Τομέας')) {
      fillTotalCostTable(rows, setCell, data);
    } else if (tableText.includes('Κωδικός Έργου')) {
      fillBudgetHeaderTable(rows, setCell, data);
    } else if (tableText.includes('Αριθμός Έργου')) {
      fillSection1Table(rows, appendInline, data);
    }
    // else: timeline / unknown table — leave untouched.
  }

  const serialized = new XMLSerializer().serializeToString(parsed);
  zip.file('word/document.xml', serialized);
  const out = await zip.generateAsync({ type: 'uint8array' });
  return { buffer: Buffer.from(out), summary };
}

type SetCell = (cell: WNode, value: string, label: string) => void;
type AppendInline = (cell: WNode, value: string, label: string) => void;

// T0 — inline form fields: append the value after each label cell.
function fillSection1Table(rows: WNode[], appendInline: AppendInline, data: ProjectFormData): void {
  // [distinctive label token, value]. Order matters within a cell (first match wins).
  const rules: Array<[string, string]> = [
    ['Αριθμός Έργου', data.erpProjectCode ?? ''],
    ['Αξία Ανάθεσης', fmtMoneyEur(data.totals.totalNet)],
    ['Αξία Υπηρεσιών', fmtMoneyEur(data.totals.servicesNet)],
    ['Περιγραφή Έργου', data.description ?? ''], // specific: avoids matching "Τεχνική Περιγραφή"
    ['Αρμόδιος Πωλητής', data.salesPersonCode ?? ''], // AspNetUsers.NameCode, not the full name
    ['Παραλαβής', data.contactName ?? ''], // "Υπεύθυνος Παραλαβής(πελάτη)" — match Παραλαβής, not Πελάτης
    ['Πελάτης', data.customerName ?? ''],
    ['Ημ/νία Σύμβασης', fmtDate(data.orderSignedDate)],
    ['Επιθυμητή Ημ/νία Παράδοσης', fmtDate(data.deliveryDueDate)],
  ];
  for (const row of rows) {
    for (const cell of cellsOf(row)) {
      const text = textOf(cell);
      const match = rules.find(([token]) => text.includes(token));
      if (match) appendInline(cell, match[1], match[0]);
    }
  }
}

// T1 — budget header: 2-column label|value rows. Write into the value cell (c1).
function fillBudgetHeaderTable(rows: WNode[], setCell: SetCell, data: ProjectFormData): void {
  const rules: Array<[string, string]> = [
    ['Κωδικός Έργου', data.erpProjectCode ?? ''],
    ['Περιγραφή Έργου', data.description ?? ''],
    ['Πελάτης', data.customerName ?? ''],
    ['Αξία', fmtMoneyEur(data.totals.totalNet)],
  ];
  for (const row of rows) {
    const cells = cellsOf(row);
    if (cells.length < 2) continue;
    const labelText = textOf(cells[0]);
    const match = rules.find(([token]) => labelText.includes(token));
    if (match) setCell(cells[1], match[1], `T1:${match[0]}`);
  }
}

// T3 — total-cost summary: "Τομέας | Κόστος (€)". These are COST prices, not net
// selling prices. The € is already in the header, so insert plain numbers (no
// symbol). Write into the value cell (c1).
function fillTotalCostTable(rows: WNode[], setCell: SetCell, data: ProjectFormData): void {
  const rules: Array<[string, string]> = [
    ['Προϊόντα', fmtMoneyPlain(data.totals.productsCost)],
    ['Υπηρεσίες', fmtMoneyPlain(data.totals.servicesCost)],
    ['Σύνολο', fmtMoneyPlain(data.totals.totalCost)],
    ['Περιθώριο Κέρδους', fmtPercentPlain(data.totals.marginPct)],
  ];
  for (const row of rows) {
    const cells = cellsOf(row);
    if (cells.length < 2) continue;
    const labelText = textOf(cells[0]);
    if (labelText.includes('Τομέας')) continue; // header row
    const match = rules.find(([token]) => labelText.includes(token));
    if (match) setCell(cells[1], match[1], `T3:${match[0]}`);
  }
}

// T2 — services budget: "Profile | Μεροκάματα (Qty) | Κόστος € (Cost)".
// The € is in the header so Cost is a plain number. Qty → c1, Cost → c2.
function fillServicesTable(rows: WNode[], setCell: SetCell, data: ProjectFormData): void {
  // Doc row label token → profile id (or 'total' for the summary row).
  const labelToProfile: Array<[string, ServiceProfileId | 'total']> = [
    ['Project Manager', 'projectManager'],
    ['Designer', 'designer'],
    ['Electrician', 'electricianCabling'],
    ['Installation', 'installation'],
    ['Commissioning', 'commissioning'],
    ['Programming', 'programming'],
    ['Εκπαίδευση', 'training'],
    ['Συντήρηση', 'maintenance'],
    ['Λοιπές Υπηρεσίες', 'other'],
    ['Total', 'total'],
  ];
  for (const row of rows) {
    const cells = cellsOf(row);
    if (cells.length < 3) continue;
    const labelText = textOf(cells[0]);
    if (labelText.includes('Profile') || labelText.includes('Μεροκάματα')) continue; // header
    const match = labelToProfile.find(([token]) => labelText.includes(token));
    if (!match) continue;
    const [token, profile] = match;
    const qty = profile === 'total' ? data.services.totalQty : data.services.profiles[profile].qty;
    const cost = profile === 'total' ? data.services.totalCost : data.services.profiles[profile].cost;
    setCell(cells[1], fmtQty(qty), `T2:${token}:qty`);
    setCell(cells[2], fmtMoneyPlain(cost), `T2:${token}:cost`);
  }
}
