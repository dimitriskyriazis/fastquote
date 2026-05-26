"use client";

import { useEffect, useRef, useState } from "react";

const THRESHOLD = 200;
// Number of distinct scroll gestures in the same direction before the button appears
const SCROLL_STREAK = 2;
// A new gesture is counted only if this many ms have passed since the last scroll event.
// Mouse wheel notches fire a burst of events within ~50ms, then pause ~100-250ms before
// the next notch — so 150ms groups the burst but separates notches as distinct gestures.
const GESTURE_GAP_MS = 150;
// Auto-hide the button after this long
const HIDE_DELAY_MS = 3000;

function isScrollable(el: Element): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  const oy = style.overflowY;
  return (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1;
}

const PANEL_SELECTORS = [".offer-products-grid", ".price-list-products-grid", ".fq-grid-panel"];

type Anchor = { panel: HTMLElement; selector: string };

function findAnchor(node: HTMLElement): Anchor | null {
  for (const selector of PANEL_SELECTORS) {
    const panel = node.closest<HTMLElement>(selector);
    if (panel) return { panel, selector };
  }
  return null;
}

type ButtonMode = "bottom" | "top";

export default function ScrollToBottomButton() {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState<ButtonMode>("bottom");
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 24, bottom: 24 });
  const anchorRef = useRef<Anchor | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // streak > 0: consecutive downward gestures; streak < 0: consecutive upward gestures
  const streakRef = useRef<number>(0);
  const lastScrollTopRef = useRef<Map<HTMLElement, number>>(new Map());
  // Timestamp of the last scroll event — used to detect gesture boundaries
  const lastScrollTimeRef = useRef<number>(0);
  const streakResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    const onScroll = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLElement) || !isScrollable(target)) return;

      const anchor = findAnchor(target);
      if (!anchor) return;

      const now = Date.now();
      const prevScrollTop = lastScrollTopRef.current.get(target) ?? target.scrollTop;
      const currentScrollTop = target.scrollTop;
      const delta = currentScrollTop - prevScrollTop;
      lastScrollTopRef.current.set(target, currentScrollTop);

      if (delta === 0) return;

      const timeSinceLast = now - lastScrollTimeRef.current;
      lastScrollTimeRef.current = now;

      // --- Gesture counting ---
      // A single physical scroll (wheel notch, trackpad swipe) fires many rapid events.
      // We only count the FIRST event after a pause (≥ GESTURE_GAP_MS) as a new gesture.
      // If direction changed, always reset streak regardless of timing.
      const scrollingDown = delta > 0;
      const directionChanged = scrollingDown ? streakRef.current < 0 : streakRef.current > 0;

      if (directionChanged) {
        // Switched direction — start fresh in new direction
        streakRef.current = scrollingDown ? 1 : -1;
      } else if (timeSinceLast >= GESTURE_GAP_MS) {
        // New gesture in the same direction — increment
        streakRef.current += scrollingDown ? 1 : -1;
      }
      // else: rapid continuation of the same gesture — don't increment

      // Reset streak if the user stops scrolling for a while
      if (streakResetTimerRef.current) clearTimeout(streakResetTimerRef.current);
      streakResetTimerRef.current = setTimeout(() => { streakRef.current = 0; }, 1500);

      const scrollTop = currentScrollTop;
      const scrollHeight = target.scrollHeight;
      const clientHeight = target.clientHeight;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 4;
      const atTop = scrollTop <= THRESHOLD;

      // Hide if we've reached the natural edge (no point showing the button)
      if ((scrollingDown && atBottom) || (!scrollingDown && atTop)) {
        clearHideTimer();
        setVisible(false);
        streakRef.current = 0;
        return;
      }

      // Show "scroll to bottom" after SCROLL_STREAK downward gestures
      if (streakRef.current >= SCROLL_STREAK) {
        streakRef.current = 0; // reset so it takes 3 more gestures to trigger again
        const rect = anchor.panel.getBoundingClientRect();
        setPos({
          right: Math.max(8, window.innerWidth - rect.right + 24),
          bottom: Math.max(8, window.innerHeight - rect.bottom + 24),
        });
        anchorRef.current = anchor;
        setMode("bottom");
        setVisible(true);
        scheduleHide();
        return;
      }

      // Show "scroll to top" after SCROLL_STREAK upward gestures
      if (streakRef.current <= -SCROLL_STREAK) {
        streakRef.current = 0; // reset so it takes 3 more gestures to trigger again
        const rect = anchor.panel.getBoundingClientRect();
        setPos({
          right: Math.max(8, window.innerWidth - rect.right + 24),
          bottom: Math.max(8, window.innerHeight - rect.bottom + 24),
        });
        anchorRef.current = anchor;
        setMode("top");
        setVisible(true);
        scheduleHide();
        return;
      }

      // Streak not yet reached — leave visibility as-is (hide timer manages auto-hide)
    };

    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      clearHideTimer();
      if (streakResetTimerRef.current) clearTimeout(streakResetTimerRef.current);
    };
  }, []);

  const jumpAnchorToBottom = () => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchor.panel.querySelectorAll<HTMLElement>("*").forEach((node) => {
      if (isScrollable(node)) node.scrollTop = node.scrollHeight;
    });
  };

  const jumpAnchorToTop = () => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchor.panel.querySelectorAll<HTMLElement>("*").forEach((node) => {
      if (isScrollable(node)) node.scrollTop = 0;
    });
  };

  const handleClick = () => {
    if (mode === "bottom") {
      jumpAnchorToBottom();
      requestAnimationFrame(jumpAnchorToBottom);
      setTimeout(jumpAnchorToBottom, 100);
      setTimeout(jumpAnchorToBottom, 300);
      setTimeout(jumpAnchorToBottom, 700);
    } else {
      jumpAnchorToTop();
      requestAnimationFrame(jumpAnchorToTop);
      setTimeout(jumpAnchorToTop, 100);
    }
    setVisible(false);
    streakRef.current = 0;
  };

  if (!visible) return null;

  const isTop = mode === "top";

  return (
    <button
      type="button"
      onClick={handleClick}
      aria-label={isTop ? "Scroll to top" : "Scroll to bottom"}
      title={isTop ? "Scroll to top" : "Scroll to bottom"}
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
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ transform: isTop ? "rotate(180deg)" : undefined }}
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
      {isTop ? "Scroll to top" : "Scroll to bottom"}
    </button>
  );
}
