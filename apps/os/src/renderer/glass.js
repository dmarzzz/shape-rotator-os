// ─── glass.js — cursor-tracking specular sheen for liquid-glass panels ─────
//
// The cohort's signature liquid motif: a soft specular highlight that tracks
// the pointer across glass panels (the inspector, generated readouts, and the
// view-specific glass surfaces tagged `.lg-track`). All the painting happens
// in CSS — a radial-gradient highlight anchored at the custom properties
// `--lg-mx` / `--lg-my` (see styles.css `.lg-panel` / `.ac-inspector`). This
// module's only job is to move those two numbers on pointermove.
//
// Why this shape:
//   • No React, no per-element rAF loop — we write straight to the element's
//     style (the house "bypass the framework for 60fps" rule), throttled to
//     one write per animation frame.
//   • The intensity is owned by the `--lg-sheen` token, not here — raising the
//     dose later is a one-line CSS change, this file never changes.
//   • prefers-reduced-motion → we never attach the listener, so the static
//     default glint (anchored near the top edge) is all that shows.

const SHEEN_SELECTOR = ".lg-track, .ac-inspector, .ac-main-readout";

let rafId = 0;
let pending = null; // { el, x, y } — coalesced to the next frame

function flush() {
  rafId = 0;
  const next = pending;
  pending = null;
  if (!next) return;
  next.el.style.setProperty("--lg-mx", next.x.toFixed(1) + "%");
  next.el.style.setProperty("--lg-my", next.y.toFixed(1) + "%");
}

function onMove(e) {
  const el = e.target && e.target.closest ? e.target.closest(SHEEN_SELECTOR) : null;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return;
  pending = {
    el,
    x: ((e.clientX - r.left) / r.width) * 100,
    y: ((e.clientY - r.top) / r.height) * 100,
  };
  if (!rafId) rafId = requestAnimationFrame(flush);
}

export function init() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch {}
  document.addEventListener("pointermove", onMove, { passive: true });
}
