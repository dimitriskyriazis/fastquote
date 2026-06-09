export type OfferLanguage = 'Greek' | 'English';

export const OFFER_LANGUAGES: OfferLanguage[] = ['Greek', 'English'];

export const DEFAULT_OFFER_LANGUAGE: OfferLanguage = 'Greek';

export type OfferLanguageDefaults = {
  title: string;
  paymentTerms: string;
  deliveryTime: string;
  offerValidity: string;
  closingNote: string;
  discountLabel: string;
  additionalDiscountLabel: string;
  finalPriceLabel: string;
};

export const OFFER_LANGUAGE_DEFAULTS: Record<OfferLanguage, OfferLanguageDefaults> = {
  Greek: {
    title: 'Οικονομική Προσφορά',
    paymentTerms: 'Κατόπιν συνεννόησης',
    deliveryTime: '8 εβδομάδες',
    offerValidity: '4 εβδομάδες',
    closingNote: 'Οι παραπάνω τιμές είναι σε Ευρώ για προϊόντα ελεύθερα χωρίς ΦΠΑ.',
    discountLabel: 'Έκπτωση',
    additionalDiscountLabel: 'Επιπλέον Έκπτωση',
    finalPriceLabel: 'Τελική Τιμή',
  },
  English: {
    title: 'Financial Proposal',
    paymentTerms: 'Upon Agreement',
    deliveryTime: '8 weeks',
    offerValidity: '4 weeks',
    closingNote: 'The above prices are in Euro and do not include VAT.',
    discountLabel: 'Discount',
    additionalDiscountLabel: 'Extra Discount',
    finalPriceLabel: 'Final Price',
  },
};

export const normalizeOfferLanguage = (value: unknown): OfferLanguage => {
  if (typeof value !== 'string') return DEFAULT_OFFER_LANGUAGE;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'english' || trimmed === 'en') return 'English';
  if (trimmed === 'greek' || trimmed === 'el' || trimmed === 'gr') return 'Greek';
  return DEFAULT_OFFER_LANGUAGE;
};

export const offerLanguageToPdfLang = (lang: OfferLanguage): 'el' | 'en' =>
  lang === 'English' ? 'en' : 'el';
