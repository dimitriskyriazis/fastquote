import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import CustomerBasicDataClient from './CustomerBasicDataClient';
import styles from './CustomerBasicDataPanel.module.css';
import type { CustomerBasicRecord, CustomerDropdownOption, CustomerCityOption } from './CustomerBasicDataTypes';
import {
  fetchCities,
  fetchCountries,
  fetchCustomerGroups,
  fetchCustomers,
  fetchImportanceOptions,
  fetchPricingPolicies,
} from './customerBasicDataLookups';

type Props = {
  customerId: string;
  initialRecord?: CustomerBasicRecord | null;
};

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
