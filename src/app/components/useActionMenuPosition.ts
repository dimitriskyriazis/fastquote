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
const BOTTOM_MARGIN = 12;

export const useActionMenuPosition = (open: boolean): Result => {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPos(null);
      return;
    }
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = rect.left;
    setMenuPos({ top: rect.bottom + MENU_SPACING, left });
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

  return { buttonRef, menuRef, menuPos };
};
