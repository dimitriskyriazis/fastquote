/**
 * Formats a date value for use in HTML date input fields (type="date").
 * Returns ISO format string (YYYY-MM-DD) or empty string if invalid.
 * @param value - Date value (Date object, string, or null/undefined)
 * @returns ISO date string (YYYY-MM-DD) or empty string
 */
export function formatDateInputValue(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString().slice(0, 10);
}
