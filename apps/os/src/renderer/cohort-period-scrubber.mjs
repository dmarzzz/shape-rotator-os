// Shared "as of …" period scrubber — one polished dot-rail reused across the
// cohort constellation views (pmf evidence, standing, say/did/shipped, collab
// board, relationship map) and echoed as the calendar's week navigator.
//
// It is the evolution of the PMF view's `.ac-jweek` snap-scrubber. Two taste
// fixes the user asked for are baked into the geometry rather than bolted on:
//
//   1. ALIGNED DOTS — the dots AND the gliding indicator are positioned by the
//      SAME fraction (`--cps-f` → `scrubberFrac`), so they can never drift apart.
//   2. A SWEEP FROM DOT TO DOT — the indicator (`.cps-glide`) and the trailing
//      progress fill (`.cps-fill`) carry a `view-transition-name`, so when a
//      commit re-renders the view inside the existing dot-morph View Transition
//      they glide from their old position to the new one instead of jumping.
//
// The native range is kept underneath as the single interaction surface (drag +
// click-to-jump + keyboard), with its thumb hidden — so there is one clear
// indicator, not a knob competing with the notches.
//
// The module stays DOM-light and free of app state: callers build markup from a
// `stops` array + `activeIdx`, and wire commit/preview behaviour via
// `wireScrubber`. The geometry + stop-derivation helpers are pure so they
// unit-test under `node --test` with no DOM (see cohort-period-scrubber.test.mjs).

// Fraction (0..1) of a stop's centre along the rail. Single source of truth for
// BOTH the dots and the gliding indicator — the reason they stay aligned.
export function scrubberFrac(i, last) {
  const n = Number(last) || 0;
  if (n <= 0) return 0;
  const idx = Math.min(Math.max(Number(i) || 0, 0), n);
  return idx / n;
}

// Clamp an index into [0, count-1], rounding non-integers. Used everywhere a raw
// range value or data-attr is read back.
export function clampStopIdx(i, count) {
  const max = Math.max(0, (Number(count) || 0) - 1);
  const v = Number.isFinite(Number(i)) ? Math.round(Number(i)) : 0;
  return Math.min(Math.max(v, 0), max);
}

// Minimal HTML escaping (mirrors alchemy.js escHtml/escAttr; kept local so the
// module has no renderer import). Covers the set that matters in attrs + text.
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Derive weekly stops from the standing-weekly model
// ({weeks:[{program_week,label}]}). compact: first → "start", last → "now",
// else "wk N".
export function weekStopsFrom(weeks) {
  const ws = Array.isArray(weeks) ? weeks : [];
  const last = ws.length - 1;
  return ws.map((w, i) => ({
    label: (w && w.label) || `week ${w && w.program_week != null ? w.program_week : i}`,
    compact: i <= 0 ? "start" : (i === last ? "now" : `wk ${w && w.program_week != null ? w.program_week : i}`),
    value: w && w.program_week != null ? w.program_week : i,
  }));
}

// Derive snapshot stops for the relationship map / collab board, where the axis
// is the cohort timeline (state.constellationTimelineIdx). One stop per snapshot,
// value === its index; the LAST index is the live "now" surface (matching
// activeConstellationCohort's idx >= length-1 ⇒ live rule), so no extra stop.
export function snapshotStopsFrom(snapshots, { nowLabel = "now" } = {}) {
  const snaps = Array.isArray(snapshots) ? snapshots : [];
  const last = snaps.length - 1;
  return snaps.map((s, i) => ({
    label: (s && s.label) || `snapshot ${i + 1}`,
    compact: i === 0 ? "start" : (i === last ? nowLabel : `wk ${i + 1}`),
    value: i,
  }));
}

