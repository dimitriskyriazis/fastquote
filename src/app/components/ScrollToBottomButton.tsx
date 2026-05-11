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

export default function ScrollToBottomButton() {
  const [visible, setVisible] = useState(false);
  const targetRef = useRef<HTMLElement | Window | null>(null);
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
      let el: HTMLElement | Window | null = null;
      if (target instanceof Document) {
        el = window;
      } else if (target instanceof HTMLElement && isScrollable(target)) {
        el = target;
      } else {
        el = window;
      }

      let scrollTop: number;
      let scrollHeight: number;
      let clientHeight: number;
      if (el === window) {
        scrollTop = window.scrollY;
        scrollHeight = document.documentElement.scrollHeight;
        clientHeight = window.innerHeight;
      } else {
        const h = el as HTMLElement;
        scrollTop = h.scrollTop;
        scrollHeight = h.scrollHeight;
        clientHeight = h.clientHeight;
      }

      const scrolledDown = scrollTop > THRESHOLD;
      const notAtBottom = scrollTop + clientHeight < scrollHeight - 4;

      if (scrolledDown && notAtBottom) {
        targetRef.current = el;
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

  const jumpAllToBottom = () => {
    const BIG = 1e9;
    window.scrollTo(0, BIG);
    document.documentElement.scrollTop = BIG;
    document.body.scrollTop = BIG;
    document.querySelectorAll<HTMLElement>("*").forEach((node) => {
      if (isScrollable(node)) {
        node.scrollTop = node.scrollHeight;
      }
    });
  };

  const handleClick = () => {
    jumpAllToBottom();
    // Re-issue in case content grows from virtualization/lazy-load after the first jump.
    requestAnimationFrame(jumpAllToBottom);
    setTimeout(jumpAllToBottom, 100);
    setTimeout(jumpAllToBottom, 300);
    setTimeout(jumpAllToBottom, 700);
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
        right: 24,
        bottom: 24,
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
