import type { DropdownOption } from '../../../lib/dropdownOptions';

export type CustomerBasicRecord = {
  CustomerID: number | null;
  Name: string | null;
  BrandName: string | null;
  TaxID: string | null;
  TaxOffice: string | null;
  Profession: string | null;
  CustomerGroupID: number | null;
  CustomerGroupName: string | null;

  ERPID: string | null;
  IsParent: boolean | number | null;
  ParentCustomerID: number | null;
  ParentCustomerName: string | null;
  PricingPolicyID: number | null;
  PricingPolicyName: string | null;
  Importance: string | null;
  Enabled: boolean | number | null;
  Address: string | null;
  CountryID: number | null;
  CountryName: string | null;
  City: string | null;
  Phone: string | null;
  Email: string | null;
  WebSite: string | null;
  Notes: string | null;
};

export type CustomerDropdownOption = DropdownOption;

export type CustomerBasicUpdateField =
  | 'Name'
  | 'BrandName'
  | 'TaxID'
  | 'TaxOffice'
  | 'Profession'
  | 'CustomerGroupID'

  | 'ERPID'
  | 'IsParent'
  | 'ParentCustomerID'
  | 'PricingPolicyID'
  | 'Importance'
  | 'Enabled'
  | 'Address'
  | 'CountryID'
  | 'City'
  | 'Phone'
  | 'Email'
  | 'WebSite'
  | 'Notes';
