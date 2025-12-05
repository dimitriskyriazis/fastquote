import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { toDropdownOptions, type RawDropdownRow } from '../../../lib/dropdownOptions';
import CustomerBasicDataClient from './CustomerBasicDataClient';
import styles from './CustomerBasicDataPanel.module.css';
import type { CustomerBasicRecord, CustomerDropdownOption, CustomerCityOption } from './CustomerBasicDataTypes';

type Props = {
  customerId: string;
  initialRecord?: CustomerBasicRecord | null;
};

type LookupRow = RawDropdownRow & { ID: number | string | null; Name: string | null };
type CityRow = { ID: number | null; Name: string | null; CountryID: number | null };

const mapLookupRows = (rows: LookupRow[] | undefined | null): CustomerDropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

export async function fetchCustomerBasicRecord(customerId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('customerId', sql.Int, customerId);
    const result = await request.query<CustomerBasicRecord>(`
      SELECT TOP 1
        c.ID AS CustomerID,
        c.Name,
        c.BrandName,
        c.TaxID,
        c.TaxOffice,
        c.Profession,
        c.CustomerGroupID,
        cg.Name AS CustomerGroupName,
        c.ActivityCode,
        c.ERPID,
        c.IsParent,
        c.ParentCustomerID,
        parent.Name AS ParentCustomerName,
        c.PricingPolicyID,
        pp.Name AS PricingPolicyName,
        c.Importance,
        c.Enabled,
        c.Address,
        c.CountryID,
        country.Name AS CountryName,
        c.CityID,
        city.Name AS CityName,
        c.Phone,
        c.Email,
        c.WebSite,
        c.Notes
      FROM dbo.Customers AS c
      LEFT JOIN dbo.CustomerGroups AS cg ON c.CustomerGroupID = cg.ID
      LEFT JOIN dbo.Customers AS parent ON c.ParentCustomerID = parent.ID
      LEFT JOIN dbo.Countries AS country ON c.CountryID = country.ID
      LEFT JOIN dbo.Cities AS city ON c.CityID = city.ID
      LEFT JOIN dbo.PricingPolicies AS pp ON c.PricingPolicyID = pp.ID
      WHERE c.ID = @customerId
    `);
    return result.recordset?.[0] ?? null;
  } catch (err) {
    console.error('Failed to load customer basic data', err);
    return null;
  }
}

async function fetchCustomerGroups() {
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

async function fetchCustomers() {
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

async function fetchPricingPolicies() {
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

async function fetchCountries() {
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

async function fetchCities(): Promise<CustomerCityOption[]> {
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

async function fetchImportanceOptions(): Promise<CustomerDropdownOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<{ Importance: string | number | null }>(`
      SELECT DISTINCT Importance
      FROM dbo.Customers
      WHERE Importance IS NOT NULL
      ORDER BY Importance
    `);
    const deduped = new Map<string, CustomerDropdownOption>();
    (result.recordset ?? []).forEach((row) => {
      const raw = row.Importance;
      if (raw == null) return;
      const label = typeof raw === 'number' ? String(raw) : String(raw).trim();
      if (!label) return;
      if (!deduped.has(label)) {
        deduped.set(label, { value: label, label });
      }
    });
    return Array.from(deduped.values());
  } catch (err) {
    console.error('Failed to load customer importances', err);
    return [];
  }
}

export default async function CustomerBasicDataPanel({ customerId, initialRecord }: Props) {
  const decodedId = decodeURIComponent(customerId);
  const numericId = Number(decodedId);
  const record =
    initialRecord ??
    (Number.isInteger(numericId) && numericId > 0 ? await fetchCustomerBasicRecord(numericId) : null);

  if (!record) {
    return (
      <section className={styles.emptyState}>
        This customer could not be found or has been removed.
      </section>
    );
  }

  const [customerGroups, parentCustomers, pricingPolicies, importanceOptions, countries, cities] =
    await Promise.all([
      fetchCustomerGroups(),
      fetchCustomers(),
      fetchPricingPolicies(),
      fetchImportanceOptions(),
      fetchCountries(),
      fetchCities(),
    ]);

  const filteredParents =
    record.CustomerID != null
      ? parentCustomers.filter((option) => option.value !== String(record.CustomerID))
      : parentCustomers;

  return (
    <CustomerBasicDataClient
      customerId={decodedId}
      record={record}
      customerGroups={customerGroups}
      parentCustomers={filteredParents}
      pricingPolicies={pricingPolicies}
      importanceOptions={importanceOptions}
      countries={countries}
      cities={cities}
    />
  );
}
