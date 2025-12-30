'use client';

import { useEffect } from 'react';

type SelectionState = { start: number; end: number };

const elementSelectionMap = new WeakMap<HTMLInputElement | HTMLTextAreaElement, SelectionState>();
const cellSelectionMap = new Map<string, SelectionState>();

const computeCellKey = (input: HTMLInputElement | HTMLTextAreaElement): string | null => {
  const cell = input.closest('.ag-cell');
  if (!cell) return null;
  const rowId = cell.getAttribute('row-id');
  const colId = cell.getAttribute('col-id');
  if (!rowId || !colId) return null;
  return `${rowId}:${colId}`;
};

const getCurrentSelection = (input: HTMLInputElement | HTMLTextAreaElement): SelectionState => {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return { start, end };
};

export const updateCaretSelection = (input: HTMLInputElement | HTMLTextAreaElement) => {
  const selection = getCurrentSelection(input);
  elementSelectionMap.set(input, selection);
  const key = computeCellKey(input);
  if (key) {
    cellSelectionMap.set(key, selection);
  }
};

export const restoreCaretSelection = (input: HTMLInputElement | HTMLTextAreaElement) => {
  requestAnimationFrame(() => {
    try {
      if (document.activeElement !== input) {
        input.focus({ preventScroll: true });
      }
      const key = computeCellKey(input);
      const selection =
        (key ? cellSelectionMap.get(key) : undefined) ??
        elementSelectionMap.get(input) ??
        getCurrentSelection(input);
      input.setSelectionRange(selection.start, selection.end);
    } catch {
      // ignore invalid ranges
    }
  });
};

const handleMouseInput = (event: MouseEvent, callback: (input: HTMLInputElement | HTMLTextAreaElement) => void) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
  callback(target);
};

const useCaretKeeper = () => {
  useEffect(() => {
    const handleFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      updateCaretSelection(target);
    };
    const handleInput = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      updateCaretSelection(target);
    };
    const handleMouseUp = (event: MouseEvent) => {
      handleMouseInput(event, (input) => {
        window.setTimeout(() => updateCaretSelection(input), 0);
      });
    };

    document.addEventListener('focus', handleFocus, true);
    document.addEventListener('input', handleInput, true);
    document.addEventListener('mouseup', handleMouseUp, true);

    return () => {
      document.removeEventListener('focus', handleFocus, true);
      document.removeEventListener('input', handleInput, true);
      document.removeEventListener('mouseup', handleMouseUp, true);
    };
  }, []);
};

export default useCaretKeeper;
