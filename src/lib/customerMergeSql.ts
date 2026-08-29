/**
 * Shared SQL for the customer-merge preview and commit routes.
 *
 * On the optional columns: dbo.Customers.PaymentTermID and dbo.Customers.ERPCode
 * arrive with migrations that are not applied everywhere yet (neither exists on
 * a plain local database today, and production trails as well). Rather than hard
 * coding them and 500-ing on a database that predates the migration, every
 * statement here is assembled around a sys.columns probe — the same defensive
 * idiom lib/authz.ts uses for the two AspNetUserRoles shapes. Where a column is
 * missing the record simply reports null for it and the field disappears from
 * the merge picker.
 */
import sql from 'mssql';
import type { ConnectionPool, Request as SqlRequest } from 'mssql';
import { normalizeId } from './normalize';
import {
  MERGE_FIELDS,
  MAX_MERGE_SECONDARIES,
  contactDuplicateKey,
  type MergeContactRecord,
  type MergeCustomerRecord,
  type MergeFieldDescriptor,
  type MergeFieldKey,
} from '../app/customers/merge/customerMergeTypes';

export type CustomerOptionalColumns = {
  paymentTermId: boolean;
  paymentTermsTable: boolean;
  erpCode: boolean;
};

export const probeCustomerColumns = async (
  pool: ConnectionPool,
): Promise<CustomerOptionalColumns> => {
  const result = await pool.request().query<{ Kind: string }>(`
    SELECT 'PaymentTermID' AS Kind FROM sys.columns
      WHERE object_id = OBJECT_ID(N'dbo.Customers') AND name = 'PaymentTermID'
    UNION ALL
    SELECT 'ERPCode' FROM sys.columns
      WHERE object_id = OBJECT_ID(N'dbo.Customers') AND name = 'ERPCode'
    UNION ALL
    SELECT 'PaymentTerms' FROM sys.tables
      WHERE object_id = OBJECT_ID(N'dbo.PaymentTerms')
  `);
  const present = new Set((result.recordset ?? []).map((row) => row.Kind));
  return {
    paymentTermId: present.has('PaymentTermID'),
    paymentTermsTable: present.has('PaymentTerms'),
    erpCode: present.has('ERPCode'),
  };
};

/** The merge fields this database can actually store, in display order. */
export const availableMergeFields = (
  columns: CustomerOptionalColumns,
): MergeFieldDescriptor[] =>
  MERGE_FIELDS.filter((descriptor) => {
    if (descriptor.field === 'PaymentTermID') return columns.paymentTermId;
    if (descriptor.field === 'ERPCode') return columns.erpCode;
    return true;
  });

type FieldColumn = {
  column: string;
  type: 'string' | 'number';
  length?: number;
  /** NOT NULL in dbo.Customers: a null pick has to be ignored, not written. */
  notNull?: boolean;
};

/**
 * Column mapping and bind types, kept aligned with the FIELD_CONFIG in
 * /api/customers/[customerId]/basicdata so a value written through the merge is
 * indistinguishable from one written through the detail page.
 *
 * PricingPolicyID is genuinely an NVARCHAR(100) column holding a numeric id —
 * that is how the schema is, and the detail page binds it as an int and lets SQL
 * Server convert. It is also NOT NULL, hence the flag.
 */
