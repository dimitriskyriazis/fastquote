'use client';

import { useEffect } from 'react';

const EXCLUDED_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'date',
  'datetime-local',
  'email',
  'file',
  'hidden',
  'image',
  'month',
  'number',
  'password',
  'radio',
  'range',
  'reset',
  'submit',
  'tel',
  'time',
  'url',
  'week',
]);

const GREEK_CHAR_PATTERN = /[\u0370-\u03FF\u1F00-\u1FFF]/;

const isTextLikeInput = (input: HTMLInputElement): boolean => {
  const type = (input.getAttribute('type') ?? input.type ?? 'text').toLowerCase();
  return !EXCLUDED_INPUT_TYPES.has(type);
};

const inferLanguage = (value: string): 'en' | 'el' =>
  GREEK_CHAR_PATTERN.test(value) ? 'el' : 'en';

const resolveEditableTarget = (target: EventTarget | null): HTMLElement | null => {
  if (!target) return null;
  const element =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  if (!element) return null;
  if (element.matches('input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]')) {
    return element;
  }
  return element.closest<HTMLElement>(
    'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
  );
};

const applySpellcheck = (element: HTMLElement | null) => {
  if (!element) return;
  if (element.getAttribute('data-disable-spellcheck') === 'true') return;

  if (element instanceof HTMLInputElement) {
    if (element.disabled || element.readOnly || !isTextLikeInput(element)) return;
    element.spellcheck = true;
    element.lang = inferLanguage(element.value);
    return;
  }

  if (element instanceof HTMLTextAreaElement) {
    if (element.disabled || element.readOnly) return;
    element.spellcheck = true;
    element.lang = inferLanguage(element.value);
    return;
  }

  if (element.isContentEditable) {
    element.spellcheck = true;
    element.lang = inferLanguage(element.textContent ?? '');
  }
};

export default function SpellcheckManager() {
  useEffect(() => {
    const setupElement = (eventTarget: EventTarget | null) => {
      applySpellcheck(resolveEditableTarget(eventTarget));
    };

    const handleFocusIn = (event: FocusEvent) => {
      setupElement(event.target);
    };

    const handleInput = (event: Event) => {
      setupElement(event.target);
    };

    const options: AddEventListenerOptions = { capture: true };
    document.addEventListener('focusin', handleFocusIn, options);
    document.addEventListener('input', handleInput, options);

    document
      .querySelectorAll<HTMLElement>(
        'input, textarea, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"]',
      )
      .forEach((element) => applySpellcheck(element));

    return () => {
      document.removeEventListener('focusin', handleFocusIn, options);
      document.removeEventListener('input', handleInput, options);
    };
  }, []);

  return null;
}
