import type { DropdownOption } from './dropdownOptions';

export type PricingPolicyRuleOption = DropdownOption & {
  brandId: number | null;
  brandName: string | null;
  pricingPolicyId: number | null;
  pricingPolicyName: string | null;
  telmacoDiscountPercentage?: number | null;
  customerDiscountPercentage?: number | null;
};
