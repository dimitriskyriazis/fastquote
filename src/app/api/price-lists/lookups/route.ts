import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/sql';
import { requirePermission } from '../../../../lib/authz';
import { toDropdownOptions, type DropdownOption, type RawDropdownRow } from '../../../../lib/dropdownOptions';

type LookupRow = RawDropdownRow & { ID: number | null; Name: string | null };
type UserLookupRow = LookupRow & { UserName?: string | null };
type LookupKey = 'brands' | 'countries' | 'cities' | 'suppliers' | 'currencies' | 'users';

type PriceListLookupsPayload = {
  brands?: DropdownOption[];
  countries?: DropdownOption[];
  cities?: DropdownOption[];
  suppliers?: DropdownOption[];
  currencies?: DropdownOption[];
  users?: DropdownOption[];
};

const LOOKUP_KEYS: LookupKey[] = ['brands', 'countries', 'cities', 'suppliers', 'currencies', 'users'];

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

async function fetchBrands() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Brands
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
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Cities
    ORDER BY Name
  `);
  return mapLookupRows(result.recordset);
}

async function fetchSuppliers() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Suppliers
    ORDER BY Name
  `);
  return mapLookupRows(result.recordset);
}

async function fetchCurrencies() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Currencies
    ORDER BY Name
  `);
  return mapLookupRows(result.recordset);
}

async function fetchUsers() {
  const pool = await getPool();
  const result = await pool.request().query<UserLookupRow>(`
    SELECT
      Id AS ID,
      COALESCE(NULLIF(LTRIM(RTRIM(FullName)), ''), UserName) AS Name
    FROM dbo.AspNetUsers
    ORDER BY COALESCE(NULLIF(LTRIM(RTRIM(FullName)), ''), UserName)
  `);
  return mapLookupRows(result.recordset);
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requirePermission(req, 'managePriceLists');
    if (!auth.ok) return auth.response;

    const keys = parseRequestedKeys(req);
    const payload: PriceListLookupsPayload = {};

    await Promise.all(
      keys.map(async (key) => {
        if (key === 'brands') {
          payload.brands = await fetchBrands();
          return;
        }
        if (key === 'countries') {
          payload.countries = await fetchCountries();
          return;
        }
        if (key === 'cities') {
          payload.cities = await fetchCities();
          return;
        }
        if (key === 'suppliers') {
          payload.suppliers = await fetchSuppliers();
          return;
        }
        if (key === 'currencies') {
          payload.currencies = await fetchCurrencies();
          return;
        }
        payload.users = await fetchUsers();
      }),
    );

    return NextResponse.json({ ok: true, lookups: payload });
  } catch (err) {
    console.error('Failed to load price list lookups', err);
    const message = err instanceof Error ? err.message : 'Unable to load price list lookups.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
