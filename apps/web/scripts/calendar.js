import {
  renderWeekView,
  renderSkeletonWeek,
  loadCalendar,
  currentWeekIdx,
  attachWeekViewBehavior,
  renderCohortCalendar,
  exportWeekPng,
  openEventDetail,
} from "@shape-rotator/shape-ui";
import { wireCalendarExportLinks } from "./calendar-links.mjs";
import { fetchPublicCalendarGrid } from "./calendar-supabase-grid.mjs";

// Web cohort calendar — seed with the bundled snapshot from
// cohort-surface.json so first paint is instant, then refresh from the
// same-origin deployed calendar.json. The live Phala endpoint does not send
// browser CORS headers, so web avoids that doomed cross-origin fetch while
// Electron can still use the live endpoint through shape-ui's default loader.
const WEB_CALENDAR_URL = "/calendar.json";
const CALENDAR_REFRESH_MS = 5 * 60 * 1000;

const state = {
  cohort: null,
  data: null,        // raw Phala JSON (live or bundled)
  source: null,      // "live" | "bundled" | null
  weekIdx: 0,
  sub: "week",       // "week" | "presence"
  initialMount: true, // first render-of-week-view? drives mobile scroll-to-today
};

const mount = document.getElementById("mount");
let detachBehavior = null;   // teardown returned by attachWeekViewBehavior

function rerender() {
  if (!mount) return;
  // Tear down any previous mobile behavior listeners before re-rendering,
  // otherwise touch handlers stack up across renders.
  if (detachBehavior) { detachBehavior(); detachBehavior = null; }

  const presenceHtml = state.sub === "presence"
    ? `<div class="cal-presence-canvas-wrap calendar-wrap"></div>`
    : "";

  mount.innerHTML = renderWeekView({
    data: state.data,
    weekIdx: state.weekIdx,
    sub: state.sub,
    source: state.source,
    // Phala calendar.json is the single source of truth for the schedule.
    // The cohort-data/events/*.md anchors duplicate entries already present
    // in the calendar.json cell text (e.g. daily-tea.md + "14:00–14:30 tea
    // on roof" cells → tea showing twice on every weekday). Drop the
    // anchor overlay for now; restore once dedupe + a recurrence model
    // for the markdown events is in place.
    events: [],
    presenceHtml,
    surface: "web",
  });

  if (state.sub === "presence") {
    const wrap = mount.querySelector(".cal-presence-canvas-wrap");
    if (wrap && state.cohort) {
      try { renderCohortCalendar({ container: wrap, cohort: state.cohort }); }
      catch (e) { wrap.innerHTML = `<p class="cal-presence-empty">presence render failed: ${e.message}</p>`; }
    }
  } else {
    // Wire mobile behavior on the week view: swipe-to-navigate + auto-scroll
    // to today on the very first mount (not on every internal re-render —
    // we don't want week-nav clicks to jump the user back to today).
    detachBehavior = attachWeekViewBehavior(mount, {
      scrollToToday: state.initialMount,
      onWeekChange: (delta) => {
        const next = state.weekIdx + delta;
        if (next < 0 || next > 9) return;
        state.weekIdx = next;
        rerender();
      },
    });
    state.initialMount = false;
  }
}

