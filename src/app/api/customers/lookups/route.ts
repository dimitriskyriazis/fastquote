import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/sql';
import { requirePermission } from '../../../../lib/authz';
import { toDropdownOptions, type DropdownOption, type RawDropdownRow } from '../../../../lib/dropdownOptions';

type LookupRow = RawDropdownRow & { ID: number | string | null; Name: string | null };
type CityRow = { ID: number | null; Name: string | null; CountryID: number | null };
type LookupKey =
  | 'customerGroups'
  | 'parentCustomers'
  | 'pricingPolicies'
  | 'importanceOptions'
  | 'countries'
  | 'cities';

type CustomerLookupsPayload = {
  customerGroups?: DropdownOption[];
  parentCustomers?: DropdownOption[];
  pricingPolicies?: DropdownOption[];
  importanceOptions?: DropdownOption[];
  countries?: DropdownOption[];
  cities?: Array<DropdownOption & { countryId: number | null }>;
};

const LOOKUP_KEYS: LookupKey[] = [
  'customerGroups',
  'parentCustomers',
  'pricingPolicies',
  'importanceOptions',
  'countries',
  'cities',
];

const IMPORTANCE_VALUES = ['', '1', '2', '3'];
const IMPORTANCE_OPTIONS: DropdownOption[] = IMPORTANCE_VALUES.map((value) => ({
  value,
  label: value === '' ? 'Empty' : value,
}));

const mapLookupRows = (rows: LookupRow[] | undefined | null): DropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

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

async function fetchCustomerGroups() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.CustomerGroups
    ORDER BY Name
  `);
  return mapLookupRows(result.recordset);
}

async function fetchParentCustomers() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Customers
    ORDER BY Name
  `);
  return mapLookupRows(result.recordset);
}

async function fetchPricingPolicies() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.PricingPolicies
    ORDER BY Name
  `);
  return mapLookupRows(result.recordset);
}

async function fetchCountries() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Countries
    ORDER BY Name
  `);
  return mapLookupRows(result.recordset);
}

async function fetchCities() {
  const pool = await getPool();
  const result = await pool.request().query<CityRow>(`
    SELECT ID, Name, CountryID
    FROM dbo.Cities
    ORDER BY Name
  `);
  return (result.recordset ?? [])
    .filter((row) => row.ID != null)
    .map((row) => ({
      value: String(row.ID),
      label: row.Name?.trim() || `City ${String(row.ID)}`,
      countryId: row.CountryID ?? null,
    }));
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePermission(req, 'manageCustomersContacts');
    if (!auth.ok) return auth.response;

    const keys = parseRequestedKeys(req);
    const payload: CustomerLookupsPayload = {};

    await Promise.all(
      keys.map(async (key) => {
        if (key === 'customerGroups') {
          payload.customerGroups = await fetchCustomerGroups();
          return;
        }
        if (key === 'parentCustomers') {
          payload.parentCustomers = await fetchParentCustomers();
          return;
        }
        if (key === 'pricingPolicies') {
          payload.pricingPolicies = await fetchPricingPolicies();
          return;
        }
        if (key === 'importanceOptions') {
          payload.importanceOptions = IMPORTANCE_OPTIONS;
          return;
        }
        if (key === 'countries') {
          payload.countries = await fetchCountries();
          return;
        }
        payload.cities = await fetchCities();
      }),
    );

    return NextResponse.json({ ok: true, lookups: payload });
  } catch (err) {
    console.error('Failed to load customer lookups', err);
    const message = err instanceof Error ? err.message : 'Unable to load customer lookups.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
