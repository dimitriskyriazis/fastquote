/**
 * Normalizes various boolean representations to a boolean value.
 * Handles numbers (1/0), booleans, strings ("true"/"false", "Yes"/"No", "1"/"0"), etc.
 * @param value - The value to normalize
 * @returns true for truthy boolean values, false otherwise
 */
export function normalizeBoolean(value: unknown): boolean {
  if (value === 1 || value === true || value === "true" || value === "Yes" || value === "1") return true;
  if (value === 0 || value === false || value === "false" || value === "No" || value === "0") return false;
  return false;
}
