'use client';

import { useRef, useState, useEffect, useCallback, type CSSProperties, type ReactNode, type PointerEvent as ReactPointerEvent } from 'react';
import React from 'react';
import handleStyles from './useModalDragResize.module.css';

type Options = {
  draggable?: boolean;
  resizable?: boolean;
  minWidth?: number;
  minHeight?: number;
  maxWidth?: number;
  maxHeight?: number;
};

const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A']);
const VIEWPORT_MARGIN = 16;

const HANDLE_DEFS = [
  { key: 'n', edges: 'top', cls: handleStyles.handleN },
  { key: 's', edges: 'bottom', cls: handleStyles.handleS },
  { key: 'e', edges: 'right', cls: handleStyles.handleE },
  { key: 'w', edges: 'left', cls: handleStyles.handleW },
  { key: 'ne', edges: 'top,right', cls: handleStyles.handleNE },
  { key: 'nw', edges: 'top,left', cls: handleStyles.handleNW },
  { key: 'se', edges: 'bottom,right', cls: handleStyles.handleSE },
  { key: 'sw', edges: 'bottom,left', cls: handleStyles.handleSW },
] as const;

function parseEdges(edgesStr: string) {
  const parts = edgesStr.split(',');
  return {
    top: parts.includes('top'),
    bottom: parts.includes('bottom'),
    left: parts.includes('left'),
    right: parts.includes('right'),
  };
}

