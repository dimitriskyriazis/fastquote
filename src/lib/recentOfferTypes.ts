export type RecentOfferSummary = {
  id: string;
  label: string;
  customerName?: string | null;
  description?: string | null;
  title?: string | null;
  openedAt: string;
};

export const RECENT_OFFERS_MAX = 6;
