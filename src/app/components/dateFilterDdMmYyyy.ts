// Custom AG Grid date-filter input that enters/displays dates as DD/MM/YYYY
// instead of AG Grid's default ISO yyyy-mm-dd text input.
//
// This is registered globally under the reserved component name `agDateInput`
// (see AgGridAll `sharedGridOptions.components`), so every `agDateColumnFilter`
// — both the main filter popup and the floating-filter editable input — uses it.
//
// IMPORTANT: this only changes what the user TYPES and SEES. `getDate()` returns
// a real Date which AG Grid serialises back to ISO (yyyy-mm-dd) in the filter
// model, so server-side filtering and persisted filter state are unaffected.
//
// AG Grid React treats this as a JavaScript component (not a React one) because
// `getGui` is present on the prototype — see ag-grid-react `isFrameworkComponent`.

import type { IDateComp, IDateParams } from 'ag-grid-community';

const PLACEHOLDER = 'dd/mm/yyyy';

const padZeros = (value: number, length: number): string =>
  String(Math.abs(value)).padStart(length, '0');

/** Date -> "DD/MM/YYYY" (empty string for null/invalid). */
export const formatDateDdMmYyyy = (date: Date | null | undefined): string => {
  if (!date || Number.isNaN(date.getTime())) return '';
  return `${padZeros(date.getDate(), 2)}/${padZeros(date.getMonth() + 1, 2)}/${padZeros(date.getFullYear(), 4)}`;
};

/**
 * "DD/MM/YYYY" -> Date (or null when unparseable). Accepts `/`, `.` or `-` as
 * separators and 2-digit years (interpreted as 20YY). Rejects impossible dates
 * (e.g. 31/02/2024) rather than letting them roll over to the next month.
 */
export const parseDateDdMmYyyy = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const match = value.trim().match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{1,4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (match[3].length <= 2) {
    // Two-digit (or shorter) year: assume the 2000s, matching the dd/mm/yy hint.
    year += 2000;
  }

  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const date = new Date(year, month - 1, day);
  // new Date(yy, ...) maps years 0-99 to 1900-1999; force the intended year.
  date.setFullYear(year);
  date.setHours(0, 0, 0, 0);

  // Reject overflow (e.g. day 31 in a 30-day month rolls into the next month).
  if (date.getDate() !== day || date.getMonth() !== month - 1 || date.getFullYear() !== year) {
    return null;
  }
  return date;
};

type AfterGuiAttachedParams = { suppressFocus?: boolean } | undefined;

export class DdMmYyyyDateFilter implements IDateComp {
  private params!: IDateParams;
  private eGui!: HTMLDivElement;
  private eField!: HTMLDivElement;
  private eInput!: HTMLInputElement;
  // Mirrors DefaultDateComponent: when used in a floating filter with an Apply
  // button, only commit on `change`/focus-out rather than on every keystroke.
  private isApply = false;
  private applyOnFocusOut = false;
  private removeListeners: Array<() => void> = [];

  init(params: IDateParams): void {
    this.params = params;

    // Replicate AG Grid's DefaultDateComponent markup so the input inherits the
    // filter styling (search icon, padding, focus ring) from the quartz theme.
    this.eGui = document.createElement('div');
    this.eGui.className = 'ag-filter-filter';

    const field = document.createElement('div');
    field.className = 'ag-text-field ag-input-field ag-date-filter';
    field.setAttribute('role', 'presentation');
    this.eField = field;

    const label = document.createElement('div');
    label.className = 'ag-input-field-label ag-label ag-hidden';
    label.setAttribute('role', 'presentation');

    const wrapper = document.createElement('div');
    wrapper.className = 'ag-wrapper ag-input-wrapper';
    wrapper.setAttribute('role', 'presentation');

    this.eInput = document.createElement('input');
    this.eInput.className = 'ag-input-field-input ag-text-field-input';
    this.eInput.type = 'text';
    this.eInput.setAttribute('autocomplete', 'off');
    this.eInput.placeholder = PLACEHOLDER;

    wrapper.appendChild(this.eInput);
    field.appendChild(label);
    field.appendChild(wrapper);
    this.eGui.appendChild(field);

    this.applyParams(params);
    this.attachListeners();
  }

  private applyParams(params: IDateParams): void {
    const buttons = params.filterParams?.buttons;
    this.isApply = params.location === 'floatingFilter' && !!buttons?.includes('apply');
  }

  private attachListeners(): void {
    const onInput = () => this.handleInput(false);
    const onChange = () => this.handleInput(true);
    const onFocusOut = () => this.handleFocusOut();
    const onMouseDown = () => {
      if (!this.eInput.disabled) this.eInput.focus({ preventScroll: true });
    };

    this.eInput.addEventListener('input', onInput);
    this.eInput.addEventListener('change', onChange);
    this.eInput.addEventListener('focusout', onFocusOut);
    this.eInput.addEventListener('mousedown', onMouseDown);

    this.removeListeners.push(
      () => this.eInput.removeEventListener('input', onInput),
      () => this.eInput.removeEventListener('change', onChange),
      () => this.eInput.removeEventListener('focusout', onFocusOut),
      () => this.eInput.removeEventListener('mousedown', onMouseDown),
    );
  }

  private handleInput(isChange: boolean): void {
    if (this.eInput.disabled) return;
    if (this.isApply) {
      this.applyOnFocusOut = !isChange;
      if (isChange) this.params.onDateChanged();
      return;
    }
    if (!isChange) this.params.onDateChanged();
  }

  private handleFocusOut(): void {
    if (this.applyOnFocusOut) {
      this.applyOnFocusOut = false;
      this.params.onDateChanged();
    }
  }

  getGui(): HTMLElement {
    return this.eGui;
  }

  getDate(): Date | null {
    return parseDateDdMmYyyy(this.eInput.value);
  }

  setDate(date: Date | null): void {
    this.eInput.value = formatDateDdMmYyyy(date);
  }

  setInputPlaceholder(placeholder: string): void {
    // AG Grid pushes the locale `dateFormatOoo` text here; we override that key
    // to "dd/mm/yyyy" (see AgGridAll localeText), but guard against an empty one.
    this.eInput.placeholder = placeholder || PLACEHOLDER;
  }

  setInputAriaLabel(label: string): void {
    if (label) this.eInput.setAttribute('aria-label', label);
    else this.eInput.removeAttribute('aria-label');
  }

  setDisabled(disabled: boolean): void {
    this.eInput.disabled = disabled;
    // Mirror AgInputTextField: dim the wrapper and let AG Grid's focus-exclusion
    // (.ag-disabled) apply, so a read-only date condition looks/behaves correctly.
    this.eField.classList.toggle('ag-disabled', disabled);
  }

  afterGuiAttached(params?: AfterGuiAttachedParams): void {
    if (!params?.suppressFocus) {
      this.eInput.focus({ preventScroll: true });
    }
  }

  refresh(params: IDateParams): void {
    this.params = params;
    this.applyParams(params);
  }

  destroy(): void {
    this.removeListeners.forEach((off) => off());
    this.removeListeners = [];
  }
}
