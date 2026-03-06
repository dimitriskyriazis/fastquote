/**
 * Shared normalization utilities for API route input handling.
 *
 * These functions replace the identical copies previously defined inline
 * in 10+ individual route files.
 */

export const normalizeId = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export const normalizeString = (value: unknown, maxLength = 500): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const str = String(value);
    return str.length > maxLength ? str.slice(0, maxLength) : str;
  }
  return null;
};

export const normalizeInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isInteger(parsed)) return parsed;
  }
  return null;
};

export const normalizeUserId = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number') {
    const str = String(value);
    return str.trim() || null;
  }
  return null;
};

export const normalizeDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

export const normalizeProbability = (
  value: unknown,
  min = 0,
  max = 100,
): number | null => {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) return null;
    return value >= min && value <= max ? value : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (!/^-?\d+$/.test(trimmed)) return null;
    const parsed = Number.parseInt(trimmed, 10);
    if (!Number.isInteger(parsed)) return null;
    return parsed >= min && parsed <= max ? parsed : null;
  }
  return null;
};

export const normalizeDecimal = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};
