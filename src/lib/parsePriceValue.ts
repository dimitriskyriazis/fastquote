import type { PriceListDecimalFormat } from "./priceListDecimalFormats";

const looksLikeSingleDecimal = (separatorIdx: number, count: number, length: number) => {
  if (count !== 1) return false;
  const trailing = length - separatorIdx - 1;
  return trailing >= 1 && trailing <= 2;
};

export const formatNumericPortion = (
  numericPortion: string,
  format: PriceListDecimalFormat,
): string => {
  const commaCount = (numericPortion.match(/,/g) || []).length;
  const dotCount = (numericPortion.match(/\./g) || []).length;
  const lastComma = numericPortion.lastIndexOf(",");
  const lastDot = numericPortion.lastIndexOf(".");

  // Both separators present: the right-most one is unambiguously the decimal.
  if (commaCount > 0 && dotCount > 0) {
    if (lastComma > lastDot) {
      return numericPortion.replace(/\./g, "").replace(/,/g, ".");
    }
    return numericPortion.replace(/,/g, "");
  }

  // Single-separator decimal heuristic: a real thousands separator always has
  // exactly 3 trailing digits, so 1-2 trailing digits must be a decimal mark.
  // 3 trailing digits with the user's hint matching the locale → treat as thousands.
  if (format === "dotDecimal") {
    if (commaCount > 0 && dotCount === 0 &&
        looksLikeSingleDecimal(lastComma, commaCount, numericPortion.length)) {
      return numericPortion.replace(",", ".");
    }
    return numericPortion.replace(/,/g, "");
  }
  if (format === "commaDecimal") {
    if (dotCount > 0 && commaCount === 0 &&
        looksLikeSingleDecimal(lastDot, dotCount, numericPortion.length)) {
      return numericPortion;
    }
    return numericPortion.replace(/\./g, "").replace(/,/g, ".");
  }

  // Auto mode: rely on trailing-digit count to disambiguate single separators.
  if (commaCount > 0 && dotCount === 0) {
    if (looksLikeSingleDecimal(lastComma, commaCount, numericPortion.length)) {
      return numericPortion.replace(",", ".");
    }
    return numericPortion.replace(/,/g, "");
  }
  if (dotCount > 0 && commaCount === 0) {
    if (looksLikeSingleDecimal(lastDot, dotCount, numericPortion.length)) {
      return numericPortion;
    }
    return numericPortion.replace(/\./g, "");
  }
  return numericPortion;
};

export const parsePriceValue = (
  value: unknown,
  format: PriceListDecimalFormat,
): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  const numericPortion = raw.replace(/[^\d.,-]/g, "");
  if (!numericPortion) return null;
  const normalized = formatNumericPortion(numericPortion, format);
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

// Sample a column of price-like values and pick the dominant decimal format.
// Returns "dotDecimal" (1,000.00) or "commaDecimal" (1.000,00). Falls back to
// "dotDecimal" if the sample is empty or fully ambiguous (no separators).
export const detectDecimalFormat = (
  values: ReadonlyArray<unknown>,
): Exclude<PriceListDecimalFormat, "auto"> => {
  let dotVotes = 0;
  let commaVotes = 0;

  for (const v of values) {
    if (v == null) continue;
    // Native numbers from xlsx (raw:true) are already locale-free; they don't
    // tell us anything about the source file's format.
    if (typeof v === "number") continue;
    if (typeof v !== "string") continue;
    const numeric = v.replace(/[^\d.,-]/g, "");
    if (!numeric) continue;

    const commaCount = (numeric.match(/,/g) || []).length;
    const dotCount = (numeric.match(/\./g) || []).length;
    const lastComma = numeric.lastIndexOf(",");
    const lastDot = numeric.lastIndexOf(".");

    // Both separators: unambiguous — rightmost is decimal.
    if (commaCount > 0 && dotCount > 0) {
      if (lastComma > lastDot) commaVotes += 2;
      else dotVotes += 2;
      continue;
    }
    // Single separator: trailing digit count is the strongest signal.
    if (commaCount > 0 && dotCount === 0) {
      const trailing = numeric.length - lastComma - 1;
      if (trailing === 3) dotVotes += 1; // looks like US thousands
      else if (trailing === 1 || trailing === 2) commaVotes += 1; // EU decimal
      // 0 or >3 trailing: ambiguous, skip
      continue;
    }
    if (dotCount > 0 && commaCount === 0) {
      const trailing = numeric.length - lastDot - 1;
      if (trailing === 3) commaVotes += 1; // looks like EU thousands
      else if (trailing === 1 || trailing === 2) dotVotes += 1; // US decimal
      continue;
    }
    // No separators: no signal.
  }

  if (commaVotes > dotVotes) return "commaDecimal";
  return "dotDecimal";
};
