// Assembles the data needed to fill the TELMACO "Project Handover / Budget" Word
// form (Πληροφορίες Παραγγελίας Πελάτη / ΠΡΟΥΠΟΛΟΓΙΣΜΟΣ ΕΡΓΟΥ) for a single offer.
//
// Returns RAW values (numbers, Dates, strings); the docx fill engine
// (./fillProjectForm) is responsible for formatting and placing them.

import sql from 'mssql';
import { getPool } from '../sql';

// The 9 service "profiles" rendered in the services-budget table (T2). Keyed by a
// stable id; the fill engine maps the doc's Greek/English row labels to these ids.
export const SERVICE_PROFILE_IDS = [
  'projectManager',
  'designer',
  'electricianCabling',
  'installation',
  'commissioning',
  'programming',
  'training',
  'maintenance',
  'other',
] as const;

export type ServiceProfileId = (typeof SERVICE_PROFILE_IDS)[number];

// Maps a service line's PartNumber to a profile via an ORDERED prefix list
// (case-insensitive, first match wins). Order matters: more specific prefixes
// (InstallWir-, SoftInstall-) must precede the generic Install-/Instal- rules.
// Anything unmatched (or with no part number) falls back to "other".
//
// Derived from the service catalogue (e.g. ProjectMgt-Lot, Design-Lot, Comm-Day…).
// Judgment calls — adjust here if the business mapping differs:
//   SoftInstall- → programming (not installation); SiteMgt- → projectManager;
//   OnAir- → commissioning; SiteSrv-/Handover- → other.
const PROFILE_PREFIX_RULES: ReadonlyArray<{ prefix: string; profile: ServiceProfileId }> = [
  { prefix: 'ProjectMgt-', profile: 'projectManager' },
  { prefix: 'SiteMgt-', profile: 'projectManager' },
  { prefix: 'CAD-', profile: 'designer' },
  { prefix: 'DesignPer-', profile: 'designer' },
  { prefix: 'Design-', profile: 'designer' },
  { prefix: 'WorkFlow-', profile: 'designer' },
  { prefix: 'InstallWir-', profile: 'electricianCabling' },
  { prefix: 'SoftInstall-', profile: 'programming' },
  { prefix: 'Install-', profile: 'installation' },
  { prefix: 'Instal-', profile: 'installation' },
  { prefix: 'Comm-', profile: 'commissioning' },
  { prefix: 'FAT-', profile: 'commissioning' },
  { prefix: 'OnAir-', profile: 'commissioning' },
  { prefix: 'Programm-', profile: 'programming' },
  { prefix: 'Train-', profile: 'training' },
  { prefix: 'Maint-', profile: 'maintenance' },
];

export const resolveServiceProfile = (partNumber: string | null | undefined): ServiceProfileId => {
  const pn = (partNumber ?? '').trim().toLowerCase();
  if (!pn) return 'other';
  for (const rule of PROFILE_PREFIX_RULES) {
    if (pn.startsWith(rule.prefix.toLowerCase())) return rule.profile;
  }
  return 'other';
};

export interface ServiceProfileTotals {
  qty: number;
  cost: number;
}

export interface ProjectFormData {
  erpProjectCode: string | null;
  description: string | null;
  customerName: string | null;
  salesPersonName: string | null; // full name — used for the required-field check
  salesPersonCode: string | null; // AspNetUsers.NameCode — shown as "Αρμόδιος Πωλητής"
  contactName: string | null;
  orderSignedDate: Date | null;
  deliveryDueDate: Date | null;
  totals: {
    totalNet: number; // overall net price (after offer-level extra discount)
    productsNet: number; // product lines only
    servicesNet: number; // service lines only
    totalCost: number; // overall cost price
    productsCost: number; // product lines cost only
    servicesCost: number; // service lines cost only
    marginPct: number | null; // 1 − ΣCost/ΣNet, as a percentage
  };
  services: {
    profiles: Record<ServiceProfileId, ServiceProfileTotals>;
    totalQty: number;
    totalCost: number;
  };
}

// Basic-data fields that must be present before the project form can be generated
// (mirrors how Create Draft Order requires Order Signed). Labels match the Basic
// Data form so the user knows exactly what to fill in.
export interface MissingField {
  label: string; // shown to the user
  fieldId: string; // OfferBasicDataClient field def id, used to highlight the control
}

