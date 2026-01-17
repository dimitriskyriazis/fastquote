const DATE_TIME_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: "medium",
  timeStyle: "short",
  hour12: false,
};

/**
 * Formats a date/time value for display with medium date and short time style.
 * @param value - Date value (Date object, string, or null/undefined)
 * @returns Formatted date/time string or "Unknown time" if invalid
 */
export function formatDateTime(value?: string | Date | null) {
  if (value == null) return "Unknown time";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return date.toLocaleString("en-GB", DATE_TIME_FORMAT_OPTIONS);
}

/**
 * Formats a date value in UK format (DD/MM/YYYY).
 * @param value - Date value (Date object, string, number, or null/undefined)
 * @returns Formatted date string in DD/MM/YYYY format, or empty string if invalid
 */
export function formatDateUK(value: unknown): string {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value as string | number);
  if (Number.isNaN(date.getTime())) {
    // If it's not a valid date, return the original value as string if it exists
    return value != null ? String(value) : "";
  }
  return date.toLocaleDateString("en-GB", { 
    day: "2-digit", 
    month: "2-digit", 
    year: "numeric" 
  });
}
