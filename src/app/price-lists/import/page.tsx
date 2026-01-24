import PriceListImportClient, {
  type PreviousPriceListOption,
} from "./PriceListImportClient";
import { getPool } from "../../../lib/sql";
import {
  toDropdownOptions,
  type DropdownOption,
  type RawDropdownRow,
} from "../../../lib/dropdownOptions";
import type { PricingPolicyRuleOption } from "../../../lib/lookupTypes";
import { formatDateUK } from "../../lib/formatDateTime";

type PriceListLookupRow = RawDropdownRow & {
  BrandID?: number | null;
  BrandName?: string | null;
  ValidFromDate?: Date | string | null;
  ValidToDate?: Date | string | null;
  Enabled?: boolean | number | null;
};

type PricingPolicyRuleRow = {
  ID: number | null;
  Name: string | null;
  BrandID: number | null;
  BrandName: string | null;
  PricingPolicyID: number | null;
  PricingPolicyName: string | null;
};

type UserRow = {
  Id: string | null;
  FullName: string | null;
};

const toOptions = (rows: RawDropdownRow[] | null | undefined): DropdownOption[] => toDropdownOptions(rows);

const safeLabel = (value: string | null | undefined, fallback: string): string => {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

async function fetchPricingPolicies() {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .query<RawDropdownRow>("SELECT ID, Name FROM dbo.PricingPolicies ORDER BY Name");
    return toOptions(result.recordset);
  } catch (err) {
    console.error("Failed to load pricing policies", err);
    return [];
  }
}

async function fetchPricingPolicyRules(): Promise<PricingPolicyRuleOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<PricingPolicyRuleRow>(`
      SELECT
        ppr.ID,
        ppr.Name,
        ppr.BrandID,
        b.Name AS BrandName,
        ppr.PricingPolicyID,
        pp.Name AS PricingPolicyName
      FROM dbo.PricingPolicyRules ppr
      LEFT JOIN dbo.Brands b ON ppr.BrandID = b.ID
      LEFT JOIN dbo.PricingPolicies pp ON ppr.PricingPolicyID = pp.ID
      ORDER BY ppr.Name
    `);

    return (result.recordset ?? [])
      .filter((row) => row?.ID != null)
      .map((row) => ({
        value: String(row.ID),
        label: safeLabel(row.Name, `Rule ${row.ID}`),
        brandId: row.BrandID,
        brandName: row.BrandName ?? null,
        pricingPolicyId: row.PricingPolicyID,
        pricingPolicyName: row.PricingPolicyName ?? null,
      }));
  } catch (err) {
    console.error("Failed to load pricing policy rules", err);
    return [];
  }
}

async function fetchUsers(): Promise<DropdownOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<UserRow>(`
      SELECT Id, FullName
      FROM dbo.AspNetUsers
      ORDER BY
        CASE WHEN FullName IS NULL OR LTRIM(RTRIM(FullName)) = '' THEN 1 ELSE 0 END,
        FullName
    `);
    return (result.recordset ?? [])
      .filter((row): row is UserRow & { Id: string } => Boolean(row?.Id))
      .map((row) => ({
        value: String(row.Id),
        label: safeLabel(row.FullName, "User"),
      }));
  } catch (err) {
    console.error("Failed to load users", err);
    return [];
  }
}

async function fetchPreviousPriceLists(): Promise<PreviousPriceListOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<PriceListLookupRow>(`
      SELECT TOP (200)
        pl.ID,
        pl.Name,
        pl.BrandID,
        b.Name AS BrandName,
        pl.ValidFromDate,
        pl.ValidToDate,
        pl.Enabled
      FROM dbo.PriceLists AS pl
      LEFT JOIN dbo.Brands AS b ON pl.BrandID = b.ID
      WHERE pl.Enabled = 1
      ORDER BY
        CASE WHEN pl.ValidToDate IS NULL OR pl.ValidToDate >= SYSUTCDATETIME() THEN 0 ELSE 1 END,
        pl.ValidToDate DESC,
        pl.ModifiedOn DESC,
        pl.ID DESC
    `);

    const formatDate = (value: Date | string | null | undefined) => {
      if (!value) return null;
      const formatted = formatDateUK(value);
      return formatted === "" ? null : formatted;
    };

    return (result.recordset ?? [])
      .filter((row) => row?.ID != null)
      .map((row) => {
        const from = formatDate(row.ValidFromDate);
        const to = formatDate(row.ValidToDate);
        const brand = row.BrandName?.trim();
        const dates = from || to ? `(${from || "—"} → ${to || "—"})` : "";
        const enabledLabel =
          row.Enabled === false || row.Enabled === 0 ? " • disabled" : "";
        const brandLabel = brand ? ` • ${brand}` : "";
        return {
          value: String(row.ID),
          label: `${safeLabel(row.Name, "Price list")} ${dates}${brandLabel}${enabledLabel}`.trim(),
          brandId: row.BrandID ?? null,
          brandName: row.BrandName ?? null,
        };
      });
  } catch (err) {
    console.error("Failed to load previous price lists", err);
    return [];
  }
}

export default async function PriceListImportPage() {
  const pool = await getPool();

  const [brands, suppliers, currencies, countries] = await Promise.all([
    pool
      .request()
      .query<RawDropdownRow>("SELECT ID, Name FROM dbo.Brands ORDER BY Name")
      .then((res) => toOptions(res.recordset))
      .catch((err) => {
        console.error("Failed to load brands", err);
        return [] as DropdownOption[];
      }),
    pool
      .request()
      .query<RawDropdownRow>("SELECT ID, Name FROM dbo.Suppliers ORDER BY Name")
      .then((res) => toOptions(res.recordset))
      .catch((err) => {
        console.error("Failed to load suppliers", err);
        return [] as DropdownOption[];
      }),
    pool
      .request()
      .query<RawDropdownRow>(`
        SELECT ID, Name
        FROM dbo.Currencies
        ORDER BY
          CASE
            WHEN Name = N'€' OR LOWER(Name) LIKE '%eur%' OR LOWER(Name) LIKE '%euro%' THEN 0
            WHEN Name = N'$' OR LOWER(Name) LIKE '%usd%' OR LOWER(Name) LIKE '%dollar%' THEN 1
            ELSE 2
          END,
          Name
      `)
      .then((res) => toOptions(res.recordset))
      .catch((err) => {
        console.error("Failed to load currencies", err);
        return [] as DropdownOption[];
      }),
    pool
      .request()
      .query<RawDropdownRow>("SELECT ID, Name FROM dbo.Countries ORDER BY Name")
      .then((res) => toOptions(res.recordset))
      .catch((err) => {
        console.error("Failed to load countries", err);
        return [] as DropdownOption[];
      }),
  ]);

  const [pricingPolicies, pricingPolicyRules, users, previousPriceLists] =
    await Promise.all([
      fetchPricingPolicies(),
      fetchPricingPolicyRules(),
      fetchUsers(),
      fetchPreviousPriceLists(),
    ]);

  return (
    <PriceListImportClient
      brands={brands}
      suppliers={suppliers}
      currencies={currencies}
      countries={countries}
      pricingPolicies={pricingPolicies}
      pricingPolicyRules={pricingPolicyRules}
      users={users}
      previousPriceLists={previousPriceLists}
    />
  );
}