export const MERGE_FIELD_COLUMNS: Record<MergeFieldKey, FieldColumn> = {
  Name: { column: 'Name', type: 'string', length: 200, notNull: true },
  BrandName: { column: 'BrandName', type: 'string', length: 100 },
  TaxID: { column: 'TaxID', type: 'string', length: 36 },
  TaxOffice: { column: 'TaxOffice', type: 'string', length: 100 },
  Profession: { column: 'Profession', type: 'string', length: 200 },
  CustomerGroupID: { column: 'CustomerGroupID', type: 'number' },
  PaymentTermID: { column: 'PaymentTermID', type: 'number' },
  ERPID: { column: 'ERPID', type: 'number' },
  ERPCode: { column: 'ERPCode', type: 'string', length: 25 },
  PricingPolicyID: { column: 'PricingPolicyID', type: 'number', notNull: true },
  Importance: { column: 'Importance', type: 'string', length: 100 },
  Address: { column: 'Address', type: 'string', length: 100 },
  AddressNo: { column: 'AddressNo', type: 'string', length: 10 },
  PostalCode: { column: 'PostalCode', type: 'string', length: 30 },
  CountryID: { column: 'CountryID', type: 'number' },
  City: { column: 'City', type: 'string', length: 200 },
  Phone: { column: 'Phone', type: 'string', length: 40 },
  Email: { column: 'Email', type: 'string', length: 100 },
  WebSite: { column: 'WebSite', type: 'string', length: 100 },
  Notes: { column: 'Notes', type: 'string' },
};

export const bindMergeField = (
  request: SqlRequest,
  paramName: string,
  field: MergeFieldKey,
  value: string | number | null,
): void => {
  const config = MERGE_FIELD_COLUMNS[field];
  if (config.type === 'number') {
    request.input(paramName, sql.Int, value === null || value === '' ? null : Number(value));
    return;
  }
  request.input(
    paramName,
    config.length ? sql.NVarChar(config.length) : sql.NVarChar(sql.MAX),
    value === null || value === '' ? null : String(value),
  );
};

const buildIdList = (request: SqlRequest, prefix: string, ids: readonly number[]): string => {
  const names = ids.map((id, index) => {
    const name = `${prefix}${index}`;
    request.input(name, sql.Int, id);
    return `@${name}`;
  });
  // An empty IN () is a syntax error; SELECT NULL never matches, which is the
  // behaviour every caller wants for an empty set.
  return names.length > 0 ? names.join(', ') : 'SELECT NULL';
};

export const fetchMergeCustomers = async (
  pool: ConnectionPool,
  ids: readonly number[],
  columns: CustomerOptionalColumns,
): Promise<MergeCustomerRecord[]> => {
  if (ids.length === 0) return [];
  const request = pool.request();
  const idList = buildIdList(request, 'cid', ids);

  const paymentTermIdExpr = columns.paymentTermId ? 'c.PaymentTermID' : 'CAST(NULL AS int)';
  const paymentTermNameExpr = columns.paymentTermId && columns.paymentTermsTable
    ? 'pt.Name'
    : 'CAST(NULL AS nvarchar(100))';
  const paymentTermJoin = columns.paymentTermId && columns.paymentTermsTable
    ? 'LEFT JOIN dbo.PaymentTerms AS pt ON pt.ID = c.PaymentTermID'
    : '';
  const erpCodeExpr = columns.erpCode ? 'c.ERPCode' : 'CAST(NULL AS nvarchar(25))';

  const result = await request.query<MergeCustomerRecord>(`
    SELECT
      c.ID AS CustomerID,
      c.Name, c.BrandName, c.TaxID, c.TaxOffice, c.Profession,
      c.CustomerGroupID, cg.Name AS CustomerGroupName,
      ${paymentTermIdExpr} AS PaymentTermID,
      ${paymentTermNameExpr} AS PaymentTermName,
      c.ERPID,
      ${erpCodeExpr} AS ERPCode,
      c.PricingPolicyID, pp.Name AS PricingPolicyName,
      c.Importance, c.Address, c.AddressNo, c.PostalCode,
      c.CountryID, country.Name AS CountryName,
      c.City, c.Phone, c.Email, c.WebSite, c.Notes,
      c.IsParent, c.ParentCustomerID, parent.Name AS ParentCustomerName,
      c.Enabled, c.CreatedOn, c.ModifiedOn,
      ISNULL(offers.n, 0) AS OfferCount,
      ISNULL(contacts.n, 0) AS ContactCount,
      ISNULL(children.n, 0) AS ChildCount
    FROM dbo.Customers AS c
    LEFT JOIN dbo.CustomerGroups AS cg ON cg.ID = c.CustomerGroupID
    LEFT JOIN dbo.PricingPolicies AS pp ON pp.ID = c.PricingPolicyID
    LEFT JOIN dbo.Countries AS country ON country.ID = c.CountryID
    LEFT JOIN dbo.Customers AS parent ON parent.ID = c.ParentCustomerID
    ${paymentTermJoin}
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.Offer AS o WHERE o.CustomerID = c.ID) AS offers
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.Contacts AS k WHERE k.CustomerID = c.ID) AS contacts
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.Customers AS ch WHERE ch.ParentCustomerID = c.ID) AS children
    WHERE c.ID IN (${idList})
  `);
  return result.recordset ?? [];
};

