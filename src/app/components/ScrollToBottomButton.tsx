"use client";

import { useEffect, useRef, useState } from "react";

const THRESHOLD = 200;

function isScrollable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  const oy = style.overflowY;
  return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
}

const HIDE_DELAY_MS = 3000;

// Selectors for the two panels that can host this button — order matters: most-specific first.
const PANEL_SELECTORS = [".offer-products-grid", ".price-list-products-grid", ".fq-grid-panel"];

type Anchor = { panel: HTMLElement; selector: string };

function findAnchor(node: HTMLElement): Anchor | null {
  for (const selector of PANEL_SELECTORS) {
    const panel = node.closest<HTMLElement>(selector);
    if (panel) return { panel, selector };
  }
  return null;
}

export default function ScrollToBottomButton() {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 24, bottom: 24 });
  const anchorRef = useRef<Anchor | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const clearHideTimer = () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
    const scheduleHide = () => {
      clearHideTimer();
      hideTimerRef.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
    };

    const evaluate = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement) || !isScrollable(target)) {
        clearHideTimer();
        setVisible(false);
        return;
      }

      const anchor = findAnchor(target);
      if (!anchor) {
        clearHideTimer();
        setVisible(false);
        return;
      }

      const scrollTop = target.scrollTop;
      const scrollHeight = target.scrollHeight;
      const clientHeight = target.clientHeight;

      const scrolledDown = scrollTop > THRESHOLD;
      const notAtBottom = scrollTop + clientHeight < scrollHeight - 4;

      if (scrolledDown && notAtBottom) {
        const rect = anchor.panel.getBoundingClientRect();
        setPos({
          right: Math.max(8, window.innerWidth - rect.right + 24),
          bottom: Math.max(8, window.innerHeight - rect.bottom + 24),
        });
        anchorRef.current = anchor;
        setVisible(true);
        scheduleHide();
      } else {
        clearHideTimer();
        setVisible(false);
      }
    };

    const onScroll = (e: Event) => evaluate(e.target);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      clearHideTimer();
    };
  }, []);

  const jumpAnchorToBottom = () => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchor.panel.querySelectorAll<HTMLElement>("*").forEach((node) => {
      if (isScrollable(node)) {
        node.scrollTop = node.scrollHeight;
      }
    });
  };

  const handleClick = () => {
    jumpAnchorToBottom();
    // Re-issue in case content grows from virtualization/lazy-load after the first jump.
    requestAnimationFrame(jumpAnchorToBottom);
    setTimeout(jumpAnchorToBottom, 100);
    setTimeout(jumpAnchorToBottom, 300);
    setTimeout(jumpAnchorToBottom, 700);
  };

  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Scroll to bottom"
      title="Scroll to bottom"
      style={{
        position: "fixed",
        right: pos.right,
        bottom: pos.bottom,
        zIndex: 9999,
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        padding: "10px 14px",
        borderRadius: 999,
        border: "1px solid rgba(248, 113, 113, 0.35)",
        background: "#dc2626",
        color: "#ffffff",
        fontWeight: 600,
        fontSize: "0.85rem",
        cursor: "pointer",
        boxShadow: "0 12px 26px rgba(220, 38, 38, 0.4)",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
      Scroll to bottom
    </button>
  );
}
