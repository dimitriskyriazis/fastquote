import { describe, it, expect } from 'vitest';
import {
  buildOfferDiscountInfo,
  discountPayload,
  discountedUnitPrice,
  planDiscount,
  resolveDiscountFraction,
  round2,
} from '../offerDiscount';

const lines = (...pairs: Array<[qty: number, price: number]>) =>
  pairs.map(([qty, price]) => ({ qty, price }));

describe('resolveDiscountFraction', () => {
  it('reads a percentage straight off the header', () => {
    expect(resolveDiscountFraction(5, 'pct', 10_000)).toBeCloseTo(0.05, 12);
    expect(resolveDiscountFraction(12.5, 'pct', 0)).toBeCloseTo(0.125, 12);
  });

  it('spreads an absolute amount proportionally over the offer net', () => {
    // €1.000 off a €10.000 offer = 10% of every line it touches.
    expect(resolveDiscountFraction(1000, 'abs', 10_000)).toBeCloseTo(0.1, 12);
  });

  it('treats an absolute amount with no net basis as no discount', () => {
    // Nothing to spread it over — applying it in full to a subset of the lines
    // would over-discount, so it resolves to nothing instead.
    expect(resolveDiscountFraction(1000, 'abs', 0)).toBe(0);
  });

  it('ignores missing, zero and negative values', () => {
    expect(resolveDiscountFraction(null, 'pct', 100)).toBe(0);
    expect(resolveDiscountFraction(undefined, 'pct', 100)).toBe(0);
    expect(resolveDiscountFraction(0, 'pct', 100)).toBe(0);
    expect(resolveDiscountFraction(-5, 'pct', 100)).toBe(0);
    expect(resolveDiscountFraction(Number.NaN, 'pct', 100)).toBe(0);
  });

  it('never removes more than the value being discounted', () => {
    expect(resolveDiscountFraction(150, 'pct', 1000)).toBe(1);
    expect(resolveDiscountFraction(5000, 'abs', 1000)).toBe(1);
  });
});

describe('buildOfferDiscountInfo', () => {
  it('flags an offer with no additional discount', () => {
    const info = buildOfferDiscountInfo(null, 'pct', 5000);
    expect(info.hasDiscount).toBe(false);
    expect(info.fraction).toBe(0);
    expect(info.value).toBe(0);
  });

  it('keeps the raw header value alongside the derived fraction', () => {
    const info = buildOfferDiscountInfo(1500, 'abs', 30_000);
    expect(info.hasDiscount).toBe(true);
    expect(info.value).toBe(1500);
    expect(info.mode).toBe('abs');
    expect(info.fraction).toBeCloseTo(0.05, 12);
  });
});

