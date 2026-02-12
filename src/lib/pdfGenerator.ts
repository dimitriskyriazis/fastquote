import fs from 'fs';
import path from 'path';

// ── Types ────────────────────────────────────────────────────────────────────

export type PdfLang = 'el' | 'en';
export type PdfLayout = 'standard' | 'detailed';
export type PdfOrientation = 'portrait' | 'landscape';

export type OfferPdfData = {
  offerId: number;
  offerDate: string | null;
  title: string | null;
  description: string | null;
  salesDivisionName: string | null;
  offerContact: string | null;
  customer: {
    name: string | null;
    brandName: string | null;
    address: string | null;
    phone: string | null;
    email: string | null;
    taxId: string | null;
    taxOffice: string | null;
  };
  contactFullName: string | null;
  salesPerson: { nameGR: string | null; nameEN: string | null; signTitle: string | null; nameCode: string | null };
  approvalUser: { nameGR: string | null; nameEN: string | null; signTitle: string | null };
  products: OfferProductRow[];
  terms: {
    offerValidity: string | null;
    paymentTerms: string | null;
    deliveryTime: string | null;
    installationSchedule: string | null;
  };
  notesIntroduction: string | null;
  notesClosing: string | null;
};

export type OfferProductRow = {
  treeOrdering: string | null;
  isCategory: boolean;
  isComment: boolean;
  quantity: number | null;
  brandName: string | null;
  modelNumber: string | null;
  partNumber: string | null;
  description: string | null;
  comment: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  totalNet: number | null;
  webLink: string | null;
  listPrice: number | null;
  customerDiscount: number | null;
};

// ── Translations ─────────────────────────────────────────────────────────────

const LABELS = {
  el: {
    title: 'ΠΡΟΣΦΟΡΑ',
    to: 'Προς',
    attn: 'Υπ\' όψιν',
    cc: 'Κοινοποίηση',
    address: 'Διεύθυνση',
    phone: 'Τηλέφωνο',
    fax: 'FAX',
    taxId: 'ΑΦΜ',
    taxOffice: 'ΔΟΥ',
    refNo: 'Α/Α',
    date: 'Ημερομηνία',
    responsible: 'Αρμόδιος',
    ourRef: 'Στοιχεία μας',
    colNo: 'Α/Α',
    colQty: 'Τεμ',
    colBrand: 'Οίκος',
    colType: 'Τύπος',
    colDescription: 'Περιγραφή',
    colListPrice: 'Τιμή Καταλόγου',
    colDiscount: 'Έκπτωση %',
    colUnitPrice: 'Τιμή Μονάδας',
    colTotal: 'Σύνολο',
    vatNote: 'Οι παραπάνω τιμές είναι σε ευρώ για προϊόντα ελεύθερα χωρίς ΦΠΑ',
    offerValidity: 'Ισχύς Προσφοράς',
    paymentTerms: 'Τρόπος Πληρωμής',
    deliveryTime: 'Χρόνος Παράδοσης',
    installationSchedule: 'Προβλεπόμενος Χρόνος Εγκατάστασης',
    regards: 'Με εκτίμηση,',
    companySign: 'Τελμάκο Α.Ε.',
    pageLabel: 'Σελίδα',
  },
  en: {
    title: 'OFFER',
    to: 'To',
    attn: 'Attn',
    cc: 'CC',
    address: 'Address',
    phone: 'Phone',
    fax: 'FAX',
    taxId: 'Tax ID',
    taxOffice: 'Tax Office',
    refNo: 'Ref No',
    date: 'Date',
    responsible: 'Responsible',
    ourRef: 'Our Ref',
    colNo: 'No',
    colQty: 'Qty',
    colBrand: 'Brand',
    colType: 'Type',
    colDescription: 'Description',
    colListPrice: 'List Price',
    colDiscount: 'Discount %',
    colUnitPrice: 'Unit Price',
    colTotal: 'Total',
    vatNote: 'The above prices are in EUR for products free of VAT',
    offerValidity: 'Offer Validity',
    paymentTerms: 'Payment Terms',
    deliveryTime: 'Delivery Time',
    installationSchedule: 'Installation Schedule',
    regards: 'Best regards,',
    companySign: 'Telmaco S.A.',
    pageLabel: 'Page',
  },
} as const;

