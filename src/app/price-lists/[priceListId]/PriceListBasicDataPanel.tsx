import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { toDropdownOptions, type RawDropdownRow } from '../../../lib/dropdownOptions';
import PriceListBasicDataClient from './PriceListBasicDataClient';
import styles from './PriceListBasicDataPanel.module.css';
import type {
  PriceListBasicRecord,
  PriceListDropdownOption,
  PriceListPricingPolicy,
  PricingPoliciesByBrand,
} from './PriceListBasicDataTypes';

type Props = {
  priceListId: string;
  initialRecord?: PriceListBasicRecord | null;
};

type LookupRow = RawDropdownRow & { ID: number | null; Name: string | null };

const mapLookupRows = (rows: LookupRow[] | undefined | null): PriceListDropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

export async function fetchPriceListBasicRecord(priceListId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('priceListId', sql.Int, priceListId);
    const result = await request.query<PriceListBasicRecord>(`
      SELECT TOP 1
        pl.ID AS PriceListID,
        pl.Name,
        pl.ValidFromDate,
        pl.ValidToDate,
        pl.Comments,
        pl.ValidityComment,
        pl.Enabled,
        pl.FilePath,
        pl.BrandID AS BrandID,
        b.Name AS BrandName,
        pl.CountryId AS CountryId,
        c.Name AS CountryName,
        pl.SupplierID AS SupplierID,
        s.Name AS SupplierName,
        pl.CurrencyId AS CurrencyId,
        cur.Name AS CurrencyName,
        pl.CostCurrencyID AS CostCurrencyID,
        costCur.Name AS CostCurrencyName,
        pl.CurrencyCostModifier AS CurrencyCostModifier,
        pl.ResponsibleUserId,
        COALESCE(NULLIF(LTRIM(RTRIM(resp.FullName)), ''), resp.UserName) AS ResponsibleUserName,
        pl.HasDuty,
        NULL AS PricingPolicyID,
        NULL AS PricingPolicyName,
        pl.ModifiedOn,
        pl.ModifiedBy AS ModifiedByUserId,
        modified.UserName AS ModifiedByUserName,
        modified.FullName AS ModifiedByFullName
      FROM dbo.PriceLists AS pl
      LEFT JOIN dbo.Brands AS b ON pl.BrandID = b.ID
      LEFT JOIN dbo.Countries AS c ON pl.CountryId = c.ID
      LEFT JOIN dbo.Suppliers AS s ON pl.SupplierID = s.ID
      LEFT JOIN dbo.Currencies AS cur ON pl.CurrencyId = cur.ID
      LEFT JOIN dbo.Currencies AS costCur ON pl.CostCurrencyID = costCur.ID
      LEFT JOIN dbo.AspNetUsers AS resp ON pl.ResponsibleUserId = resp.Id
      LEFT JOIN dbo.AspNetUsers AS modified ON pl.ModifiedBy = modified.Id
      WHERE pl.ID = @priceListId
    `);
    return result.recordset?.[0] ?? null;
  } catch (err) {
    console.error('Failed to load price list basic data', err);
    return null;
  }
}

async function fetchBrands() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Brands
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load brands', err);
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

async function fetchSuppliers() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Suppliers
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load suppliers', err);
    return [];
  }
}

async function fetchCurrencies() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Currencies
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load currencies', err);
    return [];
  }
}

