// Alchemy tab. Cohort-progress sandbox. Four exploratory views behind a
// left-rail switcher: legend (the shape vocabulary), shapes (the cohort
// rendered as those shapes), pulse, constellation. Aesthetic bridges
// atlas (dark cyber) and shaperotator.xyz (museum-specimen brutalism on
// warm paper) — same dark stage, oxide-red signature, mono small-caps
// "specimen tag" treatment, slow tilt/breathe motion.
//
// Data comes from cohort-source.js (the §4.5 abstraction). This module
// never touches swf-node directly. Only surface fields are read here —
// alchemist-only fields (class, archetype, status, etc.) live on the
// alchemist app's depth-bundle path and never enter this bundle.
//
// Public API matches atlas.js / cosmos.js / graph2.js so boot.js can
// mount this the same way:
//   mount(container)        - idempotent
//   setActive(bool)         - pause/resume any animations
//   notifyDataChanged()     - rebuild from latest data

import {
  SHAPES, SHAPE_BY_KEY, shapeForTeam, shapeSvgByFam, domainLabel,
  mountShape, mountShapesIn,
  // Extracted into shape-ui so the sibling web app can render the same
  // cohort surface. The Electron renderer keeps the same call sites —
  // only the implementations moved.
  escHtml, escAttr, normalizeLinkHref,
  buildEditPRUrl,
  teamCardHtml, personCardHtml,
  buildCalendarRows, drawCalendar,
  renderWeekView as renderCalendarWeekView,
  loadCalendar as loadCalendarData,
  currentWeekIdx as calendarCurrentWeekIdx,
  parseWeekRow as calendarParseWeekRow,
  attachWeekViewBehavior as attachCalendarMobileBehavior,
} from "@shape-rotator/shape-ui";
import {
  aggregateSkillAreas, buildCohortIndex, buildCollabModel, collabAffKey,
  constellationIndegree, constellationModel, teamKind, teamsOfKind,
} from "./cohort-relations.js";
import {
  contextRawScriptById as findContextRawScriptById,
  contextSourceById as findContextSourceById,
} from "./context-vault-model.js";
import { getCohortSurface, subscribeToCohortChanges, isSyncAvailable } from "./cohort-source.js";
import { resolvePRForCurrentUser, clearForkCache } from "./gh-fork.js";
import { enrichPeople } from "./gh-user.js";
import { putLocalRecord, getRecord, getHealth, getManifest, getNodeLog } from "./sync-client.js";
import { toast } from "./ux.js";
import { getTheme, toggleTheme } from "./theme.js";
import { getIdentity } from "./identity.js";
import {
  askAgeLabel, askIsCurrent, askIsOpen, askStatus, askTopic, asksWithStatus,
  isAskMine, normalizeAskIdentity, resolveAskAuthor, resolveAskIdentityPerson,
} from "./asks.js";
// Membrane mode — 2026-05 redesign. Pressurized-membrane object that replaces
// the 7-rail nav with a 4-blob constellation. Lives behind data-alch-mode
// "membrane" so the legacy modes stay reachable while we evaluate.
import { mountMembrane } from "./membrane/index.js";
import { CALENDAR_TRANSCRIPT_MATCHES } from "../content/context/calendar-transcript-matches.js";
import { renderIntel, wireIntel } from "./intel/intel.js";

const ALCHEMY_LS_KEY  = "srwk:alchemy_mode";
const PROFILE_LS_KEY  = "srwk:profile_v1";
const EVENTS_LS_KEY   = "srwk:cohort_events_v1";
const DETAIL_LS_KEY   = "srwk:alchemy_detail_v1";
// `atlas` was here as an alchemy sub-mode but collides with the top-level
// atlas tab (the swf-node wall-map). Renderer (renderAtlas / wireAtlas) is
// kept in place so the view can be promoted to a top tab later under a
// different name if desired — just unreachable from the alchemy rail today.
// "feed" is intentionally absent from the rail and mode list as of 2026-05.
// The renderer (renderFeed) and fetcher (refreshFeed) are still in the file
// because we plan to bring the feed back as a teleport-router-fed surface
// once that integration lands; rather than rip out the code and re-write it
// from git history, the surfaces are simply unwired. See the "feed off"
// section below this constant for the disabled hooks.
const ALCHEMY_MODES   = ["membrane", "shapes", "pulse", "constellation", "intel", "collab", "calendar", "profile", "onboarding", "program", "asks", "context"];
const MEMBRANE_INTRO_LS_KEY = "srwk:membrane_seen_v1";

const WEEKS_TOTAL = 10;
const WEEK_NOW = 1; // TODO: bump weekly, or derive from a cohort start date.

// GitHub event refresh cadence. Each refresh hits api.github.com once
// per tracked repo + once per cohort github handle — ~35 requests on a
// typical cohort, well above the 60 req/hr unauth budget if we run it
// often. Activity feeds aren't time-sensitive (vs. cohort sync, which
// has its own live P2P channel via swf-node), so we tick once a day in
// the background and rely on the "refresh" button in the feed header for
// on-demand pulls. The interval is additionally gated on the feed tab
// being visible — no point burning quota when nobody's looking.
const FEED_REFRESH_MS = 24 * 60 * 60 * 1000;

// Feed kill-switch — disabled per user request 2026-05-20. The feed tab
// hits api.github.com /events ~35×/refresh and is the last remaining
// rate-limit offender after v0.1.39's cohort-sync fix. While off:
//   - the rail button is `hidden` in src/index.html
//   - any stored `mode === "feed"` is migrated to "shapes" on mount
//   - refreshFeed() short-circuits, so no background poll, no timer fire
// To bring it back: flip FEED_DISABLED to false and remove the `hidden`
// attribute on the rail button (index.html around line 300).
const FEED_DISABLED = true;

// Where the cohort-data markdown lives. Profile tab surfaces a link to
// each team's record so participants can edit it directly. Hardcoded
// for now — if this repo is ever renamed or the cohort-data dir moves
// to a separate repo (D4 from the spec walkthrough), update this.
const COHORT_DATA_REPO = "https://github.com/dmarzzz/shape-rotator-os";
const COHORT_DATA_BRANCH = "main";
const COHORT_WEB_BASE_URL = "https://shape-rotator-os.vercel.app";
function teamRecordEditUrl(record_id) {
  return `${COHORT_DATA_REPO}/edit/${COHORT_DATA_BRANCH}/cohort-data/teams/${record_id}.md`;
}
function teamRecordViewUrl(record_id) {
  return `${COHORT_DATA_REPO}/blob/${COHORT_DATA_BRANCH}/cohort-data/teams/${record_id}.md`;
}
function cohortRecordUrl(record_id) {
  return `${COHORT_WEB_BASE_URL}/cohort#${encodeURIComponent(String(record_id || ""))}`;
}

const state = {
  mounted: false,
  active: false,
  container: null,
  canvas: null,
  rail: null,
  mode: "membrane",  // default rail landing — membrane is the 2026-05 redesign
  menuOpen: false,   // membrane-only rail overlay, toggled from the top OS tab
  membraneController: null,  // active membrane scene controller (mounted lazily on first membrane render)
  shapesKindFilter: "works",  // "works" (teams + projects) | "people"
  shapesMembershipFilter: "cohort",  // works: "cohort" | "visiting" | "all";
                                     // people: "cohort-member" | "visiting-scholar" | "coordinator" | "all".
                                     // We default to "cohort" / "cohort-member" so the formally-invited
                                     // cohort is the first thing visitors see — important per the
                                     // coordinator's note about not implying a 1-in-30 invite rate.
  detailRecordId: null,     // when set, the alchemy canvas renders the full detail page for this team/project
  detailReturnMode: null,   // remembered so the back button knows where to land
  shapeControllers: [],     // active shader-canvas controllers — destroyed before each re-render so GL contexts don't leak
  cohort: null,        // { teams, clusters, people, program, asks, cohort_vocab } from cohort-source
  profile: null,       // local-only: { user, editor state, ... }
  programPage: null,   // active program-handbook page slug (overview | success | rules | schedule)
  atlasFocus: null,    // active tag in the atlas view (null = whole-graph mode)
  onboardingJustToggled: null,  // step key that was just marked/unmarked done; consumed by wireOnboarding to scroll-into-view the next step
  openAskComposer: false, // one-shot landing state when membrane sends someone to post
  constellationMode: "clusters",  // "clusters" (shared cluster membership) | "dependencies" (team-asserted dependency edges)
  constellationLayout: "wells",    // "wells" (cluster-grouped grid) | "circle" (single ring — the original view)
  calendar: {                     // calendar tab state — see renderCalendar()
    sub: "day",                   // "day" (typeset today agenda) | "week" (broadsheet grid) | "presence" (availability gantt)
    weekIdx: null,                // 0..9; resolved on first render via calendarCurrentWeekIdx()
    dayIdx: null,                 // 0..6 (mon..sun) within visible week; null = pick today if in week, else mon
    data: null,                   // raw Phala JSON — live response or bundled snapshot
    source: null,                 // "live" | "bundled" | null (no data yet)
    initialMount: true,           // first render-of-week-view? drives mobile scroll-to-today
    detachMobile: null,           // teardown returned by attachCalendarMobileBehavior
    loading: false,               // true while the async live fetch is in flight
  },
  events: [],          // normalized feed items, latest-first
  fetchedAt: 0,
  isFetching: false,
  contextVault: {
    loaded: false,
    loading: false,
    manifest: null,
    roots: [],
    mode: "articles",
    selectedId: null,
    selectedRawId: null,
    selectedText: "",
    selectedTruncated: false,
    pendingRawPath: null,
    rawTextById: {},
    rawLoadingId: null,
    error: "",
    message: "",
  },
  unsubscribe: null,
  refreshTimer: null,
};

export function mount(container) {
  if (state.mounted) return;
  state.container = container;
  state.canvas = document.getElementById("alchemy-canvas");
  state.rail = container.querySelector(".alchemy-rail");
  if (!state.canvas || !state.rail) return;

  try {
    const saved = localStorage.getItem(ALCHEMY_LS_KEY);
    if (saved && ALCHEMY_MODES.includes(saved)) state.mode = saved;
    // Migrations:
    if (saved === "specimens") { state.mode = "shapes"; localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); }
    if (saved === "legend")    { state.mode = "shapes"; localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); }
    // feed-off: any user whose saved mode is "feed" lands on the cohort
    // grid instead of a dead tab. Restore symmetry when the feed comes
    // back as a teleport-router surface.
    if (saved === "feed")      { state.mode = "shapes"; localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); }
    // Defensive: if state.mode somehow came in as "feed" from a non-
    // localStorage path while FEED_DISABLED is true, reroute to shapes
    // so we don't try to render a tab that no longer has a rail button.
    if (FEED_DISABLED && state.mode === "feed") {
      state.mode = "shapes";
      try { localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); } catch {}
    }
    // One-time membrane intro: on this preview branch, first launch lands
    // every user on the membrane mode regardless of prior preference so the
    // redesign is the first thing they see. Subsequent rail clicks persist
    // normally — once they pick another mode, that sticks.
    const membraneSeen = localStorage.getItem(MEMBRANE_INTRO_LS_KEY);
    if (!membraneSeen) {
      state.mode = "membrane";
      localStorage.setItem(MEMBRANE_INTRO_LS_KEY, "1");
    }
  } catch {}
  // Detail page state — if a record was open at last reload, restore it
  // so the user lands back where they were instead of on the grid.
  try {
    const dRaw = localStorage.getItem(DETAIL_LS_KEY);
    if (dRaw) {
      const d = JSON.parse(dRaw);
      if (d?.recordId) state.detailRecordId = String(d.recordId);
      if (d?.returnMode && ALCHEMY_MODES.includes(d.returnMode)) state.detailReturnMode = d.returnMode;
    }
  } catch {}
  loadProfile();
  loadEventsCache();
  if (state.container) {
    state.container.dataset.alchModeCurrent = state.mode;
    syncMembraneMenuChrome();
  }
  // Background feed refresh — interval gated on the feed tab being open
  // so we don't burn the 60 req/hr unauth GH budget on a user who hasn't
  // looked at the feed today. Skipped entirely while FEED_DISABLED — no
  // timer, no mount kick, nothing hitting api.github.com from this code
  // path. Flip FEED_DISABLED to false (top of file) to revive.
  if (!FEED_DISABLED && !state.refreshTimer) {
    state.refreshTimer = setInterval(() => {
      if (state.mode !== "feed") return;
      refreshFeed({ source: "interval" });
    }, FEED_REFRESH_MS);
    // First fetch on mount, deferred a beat so we don't compete with cohort load.
    setTimeout(() => refreshFeed({ source: "mount" }), 1500);
  }

  for (const btn of state.rail.querySelectorAll(".alchemy-rail-btn")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.alchMode;
      if (!next) return;
      if (state.mode === "membrane") setMembraneMenuOpen(false);
      // Clicking any rail mode also exits the detail page if it's open.
      const wasDetail = !!state.detailRecordId;
      if (next === state.mode && !wasDetail) return;
      state.mode = next;
      if (wasDetail) {
        state.detailRecordId = null;
        state.detailReturnMode = null;
        try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
      }
      try { localStorage.setItem(ALCHEMY_LS_KEY, next); } catch {}
      syncRailSelection();
      render();
    });
  }
  document.addEventListener("click", (e) => {
    if (!isMembraneShellOpen()) return;
    if (e.target.closest(".alchemy-rail")) return;
    if (e.target.closest('#tab-bar .tab-btn[data-tab="alchemy"]')) return;
    setMembraneMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isMembraneShellOpen()) {
      e.preventDefault();
      setMembraneMenuOpen(false);
    }
  });
  syncRailSelection();
  loadCohort().then(render).catch(err => {
    console.error("[alchemy] cohort load failed:", err);
    state.canvas.innerHTML = `<p class="alch-callout"><strong>cohort data unavailable</strong><br/>${escHtml(err.message || String(err))}</p>`;
  });
  state.unsubscribe = subscribeToCohortChanges(() => {
    loadCohort().then(render).catch(() => {});
  });
  state.mounted = true;
}

export function setActive(v) {
  state.active = !!v;
}

export function notifyDataChanged() {
  if (!state.mounted) return;
  loadCohort().then(render).catch(() => {});
}

// Cross-module bridge — identity.js (and any future caller) can route
// the user into the profile editor focused on a specific record:
//   window.__srwkOpenProfile({ kind: "person"|"team"|"project",
//                              record_id: "<slug>",
//                              mode: "edit"|"add" })
// Switches to the alchemy tab + profile mode, sets editor state, renders.
window.__srwkOpenProfile = function openProfileExternal(opts = {}) {
  const kind = (opts.kind === "team" || opts.kind === "project" || opts.kind === "person") ? opts.kind : "person";
  const mode = (opts.mode === "add") ? "add" : "edit";
  // Make sure profile state exists (may be called before alchemy mounts).
  if (!state.profile) loadProfile();
  state.profile.editKind = kind;
  state.profile.editMode = mode;
  if (mode === "edit" && opts.record_id) {
    state.profile.editTargetId = String(opts.record_id);
  } else if (mode === "add") {
    state.profile.editTargetId = null;
  }
  saveProfile();
  // Drop out of the detail page if it happens to be open.
  state.detailRecordId = null;
  state.detailReturnMode = null;
  try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
  // Switch the global tab to alchemy + alchemy mode to profile.
  state.mode = "profile";
  try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
  if (typeof window.__srwkGoTab === "function") {
    window.__srwkGoTab("alchemy");
  }
  // Repaint the alchemy canvas. If alchemy isn't mounted yet (very first
  // load before tab switch fires mount), the tab switch will trigger
  // loadCohort + render itself.
  if (state.mounted) {
    syncRailSelection();
    render();
  }
};

async function loadCohort() {
  state.cohort = await getCohortSurface();
  // Enrich person records from GitHub: name / geo / website / x are
  // filled in (when empty) from api.github.com/users/<handle>. Cached
  // 24h in localStorage so this is one API call per person per day
  // per device. Triggers a re-render whenever a record gets new data
  // so the first-render placeholders update as fetches complete.
  if (state.cohort?.people) {
    enrichPeople(state.cohort.people, {
      onUpdate: () => {
        // Debounce: gather a few enrichments before re-rendering so a
        // cold-cache cohort doesn't trigger 50 paints in a row.
        clearTimeout(state._ghEnrichRenderTimer);
        state._ghEnrichRenderTimer = setTimeout(() => {
          if (state.mounted && state.active) render();
        }, 350);
      },
    });
  }
}

function syncRailSelection() {
  if (!state.rail) return;
  for (const btn of state.rail.querySelectorAll(".alchemy-rail-btn")) {
    btn.setAttribute("aria-selected", btn.dataset.alchMode === state.mode ? "true" : "false");
  }
}

function isMembraneHome() {
  return state.mode === "membrane" && !state.detailRecordId;
}

function isMembraneShellOpen() {
  return !!(state.mounted && state.container && isMembraneHome() && state.menuOpen);
}

function syncMembraneMenuChrome() {
  if (!state.container) return;
  const open = isMembraneHome() && state.menuOpen;
  state.container.dataset.alchMenu = open ? "open" : "closed";
  const tab = document.querySelector('#tab-bar .tab-btn[data-tab="alchemy"]');
  if (tab) {
    tab.setAttribute("aria-expanded", open ? "true" : "false");
  }
}

function setMembraneMenuOpen(open) {
  state.menuOpen = isMembraneHome() ? !!open : false;
  syncMembraneMenuChrome();
}

export function toggleMembraneMenuFromTopTab() {
  if (!state.container || !isMembraneHome()) return false;
  setMembraneMenuOpen(!state.menuOpen);
  return true;
}

export function closeMembraneMenu() {
  if (!state.container || !state.menuOpen) return false;
  setMembraneMenuOpen(false);
  return true;
}

function render() {
  if (!state.canvas || !state.cohort) return;
  // Reflect current mode on the alchemy-view container so scoped CSS
  // (membrane.css especially) can target the right surface.
  if (state.container) {
    state.container.dataset.alchModeCurrent = state.mode;
    if (!isMembraneHome()) state.menuOpen = false;
    syncMembraneMenuChrome();
  }
  // Cross-fade: leave → swap → enter. Total ~440ms.
  const canvas = state.canvas;
  canvas.classList.remove("is-entering");
  canvas.classList.add("is-leaving");
  // Tear down every active shape-shader controller before the innerHTML
  // rewrite — each one owns a WebGL2 context, and browsers cap us to
  // ~16. Leaving them alive across renders would silently exhaust the
  // budget after a few mode switches.
  destroyAllShapes();
  // Tear down the membrane scene when leaving membrane mode — same WebGL
  // budget concern, plus the RAF loop should stop.
  if (state.mode !== "membrane" && state.membraneController) {
    try { state.membraneController.destroy(); } catch {}
    state.membraneController = null;
  }
  setTimeout(() => {
    canvas.classList.add("is-entering");
    canvas.classList.remove("is-leaving");
    // Detail page takes precedence over mode — opened by clicking a card,
    // closed by the back button (which clears state.detailRecordId).
    if (state.detailRecordId) {
      renderDetail(state.detailRecordId);
    } else if (state.mode === "membrane") renderMembrane();
    else if (state.mode === "feed") renderFeed();
    else if (state.mode === "shapes") renderShapes();
    else if (state.mode === "pulse") renderPulse();
    else if (state.mode === "constellation") renderConstellation();
    else if (state.mode === "intel") renderIntel(state.canvas);
    else if (state.mode === "collab") renderCollab();
    else if (state.mode === "calendar") renderCalendar();
    else if (state.mode === "profile") renderProfile();
    else if (state.mode === "onboarding") renderOnboarding();
    else if (state.mode === "program") renderProgram();
    else if (state.mode === "asks") renderAsks();
    else if (state.mode === "context") renderContextVault();
    // atlas — sub-mode disabled to avoid collision with top-level atlas tab.
    // Index cards for the staggered entrance.
    const cards = canvas.querySelectorAll(".alch-card, .alch-legend-card, .alch-feed-item");
    cards.forEach((c, i) => c.style.setProperty("--alch-i", String(i)));
    requestAnimationFrame(() => canvas.classList.remove("is-entering"));
    // Wire up post-render interactions per mode.
    if (!state.detailRecordId) {
      if (state.mode === "shapes") wireShapeCardClicks();
      if (state.mode === "feed") wireFeedInteractions();
      if (state.mode === "profile") wireProfileForm();
      // Kick a feed refresh on entry; the timer keeps it warm in background.
      if (state.mode === "feed") refreshFeed({ source: "mode-enter" });
      if (state.mode === "constellation") wireConstellationHover();
      if (state.mode === "intel") wireIntel(state.canvas);
      if (state.mode === "collab") wireCollab();
      if (state.mode === "calendar") wireCalendar();
      if (state.mode === "onboarding") wireOnboarding();
      if (state.mode === "program") wireProgram();
      if (state.mode === "asks") wireAsks();
      if (state.mode === "context") wireContextVault();
      // atlas wire skipped — see ALCHEMY_MODES comment.
    }
    // Mount shape shaders LAST — every <canvas data-shape-fam> emitted
    // by the renderers above gets one WebGL2 context here. Controllers
    // are tracked in state.shapeControllers so the next render can
    // .destroy() them all in one shot.
    mountAllShapes();
  }, 220);
}

function destroyAllShapes() {
  for (const c of state.shapeControllers) {
    try { c.destroy(); } catch {}
  }
  state.shapeControllers = [];
}
function mountAllShapes() {
  if (!state.canvas) return;
  state.shapeControllers = mountShapesIn(state.canvas);
}

// ─── membrane ───────────────────────────────────────────────────────────
// 2026-05 redesign. The membrane controller owns its own canvas + WebGL +
// RAF loop + audio scaffold; render() teardown is handled by the
// `state.membraneController.destroy()` call that fires when switching out
// of membrane mode (see the render() prelude above).
function renderMembrane() {
  if (!state.canvas) return;
  if (state.membraneController) {
    state.membraneController.setData(computeMembraneData());
    return;
  }
  state.membraneController = mountMembrane(state.canvas);
  state.membraneController.setData(computeMembraneData());
}

// Today's timed events from the Phala calendar GRID (cohort.calendar.tabs).
// The daily schedule (sessions, dinners) lives in the grid cells, not in
// cohort.events — so the membrane events panel needs to parse today's cell
// to surface things like "19:00 muse dinner". Reuses the calendar module's
// week-row parser; only lines that lead with a clock time count as events.
function todayGridEvents(cal) {
  try {
    if (!cal || !cal.tabs) return [];
    const tabName = cal.tabs["May 18 Start"] ? "May 18 Start" : Object.keys(cal.tabs)[0];
    const rows = cal.tabs[tabName] || [];
    const wk = calendarCurrentWeekIdx();
    const weekRow = rows[2 + wk] || [];
    const week = calendarParseWeekRow(weekRow, wk);
    // Match the LOCAL calendar date, not parseWeekRow's UTC `isToday`. The
    // grid cell dates are UTC-midnight; comparing on Y/M/D keeps "today"
    // pinned to the day the user is actually in (otherwise, after ~8pm
    // US-eastern, UTC rolls to tomorrow and the panel shows tomorrow's cell).
    const now = new Date();
    const localKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
    const today = (week.days || []).find((d) => {
      const dd = new Date(d.dayMs);
      return `${dd.getUTCFullYear()}-${dd.getUTCMonth()}-${dd.getUTCDate()}` === localKey;
    });
    if (!today) return [];
    const out = [];
    for (const block of (today.blocks || [])) {
      const first = String(block).split("\n")[0].trim();
      let time = "", rest = "";
      const range = first.match(/^(\d{1,2}:\d{2})\s*[-–—:]\s*(\d{1,2}:\d{2})(.*)$/);
      if (range) { time = `${range[1]}–${range[2]}`; rest = range[3]; }
      else {
        const single = first.match(/^(\d{1,2}:\d{2})(.*)$/);
        if (!single) continue;           // no leading time → not a scheduled event
        time = single[1]; rest = single[2];
      }
      rest = rest.replace(/^[\s.·:–—-]+/, "").trim();
      if (!rest) continue;
      out.push({ time, title: rest, sub: "" });
    }
    return out;
  } catch { return []; }
}

// Cross-blob data feed. Read the cohort surface and shape it into per-blob
// stat dictionaries that the panels can render. Re-runs on every cohort
// refresh via subscribeToCohortChanges → render() chain.
function computeMembraneData() {
  const c = state.cohort || {};
  const cohortIndex = buildCohortIndex(c);
  const teams = cohortIndex.teams;
  const people = cohortIndex.people;
  const events = Array.isArray(c.events) ? c.events : [];
  const asks = asksWithStatus(c.asks);

  // Pull the user's claimed identity from identity.js (the source of truth
  // — same module the top-right pill reads). Then resolve it to the full
  // cohort record so we have name, team, bio, github link, role, etc.
  const identity = getIdentity();
  const editorUser = state.profile?.user || null;
  let myRecord = null;
  if (identity?.record_id) {
    if (identity.kind === 'team') {
      myRecord = cohortIndex.teamById.get(identity.record_id) || null;
    } else {
      myRecord = cohortIndex.personById.get(identity.record_id) || null;
    }
  }
  // Fallback for handle-based matching when the editor user is set but no
  // formal claim has been made yet.
  const editorHandle = editorUser?.github || editorUser?.gh_handle || editorUser?.handle || editorUser?.links?.github || null;
  if (!myRecord && editorHandle) {
    const lc = normalizeAskIdentity(editorHandle);
    myRecord = people.find((p) =>
      normalizeAskIdentity(p.links?.github || p.gh_handle || p.handle || '') === lc);
  }
  const myHandle = (myRecord?.links?.github || myRecord?.gh_handle
                 || editorHandle || identity?.record_id || null);

  const askIdentity = { identity, profileUser: editorUser, people };
  const myAsks = asks.filter((a) => askIsCurrent(a) && isAskMine(a, askIdentity)).length;
  const openAsks = asks.filter(askIsOpen).length;

  const now = Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;
  const weekFromNow = now + 7 * DAY_MS;
  // Range-aware parse — match renderEventsInline(): point events use
  // date/starts_at, spans use range_start/range_end (extended to day end).
  // Without this, every span event (daily tea, office hours…) was dropped.
  const spans = events
    .map((e) => {
      const startMs = Date.parse(e?.starts_at || e?.start || e?.date || e?.range_start || '');
      if (!Number.isFinite(startMs)) return null;
      const endRaw = Date.parse(e?.range_end || '');
      const endMs = Number.isFinite(endRaw) ? endRaw + (DAY_MS - 1) : startMs;
      return { startMs, endMs, e };
    })
    .filter(Boolean)
    .sort((a, b) => a.startMs - b.startMs);
  // This week = events still live (not ended) that start within 7 days —
  // includes anything ongoing right now.
  const eventsThisWeek = spans.filter((u) => u.endMs >= now && u.startMs <= weekFromNow).length;
  const happeningNow = spans.find((u) => u.startMs <= now && u.endMs >= now);
  const nextStart = spans.find((u) => u.startMs >= now);
  const nextEventEntry = happeningNow || nextStart;
  const nextEvent = nextEventEntry?.e;
  const nextEventLabel = nextEvent ? (nextEvent.title || nextEvent.name || 'untitled') : '—';
  const nextEventInMs = happeningNow ? 0 : (nextStart ? nextStart.startMs - now : null);

  // TODAY's agenda for the events panel. Merges two sources:
  //   - timed lines from today's Phala calendar GRID cell (e.g. "19:00 muse
  //     dinner") — the daily schedule lives in cohort.calendar.tabs, NOT in
  //     cohort.events, so the panel used to miss them entirely.
  //   - cohort.events spans that overlap today (e.g. "daily tea").
  // Deduped by title; all-day/ongoing items first, then by clock time.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const tomorrowMs = todayStartMs + DAY_MS;
  const gridItems = todayGridEvents(c.calendar);
  const spanItems = spans
    .filter((u) => u.startMs < tomorrowMs && u.endMs >= todayStartMs)
    .map((u) => ({
      time: '',
      title: u.e.title || u.e.name || 'untitled',
      sub: u.e.subtitle || '',
      ongoing: (u.endMs - u.startMs) > 12 * 60 * 60 * 1000,
    }));
  const seenToday = new Set();
  const eventsToday = [];
  for (const it of [...spanItems, ...gridItems]) {
    const k = (it.title || '').toLowerCase().trim();
    if (!k || seenToday.has(k)) continue;
    seenToday.add(k);
    eventsToday.push(it);
  }
  eventsToday.sort((a, b) =>
    (a.time ? 1 : 0) - (b.time ? 1 : 0) || String(a.time).localeCompare(String(b.time)));

  // Edge count: count unique team↔team dependencies the current user's team
  // participates in. Fallback: total cohort-level edges.
  const allEdges = teams.reduce((n, t) => n + (Array.isArray(t.dependencies) ? t.dependencies.length : 0), 0);

  // Connections — mirror the constellation view's edges into a flat list
  // the self panel can render. Includes teammates (same team), members
  // of teams my team depends on, and people in shared synergy clusters.
  const connections = [];
  if (myRecord) {
    const myTeamId = myRecord.team || (myRecord.kind === 'team' ? myRecord.record_id : null);
    const myTeam = myTeamId ? cohortIndex.teamById.get(myTeamId) : null;
    const seen = new Set();
    const add = (person, edgeType, team) => {
      if (!person || person.record_id === myRecord.record_id) return;
      if (seen.has(person.record_id)) return;
      seen.add(person.record_id);
      connections.push({
        kind: 'person',
        record_id: person.record_id,
        name: person.display_name || person.name || person.handle || person.record_id,
        team: team?.name || person.team || '',
        role: person.role || person.title || '',
        edgeType,
      });
    };
    if (myTeam) {
      // Teammates
      for (const p of cohortIndex.primaryPeopleByTeam.get(myTeam.record_id) || []) add(p, 'teammate', myTeam);
      // Dependency-team members
      const depIds = Array.isArray(myTeam.dependencies) ? myTeam.dependencies : [];
      for (const depId of depIds) {
        const depTeam = cohortIndex.teamById.get(depId);
        if (!depTeam) continue;
        for (const p of cohortIndex.primaryPeopleByTeam.get(depId) || []) add(p, 'depends on', depTeam);
      }
      // Reverse-dependency: teams that depend on mine
      for (const t of teams) {
        if (!Array.isArray(t.dependencies)) continue;
        if (!t.dependencies.includes(myTeam.record_id)) continue;
        for (const p of cohortIndex.primaryPeopleByTeam.get(t.record_id) || []) add(p, 'depended by', t);
      }
    }
    // Cluster overlap — people in same synergy cluster as my team
    const clusters = Array.isArray(c.clusters) ? c.clusters : [];
    for (const cl of clusters) {
      const teamIds = Array.isArray(cl.teams) ? cl.teams
                    : Array.isArray(cl.members) ? cl.members : [];
      if (!myTeam || !teamIds.includes(myTeam.record_id)) continue;
      for (const tid of teamIds) {
        if (tid === myTeam.record_id) continue;
        const team = cohortIndex.teamById.get(tid);
        for (const p of cohortIndex.primaryPeopleByTeam.get(tid) || []) add(p, `cluster: ${cl.label || cl.name || cl.record_id}`, team);
      }
    }
  }

  // Shape the profile object the panel will render. Prefer the full
  // cohort record (rich fields), fall back to the identity claim (just
  // name + kind + record_id), fall back to editor-state user.
  const ghHandle = myRecord?.links?.github || myRecord?.gh_handle || myRecord?.handle || editorHandle || '';
  const avatarUrl = ghHandle
    ? `https://github.com/${encodeURIComponent(ghHandle)}.png?size=256`
    : null;

  const profileForPanel = myRecord ? {
    record_id: myRecord.record_id,
    name: myRecord.name,
    team: myRecord.team || (myRecord.kind === 'team' ? myRecord.record_id : ''),
    role: myRecord.role || myRecord.title || '',
    role_class: myRecord.role_class,
    handle: ghHandle,
    bio: myRecord.bio || myRecord.description || myRecord.about || '',
    kind: myRecord.kind || (cohortIndex.teamById.has(myRecord.record_id) ? 'team' : 'person'),
    links: myRecord.links || {},
    avatarUrl,
  } : (identity ? {
    record_id: identity.record_id,
    name: identity.display_name,
    kind: identity.kind,
    handle: '',
    team: '',
    role: '',
    bio: '',
    avatarUrl: null,
  } : editorUser);

  return {
    self: {
      edgeCount: String(connections.length || allEdges),
      // Reliable claim signal — ONLY a formal identity claim counts, never
      // the editor-handle fallback (that mis-flagged the github editor user
      // as "claimed" and stranded them in an empty field). The membrane uses
      // this to auto-enter the field for returning claimed users.
      claimed: !!(identity && identity.record_id),
      profile: profileForPanel,
      connections,
    },
    cohort: {
      peerCount: String(people.length),
      onlineCount: c._syncAvailable ? 'live' : 'idle',
    },
    events: {
      eventsThisWeek: String(eventsThisWeek),
      nextEventLabel: nextEventLabel.length > 28 ? nextEventLabel.slice(0, 26) + '…' : nextEventLabel,
      nextEventInMs,
      eventsList: events,
      eventsToday,
    },
    asks: {
      openAskCount: String(openAsks),
      myAskCount: String(myAsks),
      asksList: asks,
      peopleList: people,
      askIdentity,
    },
  };
}

// Bridge from membrane panels → alchemy rail navigation. Lets the panel
// "open network →" / "open calendar →" buttons jump into the legacy mode.
// Public hook used by membrane/index.js.
window.__srwkAlchemyJump = function alchemyJumpFromMembrane(mode, opts) {
  if (!ALCHEMY_MODES.includes(mode)) return;
  state.mode = mode;
  // Optional: land on a specific constellation sub-view (clusters /
  // dependencies / journey). Used by the cohort panel's view cards.
  if (mode === "constellation" && opts && opts.constellationMode) {
    state.constellationMode = opts.constellationMode;
  }
  if (mode === "asks" && opts && opts.openComposer) {
    state.openAskComposer = true;
  }
  try { localStorage.setItem(ALCHEMY_LS_KEY, mode); } catch {}
  syncRailSelection();
  render();
};

// Jump straight to a specific record's detail page in the legacy view.
// Used by the self panel's "connections" list — clicking a peer opens
// their profile in the cohort surface (shapes mode with detail page).
window.__srwkAlchemyShowRecord = function showRecordFromMembrane(recordId, returnMode = 'shapes') {
  if (!recordId) return;
  if (!ALCHEMY_MODES.includes(returnMode)) returnMode = 'shapes';
  state.mode = returnMode;
  state.detailRecordId = String(recordId);
  state.detailReturnMode = returnMode;
  try {
    localStorage.setItem(ALCHEMY_LS_KEY, returnMode);
    localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({ recordId: String(recordId), returnMode }));
  } catch {}
  syncRailSelection();
  render();
};

// Display id "SHAPE-NN" from the team's index in the array.
function displayId(idx) {
  return String(idx + 1).padStart(2, "0");
}

// ─── legend ──────────────────────────────────────────────────────────
function renderLegend() {
  const teams = state.cohort.teams;
  const counts = new Map();
  for (const t of teams) {
    if (t.is_mentor) continue;
    const s = shapeForTeam(t);
    if (!s) continue;
    counts.set(s.key, (counts.get(s.key) || 0) + 1);
  }
  const cards = SHAPES.map((s, i) => {
    const idTag = `LEGEND-${String(i + 1).padStart(2, "0")}`;
    const n = counts.get(s.key) || 0;
    const dest = SHAPE_BY_KEY[s.rotates_to];
    return `
    <article class="alch-legend-card">
      <div class="alch-card-tag">
        <span class="ct-id">${idTag}</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(domainLabel(s.domain))}</span>
      </div>
      <div class="alch-card-shape alch-legend-shape"><canvas data-shape-fam="${s.fam}" data-shape-kind="team" data-shape-seed="legend:${escAttr(s.key)}"></canvas></div>
      <div class="alch-legend-name">${escHtml(s.name)}</div>
      <div class="alch-card-rule"></div>
      <div class="alch-card-meta">
        <div class="alch-card-meta-row"><span class="cm-k">meaning</span><span class="cm-v">${escHtml(s.meaning)}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">in cohort</span><span class="cm-v">${n} ${n === 1 ? "team" : "teams"}</span></div>
        <div class="alch-card-meta-row"><span class="cm-k">rotates to</span><span class="cm-v alch-rotates-to"><span class="ar-arrow" aria-hidden="true">↻</span> ${escHtml(dest ? dest.name : s.rotates_to)}</span></div>
      </div>
    </article>`;
  }).join("");
  state.canvas.innerHTML = `
    <div class="alch-legend-intro">
      <h2 class="alch-legend-title">the shape rotator vocabulary</h2>
      <p class="alch-legend-sub">Six shapes. Every team enters in one and rotates through others over the program. Count is at week ${WEEK_NOW}.</p>
    </div>
    <div class="alch-legend-grid">${cards}</div>
    <p class="alch-callout"><strong>legend · v0.1</strong><br/>
    The vocabulary is fixed in <code>@shape-rotator/shape-ui</code>; each team's <code>shape</code> field defaults to its <code>domain</code> until rotation begins. <em>rotates to</em> is a tendency, not a forecast — encoded from the kickoff lopsidedness analysis (most shapes pull toward SCAFFOLD because GTM is the universal cohort gap).</p>
  `;
}

// ─── shapes (the cohort, as shapes) ──────────────────────────────────

// Membership taxonomy — kept here (not in shape-ui) because the chip set is a
// view concern, not a card concern. Two parallel chip rows: one for the
// teams sub-tab (membership on team records), one for the individuals sub-tab
// (role_class on person records). Both default the leftmost chip — cohort /
// cohort-member — so the formally-invited cohort lands first.
const TEAM_MEMBERSHIP_CHIPS = [
  { id: "cohort",   label: "cohort teams",  match: (t) => (t.membership || "visiting") === "cohort" },
  { id: "visiting", label: "visiting",      match: (t) => (t.membership || "visiting") !== "cohort" },
  { id: "all",      label: "all",           match: () => true },
];
const PERSON_ROLE_CHIPS = [
  { id: "cohort-member",    label: "cohort members",    match: (p) => (p.role_class || "visiting-scholar") === "cohort-member" },
  { id: "visiting-scholar", label: "visiting scholars", match: (p) => (p.role_class || "visiting-scholar") === "visiting-scholar" },
  { id: "coordinator",      label: "coordinators",      match: (p) => (p.role_class || "visiting-scholar") === "coordinator" },
  { id: "all",              label: "all",               match: () => true },
];

function renderShapes() {
  const allTeams  = state.cohort.teams  || [];
  const allPeople = state.cohort.people || [];
  const nWorks  = allTeams.length;
  const nPeople = allPeople.length;
  // Migrate legacy filter values ("all" | "team" | "project" → "works",
  // "person" → "people") so old persisted state lands sensibly.
  const raw = state.shapesKindFilter;
  const filter = (raw === "people" || raw === "person") ? "people" : "works";
  state.shapesKindFilter = filter;

  // Pick the chip set for the active sub-tab. The active membership filter
  // is stored as a single string on state and reinterpreted per sub-tab via
  // a default fallback — switching sub-tabs resets to that tab's leftmost
  // (cohort) chip so the user always lands on the official cohort first.
  const chipSet = filter === "people" ? PERSON_ROLE_CHIPS : TEAM_MEMBERSHIP_CHIPS;
  const defaultMembership = chipSet[0].id;
  if (!chipSet.some(c => c.id === state.shapesMembershipFilter)) {
    state.shapesMembershipFilter = defaultMembership;
  }
  const activeChip = chipSet.find(c => c.id === state.shapesMembershipFilter) || chipSet[0];

  const sourceRecords = (filter === "people")
    ? allPeople.map(p => ({ ...p, _kind: "person" }))
    : allTeams.map(t => ({ ...t, _kind: teamKind(t) }));
  const records = sourceRecords.filter(r => activeChip.match(r));

  // Counts per chip — surfaced inline so people can see at a glance how
  // many records are in each bucket (helpful context for the cohort-vs-
  // visiting distinction).
  const counts = new Map();
  for (const chip of chipSet) {
    counts.set(chip.id, sourceRecords.filter(r => chip.match(r)).length);
  }
  const membershipChips = chipSet.map(chip => `
    <button class="alch-shapes-chip alch-shapes-chip-membership" data-membership-filter="${escAttr(chip.id)}" type="button" aria-selected="${chip.id === activeChip.id}">${escHtml(chip.label)} <span class="ascn">${counts.get(chip.id) || 0}</span></button>
  `).join("");

  const chips = `
    <div class="alch-shapes-toolbar">
      <nav class="alch-shapes-filter" role="tablist" aria-label="filter by kind">
        <button class="alch-shapes-chip" data-shapes-filter="works"  type="button" aria-selected="${filter === "works"}">teams & projects <span class="ascn">${nWorks}</span></button>
        <button class="alch-shapes-chip" data-shapes-filter="people" type="button" aria-selected="${filter === "people"}">individuals <span class="ascn">${nPeople}</span></button>
      </nav>
      <button id="dossier-export-png" class="cal-action" type="button">export dossier (png)</button>
    </div>
    <nav class="alch-shapes-filter alch-shapes-filter-membership" role="tablist" aria-label="filter by membership">
      ${membershipChips}
    </nav>
  `;
  const cardCtx = { people: state.cohort?.people || [] };
  const cards = records.map((r, idx) => {
    if (r._kind === "person") return personCardHtml(r, idx);
    return teamCardHtml(r, idx, cardCtx);
  }).join("");
  const emptyMsg = filter === "people"
    ? `no ${escHtml(activeChip.label)} yet.`
    : `no ${escHtml(activeChip.label)} yet.`;
  const grid = records.length
    ? `<div class="alch-specimens">${cards}</div>`
    : `<p class="alch-pf-pick">${emptyMsg}</p>`;
  state.canvas.innerHTML = `
    ${chips}
    ${grid}
    <p class="alch-callout"><strong>shapes · v0.1</strong><br/>
    Each card is a team, project or individual in its current shape (week ${WEEK_NOW}). Teams render as their starting domain shape; projects share the team vocabulary with a stitched rim; individuals render as a portrait medallion. Cards tinted with the cohort accent are formally-invited cohort teams (and the people on them).</p>
  `;
  // Wire the kind filter chips. Switching sub-tabs resets the membership
  // chip to the new tab's default (cohort / cohort-member).
  for (const btn of state.canvas.querySelectorAll(".alch-shapes-chip[data-shapes-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.shapesFilter;
      if (next === state.shapesKindFilter) return;
      state.shapesKindFilter = next;
      const nextChipSet = next === "people" ? PERSON_ROLE_CHIPS : TEAM_MEMBERSHIP_CHIPS;
      state.shapesMembershipFilter = nextChipSet[0].id;
      renderShapes();
    });
  }
  // Wire the membership chips.
  for (const btn of state.canvas.querySelectorAll(".alch-shapes-chip[data-membership-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.membershipFilter;
      if (next === state.shapesMembershipFilter) return;
      state.shapesMembershipFilter = next;
      renderShapes();
    });
  }
  // Wire the dossier export button.
  const dossierBtn = document.getElementById("dossier-export-png");
  if (dossierBtn) dossierBtn.addEventListener("click", exportDossier);
}

// teamCardHtml / personCardHtml live in @shape-rotator/shape-ui now.
// The Electron renderer keeps the same call sites — see imports above.

// ─── pulse ───────────────────────────────────────────────────────────
function renderPulse() {
  const teams = state.cohort.teams;
  const weekHeaders = Array.from({ length: WEEKS_TOTAL }, (_, i) =>
    `<span>w${String(i + 1).padStart(2, "0")}</span>`).join("");
  const rows = teams.map((t, idx) => {
    const bars = Array.from({ length: WEEKS_TOTAL }, (_, i) => {
      const week = i + 1;
      const v = pulseValue(t.record_id || displayId(idx), week);
      const future = week > WEEK_NOW;
      const isNow = week === WEEK_NOW;
      const height = future ? 4 : Math.max(6, Math.round(v * 44));
      const opacity = future ? 0.20 : 1;
      const cls = isNow ? "alch-pulse-bar is-now" : "alch-pulse-bar";
      const label = future ? `w${week}: future` : `w${week}: ${Math.round(v * 100)} units`;
      return `<div class="${cls}" style="height:${height}px;opacity:${opacity}" title="${escHtml(t.name)} — ${escHtml(label)}"></div>`;
    }).join("");
    return `
      <div class="alch-pulse-row">
        <div class="alch-pulse-name">
          <span class="alch-pulse-name-tag">SPC-${displayId(idx)}</span>
          ${escHtml(t.name)}
        </div>
        <div class="alch-pulse-bars">${bars}</div>
      </div>
    `;
  }).join("");
  state.canvas.innerHTML = `
    <div class="alch-pulse">
      <div class="alch-pulse-axis">
        <span>team / activity</span>
        <div class="alch-pulse-axis-weeks">${weekHeaders}</div>
      </div>
      ${rows}
    </div>
    <p class="alch-callout"><strong>pulse · v0.1</strong><br/>
    Per-team weekly activity. Bars are seeded-random for now — wire real signals (commits, posts, peer-search hits) by replacing <code>pulseValue()</code>. The cyan bar marks the current cohort week (w${String(WEEK_NOW).padStart(2, "0")}).</p>
  `;
}

// Stable hash from (key, week) → 0..1. No PRNG state; deterministic.
function pulseValue(key, week) {
  let t = (hashStr(String(key)) >>> 0) ^ (week * 31);
  t += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (((t ^ (t >>> 14)) >>> 0) % 10000) / 10000;
}
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// ─── journey (PMF spectrum) ──────────────────────────────────────────
// PMF fields live INSIDE each team/project record under one optional
// `journey` object. Everything below is defaulted-at-read: a record with
// no `journey` (or a missing field) renders at the origin (stage 1,
// evidence 1) without crashing. Old records render fine; older app
// versions reading newer data never break (the object is additive).
const JOURNEY_STAGE_LABELS = [
  "side project", // stage 0 — off the main PMF maturity track
  "idea",
  "problem discovery",
  "problem-solution fit",
  "mvp / product validation",
  "early traction",
  "emerging pmf",
  "strong pmf",
  "scale fit",
];
const JOURNEY_EVIDENCE_LABELS = [
  null, // 1-indexed
  "vibes / thesis",
  "interviews",
  "pilots / lois / design partners",
  "usage / revenue / retention",
  "repeatable pull",
];
const JOURNEY_BOTTLENECKS = [
  "ICP Clarity", "Pain Intensity", "Solution Quality", "Technical Risk",
  "GTM", "Retention", "Business Model", "Fundraising", "Regulatory", "Team",
];
const JOURNEY_COMPANY_TYPES = ["B2B", "Consumer", "Infra", "Marketplace", "Protocol", "AI", "Other"];
const JOURNEY_CONFIDENCE = ["Low", "Medium", "High"];
// 10-color palette keyed by primary_bottleneck (CSS classes ac-jdot-b0..b9).
// Lives in styles.css; this array keeps the index↔bottleneck mapping in one place.
const JOURNEY_BOTTLENECK_COLORS = [
  "#c44025", // ICP Clarity     — oxide red
  "#d98a3d", // Pain Intensity  — amber
  "#c9a35e", // Solution Quality— brass
  "#7fa05a", // Technical Risk  — olive
  "#4fa3a0", // GTM             — teal
  "#4f7fa3", // Retention       — steel blue
  "#7a6fb0", // Business Model  — muted violet
  "#a35e8f", // Fundraising     — plum
  "#9a6b5a", // Regulatory      — clay
  "#8a8f99", // Team            — slate
];
const JOURNEY_DEFAULTS = {
  stage: 1, evidence_quality: 1, market_upside: 3,
  primary_bottleneck: "ICP Clarity", confidence: "Low",
};
// Journey select fields whose value is an integer (not a string label).
const NUMERIC_JOURNEY_KEYS = new Set([
  "journey.stage", "journey.evidence_quality", "journey.market_upside",
]);

// Read a record's journey object with defaults applied. NEVER assumes the
// key exists; clamps the scaled fields so out-of-range data can't break the
// plot. Returns a fully-populated object the renderer/tooltip can trust.
function journeyFor(rec) {
  const j = (rec && typeof rec.journey === "object" && rec.journey) || {};
  const clampInt = (v, lo, hi, dflt) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
  };
  const pickFrom = (v, list, dflt) => (list.includes(v) ? v : dflt);
  return {
    stage: clampInt(j.stage, 0, 8, JOURNEY_DEFAULTS.stage),
    evidence_quality: clampInt(j.evidence_quality, 1, 5, JOURNEY_DEFAULTS.evidence_quality),
    market_upside: clampInt(j.market_upside, 1, 5, JOURNEY_DEFAULTS.market_upside),
    primary_bottleneck: pickFrom(j.primary_bottleneck, JOURNEY_BOTTLENECKS, JOURNEY_DEFAULTS.primary_bottleneck),
    company_type: pickFrom(j.company_type, JOURNEY_COMPANY_TYPES, null),
    confidence: pickFrom(j.confidence, JOURNEY_CONFIDENCE, JOURNEY_DEFAULTS.confidence),
    icp: typeof j.icp === "string" ? j.icp : "",
    problem: typeof j.problem === "string" ? j.problem : "",
    solution: typeof j.solution === "string" ? j.solution : "",
    evidence_notes: typeof j.evidence_notes === "string" ? j.evidence_notes : "",
    next_milestone: typeof j.next_milestone === "string" ? j.next_milestone : "",
  };
}

// Stable signed jitter in [-1,1] from (record_id, salt) so the many
// Stage-1/Evidence-1 dots don't stack. The TRUE integer values still drive
// the tooltip + detail drawer — only the pixel position is nudged.
function journeyJitter(recordId, salt) {
  let t = (hashStr(String(recordId) + ":" + salt) >>> 0);
  t += 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((((t ^ (t >>> 14)) >>> 0) % 10000) / 10000) * 2 - 1;
}

// Market-upside labels (index = upside 1..5).
const JOURNEY_UPSIDE_LABELS = ["", "niche", "modest", "solid", "large", "category-defining"];

// Rarity tier derived from PMF stage — drives the Cohort Plate frame
// material (escalates hairline → double-rule → foil edge; single accent,
// never multi-hue). Stage 0 (side project) is off-track = "prospect".
function tierForStage(stage) {
  if (stage <= 0) return { key: "prospect", name: "side quest" };
  if (stage <= 2) return { key: "signal", name: "signal" };
  if (stage <= 4) return { key: "traction", name: "traction" };
  if (stage <= 6) return { key: "fit", name: "fit" };
  return { key: "scale", name: "scale" };
}

// Human label for a stage value (0 = the off-track "side project").
function journeyStageLabel(stage) {
  if (stage === 0) return JOURNEY_STAGE_LABELS[0];
  return `${stage} · ${JOURNEY_STAGE_LABELS[stage] || "—"}`;
}

// Read-only PMF/journey CARD for the record detail page + drawer. The data
// IS the visual: a stage spectrum track with a glowing marker, dot-meters
// for evidence + upside, and a colored bottleneck chip. Always shown for
// teams/projects (defaults via journeyFor); editable via profile → edit.
function journeyDetailSection(rec) {
  const j = journeyFor(rec);
  const isSide = j.stage === 0;

  // Stage spectrum: an off-track "side" tick, then 8 segments idea→scale-fit.
  // Filled up to the current stage; current segment marked.
  const segs = [];
  segs.push(`<span class="jcard-seg jcard-seg-side ${isSide ? "is-cur is-on" : ""}" title="side project">◇</span>`);
  for (let s = 1; s <= 8; s++) {
    const on = !isSide && s <= j.stage ? "is-on" : "";
    const cur = !isSide && s === j.stage ? "is-cur" : "";
    segs.push(`<span class="jcard-seg ${on} ${cur}" title="${escHtml(`${s} · ${JOURNEY_STAGE_LABELS[s]}`)}"><i>${s}</i></span>`);
  }

  // 1..max dot meters.
  const meter = (val, max) => {
    let d = "";
    for (let i = 1; i <= max; i++) d += `<span class="jcm-dot ${i <= val ? "is-on" : ""}"></span>`;
    return `<span class="jcm-dots">${d}</span>`;
  };

  const bIdx = Math.max(0, JOURNEY_BOTTLENECKS.indexOf(j.primary_bottleneck));
  const bColor = JOURNEY_BOTTLENECK_COLORS[bIdx] || JOURNEY_BOTTLENECK_COLORS[0];

  const textRow = (k, v) => v ? `<div class="jcard-note"><span class="jcard-note-k">${escHtml(k)}</span><span class="jcard-note-v">${escHtml(v)}</span></div>` : "";

  return `
    <div class="jcard ${isSide ? "is-side" : ""}">
      <div class="jcard-head">
        <span class="jcard-stage-name">${escHtml(JOURNEY_STAGE_LABELS[j.stage] || "—")}</span>
        <span class="jcard-stage-meta">${isSide ? "off-track" : `stage ${j.stage} / 8`}</span>
      </div>
      <div class="jcard-track">${segs.join("")}</div>
      <div class="jcard-meters">
        <div class="jcard-meter">
          <span class="jcm-k">evidence</span>${meter(j.evidence_quality, 5)}
          <span class="jcm-lbl">${escHtml(JOURNEY_EVIDENCE_LABELS[j.evidence_quality] || "")}</span>
        </div>
        <div class="jcard-meter">
          <span class="jcm-k">upside</span>${meter(j.market_upside, 5)}
          <span class="jcm-lbl">${escHtml(JOURNEY_UPSIDE_LABELS[j.market_upside] || "")}</span>
        </div>
      </div>
      <div class="jcard-chips">
        <span class="jcard-chip jcard-chip-bottleneck" style="--jc:${bColor}">${escHtml(j.primary_bottleneck)}</span>
        ${j.company_type ? `<span class="jcard-chip">${escHtml(j.company_type)}</span>` : ""}
      </div>
      ${(j.icp || j.problem || j.solution || j.evidence_notes || j.next_milestone) ? `
        <div class="jcard-notes">
          ${textRow("icp", j.icp)}
          ${textRow("problem", j.problem)}
          ${textRow("solution", j.solution)}
          ${textRow("evidence", j.evidence_notes)}
          ${textRow("next milestone", j.next_milestone)}
        </div>` : ""}
    </div>`;
}

function renderJourney() {
  const all = state.cohort.teams || [];
  // Filters (persist for the session). side = include the off-track stage-0
  // "side project" column; bottleneck = isolate one bottleneck.
  const jf = state.journeyFilters || (state.journeyFilters = { teams: true, projects: true, side: true, bottleneck: null });
  const teams = all.filter((t) => {
    const j = journeyFor(t);
    const isProject = teamKind(t) === "project";
    if (isProject && !jf.projects) return false;
    if (!isProject && !jf.teams) return false;
    if (j.stage === 0 && !jf.side) return false;
    if (jf.bottleneck && j.primary_bottleneck !== jf.bottleneck) return false;
    return true;
  });
  // Stage distribution over the filtered set (drives the per-column counts).
  const stageCounts = new Array(9).fill(0);
  for (const t of teams) stageCounts[journeyFor(t).stage]++;
  const W = 980, H = 540;
  // Plot area inset: leave room for axis labels (left = evidence, bottom = stage).
  const PAD_L = 96, PAD_R = 28, PAD_T = 28, PAD_B = 88;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  // X = stage. Column 0 is "side project" — OFF the main maturity track,
  // set apart by a divider — then stages 1..8 (idea → scale fit). 9 columns.
  // Y = evidence_quality (1..5, higher = up).
  const STAGE_COUNT = JOURNEY_STAGE_LABELS.length; // 9 (0..8)
  const colW = plotW / STAGE_COUNT;
  const rowH = plotH / 5;
  const xForStage = (stage) => PAD_L + (stage + 0.5) * colW;
  const yForEvidence = (ev) => PAD_T + plotH - (ev - 0.5) * rowH;

  // ── grid + axis labels ──
  const gridLines = [];
  for (let i = 0; i <= STAGE_COUNT; i++) {
    const x = PAD_L + i * colW;
    gridLines.push(`<line class="ac-jgrid" x1="${x.toFixed(1)}" y1="${PAD_T}" x2="${x.toFixed(1)}" y2="${(PAD_T + plotH).toFixed(1)}"/>`);
  }
  for (let i = 0; i <= 5; i++) {
    const y = PAD_T + i * rowH;
    gridLines.push(`<line class="ac-jgrid" x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${(PAD_L + plotW).toFixed(1)}" y2="${y.toFixed(1)}"/>`);
  }
  // Divider between the off-track side-project column (0) and idea (1).
  const dividerX = PAD_L + colW;
  gridLines.push(`<line class="ac-jdivider" x1="${dividerX.toFixed(1)}" y1="${(PAD_T - 6).toFixed(1)}" x2="${dividerX.toFixed(1)}" y2="${(PAD_T + plotH + 6).toFixed(1)}"/>`);
  const xLabels = JOURNEY_STAGE_LABELS.map((lbl, stage) => {
    const x = xForStage(stage);
    // Stage 0 (side project) is off-track — render the label only, no number.
    const num = stage === 0 ? "" : `<tspan class="ac-jaxis-num">${stage}</tspan> `;
    const cls = stage === 0 ? "ac-jaxis-x ac-jaxis-x-side" : "ac-jaxis-x";
    return `<text class="${cls}" x="${x.toFixed(1)}" y="${(PAD_T + plotH + 18).toFixed(1)}" text-anchor="middle">${num}${escHtml(lbl)}</text>`;
  }).join("");
  const yLabels = JOURNEY_EVIDENCE_LABELS.slice(1).map((lbl, i) => {
    const ev = i + 1;
    const y = yForEvidence(ev);
    return `<text class="ac-jaxis-y" x="${(PAD_L - 10).toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="end"><tspan class="ac-jaxis-num">${ev}</tspan> ${escHtml(lbl)}</text>`;
  }).join("");
  const axisTitleX = `<text class="ac-jaxis-title" x="${(PAD_L + plotW / 2).toFixed(1)}" y="${(H - 16).toFixed(1)}" text-anchor="middle">stage →</text>`;
  const axisTitleY = `<text class="ac-jaxis-title" transform="translate(18,${(PAD_T + plotH / 2).toFixed(1)}) rotate(-90)" text-anchor="middle">evidence quality →</text>`;
  // Per-stage count strip across the top — a quick distribution read.
  const countLabels = stageCounts.map((c, stage) =>
    c > 0 ? `<text class="ac-jcount" x="${xForStage(stage).toFixed(1)}" y="${(PAD_T - 7).toFixed(1)}" text-anchor="middle">${c}</text>` : ""
  ).join("");

  // ── dots: one per team AND project. Radius ← market_upside; fill ←
  // primary_bottleneck. Deterministic jitter spreads same-cell dots. ──
  const dots = teams.map((t) => {
    const j = journeyFor(t);
    const jx = journeyJitter(t.record_id, "x") * (colW * 0.32);
    const jy = journeyJitter(t.record_id, "y") * (rowH * 0.32);
    const cx = xForStage(j.stage) + jx;
    const cy = yForEvidence(j.evidence_quality) + jy;
    const r = 4 + j.market_upside * 1.8; // upside 1..5 → r 5.8..13
    const colorIdx = Math.max(0, JOURNEY_BOTTLENECKS.indexOf(j.primary_bottleneck));
    const isProject = teamKind(t) === "project";
    return `<g class="ac-jnode${isProject ? " is-project" : ""}" data-record-id="${escHtml(t.record_id)}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})">
        <circle class="ac-jdot ac-jdot-b${colorIdx}" r="${r.toFixed(1)}"/>
        <text class="ac-jnode-label" y="${(-r - 5).toFixed(1)}" text-anchor="middle">${escHtml(t.name)}</text>
      </g>`;
  }).join("");

  // ── bottleneck legend (10 colors) — clickable to isolate a bottleneck ──
  const legend = JOURNEY_BOTTLENECKS.map((b, i) =>
    `<button type="button" class="acl-item acl-jbtn ${jf.bottleneck === b ? "is-active" : ""} ${jf.bottleneck && jf.bottleneck !== b ? "is-dim" : ""}" data-jbottleneck="${escAttr(b)}"><span class="acl-jswatch ac-jdot-b${i}"></span>${escHtml(b)}</button>`
  ).join("");

  // ── filter bar — toggle teams / projects / side projects ──
  const fbtn = (key, label) => `<button type="button" class="ajf-toggle ${jf[key] ? "is-on" : ""}" data-jfilter="${key}">${label}</button>`;
  const filterBar = `
    <div class="alch-journey-filters">
      <span class="ajf-label">show</span>
      ${fbtn("teams", "teams")}
      ${fbtn("projects", "projects")}
      ${fbtn("side", "side projects")}
      <span class="ajf-count">${teams.length} shown</span>
    </div>`;

  state.canvas.innerHTML = `
    <div class="alch-constellation">
      <nav class="alch-const-modes" role="tablist" aria-label="constellation view">
        <button class="alch-const-mode-btn" data-const-mode="clusters" aria-selected="false" type="button">
          <span class="acm-glyph" aria-hidden="true">◑</span><span class="acm-label">clusters</span>
          <span class="acm-hint">shared cluster membership</span>
        </button>
        <button class="alch-const-mode-btn" data-const-mode="dependencies" aria-selected="false" type="button">
          <span class="acm-glyph" aria-hidden="true">↬</span><span class="acm-label">dependencies</span>
          <span class="acm-hint">team-asserted edges</span>
        </button>
        <button class="alch-const-mode-btn" data-const-mode="journey" aria-selected="true" type="button">
          <span class="acm-glyph" aria-hidden="true">⌁</span><span class="acm-label">journey</span>
          <span class="acm-hint">pmf maturity spectrum</span>
        </button>
      </nav>
      ${filterBar}
      <div class="alch-constellation-stage alch-journey-stage">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          ${gridLines.join("")}
          ${xLabels}
          ${yLabels}
          ${axisTitleX}
          ${axisTitleY}
          ${countLabels}
          ${dots}
        </svg>
        <div class="alch-journey-tip" hidden></div>
      </div>
      <div class="alch-constellation-legend">${legend}</div>
      <p class="alch-callout"><strong>journey · v0.1</strong><br/>
      Every cohort team and project placed on a startup-maturity spectrum — <strong>stage</strong> (idea → scale fit) across, <strong>evidence quality</strong> (vibes → repeatable pull) up. Dot size is market upside; dot color is the primary bottleneck. Initial placement defaults every company to <em>idea / vibes</em> — update each as evidence is collected, via <strong>profile → edit → team / project</strong>.</p>
    </div>
  `;
}

// ─── constellation ───────────────────────────────────────────────────
// ─── cohort map · cluster-well constellation ─────────────────────────
// Ported (watered-down, PUBLIC-data-only) from the cohort dossier's Map
// view. Teams sit inside their primary cluster's "well"; node size = how
// many teams declare a dependency on them (keystones grow); domain → a
// warm tonal color. Detail-on-click reuses the existing record drawer.
// Nothing here reads coordinator judgement or any private dossier input —
// every field used is self-asserted in the cohort surface.
const CONST_DOMAIN_LABEL = {
  tee: "trusted compute", ai: "agent infra", crypto: "crypto · identity",
  "app-ux": "app · ux", "bd-gtm": "app · ux", other: "other",
};
const CONST_DOMAIN_KEYS = ["tee", "ai", "crypto", "app-ux"];
function constDomainClass(d) {
  const k = String(d || "other").toLowerCase();
  if (k === "bd-gtm") return "app-ux";
  return CONST_DOMAIN_KEYS.includes(k) ? k : "other";
}

// Lay wells out on an adaptive grid (favoring more columns on the wide
// canvas) so they never overlap regardless of cluster count, then place
// each well's teams: keystone (highest in-degree) at the centre, the rest
// on a ring inside the well.
function placeConstellation(model, W, H) {
  const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const N = Math.max(1, model.wellsDef.length);
  const cols = Math.max(1, Math.min(N, Math.round(Math.sqrt(N * (W / H)))));
  const rows = Math.ceil(N / cols);
  const cellW = W / cols, cellH = H / rows;
  const wells = [];
  const pos = new Map();
  model.wellsDef.forEach((w, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    // centre a partial last row
    const rowCount = (row === rows - 1) ? (N - row * cols) : cols;
    const rowPad = (cols - rowCount) * cellW / 2;
    const cx = rowPad + col * cellW + cellW / 2;
    const cy = row * cellH + cellH / 2;
    const rx = cellW * 0.42, ry = cellH * 0.40;
    wells.push({ id: w.id, label: w.label, cx, cy, rx, ry });
    const ordered = w.members.slice().sort((a, b) => (model.indegree.get(b) || 0) - (model.indegree.get(a) || 0));
    const ringN = Math.max(1, ordered.length - 1);
    ordered.forEach((rid, k) => {
      const team = model.byRecordId.get(rid);
      const deg = model.indegree.get(rid) || 0;
      const r = 6 + Math.min(deg, 8) * 1.5;
      let x = cx, y = cy + (ordered.length > 1 ? -ry * 0.1 : 0);
      if (k > 0) {
        const a = -Math.PI / 2 + ((k - 1) / ringN) * Math.PI * 2;
        const spread = ringN > 5 && (k % 2 === 0) ? 0.92 : 0.66;
        x = cl(cx + Math.cos(a) * rx * spread, r + 4, W - r - 4);
        y = cl(cy + Math.sin(a) * ry * spread, r + 12, H - r - 12);
      }
      pos.set(rid, { team, x, y, r, deg });
    });
  });
  return { wells, pos };
}

// The original single-ring layout, kept as a toggle alongside the wells.
// Teams are ordered cluster-by-cluster so each cluster reads as an arc;
// node size + domain colour match the wells view. No well backdrops.
function placeConstellationCircle(model, W, H) {
  const CX = W / 2, CY = H / 2, R = Math.min(W, H) * 0.4;
  const order = [];
  for (const w of model.wellsDef) for (const rid of w.members) order.push(rid);
  const n = order.length || 1;
  const pos = new Map();
  order.forEach((rid, i) => {
    const team = model.byRecordId.get(rid);
    if (!team) return;
    const deg = model.indegree.get(rid) || 0;
    const r = 6 + Math.min(deg, 8) * 1.5;
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    pos.set(rid, { team, x: CX + Math.cos(ang) * R, y: CY + Math.sin(ang) * R, r, deg });
  });
  return { wells: [], pos };
}

// Watered-down "read" surfaced on hover — public self-asserted fields only
// (name · domain · how many depend on it · the team's own focus/now).
function constFrameLine(team, deg) {
  const dom = CONST_DOMAIN_LABEL[constDomainClass(team.domain)] || "other";
  const depWord = deg === 1 ? "team depends on this" : "teams depend on this";
  const frame = team.focus || team.now || "";
  return `<strong>${escHtml(team.name || team.record_id)}</strong> · ${escHtml(dom)} · ${deg} ${depWord}`
    + (frame ? `<br/>${escHtml(frame)}` : "");
}

function renderConstellation() {
  const teams = state.cohort.teams;
  const clusters = state.cohort.clusters;
  const mode = state.constellationMode || "clusters";

  // Journey sub-tab renders a PMF scatterplot instead of the map.
  if (mode === "journey") { renderJourney(); return; }

  const W = 980, H = 540;
  const layout = state.constellationLayout || "wells";
  const model = constellationModel(teams, clusters);
  const { wells, pos } = layout === "circle"
    ? placeConstellationCircle(model, W, H)
    : placeConstellation(model, W, H);

  // Cluster well backdrops (soft dashed ellipse + label) behind everything.
  const wellMarkup = wells.map(w => `
    <g class="ac-well" data-well="${escHtml(w.id)}">
      <ellipse cx="${w.cx.toFixed(1)}" cy="${w.cy.toFixed(1)}" rx="${w.rx.toFixed(1)}" ry="${w.ry.toFixed(1)}"/>
      <text class="ac-well-label" x="${w.cx.toFixed(1)}" y="${(w.cy - w.ry + 15).toFixed(1)}" text-anchor="middle">${escHtml(w.label)}</text>
    </g>`).join("");

  // Edges:
  // - "clusters":     undirected line between teams sharing a cluster.
  // - "dependencies": directed arrow from a team to each team it depends on.
  const edges = [];
  if (mode === "clusters") {
    for (const c of clusters) {
      const present = (c.teams || []).filter(rid => pos.has(rid));
      for (let i = 0; i < present.length; i++)
        for (let j = i + 1; j < present.length; j++)
          edges.push({ from: present[i], to: present[j], cluster: c, directed: false });
    }
  } else { // dependencies
    const seen = new Set();
    for (const t of teams) {
      for (const dep of (Array.isArray(t.dependencies) ? t.dependencies : [])) {
        if (!pos.has(dep) || dep === t.record_id) continue;
        const k = t.record_id + ">" + dep;
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ from: t.record_id, to: dep, cluster: null, directed: true });
      }
    }
  }

  const edgeMarkup = edges.map(e => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return "";
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const sx = a.x + ux * (a.r + 2), sy = a.y + uy * (a.r + 2);
    const ex = b.x - ux * (b.r + (e.directed ? 7 : 3)), ey = b.y - uy * (b.r + (e.directed ? 7 : 3));
    const bend = 12 + Math.min(48, dist * 0.12);
    const qx = (sx + ex) / 2 - uy * bend, qy = (sy + ey) / 2 + ux * bend;
    const cls = e.directed
      ? "ac-edge ac-edge-dependency"
      : `ac-edge ac-edge-${(e.cluster && (e.cluster.record_id || e.cluster.name)) || "x"}`;
    const marker = e.directed ? ` marker-end="url(#ac-arrow)"` : "";
    return `<path class="${cls}" data-a="${escHtml(e.from)}" data-b="${escHtml(e.to)}"`
      + ` d="M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}"${marker}/>`;
  }).join("");

  // Draw small→large so keystones sit on top of the pile.
  const nodeMarkup = [...pos.values()].sort((p, q) => p.r - q.r).map(({ team, x, y, r }) => `
    <g class="ac-node-group ac-node-domain-${constDomainClass(team.domain)}" data-record-id="${escHtml(team.record_id)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle class="ac-node-shape ${team.is_mentor ? "ac-node-mentor" : ""}" r="${r.toFixed(1)}"/>
      <text class="ac-node-label" y="${(r + 13).toFixed(1)}" text-anchor="middle">${escHtml(team.name)}</text>
    </g>`).join("");

  const legend =
    CONST_DOMAIN_KEYS.map(k => `<span class="acl-item"><span class="acl-dot acl-dot-${k}"></span>${escHtml(CONST_DOMAIN_LABEL[k])}</span>`).join("")
    + `<span class="acl-item"><span class="acl-size"></span>larger = more teams depend on it</span>`
    + (mode === "dependencies" ? `<span class="acl-item"><span class="acl-swatch acl-swatch-dependency"></span>declared dependency →</span>` : "");

  const calloutBody = mode === "clusters"
    ? `Teams grouped into their <strong>cohort cluster</strong> wells; lines join teams that share a cluster. Color = domain, size = how many teams declare a dependency on them. Hover a node for its frame; click to open the full card. Mentor teams render hollow.`
    : `Arrows point from a team to the teams it <code>depends on</code> — self-asserted in the cohort surface. The biggest nodes are the cohort's keystones (most depended-upon). Hover for a frame; click for the card. See <button class="alch-link-btn" data-go="program" data-program-page="rules">program · rules</button> for why connections aren't inferred.`;

  state.canvas.innerHTML = `
    <div class="alch-constellation">
      <nav class="alch-const-modes" role="tablist" aria-label="constellation edge source">
        <button class="alch-const-mode-btn" data-const-mode="clusters" aria-selected="${mode === "clusters"}" type="button">
          <span class="acm-glyph" aria-hidden="true">◑</span><span class="acm-label">clusters</span>
          <span class="acm-hint">shared cluster membership</span>
        </button>
        <button class="alch-const-mode-btn" data-const-mode="dependencies" aria-selected="${mode === "dependencies"}" type="button">
          <span class="acm-glyph" aria-hidden="true">↬</span><span class="acm-label">dependencies</span>
          <span class="acm-hint">team-asserted edges</span>
        </button>
        <button class="alch-const-mode-btn" data-const-mode="journey" aria-selected="${mode === "journey"}" type="button">
          <span class="acm-glyph" aria-hidden="true">⌁</span><span class="acm-label">journey</span>
          <span class="acm-hint">pmf maturity spectrum</span>
        </button>
      </nav>
      <div class="ac-layout-toggle" role="group" aria-label="map layout">
        <button class="ac-layout-btn" data-const-layout="wells" aria-selected="${layout === "wells"}" type="button">⬡ wells</button>
        <button class="ac-layout-btn" data-const-layout="circle" aria-selected="${layout === "circle"}" type="button">◯ circle</button>
      </div>
      <div class="alch-constellation-stage">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
          <defs>
            <marker id="ac-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z"/>
            </marker>
          </defs>
          <g class="ac-wells">${wellMarkup}</g>
          <g class="ac-edges">${edgeMarkup}</g>
          <g class="ac-nodes">${nodeMarkup}</g>
        </svg>
      </div>
      <div class="alch-constellation-legend">${legend}</div>
      <div class="ac-hoverline" data-ac-hoverline aria-live="polite"></div>
      <p class="alch-callout"><strong>cohort map · v0.4</strong><br/>${calloutBody}</p>
    </div>
  `;
}

// escHtml / escAttr live in @shape-rotator/shape-ui now (imported above).

// ─── fork-aware PR launcher ─────────────────────────────────────────
// Every PR-creating click (edit/new) routes through here. Resolves the
// right URL via gh-fork.js:
//   - User has a fork that exists → open URL on their fork directly.
//   - User has a handle but no fork → show the "create your fork (one
//     click)" modal; after the fork is created (~3s) the next click
//     goes direct.
//   - User has no claimed identity / no github handle → fall back to
//     the canonical /edit/ URL and rely on GitHub's auto-fork-on-
//     Propose-changes (the legacy behavior).
//
// Returns:
//   { ok: true, url }                — URL was opened
//   { ok: false, reason: "needs-fork" } — fork modal shown, no URL opened
async function launchPRFlow({ kind, path, value }) {
  let res;
  try {
    res = await resolvePRForCurrentUser({ kind, path, value });
  } catch (e) {
    console.warn("[pr-launcher] resolve failed:", e?.message || e);
    return { ok: false, reason: "resolve-failed" };
  }
  if (res.kind === "ready") {
    try { window.api?.openExternal?.(res.url); } catch {}
    return { ok: true, url: res.url };
  }
  if (res.kind === "needs-fork") {
    showForkPrompt(res);
    return { ok: false, reason: "needs-fork", forkUrl: res.forkUrl, canonicalUrl: res.canonicalUrl };
  }
  // no-identity fallback
  try { window.api?.openExternal?.(res.canonicalUrl); } catch {}
  return { ok: true, url: res.canonicalUrl, fallback: true };
}

// Modal prompting the user to create their fork. One-time per device
// per cohort member — after they click "create fork" + GitHub finishes,
// clearForkCache wipes the stale "fork doesn't exist" entry so the
// retry hits "ready."
let _forkPromptEl = null;
function showForkPrompt({ forkUrl, canonicalUrl, handle, retryHint }) {
  if (_forkPromptEl) return;
  const overlay = document.createElement("div");
  overlay.className = "fork-prompt-backdrop";
  overlay.innerHTML = `
    <div class="fork-prompt" role="dialog" aria-labelledby="fp-title">
      <header class="fp-head">
        <h2 id="fp-title" class="fp-title">create your fork — one click</h2>
        <p class="fp-sub">cohort members don't have direct write access to <code>${escHtml("dmarzzz/shape-rotator-os")}</code>. you'll submit your edits as PRs from your own fork. this is a <strong>one-time setup</strong> — every future edit goes straight to your fork after this.</p>
      </header>
      <section class="fp-body">
        <p class="fp-line">you'll be sent to github to click <strong>"create fork"</strong>. takes about 3 seconds. when it's done, come back to this app and click submit again — every subsequent edit lands directly in your fork.</p>
        <p class="fp-line fp-aux">target fork: <code>${escHtml(handle)}/shape-rotator-os</code></p>
      </section>
      <footer class="fp-foot">
        <button class="fp-btn fp-btn-primary" id="fp-create" type="button">open github · create fork</button>
        <button class="fp-btn" id="fp-retry" type="button" title="click after you've forked">i've forked · retry</button>
        <button class="fp-btn fp-btn-skip" id="fp-cancel" type="button">cancel</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  _forkPromptEl = overlay;
  const close = () => { overlay.remove(); _forkPromptEl = null; };
  overlay.querySelector("#fp-create")?.addEventListener("click", () => {
    try { window.api?.openExternal?.(forkUrl); } catch {}
  });
  overlay.querySelector("#fp-retry")?.addEventListener("click", () => {
    // Bust the cache so the next launchPRFlow rechecks the api.
    clearForkCache(handle);
    close();
    // Don't re-launch automatically — user might have moved on. They'll
    // click submit again from the original form.
  });
  overlay.querySelector("#fp-cancel")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
}

// ─── history modal (Phase 2 sync) ───────────────────────────────────
//
// Lists prior versions of the current record (newest-first per spec
// §7.2) via /sync/record/<id>?full=true. Each row shows wall_ts_ms +
// a one-line summary of which top-level fields differ from the
// previous-newer envelope. "Restore" pre-fills the editor with that
// version's content + a fresh local timestamp; the user then clicks
// submit to land a new envelope with the restored content (spec §7.3
// — "restore" is implemented entirely at the UI layer).
let _historyModalEl = null;
async function openHistoryModal({ recordId, recordKind }) {
  if (_historyModalEl) return;
  const overlay = document.createElement("div");
  overlay.className = "history-modal-backdrop";
  overlay.innerHTML = `
    <div class="history-modal" role="dialog" aria-labelledby="hm-title">
      <header class="hm-head">
        <h2 id="hm-title" class="hm-title">version history</h2>
        <p class="hm-sub">prior envelopes for <code>${escHtml(recordId)}</code> — newest first. "restore" pre-fills the editor with that version's content; click submit to land a new envelope.</p>
      </header>
      <section class="hm-body" id="hm-body">
        <p class="hm-empty">loading…</p>
      </section>
      <footer class="hm-foot">
        <button class="hm-btn hm-skip" type="button" id="hm-close">close</button>
      </footer>
    </div>
  `;
  document.body.appendChild(overlay);
  _historyModalEl = overlay;
  const close = () => { overlay.remove(); _historyModalEl = null; };
  overlay.querySelector("#hm-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  const body = overlay.querySelector("#hm-body");
  const res = await getRecord(recordId, { full: true });
  if (!res.ok) {
    const reason = res.reason || "unknown";
    const subline = reason === "not_found"
      ? "no envelopes recorded yet for this record on this swf-node. once you submit an edit through the in-app editor, the chain starts."
      : (reason === "timeout" || reason === "network")
        ? `swf-node didn't respond (${escHtml(reason)}). history is only available when the local daemon is running.`
        : `couldn't load history (${escHtml(reason)}).`;
    body.innerHTML = `<p class="hm-empty">${subline}</p>`;
    return;
  }
  const envelopes = res.envelopes || [];
  if (envelopes.length === 0) {
    body.innerHTML = `<p class="hm-empty">no history yet for this record. submit an edit to start the chain.</p>`;
    return;
  }
  // Render newest-first. Diff each row against the next-newer envelope
  // (i.e. the user-visible "what changed when this version landed").
  const rows = envelopes.map((env, i) => {
    const next = envelopes[i + 1];   // older — what this row replaced
    const changed = summarizeContentDiff(next?.content, env.content);
    const ts = env.wall_ts_ms ? new Date(env.wall_ts_ms).toLocaleString() : "unknown time";
    const isLatest = i === 0;
    const isRoot = !next;
    return `
      <div class="hm-row" data-history-idx="${i}">
        <div class="hm-row-head">
          <span class="hm-row-ts">${escHtml(ts)}</span>
          ${isLatest ? `<span class="hm-row-tag">latest</span>` : ""}
          ${isRoot   ? `<span class="hm-row-tag hm-row-tag-root">root · v0</span>` : ""}
        </div>
        <div class="hm-row-diff">${changed}</div>
        <div class="hm-row-actions">
          <button class="hm-btn hm-restore" type="button" data-history-idx="${i}" ${isLatest ? "disabled" : ""}>
            ${isLatest ? "this version is live" : "restore"}
          </button>
        </div>
      </div>
    `;
  }).join("");
  body.innerHTML = rows;

  // Restore handler: copy that version's `content` into the editor's
  // draft. The editor stays in EDIT mode pointed at the same record;
  // a fresh submit click then writes a new envelope (spec §7.3).
  for (const btn of body.querySelectorAll(".hm-restore")) {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.historyIdx);
      const env = envelopes[idx];
      if (!env || !env.content) return;
      const p = state.profile;
      // Preserve identity-level fields the editor expects on the draft.
      const next = {
        ...env.content,
        record_id: recordId,
        record_type: recordKind || env.kind || "person",
        schema_version: 1,
      };
      p.editDraft = next;
      // loadEditTarget() seeds editDraft from cohort whenever its
      // context key changes — i.e. whenever the user picks a different
      // record OR the cohort refreshes with a new editTargetId. We
      // already match the current context (same mode + kind + target),
      // so setting the context key to the canonical value keeps the
      // restored draft sticky until the user navigates away.
      p._editContextKey = `${p.editMode}|${p.editKind}|${p.editTargetId || ""}`;
      // editBaseline stays pinned to the LIVE cohort record so the
      // submit-time diff shows the restore as a real change (otherwise
      // an immediate submit would be a no-op).
      saveProfile();
      close();
      toast({ kind: "info", title: "restored", message: "click save to land this version as a new envelope" });
      renderProfile();
      wireProfileForm();
    });
  }
}

// One-line diff summary for the history row. Lists keys that changed
// between two `content` snapshots, e.g. "name, comm_style, links.github."
// Returns "first version" when there's no prior to diff against.
function summarizeContentDiff(prev, curr) {
  if (!prev) return `<span class="hm-diff-root">first version of this record</span>`;
  const keys = new Set([...Object.keys(prev || {}), ...Object.keys(curr || {})]);
  const changed = [];
  for (const k of keys) {
    const a = prev?.[k];
    const b = curr?.[k];
    if (k === "links" && a && b && typeof a === "object" && typeof b === "object") {
      const subKeys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const sk of subKeys) {
        if (a[sk] !== b[sk]) changed.push(`links.${sk}`);
      }
      continue;
    }
    // Cheap structural compare — JSON.stringify is fine for our small
    // content objects.
    if (JSON.stringify(a) !== JSON.stringify(b)) changed.push(k);
  }
  if (changed.length === 0) return `<span class="hm-diff-none">no field-level changes detected</span>`;
  return `<span class="hm-diff-keys">changed: ${changed.map(k => `<code>${escHtml(k)}</code>`).join(", ")}</span>`;
}

// ─── fork warning banner (spec §9.9) ───────────────────────────────
//
// Polls /health every 30s. If swf-node reports any record_id matching
// the user's claimed identity in its `forked_records` list, surface a
// banner in the profile editor. The spec §9.9 quarantines forked
// records (no replication; "latest view" refuses to apply either side)
// until the author writes a new envelope to resolve.
let _forkPollTimer = null;
let _forkPollSubscribers = new Set();
let _forkedSelf = false;
let _forkBannerSub = null;

function startForkPolling() {
  if (_forkPollTimer) return;
  const tick = async () => {
    try {
      // Pull the current identity lazily (don't import it at module load
      // to avoid a cycle with identity.js → cohort-source.js → here).
      const ident = await import("./identity.js").then(m => m.getIdentity());
      if (!ident || ident.kind !== "person") {
        _forkedSelf = false;
        notifyForkChange();
        return;
      }
      const h = await getHealth();
      if (!h.ok) return;            // network blip; don't toggle state
      // Spec leaves the exact key flexible — both /health and
      // /sync/manifest may expose `forked_records`. Try both shapes.
      const forked = h.body?.forked_records
        || h.body?.sync?.forked_records
        || [];
      const ids = forked.map(f => typeof f === "string" ? f : f?.record_id).filter(Boolean);
      const next = ids.includes(ident.record_id);
      if (next !== _forkedSelf) {
        _forkedSelf = next;
        notifyForkChange();
      }
    } catch { /* swallow */ }
  };
  // First poll runs ~5s after start so a freshly-mounted profile editor
  // doesn't race the daemon's first health response.
  setTimeout(tick, 5000);
  _forkPollTimer = setInterval(tick, 30 * 1000);
}
function notifyForkChange() {
  for (const cb of _forkPollSubscribers) {
    try { cb(_forkedSelf); } catch {}
  }
}
function subscribeToForkChange(cb) {
  _forkPollSubscribers.add(cb);
  return () => _forkPollSubscribers.delete(cb);
}
function isProfileForked() { return _forkedSelf; }

// ─── shape card → drawer ─────────────────────────────────────────────
function wireShapeCardClicks() {
  const cards = state.canvas.querySelectorAll(".alch-card[data-record-id]");
  for (const card of cards) {
    card.addEventListener("click", () => openDetail(card.dataset.recordId));
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(card.dataset.recordId);
      }
    });
  }
  // Member chips (data-person) embedded in team/project cards — open the
  // person's detail and stop the click from also firing the card handler.
  wirePersonLinks(state.canvas);
  // External links inside the cards (repo / github / x) — route through
  // shell.openExternal and stop the click bubbling to the card.
  wireExternalLinks(state.canvas);
}

function openDetail(recordId) {
  if (!recordId) return;
  state.detailRecordId = String(recordId);
  // Remember where to land on back — usually shapes, but if user opened
  // the detail from a different mode (future entry points) honor that.
  state.detailReturnMode = state.mode || "shapes";
  try {
    localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({
      recordId: state.detailRecordId,
      returnMode: state.detailReturnMode,
    }));
  } catch {}
  render();
  // Scroll the canvas to the top so the hero is in view.
  try { state.canvas?.scrollTo({ top: 0, behavior: "auto" }); } catch {}
}

function closeDetail() {
  state.detailRecordId = null;
  if (state.detailReturnMode) state.mode = state.detailReturnMode;
  state.detailReturnMode = null;
  try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
  try { localStorage.setItem(ALCHEMY_LS_KEY, state.mode); } catch {}
  syncRailSelection();
  render();
}

// ─── constellation hover ─────────────────────────────────────────────
function wireConstellationHover() {
  const stage = state.canvas.querySelector(".alch-constellation-stage");
  if (stage) {
    const groups = stage.querySelectorAll(".ac-node-group");
    // Hovering a node shows its watered-down frame (public fields only) in a
    // FIXED-HEIGHT line — never the callout, whose reflow used to shrink the
    // flex stage, move the node out from under the cursor, and flicker.
    const hoverEl = state.canvas.querySelector("[data-ac-hoverline]");
    const cohortIndex = buildCohortIndex(state.cohort);
    const teamById = cohortIndex.teamById;
    const indeg = constellationIndegree(cohortIndex.teams);
    for (const g of groups) {
      const rid = g.dataset.recordId;
      g.addEventListener("mouseenter", () => {
        setConstellationHover(stage, rid, true);
        const t = teamById.get(rid);
        if (hoverEl && t) hoverEl.innerHTML = constFrameLine(t, indeg.get(rid) || 0);
      });
      g.addEventListener("mouseleave", () => {
        setConstellationHover(stage, rid, false);
        if (hoverEl) hoverEl.innerHTML = "";
      });
      g.addEventListener("click", () => openDrawer(rid));
    }
    // Journey scatterplot nodes: hover → tooltip, click → drawer.
    const tip = stage.querySelector(".alch-journey-tip");
    const byId = cohortIndex.teamById;
    for (const node of stage.querySelectorAll(".ac-jnode")) {
      const rid = node.dataset.recordId;
      node.addEventListener("mouseenter", () => showJourneyTip(stage, tip, byId.get(rid)));
      node.addEventListener("mousemove", (e) => positionJourneyTip(stage, tip, e));
      node.addEventListener("mouseleave", () => { if (tip) tip.hidden = true; });
      node.addEventListener("click", () => openDrawer(rid));
    }
  }
  // Mode-toggle nav: switches the edge source between cluster-membership
  // and team-asserted dependencies. State persists for the session.
  for (const btn of state.canvas.querySelectorAll(".alch-const-mode-btn[data-const-mode]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.constMode;
      if (next === state.constellationMode) return;
      state.constellationMode = next;
      render();
    });
  }
  // Layout toggle: cluster-grouped wells ↔ single ring (the original view).
  for (const btn of state.canvas.querySelectorAll(".ac-layout-btn[data-const-layout]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.constLayout;
      if (next === state.constellationLayout) return;
      state.constellationLayout = next;
      render();
    });
  }
  // Inline jump to program → rules from the callout (dependencies mode).
  for (const b of state.canvas.querySelectorAll(".alch-link-btn[data-go='program']")) {
    b.addEventListener("click", () => {
      state.mode = "program";
      state.programPage = b.dataset.programPage || null;
      try { localStorage.setItem(ALCHEMY_LS_KEY, "program"); } catch {}
      syncRailSelection();
      render();
    });
  }
  // Journey filters: toggle teams / projects / side projects.
  const jf = state.journeyFilters;
  for (const btn of state.canvas.querySelectorAll(".ajf-toggle[data-jfilter]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.jfilter;
      if (jf && key in jf) { jf[key] = !jf[key]; render(); }
    });
  }
  // Journey legend: click a bottleneck to isolate it; click again to clear.
  for (const btn of state.canvas.querySelectorAll(".acl-jbtn[data-jbottleneck]")) {
    btn.addEventListener("click", () => {
      if (!jf) return;
      const b = btn.dataset.jbottleneck;
      jf.bottleneck = jf.bottleneck === b ? null : b;
      render();
    });
  }
}
function setConstellationHover(stage, recordId, on) {
  if (!on) {
    stage.removeAttribute("data-hover-active");
    stage.querySelectorAll(".ac-edge.is-hot").forEach(e => e.classList.remove("is-hot"));
    stage.querySelectorAll(".ac-node-group.is-related").forEach(e => e.classList.remove("is-related"));
    return;
  }
  stage.setAttribute("data-hover-active", "true");
  // light up edges touching this node, collect related nodes.
  const related = new Set();
  stage.querySelectorAll(".ac-edge").forEach(edge => {
    const a = edge.dataset.a, b = edge.dataset.b;
    if (a === recordId || b === recordId) {
      edge.classList.add("is-hot");
      related.add(a); related.add(b);
    } else {
      edge.classList.remove("is-hot");
    }
  });
  stage.querySelectorAll(".ac-node-group").forEach(g => {
    const rid = g.dataset.recordId;
    if (related.has(rid) && rid !== recordId) g.classList.add("is-related");
    else g.classList.remove("is-related");
  });
}

// Journey tooltip: name + stage/evidence labels + bottleneck + next
// milestone. Reads journey with defaults applied so it never crashes on a
// record that has no `journey` object.
function showJourneyTip(stage, tip, rec) {
  if (!tip || !rec) return;
  const j = journeyFor(rec);
  const stageLbl = JOURNEY_STAGE_LABELS[j.stage] || "—";
  const evLbl = JOURNEY_EVIDENCE_LABELS[j.evidence_quality] || "—";
  const milestone = j.next_milestone
    ? `<div class="ajt-row"><span class="ajt-k">next</span><span class="ajt-v">${escHtml(j.next_milestone)}</span></div>`
    : "";
  tip.innerHTML = `
    <div class="ajt-name">${escHtml(rec.name || rec.record_id)}</div>
    <div class="ajt-row"><span class="ajt-k">stage</span><span class="ajt-v">${j.stage} · ${escHtml(stageLbl)}</span></div>
    <div class="ajt-row"><span class="ajt-k">evidence</span><span class="ajt-v">${j.evidence_quality} · ${escHtml(evLbl)}</span></div>
    <div class="ajt-row"><span class="ajt-k">bottleneck</span><span class="ajt-v">${escHtml(j.primary_bottleneck)}</span></div>
    ${milestone}
  `;
  tip.hidden = false;
}
function positionJourneyTip(stage, tip, e) {
  if (!tip || tip.hidden) return;
  const r = stage.getBoundingClientRect();
  let x = e.clientX - r.left + 14;
  let y = e.clientY - r.top + 14;
  // Keep the tip inside the stage on the right/bottom edges.
  const tw = tip.offsetWidth || 200, th = tip.offsetHeight || 80;
  if (x + tw > r.width) x = e.clientX - r.left - tw - 14;
  if (y + th > r.height) y = e.clientY - r.top - th - 14;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

// ─── calendar (cohort presence over time) ─────────────────────────────
// Gantt-style canvas: rows = people grouped by team, columns = days from
// program start → end. Each row shows the person's overall window as a
// filled bar in their hash-derived hue; absences render as a striped
// overlay so the visual delta between "in cohort" and "actually here"
// reads at a glance. A vertical "today" marker pulses on top.
//
// Scales: the canvas is built at full size (no clipping) so when the
// cohort grows from 17 to 50 the layout just adds more rows. The CSS
// container scrolls; export captures the FULL canvas regardless of
// visible portion.
//
// Export: PNG via canvas.toDataURL → Electron IPC save dialog. PNG is
// the most messaging-app-friendly format (renders inline in iMessage,
// Slack, Discord). PDF as bonus through electron's printToPDF if asked.
const CAL_DAY_W      = 18;        // pixel width per day column (was 22; tightened so 62-day windows fit common viewports without horizontal scroll)
const CAL_ROW_H      = 32;        // height per person row
const CAL_HEADER_H   = 148;       // top — concurrent strip + month band + week labels + day numbers
const CAL_DENSITY_H  = 32;        // height of the concurrent-headcount strip above the grid
const CAL_TEAM_H     = 36;        // height of team-group header rows
const CAL_LEFT_W     = 240;       // left column — person labels
const CAL_PAD_R      = 40;
const CAL_PAD_B      = 40;
const CAL_FOOTER_H   = 64;        // bottom — date span + legend
const CAL_BG         = "#231F20";
const CAL_BG_LANE    = "#2C2728";
const CAL_RULE       = "rgba(245, 243, 238, 0.07)";
const CAL_RULE_WEEK  = "rgba(245, 243, 238, 0.14)";
const CAL_INK_1      = "#f5f3ee";
const CAL_INK_2      = "#b8b4ab";
const CAL_INK_3      = "#7a7368";
const CAL_INK_4      = "#3a3833";
const CAL_OXIDE      = "#8F220E";  // today marker

// Reasonable defaults for the program; if cohort data exposes a
// programStart/end later this lifts straight from there.
const CAL_PROGRAM_START = "2026-05-18";
const CAL_PROGRAM_END   = "2026-07-18";

function isoToDate(s) {
  if (!s) return null;
  // Accept either "YYYY-MM-DD" or full ISO. Force UTC midnight to avoid TZ drift.
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
}
function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}
function fmtShortDate(d) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}
// fmtMonth, buildCalendarRows, drawCalendar, drawPersonRow,
// drawHeadcountStrip, and roundRect have moved to
// @shape-rotator/shape-ui (cohort-calendar.js) so the sibling web app
// can render the same calendar. The Electron renderer keeps the same
// call sites — buildCalendarRows + drawCalendar are imported above.
// personColors and hsl stay here because the dossier exporter
// (drawShapeGlyph) uses them too.

// ─── calendar — sub-tabbed live view ─────────────────────────────────
// Two sub-views, switchable via state.calendar.sub:
//   week      broadsheet weekly grid (live Phala schedule, bundled fallback)
//   presence  the existing availability Gantt (everyone's window + absences)
//
// Two sub-views: the broadsheet "week" grid (live Phala schedule, bundled
// fallback) and "presence" (the existing availability gantt). Anchor events
// from cohort-data/events/*.md fold into the week cells they fall on — no
// separate "key dates" tab.
function calendarSubView() {
  const cal = state.calendar;
  // Default sub is "day" — the calendar tab opens to a typeset agenda for
  // today rather than the broadsheet week grid, since that's the question
  // people most often have ("what's on right now?"). Week + presence are
  // one click away from any tab.
  return cal.sub === "presence" ? "presence"
       : cal.sub === "week"     ? "week"
       : "day";
}

function seedCalendarData() {
  const cal = state.calendar;
  if (cal.weekIdx == null) cal.weekIdx = calendarCurrentWeekIdx();
  if (cal.data != null || cal.loading) return;

  // Seed the data on first entry: prefer the bundled snapshot so the first
  // paint is instant, then kick off the live fetch in the background and
  // update only the calendar surface when it resolves.
  const bundled = state.cohort?.calendar || null;
  if (bundled) {
    cal.data = bundled;
    cal.source = "bundled";
  }
  cal.loading = true;
  loadCalendarData({ bundled }).then(res => {
    cal.data = res.data || cal.data;
    cal.source = res.source || cal.source;
    cal.loading = false;
    if (state.mode === "calendar") refreshCalendarView();
  }).catch(() => { cal.loading = false; });
}

function renderCalendarHtml() {
  const cal = state.calendar;
  const sub = calendarSubView();
  const presenceHtml = sub === "presence" ? renderCalAvailability() : "";

  return renderCalendarWeekView({
    data: cal.data,
    weekIdx: cal.weekIdx,
    dayIdx:  cal.dayIdx == null ? null : cal.dayIdx,
    sub,
    source: cal.source,
    // Phala calendar.json is the single source of truth for the schedule.
    // The cohort-data/events/*.md anchors duplicate entries already in the
    // calendar cell text (e.g. daily-tea.md + "14:00–14:30 tea on roof"
    // cells → tea showing twice on every weekday). Drop the anchor overlay
    // for now; restore once dedupe + a recurrence model are in place.
    events: [],
    transcriptMatches: CALENDAR_TRANSCRIPT_MATCHES,
    presenceHtml,
  });
}

function unmountCalendarBehavior() {
  const cal = state.calendar;
  if (cal.detachMobile) {
    cal.detachMobile();
    cal.detachMobile = null;
  }
}

function mountCalendarBehavior({ scrollToToday = false } = {}) {
  const cal = state.calendar;
  const sub = calendarSubView();
  if (sub === "presence") {
    mountAvailabilityCanvas();
    return;
  }

  // Wire mobile behavior on the week/day views: swipe-to-navigate + optional
  // first-mount auto-scroll to today. Later partial refreshes should not jump
  // the page back to today.
  cal.detachMobile = attachCalendarMobileBehavior(state.canvas, {
    scrollToToday,
    onWeekChange: (delta) => {
      const next = cal.weekIdx + delta;
      if (next < 0 || next > 9) return;
      cal.weekIdx = next;
      refreshCalendarView();
    },
  });
  cal.initialMount = false;
}

function paintCalendarView({ wire = false, scrollToToday = false } = {}) {
  seedCalendarData();
  // Tear down previous mobile-behavior listeners before swapping markup, or
  // touchstart/touchend handlers will stack up across renders.
  unmountCalendarBehavior();
  state.canvas.innerHTML = renderCalendarHtml();
  mountCalendarBehavior({ scrollToToday });
  if (wire) wireCalendar();
}

function refreshCalendarView() {
  if (state.mode !== "calendar" || !state.canvas) {
    render();
    return;
  }
  paintCalendarView({ wire: true, scrollToToday: false });
}

function renderCalendar() {
  paintCalendarView({ wire: false, scrollToToday: state.calendar.initialMount });
}

// ── presence view (the existing availability Gantt) ─────────────────

function renderCalAvailability() {
  const start = isoToDate(CAL_PROGRAM_START);
  const end   = isoToDate(CAL_PROGRAM_END);
  const numDays = daysBetween(start, end) + 1;
  const rows = buildCalendarRows(state.cohort || {});
  let bodyH = 0;
  for (const r of rows) bodyH += (r.type === "team" ? CAL_TEAM_H : CAL_ROW_H);
  const w = CAL_LEFT_W + numDays * CAL_DAY_W + CAL_PAD_R;
  const h = CAL_HEADER_H + bodyH + CAL_FOOTER_H + CAL_PAD_B;

  const numPeople = rows.filter(r => r.type === "person").length;
  const numTeamGroups = rows.filter(r => r.type === "team").length;

  return `
    <div class="cal-avail-wrap">
      <header class="cal-avail-head">
        <div>
          <h3 class="cal-section-title">availability</h3>
          <span class="cal-section-sub">${escHtml(fmtShortDate(start))} → ${escHtml(fmtShortDate(end))} · ${numPeople} individuals · ${numTeamGroups} groups · striped = absence</span>
        </div>
        <div class="cal-page-actions">
          <button id="cal-export-png" class="cal-action" type="button">export png</button>
          <button id="cal-export-pdf" class="cal-action" type="button">export pdf</button>
          <button class="alch-feed-btn cal-avail-edit" type="button" data-cal-go-profile="1" title="edit your dates_start, dates_end, absences in your person record">
            <span aria-hidden="true">✎</span><span>edit my availability</span>
          </button>
        </div>
      </header>
      <div class="cal-section cal-section-presence">
        <div class="cal-scroll">
          <canvas id="cal-canvas" width="${w}" height="${h}" style="width:${w}px; height:${h}px;" data-cal-w="${w}" data-cal-h="${h}" data-cal-numdays="${numDays}"></canvas>
        </div>
      </div>
    </div>
  `;
}

// Mount step for the availability canvas. Called from renderCalendar after
// innerHTML replacement so the canvas DOM node exists.
function mountAvailabilityCanvas() {
  const cnv = document.getElementById("cal-canvas");
  if (!cnv) return;
  const w = Number(cnv.dataset.calW) || cnv.width;
  const h = Number(cnv.dataset.calH) || cnv.height;
  const numDays = Number(cnv.dataset.calNumdays) || 1;
  const start = isoToDate(CAL_PROGRAM_START);
  const end   = isoToDate(CAL_PROGRAM_END);
  const rows = buildCalendarRows(state.cohort || {});
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cnv.width  = Math.round(w * dpr);
  cnv.height = Math.round(h * dpr);
  cnv.style.width  = w + "px";
  cnv.style.height = h + "px";
  const ctx = cnv.getContext("2d");
  ctx.scale(dpr, dpr);
  drawCalendar(ctx, w, h, rows, start, end, numDays);
}

// FNV-1a hash → two hues in [0,1) for a person, matching the shader's
// per-team palette derivation so each individual's color in the calendar
// echoes their shape on the grid.
function personColors(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const a =  h         & 0xff;
  const b = (h >>> 8)  & 0xff;
  return {
    hue:  a / 255,
    hue2: (a / 255 + 0.33 + (b / 255) * 0.34) % 1,
  };
}

function hsl(h, s, l, a) {
  // h/s/l in [0,1]; alpha 0..1 — returns rgba() string
  function f(n) {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  }
  const r = Math.round(f(0) * 255);
  const g = Math.round(f(8) * 255);
  const b = Math.round(f(4) * 255);
  return `rgba(${r},${g},${b},${a == null ? 1 : a})`;
}

// Wire interactions for the active calendar view: sub-tab switch, week nav
// (prev/today/next + the 10-week scrubber dots), stale-banner retry, the
// "edit my availability" jump in the presence view, and gantt export.
function wireCalendar() {
  const cal = state.calendar;

  // day / week / presence sub-tab switch
  for (const btn of state.canvas.querySelectorAll(".cal-subtab[data-cal-sub]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.calSub;
      if (!next || next === cal.sub) return;
      cal.sub = next;
      refreshCalendarView();
    });
  }

  // day-view day pills — pick which day of the visible week to view
  for (const pill of state.canvas.querySelectorAll(".cal-day-pill[data-cal-day-pick]")) {
    pill.addEventListener("click", () => {
      const i = Number(pill.dataset.calDayPick);
      if (!Number.isFinite(i) || i < 0 || i > 6) return;
      cal.dayIdx = i;
      refreshCalendarView();
    });
  }

  for (const btn of state.canvas.querySelectorAll("[data-cal-transcript-path]")) {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      openCalendarTranscript(btn.dataset.calTranscriptPath);
    });
  }

  // week navigation (prev / today / next). Changing the visible week
  // resets the day-view selection so day view follows the user's
  // attention rather than stranding them on, say, "wednesday of last week"
  // when they jump forward.
  for (const btn of state.canvas.querySelectorAll("[data-cal-nav]")) {
    btn.addEventListener("click", () => {
      const dir = btn.dataset.calNav;
      if (dir === "prev"  && cal.weekIdx > 0)  cal.weekIdx -= 1;
      else if (dir === "next"  && cal.weekIdx < 9) cal.weekIdx += 1;
      else if (dir === "today") cal.weekIdx = calendarCurrentWeekIdx();
      else return;
      cal.dayIdx = null;
      refreshCalendarView();
    });
  }

  // 10-week scrubber dots — same dayIdx reset semantics as week nav.
  for (const dot of state.canvas.querySelectorAll(".cal-scrub-dot[data-week]")) {
    dot.addEventListener("click", () => {
      const i = Number(dot.dataset.week);
      if (Number.isFinite(i) && i !== cal.weekIdx) {
        cal.weekIdx = i;
        cal.dayIdx = null;
        refreshCalendarView();
      }
    });
  }

  // stale-banner retry — force a fresh live fetch
  for (const btn of state.canvas.querySelectorAll("[data-cal-retry]")) {
    btn.addEventListener("click", () => {
      cal.loading = true;
      const bundled = state.cohort?.calendar || null;
      loadCalendarData({ bundled }).then(res => {
        cal.data = res.data || cal.data;
        cal.source = res.source || cal.source;
        cal.loading = false;
        if (state.mode === "calendar") refreshCalendarView();
      }).catch(() => { cal.loading = false; });
    });
  }

  // presence view's "edit my availability" → profile editor.
  const editAvail = state.canvas.querySelector(".cal-avail-edit[data-cal-go-profile]");
  if (editAvail) editAvail.addEventListener("click", () => {
    state.mode = "profile";
    try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
    syncRailSelection();
    render();
  });

  // Gantt export (presence view only)
  const pngBtn = document.getElementById("cal-export-png");
  if (pngBtn) pngBtn.addEventListener("click", () => exportCalendar("png"));
  const pdfBtn = document.getElementById("cal-export-pdf");
  if (pdfBtn) pdfBtn.addEventListener("click", () => exportCalendar("pdf"));

  // External links inside the calendar view (recurring + footer links).
  wireExternalLinks(state.canvas);
}

// ─── onboarding ─────────────────────────────────────────────────────
// First-week walkthrough. The app never *stores* progress here — we just
// surface the steps and hand off to either profile-tab edits or github
// PR URLs. Each step is "click this to do that"; completion lives in the
// markdown source (a person has a `weekly_intention`, a team has
// `weekly_goals` etc.) so the same content shows up in dossiers + feeds.
//
// Step contract: { id, title, ask, action, kind }
//   action.kind = "go-profile"  — switch to the profile sub-mode focused on
//                                 a specific record + kind. Uses the existing
//                                 openProfileEditor() helper.
//   action.kind = "go-program"  — switch to the program sub-mode + a page.
//   action.kind = "external"    — open a URL in the browser.

// Per-step "I've already done this" overrides — stored locally so an existing
// participant whose record predates the auto-detect heuristics can still
// check off steps. Keyed by step `key` (stable across renames + reorders).
const ONBOARDING_DONE_LS_KEY = "srfg:onboarding_done_v1";
function loadOnboardingDone() {
  try {
    const raw = localStorage.getItem(ONBOARDING_DONE_LS_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === "object") ? obj : {};
  } catch { return {}; }
}
function saveOnboardingDone(map) {
  try { localStorage.setItem(ONBOARDING_DONE_LS_KEY, JSON.stringify(map || {})); } catch {}
}
function toggleOnboardingDone(key) {
  const cur = loadOnboardingDone();
  if (cur[key]) delete cur[key];
  else cur[key] = true;
  saveOnboardingDone(cur);
}

function renderOnboarding() {
  const cohortIndex = buildCohortIndex(state.cohort);
  const people = cohortIndex.people;
  const p       = state.profile || {};
  // Best-effort identity: prefer an explicit profile.user.record_id, else
  // match by github handle, else nothing. Onboarding doesn't require this
  // to be set — the missing case is the most common first-launch state.
  const meId    = p?.user?.record_id || null;
  const meGh    = (p?.user?.github || "").toLowerCase();
  const me = people.find(pp =>
    (meId && pp.record_id === meId) ||
    (meGh && (pp.links?.github || "").toLowerCase() === meGh)
  ) || null;
  const myTeam = cohortIndex.teamForPerson(me);

  // Two sources of "complete":
  //   1. Auto-detect: the underlying field exists in the cohort surface.
  //   2. Local override: user explicitly checked it off (localStorage).
  // The local override wins so participants whose records predate the
  // heuristics aren't stuck staring at false-negatives.
  const has = (obj, key) => obj && obj[key] != null && String(obj[key]).trim() !== "";
  const done = loadOnboardingDone();

  // Step 01's effective state propagates downstream: once you mark "claim
  // your person record" done (or the auto-detect found you), steps 02-05
  // should no longer be greyed out as "blocked". Without this, marking
  // step 01 done felt like a no-op — the next step stayed un-clickable.
  const step1Effective = !!me || !!done["claim-person-record"];
  // Step 05 (project goals) needs a team. Auto-derives from `me.team`;
  // if we can't auto-derive but step 01 was overridden, we don't block —
  // the user picks their team in the profile editor.
  const step5HasTeamContext = !!myTeam || step1Effective;

  // Generic action for "I overrode step 01 but no auto-detected record
  // exists" — drop the user into the profile editor without prefilling a
  // record id so they can pick the right one from the dropdown.
  const openPersonEditorGeneric = { kind: "go-profile", mode: "edit", recordKind: "person", recordId: null, label: "open profile · pick your record" };
  const openTeamEditorGeneric   = { kind: "go-profile", mode: "edit", recordKind: "team",   recordId: null, label: "open profile · pick your team" };

  // Onboarding v0.5 — 6 core steps + 2 bonus. Cohort feedback wanted
  // matrix + interview back in the flow, plus a dedicated step for
  // installing the Electron app (which used to be assumed by step 01
  // but was never given its own slot). Bonus rows render below a
  // visible separator and are explicitly optional.
  //
  //   1. local agent          auto-checked: they're in the app
  //   2. field-kit            link to repo; voxterm comes bundled
  //   3. Shape Rotator OS     install instructions doc (per-platform
  //                           + macOS xattr step). Auto-checks since
  //                           the user is already running it.
  //   4. profile              agent-driven via the /shape-rotator-
  //                           profile skill. Secondary link offers
  //                           the in-app editor as a fallback.
  //   5. join matrix (human)  link to docs/MATRIX.md (operator-stub)
  //   6. interview            external link (operator-stub)
  //   B1. hermes              optional second agent (operator-stub)
  //   B2. bot on matrix       /matrix-bot-setup skill in field-kit
  //
  // The renderer maps `bonus: true` entries to "B<n>" display numbers
  // and inserts a separator before the first bonus row.
  const stepDefs = [
    {
      key: "local-agent",
      title: "set up your local agent",
      ask: `you're reading this <em>inside</em> Shape Rotator OS, which means your local agent is already running on this machine. ✓`,
      autoComplete: true,
      missingState: "complete",
      action: null,
    },
    {
      key: "field-kit",
      title: "install the field-kit",
      ask: `the field-kit gives your local agent CLI tools — research swarm, content pipeline, the cohort skills <strong>and voxterm</strong> (the local-first voice transcription TUI) all in one bundle. clone the repo, run <code>bash setup.sh</code>, then <code>./kit install-global</code> so <code>rotate</code> is on your PATH. after that, <code>rotate vox</code> launches voxterm.`,
      autoComplete: false,
      missingState: "info",
      action: { kind: "external", url: "https://github.com/dmarzzz/shape-rotator-field-kit", label: "open shape-rotator-field-kit" },
    },
    {
      key: "install-electron-app",
      title: "install Shape Rotator OS (the Electron app)",
      ask: `the cohort viewer you're reading this in. ✓ already installed for you, but the install docs cover per-platform steps for the rest of the cohort — including the one extra step macOS users need (<code>xattr -cr</code>) because the app isn't code-signed yet.`,
      autoComplete: true,  // they're inside the app, so by definition
      missingState: "complete",
      action: { kind: "external", url: "https://github.com/dmarzzz/shape-rotator-os/blob/main/docs/INSTALL.md", label: "open install instructions" },
    },
    {
      key: "set-up-profile",
      title: "fill in your profile with the agent skill",
      // Phase 2: profile edits flow through the bundled swf-node first
      // (gossiped to LAN peers within one ~30s sync tick). GitHub PR is
      // the fallback when swf-node isn't running — Windows builds,
      // first launches before the daemon boots, anyone who explicitly
      // SWF_NODE_DISABLE=1's the supervisor.
      ask: me
        ? `you're on the map as <strong>${escHtml(me.name || me.record_id)}</strong>. swf-node syncs your profile to other cohort members on your LAN. GitHub PR is the fallback when swf-node isn't running. ask your local agent (the <code>/shape-rotator-profile</code> skill walks through the schema) or use the in-app editor below.`
        : `add a person record so you appear on the cohort map + calendar. swf-node syncs your profile to other cohort members on your LAN. GitHub PR is the fallback when swf-node isn't running. ask your local agent (the <code>/shape-rotator-profile</code> skill walks through the schema) or use the in-app editor below.`,
      autoComplete: !!me && (
        has(me, "comm_style") || has(me, "contribute_interests") ||
        has(me, "availability_pref") || has(me, "weekly_intention")
      ),
      missingState: "missing",
      action: { kind: "external", url: "https://github.com/dmarzzz/shape-rotator-field-kit/blob/main/skills/shape-rotator-profile/SKILL.md", label: "open the /shape-rotator-profile skill" },
      secondaryAction: me
        ? { kind: "go-profile", mode: "edit", recordKind: "person", recordId: me.record_id, label: "or: use the in-app editor" }
        : { kind: "go-profile", mode: "add",  recordKind: "person",                          label: "or: use the in-app editor" },
    },
    {
      key: "join-matrix",
      title: "join the matrix server (as a human)",
      ask: `the cohort chats in matrix. the doc covers homeserver, room, and client setup — <em>currently a stub; @amiller will fill in homeserver + room IDs once they're settled</em>.`,
      autoComplete: false,
      missingState: "info",
      action: { kind: "external", url: "https://github.com/dmarzzz/shape-rotator-os/blob/main/docs/MATRIX.md", label: "open matrix join instructions" },
    },
    {
      key: "interview",
      title: "do the cohort interview",
      ask: `a short interview so the cohort has a baseline picture of what you bring. the <strong>router</strong> app runs it locally — answer a few questions and it writes your intro for you to review + post.`,
      autoComplete: false,
      missingState: "info",
      action: { kind: "open-app", app: "daybook", label: "open router →" },
      secondaryAction: { kind: "interview-quiz-links", label: "or: show interview status" },
    },
    {
      key: "hermes-agent",
      title: "set up a hermes agent",
      ask: `Hermes is an autonomous second agent that runs alongside your primary local agent — useful for background research, scheduled summaries, etc. <em>links coming once the operator publishes the hermes docs.</em>`,
      autoComplete: false,
      missingState: "info",
      bonus: true,
      action: { kind: "hermes-instructions", label: "show hermes status" },
    },
    {
      key: "agent-on-matrix",
      title: "add your bot to the matrix server",
      ask: `register your local agent as a bot in the cohort room so it can post + read on your behalf. the field-kit ships a <code>/matrix-bot-setup</code> skill that walks through it once @amiller publishes the homeserver details.`,
      autoComplete: false,
      missingState: "info",
      bonus: true,
      action: { kind: "external", url: "https://github.com/dmarzzz/shape-rotator-field-kit/blob/main/skills/matrix-bot-setup/SKILL.md", label: "open the /matrix-bot-setup skill" },
    },
  ];
  // Suppress lint on now-unused vars from the old flow — keep them
  // around so future refactors can hook back into the project-success
  // / week-1-intention shapes.
  void step5HasTeamContext; void openTeamEditorGeneric; void openPersonEditorGeneric;

  // Number the core steps 01/02/..., then re-start the bonus rows at
  // B1/B2/... so the user reads "core: 6 things you should do; bonus:
  // 2 optional extras" without bonus rows inflating the core count.
  let coreCounter = 0;
  let bonusCounter = 0;
  const steps = stepDefs.map((s) => {
    const overridden = !!done[s.key];
    const isComplete = overridden || s.autoComplete;
    let n;
    if (s.bonus) { bonusCounter += 1; n = `B${bonusCounter}`; }
    else         { coreCounter  += 1; n = String(coreCounter).padStart(2, "0"); }
    return {
      ...s,
      n,
      overridden,
      state: isComplete ? "complete" : s.missingState,
    };
  });

  // True once we've emitted the bonus separator so we only emit it
  // once (before the first bonus row).
  let bonusSeparatorEmitted = false;
  const stepHtml = steps.map(s => {
    let separator = "";
    if (s.bonus && !bonusSeparatorEmitted) {
      bonusSeparatorEmitted = true;
      separator = `
        <li class="alch-onb-bonus-sep" aria-hidden="true">
          <span class="alch-onb-bonus-line"></span>
          <span class="alch-onb-bonus-label">bonus · optional</span>
          <span class="alch-onb-bonus-line"></span>
        </li>`;
    }
    // Inline single-field form (currently used by week-1 intention only;
    // pattern extends to any one-field person/team update).
    const inlineHtml = (s.inline && s.state !== "complete" && s.state !== "blocked")
      ? `<form class="alch-onb-inline" data-onb-inline-step="${escAttr(s.key)}"
                data-record-kind="${escAttr(s.inline.recordKind)}"
                data-record-id="${escAttr(s.inline.recordId)}"
                data-field-key="${escAttr(s.inline.fieldKey)}">
           <textarea class="alch-onb-inline-input"
                     rows="2"
                     placeholder="${escAttr(s.inline.placeholder || "")}">${escHtml(s.inline.existing || "")}</textarea>
           <div class="alch-onb-inline-row">
             <button class="alch-feed-btn alch-onb-inline-submit" type="submit">
               ${escHtml(s.inline.submitLabel || "submit → open PR")}
             </button>
             <span class="alch-onb-inline-hint">opens github's web editor with the YAML patch ready to paste</span>
           </div>
           <div class="alch-onb-inline-result" hidden></div>
         </form>`
      : "";
    const action = s.action
      ? `<button class="alch-feed-btn alch-onb-action" type="button"
                 data-onb-action="${escAttr(JSON.stringify(s.action))}">
           ${escHtml(s.action.label)}
         </button>`
      : "";
    // Optional secondary action — renders as a smaller, quieter link
    // next to the primary button. Used by step 04 today to surface
    // the agent-driven path next to the in-app editor button.
    const secondary = s.secondaryAction
      ? `<button class="alch-onb-secondary" type="button"
                 data-onb-action="${escAttr(JSON.stringify(s.secondaryAction))}">
           ${escHtml(s.secondaryAction.label)}
         </button>`
      : "";
    // Per-step "mark done" toggle. Reflects + writes the localStorage map.
    // When auto-detect already says complete we still show the toggle so the
    // user can manually uncheck (and re-pin the step's state if they want).
    const toggleLabel = s.overridden
      ? "✓ marked done"
      : (s.autoComplete ? "auto · mark done" : "mark done");
    const toggleCls = s.overridden ? "alch-onb-done alch-onb-done-on" : "alch-onb-done";
    return separator + `
      <li class="alch-onb-step${s.bonus ? " alch-onb-step-bonus" : ""}" data-state="${escAttr(s.state)}">
        <div class="alch-onb-step-num">${escHtml(s.n)}</div>
        <div class="alch-onb-step-body">
          <h3 class="alch-onb-step-title">${escHtml(s.title)}</h3>
          <p class="alch-onb-step-ask">${s.ask}</p>
          ${inlineHtml}
          <div class="alch-onb-step-actions">
            ${action}
            ${secondary}
            <button class="${toggleCls}" type="button"
                    data-onb-toggle="${escAttr(s.key)}"
                    aria-pressed="${s.overridden}"
                    title="stored in localStorage on this machine">
              ${escHtml(toggleLabel)}
            </button>
          </div>
        </div>
        <div class="alch-onb-step-mark" aria-hidden="true"></div>
      </li>
    `;
  }).join("");

  const coreCount = stepDefs.filter(s => !s.bonus).length;
  const bonusCount = stepDefs.filter(s => s.bonus).length;
  const countLabel = bonusCount > 0
    ? `${coreCount} core step${coreCount === 1 ? "" : "s"} + ${bonusCount} bonus`
    : `${coreCount} step${coreCount === 1 ? "" : "s"}`;
  state.canvas.innerHTML = `
    <header class="alch-onb-head">
      <h2 class="alch-onb-title">onboarding</h2>
      <p class="alch-onb-sub">
        ${me
          ? `you're <strong>${escHtml(me.name || me.record_id)}</strong>. ${countLabel} to get fully wired into the cohort.`
          : `${countLabel} to get fully wired into the cohort.`}
      </p>
    </header>
    <ol class="alch-onb-steps">${stepHtml}</ol>
    <p class="alch-callout"><strong>onboarding · v0.5</strong><br/>
    01 + 03 auto-complete (you're in the app, so the local agent + Electron app are running). 02 sets up the field-kit so your agent gets CLI superpowers — voxterm comes bundled. 04 routes your profile through the field-kit's <code>/shape-rotator-profile</code> skill (with the in-app editor as fallback). 05 + 06 are matrix + interview; both link to in-repo stub docs that the operator will fill in. the bonus rows are second-agent (hermes) and adding your bot to matrix — optional, do them later.</p>
  `;
}

// ─── onboarding action modals ───────────────────────────────────────
// Step 03/04/05 actions don't route inside the app — they show a small
// modal with instructions or external links. The content is intentionally
// stub-shaped (TODO placeholders for the operator) so the flow renders
// today and the values can be dropped in without touching the renderer.

let _onbModalEl = null;
function showOnboardingModal({ title, body }) {
  if (_onbModalEl) closeOnboardingModal();
  const overlay = document.createElement("div");
  overlay.className = "alch-onb-modal-backdrop";
  overlay.innerHTML = `
    <div class="alch-onb-modal" role="dialog" aria-labelledby="onb-modal-title">
      <header class="alch-onb-modal-head">
        <h2 id="onb-modal-title" class="alch-onb-modal-title">${escHtml(title)}</h2>
        <button class="alch-onb-modal-close" type="button" aria-label="close">×</button>
      </header>
      <div class="alch-onb-modal-body">${body}</div>
    </div>
  `;
  document.body.appendChild(overlay);
  _onbModalEl = overlay;
  const close = () => closeOnboardingModal();
  overlay.querySelector(".alch-onb-modal-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", _onbModalKeydown);
  // Wire copy buttons inside the modal body.
  for (const btn of overlay.querySelectorAll("[data-onb-copy]")) {
    btn.addEventListener("click", async () => {
      const text = btn.getAttribute("data-onb-copy") || "";
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.textContent = "copied";
        setTimeout(() => { btn.textContent = prev; }, 1400);
      } catch {}
    });
  }
  // External links open in the user's browser, not in this Electron window.
  wireExternalLinks(overlay);
}
function closeOnboardingModal() {
  if (_onbModalEl) { _onbModalEl.remove(); _onbModalEl = null; }
  document.removeEventListener("keydown", _onbModalKeydown);
}
function _onbModalKeydown(e) { if (e.key === "Escape") closeOnboardingModal(); }

function showMatrixInstructions() {
  // TODO(operator): drop the homeserver URL + room ID + registration
  // policy in once decided. Until then we render the placeholder with a
  // clear "not yet" so participants know it's pending, not broken.
  showOnboardingModal({
    title: "join the cohort matrix server",
    body: `
      <p class="alch-onb-modal-line">the cohort talks on matrix. you'll do this once, from your browser.</p>
      <ol class="alch-onb-modal-steps">
        <li>create an account on the homeserver: <code>TODO_MATRIX_HOMESERVER</code> <span class="alch-onb-modal-aux">(operator will publish the URL)</span></li>
        <li>verify your email if prompted.</li>
        <li>join the cohort room: <code>TODO_MATRIX_ROOM</code></li>
        <li>say hi.</li>
      </ol>
      <p class="alch-onb-modal-aux">recommended clients: <a href="https://element.io/download" data-external>element</a> (desktop) or <a href="https://app.element.io" data-external>element web</a>. anything matrix-compatible works.</p>
    `,
  });
}

function showBotMatrixInstructions() {
  // TODO(operator): once the homeserver is settled, fill in the bot
  // registration token / open-registration policy, and update the
  // /matrix-bot-setup skill in shape-rotator-field-kit to match.
  showOnboardingModal({
    title: "have your agent join matrix",
    body: `
      <p class="alch-onb-modal-line">register your local agent as a bot in the cohort room so it can post research summaries, ship updates, etc. on your behalf.</p>
      <p class="alch-onb-modal-line"><strong>option A — claude code skill</strong> (recommended):</p>
      <pre class="alch-onb-modal-pre">/matrix-bot-setup</pre>
      <p class="alch-onb-modal-aux">if the slash command isn't recognized, install the skill first: <code>rotate install-skills</code> (after cloning <a href="https://github.com/dmarzzz/shape-rotator-field-kit" data-external>shape-rotator-field-kit</a>).</p>
      <p class="alch-onb-modal-line"><strong>option B — manual</strong>:</p>
      <pre class="alch-onb-modal-pre">TODO_BOT_SETUP_SCRIPT</pre>
      <button class="alch-feed-btn" type="button" data-onb-copy="TODO_BOT_SETUP_SCRIPT">copy</button>
      <p class="alch-onb-modal-aux">operator will publish the script once the homeserver registration + bot policy are settled.</p>
    `,
  });
}

function showInterviewQuizLinks() {
  // TODO(operator): drop interview + quiz URLs in. Until then show a
  // "not yet" rather than dead buttons.
  showOnboardingModal({
    title: "interview + quiz",
    body: `
      <p class="alch-onb-modal-line">two short asks so the cohort has a baseline picture of what each of you brings:</p>
      <ul class="alch-onb-modal-steps">
        <li><strong>interview</strong> — 15 minutes, open-ended. <span class="alch-onb-modal-aux">operator will publish the URL.</span></li>
        <li><strong>quiz</strong> — 10 minutes, multiple choice. <span class="alch-onb-modal-aux">operator will publish the URL.</span></li>
      </ul>
      <p class="alch-onb-modal-aux">once published, both URLs should open in your browser.</p>
    `,
  });
}

function showHermesInstructions() {
  showOnboardingModal({
    title: "hermes agent setup",
    body: `
      <p class="alch-onb-modal-line">Hermes docs are not published yet. This step is optional and can wait until the operator posts the setup link.</p>
      <p class="alch-onb-modal-aux">Once published, this action should open the Hermes setup docs in your browser.</p>
    `,
  });
}

// Celebrate finishing an onboarding step. Pure-DOM particle burst — no
// library, no canvas, ~60 absolutely-positioned divs animated via the
// Web Animations API with a gravity-flavored cubic-bezier. Honours the
// user's reduced-motion preference (no burst at all when set).
function triggerConfetti(originEl) {
  if (!originEl) return;
  if (typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    return;
  }
  const rect = originEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  // Cohort palette — keep the celebration on-brand with the rest of the
  // app rather than rainbow Mardi Gras.
  const colors = ["#8F220E", "#c1a872", "#e8b94c", "#7eb499", "#f5f3ee"];

  const container = document.createElement("div");
  container.className = "confetti-burst";
  container.style.cssText =
    `position:fixed;left:${cx}px;top:${cy}px;` +
    `pointer-events:none;z-index:9999;width:0;height:0;`;
  document.body.appendChild(container);

  const N = 56;
  for (let i = 0; i < N; i++) {
    const p = document.createElement("div");
    // Random direction (full 360°), then gravity-biased velocity.
    const angle = Math.random() * Math.PI * 2;
    const speed = 220 + Math.random() * 260;
    const dx = Math.cos(angle) * speed;
    const dy = Math.sin(angle) * speed - 180;  // upward bias on the way out
    const fall = 760 + Math.random() * 240;     // gravity arc on the way down
    const spin = (Math.random() - 0.5) * 1080;
    const color = colors[i % colors.length];
    const w = 6 + Math.random() * 5;
    const h = 3 + Math.random() * 4;
    const round = Math.random() > 0.55 ? "50%" : "1px";
    const dur = 1500 + Math.random() * 900;
    const startRot = Math.random() * 360;

    p.style.cssText =
      `position:absolute;left:0;top:0;` +
      `width:${w.toFixed(1)}px;height:${h.toFixed(1)}px;` +
      `background:${color};border-radius:${round};` +
      `transform:translate(-50%,-50%) rotate(${startRot}deg);`;
    container.appendChild(p);

    p.animate(
      [
        { transform: `translate(-50%,-50%) rotate(${startRot}deg)`, opacity: 1 },
        { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${dy.toFixed(1)}px)) rotate(${(startRot + spin).toFixed(1)}deg)`, opacity: 1, offset: 0.32 },
        { transform: `translate(calc(-50% + ${dx.toFixed(1)}px), calc(-50% + ${(dy + fall).toFixed(1)}px)) rotate(${(startRot + spin * 2).toFixed(1)}deg)`, opacity: 0 },
      ],
      { duration: dur, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "forwards" }
    );
  }
  // Cleanup once the longest animation could have finished.
  setTimeout(() => { try { container.remove(); } catch {} }, 2700);
}

// Submit a single-field update from an onboarding inline form. We fetch
// the user's existing record, mutate the one targeted field, rebuild the
// full markdown, and route through GitHub's /new/?value= URL — the file
// already exists on main, so GitHub forces the "create new branch +
// propose changes" path. Same pattern as the profile EDIT submit.
async function submitOnboardingInline(form) {
  const recordKind = form.dataset.recordKind || "person";
  const recordId   = form.dataset.recordId;
  const fieldKey   = form.dataset.fieldKey;
  const stepKey    = form.dataset.onbInlineStep;
  const input      = form.querySelector(".alch-onb-inline-input");
  const result     = form.querySelector(".alch-onb-inline-result");
  if (!recordId || !fieldKey || !input || !result) return;

  const value = input.value.trim();
  if (!value) {
    result.hidden = false;
    result.innerHTML = `<p class="alch-onb-inline-line alch-onb-inline-err">type something first.</p>`;
    return;
  }
  const folder = recordKind === "person" ? "people"
               : recordKind === "team" || recordKind === "project" ? "teams"
               : `${recordKind}s`;
  const filename = `cohort-data/${folder}/${recordId}.md`;

  // Pull the existing record from the cohort surface so the rebuild
  // preserves every other field. Mutate just the one the user typed.
  const cohort = state.cohort;
  let baseline = null;
  if (cohort) {
    const cohortIndex = buildCohortIndex(cohort);
    if (recordKind === "person") baseline = cohortIndex.personById.get(recordId);
    else baseline = cohortIndex.teamById.get(recordId);
  }
  if (!baseline) {
    result.hidden = false;
    result.innerHTML = `<p class="alch-onb-inline-line alch-onb-inline-err">couldn't find your record in the local cohort cache. reload + try again.</p>`;
    return;
  }
  const draft = JSON.parse(JSON.stringify(baseline));
  draft[fieldKey] = value;

  result.hidden = false;
  result.innerHTML = `<p class="alch-onb-inline-line"><span class="alch-onb-inline-tag">preparing</span> building your updated file…</p>`;

  const existingBody = await fetchExistingBody(filename);
  const content = recordKind === "person"
    ? buildPersonMarkdown(draft, recordId, existingBody)
    : buildTeamMarkdown(draft, recordId, recordKind === "project" ? "project" : "team", existingBody);

  const launched = await launchPRFlow({ kind: "new", path: filename, value: content });
  if (!launched.ok) {
    result.hidden = false;
    result.innerHTML = `
      <p class="alch-onb-inline-line">
        <span class="alch-onb-inline-tag">fork first</span>
        once your fork exists, click submit again — your text is still in the box.
      </p>
    `;
    return;
  }
  const editUrl = launched.url;
  result.hidden = false;
  result.innerHTML = `
    <p class="alch-onb-inline-line">
      <span class="alch-onb-inline-tag">github opened</span>
      your <code>${escHtml(fieldKey)}</code> edit is pre-filled. on github: <strong>commit changes</strong> → <strong>propose changes</strong> → <strong>create pull request</strong>.
    </p>
    <div class="alch-onb-inline-row">
      <a class="alch-onb-inline-link" href="${escAttr(editUrl)}" data-external>reopen editor</a>
    </div>
  `;
  wireExternalLinks(result);
}

function wireOnboarding() {
  for (const btn of state.canvas.querySelectorAll(".alch-onb-done[data-onb-toggle]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.onbToggle;
      if (!key) return;
      // Detect direction: only celebrate when going OFF → ON. Unmarking
      // (clearing a stuck override) shouldn't fire confetti.
      const wasDone = !!loadOnboardingDone()[key];
      toggleOnboardingDone(key);
      const isDoneNow = !!loadOnboardingDone()[key];
      if (!wasDone && isDoneNow) triggerConfetti(btn);
      // Remember which step we just toggled so the post-render handler
      // can scroll to (and momentarily pulse) whatever comes next.
      state.onboardingJustToggled = key;
      render();
    });
  }
  // Inline single-field submit (week-1 intention today; pattern extends).
  for (const form of state.canvas.querySelectorAll("form.alch-onb-inline")) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitOnboardingInline(form);
    });
  }
  // After re-render, surface forward motion: scroll the first step that
  // still needs action into view + brief pulse highlight. Render() is
  // animated (~220ms swap) so we wait past that before measuring DOM.
  if (state.onboardingJustToggled) {
    const justKey = state.onboardingJustToggled;
    state.onboardingJustToggled = null;
    setTimeout(() => {
      if (!state.canvas) return;
      // Prefer the step immediately after the one we just toggled. Fall
      // back to the first non-complete actionable step on the page.
      const steps = Array.from(state.canvas.querySelectorAll(".alch-onb-step"));
      const justIdx = steps.findIndex(li => li.querySelector(`[data-onb-toggle="${justKey}"]`));
      const candidates = justIdx >= 0 ? steps.slice(justIdx + 1) : steps;
      const next = candidates.find(li => {
        const st = li.getAttribute("data-state");
        return st === "missing" || st === "info";
      });
      if (next) {
        next.scrollIntoView({ behavior: "smooth", block: "center" });
        next.classList.add("is-onb-next-pulse");
        setTimeout(() => next.classList.remove("is-onb-next-pulse"), 1600);
      }
    }, 260);
  }
  for (const btn of state.canvas.querySelectorAll(".alch-onb-action")) {
    btn.addEventListener("click", () => {
      let a;
      try { a = JSON.parse(btn.dataset.onbAction || "{}"); } catch { return; }
      if (a.kind === "go-profile") {
        // Reuse the public profile-opener already wired for cross-tab handoff
        // (defined on window.__srwkOpenProfile). Keeps a single code path
        // for "land on profile focused on record X".
        if (typeof window.__srwkOpenProfile === "function") {
          window.__srwkOpenProfile({ kind: a.recordKind, mode: a.mode || "edit", record_id: a.recordId });
        }
      } else if (a.kind === "go-program") {
        state.mode = "program";
        try { localStorage.setItem(ALCHEMY_LS_KEY, "program"); } catch {}
        if (a.page) state.programPage = a.page;
        syncRailSelection();
        render();
      } else if (a.kind === "external" && a.url) {
        try { window.api?.openExternal?.(a.url); } catch {}
      } else if (a.kind === "open-app" && a.app) {
        // Deep-link into an apps-tab sub-app (boot.js owns the navigation).
        try { window.__srwkOpenApp?.(a.app); } catch {}
      } else if (a.kind === "matrix-instructions") {
        showMatrixInstructions();
      } else if (a.kind === "bot-matrix-instructions") {
        showBotMatrixInstructions();
      } else if (a.kind === "interview-quiz-links") {
        showInterviewQuizLinks();
      } else if (a.kind === "hermes-instructions") {
        showHermesInstructions();
      }
    });
  }
}

// ─── program handbook ───────────────────────────────────────────────
// Tabbed renderer over cohort-data/program/*.md. Each page's body_md
// is shipped in the surface bundle; we do a lightweight markdown→HTML
// pass (enough for headings, paragraphs, em/strong, code, lists, links).
// Each page has a "edit this page" link that opens github's web editor
// at the corresponding cohort-data/program/<slug>.md path.

function escHtmlPreserve(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Minimal markdown→HTML. Intentionally narrow: handles the subset we
// actually use in program/*.md. If we need more (tables, footnotes,
// images) lift a real lib later; today: zero deps, predictable output.
function renderProgramMarkdown(md) {
  const src = String(md || "").trim();
  if (!src) return `<p class="alch-prog-empty">(this page is empty — fill it in via the edit button above.)</p>`;
  const lines = src.split(/\r?\n/);
  const out = [];
  let inUl = false, inOl = false, inP = false, inTable = false, tableRows = 0;
  const closeBlocks = () => {
    if (inP)  { out.push("</p>"); inP = false; }
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
    if (inTable) { out.push("</tbody></table></div>"); inTable = false; tableRows = 0; }
  };
  const inline = (text) => {
    let t = escHtmlPreserve(text);
    // code spans first so we don't escape inside them
    t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/_([^_\n]+)_/g, "<em>$1</em>");
    // [label](url)
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safe = url.startsWith("http") || url.startsWith("/") || url.startsWith("#") ? url : "#";
      return `<a href="${safe}" data-external>${label}</a>`;
    });
    return t;
  };

  // Split a pipe-delimited markdown row into cells. Trims the leading +
  // trailing pipe if present, then splits on `|` and trims each cell.
  // (Escaped pipes \| within cells are rare in our content; not handled.)
  const splitRow = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(s => s.trim());
  // GFM separator row, with optional alignment markers (:---, ---:, :---:).
  // Returns alignments array (each "left"|"right"|"center"|null) or null
  // if the line isn't a valid separator.
  const parseSeparator = (row) => {
    const cells = splitRow(row);
    if (!cells.length) return null;
    const aligns = [];
    for (const c of cells) {
      if (!/^:?-{3,}:?$/.test(c)) return null;
      const left = c.startsWith(":");
      const right = c.endsWith(":");
      aligns.push(left && right ? "center" : right ? "right" : left ? "left" : null);
    }
    return aligns;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { closeBlocks(); continue; }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) { closeBlocks(); out.push(`<h${h[1].length} class="alch-prog-h${h[1].length}">${inline(h[2])}</h${h[1].length}>`); continue; }
    // GFM table — header row + separator row + N body rows. Detected by
    // the next line being a valid separator; otherwise this line is just
    // text-with-pipes and falls through to the paragraph path.
    if (line.includes("|") && i + 1 < lines.length) {
      const aligns = parseSeparator(lines[i + 1].trim());
      if (aligns) {
        closeBlocks();
        const headers = splitRow(line);
        const alignAttr = (j) => aligns[j] ? ` style="text-align:${aligns[j]}"` : "";
        let html = `<table class="alch-prog-table"><thead><tr>`;
        headers.forEach((c, j) => { html += `<th${alignAttr(j)}>${inline(c)}</th>`; });
        html += `</tr></thead><tbody>`;
        let j = i + 2;
        while (j < lines.length && lines[j].trim() && lines[j].includes("|")) {
          const cells = splitRow(lines[j].trim());
          html += `<tr>`;
          cells.forEach((c, k) => { html += `<td${alignAttr(k)}>${inline(c)}</td>`; });
          html += `</tr>`;
          j++;
        }
        html += `</tbody></table>`;
        out.push(html);
        i = j - 1; // outer loop will i++ past the last body row
        continue;
      }
    }
    // Blockquote — single-line `> text`, no nesting. Most program pages
    // use these for pull-quotes; multi-line continuation isn't worth
    // the complexity until we need it.
    const bq = /^>\s+(.+)$/.exec(line);
    if (bq) { closeBlocks(); out.push(`<blockquote class="alch-prog-bq">${inline(bq[1])}</blockquote>`); continue; }
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    if (ul) {
      if (inP)  { out.push("</p>"); inP = false; }
      if (inTable) { out.push("</tbody></table></div>"); inTable = false; tableRows = 0; }
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push(`<ul class="alch-prog-ul">`); inUl = true; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      if (inP)  { out.push("</p>"); inP = false; }
      if (inTable) { out.push("</tbody></table></div>"); inTable = false; tableRows = 0; }
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push(`<ol class="alch-prog-ol">`); inOl = true; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    // Paragraph text.
    if (inUl || inOl) closeBlocks();
    if (inTable) { out.push("</tbody></table></div>"); inTable = false; tableRows = 0; }
    if (!inP) { out.push(`<p class="alch-prog-p">`); inP = true; }
    else out.push(" ");
    out.push(inline(line));
  }
  closeBlocks();
  return out.join("");
}

function programPages() {
  const pages = (state.cohort?.program || []).slice();
  // Defensive sort by `order` then record_id; matches the build script.
  pages.sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 1e9;
    const bo = Number.isFinite(b.order) ? b.order : 1e9;
    if (ao !== bo) return ao - bo;
    return String(a.record_id).localeCompare(String(b.record_id));
  });
  return pages;
}

function currentProgramPage(pages) {
  const want = state.programPage || pages[0]?.record_id;
  const current = pages.find(p => p.record_id === want) || pages[0] || null;
  if (current) state.programPage = current.record_id;
  return current;
}

function renderProgramTabs(pages, current) {
  return pages.map(p => `
    <button class="alch-prog-tab" type="button"
            data-program-page="${escAttr(p.record_id)}"
            aria-selected="${p.record_id === current.record_id}">
      <span class="alch-prog-tab-num">${escHtml(String(Number.isFinite(p.order) ? p.order : "·").padStart(2, "0"))}</span>
      <span class="alch-prog-tab-label">${escHtml(p.title || p.record_id)}</span>
    </button>
  `).join("");
}

function renderProgramPage(current) {
  const bodyHtml = renderProgramMarkdown(current.body_md);
  const editPath = `cohort-data/program/${current.record_id}.md`;
  return `
    <article class="alch-prog-page">
      <header class="alch-prog-page-head">
        <h2 class="alch-prog-page-title">${escHtml(current.title || current.record_id)}</h2>
        <button class="alch-feed-btn alch-prog-edit" type="button" data-edit-path="${escAttr(editPath)}" title="opens github's web editor (PR-only)">
          <span aria-hidden="true">✎</span>
          <span>edit this page</span>
        </button>
      </header>
      <div class="alch-prog-body">${bodyHtml}</div>
      <footer class="alch-prog-page-foot">
        <span class="alch-prog-aux">source:</span> <code>${escHtml(editPath)}</code>
      </footer>
    </article>
  `;
}

function renderProgram() {
  const pages = programPages();

  if (pages.length === 0) {
    state.canvas.innerHTML = `
      <header class="alch-prog-head">
        <h2 class="alch-prog-title">program</h2>
        <p class="alch-prog-sub">no program pages in the surface bundle yet.</p>
      </header>
      <p class="alch-callout">run <code>npm run build:cohort</code> after adding files under <code>cohort-data/program/</code>.</p>
    `;
    return;
  }

  const current = currentProgramPage(pages);
  const tabs = renderProgramTabs(pages, current);

  state.canvas.innerHTML = `
    <header class="alch-prog-head">
      <h2 class="alch-prog-title">program</h2>
      <p class="alch-prog-sub">the handbook. edits open a PR on github — stewards merge → next build:cohort ships the change to the cohort.</p>
    </header>
    <nav class="alch-prog-tabs" role="tablist" aria-label="program section">${tabs}</nav>
    ${renderProgramPage(current)}
  `;
}

function syncProgramTabSelection(currentId) {
  for (const btn of state.canvas.querySelectorAll(".alch-prog-tab[data-program-page]")) {
    btn.setAttribute("aria-selected", String(btn.dataset.programPage === currentId));
  }
}

function wireProgramPageActions(root = state.canvas) {
  const editBtn = root.querySelector(".alch-prog-edit[data-edit-path]");
  if (editBtn) {
    editBtn.addEventListener("click", async () => {
      await launchPRFlow({ kind: "edit", path: editBtn.dataset.editPath });
    });
  }
  wireExternalLinks(root);
}

function selectProgramPage(pageId) {
  if (!pageId) return;
  state.programPage = pageId;
  const pages = programPages();
  const current = currentProgramPage(pages);
  if (!current) {
    render();
    return;
  }

  const page = state.canvas?.querySelector(".alch-prog-page");
  const tabs = state.canvas?.querySelector(".alch-prog-tabs");
  if (state.mode === "program" && page && tabs) {
    syncProgramTabSelection(current.record_id);
    page.outerHTML = renderProgramPage(current);
    wireProgramPageActions(state.canvas.querySelector(".alch-prog-page") || state.canvas);
    return;
  }
  render();
}

function wireProgram() {
  for (const btn of state.canvas.querySelectorAll(".alch-prog-tab[data-program-page]")) {
    btn.addEventListener("click", () => {
      selectProgramPage(btn.dataset.programPage);
    });
  }
  wireProgramPageActions(state.canvas);
}

// ─── asks board ─────────────────────────────────────────────────────
// Recurse pairing-bot + ETHGlobal #find-a-team pattern. Each ask is a
// markdown file under cohort-data/asks/ with frontmatter {posted_at,
// author, verb, topic, skill_areas, status}. Posts fade after 5 days
// from posted_at (renderer-side filter; the underlying file stays so
// the audit trail is preserved).
//
// Sensitivity: this surface intentionally has NO leaderboard, NO claim
// count, NO "endorsement" mechanic, NO algorithm matching. Keep the
// interaction to post, claim, finish, and contact the author.

function dmLinkForPerson(p) {
  // Preference order: telegram > x > website > github > email.
  // Returns { label, url } or null.
  if (!p) return null;
  const L = p.links || {};
  if (L.telegram) return { label: "telegram", url: L.telegram.startsWith("http") ? L.telegram : `https://t.me/${L.telegram.replace(/^@/, "")}` };
  if (L.x)        return { label: "x / dm",   url: L.x.startsWith("http")        ? L.x        : `https://x.com/${L.x.replace(/^@/, "")}` };
  if (L.github)   return { label: "github",   url: L.github.startsWith("http")   ? L.github   : `https://github.com/${L.github}` };
  if (L.website)  return { label: "website",  url: L.website };
  if (p.email)    return { label: "email",    url: `mailto:${p.email}` };
  return null;
}

function currentAskContext() {
  const people = state.cohort?.people || [];
  const me = state.profile?.user || {};
  const askIdentity = { identity: getIdentity(), profileUser: me, people };
  const myPerson = resolveAskIdentityPerson(askIdentity);
  const myHandle = normalizeAskIdentity(me.github || me.gh_handle || me.handle || me.links?.github);
  const authorSlug = myPerson?.record_id || me.record_id || (myHandle ? myHandle : "your-slug");
  return { people, me, askIdentity, myPerson, myHandle, authorSlug };
}

// ─── cohort collaboration board (ported from the dossier Connections) ─
// Standing seek↔offer matchmaking across teams, fed ENTIRELY from public
// self-asserted cohort-surface fields (dependencies / seeking / offering /
// skill_areas / pair_with). The dossier's private 'strength' + OSINT
// 'shared_papers' scores are NOT used — affinity is recomputed from shared
// skill_areas (+ self-declared pair_with), and intros from public
// seeking↔offering term overlap, shown as chips so every match is legible.
function collabCell(R, C, ri, ci, m) {
  if (R.rid === C.rid) return `<div class="cb-cell cb-diag" data-row="${ri}" data-col="${ci}" aria-hidden="true"></div>`;
  const dep = m.deps.has(R.rid + ">" + C.rid);
  const so = m.soByPair.get(R.rid + ">" + C.rid);
  const af = m.aff.get(collabAffKey(R.rid, C.rid));
  let cls = "cb-cell", mark = "", title = "", has = false;
  if (af) { cls += " has-aff"; has = true; mark = "·"; title = `${R.team.name} ↔ ${C.team.name} — shares ${af.shared.join(", ") || "interests"}${af.endorsed ? " · endorsed pairing" : ""}`; }
  if (so) { cls += " has-so s" + Math.min(4, so.score); has = true; mark = "◆"; title = `${R.team.name} seeks → ${C.team.name} offers — ${so.shared.join(", ")}`; }
  if (dep) { cls += " has-dep"; has = true; mark = "▲"; title = `${R.team.name} depends on ${C.team.name}`; }
  if (!has) return `<div class="cb-cell" data-row="${ri}" data-col="${ci}"></div>`;
  return `<button type="button" class="${cls}" data-row="${ri}" data-col="${ci}" data-collab-open="${escAttr(C.rid)}" title="${escAttr(title)}"><span class="cb-mark">${mark}</span></button>`;
}

function renderCollab() {
  const teams = (state.cohort?.teams || []).filter(t => t && t.record_id);
  const clusters = state.cohort?.clusters || [];
  if (!teams.length) {
    state.canvas.innerHTML = `<header class="alch-cb-head"><h2 class="alch-cb-title">collaboration board</h2></header><p class="alch-callout">no team data yet.</p>`;
    return;
  }
  const m = buildCollabModel(teams, clusters);
  const ordered = m.ordered;
  const N = ordered.length;
  const colN = `--cb-cols:${N}`;

  // header row (offerers across the top)
  let headCells = `<div class="cb-corner" aria-hidden="true">seeks ↓ · offers →</div>`;
  ordered.forEach((o, ci) => {
    const deg = m.indegree.get(o.rid) || 0;
    headCells += `<button type="button" class="cb-colhead${deg >= 5 ? " is-key" : ""}" data-col="${ci}" data-collab-open="${escAttr(o.rid)}" title="${escAttr(o.team.name + " — " + deg + " teams depend on it")}"><span>${escHtml(o.team.name)}</span></button>`;
  });
  let rows = `<div class="cb-row cb-headrow" style="${colN}">${headCells}</div>`;
  ordered.forEach((R, ri) => {
    let line = `<button type="button" class="cb-rowhead" data-row="${ri}" data-collab-open="${escAttr(R.rid)}" title="${escAttr(R.team.name + " · " + R.clusterLabel)}"><span class="cb-rowhead-name">${escHtml(R.team.name)}</span><span class="cb-rowhead-grp">${escHtml(R.clusterLabel)}</span></button>`;
    ordered.forEach((C, ci) => { line += collabCell(R, C, ri, ci, m); });
    rows += `<div class="cb-row" style="${colN}">${line}</div>`;
  });
  const matrix = `
    <section class="alch-cb-section">
      <div class="alch-cb-sechead"><h3>adjacency matrix</h3>
        <div class="cb-legend">
          <span><i class="cb-sw dep"></i>depends on</span>
          <span><i class="cb-sw so"></i>seeks → offers</span>
          <span><i class="cb-sw aff"></i>shared skill area</span>
          <span><i class="cb-sw key"></i>keystone column</span>
        </div>
      </div>
      <div class="cb-scroll" tabindex="0"><div class="cb-grid">${rows}</div></div>
      <p class="cb-hint">rows = the team that needs · columns = the team that provides · hover a cell for the basis · click to open the provider</p>
    </section>`;

  // intros to make — strongest seek↔offer per unordered pair
  const introByPair = new Map();
  for (const s of m.seekOffer) {
    const k = collabAffKey(s.seeker, s.offerer);
    if (!introByPair.has(k) || s.score > introByPair.get(k).score) introByPair.set(k, s);
  }
  const intros = [...introByPair.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  const introCards = intros.map(s => {
    const chips = s.shared.slice(0, 5).map(c => `<span class="cb-chip">${escHtml(c)}</span>`).join("");
    return `<article class="cb-intro" data-collab-cohort-open="${escAttr(s.offerer)}" role="link" tabindex="0" title="${escAttr(`open ${s.offererName || s.offerer} on the cohort page`)}">
      <div class="cb-intro-flow">
        <div class="cb-intro-side"><span class="cb-intro-role">needs</span><span class="cb-intro-team">${escHtml(s.seekerName)}</span>${s.seeking ? `<span class="cb-intro-text">${escHtml(s.seeking)}</span>` : ""}</div>
        <div class="cb-intro-arrow" aria-hidden="true">→</div>
        <div class="cb-intro-side"><span class="cb-intro-role">provides</span><span class="cb-intro-team">${escHtml(s.offererName)}</span>${s.offering ? `<span class="cb-intro-text">${escHtml(s.offering)}</span>` : ""}</div>
      </div>${chips ? `<div class="cb-intro-chips">${chips}</div>` : ""}
    </article>`;
  }).join("");
  const introSection = `
    <section class="alch-cb-section">
      <div class="alch-cb-sechead"><h3>intros to make</h3><span class="cb-sub">strongest seek ↔ offer overlaps — the conversations to schedule</span></div>
      <div class="cb-intro-grid">${introCards || '<p class="cb-empty">no overlaps found.</p>'}</div>
    </section>`;

  // convergence — skill areas shared by 3+ teams
  const maxConv = m.convergence.reduce((mx, c) => Math.max(mx, c.count), 1);
  const convRows = m.convergence.map(c => {
    const pct = Math.round((c.count / maxConv) * 100);
    const weight = c.count >= 8 ? " heavy" : c.count >= 5 ? " mid" : "";
    return `<article class="cb-cv${weight}">
      <div class="cb-cv-head"><span class="cb-cv-skill">${escHtml(c.skill)}</span><span class="cb-cv-count">${c.count} teams</span></div>
      <div class="cb-cv-bar"><i style="width:${pct}%"></i></div>
      <div class="cb-cv-teams">${c.teams.map(t => `<span class="cb-cv-team">${escHtml(t)}</span>`).join("")}</div>
    </article>`;
  }).join("");
  const convSection = `
    <section class="alch-cb-section">
      <div class="alch-cb-sechead"><h3>convergence</h3><span class="cb-sub">skill areas shared by 3+ teams — where the cohort concentrates</span></div>
      <div class="cb-cv-list">${convRows || '<p class="cb-empty">no shared areas.</p>'}</div>
    </section>`;

  state.canvas.innerHTML = `
    <div class="alch-collab">
      <header class="alch-cb-head">
        <h2 class="alch-cb-title">collaboration board</h2>
        <p class="alch-cb-sub">who depends on whom, who can unblock whom, where the cohort over-concentrates — all from teams' own declared dependencies, seeking, offering &amp; skill areas.</p>
        <div class="alch-cb-stats">
          <span><strong>${m.deps.size}</strong> dependencies</span>
          <span><strong>${m.seekOffer.length}</strong> seek ↔ offer overlaps</span>
          <span><strong>${m.aff.size}</strong> shared affinities</span>
          <span><strong>${m.convergence.length}</strong> convergence areas</span>
        </div>
      </header>
      ${matrix}
      ${introSection}
      ${convSection}
      <p class="alch-callout"><strong>collaboration board · v0.1</strong><br/>Self-asserted only — affinities are shared <code>skill_areas</code>, intros are <code>seeking</code>↔<code>offering</code> term overlaps. No inferred or private scoring.</p>
    </div>`;
}

function wireCollab() {
  for (const el of state.canvas.querySelectorAll("[data-collab-cohort-open]")) {
    const activate = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const rid = el.getAttribute("data-collab-cohort-open");
      if (!rid) return;
      try { window.api?.openExternal?.(cohortRecordUrl(rid)); } catch {}
    };
    el.addEventListener("click", activate);
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") activate(event);
    });
  }
  for (const el of state.canvas.querySelectorAll("[data-collab-open]")) {
    el.addEventListener("click", () => { const rid = el.getAttribute("data-collab-open"); if (rid) openDrawer(rid); });
  }
  const grid = state.canvas.querySelector(".cb-grid");
  if (!grid) return;
  const clearHL = () => grid.querySelectorAll(".is-hl-row, .is-hl-col").forEach(e => e.classList.remove("is-hl-row", "is-hl-col"));
  const setHL = (r, c) => {
    clearHL();
    if (r != null) grid.querySelectorAll(`[data-row="${r}"]`).forEach(e => e.classList.add("is-hl-row"));
    if (c != null) grid.querySelectorAll(`[data-col="${c}"]`).forEach(e => e.classList.add("is-hl-col"));
  };
  grid.addEventListener("mouseover", (e) => {
    const t = e.target.closest("[data-row], [data-col]");
    if (!t) return;
    const r = t.getAttribute("data-row"), c = t.getAttribute("data-col");
    setHL(r != null ? +r : null, c != null ? +c : null);
  });
  grid.addEventListener("mouseleave", clearHL);
}

function renderAsks() {
  const asks = asksWithStatus(state.cohort?.asks);
  const { people, askIdentity, myHandle, authorSlug } = currentAskContext();

  const open = asks.filter(askIsOpen);
  const closed = asks.filter(a => !askIsOpen(a));

  const renderAsk = (a) => {
    const author = resolveAskAuthor(a, people);
    const authorLabel = author ? (author.name || author.record_id) : (a.author || a.owner || "unknown");
    const dm = dmLinkForPerson(author);
    const chips = (a.skill_areas || []).map(s => `<span class="alch-asks-chip">${escHtml(s)}</span>`).join("");
    const isMine = isAskMine(a, askIdentity);
    const claimedByMe = a.claimed_by ? isAskMine({ author: a.claimed_by }, askIdentity) : false;
    const ageLabel = askAgeLabel(a) || "—";
    const status = askStatus(a);
    const verb = String(a.verb || "ask").trim();
    const verbGlyph = Array.from(verb)[0] || "·";
    const verbLabel = Array.from(verb).slice(1).join("").trim() || verb;
    const statusBadge = status === "claimed" ? `<span class="alch-asks-status alch-asks-status-claimed">claimed</span>`
                      : status === "done"    ? `<span class="alch-asks-status alch-asks-status-done">done</span>`
                      : a._expired           ? `<span class="alch-asks-status alch-asks-status-fading">fading</span>`
                      : "";
    const topic = askTopic(a) || "untitled ask";
    const actions = [];
    if (isMine && status !== "done") {
      actions.push(`<a class="alch-asks-action alch-asks-action-primary alch-asks-action-edit" data-asks-edit="${escAttr(a.record_id)}" href="#">edit</a>`);
    } else if (status === "open" && !a._expired) {
      if (authorSlug !== "your-slug") {
        actions.push(`<button class="alch-asks-action alch-asks-action-primary" type="button" data-asks-claim="${escAttr(a.record_id)}">claim</button>`);
      } else if (dm) {
        actions.push(`<a class="alch-asks-action alch-asks-action-primary" data-external href="${escAttr(dm.url)}">${escHtml(dm.label)} →</a>`);
      } else {
        actions.push(`<span class="alch-asks-action alch-asks-action-disabled">claim needs profile</span>`);
      }
    } else if (status === "claimed" && (claimedByMe || isMine)) {
      actions.push(`<button class="alch-asks-action alch-asks-action-primary" type="button" data-asks-done="${escAttr(a.record_id)}">done</button>`);
    }
    if (dm && !isMine && status !== "done") {
      actions.push(`<a class="alch-asks-action alch-asks-action-secondary" data-external href="${escAttr(dm.url)}">${escHtml(dm.label)}</a>`);
    }
    const actionsMarkup = actions.length
      ? `<div class="alch-asks-actions">${actions.join("")}</div>`
      : "";
    return `
      <details class="alch-asks-card" data-expired="${a._expired ? "1" : "0"}" data-asks-record="${escAttr(a.record_id)}">
        <summary class="alch-asks-summary">
          <span class="alch-asks-verb" title="${escAttr(verb)}" aria-label="${escAttr(verbLabel)}">${escHtml(verbGlyph)}</span>
          <span class="alch-asks-body">
            <span class="alch-asks-topic" title="${escAttr(topic)}">${escHtml(topic)}</span>
            <span class="alch-asks-meta">
              <span class="alch-asks-author">${escHtml(authorLabel)}</span>
              <span class="alch-asks-sep">·</span>
              <span class="alch-asks-when">${escHtml(ageLabel)}</span>
              ${statusBadge}
            </span>
          </span>
          <span class="alch-asks-row-caret" aria-hidden="true"></span>
        </summary>
        <div class="alch-asks-expanded">
          ${chips ? `<div class="alch-asks-chips">${chips}</div>` : ""}
          <div class="alch-asks-context" data-asks-context-panel hidden></div>
          ${actionsMarkup}
          <div class="alch-asks-row-note" data-asks-row-note hidden></div>
        </div>
      </details>
    `;
  };

  const section = (title, list, emptyText) => `
    <details class="alch-asks-section" open>
      <summary class="alch-asks-section-head">
        <span class="alch-asks-section-caret" aria-hidden="true"></span>
        <h3 class="alch-asks-section-title">${escHtml(title)}</h3>
        <span class="alch-asks-section-count">${list.length}</span>
      </summary>
      ${list.length
        ? `<div class="alch-asks-list">${list.map(renderAsk).join("")}</div>`
        : `<p class="alch-asks-empty">${escHtml(emptyText)}</p>`}
    </details>
  `;

  // Author slug: prefer the cohort-resolved person record_id (so the
  // ask's `author` field actually points at a record), fall back to
  // their github handle, then a literal "your-slug" the user edits in
  // the github web editor. (Old code injected a stale branch name here;
  // both /new/ and /edit/ now target `main`.)
  const todayIso = new Date().toISOString().slice(0, 10);

  // Common verbs the compose form offers as quick picks. Stays in code
  // (not cohort-data) since it's a tiny vocab that drives nothing else.
  const ASK_VERB_OPTIONS = [
    "🤝 pair on",
    "🎨 need 30 min with",
    "🔬 brain on",
    "🧪 try this with me",
    "📣 looking for",
    "🪛 help me debug",
  ];
  const askVerbPills = ASK_VERB_OPTIONS.map((v, i) => `
    <button class="alch-asks-verb-pill" type="button" data-asks-verb="${escAttr(v)}" aria-pressed="${i === 0 ? "true" : "false"}">
      ${escHtml(v)}
    </button>
  `).join("");
  const openComposer = state.openAskComposer === true;
  state.openAskComposer = false;

  state.canvas.innerHTML = `
    <header class="alch-asks-head">
      <h2 class="alch-asks-title">asks</h2>
    </header>

    <form class="alch-asks-compose" data-author-slug="${escAttr(authorSlug)}" data-today="${escAttr(todayIso)}" data-autofocus="${openComposer ? "1" : "0"}">
      <details class="alch-asks-compose-shell" data-asks-compose-details${openComposer ? " open" : ""}>
        <summary class="alch-asks-compose-head">
          <span class="alch-asks-compose-title">post an ask</span>
          <span class="alch-asks-verb-pills" role="group" aria-label="ask type">
            ${askVerbPills}
          </span>
          <span class="alch-asks-compose-caret" aria-hidden="true"></span>
        </summary>
        <input type="hidden" name="verb" value="${escAttr(ASK_VERB_OPTIONS[0])}" />
        <div class="alch-asks-compose-body">
          <div class="alch-asks-compose-grid">
            <label class="alch-asks-compose-field alch-asks-compose-topic">
              <span class="alch-asks-compose-label">topic</span>
              <textarea name="topic" rows="2" class="alch-asks-compose-input"
                        placeholder="fuzzing the AMM contract — would love 30 min with someone who's done property testing"></textarea>
            </label>
            <label class="alch-asks-compose-field alch-asks-compose-tags">
              <span class="alch-asks-compose-label">tags <span class="alch-asks-compose-hint">(comma-separated, from cohort vocab if you can)</span></span>
              <input name="skill_areas" type="text" class="alch-asks-compose-input" placeholder="tee, dstack, attestation" />
            </label>
            <details class="alch-asks-compose-context">
              <summary>add context</summary>
              <label class="alch-asks-compose-field">
                <span class="alch-asks-compose-label">context</span>
                <textarea name="body" rows="3" class="alch-asks-compose-input" placeholder="links, constraints, what you've tried"></textarea>
              </label>
            </details>
          </div>
          <div class="alch-asks-compose-row">
            <button class="alch-feed-btn alch-asks-compose-submit" type="submit">submit → open PR</button>
            <span class="alch-asks-compose-author">posting as <strong>${escHtml(authorSlug)}</strong>${myHandle && authorSlug !== myHandle ? ` · @${escHtml(myHandle)}` : ""}</span>
          </div>
          <div class="alch-asks-compose-result" hidden></div>
        </div>
      </details>
    </form>

    ${section("open", open, "no open asks.")}

    ${section("closed", closed, "nothing closed yet.")}
  `;
}

function askMarkdownPath(recordId) {
  return `cohort-data/asks/${recordId}.md`;
}

function askPostedDate(ask) {
  const raw = String(ask?.posted_at || "").match(/(\d{4})-(\d{2})-(\d{2})/);
  return raw ? raw[0] : new Date().toISOString().slice(0, 10);
}

function askTagsBlock(skillAreas) {
  const tags = (Array.isArray(skillAreas) ? skillAreas : [])
    .map(s => String(s).trim())
    .filter(Boolean);
  return tags.length
    ? "skill_areas:\n" + tags.map(s => `  - ${quoteYaml(s)}`).join("\n")
    : "skill_areas: []";
}

function askBodyOrPlaceholder(body) {
  if (body == null) return "\n(optional body — extra context for the ask.)\n";
  const s = String(body);
  return s.startsWith("\n") ? s : `\n${s}`;
}

function buildAskMarkdown(ask, overrides = {}, body = null) {
  const merged = { ...ask, ...overrides };
  const claimedBy = String(merged.claimed_by || "").trim();
  return `---
record_id: ${merged.record_id}
record_type: ask
schema_version: ${merged.schema_version || 1}
posted_at: ${askPostedDate(merged)}
author: ${quoteYaml(merged.author || "your-slug")}
verb: ${quoteYaml(merged.verb || "🤝 pair on")}
topic: ${yamlScalar(askTopic(merged) || "untitled ask", 2)}
${askTagsBlock(merged.skill_areas)}
status: ${quoteYaml(askStatus(merged))}
${claimedBy ? `claimed_by: ${quoteYaml(claimedBy)}\n` : ""}---${askBodyOrPlaceholder(body)}`;
}

function cleanAskBody(body) {
  const s = String(body || "").trim();
  if (!s) return "";
  if (/^\(optional body\s+—\s+extra context for the ask\.\)$/i.test(s)) return "";
  if (/^\(this is a seed example so the asks tab isn't empty/i.test(s)) return "";
  return s;
}

function findRenderedAsk(recordId) {
  return asksWithStatus(state.cohort?.asks).find(a => a.record_id === recordId) || null;
}

function askRowNote(el, html, kind = "info") {
  const card = el?.closest?.(".alch-asks-card");
  const note = card?.querySelector?.("[data-asks-row-note]");
  if (!note) return;
  note.hidden = false;
  note.dataset.kind = kind;
  note.innerHTML = html;
}

async function launchAskStatusUpdate(el, recordId, nextStatus) {
  const ask = findRenderedAsk(recordId);
  if (!ask) {
    askRowNote(el, `<span class="alch-onb-inline-tag">missing</span> ask record not found.`, "error");
    return;
  }
  const { authorSlug } = currentAskContext();
  if (authorSlug === "your-slug") {
    askRowNote(el, `<span class="alch-onb-inline-tag">profile</span> claim your profile before changing ask status.`, "error");
    return;
  }
  const path = askMarkdownPath(recordId);
  askRowNote(el, `<span class="alch-onb-inline-tag">preparing</span> building status update...`);
  const body = await fetchExistingBody(path);
  const overrides = { status: nextStatus };
  if (nextStatus === "claimed") overrides.claimed_by = authorSlug;
  if (nextStatus === "done") overrides.claimed_by = ask.claimed_by || authorSlug;
  const markdown = buildAskMarkdown(ask, overrides, body);
  let copied = false;
  try {
    if (window.api?.clipboardWrite) {
      const res = await window.api.clipboardWrite(markdown);
      copied = !res || res.ok !== false;
    }
  } catch {}
  const launched = await launchPRFlow({ kind: "edit", path, value: markdown });
  if (!launched.ok) {
    askRowNote(el, `<span class="alch-onb-inline-tag">fork first</span> create your fork, then click again.`, "error");
    return;
  }
  askRowNote(el, `
    <span class="alch-onb-inline-tag">github opened</span>
    ${copied
      ? `replacement markdown copied — paste it over the file in github, then commit the ${escHtml(nextStatus)} update and create the PR.`
      : `copy the replacement markdown below, paste it over the file in github, then commit the ${escHtml(nextStatus)} update and create the PR.`}
    <a class="alch-onb-inline-link" href="${escAttr(launched.url)}" data-external>reopen</a>
    <details class="alch-asks-compose-preview">
      <summary>replacement markdown</summary>
      <pre class="alch-onb-inline-patch">${escHtml(markdown)}</pre>
    </details>
  `, "success");
  const note = el?.closest?.(".alch-asks-card")?.querySelector?.("[data-asks-row-note]");
  if (note) wireExternalLinks(note);
}

async function loadAskContextForCard(card, recordId) {
  const panel = card?.querySelector?.("[data-asks-context-panel]");
  if (!panel || !recordId) return null;
  if (panel.dataset.loaded === "1") {
    panel.hidden = false;
    return panel;
  }
  panel.hidden = false;
  panel.dataset.loaded = "0";
  panel.innerHTML = `<span class="alch-onb-inline-tag">loading</span> reading context...`;
  const body = cleanAskBody(await fetchExistingBody(askMarkdownPath(recordId)));
  panel.dataset.loaded = "1";
  panel.innerHTML = body
    ? `<pre>${escHtml(body)}</pre>`
    : `<span class="alch-onb-inline-tag">context</span> no extra context in this ask.`;
  return panel;
}

// Compose-form submit. Reads verb/topic/skill_areas, derives a stable
// slug for the file (author + date + 4-char topic hash to dedupe same-day
// asks from the same author), builds the full ask markdown, and opens
// github's /new/ URL with that content prefilled.
async function submitAskCompose(form) {
  const authorSlug = form.dataset.authorSlug || "your-slug";
  const todayIso   = form.dataset.today || new Date().toISOString().slice(0, 10);
  const verb       = String(form.elements.verb?.value || "🤝 pair on").trim();
  const topic      = String(form.elements.topic?.value || "").trim();
  const tagsRaw    = String(form.elements.skill_areas?.value || "").trim();
  const bodyRaw    = String(form.elements.body?.value || "").trim();
  const result     = form.querySelector(".alch-asks-compose-result");
  if (!result) return;

  if (!topic) {
    result.hidden = false;
    result.innerHTML = `<p class="alch-onb-inline-line alch-onb-inline-err">type a topic first.</p>`;
    return;
  }
  const skillAreas = tagsRaw.length
    ? tagsRaw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    : [];

  // 4-char hash of the topic so two asks the same day from the same author
  // don't collide on filename. Deterministic so re-submits land on the
  // same path (lets the user edit instead of duplicating if they reopen).
  let h = 2166136261 >>> 0;
  for (let i = 0; i < topic.length; i++) { h ^= topic.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  const hash = h.toString(36).slice(0, 4);
  const recordId = `${authorSlug}-${todayIso}-${hash}`;

  // Build the markdown body. quoteYaml + yamlScalar handle quoting + multiline.
  const tagsBlock = skillAreas.length
    ? "skill_areas:\n" + skillAreas.map(s => `  - ${quoteYaml(s)}`).join("\n")
    : "skill_areas: []";
  const bodyBlock = bodyRaw
    ? `\n${bodyRaw}\n`
    : "\n(optional body — extra context for the ask.)\n";
  const askMarkdown = `---
record_id: ${recordId}
record_type: ask
schema_version: 1
posted_at: ${todayIso}
author: ${authorSlug}
verb: ${quoteYaml(verb)}
topic: ${yamlScalar(topic, 2)}
${tagsBlock}
status: open
---${bodyBlock}`;
  const filename = `cohort-data/asks/${recordId}.md`;

  // Fork-aware launch. needs-fork pops a modal; ready opens the URL on
  // the user's fork (with the prefilled markdown) and we render the
  // preview panel below for confidence.
  const launched = await launchPRFlow({ kind: "new", path: filename, value: askMarkdown });
  if (!launched.ok) {
    result.hidden = false;
    result.innerHTML = `
      <p class="alch-onb-inline-line">
        <span class="alch-onb-inline-tag">fork first</span>
        once your fork exists, click submit again — your verb, topic, and tags are still in the form.
      </p>
    `;
    return;
  }
  const newUrl = launched.url;
  result.hidden = false;
  result.innerHTML = `
    <p class="alch-onb-inline-line">
      <span class="alch-onb-inline-tag">github opened</span>
      review the prefilled markdown, then <strong>commit new file</strong> → github walks you into a PR.
    </p>
    <details class="alch-asks-compose-preview">
      <summary>preview the file</summary>
      <pre class="alch-onb-inline-patch">${escHtml(askMarkdown)}</pre>
    </details>
    <div class="alch-onb-inline-row">
      <a class="alch-onb-inline-link" href="${escAttr(newUrl)}" data-external>reopen editor</a>
    </div>
  `;
  wireExternalLinks(result);
}

function wireAsks() {
  // Compose form: build the full markdown content from the form values
  // and open github's /new/ URL with that content prefilled.
  for (const form of state.canvas.querySelectorAll("form.alch-asks-compose")) {
    const verbInput = form.elements.verb;
    const composeDetails = form.querySelector("[data-asks-compose-details]");
    for (const b of form.querySelectorAll("[data-asks-verb]")) {
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (verbInput) verbInput.value = b.dataset.asksVerb || "";
        form.querySelectorAll("[data-asks-verb]").forEach((x) => {
          x.setAttribute("aria-pressed", x === b ? "true" : "false");
        });
        if (composeDetails) composeDetails.open = true;
        if (!String(form.elements.topic?.value || "").trim()) {
          requestAnimationFrame(() => form.elements.topic?.focus?.());
        }
      });
    }
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      submitAskCompose(form);
    });
    if (form.dataset.autofocus === "1") {
      requestAnimationFrame(() => form.elements.topic?.focus?.());
    }
  }
  for (const a of state.canvas.querySelectorAll(".alch-asks-action[data-asks-edit]")) {
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      const slug = a.dataset.asksEdit;
      await launchPRFlow({ kind: "edit", path: `cohort-data/asks/${slug}.md` });
    });
  }
  for (const b of state.canvas.querySelectorAll("[data-asks-claim]")) {
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      await launchAskStatusUpdate(b, b.dataset.asksClaim, "claimed");
    });
  }
  for (const b of state.canvas.querySelectorAll("[data-asks-done]")) {
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      await launchAskStatusUpdate(b, b.dataset.asksDone, "done");
    });
  }
  for (const row of state.canvas.querySelectorAll(".alch-asks-card[data-asks-record]")) {
    row.addEventListener("toggle", () => {
      if (row.open) loadAskContextForCard(row, row.dataset.asksRecord);
    });
  }
  // Inline jump to program → rules from the callout.
  for (const b of state.canvas.querySelectorAll(".alch-link-btn[data-go='program']")) {
    b.addEventListener("click", () => {
      state.mode = "program";
      state.programPage = b.dataset.programPage || null;
      try { localStorage.setItem(ALCHEMY_LS_KEY, "program"); } catch {}
      syncRailSelection();
      render();
    });
  }
  wireExternalLinks(state.canvas);
}

// ─── context vault ──────────────────────────────────────────────────
// Local article-index surface. Raw source notes stay on disk in
// user-controlled folders; main.js builds one private article index plus
// a metadata manifest under Electron userData/context-vault. The renderer
// can then promote selected, public-safe summaries into the existing
// GitHub PR flow for asks or program notes.

const CONTEXT_CONTENT_VERSION = "v0.0.3";
const CONTEXT_CONTENT_RELEASE_NOTE = "reader drafts · transcripts · copy bundle · local-date calendar";

function contextVaultAvailable() {
  return !!(window.api?.loadContextVault && window.api?.scanContextVault);
}

async function loadContextVault({ scan = false } = {}) {
  if (!contextVaultAvailable()) {
    state.contextVault.error = "Context Vault IPC is not available in this build.";
    state.contextVault.loaded = true;
    state.contextVault.loading = false;
    render();
    return;
  }
  state.contextVault.loading = true;
  state.contextVault.error = "";
  state.contextVault.message = scan ? "building article index..." : "loading article index...";
  render();
  try {
    const res = scan ? await window.api.scanContextVault() : await window.api.loadContextVault();
    if (!res?.ok) throw new Error(res?.error || "context vault request failed");
    state.contextVault.manifest = res.manifest || null;
    state.contextVault.roots = res.roots || res.manifest?.roots || [];
    state.contextVault.loaded = true;
    state.contextVault.loading = false;
    resolvePendingContextRawScript();
    state.contextVault.message = scan
      ? `article index updated: ${res.manifest?.totals?.articles || res.manifest?.totals?.sources || 0} article${(res.manifest?.totals?.articles || res.manifest?.totals?.sources) === 1 ? "" : "s"}`
      : "";
    if (!state.contextVault.selectedId && res.manifest?.sources?.length) {
      state.contextVault.selectedId = res.manifest.sources[0].id;
    }
  } catch (e) {
    state.contextVault.loaded = true;
    state.contextVault.loading = false;
    state.contextVault.error = e?.message || String(e);
  }
  render();
}

async function selectContextSource(sourceId) {
  if (!sourceId) return;
  if (state.contextVault.selectedId === sourceId) return;
  state.contextVault.mode = "articles";
  state.contextVault.selectedId = sourceId;
  state.contextVault.selectedText = "";
  state.contextVault.selectedTruncated = false;
  const selected = contextSourceById(sourceId);
  const detail = state.canvas?.querySelector(".alch-cv-detail");
  if (state.mode === "context" && selected && detail) {
    for (const btn of state.canvas.querySelectorAll("[data-cv-source]")) {
      btn.classList.toggle("is-selected", btn.dataset.cvSource === sourceId);
    }
    detail.outerHTML = renderContextVaultDetail(selected);
    wireContextVaultDetailActions(state.canvas);
    return;
  }
  render();
}

function setContextVaultMode(mode) {
  const nextMode = mode === "raw" ? "raw" : "articles";
  if (state.contextVault.mode === nextMode) return;
  state.contextVault.mode = nextMode;
  renderContextVault();
  wireContextVault();
}

async function selectContextRawScript(sourceId) {
  if (!sourceId) return;
  if (state.contextVault.mode === "raw" && state.contextVault.selectedRawId === sourceId) return;
  state.contextVault.mode = "raw";
  state.contextVault.selectedRawId = sourceId;
  const selected = contextRawScriptById(sourceId);
  const detail = state.canvas?.querySelector(".alch-cv-detail");
  if (state.mode === "context" && selected && detail) {
    for (const btn of state.canvas.querySelectorAll("[data-cv-raw-source]")) {
      btn.classList.toggle("is-selected", btn.dataset.cvRawSource === sourceId);
    }
    detail.outerHTML = renderContextVaultRawDetail(selected);
    wireContextVaultDetailActions(state.canvas);
    loadContextRawScriptText(sourceId);
    return;
  }
  render();
}

function contextSourceById(id) {
  return findContextSourceById(state.contextVault.manifest, id);
}

function contextRawScriptById(id) {
  return findContextRawScriptById(state.contextVault.manifest, id);
}

function normalizeContextPath(pathValue) {
  return String(pathValue || "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .toLowerCase();
}

function contextPathBasename(pathValue) {
  const normalized = normalizeContextPath(pathValue);
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

function contextRawScriptByPath(pathValue) {
  const target = normalizeContextPath(pathValue);
  if (!target) return null;
  const targetBase = contextPathBasename(target);
  return (state.contextVault.manifest?.raw_scripts || []).find(source => {
    const sourcePath = normalizeContextPath(source.path || source.file || source.href || "");
    return sourcePath === target
      || sourcePath.endsWith(`/${target}`)
      || contextPathBasename(sourcePath) === targetBase;
  }) || null;
}

function resolvePendingContextRawScript() {
  const pending = state.contextVault.pendingRawPath;
  if (!pending || !state.contextVault.manifest) return null;
  const source = contextRawScriptByPath(pending);
  if (source) {
    state.contextVault.selectedRawId = source.id;
    state.contextVault.pendingRawPath = null;
  }
  return source;
}

function openCalendarTranscript(pathValue) {
  if (!pathValue) return;
  state.contextVault.mode = "raw";
  const source = contextRawScriptByPath(pathValue);
  if (source) {
    state.contextVault.selectedRawId = source.id;
    state.contextVault.pendingRawPath = null;
  } else {
    state.contextVault.selectedRawId = null;
    state.contextVault.pendingRawPath = pathValue;
  }
  state.mode = "context";
  try { localStorage.setItem(ALCHEMY_LS_KEY, "context"); } catch {}
  syncRailSelection();
  render();
}

async function loadContextRawScriptText(sourceId) {
  if (!sourceId || state.contextVault.rawTextById?.[sourceId]) return;
  if (!window.api?.readContextVaultSource) return;
  state.contextVault.rawLoadingId = sourceId;
  try {
    const res = await window.api.readContextVaultSource(sourceId);
    if (!res?.ok) throw new Error(res?.error || "transcript read failed");
    state.contextVault.rawTextById = {
      ...(state.contextVault.rawTextById || {}),
      [sourceId]: res.text || "",
    };
    state.contextVault.selectedTruncated = !!res.truncated;
  } catch (e) {
    state.contextVault.rawTextById = {
      ...(state.contextVault.rawTextById || {}),
      [sourceId]: `Could not load transcript: ${e?.message || String(e)}`,
    };
  } finally {
    if (state.contextVault.rawLoadingId === sourceId) state.contextVault.rawLoadingId = null;
  }
  if (state.mode === "context" && state.contextVault.mode === "raw" && state.contextVault.selectedRawId === sourceId) {
    const selected = contextRawScriptById(sourceId);
    const detail = state.canvas?.querySelector(".alch-cv-detail");
    if (selected && detail) {
      detail.outerHTML = renderContextVaultRawDetail(selected);
      wireContextVaultDetailActions(state.canvas);
    }
  }
}

function contextSlug(s, fallback = "context-note") {
  const base = String(s || fallback)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || fallback;
}

function contextMiniHash(s) {
  const h = Math.abs(hashStr(String(s || ""))).toString(36);
  return h.slice(0, 5).padStart(5, "0");
}

function contextSkillBlock(skillAreas) {
  const skills = (skillAreas || []).map(s => String(s).trim()).filter(Boolean);
  return skills.length
    ? "skill_areas:\n" + skills.map(s => `  - ${s}`).join("\n")
    : "skill_areas: []";
}

function contextAuthorSlug() {
  const me = state.profile?.user || {};
  const gh = String(me.github || "").toLowerCase();
  return me.record_id || (gh ? gh : "your-slug");
}

function contextSelectedDigest(source) {
  return String(source?.article_dek || source?.article_angle || source?.article_title || source?.article_id || "article draft")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 220);
}

function contextArticleTitle(source) {
  return source?.article_title || source?.article_id || "Untitled article";
}

function contextArticleSlug(source) {
  return source?.article_slug || contextSlug(contextArticleTitle(source), "article");
}

function contextArticleDek(source) {
  return source?.article_dek || source?.article_angle || "A private context-vault article candidate awaiting an editorial pass.";
}

function contextArticleSection(source) {
  return source?.article_section || "article candidate";
}

function contextArticleMeta(source) {
  const bits = [];
  if (source?.status) bits.push(String(source.status));
  if (source?.content_version) bits.push(String(source.content_version));
  const section = contextArticleSection(source);
  if (section) bits.push(section);
  return bits.join(" · ");
}

function contextArticleReader(source) {
  const title = contextArticleTitle(source);
  const angle = contextArticleDek(source);
  if (/memory, workflows, and social routing/i.test(title)) {
    return {
      kicker: "agent infrastructure",
      lede: "The hard part of agent software is no longer getting one impressive answer. The hard part is preserving useful work after the chat window closes.",
      sections: [
        ["Private sessions lose the plot", "A good agent session can contain decisions, partial research, tool traces, and useful taste. If that work stays trapped in a private scrollback, the next agent starts cold and the human has to re-explain the same context."],
        ["Workflows need memory and checkpoints", "Durable agent work needs named goals, resumable state, audit trails, and clear handoffs. Otherwise every long-running task becomes brittle: one timeout, one restart, or one missing file can erase the thread."],
        ["Routing is social, not just technical", "The next layer is deciding who or what should see the work. Some context belongs to the individual, some belongs to a team, and some should become public program knowledge. Shape Rotator should make those routing choices explicit."],
      ],
      takeaway: "The useful agent is not the one that talks the most. It is the one that remembers what matters, shows its work, and lets humans redirect it before private context becomes public output.",
    };
  }
  if (/privacy is not the product/i.test(title)) {
    return {
      kicker: "privacy and capability",
      lede: "Privacy infrastructure is only interesting when it lets someone do something they already wanted to do.",
      sections: [
        ["Privacy is a means, not the hook", "TEEs, local-first storage, and data sovereignty can sound abstract when they are sold as values alone. The product becomes legible when privacy unlocks a concrete workflow: safer personalization, delegated work on sensitive data, or collaboration without leaking the room."],
        ["Capability gives privacy a job", "A user does not wake up wanting remote attestation. They want an assistant that can use sensitive context without spraying it everywhere. They want private records to become useful without becoming exposed."],
        ["The product test is workflow pull", "The right question is not whether the stack is private. The right question is what new behavior becomes possible because the stack is private. If the answer is not a workflow people want, privacy stays infrastructure theater."],
      ],
      takeaway: "Privacy wins when it is attached to capability: do the thing better, with less exposure, and with enough control that users trust the system to keep doing it.",
    };
  }
  if (/verifiability is becoming ux/i.test(title)) {
    return {
      kicker: "verifiability ux",
      lede: "Verification is moving out of backend diagrams and into the user experience of AI infrastructure.",
      sections: [
        ["Trust primitives are becoming interface primitives", "Remote attestation, proofs, signatures, and deployable evidence used to sit behind the product. In AI infrastructure, users increasingly need to know what ran, where it ran, and whether the system can prove it."],
        ["Proof has to become legible", "A raw attestation quote is not UX. A useful interface turns verification into something people can act on: this model ran in this environment, this data stayed inside this boundary, this output came from this signed workflow."],
        ["The proof changes behavior", "When verification becomes visible, users can make better choices. They can decide whether to share context, delegate a task, accept an output, or escalate to a human. Verifiability becomes part of the control surface."],
      ],
      takeaway: "The next trust layer will not be a hidden badge. It will be a readable proof trail that helps users understand and steer AI systems.",
    };
  }
  return {
    kicker: contextArticleSection(source),
    lede: angle,
    sections: [
      ["Thesis", angle],
      ["What the article should make clear", "Turn the private context into public-safe claims, concrete examples, and a publish boundary that does not leak the room."],
    ],
    takeaway: "Use this as a reader-facing article draft, then revise against the private context before publishing.",
  };
}

function buildContextArticleMarkdown(source) {
  if (source?.article_full_md) return source.article_full_md;
  if (source?.article_body_md) return source.article_body_md;
  const title = contextArticleTitle(source);
  const reader = contextArticleReader(source);
  const lines = [
    `# ${title}`,
    "",
    reader.lede,
    "",
  ];
  for (const [heading, body] of reader.sections) {
    lines.push(`## ${heading}`, "", body, "");
  }
  lines.push("## Takeaway", "", reader.takeaway, "");
  return lines.join("\n");
}

function renderContextReaderHtml(source) {
  if (source?.article_body_md) {
    return `
      <article class="alch-cv-reader alch-cv-article-md">
        ${renderProgramMarkdown(source.article_body_md)}
      </article>
    `;
  }
  const title = contextArticleTitle(source);
  const reader = contextArticleReader(source);
  const sections = reader.sections.map(([heading, body]) => `
    <section class="alch-cv-reader-section">
      <h3>${escHtml(heading)}</h3>
      <p>${escHtml(body)}</p>
    </section>
  `).join("");
  return `
    <article class="alch-cv-reader">
      <p class="alch-cv-reader-kicker">${escHtml(reader.kicker)}</p>
      <h1>${escHtml(title)}</h1>
      <p class="alch-cv-reader-lede">${escHtml(reader.lede)}</p>
      ${sections}
      <section class="alch-cv-reader-section alch-cv-reader-takeaway">
        <h3>Takeaway</h3>
        <p>${escHtml(reader.takeaway)}</p>
      </section>
    </article>
  `;
}

function renderContextVaultDetail(selected) {
  const selectedMdFile = selected ? (selected.article_file || `${contextArticleSlug(selected)}.md`) : "article.md";
  return selected ? `
    <article class="alch-cv-detail">
      <header class="alch-cv-detail-head">
        <div>
          <span class="alch-cv-eyebrow">reader draft · markdown</span>
        </div>
        <button class="alch-cv-md-action" type="button" data-cv-copy-article="${escAttr(selected.id)}" title="copy ${escAttr(selectedMdFile)}">
          <span class="alch-cv-md-action-label">copy .md</span>
          <span class="alch-cv-md-action-file">${escHtml(selectedMdFile)}</span>
        </button>
      </header>
      ${renderContextReaderHtml(selected)}
      <div class="alch-cv-result" data-cv-result hidden></div>
    </article>
  ` : `
    <article class="alch-cv-detail alch-cv-empty-detail">
      <h3>no articles indexed yet</h3>
      <p>Refresh the private article index to load articles.</p>
    </article>
  `;
}

function contextRawScriptTitle(source) {
  return source?.title || source?.path?.split(/[\\/]/).pop()?.replace(/\.txt$/i, "") || "Untitled transcript";
}

function contextRawScriptMeta(source) {
  const bits = [];
  if (source?.date) bits.push(source.date);
  if (source?.line_count) bits.push(`${source.line_count} lines`);
  if (source?.review_status) bits.push(source.review_status.replace(/-/g, " "));
  if (source?.source_kind) bits.push(source.source_kind.replace(/-/g, " "));
  return bits.join(" · ");
}

function contextList(value) {
  if (Array.isArray(value)) return value.map(v => String(v || "").trim()).filter(Boolean);
  if (!value) return [];
  return String(value).split(",").map(v => v.trim()).filter(Boolean);
}

function contextTeamRecord(id) {
  return (state.cohort?.teams || []).find(team => team?.record_id === id) || null;
}

function contextPersonRecord(id) {
  return (state.cohort?.people || []).find(person => person?.record_id === id) || null;
}

function contextTeamKind(id) {
  const team = contextTeamRecord(id);
  return team?.kind === "project" ? "project" : "team";
}

function renderContextRecordChip({ kind, id, label }) {
  if (!id) return "";
  return `
    <button class="alch-cv-rel-chip" type="button"
            data-cv-record-kind="${escAttr(kind)}"
            data-cv-record-id="${escAttr(id)}">
      <span>${escHtml(kind)}</span>${escHtml(label || id)}
    </button>
  `;
}

function renderContextRawMap(source) {
  if (!source) return "";
  const teams = contextList(source.related_teams);
  const people = contextList(source.related_people);
  const calendar = contextList(source.calendar_matches);
  const utility = source.utility || "";
  const boundary = source.content_boundary || source.import_boundary || "";
  if (!teams.length && !people.length && !calendar.length && !utility && !boundary) return "";

  const teamChips = teams.map(id => {
    const team = contextTeamRecord(id);
    return renderContextRecordChip({
      kind: contextTeamKind(id),
      id,
      label: team?.name || id,
    });
  }).join("");
  const personChips = people.map(id => {
    const person = contextPersonRecord(id);
    return renderContextRecordChip({
      kind: "person",
      id,
      label: person?.name || id,
    });
  }).join("");
  const calendarTags = calendar.map(match => `<span class="alch-cv-rel-tag">${escHtml(match)}</span>`).join("");

  return `
    <section class="alch-cv-raw-map" aria-label="transcript review map">
      ${source.submit_recommendation ? `<p class="alch-cv-raw-map-status">${escHtml(source.submit_recommendation)}</p>` : ""}
      ${calendarTags ? `<div class="alch-cv-rel-row"><strong>calendar</strong><div>${calendarTags}</div></div>` : ""}
      ${teamChips ? `<div class="alch-cv-rel-row"><strong>teams</strong><div>${teamChips}</div></div>` : ""}
      ${personChips ? `<div class="alch-cv-rel-row"><strong>people</strong><div>${personChips}</div></div>` : ""}
      ${utility ? `<div class="alch-cv-rel-row"><strong>useful for</strong><p>${escHtml(utility)}</p></div>` : ""}
      ${boundary ? `<div class="alch-cv-rel-row"><strong>boundary</strong><p>${escHtml(boundary)}</p></div>` : ""}
    </section>
  `;
}

function renderContextVaultRawDetail(selected) {
  if (!selected) {
    return `
      <article class="alch-cv-detail alch-cv-empty-detail">
        <h3>no transcripts indexed yet</h3>
        <p>Refresh the context vault to load bundled and local transcripts.</p>
      </article>
    `;
  }
  const title = contextRawScriptTitle(selected);
  const text = state.contextVault.rawTextById?.[selected.id] || "";
  const loading = state.contextVault.rawLoadingId === selected.id && !text;
  const fallback = selected.excerpt || "Loading transcript...";
  const displayText = loading ? "Loading transcript..." : (text || fallback);
  return `
    <article class="alch-cv-detail alch-cv-raw-detail">
      <header class="alch-cv-detail-head">
        <div>
          <span class="alch-cv-eyebrow">transcript · txt</span>
        </div>
        <div class="alch-cv-detail-actions">
          <button class="alch-cv-md-action" type="button" data-cv-copy-raw-bundle title="copy all transcripts">
            <span class="alch-cv-md-action-label">copy all</span>
          </button>
          <button class="alch-cv-md-action" type="button" data-cv-copy-raw="${escAttr(selected.id)}" title="copy ${escAttr(title)}">
            <span class="alch-cv-md-action-label">copy .txt</span>
          </button>
        </div>
      </header>
      <article class="alch-cv-reader alch-cv-raw-reader">
        <p class="alch-cv-reader-kicker">${escHtml(contextRawScriptMeta(selected) || "source transcript")}</p>
        <h1>${escHtml(title)}</h1>
        ${renderContextRawMap(selected)}
      </article>
      <pre class="alch-cv-raw-text">${escHtml(displayText)}</pre>
      <div class="alch-cv-result" data-cv-result hidden></div>
    </article>
  `;
}

async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const res = await window.api?.clipboardWrite?.(text);
    return !!res?.ok;
  } catch {}
  return false;
}

function flashCopyButton(btn, ok = true) {
  if (!btn) return;
  const title = btn.querySelector?.(".link-card-title, .alch-cv-md-action-label");
  if (title) {
    const oldTitle = title.textContent;
    btn.dataset.state = ok ? "copied" : "failed";
    title.textContent = ok ? "copied" : "copy failed";
    setTimeout(() => {
      title.textContent = oldTitle;
      delete btn.dataset.state;
    }, 1200);
    return;
  }
  const old = btn.textContent;
  btn.textContent = ok ? "copied" : "copy failed";
  setTimeout(() => { btn.textContent = old; }, 1200);
}

function buildContextAskMarkdown(source) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const author = contextAuthorSlug();
  const title = contextArticleTitle(source);
  const topic = `Draft Shape Rotator article: ${title}`;
  const recordId = `${author}-${todayIso}-context-${contextMiniHash(source.id + topic)}`;
  return {
    path: `cohort-data/asks/${recordId}.md`,
    markdown: `---
record_id: ${recordId}
record_type: ask
schema_version: 1
posted_at: ${todayIso}
author: ${author}
verb: "🔬 brain on"
topic: ${yamlScalar(topic, 2)}
${contextSkillBlock(source.skill_areas)}
status: open
---

Context Vault article: ${source.article_id || source.corpus_id || "unindexed"}
Working title: ${title}
Drafting cue: ${contextSelectedDigest(source)}
Private inputs remain local; this ask is the public-safe coordination layer.
`,
  };
}

function buildContextProgramMarkdown(source) {
  const title = contextArticleTitle(source);
  const recordId = `context-${source.date || new Date().toISOString().slice(0, 10)}-${contextArticleSlug(source).slice(0, 40)}-${contextMiniHash(source.id)}`;
  const skills = (source.skill_areas || []).join(", ") || "none inferred";
  return {
    path: `cohort-data/program/${recordId}.md`,
    markdown: `---
record_id: ${recordId}
record_type: program_page
schema_version: 1
title: ${quoteYaml(title)}
order: 90
---

## context vault reference

- context vault article: ${source.article_id || source.corpus_id || "unindexed"}
- draft status: draft-candidate
- inferred skill areas: ${skills}
- editorial section: ${contextArticleSection(source)}

## article direction

${source.article_angle || contextArticleDek(source)}

## drafting boundary

- Private inputs stay hidden.
- Add public-safe synthesis before publishing.
- Do not paste private input text into this page.

## steward note

This page was drafted from Context Vault. Private inputs stay local; publish only cleaned program context, resource trails, or public-safe synthesis.
`,
  };
}

function renderContextVault() {
  const cv = state.contextVault;
  if (!cv.loaded && !cv.loading) {
    // Fire after the current render stack so the loading state can paint.
    setTimeout(() => loadContextVault({ scan: false }), 0);
  }
  const manifest = cv.manifest || null;
  const sources = manifest?.sources || [];
  const rawScripts = manifest?.raw_scripts || [];
  const mode = cv.mode === "raw" ? "raw" : "articles";
  const pendingRaw = resolvePendingContextRawScript();
  const selected = contextSourceById(cv.selectedId) || sources[0] || null;
  const selectedRaw = pendingRaw || contextRawScriptById(cv.selectedRawId) || rawScripts[0] || null;
  if (selected && !cv.selectedId) cv.selectedId = selected.id;
  if (selectedRaw && !cv.selectedRawId) cv.selectedRawId = selectedRaw.id;
  const sourceRows = mode === "raw"
    ? rawScripts.map(s => {
      const selectedCls = selectedRaw && selectedRaw.id === s.id ? " is-selected" : "";
      return `
        <button class="alch-cv-source alch-cv-transcript-source${selectedCls}" type="button" data-cv-raw-source="${escAttr(s.id)}">
          <strong>${escHtml(contextRawScriptTitle(s))}</strong>
          <span class="alch-cv-source-meta">${escHtml(contextRawScriptMeta(s))}</span>
        </button>
      `;
    }).join("")
    : sources.map(s => {
      const selectedCls = selected && selected.id === s.id ? " is-selected" : "";
      const title = contextArticleTitle(s);
      const meta = contextArticleMeta(s);
      return `
        <button class="alch-cv-source${selectedCls}" type="button" data-cv-source="${escAttr(s.id)}">
          <strong>${escHtml(title)}</strong>
          ${meta ? `<span class="alch-cv-source-meta">${escHtml(meta)}</span>` : ""}
        </button>
      `;
    }).join("");
  const detail = mode === "raw" ? renderContextVaultRawDetail(selectedRaw) : renderContextVaultDetail(selected);

  state.canvas.innerHTML = `
    <section class="alch-cv">
      <header class="alch-cv-head">
        <div>
          <p class="alch-cv-kicker">local context vault</p>
          <h2>context library</h2>
          <p>Reader-facing article drafts plus the transcripts they came from, bundled into the OS for local prompting.</p>
          <div class="alch-cv-release">
            <span class="alch-cv-release-version">content ${escHtml(CONTEXT_CONTENT_VERSION)}</span>
            <span class="alch-cv-release-note">${escHtml(CONTEXT_CONTENT_RELEASE_NOTE)}</span>
          </div>
        </div>
        <div class="alch-cv-head-actions">
          <button class="alch-feed-btn alch-cv-scan" type="button" ${cv.loading ? "disabled" : ""}>${cv.loading ? "refreshing..." : "refresh article index"}</button>
        </div>
      </header>
      ${cv.message ? `<p class="alch-cv-message">${escHtml(cv.message)}</p>` : ""}
      ${cv.error ? `<p class="alch-cv-error">${escHtml(cv.error)}</p>` : ""}
      <div class="alch-cv-layout">
        <aside class="alch-cv-sidebar">
          <div class="alch-cv-mode">
            <button class="${mode === "articles" ? "is-selected" : ""}" type="button" data-cv-mode="articles">articles <span>${sources.length}</span></button>
            <button class="${mode === "raw" ? "is-selected" : ""}" type="button" data-cv-mode="raw">transcripts <span>${rawScripts.length}</span></button>
          </div>
          <h3>${mode === "raw" ? "transcripts" : "articles"}</h3>
          <div class="alch-cv-sources">${sourceRows || `<p class="alch-cv-muted">refresh to load ${mode === "raw" ? "transcripts" : "articles"}.</p>`}</div>
        </aside>
        ${detail}
      </div>
    </section>
  `;
  if (mode === "raw" && selectedRaw && !cv.rawTextById?.[selectedRaw.id]) {
    setTimeout(() => loadContextRawScriptText(selectedRaw.id), 0);
  }
}

function wireContextVault() {
  const scan = state.canvas.querySelector(".alch-cv-scan");
  if (scan) {
    scan.addEventListener("click", () => loadContextVault({ scan: true }));
  }
  for (const btn of state.canvas.querySelectorAll("[data-cv-mode]")) {
    btn.addEventListener("click", () => setContextVaultMode(btn.dataset.cvMode));
  }
  for (const btn of state.canvas.querySelectorAll("[data-cv-source]")) {
    btn.addEventListener("click", () => selectContextSource(btn.dataset.cvSource));
  }
  for (const btn of state.canvas.querySelectorAll("[data-cv-raw-source]")) {
    btn.addEventListener("click", () => selectContextRawScript(btn.dataset.cvRawSource));
  }
  wireContextVaultDetailActions(state.canvas);
}

function wireContextVaultDetailActions(root = state.canvas) {
  if (!root) return;
  for (const btn of root.querySelectorAll("[data-cv-reveal-corpus]")) {
    btn.addEventListener("click", async () => {
      if (window.api?.revealContextVaultCorpus) await window.api.revealContextVaultCorpus();
    });
  }
  for (const btn of root.querySelectorAll("[data-cv-reveal-source]")) {
    btn.addEventListener("click", async () => {
      if (window.api?.revealContextVaultSource) await window.api.revealContextVaultSource(btn.dataset.cvRevealSource);
    });
  }
  for (const btn of root.querySelectorAll("[data-cv-record-id]")) {
    btn.addEventListener("click", () => {
      if (typeof window.__srwkOpenProfile !== "function") return;
      window.__srwkOpenProfile({
        kind: btn.dataset.cvRecordKind || "person",
        record_id: btn.dataset.cvRecordId,
        mode: "edit",
      });
    });
  }
  for (const btn of root.querySelectorAll("[data-cv-copy-article]")) {
    btn.addEventListener("click", async () => {
      const source = contextSourceById(btn.dataset.cvCopyArticle);
      if (!source) return;
      const markdown = buildContextArticleMarkdown(source);
      flashCopyButton(btn, await copyTextToClipboard(markdown));
    });
  }
  for (const btn of root.querySelectorAll("[data-cv-copy-raw]")) {
    btn.addEventListener("click", async () => {
      const sourceId = btn.dataset.cvCopyRaw;
      let text = state.contextVault.rawTextById?.[sourceId] || "";
      if (!text && window.api?.readContextVaultSource) {
        const res = await window.api.readContextVaultSource(sourceId);
        if (res?.ok) {
          text = res.text || "";
          state.contextVault.rawTextById = { ...(state.contextVault.rawTextById || {}), [sourceId]: text };
        }
      }
      flashCopyButton(btn, await copyTextToClipboard(text));
    });
  }
  for (const btn of root.querySelectorAll("[data-cv-copy-raw-bundle]")) {
    btn.addEventListener("click", async () => {
      let text = "";
      if (window.api?.readContextVaultRawBundle) {
        const res = await window.api.readContextVaultRawBundle();
        if (res?.ok) text = res.text || "";
      }
      flashCopyButton(btn, await copyTextToClipboard(text));
    });
  }
  for (const btn of root.querySelectorAll("[data-cv-promote]")) {
    btn.addEventListener("click", async () => {
      const source = contextSourceById(btn.dataset.cvSourceId);
      if (!source) return;
      const result = root.querySelector("[data-cv-result]");
      const draft = btn.dataset.cvPromote === "program"
        ? buildContextProgramMarkdown(source)
        : buildContextAskMarkdown(source);
      const launched = await launchPRFlow({ kind: "new", path: draft.path, value: draft.markdown });
      if (result) {
        result.hidden = false;
        result.innerHTML = launched.ok ? `
          <p class="alch-onb-inline-line">
            <span class="alch-onb-inline-tag">github opened</span>
            review the generated markdown before committing the PR.
          </p>
          <details class="alch-asks-compose-preview">
            <summary>preview draft</summary>
            <pre class="alch-onb-inline-patch">${escHtml(draft.markdown)}</pre>
          </details>
          <div class="alch-onb-inline-row"><a class="alch-onb-inline-link" href="${escAttr(launched.url)}" data-external>reopen editor</a></div>
        ` : `
          <p class="alch-onb-inline-line">
            <span class="alch-onb-inline-tag">fork first</span>
            once your fork exists, click the promote button again.
          </p>
        `;
        wireExternalLinks(result);
      }
    });
  }
}

// ─── topic atlas ────────────────────────────────────────────────────
// Force-directed bubble cluster of `skill_areas` tags across teams +
// people. Bubble size = number of cohort members carrying the tag.
// Adjacency = co-occurrence on the same record. Click bubble → reveal
// the teams + people that carry it.
//
// Layout: simple custom force iteration on canvas. ~25 nodes; no need
// for a real graph library. The deterministic seed-based init keeps
// the layout stable across renders.

// Deterministic seeded RNG so the layout is stable across renders.
function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t = (t + 0x6D2B79F5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function layoutAtlas(nodes, edges, w, h) {
  if (nodes.length === 0) return [];
  const rand = mulberry32(0xC0FFEE);
  // Bubble radius scales with sqrt(size); min/max clamped.
  const maxSize = Math.max(...nodes.map(n => n.size), 1);
  const rOf = (n) => Math.max(14, Math.min(56, 14 + 36 * Math.sqrt(n.size / maxSize)));
  const pts = nodes.map((n) => ({
    ...n,
    r: rOf(n),
    x: w / 2 + (rand() - 0.5) * w * 0.6,
    y: h / 2 + (rand() - 0.5) * h * 0.6,
    vx: 0, vy: 0,
  }));
  const idx = new Map(pts.map((p, i) => [p.tag, i]));

  // Run a fixed number of force iterations. O(n^2) repulsion + attraction
  // along edges + centering. n ≤ 25 so this is sub-millisecond.
  const ITERS = 240;
  for (let step = 0; step < ITERS; step++) {
    const alpha = 1 - step / ITERS;
    // Repulsion
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i], b = pts[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        const minD = a.r + b.r + 14;
        if (d2 < 0.0001) { dx = (rand() - 0.5); dy = (rand() - 0.5); d2 = 1; }
        const d = Math.sqrt(d2);
        const overlap = Math.max(0, minD - d);
        const force = (1500 / Math.max(d2, 100)) + overlap * 1.4;
        const fx = (dx / d) * force * alpha;
        const fy = (dy / d) * force * alpha;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
    }
    // Attraction along edges (weighted)
    for (const e of edges) {
      const ai = idx.get(e.a), bi = idx.get(e.b);
      if (ai == null || bi == null) continue;
      const a = pts[ai], b = pts[bi];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const target = (a.r + b.r) * 1.6;
      const stretch = d - target;
      const force = stretch * 0.012 * Math.min(e.weight, 4) * alpha;
      const fx = (dx / d) * force, fy = (dy / d) * force;
      a.vx += fx; a.vy += fy;
      b.vx -= fx; b.vy -= fy;
    }
    // Centering
    for (const p of pts) {
      p.vx += (w / 2 - p.x) * 0.005 * alpha;
      p.vy += (h / 2 - p.y) * 0.005 * alpha;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.82; p.vy *= 0.82;
      // Clamp to viewport.
      p.x = Math.max(p.r + 6, Math.min(w - p.r - 6, p.x));
      p.y = Math.max(p.r + 6, Math.min(h - p.r - 6, p.y));
    }
  }
  return pts;
}

function renderAtlas() {
  const { nodes, edges } = aggregateSkillAreas(state.cohort);
  const cohortIndex = buildCohortIndex(state.cohort);
  const teams = cohortIndex.teams;
  const people = cohortIndex.people;
  const totalTeams = teams.length;
  const totalPeople = people.length;
  const W = 880, H = 520;

  if (nodes.length === 0) {
    state.canvas.innerHTML = `
      <header class="alch-atlas-head">
        <h2 class="alch-atlas-title">atlas</h2>
        <p class="alch-atlas-sub">skill_areas tags across the cohort.</p>
      </header>
      <p class="alch-callout">no tagged records yet. add <code>skill_areas</code> to your team or person record via the profile editor; this view reads from the merged cohort surface.</p>
    `;
    return;
  }

  const laid = layoutAtlas(nodes, edges, W, H);
  const active = state.atlasFocus || null;
  const activeNode = active ? laid.find(n => n.tag === active) : null;
  // Edges with end points after layout, filtered to a sensible top set
  // (the strongest co-occurrences) so the canvas isn't a hairball.
  const TOP_EDGES = 24;
  const drawableEdges = edges
    .map(e => ({ ...e, _a: laid.find(p => p.tag === e.a), _b: laid.find(p => p.tag === e.b) }))
    .filter(e => e._a && e._b)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, TOP_EDGES);

  const edgeSvg = drawableEdges.map(e => {
    const dim = active && active !== e.a && active !== e.b ? 0.08 : 0.30;
    return `<line x1="${e._a.x.toFixed(1)}" y1="${e._a.y.toFixed(1)}" x2="${e._b.x.toFixed(1)}" y2="${e._b.y.toFixed(1)}" stroke="rgba(245,243,238,${dim})" stroke-width="${Math.min(2.5, 0.6 + e.weight * 0.3).toFixed(2)}" />`;
  }).join("");

  const nodeSvg = laid.map(n => {
    const dim = active ? (n.tag === active ? 1 : 0.32) : 1;
    const fill = n.tag === active ? "#8F220E" : "rgba(193,168,114,0.55)";
    const stroke = n.tag === active ? "#8F220E" : "rgba(245,243,238,0.55)";
    const label = n.tag.length > 16 ? n.tag.slice(0, 15) + "…" : n.tag;
    return `
      <g class="alch-atlas-node" data-atlas-tag="${escAttr(n.tag)}" opacity="${dim}" style="cursor:pointer;">
        <circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${n.r.toFixed(1)}" fill="${fill}" fill-opacity="0.18" stroke="${stroke}" stroke-width="1.2" />
        <text x="${n.x.toFixed(1)}" y="${(n.y + 3).toFixed(1)}" text-anchor="middle" font-family="var(--ed-mono, ui-monospace, monospace)" font-size="${Math.max(10, Math.min(13, n.r / 3.5)).toFixed(1)}" fill="rgba(245,243,238,0.92)" style="letter-spacing:0.04em;">${escHtml(label)}</text>
        <text x="${n.x.toFixed(1)}" y="${(n.y + n.r + 14).toFixed(1)}" text-anchor="middle" font-family="var(--ed-mono, ui-monospace, monospace)" font-size="9.5" fill="rgba(245,243,238,0.55)" style="letter-spacing:0.16em;">${n.size}</text>
      </g>
    `;
  }).join("");

  // Side panel — when a tag is focused, list its teams + people.
  let panel = "";
  if (activeNode) {
    const tList = (activeNode.teams || []).map(rid => {
      const t = cohortIndex.teamById.get(rid);
      return `<li class="alch-atlas-li" data-atlas-go-team="${escAttr(rid)}">${escHtml(t?.name || rid)}</li>`;
    }).join("");
    const pList = (activeNode.people || []).map(rid => {
      const p = cohortIndex.personById.get(rid);
      return `<li class="alch-atlas-li" data-atlas-go-person="${escAttr(rid)}">${escHtml(p?.name || rid)}</li>`;
    }).join("");
    panel = `
      <aside class="alch-atlas-panel">
        <header class="alch-atlas-panel-head">
          <h3 class="alch-atlas-panel-title">${escHtml(activeNode.tag)}</h3>
          <span class="alch-atlas-panel-count">${activeNode.size}</span>
          <button class="alch-atlas-panel-x" type="button" data-atlas-clear="1" aria-label="clear focus">×</button>
        </header>
        ${tList ? `<section class="alch-atlas-panel-section"><h4 class="alch-atlas-panel-h">teams (${activeNode.teams.length})</h4><ul class="alch-atlas-ul">${tList}</ul></section>` : ""}
        ${pList ? `<section class="alch-atlas-panel-section"><h4 class="alch-atlas-panel-h">people (${activeNode.people.length})</h4><ul class="alch-atlas-ul">${pList}</ul></section>` : ""}
      </aside>
    `;
  }

  state.canvas.innerHTML = `
    <header class="alch-atlas-head">
      <h2 class="alch-atlas-title">atlas</h2>
      <p class="alch-atlas-sub">${nodes.length} skill_areas tags · ${totalTeams} teams · ${totalPeople} people · bubble size = members carrying the tag · click a bubble to inspect</p>
    </header>
    <div class="alch-atlas-stage" data-active="${active ? "1" : "0"}">
      <svg class="alch-atlas-svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet">
        <g class="alch-atlas-edges">${edgeSvg}</g>
        <g class="alch-atlas-nodes">${nodeSvg}</g>
      </svg>
      ${panel}
    </div>
    <p class="alch-callout"><strong>atlas · v0.1</strong><br/>
    flat folksonomy of the cohort's controlled-vocab skill_areas. no proficiency, no ranking — just adjacency. populated from every team's + person's record. add a tag to your record via <button class="alch-link-btn" data-go="profile">profile</button> and it shows up here on the next build.</p>
  `;
}

function wireAtlas() {
  for (const g of state.canvas.querySelectorAll(".alch-atlas-node[data-atlas-tag]")) {
    g.addEventListener("click", () => {
      const tag = g.dataset.atlasTag;
      state.atlasFocus = (state.atlasFocus === tag) ? null : tag;
      render();
    });
  }
  const clr = state.canvas.querySelector("[data-atlas-clear]");
  if (clr) clr.addEventListener("click", () => { state.atlasFocus = null; render(); });
  for (const li of state.canvas.querySelectorAll("[data-atlas-go-team]")) {
    li.addEventListener("click", () => openDetail(li.dataset.atlasGoTeam));
  }
  for (const li of state.canvas.querySelectorAll("[data-atlas-go-person]")) {
    li.addEventListener("click", () => openDetail(li.dataset.atlasGoPerson));
  }
  for (const b of state.canvas.querySelectorAll(".alch-link-btn[data-go='profile']")) {
    b.addEventListener("click", () => {
      state.mode = "profile";
      try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
      syncRailSelection();
      render();
    });
  }
}

// ── Dossier export — multi-card PNG of all teams + projects ─────────
// Renders each team/project as a card with shape glyph, kind tag,
// focus, lead, and member count to a single offscreen canvas, then
// pipes through the same IPC PNG save flow.
async function exportDossier() {
  const cohortIndex = buildCohortIndex(state.cohort);
  const all = cohortIndex.teams.slice();
  const people = cohortIndex.people;
  if (all.length === 0) return;
  // Sort teams first by kind (team > project), then alpha.
  all.sort((a, b) => {
    const ak = (a.kind || "team") === "team" ? 0 : 1;
    const bk = (b.kind || "team") === "team" ? 0 : 1;
    if (ak !== bk) return ak - bk;
    return String(a.name).localeCompare(String(b.name));
  });

  // Group people by team id so each card can list members inline.
  const peopleByTeam = new Map(cohortIndex.primaryPeopleByTeam);
  // Sort each team's members: lead first, then alpha.
  for (const arr of peopleByTeam.values()) {
    arr.sort((a, b) => {
      const al = a.role === "lead" ? 0 : 1;
      const bl = b.role === "lead" ? 0 : 1;
      if (al !== bl) return al - bl;
      return String(a.name || a.record_id).localeCompare(String(b.name || b.record_id));
    });
  }

  // Layout: 3-column grid, card 380×260 + 24px gutter, plus header.
  const cols = 3;
  const cardW = 380;
  const cardH = 260;
  const gap = 24;
  const padL = 56;
  const padT = 140;     // header
  const padR = 56;
  const padB = 56;
  const rows = Math.ceil(all.length / cols);
  const W = padL + cols * cardW + (cols - 1) * gap + padR;
  const H = padT + rows * cardH + (rows - 1) * gap + padB;

  const cnv = document.createElement("canvas");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  cnv.width  = Math.round(W * dpr);
  cnv.height = Math.round(H * dpr);
  const ctx = cnv.getContext("2d");
  ctx.scale(dpr, dpr);

  // Background — same warm radial as the app.
  const bg = ctx.createRadialGradient(W / 2, -100, 100, W / 2, H / 2, Math.max(W, H));
  bg.addColorStop(0, "#17140f");
  bg.addColorStop(1, "#0a0908");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // ── Header ─────────────────────────────────────────────────────────
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillStyle = CAL_INK_1;
  ctx.font = `italic 44px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.globalAlpha = 0.96;
  ctx.fillText("cohort dossier", padL, 64);
  ctx.font = `400 13px "JetBrains Mono", "Berkeley Mono", ui-monospace, monospace`;
  ctx.globalAlpha = 0.55;
  const nTeams = all.filter(t => (t.kind || "team") === "team").length;
  const nProjects = all.filter(t => (t.kind || "team") === "project").length;
  ctx.fillText(`shape rotator · summer 2026 · ${nTeams} teams · ${nProjects} projects · ${people.length} individuals`,
               padL, 90);
  ctx.globalAlpha = 1;
  // Hairline rule under header
  ctx.strokeStyle = "rgba(245, 243, 238, 0.16)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT - 24 + 0.5);
  ctx.lineTo(W - padR, padT - 24 + 0.5);
  ctx.stroke();

  // ── Cards ──────────────────────────────────────────────────────────
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = padL + col * (cardW + gap);
    const y = padT + row * (cardH + gap);
    drawDossierCard(ctx, t, peopleByTeam.get(t.record_id) || [], x, y, cardW, cardH);
  }

  // Footer
  ctx.fillStyle = CAL_INK_3;
  ctx.globalAlpha = 0.55;
  ctx.font = `400 11px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = "right";
  ctx.fillText("generated by shape rotator os · " + new Date().toISOString().slice(0, 10),
               W - padR, H - 28);
  ctx.globalAlpha = 1;
  ctx.textAlign = "left";

  // Export through the same IPC path as the calendar — but pass a
  // distinct filename so the saved file isn't called "cohort-calendar".
  const dataUrl = cnv.toDataURL("image/png");
  const stamp = new Date().toISOString().slice(0, 10);
  if (window.api?.exportCalendar) {
    const r = await window.api.exportCalendar({
      format: "png",
      dataUrl,
      filename: `cohort-dossier-${stamp}`,
    });
    if (r?.ok) {
      const c = document.querySelector(".alch-callout");
      if (c) {
        const note = document.createElement("div");
        note.style.cssText = "margin-top:8px;color:#f5f3ee;opacity:0.85;font-family:var(--ed-mono);font-size:11px;letter-spacing:0.16em;text-transform:lowercase";
        note.textContent = `dossier saved → ${r.path}`;
        c.appendChild(note);
        setTimeout(() => { try { note.remove(); } catch {} }, 6000);
      }
    }
  } else {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = `cohort-dossier-${stamp}.png`;
    a.click();
  }
}

function drawDossierCard(ctx, team, members, x, y, w, h) {
  // Card background — slight vertical gradient
  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, "#15120e");
  grad.addColorStop(1, "#0e0c0a");
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);
  // Top hairline rule (matches the app's "border-top only" card style)
  ctx.strokeStyle = "rgba(245, 243, 238, 0.10)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y + 0.5);
  ctx.lineTo(x + w, y + 0.5);
  ctx.stroke();

  // ── Tag row: SHAPE-NN · KIND · DOMAIN ─────────────────────────────
  ctx.font = `500 9.5px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.55;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const tagParts = [
    String(team.record_id || "").toUpperCase(),
    String(team.kind || "team").toUpperCase(),
    String(team.domain || "—").toUpperCase(),
  ];
  // Pseudo letter-spacing
  let tx = x + 20;
  const tag = tagParts.join("  ·  ");
  for (const ch of tag) {
    ctx.fillText(ch, tx, y + 26);
    tx += ctx.measureText(ch).width + 1.2;
  }
  ctx.globalAlpha = 1;

  // ── Shape glyph (left) ─────────────────────────────────────────────
  const glyphSize = 88;
  const glyphX = x + 20;
  const glyphY = y + 42;
  drawShapeGlyph(ctx, team.shape, team.kind, team.record_id || team.name || "_",
                 glyphX, glyphY, glyphSize);

  // ── Name (right, large italic Iowan) ──────────────────────────────
  const textX = glyphX + glyphSize + 22;
  ctx.font = `italic 26px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.96;
  ctx.fillText(team.name || "—", textX, glyphY + 26);

  // ── Focus (italic, smaller) ────────────────────────────────────────
  if (team.focus) {
    ctx.font = `italic 13.5px "Iowan Old Style", "Hoefler Text", Georgia, serif`;
    ctx.globalAlpha = 0.78;
    wrapText(ctx, team.focus, textX, glyphY + 50, w - (textX - x) - 20, 18, 3);
  }
  ctx.globalAlpha = 1;

  // ── Meta strip (GEO · #CONTRIBUTORS) at bottom-left ───────────────
  // Two columns (LEAD column was retired with the lead field). The full
  // contributor list still renders below as the ROSTER row.
  const colGeoX        = x + 20;
  const colMembersX    = x + 220;
  const colGeoW        = (colMembersX - colGeoX) - 10;
  const colMembersW    = (x + w - 20) - colMembersX;

  ctx.font = `500 9.5px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.42;
  ctx.fillText("GEO",          colGeoX,     y + h - 70);
  ctx.fillText("CONTRIBUTORS", colMembersX, y + h - 70);
  ctx.globalAlpha = 0.88;
  ctx.font = `500 12px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillText(truncateText(ctx, team.geo || "—", colGeoW), colGeoX, y + h - 52);
  ctx.fillText(truncateText(ctx, String(members.length || team.members_count || 0), colMembersW), colMembersX, y + h - 52);

  // ── Member chips ───────────────────────────────────────────────────
  if (members.length) {
    ctx.font = `400 10px "JetBrains Mono", ui-monospace, monospace`;
    ctx.fillStyle = CAL_INK_1;
    ctx.globalAlpha = 0.42;
    ctx.fillText("ROSTER", x + 20, y + h - 28);
    ctx.globalAlpha = 0.85;
    ctx.font = `italic 12px "Iowan Old Style", Georgia, serif`;
    const rosterX = x + 70;
    const rosterW = (x + w - 20) - rosterX;
    const names = members.slice(0, 5).map(m => m.name || m.record_id).join("  ·  ");
    const suffix = members.length > 5 ? `  · +${members.length - 5}` : "";
    ctx.fillText(truncateText(ctx, names + suffix, rosterW), rosterX, y + h - 28);
  }
  ctx.globalAlpha = 1;
}

function drawShapeGlyph(ctx, shapeKey, kind, seed, x, y, size) {
  const cx = x + size / 2;
  const cy = y + size / 2;
  const r = size * 0.42;
  const colors = personColors(seed);
  const c1 = hsl(colors.hue, 0.70, 0.55, 1);
  const c2 = hsl(colors.hue2, 0.72, 0.60, 1);

  // Soft gradient backdrop (square card behind the silhouette)
  ctx.fillStyle = "rgba(245, 243, 238, 0.02)";
  ctx.fillRect(x, y, size, size);

  // Silhouette path per shape key. Kind=project gets stitched stroke;
  // person doesn't apply here (dossier is teams + projects only).
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  ctx.beginPath();
  switch (shapeKey) {
    case "torus":
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      break;
    case "scaffold":
      ctx.rect(cx - r * 0.82, cy - r * 0.82, r * 1.64, r * 1.64);
      break;
    case "hex": {
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        const px = cx + Math.cos(a) * r;
        const py = cy + Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case "prism":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.866, cy + r * 0.5);
      ctx.lineTo(cx - r * 0.866, cy + r * 0.5);
      ctx.closePath();
      break;
    case "meridian":
      ctx.arc(cx, cy, r, Math.PI, 0, false);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    case "plate":
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r, cy);
      ctx.closePath();
      break;
    default:
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  // Stroke twice: thick halo in c2, sharp in c1.
  if (kind === "project") ctx.setLineDash([4, 3]);
  ctx.strokeStyle = c2;
  ctx.globalAlpha = 0.35;
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = c1;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
  // Inner dot
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.15, 0, Math.PI * 2);
  ctx.fillStyle = c2;
  ctx.fill();
}

function wrapText(ctx, text, x, y, maxW, lineH, maxLines) {
  const words = String(text).split(/\s+/);
  let line = "";
  let lines = 0;
  for (let n = 0; n < words.length; n++) {
    const test = line ? line + " " + words[n] : words[n];
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, y + lines * lineH);
      lines++;
      if (lines >= maxLines) {
        ctx.fillText("…", x + ctx.measureText(line).width + 2, y + (lines - 1) * lineH);
        return;
      }
      line = words[n];
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, y + lines * lineH);
}

function truncateText(ctx, text, maxW) {
  const s = String(text);
  if (ctx.measureText(s).width <= maxW) return s;
  const ell = "…";
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + ell).width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, lo) + ell;
}

async function exportCalendar(format) {
  const cnv = document.getElementById("cal-canvas");
  if (!cnv) return;
  if (format === "png") {
    // Snapshot the canvas as PNG. Routed through Electron IPC so we get
    // a native save dialog instead of a browser blob download.
    const dataUrl = cnv.toDataURL("image/png");
    if (window.api?.exportCalendar) {
      const r = await window.api.exportCalendar({ format: "png", dataUrl });
      announceExport(r);
    } else {
      // Fallback for non-Electron contexts: trigger a download link.
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = `cohort-calendar-${new Date().toISOString().slice(0,10)}.png`;
      a.click();
    }
  } else if (format === "pdf") {
    // For PDF we ask the main process to embed the canvas image into a
    // single-page PDF at the canvas's pixel dimensions. printToPDF would
    // capture the WHOLE app chrome which is not what we want.
    const dataUrl = cnv.toDataURL("image/png");
    if (window.api?.exportCalendar) {
      const r = await window.api.exportCalendar({ format: "pdf", dataUrl, w: cnv.width, h: cnv.height });
      announceExport(r);
    }
  }
}
function announceExport(r) {
  if (!r) return;
  if (r.ok) {
    // Toast-style transient confirmation using the existing callout.
    const c = document.querySelector(".alch-callout");
    if (c) {
      const note = document.createElement("div");
      note.style.cssText = "margin-top:8px;color:#f5f3ee;opacity:0.85;font-family:var(--ed-mono);font-size:11px;letter-spacing:0.16em;text-transform:lowercase";
      note.textContent = `saved → ${r.path}`;
      c.appendChild(note);
      setTimeout(() => { try { note.remove(); } catch {} }, 6000);
    }
  } else if (r.reason !== "cancelled") {
    console.warn("[calendar] export failed:", r);
  }
}

// ─── detail page (full-canvas team / project profile) ────────────────
// Replaces the side drawer for a roomier read. Same data, more space:
// hero (shape glyph + name + kind), about, credentials, links, members,
// synergy clusters. Entered by clicking a card; back button returns to
// the previous mode (typically shapes).
function renderDetail(recordId) {
  const cohortIndex = buildCohortIndex(state.cohort);
  const team = cohortIndex.teamById.get(recordId);
  if (team) return renderTeamDetail(team);
  const person = cohortIndex.personById.get(recordId);
  if (person) return renderPersonDetail(person);
  // Record vanished (e.g. cohort republished, slug changed). Bail out
  // back to the grid rather than showing an empty page.
  closeDetail();
}

function renderTeamDetail(team) {
  const cohortIndex = buildCohortIndex(state.cohort);
  const recordId = team.record_id;
  const s = shapeForTeam(team);
  const kind = teamKind(team);
  const m = Number(team.members_count) || 0;
  const memberClusters = cohortIndex.clustersByTeam.get(recordId) || [];
  // People whose `team` field points at this record. For projects this
  // surfaces who's working on it; for teams, the roster.
  const teamPeople = cohortIndex.primaryPeopleByTeam.get(recordId) || [];

  const linksRow = renderDetailLinks(team.links || {});
  const editUrl = buildEditPRUrl({ recordType: "team", recordId });

  // ── Cohort Plate framing ──
  const j = journeyFor(team);
  const tier = tierForStage(j.stage);
  const allTeams = cohortIndex.teams;
  const idx = allTeams.findIndex(t => t.record_id === recordId) + 1;
  const idxStr = `${String(Math.max(1, idx)).padStart(3, "0")}/${String(allTeams.length).padStart(3, "0")}`;
  // taxonomy "class line" — domain as class, shape as order.
  const klass = (domainLabel(team.domain) || "—").toLowerCase();
  const order = (s ? s.name : (team.shape || "—")).toLowerCase();
  // cohort phase (m1/m2/m3) from the current program week.
  let phase = "";
  try { const w = calendarCurrentWeekIdx() + 1; phase = w <= 4 ? "m1" : w <= 9 ? "m2" : "m3"; } catch {}

  state.canvas.innerHTML = `
    <header class="alch-detail-bar">
      <button class="alch-detail-back" type="button" id="alch-detail-back" aria-label="back to grid">
        <span aria-hidden="true">←</span>
        <span>back</span>
      </button>
      <div class="alch-detail-bar-tag">
        <span>${escHtml(team.record_id.toUpperCase())}</span>
        <span class="ct-sep">·</span>
        <span class="ct-kind ct-kind-${escHtml(kind)}">${escHtml(kind)}</span>
        ${team.is_mentor ? `<span class="ct-sep">·</span><span>mentor</span>` : ""}
      </div>
      <a href="${escHtml(editUrl)}" data-external class="alch-detail-edit" title="edit this record on github">edit on github →</a>
    </header>

    <article class="cohort-plate is-revealing" data-tier="${escAttr(tier.key)}" data-kind="${escAttr(kind)}" id="cohort-plate">
      <div class="plate-foil" aria-hidden="true"></div>
      <div class="plate-scan" aria-hidden="true"></div>

      <div class="plate-band">
        <span class="pb-desig">${escHtml(team.name)}</span>
        <span class="pb-meta">designation · ${escHtml(kind)} · idx ${escHtml(idxStr)}${phase ? ` · cohort ${escHtml(phase)}` : ""}</span>
        <span class="pb-tier" data-tier="${escAttr(tier.key)}">tier · ${escHtml(tier.name)}</span>
      </div>
      <div class="plate-class">class: ${escHtml(klass)} <span class="pc-sep">//</span> order: ${escHtml(order)}${team.is_mentor ? ` <span class="pc-sep">//</span> mentor` : ""}</div>

      <section class="alch-detail-hero plate-hero">
        <div class="alch-detail-shape">${s ? `<canvas data-shape-fam="${s.fam}" data-shape-kind="${escAttr(teamKind(team))}" data-shape-seed="${escAttr(team.record_id)}"></canvas>` : ""}</div>
        <div class="alch-detail-hero-text">
          <h2 class="alch-detail-name">${escHtml(team.name)}</h2>
          <p class="alch-detail-focus">${escHtml(team.focus || "—")}</p>
          <div class="alch-detail-meta">
            <span><span class="adm-k">domain</span> ${escHtml(domainLabel(team.domain))}</span>
            <span class="ct-sep">·</span>
            <span><span class="adm-k">${kind === "project" ? "contributors" : "team"}</span> ${m} ${m === 1 ? "person" : "people"}</span>
            <span class="ct-sep">·</span>
            <span><span class="adm-k">geo</span> ${escHtml(team.geo || "—")}</span>
          </div>
        </div>
        <div class="plate-grade-stamp" data-tier="${escAttr(tier.key)}" aria-hidden="true">${escHtml(tier.name)}</div>
      </section>

      <div class="alch-detail-grid">
        <section class="alch-detail-section">
          <h3 class="alch-detail-h">about</h3>
          <div class="alch-detail-row"><span class="adr-k">contributors</span><span class="adr-v">${teamPeople.length} ${teamPeople.length === 1 ? "person" : "people"}</span></div>
          ${team.traction ? `<div class="alch-detail-row"><span class="adr-k">traction</span><span class="adr-v">${escHtml(team.traction)}</span></div>` : ""}
        </section>

        <section class="alch-detail-section">
          <h3 class="alch-detail-h">pmf · journey</h3>
          ${journeyDetailSection(team)}
        </section>

        ${(team.paper_basis || team.hackathon_note) ? `
          <section class="alch-detail-section">
            <h3 class="alch-detail-h">trophies</h3>
            <div class="plate-trophies">
              ${team.hackathon_note ? `<span class="plate-trophy trophy-rare"><span class="ptr-mark">★</span><span class="ptr-body"><span class="ptr-grade">rare</span><span class="ptr-name">${escHtml(team.hackathon_note)}</span></span></span>` : ""}
              ${team.paper_basis ? `<span class="plate-trophy trophy-notable"><span class="ptr-mark">◆</span><span class="ptr-body"><span class="ptr-grade">notable</span><span class="ptr-name">${escHtml(team.paper_basis)}</span></span></span>` : ""}
            </div>
          </section>
        ` : ""}

        <section class="alch-detail-section">
          <h3 class="alch-detail-h">links</h3>
          ${linksRow}
        </section>

        ${teamPeople.length ? `
          <section class="alch-detail-section">
            <h3 class="alch-detail-h">${kind === "project" ? "contributors" : "members"} <span class="alch-profile-h-aux">— ${teamPeople.length}</span></h3>
            <ul class="alch-detail-people">
              ${teamPeople.map(p => `
                <li class="alch-detail-person is-clickable" data-person="${escHtml(p.record_id)}" tabindex="0" role="button" aria-label="open ${escHtml(p.name || p.record_id)}">
                  <span class="adp-name">${escHtml(p.name || p.record_id)}</span>
                  ${p.role ? `<span class="adp-role">${escHtml(p.role)}</span>` : ""}
                </li>
              `).join("")}
            </ul>
          </section>
        ` : ""}

        ${memberClusters.length ? `
          <section class="alch-detail-section">
            <h3 class="alch-detail-h">guild <span class="alch-profile-h-aux">— synergy clusters</span></h3>
            <div class="plate-guild">
              ${memberClusters.map(cl => `<span class="guild-tag">${escHtml(cl.label)}</span>`).join("")}
            </div>
          </section>
        ` : ""}
      </div>
    </article>
  `;

  // Wire interactions.
  state.canvas.querySelector("#alch-detail-back")?.addEventListener("click", closeDetail);
  wirePersonLinks(state.canvas);
  wireExternalLinks(state.canvas);
  wirePlateFoil(state.canvas.querySelector(".cohort-plate"));
}

// Cursor-tracked foil glint: update --mx/--my (0..100%) as the pointer
// moves over the plate; CSS positions a faint oxide sheen there. Settles
// flat on leave. The one-shot reveal (scan sweep + grade stamp) is pure
// CSS, triggered by the .is-revealing class on mount.
function wirePlateFoil(plate) {
  if (!plate) return;
  plate.addEventListener("pointermove", (e) => {
    const r = plate.getBoundingClientRect();
    plate.style.setProperty("--mx", `${(((e.clientX - r.left) / r.width) * 100).toFixed(1)}%`);
    plate.style.setProperty("--my", `${(((e.clientY - r.top) / r.height) * 100).toFixed(1)}%`);
    plate.classList.add("is-foil");
  });
  plate.addEventListener("pointerleave", () => plate.classList.remove("is-foil"));
  // Drop the reveal class once the animation has played so it doesn't
  // re-run on incidental reflows.
  setTimeout(() => plate.classList.remove("is-revealing"), 1400);
}

function renderPersonDetail(person) {
  const cohortIndex = buildCohortIndex(state.cohort);
  const recordId = person.record_id;
  const fam = Math.abs(hashStr(recordId || "_")) % 6;
  const team = cohortIndex.teamForPerson(person);
  const secondary = (Array.isArray(person.secondary_teams) ? person.secondary_teams : [])
    .map(id => cohortIndex.teamById.get(id))
    .filter(Boolean);
  const linksRow = renderDetailLinks(person.links || {});
  const editUrl = buildEditPRUrl({ recordType: "person", recordId });
  const datesLine = (person.dates_start || person.dates_end)
    ? `${escHtml(person.dates_start || "—")} → ${escHtml(person.dates_end || "—")}`
    : "—";
  const absences = Array.isArray(person.absences) ? person.absences : [];

  state.canvas.innerHTML = `
    <header class="alch-detail-bar">
      <button class="alch-detail-back" type="button" id="alch-detail-back" aria-label="back to grid">
        <span aria-hidden="true">←</span>
        <span>back</span>
      </button>
      <div class="alch-detail-bar-tag">
        <span>${escHtml(recordId.toUpperCase())}</span>
        <span class="ct-sep">·</span>
        <span class="ct-kind ct-kind-person">individual</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(domainLabel(person.domain))}</span>
      </div>
      <a href="${escHtml(editUrl)}" data-external class="alch-detail-edit" title="edit this record on github">edit on github →</a>
    </header>

    <section class="alch-detail-hero">
      <div class="alch-detail-shape"><canvas data-shape-fam="${fam}" data-shape-kind="person" data-shape-seed="${escAttr(recordId)}"></canvas></div>
      <div class="alch-detail-hero-text">
        <h2 class="alch-detail-name">${escHtml(person.name || recordId)}</h2>
        <p class="alch-detail-focus">${escHtml(person.role || "—")}</p>
        <div class="alch-detail-meta">
          <span><span class="adm-k">team</span> ${team
            ? `<button type="button" class="alch-card-member" data-person="${escHtml(team.record_id)}">${escHtml(team.name)}</button>`
            : "—"}</span>
          <span class="ct-sep">·</span>
          <span><span class="adm-k">domain</span> ${escHtml(domainLabel(person.domain))}</span>
          <span class="ct-sep">·</span>
          <span><span class="adm-k">geo</span> ${escHtml(person.geo || "—")}</span>
        </div>
      </div>
    </section>

    <div class="alch-detail-grid">
      <section class="alch-detail-section">
        <h3 class="alch-detail-h">window</h3>
        <div class="alch-detail-row"><span class="adr-k">dates</span><span class="adr-v">${datesLine}</span></div>
        ${absences.length ? `
          <div class="alch-detail-row"><span class="adr-k">absences</span><span class="adr-v">${absences.map(a =>
            `${escHtml(a.start || "—")} → ${escHtml(a.end || "—")}${a.note ? ` <span style="opacity:0.55">(${escHtml(a.note)})</span>` : ""}`
          ).join("<br/>")}</span></div>
        ` : ""}
      </section>

      ${secondary.length ? `
        <section class="alch-detail-section">
          <h3 class="alch-detail-h">also contributes to</h3>
          <ul class="alch-detail-people">
            ${secondary.map(t => `
              <li class="alch-detail-person is-clickable" data-person="${escHtml(t.record_id)}" tabindex="0" role="button" aria-label="open ${escHtml(t.name)}">
                <span class="adp-name">${escHtml(t.name)}</span>
                <span class="adp-role">${escHtml(teamKind(t))}</span>
              </li>
            `).join("")}
          </ul>
        </section>
      ` : ""}

      ${person.dietary_restrictions ? `
        <section class="alch-detail-section">
          <h3 class="alch-detail-h">dietary</h3>
          <div class="alch-detail-row"><span class="adr-v">${escHtml(person.dietary_restrictions)}</span></div>
        </section>
      ` : ""}

      <section class="alch-detail-section">
        <h3 class="alch-detail-h">links</h3>
        ${linksRow}
      </section>
    </div>
  `;

  state.canvas.querySelector("#alch-detail-back")?.addEventListener("click", closeDetail);
  wirePersonLinks(state.canvas);
  wireExternalLinks(state.canvas);
}

function wirePersonLinks(root) {
  // Member chips on team cards / detail and the "team" pill on person
  // detail share the same hook: data-person="<record_id>" → openDetail.
  // stopPropagation so clicks inside a card don't also fire the card.
  const handler = (e) => {
    const id = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.person) || "";
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    openDetail(id);
  };
  for (const el of root.querySelectorAll("[data-person]")) {
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") handler(e);
    });
  }
}

function renderDetailLinks(L) {
  const LINK_LABELS = {
    website: "website", demo: "demo", deck: "deck", repo: "repo",
    article: "article", slides: "slides", alt: "alt site",
    linkedin: "linkedin",
  };
  const rows = [];
  if (L.repo && GH_REPO_RE.test(String(L.repo))) {
    rows.push(`<div class="alch-detail-row"><span class="adr-k">repo</span><span class="adr-v"><a href="https://github.com/${escHtml(L.repo)}" data-external class="alch-card-repo-link">${escHtml(L.repo)}</a></span></div>`);
  }
  if (L.github) {
    const gh = String(L.github);
    const url = normalizeLinkHref("github", gh);
    rows.push(`<div class="alch-detail-row"><span class="adr-k">github</span><span class="adr-v"><a href="${escAttr(url)}" data-external>${escHtml(gh)}</a></span></div>`);
  }
  if (L.x) {
    const handle = String(L.x).replace(/^@/, "");
    rows.push(`<div class="alch-detail-row"><span class="adr-k">x</span><span class="adr-v"><a href="${escAttr(normalizeLinkHref("x", handle))}" data-external>@${escHtml(handle)}</a></span></div>`);
  }
  for (const k of Object.keys(L)) {
    if (k === "github" || k === "x" || k === "repo") continue;
    const v = L[k];
    if (!v) continue;
    const label = LINK_LABELS[k] || k;
    const display = (typeof v === "string") ? v.replace(/^https?:\/\//, "") : String(v);
    const href = normalizeLinkHref(k, v);
    if (href) {
      rows.push(`<div class="alch-detail-row"><span class="adr-k">${escHtml(label)}</span><span class="adr-v"><a href="${escAttr(href)}" data-external>${escHtml(display)}</a></span></div>`);
    } else {
      rows.push(`<div class="alch-detail-row"><span class="adr-k">${escHtml(label)}</span><span class="adr-v">${escHtml(display)}</span></div>`);
    }
  }
  if (rows.length === 0) rows.push(`<div class="alch-detail-row"><span class="adr-k">links</span><span class="adr-v" style="opacity:0.55">— not yet submitted</span></div>`);
  return rows.join("");
}

// ─── drawer (specimen detail) ────────────────────────────────────────
function openDrawer(recordId) {
  if (!state.cohort) return;
  const cohortIndex = buildCohortIndex(state.cohort);
  const team = cohortIndex.teamById.get(recordId);
  if (!team) return;

  const { backdrop, drawer, body } = ensureDrawer();
  const s = shapeForTeam(team);
  const dest = s ? SHAPE_BY_KEY[s.rotates_to] : null;
  const m = Number(team.members_count) || 0;

  // Find which clusters this team belongs to
  const memberClusters = cohortIndex.clustersByTeam.get(recordId) || [];

  // Render every available link key with a sensible label; github + x
  // get full URL prefixes, the rest are passed through.
  const LINK_LABELS = {
    website: "website", demo: "demo", deck: "deck", repo: "repo",
    article: "article", slides: "slides", alt: "alt site",
  };
  const linksRow = (() => {
    const rows = [];
    const L = team.links || {};
    if (L.github) {
      // Treat as github user/org if no slash; as path otherwise.
      const gh = String(L.github);
      const url = gh.startsWith("http") ? gh : `https://github.com/${gh}`;
      rows.push(`<div class="alch-drawer-row"><span class="dr-k">github</span><span class="dr-v"><a href="${escHtml(url)}" data-external>${escHtml(gh)}</a></span></div>`);
    }
    if (L.x) {
      const handle = String(L.x).replace(/^@/, "");
      rows.push(`<div class="alch-drawer-row"><span class="dr-k">x</span><span class="dr-v"><a href="https://x.com/${escHtml(handle)}" data-external>@${escHtml(handle)}</a></span></div>`);
    }
    for (const k of Object.keys(L)) {
      if (k === "github" || k === "x") continue;
      const v = L[k];
      if (!v) continue;
      const label = LINK_LABELS[k] || k;
      const display = (typeof v === "string") ? v.replace(/^https?:\/\//, "") : String(v);
      rows.push(`<div class="alch-drawer-row"><span class="dr-k">${escHtml(label)}</span><span class="dr-v"><a href="${escHtml(v)}" data-external>${escHtml(display)}</a></span></div>`);
    }
    if (rows.length === 0) rows.push(`<div class="alch-drawer-row"><span class="dr-k">links</span><span class="dr-v muted">— not yet submitted</span></div>`);
    return rows.join("");
  })();

  const tagBits = [
    `<span class="dt-id">${escHtml(team.record_id.toUpperCase())}</span>`,
    `<span>·</span>`,
    `<span>${escHtml(s ? s.name : domainLabel(team.domain))}</span>`,
    `<span>·</span>`,
    `<span>${escHtml(domainLabel(team.domain))}</span>`,
  ];
  if (team.is_mentor) {
    tagBits.push(`<span>·</span>`, `<span>mentor</span>`);
  }

  body.innerHTML = `
    <div class="alch-drawer-tag">${tagBits.join("")}</div>
    <div class="alch-drawer-name">${escHtml(team.name)}</div>
    <div class="alch-drawer-shape">${s ? shapeSvgByFam(s.fam, hashStr(team.record_id)) : ""}</div>
    <div class="alch-drawer-rule"></div>
    <section class="alch-drawer-section">
      <h4>about</h4>
      <div class="alch-drawer-row"><span class="dr-k">focus</span><span class="dr-v">${escHtml(team.focus || "—")}</span></div>
      <div class="alch-drawer-row"><span class="dr-k">team</span><span class="dr-v">${m} ${m === 1 ? "person" : "people"}</span></div>
      <div class="alch-drawer-row"><span class="dr-k">geo</span><span class="dr-v">${escHtml(team.geo || "—")}</span></div>
      ${team.traction ? `<div class="alch-drawer-row"><span class="dr-k">traction</span><span class="dr-v">${escHtml(team.traction)}</span></div>` : ""}
    </section>
    <section class="alch-drawer-section">
      <h4>pmf · journey</h4>
      ${journeyDetailSection(team)}
    </section>
    ${team.paper_basis || team.hackathon_note ? `
      <section class="alch-drawer-section">
        <h4>credentials</h4>
        ${team.paper_basis  ? `<div class="alch-drawer-row"><span class="dr-k">paper</span><span class="dr-v">${escHtml(team.paper_basis)}</span></div>`  : ""}
        ${team.hackathon_note ? `<div class="alch-drawer-row"><span class="dr-k">hackathon</span><span class="dr-v"><span style="color:var(--alchemy-oxide-bright)">★</span> ${escHtml(team.hackathon_note)}</span></div>` : ""}
      </section>
    ` : ""}
    <section class="alch-drawer-section">
      <h4>links</h4>
      ${linksRow}
    </section>
    ${memberClusters.length ? `
      <section class="alch-drawer-section">
        <h4>synergy clusters</h4>
        <div class="alch-drawer-clusters">
          ${memberClusters.map(cl => `
            <span class="alch-drawer-cluster" data-cluster="${escHtml(cl.record_id)}">${escHtml(cl.label)}</span>
          `).join("")}
        </div>
      </section>
    ` : ""}
  `;
  // Open external links via the Electron shell, not in-window.
  for (const a of body.querySelectorAll("a[data-external]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const url = a.getAttribute("href");
      if (url) try { window.api?.openExternal?.(url); } catch {}
    });
  }
  drawer.querySelector(".alch-drawer-tag-host")?.replaceChildren();
  // Open with a frame delay so the transition fires.
  requestAnimationFrame(() => {
    backdrop.classList.add("is-open");
    drawer.classList.add("is-open");
  });
}

function closeDrawer() {
  const backdrop = document.querySelector(".alch-drawer-backdrop");
  const drawer = document.querySelector(".alch-drawer");
  if (backdrop) backdrop.classList.remove("is-open");
  if (drawer) drawer.classList.remove("is-open");
}

let _drawerNodes = null;
function ensureDrawer() {
  if (_drawerNodes) return _drawerNodes;
  const backdrop = document.createElement("div");
  backdrop.className = "alch-drawer-backdrop";
  backdrop.addEventListener("click", closeDrawer);
  document.body.appendChild(backdrop);

  const drawer = document.createElement("aside");
  drawer.className = "alch-drawer";
  drawer.setAttribute("aria-label", "team detail");
  drawer.innerHTML = `
    <header class="alch-drawer-head">
      <div class="alch-drawer-tag-host"></div>
      <button class="alch-drawer-close" type="button" title="close (esc)">close</button>
    </header>
    <div class="alch-drawer-body"></div>
  `;
  drawer.querySelector(".alch-drawer-close").addEventListener("click", closeDrawer);
  document.body.appendChild(drawer);

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drawer.classList.contains("is-open")) closeDrawer();
  });

  _drawerNodes = { backdrop, drawer, body: drawer.querySelector(".alch-drawer-body") };
  return _drawerNodes;
}

// ─── profile (localStorage; cohort-data write-back is Phase 4) ───────
function defaultProfile() {
  return {
    // Local "me" preferences. Used to seed the person-edit form when
    // creating a new person record. Not the same as the published record.
    user: { team_id: null, name: "", github: "", website: "", x: "" },
    // Editor state for the team/project/person editor (UI-only, not published).
    // editMode flips between "add" (blank form → /new/ URL) and "edit"
    // (record picker → /edit/ URL + diff panel).
    editMode: "edit",                          // "add" | "edit"
    editKind: "team",                          // "team" | "project" | "person"
    editTargetId: null,                        // <slug>; null in add mode or before pick
  };
}
function loadProfile() {
  let raw = null;
  try { raw = localStorage.getItem(PROFILE_LS_KEY); } catch {}
  if (raw) {
    try {
      state.profile = { ...defaultProfile(), ...JSON.parse(raw) };
      // Drop legacy fields that no longer exist on the profile shape.
      // trackedRepos was the private feed-watch list; replaced by every
      // team's canonical links.repo in the cohort.surface bundle.
      delete state.profile.trackedRepos;
      // Migrate old state: editTargetId="_new_" (person) was the prior
      // way to signal a create flow; consolidate under editMode="add".
      if (state.profile.editTargetId === "_new_") {
        state.profile.editMode = "add";
        state.profile.editTargetId = null;
      }
      return;
    } catch {}
  }
  state.profile = defaultProfile();
}
function saveProfile() {
  try { localStorage.setItem(PROFILE_LS_KEY, JSON.stringify(state.profile)); } catch {}
}
function loadEventsCache() {
  let raw = null;
  try { raw = localStorage.getItem(EVENTS_LS_KEY); } catch {}
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        state.events = parsed.items;
        state.fetchedAt = Number(parsed.fetchedAt) || 0;
      }
    } catch {}
  }
}
function saveEventsCache() {
  try {
    localStorage.setItem(EVENTS_LS_KEY, JSON.stringify({
      fetchedAt: state.fetchedAt,
      items: state.events.slice(0, 200),  // cap cache
    }));
  } catch {}
}

// ─── github scraper ─────────────────────────────────────────────────
// Fetch /events for each tracked repo, normalize into feed items.
// Unauthenticated; the cohort fits within the 60-req/hr budget.
const GH_REPO_RE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

async function refreshFeed({ source = "auto", force = false } = {}) {
  // Kill-switch — see FEED_DISABLED at top of file. Short-circuits every
  // caller (mount kick, interval, mode-enter, the in-header refresh
  // button) so the github /events feed makes zero requests while off.
  if (FEED_DISABLED) return;
  if (state.isFetching) return;
  const fresh = Date.now() - state.fetchedAt < FEED_REFRESH_MS;
  if (fresh && !force && state.events.length > 0) {
    paintFeedMeta();
    return;
  }
  // Two source kinds:
  //   1. Team repos — every team's canonical `links.repo`. Captures
  //      shared activity (PRs, pushes, releases) under the team's name.
  //   2. Person github handles — `/users/<handle>/events/public`.
  //      Catches "big changes to PRs in individuals' repos" the user
  //      asked for. When a person's event lands on a non-cohort repo
  //      we still surface it with their handle in the actor slot.
  // Both deduped (repos by string, handles by lowercase).
  const teamRepos = [];
  const seenRepos = new Set();
  for (const t of state.cohort?.teams || []) {
    const repo = String(t?.links?.repo || "").trim();
    if (!GH_REPO_RE.test(repo) || seenRepos.has(repo)) continue;
    seenRepos.add(repo);
    teamRepos.push({ team_id: t.record_id, repo });
  }
  const userHandles = [];
  const seenHandles = new Set();
  for (const p of state.cohort?.people || []) {
    const gh = String(p?.links?.github || "").trim();
    if (!gh) continue;
    const lower = gh.toLowerCase();
    if (seenHandles.has(lower)) continue;
    seenHandles.add(lower);
    userHandles.push({ person_id: p.record_id, gh });
  }
  const totalTargets = teamRepos.length + userHandles.length;
  if (totalTargets === 0) { paintFeedMeta(); return; }

  state.isFetching = true;
  state.fetchProgress = { done: 0, total: totalTargets };
  // First-visit loading screen: shows progress as repos+users get hit.
  if (state.mode === "feed" && state.events.length === 0) {
    renderFeed();
    wireFeedInteractions();
  } else {
    paintFeedMeta(`fetching · ${totalTargets} sources · ${source}`);
  }

  const collected = [];
  const repoToTeam = new Map(teamRepos.map(({ repo, team_id }) => [repo.toLowerCase(), team_id]));

  const tick = () => {
    state.fetchProgress.done++;
    if (state.mode === "feed" && state.events.length === 0) {
      paintFeedLoadingProgress();
    } else {
      paintFeedMeta(`fetching · ${state.fetchProgress.done}/${totalTargets} · ${source}`);
    }
  };

  // Team repos first (most relevant signal).
  for (const { team_id, repo } of teamRepos) {
    try {
      const items = await fetchGithubRepoEvents(repo, team_id);
      collected.push(...items);
    } catch (e) {
      console.warn(`[alch.feed] github fetch ${repo}:`, e?.message || e);
    }
    tick();
  }
  // Then person events. Match the event's repo against cohort teams when
  // possible so the feed item still gets a team label; otherwise leave
  // team_id null and the renderer surfaces the actor + bare repo string.
  for (const { person_id, gh } of userHandles) {
    try {
      const items = await fetchGithubUserEvents(gh, repoToTeam, person_id);
      collected.push(...items);
    } catch (e) {
      console.warn(`[alch.feed] github user fetch ${gh}:`, e?.message || e);
    }
    tick();
  }

  // Merge with existing cache, dedupe by id, sort latest-first, cap.
  // Bumped cap 200 → 400 since two sources can overlap heavily.
  const byId = new Map();
  for (const it of [...collected, ...state.events]) {
    if (!byId.has(it.id)) byId.set(it.id, it);
  }
  state.events = Array.from(byId.values()).sort((a, b) => (b.at_ms || 0) - (a.at_ms || 0)).slice(0, 400);
  state.fetchedAt = Date.now();
  state.isFetching = false;
  state.fetchProgress = null;
  saveEventsCache();
  if (state.mode === "feed") {
    renderFeed();
    wireFeedInteractions();
  }
}

async function fetchGithubRepoEvents(repo, team_id) {
  // per_page maxes at 100 for the events endpoint; the API only retains
  // ~300 events / 90 days per repo regardless, so this gives the best
  // back-fill we can get without authentication.
  const url = `https://api.github.com/repos/${repo}/events?per_page=100`;
  const r = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) return [];
    throw new Error(`HTTP ${r.status}`);
  }
  const evs = await r.json();
  if (!Array.isArray(evs)) return [];
  return evs.map(ev => normalizeGithubEvent(ev, repo, team_id)).filter(Boolean);
}

// Per-person scraper. Uses /users/<handle>/events/public — the public
// timeline of everything that user does across github. We map each
// event's repo back to a cohort team when possible (so feed cards still
// show "Pramaana · person did X" rather than just "raw owner/repo").
// person_id flows through as a fallback team label.
async function fetchGithubUserEvents(handle, repoToTeam, person_id) {
  const url = `https://api.github.com/users/${encodeURIComponent(handle)}/events/public?per_page=100`;
  const r = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!r.ok) {
    if (r.status === 404 || r.status === 403) return [];
    throw new Error(`HTTP ${r.status}`);
  }
  const evs = await r.json();
  if (!Array.isArray(evs)) return [];
  const out = [];
  for (const ev of evs) {
    const repo = ev.repo?.name || "";
    if (!repo) continue;
    const team_id = repoToTeam.get(repo.toLowerCase()) || null;
    const norm = normalizeGithubEvent(ev, repo, team_id);
    if (norm) {
      norm.person_id = person_id;  // tag for "this came from a cohort person"
      out.push(norm);
    }
  }
  return out;
}

// Update the loading-screen progress text + bar without a full re-render
// (avoids the alchemy-canvas swap animation flickering 30+ times).
function paintFeedLoadingProgress() {
  const p = state.fetchProgress;
  if (!p) return;
  const progEl = document.getElementById("alch-feed-loading-progress");
  if (progEl) progEl.textContent = `${p.done} of ${p.total} sources fetched`;
  const barEl = document.getElementById("alch-feed-loading-bar-fill");
  if (barEl) barEl.style.width = `${(100 * p.done / Math.max(p.total, 1)).toFixed(1)}%`;
}

function normalizeGithubEvent(ev, repo, team_id) {
  const id = `gh:${ev.id || `${repo}:${ev.created_at}:${ev.type}`}`;
  const at_ms = ev.created_at ? Date.parse(ev.created_at) : Date.now();
  const actor = ev.actor?.login || "—";
  const url = githubEventUrl(ev, repo);
  let summary;
  switch (ev.type) {
    case "PushEvent": {
      const n = ev.payload?.commits?.length || ev.payload?.size || 0;
      const branch = (ev.payload?.ref || "").replace(/^refs\/heads\//, "") || "main";
      const commits = ev.payload?.commits || [];
      const firstMsg = commits[0]?.message?.split("\n")[0] || "";
      summary = `pushed ${n} commit${n === 1 ? "" : "s"} to ${branch}${firstMsg ? ` — ${firstMsg}` : ""}`;
      break;
    }
    case "PullRequestEvent": {
      const action = ev.payload?.action;
      const num = ev.payload?.number;
      const title = ev.payload?.pull_request?.title || "";
      const verb = action === "closed" && ev.payload?.pull_request?.merged ? "merged" : action;
      summary = `${verb} PR #${num}${title ? ` — ${title}` : ""}`;
      break;
    }
    case "PullRequestReviewEvent": {
      const num = ev.payload?.pull_request?.number;
      summary = `reviewed PR #${num}`;
      break;
    }
    case "IssuesEvent": {
      const action = ev.payload?.action;
      const num = ev.payload?.issue?.number;
      const title = ev.payload?.issue?.title || "";
      summary = `${action} issue #${num}${title ? ` — ${title}` : ""}`;
      break;
    }
    case "IssueCommentEvent": {
      const num = ev.payload?.issue?.number;
      summary = `commented on #${num}`;
      break;
    }
    case "CreateEvent": {
      const refType = ev.payload?.ref_type;
      const ref = ev.payload?.ref;
      summary = `created ${refType}${ref ? ` ${ref}` : ""}`;
      break;
    }
    case "DeleteEvent": {
      const refType = ev.payload?.ref_type;
      const ref = ev.payload?.ref;
      summary = `deleted ${refType}${ref ? ` ${ref}` : ""}`;
      break;
    }
    case "ReleaseEvent": {
      const tag = ev.payload?.release?.tag_name || "";
      summary = `released ${tag}`;
      break;
    }
    case "ForkEvent": summary = "forked the repo"; break;
    case "WatchEvent": summary = "starred the repo"; break;
    case "PublicEvent": summary = "made the repo public"; break;
    case "MemberEvent": summary = `added ${ev.payload?.member?.login || "a member"}`; break;
    default: return null; // skip uninteresting types
  }
  return { id, source: "github", repo, team_id, type: ev.type, actor, at_ms, summary, url };
}

function githubEventUrl(ev, repo) {
  switch (ev.type) {
    case "PushEvent": {
      const head = ev.payload?.head;
      return head ? `https://github.com/${repo}/commit/${head}` : `https://github.com/${repo}/commits`;
    }
    case "PullRequestEvent":       return ev.payload?.pull_request?.html_url || `https://github.com/${repo}/pulls`;
    case "PullRequestReviewEvent": return ev.payload?.pull_request?.html_url || `https://github.com/${repo}/pulls`;
    case "IssuesEvent":            return ev.payload?.issue?.html_url || `https://github.com/${repo}/issues`;
    case "IssueCommentEvent":      return ev.payload?.comment?.html_url || `https://github.com/${repo}/issues`;
    case "ReleaseEvent":           return ev.payload?.release?.html_url || `https://github.com/${repo}/releases`;
    default:                       return `https://github.com/${repo}`;
  }
}

// ─── feed renderer ───────────────────────────────────────────────────
function teamLabel(rid, cohortIndex = buildCohortIndex(state.cohort)) {
  return cohortIndex.teamLabel(rid);
}
function relativeTime(ms) {
  const diff = Date.now() - ms;
  if (!Number.isFinite(diff)) return "—";
  const s = Math.max(0, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
function feedSourceGlyph(src) {
  return src === "github" ? "◇" : src === "transcript" ? "❍" : "·";
}

function renderFeed() {
  // Repos are the cohort's: every team with a valid links.repo.
  const repos = (state.cohort?.teams || []).filter(t => GH_REPO_RE.test(String(t?.links?.repo || "").trim()));
  const items = state.events;
  const head = `
    <header class="alch-feed-head">
      <div>
        <h2 class="alch-feed-title">recent activity</h2>
        <p class="alch-feed-sub" id="alch-feed-meta"></p>
      </div>
      <div class="alch-feed-actions">
        <button id="alch-feed-refresh" class="alch-feed-btn" type="button" title="re-fetch from github">
          <span aria-hidden="true">↻</span>
          <span>refresh</span>
        </button>
      </div>
    </header>
  `;
  let body;
  if (repos.length === 0) {
    body = `
      <div class="alch-feed-empty">
        <div class="alch-feed-empty-glyph" aria-hidden="true">◇</div>
        <div class="alch-feed-empty-title">no repos tracked yet</div>
        <div class="alch-feed-empty-sub">
          go to <button class="alch-link-btn" data-go="profile">profile</button> to register
          your team's github repos. activity will populate here within a few seconds.
        </div>
      </div>
    `;
  } else if (items.length === 0 && state.isFetching) {
    // First-visit back-fill in progress. Show a real loading screen with
    // progress so the user sees the scrape happening rather than staring
    // at an empty page.
    const prog = state.fetchProgress || { done: 0, total: 0 };
    const pct = prog.total ? (100 * prog.done / prog.total).toFixed(1) : 0;
    body = `
      <div class="alch-feed-loading">
        <div class="alch-feed-loading-glyph" aria-hidden="true"><span class="alch-feed-loading-spin"></span></div>
        <div class="alch-feed-loading-title">scraping cohort activity…</div>
        <div class="alch-feed-loading-sub" id="alch-feed-loading-progress">
          ${prog.total ? `${prog.done} of ${prog.total} sources fetched` : "warming up the cache"}
        </div>
        <div class="alch-feed-loading-bar">
          <div class="alch-feed-loading-bar-fill" id="alch-feed-loading-bar-fill" style="width:${pct}%"></div>
        </div>
        <div class="alch-feed-loading-foot">
          team repos + every cohort member's github profile. first run takes a moment;
          subsequent visits read from the local cache and refresh in the background.
        </div>
      </div>
    `;
  } else if (items.length === 0) {
    body = `
      <div class="alch-feed-empty">
        <div class="alch-feed-empty-glyph" aria-hidden="true">⊙</div>
        <div class="alch-feed-empty-title">tracking ${repos.length} ${repos.length === 1 ? "repo" : "repos"} · no events yet</div>
        <div class="alch-feed-empty-sub">github is being polled. fresh activity shows up here.</div>
      </div>
    `;
  } else {
    // Roll the flat event list up to one card per actor (person ↦ team
    // ↦ raw gh login). Stops the feed from being 100 lines of "vaishnavi
    // pushed 1 commit" — one card with the latest event + a "+N more"
    // tail is easier to scan.
    const groups = groupFeedItemsByActor(items);
    const cohortIndex = buildCohortIndex(state.cohort);
    body = `<ul class="alch-feed-list">${groups.map(group => renderFeedGroup(group, cohortIndex)).join("")}</ul>`;
    body += `
      <p class="alch-callout"><strong>feed · v0.2</strong><br/>
      One card per person/team — the latest event headlines, a "+N more" tail counts the rest. Click a card to open the latest event on github. Sources: team repos + every cohort member's public github activity. Refreshed every 12 min in the background.</p>
    `;
  }
  state.canvas.innerHTML = head + body;
  paintFeedMeta();
}

// Group flat event list by actor identity: cohort person record ↦ cohort
// team ↦ raw github login. Each group: the latest event becomes the
// headline; everything else under the same key counts toward the "+N more"
// suffix. Result sorted by group's most-recent event.
function groupFeedItemsByActor(events) {
  const groups = new Map();
  for (const ev of events) {
    const key = ev.person_id
      ? `p:${ev.person_id}`
      : ev.team_id
        ? `t:${ev.team_id}`
        : `a:${(ev.actor || ev.repo || "?").toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        kind: ev.person_id ? "person" : ev.team_id ? "team" : "actor",
        person_id: ev.person_id || null,
        team_id: ev.team_id || null,
        actor: ev.actor || "",
        latest: ev,
        count: 0,
        types: new Map(),
      };
      groups.set(key, g);
    }
    g.count++;
    if ((ev.at_ms || 0) > (g.latest.at_ms || 0)) g.latest = ev;
    g.types.set(ev.type, (g.types.get(ev.type) || 0) + 1);
  }
  return Array.from(groups.values()).sort(
    (a, b) => (b.latest.at_ms || 0) - (a.latest.at_ms || 0)
  );
}

// Headline derivation: prefer the cohort person's name, else cohort team
// name, else raw gh actor. Returns { primary, secondary } for two-line
// layout (primary = bold name, secondary = team/repo context line).
function feedGroupHeadline(g, cohortIndex = buildCohortIndex(state.cohort)) {
  const ev = g.latest;
  let primary = "";
  let secondary = "";
  if (g.person_id) {
    const p = cohortIndex.personById.get(g.person_id);
    primary = p?.name || g.actor || g.person_id;
    if (ev.team_id) {
      const t = teamLabel(ev.team_id, cohortIndex);
      if (t && t !== "—") secondary = t;
    }
    if (!secondary && ev.repo) secondary = ev.repo;
  } else if (g.team_id) {
    primary = teamLabel(g.team_id, cohortIndex);
    secondary = g.actor ? `@${g.actor}` : (ev.repo || "");
  } else {
    primary = g.actor || ev.repo || "—";
    secondary = ev.repo || "";
  }
  return { primary, secondary };
}

// Short tail summarising the rest of the group's activity by event type.
// E.g. counts {PushEvent: 3, PullRequestEvent: 2} → "3 pushes · 2 PRs"
function feedGroupTail(g) {
  if (g.count <= 1) return "";
  const labels = {
    PushEvent:              { one: "push",    many: "pushes" },
    PullRequestEvent:       { one: "PR",      many: "PRs" },
    PullRequestReviewEvent: { one: "review",  many: "reviews" },
    IssuesEvent:            { one: "issue",   many: "issues" },
    IssueCommentEvent:      { one: "comment", many: "comments" },
    CreateEvent:            { one: "create",  many: "creates" },
    DeleteEvent:            { one: "delete",  many: "deletes" },
    ReleaseEvent:           { one: "release", many: "releases" },
    ForkEvent:              { one: "fork",    many: "forks" },
    WatchEvent:             { one: "star",    many: "stars" },
  };
  // Subtract 1 since the latest event is already shown as the headline.
  const types = Array.from(g.types.entries()).map(([t, c]) => {
    const k = t === g.latest.type ? c - 1 : c;
    return [t, k];
  }).filter(([, c]) => c > 0);
  if (types.length === 0) return "";
  types.sort((a, b) => b[1] - a[1]);
  const top = types.slice(0, 3).map(([t, c]) => {
    const lbl = labels[t] || { one: t.replace(/Event$/, "").toLowerCase(), many: t.replace(/Event$/, "").toLowerCase() + "s" };
    return `${c} ${c === 1 ? lbl.one : lbl.many}`;
  });
  return top.join(" · ");
}

function renderFeedGroup(g, cohortIndex = buildCohortIndex(state.cohort)) {
  const ev = g.latest;
  const { primary, secondary } = feedGroupHeadline(g, cohortIndex);
  const tail = feedGroupTail(g);
  const sourceClass = `is-${ev.source}`;
  return `
    <li class="alch-feed-item alch-feed-group ${sourceClass}"
        data-event-id="${escHtml(ev.id)}"
        data-url="${escHtml(ev.url || "")}">
      <div class="alch-feed-glyph" aria-hidden="true">${feedSourceGlyph(ev.source)}</div>
      <div class="alch-feed-body">
        <div class="alch-feed-headline">
          <span class="alch-feed-team">${escHtml(primary)}</span>
          ${secondary ? `<span class="alch-feed-sep">·</span><span class="alch-feed-repo">${escHtml(secondary)}</span>` : ""}
        </div>
        <div class="alch-feed-summary">
          <span class="alch-feed-action">${escHtml(ev.summary || "")}</span>
        </div>
        ${tail ? `<div class="alch-feed-tail">+ ${escHtml(tail)} this week</div>` : ""}
      </div>
      <div class="alch-feed-time" title="${escHtml(new Date(ev.at_ms).toLocaleString())}">${escHtml(relativeTime(ev.at_ms))}</div>
    </li>
  `;
}

// Kept for any caller that still wants a per-event view (currently none
// after the rollup; safe to delete in a later sweep).
function renderFeedItem(ev) {
  const teamName = teamLabel(ev.team_id);
  const sourceClass = `is-${ev.source}`;
  return `
    <li class="alch-feed-item ${sourceClass}" data-event-id="${escHtml(ev.id)}" data-url="${escHtml(ev.url || "")}">
      <div class="alch-feed-glyph" aria-hidden="true">${feedSourceGlyph(ev.source)}</div>
      <div class="alch-feed-body">
        <div class="alch-feed-headline">
          <span class="alch-feed-team">${escHtml(teamName)}</span>
          <span class="alch-feed-sep">·</span>
          <span class="alch-feed-repo">${escHtml(ev.repo || "")}</span>
        </div>
        <div class="alch-feed-summary">
          <span class="alch-feed-actor">${escHtml(ev.actor || "")}</span>
          <span class="alch-feed-action">${escHtml(ev.summary || "")}</span>
        </div>
      </div>
      <div class="alch-feed-time" title="${escHtml(new Date(ev.at_ms).toLocaleString())}">${escHtml(relativeTime(ev.at_ms))}</div>
    </li>
  `;
}

function paintFeedMeta(override) {
  const meta = document.getElementById("alch-feed-meta");
  if (!meta) return;
  const repos = (state.cohort?.teams || []).filter(t => GH_REPO_RE.test(String(t?.links?.repo || "").trim())).length;
  if (override) { meta.textContent = override; return; }
  if (state.isFetching) {
    meta.textContent = `fetching…`;
  } else if (state.fetchedAt > 0) {
    meta.textContent = `${state.events.length} events · ${repos} ${repos === 1 ? "repo" : "repos"} tracked · last fetched ${relativeTime(state.fetchedAt)}`;
  } else {
    meta.textContent = `${repos} ${repos === 1 ? "repo" : "repos"} tracked · waiting on first fetch`;
  }
}

function wireFeedInteractions() {
  const refreshBtn = document.getElementById("alch-feed-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => refreshFeed({ source: "manual", force: true }));
  }
  for (const item of state.canvas.querySelectorAll(".alch-feed-item[data-url]")) {
    const url = item.dataset.url;
    if (!url) continue;
    item.style.cursor = "pointer";
    item.addEventListener("click", () => {
      try { window.api?.openExternal?.(url); } catch {}
    });
    item.tabIndex = 0;
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        try { window.api?.openExternal?.(url); } catch {}
      }
    });
  }
  // Empty-state link → switch to profile tab.
  for (const link of state.canvas.querySelectorAll(".alch-link-btn[data-go='profile']")) {
    link.addEventListener("click", () => {
      state.mode = "profile";
      try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
      syncRailSelection();
      render();
    });
  }
  // (timer is mounted globally in mount())
}

// ─── profile renderer ────────────────────────────────────────────────
// TODO: extract this whole block into @shape-rotator/shape-ui
// (profile-form.js currently ships a minimal single-record edit form
// for the sibling web app, but the full add/edit/diff/markdown-gen
// flow below stays here because it's wired into state.profile,
// cohort-relative pickers, and steward-merge expectations that are
// out of scope for the web app today). Convergence work is Phase 2.
// Two editing modes:
//   • team   — pick an existing team, edit its surface fields. Submit
//              opens github's /edit/ URL + shows a diff panel since
//              github web editor doesn't accept pre-filled content for
//              existing files. User makes the listed changes manually.
//   • person — pick an existing person OR create new. New uses /new/
//              with prefilled content (one-click); existing uses
//              /edit/ + diff panel like teams.
//
// editDraft is the in-progress edit; editBaseline is what was loaded
// (so we can compute a diff of just the changed fields).

// Team and project share the same frontmatter shape, so they share the
// same field list — but copy that says "team name" or "members on the
// team" reads wrong in the project editor. teamFieldsFor(kind) returns
// the same fields with kind-aware placeholders + labels.
function teamFieldsFor(kind) {
  const isProject = kind === "project";
  return [
    { key: "name",            label: "name",            type: "text",     placeholder: isProject ? "project name" : "team name" },
    { key: "focus",           label: "focus",           type: "text",     placeholder: isProject ? "what it does, in one line" : "what you're building, in one line" },
    // `lead` retired — team identity is the contributor list, derived from
    // person records. Anyone with role: "lead" on their person record is
    // still highlighted in the dossier + member views.
    { key: "members_count",   label: isProject ? "contributors" : "members", type: "number", placeholder: isProject ? "how many people work on it" : "how many on the team" },
    { key: "geo",             label: "geo",             type: "text",     placeholder: "NYC, etc." },
    { key: "domain",          label: "domain",          type: "select",   options: ["crypto", "tee", "ai", "app-ux", "bd-gtm", "design"] },
    { key: "shape",           label: "shape",           type: "select",   options: ["torus", "hex", "prism", "meridian", "scaffold", "plate"] },
    { key: "paper_basis",     label: "paper basis",     type: "text",     placeholder: "the IC3/Flashbots paper your work cites" },
    { key: "traction",        label: "traction",        type: "text",     placeholder: "short public blurb (no $ amounts)" },
    { key: "hackathon_note",  label: "hackathon",       type: "text",     placeholder: "any award worth surfacing" },
    { key: "links.website",   label: "website",         type: "url",      placeholder: "https://…" },
    { key: "links.github",    label: "github",          type: "text",     placeholder: "owner (org/user vanity link)" },
    { key: "links.repo",      label: "repo",            type: "text",     placeholder: "owner/repo — feed auto-tracks this" },
    { key: "links.x",         label: "x / twitter",     type: "text",     placeholder: "@handle" },
    { key: "links.demo",      label: "demo",            type: "url",      placeholder: "video / loom / drive" },
    { key: "links.deck",      label: "deck",            type: "url",      placeholder: "https://…" },
    // Program-track fields — set in week-1 office hours per the agenda.
    { key: "success_dimensions", label: "success dimensions", type: "text",     placeholder: "productization, research_lineage, collaborative — pick any subset" },
    { key: "graduation_target",  label: "graduation target",  type: "textarea", placeholder: "what 'graduating well' looks like for this project" },
    { key: "monthly_milestones", label: "monthly milestones", type: "textarea", placeholder: "rough month-by-month checkpoints (one per line)" },
    { key: "weekly_goals",       label: "this week's goals",  type: "textarea", placeholder: "concrete goal(s) for this week — refresh on monday" },
    // ── PMF journey — placed on the constellation › journey spectrum.
    // stage / evidence STORE the integer but SHOW "1 · idea" via {value,label}.
    // All optional + defaulted-at-read; an unset journey plots at idea/vibes.
    { key: "journey.stage",            label: "pmf · stage",            type: "select", options: JOURNEY_STAGE_LABELS.map((l, i) => ({ value: i, label: i === 0 ? l : `${i} · ${l}` })) },
    { key: "journey.evidence_quality", label: "pmf · evidence quality", type: "select", options: JOURNEY_EVIDENCE_LABELS.slice(1).map((l, i) => ({ value: i + 1, label: `${i + 1} · ${l}` })) },
    { key: "journey.market_upside",    label: "pmf · market upside",    type: "select", options: [1, 2, 3, 4, 5].map(n => ({ value: n, label: `${n} · ${["", "niche", "modest", "solid", "large", "category-defining"][n]}` })) },
    { key: "journey.primary_bottleneck", label: "pmf · primary bottleneck", type: "select", options: JOURNEY_BOTTLENECKS },
    { key: "journey.company_type",     label: "pmf · company type",     type: "select", options: JOURNEY_COMPANY_TYPES },
    { key: "journey.confidence",       label: "pmf · confidence",       type: "select", options: JOURNEY_CONFIDENCE },
    { key: "journey.icp",              label: "pmf · ICP",              type: "text",     placeholder: "who is this for — the ideal customer profile" },
    { key: "journey.problem",          label: "pmf · problem",          type: "textarea", placeholder: "the pain you're solving, in their words" },
    { key: "journey.solution",         label: "pmf · solution",         type: "textarea", placeholder: "what you ship to solve it" },
    { key: "journey.evidence_notes",   label: "pmf · evidence notes",   type: "textarea", placeholder: "what proof you have so far (interviews, pilots, usage…)" },
    { key: "journey.next_milestone",   label: "pmf · next milestone",   type: "text",     placeholder: "the next thing that would move you up the spectrum" },
  ];
}

const PERSON_EDITABLE_FIELDS = [
  { key: "name",                label: "name",                type: "text",     placeholder: "your name" },
  { key: "team",                label: "team",                type: "team-select" },
  { key: "role",                label: "role",                type: "text",     placeholder: "what you do on the team" },
  { key: "geo",                 label: "geo",                 type: "text",     placeholder: "NYC, etc." },
  { key: "domain",              label: "domain",              type: "select",   options: ["crypto", "tee", "ai", "app-ux", "bd-gtm", "design"] },
  { key: "links.github",        label: "github",              type: "text",     placeholder: "username" },
  { key: "links.x",             label: "x / twitter",         type: "text",     placeholder: "@handle" },
  { key: "links.website",       label: "website",             type: "url",      placeholder: "https://…" },
  { key: "links.linkedin",      label: "linkedin",            type: "text",     placeholder: "username" },
  // Personal-API fields. Free-text, all optional; surfaced in the onboarding
  // walkthrough + person dossier so the cohort can collaborate well.
  { key: "comm_style",          label: "comm style",          type: "textarea", placeholder: "sync vs async, DM vs issue, fastest path to reach you" },
  { key: "contribute_interests",label: "contribute interests",type: "textarea", placeholder: "what you'd happily pair on for other people's projects" },
  { key: "availability_pref",   label: "availability rhythm", type: "textarea", placeholder: "heads-down hours, no-meet days, time zone notes" },
  { key: "weekly_intention",    label: "this week's intention", type: "textarea", placeholder: "one concrete thing you want to ship or learn this week" },
  { key: "dietary_restrictions",label: "dietary",             type: "text",     placeholder: "vegetarian / vegan / allergies / none — for cohort-meal planning" },
];

function getNested(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setNested(obj, path, value) {
  const ks = path.split(".");
  let cur = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (cur[ks[i]] == null || typeof cur[ks[i]] !== "object") cur[ks[i]] = {};
    cur = cur[ks[i]];
  }
  cur[ks[ks.length - 1]] = value;
}

// When switching mode/kind in EDIT mode, snap editTargetId to a valid
// record from the new pool if the current one isn't in it. Avoids the
// editor showing a stale form for a record that doesn't match the kind.
function pickFirstTargetIfMissing(p) {
  const cohort = state.cohort;
  if (!cohort) return;
  const cohortIndex = buildCohortIndex(cohort);
  const pool = (p.editKind === "person")
    ? cohortIndex.people
    : teamsOfKind(cohortIndex.teams, p.editKind);
  const stillValid = pool.some(r => r.record_id === p.editTargetId);
  if (!stillValid) p.editTargetId = pool[0]?.record_id || null;
}

function loadEditTarget() {
  const p = state.profile;
  const cohort = state.cohort;
  // If the cohort is briefly null (during a refresh / first-paint
  // window), leave whatever draft already exists alone. Previously
  // we wiped editDraft and editBaseline here, which let a single
  // cohort refresh blow away the user's in-progress edits.
  if (!cohort) return;
  const cohortIndex = buildCohortIndex(cohort);

  // Sticky draft: only (re)seed when the edit context actually changed.
  // Same mode + same kind + same target → preserve whatever the user has
  // typed across re-renders (sub-tab switches, top-tab switches, cohort
  // refreshes, etc.). Previously every render call clobbered the draft,
  // wiping in-progress text.
  const contextKey = `${p.editMode}|${p.editKind}|${p.editTargetId || ""}`;
  if (p._editContextKey === contextKey && p.editDraft) return;
  p._editContextKey = contextKey;

  // ADD mode: seed a blank draft for the chosen kind. No baseline (null
  // signals "creating", which runGithubPRFlow uses to pick /new/ URL).
  if (p.editMode === "add") {
    if (p.editKind === "person") {
      p.editDraft = {
        record_id: "",
        record_type: "person",
        schema_version: 1,
        name: p.user.name || "",
        team: p.user.team_id || null,
        role: "",
        geo: "",
        domain: null,
        links: {
          github: p.user.github || "",
          x: p.user.x || "",
          website: p.user.website || "",
        },
      };
    } else {
      // team or project — both team-shaped, distinguished by `kind`.
      p.editDraft = {
        record_id: "",
        record_type: "team",
        schema_version: 1,
        kind: p.editKind,           // "team" | "project"
        name: "",
        focus: "",
        members_count: null,
        geo: "",
        domain: null,
        shape: null,
        is_mentor: false,
        links: { github: null, x: null, website: null, demo: null, deck: null },
        paper_basis: null,
        traction: null,
        hackathon_note: null,
      };
    }
    p.editBaseline = null;
    return;
  }

  // EDIT mode: look up the picked record in the cohort.
  if (p.editKind === "person") {
    const person = cohortIndex.personById.get(p.editTargetId);
    if (person) {
      p.editDraft = JSON.parse(JSON.stringify(person));
      p.editBaseline = JSON.parse(JSON.stringify(person));
    } else {
      p.editDraft = null;
      p.editBaseline = null;
    }
    return;
  }
  // team or project — pull from cohort.teams, filter by kind.
  const pool = teamsOfKind(cohortIndex.teams, p.editKind);
  const t = pool.find(x => x.record_id === p.editTargetId);
  if (t) {
    p.editDraft = JSON.parse(JSON.stringify(t));
    p.editBaseline = JSON.parse(JSON.stringify(t));
  } else {
    p.editDraft = null;
    p.editBaseline = null;
  }
}

function renderProfile() {
  loadEditTarget();
  // Start the fork-warning poll the first time the user lands on
  // profile. Idempotent + bounded (one 30s timer for the app lifetime).
  startForkPolling();
  // Re-render the profile (banner included) when fork status flips.
  // _forkBannerSub is a module-level guard so we only subscribe once.
  if (!_forkBannerSub) {
    _forkBannerSub = subscribeToForkChange(() => {
      if (state.mode === "profile") {
        renderProfile();
        wireProfileForm();
      }
    });
  }
  const p = state.profile;
  const teams = state.cohort?.teams || [];
  const people = state.cohort?.people || [];

  const editorBody = renderEditorBody(p, teams, people);
  // Fork warning per spec §9.9 — surfaced as a banner above the editor
  // when swf-node sees the user's record_id in /health.forked_records.
  const forkBannerHtml = isProfileForked() ? `
    <div class="alch-profile-fork-banner" role="alert">
      <span class="alch-fork-tag">!</span>
      <span class="alch-fork-msg">your profile has diverged across devices — write a new edit below to resolve.</span>
      <a class="alch-fork-link" href="https://github.com/dmarzzz/shape-rotator-os/blob/main/docs/MATRIX.md" data-external>more</a>
    </div>
  ` : "";

  const themeNow = getTheme();
  const themeNext = themeNow === "light" ? "dark" : "light";
  state.canvas.innerHTML = `
    <header class="alch-profile-head">
      <div class="alch-profile-head-row">
        <h2 class="alch-profile-title">profile</h2>
        <button
          id="alch-theme-toggle"
          class="alch-theme-toggle"
          type="button"
          data-theme-now="${themeNow}"
          title="switch to ${themeNext} mode"
          aria-label="switch to ${themeNext} mode"
        >
          <span class="alch-theme-toggle-icon" aria-hidden="true">${themeNow === "light" ? "☾" : "☀"}</span>
          <span class="alch-theme-toggle-label">${themeNext} mode</span>
        </button>
      </div>
      <p class="alch-profile-sub">
        add or edit a team / project / person record. when swf-node is running, edits land locally and gossip to LAN peers; github PR is the fallback.
      </p>
    </header>

    ${forkBannerHtml}

    <section class="alch-profile-section">
      <h3 class="alch-profile-h">${p.editMode === "add" ? "add a record" : "edit a record"}</h3>
      <nav class="alch-pf-modetabs" role="tablist" aria-label="add or edit">
        <button class="alch-pf-modetab" data-edit-mode="add"  type="button" aria-selected="${p.editMode === "add"}">add</button>
        <button class="alch-pf-modetab" data-edit-mode="edit" type="button" aria-selected="${p.editMode === "edit"}">edit</button>
      </nav>
      <nav class="alch-pf-subtabs" role="tablist" aria-label="record kind">
        <button class="alch-pf-subtab" data-edit-kind="team"    type="button" aria-selected="${p.editKind === "team"}">team</button>
        <button class="alch-pf-subtab" data-edit-kind="project" type="button" aria-selected="${p.editKind === "project"}">project</button>
        <button class="alch-pf-subtab" data-edit-kind="person"  type="button" aria-selected="${p.editKind === "person"}">person</button>
      </nav>
      <div class="alch-pf-editor" id="alch-pf-editor">${editorBody}</div>
      <div id="alch-submit-pr-result" class="alch-submit-pr-result" hidden></div>
    </section>

    <p class="alch-callout"><strong>profile · v0.2</strong><br/>
    Submitting opens a PR against this repo. Stewards review + merge → cohort sees the change on next
    <code>npm run build:cohort</code>. Updates only touch surface fields (steward-managed fields like class /
    archetype / status are preserved by manual edit in the github editor). The feed auto-tracks every
    team or project's <code>links.repo</code> — fill it in via <strong>edit → team</strong> or <strong>edit → project</strong> to surface activity.</p>
  `;
}

function renderEditorBody(p, teams, people) {
  const fields = (p.editKind === "person") ? PERSON_EDITABLE_FIELDS : teamFieldsFor(p.editKind);

  // ADD mode: blank form, no record-picker. The slug is derived live
  // from the form (name / github) and previewed in the submit block.
  if (p.editMode === "add") {
    const formHtml = p.editDraft
      ? renderEditorForm(fields, p.editDraft, { teams })
      : `<p class="alch-pf-pick">loading…</p>`;
    return `${formHtml}${p.editDraft ? renderSubmitBlock(p) : ""}`;
  }

  // EDIT mode: pick an existing record, then edit. Pool is filtered by
  // kind so projects don't pollute the team picker (and vice versa).
  if (p.editKind === "person") {
    const pool = people;
    const opts = ['<option value="">— pick a person —</option>']
      .concat(pool.map(pp => `<option value="${escHtml(pp.record_id)}" ${p.editTargetId === pp.record_id ? "selected" : ""}>${escHtml(pp.name || pp.record_id)}</option>`))
      .join("");
    const formHtml = p.editDraft
      ? renderEditorForm(fields, p.editDraft, { teams })
      : `<p class="alch-pf-pick">${pool.length ? "pick a person above to edit." : "no person records yet — switch to <strong>add</strong> to create one."}</p>`;
    return `
      <div class="alch-pf-target">
        <label><span>person</span>
          <select id="alch-pf-target-select" class="alch-pf-target-select">${opts}</select>
        </label>
      </div>
      ${formHtml}
      ${p.editDraft ? renderSubmitBlock(p) : ""}
    `;
  }
  // team or project
  const pool = teamsOfKind(teams, p.editKind);
  const opts = [`<option value="">— pick a ${p.editKind} —</option>`]
    .concat(pool.map(t => `<option value="${escHtml(t.record_id)}" ${p.editTargetId === t.record_id ? "selected" : ""}>${escHtml(t.name)} · ${escHtml(t.record_id)}</option>`))
    .join("");
  const formHtml = p.editDraft
    ? renderEditorForm(fields, p.editDraft, { teams })
    : `<p class="alch-pf-pick">${pool.length ? `pick a ${p.editKind} above to edit its surface record.` : `no ${p.editKind} records yet — switch to <strong>add</strong> to create one.`}</p>`;
  return `
    <div class="alch-pf-target">
      <label><span>which ${escHtml(p.editKind)}</span>
        <select id="alch-pf-target-select" class="alch-pf-target-select">${opts}</select>
      </label>
    </div>
    ${formHtml}
    ${p.editDraft ? renderSubmitBlock(p) : ""}
  `;
}

function renderEditorForm(fields, draft, ctx) {
  const rows = fields.map(f => {
    const value = getNested(draft, f.key);
    const display = value == null ? "" : String(value);
    let input;
    if (f.type === "select") {
      // Options may be plain strings (value === label) OR {value,label}
      // objects (store the value, show the label). Selected when the
      // stringified option value matches the stringified current value.
      const opts = ['<option value="">—</option>']
        .concat(f.options.map(o => {
          const ov = (o && typeof o === "object") ? o.value : o;
          const ol = (o && typeof o === "object") ? o.label : o;
          const sel = String(ov) === String(value) ? "selected" : "";
          return `<option value="${escAttr(String(ov))}" ${sel}>${escHtml(String(ol))}</option>`;
        }))
        .join("");
      input = `<select name="${escAttr(f.key)}">${opts}</select>`;
    } else if (f.type === "team-select") {
      const teamOpts = ['<option value="">— no team —</option>']
        .concat((ctx.teams || []).map(t => `<option value="${escHtml(t.record_id)}" ${value === t.record_id ? "selected" : ""}>${escHtml(t.name)} · ${escHtml(t.record_id)}</option>`))
        .join("");
      input = `<select name="${escAttr(f.key)}">${teamOpts}</select>`;
    } else if (f.type === "textarea") {
      input = `<textarea name="${escAttr(f.key)}" rows="3" placeholder="${escAttr(f.placeholder || "")}">${escHtml(display)}</textarea>`;
    } else {
      input = `<input type="${f.type}" name="${escAttr(f.key)}" value="${escAttr(display)}" placeholder="${escAttr(f.placeholder || "")}" />`;
    }
    const rowCls = (f.type === "textarea") ? "alch-pf-row alch-pf-row-wide" : "alch-pf-row";
    return `<label class="${rowCls}"><span>${escHtml(f.label)}</span>${input}</label>`;
  }).join("");
  return `<form id="alch-pf-edit-form" class="alch-profile-form" autocomplete="off">${rows}</form>`;
}

function renderSubmitBlock(p) {
  const isAdd = p.editMode === "add";
  const slug = isAdd ? (draftSlug(p) || "<your-slug>") : p.editTargetId;
  // team and project both live under cohort-data/teams/.
  const folder = (p.editKind === "person") ? "people" : "teams";
  const targetPath = `cohort-data/${folder}/${slug}.md`;
  // Two explicit buttons — no surprise fallback. The local-sync path used
  // to silently fall through to github when swf-node returned an error;
  // users couldn't tell which path actually fired. Now: pick the path
  // explicitly. The sync button disables when swf-node isn't reachable
  // OR when the draft kind isn't supported by Phase 2 sync (person only).
  const syncOn = isSyncAvailable();
  const isPerson = p.editKind === "person";
  const syncEnabled = syncOn && isPerson;
  const syncLabel = isAdd ? "create · local sync" : "save · local sync";
  const ghLabel   = isAdd ? "create · open github PR" : "save · open github PR";
  const syncDisabledNote =
    !syncOn   ? ` <span class="alch-submit-pr-mute">(swf-node down)</span>`
    : !isPerson ? ` <span class="alch-submit-pr-mute">(person only · Phase 3 adds ${escHtml(p.editKind)})</span>`
    : "";
  const syncTitle =
    !syncOn   ? "swf-node is not reachable on 127.0.0.1:7777"
    : !isPerson ? `local sync is person-only in Phase 2 — this draft is a ${p.editKind}; use github PR`
    : "post to local swf-node — gossips to LAN peers in ~30s";
  // History link — only in EDIT mode (ADD has no chain to inspect yet).
  // Reads /sync/record/<id>?full=true via sync-client. When swf-node is
  // unreachable the modal renders "history unavailable" and links to
  // the github file history.
  const historyHtml = (!isAdd && slug)
    ? `<button id="alch-history-link" class="alch-history-link" type="button" data-record-id="${escAttr(slug)}" data-record-kind="${escAttr(p.editKind)}">history</button>`
    : "";
  return `
    <div class="alch-profile-submit">
      <div class="alch-profile-submit-row">
        <button id="alch-submit-sync"
                class="alch-feed-btn alch-submit-pr-btn alch-submit-pr-primary"
                type="button"
                ${syncEnabled ? "" : "disabled aria-disabled=\"true\""}
                title="${escAttr(syncTitle)}">
          <span aria-hidden="true">↑</span>
          <span class="alch-submit-pr-label">${escHtml(syncLabel)}</span>${syncDisabledNote}
        </button>
        <button id="alch-submit-pr"
                class="alch-feed-btn alch-submit-pr-btn alch-submit-pr-secondary"
                type="button"
                title="open github's web editor — durable, requires fork + merge">
          <span aria-hidden="true">⎘</span>
          <span class="alch-submit-pr-label">${escHtml(ghLabel)}</span>
        </button>
        ${historyHtml}
      </div>
      <p class="alch-submit-pr-hint">
        will publish to <code id="alch-submit-pr-target">${escHtml(targetPath)}</code>.
        <strong>local sync</strong> writes to your swf-node — instant on this machine, gossips to LAN peers on the next ~30s tick.
        <strong>github PR</strong> opens the web editor pre-filled with your edits — durable, requires a fork + reviewer merge.
      </p>
    </div>
  `;
}

function profileSlug(profile) {
  const src = (profile?.user?.github || profile?.user?.name || "").toString();
  return src.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// Slug for an in-flight ADD form. Prefers values from the form itself
// over the long-lived "me" prefs so the path preview updates live and
// the submitted record_id matches the visible NAME / GITHUB fields.
// Person uses github > name; team/project just use name.
function draftSlug(p) {
  const d = p?.editDraft || {};
  const isPerson = p?.editKind === "person";
  const src = isPerson
    ? (d?.links?.github || d?.name || p?.user?.github || p?.user?.name || "")
    : (d?.name || "");
  return String(src).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function wireExternalLinks(root) {
  for (const a of (root || document).querySelectorAll("a[data-external]")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      // Stop the click bubbling — links inside clickable cards (shapes
      // grid) would otherwise also fire the card's "open detail" handler.
      e.stopPropagation();
      const url = a.getAttribute("href");
      if (!url || url === "#") return;
      try { window.api?.openExternal?.(url); } catch {}
    });
  }
}

function wireProfileForm() {
  // Light/dark toggle (lives in the profile header).
  const themeBtn = state.canvas.querySelector("#alch-theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const next = toggleTheme();
      toast(`switched to ${next} mode`);
      renderProfile();
      wireProfileForm();
    });
  }

  // Mode tabs (add / edit)
  for (const btn of state.canvas.querySelectorAll(".alch-pf-modetab[data-edit-mode]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.editMode;
      if (next === state.profile.editMode) return;
      state.profile.editMode = next;
      // Switching to edit: try to keep targetId valid for the current
      // kind, otherwise clear so the picker prompts.
      if (next === "edit") pickFirstTargetIfMissing(state.profile);
      else state.profile.editTargetId = null;
      saveProfile();
      renderProfile();
      wireProfileForm();
    });
  }

  // Kind tabs (team / project / person)
  for (const btn of state.canvas.querySelectorAll(".alch-pf-subtab[data-edit-kind]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.editKind;
      if (next === state.profile.editKind) return;
      state.profile.editKind = next;
      if (state.profile.editMode === "edit") pickFirstTargetIfMissing(state.profile);
      saveProfile();
      renderProfile();
      wireProfileForm();
    });
  }

  // Target selector (only present in EDIT mode)
  const targetSel = document.getElementById("alch-pf-target-select");
  if (targetSel) {
    targetSel.addEventListener("change", () => {
      state.profile.editTargetId = targetSel.value || null;
      saveProfile();
      renderProfile();
      wireProfileForm();
    });
  }

  // Edit form: live-update editDraft on input. NO re-render so focus
  // stays in the input the user is typing into. Persists the draft to
  // localStorage SYNCHRONOUSLY on every keystroke — the previous 350ms
  // debounce was losing in-progress edits when the user tab-switched
  // before the timer fired. localStorage.setItem on a small JSON blob
  // is ~sub-millisecond on modern machines; no need to debounce.
  const editForm = document.getElementById("alch-pf-edit-form");
  if (editForm) {
    const onChange = (e) => {
      const target = e.target;
      if (!target?.name || !state.profile.editDraft) return;
      const value = target.value;
      // Coerce number / select empty / etc.
      let coerced = value;
      if (target.type === "number") coerced = value === "" ? null : Number(value);
      else if (value === "") coerced = null;
      // Integer-valued journey selects store the number, not the string,
      // so the data model stays clean (stage/evidence/market_upside are
      // 1..N integers). Other selects keep their string value.
      else if (NUMERIC_JOURNEY_KEYS.has(target.name) && /^-?\d+$/.test(value)) {
        coerced = Number(value);
      }
      setNested(state.profile.editDraft, target.name, coerced);
      saveProfile();
      // Refresh the ADD path preview so the user can see exactly where
      // their record will land before they hit submit. Folder mirrors
      // renderSubmitBlock: people → people/, team+project → teams/.
      const targetEl = document.getElementById("alch-submit-pr-target");
      if (targetEl && state.profile.editMode === "add") {
        const slug = draftSlug(state.profile) || "<your-slug>";
        const folder = state.profile.editKind === "person" ? "people" : "teams";
        targetEl.textContent = `cohort-data/${folder}/${slug}.md`;
      }
    };
    editForm.addEventListener("input", onChange);
    editForm.addEventListener("change", onChange);
  }

  // Submit
  const syncBtn = document.getElementById("alch-submit-sync");
  if (syncBtn) syncBtn.addEventListener("click", submitEditAsLocalSync);
  const prBtn = document.getElementById("alch-submit-pr");
  if (prBtn) prBtn.addEventListener("click", submitEditAsGithubPR);

  // History — Phase 2 modal listing prior versions of the record. Pulls
  // the full chain via /sync/record/<id>?full=true. Each row exposes a
  // "restore" button that pre-fills the editor with that version's
  // content (the user then clicks submit normally → fresh envelope with
  // restored content).
  const histBtn = document.getElementById("alch-history-link");
  if (histBtn) histBtn.addEventListener("click", () => {
    const recordId = histBtn.dataset.recordId;
    const recordKind = histBtn.dataset.recordKind;
    if (recordId) openHistoryModal({ recordId, recordKind });
  });

  wireExternalLinks(state.canvas);
}

// YAML-quote a user-supplied string. Always wrap in double quotes +
// escape internal quotes/backslashes — bulletproof for our schema
// (URLs, names with punctuation, handles, etc.).
function quoteYaml(s) {
  return `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Emit a YAML scalar — quoted on a single line for short strings, or as a
// literal block (`|`) for anything containing a newline. `indent` is the
// number of spaces a continuation line should sit at (the key's column
// + 2). Used for textarea-backed fields like weekly_goals, monthly_milestones,
// and the personal-API fields where multiline content matters.
function yamlScalar(value, indent = 2) {
  if (value == null || value === "") return "null";
  const s = String(value);
  if (!/\n/.test(s)) return quoteYaml(s);
  const pad = " ".repeat(indent);
  // Strip trailing whitespace; rejoin with leading indent. Block-scalar
  // `|` preserves newlines verbatim; we don't strip blank lines because
  // they may be load-bearing in the user's prose.
  const lines = s.replace(/\s+$/, "").split(/\r?\n/).map(l => pad + l);
  return `|\n${lines.join("\n")}`;
}

// Build the full markdown content for a team or project record. For NEW
// records, `body` is null and the default placeholder is appended. For
// EDIT submissions, the caller passes the preserved body (fetched from
// raw.githubusercontent.com) so the user's existing description isn't
// wiped when the YAML frontmatter is rewritten. `draft` is the editor's
// working record and should include any fields the editor doesn't
// expose (members_count baseline, etc.) so the rebuild is a strict
// superset of the in-form fields.
function buildTeamMarkdown(draft, slug, kind, body = null) {
  const links = draft.links || {};
  const lp = [];
  if (links.github)  lp.push(`  github: ${quoteYaml(links.github)}`);
  if (links.repo)    lp.push(`  repo: ${quoteYaml(links.repo)}`);
  if (links.x)       lp.push(`  x: ${quoteYaml(links.x)}`);
  if (links.website) lp.push(`  website: ${quoteYaml(links.website)}`);
  if (links.demo)    lp.push(`  demo: ${quoteYaml(links.demo)}`);
  if (links.deck)    lp.push(`  deck: ${quoteYaml(links.deck)}`);
  const linksBlock = lp.length ? `links:\n${lp.join("\n")}` : `links: {}`;

  // Preserve fields that the editor doesn't expose so we don't silently
  // delete them on edit. `now`, `prior_shipping`, `skill_areas`,
  // `dependencies`, `seeking`, `offering` live in the cohort surface
  // record and ride along through `draft` (which is a clone of the
  // baseline that the form mutates in-place).
  const extras = [];
  if (Array.isArray(draft.skill_areas) && draft.skill_areas.length) {
    extras.push(`skill_areas:\n${draft.skill_areas.map(s => `  - ${s}`).join("\n")}`);
  }
  if (Array.isArray(draft.dependencies) && draft.dependencies.length) {
    extras.push(`dependencies:\n${draft.dependencies.map(d => `  - ${d}`).join("\n")}`);
  }
  if (Array.isArray(draft.seeking) && draft.seeking.length) {
    extras.push(`seeking:\n${draft.seeking.map(s => `  - ${quoteYaml(s)}`).join("\n")}`);
  }
  if (Array.isArray(draft.offering) && draft.offering.length) {
    extras.push(`offering:\n${draft.offering.map(s => `  - ${quoteYaml(s)}`).join("\n")}`);
  }
  if (draft.now) extras.push(`now: ${quoteYaml(draft.now)}`);
  if (draft.prior_shipping) extras.push(`prior_shipping: ${yamlScalar(draft.prior_shipping)}`);
  const extrasBlock = extras.length ? `\n${extras.join("\n")}` : "";

  const bodyHint = kind === "project"
    ? "(project description — what it does, who it's for, current state)"
    : "(team description — focus, members, where to find you)";
  const bodyContent = body != null && body.trim() ? body : `\n## about\n\n${bodyHint}\n`;
  return `---
record_id: ${slug}
record_type: team
schema_version: 1
kind: ${kind}
name: ${quoteYaml(draft.name || "")}
focus: ${quoteYaml(draft.focus || "")}
members_count: ${draft.members_count == null ? "null" : Number(draft.members_count)}
geo: ${quoteYaml(draft.geo || "")}
domain: ${draft.domain || "null"}
shape: ${draft.shape || "null"}
is_mentor: ${draft.is_mentor ? "true" : "false"}
${linksBlock}
paper_basis: ${draft.paper_basis ? quoteYaml(draft.paper_basis) : "null"}
traction: ${draft.traction ? quoteYaml(draft.traction) : "null"}
hackathon_note: ${draft.hackathon_note ? quoteYaml(draft.hackathon_note) : "null"}
success_dimensions: ${yamlScalar(draft.success_dimensions)}
graduation_target: ${yamlScalar(draft.graduation_target)}
monthly_milestones: ${yamlScalar(draft.monthly_milestones)}
weekly_goals: ${yamlScalar(draft.weekly_goals)}${extrasBlock}
---
${bodyContent}`;
}

// Build the full markdown content for a person record. For NEW records,
// `body` is null (a placeholder is appended); for EDIT submissions the
// caller passes the existing body so the user's bio survives a YAML
// rewrite. `draft` should include non-editor fields (email, dates_*,
// secondary_teams) — for EDIT mode these ride in via the baseline-clone
// that the form mutates in place.
function buildPersonMarkdown(draft, slug, body = null) {
  const links = draft.links || {};
  const lp = [];
  if (links.github)   lp.push(`  github: ${quoteYaml(links.github)}`);
  if (links.x)        lp.push(`  x: ${quoteYaml(links.x)}`);
  if (links.website)  lp.push(`  website: ${quoteYaml(links.website)}`);
  if (links.linkedin) lp.push(`  linkedin: ${quoteYaml(links.linkedin)}`);
  const linksBlock = lp.length ? `links:\n${lp.join("\n")}` : `links: {}`;

  // Preserve fields that the editor form doesn't expose — these come
  // from the cohort-surface clone (editDraft is a deep copy of the
  // baseline record), and should never be wiped just because the user
  // updated their name. Covers every surface_field from schema.yml's
  // people block.
  const extras = [];
  if (draft.email) extras.push(`email: ${quoteYaml(draft.email)}`);
  if (draft.dates_start) extras.push(`dates_start: ${draft.dates_start}`);
  if (draft.dates_end)   extras.push(`dates_end: ${draft.dates_end}`);
  if (Array.isArray(draft.secondary_teams) && draft.secondary_teams.length) {
    extras.push(`secondary_teams:\n${draft.secondary_teams.map(t => `  - ${t}`).join("\n")}`);
  }
  if (Array.isArray(draft.absences) && draft.absences.length) {
    const lines = draft.absences.map(a => {
      const parts = [`    start: ${a.start}`, `    end: ${a.end}`];
      if (a.note) parts.push(`    note: ${quoteYaml(a.note)}`);
      return `  -\n${parts.join("\n")}`;
    });
    extras.push(`absences:\n${lines.join("\n")}`);
  }
  if (Array.isArray(draft.skills) && draft.skills.length) {
    extras.push(`skills:\n${draft.skills.map(s => `  - ${quoteYaml(s)}`).join("\n")}`);
  }
  if (Array.isArray(draft.skill_areas) && draft.skill_areas.length) {
    extras.push(`skill_areas:\n${draft.skill_areas.map(s => `  - ${s}`).join("\n")}`);
  }
  if (Array.isArray(draft.seeking) && draft.seeking.length) {
    extras.push(`seeking:\n${draft.seeking.map(s => `  - ${quoteYaml(s)}`).join("\n")}`);
  }
  if (Array.isArray(draft.offering) && draft.offering.length) {
    extras.push(`offering:\n${draft.offering.map(s => `  - ${quoteYaml(s)}`).join("\n")}`);
  }
  if (Array.isArray(draft.pair_with) && draft.pair_with.length) {
    extras.push(`pair_with:\n${draft.pair_with.map(s => `  - ${s}`).join("\n")}`);
  } else if (typeof draft.pair_with === "string" && draft.pair_with) {
    extras.push(`pair_with: ${quoteYaml(draft.pair_with)}`);
  }
  if (draft.now) extras.push(`now: ${yamlScalar(draft.now)}`);
  const extrasBlock = extras.length ? `\n${extras.join("\n")}` : "";

  const bodyContent = body != null && body.trim() ? body : `\n## bio\n\n(write a short bio here — what you're building, what you're into, what you'd be a good thought partner on)\n`;
  return `---
record_id: ${slug}
record_type: person
schema_version: 1
name: ${quoteYaml(draft.name || "")}
team: ${draft.team || "null"}
role: ${quoteYaml(draft.role || "")}
geo: ${quoteYaml(draft.geo || "")}
domain: ${draft.domain || "null"}${extrasBlock}
${linksBlock}
comm_style: ${yamlScalar(draft.comm_style)}
contribute_interests: ${yamlScalar(draft.contribute_interests)}
availability_pref: ${yamlScalar(draft.availability_pref)}
weekly_intention: ${yamlScalar(draft.weekly_intention)}
dietary_restrictions: ${yamlScalar(draft.dietary_restrictions)}
---
${bodyContent}`;
}

// Fetch the markdown body (everything after the frontmatter) of a cohort
// record straight from raw.githubusercontent.com. Used by the EDIT flow
// so we can rebuild the whole file with mutated frontmatter while
// preserving the user's prose. Returns `null` on any failure — the
// caller falls back to the default placeholder body.
async function fetchExistingBody(path) {
  const url = `https://raw.githubusercontent.com/dmarzzz/shape-rotator-os/main/${path}?ts=${Date.now()}`;
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    const text = await r.text();
    // Split at the second `---` line. The first opens the frontmatter,
    // the second closes it; everything that follows is the body.
    const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return null;
    return m[1];
  } catch { return null; }
}

// Compute the diff between the in-progress draft and the loaded
// baseline. Returns a list of { path, before, after } for any field
// whose final value differs. Used to render the "what to change"
// panel for /edit/ submissions.
function computeFieldDiff(baseline, draft, fields) {
  const out = [];
  for (const f of fields) {
    const before = getNested(baseline, f.key);
    const after  = getNested(draft, f.key);
    const same = before == null && after == null
      ? true
      : (before === after) || (String(before ?? "") === String(after ?? ""));
    if (!same) out.push({ path: f.key, before, after, label: f.label });
  }
  return out;
}

// Render a YAML patch — just the changed fields, ready to paste
// into github's web editor. For nested keys we group under the
// parent (links: { github: …, x: … }).
function buildYamlPatch(diff) {
  const flat = {};
  const nested = {};
  for (const d of diff) {
    if (d.path.includes(".")) {
      const [parent, child] = d.path.split(".");
      nested[parent] = nested[parent] || {};
      nested[parent][child] = d.after;
    } else {
      flat[d.path] = d.after;
    }
  }
  const lines = [];
  for (const [k, v] of Object.entries(flat)) {
    // Top-level key — block-scalar continuation indents 2 spaces.
    lines.push(`${k}: ${formatYamlValue(v, 2)}`);
  }
  for (const [parent, kids] of Object.entries(nested)) {
    lines.push(`${parent}:`);
    for (const [k, v] of Object.entries(kids)) {
      // Nested under `parent:` — continuation indents 4 spaces.
      lines.push(`  ${k}: ${formatYamlValue(v, 4)}`);
    }
  }
  return lines.join("\n");
}
function formatYamlValue(v, indent = 2) {
  if (v == null || v === "") return "null";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return String(v);
  // String. Multiline → block scalar; single-line → quoted.
  return yamlScalar(v, indent);
}

// Try the swf-node /sync/local_record path first. Returns:
//   { routed: "sync", envelope }  — local-write succeeded, peers will pick it up
//   { routed: "fallback", reason } — swf-node unreachable / no token / explicit
//                                    fallback signal; caller continues to gh PR
// On a hard sync error (e.g. 409 author conflict, 413 too large) we still
// route to fallback rather than blocking the user — the github PR path
// is always a viable escape hatch in the cohort program's trust model.
async function trySyncWriteForCurrentEdit() {
  const p = state.profile;
  const isAdd = p.editMode === "add";
  const slug = isAdd ? draftSlug(p) : p.editTargetId;
  if (!slug) return { routed: "fallback", reason: "no_slug" };

  // Phase 2 ships envelope kind=person. Team / project edits keep using
  // the github PR path until Phase 3 adds those kinds.
  if (p.editKind !== "person") return { routed: "fallback", reason: "kind_unsupported" };

  // Skip the network probe entirely if cohort-source already knows sync
  // is unreachable — saves a 5s timeout on every submit when swf-node is
  // down.
  if (!isSyncAvailable()) return { routed: "fallback", reason: "sync_unavailable" };

  // Determine prev_hash from the manifest if we can — defensive against
  // a concurrent edit from another device. Optional per sync-client.js;
  // the daemon will compute it from its chain when omitted.
  let prevHash = null;
  try {
    const m = await getManifest();
    if (m.ok) {
      const meta = m.manifest?.records?.[slug];
      if (meta?.latest_content_hash) prevHash = meta.latest_content_hash;
    }
  } catch { /* not fatal — fall through with prev_hash null */ }

  // Strip the meta fields that envelopes don't carry — record_id is
  // pinned by the envelope itself, schema_version is a cohort-data
  // markdown concern, record_type is the envelope's `kind`.
  const draft = p.editDraft || {};
  const content = { ...draft };
  delete content.record_id;
  delete content.record_type;
  delete content.schema_version;

  const res = await putLocalRecord({
    record_id: slug,
    record_type: "person",
    content,
    prev_hash: prevHash,
  });
  if (!res.ok) return { routed: "fallback", reason: res.reason || "post_failed", body: res.body };
  return { routed: "sync", envelope: res.envelope, recordId: slug };
}

// Stamp the freshly-signed envelope into the in-memory cohort surface
// so the canvas re-renders immediately (no waiting on the 30s tick).
function applyEnvelopeToCohort(envelope, recordId, kind) {
  if (!envelope || !envelope.content) return;
  const cohort = state.cohort;
  if (!cohort) return;
  const listKey = kind === "person" ? "people" : null;
  if (!listKey) return;
  const arr = Array.isArray(cohort[listKey]) ? cohort[listKey] : [];
  const idx = arr.findIndex(r => r.record_id === recordId);
  const merged = { ...envelope.content, record_id: recordId, record_type: kind };
  if (idx >= 0) arr[idx] = merged;
  else arr.push(merged);
  cohort[listKey] = arr;
}

// ─── profile-sync diagnostic logger ────────────────────────────────────
// Verbose by design — profile sync is where users most often need a quick
// wire-level read. Lands in DevTools (SRWK_DEVTOOLS=1) and is dumped into
// the "copy diagnostics" payload from the error result panel.
const _profileSyncLog = [];
function psLog(level, ...args) {
  const ts = new Date().toISOString();
  _profileSyncLog.push({ ts, level, args });
  if (_profileSyncLog.length > 200) _profileSyncLog.splice(0, _profileSyncLog.length - 200);
  // eslint-disable-next-line no-console
  (console[level] || console.log)("[profile-sync]", ...args);
}

// Translate a trySyncWriteForCurrentEdit failure into something a human
// can read. Headline gets the in-app line; body gets the daemon's actual
// response payload (if any) for the diagnostics dump.
function describeSyncFailure(synced) {
  const r = synced.reason || "unknown";
  let headline;
  switch (r) {
    case "no_token":           headline = "no agent token — swf-node hasn't shared its auth token with the renderer yet"; break;
    case "no_cohort_keys":     headline = "swf-node has no cohort signing keys bootstrapped (POST /sync/local_record → 503)"; break;
    case "sync_unavailable":   headline = "swf-node not reachable on 127.0.0.1:7777"; break;
    case "unauthorized":       headline = "swf-node rejected the agent token (401) even after a refresh"; break;
    case "no_slug":            headline = "no record_id could be determined from the draft (no github username, no name)"; break;
    case "kind_unsupported":   headline = `local sync is person-only in Phase 2 — this draft is a ${state.profile?.editKind || "?"}`; break;
    case "bad_request":        headline = `client-side validation: ${synced.error || "unknown"}`; break;
    case "conflict":           headline = "swf-node rejected the write as a chain conflict (409) — another device may have written first; reload + retry"; break;
    case "envelope_too_large": headline = "swf-node rejected the envelope as too large (413) — trim the draft and retry"; break;
    case "not_found":          headline = "swf-node returned 404 — the local_record route may be missing on this swf-node version"; break;
    case "server_error":       headline = `swf-node returned a 5xx (${synced.status ?? "?"}) — daemon-side error; check swf-node logs`; break;
    case "http_error":         headline = `swf-node returned HTTP ${synced.status ?? "?"} — see daemon response body`; break;
    case "malformed":          headline = "swf-node returned 200 but the response shape wasn't recognized (expected { envelope: … })"; break;
    case "timeout":            headline = "POST /sync/local_record timed out — swf-node didn't respond within the request budget"; break;
    case "network":            headline = `network error talking to swf-node — ${synced.error || "fetch failed"}`; break;
    case "post_failed":
    default:                   headline = `POST /sync/local_record returned status ${synced.status ?? "?"} (reason: ${r})`;
  }
  let body = "";
  if (synced.body && typeof synced.body === "object")  body = JSON.stringify(synced.body, null, 2);
  else if (synced.body)                                body = String(synced.body);
  return { headline, body };
}

// ─── propagation watch ────────────────────────────────────────────────
// After a successful local-sync the user had no signal that the LAN
// actually picked up the change. Capture /node/log's max seq right
// before the POST; at +30s and +60s, re-query for events since save
// and surface a one-line status (peer manifest fetches, pulls, applied,
// reachable). Not a strict proof of propagation — swf-node's view of
// peers is partial — but enough to distinguish "wire is alive" from
// "wire is dead".
async function captureCurrentLogSeq() {
  try {
    const r = await getNodeLog({ sinceSeq: 0, limit: 1 });
    if (!r.ok || !r.log || !Array.isArray(r.log.events)) return null;
    const evs = r.log.events;
    if (!evs.length) return null;
    const last = evs[evs.length - 1];
    return last && typeof last.seq === "number" ? last.seq : null;
  } catch { return null; }
}

const PEER_KINDS = new Set([
  "manifest_fetched", "pulled", "applied_local",
  "peer_reachable", "peer_unreachable",
]);

async function pollPropagation(statusEl, sinceSeq, label) {
  if (!statusEl) return;
  try {
    const r = await getNodeLog({ sinceSeq: sinceSeq ?? 0, limit: 200 });
    if (!r.ok || !r.log || !Array.isArray(r.log.events)) {
      statusEl.innerHTML = `propagation watch (<strong>${escHtml(label)}</strong>): /node/log unavailable`;
      return;
    }
    const evs = r.log.events;
    const total = evs.length;
    const peerEvs = evs.filter(e => PEER_KINDS.has(e.kind));
    const fetched = peerEvs.filter(e => e.kind === "manifest_fetched").length;
    const pulled  = peerEvs.filter(e => e.kind === "pulled").length;
    const applied = peerEvs.filter(e => e.kind === "applied_local").length;
    const reach   = peerEvs.filter(e => e.kind === "peer_reachable").length;
    statusEl.innerHTML = `propagation <strong>${escHtml(label)}</strong>: ${total} wire event${total === 1 ? "" : "s"} since save · ${fetched} peer manifest fetch${fetched === 1 ? "" : "es"} · ${pulled} pull${pulled === 1 ? "" : "s"} · ${applied} applied · ${reach} peer-reachable`;
    psLog("info", "propagation poll", { label, sinceSeq, total, fetched, pulled, applied, reach });
  } catch (e) {
    statusEl.innerHTML = `propagation watch (<strong>${escHtml(label)}</strong>): error reading /node/log`;
    psLog("warn", "propagation poll failed", String(e));
  }
}

async function submitEditAsLocalSync() {
  const result = document.getElementById("alch-submit-pr-result");
  if (!result) return;
  const p = state.profile;

  psLog("info", "submitEditAsLocalSync click", {
    editMode: p.editMode,
    editKind: p.editKind,
    editTargetId: p.editTargetId,
    draftSlug: draftSlug(p),
    syncAvailable: isSyncAvailable(),
    draftKeys: Object.keys(p.editDraft || {}),
  });

  if (p.editKind !== "person") {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">unsupported</span> <span>local sync is person-only in Phase 2 (this draft is a ${escHtml(p.editKind)}). use <strong>save · open github PR</strong>.</span></div>`;
    return;
  }

  result.hidden = false;
  result.dataset.kind = "loading";
  result.innerHTML = `<div class="aspr-line"><span class="aspr-tag">saving</span> <span>posting to local swf-node…</span></div>`;

  // Capture the /node/log frontier BEFORE the POST so the post-save
  // propagation watch can count events that fired since the save (rather
  // than the entire log buffer).
  const preSaveSeq = await captureCurrentLogSeq();
  psLog("info", "captured pre-save log seq", { seq: preSaveSeq });

  const synced = await trySyncWriteForCurrentEdit();
  psLog("info", "trySyncWriteForCurrentEdit returned", synced);

  if (synced.routed === "sync") {
    const recordId = synced.recordId;
    applyEnvelopeToCohort(synced.envelope, recordId, "person");
    // Snap the editor's baseline to the new content so a follow-up EDIT
    // diffs from the just-saved state.
    if (p.editMode === "edit") {
      p.editBaseline = JSON.parse(JSON.stringify(p.editDraft));
    }
    toast({ kind: "success", title: "profile saved locally", message: "syncing to peers on the next tick (~30s)" });
    result.dataset.kind = "success";
    result.innerHTML = `
      <div class="aspr-line"><span class="aspr-tag">saved · local</span> <span>your edit is on this swf-node. LAN peers will pull it on the next ~30s tick.</span></div>
      <div class="aspr-line aspr-aux">record: <code>${escHtml(recordId)}</code> · envelope_hash: <code>${escHtml(synced.envelope?.content_hash || "—")}</code></div>
      <div class="aspr-line aspr-aux" id="aspr-prop-status">propagation watch: starting (+30s, +60s polls)…</div>
    `;
    // Schedule propagation watches. Best-effort signal: counts peer-side
    // sync events that fire in the window after save.
    const statusEl = result.querySelector("#aspr-prop-status");
    setTimeout(() => { pollPropagation(statusEl, preSaveSeq, "+30s"); }, 30000);
    setTimeout(() => { pollPropagation(statusEl, preSaveSeq, "+60s"); }, 60000);
    renderProfile();
    wireProfileForm();
    return;
  }

  // Failure. Do NOT fall back — the github button is sitting right next to
  // this one for the user to decide. Surface the daemon's actual reason +
  // any response body in a copyable diagnostic.
  const detail = describeSyncFailure(synced);
  psLog("warn", "sync failed — surfacing to user (no auto-fallback)", { reason: synced.reason, status: synced.status, body: synced.body });
  result.dataset.kind = "error";
  result.innerHTML = `
    <div class="aspr-line"><span class="aspr-tag aspr-tag-warn">local sync failed</span> <span>${escHtml(detail.headline)}</span></div>
    ${detail.body ? `<div class="aspr-line aspr-aux"><pre class="aspr-debug">${escHtml(detail.body)}</pre></div>` : ""}
    <div class="aspr-line aspr-aux">
      <button type="button" class="alch-feed-btn aspr-copy-log">copy diagnostics</button>
      <span class="aspr-aux">or click <strong>save · open github PR</strong> for the durable path.</span>
    </div>
  `;
  const copyBtn = result.querySelector(".aspr-copy-log");
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    // Gather a self-contained snapshot for triage: app version, daemon
    // reachability, the failed call's full inputs/outputs, and the last
    // 50 /node/log events so reviewers can see what the wire was doing
    // around the failure. Best-effort — each lookup may itself fail and
    // we surface that as null, never blocking the dump.
    let appInfo = null;
    try { appInfo = await (window.api?.getAppInfo?.() ?? null); } catch (e) { appInfo = { error: String(e) }; }
    let recentLog = null;
    try {
      const r = await getNodeLog({ sinceSeq: 0, limit: 50 });
      recentLog = r.ok ? { count: r.log?.events?.length ?? 0, events: r.log?.events ?? [] } : { error: r.reason || "log_unavailable" };
    } catch (e) { recentLog = { error: String(e) }; }
    let manifestSummary = null;
    try {
      const m = await getManifest();
      if (m.ok) {
        const recs = Object.keys(m.manifest?.records || {});
        manifestSummary = { record_count: recs.length, record_ids: recs.slice(0, 20) };
      } else {
        manifestSummary = { error: m.reason || "manifest_unavailable" };
      }
    } catch (e) { manifestSummary = { error: String(e) }; }
    const payload = {
      timestamp: new Date().toISOString(),
      app: appInfo,
      sync_available: isSyncAvailable(),
      edit: {
        mode: p.editMode,
        kind: p.editKind,
        target_id: p.editTargetId,
        draft_keys: Object.keys(p.editDraft || {}),
      },
      result: synced,
      manifest_summary: manifestSummary,
      recent_node_log: recentLog,
      log_tail: _profileSyncLog.slice(-40),
    };
    const blob = JSON.stringify(payload, null, 2);
    try {
      await navigator.clipboard.writeText(blob);
      toast({ kind: "info", title: "diagnostics copied", message: `${blob.length} bytes — paste anywhere to debug` });
    } catch (e) {
      psLog("warn", "clipboard write failed", String(e));
      toast({ kind: "warn", title: "copy failed", message: "see DevTools console for the dump" });
      console.log("[profile-sync] diagnostics dump:\n" + blob);
    }
  });
}

async function submitEditAsGithubPR() {
  const result = document.getElementById("alch-submit-pr-result");
  if (!result) return;
  psLog("info", "submitEditAsGithubPR click", {
    editMode: state.profile.editMode,
    editKind: state.profile.editKind,
    editTargetId: state.profile.editTargetId,
  });
  await runGithubPRFlow(result);
}

// ─── github PR launcher — extracted from the old submitEditAsPR ───────
// ADD → github /new/ URL with prefilled content. EDIT → rebuild full
// markdown (mutated frontmatter + preserved body fetched from raw) and
// route through /new/?value= so github forces "create new branch +
// propose changes". Pure UI flow — no swf-node side effects.
async function runGithubPRFlow(result) {
  const p = state.profile;
  if (p.editMode === "add") {
    const slug = draftSlug(p);
    if (!slug) {
      result.hidden = false;
      result.dataset.kind = "error";
      const hint = p.editKind === "person"
        ? "fill in either name or github username, then submit."
        : `fill in the ${p.editKind} name, then submit.`;
      result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">need a name</span> <span>${escHtml(hint)}</span></div>`;
      return;
    }
    // Stamp slug into draft so the markdown reflects it.
    p.editDraft.record_id = slug;
    const folder = p.editKind === "person" ? "people" : "teams";
    const filename = `cohort-data/${folder}/${slug}.md`;
    const content = p.editKind === "person"
      ? buildPersonMarkdown(p.editDraft, slug)
      : buildTeamMarkdown(p.editDraft, slug, p.editKind);

    const launched = await launchPRFlow({ kind: "new", path: filename, value: content });
    if (!launched.ok) {
      result.hidden = false;
      result.dataset.kind = "needs-fork";
      result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">fork first</span> <span>create your fork (one click — modal is open), then click submit again. your draft is preserved.</span></div>`;
      return;
    }
    const url = launched.url;
    result.hidden = false;
    result.dataset.kind = "success";
    result.innerHTML = `
      <div class="aspr-line"><span class="aspr-tag">github opened</span> <span>review → <strong>commit new file</strong> → github prompts you to open a PR</span></div>
      <div class="aspr-line"><span class="aspr-aux">file:</span> <code>${escHtml(filename)}</code></div>
      <div class="aspr-line">
        <button type="button" class="alch-feed-btn aspr-reopen">reopen editor</button>
      </div>
    `;
    const reopen = result.querySelector(".aspr-reopen");
    if (reopen) reopen.addEventListener("click", () => { try { window.api?.openExternal?.(url); } catch {} });
    return;
  }

  // EDIT mode. We used to send the user to GitHub's /edit/ URL which
  // shows the existing file — meaning the user had to manually re-apply
  // their in-app edits in GitHub's web editor. Now we rebuild the full
  // markdown (mutated frontmatter + preserved body fetched from raw)
  // and route through GitHub's /new/?value= URL. Because the file
  // already exists on main, GitHub forces "create new branch + propose
  // changes" — no accidental commits to main, no manual YAML editing.
  const slug = p.editTargetId;
  if (!slug) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">no record picked</span> <span>pick a ${escHtml(p.editKind)} above first.</span></div>`;
    return;
  }
  const fields = (p.editKind === "person") ? PERSON_EDITABLE_FIELDS : teamFieldsFor(p.editKind);
  const folder = (p.editKind === "person") ? "people" : "teams";
  const filename = `cohort-data/${folder}/${slug}.md`;
  const diff = computeFieldDiff(p.editBaseline || {}, p.editDraft || {}, fields);
  if (diff.length === 0) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">no changes</span> <span>edit any field above first.</span></div>`;
    return;
  }

  // Painty loading state while we fetch the raw body. The fetch is fast
  // (~200ms) but worth surfacing so the click doesn't feel dead.
  result.hidden = false;
  result.dataset.kind = "loading";
  result.innerHTML = `<div class="aspr-line"><span class="aspr-tag">preparing</span> <span>building your updated file…</span></div>`;

  const existingBody = await fetchExistingBody(filename);
  const content = p.editKind === "person"
    ? buildPersonMarkdown(p.editDraft, slug, existingBody)
    : buildTeamMarkdown(p.editDraft, slug, p.editKind, existingBody);

  const launched = await launchPRFlow({ kind: "new", path: filename, value: content });
  if (!launched.ok) {
    result.hidden = false;
    result.dataset.kind = "needs-fork";
    result.innerHTML = `<div class="aspr-line"><span class="aspr-tag aspr-tag-warn">fork first</span> <span>create your fork (one click — modal is open), then click submit again. your draft is preserved.</span></div>`;
    return;
  }
  const editUrl = launched.url;

  const diffRows = diff.map(d => `
    <div class="aspr-diff-row">
      <span class="aspr-diff-key">${escHtml(d.label)}</span>
      <span class="aspr-diff-before">${escHtml(formatDiffValue(d.before))}</span>
      <span class="aspr-diff-arrow" aria-hidden="true">→</span>
      <span class="aspr-diff-after">${escHtml(formatDiffValue(d.after))}</span>
    </div>
  `).join("");
  result.hidden = false;
  result.dataset.kind = "diff";
  result.innerHTML = `
    <div class="aspr-line"><span class="aspr-tag">github opened</span> <span>your edits are pre-filled. on github: <strong>commit changes</strong> → <strong>propose changes</strong> → <strong>create pull request</strong>.</span></div>
    <div class="aspr-diff">${diffRows}</div>
    <div class="aspr-line aspr-aux">file: <code>${escHtml(filename)}</code> · steward merges → next cohort sync (~5 min) ships your change.</div>
    <div class="aspr-line">
      <button type="button" class="alch-feed-btn aspr-reopen">reopen editor</button>
    </div>
  `;
  const reopen = result.querySelector(".aspr-reopen");
  if (reopen) reopen.addEventListener("click", () => { try { window.api?.openExternal?.(editUrl); } catch {} });
}

function formatDiffValue(v) {
  if (v == null) return "—";
  if (v === "") return '""';
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// escAttr lives in @shape-rotator/shape-ui now (imported at the top).