// `key` is the resolved value on ProjectFormData; `fieldId` is the Basic Data form
// control id used to highlight the field (same scheme Create Draft Order uses for
// the Order Signed field).
export const REQUIRED_BASIC_DATA_FIELDS: ReadonlyArray<{
  key: 'erpProjectCode' | 'description' | 'customerName' | 'salesPersonName' | 'contactName' | 'orderSignedDate' | 'deliveryDueDate';
  label: string;
  fieldId: string;
}> = [
  { key: 'erpProjectCode', label: 'ERP Project Code', fieldId: 'erpProjectCode' },
  { key: 'description', label: 'Description', fieldId: 'description' },
  { key: 'customerName', label: 'Customer', fieldId: 'customer' },
  { key: 'salesPersonName', label: 'Sales Person', fieldId: 'salesPersonId' },
  { key: 'contactName', label: 'Contact', fieldId: 'contactId' },
  { key: 'orderSignedDate', label: 'Order Signed date', fieldId: 'orderSigned' },
  { key: 'deliveryDueDate', label: 'Delivery Due date', fieldId: 'deliveryDue' },
];

export function getMissingRequiredFields(data: ProjectFormData): MissingField[] {
  return REQUIRED_BASIC_DATA_FIELDS.filter(({ key }) => {
    const value = data[key];
    return value == null || (typeof value === 'string' && value.trim() === '');
  }).map(({ label, fieldId }) => ({ label, fieldId }));
}

// SQL Server DECIMAL columns can surface as number or string depending on driver.
const num = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const cleanString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

const toDate = (value: unknown): Date | null => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Offer-level additional discount, replicated from pdfGenerator.applyExtraDiscount
// so the budget figures match the offer's PDF export exactly.
const applyExtraDiscount = (
  base: number,
  value: number | null,
  mode: 'pct' | 'abs' | null,
): number => {
  if (value == null || !Number.isFinite(value) || value === 0) return base;
  const reduction = mode === 'abs' ? value : base * (value / 100);
  const next = base - reduction;
  return Number.isFinite(next) ? next : base;
};

// Keep in sync with TOTALS_ROW_PREDICATE in
// src/app/api/offers/[offerId]/products/route.ts — the canonical set of rows that
// count toward an offer's totals (priced products + comments, excluding options).
const TOTALS_ROW_PREDICATE =
  '(od.ProductID IS NOT NULL OR ISNULL(od.IsComment, 0) = 1) AND ISNULL(od.IsOption, 0) = 0';

