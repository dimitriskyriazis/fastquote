import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOfferExportRowTypesStorageKey,
  promptOfferExportRowTypes,
  readOfferExportRowTypePrefs,
} from './offerExportRowTypes';
import type { ChecklistDialogOptions } from '../../../../lib/confirm';

const showChecklistDialog = vi.hoisted(() => vi.fn());
vi.mock('../../../../lib/confirm', () => ({ showChecklistDialog }));

type Row = Record<string, unknown>;

const product = (id: number): Row => ({ OfferDetailID: id, TreeOrdering: String(id), PartNumber: `PN-${id}` });
const option = (id: number): Row => ({ ...product(id), IsOption: 1 });
const nonPrintableComment = (id: number): Row => ({
  OfferDetailID: id, TreeOrdering: String(id), IsComment: 1, IsPrintable: 0,
});
const nonPrintableService = (id: number): Row => ({
  OfferDetailID: id, TreeOrdering: String(id), IsService: 1, IsPrintable: 0,
});
const printableService = (id: number): Row => ({
  OfferDetailID: id, TreeOrdering: String(id), IsService: 1, IsPrintable: 1,
});

const store = new Map<string, string>();
const USER = 'dim.kyriazis';
const KEY = buildOfferExportRowTypesStorageKey(USER);

beforeEach(() => {
  store.clear();
  showChecklistDialog.mockReset();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    },
  });
});

/** Answer the prompt: every offered item ticked except the listed keys. */
const answerWith = (...unticked: string[]) => {
  showChecklistDialog.mockImplementation(async ({ items }: ChecklistDialogOptions) =>
    Object.fromEntries(items.map((item) => [item.key, !unticked.includes(item.key)])));
};

describe('promptOfferExportRowTypes', () => {
  it('does not prompt when there are no non-printable rows and no options', async () => {
    const rows = [product(1), product(2), printableService(3)];
    await expect(promptOfferExportRowTypes(rows, USER)).resolves.toBeNull();
    expect(showChecklistDialog).not.toHaveBeenCalled();
  });

  it('only offers the row types the export actually contains', async () => {
    answerWith();
    await promptOfferExportRowTypes([product(1), nonPrintableComment(2)], USER);
    const items = (showChecklistDialog.mock.calls[0][0] as ChecklistDialogOptions).items;
    expect(items.map((item) => item.key)).toEqual(['nonPrintable']);
    expect(items[0].hint).toContain('1 row');
  });

  it('returns null (export everything) when the user keeps both row types', async () => {
    answerWith();
    const rows = [product(1), nonPrintableComment(2), option(3)];
    await expect(promptOfferExportRowTypes(rows, USER)).resolves.toBeNull();
  });

  it('cancels the export when the dialog is dismissed', async () => {
    showChecklistDialog.mockResolvedValue(false);
    const result = await promptOfferExportRowTypes([product(1), option(2)], USER);
    expect(result).toEqual({ cancelled: true });
  });

  it('skips non-printable comments AND services when unticked, keeping printable ones', async () => {
    answerWith('nonPrintable');
    const rows = [product(1), nonPrintableComment(2), nonPrintableService(3), printableService(4), option(5)];
    const result = await promptOfferExportRowTypes(rows, USER);
    const kept = rows.filter((row) => !result?.shouldSkipRow?.(row));
    expect(kept).toEqual([product(1), printableService(4), option(5)]);
  });

  it('skips options of every row type when unticked', async () => {
    answerWith('options');
    const optionComment = { ...nonPrintableComment(3), IsOption: 1 };
    const rows = [product(1), option(2), optionComment, nonPrintableComment(4)];
    const result = await promptOfferExportRowTypes(rows, USER);
    const kept = rows.filter((row) => !result?.shouldSkipRow?.(row));
    expect(kept).toEqual([product(1), nonPrintableComment(4)]);
  });

  it('remembers the answer as the next prompt default', async () => {
    answerWith('options');
    await promptOfferExportRowTypes([product(1), nonPrintableComment(2), option(3)], USER);
    expect(readOfferExportRowTypePrefs(USER)).toEqual({ nonPrintable: true, options: false });

    answerWith();
    await promptOfferExportRowTypes([product(1), option(2)], USER);
    const items = (showChecklistDialog.mock.calls[1][0] as ChecklistDialogOptions).items;
    expect(items.find((item) => item.key === 'options')?.checked).toBe(false);
    // Re-ticking it sticks too.
    expect(readOfferExportRowTypePrefs(USER)).toEqual({ nonPrintable: true, options: true });
  });

  it('does not reset a remembered choice the prompt never offered', async () => {
    store.set(KEY, JSON.stringify({ nonPrintable: false, options: false }));
    answerWith(); // only options are present, so only that box is shown (and ticked)
    await promptOfferExportRowTypes([product(1), option(2)], USER);
    expect(readOfferExportRowTypePrefs(USER)).toEqual({ nonPrintable: false, options: true });
  });

  it('defaults to including everything when nothing is stored', () => {
    expect(readOfferExportRowTypePrefs(USER)).toEqual({ nonPrintable: true, options: true });
  });

  it('survives corrupt stored prefs', () => {
    store.set(KEY, '{not json');
    expect(readOfferExportRowTypePrefs(USER)).toEqual({ nonPrintable: true, options: true });
  });
});
