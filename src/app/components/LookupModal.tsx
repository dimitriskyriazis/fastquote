'use client';

import { useEffect, useState, useCallback, useRef, type CSSProperties } from 'react';
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
  headerClassName?: string;
  titleClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  confirmFirst?: boolean;
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
  headerClassName = '',
  titleClassName = '',
  bodyClassName = '',
  footerClassName = '',
  confirmFirst = false,
}: Props) {
  const [showValidation, setShowValidation] = useState(false);
  const overlayPointerDownOnOverlayRef = useRef(false);

  const handleClose = useCallback(() => {
    setShowValidation(false);
    onClose();
  }, [onClose]);

  const handleConfirm = useCallback(() => {
    setShowValidation(true);
    onConfirm();
  }, [onConfirm]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        handleClose();
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
  }, [open, handleClose]);

  if (!open) return null;

  return (
    <div
      className={`${styles.overlay} ${overlayClassName ?? ''}`.trim()}
      style={overlayStyle}
      onPointerDown={(event) => {
        overlayPointerDownOnOverlayRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const shouldClose =
          overlayPointerDownOnOverlayRef.current && event.currentTarget === event.target;
        overlayPointerDownOnOverlayRef.current = false;
        if (shouldClose) {
          handleClose();
        }
      }}
    >
      <div
        className={`${styles.card} ${cardClassName}`.trim()}
        style={cardStyle}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-show-validation={showValidation ? 'true' : 'false'}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={`${styles.header} ${headerClassName}`.trim()}>
          <div className={`${styles.title} ${titleClassName}`.trim()}>{title}</div>
          <button
            type="button"
            className={styles.closeButton}
            aria-label="Close dialog"
            onClick={handleClose}
          >
            ×
          </button>
        </div>
        <div className={`${styles.body} ${bodyClassName}`.trim()}>
          {children}
          {error ? <div className={styles.error}>{error}</div> : null}
        </div>
        <div className={`${styles.footer} ${footerClassName}`.trim()}>
          {confirmFirst ? (
            <>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={handleConfirm}
                disabled={saving}
              >
                {saving ? 'Saving…' : confirmLabel}
              </button>
              <button type="button" className={styles.cancelButton} onClick={onClose} disabled={saving}>
                {cancelLabel}
              </button>
            </>
          ) : (
            <>
              <button type="button" className={styles.cancelButton} onClick={handleClose} disabled={saving}>
                {cancelLabel}
              </button>
              <button
                type="button"
                className={styles.confirmButton}
                onClick={handleConfirm}
                disabled={saving}
              >
                {saving ? 'Saving…' : confirmLabel}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