export async function getProjectFormData(offerId: number): Promise<ProjectFormData> {
  const pool = await getPool();

  // ── Offer header + joins (customer / salesperson / contact) ───────────────
  const headerResult = await pool
    .request()
    .input('offerId', sql.Int, offerId)
    .query<{
      ERPProjectCode: string | null;
      Description: string | null;
      OrderSignedDate: Date | string | null;
      DeliveryDueDate: Date | string | null;
      CustomerName: string | null;
      SalesPersonName: string | null;
      SalesPersonNameCode: string | null;
      ContactName: string | null;
      ExtraNetDiscount: number | null;
      ExtraNetDiscountMode: string | null;
    }>(`
      SELECT
        o.ERPProjectCode,
        o.Description,
        o.OrderSignedDate,
        o.DeliveryDueDate,
        c.Name AS CustomerName,
        -- Prefer the Greek full name (this form is in Greek), fall back to English.
        COALESCE(NULLIF(LTRIM(RTRIM(sales.FullNameGR)), ''), sales.FullName) AS SalesPersonName,
        sales.NameCode AS SalesPersonNameCode,
        LTRIM(RTRIM(CONCAT(
          ISNULL(t.Name, ''), ' ',
          ISNULL(ct.FirstName, ''), ' ',
          ISNULL(ct.LastName, '')
        ))) AS ContactName,
        o.ExtraNetDiscount,
        o.ExtraNetDiscountMode
      FROM dbo.[Offer] o
      LEFT JOIN dbo.Customers   c     ON o.CustomerID   = c.ID
      LEFT JOIN dbo.AspNetUsers sales ON o.SalesPersonId = sales.Id
      LEFT JOIN dbo.Contacts    ct    ON o.ContactID    = ct.ID
      LEFT JOIN dbo.Titles      t     ON ct.TitleID     = t.ID
      WHERE o.ID = @offerId;
    `);

  const header = headerResult.recordset?.[0] ?? null;

  // ── Canonical totals (products / services split + cost) ───────────────────
  const totalsResult = await pool
    .request()
    .input('offerId', sql.Int, offerId)
    .query<{
      totalNet: number | null;
      productsNet: number | null;
      servicesNet: number | null;
      totalCost: number | null;
      productsCost: number | null;
      servicesCost: number | null;
    }>(`
      SELECT
        SUM(CASE WHEN ${TOTALS_ROW_PREDICATE} THEN COALESCE(od.TotalNet, 0) ELSE 0 END) AS totalNet,
        SUM(CASE WHEN ${TOTALS_ROW_PREDICATE} AND ISNULL(od.IsService, 0) = 0 THEN COALESCE(od.TotalNet, 0) ELSE 0 END) AS productsNet,
        SUM(CASE WHEN ${TOTALS_ROW_PREDICATE} AND ISNULL(od.IsService, 0) = 1 THEN COALESCE(od.TotalNet, 0) ELSE 0 END) AS servicesNet,
        SUM(CASE WHEN ${TOTALS_ROW_PREDICATE} THEN COALESCE(od.TotalCost, 0) ELSE 0 END) AS totalCost,
        SUM(CASE WHEN ${TOTALS_ROW_PREDICATE} AND ISNULL(od.IsService, 0) = 0 THEN COALESCE(od.TotalCost, 0) ELSE 0 END) AS productsCost,
        SUM(CASE WHEN ${TOTALS_ROW_PREDICATE} AND ISNULL(od.IsService, 0) = 1 THEN COALESCE(od.TotalCost, 0) ELSE 0 END) AS servicesCost
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @offerId;
    `);

  const totalsRow = totalsResult.recordset?.[0] ?? null;

  // ── Service lines for the man-day budget table (grouped by profile) ───────
  const servicesResult = await pool
    .request()
    .input('offerId', sql.Int, offerId)
    .query<{ PartNumber: string | null; Quantity: number | null; TotalCost: number | null }>(`
      SELECT
        od.PartNumber,
        COALESCE(od.Quantity, 0)  AS Quantity,
        COALESCE(od.TotalCost, 0) AS TotalCost
      FROM dbo.OfferDetails od
      WHERE od.OfferID = @offerId
        AND ISNULL(od.IsService, 0) = 1
        AND ISNULL(od.IsOption, 0) = 0;
    `);

  // Net totals before the offer-level extra discount.
  const netBeforeExtra = num(totalsRow?.totalNet);
  const productsBefore = num(totalsRow?.productsNet);
  const servicesBefore = num(totalsRow?.servicesNet);
  // Cost prices are the actual costs — the offer-level extra discount only reduces
  // the selling (net) price, never cost, so these are used as summed (no factor).
  const totalCost = num(totalsRow?.totalCost);
  const productsCost = num(totalsRow?.productsCost);
  const servicesCost = num(totalsRow?.servicesCost);

  const extraValue = header?.ExtraNetDiscount == null ? null : num(header.ExtraNetDiscount);
  const extraMode: 'pct' | 'abs' = header?.ExtraNetDiscountMode === 'abs' ? 'abs' : 'pct';

  const totalNet = applyExtraDiscount(netBeforeExtra, extraValue, extraMode);
  // Spread the offer-level discount proportionally so products + services still
  // sum to the discounted total.
  const factor = netBeforeExtra !== 0 ? totalNet / netBeforeExtra : 1;
  const productsNet = productsBefore * factor;
  const servicesNet = servicesBefore * factor;
  const marginPct = totalNet !== 0 ? (1 - totalCost / totalNet) * 100 : null;

  // Group service lines into the 9 profiles.
  const profiles = Object.fromEntries(
    SERVICE_PROFILE_IDS.map((id) => [id, { qty: 0, cost: 0 }]),
  ) as Record<ServiceProfileId, ServiceProfileTotals>;
  let servicesTotalQty = 0;
  let servicesTotalCost = 0;
  for (const line of servicesResult.recordset ?? []) {
    const profile = resolveServiceProfile(line.PartNumber);
    const qty = num(line.Quantity);
    const cost = num(line.TotalCost);
    profiles[profile].qty += qty;
    profiles[profile].cost += cost;
    servicesTotalQty += qty;
    servicesTotalCost += cost;
  }

  return {
    erpProjectCode: cleanString(header?.ERPProjectCode),
    description: cleanString(header?.Description),
    customerName: cleanString(header?.CustomerName),
    salesPersonName: cleanString(header?.SalesPersonName),
    salesPersonCode: cleanString(header?.SalesPersonNameCode),
    contactName: cleanString(header?.ContactName),
    orderSignedDate: toDate(header?.OrderSignedDate),
    deliveryDueDate: toDate(header?.DeliveryDueDate),
    totals: { totalNet, productsNet, servicesNet, totalCost, productsCost, servicesCost, marginPct },
    services: { profiles, totalQty: servicesTotalQty, totalCost: servicesTotalCost },
  };
}