// Build the scrubber markup. `kind` is a free tag the wiring reads to route the
// commit (e.g. "week" | "snapshot" | "calweek"). `activeIdx` clamps into range.
// Returns "" when there is nothing to scrub (0 or 1 stop) so callers can splice
// it in unconditionally.
export function periodScrubberHtml({
  stops = [],
  activeIdx = 0,
  caption = "as of",
  kind = "week",
  ariaLabel = "as of period",
} = {}) {
  if (!Array.isArray(stops) || stops.length < 2) return "";
  const last = stops.length - 1;
  const sel = clampStopIdx(activeIdx, stops.length);
  const f = (i) => scrubberFrac(i, last).toFixed(4);
  const dots = stops.map((s, i) =>
    `<span class="cps-stop${i === sel ? " is-active" : ""}" style="--cps-f:${f(i)}" data-cps-compact="${esc(s.compact || s.label)}" title="${esc(s.label)}" aria-hidden="true"></span>`
  ).join("");
  const now = stops[sel] && (stops[sel].compact || stops[sel].label) || "";
  const valueText = (stops[sel] && stops[sel].label) || "";
  return `
    <div class="cps" data-cps data-cps-kind="${esc(kind)}" data-cps-last="${last}" role="group" aria-label="${esc(ariaLabel)}">
      <span class="cps-cap" aria-hidden="true">${esc(caption)}</span>
      <span class="cps-rail">
        <span class="cps-fill" style="--cps-f:${f(sel)}" aria-hidden="true"></span>
        ${dots}
        <span class="cps-glide" style="--cps-f:${f(sel)}" aria-hidden="true"></span>
        <input class="cps-range" type="range" min="0" max="${last}" step="1" value="${sel}" data-cps-range
               aria-label="${esc(ariaLabel)}" aria-valuetext="${esc(valueText)}"/>
      </span>
      <span class="cps-now" data-cps-now aria-hidden="true">${esc(now)}</span>
    </div>`;
}

// Wire every scrubber inside `scope`. Idempotent per element (`__cpsWired`).
//
//   onPreview(idx, root)  — fires live during drag/keyboard, cheap: no re-render.
//   onCommit(idx, kind, root) — fires on release / click-to-jump. The caller sets
//                               state and re-renders, ideally inside the shared
//                               View Transition so the indicator sweeps.
//
// The active-dot highlight + live label are updated here; during an active drag
// the indicator tracks the thumb 1:1 (transition suppressed via `.is-dragging`),
// while keyboard/click commits leave the sweep to the View Transition. After a
// commit the rebuilt range is re-focused so keyboard scrubbing survives the
// re-render.
export function wireScrubber(scope, { onPreview, onCommit } = {}) {
  if (!scope) return;
  const roots = typeof scope.matches === "function" && scope.matches("[data-cps]")
    ? [scope]
    : Array.from((scope.querySelectorAll && scope.querySelectorAll("[data-cps]")) || []);
  for (const root of roots) {
    if (root.__cpsWired) continue;
    root.__cpsWired = true;
    const range = root.querySelector("[data-cps-range]");
    const glide = root.querySelector(".cps-glide");
    const fill = root.querySelector(".cps-fill");
    const nowEl = root.querySelector("[data-cps-now]");
    const stops = Array.from(root.querySelectorAll(".cps-stop"));
    const last = Number(root.getAttribute("data-cps-last")) || 0;
    const kind = root.getAttribute("data-cps-kind") || "week";
    if (!range) continue;
    const fracOf = (i) => (last > 0 ? Math.min(Math.max(i, 0), last) / last : 0);

    const markActive = (i) => {
      for (let si = 0; si < stops.length; si++) stops[si].classList.toggle("is-active", si === i);
      const s = stops[i];
      if (nowEl && s) nowEl.textContent = s.getAttribute("data-cps-compact") || nowEl.textContent;
      if (s) range.setAttribute("aria-valuetext", s.getAttribute("title") || "");
    };
    // 1:1 indicator tracking while the user is dragging the thumb.
    const trackGlide = (i) => {
      const f = fracOf(i).toFixed(4);
      if (glide) glide.style.setProperty("--cps-f", f);
      if (fill) fill.style.setProperty("--cps-f", f);
    };

    range.addEventListener("pointerdown", () => root.classList.add("is-dragging"));
    const endDrag = () => root.classList.remove("is-dragging");
    range.addEventListener("pointerup", endDrag);
    range.addEventListener("pointercancel", endDrag);
    range.addEventListener("blur", endDrag);

    range.addEventListener("input", () => {
      const i = clampStopIdx(range.value, last + 1);
      markActive(i);
      if (root.classList.contains("is-dragging")) trackGlide(i); // keyboard leaves the sweep to the VT
      if (typeof onPreview === "function") onPreview(i, root);
    });
    range.addEventListener("change", () => {
      endDrag();
      const i = clampStopIdx(range.value, last + 1);
      if (typeof onCommit === "function") onCommit(i, kind, root);
      // The commit re-renders and destroys this slider; a native range fires
      // `change` on EVERY arrow-key step, so re-focus the rebuilt range or a
      // keyboard user is dropped to <body> after the first step.
      const doc = root.ownerDocument || (typeof document !== "undefined" ? document : null);
      const refocus = () => { try { doc && doc.querySelector("[data-cps-range]") && doc.querySelector("[data-cps-range]").focus({ preventScroll: true }); } catch {} };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(refocus);
      else if (typeof setTimeout === "function") setTimeout(refocus, 0);
    });
  }
}
