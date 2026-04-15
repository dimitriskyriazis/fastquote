import type { DropdownOption } from '../../../lib/dropdownOptions';

export type OfferBasicRecord = {
  OfferID: number | null;
  OfferVersion: number | null;
  CustomerID: number | null;
  SalesDivisionID: number | null;
  StatusID: number | null;
  PricingPolicyID: number | null;
  MarketID: number | null;
  Title: string | null;
  Description: string | null;
  PaymentTerms: string | null;
  InstallationSchedule: string | null;
  OfferNotesClosing: string | null;
  OfferValidity: string | null;
  DeliveryTime: string | null;
  OfferNotesIntroduction: string | null;
  TelmacoNote: string | null;
  OfferContact: string | null;
  ContactID: number | null;
  ContactFullName: string | null;
  CustomerName: string | null;
  StatusName: string | null;
  PricingPolicyName: string | null;
  MarketName: string | null;
  SalesDivisionName: string | null;
  SalesCreationPersonName: string | null;
  SalesCreationPersonUserName: string | null;
  SalesCreationPersonId: string | null;
  SalesPersonName: string | null;
  SalesPersonUserName: string | null;
  ApprovalUserName: string | null;
  ApprovalUserUserName: string | null;
  SalesPersonId: string | null;
  ApprovalUserId: string | null;
  ERPProjectCode: string | null;
  ERPFWCProjectID: number | null;
  Probability: number | null;
  CustomerRef: string | null;
  DraftRequestDate: Date | string | null;
  DraftOfferDate: Date | string | null;
  RequestDate: Date | string | null;
  OfferDeadlineDate: Date | string | null;
  OrderSignedDate: Date | string | null;
  DeliveryDueDate: Date | string | null;
  PossibleOrderDate: Date | string | null;
  OfferDate: Date | string | null;
  ModifiedOn: Date | string | null;
  ModifiedByUserName: string | null;
  ModifiedByFullName: string | null;
  ProtocolNo: number | null;
};

export type OfferContactInfo = {
  ContactID: number;
  FirstName: string | null;
  LastName: string | null;
  FullName: string;
};

export type OfferDropdownOption = DropdownOption;

export type MarketOption = OfferDropdownOption & { salesDivisionId: string };

export type OfferBasicUpdateField =
  | 'CustomerID'
  | 'SalesDivisionID'
  | 'CreatedBy'
  | 'Title'
  | 'Description'
  | 'PaymentTerms'
  | 'InstallationSchedule'
  | 'OfferNotesClosing'
  | 'OfferValidity'
  | 'DeliveryTime'
  | 'OfferNotesIntroduction'
  | 'Comments'
  | 'OfferContact'
  | 'ContactID'
  | 'StatusID'
  | 'PricingPolicyID'
  | 'MarketID'
  | 'SalesPersonId'
  | 'ApprovalUserId'
  | 'ERPProjectCode'
  | 'ERPFWCProjectID'
  | 'Probability'
  | 'CustomerRef'
  | 'DraftRequestDate'
  | 'DraftOfferDate'
  | 'RequestDate'
  | 'OfferDeadlineDate'
  | 'OrderSignedDate'
  | 'DeliveryDueDate'
  | 'PossibleOrderDate'
  | 'OfferDate'
  | 'ProtocolNo';
