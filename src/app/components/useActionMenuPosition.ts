'use client';

import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

type Position = {
  top: number;
  left: number;
};

type Result = {
  buttonRef: RefObject<HTMLButtonElement | null>;
  menuRef: RefObject<HTMLDivElement | null>;
  menuPos: Position | null;
};

const MENU_SPACING = 6;
const MINIMUM_TOP = 6;
const MINIMUM_LEFT = 6;
const BOTTOM_MARGIN = 12;
const RIGHT_MARGIN = 12;

export const useActionMenuPosition = (open: boolean): Result => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<Position | null>(null);

  // Layout effects intentionally measure DOM and update local state.
  // This causes an immediate state update; the rule is disabled so ESLint understands this is deliberate.
  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPos({ top: rect.bottom + MENU_SPACING, left: rect.left });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !menuPos) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    const menuElement = menuRef.current;
    if (!rect || !menuElement) return;
    const menuHeight = menuElement.offsetHeight;
    if (menuHeight === 0) return;
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 0;
    const spaceBelow = viewportHeight - rect.bottom;
    const shouldFlip = spaceBelow < menuHeight + BOTTOM_MARGIN;
    const fitsAbove = rect.top >= menuHeight + MENU_SPACING + MINIMUM_TOP;
    if (!shouldFlip || !fitsAbove) return;
      const aboveTop = Math.max(rect.top - menuHeight - MENU_SPACING, MINIMUM_TOP);
      if (menuPos.top === aboveTop || menuPos.left !== rect.left) return;
       
      setMenuPos({ top: aboveTop, left: rect.left });
  }, [open, menuPos]);

  useLayoutEffect(() => {
    if (!open || !menuPos) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    const menuElement = menuRef.current;
    if (!rect || !menuElement) return;
    const menuWidth = menuElement.offsetWidth;
    if (menuWidth === 0) return;
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 0;
    if (viewportWidth <= 0) return;

    const maxLeft = Math.max(MINIMUM_LEFT, viewportWidth - RIGHT_MARGIN - menuWidth);
    let nextLeft = menuPos.left;

    // If it would overflow on the right, align to the button's right edge.
    if (nextLeft + menuWidth > viewportWidth - RIGHT_MARGIN) {
      nextLeft = rect.right - menuWidth;
    }

    // Clamp within viewport.
    nextLeft = Math.min(maxLeft, Math.max(MINIMUM_LEFT, nextLeft));

    if (nextLeft !== menuPos.left) {
      setMenuPos({ top: menuPos.top, left: nextLeft });
    }
  }, [open, menuPos]);

  return { buttonRef, menuRef, menuPos };
};
