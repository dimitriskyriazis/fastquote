import fs from 'fs';
import path from 'path';
import { DEFAULT_PDF_PRODUCT_COLUMNS, type PdfProductColumn } from './pdfColumns';

export type PdfLang = 'el' | 'en';
export type PdfOrientation = 'portrait' | 'landscape';

/** Loose cell type for pdfmake table body entries. */
type PdfCell = Record<string, unknown> & { rowKind?: string };
type PdfTableNode = { table: { body: PdfCell[][] } };

export type OfferPdfData = {
  offerId: number;
  offerDate: string | null;
  title: string | null;
  description: string | null;
  offerDescription?: string | null;
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
  salesPerson: { nameGR: string | null; nameEN: string | null; signTitle: string | null; nameCode: string | null; email: string | null };
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
  discountNote: string | null;
  finalPriceLabel: string | null;
  currencySymbol?: string | null;
};

export type OfferProductRow = {
  treeOrdering: string | null;
  isCategory: boolean;
  isComment: boolean;
  isOption: boolean;
  quantity: number | null;
  brandName: string | null;
  modelNumber: string | null;
  partNumber: string | null;
  description: string | null;
  warranty: string | number | null;
  origin: string | null;
  comment: string | null;
  delivery: string | null;
  unitPrice: number | null;
  totalPrice: number | null;
  totalNet: number | null;
  webLink: string | null;
  listPrice: number | null;
  customerDiscount: number | null;
  requestedBrand: string | null;
  requestedPartNo: string | null;
  requestedModelNo: string | null;
  requestedDescription: string | null;
  requestedQuantity: number | null;
};

export type PdfPrintSettings = {
  noOfLevels: number;
  printProducts: boolean;
  printCategories: boolean;
  printSubCategories: boolean;
  printSubSubCategories: boolean;
};

const LABELS = {
  el: {
    title: 'QUOTATION',
    to: 'Προς',
    attn: 'Υπ\' όψιν',
    address: 'Διεύθυνση',
    phone: 'Τηλέφωνο',
    taxId: 'ΑΦΜ',
    taxOffice: 'ΔΟΥ',
    refNo: 'Α/Α',
    date: 'Ημερομηνία',
    responsible: 'Αρμόδιος',
    responsibleEmail: 'Email',
    colNo: 'Α/Α',
    optionTag: 'Option',
    colQty: 'Τεμ',
    colBrand: 'Οίκος',
    colType: 'Κωδικός',
    colModelNumber: 'Μοντέλο',
    colDescription: 'Περιγραφή',
    colWarranty: 'Εγγύηση',
    colOrigin: 'Προέλευση',
    colComment: 'Σχόλιο',
    colDelivery: 'Παράδοση',
    colListPrice: 'Τιμή Μονάδας',
    colTotalList: 'Σύνολο',
    colDiscount: 'Έκπτωση %',
    colUnitPrice: 'Τελική Τιμή',
    colTotal: 'Τελικό Σύνολο',
    colRequestedBrand: 'Ζητ. Οίκος',
    colRequestedPartNo: 'Ζητ. Κωδικός',
    colRequestedModelNo: 'Ζητ. Μοντέλο',
    colRequestedDescription: 'Ζητ. Περιγραφή',
    colRequestedQuantity: 'Ζητ. Τεμ',
    subtotal: 'Γενικό Σύνολο',
    discountAmount: 'Έκπτωση',
    total: 'Τελική Τιμή',
    discountNoteTitle: 'Σημείωση Έκπτωσης',
    termsTitle: 'Όροι Προσφοράς',
    offerValidity: 'Ισχύς Προσφοράς',
    paymentTerms: 'Τρόπος Πληρωμής',
    deliveryTime: 'Χρόνος Παράδοσης',
    installationSchedule: 'Προβλεπόμενος Χρόνος Εγκατάστασης',
    notesTitle: 'Σημειώσεις',
    signaturesTitle: 'Υπογραφές',
    regards: 'Με εκτίμηση,',
    companySign: 'Τελμάκο Α.Ε.',
    pageLabel: 'Σελίδα',
    equipmentListTitle: 'ΛΙΣΤΑ ΕΞΟΠΛΙΣΜΟΥ',
  },
  en: {
    title: 'QUOTATION',
    to: 'To',
    attn: 'Attn',
    address: 'Address',
    phone: 'Phone',
    taxId: 'Tax ID',
    taxOffice: 'Tax Office',
    refNo: 'Ref No',
    date: 'Date',
    responsible: 'Responsible',
    responsibleEmail: 'Email',
    colNo: 'No',
    optionTag: 'Option',
    colQty: 'Qty',
    colBrand: 'Brand',
    colType: 'Part Number',
    colModelNumber: 'Model Number',
    colDescription: 'Description',
    colWarranty: 'Warranty',
    colOrigin: 'Origin',
    colComment: 'Comment',
    colDelivery: 'Delivery',
    colListPrice: 'Unit List',
    colTotalList: 'Total List',
    colDiscount: 'Discount %',
    colUnitPrice: 'Unit Net',
    colTotal: 'Total Net',
    colRequestedBrand: 'Req. Brand',
    colRequestedPartNo: 'Req. Part Number',
    colRequestedModelNo: 'Req. Model Number',
    colRequestedDescription: 'Req. Description',
    colRequestedQuantity: 'Req. Qty',
    subtotal: 'Grand Total',
    discountAmount: 'Discount',
    total: 'Final Price',
    discountNoteTitle: 'Discount Note',
    termsTitle: 'Commercial Terms',
    offerValidity: 'Offer Validity',
    paymentTerms: 'Payment Terms',
    deliveryTime: 'Delivery Time',
    installationSchedule: 'Installation Schedule',
    notesTitle: 'Notes',
    signaturesTitle: 'Signatures',
    regards: 'Best regards,',
    companySign: 'Telmaco S.A.',
    pageLabel: 'Page',
    equipmentListTitle: 'EQUIPMENT LIST',
  },
} as const;

type Labels = (typeof LABELS)[PdfLang];

const PRICE_COLUMNS = new Set<PdfProductColumn>(['listPrice', 'totalList', 'discount', 'unitPrice', 'total']);

const COLORS = {
primaryText: '#222222',
secondaryText: '#6B7280',
optionText: '#1B3A6B',
lightBg: '#F5F5F5',
border: '#E5E5E5',
accentRed: '#C62828',
zebraRowBg: '#F7F7F7',
categoryBg: '#F0F0F0',
categoryLine: '#D9D9D9',
sectionLine: '#E0E0E0',
termsBoxBg: '#F7F7F7',
} as const;

