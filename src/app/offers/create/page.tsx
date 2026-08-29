import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import OfferCreateClient, {
  type CustomerOption,
  type MarketOption,
  type PricingPolicyOption,
} from './OfferCreateClient';
import styles from '../offersDetail.module.css';
import clientStyles from './OfferCreateClient.module.css';
import { getPool } from '../../../lib/sql';
import { toDropdownOptions, type RawDropdownRow, type DropdownOption } from '../../../lib/dropdownOptions';
import { getAuditFallbackUserId, resolveAuditUserId } from '../../../lib/auditTrail';


type LookupRow = RawDropdownRow & { ID: number; Name: string | null };
type MarketLookupRow = LookupRow & { SalesDivisionID?: number | null };
type UserLookupRow = LookupRow & { SalesSeniorityName?: string | null };
// Customers.PricingPolicyID is nvarchar(100) NOT NULL, not an int FK: the overwhelming
// majority of rows hold '' (no policy), and the rest hold the ID as text.
type CustomerLookupRow = LookupRow & { PricingPolicyID?: number | string | null };
type PricingPolicyLookupRow = LookupRow & {
  Enabled?: boolean | number | null;
  HasRules?: boolean | number | null;
};

const toFlag = (value: boolean | number | null | undefined): boolean =>
  value === true || value === 1;

const mapOptions = (rows: LookupRow[] | undefined | null): DropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

// Each customer carries its own PricingPolicyID so the form can default the offer's pricing
// policy from the customer (see resolvePolicyForCustomer in OfferCreateClient).
async function fetchCustomers(): Promise<CustomerOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<CustomerLookupRow>(`
      SELECT ID, Name, PricingPolicyID
      FROM dbo.Customers
      WHERE ISNULL(IsParent, 0) = 0
        AND ISNULL(Enabled, 0) = 1
      ORDER BY Name
    `);
    return (result.recordset ?? [])
      .filter((row): row is CustomerLookupRow & { ID: number } => row?.ID != null)
      .map((row) => {
        const stringId = String(row.ID);
        return {
          value: stringId,
          label: normalizeDropdownLabel(row.Name) ?? `Option ${stringId}`,
          pricingPolicyId: row.PricingPolicyID != null ? String(row.PricingPolicyID).trim() : '',
        };
      });
  } catch (err) {
    console.error('Failed to load customers', err);
    return [];
  }
}

async function fetchOfferStatuses() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.OfferStatus
      ORDER BY Sorting, Name
    `);
    return mapOptions(result.recordset);
  } catch (err) {
    console.error('Failed to load statuses', err);
    return [];
  }
}

// enabled/hasRules mirror what POST /api/offers/create enforces, so the customer-derived
// default never lands on a policy the create call would reject.
async function fetchPricingPolicies(): Promise<PricingPolicyOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<PricingPolicyLookupRow>(`
      SELECT
        pp.ID,
        pp.Name,
        CAST(CASE WHEN ISNULL(pp.Enabled, 0) = 1 THEN 1 ELSE 0 END AS BIT) AS Enabled,
        CAST(CASE WHEN EXISTS (
          SELECT 1 FROM dbo.PricingPolicyRules ppr WHERE ppr.PricingPolicyID = pp.ID
        ) THEN 1 ELSE 0 END AS BIT) AS HasRules
      FROM dbo.PricingPolicies pp
      ORDER BY pp.Name
    `);
    return (result.recordset ?? [])
      .filter((row): row is PricingPolicyLookupRow & { ID: number } => row?.ID != null)
      .map((row) => {
        const stringId = String(row.ID);
        return {
          value: stringId,
          label: normalizeDropdownLabel(row.Name) ?? `Option ${stringId}`,
          enabled: toFlag(row.Enabled),
          hasRules: toFlag(row.HasRules),
        };
      });
  } catch (err) {
    console.error('Failed to load pricing policies', err);
    return [];
  }
}

const normalizeDropdownLabel = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const mapMarketOptions = (rows: MarketLookupRow[] | undefined | null): MarketOption[] =>
  (rows ?? [])
    .filter((row): row is MarketLookupRow & { ID: number } => row?.ID != null)
    .map((row) => {
      const stringId = String(row.ID);
      const label = normalizeDropdownLabel(row.Name) ?? `Option ${stringId}`;
      return {
        value: stringId,
        label,
        salesDivisionId: row.SalesDivisionID != null ? String(row.SalesDivisionID) : '',
      };
    });

async function fetchMarkets(): Promise<MarketOption[]> {
  try {
    const pool = await getPool();
    const result = await pool.request().query<MarketLookupRow>(`
      SELECT ID, Name, SalesDivisionID
      FROM dbo.Markets
      ORDER BY Name
    `);
    return mapMarketOptions(result.recordset);
  } catch (err) {
    console.error('Failed to load markets', err);
    return [];
  }
}

async function fetchSalesDivisions() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.SalesDivision
      ORDER BY Name
    `);
    return mapOptions(result.recordset);
  } catch (err) {
    console.error('Failed to load sales divisions', err);
    return [];
  }
}

