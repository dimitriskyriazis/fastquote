export type ConfirmDialogOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
};

export const showConfirmDialog = async ({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
}: ConfirmDialogOptions): Promise<boolean> => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return true;
  }

  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'telquote-confirm-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'telquote-confirm-dialog';

    if (title) {
      const heading = document.createElement('h3');
      heading.className = 'telquote-confirm-title';
      heading.textContent = title;
      dialog.appendChild(heading);
    }

    const messageEl = document.createElement('p');
    messageEl.className = 'telquote-confirm-message';
    messageEl.textContent = message;
    dialog.appendChild(messageEl);

    const buttons = document.createElement('div');
    buttons.className = 'telquote-confirm-buttons';

    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'telquote-confirm-btn telquote-confirm-btn--cancel';
    cancelBtn.textContent = cancelLabel;

    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = `telquote-confirm-btn telquote-confirm-btn--confirm${
      tone === 'danger' ? ' telquote-confirm-btn--danger' : ''
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
