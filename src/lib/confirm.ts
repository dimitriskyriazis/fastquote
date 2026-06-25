export type MultiChoiceDialogOption = { label: string; value: string };

// ---------------------------------------------------------------------------
// Enhance-descriptions preview dialog
// Shows a before/after table for each product with per-row checkboxes.
// Returns the indices of rows the user selected to apply, or false if cancelled.
// ---------------------------------------------------------------------------
export type EnhancePreviewRow = {
  /** Fallback identifier shown when brand + partNumber are both empty */
  label: string;
  brand?: string | null;
  partNumber?: string | null;
  before: string | null;
  after: string | null;
  /** If true the row was skipped (no AI result) — shown greyed out, not selectable */
  skipped?: boolean;
};

/**
 * Returns the indices (into `rows`) that the user chose to apply,
 * or `false` if the dialog was cancelled.
 */
export const showEnhancePreviewDialog = async (
  rows: EnhancePreviewRow[],
): Promise<number[] | false> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return [];

  return new Promise<number[] | false>((resolve) => {
    /* ---- checked state: only non-skipped rows are selectable ---- */
    const selectableIndices = rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !r.skipped)
      .map(({ i }) => i);
    const checked = new Set<number>(selectableIndices); // all on by default

    /* ---- overlay ---- */
    const overlay = document.createElement('div');
    overlay.className = 'fastquote-confirm-overlay';

    /* ---- dialog shell ---- */
    const dialog = document.createElement('div');
    dialog.className = 'fastquote-confirm-dialog';
    dialog.style.cssText =
      'width:min(96vw,1200px);max-width:96vw;padding:24px 28px 20px;display:flex;flex-direction:column;gap:0;';

    /* ---- title ---- */
    const heading = document.createElement('h3');
    heading.className = 'fastquote-confirm-title';
    heading.textContent = `Review enhanced descriptions (${selectableIndices.length} product${selectableIndices.length !== 1 ? 's' : ''})`;
    dialog.appendChild(heading);

    /* ---- subtitle ---- */
    const sub = document.createElement('p');
    sub.className = 'fastquote-confirm-message';
    sub.style.marginBottom = '14px';
    sub.textContent = 'Uncheck any rows you don\'t want to update, then click "Apply" to save or "Cancel" to discard all.';
    dialog.appendChild(sub);

    /* ---- scrollable table wrapper ---- */
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'overflow-y:auto;max-height:55vh;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:18px;flex:1 1 auto;';

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.82rem;table-layout:fixed;';

    /* -- thead -- */
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    // Select-all checkbox cell
    const thCheck = document.createElement('th');
    thCheck.style.cssText =
      'width:36px;padding:6px 8px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;' +
      'position:sticky;top:0;z-index:1;text-align:center;';
    const selectAllCb = document.createElement('input');
    selectAllCb.type = 'checkbox';
    selectAllCb.checked = true;
    selectAllCb.title = 'Select / deselect all';
    selectAllCb.style.cursor = 'pointer';
    thCheck.appendChild(selectAllCb);
    headerRow.appendChild(thCheck);

    const colDefs = [
      { label: 'Brand', width: '10%' },
      { label: 'Part / Model No.', width: '12%' },
      { label: 'Before', width: '37%' },
      { label: 'After', width: '37%' },
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

    /* ---- Apply button (created early so updateApplyBtn can close over it as const) ---- */
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'fastquote-confirm-btn fastquote-confirm-btn--confirm';
    confirmBtn.textContent = `Apply ${checked.size} change${checked.size !== 1 ? 's' : ''}`;

    /* helper: update Apply button label + select-all indeterminate state */
    const updateApplyBtn = () => {
      const n = checked.size;
      confirmBtn.textContent = `Apply ${n} change${n !== 1 ? 's' : ''}`;
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

    /* -- tbody -- */
    const tbody = document.createElement('tbody');
    const rowCheckboxes: Map<number, HTMLInputElement> = new Map();

    rows.forEach((row, idx) => {
      const isSelectable = !row.skipped;
      const tr = document.createElement('tr');
      const baseRowBg = idx % 2 === 1 ? '#fafafa' : '#ffffff';
      tr.style.background = baseRowBg;

      const makeCell = (text: string | null, muted?: boolean) => {
        const td = document.createElement('td');
        td.style.cssText =
          `padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;` +
          `word-break:break-word;white-space:pre-wrap;line-height:1.4;` +
          (muted ? 'color:#9ca3af;font-style:italic;' : '');
        td.textContent = text ?? '—';
        return td;
      };

      /* checkbox cell */
      const tdCheck = document.createElement('td');
      tdCheck.style.cssText =
        'padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;text-align:center;';
      if (isSelectable) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.style.cursor = 'pointer';
        cb.addEventListener('change', () => {
          if (cb.checked) {
            checked.add(idx);
            tr.style.opacity = '1';
          } else {
            checked.delete(idx);
            tr.style.opacity = '0.45';
          }
          updateApplyBtn();
        });
        rowCheckboxes.set(idx, cb);
        tdCheck.appendChild(cb);
      }
      tr.appendChild(tdCheck);

      /* brand cell */
      const brandText = row.brand?.trim() || null;
      const brandCell = makeCell(brandText, !brandText);
      brandCell.style.fontWeight = brandText ? '500' : '';
      tr.appendChild(brandCell);

      /* part / model cell */
      const partText = [row.partNumber?.trim(), '']
        .filter(Boolean)[0] ?? null;
      tr.appendChild(makeCell(partText, !partText));

      if (row.skipped) {
        const skipCell = makeCell('(skipped — no data)', true);
        skipCell.colSpan = 2;
        tr.appendChild(skipCell);
        tr.style.opacity = '0.5';
      } else {
        tr.appendChild(makeCell(row.before, !row.before));

        const afterCell = makeCell(row.after, !row.after);
        if (row.after && row.after !== row.before) {
          afterCell.style.background = '#f0fdf4';
          afterCell.style.color = '#166534';
        }
        tr.appendChild(afterCell);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    dialog.appendChild(wrapper);

    /* ---- select-all handler (runs after rowCheckboxes is populated) ---- */
    selectAllCb.addEventListener('change', () => {
      const shouldCheck = selectAllCb.checked;
      selectableIndices.forEach((idx) => {
        const cb = rowCheckboxes.get(idx);
        if (cb) cb.checked = shouldCheck;
        const tr = tbody.children[idx] as HTMLTableRowElement | undefined;
        if (tr) tr.style.opacity = shouldCheck ? '1' : '0.45';
        if (shouldCheck) checked.add(idx);
        else checked.delete(idx);
      });
      updateApplyBtn();
    });

    /* ---- buttons ---- */
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

    const cleanup = (result: number[] | false) => {
      overlay.classList.remove('visible');
      window.setTimeout(() => overlay.remove(), 180);
      window.removeEventListener('keydown', handleKey);
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup([...checked]));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    };
    window.addEventListener('keydown', handleKey);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      confirmBtn.focus();
    });
  });
};