async function fetchUsers() {
  try {
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
        label: normalizeDropdownLabel(row.Name) ?? `Option ${String(row.ID)}`,
        salesSeniorityName: normalizeDropdownLabel(row.SalesSeniorityName),
      }));
  } catch (err) {
    console.error('Failed to load users', err);
    return [];
  }
}

async function fetchFwcProjects() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, ShortName AS Name
      FROM dbo.FWCs
      ORDER BY ShortName, ID
    `);
    return mapOptions(result.recordset);
  } catch (err) {
    console.error('Failed to load FWC projects', err);
    return [];
  }
}

async function fetchCurrencies() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Currencies
      ORDER BY
        CASE
          WHEN Name = N'€' THEN 0
          WHEN LOWER(Name) LIKE '%eur%' THEN 1
          ELSE 2
        END,
        Name
    `);
    return mapOptions(result.recordset);
  } catch (err) {
    console.error('Failed to load currencies', err);
    return [];
  }
}

export default async function Page() {
  const requestHeaders = await headers();
  const requestCookies = await cookies();
  const loggedUserId = resolveAuditUserId({
    headers: requestHeaders,
    cookies: requestCookies,
  });

  const [
    customers,
    statuses,
    pricingPolicies,
    markets,
    salesDivisions,
    users,
    fwcProjects,
    currencies,
  ] = await Promise.all([
    fetchCustomers(),
    fetchOfferStatuses(),
    fetchPricingPolicies(),
    fetchMarkets(),
    fetchSalesDivisions(),
    fetchUsers(),
    fetchFwcProjects(),
    fetchCurrencies(),
  ]);

  const fallbackUserId = getAuditFallbackUserId();
  const hasFallbackUser = fallbackUserId
    ? users.some((user) => user.value === fallbackUserId)
    : false;
  const suggestedUserId = loggedUserId ?? (hasFallbackUser ? fallbackUserId ?? '' : '');

  const formId = 'offer-create-form';

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div className={`${styles.headerSide} ${styles.headerSideStart}`}>
          <Link href="/offers" className={`${styles.backLink} page-header-button`}>
            <span aria-hidden="true">←</span>
            Back to offers
          </Link>
        </div>
        <h1 className={styles.heading}>Create Offer</h1>
        <div className={`${styles.headerSide} ${styles.headerSideEnd}`}>
          <button
            type="submit"
            form={formId}
            className={`${clientStyles.submitButton} page-header-button`}
          >
            Create offer and proceed to products
          </button>
        </div>
      </div>
      <div className={styles.pageBody}>
        <OfferCreateClient
          customers={customers}
          statuses={statuses}
          pricingPolicies={pricingPolicies}
          markets={markets}
          salesDivisions={salesDivisions}
          users={users}
          fwcProjects={fwcProjects}
          currencies={currencies}
          defaultValues={{
            suggestedUserId,
          }}
          formId={formId}
        />
      </div>
    </main>
  );
}