export const fetchMergeContacts = async (
  pool: ConnectionPool,
  customerIds: readonly number[],
): Promise<MergeContactRecord[]> => {
  if (customerIds.length === 0) return [];
  const request = pool.request();
  const idList = buildIdList(request, 'kcid', customerIds);

  const result = await request.query<Omit<MergeContactRecord, 'duplicateKey'>>(`
    SELECT
      k.ID AS ContactID,
      k.CustomerID,
      k.TitleID, t.Name AS TitleName,
      k.LastName, k.FirstName, k.Position,
      k.Phone, k.Mobile, k.Email, k.SecondEmail,
      k.Importance, k.Enabled,
      ISNULL(offers.n, 0) AS OfferCount,
      ISNULL(mails.n, 0) AS MailCount,
      ISNULL(grouplists.n, 0) AS GroupCount
    FROM dbo.Contacts AS k
    LEFT JOIN dbo.Titles AS t ON t.ID = k.TitleID
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.Offer AS o WHERE o.ContactID = k.ID) AS offers
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.MailContacts AS mc WHERE mc.ContactID = k.ID) AS mails
    OUTER APPLY (SELECT COUNT(*) AS n FROM dbo.ContactsGroupLists AS cgl WHERE cgl.ContactID = k.ID) AS grouplists
    WHERE k.CustomerID IN (${idList})
    ORDER BY k.LastName, k.FirstName, k.ID
  `);

  return (result.recordset ?? []).map((row) => ({
    ...row,
    duplicateKey: contactDuplicateKey(row),
  }));
};

/**
 * The primary's ancestor chain, primary itself excluded.
 *
 * The merge repoints every child of a secondary onto the primary. If one of
 * those children is an ancestor of the primary, that repoint closes a loop
 * (primary -> P1 -> primary) and every later parent walk spins. These ids are
 * therefore excluded from the repoint and have their link cleared instead.
 * The depth guard also means an already-cyclic row cannot hang this query.
 */
export const fetchAncestorIds = async (
  pool: ConnectionPool,
  primaryId: number,
): Promise<number[]> => {
  const result = await pool
    .request()
    .input('primaryId', sql.Int, primaryId)
    .query<{ ID: number }>(`
      WITH chain AS (
        SELECT c.ID, c.ParentCustomerID, 0 AS depth
        FROM dbo.Customers AS c
        WHERE c.ID = @primaryId
        UNION ALL
        SELECT p.ID, p.ParentCustomerID, chain.depth + 1
        FROM dbo.Customers AS p
        INNER JOIN chain ON p.ID = chain.ParentCustomerID
        WHERE chain.depth < 20
      )
      SELECT DISTINCT ID FROM chain WHERE ID <> @primaryId
      OPTION (MAXRECURSION 25)
    `);
  return (result.recordset ?? []).map((row) => row.ID);
};


/** Parses a client-supplied id array, dropping anything that is not an id. */
export const collectMergeIds = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const unique = new Set<number>();
  value.forEach((entry) => {
    const id = normalizeId(entry);
    if (id != null) unique.add(id);
  });
  return Array.from(unique);
};

// Re-exported so the merge routes keep one import for their shared pieces.
export { MAX_MERGE_SECONDARIES };
