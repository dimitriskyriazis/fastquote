/**
 * Shared contract between the customer-merge screens and their API routes.
 *
 * The merge is deliberately non-destructive. Nothing is deleted: the surviving
 * (primary) customer takes the field values the user picked, the contacts the
 * user chose to keep, every offer, and every child customer; the secondaries are
 * then set Enabled = 0 and left otherwise intact, still carrying whatever
 * contacts were NOT kept. A mistake is undone by re-enabling the secondary and
 * moving things back — nothing has to be recovered from a backup.
 */

/**
 * Upper bound on how many customers can be folded into one primary in a single
 * pass. Sized to fit the largest group the duplicate scanner can produce
 * (MAX_GROUP_SIZE = 25 members, so 24 secondaries), because a suggestion the
 * user cannot act on is worse than no suggestion.
 *
 * This lives here rather than next to the merge SQL because the customers grid
 * needs it to label its context-menu item, and that is a client component —
 * importing it from lib/customerMergeSql would drag the mssql driver into the
 * browser bundle and fail the build.
 */
export const MAX_MERGE_SECONDARIES = 24;

export type MergeFieldKey =
  | 'Name'
  | 'BrandName'
  | 'TaxID'
  | 'TaxOffice'
  | 'Profession'
  | 'CustomerGroupID'
  | 'PaymentTermID'
  | 'ERPID'
  | 'ERPCode'
  | 'PricingPolicyID'
  | 'Importance'
  | 'Address'
  | 'AddressNo'
  | 'PostalCode'
  | 'CountryID'
  | 'City'
  | 'Phone'
  | 'Email'
  | 'WebSite'
  | 'Notes';

export type MergeFieldDescriptor = {
  field: MergeFieldKey;
  label: string;
  /**
   * Where the human-readable value lives on the record, when the stored value is
   * an id. The picker shows this; the payload sends the id.
   */
  displayField?: keyof MergeCustomerRecord;
  /** NOT NULL in dbo.Customers — the picker must never resolve it to empty. */
  required?: boolean;
  multiline?: boolean;
};

/**
 * The fields offered for side-by-side resolution, in display order.
 *
 * IsParent, ParentCustomerID and Enabled are intentionally absent: the merge
 * derives all three itself (children are repointed, so the survivor's IsParent
 * follows from whether it ends up with any; Enabled is what the merge sets on
 * the losers). Letting a user pick them here would fight the transaction.
 */
export const MERGE_FIELDS: readonly MergeFieldDescriptor[] = [
  { field: 'Name', label: 'Customer Name', required: true },
  { field: 'BrandName', label: 'Official Name' },
  { field: 'TaxID', label: 'Tax ID' },
  { field: 'TaxOffice', label: 'Tax Office' },
  { field: 'Profession', label: 'Profession' },
  { field: 'CustomerGroupID', label: 'Customer Group', displayField: 'CustomerGroupName' },
  { field: 'PaymentTermID', label: 'Payment Terms', displayField: 'PaymentTermName' },
  { field: 'PricingPolicyID', label: 'Pricing Policy', displayField: 'PricingPolicyName', required: true },
  { field: 'ERPID', label: 'ERP ID' },
  { field: 'ERPCode', label: 'ERP Code' },
  { field: 'Importance', label: 'Importance' },
  { field: 'CountryID', label: 'Country', displayField: 'CountryName' },
  { field: 'City', label: 'City' },
  { field: 'Address', label: 'Address' },
  { field: 'AddressNo', label: 'Address No' },
  { field: 'PostalCode', label: 'Postal Code' },
  { field: 'Phone', label: 'Phone' },
  { field: 'Email', label: 'Email' },
  { field: 'WebSite', label: 'Web Site' },
  { field: 'Notes', label: 'Notes', multiline: true },
];

