import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import sql from 'mssql';
import { getPool } from '../../../../lib/sql';
import { requirePermission } from '../../../../lib/authz';
import { toDropdownOptions, type DropdownOption, type RawDropdownRow } from '../../../../lib/dropdownOptions';
import { collateSearch } from '../../../../lib/textSearch';

type LookupRow = RawDropdownRow & { ID: number; Name: string | null };
type MarketLookupRow = LookupRow & { SalesDivisionID?: number | null };
type UserLookupRow = LookupRow & { SalesSeniorityName?: string | null };
// Customers.PricingPolicyID is nvarchar(100) NOT NULL, not an int FK: the overwhelming
// majority of rows hold '' (no policy), and the rest hold the ID as text.
type CustomerLookupRow = LookupRow & {
  PricingPolicyID?: number | string | null;
  PaymentTermID?: number | null;
};
type PaymentTermLookupRow = LookupRow & { DescriptionGR?: string | null; DescriptionEN?: string | null };
type PricingPolicyLookupRow = LookupRow & {
  Enabled?: boolean | number | null;
  HasRules?: boolean | number | null;
};

// The Create Offer form defaults its pricing policy from the selected customer, so every
// customer option carries that customer's own PricingPolicyID, and every pricing-policy
// option carries the two flags POST /api/offers/create validates (enabled + has rules) so
// the client never auto-selects a policy the create call would reject.
// paymentTermId rides along for the same reason as pricingPolicyId: the Create
// Offer form defaults the offer's term from the selected customer.
type CustomerOption = DropdownOption & { pricingPolicyId: string; paymentTermId: string };
// Both descriptions travel with the option so the form can show the printed
// text in the offer's language without another round trip.
type PaymentTermOption = DropdownOption & { descriptionGr: string; descriptionEn: string };
type PricingPolicyOption = DropdownOption & { enabled: boolean; hasRules: boolean };

type LookupKey =
  | 'customers'
  | 'statuses'
  | 'pricingPolicies'
  | 'markets'
  | 'salesDivisions'
  | 'users'
  | 'fwcProjects'
  | 'currencies'
  | 'paymentTerms';

type OfferLookupPayload = {
  customers?: CustomerOption[];
  statuses?: DropdownOption[];
  pricingPolicies?: PricingPolicyOption[];
  markets?: Array<DropdownOption & { salesDivisionId: string }>;
  salesDivisions?: DropdownOption[];
  users?: Array<DropdownOption & { salesSeniorityName?: string | null }>;
  fwcProjects?: DropdownOption[];
  currencies?: DropdownOption[];
  paymentTerms?: PaymentTermOption[];
};

const LOOKUP_KEYS: LookupKey[] = [
  'customers',
  'statuses',
  'pricingPolicies',
  'markets',
  'salesDivisions',
  'users',
  'fwcProjects',
  'currencies',
  'paymentTerms',
];

const toLookupOptions = (rows: LookupRow[] | undefined | null): DropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

const toFlag = (value: boolean | number | null | undefined): boolean =>
  value === true || value === 1;

const normalizeLabel = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const parseRequestedKeys = (req: NextRequest): LookupKey[] => {
  const keyParams = req.nextUrl.searchParams.getAll('keys');
  const raw = keyParams
    .flatMap((segment) => segment.split(','))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (raw.length === 0) return LOOKUP_KEYS;

  const requested = new Set<LookupKey>();
  raw.forEach((candidate) => {
    if ((LOOKUP_KEYS as string[]).includes(candidate)) {
      requested.add(candidate as LookupKey);
    }
  });

  return requested.size > 0 ? Array.from(requested) : LOOKUP_KEYS;
};

const toCustomerOptions = (rows: CustomerLookupRow[] | undefined | null): CustomerOption[] =>
  (rows ?? [])
    .filter((row): row is CustomerLookupRow & { ID: number } => row?.ID != null)
    .map((row) => {
      const stringId = String(row.ID);
      return {
        value: stringId,
        label: normalizeLabel(row.Name) ?? `Option ${stringId}`,
        pricingPolicyId: row.PricingPolicyID != null ? String(row.PricingPolicyID).trim() : '',
        paymentTermId: row.PaymentTermID != null ? String(row.PaymentTermID) : '',
      };
    });

const toPaymentTermOptions = (rows: PaymentTermLookupRow[] | undefined | null): PaymentTermOption[] =>
  (rows ?? [])
    .filter((row): row is PaymentTermLookupRow & { ID: number } => row?.ID != null)
    .map((row) => {
      const stringId = String(row.ID);
      return {
        value: stringId,
        label: normalizeLabel(row.Name) ?? `Option ${stringId}`,
        descriptionGr: (row.DescriptionGR ?? '').trim(),
        descriptionEn: (row.DescriptionEN ?? '').trim(),
      };
    });

const toPricingPolicyOptions = (
  rows: PricingPolicyLookupRow[] | undefined | null,
): PricingPolicyOption[] =>
  (rows ?? [])
    .filter((row): row is PricingPolicyLookupRow & { ID: number } => row?.ID != null)
    .map((row) => {
      const stringId = String(row.ID);
      return {
        value: stringId,
        label: normalizeLabel(row.Name) ?? `Option ${stringId}`,
        enabled: toFlag(row.Enabled),
        hasRules: toFlag(row.HasRules),
      };
    });

