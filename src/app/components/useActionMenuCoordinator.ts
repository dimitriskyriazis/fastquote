'use client';

import { useEffect, useRef } from 'react';

const ACTION_MENU_CLOSE_EVENT = 'fastquote-action-menu-close';

type ActionMenuCloseEventDetail = {
  source: symbol;
};

export const dispatchActionMenuCloseEvent = (source: symbol) => {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ActionMenuCloseEventDetail>(ACTION_MENU_CLOSE_EVENT, {
      detail: { source },
    }),
  );
};

export const useActionMenuCloseListener = (onClose: () => void) => {
  const instanceIdRef = useRef<symbol>();
  if (!instanceIdRef.current) {
    instanceIdRef.current = Symbol('action-menu');
  }

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<ActionMenuCloseEventDetail>;
      if (customEvent.detail?.source === instanceIdRef.current) return;
      onClose();
    };
    window.addEventListener(ACTION_MENU_CLOSE_EVENT, handler);
    return () => {
      window.removeEventListener(ACTION_MENU_CLOSE_EVENT, handler);
    };
  }, [onClose]);

  return instanceIdRef.current as symbol;
};
