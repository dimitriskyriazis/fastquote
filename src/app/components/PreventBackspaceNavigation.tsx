'use client';

import { useEffect } from 'react';

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

const isTextLikeInput = (input: HTMLInputElement): boolean => {
  const type = (input.getAttribute('type') ?? input.type ?? 'text').toLowerCase();
  return !NON_TEXT_INPUT_TYPES.has(type);
};

const isActuallyEditableField = (el: HTMLElement): boolean => {
  if (el instanceof HTMLInputElement) {
    if (el.disabled || el.readOnly) return false;
    return isTextLikeInput(el);
  }
  if (el instanceof HTMLTextAreaElement) {
    if (el.disabled || el.readOnly) return false;
    return true;
  }
  if (el.isContentEditable) return true;
  return false;
};

const isEditableElement = (target: EventTarget | null): boolean => {
  if (!target) return false;
  const element =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  if (!element) return false;

  if (isActuallyEditableField(element)) return true;

  const closestEditable = element.closest(
    'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  );
  if (closestEditable instanceof HTMLElement) {
    return isActuallyEditableField(closestEditable);
  }

  return false;
};

export default function PreventBackspaceNavigation() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Backspace' || event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.defaultPrevented) return;
      if (isEditableElement(event.target) || isEditableElement(document.activeElement)) return;
      event.preventDefault();
    };
    const options: AddEventListenerOptions = { capture: true };
    window.addEventListener('keydown', handleKeyDown, options);
    return () => window.removeEventListener('keydown', handleKeyDown, options);
  }, []);
  return null;
}
