'use client';

import { useEffect } from 'react';
import useCaretKeeper from '../hooks/useCaretKeeper';

const CONTROL_SELECTORS = ['input', 'textarea', 'select'];
const CARET_MANAGED_ATTR = 'data-caret-visibility-managed';

const markControl = (element: Element) => {
  if (
    !(element instanceof HTMLInputElement)
    && !(element instanceof HTMLTextAreaElement)
    && !(element instanceof HTMLSelectElement)
  ) {
    return;
  }
  try {
    element.setAttribute(CARET_MANAGED_ATTR, 'true');
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
    let pendingRecords: MutationRecord[] = [];
    let frameId = 0;
    const flushRecords = () => {
      frameId = 0;
      const batch = pendingRecords.slice();
      pendingRecords = [];
      batch.forEach((record) => {
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
    };
    const observer = new MutationObserver((records) => {
      pendingRecords = pendingRecords.concat(records);
      if (!frameId) {
        frameId = requestAnimationFrame(flushRecords);
      }
    });
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'readonly', 'name', 'type'],
    });
    return () => {
      observer.disconnect();
      if (frameId) cancelAnimationFrame(frameId);
    };
  }, []);
};

export default function CaretVisibilityManager() {
  useCaretKeeper();
  useGlobalAutofillSkip();
  return null;
}