export function useModalDragResize(options: Options = {}) {
  const {
    draggable = false,
    resizable = false,
    minWidth = 280,
    minHeight = 200,
    maxWidth,
    maxHeight,
  } = options;

  const cardElRef = useRef<HTMLDivElement | null>(null);
  const offsetRef = useRef({ x: 0, y: 0 });
  const sizeRef = useRef<{ w: number | null; h: number | null }>({ w: null, h: null });
  const optsRef = useRef({ resizable, minWidth, minHeight, maxWidth, maxHeight });
  const [, setRenderToken] = useState(0);

  useEffect(() => {
    optsRef.current = { resizable, minWidth, minHeight, maxWidth, maxHeight };
  });

  const cardRef = useCallback((el: HTMLDivElement | null) => {
    cardElRef.current = el;
  }, []);

  const applyTransform = useCallback(() => {
    const el = cardElRef.current;
    if (!el) return;
    const { x, y } = offsetRef.current;
    el.style.transform = x === 0 && y === 0 ? '' : `translate(${x}px, ${y}px)`;
    const { w, h } = sizeRef.current;
    el.style.width = w != null ? `${w}px` : '';
    el.style.height = h != null ? `${h}px` : '';
  }, []);

  const clampOffset = useCallback(() => {
    const el = cardElRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let { x, y } = offsetRef.current;

    if (rect.left < VIEWPORT_MARGIN) x += VIEWPORT_MARGIN - rect.left;
    if (rect.top < VIEWPORT_MARGIN) y += VIEWPORT_MARGIN - rect.top;
    if (rect.right > vw - VIEWPORT_MARGIN) x -= rect.right - (vw - VIEWPORT_MARGIN);
    if (rect.bottom > vh - VIEWPORT_MARGIN) y -= rect.bottom - (vh - VIEWPORT_MARGIN);

    offsetRef.current = { x, y };
  }, []);

  const resetPosition = useCallback(() => {
    offsetRef.current = { x: 0, y: 0 };
    sizeRef.current = { w: null, h: null };
    applyTransform();
    setRenderToken((t) => t + 1);
  }, [applyTransform]);

  // --- Drag ---
  const handleHeaderPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      if (!draggable) return;
      const tag = (e.target as HTMLElement).tagName;
      if (INTERACTIVE_TAGS.has(tag)) return;
      if ((e.target as HTMLElement).closest('button, a, input, textarea, select')) return;

      const el = cardElRef.current;
      if (!el) return;

      e.preventDefault();

      // Lock the current size on first drag so CSS-driven size won't shift
      if (sizeRef.current.w == null) {
        const rect = el.getBoundingClientRect();
        sizeRef.current = { w: rect.width, h: rect.height };
        applyTransform();
      }

      const startX = e.clientX;
      const startY = e.clientY;
      const startOffset = { ...offsetRef.current };
      const header = e.currentTarget as HTMLElement;
      header.setPointerCapture(e.pointerId);

      // Capture rect ONCE — compute clamped positions mathematically to avoid
      // getBoundingClientRect() on every pointermove (which forces reflow).
      const startRect = el.getBoundingClientRect();
      const naturalLeft = startRect.left - startOffset.x;
      const naturalTop = startRect.top - startOffset.y;
      const modalW = startRect.width;
      const modalH = startRect.height;

      const onMove = (me: globalThis.PointerEvent) => {
        let x = startOffset.x + (me.clientX - startX);
        let y = startOffset.y + (me.clientY - startY);

        // Clamp so the modal stays within the viewport
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const left = naturalLeft + x;
        const top = naturalTop + y;
        const right = left + modalW;
        const bottom = top + modalH;

        if (left < VIEWPORT_MARGIN) x += VIEWPORT_MARGIN - left;
        if (top < VIEWPORT_MARGIN) y += VIEWPORT_MARGIN - top;
        if (right > vw - VIEWPORT_MARGIN) x -= right - (vw - VIEWPORT_MARGIN);
        if (bottom > vh - VIEWPORT_MARGIN) y -= bottom - (vh - VIEWPORT_MARGIN);

        offsetRef.current = { x, y };
        applyTransform();
      };
      const onUp = () => {
        header.removeEventListener('pointermove', onMove);
        header.removeEventListener('pointerup', onUp);
        setRenderToken((t) => t + 1);
      };
      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
    },
    [draggable, applyTransform],
  );

  const handleHeaderDoubleClick = useCallback(() => {
    if (!draggable) return;
    resetPosition();
  }, [draggable, resetPosition]);

  // --- Resize ---
  const handleResizePointerDown = useCallback(
    (e: ReactPointerEvent) => {
      const opts = optsRef.current;
      if (!opts.resizable) return;
      e.preventDefault();
      e.stopPropagation();

      const edgesStr = (e.currentTarget as HTMLElement).dataset.edges;
      if (!edgesStr) return;
      const edges = parseEdges(edgesStr);

      const el = cardElRef.current;
      if (!el) return;

      const startRect = el.getBoundingClientRect();
      const startOffset = { ...offsetRef.current };
      const startW = sizeRef.current.w ?? startRect.width;
      const startH = sizeRef.current.h ?? startRect.height;
      const startX = e.clientX;
      const startY = e.clientY;
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);

      const effMaxW = opts.maxWidth ?? window.innerWidth - VIEWPORT_MARGIN * 2;
      const effMaxH = opts.maxHeight ?? window.innerHeight - VIEWPORT_MARGIN * 2;

      const onMove = (me: globalThis.PointerEvent) => {
        const dx = me.clientX - startX;
        const dy = me.clientY - startY;
        let newW = startW;
        let newH = startH;
        let newOx = startOffset.x;
        let newOy = startOffset.y;

        if (edges.right) newW = startW + dx;
        if (edges.left) {
          newW = startW - dx;
          newOx = startOffset.x + dx;
        }
        if (edges.bottom) newH = startH + dy;
        if (edges.top) {
          newH = startH - dy;
          newOy = startOffset.y + dy;
        }

        const clampedW = Math.max(opts.minWidth, Math.min(newW, effMaxW));
        const clampedH = Math.max(opts.minHeight, Math.min(newH, effMaxH));

        if (edges.left) newOx = startOffset.x + (startW - clampedW);
        if (edges.top) newOy = startOffset.y + (startH - clampedH);

        sizeRef.current = { w: clampedW, h: clampedH };
        offsetRef.current = { x: newOx, y: newOy };
        applyTransform();
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        setRenderToken((t) => t + 1);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
    },
    [applyTransform],
  );

  // --- Window resize clamp ---
  useEffect(() => {
    if (!draggable && !resizable) return undefined;
    let raf = 0;
    const onResize = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        clampOffset();
        applyTransform();
      });
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => {
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
    };
  }, [draggable, resizable, clampOffset, applyTransform]);

  // --- Resize handles (handler only reads ref inside pointer event, not during render) ---
  /* eslint-disable react-hooks/refs */
  const resizeHandles: ReactNode = resizable
    ? HANDLE_DEFS.map((h) =>
        React.createElement('div', {
          key: h.key,
          className: `${handleStyles.resizeHandle} ${h.cls}`,
          'data-edges': h.edges,
          onPointerDown: handleResizePointerDown,
        }),
      )
    : null;
  /* eslint-enable react-hooks/refs */

  // --- Return values ---
  const cardStyle: CSSProperties =
    draggable || resizable ? { position: 'relative' as const, willChange: 'transform' } : {};

  const headerProps = {
    onPointerDown: handleHeaderPointerDown,
    onDoubleClick: handleHeaderDoubleClick,
    style: draggable ? ({ cursor: 'move', userSelect: 'none' } as CSSProperties) : ({} as CSSProperties),
  };

  return { cardRef, cardStyle, headerProps, resizeHandles, resetPosition };
}