describe('planDiscount', () => {
  const pct10 = buildOfferDiscountInfo(10, 'pct', 0);

  it('is a no-op when the offer has no additional discount', () => {
    const plan = planDiscount(buildOfferDiscountInfo(0, 'pct', 0), null, lines([2, 100], [1, 50]));
    expect(plan).toEqual({
      allocation: null,
      subtotalBeforeDiscount: 250,
      discountAmount: 0,
      subtotalAfterDiscount: 250,
      documentDiscount: null,
    });
  });

  it('sends the amount on the header for the document allocation', () => {
    const plan = planDiscount(pct10, 'document', lines([2, 100], [1, 50]));
    expect(plan.subtotalBeforeDiscount).toBe(250);
    expect(plan.discountAmount).toBe(25);
    expect(plan.subtotalAfterDiscount).toBe(225);
    // Prices stay as quoted, so the discount has to ride on the document.
    expect(plan.documentDiscount).toBe(25);
  });

  it('bakes the discount into the unit prices for the lines allocation', () => {
    const plan = planDiscount(pct10, 'lines', lines([2, 100], [1, 50]));
    expect(plan.subtotalBeforeDiscount).toBe(250);
    expect(plan.subtotalAfterDiscount).toBe(225);
    expect(plan.discountAmount).toBe(25);
    // Nothing goes on the header — the prices already carry it.
    expect(plan.documentDiscount).toBeNull();
  });

  it('reports the lines allocation from the rounded prices actually transmitted', () => {
    // 3,33 € less 10% = 2,997 → 3,00 at the 2 decimals a unit price carries, so
    // the achievable discount is 0,99 € rather than the nominal 1,00 €.
    const info = buildOfferDiscountInfo(10, 'pct', 0);
    const rows = lines([1, 3.33], [1, 3.33], [1, 3.34]);

    const intoLines = planDiscount(info, 'lines', rows);
    expect(intoLines.subtotalBeforeDiscount).toBe(10);
    expect(intoLines.subtotalAfterDiscount).toBe(9.01);
    expect(intoLines.discountAmount).toBe(0.99);

    const intoDocument = planDiscount(info, 'document', rows);
    expect(intoDocument.discountAmount).toBe(1);
    expect(intoDocument.subtotalAfterDiscount).toBe(9);

    // The residual the wizard warns about: the two options can't always land on
    // the same cent.
    expect(intoLines.subtotalAfterDiscount - intoDocument.subtotalAfterDiscount).toBeCloseTo(0.01, 12);
  });

  it('rounds each line the way setDocs receives it', () => {
    // A fractional quantity makes round-then-sum differ from sum-then-round, and
    // setDocs gets one rounded `lineval` per line — so the plan must round per
    // line too. 0,5 × 10,01 = 5,005 → 5,00 per line → 10,00, where summing first
    // would have reported 10,01.
    const plan = planDiscount(buildOfferDiscountInfo(0, 'pct', 0), null, lines([0.5, 10.01], [0.5, 10.01]));
    expect(plan.subtotalBeforeDiscount).toBe(10);
  });

  it('zeroes the document when the discount is clamped to 100%', () => {
    const plan = planDiscount(buildOfferDiscountInfo(150, 'pct', 0), 'lines', lines([2, 100]));
    expect(plan.subtotalAfterDiscount).toBe(0);
    expect(plan.discountAmount).toBe(200);
  });

  it('leaves an empty pre-order at zero', () => {
    const plan = planDiscount(pct10, 'document', []);
    expect(plan.subtotalBeforeDiscount).toBe(0);
    expect(plan.discountAmount).toBe(0);
    expect(plan.subtotalAfterDiscount).toBe(0);
    expect(plan.documentDiscount).toBe(0);
  });

  it('previews the nominal amount before an allocation is chosen', () => {
    const plan = planDiscount(pct10, null, lines([1, 200]));
    expect(plan.discountAmount).toBe(20);
    // Nothing is committed to the header until the user actually picks 'document'.
    expect(plan.documentDiscount).toBeNull();
  });
});

describe('discountedUnitPrice', () => {
  it('rounds to the 2 decimals a Soft1 unit price carries', () => {
    expect(discountedUnitPrice(3.33, 0.1)).toBe(3);
    expect(discountedUnitPrice(100, 0.075)).toBe(92.5);
    expect(discountedUnitPrice(19.99, 0.05)).toBe(18.99);
  });

  it('returns the price untouched for a zero fraction', () => {
    expect(discountedUnitPrice(123.45, 0)).toBe(123.45);
  });
});

describe('round2', () => {
  it('matches the scale used when emitting decimals to SoftOne', () => {
    expect(round2(12.344)).toBe(12.34);
    expect(round2(12.346)).toBe(12.35);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('rounds the stored binary value, exactly like toErpDecimal', () => {
    // Deliberately pinned: a "half" that is really below half in binary (2.675 is
    // stored as 2.67499…) rounds down. round2 goes through the same toFixed the
    // ERP payload does, so a reported total can never disagree with what was sent.
    expect(round2(2.675)).toBe(2.67);
    expect(round2(1.005)).toBe(1);
    expect(round2(2.675)).toBe(Number((2.675).toFixed(2)));
  });
});

describe('discountPayload', () => {
  it('exposes an absolute discount as a percentage for the UI', () => {
    const payload = discountPayload(buildOfferDiscountInfo(1500, 'abs', 30_000));
    expect(payload).toEqual({ hasDiscount: true, value: 1500, mode: 'abs', fractionPct: 5 });
  });

  it('reports nothing to allocate when the offer has no discount', () => {
    const payload = discountPayload(buildOfferDiscountInfo(null, 'pct', 0));
    expect(payload.hasDiscount).toBe(false);
    expect(payload.fractionPct).toBe(0);
  });
});
