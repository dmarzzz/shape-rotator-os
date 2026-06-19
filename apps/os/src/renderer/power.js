// power.js — app-wide render-activity coordinator (battery).
//
// Electron only throttles a renderer when its window is MINIMIZED or fully
// OCCLUDED (the default `backgroundThrottling`, keyed off document visibility).
// A window that is merely BLURRED — visible on a second monitor, or sitting
// behind the app you are actually typing in — keeps every requestAnimationFrame
// loop running at the full refresh rate. That is the common battery-drain case
// this module addresses: heavy WebGL loops read the current frame budget here
// and pause / throttle when the app is not the focused, visible window.
//
// State → frame budget for animation:
//   hidden  (minimized / occluded)        → paused    (Infinity ms, skip draw)
//   blurred (visible but not focused)      → ~10 fps   (BLUR_FRAME_MS)
//   active  (visible + focused)            → full rate (render every frame)

export const BLUR_FRAME_MS = 1000 / 10;   // visible-but-unfocused: keep it alive, barely

let focused =
  typeof document !== "undefined" && typeof document.hasFocus === "function"
    ? document.hasFocus()
    : true;
let visible = typeof document === "undefined" ? true : !document.hidden;

function state() {
  if (!visible) return "hidden";
  return focused ? "active" : "blurred";
}

const listeners = new Set();
function emit() {
  const s = state();
  for (const fn of listeners) {
    try { fn(s); } catch (e) { console.error("[power]", e); }
  }
}

function setFocused(v) { v = !!v; if (v === focused) return; focused = v; emit(); }
function setVisible(v) { v = !!v; if (v === visible) return; visible = v; emit(); }

if (typeof window !== "undefined") {
  window.addEventListener("focus", () => setFocused(true));
  window.addEventListener("blur", () => setFocused(false));
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => setVisible(!document.hidden));
}

// Coarse state: "active" | "blurred" | "hidden".
export function powerState() { return state(); }
export function isActive() { return state() === "active"; }

// Milliseconds a loop should wait between RENDERED frames given the current
// state. Returns Infinity when the loop should not draw at all (hidden), and 0
// when active (render every frame). Only throttles while blurred.
export function frameBudgetMs() {
  const s = state();
  if (s === "hidden") return Infinity;
  if (s === "blurred") return BLUR_FRAME_MS;
  return 0;
}

// Subscribe to coarse state changes. Fires once immediately with the current
// state. Returns an unsubscribe fn.
export function onPowerChange(fn) {
  listeners.add(fn);
  try { fn(state()); } catch (e) { console.error("[power]", e); }
  return () => listeners.delete(fn);
}
