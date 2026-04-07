'use client';

import React, { useState, forwardRef, useCallback } from 'react';
import ReactDatePicker, { registerLocale } from 'react-datepicker';
import { enGB } from 'date-fns/locale';
import 'react-datepicker/dist/react-datepicker.css';
import styles from './DatePicker.module.css';

// Register UK locale
registerLocale('en-GB', enGB);

/**
 * Live auto-format while typing:
 * - Converts - and . to /
 * - Pads single-digit day when / is typed (8/ → 08/)
 * - Pads single-digit month when / is typed (08/4/ → 08/04/)
 * Only pads when adding characters, not when backspacing.
 */
function autoFormatDateInput(newVal: string, prevVal: string): string {
  // Normalize separators to /
  let val = newVal.replace(/[\-\.]/g, '/');
  // Only allow digits and /
  val = val.replace(/[^\d\/]/g, '');

  // Only auto-pad when adding characters, not backspacing
  if (val.length > prevVal.length) {
    const parts = val.split('/');
    // Pad single-digit day when / is typed after it
    if (parts.length >= 2 && parts[0].length === 1) {
      parts[0] = '0' + parts[0];
    }
    // Pad single-digit month when / is typed after it
    if (parts.length >= 3 && parts[1].length === 1) {
      parts[1] = '0' + parts[1];
    }
    val = parts.join('/');
  }

  // Max length: DD/MM/YYYY = 10
  if (val.length > 10) val = val.slice(0, 10);

  return val;
}

/** Expand 2-digit year on blur: DD/MM/YY → DD/MM/20YY */
function expandDateYear(val: string): string {
  const match = val.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (match) return `${match[1]}/${match[2]}/20${match[3]}`;
  return val;
}

/** Parse DD/MM/YYYY into a Date object */
function parseFormattedDate(input: string): Date | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('/');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2100) return null;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

type SmartDateInputProps = {
  value?: string;
  onChange?: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur?: (e: React.FocusEvent<HTMLElement>) => void;
  onFocus?: (e: React.FocusEvent<HTMLElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  onKeyDown?: (e: React.KeyboardEvent<HTMLElement>) => void;
  onSmartParse?: (rawText: string) => void;
  className?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  'aria-invalid'?: boolean;
};

const SmartDateInput = forwardRef<HTMLInputElement, SmartDateInputProps>((props, ref) => {
  const {
    value: dpValue,
    onChange: _dpOnChange, // eslint-disable-line @typescript-eslint/no-unused-vars
    onBlur: dpOnBlur,
    onFocus: dpOnFocus,
    onClick: dpOnClick,
    onKeyDown: dpOnKeyDown,
    onSmartParse,
    className,
    placeholder,
    disabled,
    required,
    ...rest
  } = props;

  // Local text only tracked while focused (typing). Null = use dpValue.
  const [localText, setLocalText] = useState<string | null>(null);
  const text = localText ?? (dpValue ?? '');

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setLocalText(dpValue ?? '');
    dpOnFocus?.(e);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const formatted = autoFormatDateInput(e.target.value, text);
    setLocalText(formatted);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    const expanded = expandDateYear(text);
    onSmartParse?.(expanded);
    setLocalText(null);
    dpOnBlur?.(e);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const expanded = expandDateYear(text);
      onSmartParse?.(expanded);
      (e.target as HTMLInputElement).blur();
      return;
    }
    dpOnKeyDown?.(e);
  };

  return (
    <input
      ref={ref}
      type="text"
      value={text}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={dpOnClick as React.MouseEventHandler<HTMLInputElement>}
      onKeyDown={handleKeyDown}
      className={className}
      placeholder={placeholder}
      disabled={disabled}
      required={required}
      aria-invalid={rest['aria-invalid'] || undefined}
    />
  );
});

SmartDateInput.displayName = 'SmartDateInput';

type DatePickerProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  invalid?: boolean;
  minDate?: Date;
  maxDate?: Date;
};

export default function UKDatePicker({
  value,
  onChange,
  placeholder = 'DD/MM/YYYY',
  className,
  disabled = false,
  required = false,
  invalid = false,
  minDate,
  maxDate,
}: DatePickerProps) {
  const selectedDate = value ? new Date(value) : null;
  const isInvalid = selectedDate && Number.isNaN(selectedDate.getTime());

  const emitDate = useCallback((date: Date | null) => {
    if (date && !Number.isNaN(date.getTime())) {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      onChange(`${year}-${month}-${day}`);
    } else {
      onChange('');
    }
  }, [onChange]);

  const handleChange = (date: Date | null) => {
    emitDate(date);
  };

  const handleSmartParse = useCallback((rawText: string) => {
    if (!rawText.trim()) {
      onChange('');
      return;
    }
    const parsed = parseFormattedDate(rawText);
    if (parsed) {
      emitDate(parsed);
    }
  }, [onChange, emitDate]);

  return (
    <ReactDatePicker
      selected={selectedDate && !isInvalid ? selectedDate : null}
      onChange={handleChange}
      locale="en-GB"
      dateFormat="dd/MM/yyyy"
      placeholderText={placeholder}
      wrapperClassName={styles.datePickerWrapper}
      className={className || styles.datePickerInput}
      disabled={disabled}
      required={required}
      minDate={minDate}
      maxDate={maxDate}
      customInput={(
        <SmartDateInput
          onSmartParse={handleSmartParse}
          placeholder={placeholder}
          disabled={disabled}
          required={required}
          aria-invalid={invalid || undefined}
        />
      )}
      showYearDropdown
      showMonthDropdown
      dropdownMode="select"
      popperPlacement="bottom-start"
      fixedHeight
    />
  );
}