// ---------------------------------------------------------------------------
// Selectable confirm dialog
// Like showConfirmDialog's details table, but each row has a checkbox plus a
// header "select all" checkbox. Returns the indices of the rows the user chose
// to apply, or `false` if cancelled. Used for the import "Description Mismatch"
// / "Model Number Mismatch" prompts so the user can pick which rows to overwrite.
// ---------------------------------------------------------------------------
export type SelectableConfirmDialogOptions = {
  title?: string;
  message: string;
  /** Verb shown on the confirm button; a live count is appended, e.g. "Overwrite 12 selected". */
  confirmLabel?: string;
  cancelLabel?: string;
  columns: string[];
  rows: string[][];
  /** Column widths (CSS values) aligned to `columns`; checkbox column is sized automatically. */
  columnWidths?: string[];
  /** Index into `columns` of the "new value" column to highlight green when it differs. */
  highlightColumn?: number;
  /** Whether every row starts checked (default true). Pass false for opt-in selection. */
  defaultChecked?: boolean;
  /** Allow confirming with zero rows selected (e.g. "import as-is"). Default false. */
  allowEmpty?: boolean;
};

/**
 * Returns the indices (into `rows`) the user chose to apply, or `false` if cancelled.
 * All rows start checked.
 */
export const showSelectableConfirmDialog = async ({
  title,
  message,
  confirmLabel = 'Apply',
  cancelLabel = 'Cancel',
  columns,
  rows,
  columnWidths,
  highlightColumn,
  defaultChecked = true,
  allowEmpty = false,
}: SelectableConfirmDialogOptions): Promise<number[] | false> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    // SSR / non-interactive: apply everything by default.
    return defaultChecked === false ? [] : rows.map((_, i) => i);
  }

  return new Promise<number[] | false>((resolve) => {
    const checked = new Set<number>(defaultChecked === false ? [] : rows.map((_, i) => i));

    const overlay = document.createElement('div');
    overlay.className = 'fastquote-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'fastquote-confirm-dialog';
    dialog.style.cssText =
      'width:min(96vw,1100px);max-width:96vw;padding:24px 28px 20px;display:flex;flex-direction:column;gap:0;';

    if (title) {
      const heading = document.createElement('h3');
      heading.className = 'fastquote-confirm-title';
      heading.textContent = title;
      dialog.appendChild(heading);
    }

    const messageEl = document.createElement('p');
    messageEl.className = 'fastquote-confirm-message';
    messageEl.style.marginBottom = '14px';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);

    /* ---- scrollable table wrapper ---- */
    const wrapper = document.createElement('div');
    wrapper.style.cssText =
      'overflow-y:auto;max-height:55vh;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:18px;flex:1 1 auto;';

    const table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.82rem;table-layout:fixed;';

    /* -- thead -- */
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');

    const thCheck = document.createElement('th');
    thCheck.style.cssText =
      'width:36px;padding:6px 8px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;' +
      'position:sticky;top:0;z-index:1;text-align:center;';
    const selectAllCb = document.createElement('input');
    selectAllCb.type = 'checkbox';
    selectAllCb.checked = rows.length > 0 && defaultChecked !== false;
    selectAllCb.title = 'Select / deselect all';
    selectAllCb.style.cursor = 'pointer';
    thCheck.appendChild(selectAllCb);
    headerRow.appendChild(thCheck);

    columns.forEach((label, colIdx) => {
      const th = document.createElement('th');
      th.textContent = label;
      const width = columnWidths?.[colIdx];
      th.style.cssText =
        'text-align:left;padding:7px 10px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;' +
        'font-weight:600;position:sticky;top:0;z-index:1;' +
        (width ? `width:${width};` : '');
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    /* ---- confirm button (created early so updateConfirmBtn can close over it) ---- */
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'fastquote-confirm-btn fastquote-confirm-btn--confirm';

    const updateConfirmBtn = () => {
      const n = checked.size;
      confirmBtn.textContent = `${confirmLabel} ${n} selected`;
      confirmBtn.disabled = !allowEmpty && n === 0;
      if (n === 0) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
      } else if (n === rows.length) {
        selectAllCb.checked = true;
        selectAllCb.indeterminate = false;
      } else {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = true;
      }
    };

    /* -- tbody -- */
    const tbody = document.createElement('tbody');
    const rowCheckboxes: HTMLInputElement[] = [];

    rows.forEach((row, idx) => {
      const tr = document.createElement('tr');
      tr.style.background = idx % 2 === 1 ? '#fafafa' : '#ffffff';

      const tdCheck = document.createElement('td');
      tdCheck.style.cssText =
        'padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:middle;text-align:center;';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = true;
      cb.style.cursor = 'pointer';
      cb.addEventListener('change', () => {
        if (cb.checked) {
          checked.add(idx);
          tr.style.opacity = '1';
        } else {
          checked.delete(idx);
          tr.style.opacity = '0.45';
        }
        updateConfirmBtn();
      });
      rowCheckboxes.push(cb);
      tdCheck.appendChild(cb);
      tr.appendChild(tdCheck);

      row.forEach((cell, colIdx) => {
        const td = document.createElement('td');
        td.style.cssText =
          'padding:6px 10px;border-bottom:1px solid #f0f0f0;vertical-align:top;' +
          'word-break:break-word;white-space:pre-wrap;line-height:1.4;';
        td.textContent = cell;
        if (highlightColumn === colIdx && cell && cell !== row[colIdx - 1]) {
          td.style.background = '#f0fdf4';
          td.style.color = '#166534';
        }
        tr.appendChild(td);
      });

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    dialog.appendChild(wrapper);

    /* ---- select-all handler ---- */
    selectAllCb.addEventListener('change', () => {
      const shouldCheck = selectAllCb.checked;
      rowCheckboxes.forEach((cb, idx) => {
        cb.checked = shouldCheck;
        const tr = tbody.children[idx] as HTMLTableRowElement | undefined;
        if (tr) tr.style.opacity = shouldCheck ? '1' : '0.45';
        if (shouldCheck) checked.add(idx);
        else checked.delete(idx);
      });
      updateConfirmBtn();
    });

    /* ---- buttons ---- */
    const buttons = document.createElement('div');
    buttons.className = 'fastquote-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'fastquote-confirm-btn fastquote-confirm-btn--cancel';
    cancelBtn.textContent = cancelLabel;

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    const cleanup = (result: number[] | false) => {
      overlay.classList.remove('visible');
      window.setTimeout(() => overlay.remove(), 180);
      window.removeEventListener('keydown', handleKey);
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup([...checked]));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); cleanup(false); }
    };
    window.addEventListener('keydown', handleKey);

    updateConfirmBtn();
    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
      confirmBtn.focus();
    });
  });
};

