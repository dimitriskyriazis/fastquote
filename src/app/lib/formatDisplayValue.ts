/**
 * Formats a value for display in read-only fields or labels.
 * Handles dates, strings, booleans, and other types consistently.
 * @param value - The value to format
 * @returns Formatted string for display, or '—' for empty/null values
 */
export function formatDisplayValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  
  if (value instanceof Date) {
    return value.toLocaleDateString("en-GB", { 
      day: "2-digit", 
      month: "2-digit", 
      year: "numeric" 
    });
  }
  
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '—';
  }
  
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No';
  }
  
  return String(value);
}
