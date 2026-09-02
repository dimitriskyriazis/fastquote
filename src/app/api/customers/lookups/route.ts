import { NextRequest, NextResponse } from 'next/server';
import { logRequest } from '../../../../lib/apiHelpers';
import { getPool } from '../../../../lib/sql';
import { requirePermission } from '../../../../lib/authz';
import { toDropdownOptions, type DropdownOption, type RawDropdownRow } from '../../../../lib/dropdownOptions';

type LookupRow = RawDropdownRow & { ID: number | string | null; Name: string | null };
type LookupKey =
  | 'customerGroups'
  | 'parentCustomers'
  | 'pricingPolicies'
  | 'importanceOptions'
  | 'countries'
  | 'paymentTerms';

type CustomerLookupsPayload = {
  customerGroups?: DropdownOption[];
  parentCustomers?: DropdownOption[];
  pricingPolicies?: DropdownOption[];
  importanceOptions?: DropdownOption[];
  countries?: DropdownOption[];
  paymentTerms?: DropdownOption[];
};

const LOOKUP_KEYS: LookupKey[] = [
  'customerGroups',
  'parentCustomers',
  'pricingPolicies',
  'importanceOptions',
  'countries',
  'paymentTerms',
];

const IMPORTANCE_VALUES = ['', 'High', 'Med', 'Low'];
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

// Only enabled customers flagged as parents can be picked as a Parent Customer.
// Legacy rows may still point at a non-parent or a disabled one; the basic-data
// panel keeps showing that name from the record (ParentCustomerName), so
// filtering here loses nothing.
async function fetchParentCustomers() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.Customers
    WHERE ISNULL(IsParent, 0) = 1
      AND ISNULL(Enabled, 0) = 1
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

// Ordered by ID, not by Name: the seeded ids encode the intended business order
// (30/60/75/90/120 DAYS, then deposits, then CONTRACT/CASH/LC/OTHER), whereas
// ORDER BY Name lists '120 DAYS' before '30 DAYS'.
async function fetchPaymentTerms() {
  const pool = await getPool();
  const result = await pool.request().query<LookupRow>(`
    SELECT ID, Name
    FROM dbo.PaymentTerms
    WHERE Enabled = 1
    ORDER BY ID
  `);
  return mapLookupRows(result.recordset);
}

export async function GET(req: NextRequest) {
  logRequest(req, '/api/customers/lookups');
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
        if (key === 'paymentTerms') {
          payload.paymentTerms = await fetchPaymentTerms();
        }
      }),
    );

    return NextResponse.json({ ok: true, lookups: payload });
  } catch (err) {
    console.error('Failed to load customer lookups', err);
    const message = err instanceof Error ? err.message : 'Unable to load customer lookups.';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
