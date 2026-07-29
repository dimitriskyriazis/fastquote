// Web-link preview dialog for the add-weblinks feature.
// Review-before-save table: shows the current and proposed link (clickable, so the
// page can be eyeballed before approving), how the proposal was verified, and why
// rows without a proposal failed. Modeled on showEnhancePreviewDialog in confirm.ts
// (same overlay/dialog classes from ag-grid-overrides.css).
// Returns the indices of rows the user selected to apply, or false if cancelled.

import type { WebLinkStatus, WebLinkVerification } from './webLinkResolution';

export type WebLinkPreviewRow = {
  /** Fallback identifier shown when brand + partNumber are both empty */
  label: string;
  brand?: string | null;
  partNumber?: string | null;
  oldLink: string | null;
  newLink: string | null;
  status: WebLinkStatus;
  verification?: WebLinkVerification;
  note?: string;
  /** How many products in this run were given this same page (1 = unique to this product).
   *  More than one means the page identifies a family, not a model. */
  sharedWith?: number;
};

type Badge = { text: string; color: string; bg: string };

// Typed by the unions so adding a WebLinkVerification / WebLinkStatus member fails the build
// rather than crashing the dialog on a missing badge at render time.
const STATUS_BADGES: Record<WebLinkVerification | WebLinkStatus, Badge> = {
  previewed: { text: 'Found', color: '#166534', bg: '#f0fdf4' }, // never rendered: previewed maps to its verification
  content: { text: 'Verified on page', color: '#166534', bg: '#f0fdf4' },
  // The page renders nothing our server can read (JS-only catalog), but the search index listed
  // this exact URL with a title naming this model — the crawler rendered what we couldn't.
  index: { text: 'Verified via search index', color: '#155e75', bg: '#ecfeff' },
  llm: { text: 'AI judged', color: '#92400e', bg: '#fffbeb' },
  // Right product range, wrong granularity: every sibling SKU would get this same link.
  family: { text: 'Family page only', color: '#9a3412', bg: '#fff7ed' },
  url: { text: 'URL match', color: '#92400e', bg: '#fffbeb' },
  // The site blocked automated verification — the link is a best guess; the user must open it.
  unverified: { text: 'Unverified — open to check', color: '#b45309', bg: '#fff7ed' },
  not_found: { text: 'No link found', color: '#6b7280', bg: 'transparent' },
  error: { text: 'Error', color: '#b91c1c', bg: 'transparent' },
};

/**
 * A proposal that must not be applied without a human look, so it is shown but NOT pre-selected:
 *  - a page judged to be only the product family/range (it does not identify this model), or
 *  - a page proposed for more than one product in this run, which makes it a family page in
 *    disguise whatever tier verified it.
 * Everything else selectable starts checked, "unverified" rows included (user preference).
 */
export const isWeakWebLinkProposal = (r: Pick<WebLinkPreviewRow, 'verification' | 'sharedWith'>): boolean =>
  r.verification === 'family' || (r.sharedWith ?? 1) > 1;

/**
 * Returns the indices (into `rows`) that the user chose to apply,
 * or `false` if the dialog was cancelled.
 */
