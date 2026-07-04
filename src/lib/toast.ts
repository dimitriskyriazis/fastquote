export type ToastTone = 'info' | 'error' | 'success' | 'warning';

export type ToastAction = {
  label: string;
  onClick: () => void;
};

export const showToastMessage = (
  message: string,
  tone: ToastTone = 'info',
  durationMs = 5000,
  action?: ToastAction,
): (() => void) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const effectiveDuration = action ? Math.max(durationMs, 5500) : durationMs;

  const containerId = 'fastquote-drop-toast-container';
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    container.className = 'drop-toast-container';
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    document.body.appendChild(container);
  }

  // Suppress duplicate toasts with the same message and tone that are already visible.
  const existingToasts = Array.from(container.children) as HTMLElement[];
  if (existingToasts.some(el => el.dataset.message === message && el.dataset.tone === tone)) {
    return () => {};
  }

  const toast = document.createElement('div');
  toast.dataset.message = message;
  toast.dataset.tone = tone;
  toast.className = `drop-toast drop-toast--${tone}`;
  toast.textContent = message;

  if (action) {
    const btn = document.createElement('button');
    btn.className = 'drop-toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      action.onClick();
      removeToast();
    });
    toast.appendChild(btn);
  }

  container.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add('visible');
  });
  let dismissed = false;
  const removeToast = () => {
    if (dismissed) return;
    dismissed = true;
    toast.classList.remove('visible');
    window.setTimeout(() => {
      toast.remove();
      if (container && container.childElementCount === 0) {
        container.remove();
      }
    }, 220);
  };
  window.setTimeout(removeToast, effectiveDuration);
  return removeToast;
};

export type ProgressToast = {
  update: (message: string) => void;
  dismiss: () => void;
};

/**
 * A long-lived toast whose text can be updated in place — for multi-step progress
 * (chunked requests etc.) where re-creating the toast per step would flicker and
 * re-trigger the entry animation each time.
 */
export const showProgressToast = (message: string, tone: ToastTone = 'info'): ProgressToast => {
  const dismiss = showToastMessage(message, tone, 600000);
  if (typeof document === 'undefined') return { update: () => {}, dismiss };

  const container = document.getElementById('fastquote-drop-toast-container');
  const toast = container
    ? (Array.from(container.children) as HTMLElement[]).find(
        (el) => el.dataset.message === message && el.dataset.tone === tone,
      )
    : undefined;

  return {
    update: (next: string) => {
      if (toast && toast.isConnected) {
        toast.textContent = next;
        toast.dataset.message = next;
      }
    },
    dismiss,
  };
};
