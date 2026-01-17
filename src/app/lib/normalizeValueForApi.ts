/**
 * Normalizes a string value for API consumption based on the specified type.
 * @param value - The string value to normalize
 * @param type - The type to normalize to ('string', 'number', or 'date')
 * @returns The normalized value, or null if the value is invalid/empty
 */
export function normalizeValueForApi(
  value: string,
  type?: 'string' | 'number' | 'date'
): string | number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  
  if (type === 'number') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  
  if (type === 'date') {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
  }
  
  return trimmed;
}
