/**
 * Offer-level additional discount — the arithmetic used to project it onto a
 * Soft1 pre-order.
 *
 * `Offer.ExtraNetDiscount` / `Offer.ExtraNetDiscountMode` is the offer-wide
 * "Additional Discount" applied on top of the net subtotal (the PDF's «Επιπλέον
 * Έκπτωση» line). It lives on the offer header only — no OfferDetails row carries
 * it — so when a pre-order is created in Soft1 the discount has to be projected
 * onto the document explicitly. The user picks how in the wizard's Discount step:
 *
 *   'lines'    → bake it into each line's unit price; no header discount
 *   'document' → leave unit prices as quoted and send the amount as the document
 *                discount (setDocs `discval`, added to the Telmaco WS 29/07/2026)
 *
 * Kept free of DB/IO so it can be unit-tested; the SQL that loads the header
 * values lives in the create-draft-order-soft1 route.
 */

export type DiscountAllocation = 'lines' | 'document';

export type OfferDiscountInfo = {
  hasDiscount: boolean;
  /** Raw header value — a percentage when mode='pct', euros when mode='abs'. */
  value: number;
  mode: 'pct' | 'abs';
  /**
   * Share of net value the discount removes, as a 0..1 fraction. For 'abs' the
   * euro amount is spread proportionally over the whole offer (products AND
   * services) exactly like the project form does, so a products-only pre-order
   * carries just its own share.
   */
  fraction: number;
  /** Offer net subtotal (products + services) before the additional discount. */
  offerNetBeforeExtra: number;
};

export type DiscountPlan = {
  allocation: DiscountAllocation | null;
  /** Pre-order value at the offer's own unit prices, before this discount. */
  subtotalBeforeDiscount: number;
  /** The pre-order's share of the additional discount, in euros. */
  discountAmount: number;
  /** Document value after the discount, as it will land in Soft1. */
  subtotalAfterDiscount: number;
  /** setDocs `discval` to send — null when the discount is baked into prices. */
  documentDiscount: number | null;
};

/**
 * Rounds to 2 decimals through the same path as orderCreationWS.toErpDecimal, so
 * every euro figure we report is exactly the one transmitted to SoftOne.
 */
export const round2 = (value: number): number => Number(value.toFixed(2));

/** Unit price with the additional discount baked in, at the scale we transmit. */
export const discountedUnitPrice = (price: number, fraction: number): number =>
  round2(price * (1 - fraction));

/**
 * Turns the stored header value into a 0..1 fraction of net value.
 *
 * 'pct' needs no basis. 'abs' is divided by the offer's own net subtotal, which
 * is what spreads the amount proportionally — without a positive basis an
 * absolute amount cannot be placed at all, so it resolves to "no discount"
 * rather than being applied in full to a subset of the lines.
 */
export function resolveDiscountFraction(
  value: number | null | undefined,
  mode: 'pct' | 'abs',
  offerNetBeforeExtra: number,
): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  const fraction = mode === 'abs'
    ? (offerNetBeforeExtra > 0 ? value / offerNetBeforeExtra : 0)
    : value / 100;
  if (!Number.isFinite(fraction) || fraction <= 0) return 0;
  // A discount can never remove more than the value it discounts.
  return Math.min(fraction, 1);
}

export function buildOfferDiscountInfo(
  value: number | null | undefined,
  mode: 'pct' | 'abs',
  offerNetBeforeExtra: number,
): OfferDiscountInfo {
  const fraction = resolveDiscountFraction(value, mode, offerNetBeforeExtra);
  return {
    hasDiscount: fraction > 0,
    value: value != null && Number.isFinite(value) ? value : 0,
    mode,
    fraction,
    offerNetBeforeExtra,
  };
}

/**
 * Works out what the discount does to this pre-order. Both allocations target the
 * same document value; 'lines' can miss it by a few cents because a unit price
 * only carries 2 decimals, so its numbers are derived from the rounded prices we
 * actually transmit rather than from the nominal target.
 *
 * Line values are rounded per line, because that is how setDocs receives each
 * `lineval` — the document total is the sum of the rounded lines, not a rounded sum.
 */
export function planDiscount(
  info: OfferDiscountInfo,
  allocation: DiscountAllocation | null,
  lines: Array<{ qty: number; price: number }>,
): DiscountPlan {
  const subtotalBeforeDiscount = round2(
    lines.reduce((sum, l) => sum + round2(l.qty * l.price), 0),
  );

  if (!info.hasDiscount) {
    return {
      allocation: null,
      subtotalBeforeDiscount,
      discountAmount: 0,
      subtotalAfterDiscount: subtotalBeforeDiscount,
      documentDiscount: null,
    };
  }

  if (allocation === 'lines') {
    const subtotalAfterDiscount = round2(
      lines.reduce((sum, l) => sum + round2(l.qty * discountedUnitPrice(l.price, info.fraction)), 0),
    );
    return {
      allocation,
      subtotalBeforeDiscount,
      discountAmount: round2(subtotalBeforeDiscount - subtotalAfterDiscount),
      subtotalAfterDiscount,
      documentDiscount: null,
    };
  }

  // 'document', and the not-yet-chosen preview: the nominal share of the discount.
  const discountAmount = round2(subtotalBeforeDiscount * info.fraction);
  return {
    allocation,
    subtotalBeforeDiscount,
    discountAmount,
    subtotalAfterDiscount: round2(subtotalBeforeDiscount - discountAmount),
    documentDiscount: allocation === 'document' ? discountAmount : null,
  };
}

/** Wire shape of the discount info the wizard needs to drive its Discount step. */
export function discountPayload(info: OfferDiscountInfo) {
  return {
    hasDiscount: info.hasDiscount,
    value: info.value,
    mode: info.mode,
    fractionPct: round2(info.fraction * 100),
  };
}
