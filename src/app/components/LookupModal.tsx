'use client';

import { useEffect, type CSSProperties } from 'react';
import styles from './LookupModal.module.css';

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: () => void;
  confirmLabel?: string;
  cancelLabel?: string;
  saving?: boolean;
  error?: string | null;
  children?: React.ReactNode;
  overlayClassName?: string;
  overlayStyle?: CSSProperties;
  cardClassName?: string;
  cardStyle?: CSSProperties;
};

export default function LookupModal({
  open,
  title,
  onClose,
  onConfirm,
  confirmLabel = 'Save',
  cancelLabel = 'Cancel',
  saving = false,
  error = null,
  children,
  overlayClassName = '',
  overlayStyle,
  cardClassName = '',
  cardStyle,
}: Props) {
  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Backspace') {
        const target = event.target;
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable)
        ) {
          return;
        }
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className={`${styles.overlay} ${overlayClassName ?? ''}`.trim()}
      style={overlayStyle}
      onClick={(event) => {
        if (event.currentTarget === event.target) {
          onClose();
        }
      }}
    >
      <div
        className={`${styles.card} ${cardClassName}`.trim()}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.header}>
          <div className={styles.title}>{title}</div>
          <button
            type="button"
            className={styles.closeButton}
            aria-label="Close dialog"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className={styles.body}>
          {children}
          {error ? <div className={styles.error}>{error}</div> : null}
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.cancelButton} onClick={onClose} disabled={saving}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={styles.confirmButton}
            onClick={onConfirm}
            disabled={saving}
          >
            {saving ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