export type MergeCustomerRecord = {
  CustomerID: number;
  Name: string | null;
  BrandName: string | null;
  TaxID: string | null;
  TaxOffice: string | null;
  Profession: string | null;
  CustomerGroupID: number | null;
  CustomerGroupName: string | null;
  /** Null when the PaymentTerms migration has not been applied to this database. */
  PaymentTermID: number | null;
  PaymentTermName: string | null;
  ERPID: number | null;
  /** Null when the ERPCode migration has not been applied to this database. */
  ERPCode: string | null;
  PricingPolicyID: number | null;
  PricingPolicyName: string | null;
  Importance: string | null;
  Address: string | null;
  AddressNo: string | null;
  PostalCode: string | null;
  CountryID: number | null;
  CountryName: string | null;
  City: string | null;
  Phone: string | null;
  Email: string | null;
  WebSite: string | null;
  Notes: string | null;
  IsParent: boolean | number | null;
  ParentCustomerID: number | null;
  ParentCustomerName: string | null;
  Enabled: boolean | number | null;
  CreatedOn: string | null;
  ModifiedOn: string | null;
  /** Offers pointing at this customer — all of them move to the primary. */
  OfferCount: number;
  /** Contacts currently filed under this customer. */
  ContactCount: number;
  /** Customers whose ParentCustomerID points here. */
  ChildCount: number;
};

export type MergeContactRecord = {
  ContactID: number;
  CustomerID: number;
  TitleID: number | null;
  TitleName: string | null;
  LastName: string | null;
  FirstName: string | null;
  Position: string | null;
  Phone: string | null;
  Mobile: string | null;
  Email: string | null;
  SecondEmail: string | null;
  Importance: string | null;
  Enabled: boolean | number | null;
  /** Offers whose ContactID points at this contact. dbo.Offer has no FK here. */
  OfferCount: number;
  /** Rows in dbo.MailContacts — marketing send history. */
  MailCount: number;
  /** Rows in dbo.ContactsGroupLists — mailing-list membership. */
  GroupCount: number;
  /**
   * Contacts sharing this key look like the same person. Empty when the contact
   * has nothing distinctive to match on.
   */
  duplicateKey: string;
};

export type MergePreviewRequest = {
  primaryId: number;
  secondaryIds: number[];
};

export type MergePreview = {
  primary: MergeCustomerRecord;
  secondaries: MergeCustomerRecord[];
  /** Every contact on the primary and on all secondaries. */
  contacts: MergeContactRecord[];
  /** Fields actually present in this database, in display order. */
  fields: MergeFieldDescriptor[];
  totals: {
    offersToRepoint: number;
    childrenToRepoint: number;
    contactsOnSecondaries: number;
  };
  /** Things the user should read before committing. Not blocking. */
  warnings: string[];
};

export type MergeCommitRequest = {
  primaryId: number;
  secondaryIds: number[];
  /** Field -> chosen value. Only fields in MERGE_FIELDS are honoured. */
  fieldValues: Partial<Record<MergeFieldKey, string | number | null>>;
  /** Contacts currently on a SECONDARY that should move to the primary. */
  contactIdsToKeep: number[];
  /**
   * Every contact the user unticked, on the primary or on a secondary, to be
   * switched off (Enabled = 0).
   *
   * Disabling rather than "just leaving it there" is what makes unticking mean
   * one thing everywhere. The marketing exports filter on `Contacts.Enabled` but
   * NOT on `Customers.Enabled` (the customer join is only there for the name
   * column), so a contact merely left behind on a disabled customer stays in its
   * groups and keeps being mailed — which is the opposite of what unticking a
   * duplicate is meant to achieve.
   *
   * Nothing is destroyed: the row, its group memberships, its mail history and
   * any offer pointing at it all stay, and re-enabling the contact undoes it.
   */
  contactIdsToDisable: number[];
};

export type MergeCommitResult = {
  ok: true;
  primaryId: number;
  secondaryIds: number[];
  moved: {
    contacts: number;
    offers: number;
    children: number;
  };
  /** Customers switched off. */
  disabled: number;
  /** Contacts on the primary switched off at the user's request. */
  disabledContacts: number;
  fieldsUpdated: MergeFieldKey[];
  warnings: string[];
};

/**
 * Comparison key for spotting the same person filed under two customers.
 *
 * Email is the only genuinely reliable signal, so it wins when present. Falling
 * back to the name alone would collapse the many real cases of two different
 * people with a common Greek surname, so the fallback needs the mobile too.
 */
export const contactDuplicateKey = (contact: {
  Email?: string | null;
  LastName?: string | null;
  FirstName?: string | null;
  Mobile?: string | null;
}): string => {
  const email = (contact.Email ?? '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const name = `${(contact.LastName ?? '').trim()} ${(contact.FirstName ?? '').trim()}`
    .trim()
    .toLowerCase();
  const mobile = (contact.Mobile ?? '').replace(/\D/g, '');
  if (name && mobile) return `name+mobile:${name}|${mobile}`;
  return '';
};
