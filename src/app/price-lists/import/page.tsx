import PriceListImportClient, {
  type PreviousPriceListOption,
  type PrefillData,
} from "./PriceListImportClient";
import { getPool } from "../../../lib/sql";
import sql from "mssql";
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
  TelmacoDiscountPercentage: number | null;
  CustomerDiscountPercentage: number | null;
  TelmacoWarrantyYears: number | null;
  CustomerWarrantyYears: number | null;
};

type UserRow = {
  Id: string | null;
  FullName: string | null;
};

const toOptions = (rows: RawDropdownRow[] | null | undefined): DropdownOption[] => toDropdownOptions(rows);

// Always fetch fresh lookup data (e.g. brands) on each request so manually added DB rows are visible after refresh
export const dynamic = "force-dynamic";

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

    return (result.recordset ?? [])
      .filter((row) => row?.ID != null)
      .map((row) => ({
        value: String(row.ID),
        label: safeLabel(row.Name, `Rule ${row.ID}`),
        brandId: row.BrandID,
        brandName: row.BrandName ?? null,
        pricingPolicyId: row.PricingPolicyID,
        pricingPolicyName: row.PricingPolicyName ?? null,
        telmacoDiscountPercentage: row.TelmacoDiscountPercentage ?? null,
        customerDiscountPercentage: row.CustomerDiscountPercentage ?? null,
        telmacoWarrantyYears: row.TelmacoWarrantyYears ?? null,
        customerWarrantyYears: row.CustomerWarrantyYears ?? null,
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

type PriceListPrefillRow = {
  ID: number;
  Name: string | null;
  BrandID: number | null;
  SupplierID: number | null;
  CurrencyId: number | null;
  CostCurrencyID: number | null;
  CurrencyCostModifier: number | null;
  CountryId: number | null;
  HasDuty: boolean | number | null;
  ResponsibleUserId: string | null;
  Comments: string | null;
  ValidityComment: string | null;
};

type PrefillPolicyRow = {
  PricingPolicyID: number;
};

async function fetchPrefillData(priceListId: number): Promise<PrefillData | null> {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input("id", sql.Int, priceListId);
    const result = await request.query<PriceListPrefillRow>(`
      SELECT
        ID, Name, BrandID, SupplierID, CurrencyId, CostCurrencyID,
        CurrencyCostModifier, CountryId, HasDuty, ResponsibleUserId,
        Comments, ValidityComment
      FROM dbo.PriceLists
      WHERE ID = @id
    `);
    const row = result.recordset?.[0];
    if (!row) return null;

    const policiesResult = await pool.request()
      .input("plId", sql.Int, priceListId)
      .query<PrefillPolicyRow>(`
        SELECT PricingPolicyID
        FROM dbo.PriceListPricingPolicy
        WHERE PriceListID = @plId
      `);

    return {
      name: row.Name ?? "",
      previousPriceListId: String(row.ID),
      brandId: row.BrandID != null ? String(row.BrandID) : "",
      supplierId: row.SupplierID != null ? String(row.SupplierID) : "",
      costCurrencyId: row.CostCurrencyID != null ? String(row.CostCurrencyID) : "",
      currencyCostModifier: row.CurrencyCostModifier != null ? String(row.CurrencyCostModifier) : "1",
      countryId: row.CountryId != null ? String(row.CountryId) : "",
      hasDuty: row.HasDuty === true || row.HasDuty === 1 ? true : row.HasDuty === false || row.HasDuty === 0 ? false : null,
      responsibleUserId: row.ResponsibleUserId ?? "",
      comments: row.Comments ?? "",
      supplierComments: row.ValidityComment ?? "",
      pricingPolicyIds: (policiesResult.recordset ?? []).map((p) => p.PricingPolicyID),
    };
  } catch (err) {
    console.error("Failed to fetch prefill data for price list", priceListId, err);
    return null;
  }
}

type PageProps = {
  searchParams: Promise<{ from?: string; append?: string }>;
};

export default async function PriceListImportPage({ searchParams }: PageProps) {
  const resolvedSearchParams = await searchParams;
  const appendId = resolvedSearchParams.append ? Number(resolvedSearchParams.append) : null;
  const appendMode = appendId != null && Number.isInteger(appendId);
  const fromId = appendMode
    ? appendId
    : resolvedSearchParams.from
      ? Number(resolvedSearchParams.from)
      : null;
  const prefill = fromId && Number.isInteger(fromId) ? await fetchPrefillData(fromId) : null;
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
      prefill={prefill}
      appendMode={appendMode}
      appendToPriceListId={appendMode && appendId != null ? appendId : null}
      appendToPriceListName={appendMode ? prefill?.name ?? null : null}
    />
  );
}