export const showMultiChoiceDialog = async ({
  title,
  message,
  choices,
}: {
  title?: string;
  message: string;
  choices: MultiChoiceDialogOption[];
}): Promise<string | null> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return choices[0]?.value ?? null;
  }

  return new Promise<string | null>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fastquote-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'fastquote-confirm-dialog';

    if (title) {
      const heading = document.createElement('h3');
      heading.className = 'fastquote-confirm-title';
      heading.textContent = title;
      dialog.appendChild(heading);
    }

    const messageEl = document.createElement('p');
    messageEl.className = 'fastquote-confirm-message';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);

    const buttons = document.createElement('div');
    buttons.className = 'fastquote-confirm-buttons';

    const cleanup = (result: string | null) => {
      overlay.classList.remove('visible');
      window.setTimeout(() => {
        overlay.remove();
      }, 180);
      window.removeEventListener('keydown', handleKey);
      resolve(result);
    };

    choices.forEach((choice, index) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fastquote-confirm-btn fastquote-confirm-btn--confirm';
      btn.textContent = choice.label;
      btn.addEventListener('click', () => cleanup(choice.value));
      if (index === 0) {
        requestAnimationFrame(() => btn.focus());
      }
      buttons.appendChild(btn);
    });

    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        cleanup(null);
      }
    });

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cleanup(null);
      }
    };
    window.addEventListener('keydown', handleKey);

    document.body.appendChild(overlay);
    requestAnimationFrame(() => {
      overlay.classList.add('visible');
    });
  });
};

