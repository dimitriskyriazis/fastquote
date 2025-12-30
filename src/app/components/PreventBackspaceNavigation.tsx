'use client';

import { useEffect } from 'react';

const isEditableElement = (target: EventTarget | null): boolean => {
  if (!target) return false;
  if (target instanceof HTMLElement) {
    const tagName = target.tagName.toLowerCase();
    if (tagName === 'input' || tagName === 'textarea') return true;
    if (target.isContentEditable) return true;
  }
  if (target instanceof Element) {
    const closestEditable = target.closest('input, textarea, [contenteditable="true"], [contenteditable=""]');
    if (closestEditable) return true;
  } else if (target instanceof Node) {
    const parent = target.parentElement;
    if (parent) {
      const closestEditable = parent.closest('input, textarea, [contenteditable="true"], [contenteditable=""]');
      if (closestEditable) return true;
    }
  }
  return false;
};

export default function PreventBackspaceNavigation() {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Backspace' || event.metaKey || event.altKey || event.ctrlKey) return;
      if (event.defaultPrevented) return;
      if (isEditableElement(event.target)) return;
      event.preventDefault();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);
  return null;
}
