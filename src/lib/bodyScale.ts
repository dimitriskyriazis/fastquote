// Helpers for the app-wide body zoom (see base.css — body has
// transform:scale(0.9) with transform-origin top-left).
//
// Consequence of the scale: any element rendered under <body> that is
// positioned by writing viewport-pixel numbers (getBoundingClientRect(),
// event.clientX/clientY, window.innerWidth/Height) into style top/left (CSS
// layout px) renders at 0.9× the intended coordinates — drifting toward the
// top-left, worse the further right/down. Note position:fixed offers no
// escape: a transformed ancestor becomes the containing block, so fixed
// elements under body are scaled too. Writers must divide viewport px by
// getBodyScale() before writing CSS px.

export const getBodyScale = (): number => {
  if (typeof document === 'undefined') return 1;
  const matrix = window.getComputedStyle(document.body).transform;
  const scaleMatch = matrix.match(/^matrix\(([^,]+)/);
  const scale = scaleMatch ? parseFloat(scaleMatch[1]) : 1;
  return scale > 0 && Number.isFinite(scale) ? scale : 1;
};

// ---------------------------------------------------------------------------
// AG Grid overlay corrector
//
// AG Grid positions two kinds of overlays by writing viewport-px values into
// CSS top/left of elements appended to document.body:
//
//  1. The drag image, one wrapper per drag, for every drag type — row drags,
//     column header reordering, and tool-panel drags into Row Groups/Values:
//       <div style="position:absolute; top:..; left:..">  ← positioned wrapper
//         <div class="ag-dnd-ghost">…</div>
//       </div>
//     (_anchorElementToMouseMoveEvent writes clientX/Y-derived values.)
//
//  2. Popups — context menus, column menus, filter menus, select editors —
//     via PopupService (popupParent must be document.body so the parent rect
//     resolves to the unscaled documentElement):
//       <div class="ag-popup">
//         <div class="ag-popup-child" style="top:..; left:..">…</div>
//       </div>
//
// A single body-level childList observer catches both: when a wrapper
// appears, attach a style observer to the positioned element that divides
// every top/left AG Grid writes by the body scale. All writers (including
// our postProcessPopup in AgGridAll) must therefore write absolute
// viewport-px values and never read style.left/top back.
// ---------------------------------------------------------------------------

declare global {
  // Survives Next.js dev HMR module re-evaluation — a second install would
  // attach a second corrector to the same element and divide twice.
  var __FASTQUOTE_AG_OVERLAY_SCALE_FIX__: boolean | undefined;
}

const CORRECTED_ATTR = 'data-fq-scale-corrected';

const attachCorrector = (el: HTMLElement) => {
  if (el.hasAttribute(CORRECTED_ATTR)) return;
  const scale = getBodyScale();
  if (scale === 1) return;
  el.setAttribute(CORRECTED_ATTR, 'true');

  // The observer fires for ANY style change (AG Grid also toggles min-width,
  // max-height, display, …). Remember the last top/left we wrote and only
  // divide values that differ, so an unrelated style write never re-divides
  // an already-corrected position. writtenTop/Left start as NaN to mean
  // "nothing written yet" — that case must still divide, so guard it
  // explicitly (Math.abs(x - NaN) > 0.01 is always false, which would
  // otherwise skip the very first correction and disable the corrector).
  let writtenTop = Number.NaN;
  let writtenLeft = Number.NaN;
  const correct = () => {
    const rawTop = parseFloat(el.style.getPropertyValue('top'));
    const rawLeft = parseFloat(el.style.getPropertyValue('left'));
    if (!Number.isNaN(rawTop) && (Number.isNaN(writtenTop) || Math.abs(rawTop - writtenTop) > 0.01)) {
      writtenTop = rawTop / scale;
      el.style.setProperty('top', `${writtenTop}px`);
    }
    if (!Number.isNaN(rawLeft) && (Number.isNaN(writtenLeft) || Math.abs(rawLeft - writtenLeft) > 0.01)) {
      writtenLeft = rawLeft / scale;
      el.style.setProperty('left', `${writtenLeft}px`);
    }
  };

  // Fires as a microtask after each AG Grid style write, before paint.
  // Disconnect while applying our own write so the division never compounds.
  const observer = new MutationObserver(() => {
    observer.disconnect();
    if (!el.isConnected) return;
    correct();
    observer.observe(el, { attributes: true, attributeFilter: ['style'] });
  });
  correct(); // fix the position written before we attached
  observer.observe(el, { attributes: true, attributeFilter: ['style'] });
};

export const installAgGridOverlayScaleFix = () => {
  if (typeof document === 'undefined') return;
  if (globalThis.__FASTQUOTE_AG_OVERLAY_SCALE_FIX__) return;
  globalThis.__FASTQUOTE_AG_OVERLAY_SCALE_FIX__ = true;

  const bodyObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (!(node instanceof HTMLElement)) return;
        if (node.classList.contains('ag-popup')) {
          node.querySelectorAll<HTMLElement>(':scope > .ag-popup-child').forEach(attachCorrector);
        } else if (node.classList.contains('ag-dnd-ghost') || node.querySelector('.ag-dnd-ghost')) {
          attachCorrector(node);
        }
      });
    }
  });
  bodyObserver.observe(document.body, { childList: true });
};
