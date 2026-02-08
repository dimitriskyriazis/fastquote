import Link from 'next/link';
import { cookies, headers } from 'next/headers';
import OfferCreateClient, { type MarketOption } from './OfferCreateClient';
import styles from '../offersDetail.module.css';
import clientStyles from './OfferCreateClient.module.css';
import { getPool } from '../../../lib/sql';
import { toDropdownOptions, type RawDropdownRow, type DropdownOption } from '../../../lib/dropdownOptions';
import { getAuditFallbackUserId, resolveAuditUserId } from '../../../lib/auditTrail';

type LookupRow = RawDropdownRow & { ID: number; Name: string | null };
type MarketLookupRow = LookupRow & { SalesDivisionID?: number | null };

const mapOptions = (rows: LookupRow[] | undefined | null): DropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

async function fetchCustomers() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Customers
      WHERE ISNULL(IsParent, 0) = 0
      ORDER BY Name
    `);
    return mapOptions(result.recordset);
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

async function fetchPricingPolicies() {
  try {
    const pool = await getPool();
    const result = await pool.request().query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.PricingPolicies
      ORDER BY Name
    `);
    return mapOptions(result.recordset);
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
    const result = await pool.request().query<LookupRow>(`
      SELECT
        Id AS ID,
        COALESCE(NULLIF(LTRIM(RTRIM(FullName)), ''), UserName) AS Name
      FROM dbo.AspNetUsers
      ORDER BY COALESCE(NULLIF(LTRIM(RTRIM(FullName)), ''), UserName)
    `);
    return mapOptions(result.recordset);
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
  ] = await Promise.all([
    fetchCustomers(),
    fetchOfferStatuses(),
    fetchPricingPolicies(),
    fetchMarkets(),
    fetchSalesDivisions(),
    fetchUsers(),
    fetchFwcProjects(),
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
          defaultValues={{
            deliveryTime: '8 weeks',
            paymentTerms: 'Upon Agreement',
            offerValidity: '4 weeks',
            suggestedUserId,
          }}
          formId={formId}
        />
      </div>
    </main>
  );
}
