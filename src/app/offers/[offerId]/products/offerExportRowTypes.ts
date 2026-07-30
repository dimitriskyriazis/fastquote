// Grid Export → Excel/CSV row-type gate for the offer-products grid.
//
// The grid shows working rows the printed offer never does — non-printable
// comments/services (internal notes and costs) and options (rows the customer
// may or may not take). Whether those belong in an ad-hoc Excel export depends
// entirely on who the file is for, so the export asks instead of guessing, and
// remembers the answer per user as the next prompt's default.
import { showChecklistDialog } from '../../../../lib/confirm';
import { isNonPrintableOfferProductRow, isOfferProductOption } from '../../../../lib/offerProductRows';
import type { ExportRowFilter } from '../../../../lib/gridExport';

export type OfferExportRowTypePrefs = {
  nonPrintable: boolean;
  options: boolean;
};

// Include everything: what the export did before it asked.
const DEFAULT_PREFS: OfferExportRowTypePrefs = { nonPrintable: true, options: true };

const STORAGE_PREFIX = 'fastquote:offer-export-row-types';

const sanitizeSegment = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Per-user, shared across offers — the choice is about the recipient, not the offer. */
export const buildOfferExportRowTypesStorageKey = (userId: string | null | undefined): string => {
  const user = userId && userId.trim() ? userId.trim() : 'anon';
  return `${STORAGE_PREFIX}:${sanitizeSegment(user)}`;
};

export const readOfferExportRowTypePrefs = (
  userId: string | null | undefined,
): OfferExportRowTypePrefs => {
  if (typeof window === 'undefined') return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(buildOfferExportRowTypesStorageKey(userId));
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<OfferExportRowTypePrefs> | null;
    return {
      nonPrintable: parsed?.nonPrintable !== false,
      options: parsed?.options !== false,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
};

export const writeOfferExportRowTypePrefs = (
  userId: string | null | undefined,
  prefs: OfferExportRowTypePrefs,
): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(buildOfferExportRowTypesStorageKey(userId), JSON.stringify(prefs));
  } catch {
    /* localStorage full or blocked — the prompt just won't remember. */
  }
};

const rowLabel = (count: number) => `${count} row${count === 1 ? '' : 's'}`;

/**
 * Ask which of the export's special row types to keep, and turn the answer into
 * an ExportRowFilter. Returns null when there is nothing to ask about (or the
 * user kept everything), so ordinary exports never see a dialog.
 */
export async function promptOfferExportRowTypes(
  rows: Record<string, unknown>[],
  userId: string | null | undefined,
): Promise<ExportRowFilter | null> {
  const nonPrintableCount = rows.reduce(
    (count, row) => (isNonPrintableOfferProductRow(row) ? count + 1 : count),
    0,
  );
  const optionCount = rows.reduce(
    (count, row) => (isOfferProductOption(row) ? count + 1 : count),
    0,
  );
  if (nonPrintableCount === 0 && optionCount === 0) return null;

  const prefs = readOfferExportRowTypePrefs(userId);
  const items = [];
  if (nonPrintableCount > 0) {
    items.push({
      key: 'nonPrintable',
      label: 'Non-printable comments and services',
      hint: `${rowLabel(nonPrintableCount)} — internal lines that never reach the printed offer`,
      checked: prefs.nonPrintable,
    });
  }
  if (optionCount > 0) {
    items.push({
      key: 'options',
      label: 'Options',
      hint: `${rowLabel(optionCount)} — optional lines (Item No ends in "o")`,
      checked: prefs.options,
    });
  }

  const answer = await showChecklistDialog({
    title: 'Export rows',
    message: 'Untick anything you want left out of this export.',
    items,
    confirmLabel: 'Export',
  });
  if (answer === false) return { cancelled: true };

  // Only rows that were actually offered can change the remembered prefs —
  // an offer without options must not silently reset the options preference.
  const includeNonPrintable = nonPrintableCount === 0 || answer.nonPrintable !== false;
  const includeOptions = optionCount === 0 || answer.options !== false;
  writeOfferExportRowTypePrefs(userId, {
    nonPrintable: nonPrintableCount > 0 ? includeNonPrintable : prefs.nonPrintable,
    options: optionCount > 0 ? includeOptions : prefs.options,
  });

  if (includeNonPrintable && includeOptions) return null;
  return {
    shouldSkipRow: (row) => (
      (!includeNonPrintable && isNonPrintableOfferProductRow(row))
      || (!includeOptions && isOfferProductOption(row))
    ),
  };
}
