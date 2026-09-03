import type { DropdownOption } from '../../../lib/dropdownOptions';

export type OfferBasicRecord = {
  OfferID: number | null;
  OfferVersion: number | null;
  CustomerID: number | null;
  SalesDivisionID: number | null;
  StatusID: number | null;
  PricingPolicyID: number | null;
  MarketID: number | null;
  CurrencyID: number | null;
  CurrencyModifier: number | null;
  CurrencyName: string | null;
  Title: string | null;
  Description: string | null;
  OfferDescription: string | null;
  PaymentTerms: string | null;
  // WHICH catalogue term applies (dbo.PaymentTerms.ID). PaymentTerms above is
  // the printed snapshot of its description, or free text when the term is OTHER.
  PaymentTermID: number | null;
  PaymentTermName: string | null;
  InstallationSchedule: string | null;
  OfferNotesClosing: string | null;
  OfferValidity: string | null;
  DeliveryTime: string | null;
  OfferNotesIntroduction: string | null;
  DiscountNote: string | null;
  TelmacoNote: string | null;
  OfferContact: string | null;
  DiscountLabel: string | null;
  AdditionalDiscountLabel: string | null;
  FinalPriceLabel: string | null;
  OfferLanguage: string | null;
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
  ServicesLocation: string | null;
  PricingSellAnchor: string | null;
  PricingHoldMarginOnCost: boolean | null;
  ExtraNetDiscount: number | null;
  ExtraNetDiscountMode: string | null;
  IsTelvin: boolean | null;
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
  | 'OfferDescription'
  | 'PaymentTerms'
  | 'PaymentTermID'
  | 'InstallationSchedule'
  | 'OfferNotesClosing'
  | 'OfferValidity'
  | 'DeliveryTime'
  | 'OfferNotesIntroduction'
  | 'DiscountNote'
  | 'Comments'
  | 'OfferContact'
  | 'DiscountLabel'
  | 'AdditionalDiscountLabel'
  | 'FinalPriceLabel'
  | 'OfferLanguage'
  | 'ContactID'
  | 'StatusID'
  | 'PricingPolicyID'
  | 'MarketID'
  | 'CurrencyModifier'
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
  | 'ProtocolNo'
  | 'ServicesLocation'
  | 'PricingSellAnchor'
  | 'PricingHoldMarginOnCost'
  | 'ExtraNetDiscount'
  | 'ExtraNetDiscountMode'
  | 'IsTelvin';

// A payment-term dropdown option. Both descriptions travel with it so the form
// can show the text that will be printed, in the offer's language, without a
// round trip.
export type PaymentTermOption = OfferDropdownOption & {
  descriptionGr: string;
  descriptionEn: string;
};