async function fetchCustomers(search?: string) {
  const pool = await getPool();
  const needle = (search ?? '').trim();
  if (needle.length > 0) {
    const req = pool.request();
    req.input('customerSearch', sql.NVarChar(200), `%${needle}%`);
    const result = await req.query<CustomerLookupRow>(`
      SELECT TOP 50 ID, Name, PricingPolicyID, PaymentTermID
      FROM dbo.Customers
      WHERE ${collateSearch('Name')} LIKE @customerSearch
        AND ISNULL(IsParent, 0) = 0
        AND ISNULL(Enabled, 0) = 1
      ORDER BY Name
    `);
    return toCustomerOptions(result.recordset);
  }
  const result = await pool.request().query<CustomerLookupRow>(`
    SELECT ID, Name, PricingPolicyID, PaymentTermID
    FROM dbo.Customers
    WHERE ISNULL(IsParent, 0) = 0
      AND ISNULL(Enabled, 0) = 1
    ORDER BY Name
  `);
  return toCustomerOptions(result.recordset);
}

async function fetchStatuses() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.OfferStatus
    ORDER BY Sorting, Name
  `);
  return toLookupOptions(result.recordset);
}

async function fetchPricingPolicies() {
  const pool = await getPool();
  const result = await pool.request().query<PricingPolicyLookupRow>(`
    SELECT
      pp.ID,
      pp.Name,
      CAST(CASE WHEN ISNULL(pp.Enabled, 0) = 1 THEN 1 ELSE 0 END AS BIT) AS Enabled,
      CAST(CASE WHEN EXISTS (
        SELECT 1 FROM dbo.PricingPolicyRules ppr WHERE ppr.PricingPolicyID = pp.ID
      ) THEN 1 ELSE 0 END AS BIT) AS HasRules
    FROM dbo.PricingPolicies pp
    ORDER BY pp.Name
  `);
  return toPricingPolicyOptions(result.recordset);
}

async function fetchPaymentTerms() {
  const pool = await getPool();
  const result = await pool.request().query<PaymentTermLookupRow>(`
    SELECT ID, Name, DescriptionGR, DescriptionEN
    FROM dbo.PaymentTerms
    WHERE ISNULL(Enabled, 0) = 1
    ORDER BY ID
  `);
  return toPaymentTermOptions(result.recordset);
}

async function fetchMarkets() {
  const pool = await getPool();
  const result = await pool.request().query<MarketLookupRow>(`
    SELECT ID, Name, SalesDivisionID
    FROM dbo.Markets
    ORDER BY Name
  `);
  return (result.recordset ?? [])
    .filter((row): row is MarketLookupRow & { ID: number } => row?.ID != null)
    .map((row) => ({
      value: String(row.ID),
      label: normalizeLabel(row.Name) ?? `Option ${String(row.ID)}`,
      salesDivisionId: row.SalesDivisionID != null ? String(row.SalesDivisionID) : '',
    }));
}

async function fetchSalesDivisions() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.SalesDivision
    ORDER BY Name
  `);
  return toLookupOptions(result.recordset);
}

async function fetchUsers() {
  const pool = await getPool();
  const result = await pool.request().query<UserLookupRow>(`
    SELECT
      u.Id AS ID,
      COALESCE(NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserName) AS Name,
      ss.Name AS SalesSeniorityName
    FROM dbo.AspNetUsers u
    LEFT JOIN dbo.SalesSeniorities ss ON ss.ID = u.SalesSeniorityID
    ORDER BY COALESCE(NULLIF(LTRIM(RTRIM(u.FullName)), ''), u.UserName)
  `);
  return (result.recordset ?? [])
    .filter((row): row is UserLookupRow & { ID: number } => row?.ID != null)
    .map((row) => ({
      value: String(row.ID),
      label: normalizeLabel(row.Name) ?? `Option ${String(row.ID)}`,
      salesSeniorityName: normalizeLabel(row.SalesSeniorityName),
    }));
}

async function fetchFwcProjects() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, ShortName AS Name
    FROM dbo.FWCs
    ORDER BY ShortName, ID
  `);
  return toLookupOptions(result.recordset);
}

async function fetchCurrencies() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Currencies
    ORDER BY
      CASE
        WHEN Name = N'€' THEN 0
        WHEN LOWER(Name) LIKE '%eur%' THEN 1
        ELSE 2
      END,
      Name
  `);
  return toLookupOptions(result.recordset);
}

export async function GET(req: NextRequest) {
  logRequest(req, '/api/offers/lookups');
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const keys = parseRequestedKeys(req);
    const customerSearch = req.nextUrl.searchParams.get('customerSearch') ?? undefined;
    const payload: OfferLookupPayload = {};

    await Promise.all(
      keys.map(async (key) => {
        if (key === 'customers') {
          payload.customers = await fetchCustomers(customerSearch);
          return;
        }
        if (key === 'statuses') {
          payload.statuses = await fetchStatuses();
          return;
        }
        if (key === 'pricingPolicies') {
          payload.pricingPolicies = await fetchPricingPolicies();
          return;
        }
        if (key === 'paymentTerms') {
          payload.paymentTerms = await fetchPaymentTerms();
          return;
        }
        if (key === 'markets') {
          payload.markets = await fetchMarkets();
          return;
        }
        if (key === 'salesDivisions') {
          payload.salesDivisions = await fetchSalesDivisions();
          return;
        }
        if (key === 'users') {
          payload.users = await fetchUsers();
          return;
        }
        if (key === 'fwcProjects') {
          payload.fwcProjects = await fetchFwcProjects();
          return;
        }
        payload.currencies = await fetchCurrencies();
      }),
    );

    return NextResponse.json({ ok: true, lookups: payload });
  } catch (err) {
    console.error('Failed to load offer lookups', err);
    const message = err instanceof Error ? err.message : 'Unable to load offer lookups.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