const COMPANY = {
  name: 'Τελμάκο Α.Ε.',
  nameEN: 'Telmaco S.A.',
  address: 'Αθ. Διάκου 23, 152 33 Χαλάνδρι',
  addressEN: 'Ath. Diakou 23, 152 33 Chalandri',
  phone: '210 6874 100',
  email: 'info@telmaco.gr',
  website: 'www.telmaco.gr',
  afm: '094150597',
  doy: 'ΚΕΦΟΔΕ ΑΤΤΙΚΗΣ',
  doyEN: 'KEFODE ATTIKIS',
};

const PAGE_MARGINS: Record<PdfOrientation, [number, number, number, number]> = {
  // Top margin must be larger than the running header height,
  // otherwise table headers render too close to (or under) the header line.
  portrait: [40, 60, 40, 36],
  landscape: [36, 56, 36, 32],
};

const COVER_LOGO_FIT: Record<PdfOrientation, [number, number]> = {
  portrait: [220, 72],
  landscape: [200, 60],
};

const INNER_LOGO_FIT: Record<PdfOrientation, [number, number]> = {
  portrait: [110, 34],
  landscape: [104, 30],
};

// A4 page width in PDF points
const A4_WIDTH: Record<PdfOrientation, number> = {
  portrait: 595.28,
  landscape: 841.89,
};

function innerContentWidth(orientation: PdfOrientation) {
  const [ml, , mr] = PAGE_MARGINS[orientation];
  return A4_WIDTH[orientation] - ml - mr;
}

/**
 * Width tuning: give Description more space by reducing Brand/Type slightly.
 * Keeps products readable and reduces “ladder wrapping”.
 */
const BASE_WIDTHS: Record<PdfOrientation, Record<PdfProductColumn, number | '*'>> = {
  portrait: {
    no: 28,
    qty: 26,
    brand: 42,
    type: 52,
    modelNumber: 52,
    description: '*',
    unitPrice: 52,
    total: 52,
    listPrice: 52,
    totalList: 52,
    discount: 43,
    warranty: 44,
    origin: 62,
    comment: 58,
    delivery: 50,
    requestedBrand: 44,
    requestedPartNo: 52,
    requestedModelNo: 52,
    requestedDescription: 72,
    requestedQuantity: 28,
  },
  landscape: {
    no: 30,
    qty: 28,
    brand: 48,
    type: 60,
    modelNumber: 60,
    description: '*',
    unitPrice: 58,
    total: 58,
    listPrice: 58,
    totalList: 58,
    discount: 49,
    warranty: 50,
    origin: 70,
    comment: 64,
    delivery: 56,
    requestedBrand: 48,
    requestedPartNo: 60,
    requestedModelNo: 60,
    requestedDescription: 88,
    requestedQuantity: 30,
  },
};

let _logoBase64: string | null = null;
let _pdfmakeReady = false;

function str(v: string | null | undefined): string {
  return v?.trim() || '';
}

function scalar(v: string | number | null | undefined): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  return str(v);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;
}

function formatEuropeanNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '';
  const parts = n.toFixed(2).split('.');
  const intPart = (parts[0] ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${intPart},${parts[1] ?? '00'}`;
}

let currentCurrencySymbol = '€';

function formatCurrency(n: number | null | undefined): string {
  const v = formatEuropeanNumber(n);
  if (!v) return '';
  return currentCurrencySymbol === '$'
    ? `${currentCurrencySymbol} ${v}`
    : `${v} ${currentCurrencySymbol}`;
}

function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return '';
  return n.toFixed(1).replace('.', ',');
}

function fixObviousTypos(text: string): string {
  return text.replace(/\bWe\s+we\b/gi, 'We');
}

function getLogoBase64(): string {
  if (_logoBase64) return _logoBase64;
  const logoPath = path.join(process.cwd(), 'public', 'telmaco.jpg');
  const buf = fs.readFileSync(logoPath);
  _logoBase64 = `data:image/jpeg;base64,${buf.toString('base64')}`;
  return _logoBase64;
}

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
    Inter: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
    Roboto: {
      normal: 'Roboto-Regular.ttf',
      bold: 'Roboto-Medium.ttf',
      italics: 'Roboto-Italic.ttf',
      bolditalics: 'Roboto-MediumItalic.ttf',
    },
  });

  _pdfmakeReady = true;
}

function getOfferMeta(data: OfferPdfData, lang: PdfLang) {
  const salesName =
    lang === 'el'
      ? str(data.salesPerson.nameGR) || str(data.salesPerson.nameEN)
      : str(data.salesPerson.nameEN) || str(data.salesPerson.nameGR);

  const approvalName =
    lang === 'el'
      ? str(data.approvalUser.nameGR) || str(data.approvalUser.nameEN)
      : str(data.approvalUser.nameEN) || str(data.approvalUser.nameGR);

  const refParts = [String(data.offerId), str(data.salesDivisionName), str(data.salesPerson.nameCode)].filter(Boolean);
  const refNo = refParts.join('-');

  const customerName = (() => {
    const name = str(data.customer.name);
    const brand = str(data.customer.brandName);
    return brand && brand !== name ? `${name}\n${brand}` : name;
  })();

  return {
    salesName,
    approvalName,
    refNo,
    date: formatDate(data.offerDate) || '-',
    customerName,
    attn: str(data.offerContact) || str(data.contactFullName),
  };
}

/**
 * If delivery is not visible as a column, render it subtly under Description.
 * Comment and Warranty are intentionally excluded when their columns are not selected —
 * they should appear only when explicitly selected as columns.
 */
function buildDescriptionCell(
  row: OfferProductRow,
  baseText: string,
  selectedColumns: PdfProductColumn[],
) {
  if (row.isComment) {
    return { text: baseText };
  }

  const showDeliveryCol = selectedColumns.includes('delivery');

  const extraLines: string[] = [];

  if (!showDeliveryCol) {
    const delivery = str(row.delivery);
    if (delivery) extraLines.push(`Delivery: ${delivery}`);
  }

  if (extraLines.length === 0) {
    return { text: baseText };
  }

  return {
    stack: [
      { text: baseText },
      {
        text: extraLines.join('\n'),
        fontSize: 6.8,
        color: COLORS.secondaryText,
        margin: [0, 1, 0, 0],
      },
    ],
  };
}

function buildCompactHeader(data: OfferPdfData, L: Labels, lang: PdfLang, orientation: PdfOrientation, logo: string) {
  const meta = getOfferMeta(data, lang);

  const companyName = lang === 'el' ? COMPANY.name : COMPANY.nameEN;
  const companyAddress = lang === 'el' ? COMPANY.address : COMPANY.addressEN;
  const companyPhone = lang === 'en' ? `+30 ${COMPANY.phone}` : COMPANY.phone;
  const taxLine =
    lang === 'el'
      ? `ΑΦΜ: ${COMPANY.afm}, ΔΟΥ: ${COMPANY.doy}`
      : `Tax ID: ${COMPANY.afm}, Tax Office: ${COMPANY.doyEN}`;

  const salesEmail = str(data.salesPerson.email);
  const leftInfo = [
    { label: L.to, value: meta.customerName || '-' },
    { label: L.attn, value: meta.attn },
    { label: L.address, value: str(data.customer.address) },
    { label: L.phone, value: str(data.customer.phone) },
    { label: L.taxId, value: str(data.customer.taxId) },
  ].filter((r) => r.value);

  const rightInfo = [
    { label: L.refNo, value: meta.refNo },
    { label: L.date, value: meta.date },
    { label: L.responsible, value: meta.salesName || '-' },
    ...(salesEmail ? [{ label: L.responsibleEmail, value: salesEmail }] : []),
  ];

  const labelStyle = { fontSize: 7.3, color: COLORS.secondaryText, bold: false };
  const compactValue = { fontSize: 8.3, color: COLORS.primaryText, bold: true };

  return [
    {
      columns: [
        { width: 'auto', image: logo, fit: INNER_LOGO_FIT[orientation] },
        {
          width: '*',
          stack: [
            { text: `${companyName}  |  ${companyAddress}`, ...labelStyle, alignment: 'right' },
            { text: `${companyPhone} | ${COMPANY.email} | ${COMPANY.website}`, ...labelStyle, alignment: 'right', margin: [0, 1, 0, 0] },
            { text: taxLine, ...labelStyle, alignment: 'right', margin: [0, 1, 0, 0] },
          ],
        },
      ],
    },
    {
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 0,
          x2: innerContentWidth(orientation),
          y2: 0,
          lineWidth: 1,
          lineColor: COLORS.accentRed,
        },
      ],
      margin: [0, 6, 0, 6],
    },
    {
      margin: [0, 0, 0, 10],
      table: {
        widths: ['*', '*'],
        body: [
          [
            {
              table: {
                widths: ['auto', '*'],
                body:
                  leftInfo.length > 0
                    ? leftInfo.map((row) => [
                        { text: `${row.label}:`, ...labelStyle },
                        { text: row.value, ...compactValue },
                      ])
                    : [[{ text: '', ...labelStyle }, { text: '', ...compactValue }]],
              },
              layout: {
                hLineWidth: () => 0,
                vLineWidth: () => 0,
                paddingLeft: (i: number) => (i === 0 ? 0 : 6),
                paddingRight: (i: number) => (i === 0 ? 4 : 0),
                paddingTop: () => 2,
                paddingBottom: () => 2,
              },
              margin: [6, 4, 6, 4],
            },
            {
              table: {
                widths: ['auto', '*'],
                body: rightInfo.map((row) => [
                  { text: `${row.label}:`, ...labelStyle },
                  { text: row.value, ...compactValue },
                ]),
              },
              layout: {
                hLineWidth: () => 0,
                vLineWidth: () => 0,
                paddingLeft: (i: number) => (i === 0 ? 0 : 6),
                paddingRight: (i: number) => (i === 0 ? 4 : 0),
                paddingTop: () => 2,
                paddingBottom: () => 2,
              },
              margin: [6, 4, 6, 4],
            },
          ],
        ],
      },
      layout: {
        fillColor: () => COLORS.lightBg,
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 8,
        paddingRight: () => 8,
        paddingTop: () => 6,
        paddingBottom: () => 6,
      },
    },
  ];
}

function buildCoverPage(data: OfferPdfData, L: Labels, lang: PdfLang, orientation: PdfOrientation, logo: string, equipmentList: boolean = false) {
  const meta = getOfferMeta(data, lang);
  const isLandscape = orientation === 'landscape';
  const coverTitle = equipmentList ? L.equipmentListTitle : (str(data.title) || L.title);

  // De-duplicate cover: do NOT include L.to here since the client identity is already centered.
  const leftInfo = [
    { label: L.attn, value: meta.attn },
    { label: L.address, value: str(data.customer.address) },
    { label: L.phone, value: str(data.customer.phone) },
    { label: L.taxId, value: str(data.customer.taxId) },
  ].filter((r) => r.value);

  const salesEmail = str(data.salesPerson.email);
  const rightInfo = [
    { label: L.refNo, value: meta.refNo },
    { label: L.date, value: meta.date },
    { label: L.responsible, value: meta.salesName || '-' },
    ...(salesEmail ? [{ label: L.responsibleEmail, value: salesEmail }] : []),
  ];

  const companyName = lang === 'el' ? COMPANY.name : COMPANY.nameEN;
  const companyAddress = lang === 'el' ? COMPANY.address : COMPANY.addressEN;
  const companyPhone = lang === 'en' ? `+30 ${COMPANY.phone}` : COMPANY.phone;
  const taxLine =
    lang === 'el'
      ? `ΑΦΜ: ${COMPANY.afm}, ΔΟΥ: ${COMPANY.doy}`
      : `Tax ID: ${COMPANY.afm}, Tax Office: ${COMPANY.doyEN}`;

  return [
    {
      columns: [
        { width: 'auto', image: logo, fit: COVER_LOGO_FIT[orientation] },
        {
          width: '*',
          stack: [
            { text: companyName, style: 'secondary', alignment: 'right' },
            { text: companyAddress, style: 'secondary', alignment: 'right', margin: [0, 2, 0, 0] },
            { text: `${companyPhone} | ${COMPANY.email}`, style: 'secondary', alignment: 'right', margin: [0, 2, 0, 0] },
            { text: COMPANY.website, style: 'secondary', alignment: 'right', margin: [0, 2, 0, 0] },
            { text: taxLine, style: 'secondary', alignment: 'right', margin: [0, 2, 0, 0] },
          ],
        },
      ],
    },
    {
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 0,
          x2: innerContentWidth(orientation),
          y2: 0,
          lineWidth: 1.5,
          lineColor: COLORS.accentRed,
        },
      ],
      margin: [0, 16, 0, 0],
    },
    {
      stack: [
        { text: coverTitle, style: 'titleCover', alignment: 'center' },
        ...(str(data.offerDescription)
          ? [
              {
                text: str(data.offerDescription),
                fontSize: isLandscape ? 24 : 22,
                bold: true,
                color: COLORS.primaryText,
                alignment: 'center',
                margin: [0, 12, 0, 0],
              },
            ]
          : []),
        {
          text: meta.customerName || ' ',
          fontSize: isLandscape ? 20 : 18,
          bold: true,
          color: COLORS.primaryText,
          alignment: 'center',
          margin: [0, 18, 0, 0],
        },
      ],
      margin: [0, isLandscape ? 70 : 96, 0, 0],
    },
    {
      margin: [0, isLandscape ? 58 : 88, 0, 0],
      table: {
        widths: ['*', '*'],
        body: [
          [
            {
              table: {
                widths: ['auto', '*'],
                body:
                  leftInfo.length > 0
                    ? leftInfo.map((row) => [
                        { text: `${row.label}:`, style: 'metaLabel' },
                        { text: row.value, style: 'metaValue' },
                      ])
                    : [[{ text: '', style: 'metaLabel' }, { text: '', style: 'metaValue' }]],
              },
              layout: {
                hLineWidth: () => 0,
                vLineWidth: () => 0,
                paddingLeft: (i: number) => (i === 0 ? 0 : 8),
                paddingRight: (i: number) => (i === 0 ? 4 : 0),
                paddingTop: () => 2.5,
                paddingBottom: () => 2.5,
              },
              margin: [8, 6, 8, 6],
            },
            {
              table: {
                widths: ['auto', '*'],
                body: rightInfo.map((row) => [
                  { text: `${row.label}:`, style: 'metaLabel' },
                  { text: row.value, style: 'metaValue' },
                ]),
              },
              layout: {
                hLineWidth: () => 0,
                vLineWidth: () => 0,
                paddingLeft: (i: number) => (i === 0 ? 0 : 8),
                paddingRight: (i: number) => (i === 0 ? 4 : 0),
                paddingTop: () => 2.5,
                paddingBottom: () => 2.5,
              },
              margin: [8, 6, 8, 6],
            },
          ],
        ],
      },
      layout: {
        fillColor: () => COLORS.lightBg,
        hLineWidth: () => 0,
        vLineWidth: () => 0,
        paddingLeft: () => 14,
        paddingRight: () => 14,
        paddingTop: () => 14,
        paddingBottom: () => 14,
      },
      pageBreak: 'after',
    },
  ];
}

function buildHeaderFull(data: OfferPdfData, L: Labels, lang: PdfLang, orientation: PdfOrientation, logo: string) {
  const meta = getOfferMeta(data, lang);

  return {
    margin: [PAGE_MARGINS[orientation][0], 8, PAGE_MARGINS[orientation][2], 0],
    stack: [
      {
        columns: [
          { width: 'auto', image: logo, fit: INNER_LOGO_FIT[orientation] },
          {
            width: '*',
            margin: [0, 10, 0, 0],
            stack: [
              { text: `${L.refNo}: ${meta.refNo}`, style: 'secondary', alignment: 'right' },
              { text: `${L.date}: ${meta.date}`, style: 'secondary', alignment: 'right', margin: [0, 1, 0, 0] },
            ],
          },
        ],
      },
      {
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: innerContentWidth(orientation),
            y2: 0,
            lineWidth: 0.8,
            lineColor: COLORS.accentRed,
          },
        ],
        margin: [0, 6, 0, 8],
      },
    ],
  };
}

function tableHeaderLabel(column: PdfProductColumn, L: Labels): string {
  switch (column) {
    case 'no': return L.colNo;
    case 'qty': return L.colQty;
    case 'brand': return L.colBrand;
    case 'type': return L.colType;
    case 'modelNumber': return L.colModelNumber;
    case 'description': return L.colDescription;
    case 'warranty': return L.colWarranty;
    case 'origin': return L.colOrigin;
    case 'comment': return L.colComment;
    case 'delivery': return L.colDelivery;
    case 'listPrice': return L.colListPrice;
    case 'totalList': return L.colTotalList;
    case 'discount': return L.colDiscount;
    case 'unitPrice': return L.colUnitPrice;
    case 'total': return L.colTotal;
    case 'requestedBrand': return L.colRequestedBrand;
    case 'requestedPartNo': return L.colRequestedPartNo;
    case 'requestedModelNo': return L.colRequestedModelNo;
    case 'requestedDescription': return L.colRequestedDescription;
    case 'requestedQuantity': return L.colRequestedQuantity;
  }
}

/**
 * Determines whether a row should display price values based on print settings.
 * - For product rows (non-category): controlled by printProducts
 * - For category rows: depth 1 = Categories, depth 2 = Sub-Categories, depth 3 = Sub-Sub-Categories
 */
function shouldShowPrices(row: OfferProductRow, printSettings: PdfPrintSettings | null): boolean {
  if (!printSettings) return true;
  const depth = row.treeOrdering ? row.treeOrdering.split('.').length : 1;

  if (row.isCategory) {
    // Category at depth 1 → "Categories" flag
    // Category at depth 2 → "Sub-Categories" flag
    // Category at depth 3 → "Sub-Sub-Categories" flag
    if (depth === 1) return printSettings.printCategories;
    if (depth === 2) return printSettings.printSubCategories;
    if (depth === 3) return printSettings.printSubSubCategories;
    return false;
  }

  // Non-category rows are "products"
  return printSettings.printProducts;
}

function columnValue(row: OfferProductRow, column: PdfProductColumn): string {
  switch (column) {
    case 'no': {
      return str(row.treeOrdering);
    }
    case 'qty': {
      if (row.isComment && (row.quantity == null || row.quantity === 0)) return '';
      return row.quantity != null ? String(row.quantity) : '';
    }
    case 'brand': return str(row.brandName);
    case 'type': return str(row.partNumber);
    case 'modelNumber': return str(row.modelNumber);
    case 'description': {
      if (!row.isComment) return str(row.description);
      return str(row.description) || str(row.comment);
    }
    case 'warranty': return scalar(row.warranty);
    case 'origin': return str(row.origin);
    case 'comment': return str(row.comment);
    case 'delivery': return str(row.delivery);
    case 'listPrice': return row.listPrice != null ? formatCurrency(row.listPrice) : '';
    case 'totalList': {
      if (row.listPrice != null && row.quantity != null) {
        return formatCurrency(row.listPrice * row.quantity);
      }
      return row.listPrice != null ? formatCurrency(row.listPrice) : '';
    }
    case 'discount': return row.customerDiscount != null ? formatPercent(row.customerDiscount) : '';
    case 'unitPrice': return row.unitPrice != null ? formatCurrency(row.unitPrice) : '';
    case 'total': {
      const hasAmount = (
        (row.totalPrice != null && Number.isFinite(row.totalPrice)) ||
        (row.totalNet != null && Number.isFinite(row.totalNet)) ||
        (
          row.quantity != null &&
          row.unitPrice != null &&
          Number.isFinite(row.quantity) &&
          Number.isFinite(row.unitPrice)
        )
      );
      return hasAmount ? formatCurrency(lineNetAmount(row)) : '';
    }
    case 'requestedBrand': return str(row.requestedBrand);
    case 'requestedPartNo': return str(row.requestedPartNo);
    case 'requestedModelNo': return str(row.requestedModelNo);
    case 'requestedDescription': return str(row.requestedDescription);
    case 'requestedQuantity': return row.requestedQuantity != null ? String(row.requestedQuantity) : '';
  }
}

function dynamicCellFont(
  column: PdfProductColumn,
): { style: 'cell' | 'cellTight'; fontSize?: number; lineHeight?: number } {
  if (column === 'description') return { style: 'cell', lineHeight: 1.28 };
  return { style: 'cell', lineHeight: 1.15 };
}

function computeColumnWidths(selectedColumns: PdfProductColumn[], orientation: PdfOrientation): Array<number | '*'> {
  const widths = selectedColumns.map((c) => BASE_WIDTHS[orientation][c]);
  if (!selectedColumns.includes('description') && widths.length > 0) {
    widths[widths.length - 1] = '*';
  }
  return widths;
}

function lineNetAmount(row: OfferProductRow): number {
  if (row.totalNet != null && Number.isFinite(row.totalNet)) return row.totalNet;
  if (row.quantity != null && row.unitPrice != null && Number.isFinite(row.quantity) && Number.isFinite(row.unitPrice)) {
    return row.quantity * row.unitPrice;
  }
  if (row.totalPrice != null && Number.isFinite(row.totalPrice)) return row.totalPrice;
  return 0;
}

function lineListAmount(row: OfferProductRow): number {
  if (row.totalPrice != null && Number.isFinite(row.totalPrice)) return row.totalPrice;
  if (row.listPrice != null && row.quantity != null && Number.isFinite(row.listPrice) && Number.isFinite(row.quantity)) {
    return row.listPrice * row.quantity;
  }
  if (row.listPrice != null && Number.isFinite(row.listPrice)) return row.listPrice;
  return lineNetAmount(row);
}

function buildCategoryTotalsMap(
  products: OfferProductRow[],
  resolveAmount: (row: OfferProductRow) => number,
): Map<string, number> {
  const categories = products.filter((p) => p.isCategory && str(p.treeOrdering));
  // Options are excluded from category totals — they are shown separately as optional items
  const detailRows = products.filter((p) => !p.isCategory && !p.isOption && str(p.treeOrdering));

  const totals = new Map<string, number>();

  for (const category of categories) {
    const key = str(category.treeOrdering);
    if (!key) continue;
    let sum = 0;
    for (const row of detailRows) {
      const rowKey = str(row.treeOrdering);
      if (rowKey === key || rowKey.startsWith(`${key}.`)) {
        sum += resolveAmount(row);
      }
    }
    totals.set(key, sum);
  }

  return totals;
}

function buildItemsTable(
  data: OfferPdfData,
  L: Labels,
  orientation: PdfOrientation,
  selectedColumns: PdfProductColumn[],
  printSettings: PdfPrintSettings | null = null,
) {
  const showCategoryTotalNet = selectedColumns.includes('total');
  const showCategoryTotalList = selectedColumns.includes('totalList');
  const categoryNetTotalsMap = showCategoryTotalNet
    ? buildCategoryTotalsMap(data.products, lineNetAmount)
    : new Map<string, number>();
  const categoryListTotalsMap = showCategoryTotalList
    ? buildCategoryTotalsMap(data.products, lineListAmount)
    : new Map<string, number>();
  const numericCols = new Set<PdfProductColumn>(['qty', 'listPrice', 'totalList', 'discount', 'unitPrice', 'total', 'requestedQuantity']);
  const priceColumns = new Set<PdfProductColumn>(['listPrice', 'totalList', 'discount', 'unitPrice', 'total']);

  const headerRow = selectedColumns.map((col) => ({
    text: tableHeaderLabel(col, L),
    style: 'tableHeader',
    alignment: numericCols.has(col) ? 'right' : 'left',
    noWrap: col === 'discount',
    rowKind: 'header',
  }));

  const body: PdfCell[][] = [headerRow];

  for (const row of data.products) {
    if (row.isCategory) {
      const categoryText = [str(row.treeOrdering), str(row.description)].filter(Boolean).join('     ');
      const categoryKey = str(row.treeOrdering);
      const fallbackNetAmount = categoryKey ? categoryNetTotalsMap.get(categoryKey) : null;
      const categoryNetAmountValue =
        row.totalNet != null && Number.isFinite(row.totalNet)
          ? row.totalNet
          : (fallbackNetAmount != null && Number.isFinite(fallbackNetAmount) ? fallbackNetAmount : null);

      const fallbackListAmount = categoryKey ? categoryListTotalsMap.get(categoryKey) : null;
      const categoryListAmountValue =
        row.totalPrice != null && Number.isFinite(row.totalPrice)
          ? row.totalPrice
          : (fallbackListAmount != null && Number.isFinite(fallbackListAmount) ? fallbackListAmount : null);

      const showCategoryPrices = shouldShowPrices(row, printSettings);
      const totalListIdx = selectedColumns.indexOf('totalList');
      const totalNetIdx = selectedColumns.indexOf('total');

      const amountByIdx = new Map<number, number>();
      if (showCategoryPrices && showCategoryTotalList && totalListIdx !== -1 && categoryListAmountValue != null && categoryListAmountValue > 0) {
        amountByIdx.set(totalListIdx, categoryListAmountValue);
      }
      if (showCategoryPrices && showCategoryTotalNet && totalNetIdx !== -1 && categoryNetAmountValue != null && categoryNetAmountValue > 0) {
        amountByIdx.set(totalNetIdx, categoryNetAmountValue);
      }

      const catBase = {
        fillColor: COLORS.categoryBg,
        border: [false, false, false, false],
        bold: true,
        fontSize: 8.0,
        color: COLORS.primaryText,
      };
      const n = selectedColumns.length;
      const cells: PdfCell[] = [];

      if (amountByIdx.size === 0) {
        // No per-column amounts: full-width category text
        cells.push({
          ...catBase,
          colSpan: n,
          rowKind: 'category',
          text: categoryText,
        });
        for (let k = 1; k < n; k++) cells.push({ text: '', ...catBase });
      } else {
        const sortedBreaks = Array.from(amountByIdx.keys()).sort((a, b) => a - b);
        let cursor = 0;
        let firstSegment = true;
        for (const breakIdx of sortedBreaks) {
          const span = breakIdx - cursor;
          if (span > 0) {
            cells.push({
              ...catBase,
              colSpan: span,
              rowKind: firstSegment ? 'category' : undefined,
              text: firstSegment ? categoryText : '',
            });
            for (let k = 1; k < span; k++) cells.push({ text: '', ...catBase });
            firstSegment = false;
          }
          cells.push({
            ...catBase,
            rowKind: firstSegment ? 'category' : undefined,
            text: formatCurrency(amountByIdx.get(breakIdx)!),
            alignment: 'right',
          });
          firstSegment = false;
          cursor = breakIdx + 1;
        }
        const tailSpan = n - cursor;
        if (tailSpan > 0) {
          cells.push({
            ...catBase,
            colSpan: tailSpan,
            text: '',
          });
          for (let k = 1; k < tailSpan; k++) cells.push({ text: '', ...catBase });
        }
        // Ensure first cell carries rowKind so layout callbacks see it
        if (cells[0] && !cells[0].rowKind) cells[0].rowKind = 'category';
      }

      body.push(cells);
      continue;
    }

    // Options always show prices regardless of printProducts setting — they are
    // optional items and their prices must always be visible so the customer can
    // see what each option costs.
    const hidePrices = !shouldShowPrices(row, printSettings) && !row.isOption;

    body.push(
      selectedColumns.map((col) => {
        // Description supports compact sub-lines when comment/delivery columns are hidden.
        if (col === 'description') {
          const base = columnValue(row, col);
          const dyn = dynamicCellFont(col);
          const descCell = buildDescriptionCell(row, base, selectedColumns);

          const cell: PdfCell = {
            ...descCell,
            style: dyn.style,
            noWrap: false,
          };
          if (dyn.fontSize) cell.fontSize = dyn.fontSize;
          if (dyn.lineHeight) cell.lineHeight = dyn.lineHeight;
          if (row.isOption) {
            cell.italics = true;
            cell.color = COLORS.optionText;
          }
          return cell;
        }

        // For option rows, show only the word "Option" in totalList and total
        // columns — no price amount, just the label so the customer can identify it.
        if (row.isOption && (col === 'totalList' || col === 'total')) {
          const dyn = dynamicCellFont(col);
          const optionCell: PdfCell = {
            text: L.optionTag,
            style: dyn.style,
            italics: true,
            color: COLORS.optionText,
            alignment: 'right',
            noWrap: true,
          };
          if (col === selectedColumns[0]) optionCell.rowKind = 'option';
          return optionCell;
        }

        const value = hidePrices && priceColumns.has(col) ? '' : columnValue(row, col);
        const dyn = dynamicCellFont(col);

        const baseCell: PdfCell = {
          text: value,
          style: dyn.style,
          noWrap: numericCols.has(col) || col === 'no',
        };
        if (dyn.fontSize) baseCell.fontSize = dyn.fontSize;
        if (dyn.lineHeight) baseCell.lineHeight = dyn.lineHeight;
        if (numericCols.has(col)) {
          baseCell.alignment = 'right';
          baseCell.fontFeatures = ['tnum'];
        }
        if (row.isOption) {
          baseCell.italics = true;
          baseCell.color = COLORS.optionText;
        }

        if ((col === 'type' || col === 'modelNumber') && str(row.webLink) && value) {
          const hasPartNumber = !!str(row.partNumber);
          const linkOnThisCol = col === 'type' ? hasPartNumber : !hasPartNumber;
          if (linkOnThisCol) {
            baseCell.color = '#1D4ED8';
            baseCell.decoration = 'underline';
            baseCell.link = str(row.webLink);
          }
        }

        // Tag first column so layout callbacks can detect normal item rows.
        if (col === selectedColumns[0]) baseCell.rowKind = row.isOption ? 'option' : 'item';

        return baseCell;
      }),
    );
  }

  const zebraRows = new Set<number>();
  let itemRowOrdinal = 0;
  for (let rowIndex = 1; rowIndex < body.length; rowIndex += 1) {
    const kind = body[rowIndex]?.[0]?.rowKind;
    if (kind !== 'item' && kind !== 'option') continue;
    itemRowOrdinal += 1;
    if (itemRowOrdinal % 2 === 0) zebraRows.add(rowIndex);
  }

  return {
    table: {
      headerRows: 1,
      widths: computeColumnWidths(selectedColumns, orientation),
      body,
      // Keep each product row intact; if it doesn't fit, move it to the next page.
      dontBreakRows: true,
    },
    layout: {
      hLineWidth: (i: number, node: PdfTableNode) => {
        if (i === 0) return 0;              // top of table
        if (i === 1) return 1;              // under header
        if (i === node.table.body.length) return 0.6;
        const rowAboveKind = node.table.body[i - 1]?.[0]?.rowKind;
        const rowBelowKind = node.table.body[i]?.[0]?.rowKind;
        if (rowAboveKind === 'category' || rowBelowKind === 'category') return 0.7;
        return 0.4;
      },
      vLineWidth: () => 0,
      hLineColor: (i: number, node: PdfTableNode) => {
        const rowAboveKind = node.table.body[i - 1]?.[0]?.rowKind;
        const rowBelowKind = node.table.body[i]?.[0]?.rowKind;
        if (rowAboveKind === 'category' || rowBelowKind === 'category') return COLORS.categoryLine;
        return COLORS.border;
      },
      vLineColor: () => COLORS.border,

      paddingLeft: () => 5,
      paddingRight: () => 5,

      paddingTop: (i: number, node: PdfTableNode) => {
        const kind = node.table.body[i]?.[0]?.rowKind;
        if (kind === 'category') return 4;
        if (kind === 'item' || kind === 'option') return 3;
        return 5;
      },
      paddingBottom: (i: number, node: PdfTableNode) => {
        const kind = node.table.body[i]?.[0]?.rowKind;
        if (kind === 'category') return 7;
        if (kind === 'item' || kind === 'option') return 3;
        return 5;
      },

      fillColor: (i: number, node: PdfTableNode) => {
        const kind = node.table.body[i]?.[0]?.rowKind;
        if (kind !== 'item' && kind !== 'option') return null;
        return zebraRows.has(i) ? COLORS.zebraRowBg : null;
      },
    },
  };
}

function calculateDiscountSummary(data: OfferPdfData): {
  listSubtotal: number;
  discountEur: number;
  totalNet: number;
} {
  const detailRows = data.products.filter((p) => !p.isCategory && !p.isOption);

  let listSubtotal = 0;
  let totalNet = 0;

  for (const row of detailRows) {
    const lineTotal = lineNetAmount(row);
    const qty = row.quantity ?? null;

    // Net summary should follow the same source as the line Total column.
    totalNet += lineTotal;

    if (qty != null && row.listPrice != null) {
      listSubtotal += row.listPrice * qty;
      continue;
    }

    if (row.customerDiscount != null && row.customerDiscount > 0 && row.customerDiscount < 100 && lineTotal > 0) {
      listSubtotal += lineTotal / (1 - (row.customerDiscount / 100));
      continue;
    }

    listSubtotal += lineTotal;
  }

  if (listSubtotal <= 0) listSubtotal = totalNet;

  const discountEur = Math.max(0, listSubtotal - totalNet);

  return { listSubtotal, discountEur, totalNet };
}

function buildTotalsAndTerms(
  data: OfferPdfData,
  L: Labels,
  orientation: PdfOrientation,
  selectedColumns: PdfProductColumn[],
  equipmentList: boolean = false,
): { totals: unknown[]; terms: unknown[] } {
  const hasPriceColumns = selectedColumns.some(c => PRICE_COLUMNS.has(c));
  const discountSummary = calculateDiscountSummary(data);
  const showDiscountSummary = discountSummary.discountEur > 0;

  let terms = [
    { label: L.offerValidity, value: fixObviousTypos(str(data.terms.offerValidity)) },
    { label: L.paymentTerms, value: fixObviousTypos(str(data.terms.paymentTerms)) },
    { label: L.deliveryTime, value: fixObviousTypos(str(data.terms.deliveryTime)) },
    { label: L.installationSchedule, value: fixObviousTypos(str(data.terms.installationSchedule)) },
  ].filter((t) => t.value);

  if (equipmentList) {
    terms = terms.filter(t => t.label !== L.paymentTerms);
  }

  const cell = (t?: { label: string; value: string }) => {
    if (!t) return { text: '', margin: [0, 3, 0, 3] };
    return {
      text: [
        { text: `${t.label}: `, fontSize: 8.3, color: COLORS.secondaryText },
        { text: t.value, fontSize: 8.3, bold: true, color: COLORS.primaryText },
      ],
      margin: [0, 3, 0, 3],
    };
  };

  const termRows: unknown[][] = [];
  for (let i = 0; i < terms.length; i += 2) {
    termRows.push([cell(terms[i]), cell(terms[i + 1])]);
  }

  const totalsBlocks: unknown[] = [];
  const termsBlocks: unknown[] = [];

  const summaryRowStyle = { fontSize: 8.3, color: COLORS.primaryText };
  const finalPriceStyle = { fontSize: 9.3, bold: true, color: COLORS.primaryText };
  const baseRows: PdfCell[][] = showDiscountSummary
    ? [
        [
          { text: L.subtotal, ...summaryRowStyle },
          { text: formatCurrency(discountSummary.listSubtotal), ...summaryRowStyle, alignment: 'right' },
        ],
        [
          { text: L.discountAmount, ...summaryRowStyle },
          { text: formatCurrency(discountSummary.discountEur), ...summaryRowStyle, alignment: 'right' },
        ],
      ]
    : [];

  const finalPriceLabel = str(data.finalPriceLabel) || L.total;
  const finalPriceValue = discountSummary.totalNet;
  const totalRow: PdfCell[] = [
    { text: finalPriceLabel, ...finalPriceStyle },
    { text: formatCurrency(finalPriceValue), ...finalPriceStyle, alignment: 'right' },
  ];

  const summaryRows: PdfCell[][] = [...baseRows, totalRow];

  const discountNote = str(data.discountNote);
  const totalsBoxWidth = orientation === 'portrait' ? 220 : 250;

  if (hasPriceColumns) {
    const totalsBox = {
      width: totalsBoxWidth,
      table: {
        widths: ['*', 'auto'],
        body: summaryRows,
      },
      layout: {
        fillColor: () => COLORS.termsBoxBg,
        hLineWidth: (i: number, node: { table: { body: unknown[][] } }) =>
          i === 0 || i === node.table.body.length ? 0.8 : 0.45,
        vLineWidth: (i: number, node: { table: { widths: unknown[] } }) =>
          i === 0 || i === node.table.widths.length ? 0.8 : 0,
        hLineColor: () => COLORS.border,
        vLineColor: () => COLORS.border,
        paddingLeft: () => 8,
        paddingRight: () => 8,
        paddingTop: () => 5,
        paddingBottom: () => 5,
      },
    };

    if (discountNote) {
      totalsBlocks.push({
        columns: [
          {
            width: '*',
            table: {
              widths: ['*'],
              body: [
                [
                  {
                    stack: [
                      { text: L.discountNoteTitle, fontSize: 7.3, color: COLORS.secondaryText, bold: true },
                      { text: discountNote, fontSize: 8.3, color: COLORS.primaryText, margin: [0, 4, 0, 0] },
                    ],
                  },
                ],
              ],
            },
            layout: {
              fillColor: () => COLORS.termsBoxBg,
              hLineWidth: (i: number, node: { table: { body: unknown[][] } }) =>
                i === 0 || i === node.table.body.length ? 0.8 : 0.45,
              vLineWidth: (i: number, node: { table: { widths: unknown[] } }) =>
                i === 0 || i === node.table.widths.length ? 0.8 : 0,
              hLineColor: () => COLORS.border,
              vLineColor: () => COLORS.border,
              paddingLeft: () => 8,
              paddingRight: () => 8,
              paddingTop: () => 5,
              paddingBottom: () => 5,
            },
            margin: [0, 0, 12, 0],
          },
          totalsBox,
        ],
        margin: [0, 18, 0, 18],
      });
    } else {
      totalsBlocks.push({
        columns: [
          { width: '*', text: '' },
          totalsBox,
        ],
        margin: [0, 18, 0, 18],
      });
    }
  }

  termsBlocks.push({
      text: L.termsTitle,
      style: 'h2',
      margin: [0, 10, 0, 6],
    });

  termsBlocks.push({
      table: {
        widths: ['*', '*'],
        body: termRows,
      },
      layout: {
        fillColor: () => COLORS.termsBoxBg,
        hLineWidth: (i: number, node: { table: { body: unknown[][] } }) =>
          i === 0 || i === node.table.body.length ? 0.8 : 0.45,
        vLineWidth: (i: number, node: { table: { widths: unknown[] } }) =>
          i === 0 || i === node.table.widths.length ? 0.8 : 0,
        hLineColor: () => COLORS.border,
        vLineColor: () => COLORS.border,
        paddingLeft: () => 6,
        paddingRight: () => 6,
        paddingTop: () => 6,
        paddingBottom: () => 6,
      },
      margin: [0, 0, 0, 10],
    });

  return { totals: totalsBlocks, terms: termsBlocks };
}

function buildSignatureBlock(data: OfferPdfData, L: Labels, lang: PdfLang, orientation: PdfOrientation) {
  const meta = getOfferMeta(data, lang);
  const leftTitle = str(data.salesPerson.signTitle);
  const rightTitle = str(data.approvalUser.signTitle);
  const normalizeName = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();
  const sameSigner =
    !!meta.salesName &&
    !!meta.approvalName &&
    normalizeName(meta.salesName) === normalizeName(meta.approvalName);

  return {
    stack: [
      {
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: innerContentWidth(orientation),
            y2: 0,
            lineWidth: 0.8,
            lineColor: COLORS.sectionLine,
          },
        ],
        margin: [0, 6, 0, 10],
      },
      { text: L.regards, style: 'body', margin: [0, 18, 0, 4] },
      { text: L.companySign, style: 'body', bold: true, margin: [0, 0, 0, 28] },
      sameSigner
        ? {
            stack: [
              { text: meta.salesName || meta.approvalName, style: 'body', bold: true },
              { text: rightTitle || leftTitle, style: 'body', margin: [0, 3, 0, 0] },
            ],
          }
        : {
            columns: [
              {
                width: '50%',
                stack: [
                  { text: meta.salesName , style: 'body', bold: true },
                  { text: leftTitle, style: 'body', margin: [0, 3, 0, 0] },
                ],
              },
              {
                width: '50%',
                stack: [
                  { text: meta.approvalName , style: 'body', bold: true, alignment: 'right' },
                  { text: rightTitle, style: 'body', alignment: 'right', margin: [0, 3, 0, 0] },
                ],
              },
            ],
          },
    ],
  };
}

export async function generateOfferPdf(
  data: OfferPdfData,
  lang: PdfLang,
  orientation: PdfOrientation = 'portrait',
  selectedColumns: PdfProductColumn[] = DEFAULT_PDF_PRODUCT_COLUMNS,
  printSettings: PdfPrintSettings | null = null,
  smallOffer: boolean = false,
  equipmentList: boolean = false,
): Promise<Buffer> {
  ensurePdfmake();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pdfmake = require('pdfmake');

  const trimmedSymbol = (data.currencySymbol ?? '').trim();
  currentCurrencySymbol = trimmedSymbol.length > 0 ? trimmedSymbol : '€';

  const logo = getLogoBase64();
  const L = LABELS[lang];
  let cols = selectedColumns.length > 0 ? selectedColumns : DEFAULT_PDF_PRODUCT_COLUMNS;
  if (equipmentList) {
    cols = cols.filter(c => !PRICE_COLUMNS.has(c));
    if (cols.length === 0) cols = DEFAULT_PDF_PRODUCT_COLUMNS.filter(c => !PRICE_COLUMNS.has(c));
  }

  const itemsTable = buildItemsTable(data, L, orientation, cols, printSettings);
  const totalsAndTerms = buildTotalsAndTerms(data, L, orientation, cols, equipmentList);
  const openingNote = str(data.notesIntroduction)
    ? [
        { text: fixObviousTypos(str(data.notesIntroduction)), style: 'body', margin: [0, 0, 0, 8] },
        {
          canvas: [
            {
              type: 'line',
              x1: 0,
              y1: 0,
              x2: innerContentWidth(orientation),
              y2: 0,
              lineWidth: 0.9,
              lineColor: COLORS.sectionLine,
            },
          ],
          margin: [0, 0, 0, 12],
        },
      ]
    : [];

  const notes: unknown[] = [
    // Divider line for premium separation
    {
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 0,
          x2: innerContentWidth(orientation),
          y2: 0,
          lineWidth: 0.8,
          lineColor: COLORS.border,
        },
      ],
      margin: [0, 6, 0, 12],
    },
    { text: L.notesTitle, style: 'h2', margin: [0, 0, 0, 8] },
    ...(str(data.notesClosing) ? [{ text: fixObviousTypos(str(data.notesClosing)), style: 'body', margin: [0, 0, 0, 6] }] : []),
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docDefinition: any = {
    pageSize: 'A4',
    pageOrientation: orientation,
    pageMargins: PAGE_MARGINS[orientation],

    header: (currentPage: number) => {
      if (smallOffer) {
        if (currentPage <= 1) return null;
        return buildHeaderFull(data, L, lang, orientation, logo);
      }
      if (currentPage === 1) return null;
      return buildHeaderFull(data, L, lang, orientation, logo);
    },

    footer: (currentPage: number, pageCount: number) => ({
      margin: [PAGE_MARGINS[orientation][0], 0, PAGE_MARGINS[orientation][2], 10],
      text: `${L.pageLabel} ${currentPage}/${pageCount}`,
      style: 'foot',
      alignment: 'right',
    }),

    content: [
      ...(smallOffer
        ? buildCompactHeader(data, L, lang, orientation, logo)
        : buildCoverPage(data, L, lang, orientation, logo, equipmentList)),
      ...(smallOffer && str(data.offerDescription)
        ? [
            {
              text: str(data.offerDescription),
              fontSize: 10,
              color: COLORS.secondaryText,
              margin: [0, 0, 0, 8],
            },
          ]
        : []),
      ...openingNote,
      itemsTable,
      ...totalsAndTerms.totals,
      // Keep commercial terms, notes, and signatures together: if they don't
      // fit under the totals on the current page, push the whole group onto
      // the next page rather than splitting it.
      {
        stack: [
          ...totalsAndTerms.terms,
          ...notes,
          buildSignatureBlock(data, L, lang, orientation),
        ],
        unbreakable: true,
      },
    ],

    styles: {
      titleCover: { fontSize: orientation === 'portrait' ? 28 : 32, bold: true, color: COLORS.primaryText },
      h2: { fontSize: 9.8, bold: true, color: COLORS.primaryText },
      metaLabel: { fontSize: 8.8, color: COLORS.secondaryText },
      metaValue: { fontSize: 9.8, color: COLORS.primaryText, bold: true },
      body: { fontSize: 8.3, color: COLORS.primaryText },
      tableHeader: { fontSize: 8.8, bold: true, color: COLORS.primaryText },
      cell: { fontSize: 8.3, color: COLORS.primaryText },
      cellTight: { fontSize: 7.8, color: COLORS.primaryText },
      secondary: { fontSize: 8.8, color: COLORS.secondaryText },
      foot: { fontSize: 7.8, color: COLORS.secondaryText },
    },

    defaultStyle: {
      font: 'Inter',
      fontSize: 9.8,
      color: COLORS.primaryText,
    },
  };

  const doc = pdfmake.createPdf(docDefinition);
  const buffer: Buffer = await doc.getBuffer();
  return buffer;
}