async function fetchUsers() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow & { UserName?: string | null }>(`
      SELECT
        Id AS ID,
        COALESCE(NULLIF(LTRIM(RTRIM(FullName)), ''), UserName) AS Name
      FROM dbo.AspNetUsers
      ORDER BY COALESCE(NULLIF(LTRIM(RTRIM(FullName)), ''), UserName)
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load users', err);
    return [];
  }
}

async function fetchAllPricingPolicies() {
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

type PricingPolicyRuleRow = {
  ID: number;
  Name: string | null;
  PricingPolicyID: number | null;
  BrandID: number | null;
  BrandName: string | null;
  PricingPolicyName: string | null;
  TelmacoDiscountPercentage: number | null;
  CustomerDiscountPercentage: number | null;
  TelmacoWarrantyYears: number | null;
  CustomerWarrantyYears: number | null;
};

async function fetchAllPricingPolicyRules() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<PricingPolicyRuleRow>(`
      SELECT
        ppr.ID,
        ppr.Name,
        ppr.PricingPolicyID,
        ppr.BrandID,
        b.Name AS BrandName,
        pp.Name AS PricingPolicyName,
        ppr.TelmacoDiscountPercentage,
        ppr.CustomerDiscountPercentage,
        ppr.TelmacoWarrantyYears,
        ppr.CustomerWarrantyYears
      FROM dbo.PricingPolicyRules ppr
      LEFT JOIN dbo.Brands b ON ppr.BrandID = b.ID
      LEFT JOIN dbo.PricingPolicies pp ON ppr.PricingPolicyID = pp.ID
      ORDER BY ppr.Name
    `);
    return (result.recordset ?? []).map((row) => ({
      id: row.ID,
      name: row.Name,
      pricingPolicyId: row.PricingPolicyID,
      brandId: row.BrandID,
      brandName: row.BrandName ?? null,
      pricingPolicyName: row.PricingPolicyName ?? null,
      telmacoDiscountPercentage: row.TelmacoDiscountPercentage ?? null,
      customerDiscountPercentage: row.CustomerDiscountPercentage ?? null,
      telmacoWarrantyYears: row.TelmacoWarrantyYears ?? null,
      customerWarrantyYears: row.CustomerWarrantyYears ?? null,
    }));
  } catch (err) {
    console.error('Failed to load pricing policy rules', err);
    return [];
  }
}

type PricingPolicyRow = {
  BrandID: number | null;
  PricingPolicyID: number | null;
  Name: string | null;
};

async function fetchPricingPoliciesByBrand(): Promise<PricingPoliciesByBrand> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<PricingPolicyRow>(`
      SELECT
        ppr.BrandID,
        ppr.PricingPolicyID,
        pp.Name
      FROM dbo.PricingPolicyRules AS ppr
      INNER JOIN dbo.PricingPolicies AS pp ON ppr.PricingPolicyID = pp.ID
      WHERE ppr.BrandID IS NOT NULL
    `);
    const map: PricingPoliciesByBrand = {};
    (result.recordset ?? []).forEach((row) => {
      if (row.BrandID == null || row.PricingPolicyID == null) return;
      const key = String(row.BrandID);
      if (!map[key]) map[key] = [];
      map[key].push({
        brandId: row.BrandID,
        pricingPolicyId: row.PricingPolicyID,
        name: row.Name,
      } satisfies PriceListPricingPolicy);
    });
    Object.values(map).forEach((policies) => {
      policies.sort((a, b) => {
        const aName = a.name ?? '';
        const bName = b.name ?? '';
        return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
      });
    });
    return map;
  } catch (err) {
    console.error('Failed to load pricing policies', err);
    return {};
  }
}

type PriceListPricingPolicyRow = {
  ID: number;
  PriceListID: number;
  PricingPolicyID: number;
  PricingPolicyName: string | null;
};

export async function fetchPriceListPricingPolicies(priceListId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('priceListId', sql.Int, priceListId);
    const result = await request.query<PriceListPricingPolicyRow>(`
      SELECT
        plpp.ID,
        plpp.PriceListID,
        plpp.PricingPolicyID,
        pp.Name AS PricingPolicyName
      FROM dbo.PriceListPricingPolicy AS plpp
      INNER JOIN dbo.PricingPolicies AS pp ON plpp.PricingPolicyID = pp.ID
      WHERE plpp.PriceListID = @priceListId
      ORDER BY pp.Name, ppr.Name
    `);
    return (result.recordset ?? []).map((row) => ({
      id: row.ID,
      priceListId: row.PriceListID,
      pricingPolicyId: row.PricingPolicyID,
      pricingPolicyName: row.PricingPolicyName,
      pricingPolicyRuleId: null,
      pricingPolicyRuleName: null,
    }));
  } catch (err) {
    console.error('Failed to load price list pricing policies', err);
    return [];
  }
}

export default async function PriceListBasicDataPanel({ priceListId, initialRecord }: Props) {
  const decodedId = decodeURIComponent(priceListId);
  const numericId = Number(decodedId);
  const record =
    initialRecord ??
    (Number.isInteger(numericId) && numericId > 0 ? await fetchPriceListBasicRecord(numericId) : null);

  if (!record) {
    return (
      <section className={styles.emptyState}>
        This price list could not be found or has been removed.
      </section>
    );
  }

  const [brands, countries, suppliers, currencies, users, pricingPoliciesByBrand, priceListPricingPolicies, allPricingPolicies, allPricingPolicyRules] = await Promise.all([
    fetchBrands(),
    fetchCountries(),
    fetchSuppliers(),
    fetchCurrencies(),
    fetchUsers(),
    fetchPricingPoliciesByBrand(),
    fetchPriceListPricingPolicies(numericId),
    fetchAllPricingPolicies(),
    fetchAllPricingPolicyRules(),
  ]);

  return (
    <PriceListBasicDataClient
      priceListId={decodedId}
      record={record}
      brands={brands}
      countries={countries}
      suppliers={suppliers}
      currencies={currencies}
      users={users}
      pricingPoliciesByBrand={pricingPoliciesByBrand}
      priceListPricingPolicies={priceListPricingPolicies}
      allPricingPolicies={allPricingPolicies}
      allPricingPolicyRules={allPricingPolicyRules}
    />
  );
}
