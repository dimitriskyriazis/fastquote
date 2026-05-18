import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { toDropdownOptions, type RawDropdownRow } from '../../../lib/dropdownOptions';
import styles from './OfferBasicDataPanel.module.css';
import OfferBasicDataClient from './OfferBasicDataClient';
import type { OfferBasicRecord, OfferContactInfo, OfferDropdownOption, MarketOption } from './OfferBasicDataTypes';

type Props = {
  offerId: string;
};

async function fetchOfferBasicRecord(offerId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('offerId', sql.Int, offerId);
    const result = await request.query<OfferBasicRecord>(`
      SELECT
        o.ID AS OfferID,
        o.OfferVersion,
        o.CustomerID,
        o.SalesDivisionID,
        o.Title,
        o.Description,
        o.PaymentTerms,
        o.InstallationSchedule,
        o.OfferNotesClosing,
        o.OfferValidity,
        o.DeliveryTime,
        o.OfferNotesIntroduction,
        o.DiscountNote,
        o.Comments AS TelmacoNote,
        o.OfferContact,
        o.FinalPriceLabel,
        o.OfferLanguage,
        o.ContactID,
        LTRIM(RTRIM(CONCAT(
          ISNULL(oc.FirstName, ''),
          CASE WHEN oc.FirstName IS NOT NULL AND oc.LastName IS NOT NULL THEN ' ' ELSE '' END,
          ISNULL(oc.LastName, '')
        ))) AS ContactFullName,
        c.Name AS CustomerName,
        o.StatusID,
        o.PricingPolicyID,
        o.MarketID,
        o.CurrencyID,
        o.CurrencyModifier,
        cur.Name AS CurrencyName,
        os.Name AS StatusName,
        pp.Name AS PricingPolicyName,
        m.Name AS MarketName,
        sd.Name AS SalesDivisionName,
        created.FullName AS SalesCreationPersonName,
        created.UserName AS SalesCreationPersonUserName,
        created.Id AS SalesCreationPersonId,
        sales.FullName AS SalesPersonName,
        sales.UserName AS SalesPersonUserName,
        approver.FullName AS ApprovalUserName,
        approver.UserName AS ApprovalUserUserName,
        o.SalesPersonId,
        o.ApprovalUserId,
        o.ERPProjectCode,
        o.ERPFWCProjectID,
        o.Probability,
        o.CustomerRef,
        o.DraftRequestDate,
        o.DraftOfferDate,
        o.RequestDate,
        o.OfferDeadlineDate,
        o.OrderSignedDate,
        o.DeliveryDueDate,
        o.PossibleOrderDate,
        o.OfferDate,
        o.ModifiedOn,
        modified.FullName AS ModifiedByFullName,
        modified.UserName AS ModifiedByUserName,
        o.ProtocolNo,
        o.ServicesLocation
      FROM dbo.Offer AS o
      LEFT JOIN dbo.Customers AS c ON o.CustomerID = c.ID
      LEFT JOIN dbo.OfferStatus AS os ON o.StatusID = os.ID
      LEFT JOIN dbo.PricingPolicies AS pp ON o.PricingPolicyID = pp.ID
      LEFT JOIN dbo.Markets AS m ON o.MarketID = m.ID
      LEFT JOIN dbo.Currencies AS cur ON o.CurrencyID = cur.ID
      LEFT JOIN dbo.SalesDivision AS sd ON o.SalesDivisionID = sd.ID
      LEFT JOIN dbo.AspNetUsers AS created ON o.CreatedBy = created.Id
      LEFT JOIN dbo.AspNetUsers AS sales ON o.SalesPersonId = sales.Id
      LEFT JOIN dbo.AspNetUsers AS approver ON o.ApprovalUserId = approver.Id
      LEFT JOIN dbo.AspNetUsers AS modified ON o.ModifiedBy = modified.Id
      LEFT JOIN dbo.Contacts AS oc ON o.ContactID = oc.ID
      WHERE o.ID = @offerId
    `);
    return result.recordset?.[0] ?? null;
  } catch (err) {
    console.error('Failed to load offer basic data', err);
    return null;
  }
}

type LookupRow = RawDropdownRow & { ID: number; Name: string | null };
type UserLookupRow = LookupRow & { SalesSeniorityName?: string | null };

