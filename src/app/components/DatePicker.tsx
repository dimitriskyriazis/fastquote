'use client';

import React, { forwardRef } from 'react';
import ReactDatePicker, { registerLocale } from 'react-datepicker';
import { enGB } from 'date-fns/locale';
import 'react-datepicker/dist/react-datepicker.css';
import styles from './DatePicker.module.css';

// Register UK locale
registerLocale('en-GB', enGB);

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

type CustomInputProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> & {
  value?: string;
};

const CustomInput = forwardRef<HTMLInputElement, CustomInputProps>((props, ref) => {
  const { value, className, ...rest } = props;
  return (
  <input
    ref={ref}
    type="text"
    value={value ?? ''}
    className={className}
    readOnly
    {...rest}
  />
  );
});

CustomInput.displayName = 'CustomInput';

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

  const handleChange = (date: Date | null) => {
    if (date && !Number.isNaN(date.getTime())) {
      // Convert to ISO format (YYYY-MM-DD) for storage/API
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      onChange(`${year}-${month}-${day}`);
    } else {
      onChange('');
    }
  };

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
        <CustomInput
          required={required}
          disabled={disabled}
          placeholder={placeholder}
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
