import type { OfferLanguage } from './offerLanguage';

// dbo.PaymentTerms.ID of the catch-all row. Pinned by the seed script
// (2026-08-25-payment-terms.sql inserts with IDENTITY_INSERT), so it is safe to
// reference by id here. OTHER is the one term whose printed text is free-typed
// on the offer; every other term prints its catalogue description.
export const OTHER_PAYMENT_TERM_ID = 13;

// dbo.PaymentTerms.ID of "30% DEPOSIT & BALANCE ON DELIVERY": the term a NEW
// OFFER gets when its customer has no agreed term. Pinned by the same seed as
// OTHER. Only the offer default; a customer with no term stays without one.
export const DEFAULT_OFFER_PAYMENT_TERM_ID = 8;

export type PaymentTermTextSource = {
  descriptionGr?: string | null;
  descriptionEn?: string | null;
};

export const isOtherPaymentTerm = (id: number | string | null | undefined): boolean => {
  if (id == null || id === '') return true;
  return Number(id) === OTHER_PAYMENT_TERM_ID;
};

// The text an offer prints for a non-OTHER term, in the offer's language.
// Callers write the result INTO Offer.PaymentTerms as a snapshot; they never
// re-derive it later, so a reworded catalogue entry cannot change an offer that
// was already sent.
export const resolvePaymentTermText = (
  term: PaymentTermTextSource | null | undefined,
  language: OfferLanguage,
): string => {
  if (!term) return '';
  const text = language === 'English' ? term.descriptionEn : term.descriptionGr;
  return (text ?? '').trim();
};
