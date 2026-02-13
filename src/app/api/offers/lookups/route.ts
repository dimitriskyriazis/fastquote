import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/sql';
import { requirePermission } from '../../../../lib/authz';
import { toDropdownOptions, type DropdownOption, type RawDropdownRow } from '../../../../lib/dropdownOptions';

type LookupRow = RawDropdownRow & { ID: number; Name: string | null };
type MarketLookupRow = LookupRow & { SalesDivisionID?: number | null };
type UserLookupRow = LookupRow & { SalesSeniorityName?: string | null };

type LookupKey =
  | 'customers'
  | 'statuses'
  | 'pricingPolicies'
  | 'markets'
  | 'salesDivisions'
  | 'users'
  | 'fwcProjects';

type OfferLookupPayload = {
  customers?: DropdownOption[];
  statuses?: DropdownOption[];
  pricingPolicies?: DropdownOption[];
  markets?: Array<DropdownOption & { salesDivisionId: string }>;
  salesDivisions?: DropdownOption[];
  users?: Array<DropdownOption & { salesSeniorityName?: string | null }>;
  fwcProjects?: DropdownOption[];
};

const LOOKUP_KEYS: LookupKey[] = [
  'customers',
  'statuses',
  'pricingPolicies',
  'markets',
  'salesDivisions',
  'users',
  'fwcProjects',
];

const toLookupOptions = (rows: LookupRow[] | undefined | null): DropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

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

async function fetchCustomers() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Customers
    WHERE ISNULL(IsParent, 0) = 0
    ORDER BY Name
  `);
  return toLookupOptions(result.recordset);
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
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.PricingPolicies
    ORDER BY Name
  `);
  return toLookupOptions(result.recordset);
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

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePermission(req, 'editOffers');
    if (!auth.ok) return auth.response;

    const keys = parseRequestedKeys(req);
    const payload: OfferLookupPayload = {};

    await Promise.all(
      keys.map(async (key) => {
        if (key === 'customers') {
          payload.customers = await fetchCustomers();
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
        payload.fwcProjects = await fetchFwcProjects();
      }),
    );

    return NextResponse.json({ ok: true, lookups: payload });
  } catch (err) {
    console.error('Failed to load offer lookups', err);
    const message = err instanceof Error ? err.message : 'Unable to load offer lookups.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
