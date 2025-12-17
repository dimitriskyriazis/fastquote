'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import styles from './AgGridAll.module.css';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onRegisterFocus?: (focus: (() => void) | null) => void;
};

export default function QuickSearchToolbar({ value, onChange, onRegisterFocus }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectionRef = useRef<{ start: number; end: number } | null>(null);
  const focusInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    const selection = selectionRef.current;
    if (!selection) return;
    try {
      input.setSelectionRange(selection.start, selection.end);
    } catch {
      // ignore invalid ranges
    }
  }, []);

  useEffect(() => {
    onRegisterFocus?.(focusInput);
    return () => {
      onRegisterFocus?.(null);
    };
  }, [focusInput, onRegisterFocus]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      selectionRef.current = {
        start: event.target.selectionStart ?? event.target.value.length,
        end: event.target.selectionEnd ?? event.target.selectionStart ?? event.target.value.length,
      };
      onChange(event.target.value);
    },
    [onChange],
  );

  const handleClear = useCallback(() => {
    onChange('');
    focusInput();
    selectionRef.current = { start: 0, end: 0 };
  }, [onChange, focusInput]);

  return (
    <div className={styles.searchToolbar}>
      <div className={styles.searchInputWrapper}>
        <input
          ref={inputRef}
          className={styles.searchInput}
          type="search"
          placeholder="Search all columns"
          aria-label="Search all columns"
          data-disable-autofill-skip="true"
          autoComplete="off"
          value={value}
          onChange={handleChange}
        />
        {value ? (
          <button
            type="button"
            className={styles.clearSearchButton}
            aria-label="Clear search"
            onClick={handleClear}
          >
            ×
          </button>
        ) : null}
      </div>
    </div>
  );
}