function wire() {
  if (!mount) return;
  mount.addEventListener("click", (e) => {
    const sub = e.target.closest?.("[data-cal-sub]");
    if (sub) {
      const next = sub.dataset.calSub;
      if (next && next !== state.sub) { state.sub = next; rerender(); }
      return;
    }
    const nav = e.target.closest?.("[data-cal-nav]");
    if (nav) {
      const dir = nav.dataset.calNav;
      if (dir === "prev"  && state.weekIdx > 0)  state.weekIdx -= 1;
      else if (dir === "next"  && state.weekIdx < 9) state.weekIdx += 1;
      else if (dir === "today") state.weekIdx = currentWeekIdx();
      else return;
      rerender();
      return;
    }
    const dot = e.target.closest?.(".cal-scrub-dot[data-week]");
    if (dot) {
      const i = Number(dot.dataset.week);
      if (Number.isFinite(i) && i !== state.weekIdx) { state.weekIdx = i; rerender(); }
      return;
    }
    const retry = e.target.closest?.("[data-cal-retry]");
    if (retry) {
      runLiveFetch(); // re-attempt; renderer flips badge when it resolves
      runSupabaseFetch();
      return;
    }
    const png = e.target.closest?.("[data-cal-png]");
    if (png) {
      try { exportWeekPng({ data: state.data, weekIdx: state.weekIdx }); }
      catch (err) { console.warn("[calendar] png export failed", err); }
      return;
    }
    const evCard = e.target.closest?.("[data-cal-event]");
    if (evCard) {
      if (e.target.closest?.("a[href],button")) return;
      openEventDetail(evCard);
      return;
    }
  });

  // ← / → / t keyboard nav on the week sub-view.
  document.addEventListener("keydown", (e) => {
    if (state.sub !== "week") return;
    if (e.target.closest?.("input,textarea,select,[contenteditable]")) return;
    if (e.key === "ArrowLeft"  && state.weekIdx > 0)  { state.weekIdx -= 1; rerender(); }
    else if (e.key === "ArrowRight" && state.weekIdx < 9) { state.weekIdx += 1; rerender(); }
    else if (e.key === "t" || e.key === "T") { state.weekIdx = currentWeekIdx(); rerender(); }
  });
}

// Same-origin committed snapshot (/calendar.json) — the fallback when the live
// Supabase grid is unavailable (offline, outage, or unconfigured key).
async function loadSnapshotCalendar() {
  const bundled = state.cohort?.calendar || null;
  return await loadCalendar({ bundled, url: WEB_CALENDAR_URL, source: "snapshot" });
}

async function runSnapshotFetch() {
  const res = await loadSnapshotCalendar();
  if (res.data) {
    state.data = res.data;
    state.source = res.source;
    rerender();
  }
}

// Live source order: the Supabase public_calendar_grid row (authoritative,
// refreshed within the hour by the calendar-sync workflow) → the same-origin
// /calendar.json snapshot → the bundled cohort-surface already painted. Mirrors
// the OS reader (apps/os/src/renderer/calendar-supabase.mjs) so web + app agree.
async function refreshCalendarSources() {
  const snapshotPromise = loadSnapshotCalendar();
  let grid = null;
  try {
    ({ grid } = await fetchPublicCalendarGrid({ storage: globalThis.localStorage }));
  } catch (err) {
    console.warn("[calendar] supabase fetch failed", err);
  }
  if (grid && grid.tabs) {
    state.data = grid;
    state.source = "live";
    rerender();
    return;
  }
  const snapshot = await snapshotPromise;
  if (snapshot.data) {
    state.data = snapshot.data;
    state.source = snapshot.source;
    rerender();
  }
}

function startRefreshLoop() {
  if (typeof globalThis.setInterval !== "function") return;
  globalThis.setInterval(() => {
    if (document.visibilityState === "hidden") return;
    refreshCalendarSources();
  }, CALENDAR_REFRESH_MS);
}

(async function init() {
  if (!mount) return;
  wireCalendarExportLinks();
  mount.innerHTML = renderSkeletonWeek();
  const r = await fetch("/cohort-surface.json").catch(() => null);
  state.cohort = r && r.ok ? await r.json() : null;
  if (!state.cohort) {
    mount.innerHTML = '<p class="page-empty">cohort data unavailable</p>';
    return;
  }

  // First paint: bundled snapshot for instant render.
  const bundled = state.cohort.calendar || null;
  if (bundled) {
    state.data = bundled;
    state.source = "bundled";
  }
  state.weekIdx = currentWeekIdx();
  state.sub = "week";

  rerender();
  wire();

  // Then try the live Phala fetch in the background.
  refreshCalendarSources();
  startRefreshLoop();
})();
