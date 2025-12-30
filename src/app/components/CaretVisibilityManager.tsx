'use client';

import { useEffect } from 'react';
import useCaretKeeper from '../hooks/useCaretKeeper';

const CONTROL_SELECTORS = ['input', 'textarea', 'select'];
const SKIP_ATTR = 'data-disable-autofill-skip';

const markControl = (element: Element) => {
  if (
    !(element instanceof HTMLInputElement)
    && !(element instanceof HTMLTextAreaElement)
    && !(element instanceof HTMLSelectElement)
  ) {
    return;
  }
  try {
    element.setAttribute(SKIP_ATTR, 'true');
    if (element.hasAttribute('readonly')) {
      element.removeAttribute('readonly');
    }
  } catch {
    /* ignore DOM errors */
  }
};

const markTree = (root: ParentNode) => {
  CONTROL_SELECTORS.forEach((selector) => {
    if (typeof root.querySelectorAll !== 'function') return;
    const matches = root.querySelectorAll(selector);
    matches.forEach(markControl);
  });
  if (root instanceof Element) {
    const rootTag = (root.tagName ?? '').toLowerCase();
    if (CONTROL_SELECTORS.includes(rootTag)) {
      markControl(root);
    }
  }
};

const useGlobalAutofillSkip = () => {
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const container = document.body ?? document.documentElement;
    if (!container) return;
    markTree(container);
    const observer = new MutationObserver((records) => {
      records.forEach((record) => {
        if (record.type === 'childList') {
          record.addedNodes.forEach((node) => {
            if (node instanceof Element) {
              markTree(node);
            }
          });
        } else if (record.type === 'attributes' && record.target instanceof Element) {
          const targetTag = (record.target.tagName ?? '').toLowerCase();
          if (CONTROL_SELECTORS.includes(targetTag)) {
            markControl(record.target);
          }
        }
      });
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'readonly', 'name', 'type'],
    });
    return () => observer.disconnect();
  }, []);
};

export default function CaretVisibilityManager() {
  useCaretKeeper();
  useGlobalAutofillSkip();
  return null;
}
