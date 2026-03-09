import type { DropdownOption } from '../../../lib/dropdownOptions';

export type PriceListBasicRecord = {
  PriceListID: number | null;
  Name: string | null;
  ValidFromDate: Date | string | null;
  ValidToDate: Date | string | null;
  Comments: string | null;
  ValidityComment: string | null;
  Enabled: boolean | number | null;
  FilePath: string | null;
  BrandID: number | null;
  BrandName: string | null;
  CountryId: number | null;
  CountryName: string | null;
  SupplierID: number | null;
  SupplierName: string | null;
  CurrencyId: number | null;
  CurrencyName: string | null;
  CostCurrencyID: number | null;
  CostCurrencyName: string | null;
  CurrencyCostModifier: number | null;
  ResponsibleUserId: string | null;
  ResponsibleUserName: string | null;
  HasDuty: boolean | number | null;
  PricingPolicyID: number | null;
  PricingPolicyName: string | null;
  ModifiedOn: Date | string | null;
  ModifiedByUserId: string | null;
  ModifiedByUserName: string | null;
  ModifiedByFullName: string | null;
};

export type PriceListDropdownOption = DropdownOption;

export type PriceListPricingPolicy = {
  brandId: number;
  pricingPolicyId: number;
  name: string | null;
};

export type PricingPoliciesByBrand = Record<string, PriceListPricingPolicy[]>;

export type PriceListPricingPolicyEntry = {
  id: number;
  priceListId: number;
  pricingPolicyId: number;
  pricingPolicyName: string | null;
  pricingPolicyRuleId: number | null;
  pricingPolicyRuleName: string | null;
};

export type PriceListBasicUpdateField =
  | "Name"
  | "ValidFromDate"
  | "ValidToDate"
  | "Comments"
  | "ValidityComment"
  | "FilePath"
  | "BrandID"
  | "CountryId"
  | "SupplierID"
  | "CurrencyId"
  | "CostCurrencyID"
  | "CurrencyCostModifier"
  | "ResponsibleUserId"
  | "Enabled"
  | "HasDuty";
