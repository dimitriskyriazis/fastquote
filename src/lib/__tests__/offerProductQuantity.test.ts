import { describe, expect, it } from 'vitest';
import {
  SERVICE_QUANTITY_DECIMALS,
  SERVICE_TYPE_PER_UNIT,
  allowsFractionalQuantity,
  normalizeQuantityForServiceType,
} from '../offerProductRows';

// Services are quoted in days. The catalogue pairs a `-Lot` lump sum with a
// `-Day` per-unit SKU for nearly every service (Design-Lot / DesignPer-Day,
// Comm-Lot / Comm-Day, ...), and only the ServPerUnit side may hold a fraction.
// dbo.OfferDetails mirrors this as CK_OfferDetails_Quantity_Integral.
describe('allowsFractionalQuantity', () => {
  it('accepts only the per-unit service type', () => {
    expect(allowsFractionalQuantity(SERVICE_TYPE_PER_UNIT)).toBe(true);
    expect(allowsFractionalQuantity('ServLot')).toBe(false);
    expect(allowsFractionalQuantity(null)).toBe(false);
    expect(allowsFractionalQuantity(undefined)).toBe(false);
    expect(allowsFractionalQuantity('')).toBe(false);
  });

  it('tolerates padding from the nvarchar column', () => {
    expect(allowsFractionalQuantity('  ServPerUnit  ')).toBe(true);
  });

  it('is case-sensitive — the stored values are exact', () => {
    expect(allowsFractionalQuantity('servperunit')).toBe(false);
  });
});

describe('normalizeQuantityForServiceType', () => {
  it('keeps half and quarter days on a per-unit service line', () => {
    expect(normalizeQuantityForServiceType(0.5, SERVICE_TYPE_PER_UNIT)).toBe(0.5);
    expect(normalizeQuantityForServiceType(0.25, SERVICE_TYPE_PER_UNIT)).toBe(0.25);
    expect(normalizeQuantityForServiceType(1.75, SERVICE_TYPE_PER_UNIT)).toBe(1.75);
  });

  it('caps a per-unit quantity at the supported decimals', () => {
    expect(normalizeQuantityForServiceType(0.333333, SERVICE_TYPE_PER_UNIT)).toBe(0.33);
    expect(SERVICE_QUANTITY_DECIMALS).toBe(2);
  });

  it('rounds a ServLot lump sum to whole lots', () => {
    expect(normalizeQuantityForServiceType(2.4, 'ServLot')).toBe(2);
    expect(normalizeQuantityForServiceType(2.5, 'ServLot')).toBe(3);
  });

  it('rounds product lines to whole units — they feed Soft1', () => {
    expect(normalizeQuantityForServiceType(1.5, null)).toBe(2);
    expect(normalizeQuantityForServiceType(0.4, undefined)).toBe(0);
    expect(normalizeQuantityForServiceType(27, null)).toBe(27);
  });

  it('never rounds a value that is already whole', () => {
    for (const serviceType of [SERVICE_TYPE_PER_UNIT, 'ServLot', null]) {
      expect(normalizeQuantityForServiceType(3, serviceType)).toBe(3);
      expect(normalizeQuantityForServiceType(0, serviceType)).toBe(0);
    }
  });

  it('returns null for absent or non-finite input so callers keep their own checks', () => {
    expect(normalizeQuantityForServiceType(null, SERVICE_TYPE_PER_UNIT)).toBeNull();
    expect(normalizeQuantityForServiceType(undefined, SERVICE_TYPE_PER_UNIT)).toBeNull();
    expect(normalizeQuantityForServiceType(Number.NaN, SERVICE_TYPE_PER_UNIT)).toBeNull();
    expect(normalizeQuantityForServiceType(Number.POSITIVE_INFINITY, null)).toBeNull();
  });
});
