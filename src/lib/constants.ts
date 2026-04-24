/**
 * Shared constants used across API routes and client components.
 */

/** Default batch size for chunked DELETE operations (offers, customers, products, contacts, etc.) */
export const BATCH_DELETE_SIZE = 200;

/** Maximum number of rows a grid endpoint will return in a single page */
export const PAGE_SIZE_MAX = 1000;

/** Maximum number of rows when fetching all rows at once (offer products) */
export const ALL_ROWS_LIMIT = 20000;

/** Probability field bounds */
export const PROBABILITY_MIN = 0;
export const PROBABILITY_MAX = 100;

/** SalesDivisionID for the TVS business unit (AVS = 4, TVS = 3). */
export const TVS_SALES_DIVISION_ID = 3;

/** AspNetUsers.Id forced as ApprovalUserId for every offer in the TVS sales division. */
export const TVS_APPROVAL_USER_ID = '6';

/** Standard max-length values for string fields */
export const FIELD_MAX_LENGTHS = {
  title: 512,
  description: 2000,
  standard: 500,
  email: 320,
  name: 120,
  userId: 450,
  paymentTerms: 500,
  deliveryTime: 500,
  offerValidity: 500,
  closingNote: 2000,
  introNote: 2000,
  telmacoNote: 2000,
  comment: 2000,
  projectCode: 100,
  customerRef: 200,
} as const;