type Labels = (typeof LABELS)[PdfLang];

// ── Colors ───────────────────────────────────────────────────────────────────

const C = {
  primary: '#1a1a2e',       // dark navy for headings
  accent: '#0f4c81',        // blue accent
  muted: '#64748b',         // slate for secondary text
  light: '#f8fafc',         // very light background
  headerBg: '#0f172a',      // dark header row
  headerText: '#ffffff',    // white text on dark header
  categoryBg: '#f1f5f9',    // light slate for category rows
  border: '#e2e8f0',        // subtle border
  borderDark: '#cbd5e1',    // slightly darker border
  link: '#2563eb',          // blue for hyperlinks
};

// ── Company info (hardcoded) ─────────────────────────────────────────────────

const COMPANY = {
  name: 'Τελμάκο Α.Ε.',
  nameEN: 'Telmaco S.A.',
  address: 'Αθ. Διάκου 23, 152 33 Χαλάνδρι',
  addressEN: 'Ath. Diakou 23, 152 33 Chalandri',
  phone: '210 6874 100',
  fax: '210 6874 199',
  email: 'info@telmaco.gr',
  website: 'www.telmaco.gr',
  afm: '094150597',
  doy: 'ΦΑΕ ΑΘΗΝΩΝ',
  doyEN: 'FAE ATHINON',
};

// ── Formatting helpers ───────────────────────────────────────────────────────

function formatEuropeanNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  const parts = n.toFixed(2).split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1]}`;
}

function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  return `${n.toFixed(1)}%`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const day = d.getDate();
    const month = d.getMonth() + 1;
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  } catch {
    return dateStr;
  }
}

function str(val: string | null | undefined): string {
  return val?.trim() || '';
}

// ── Logo cache ───────────────────────────────────────────────────────────────

let _logoBase64: string | null = null;

function getLogoBase64(): string {
  if (_logoBase64) return _logoBase64;
  const logoPath = path.join(process.cwd(), 'src', 'app', 'telmaco.jpg');
  const buf = fs.readFileSync(logoPath);
  _logoBase64 = 'data:image/jpeg;base64,' + buf.toString('base64');
  return _logoBase64;
}

// ── pdfmake setup ────────────────────────────────────────────────────────────

let _pdfmakeReady = false;

function ensurePdfmake() {
  if (_pdfmakeReady) return;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vfsFonts = require('pdfmake/build/vfs_fonts');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfmake = require('pdfmake');
  for (const [name, content] of Object.entries(vfsFonts)) {
    pdfmake.virtualfs.writeFileSync(name, Buffer.from(content as string, 'base64'));
  }
  pdfmake.setFonts({
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  });
  _pdfmakeReady = true;
}

// ── Hyperlink helper ─────────────────────────────────────────────────────────

function typeCell(row: OfferProductRow, fontSize: number) {
  const text = str(row.modelNumber) || str(row.partNumber);
  if (!text) return { text: '', fontSize };
  const link = str(row.webLink);
  if (link) {
    return { text, fontSize, color: C.link, decoration: 'underline', link };
  }
  return { text, fontSize };
}

// ── Table builders ───────────────────────────────────────────────────────────

function buildStandardTable(data: OfferPdfData, L: Labels) {
  const headerRow = [
    { text: L.colNo, style: 'tableHeader' },
    { text: L.colQty, style: 'tableHeader', alignment: 'center' as const },
    { text: L.colBrand, style: 'tableHeader' },
    { text: L.colType, style: 'tableHeader' },
    { text: L.colDescription, style: 'tableHeader' },
    { text: L.colUnitPrice, style: 'tableHeader', alignment: 'right' as const },
    { text: L.colTotal, style: 'tableHeader', alignment: 'right' as const },
  ];

  const body: unknown[][] = [headerRow];
  const colCount = 7;

  for (const row of data.products) {
    if (row.isComment && !row.isCategory) {
      body.push([
        { text: str(row.treeOrdering), fontSize: 7.5, color: C.muted },
        { text: '' }, { text: '' }, { text: '' },
        { text: str(row.description) || str(row.comment), fontSize: 8, italics: true, color: C.muted },
        { text: '' },
        { text: row.totalNet != null ? formatEuropeanNumber(row.totalNet) : '', fontSize: 8, italics: true, color: C.muted, alignment: 'right' as const },
      ]);
    } else if (row.isCategory) {
      const depth = (row.treeOrdering || '').split('.').length;
      const fontSize = depth <= 1 ? 9 : 8.5;
      const fillColor = depth <= 1 ? C.categoryBg : undefined;
      body.push([
        { text: str(row.treeOrdering), bold: true, fontSize, fillColor },
        { text: '', fillColor },
        { text: '', fillColor }, { text: '', fillColor },
        { text: str(row.description), bold: true, fontSize, fillColor },
        { text: '', fillColor },
        { text: row.totalNet != null ? formatEuropeanNumber(row.totalNet) : '', bold: true, fontSize, alignment: 'right' as const, fillColor },
      ]);
    } else {
      body.push([
        { text: str(row.treeOrdering), fontSize: 8, color: C.muted },
        { text: row.quantity != null ? String(row.quantity) : '', fontSize: 8, alignment: 'center' as const },
        { text: str(row.brandName), fontSize: 8 },
        typeCell(row, 8),
        { text: str(row.description), fontSize: 8 },
        { text: row.unitPrice != null ? formatEuropeanNumber(row.unitPrice) : '', fontSize: 8, alignment: 'right' as const },
        { text: row.totalPrice != null ? formatEuropeanNumber(row.totalPrice) : '', fontSize: 8, alignment: 'right' as const },
      ]);
    }
  }

  return {
    colCount,
    widths: [35, 28, 52, 58, '*', 65, 65],
    body,
  };
}

function buildDetailedTable(data: OfferPdfData, L: Labels) {
  // Detailed: No | Qty | Brand | Type | Description | ListPrice | Discount% | UnitPrice | Total
  const headerRow = [
    { text: L.colNo, style: 'tableHeader' },
    { text: L.colQty, style: 'tableHeader', alignment: 'center' as const },
    { text: L.colBrand, style: 'tableHeader' },
    { text: L.colType, style: 'tableHeader' },
    { text: L.colDescription, style: 'tableHeader' },
    { text: L.colListPrice, style: 'tableHeader', alignment: 'right' as const },
    { text: L.colDiscount, style: 'tableHeader', alignment: 'center' as const },
    { text: L.colUnitPrice, style: 'tableHeader', alignment: 'right' as const },
    { text: L.colTotal, style: 'tableHeader', alignment: 'right' as const },
  ];

  const body: unknown[][] = [headerRow];
  const colCount = 9;

  for (const row of data.products) {
    if (row.isComment && !row.isCategory) {
      body.push([
        { text: str(row.treeOrdering), fontSize: 7.5, color: C.muted },
        { text: '' }, { text: '' }, { text: '' },
        { text: str(row.description) || str(row.comment), fontSize: 7.5, italics: true, color: C.muted },
        { text: '' }, { text: '' }, { text: '' },
        { text: row.totalNet != null ? formatEuropeanNumber(row.totalNet) : '', fontSize: 7.5, italics: true, color: C.muted, alignment: 'right' as const },
      ]);
    } else if (row.isCategory) {
      const depth = (row.treeOrdering || '').split('.').length;
      const fontSize = depth <= 1 ? 8.5 : 8;
      const fillColor = depth <= 1 ? C.categoryBg : undefined;
      body.push([
        { text: str(row.treeOrdering), bold: true, fontSize, fillColor },
        { text: '', fillColor },
        { text: '', fillColor }, { text: '', fillColor },
        { text: str(row.description), bold: true, fontSize, fillColor },
        { text: '', fillColor }, { text: '', fillColor },
        { text: '', fillColor },
        { text: row.totalNet != null ? formatEuropeanNumber(row.totalNet) : '', bold: true, fontSize, alignment: 'right' as const, fillColor },
      ]);
    } else {
      body.push([
        { text: str(row.treeOrdering), fontSize: 7.5, color: C.muted },
        { text: row.quantity != null ? String(row.quantity) : '', fontSize: 7.5, alignment: 'center' as const },
        { text: str(row.brandName), fontSize: 7.5 },
        typeCell(row, 7.5),
        { text: str(row.description), fontSize: 7.5 },
        { text: row.listPrice != null ? formatEuropeanNumber(row.listPrice) : '', fontSize: 7.5, alignment: 'right' as const },
        { text: row.customerDiscount != null ? formatPercent(row.customerDiscount) : '', fontSize: 7.5, alignment: 'center' as const },
        { text: row.unitPrice != null ? formatEuropeanNumber(row.unitPrice) : '', fontSize: 7.5, alignment: 'right' as const },
        { text: row.totalPrice != null ? formatEuropeanNumber(row.totalPrice) : '', fontSize: 7.5, alignment: 'right' as const },
      ]);
    }
  }

  return {
    colCount,
    widths: [30, 24, 44, 50, '*', 55, 40, 55, 55],
    body,
  };
}

// ── PDF Generation ───────────────────────────────────────────────────────────

export async function generateOfferPdf(
  data: OfferPdfData,
  lang: PdfLang,
  layout: PdfLayout = 'standard',
  orientation: PdfOrientation = 'portrait',
): Promise<Buffer> {
  ensurePdfmake();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfmake = require('pdfmake');

  const L = LABELS[lang];
  const logo = getLogoBase64();

  // ── Build product table body ───────────────────────────────────────────

  const table = layout === 'detailed'
    ? buildDetailedTable(data, L)
    : buildStandardTable(data, L);

  // ── Build customer info block ──────────────────────────────────────────

  const customerRows: unknown[][] = [];
  const addCustField = (label: string, value: string) => {
    if (!value) return;
    customerRows.push([
      { text: `${label} :`, bold: true, fontSize: 8.5, color: C.muted, width: 95 },
      { text: value, fontSize: 8.5, color: C.primary },
    ]);
  };

  const custName = str(data.customer.name);
  const custBrand = str(data.customer.brandName);
  const customerName = custBrand && custBrand !== custName
    ? `${custName}\n${custBrand}`
    : custName;
  addCustField(L.to, customerName);
  addCustField(L.attn, str(data.offerContact) || str(data.contactFullName));
  addCustField(L.address, str(data.customer.address));
  addCustField(L.phone, str(data.customer.phone));
  addCustField(L.taxId, str(data.customer.taxId));
  addCustField(L.taxOffice, str(data.customer.taxOffice));

  const customerInfoTable = customerRows.length > 0
    ? {
        table: { widths: [95, '*'], body: customerRows },
        layout: 'noBorders' as const,
        margin: [0, 0, 0, 0] as number[],
      }
    : { text: '' };

  // ── Build offer metadata block (right side) ────────────────────────────

  const metaRows: unknown[][] = [];
  const addMeta = (label: string, value: string) => {
    if (!value) return;
    metaRows.push([
      { text: `${label} :`, bold: true, fontSize: 8.5, color: C.muted, alignment: 'right' as const },
      { text: value, fontSize: 8.5, color: C.primary },
    ]);
  };

  const nameCode = str(data.salesPerson.nameCode);
  const divName = str(data.salesDivisionName);
  const refSuffix = [divName, nameCode].filter(Boolean).join(' ');
  addMeta(L.refNo, refSuffix ? `${data.offerId} ${refSuffix}` : String(data.offerId));
  addMeta(L.date, formatDate(data.offerDate) || '-');
  const responsibleName = lang === 'el'
    ? str(data.salesPerson.nameGR) || str(data.salesPerson.nameEN)
    : str(data.salesPerson.nameEN) || str(data.salesPerson.nameGR);
  addMeta(L.responsible, responsibleName);

  const metaInfoTable = metaRows.length > 0
    ? {
        table: { widths: [85, '*'], body: metaRows },
        layout: 'noBorders' as const,
        margin: [0, 0, 0, 0] as number[],
      }
    : { text: '' };

  // ── Build terms section ────────────────────────────────────────────────

  const termsRows: unknown[][] = [];
  const addTerm = (label: string, value: string | null) => {
    if (!value) return;
    termsRows.push([
      { text: `${label} :`, bold: true, fontSize: 8.5, color: C.muted, alignment: 'right' as const },
      { text: value, fontSize: 8.5 },
    ]);
  };

  addTerm(L.offerValidity, data.terms.offerValidity);
  addTerm(L.paymentTerms, data.terms.paymentTerms);
  addTerm(L.deliveryTime, data.terms.deliveryTime);
  addTerm(L.installationSchedule, data.terms.installationSchedule);

  // ── Build signatures ───────────────────────────────────────────────────

  const salesName = lang === 'el'
    ? str(data.salesPerson.nameGR) || str(data.salesPerson.nameEN)
    : str(data.salesPerson.nameEN) || str(data.salesPerson.nameGR);
  const approvalName = lang === 'el'
    ? str(data.approvalUser.nameGR) || str(data.approvalUser.nameEN)
    : str(data.approvalUser.nameEN) || str(data.approvalUser.nameGR);

  // Deduplicate: if same person, show only one signature
  const isSameSigner = salesName && approvalName && salesName === approvalName;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let signatureBlock: any;
  if (isSameSigner) {
    signatureBlock = {
      stack: [
        ...(salesName ? [{ text: salesName, fontSize: 9, bold: true, color: C.primary }] : []),
        ...(data.salesPerson.signTitle
          ? [{ text: data.salesPerson.signTitle, fontSize: 8, color: C.muted }]
          : []),
      ],
    };
  } else {
    signatureBlock = {
      columns: [
        {
          width: '50%',
          stack: [
            ...(salesName ? [{ text: salesName, fontSize: 9, bold: true, color: C.primary }] : []),
            ...(data.salesPerson.signTitle
              ? [{ text: data.salesPerson.signTitle, fontSize: 8, color: C.muted }]
              : []),
          ],
        },
        {
          width: '50%',
          stack: [
            ...(approvalName ? [{ text: approvalName, fontSize: 9, bold: true, color: C.primary }] : []),
            ...(data.approvalUser.signTitle
              ? [{ text: data.approvalUser.signTitle, fontSize: 8, color: C.muted }]
              : []),
          ],
          alignment: 'right' as const,
        },
      ],
    };
  }

  // ── Company info strings ───────────────────────────────────────────────

  const companyInfoText = lang === 'el'
    ? `${COMPANY.name}, ${COMPANY.address}`
    : `${COMPANY.nameEN}, ${COMPANY.addressEN}`;
  const companyContactLine = `${COMPANY.phone}  |  ${COMPANY.fax}  |  ${COMPANY.email}  |  ${COMPANY.website}`;
  const companyTaxLine = lang === 'el'
    ? `AΦΜ: ${COMPANY.afm}, ΔΟΥ: ${COMPANY.doy}`
    : `Tax ID: ${COMPANY.afm}, Tax Office: ${COMPANY.doyEN}`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docDefinition: any = {
    pageSize: 'A4',
    pageOrientation: orientation,
    pageMargins: [40, 160, 40, 50],

    // ── Page header ──────────────────────────────────────────────────────

    header: (currentPage: number) => {
      const lineWidth = 515;
      const content: unknown[] = [
        // Logo row
        {
          columns: [
            { image: logo, width: 135, margin: [40, 14, 0, 0] },
            {
              stack: [
                { text: companyInfoText, fontSize: 7.5, color: C.muted, alignment: 'right' as const },
                { text: companyContactLine, fontSize: 7, color: C.muted, alignment: 'right' as const, margin: [0, 1, 0, 0] },
                { text: companyTaxLine, fontSize: 7, color: C.muted, alignment: 'right' as const, margin: [0, 1, 0, 0] },
              ],
              width: '*',
              margin: [0, 18, 40, 0],
            },
          ],
        },
        // Accent line
        {
          canvas: [{ type: 'line', x1: 0, y1: 0, x2: lineWidth, y2: 0, lineWidth: 2, lineColor: C.accent }],
          margin: [40, 6, 40, 0],
        },
      ];

      if (currentPage === 1) {
        // Full customer + metadata block on page 1
        content.push({
          columns: [
            { stack: [customerInfoTable], width: '58%', margin: [0, 8, 0, 0] },
            {
              stack: [
                { text: L.title, fontSize: 22, bold: true, color: C.accent, alignment: 'right' as const, margin: [0, 2, 0, 10] },
                metaInfoTable,
              ],
              width: '42%',
              margin: [0, 6, 0, 0],
            },
          ],
          margin: [40, 0, 40, 0],
        });
      } else {
        // Minimal repeat header on subsequent pages
        content.push({
          columns: [
            { text: `${L.to}: ${str(data.customer.name)}`, fontSize: 8, color: C.muted, width: '55%' },
            { text: `${L.refNo}: ${data.offerId}  —  ${L.title}`, fontSize: 8, bold: true, color: C.accent, alignment: 'right' as const, width: '45%' },
          ],
          margin: [40, 6, 40, 0],
        });
      }

      return content;
    },

    // ── Page footer ──────────────────────────────────────────────────────

    footer: (currentPage: number, pageCount: number) => ({
      columns: [
        { text: '', width: '*' },
        {
          text: `${L.pageLabel} ${currentPage}/${pageCount}`,
          fontSize: 7, color: C.muted, alignment: 'right' as const,
          margin: [0, 0, 40, 0],
        },
      ],
      margin: [0, 12, 0, 0],
    }),

    // ── Page content ─────────────────────────────────────────────────────

    content: [
      // Product table
      {
        table: {
          headerRows: 1,
          widths: table.widths,
          body: table.body,
          dontBreakRows: true,
        },
        layout: {
          hLineWidth: (i: number, node: { table: { body: unknown[][] } }) =>
            i === 1 ? 1.5 : i === 0 || i === node.table.body.length ? 0.5 : 0.4,
          vLineWidth: () => 0,
          hLineColor: (i: number) => i === 1 ? C.accent : C.border,
          vLineColor: () => 'transparent',
          paddingLeft: () => 4,
          paddingRight: () => 4,
          paddingTop: () => 3,
          paddingBottom: () => 3,
        },
        margin: [0, 0, 0, 20],
      },

      // Notes introduction
      ...(data.notesIntroduction
        ? [{ text: data.notesIntroduction, fontSize: 8.5, bold: true, color: C.primary, margin: [0, 0, 0, 8] as number[] }]
        : []),

      // Notes closing
      ...(data.notesClosing
        ? [{ text: data.notesClosing, fontSize: 8.5, color: C.primary, margin: [0, 0, 0, 8] as number[] }]
        : []),

      // VAT note
      { text: L.vatNote, fontSize: 8.5, color: C.muted, italics: true, margin: [0, 0, 0, 18] },

      // Terms (if any)
      ...(termsRows.length > 0
        ? [
            {
              table: { widths: [200, '*'], body: termsRows },
              layout: 'noBorders' as const,
              margin: [0, 0, 0, 20] as number[],
            },
          ]
        : []),

      // Regards + company
      { text: L.regards, fontSize: 9, color: C.muted, margin: [0, 10, 0, 2] },
      { text: L.companySign, fontSize: 9, bold: true, color: C.primary, margin: [0, 0, 0, 30] },

      // Signatures
      signatureBlock,
    ],

    styles: {
      tableHeader: {
        bold: true,
        fontSize: layout === 'detailed' ? 7.5 : 8,
        color: C.headerText,
        fillColor: C.headerBg,
      },
    },

    defaultStyle: {
      font: 'Roboto',
      fontSize: 9,
    },
  };

  const doc = pdfmake.createPdf(docDefinition);
  const buffer: Buffer = await doc.getBuffer();
  return buffer;
}
