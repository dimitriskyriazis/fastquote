/**
 * Offer.OfferContact is a text snapshot of the linked contact's name, written
 * when a contact is selected on an offer (offers/create and the basicdata PATCH
 * route). It goes stale when the contact is later renamed, so anything that
 * displays or prints an offer's contact must prefer the live Contacts name and
 * only fall back to the snapshot: legacy text-only offers, or a contact row
 * that no longer resolves.
 */

/** Trim and collapse internal whitespace so live/snapshot comparisons ignore spacing noise. */
export function normalizeContactName(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Display name for an offer's contact: the live Contacts full name when it
 * resolves, otherwise the OfferContact snapshot, otherwise ''.
 */
export function resolveOfferContactName(
  liveContactName: string | null | undefined,
  snapshotContactName: string | null | undefined,
): string {
  return normalizeContactName(liveContactName) || normalizeContactName(snapshotContactName);
}
