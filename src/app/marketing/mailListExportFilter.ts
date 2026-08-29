'use client';

import type { ExportRowFilterFactory } from '../../lib/gridExport';
import { showToastMessage } from '../../lib/toast';

/**
 * Keeps the marketing membership grids from exporting anyone the sanctioned
 * mail-list exports would refuse to mail.
 *
 * The two grids this is used on — a mail's contacts and a contact group's
 * members — are management screens: you have to be able to SEE a disabled row in
 * order to remove it from the list, so the filtering cannot live in their SQL.
 * But both grids show Email and Fax columns and carry AG Grid's default
 * Excel/CSV export, so a right-click on either produces a perfectly usable
 * mailing list — one that, unlike /api/marketing/mails/export, had no Enabled
 * rules at all behind it.
 *
 * The rule applied here is exactly the one those export routes apply in SQL:
 * `ISNULL(c.Enabled, 0) = 1 AND (cust.ID IS NULL OR cust.Enabled = 1)`. A row
 * with no customer at all is kept, matching the `cust.ID IS NULL` branch.
 */

const isOff = (value: unknown): boolean =>
  value === false || value === 0 || value === '0' || value === 'false';

/** True when this row would not survive the mail-list export queries. */
export const isUnmailableRow = (row: Record<string, unknown>): boolean =>
  isOff(row.ContactEnabled) || isOff(row.CustomerEnabled);

export const createMailListExportRowFilter = (): ExportRowFilterFactory => ({ rows }) => {
  const omitted = rows.filter(isUnmailableRow).length;
  if (omitted === 0) return null;

  // Say so rather than quietly shipping a shorter file: someone reconciling this
  // against the grid's own row count needs to know why the numbers differ.
  showToastMessage(
    `${omitted} contact${omitted === 1 ? '' : 's'} left out of the export: the contact or its customer is disabled.`,
    'info',
    6000,
  );
  return { shouldSkipRow: isUnmailableRow };
};
