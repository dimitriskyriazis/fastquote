// Pin window/AG-Grid/ancestor scroll across the burst of layout shifts that
// follow grid refreshes (purge in particular shrinks the grid momentarily,
// which makes the browser clamp window.scrollY toward 0). Re-applying the
// captured positions across several rAFs/timers wins the race against those
// shifts. Mirrors the behaviour used by the row-drag flow in AgGridAll.

const findScrollableAncestors = (start: Element | null): HTMLElement[] => {
  if (!start || typeof window === 'undefined') return [];
  const out: HTMLElement[] = [];
  let el: HTMLElement | null = start.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    const style = window.getComputedStyle(el);
    const oy = style.overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
      out.push(el);
    }
    el = el.parentElement;
  }
  return out;
};

// Pins window + scrollable-ancestor scroll. Deliberately does NOT pin the
// AG-Grid viewport scrollTop: that's a pixel offset, and when the dataset
// changes (filter clear, sort, etc.) the same pixel offset shows different
// rows. AG-Grid has its own row-ID-based restoration for that case.
export const captureAndPinScroll = (anchor?: Element | null): void => {
  if (typeof window === 'undefined') return;
  const winY = window.scrollY;
  const ancestors = findScrollableAncestors(anchor ?? null);
  const ancestorSnaps = ancestors.map((el) => ({ el, top: el.scrollTop }));

  const restore = () => {
    if (window.scrollY !== winY) {
      window.scrollTo({ top: winY, behavior: 'auto' });
    }
    for (const snap of ancestorSnaps) {
      if (snap.el.scrollTop !== snap.top) snap.el.scrollTop = snap.top;
    }
  };
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : ((cb: () => void) => setTimeout(cb, 0));
  // Burst across the whole window of layout shifts: synchronous side
  // effects, the rAF AG-Grid uses to re-layout, and the eventual SSRM
  // response (which can take a few hundred ms when the server is slow).
  raf(restore);
  raf(() => raf(restore));
  [0, 16, 50, 100, 150, 250, 400, 600, 900, 1300].forEach((ms) => setTimeout(restore, ms));
};
