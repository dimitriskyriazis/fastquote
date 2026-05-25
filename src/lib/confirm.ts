export type MultiChoiceDialogOption = { label: string; value: string };

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
