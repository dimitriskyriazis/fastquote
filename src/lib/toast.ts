export type ToastTone = 'info' | 'error' | 'success' | 'warning';

export const showToastMessage = (
  message: string,
  tone: ToastTone = 'info',
  durationMs = 3200,
): (() => void) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const containerId = 'fastquote-drop-toast-container';
  let container = document.getElementById(containerId);
  if (!container) {
    container = document.createElement('div');
    container.id = containerId;
    container.className = 'drop-toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `drop-toast drop-toast--${tone}`;
  toast.textContent = message;
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
  window.setTimeout(removeToast, durationMs);
  return removeToast;
};
