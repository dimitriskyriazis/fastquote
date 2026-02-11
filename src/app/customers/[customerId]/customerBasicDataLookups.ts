import { getPool } from '../../../lib/sql';
import { toDropdownOptions, type RawDropdownRow } from '../../../lib/dropdownOptions';
import type { CustomerDropdownOption, CustomerCityOption } from './CustomerBasicDataTypes';

type LookupRow = RawDropdownRow & { ID: number | string | null; Name: string | null };
type CityRow = { ID: number | null; Name: string | null; CountryID: number | null };

const mapLookupRows = (rows: LookupRow[] | undefined | null): CustomerDropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

export const IMPORTANCE_VALUES = ['', '1', '2', '3'];
export const IMPORTANCE_OPTIONS: CustomerDropdownOption[] = IMPORTANCE_VALUES.map((value) => ({
  value,
  label: value === '' ? 'Empty' : value,
}));

export async function fetchCustomerGroups() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.CustomerGroups
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load customer groups', err);
    return [];
  }
}

export async function fetchCustomers() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Customers
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load customers', err);
    return [];
  }
}

export async function fetchPricingPolicies() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.PricingPolicies
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load pricing policies', err);
    return [];
  }
}

export async function fetchCountries() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Countries
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load countries', err);
    return [];
  }
}

export async function fetchCities(): Promise<CustomerCityOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<CityRow>(`
      SELECT ID, Name, CountryID
      FROM dbo.Cities
      ORDER BY Name
    `);
    return (result.recordset ?? [])
      .filter((row) => row.ID != null)
      .map(
        (row) =>
          ({
            value: String(row.ID),
            label: row.Name?.trim() || `City ${row.ID}`,
            countryId: row.CountryID ?? null,
          }) satisfies CustomerCityOption,
      );
  } catch (err) {
    console.error('Failed to load cities', err);
    return [];
  }
}

export async function fetchImportanceOptions(): Promise<CustomerDropdownOption[]> {
  return IMPORTANCE_OPTIONS;
}
