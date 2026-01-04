export type PriceListDecimalFormat = "auto" | "dotDecimal" | "commaDecimal";

export const DEFAULT_PRICE_LIST_DECIMAL_FORMAT: PriceListDecimalFormat = "auto";

const PRICE_LIST_DECIMAL_FORMAT_ALIASES: Record<string, PriceListDecimalFormat> = {
  auto: "auto",
  dotdecimal: "dotDecimal",
  "dot-decimal": "dotDecimal",
  "dot_decimal": "dotDecimal",
  commadecimal: "commaDecimal",
  "comma-decimal": "commaDecimal",
  "comma_decimal": "commaDecimal",
};

export const normalizePriceListDecimalFormat = (value: unknown): PriceListDecimalFormat => {
  if (typeof value !== "string") {
    return DEFAULT_PRICE_LIST_DECIMAL_FORMAT;
  }
  const normalized = value.trim().toLowerCase();
  return PRICE_LIST_DECIMAL_FORMAT_ALIASES[normalized] ?? DEFAULT_PRICE_LIST_DECIMAL_FORMAT;
};

export const PRICE_LIST_DECIMAL_FORMAT_OPTIONS: Array<{
  value: Exclude<PriceListDecimalFormat, "auto">;
  label: string;
  description: string;
}> = [
  {
    value: "dotDecimal",
    label: "1,000.00",
    description: "Comma thousands, dot decimals (English-style)",
  },
  {
    value: "commaDecimal",
    label: "1.000,00",
    description: "Dot thousands, comma decimals (European-style)",
  },
];

