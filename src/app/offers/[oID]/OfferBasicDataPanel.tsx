import sql from 'mssql';
import { getPool } from '../../../lib/sql';
import { toDropdownOptions, type RawDropdownRow } from '../../../lib/dropdownOptions';
import styles from './OfferBasicDataPanel.module.css';
import OfferBasicDataClient from './OfferBasicDataClient';
import type { OfferBasicRecord, OfferContactInfo, OfferDropdownOption } from './OfferBasicDataTypes';

type Props = {
  oID: string;
};

async function fetchOfferBasicRecord(offerId: number) {
  try {
    const pool = await getPool();
    const request = pool.request();
    request.input('offerId', sql.Int, offerId);
    const result = await request.query<OfferBasicRecord>(`
      SELECT
        o.ID AS OfferID,
        o.CustomerID,
        o.Title,
        o.Description,
        o.PaymentTerms,
        o.InstallationSchedule,
        o.OfferNotesClosing,
        o.OfferValidity,
        o.DeliveryTime,
        o.OfferNotesIntroduction,
        o.Comments AS TelmacoNote,
        o.OfferContact,
        c.Name AS CustomerName,
        o.StatusID,
        o.PricingPolicyID,
        o.MarketID,
        os.Name AS StatusName,
        pp.Name AS PricingPolicyName,
        m.Name AS MarketName,
        sd.Name AS SalesDivisionName,
        created.FullName AS SalesCreationPersonName,
        created.UserName AS SalesCreationPersonUserName,
        sales.FullName AS SalesPersonName,
        sales.UserName AS SalesPersonUserName,
        approver.FullName AS ApprovalUserName,
        approver.UserName AS ApprovalUserUserName,
        o.SalesPersonId,
        o.ApprovalUserId,
        o.DefaultCalcMethodFormulasID,
        o.ProjectID,
        o.CustomerRef,
        o.InitialRequest,
        o.DraftOffer,
        o.OfficialRequest,
        o.OfferDeadline,
        o.OfficialQuoteOffer,
        o.OrderSigned,
        o.DeliveryDue,
        o.Delivery,
        o.OfferDate,
        o.ModifiedOn,
        modified.FullName AS ModifiedByFullName,
        modified.UserName AS ModifiedByUserName
      FROM dbo.Offer AS o
      LEFT JOIN dbo.Customers AS c ON o.CustomerID = c.ID
      LEFT JOIN dbo.OfferStatus AS os ON o.StatusID = os.ID
      LEFT JOIN dbo.PricingPolicies AS pp ON o.PricingPolicyID = pp.ID
      LEFT JOIN dbo.Markets AS m ON o.MarketID = m.ID
      LEFT JOIN dbo.SalesDivision AS sd ON o.SalesDivitionID = sd.ID
      LEFT JOIN dbo.AspNetUsers AS created ON o.CreatedBy = created.Id
      LEFT JOIN dbo.AspNetUsers AS sales ON o.SalesPersonId = sales.Id
      LEFT JOIN dbo.AspNetUsers AS approver ON o.ApprovalUserId = approver.Id
      LEFT JOIN dbo.AspNetUsers AS modified ON o.ModifiedBy = modified.Id
      WHERE o.ID = @offerId
    `);
    return result.recordset?.[0] ?? null;
  } catch (err) {
    console.error('Failed to load offer basic data', err);
    return null;
  }
}

type LookupRow = RawDropdownRow & { ID: number; Name: string | null };

const mapLookupRows = (rows: LookupRow[] | undefined | null): OfferDropdownOption[] =>
  toDropdownOptions<LookupRow>(rows);

async function fetchOfferStatuses() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.OfferStatus
      ORDER BY Name
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

async function fetchMarkets() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
      SELECT ID, Name
      FROM dbo.Markets
      ORDER BY Name
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load markets', err);
    return [];
  }
}

async function fetchAspNetUsers() {
  try {
    const pool = await getPool();
    const request = pool.request();
    const result = await request.query<LookupRow>(`
      SELECT Id AS ID, UserName AS Name
      FROM dbo.AspNetUsers
      ORDER BY UserName
    `);
    return mapLookupRows(result.recordset);
  } catch (err) {
    console.error('Failed to load users', err);
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

export default async function OfferBasicDataPanel({ oID }: Props) {
  const numericOfferId = Number(oID);
  const offerId = Number.isInteger(numericOfferId) && numericOfferId > 0 ? numericOfferId : null;
  const record = offerId ? await fetchOfferBasicRecord(offerId) : null;

  if (!record) {
    return (
      <section className={styles.emptyState}>
        This offer could not be found or has been removed.
      </section>
    );
  }

  const [contacts, statuses, pricingPolicies, markets, users] = await Promise.all([
    fetchCustomerContacts(record.CustomerID ?? null),
    fetchOfferStatuses(),
    fetchPricingPolicies(),
    fetchMarkets(),
    fetchAspNetUsers(),
  ]);

  return (
    <OfferBasicDataClient
      oID={oID}
      record={record}
      contacts={contacts}
      statuses={statuses}
      pricingPolicies={pricingPolicies}
      markets={markets}
      users={users}
    />
  );
}