export const showWebLinkPreviewDialog = async (
  rows: WebLinkPreviewRow[],
): Promise<number[] | false> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return [];

  return new Promise<number[] | false>((resolve) => {
    // Selectable = anything with a proposed link the user could apply — verified ("previewed") or
    // "unverified" (site blocked automated checking). Selectable rows start CHECKED, including
    // "unverified" ones (autoselect, by explicit user request — its badge flags them as worth
    // opening first); the two exceptions are the weak proposals below.
    const isRowSelectable = (r: WebLinkPreviewRow) =>
      (r.status === 'previewed' || r.status === 'unverified') && !!r.newLink;
    const isWeakProposal = isWeakWebLinkProposal;
    const selectableIndices = rows.map((r, i) => ({ r, i })).filter(({ r }) => isRowSelectable(r)).map(({ i }) => i);
    const foundCount = rows.filter((r) => r.status === 'previewed' && !!r.newLink).length;
    const unverifiedCount = rows.filter((r) => r.status === 'unverified' && !!r.newLink).length;
    const weakCount = rows.filter((r) => isRowSelectable(r) && isWeakProposal(r)).length;
    const checked = new Set<number>(selectableIndices.filter((i) => !isWeakProposal(rows[i])));

    const overlay = document.createElement('div');
    overlay.className = 'fastquote-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'fastquote-confirm-dialog';
    dialog.style.cssText =
      'width:min(96vw,1200px);max-width:96vw;padding:24px 28px 20px;display:flex;flex-direction:column;gap:0;';

    const heading = document.createElement('h3');
    heading.className = 'fastquote-confirm-title';
    heading.textContent =
      `Review web links (${foundCount} found` + (unverifiedCount ? `, ${unverifiedCount} unverified` : '') + ')';
    dialog.appendChild(heading);

    const sub = document.createElement('p');
    sub.className = 'fastquote-confirm-message';
    sub.style.marginBottom = '14px';
    sub.textContent = [
      'Click a link to check the page.',
      unverifiedCount
        ? '"Unverified" rows could not be checked automatically (the site blocked us) — open them to confirm.'
        : '',
      weakCount
        ? `${weakCount} row(s) start unchecked: a family page, or the same page found for several products — tick them only after checking.`
        : '',
      'Uncheck anything you don’t want, then click "Apply". Nothing is saved until you apply.',
    ]
      .filter(Boolean)
      .join(' ');
    dialog.appendChild(sub);

    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'overflow-y:auto;max-height:55vh;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:18px;flex:1 1 auto;';

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.82rem;table-layout:fixed;';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const thCheck = document.createElement('th');
    thCheck.style.cssText =
      'width:36px;padding:6px 8px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;' +
      'position:sticky;top:0;z-index:1;text-align:center;';
    const selectAllCb = document.createElement('input');
    selectAllCb.type = 'checkbox';
    selectAllCb.checked = selectableIndices.length > 0;
    selectAllCb.title = 'Select / deselect all';
    selectAllCb.style.cursor = 'pointer';
    thCheck.appendChild(selectAllCb);
    headerRow.appendChild(thCheck);

    const colDefs = [
      { label: 'Brand', width: '11%' },
      { label: 'Part / Model No.', width: '14%' },
      { label: 'Current link', width: '25%' },
      { label: 'Found link', width: '32%' },
      { label: 'Status', width: '14%' },
    ];
    colDefs.forEach(({ label, width }) => {
      const th = document.createElement('th');
      th.textContent = label;
      th.style.cssText =
        `text-align:left;padding:7px 10px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;` +
        `font-weight:600;position:sticky;top:0;z-index:1;width:${width};`;
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'fastquote-confirm-btn fastquote-confirm-btn--confirm';

    const updateApplyBtn = () => {
      const n = checked.size;
      confirmBtn.textContent = `Apply ${n} link${n !== 1 ? 's' : ''}`;
      confirmBtn.disabled = n === 0;
      const total = selectableIndices.length;
      if (n === 0) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
      } else if (n === total) {
        selectAllCb.checked = true;
        selectAllCb.indeterminate = false;
      } else {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = true;
      }
    };

    const tbody = document.createElement('tbody');
    const rowCheckboxes: Map<number, HTMLInputElement> = new Map();
    const rowElements: Map<number, HTMLTableRowElement> = new Map();

    // Single mutation point for a row's checked state so the per-row and select-all
    // handlers can't drift apart in how rows are rendered.
    const setRowChecked = (idx: number, on: boolean) => {
      const cb = rowCheckboxes.get(idx);
      if (cb) cb.checked = on;
      const tr = rowElements.get(idx);
      if (tr) tr.style.opacity = on ? '1' : '0.45';
      if (on) checked.add(idx);
      else checked.delete(idx);
    };

    const makeLinkCell = (link: string | null, emptyText: string) => {
      const td = document.createElement('td');
      td.style.cssText =
        'padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;' +
        'word-break:break-all;line-height:1.4;';
      if (link) {
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = link.replace(/^https?:\/\/(www\.)?/i, '');
        a.style.cssText = 'color:#1d4ed8;text-decoration:underline;';
        td.appendChild(a);
      } else {
        td.textContent = emptyText;
        td.style.color = '#9ca3af';
        td.style.fontStyle = 'italic';
      }
      return td;
    };

    rows.forEach((row, idx) => {
      const isSelectable = isRowSelectable(row);
      const tr = document.createElement('tr');
      tr.style.background = idx % 2 === 1 ? '#fafafa' : '#ffffff';
      // Dim non-selectable rows, and selectable rows that start unchecked (unverified).
      if (!isSelectable) tr.style.opacity = '0.6';
      else if (!checked.has(idx)) tr.style.opacity = '0.45';

      const makeTextCell = (text: string | null, muted?: boolean) => {
        const td = document.createElement('td');
        td.style.cssText =
          'padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;' +
          'word-break:break-word;line-height:1.4;' +
          (muted ? 'color:#9ca3af;font-style:italic;' : '');
        td.textContent = text ?? '-';
        return td;
      };

      const tdCheck = document.createElement('td');
      tdCheck.style.cssText =
        'padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;text-align:center;';
      if (isSelectable) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = checked.has(idx); // on unless it is a weak proposal (family / shared page)
        cb.style.cursor = 'pointer';
        cb.addEventListener('change', () => {
          setRowChecked(idx, cb.checked);
          updateApplyBtn();
        });
        rowCheckboxes.set(idx, cb);
        rowElements.set(idx, tr);
        tdCheck.appendChild(cb);
      }
      tr.appendChild(tdCheck);

      const brandText = row.brand?.trim() || null;
      const brandCell = makeTextCell(brandText ?? row.label, !brandText);
      brandCell.style.fontWeight = brandText ? '500' : '';
      tr.appendChild(brandCell);

      tr.appendChild(makeTextCell(row.partNumber?.trim() || null, !row.partNumber));
      tr.appendChild(makeLinkCell(row.oldLink, '(none)'));
      tr.appendChild(makeLinkCell(row.newLink, row.note ?? '-'));

      const badgeKey = row.status === 'previewed' ? row.verification ?? 'llm' : row.status;
      const badge: Badge = STATUS_BADGES[badgeKey] ?? { text: badgeKey, color: '#92400e', bg: '#fffbeb' };
      const statusCell = document.createElement('td');
      statusCell.style.cssText =
        `padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;line-height:1.4;` +
        `color:${badge.color};background:${badge.bg};font-weight:500;`;
      statusCell.textContent = badge.text;
      // The same page proposed for several products is a family page in disguise, whatever tier it
      // verified at — say so on the row, since that is what makes duplicate links spottable here.
      const shared = row.sharedWith ?? 1;
      if (isSelectable && shared > 1) {
        const dupe = document.createElement('div');
        dupe.textContent = `Same page as ${shared - 1} other product${shared > 2 ? 's' : ''}`;
        dupe.style.cssText = 'margin-top:2px;font-weight:400;font-size:0.74rem;color:#9a3412;';
        statusCell.appendChild(dupe);
      }
      if (row.note) statusCell.title = row.note;
      tr.appendChild(statusCell);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    dialog.appendChild(wrapper);

    selectAllCb.addEventListener('change', () => {
      const shouldCheck = selectAllCb.checked;
      selectableIndices.forEach((idx) => setRowChecked(idx, shouldCheck));
      updateApplyBtn();
    });

    const buttons = document.createElement('div');
    buttons.className = 'fastquote-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'fastquote-confirm-btn fastquote-confirm-btn--cancel';
    cancelBtn.textContent = 'Cancel';

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);
    updateApplyBtn();

    const cleanup = (result: number[] | false) => {
      overlay.classList.remove('visible');
      window.setTimeout(() => overlay.remove(), 180);
      window.removeEventListener('keydown', handleKey);
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup([...checked]));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      }
    };
    window.addEventListener('keydown', handleKey);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      confirmBtn.focus();
    });
  });
};
