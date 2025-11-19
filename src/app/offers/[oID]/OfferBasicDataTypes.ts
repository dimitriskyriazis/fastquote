export type OfferBasicRecord = {
  OfferID: number | null;
  CustomerID: number | null;
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
  CustomerName: string | null;
  StatusName: string | null;
  PricingPolicyName: string | null;
  MarketName: string | null;
  SalesDivisionName: string | null;
  SalesCreationPersonName: string | null;
  SalesCreationPersonUserName: string | null;
  SalesPersonName: string | null;
  SalesPersonUserName: string | null;
  ApprovalUserName: string | null;
  ApprovalUserUserName: string | null;
  SalesPersonId: string | null;
  ApprovalUserId: string | null;
  DefaultCalcMethodFormulasID: string | number | null;
  ProjectID: number | null;
  CustomerRef: string | null;
  InitialRequest: Date | string | null;
  DraftOffer: Date | string | null;
  OfficialRequest: Date | string | null;
  OfferDeadline: Date | string | null;
  OfficialQuoteOffer: Date | string | null;
  OrderSigned: Date | string | null;
  DeliveryDue: Date | string | null;
  Delivery: Date | string | null;
  OfferDate: Date | string | null;
};

export type OfferContactInfo = {
  ContactID: number;
  FirstName: string | null;
  LastName: string | null;
  FullName: string;
};

export type OfferDropdownOption = {
  value: string;
  label: string;
};

export type OfferBasicUpdateField =
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
  | 'StatusID'
  | 'PricingPolicyID'
  | 'MarketID'
  | 'SalesPersonId'
  | 'ApprovalUserId'
  | 'DefaultCalcMethodFormulasID'
  | 'ProjectID'
  | 'CustomerRef'
  | 'InitialRequest'
  | 'DraftOffer'
  | 'OfficialRequest'
  | 'OfferDeadline'
  | 'OfficialQuoteOffer'
  | 'OrderSigned'
  | 'DeliveryDue'
  | 'Delivery'
  | 'OfferDate';