export type ConfirmDialogDetail = {
  columns: string[];
  rows: string[][];
};

export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  /** Optional HTML-formatted version of message (use only with trusted, hardcoded strings). */
  messageHtml?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
  details?: ConfirmDialogDetail;
};

export const showConfirmDialog = async ({
  title,
  message,
  messageHtml,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  details,
}: ConfirmDialogOptions): Promise<boolean> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'fastquote-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'fastquote-confirm-dialog';
    if (details) {
      dialog.style.width = 'min(680px, calc(100% - 32px))';
    }

    if (title) {
      const heading = document.createElement('h3');
      heading.className = 'fastquote-confirm-title';
      heading.textContent = title;
      dialog.appendChild(heading);
    }

    const messageEl = document.createElement('p');
    messageEl.className = 'fastquote-confirm-message';
    if (messageHtml) {
      messageEl.innerHTML = messageHtml;
    } else {
      messageEl.textContent = message;
    }
    dialog.appendChild(messageEl);

    if (details && details.rows.length > 0) {
      const wrapper = document.createElement('div');
      wrapper.style.cssText = 'max-height:220px;overflow-y:auto;margin-bottom:16px;border:1px solid #e5e7eb;border-radius:8px;';

      const table = document.createElement('table');
      table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.85rem;';

      const thead = document.createElement('thead');
      const headerRow = document.createElement('tr');
      details.columns.forEach((col) => {
        const th = document.createElement('th');
        th.textContent = col;
        th.style.cssText = 'text-align:left;padding:6px 10px;background:#f3f4f6;border-bottom:1px solid #e5e7eb;font-weight:600;position:sticky;top:0;';
        headerRow.appendChild(th);
      });
      thead.appendChild(headerRow);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      details.rows.forEach((row) => {
        const tr = document.createElement('tr');
        row.forEach((cell) => {
          const td = document.createElement('td');
          td.textContent = cell;
          td.style.cssText = 'padding:5px 10px;border-bottom:1px solid #f0f0f0;';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      wrapper.appendChild(table);
      dialog.appendChild(wrapper);
    }

    const buttons = document.createElement('div');
    buttons.className = 'fastquote-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'fastquote-confirm-btn fastquote-confirm-btn--cancel';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `fastquote-confirm-btn fastquote-confirm-btn--confirm${
      tone === 'danger' ? ' fastquote-confirm-btn--danger' : ''
    }`;
    confirmBtn.textContent = confirmLabel;

    buttons.appendChild(cancelBtn);
    buttons.appendChild(confirmBtn);
    dialog.appendChild(buttons);
    overlay.appendChild(dialog);

    const cleanup = (result: boolean) => {
      overlay.classList.remove('visible');
      window.setTimeout(() => {
        overlay.remove();
      }, 180);
      window.removeEventListener('keydown', handleKey);
      resolve(result);
    };

    cancelBtn.addEventListener('click', () => cleanup(false));
    confirmBtn.addEventListener('click', () => cleanup(true));

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) {
        cleanup(false);
      }
    });

    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
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