const mapLookupRows = (rows: LookupRow[] | undefined | null): OfferDropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

async function fetchOfferStatuses() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.OfferStatus
      ORDER BY Sorting, Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load statuses', err);
    return [];
  }
}

async function fetchPricingPolicies() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
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

type MarketLookupRow = LookupRow & { SalesDivisionID?: number | null };

async function fetchMarkets(): Promise<MarketOption[]> {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<MarketLookupRow>(`
      SELECT ID, Name, SalesDivisionID
      FROM dbo.Markets
      ORDER BY Name
    `);
    return (result.recordset ?? [])
      .filter((row): row is MarketLookupRow & { ID: number } => row?.ID != null)
      .map((row) => ({
        value: String(row.ID),
        label: row.Name?.trim() || `Option ${String(row.ID)}`,
        salesDivisionId: row.SalesDivisionID != null ? String(row.SalesDivisionID) : '',
      }));
  } catch (err) {
    console.error('Failed to load markets', err);
    return [];
  }
}

async function fetchCustomers() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
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

async function fetchSalesDivisions() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.SalesDivision
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load sales divisions', err);
    return [];
  }
}

async function fetchAspNetUsers() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<UserLookupRow>(`
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
        label: row.Name?.trim() || `Option ${String(row.ID)}`,
        salesSeniorityName: row.SalesSeniorityName?.trim() || null,
      }));
  } catch (err) {
    console.error('Failed to load users', err);
    return [];
  }
}

async function fetchFwcProjects() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
      SELECT ID, ShortName AS Name
      FROM dbo.FWCs
      ORDER BY ShortName, ID
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load FWC projects', err);
    return [];
  }
}

async function fetchCurrencies() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
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
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load currencies', err);
    return [];
  }
}

async function fetchCustomerContacts(customerId: number | null) {
  if (!customerId) return [];
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('customerId', sql.Int, customerId);
    const result = await request.query<OfferContactInfo>(`
      SELECT
        cnt.ID AS ContactID,
        cnt.FirstName,
        cnt.LastName,
        LTRIM(RTRIM(CONCAT(ISNULL(cnt.FirstName, ''), CASE WHEN cnt.FirstName IS NOT NULL AND cnt.LastName IS NOT NULL THEN ' ' ELSE '' END, ISNULL(cnt.LastName, '')))) AS FullName
      FROM dbo.Contacts AS cnt
      WHERE cnt.CustomerID = @customerId
      ORDER BY cnt.LastName, cnt.FirstName
    `);
    return (result.recordset ?? []).map((contact) => ({
      ...contact,
      FullName: contact.FullName && contact.FullName.trim().length > 0
        ? contact.FullName.trim()
        : [contact.FirstName, contact.LastName]
            .map((value) => value?.trim())
            .filter(Boolean)
            .join(' '),
    }));
  } catch (err) {
    console.error('Failed to load contacts', err);
    return [];
  }
}

export default async function OfferBasicDataPanel({ offerId }: Props) {
  const numericOfferId = Number(offerId);
  const normalizedOfferId = Number.isInteger(numericOfferId) && numericOfferId > 0 ? numericOfferId : null;
  const record = normalizedOfferId ? await fetchOfferBasicRecord(normalizedOfferId) : null;

  if (!record) {
    return (
      <section className={styles.emptyState}>
        This offer could not be found or has been removed.
      </section>
    );
  }

  const [
    contacts,
    customers,
    statuses,
    pricingPolicies,
    markets,
    salesDivisions,
    users,
    fwcProjects,
    currencies,
  ] = await Promise.all([
    fetchCustomerContacts(record.CustomerID ?? null),
    fetchCustomers(),
    fetchOfferStatuses(),
    fetchPricingPolicies(),
    fetchMarkets(),
    fetchSalesDivisions(),
    fetchAspNetUsers(),
    fetchFwcProjects(),
    fetchCurrencies(),
  ]);

  return (
    <OfferBasicDataClient
      offerId={offerId}
      record={record}
      contacts={contacts}
      customers={customers}
      statuses={statuses}
      pricingPolicies={pricingPolicies}
      markets={markets}
      salesDivisions={salesDivisions}
      users={users}
      fwcProjects={fwcProjects}
      currencies={currencies}
    />
  );
}
