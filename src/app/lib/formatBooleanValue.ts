/**
 * Formats a boolean value for display in the UI.
 * @param value - The value to format (can be number, boolean, string, or null/undefined)
 * @returns "Yes" for truthy values, "No" for falsy values, or empty string for null/undefined
 */
export function formatBooleanValue(value: unknown): string {
  if (value === 1 || value === true || value === "true") return "Yes";
  if (value === 0 || value === false || value === "false") return "No";
  return value == null ? "" : String(value);
}
