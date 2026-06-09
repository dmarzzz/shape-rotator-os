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
  escHtml, escAttr, normalizeLinkHref, normalizeGithubAccount,
  buildEditPRUrl,
  teamCardHtml, personCardHtml,
  buildCalendarRows, drawCalendar,
  renderWeekView as renderCalendarWeekView,
  loadCalendar as loadCalendarData,
  currentWeekIdx as calendarCurrentWeekIdx,
  parseWeekRow as calendarParseWeekRow,
  attachWeekViewBehavior as attachCalendarMobileBehavior,
  exportWeekPng as exportCalendarWeekPng,
} from "@shape-rotator/shape-ui";
import {
  aggregateSkillAreas, buildCohortIndex, buildCollabModel, collabAffKey, collabHasText,
  dependencyPairKey, dependencySafeToken,
  constellationDependencyEdges, constellationIndegree, constellationModel, teamKind, teamsOfKind,
} from "./cohort-relations.js";
import {
  contextRawScriptById as findContextRawScriptById,
  contextSourceById as findContextSourceById,
} from "./context-vault-model.js";
import { getCohortSurface, subscribeToCohortChanges, isSyncAvailable } from "./cohort-source.js";
import { getCohortTimeline } from "./cohort-timeline.js";
import { resolvePRForCurrentUser, clearForkCache } from "./gh-fork.js";
import { enrichPeople } from "./gh-user.js";
import { putLocalRecord, getRecord, getHealth, getManifest, getNodeLog } from "./sync-client.js";
import { toast } from "./ux.js";
import { getTheme, toggleTheme } from "./theme.js";
import { getIdentity } from "./identity.js";
import {
  askAgeLabel, askIsCurrent, askIsOpen, askStatus, askTopic, asksWithStatus,
  isAskMine, normalizeAskIdentity, resolveAskAuthor, resolveAskIdentityPerson,
  askVerbVars, askVerbIconSvg,
} from "./asks.js";
// Membrane mode — 2026-05 redesign. Pressurized-membrane object that replaces
// the 7-rail nav with a 4-blob constellation. Lives behind data-alch-mode
// "membrane" so the legacy modes stay reachable while we evaluate.
import { mountMembrane } from "./membrane/index.js";
import { CALENDAR_TRANSCRIPT_MATCHES } from "../content/context/calendar-transcript-matches.js";
import { renderIntel, wireIntel } from "./intel/intel.js";

const ALCHEMY_LS_KEY  = "srwk:alchemy_mode";
const CONST_MODE_LS_KEY = "srwk:const_mode";  // constellation sub-view: "map" | "ring" | "journey" | "stack"
const CONST_SCOPE_LS_KEY = "srwk:const_scope"; // network scope: "projects" | "people"
const CONST_LENS_LS_KEY = "srwk:const_lens";  // map lens: "all" | "relies" | "works" | "substrate"
const CONST_INTEREST_LS_KEY = "srwk:const_interest"; // source-backed ecosystem view: cluster record_id | "all"
const PROFILE_LS_KEY  = "srwk:profile_v1";
const EVENTS_LS_KEY   = "srwk:cohort_events_v1";
const DETAIL_LS_KEY   = "srwk:alchemy_detail_v1";
const CONSTELLATION_TIMELINE_LS_KEY = "srwk:constellation_timeline_idx_v1";
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
// `collab` is hidden from the rail and represented as a Constellation
// sub-view, but remains routeable as a saved-mode/external-jump alias.
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
  collabLens: "all",               // "all" | "deps" | "needs" — matrix emphasis in the collab board
  collabTeamFilter: "all",         // "all" | "needs" | "offers" — which teams are visible in the collab matrix
  collabSort: "cluster",           // "cluster" | "intro" | "dependency" — ordering for the collab matrix
  collabSelection: null,           // { type: "team"|"pair"|"cluster", ... } — pinned inspector state
  renderToken: 0,                  // invalidates pending cross-fade swaps when a newer render starts
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
  cohortTimeline: null,         // generated timeline read model; snapshots carry public cohort surfaces
  cohortTimelineLoading: false,
  cohortTimelineError: "",
  constellationTimelineIdx: null,  // selected snapshot index within cohortTimeline.snapshots
  constellationShowDelta: false,
  constellationDrawerRecordId: null,
  profile: null,       // local-only: { user, editor state, ... }
  programPage: null,   // active program-handbook page slug (overview | success | rules | schedule)
  atlasFocus: null,    // active tag in the atlas view (null = whole-graph mode)
  onboardingJustToggled: null,  // step key that was just marked/unmarked done; consumed by wireOnboarding to scroll-into-view the next step
  openAskComposer: false, // one-shot landing state when membrane sends someone to post
  constellationMode: "map",   // top-level constellation view: "map" | "ring" | "journey" | "stack"
  constellationScope: "projects", // network entity layer: projects/teams vs people-to-project membership
  constellationLens: "all",   // map line lens: "all" | "relies" | "works" | "substrate" — changes which relationship claim is foregrounded
  constInterest: "all",       // map ecosystem focus: "all" or a cluster record_id from cohort-data/clusters
  constSelection: null,       // persistent constellation inspector selection: { type:"team"|"person", rid } | { type:"edge", from, to }
  renderSeq: 0,               // monotonic render guard; stale delayed swaps must not overwrite the latest view
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
  // The rail now lives in the persistent #primary-nav (2026-06), outside
  // this view's container — find it globally rather than within `container`.
  state.rail = document.querySelector(".alchemy-rail");
  if (!state.canvas || !state.rail) return;

  try {
    const saved = localStorage.getItem(ALCHEMY_LS_KEY);
    if (saved === "collab") {
      state.mode = "constellation";
      state.constellationMode = "collab";
    } else if (saved && ALCHEMY_MODES.includes(saved)) {
      state.mode = saved;
    }
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
    const timelineIdxRaw = localStorage.getItem(CONSTELLATION_TIMELINE_LS_KEY);
    if (timelineIdxRaw != null && timelineIdxRaw !== "") {
      const timelineIdx = Number(timelineIdxRaw);
      if (Number.isFinite(timelineIdx)) state.constellationTimelineIdx = timelineIdx;
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
    if (e.target.closest('.nav-cat[data-tab="alchemy"]')) return;
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
  loadCohortTimeline().then(() => {
    if (state.mounted && (state.mode === "constellation" || state.detailReturnMode === "constellation")) render();
  }).catch(() => {});
  state.unsubscribe = subscribeToCohortChanges(() => {
    loadCohort().then(() => render({ instant: true })).catch(() => {});
  });
  state.mounted = true;
}

export function setActive(v) {
  state.active = !!v;
}

export function notifyDataChanged() {
  if (!state.mounted) return;
  loadCohort().then(() => render({ instant: true })).catch(() => {});
}

// ─── tab-system bridge ────────────────────────────────────────────────
// The tab manager (tabs.js) drives the OS into a specific location and
// reads back the current one. A "location" inside the OS tab is just a
// mode plus an optional open record-detail id.
export function getLocation() {
  return { mode: state.mode, recordId: state.detailRecordId || null };
}

// Apply a location: set the mode (and optionally open a record detail),
// persist it the same way the in-app handlers do, then repaint. Safe to
// call before mount — it primes localStorage so the lazy mount lands here.
export function applyLocation(loc = {}) {
  const mode = ALCHEMY_MODES.includes(loc.mode) ? loc.mode : state.mode;
  if (loc.recordId) {
    state.mode = mode;
    state.detailReturnMode = mode;
    state.detailRecordId = String(loc.recordId);
    try {
      localStorage.setItem(ALCHEMY_LS_KEY, mode);
      localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({ recordId: state.detailRecordId, returnMode: mode }));
    } catch {}
  } else {
    state.mode = mode;
    state.detailRecordId = null;
    state.detailReturnMode = null;
    try {
      localStorage.setItem(ALCHEMY_LS_KEY, mode);
      localStorage.removeItem(DETAIL_LS_KEY);
    } catch {}
  }
  if (state.mounted) {
    syncRailSelection();
    render({ instant: !!loc.instant });
  }
}

// Human-readable title for a record id (team or person), for tab labels.
export function getRecordTitle(recordId) {
  if (!recordId) return null;
  try {
    const idx = buildCohortIndex(state.cohort);
    const team = idx.teamById.get(String(recordId));
    if (team) return team.name || String(recordId);
    const person = idx.personById.get(String(recordId));
    if (person) return person.name || String(recordId);
  } catch {}
  return String(recordId);
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

async function loadCohortTimeline() {
  if (state.cohortTimeline || state.cohortTimelineLoading) return;
  state.cohortTimelineLoading = true;
  try {
    state.cohortTimeline = await getCohortTimeline();
    state.cohortTimelineError = "";
    ensureConstellationTimelineIdx();
  } catch (err) {
    console.warn("[alchemy] cohort timeline load failed:", err?.message || err);
    state.cohortTimelineError = err?.message || String(err);
  } finally {
    state.cohortTimelineLoading = false;
  }
}

function constellationSnapshots() {
  return Array.isArray(state.cohortTimeline?.snapshots) ? state.cohortTimeline.snapshots : [];
}

function ensureConstellationTimelineIdx() {
  const snapshots = constellationSnapshots();
  if (!snapshots.length) {
    state.constellationTimelineIdx = null;
    return null;
  }
  let idx = Number.isFinite(state.constellationTimelineIdx)
    ? Math.round(state.constellationTimelineIdx)
    : snapshots.length - 1;
  idx = Math.max(0, Math.min(snapshots.length - 1, idx));
  state.constellationTimelineIdx = idx;
  return idx;
}

function activeConstellationSnapshot() {
  const snapshots = constellationSnapshots();
  const idx = ensureConstellationTimelineIdx();
  return idx == null ? null : snapshots[idx];
}

function activeConstellationCohort() {
  return activeConstellationSnapshot()?.surface || state.cohort;
}

function previousConstellationSnapshot() {
  const snapshots = constellationSnapshots();
  const idx = ensureConstellationTimelineIdx();
  if (idx == null || idx <= 0) return null;
  return snapshots[idx - 1] || null;
}

function activeDetailCohort() {
  return state.detailReturnMode === "constellation" ? activeConstellationCohort() : state.cohort;
}

function syncRailSelection() {
  if (!state.rail) return;
  const activeMode = state.mode === "collab" ? "constellation" : state.mode;
  for (const btn of state.rail.querySelectorAll(".alchemy-rail-btn")) {
    btn.setAttribute("aria-selected", btn.dataset.alchMode === activeMode ? "true" : "false");
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
  const tab = document.querySelector('.nav-cat[data-tab="alchemy"]');
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

function render(opts = {}) {
  if (!state.canvas || !state.cohort) return;
  // Monotonic render guard — a delayed cross-fade swap must not overwrite a
  // newer view if the user switched tabs during the 220ms timeout.
  const renderSeq = ++state.renderSeq;
  // Reflect current mode on the alchemy-view container so scoped CSS
  // (membrane.css especially) can target the right surface.
  if (state.container) {
    state.container.dataset.alchModeCurrent = state.mode;
    // Mirror the open record-detail id so the tab system can observe
    // navigation changes via a MutationObserver (no event plumbing).
    state.container.dataset.alchDetail = state.detailRecordId || "";
    if (!isMembraneHome()) state.menuOpen = false;
    syncMembraneMenuChrome();
  }
  const canvas = state.canvas;
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
  // Instant path — no cross-fade. Used for tab switches + data refreshes so
  // they feel immediate (browser-like) instead of a "reload".
  if (opts.instant) {
    canvas.classList.remove("is-leaving", "is-entering");
    renderModeContent();
    return;
  }
  // Animated cross-fade: leave → swap → enter (~440ms total).
  canvas.classList.remove("is-entering");
  canvas.classList.add("is-leaving");
  setTimeout(() => {
    if (renderSeq !== state.renderSeq || canvas !== state.canvas) return;
    canvas.classList.add("is-entering");
    canvas.classList.remove("is-leaving");
    renderModeContent();
    const clearEntering = () => canvas.classList.remove("is-entering");
    requestAnimationFrame(clearEntering);
    setTimeout(clearEntering, 80);
  }, 220);
}

// The actual content swap — mode dispatch + per-mode wiring + WebGL mount.
// Split out of render() so it can run either inside the cross-fade or
// synchronously (instant) for tab switches.
function renderModeContent() {
  const canvas = state.canvas;
  if (!canvas) return;
  const renderLabel = state.detailRecordId ? `detail:${state.detailRecordId}` : state.mode;
  try {
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
    // Index cards for the staggered entrance.
    const cards = canvas.querySelectorAll(".alch-card, .alch-legend-card, .alch-feed-item");
    cards.forEach((c, i) => c.style.setProperty("--alch-i", String(i)));
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
    }
    // Mount shape shaders LAST — every <canvas data-shape-fam> emitted by the
    // renderers above gets one WebGL2 context here.
    mountAllShapes();
  } catch (err) {
    console.error(`[alchemy] render failed for ${renderLabel}:`, err);
    canvas.innerHTML = `<p class="alch-callout"><strong>${escHtml(renderLabel)} failed to render</strong><br/>${escHtml(err?.message || String(err))}</p>`;
  }
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

function membraneText(value) {
  if (Array.isArray(value)) return value.map(membraneText).filter(Boolean).join("; ");
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

function membraneFirstText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const found = value.map(membraneText).find(Boolean);
      if (found) return found;
    } else {
      const text = membraneText(value);
      if (text) return text;
    }
  }
  return "";
}

function membraneLowerFirst(text) {
  const s = String(text || "");
  return s ? s[0].toLowerCase() + s.slice(1) : s;
}

function membraneEntity(record, kind = "team") {
  if (!record?.record_id) return null;
  const label = record.name || record.display_name || record.handle || record.record_id;
  return { id: record.record_id, kind, label };
}

function membraneMergeEntities(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const entity of Array.isArray(group) ? group : []) {
      if (!entity?.id) continue;
      const key = `${entity.kind || ""}:${entity.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entity);
    }
  }
  return merged;
}

function membraneTrimSentence(text) {
  return membraneText(text).replace(/[.;]+$/g, "");
}

function membranePolishPhrase(text) {
  return membraneText(text)
    .replace(/\blive fire\b/ig, "live-fire")
    .replace(/\bnon technical\b/ig, "non-technical");
}

function buildMembraneSelfInference(record, team, connections = []) {
  const name = record?.name || record?.display_name || record?.handle || record?.record_id || "this person";
  const role = membraneFirstText(record?.role, record?.title, record?.role_class);
  const usefulFor = membraneFirstText(
    record?.go_to_them_for,
    record?.offering,
    record?.contribute_interests,
    record?.working_style,
    record?.recurring_themes,
    record?.skills,
    record?.skill_areas,
  );
  const usefulPhrase = usefulFor.replace(/[.;]+$/g, "");
  const arena = membraneFirstText(
    record?.recurring_themes,
    record?.skill_areas,
    record?.skills,
    team?.focus,
    record?.domain,
    team?.domain,
  ).replace(/[.;]+$/g, "");
  const bio = membraneFirstText(record?.bio, record?.description, record?.about);
  const evidence = `${role} ${usefulPhrase} ${arena} ${bio}`.toLowerCase();
  const kind = record?.record_type === "team" || record?.kind === "team" ? "team" : "person";
  const entities = [membraneEntity(record, kind), membraneEntity(team, "team")].filter(Boolean);
  const arenaPhrase = /agent/i.test(bio) && /\bcrypto\b/i.test(`${arena} ${bio}`) ? "agent/crypto" : arena;
  const usefulRead = membraneLowerFirst(membranePolishPhrase(usefulPhrase));

  let text = "";
  if (usefulPhrase && /feedback|framing|thought partner|non[-\s]?technical|product|react/i.test(evidence)) {
    text = `Route ${name} rough ${arenaPhrase ? `${arenaPhrase} ` : ""}ideas when you need ${usefulRead}.`;
  } else if (usefulPhrase && arena) {
    text = `${name} is a routing fit for ${arena}: go to them for ${usefulRead}.`;
  } else if (usefulPhrase) {
    text = `${name}'s strongest routing signal is ${usefulRead}.`;
  } else if (bio) {
    const shortBio = bio.length > 170 ? `${bio.slice(0, 155).trim()}...` : bio.replace(/[.;]+$/g, "");
    text = `${name}'s visible profile suggests this route: ${shortBio}.`;
  } else if (connections.length) {
    text = `${name}'s public surface is thin; the clearest signal is ${connections.length} declared cohort connection${connections.length === 1 ? "" : "s"}.`;
  }

  return text ? { text, entities } : null;
}

function membraneTimelineWorkSignals(record, team, timelineEvents = []) {
  const recordId = record?.record_id || "";
  const teamIds = new Set([team?.record_id, record?.team].filter(Boolean));
  const handles = new Set([
    record?.links?.github,
    record?.gh_handle,
    record?.handle,
  ].map((v) => String(v || "").toLowerCase()).filter(Boolean));

  return (Array.isArray(timelineEvents) ? timelineEvents : [])
    .filter((event) => {
      if (!event) return false;
      const actor = String(event.actor || "").toLowerCase();
      if (recordId && event.person_id === recordId) return true;
      if (actor && handles.has(actor)) return true;
      if (event.team_id && teamIds.has(event.team_id)) return true;
      return false;
    })
    .sort((a, b) => (b.at_ms || 0) - (a.at_ms || 0))
    .slice(0, 2)
    .map((event) => {
      const summary = membraneText(event.summary).replace(/[.;]+$/g, "");
      const repo = membraneText(event.repo);
      const text = summary ? `${summary}${repo ? ` on ${repo}` : ""}` : "";
      const source = event.source === "transcript" ? "transcript" : "timeline";
      return text ? { source, text, entities: [] } : null;
    })
    .filter(Boolean);
}

function buildMembraneWorkSummary(record, team, asks, askIdentity, timelineEvents = []) {
  const signals = [];
  const kind = record?.record_type === "team" || record?.kind === "team" ? "team" : "person";
  const entities = [membraneEntity(record, kind), membraneEntity(team, "team")].filter(Boolean);
  const push = (source, value, rowEntities = entities) => {
    const text = membraneText(value);
    if (text && !signals.some((row) => row.text.toLowerCase() === text.toLowerCase())) {
      signals.push({ source, text, entities: rowEntities });
    }
  };

  push("now", record?.now);
  push("intent", record?.weekly_intention);
  for (const signal of membraneTimelineWorkSignals(record, team, timelineEvents)) {
    push(signal.source, signal.text, signal.entities);
  }
  if (team?.now) push("team", `${team.name || team.record_id}: ${team.now}`);
  if (team?.weekly_goals) push("week", `${team.name || team.record_id}: ${membraneText(team.weekly_goals)}`);

  const mine = (Array.isArray(asks) ? asks : [])
    .filter((ask) => askIsOpen(ask) && isAskMine(ask, askIdentity))
    .slice(0, 2);
  for (const ask of mine) push("ask", askTopic(ask), []);

  push("offers", record?.contribute_interests);

  const now = signals.find((s) => s.source === "now")?.text?.replace(/[.;]+$/g, "");
  const intent = signals.find((s) => s.source === "intent")?.text?.replace(/[.;]+$/g, "");
  const timeline = signals.find((s) => s.source === "transcript" || s.source === "timeline")?.text?.replace(/[.;]+$/g, "");
  const teamNow = signals.find((s) => s.source === "team")?.text?.replace(/[.;]+$/g, "");
  const ask = signals.find((s) => s.source === "ask")?.text?.replace(/[.;]+$/g, "");
  const offers = signals.find((s) => s.source === "offers")?.text?.replace(/[.;]+$/g, "");

  let text = "";
  if (now && timeline) {
    text = `${now}; latest visible activity: ${membraneLowerFirst(timeline)}.`;
  } else if (timeline && intent) {
    text = `Latest visible activity: ${timeline}; stated next move: ${intent}.`;
  } else if (timeline) {
    text = `Latest visible activity: ${timeline}.`;
  } else if (now && intent) {
    text = `${now}, with ${intent} as the stated next move.`;
  } else if (now) {
    text = `${now}.`;
  } else if (intent) {
    text = `Said they would do this next: ${intent}.`;
  } else if (teamNow) {
    text = `${teamNow}.`;
  } else if (ask) {
    text = `Current visible ask: ${ask}.`;
  } else if (offers) {
    text = `No fresh work signal; closest current contribution signal is ${membraneLowerFirst(offers)}.`;
  }

  const sourceDetail = signals.slice(0, 4).map((s) => s.source).join(" + ");
  return text ? { text, source: "generated", sourceDetail, entities, signals: signals.slice(0, 5) } : null;
}

function buildMembraneSelfRead(record, team, connections, asks, askIdentity, timelineEvents = []) {
  const inference = buildMembraneSelfInference(record, team, connections);
  const work = buildMembraneWorkSummary(record, team, asks, askIdentity, timelineEvents);
  const entities = membraneMergeEntities(inference?.entities, work?.entities);
  const hasTimelineSignal = Array.isArray(work?.signals)
    && work.signals.some((signal) => signal?.source === "timeline" || signal?.source === "transcript");
  const needsCalibration = connections.length === 0 && !hasTimelineSignal;
  let text = "";

  if (inference?.text && work?.text) {
    text = `${membraneTrimSentence(inference.text)}. Current work signal: ${membraneTrimSentence(work.text)}.`;
  } else if (inference?.text) {
    text = inference.text;
  } else if (work?.text) {
    text = work.text;
  } else {
    return null;
  }

  const sourceDetail = ["routing", work?.sourceDetail].filter(Boolean).join(" + ");
  return {
    text: needsCalibration ? `Needs more signal to calibrate. Current read: ${text}` : text,
    source: "generated",
    sourceDetail,
    entities,
    tone: needsCalibration ? "uncalibrated" : "normal",
  };
}

// Cross-blob data feed. Read the cohort surface and shape it into per-blob
// stat dictionaries that the panels can render. Re-runs on every cohort
// refresh via subscribeToCohortChanges → render() chain.
function computeMembraneData() {
  const c = state.cohort || {};
  const cohortIndex = buildCohortIndex(c);
  const teams = cohortIndex.teams;
  const people = cohortIndex.people;
  // #226 relationship graph — declarations dropped during the mega-merge; restored
  // at function scope so both the if(myTeam) block and allEdges below can see them.
  const teamById = cohortIndex.teamById;
  const graphEdges = constellationDependencyEdges(teams, teamById, c.dependencies || []);
  const allEdges = graphEdges.length;
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

  // Connections — mirror the constellation view's relationship edges into a
  // flat list the self panel can render. Includes teammates (same team),
  // members of teams linked to mine, and people in shared synergy clusters.
  const connections = [];
  let myTeam = null;
  if (myRecord) {
    const myTeamId = myRecord.team || (myRecord.kind === 'team' ? myRecord.record_id : null);
    myTeam = myTeamId ? cohortIndex.teamById.get(myTeamId) : null;
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
      // Relationship target members.
      for (const edge of graphEdges.filter(e => e.from === myTeam.record_id)) {
        const depTeam = cohortIndex.teamById.get(edge.to);
        if (!depTeam) continue;
        for (const p of cohortIndex.primaryPeopleByTeam.get(edge.to) || []) {
          add(p, edge.relation_label || "declared link", depTeam);
        }
      }
      // Incoming relationship members.
      for (const e of graphEdges) {
        if (e.to !== myTeam.record_id) continue;
        const t = teamById.get(e.from);
        if (!t) continue;
        const label = e.relation === "depends_on" ? "depends on us" : "links to us";
        for (const p of cohortIndex.primaryPeopleByTeam.get(t.record_id) || []) add(p, label, t);
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

  const edgeCountValue = connections.length || allEdges;
  const edgeCountSource = connections.length ? "resolved self graph" : "cohort dependency graph";
  const selfRead = myRecord
    ? buildMembraneSelfRead(myRecord, myTeam, connections, asks, askIdentity, state.events)
    : null;

  // Shape the profile object the panel will render. Prefer the full
  // cohort record (rich fields), fall back to the identity claim (just
  // name + kind + record_id), fall back to editor-state user.
  const ghHandle = myRecord?.links?.github || myRecord?.gh_handle || myRecord?.handle || editorHandle || '';
  const ghAccount = normalizeGithubAccount(ghHandle);
  const avatarUrl = ghAccount
    ? `https://github.com/${encodeURIComponent(ghAccount)}.png?size=256`
    : null;

  const profileForPanel = myRecord ? {
    record_id: myRecord.record_id,
    name: myRecord.name,
    team: myRecord.team || (myRecord.kind === 'team' ? myRecord.record_id : ''),
    role: myRecord.role || myRecord.title || '',
    role_class: myRecord.role_class,
    handle: ghAccount || ghHandle,
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
      edgeCount: String(edgeCountValue),
      // Reliable claim signal — ONLY a formal identity claim counts, never
      // the editor-handle fallback (that mis-flagged the github editor user
      // as "claimed" and stranded them in an empty field). The membrane uses
      // this to auto-enter the field for returning claimed users.
      claimed: !!(identity && identity.record_id),
      profile: profileForPanel,
      connections,
      edgeCountSource,
      read: selfRead,
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
  state.mode = mode === "collab" ? "constellation" : mode;
  // Optional: land on a specific constellation sub-view (clusters /
  // dependencies / journey / collab). Used by the cohort panel's view cards.
  if (mode === "collab") {
    state.constellationMode = "collab";
  }
  if (mode === "constellation" && opts && opts.constellationMode) {
    const m = opts.constellationMode;
    if (m === "circle" || m === "ring") {
      state.constellationMode = "ring";
    } else if (m === "clusters" || m === "wells" || m === "dependencies" || m === "source") {
      state.constellationMode = "map";
      state.constellationLens = constNormalizeConstellationLens(m);
    } else {
      state.constellationMode = m;   // "journey" | "map" | "ring" | "stack"
    }
    try {
      localStorage.setItem(CONST_MODE_LS_KEY, state.constellationMode);
      localStorage.setItem(CONST_LENS_LS_KEY, state.constellationLens);
    } catch {}
  }
  if (mode === "asks" && opts && opts.openComposer) {
    state.openAskComposer = true;
  }
  try { localStorage.setItem(ALCHEMY_LS_KEY, mode === "collab" ? "collab" : state.mode); } catch {}
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
      wireShapeCardClicks();   // renderShapes() rebinds chips, not card→openDetail; re-wire after filter switch
    });
  }
  // Wire the membership chips.
  for (const btn of state.canvas.querySelectorAll(".alch-shapes-chip[data-membership-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.membershipFilter;
      if (next === state.shapesMembershipFilter) return;
      state.shapesMembershipFilter = next;
      renderShapes();
      wireShapeCardClicks();   // re-wire cards after membership-filter switch (see note above)
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
// Fine per-bottleneck palette — still used by the PMF detail card's single
// bottleneck chip (one chip, so the 10-hue precision is fine there). The
// SCATTER collapses these to 4 families (JOURNEY_BOTTLENECK_FAMILIES) for a
// holdable glance read.
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
// The scatter colors dots by bottleneck FAMILY (4 holdable hues), not by the
// 10 fine-grained bottlenecks — 10 hues is past what an eye can hold at a
// glance. The fine bottleneck still drives isolation + the tooltip + the
// detail card; only the dot color collapses. (CSS: ac-jfam-0..3.)
const JOURNEY_BOTTLENECK_FAMILIES = [
  { label: "market",  members: ["ICP Clarity", "Pain Intensity"] },
  { label: "product", members: ["Solution Quality", "Technical Risk"] },
  { label: "growth",  members: ["GTM", "Retention", "Business Model"] },
  { label: "company", members: ["Fundraising", "Regulatory", "Team"] },
];
const JOURNEY_BOTTLENECK_FAMILY_IDX = (() => {
  const m = {};
  JOURNEY_BOTTLENECK_FAMILIES.forEach((f, i) => f.members.forEach(b => { m[b] = i; }));
  return m;
})();
function journeyFamilyIdx(bottleneck) {
  const i = JOURNEY_BOTTLENECK_FAMILY_IDX[bottleneck];
  return i === undefined ? 0 : i;
}
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

// True when a record carries ANY self-entered journey signal (vs. sitting at
// the idea·vibes default). Drives the scatter's hollow "default" dots + the
// "N of M assessed" honesty count, so unedited teams can't masquerade as a
// real bottom-left cluster — the same data-honesty rule applied on the collab
// board (don't advertise a placement you haven't actually collected).
function journeyAssessed(rec) {
  const j = rec && typeof rec.journey === "object" && rec.journey;
  if (!j) return false;
  return ["stage", "evidence_quality", "market_upside", "primary_bottleneck",
          "confidence", "icp", "problem", "solution", "evidence_notes", "next_milestone"]
    .some(k => j[k] !== undefined && j[k] !== null && j[k] !== "");
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

// ─── shared constellation chrome ─────────────────────────────────────
// Three top-level questions:
// map = what world is this in and what does this line claim?
//   map layouts: wells = ecosystem placement; ring = who bridges worlds.
// journey = where is the product-market-fit journey?
// stack = where does the project enter the product/market stack?
const CONST_VIEWS = [
  { mode: "map",     glyph: "◉", label: "relationship map", hint: "project wells and evidence-backed connections" },
  { mode: "journey", glyph: "⌁", label: "pmf evidence", hint: "coverage of explicit product-market-fit reads" },
  { mode: "stack",   glyph: "▦", label: "product layer", hint: "where projects enter the product stack" },
];
function constellationNav(active) {
  const activeTop = active === "ring" ? "map" : active;
  return `
    <nav class="alch-const-modes" role="tablist" aria-label="constellation view">
      ${CONST_VIEWS.map(v => `
        <button class="alch-const-mode-btn" data-const-mode="${v.mode}" aria-selected="${activeTop === v.mode}" aria-label="${escAttr(`${v.label}: ${v.hint}`)}" title="${escAttr(v.hint)}" type="button">
          <span class="acm-glyph" aria-hidden="true">${v.glyph}</span><span class="acm-label">${v.label}</span>
        </button>`).join("")}
    </nav>`;
}

const CONST_MAP_LAYOUTS = [
  { mode: "map", label: "wells", hint: "ecosystem placement" },
  { mode: "ring", label: "circle", hint: "all relationship lines" },
];
const CONST_NETWORK_SCOPES = [
  { scope: "projects", label: "projects", hint: "team/project relationship records" },
  { scope: "people", label: "people", hint: "person-to-person relationship context" },
];
function constNormalizeNetworkScope(raw) {
  return String(raw || "").toLowerCase() === "people" ? "people" : "projects";
}
function constellationNetworkScopeRow(active) {
  const scope = constNormalizeNetworkScope(active);
  return `
    <div class="ac-network-scope-row" role="group" aria-label="network entity layer">
      <span>Graph</span>
      ${CONST_NETWORK_SCOPES.map(v => {
        return `
          <button class="ac-network-scope-btn" data-const-network-scope="${v.scope}" aria-selected="${scope === v.scope}" aria-label="${escAttr(`${v.label}, ${v.hint}`)}" type="button">
            <strong>${escHtml(v.label)}</strong>
          </button>`;
      }).join("")}
    </div>`;
}
function constellationMapLayoutRow(active) {
  const activeLayout = active === "ring" ? "ring" : "map";
  return `
    <div class="ac-map-layout-row" role="group" aria-label="map layout">
      <span>layout</span>
      ${CONST_MAP_LAYOUTS.map(v => `
        <button class="ac-map-layout-btn" data-const-map-layout="${v.mode}" aria-selected="${activeLayout === v.mode}" aria-label="${escAttr(`${v.label} layout, ${v.hint}`)}" type="button">${escHtml(v.label)}</button>
      `).join("")}
    </div>`;
}

// Map line lenses. Each re-weights the SAME map (control-as-claim): it changes
// which relationship claim is being inspected, never the geometry. Ecosystems
// are controlled directly by clicking the wells, not by another text row.
const CONST_LENSES = [
  { lens: "all",       label: "all",    meaning: "every declared line" },
  { lens: "relies",    label: "relies", meaning: "needs or unblocks another team" },
  { lens: "works",     label: "works",  meaning: "collaboration, pairing, or complement" },
  { lens: "substrate", label: "shared", meaning: "same primitive or ecosystem context" },
];
function constNormalizeConstellationLens(raw) {
  const lens = String(raw || "").toLowerCase();
  if (lens === "dependencies" || lens === "clusters" || lens === "source") return "all";
  if (lens === "all" || lens === "relies" || lens === "works" || lens === "substrate") return lens;
  return "all";
}
function constellationLensMetric(lens, metrics = {}) {
  if (lens === "all") return metrics.edges;
  if (lens === "relies") return metrics.reliance;
  if (lens === "works") return metrics.collaboration;
  if (lens === "substrate") return metrics.ecosystem;
  return "";
}
function constellationLensAria(lens, label, metric) {
  if (lens === "relies") return metric === 0 ? `${label}, no reliance records yet` : `${label}, reliance or unblock lines`;
  if (lens === "works") return `${label}, collaboration lines`;
  if (lens === "substrate") return `${label}, shared substrate lines`;
  return `${label}, declared lines`;
}
function constellationLensRow(active, metrics = {}) {
  const chipCopy = {
    all: { label: "all" },
    relies: { label: "relies" },
    works: { label: "works" },
    substrate: { label: "shared" },
  };
  return `
    <div class="ac-lens-row" role="group" aria-label="map lens">
      <span>lines</span>
      ${CONST_LENSES.map(l => {
        const metric = constellationLensMetric(l.lens, metrics);
        const aria = constellationLensAria(l.lens, l.label, metric);
        const spec = chipCopy[l.lens] || { label: l.label };
        return `<button class="ac-lens-btn${metric === 0 ? " is-empty" : ""}" data-const-lens="${l.lens}" aria-selected="${active === l.lens}" aria-label="${escAttr(aria)}" type="button"><span>${escHtml(spec.label)}</span></button>`;
      }).join("")}
    </div>`;
}
// Truncate long cluster/well labels at rest. Full text stays available via
// an SVG <title> tooltip. Keeps compact labels from colliding with nodes.
function constTruncLabel(label) {
  const s = String(label || "");
  if (s.length <= 20) return { text: s, title: "" };
  return { text: s.slice(0, 18).trimEnd() + "…", title: s };
}

function constWellLabelLines(label) {
  const raw = constText(label);
  if (!raw) return [];
  const slashParts = raw.split(/\s*\/\s*/).map(part => part.trim()).filter(Boolean);
  const parts = slashParts.length > 1 ? slashParts : raw.split(/\s+/);
  const lines = [];
  let current = "";
  for (const part of parts) {
    const next = current ? `${current} ${part}` : part;
    if (next.length <= 18 || !current) current = next;
    else {
      lines.push(current);
      current = part;
    }
    if (lines.length === 1 && current.length > 18) break;
  }
  if (current) lines.push(current);
  const compact = lines.slice(0, 2).map(line => line.length > 20 ? `${line.slice(0, 18).trimEnd()}...` : line);
  if (compact.length === 2 && compact.join(" ").length < raw.length - 2) {
    compact[1] = compact[1].length > 17 ? `${compact[1].slice(0, 15).trimEnd()}...` : compact[1];
  }
  return compact;
}

function constWellLabelSvg(w, y, cls = "ac-well-label") {
  const lines = constWellLabelLines(w.label);
  if (!lines.length) return "";
  const x = Number(w.cx || 0).toFixed(1);
  const title = constText(w.label);
  const count = w?.members?.length || w?.count || 0;
  const countLabel = `${count} team${count === 1 ? "" : "s"}`;
  const titleLabel = cls === "ac-well-label" && count > 0 ? `${title} · ${countLabel}` : title;
  return `
    <text class="${cls}" x="${x}" y="${Number(y).toFixed(1)}" text-anchor="middle">
      <title>${escHtml(titleLabel)}</title>
      ${lines.map((line, idx) => `<tspan class="ac-well-name-line" x="${x}" dy="${idx === 0 ? "0" : "10.5"}">${escHtml(line)}</tspan>`).join("")}
    </text>`;
}

function constNodeLabelLines(team, viewMode) {
  const raw = constText(team?.name || team?.record_id);
  if (!raw) return [];
  if (viewMode === "ring") {
    const max = 16;
    return [raw.length <= max ? raw : `${raw.slice(0, max - 1).trimEnd()}…`];
  }
  const max = 13;
  if (raw.length <= max) return [raw];
  const parts = raw.split(/[\s/_-]+/).map(part => part.trim()).filter(Boolean);
  if (parts.length <= 1) return [`${raw.slice(0, max - 1).trimEnd()}…`];
  const lineMax = 11;
  const sep = raw.includes("-") && !/\s/.test(raw) ? "-" : " ";
  const lines = [];
  let current = "";
  let used = 0;
  for (const partRaw of parts) {
    const part = partRaw.length <= lineMax ? partRaw : `${partRaw.slice(0, lineMax - 1).trimEnd()}…`;
    const next = current ? `${current}${sep}${part}` : part;
    if (next.length <= lineMax || !current) {
      current = next;
      used++;
      continue;
    }
    lines.push(current);
    current = part;
    used++;
    if (lines.length >= 2) break;
  }
  if (current && lines.length < 2) lines.push(current);
  if (used < parts.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length >= lineMax
      ? `${last.slice(0, lineMax - 1).trimEnd()}…`
      : `${last}…`;
  }
  return lines.slice(0, 2);
}

function constNodeLabelSvg(lines, x, y, anchor, title) {
  const safeLines = (Array.isArray(lines) ? lines : []).filter(Boolean);
  if (!safeLines.length) return "";
  const xStr = Number(x).toFixed(1);
  const multi = safeLines.length > 1;
  const y0 = multi && Number(y) >= 0 ? Number(y) - 4 : Number(y);
  const lineMarkup = safeLines.map((line, idx) =>
    idx === 0
      ? escHtml(line)
      : `<tspan x="${xStr}" dy="9.4">${escHtml(line)}</tspan>`
  ).join("");
  return `<text class="ac-node-label" x="${xStr}" y="${y0.toFixed(1)}" text-anchor="${anchor}"><title>${escHtml(title)}</title>${lineMarkup}</text>`;
}

const CONST_WELL_ACCENTS = [
  { strong: "#C0492E", soft: "rgba(192,73,46,0.13)", faint: "rgba(192,73,46,0.045)" },
  { strong: "#D9913D", soft: "rgba(217,145,61,0.13)", faint: "rgba(217,145,61,0.045)" },
  { strong: "#9A5BA6", soft: "rgba(154,91,166,0.13)", faint: "rgba(154,91,166,0.045)" },
  { strong: "#3F9B8E", soft: "rgba(63,155,142,0.13)", faint: "rgba(63,155,142,0.045)" },
  { strong: "#D6BD86", soft: "rgba(214,189,134,0.13)", faint: "rgba(214,189,134,0.045)" },
  { strong: "#7A8EA8", soft: "rgba(122,142,168,0.13)", faint: "rgba(122,142,168,0.045)" },
];
function constWellAccentTokens(id, idx = 0) {
  const text = constText(id);
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  return CONST_WELL_ACCENTS[(hash + idx) % CONST_WELL_ACCENTS.length];
}
function constWellAccentStyle(tokens) {
  if (!tokens) return "";
  return `--well-accent:${tokens.strong};--well-accent-soft:${tokens.soft};--well-accent-faint:${tokens.faint};`;
}

function constText(val) {
  if (val == null) return "";
  if (Array.isArray(val)) return val.map(constText).filter(Boolean).join(" · ");
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? "" : val.toISOString().slice(0, 10);
  if (typeof val === "object") return "";
  return String(val).replace(/\s+/g, " ").trim();
}
function constList(val) {
  if (Array.isArray(val)) return val.map(constText).filter(Boolean);
  const s = constText(val);
  if (!s) return [];
  return s.split(/\s*[,;]\s*|\n+/).map(x => x.trim()).filter(Boolean);
}
function constShortText(val, max = 150) {
  const s = constText(val);
  if (!s || s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}
function constTeamCountText(count) {
  const n = Number(count) || 0;
  return `${n} team${n === 1 ? "" : "s"}`;
}
function constPersonDisplayName(person) {
  return constText(person?.name || person?.display_name || person?.handle || person?.record_id || "person");
}
function constPersonInitials(person) {
  const name = constPersonDisplayName(person);
  const parts = name.split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] || ""}${parts[parts.length - 1][0] || ""}`.toUpperCase();
}
function constPersonRoleLabel(person) {
  const roleClass = constText(person?.role_class).replace(/-/g, " ");
  return constText(person?.role) || roleClass || "participant";
}
function constPeopleNetworkModel(people = [], teams = [], W = 1120, H = 620) {
  const teamById = new Map((Array.isArray(teams) ? teams : []).filter(t => t?.record_id).map(t => [t.record_id, t]));
  const peopleList = (Array.isArray(people) ? people : []).filter(p => p?.record_id);
  const peopleById = new Map(peopleList.map(p => [p.record_id, p]));
  const peopleForTeam = new Map();
  const teamIdsWithPeople = new Set();
  for (const person of peopleList) {
    const teamId = teamById.has(person.team) ? person.team : "_unattached_people";
    if (!peopleForTeam.has(teamId)) peopleForTeam.set(teamId, []);
    peopleForTeam.get(teamId).push(person);
    teamIdsWithPeople.add(teamId);
  }
  const connectedTeams = [...teamIdsWithPeople]
    .filter(id => id !== "_unattached_people")
    .map(id => teamById.get(id))
    .sort((a, b) =>
      constDomainClass(a.domain).localeCompare(constDomainClass(b.domain))
      || String(a.name || a.record_id).localeCompare(String(b.name || b.record_id)));
  const unattached = peopleForTeam.get("_unattached_people") || [];
  const groupDefs = [
    ...connectedTeams.map(team => ({
      id: team.record_id,
      label: team.name || team.record_id,
      team,
      kind: "team",
      people: (peopleForTeam.get(team.record_id) || []).sort((a, b) => constPersonDisplayName(a).localeCompare(constPersonDisplayName(b))),
    })),
  ];
  if (unattached.length) {
    groupDefs.push({
      id: "_unattached_people",
      label: "not attached / visiting",
      team: null,
      kind: "unattached",
      people: unattached.slice().sort((a, b) => constPersonDisplayName(a).localeCompare(constPersonDisplayName(b))),
    });
  }
  const N = Math.max(1, groupDefs.length);
  const cols = Math.max(1, Math.min(N, Math.round(Math.sqrt(N * (W / H)))));
  const rowsN = Math.ceil(N / cols);
  const cellW = W / cols;
  const cellH = H / rowsN;
  const groups = [];
  const groupById = new Map();
  const personPositions = new Map();
  groupDefs.forEach((group, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const rowCount = row === rowsN - 1 ? (N - row * cols) : cols;
    const rowPad = (cols - rowCount) * cellW / 2;
    const cx = rowPad + col * cellW + cellW / 2;
    const cy = row * cellH + cellH / 2;
    const count = group.people.length;
    const r = Math.max(54, Math.min(cellW, cellH) * 0.40);
    const placed = { ...group, cx, cy, r, count };
    groups.push(placed);
    groupById.set(group.id, placed);
    group.people.forEach((person, personIdx) => {
      const personR = person.role_class === "coordinator" ? 7.4 : 6.4;
      let x = cx;
      let y = cy;
      let angle = null;
      if (count > 1) {
        const ring = count > 9 && personIdx >= 9 ? 1 : 0;
        const ringIdx = ring ? personIdx - 9 : personIdx;
        const ringCount = ring ? Math.max(1, count - 9) : Math.min(count, 9);
        angle = -Math.PI / 2 + (ringIdx / ringCount) * Math.PI * 2;
        const spread = ring ? 0.62 : (count > 5 ? 0.48 : 0.36);
        x = cx + Math.cos(angle) * r * spread;
        y = cy + Math.sin(angle) * r * spread;
      }
      personPositions.set(person.record_id, {
        person,
        x,
        y,
        r: personR,
        angle,
        groupId: group.id,
        teamId: group.team?.record_id || "",
      });
    });
  });

  const edgeByPair = new Map();
  const teamIdForPerson = person => teamById.has(person?.team) ? person.team : "";
  const secondarySet = person => new Set(Array.isArray(person?.secondary_teams) ? person.secondary_teams.filter(id => teamById.has(id)) : []);
  const personTextTokens = person => constTalkTokens([
    person?.role,
    person?.role_class,
    person?.now,
    person?.weekly_intention,
    person?.working_style,
    person?.contribute_interests,
    person?.go_to_them_for,
    person?.recurring_themes,
    person?.skills,
    person?.skill_areas,
  ]);
  const tokenByPerson = new Map(peopleList.map(person => [person.record_id, personTextTokens(person)]));
  const addEdge = (a, b, kind, score, reason, shared = []) => {
    if (!a?.record_id || !b?.record_id || a.record_id === b.record_id) return;
    const [pa, pb] = [a.record_id, b.record_id].sort();
    const key = `${pa}|${pb}`;
    const existing = edgeByPair.get(key);
    const row = {
      id: key,
      a: pa,
      b: pb,
      kind,
      score,
      reason,
      shared: shared.slice(0, 4),
      sourceKinds: [kind],
    };
    if (!existing || score > existing.score) {
      if (existing) row.sourceKinds = [...new Set([...existing.sourceKinds, kind])];
      edgeByPair.set(key, row);
    } else {
      existing.sourceKinds = [...new Set([...existing.sourceKinds, kind])];
      if (shared.length && existing.shared.length < 4) existing.shared = [...new Set([...existing.shared, ...shared])].slice(0, 4);
    }
  };
  for (const group of groups) {
    const members = group.people || [];
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        addEdge(members[i], members[j], "same-team", 92, `same primary project: ${group.label}`);
      }
    }
  }
  for (let i = 0; i < peopleList.length; i++) {
    for (let j = i + 1; j < peopleList.length; j++) {
      const a = peopleList[i];
      const b = peopleList[j];
      const aTeam = teamIdForPerson(a);
      const bTeam = teamIdForPerson(b);
      const aSecondary = secondarySet(a);
      const bSecondary = secondarySet(b);
      if ((aTeam && bSecondary.has(aTeam)) || (bTeam && aSecondary.has(bTeam)) || [...aSecondary].some(id => bSecondary.has(id))) {
        addEdge(a, b, "secondary-overlap", 78, "secondary project overlap");
      }
      const aPair = constList(a.pair_with).map(x => x.toLowerCase());
      const bPair = constList(b.pair_with).map(x => x.toLowerCase());
      const aName = constPersonDisplayName(a).toLowerCase();
      const bName = constPersonDisplayName(b).toLowerCase();
      if (aPair.includes(b.record_id.toLowerCase()) || aPair.includes(bName) || bPair.includes(a.record_id.toLowerCase()) || bPair.includes(aName)) {
        addEdge(a, b, "pair-with", 86, "pair_with profile field");
      }
      const at = tokenByPerson.get(a.record_id) || new Set();
      const bt = tokenByPerson.get(b.record_id) || new Set();
      const shared = [...at].filter(token => bt.has(token)).slice(0, 6);
      if (shared.length >= 2) {
        addEdge(a, b, "shared-context", 30 + shared.length * 6, `shared declared context: ${shared.slice(0, 3).join(", ")}`, shared);
      }
    }
  }
  const edges = [...edgeByPair.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 120)
    .map(edge => {
      const ap = personPositions.get(edge.a);
      const bp = personPositions.get(edge.b);
      return { ...edge, x1: ap?.x || 0, y1: ap?.y || 0, x2: bp?.x || 0, y2: bp?.y || 0 };
    })
    .filter(edge => personPositions.has(edge.a) && personPositions.has(edge.b));
  return {
    groups,
    groupById,
    peopleById,
    people: peopleList,
    personPositions,
    edges,
    attached: peopleList.filter(p => p?.team && teamById.has(p.team)).length,
    unattached: peopleList.filter(p => !p?.team || !teamById.has(p.team)).length,
  };
}

// Transcript cues are public source data carried on the cohort surface. They do
// not create graph edges; they only add inspectable context beside selected
// teams, lines, and ecosystems.
function constSourceTranscriptCues() {
  const cues = Array.isArray(state.cohort?.constellation_cues) ? state.cohort.constellation_cues : [];
  return cues
    .filter(cue => cue && typeof cue === "object")
    .map(cue => ({
      teams: Array.isArray(cue.teams) ? cue.teams.map(id => constText(id).toLowerCase()).filter(Boolean) : [],
      clusters: Array.isArray(cue.clusters) ? cue.clusters.map(id => constText(id).toLowerCase()).filter(Boolean) : [],
      label: constText(cue.label),
      source: constText(cue.source),
      excerpt: constText(cue.excerpt),
    }))
    .filter(cue => cue.label && cue.excerpt);
}

function constTranscriptCueKey(cue) {
  return `${cue?.source || ""}|${cue?.label || ""}|${cue?.excerpt || ""}`;
}

function constSourceCueHref(source) {
  const raw = constText(source);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  const match = raw.match(/^(.*?)(?::(\d+))?$/);
  const pathPart = (match?.[1] || raw).replace(/\\/g, "/").replace(/^\/+/, "");
  if (!pathPart) return "";
  const line = match?.[2] || "";
  const repoPath = pathPart.startsWith("cohort-data/") ? pathPart : `cohort-data/${pathPart}`;
  const encoded = repoPath.split("/").map(part => encodeURIComponent(part)).join("/");
  return `https://github.com/dmarzzz/shape-rotator-os/blob/main/${encoded}${line ? `#L${line}` : ""}`;
}

function constTranscriptCueSourceHtml(cue) {
  const source = cue?.source || "raw transcript";
  const href = constSourceCueHref(source);
  return href
    ? `<a class="ac-source-link" href="${escAttr(href)}" data-external>${escHtml(source)}</a>`
    : `<small>${escHtml(source)}</small>`;
}

function constTranscriptCuesForTeam(team, limit = 3) {
  const rid = constText(team?.record_id).toLowerCase();
  const name = constText(team?.name).toLowerCase();
  if (!rid && !name) return [];
  return constSourceTranscriptCues()
    .filter(cue => (cue.teams || []).some(id => id === rid || id === name))
    .slice(0, limit);
}

function constTranscriptCuesForEdge(edge, ctx, limit = 3) {
  const from = constText(edge?.from).toLowerCase();
  const to = constText(edge?.to).toLowerCase();
  if (!from || !to) return [];
  const fromTeam = ctx?.teamById?.get(edge.from);
  const toTeam = ctx?.teamById?.get(edge.to);
  const direct = constSourceTranscriptCues().filter(cue => {
    const teams = new Set(cue.teams || []);
    return teams.has(from) && teams.has(to);
  });
  const loose = [
    ...constTranscriptCuesForTeam(fromTeam, limit),
    ...constTranscriptCuesForTeam(toTeam, limit),
  ];
  const seen = new Set();
  const out = [];
  for (const cue of [...direct, ...loose]) {
    const key = constTranscriptCueKey(cue);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cue);
    if (out.length >= limit) break;
  }
  return out;
}

function constTranscriptCuesForInterest(interest, limit = 3) {
  if (!interest?.active) return [];
  const coreIds = interest.coreIds || new Set();
  const clusterId = constText(interest.id).toLowerCase();
  return constSourceTranscriptCues()
    .filter(cue =>
      (cue.clusters || []).includes(clusterId)
      || (cue.teams || []).some(id => coreIds.has(id)))
    .slice(0, limit);
}

function constTranscriptCueListHtml(cues, title = "transcript cues") {
  const list = (Array.isArray(cues) ? cues : []).filter(Boolean);
  if (!list.length) return "";
  return `
    <section class="ac-inspector-section is-transcript-cues">
      <h4>${escHtml(title)}</h4>
      <div class="ac-transcript-cues">
        ${list.map(cue => `
          <article class="ac-transcript-cue">
            <span>${escHtml(cue.label || "transcript")}</span>
            <p>${escHtml(constShortText(cue.excerpt, 180))}</p>
            ${constTranscriptCueSourceHtml(cue)}
          </article>`).join("")}
      </div>
    </section>`;
}

function constTranscriptCueDetailsHtml(cues, title = "source cues") {
  const list = (Array.isArray(cues) ? cues : []).filter(Boolean);
  if (!list.length) return "";
  return `
    <details class="ac-inspector-details is-transcript-cues">
      <summary>${escHtml(title)} <span>${escHtml(String(list.length))}</span></summary>
      <div class="ac-inspector-details-body ac-transcript-cues">
        ${list.map(cue => `
          <article class="ac-transcript-cue">
            <span>${escHtml(cue.label || "transcript")}</span>
            <p>${escHtml(constShortText(cue.excerpt, 150))}</p>
            ${constTranscriptCueSourceHtml(cue)}
          </article>`).join("")}
      </div>
    </details>`;
}

function constRelationshipMeaning(edge) {
  if (!edge?.normalized) {
    return {
      key: "unknown",
      label: "profile mention",
      note: "A team profile mentions this connection, but no relationship record explains the claim yet.",
    };
  }
  if (edge.relation === "depends_on") {
    return {
      key: "reliance",
      label: "relies on",
      note: "The source is saying the target is something it needs, builds on, or must coordinate around.",
    };
  }
  if (edge.relation === "unblocks") {
    return {
      key: "reliance",
      label: "unblocks",
      note: "The source can remove a blocker for the target. This is operational reliance, not just topical similarity.",
    };
  }
  if (edge.relation === "pairs_with") {
    return {
      key: "collaboration",
      label: "working together",
      note: "The teams are positioned as collaborators or pairing candidates; the line does not imply a hard dependency.",
    };
  }
  if (edge.relation === "complements") {
    return {
      key: "collaboration",
      label: "complement",
      note: "The products or capabilities reinforce each other; useful adjacency, but not necessarily blocking reliance.",
    };
  }
  if (edge.relation === "shares_substrate") {
    return {
      key: "ecosystem",
      label: "shared substrate",
      note: "The teams share an underlying technical stack, market genre, or operating context. This is ecosystem context, not proof they rely on each other.",
    };
  }
  return {
    key: "unknown",
    label: "mapped source link",
    note: "This relation is declared, but its meaning category is not yet mapped in the constellation grammar.",
  };
}

function constRelationshipDirection(edge, fromName, toName) {
  const a = fromName || edge?.from || "source";
  const b = toName || edge?.to || "target";
  if (!edge?.normalized) return `${a} mentions ${b} in its team profile.`;
  if (edge.relation === "depends_on") return `${a} relies on ${b}.`;
  if (edge.relation === "unblocks") return `${a} can unblock ${b}.`;
  if (edge.relation === "pairs_with") return `${a} is a pairing or collaboration candidate with ${b}.`;
  if (edge.relation === "complements") return `${a} complements ${b}.`;
  if (edge.relation === "shares_substrate") return `${a} and ${b} share substrate or ecosystem context.`;
  return `${a} is linked to ${b} by a declared relationship record.`;
}

function constRelationshipVerb(edge) {
  if (!edge?.normalized) return "is connected to";
  const labels = {
    depends_on: "depends on",
    unblocks: "can unblock",
    pairs_with: "could work with",
    complements: "complements",
    shares_substrate: "shares infrastructure with",
    declared: "is connected to",
  };
  return labels[edge.relation] || (edge.relation_label || "is connected to");
}

function constRelationshipStatus(edge) {
  if (!edge?.normalized) {
    return {
      label: "needs confirmation",
      note: "This is a profile mention. Treat it as a lead to verify, not a relationship record.",
    };
  }
  const labels = {
    exploring: "candidate relationship",
    active: "active now",
    blocked: "blocked",
    resolved: "already handled",
    declared: "declared",
    unknown: "status unknown",
  };
  const notes = {
    exploring: "The record says this is being explored; treat it as a lead, not a confirmed operating dependency.",
    active: "The record says this is currently active.",
    blocked: "The record says progress is blocked on this relationship.",
    resolved: "The record says this relationship has already been resolved.",
    declared: "The record declares a connection but does not add operating status.",
    unknown: "The record does not declare status.",
  };
  return {
    label: labels[edge.status] || edge.status_label || "status unknown",
    note: notes[edge.status] || "The status is read from the relationship record.",
  };
}

function constRelationshipSource(edge) {
  if (!edge?.normalized) {
    const field = edge?.source_kind === "team_dependencies" ? "team.dependencies" : "profile field";
    return {
      label: "profile mention",
      note: `Created from ${field}; no relationship record backs this line yet.`,
    };
  }
  return {
    label: edge.record_id || edge.id || "relationship record",
    note: "A relationship record supplies the type, status, source strength, and evidence for this line.",
  };
}

function constRelationshipConfidenceLabel(edge) {
  if (!edge?.normalized) return "profile mention; no relationship record";
  const confidence = constText(edge.confidence).toLowerCase();
  if (confidence === "high") return "relationship record: strong";
  if (confidence === "medium") return "relationship record: source-backed";
  if (confidence === "low") return "relationship record: candidate";
  if (edge.status === "exploring") return "relationship record: exploring";
  return constText(edge.confidence_label) || "relationship record";
}

function constRelationshipOneLine(edge, fromName, toName) {
  const a = fromName || edge?.from || "source";
  const b = toName || edge?.to || "target";
  if (!edge?.normalized) return `${a} mentions ${b} in its team profile.`;
  return `${a} ${constRelationshipVerb(edge)} ${b}.`;
}

const SUCCESS_DIMENSION_LABELS = {
  productization: "product",
  research_lineage: "research",
  collaborative: "collab",
};
function constSuccessDimensions(team) {
  return constList(team?.success_dimensions).map(s => SUCCESS_DIMENSION_LABELS[s] || s.replace(/_/g, " "));
}

function constClusterId(cluster) {
  return constText(cluster?.record_id || cluster?.name);
}

function constClusterLabel(cluster) {
  return constText(cluster?.label || cluster?.name || cluster?.record_id || "ecosystem");
}

function constTeamSkillList(team) {
  return (Array.isArray(team?.skill_areas) ? team.skill_areas : []).map(constText).filter(Boolean);
}

function constClusterMembershipByTeam(clusters = []) {
  const out = new Map();
  for (const cl of (Array.isArray(clusters) ? clusters : [])) {
    const id = constClusterId(cl);
    if (!id) continue;
    for (const rid of (Array.isArray(cl?.teams) ? cl.teams : [])) {
      const key = constText(rid);
      if (!key) continue;
      if (!out.has(key)) out.set(key, []);
      out.get(key).push({ id, label: constClusterLabel(cl), cluster: cl });
    }
  }
  return out;
}

function constInterestContext(teams = [], clusters = [], edges = [], activeId = "all") {
  const list = Array.isArray(teams) ? teams : [];
  const clusterList = Array.isArray(clusters) ? clusters : [];
  const id = constText(activeId) || "all";
  const teamById = new Map(list.filter(t => t?.record_id).map(t => [t.record_id, t]));
  let cluster = id === "all" ? null : clusterList.find(cl => constClusterId(cl) === id);
  if (!cluster && id === "_other") {
    const clusteredIds = new Set();
    for (const cl of clusterList) for (const rid of (Array.isArray(cl.teams) ? cl.teams : [])) clusteredIds.add(rid);
    const teamsMissingCluster = list.filter(team => team?.record_id && !clusteredIds.has(team.record_id)).map(team => team.record_id);
    if (teamsMissingCluster.length) {
      cluster = {
        record_id: "_other",
        name: "unclustered",
        label: "unclustered",
        teams: teamsMissingCluster,
        description: "Teams not listed in an ecosystem cluster record. They stay visible as their own source grouping.",
      };
    }
  }
  if (!cluster) {
    return {
      active: false,
      id: "all",
      cluster: null,
      coreIds: new Set(),
      neighborIds: new Set(),
      relatedClusterIds: new Set(),
      coreTeams: [],
      neighborTeams: [],
      topSkills: [],
      relatedClusters: [],
    };
  }

  const coreTeams = (Array.isArray(cluster.teams) ? cluster.teams : []).map(rid => teamById.get(rid)).filter(Boolean);
  const coreIds = new Set(coreTeams.map(t => t.record_id));
  const skillCounts = new Map();
  for (const team of coreTeams) {
    for (const skill of constTeamSkillList(team)) {
      skillCounts.set(skill, (skillCounts.get(skill) || 0) + 1);
    }
  }
  const topSkills = [...skillCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([skill, count]) => ({ skill, count }));
  const topSkillSet = new Set(topSkills.map(item => item.skill));

  const neighborIds = new Set();
  for (const edge of (Array.isArray(edges) ? edges : [])) {
    if (coreIds.has(edge.from) && teamById.has(edge.to) && !coreIds.has(edge.to)) neighborIds.add(edge.to);
    if (coreIds.has(edge.to) && teamById.has(edge.from) && !coreIds.has(edge.from)) neighborIds.add(edge.from);
  }
  if (topSkillSet.size) {
    for (const team of list) {
      if (!team?.record_id || coreIds.has(team.record_id)) continue;
      if (constTeamSkillList(team).some(skill => topSkillSet.has(skill))) neighborIds.add(team.record_id);
    }
  }
  const neighborTeams = [...neighborIds]
    .map(rid => teamById.get(rid))
    .filter(Boolean)
    .sort((a, b) => String(a.name || a.record_id).localeCompare(String(b.name || b.record_id)));

  const relatedClusters = [];
  const relatedClusterIds = new Set();
  for (const rel of clusterList) {
    const relId = constClusterId(rel);
    if (!relId || relId === id) continue;
    const members = new Set(Array.isArray(rel.teams) ? rel.teams : []);
    const coreOverlap = [...members].filter(rid => coreIds.has(rid)).length;
    const neighborOverlap = [...members].filter(rid => neighborIds.has(rid)).length;
    if (!coreOverlap && !neighborOverlap) continue;
    relatedClusterIds.add(relId);
    relatedClusters.push({
      id: relId,
      label: constClusterLabel(rel),
      description: constText(rel.description),
      coreOverlap,
      neighborOverlap,
    });
  }
  relatedClusters.sort((a, b) =>
    b.coreOverlap - a.coreOverlap
    || b.neighborOverlap - a.neighborOverlap
    || a.label.localeCompare(b.label));

  return {
    active: true,
    id,
    cluster,
    coreIds,
    neighborIds,
    relatedClusterIds,
    coreTeams,
    neighborTeams,
    topSkills,
    relatedClusters,
  };
}

function constInterestOwnsEdge(edge, interest) {
  if (!interest?.active) return true;
  return interest.coreIds.has(edge?.from) || interest.coreIds.has(edge?.to);
}

function constInterestTouchesEdge(edge, interest) {
  if (!interest?.active) return true;
  return constInterestOwnsEdge(edge, interest)
    || interest.neighborIds.has(edge?.from)
    || interest.neighborIds.has(edge?.to);
}

function constInterestSummaryHtml(ctx) {
  const interest = ctx?.interest;
  if (!interest?.active) return "";
  const core = interest.coreTeams.slice(0, 4);
  const neighbors = interest.neighborTeams.slice(0, 4);
  const focusEdges = (ctx?.edges || []).filter(edge => constInterestOwnsEdge(edge, interest));
  const skillChips = interest.topSkills.length
    ? `<div class="ac-view-chips">${interest.topSkills.map(item => `<span>${escHtml(item.skill)}<em>${escHtml(String(item.count))}</em></span>`).join("")}</div>`
    : `<p class="ac-inspector-empty">no shared source tags declared by the core teams.</p>`;
  const clusterChips = interest.relatedClusters.length
    ? `<div class="ac-view-clusters">${interest.relatedClusters.slice(0, 3).map(cl => `
        <button type="button" class="ac-view-chip" data-const-interest="${escAttr(cl.id)}">
          <span>${escHtml(cl.label)}</span>
          <small>${escHtml(`${cl.coreOverlap} core · ${cl.neighborOverlap} adjacent`)}</small>
        </button>`).join("")}</div>`
    : `<p class="ac-inspector-empty">no overlapping cluster wells from the current source data.</p>`;
  const teamPills = (items, total, note) => {
    const pills = items.map(t => `<button type="button" class="ac-team-pill" data-const-team="${escAttr(t.record_id)}">${escHtml(t.name || t.record_id)}</button>`).join("");
    const more = total > items.length ? `<span class="ac-team-pill is-more">+${escHtml(String(total - items.length))}</span>` : "";
    return pills || more ? `<div class="ac-team-pill-row">${pills}${more}</div>` : `<p class="ac-inspector-empty">${escHtml(note)}</p>`;
  };
  return `
    <section class="ac-inspector-section is-ecosystem-view">
      <h4>current ecosystem view</h4>
      <div class="ac-view-summary">
        <strong>${escHtml(constClusterLabel(interest.cluster))}</strong>
        <p>${escHtml(constShortText(interest.cluster.description, 135) || "no cluster description declared.")}</p>
      </div>
      <div class="ac-inspector-pills is-summary">
        <span><strong>${escHtml(String(interest.coreTeams.length))}</strong> core teams</span>
        <span><strong>${escHtml(String(interest.neighborTeams.length))}</strong> adjacent</span>
        <span><strong>${escHtml(String(focusEdges.length))}</strong> direct lines</span>
      </div>
      <div class="ac-inspector-actions">
        <button type="button" class="ac-mini-action" data-const-interest="all">show whole map</button>
      </div>
      <div class="ac-ecosystem-compact">
        <div>
          <span>core teams</span>
          ${teamPills(core, interest.coreTeams.length, "no member teams found.")}
        </div>
        <div>
          <span>adjacent teams</span>
          ${teamPills(neighbors, interest.neighborTeams.length, "no adjacent teams from declared connections or shared source tags.")}
        </div>
        <div>
          <span>shared source tags</span>
          ${skillChips}
        </div>
        <div>
          <span>related ecosystems</span>
          ${clusterChips}
        </div>
      </div>
    </section>
    ${constTranscriptCueDetailsHtml(constTranscriptCuesForInterest(interest), "source cues")}`;
}

function constellationTeamNavOrder(ctx) {
  const teams = (ctx?.teams || []).filter(team => team?.record_id);
  const interest = ctx?.interest;
  const groupRank = (team) => {
    if (!interest?.active) return 1;
    if (interest.coreIds.has(team.record_id)) return 0;
    if (interest.neighborIds.has(team.record_id)) return 1;
    return 2;
  };
  return teams.slice().sort((a, b) =>
    groupRank(a) - groupRank(b)
    || String(a.name || a.record_id).localeCompare(String(b.name || b.record_id)));
}

function constConstellationCoverage(teams = [], edges = []) {
  const list = Array.isArray(teams) ? teams : [];
  const edgeList = Array.isArray(edges) ? edges : [];
  const typedEdges = edgeList.filter(e => e.normalized).length;
  const meaningMissing = Math.max(0, edgeList.length - typedEdges);
  const assessed = list.filter(journeyAssessed).length;
  const activeContext = list.filter(t => constText(t.now) || constText(t.weekly_goals)).length;
  const proofy = list.filter(t =>
    constText(t.traction)
    || constList(t.prior_shipping).length
    || constList(t.paper_basis).length).length;
  return { teams: list.length, edges: edgeList.length, typedEdges, meaningMissing, assessed, activeContext, proofy };
}

function constMapDistributionRows(wells = [], accentById = new Map()) {
  const total = wells.reduce((sum, well) => sum + (well.members?.length || well.count || 0), 0) || 1;
  return wells
    .map((well, idx) => {
      const count = well.members?.length || well.count || 0;
      const id = well.id;
      const accent = accentById.get(id) || constWellAccentTokens(id, idx);
      return {
        id,
        label: well.label || id,
        count,
        pct: count / total,
        accent,
      };
    })
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function constMapDistributionHtml(wells = [], accentById = new Map(), activeId = "all") {
  const rows = constMapDistributionRows(wells, accentById);
  if (!rows.length) return "";
  const r = 24;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const segments = rows.map(row => {
    const len = Math.max(0.5, row.pct * c);
    const dash = `${len.toFixed(2)} ${(c - len).toFixed(2)}`;
    const dashOffset = (-offset).toFixed(2);
    offset += len;
    const selected = activeId === row.id;
    const label = `${row.label}: ${row.count} teams, ${Math.round(row.pct * 100)} percent`;
    return `<circle class="ac-donut-segment${selected ? " is-selected" : ""}" data-const-interest="${escAttr(row.id)}" cx="32" cy="32" r="${r}" fill="none" stroke="${escAttr(row.accent.strong)}" stroke-width="${selected ? 8 : 6}" stroke-dasharray="${dash}" stroke-dashoffset="${dashOffset}" transform="rotate(-90 32 32)" role="button" tabindex="0" aria-pressed="${selected ? "true" : "false"}" aria-label="${escAttr(label)}"><title>${escHtml(row.label)} · ${escHtml(String(row.count))} teams · ${escHtml(String(Math.round(row.pct * 100)))}%</title></circle>`;
  }).join("");
  const visibleRows = rows.slice(0, 3);
  const activeRow = activeId !== "all" ? rows.find(row => row.id === activeId) : null;
  if (activeRow && !visibleRows.some(row => row.id === activeRow.id)) {
    if (visibleRows.length >= 3) visibleRows[visibleRows.length - 1] = activeRow;
    else visibleRows.push(activeRow);
  }
  const visibleIds = new Set(visibleRows.map(row => row.id));
  const hiddenRows = rows.filter(row => !visibleIds.has(row.id));
  const hiddenTeams = hiddenRows.reduce((sum, row) => sum + row.count, 0);
  const topRows = visibleRows.map(row => `
    <button type="button" class="ac-dist-row${activeId === row.id ? " is-selected" : ""}" data-const-interest="${escAttr(row.id)}" style="${escAttr(constWellAccentStyle(row.accent))}">
      <span>${escHtml(row.label)}</span>
      <em>${escHtml(String(row.count))} · ${escHtml(String(Math.round(row.pct * 100)))}%</em>
    </button>`).join("");
  const moreRow = hiddenRows.length
    ? `<div class="ac-dist-more">+${escHtml(String(hiddenRows.length))} more worlds · ${escHtml(String(hiddenTeams))} teams</div>`
    : "";
  return `
    <div class="ac-distribution-card" aria-label="ecosystem composition">
      <button type="button" class="ac-dist-reset" data-const-interest="all">ecosystem mix</button>
      <div class="ac-dist-body">
        <svg class="ac-cluster-donut" viewBox="0 0 64 64" role="group" aria-label="ecosystem composition">
          <circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(226,207,162,0.08)" stroke-width="6"/>
          ${segments}
          <text x="32" y="29" text-anchor="middle">${escHtml(String(wells.reduce((sum, well) => sum + (well.members?.length || well.count || 0), 0)))}</text>
          <text x="32" y="40" text-anchor="middle">teams</text>
        </svg>
        <div class="ac-dist-rows">${topRows}${moreRow}</div>
      </div>
    </div>`;
}

function constRelationshipBreakdown(edges = []) {
  const out = {
    total: 0,
    typed: 0,
    missing: 0,
    reliance: 0,
    collaboration: 0,
    ecosystem: 0,
    unknown: 0,
    active: 0,
    blocked: 0,
    exploring: 0,
  };
  for (const edge of (Array.isArray(edges) ? edges : [])) {
    out.total++;
    if (edge?.normalized) out.typed++;
    else out.missing++;
    const meaning = constRelationshipMeaning(edge).key;
    if (Object.prototype.hasOwnProperty.call(out, meaning)) out[meaning]++;
    else out.unknown++;
    if (edge?.status === "active") out.active++;
    if (edge?.status === "blocked") out.blocked++;
    if (edge?.status === "exploring") out.exploring++;
  }
  return out;
}

function constLensSummaryHtml(ctx) {
  const lens = ctx?.lens || "all";
  if (lens === "all") return "";
  if (lens === "relies" || lens === "works" || lens === "substrate") {
    const spec = {
      relies: {
        title: "relies on",
        label: "dependency / unblock",
      },
      works: {
        title: "works with",
        label: "collaboration",
      },
      substrate: {
        title: "shared substrate",
        label: "substrate",
      },
    }[lens];
    return `
      <section class="ac-inspector-section is-lens-summary">
        <h4>${escHtml(spec.title)}</h4>
        <div class="ac-view-summary">
          <strong>${escHtml(spec.label)}</strong>
          <p>This lens narrows the map to one kind of relationship. Solid lines have a relationship record; dotted lines come from project profile mentions and need confirmation.</p>
        </div>
        <div class="ac-lens-key">
          <span><i class="is-reliance"></i>solid: relationship record</span>
          <span><i class="is-ecosystem"></i>dotted: profile mention</span>
        </div>
      </section>`;
  }
  return "";
}

function constellationInspectorContext(teams, edges, people = []) {
  const all = teams || [];
  const peopleList = Array.isArray(people) ? people : [];
  const teamById = new Map(all.map(t => [t.record_id, t]));
  const personById = new Map(peopleList.filter(p => p?.record_id).map(p => [p.record_id, p]));
  const peopleByTeam = new Map(all.map(t => [t.record_id, []]));
  for (const person of peopleList) {
    if (!person?.team || !peopleByTeam.has(person.team)) continue;
    peopleByTeam.get(person.team).push(person);
  }
  const inBy = new Map(all.map(t => [t.record_id, []]));
  const outBy = new Map(all.map(t => [t.record_id, []]));
  const edgeByPair = new Map();
  for (const e of (edges || [])) {
    if (!teamById.has(e.from) || !teamById.has(e.to)) continue;
    if (!outBy.has(e.from)) outBy.set(e.from, []);
    if (!inBy.has(e.to)) inBy.set(e.to, []);
    outBy.get(e.from).push(e);
    inBy.get(e.to).push(e);
    edgeByPair.set(dependencyPairKey(e.from, e.to), e);
  }
  return { teams: all, people: peopleList, edges: edges || [], teamById, personById, peopleByTeam, inBy, outBy, edgeByPair };
}

function constellationCurrentInspectorContext() {
  const teams = state.cohort?.teams || [];
  const people = state.cohort?.people || [];
  const clusters = state.cohort?.clusters || [];
  const teamById = new Map(teams.filter(t => t?.record_id).map(t => [t.record_id, t]));
  const edges = constellationDependencyEdges(teams, teamById, state.cohort?.dependencies || [])
    .filter(e => teamById.has(e.from) && teamById.has(e.to));
  const model = constellationModel(teams, clusters, state.cohort?.dependencies || []);
  const ctx = constellationInspectorContext(teams, edges, people);
  const rawMode = state.constellationMode === "wells" ? "map" : state.constellationMode;
  const mode = rawMode === "ring" || rawMode === "journey" || rawMode === "stack" ? rawMode : "map";
  const base = { ...ctx, clusters, mode, scope: constNormalizeNetworkScope(state.constellationScope), distributionWells: model.wellsDef, lens: mode === "ring" ? "all" : constNormalizeConstellationLens(state.constellationLens), interest: constInterestContext(teams, clusters, edges, state.constInterest) };
  return mode === "stack" ? { ...base, stackModel: constProductStackModel(teams, base) } : base;
}

function constEvidenceItems(team, ctx) {
  const j = journeyFor(team);
  const assessed = journeyAssessed(team);
  const paperCount = constList(team.paper_basis).length;
  const shipCount = constList(team.prior_shipping).length;
  const inbound = ctx?.inBy?.get(team.record_id)?.length || 0;
  const outbound = ctx?.outBy?.get(team.record_id)?.length || 0;
  const operating = [team.now, team.weekly_goals, team.graduation_target, team.monthly_milestones].filter(constText).length;
  const marketBits = [team.traction, assessed && j.icp, assessed && j.evidence_notes, assessed && j.next_milestone].filter(Boolean).length;
  const profileNote = "profile only; no stronger proof signal";
  return [
    { key: "market", label: "customer traction", value: Math.min(5, marketBits), note: team.traction || (assessed ? j.evidence_notes : "") || profileNote },
    { key: "build", label: "product shipped", value: Math.min(5, shipCount + (team.hackathon_note ? 1 : 0)), note: shipCount ? `${shipCount} public shipping signals` : (team.hackathon_note || profileNote) },
    { key: "research", label: "research basis", value: Math.min(5, paperCount), note: paperCount ? `${paperCount} paper / mechanism references` : profileNote },
    { key: "cohort", label: "cohort pull", value: Math.min(5, inbound + outbound), note: `${inbound} pointing in · ${outbound} pointing out` },
    { key: "operating", label: "operating data", value: Math.min(5, operating), note: operating ? `${operating}/4 operating fields` : profileNote },
  ];
}

function constTeamSignalHtml(team, ctx) {
  const priority = new Set(["market", "build", "research", "cohort"]);
  const items = constEvidenceItems(team, ctx).filter(item => priority.has(item.key));
  return `
    <div class="ac-signal-grid">
      ${items.map(item => `
        <div class="ac-signal-card ac-signal-${escAttr(item.key)}">
          <span>${escHtml(item.label)}</span>
          <strong>${escHtml(String(item.value))}/5</strong>
          <p>${escHtml(constShortText(item.note, 104))}</p>
      </div>`).join("")}
    </div>`;
}

const CONST_STACK_COLUMNS = [
  {
    key: "substrate",
    label: "substrate",
    hint: "runtime, TEE, storage, routing, protocol, or network layer",
    terms: ["tee", "tdx", "sev", "dstack", "confidential", "cvm", "postgres", "storage", "routing", "router", "protocol", "network", "runtime", "sdk", "evm", "tevm", "identity", "attested", "tls", "infrastructure"],
  },
  {
    key: "developer",
    label: "developer tooling",
    hint: "builder workflows, coding agents, frameworks, repos, test systems",
    terms: ["developer", "github", "code", "coding", "repo", "framework", "plugin", "agent framework", "runtime", "langgraph", "test", "corpus", "programming", "automation", "abstraction", "sdk", "tooling"],
  },
  {
    key: "proof",
    label: "proof / data",
    hint: "attestation, research IP, market data, verification, knowledge layer",
    terms: ["proof", "attestation", "verify", "verified", "measurement", "data", "market data", "research", "paper", "mechanism", "microstructure", "prediction market", "oracle", "belief", "retrieval", "knowledge", "biosensor", "privacy"],
  },
  {
    key: "application",
    label: "application",
    hint: "end-user app, workflow, interface, creative or consumer experience",
    terms: ["app", "ios", "consumer", "speaking", "practice", "chat", "signal", "relationship", "hardware", "creative", "experience", "workflow", "interface", "ux", "payer", "ehr", "prior authorization"],
  },
  {
    key: "market",
    label: "market / customer",
    hint: "buyer, GTM, paid pilot, distribution, customer or marketplace motion",
    terms: ["customer", "buyer", "paid", "pilot", "users", "gtm", "bd", "sales", "distribution", "market", "marketplace", "pharma", "payer", "fundraising", "commercial", "monetization", "retention"],
  },
];

const CONST_STACK_ROWS = [
  { key: "market", label: "customer traction", hint: "traction, paid use, user behavior, ICP, or customer proof" },
  { key: "build", label: "product shipped", hint: "working product, shipped code, prior shipping, or live prototype" },
  { key: "research", label: "research lineage", hint: "paper basis, mechanism research, citations, or research-to-product work" },
  { key: "cohort", label: "cohort leverage", hint: "inbound/outbound cohort relationships and dependency surface" },
  { key: "profile", label: "profile only", hint: "domain, focus, skills, and current notes; orientation, not proof" },
];
const CONST_STACK_ROW_SHORT = {
  market: "market",
  build: "shipping",
  research: "research",
  cohort: "cohort",
  profile: "profile",
};
const CONST_STACK_COLUMN_SHORT = {
  substrate: "substrate",
  developer: "dev tools",
  proof: "proof / data",
  application: "app",
  market: "market",
};

function constStackSourceText(team) {
  const j = journeyFor(team);
  return [
    team?.name,
    team?.domain,
    team?.focus,
    team?.now,
    team?.traction,
    team?.weekly_goals,
    team?.graduation_target,
    team?.monthly_milestones,
    team?.hackathon_note,
    ...(Array.isArray(team?.skill_areas) ? team.skill_areas : []),
    ...(Array.isArray(team?.success_dimensions) ? team.success_dimensions : []),
    ...(Array.isArray(team?.prior_shipping) ? team.prior_shipping : []),
    ...(Array.isArray(team?.paper_basis) ? team.paper_basis : []),
    ...(Array.isArray(team?.seeking) ? team.seeking : []),
    ...(Array.isArray(team?.offering) ? team.offering : []),
    j.company_type,
    j.problem,
    j.solution,
    j.icp,
    j.evidence_notes,
    j.next_milestone,
  ].map(constText).filter(Boolean).join(" ").toLowerCase();
}

function constTermMatches(text, term) {
  const haystack = ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  const needle = String(term || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!needle) return false;
  if (haystack.includes(` ${needle} `)) return true;
  if (needle.includes(" ") || needle.length < 3) return false;
  const plural = needle.endsWith("s") ? needle.slice(0, -1) : `${needle}s`;
  return plural.length > 3 && haystack.includes(` ${plural} `);
}

function constTermHits(text, terms = []) {
  const hits = [];
  for (const term of terms) {
    const needle = String(term || "").toLowerCase();
    if (needle && constTermMatches(text, needle)) hits.push(needle);
  }
  return hits;
}

const CONST_STACK_TERM_LABELS = new Map([
  ["tee", "TEE"],
  ["tdx", "TDX"],
  ["sev", "SEV"],
  ["dstack", "dstack"],
  ["cvm", "CVM"],
  ["tls", "TLS"],
  ["sdk", "SDK"],
  ["evm", "EVM"],
  ["tevm", "tEVM"],
  ["github", "GitHub"],
  ["repo", "repository"],
  ["langgraph", "LangGraph"],
  ["ios", "iOS"],
  ["ux", "UX"],
  ["ehr", "EHR"],
  ["gtm", "GTM"],
  ["bd", "BD"],
  ["icp", "ICP"],
  ["paid", "paid use"],
  ["pilot", "pilot"],
  ["users", "users"],
  ["user", "user"],
  ["customer", "customer"],
  ["buyer", "buyer"],
  ["attested", "attestation"],
  ["attestation", "attestation"],
  ["confidential", "confidential compute"],
  ["postgres", "Postgres"],
  ["prediction market", "prediction market"],
  ["market data", "market data"],
  ["agent framework", "agent framework"],
  ["prior authorization", "prior authorization"],
]);

function constStackTermLabel(term) {
  const raw = constText(term).toLowerCase();
  if (!raw) return "";
  return CONST_STACK_TERM_LABELS.get(raw) || raw.replace(/\b\w/g, c => c.toUpperCase());
}

function constStackRoleReason(hits = [], domain = "") {
  const labels = [];
  for (const hit of hits) {
    const label = constStackTermLabel(hit);
    if (label && !labels.includes(label)) labels.push(label);
    if (labels.length >= 3) break;
  }
  if (labels.length) return `source mentions: ${labels.join(" · ")}`;
  const domainLabel = CONST_DOMAIN_LABEL[domain];
  if (domainLabel) return `domain signal: ${domainLabel}`;
  return "profile only";
}

function constMarketRoleForTeam(team) {
  const text = constStackSourceText(team);
  const domain = constDomainClass(team?.domain);
  const scores = new Map(CONST_STACK_COLUMNS.map(col => [col.key, 0]));
  const hitsByKey = new Map();
  for (const col of CONST_STACK_COLUMNS) {
    const hits = constTermHits(text, col.terms);
    hitsByKey.set(col.key, hits);
    scores.set(col.key, (scores.get(col.key) || 0) + hits.length);
  }
  if (domain === "tee") scores.set("substrate", (scores.get("substrate") || 0) + 3);
  if (domain === "ai") scores.set("developer", (scores.get("developer") || 0) + 2);
  if (domain === "crypto") {
    scores.set("proof", (scores.get("proof") || 0) + 1);
    scores.set("substrate", (scores.get("substrate") || 0) + 1);
  }
  if (domain === "app-ux") scores.set("application", (scores.get("application") || 0) + 3);
  if (constList(team?.paper_basis).length) scores.set("proof", (scores.get("proof") || 0) + 2);
  if (/paid|pilot|users?|customer|buyer|retention|monetization|gtm|bd/.test(text)) scores.set("market", (scores.get("market") || 0) + 2);
  const ranked = CONST_STACK_COLUMNS
    .map((col, idx) => ({ ...col, score: scores.get(col.key) || 0, hits: hitsByKey.get(col.key) || [], idx }))
    .sort((a, b) => b.score - a.score || a.idx - b.idx);
  const primary = ranked[0];
  const secondary = ranked.find(item => item.key !== primary.key && item.score > 0) || null;
  const roleReason = constStackRoleReason(primary.hits, domain);
  return {
    key: primary.key,
    label: primary.label,
    score: primary.score,
    secondary,
    reason: roleReason,
  };
}

function constEvidenceModeForTeam(team, ctx) {
  const order = new Map(CONST_STACK_ROWS.map((row, idx) => [row.key, idx]));
  const items = constEvidenceItems(team, ctx);
  const ranked = items
    .filter(item => item.key !== "profile" && order.has(item.key))
    .sort((a, b) => b.value - a.value || order.get(a.key) - order.get(b.key));
  const top = ranked[0] || { key: "build", value: 0, note: "profile only; no stronger proof signal" };
  if ((top.value || 0) <= 0) {
    const profileSpec = CONST_STACK_ROWS.find(row => row.key === "profile");
    const operating = items.find(item => item.key === "operating");
    return { ...profileSpec, value: operating?.value || 0, note: profileSpec.hint };
  }
  const spec = CONST_STACK_ROWS.find(row => row.key === top.key) || CONST_STACK_ROWS[1];
  return { ...spec, value: top.value, note: top.note || spec.hint };
}

function constProductStackModel(teams = [], ctx) {
  const cells = new Map();
  for (const row of CONST_STACK_ROWS) {
    for (const col of CONST_STACK_COLUMNS) cells.set(`${row.key}:${col.key}`, []);
  }
  const teamRows = (Array.isArray(teams) ? teams : [])
    .filter(team => team?.record_id && teamKind(team) !== "person")
    .map(team => {
      const role = constMarketRoleForTeam(team);
      const evidence = constEvidenceModeForTeam(team, ctx);
      const inbound = ctx?.inBy?.get(team.record_id)?.length || 0;
      const outbound = ctx?.outBy?.get(team.record_id)?.length || 0;
      const allEdges = [
        ...(ctx?.inBy?.get(team.record_id) || []),
        ...(ctx?.outBy?.get(team.record_id) || []),
      ];
      const typed = allEdges.filter(edge => edge.normalized).length;
      const profile = Math.max(0, allEdges.length - typed);
      const item = { team, role, evidence, inbound, outbound, typed, profile };
      const key = `${evidence.key}:${role.key}`;
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(item);
      return item;
    });
  for (const list of cells.values()) {
    list.sort((a, b) =>
      (b.inbound + b.outbound) - (a.inbound + a.outbound)
      || String(a.team.name || a.team.record_id).localeCompare(String(b.team.name || b.team.record_id)));
  }
  const columnCounts = CONST_STACK_COLUMNS.map(col => ({
    ...col,
    count: teamRows.filter(item => item.role.key === col.key).length,
  }));
  return { rows: CONST_STACK_ROWS, columns: columnCounts, cells, teamRows, columnCounts };
}

function constStackItemForTeam(ctx, rid) {
  const recordId = constText(rid);
  return (ctx?.stackModel?.teamRows || []).find(item => item.team?.record_id === recordId) || null;
}

function constStackPlacementHtml(team, ctx) {
  if (ctx?.mode !== "stack") return "";
  const item = constStackItemForTeam(ctx, team?.record_id);
  if (!item) return "";
  const secondary = item.role.secondary;
  const proof = `${item.evidence.label}${item.evidence.key === "profile" ? "" : ` · ${item.evidence.value}/5`}`;
  const secondaryRead = secondary ? `also reads as ${secondary.label}` : "";
  return `
    <section class="ac-inspector-section is-stack-placement">
      <h4>stack placement</h4>
      <dl class="ac-bet-list">
        <div><dt>product layer</dt><dd>${escHtml(item.role.label)}</dd></div>
        ${secondaryRead ? `<div><dt>secondary role</dt><dd>${escHtml(secondaryRead)}</dd></div>` : ""}
        <div><dt>role basis</dt><dd>${escHtml(constShortText(item.role.reason, 160))}</dd></div>
        <div><dt>evidence</dt><dd>${escHtml(proof)}</dd></div>
        <div><dt>evidence basis</dt><dd>${escHtml(constShortText(item.evidence.note, 170))}</dd></div>
      </dl>
    </section>`;
}

function constProductStackHtml(model) {
  const layerRows = model.columns
    .map(col => {
      const items = model.teamRows
        .filter(item => item.role.key === col.key)
        .slice()
        .sort((a, b) =>
          (b.evidence.value || 0) - (a.evidence.value || 0)
          || b.typed - a.typed
          || (b.inbound + b.outbound) - (a.inbound + a.outbound)
          || String(a.team.name || a.team.record_id).localeCompare(String(b.team.name || b.team.record_id)));
      return { col, items };
    })
    .filter(group => group.items.length);
  if (!layerRows.length) return `<p class="ac-stack-empty">no companies to place yet.</p>`;
  return `
    <div class="ac-stack-view is-layer-list">
      ${layerRows.map(({ col, items }) => `
        <section class="ac-stack-layer ac-stack-col-${escAttr(col.key)}">
          <header class="ac-stack-layer-head">
            <strong>${escHtml(col.label)}</strong>
            <span>${escHtml(constTeamCountText(items.length))}</span>
          </header>
          <div class="ac-stack-layer-list">
            ${items.map(item => {
              const domain = constDomainClass(item.team.domain);
              const color = CONST_DOMAIN_COLORS[domain] || CONST_DOMAIN_COLORS.other;
              const relationshipSurface = item.typed + item.profile;
              const relationship = item.typed
                ? `${item.typed} relationship record${item.typed === 1 ? "" : "s"}`
                : (relationshipSurface ? `${item.profile} profile mention${item.profile === 1 ? "" : "s"}` : "no relationship lines");
              const sourceSignal = item.evidence.key === "profile"
                ? "profile data"
                : item.evidence.label;
              const title = `${item.team.name || item.team.record_id}: ${item.team.focus || item.team.now || item.role.reason || col.label}`;
              return `
                <button type="button" class="ac-stack-team ac-stack-domain-${escAttr(domain)}" data-const-team="${escAttr(item.team.record_id)}" title="${escAttr(title)}" aria-label="${escAttr(title)}" style="--team-color:${escAttr(color)};--team-size:12px">
                  <i aria-hidden="true"></i>
                  <span>${escHtml(item.team.name || item.team.record_id)}</span>
                  <p>${escHtml(constShortText(item.team.focus || item.team.now || item.role.reason, 124))}</p>
                  <em>${escHtml(sourceSignal)}</em>
                  <small>${escHtml(relationship)}</small>
                </button>`;
            }).join("")}
          </div>
        </section>`).join("")}
    </div>`;
}

function constStackSummaryHtml(ctx) {
  const model = ctx?.stackModel;
  if (!model) return "";
  const top = model.columnCounts.slice().sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 3);
  return `
    <section class="ac-inspector-section is-stack-summary">
      <h4>largest product layers</h4>
      <div class="ac-view-chips">
        ${top.map(item => `<span>${escHtml(item.label)}<em>${escHtml(String(item.count))}</em></span>`).join("")}
      </div>
    </section>`;
}

function constStackReadoutHtml(ctx) {
  const model = ctx?.stackModel;
  if (!model) return "";
  const ordered = model.columnCounts.slice().sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const top = ordered[0];
  const second = ordered[1];
  const market = ordered.find(item => item.key === "market");
  const total = model.teamRows?.length || 0;
  const title = top
    ? `${top.label} is the largest product layer`
    : "No product layers to place yet";
  const body = top
    ? `${top.count}/${total} projects currently read as ${top.label}${second ? `, followed by ${second.label}` : ""}. ${market && market.count <= Math.max(1, Math.floor(total * 0.16)) ? "Market/customer signal is still thin." : "Market/customer signal is visible but should be checked against traction."}`
    : "Add team/project records before using the stack view.";
  return `
    <section class="ac-main-readout is-stack-readout" aria-label="product stack readout">
      <div class="ac-inspector-kicker">generated stack read</div>
      <h3>${escHtml(title)}</h3>
      <p>${escHtml(body)}</p>
      <div class="ac-view-chips">
        ${ordered.slice(0, 4).map(item => `<span>${escHtml(item.label)}<em>${escHtml(String(item.count))}</em></span>`).join("")}
      </div>
    </section>`;
}

function constJourneyReadoutHtml(visibleTeams = [], allTeams = visibleTeams) {
  const cohortTeams = (Array.isArray(allTeams) ? allTeams : []).filter(team => teamKind(team) !== "person");
  const visible = (Array.isArray(visibleTeams) ? visibleTeams : []).filter(team => teamKind(team) !== "person");
  const assessed = cohortTeams.filter(journeyAssessed);
  const visibleAssessed = visible.filter(journeyAssessed).length;
  const top = assessed.slice().sort((a, b) => {
    const aj = journeyFor(a);
    const bj = journeyFor(b);
    return bj.evidence_quality - aj.evidence_quality
      || bj.stage - aj.stage
      || String(a.name || a.record_id).localeCompare(String(b.name || b.record_id));
  }).slice(0, 3);
  const missing = Math.max(0, cohortTeams.length - assessed.length);
  const title = assessed.length
    ? `${assessed.length}/${cohortTeams.length} explicit PMF reads`
    : "PMF journey coverage is missing";
  const body = assessed.length
    ? `This view is evidence coverage, not a cohort-wide maturity ranking. ${missing} profile dot${missing === 1 ? "" : "s"} mean missing journey data, not weak companies.`
    : "Every plotted dot is profile context until a team has an explicit journey read.";
  return `
    <section class="ac-main-readout is-journey-readout" aria-label="pmf evidence coverage readout">
      <div class="ac-inspector-kicker">generated PMF evidence read</div>
      <h3>${escHtml(title)}</h3>
      <p>${escHtml(body)}</p>
      <div class="ac-view-chips">
        <span>shown assessed<em>${escHtml(String(visibleAssessed))}</em></span>
        <span>missing assessment<em>${escHtml(String(missing))}</em></span>
        ${top.map(team => {
          const j = journeyFor(team);
          return `<span>${escHtml(team.name || team.record_id)}<em>${escHtml(`${j.stage}/${j.evidence_quality}`)}</em></span>`;
        }).join("")}
      </div>
    </section>`;
}

function constTeamOperatingHtml(team) {
  const rows = [
    ["now", team?.now],
    ["this week", team?.weekly_goals],
    ["target", team?.graduation_target],
  ].filter(([, value]) => constText(value));
  if (!rows.length) return "";
  return `
    <dl class="ac-bet-list ac-operating-list">
      ${rows.map(([label, value]) => `<div><dt>${escHtml(label)}</dt><dd>${escHtml(constShortText(value, 150))}</dd></div>`).join("")}
    </dl>`;
}

function constTeamRelationshipStatsHtml(team, ctx) {
  const inbound = ctx?.inBy?.get(team?.record_id) || [];
  const outbound = ctx?.outBy?.get(team?.record_id) || [];
  const allEdges = [...outbound, ...inbound];
  if (!allEdges.length) return "";
  const typed = allEdges.filter(edge => edge.normalized).length;
  const profileLinks = Math.max(0, allEdges.length - typed);
  const reliance = allEdges.filter(edge => constRelationshipMeaning(edge).key === "reliance").length;
  const collaboration = allEdges.filter(edge => constRelationshipMeaning(edge).key === "collaboration").length;
  return `
    <div class="ac-inspector-pills is-summary">
      <span><strong>${escHtml(String(outbound.length))}</strong> outbound</span>
      <span><strong>${escHtml(String(inbound.length))}</strong> inbound</span>
      <span><strong>${escHtml(String(typed))}</strong> records</span>
      ${profileLinks ? `<span><strong>${escHtml(String(profileLinks))}</strong> mentions</span>` : ""}
      ${reliance ? `<span><strong>${escHtml(String(reliance))}</strong> reliance</span>` : ""}
      ${collaboration ? `<span><strong>${escHtml(String(collaboration))}</strong> collab</span>` : ""}
    </div>`;
}

function constInspectorDetailsHtml(summary, body, open = false) {
  return `
    <details class="ac-inspector-details"${open ? " open" : ""}>
      <summary>${escHtml(summary)}</summary>
      <div class="ac-inspector-details-body">${body}</div>
    </details>`;
}

function constMiniListHtml(title, values, empty = "none listed", max = 3) {
  const list = constList(values).slice(0, max);
  return `
    <div class="ac-inspector-mini">
      <span>${escHtml(title)}</span>
      ${list.length
        ? `<ul>${list.map(v => `<li>${escHtml(constShortText(v, 96))}</li>`).join("")}</ul>`
        : `<p>${escHtml(empty)}</p>`}
    </div>`;
}

function constPersonRelevanceScore(person, team) {
  const role = String(person?.role || "");
  const goto = constList(person?.go_to_them_for).join(" ").toLowerCase();
  const cueText = [
    ...constList(team?.skill_areas),
    ...constList(team?.seeking),
    ...constList(team?.offering),
    team?.focus,
    team?.now,
  ].map(constText).join(" ").toLowerCase();
  const cueTokens = cueText.split(/[^a-z0-9]+/).filter(token => token.length >= 5);
  let score = 0;
  if (/lead|founder|cofounder|co-founder/i.test(role)) score += 8;
  if (goto) score += 3;
  for (const token of new Set(cueTokens)) if (goto.includes(token)) score += 2;
  return score;
}

function constPeopleForTeam(team, ctx) {
  return (ctx?.peopleByTeam?.get(team?.record_id) || [])
    .slice()
    .sort((a, b) => {
      const ar = constPersonRelevanceScore(a, team);
      const br = constPersonRelevanceScore(b, team);
      return br - ar || String(a.name || a.record_id).localeCompare(String(b.name || b.record_id));
    });
}

const CONST_TALK_STOP = new Set(("about across after against also around because before between building builds built candidate cohort could current does doing every from have into next only other project projects record records related relationship should signal source team teams their there these they this through typed want wants where which with without would").split(/\s+/));

function constTalkTokens(values) {
  const out = new Set();
  const raw = Array.isArray(values) ? values : [values];
  for (const item of raw) {
    const text = constText(item).toLowerCase();
    if (!text) continue;
    text.split(/[^a-z0-9+]+/).forEach(token => {
      if (token.length >= 4 && !CONST_TALK_STOP.has(token)) out.add(token);
    });
  }
  return out;
}

function constPrimaryWorldByTeam(ctx) {
  const out = new Map();
  for (const well of (ctx?.distributionWells || [])) {
    const id = constText(well?.id);
    if (!id) continue;
    const label = constText(well?.label || id);
    for (const rid of (Array.isArray(well?.members) ? well.members : [])) {
      if (!out.has(rid)) out.set(rid, { id, label });
    }
  }
  if (out.size) return out;
  for (const cl of (ctx?.clusters || [])) {
    const id = constClusterId(cl);
    if (!id) continue;
    const label = constClusterLabel(cl);
    for (const rid of (Array.isArray(cl?.teams) ? cl.teams : [])) {
      if (!out.has(rid)) out.set(rid, { id, label });
    }
  }
  return out;
}

function constCorridorEdgeScore(edge, ctx) {
  const confidence = constText(edge?.confidence).toLowerCase();
  const confidenceWeight = confidence === "high" ? 3 : (confidence === "medium" ? 2 : (confidence === "low" ? 1 : 0));
  const sourceCueWeight = Math.min(2, constTranscriptCuesForEdge(edge, ctx, 2).length) * 2;
  return (edge?.normalized ? 8 : 2)
    + (constText(edge?.next_action) ? 4 : 0)
    + (Array.isArray(edge?.evidence) && edge.evidence.length ? 3 : 0)
    + confidenceWeight
    + sourceCueWeight;
}

function constTopCorridors(ctx, max = 3) {
  const worldByTeam = constPrimaryWorldByTeam(ctx);
  const teamById = ctx?.teamById || new Map();
  const rows = new Map();
  for (const edge of (ctx?.edges || [])) {
    if (!teamById.has(edge?.from) || !teamById.has(edge?.to)) continue;
    const fromWorld = worldByTeam.get(edge.from);
    const toWorld = worldByTeam.get(edge.to);
    if (!fromWorld || !toWorld || fromWorld.id === toWorld.id) continue;
    const pair = [fromWorld, toWorld].sort((a, b) => a.id.localeCompare(b.id));
    const key = `${pair[0].id}::${pair[1].id}`;
    const current = rows.get(key) || {
      key,
      a: pair[0],
      b: pair[1],
      typed: 0,
      profile: 0,
      score: 0,
      teams: new Set(),
      topEdge: null,
      topScore: -Infinity,
    };
    const edgeScore = constCorridorEdgeScore(edge, ctx);
    current.score += edgeScore;
    if (edge?.normalized) current.typed++;
    else current.profile++;
    current.teams.add(edge.from);
    current.teams.add(edge.to);
    if (edgeScore > current.topScore) {
      current.topScore = edgeScore;
      current.topEdge = edge;
    }
    rows.set(key, current);
  }
  return [...rows.values()]
    .sort((a, b) =>
      b.score - a.score
      || b.typed - a.typed
      || b.profile - a.profile
      || a.a.label.localeCompare(b.a.label)
      || a.b.label.localeCompare(b.b.label))
    .slice(0, max);
}

function constLineBasisText(typed, profile) {
  const parts = [];
  if (typed) parts.push(`${typed} record line${typed === 1 ? "" : "s"}`);
  if (profile) parts.push(`${profile} profile mention${profile === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" · ") : "no relationship lines";
}

function constMapReadout(ctx) {
  const breakdown = constRelationshipBreakdown(ctx?.edges || []);
  const corridors = constTopCorridors(ctx, 3);
  const top = corridors[0] || null;
  const title = top
    ? `${top.a.label} to ${top.b.label}`
    : "Start with the bright lines";
  const body = top
    ? `${top.a.label} to ${top.b.label} is the strongest current cross-world corridor from the source bundle. Line mix: ${constLineBasisText(top.typed, top.profile)}.`
    : "No cross-world corridor is strong enough to headline yet; inspect the relationship rows first.";
  const caveat = `${breakdown.typed} relationship record${breakdown.typed === 1 ? "" : "s"} and ${breakdown.missing} profile mention${breakdown.missing === 1 ? "" : "s"}. Solid lines have records; dotted lines are leads to verify.`;
  return { title, body, caveat, corridors, breakdown };
}

function constMapReadoutHeroHtml(ctx, kicker = "generated readout") {
  const read = constMapReadout(ctx);
  return `
    <div class="ac-inspector-hero is-generated-readout">
      <div class="ac-inspector-kicker">${escHtml(kicker)}</div>
      <h3>${escHtml(read.title)}</h3>
      <p>${escHtml(read.body)}</p>
      <div class="ac-inspector-pills">
        <span><strong>${escHtml(String(read.breakdown.typed))}</strong> records</span>
        <span><strong>${escHtml(String(read.breakdown.missing))}</strong> mentions</span>
      </div>
      <p class="ac-rel-queue-more">${escHtml(read.caveat)}</p>
    </div>`;
}

function constCorridorReadoutHtml(ctx) {
  const corridors = constTopCorridors(ctx, 3);
  if (!corridors.length) return "";
  return `
    <section class="ac-inspector-section ac-action-card is-corridor-readout">
      <h4>top corridors</h4>
      <div class="ac-action-list">
        ${corridors.map(row => {
          const edge = row.topEdge;
          const fromName = ctx?.teamById?.get(edge?.from)?.name || edge?.from || "source";
          const toName = ctx?.teamById?.get(edge?.to)?.name || edge?.to || "target";
          return `
            <button type="button" class="ac-action-row${edge?.normalized ? " is-source-backed" : " is-profile-link"}" data-const-edge-from="${escAttr(edge?.from || "")}" data-const-edge-to="${escAttr(edge?.to || "")}">
              <strong>${escHtml(row.a.label)} to ${escHtml(row.b.label)}</strong>
              <p>${escHtml(constLineBasisText(row.typed, row.profile))} · ${escHtml(String(row.teams.size))} teams touched</p>
              <small>${escHtml(`${fromName} -> ${toName}: ${constRelationshipMeaning(edge).label}`)}</small>
            </button>`;
        }).join("")}
      </div>
    </section>`;
}

function constDataCoverageHtml(ctx) {
  const breakdown = constRelationshipBreakdown(ctx?.edges || []);
  const coverage = constConstellationCoverage(ctx?.teams || [], ctx?.edges || []);
  const missingOwner = (ctx?.edges || []).filter(edge => edge?.normalized && !constText(edge.owner)).length;
  const missingJourney = Math.max(0, coverage.teams - coverage.assessed);
  return `
    <section class="ac-inspector-section is-data-coverage">
      <h4>source caveat</h4>
      <div class="ac-view-chips">
        <span>record lines<em>${escHtml(String(breakdown.typed))}</em></span>
        <span>profile mentions<em>${escHtml(String(breakdown.missing))}</em></span>
        <span>missing journey<em>${escHtml(String(missingJourney))}</em></span>
        ${missingOwner ? `<span>missing owner<em>${escHtml(String(missingOwner))}</em></span>` : ""}
      </div>
      <p class="ac-rel-queue-more">Profile-mention lines are leads. They should not read as source-backed relationships until a relationship record supplies evidence, owner, and next action.</p>
    </section>`;
}

function constTalkTokenOverlap(a, b) {
  const aa = constTalkTokens(a);
  const bb = constTalkTokens(b);
  const shared = [];
  for (const token of aa) if (bb.has(token)) shared.push(token);
  return shared;
}

function constSharedSkillList(a, b) {
  const bSkills = new Set(constTeamSkillList(b).map(s => s.toLowerCase()));
  return constTeamSkillList(a).filter(s => bSkills.has(s.toLowerCase()));
}

function constTeamWorldRows(team, ctx) {
  const memberships = constClusterMembershipByTeam(ctx?.clusters || []).get(team?.record_id) || [];
  return memberships.map(item => item.label).filter(Boolean);
}

function constTeamEvidenceLevel(team, ctx) {
  const inbound = ctx?.inBy?.get(team?.record_id) || [];
  const outbound = ctx?.outBy?.get(team?.record_id) || [];
  const allEdges = [...outbound, ...inbound];
  const typed = allEdges.filter(edge => edge.normalized).length;
  const profile = Math.max(0, allEdges.length - typed);
  const cues = constTranscriptCuesForTeam(team).length;
  if (typed) {
    return {
      key: "typed",
      label: "relationship record",
      note: `${typed} source-backed line${typed === 1 ? "" : "s"}${profile ? ` plus ${profile} profile mention${profile === 1 ? "" : "s"}` : ""}.`,
    };
  }
  if (profile) {
    return {
      key: "profile",
      label: "profile mention",
      note: `${profile} profile mention${profile === 1 ? "" : "s"}; no relationship record yet.`,
    };
  }
  if (cues) {
    return {
      key: "cue",
      label: "source cue only",
      note: `${cues} transcript/source cue${cues === 1 ? "" : "s"}; no relationship line yet.`,
    };
  }
  return {
    key: "profile",
    label: "profile data only",
    note: "No relationship line is attached yet.",
  };
}

function constSeekingOfferingCue(a, b) {
  const aSeeking = constList(a?.seeking);
  const aOffering = constList(a?.offering);
  const bSeeking = constList(b?.seeking);
  const bOffering = constList(b?.offering);
  const aNeedsB = constTalkTokenOverlap(aSeeking, bOffering);
  const bNeedsA = constTalkTokenOverlap(bSeeking, aOffering);
  if (aNeedsB.length) {
    const seeking = constShortText(aSeeking[0] || "listed help", 92);
    const offering = constShortText(bOffering[0] || "related support", 92);
    return {
      score: aNeedsB.length,
      direction: `${a?.name || a?.record_id} is seeking ${seeking}; ${b?.name || b?.record_id} may offer related help.`,
      detail: `${seeking} / ${offering}`,
    };
  }
  if (bNeedsA.length) {
    const seeking = constShortText(bSeeking[0] || "listed help", 92);
    const offering = constShortText(aOffering[0] || "related support", 92);
    return {
      score: bNeedsA.length,
      direction: `${b?.name || b?.record_id} is seeking ${seeking}; ${a?.name || a?.record_id} may offer related help.`,
      detail: `${seeking} / ${offering}`,
    };
  }
  return { score: 0, direction: "", detail: "" };
}

function constTeamTalkCandidates(team, ctx, max = 3) {
  if (!team?.record_id) return [];
  const teamById = ctx?.teamById || new Map();
  const outbound = ctx?.outBy?.get(team.record_id) || [];
  const inbound = ctx?.inBy?.get(team.record_id) || [];
  const edges = [...outbound, ...inbound];
  const membershipsByTeam = constClusterMembershipByTeam(ctx?.clusters || []);
  const ownWorlds = new Set((membershipsByTeam.get(team.record_id) || []).map(item => item.id));
  const candidates = [];
  const seen = new Set();
  const seenTeams = new Set();
  const addCandidate = row => {
    if (!row?.team?.record_id || row.team.record_id === team.record_id) return;
    const key = row.edge ? dependencyPairKey(row.edge.from, row.edge.to) : row.team.record_id;
    if (seen.has(key) || seenTeams.has(row.team.record_id)) return;
    seen.add(key);
    seenTeams.add(row.team.record_id);
    candidates.push(row);
  };

  for (const edge of edges) {
    const otherId = edge.from === team.record_id ? edge.to : edge.from;
    const other = teamById.get(otherId);
    if (!other) continue;
    const sharedSkills = constSharedSkillList(team, other);
    const cue = constSeekingOfferingCue(team, other);
    const otherWorlds = new Set((membershipsByTeam.get(other.record_id) || []).map(item => item.id));
    const crossesWorld = [...otherWorlds].some(id => !ownWorlds.has(id));
    const nextAction = constText(edge.next_action);
    const score = (edge.normalized ? 100 : 38)
      + (nextAction ? 28 : 0)
      + (edge.evidence?.length ? 12 : 0)
      + (edge.confidence === "high" ? 12 : edge.confidence === "medium" ? 8 : edge.confidence === "low" ? 4 : 0)
      + cue.score * 6
      + sharedSkills.length * 2
      + (crossesWorld ? 5 : 0);
    const basis = edge.normalized
      ? "relationship record"
      : "profile mention";
    const action = nextAction
      || cue.direction
      || constRelationshipOneLine(edge, team.name || team.record_id, other.name || other.record_id);
    const detail = nextAction
      ? constRelationshipOneLine(edge, teamById.get(edge.from)?.name || edge.from, teamById.get(edge.to)?.name || edge.to)
      : cue.detail || (sharedSkills.length ? `shared skills: ${sharedSkills.slice(0, 3).join(", ")}` : (crossesWorld ? "cross-world corridor" : constRelationshipStatus(edge).note));
    addCandidate({ team: other, edge, score, basis, action, detail, sourceBacked: Boolean(edge.normalized) });
  }

  for (const other of (ctx?.teams || [])) {
    if (!other?.record_id || other.record_id === team.record_id || seen.has(other.record_id)) continue;
    const cue = constSeekingOfferingCue(team, other);
    const sharedSkills = constSharedSkillList(team, other);
    const otherWorlds = new Set((membershipsByTeam.get(other.record_id) || []).map(item => item.id));
    const sharedWorlds = [...otherWorlds].filter(id => ownWorlds.has(id));
    const score = cue.score * 10 + sharedSkills.length * 2 + sharedWorlds.length;
    if (score < 4) continue;
    const action = cue.direction || `Talk to ${other.name || other.record_id} about shared ${sharedSkills.slice(0, 2).join(", ") || "cohort context"}.`;
    const detail = cue.detail || (sharedSkills.length ? `shared skills: ${sharedSkills.slice(0, 3).join(", ")}` : "same ecosystem corridor");
    addCandidate({ team: other, edge: null, score, basis: "seeking/offering overlap", action, detail, sourceBacked: false });
  }

  return candidates
    .sort((a, b) => b.score - a.score || String(a.team.name || a.team.record_id).localeCompare(String(b.team.name || b.team.record_id)))
    .slice(0, max);
}

function constTeamActionCardHtml(team, ctx) {
  const rows = constTeamTalkCandidates(team, ctx, 3);
  return `
    <section class="ac-inspector-section ac-action-card is-talk-next">
      <h4>who should talk next</h4>
      ${rows.length ? `
        <div class="ac-action-list">
          ${rows.map(row => {
            const dataAttrs = row.edge
              ? `data-const-edge-from="${escAttr(row.edge.from)}" data-const-edge-to="${escAttr(row.edge.to)}"`
              : `data-const-team="${escAttr(row.team.record_id)}"`;
            return `
              <button type="button" class="ac-action-row${row.sourceBacked ? " is-source-backed" : " is-profile-link"}" ${dataAttrs}>
                <strong>${escHtml(row.team.name || row.team.record_id)}</strong>
                <p>${escHtml(constShortText(row.action, 170))}</p>
                ${row.detail ? `<small>${escHtml(constShortText(row.detail, 140))}</small>` : ""}
              </button>`;
          }).join("")}
        </div>`
      : `<p class="ac-inspector-empty">No clear next conversation from relationships, seeking/offering, or shared skills yet.</p>`}
    </section>`;
}

function constEdgeSharedWorlds(from, to, ctx) {
  const memberships = constClusterMembershipByTeam(ctx?.clusters || []);
  const a = memberships.get(from?.record_id) || [];
  const b = memberships.get(to?.record_id) || [];
  const bIds = new Set(b.map(item => item.id));
  return a.filter(item => bIds.has(item.id)).map(item => item.label).filter(Boolean);
}

function constEdgeClearAnswer(edge, from, to, ctx) {
  const sharedSkills = constSharedSkillList(from, to);
  const sharedWorlds = constEdgeSharedWorlds(from, to, ctx);
  const cue = constSeekingOfferingCue(from, to);
  const fromDepends = constList(from?.dependencies).map(x => x.toLowerCase()).includes(String(to?.record_id || "").toLowerCase());
  const toDepends = constList(to?.dependencies).map(x => x.toLowerCase()).includes(String(from?.record_id || "").toLowerCase());
  const fromNeed = constList(from?.seeking)[0] || "";
  const toOffer = constList(to?.offering)[0] || "";
  const fromNow = constText(from?.now || from?.focus);
  const toNow = constText(to?.now || to?.focus);
  const source = constRelationshipSource(edge);
  const nextAction = constText(edge?.next_action);
  let answer = "";
  let next = nextAction;
  if (edge?.normalized) {
    answer = constText(edge.reason)
      || constRelationshipDirection(edge, from.name || from.record_id, to.name || to.record_id)
      || constRelationshipOneLine(edge, from.name || from.record_id, to.name || to.record_id);
  } else if (cue.direction) {
    answer = cue.direction;
  } else if (fromDepends && toDepends) {
    answer = `${from.name || from.record_id} and ${to.name || to.record_id} both point at each other in their profiles. Treat this as a likely integration conversation, not a confirmed dependency.`;
  } else if (fromDepends) {
    answer = `${from.name || from.record_id} names ${to.name || to.record_id} as a dependency. Verify whether ${to.name || to.record_id}'s ${toOffer || toNow || "listed work"} can support ${fromNeed || fromNow || "the current project need"}.`;
  } else if (toDepends) {
    answer = `${to.name || to.record_id} names ${from.name || from.record_id} as a dependency. Verify whether ${from.name || from.record_id}'s ${constList(from?.offering)[0] || fromNow || "listed work"} can support ${constList(to?.seeking)[0] || toNow || "the current project need"}.`;
  } else {
    answer = constRelationshipOneLine(edge, from.name || from.record_id, to.name || to.record_id);
  }
  if (!next) {
    if (edge?.normalized) {
      next = "Confirm the owner and next test for this relationship record.";
    } else if (fromDepends && toDepends) {
      next = `Ask whether ${to.name || to.record_id} should become the attestation / contract layer inside a ${from.name || from.record_id} workflow, or whether the overlap is only conceptual.`;
    } else {
      next = "Turn this profile mention into a relationship record only if both teams confirm the concrete collaboration.";
    }
  }
  const whyParts = [];
  if (sharedSkills.length) whyParts.push(`shared skills: ${sharedSkills.slice(0, 4).join(", ")}`);
  if (sharedWorlds.length) whyParts.push(`shared worlds: ${sharedWorlds.slice(0, 3).join(", ")}`);
  if (cue.detail) whyParts.push(cue.detail);
  if (!whyParts.length) whyParts.push(source.note);
  return {
    answer,
    next,
    why: whyParts.join(" / "),
    caveat: edge?.normalized ? "Relationship record: use this as relationship evidence." : "Profile mention: use this as a conversation lead until a relationship record exists.",
  };
}

function constPersonChipHtml(person) {
  const goto = constList(person?.go_to_them_for).slice(0, 2).join(" · ");
  const meta = [person?.role, goto].map(constText).filter(Boolean).join(" · ");
  return `
    <button type="button" class="ac-person-chip" data-const-person="${escAttr(person.record_id)}">
      <span>${escHtml(person.name || person.record_id)}</span>
      ${meta ? `<small>${escHtml(constShortText(meta, 120))}</small>` : ""}
    </button>`;
}

function constTeamPeopleHtml(team, ctx) {
  const people = constPeopleForTeam(team, ctx).slice(0, 4);
  if (!people.length) return "";
  return `
    <section class="ac-inspector-section is-people">
      <h4>team contacts</h4>
      <div class="ac-person-list">${people.map(constPersonChipHtml).join("")}</div>
    </section>`;
}

function constRelationshipChipHtml(edge, ctx, perspectiveRid) {
  const from = ctx?.teamById?.get(edge.from);
  const to = ctx?.teamById?.get(edge.to);
  if (!from || !to) return "";
  const other = perspectiveRid === edge.from ? to : from;
  const meaning = constRelationshipMeaning(edge);
  const status = constRelationshipStatus(edge);
  const line = constRelationshipOneLine(edge, from.name || from.record_id, to.name || to.record_id);
  return `
    <button type="button" class="ac-relation-chip ac-relation-chip-${escAttr(meaning.key)}" data-const-edge-from="${escAttr(edge.from)}" data-const-edge-to="${escAttr(edge.to)}">
      <span>${escHtml(other.name || other.record_id)}</span>
      <strong>${escHtml(meaning.label)}</strong>
      <small>${escHtml(constShortText(line, 115))}</small>
      <em>${escHtml(status.label)}</em>
    </button>`;
}

function constLensMatchesEdge(edge, lens = "all") {
  if (lens === "all") return true;
  if (!edge?.normalized) return false;
  const meaning = constRelationshipMeaning(edge).key;
  if (lens === "relies") return meaning === "reliance";
  if (lens === "works") return meaning === "collaboration";
  if (lens === "substrate") return meaning === "ecosystem";
  return true;
}

function constRelationshipPriority(edge, lens = "all") {
  if ((lens === "relies" || lens === "works" || lens === "substrate") && edge?.normalized) {
    const meaning = constRelationshipMeaning(edge).key;
    if (lens === "relies" && meaning === "reliance") return { score: 98, label: edge.status === "blocked" ? "blocked reliance" : "reliance" };
    if (lens === "works" && meaning === "collaboration") return { score: 92, label: "collaboration" };
    if (lens === "substrate" && meaning === "ecosystem") return { score: 88, label: "substrate" };
  }
  if (!edge?.normalized) return { score: 44, label: "profile mention" };
  if (edge.status === "blocked") return { score: 100, label: "blocked" };
  if (edge.status === "active") return { score: 94, label: "active line" };
  if (edge.confidence === "high") return { score: 90, label: "verified record" };
  if (edge.confidence === "medium") return { score: 86, label: "source-backed record" };
  if (constText(edge.next_action)) return { score: 82, label: "relationship record" };
  if (edge.confidence === "low") return { score: 78, label: "candidate record" };
  if (edge.status === "exploring") return { score: 72, label: "exploring" };
  return { score: 40, label: edge.status_label || "relationship" };
}

function constDiverseRelationshipQueue(items = [], max = 6) {
  const selected = [];
  const selectedKeys = new Set();
  const endpointCounts = new Map();
  const meaningCounts = new Map();
  const keyFor = item => dependencyPairKey(item.edge.from, item.edge.to);
  const endpointOk = item => {
    const fromCount = endpointCounts.get(item.edge.from) || 0;
    const toCount = endpointCounts.get(item.edge.to) || 0;
    return fromCount < 2 && toCount < 2;
  };
  const meaningOk = item => (meaningCounts.get(item.meaning.key) || 0) < 2;
  const push = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key) || selected.length >= max) return false;
    selected.push(item);
    selectedKeys.add(key);
    endpointCounts.set(item.edge.from, (endpointCounts.get(item.edge.from) || 0) + 1);
    endpointCounts.set(item.edge.to, (endpointCounts.get(item.edge.to) || 0) + 1);
    meaningCounts.set(item.meaning.key, (meaningCounts.get(item.meaning.key) || 0) + 1);
    return true;
  };
  for (const item of items) {
    if (endpointOk(item) && meaningOk(item)) push(item);
    if (selected.length >= max) return selected;
  }
  for (const item of items) {
    if (endpointOk(item)) push(item);
    if (selected.length >= max) return selected;
  }
  for (const item of items) {
    push(item);
    if (selected.length >= max) return selected;
  }
  return selected;
}

function constRelationshipQueue(ctx, max = 6) {
  const teamById = ctx?.teamById || new Map();
  const lens = ctx?.lens || "all";
  const ranked = (ctx?.edges || [])
    .filter(edge => teamById.has(edge.from) && teamById.has(edge.to))
    .filter(edge => constInterestOwnsEdge(edge, ctx?.interest))
    .filter(edge => constLensMatchesEdge(edge, lens))
    .map(edge => {
      const priority = constRelationshipPriority(edge, lens);
      const meaning = constRelationshipMeaning(edge);
      return {
        edge,
        priority,
        meaning,
        fromName: teamById.get(edge.from)?.name || edge.from,
        toName: teamById.get(edge.to)?.name || edge.to,
      };
    })
    .sort((a, b) =>
      b.priority.score - a.priority.score
      || Number(b.edge.normalized) - Number(a.edge.normalized)
      || String(a.fromName).localeCompare(String(b.fromName))
      || String(a.toName).localeCompare(String(b.toName)));
  return constDiverseRelationshipQueue(ranked, max);
}

function constRelationshipQueueHtml(ctx, opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : 6;
  const queue = constRelationshipQueue(ctx, max);
  if (!queue.length) return `<p class="ac-inspector-empty">no connections to inspect yet.</p>`;
  const total = (ctx?.edges || [])
    .filter(edge => ctx?.teamById?.has(edge.from) && ctx?.teamById?.has(edge.to))
    .filter(edge => constInterestOwnsEdge(edge, ctx?.interest))
    .filter(edge => constLensMatchesEdge(edge, ctx?.lens || "all")).length;
  const remaining = Math.max(0, total - queue.length);
  return `
    <div class="ac-rel-queue${opts.compact ? " is-compact" : ""}">
      ${queue.map(({ edge, meaning, fromName, toName }) => {
        return `
        <button type="button" class="ac-rel-row ac-rel-row-${escAttr(meaning.key)}${edge.normalized ? " is-source-backed" : " is-profile-link"}" data-const-edge-from="${escAttr(edge.from)}" data-const-edge-to="${escAttr(edge.to)}">
          <span class="ac-rel-row-copy">
          <span class="ac-rel-row-top">
            <strong>${escHtml(fromName)} → ${escHtml(toName)}</strong>
            <em>${escHtml(meaning.label)}</em>
          </span>
          <span class="ac-rel-row-summary">${escHtml(constRelationshipOneLine(edge, fromName, toName))}</span>
          </span>
        </button>`;
      }).join("")}
      ${remaining ? `<p class="ac-rel-queue-more">${escHtml(String(remaining))} more line${remaining === 1 ? "" : "s"} in graph.</p>` : ""}
    </div>`;
}

function constBridgeTeamRows(ctx, max = 5) {
  const teamById = ctx?.teamById || new Map();
  const membershipsByTeam = constClusterMembershipByTeam(ctx?.clusters || []);
  const rows = (ctx?.teams || [])
    .filter(team => team?.record_id && teamById.has(team.record_id))
    .map(team => {
      const memberships = membershipsByTeam.get(team.record_id) || [];
      const ownClusters = new Set(memberships.map(item => item.id));
      const touching = (ctx?.edges || [])
        .filter(edge => edge?.from === team.record_id || edge?.to === team.record_id)
        .filter(edge => teamById.has(edge.from) && teamById.has(edge.to));
      const typed = touching.filter(edge => edge.normalized);
      const profile = touching.length - typed.length;
      const touchedClusters = new Set(ownClusters);
      let typedCrossWorld = 0;
      let profileCrossWorld = 0;
      for (const edge of touching) {
        const otherId = edge.from === team.record_id ? edge.to : edge.from;
        const otherClusters = membershipsByTeam.get(otherId) || [];
        const otherClusterIds = new Set(otherClusters.map(item => item.id));
        for (const item of otherClusters) touchedClusters.add(item.id);
        const crosses = [...otherClusterIds].some(id => !ownClusters.has(id));
        if (crosses && edge.normalized) typedCrossWorld++;
        else if (crosses) profileCrossWorld++;
      }
      const secondary = Math.max(0, memberships.length - 1);
      const score = typedCrossWorld * 7
        + Math.max(0, typed.length - typedCrossWorld) * 3
        + touchedClusters.size * 1.5
        + secondary * 2
        + profileCrossWorld * 0.7;
      return {
        team,
        score,
        worlds: touchedClusters.size,
        typed: typed.length,
        profile,
        secondary,
        typedCrossWorld,
        profileCrossWorld,
      };
    })
    .filter(row => row.score > 0)
    .sort((a, b) =>
      b.score - a.score
      || b.typedCrossWorld - a.typedCrossWorld
      || b.worlds - a.worlds
      || String(a.team.name || a.team.record_id).localeCompare(String(b.team.name || b.team.record_id)));
  return rows.slice(0, max);
}

function constBridgeTeamRowsHtml(ctx, max = 5) {
  const rows = constBridgeTeamRows(ctx, max);
  if (!rows.length) return `<p class="ac-inspector-empty">no bridge projects in the current relationship graph.</p>`;
  return `
    <div class="ac-bridge-list">
      ${rows.map((row, idx) => `
        <button type="button" class="ac-bridge-row" data-const-team="${escAttr(row.team.record_id)}">
          <span>${escHtml(row.team.name || row.team.record_id)}</span>
          <strong>#${escHtml(String(idx + 1))} bridge</strong>
          <small>${escHtml(`${row.worlds} worlds · ${row.typed} records · ${row.profile} mentions`)}</small>
        </button>`).join("")}
    </div>`;
}

function constPersonInspectorHtml(person, ctx) {
  if (!person) return constellationInspectorDefaultHtml(ctx);
  const team = ctx?.teamById?.get(person.team);
  const secondaryTeams = (Array.isArray(person.secondary_teams) ? person.secondary_teams : [])
    .map(id => ctx?.teamById?.get(id) || { record_id: id, name: id })
    .filter(Boolean);
  const goto = constList(person.go_to_them_for);
  const themes = constList(person.recurring_themes);
  const now = constText(person.now || person.weekly_intention || person.working_style);
  const attachedLabel = team?.name || person.team || "not attached to a project";
  return `
    <div class="ac-inspector-hero" data-const-selected-person="${escAttr(person.record_id)}">
      <div class="ac-inspector-kicker">selected person</div>
      <h3><button type="button" class="ac-inspector-name-link" data-const-open-record="${escAttr(person.record_id)}">${escHtml(constPersonDisplayName(person))}</button></h3>
      <p>${escHtml(constShortText([constPersonRoleLabel(person), attachedLabel].filter(Boolean).join(" · "), 150))}</p>
      <div class="ac-inspector-pills">
        <span>${escHtml(CONST_DOMAIN_LABEL[constDomainClass(person.domain || team?.domain)] || "other")}</span>
        <span>${escHtml(constText(person.role_class).replace(/-/g, " ") || "participant")}</span>
        ${person.geo ? `<span>${escHtml(person.geo)}</span>` : ""}
      </div>
      <div class="ac-inspector-actions">
        ${team?.record_id ? `<button type="button" class="ac-mini-action" data-const-team="${escAttr(team.record_id)}">inspect project</button>` : ""}
      </div>
    </div>
    <section class="ac-inspector-section ac-action-card is-why-here">
      <h4>project connection</h4>
      <dl class="ac-action-facts">
        <div>
          <dt>primary</dt>
          <dd>${team ? `<button type="button" class="ac-inline-record" data-const-team="${escAttr(team.record_id)}">${escHtml(team.name || team.record_id)}</button>` : escHtml(attachedLabel)}</dd>
        </div>
        ${secondaryTeams.length ? `<div><dt>secondary</dt><dd>${secondaryTeams.map(t => `<button type="button" class="ac-inline-record" data-const-team="${escAttr(t.record_id)}">${escHtml(t.name || t.record_id)}</button>`).join(" ")}</dd></div>` : ""}
        <div>
          <dt>source</dt>
          <dd><strong>person profile</strong><span>Primary and secondary links come from person record fields.</span></dd>
        </div>
      </dl>
    </section>
    ${goto.length ? `
      <section class="ac-inspector-section">
        <h4>go to them for</h4>
        <ul class="ac-inspector-list">${goto.slice(0, 5).map(item => `<li>${escHtml(constShortText(item, 120))}</li>`).join("")}</ul>
      </section>` : ""}
    ${themes.length ? `
      <section class="ac-inspector-section">
        <h4>themes</h4>
        <div class="ac-view-chips">${themes.slice(0, 5).map(item => `<span>${escHtml(item)}</span>`).join("")}</div>
      </section>` : ""}
    ${now ? `
      <section class="ac-inspector-section ac-action-card">
        <h4>current note</h4>
        <p>${escHtml(constShortText(now, 220))}</p>
      </section>` : ""}`;
}

function constPeopleDefaultHtml(ctx) {
  const model = ctx?.peopleModel || constPeopleNetworkModel(ctx?.people || [], ctx?.teams || []);
  const links = model.edges || [];
  const groups = (model.groups || [])
    .filter(group => group.kind === "team")
    .map(row => ({
      team: row.team,
      count: row.people.length,
    }))
    .filter(row => row.count > 0)
    .sort((a, b) => b.count - a.count || String(a.team.name || a.team.record_id).localeCompare(String(b.team.name || b.team.record_id)))
    .slice(0, 4);
  const linkRows = links.slice(0, 4).map(edge => ({
    edge,
    a: model.peopleById?.get(edge.a),
    b: model.peopleById?.get(edge.b),
  })).filter(row => row.a && row.b);
  const kindLabel = kind => ({
    "same-team": "same project",
    "secondary-overlap": "secondary overlap",
    "pair-with": "pair_with",
    "shared-context": "shared context",
  }[kind] || "profile context");
  return `
    <div class="ac-inspector-hero is-confidence">
      <div class="ac-inspector-kicker">people graph</div>
      <h3>People grouped by project, connected by profile evidence</h3>
      <p>Each circle is a primary project group. Lines connect people through same-project membership, explicit secondary links, pair-with fields, or shared declared context.</p>
    </div>
    <section class="ac-inspector-section is-rel-queue">
      <h4>strongest people links</h4>
      <div class="ac-rel-queue is-compact">
        ${linkRows.length ? linkRows.map(row => `
          <button type="button" class="ac-rel-row" data-const-person="${escAttr(row.a.record_id)}">
            <span class="ac-rel-row-copy">
              <span class="ac-rel-row-top"><strong>${escHtml(constPersonDisplayName(row.a))} ↔ ${escHtml(constPersonDisplayName(row.b))}</strong><em>${escHtml(kindLabel(row.edge.kind))}</em></span>
              <span class="ac-rel-row-summary">${escHtml(constShortText(row.edge.reason, 130))}</span>
            </span>
          </button>`).join("") : `<p class="ac-inspector-empty">No person-to-person links can be inferred yet.</p>`}
      </div>
      <p class="ac-rel-queue-more">${escHtml(String(links.length))} visible person link${links.length === 1 ? "" : "s"} from profile fields and shared declared context.</p>
    </section>
    <section class="ac-inspector-section is-rel-queue">
      <h4>largest project circles</h4>
      <div class="ac-rel-queue is-compact">
        ${groups.length ? groups.map(row => `
          <button type="button" class="ac-rel-row" data-const-team="${escAttr(row.team.record_id)}">
            <span class="ac-rel-row-copy">
              <span class="ac-rel-row-top"><strong>${escHtml(row.team.name || row.team.record_id)}</strong><em>${escHtml(String(row.count))} people</em></span>
              <span class="ac-rel-row-summary">${escHtml(constShortText(row.team.focus || row.team.now || "", 120) || "project profile")}</span>
            </span>
          </button>`).join("") : `<p class="ac-inspector-empty">No project memberships are listed yet.</p>`}
      </div>
    </section>`;
}

function constTeamInspectorHtml(team, ctx) {
  if (!team) return constellationInspectorDefaultHtml(ctx);
  const j = journeyFor(team);
  const assessed = journeyAssessed(team);
  const success = constSuccessDimensions(team);
  const liveBet = j.solution || team.now || team.focus || "";
  const firstSeekingItem = constList(team.seeking)[0] || "";
  const uncertainty = assessed
    ? [j.primary_bottleneck, j.problem].filter(Boolean).join(" · ")
    : "";
  const nextTest = j.next_milestone || constText(team.weekly_goals) || constText(team.graduation_target)
    || (firstSeekingItem ? `resolve: ${firstSeekingItem}` : "");
  const inboundEdges = ctx?.inBy?.get(team.record_id) || [];
  const outboundEdges = ctx?.outBy?.get(team.record_id) || [];
  const currentRole = constText(team.now || team.focus || team.traction);
  const sourceProof = `
    ${constMiniListHtml("traction", team.traction, "none listed", 1)}
    ${constMiniListHtml("shipping", team.prior_shipping, "none listed", 3)}
    ${constMiniListHtml("research", team.paper_basis, "none listed", 3)}`;
  const transcriptCues = constTranscriptCueListHtml(constTranscriptCuesForTeam(team), "source cues");
  const marketFitBody = assessed
    ? journeyDetailSection(team)
    : `<p class="ac-inspector-note">No explicit PMF journey read yet. Use the relationship and profile evidence above first.</p>`;
  const marketFitSection = ctx?.mode === "stack" ? "" : constInspectorDetailsHtml("PMF evidence", marketFitBody);
  const sourceProofDetails = ctx?.mode === "stack" ? "" : constInspectorDetailsHtml("source proof", sourceProof);
  const currentBetRows = [
    ["live bet", liveBet],
    ["uncertainty", uncertainty],
    ["next test", nextTest],
  ].filter(([, value]) => constText(value));
  const currentBetSection = currentBetRows.length ? constInspectorDetailsHtml("current bet", `
      <dl class="ac-bet-list">
        ${currentBetRows.map(([label, value]) => `<div><dt>${escHtml(label)}</dt><dd>${escHtml(constShortText(value, 180))}</dd></div>`).join("")}
      </dl>
      ${constTeamOperatingHtml(team)}`) : "";
  const relationshipDetails = (inboundEdges.length || outboundEdges.length) ? constInspectorDetailsHtml("relationship lines", `
    <div class="ac-inspector-network">
      ${outboundEdges.length ? `<div><span>this team points to</span>${outboundEdges.slice(0, 5).map(e => constRelationshipChipHtml(e, ctx, team.record_id)).join("")}</div>` : ""}
      ${inboundEdges.length ? `<div><span>teams pointing here</span>${inboundEdges.slice(0, 5).map(e => constRelationshipChipHtml(e, ctx, team.record_id)).join("")}</div>` : ""}
    </div>`) : "";
  return `
    <div class="ac-inspector-hero" data-const-team="${escAttr(team.record_id)}">
      <div class="ac-inspector-kicker">selected team</div>
      <h3><button type="button" class="ac-inspector-name-link" data-const-open-record="${escAttr(team.record_id)}">${escHtml(team.name || team.record_id)}</button></h3>
      <p>${escHtml(constShortText(currentRole, 150) || "No current focus in profile.")}</p>
      <div class="ac-inspector-pills">
        <span>${escHtml(CONST_DOMAIN_LABEL[constDomainClass(team.domain)] || "other")}</span>
        ${success.map(s => `<span>${escHtml(s)}</span>`).join("")}
      </div>
    </div>
    ${constStackPlacementHtml(team, ctx)}
    ${constTeamActionCardHtml(team, ctx)}
    ${constTeamPeopleHtml(team, ctx)}
    ${relationshipDetails}
    ${currentBetSection}
    ${marketFitSection}
    ${transcriptCues}
    ${sourceProofDetails}`;
}

function constEdgeInspectorHtml(edge, ctx) {
  const canonical = ctx?.edgeByPair?.get(dependencyPairKey(edge?.from, edge?.to)) || edge;
  const from = ctx?.teamById?.get(canonical?.from);
  const to = ctx?.teamById?.get(canonical?.to);
  if (!from || !to) return constellationInspectorDefaultHtml(ctx);
  const sharedSkills = (from.skill_areas || []).filter(s => (to.skill_areas || []).includes(s));
  const sourceNeeds = constList(from.seeking).slice(0, 2);
  const targetOffers = constList(to.offering).slice(0, 2);
  const meaning = constRelationshipMeaning(canonical);
  const status = constRelationshipStatus(canonical);
  const source = constRelationshipSource(canonical);
  const confidenceLabel = constRelationshipConfidenceLabel(canonical);
  const nextAction = constText(canonical.next_action);
  const directionText = constRelationshipDirection(canonical, from.name || from.record_id, to.name || to.record_id);
  const oneLine = constRelationshipOneLine(canonical, from.name || from.record_id, to.name || to.record_id);
  const clearAnswer = constEdgeClearAnswer(canonical, from, to, ctx);
  const fromPeople = constPeopleForTeam(from, ctx).slice(0, 2);
  const toPeople = constPeopleForTeam(to, ctx).slice(0, 2);
  const evidenceBody = canonical.normalized
    ? (canonical.evidence?.length
      ? `<ul class="ac-inspector-list">${canonical.evidence.slice(0, 5).map(v => `<li>${escHtml(constShortText(v, 150))}</li>`).join("")}</ul>`
      : `<p class="ac-inspector-empty">no evidence bullets are attached to this relationship record.</p>`)
    : `<p class="ac-inspector-note">${escHtml(source.note)}</p>`;
  const transcriptCues = constTranscriptCueListHtml(constTranscriptCuesForEdge(canonical, ctx), "source cues");
  const contextBody = `
    <dl class="ac-bet-list">
      <div><dt>source focus</dt><dd>${escHtml(constShortText(from.focus || from.now || "", 160) || "not stated")}</dd></div>
      <div><dt>target focus</dt><dd>${escHtml(constShortText(to.focus || to.now || "", 160) || "not stated")}</dd></div>
      <div><dt>overlap</dt><dd>${sharedSkills.length ? sharedSkills.map(escHtml).join(" · ") : "no shared skills in profiles"}</dd></div>
    </dl>
    ${constMiniListHtml(`${from.name || from.record_id} seeks`, sourceNeeds, "none listed", 2)}
    ${constMiniListHtml(`${to.name || to.record_id} offers`, targetOffers, "none listed", 2)}`;
  const actionText = nextAction
    || (canonical.normalized
      ? "No next action is attached to this relationship record yet."
      : "Verify this profile mention and convert it into a relationship record if it is real.");
  return `
    <div class="ac-inspector-hero is-edge${canonical.normalized ? " is-source-backed" : " is-profile-link"}">
      <div class="ac-inspector-kicker">${canonical.normalized ? "relationship record" : "profile mention"}</div>
      <h3>${escHtml(from.name || from.record_id)} → ${escHtml(to.name || to.record_id)}</h3>
      <p>${escHtml(constShortText(clearAnswer.answer || oneLine, 220))}</p>
      <div class="ac-inspector-pills">
        <span>${escHtml(meaning.label)}</span>
        <span>${escHtml(status.label)}</span>
        <span>${escHtml(confidenceLabel)}</span>
      </div>
    </div>
    <section class="ac-inspector-section ac-action-card is-line-action">
      <h4>next action</h4>
      <p>${escHtml(constShortText(clearAnswer.next || actionText, 220))}</p>
    </section>
    <section class="ac-inspector-section is-edge-meaning">
      <h4>why this matters</h4>
      <dl class="ac-bet-list">
        <div><dt>answer</dt><dd>${escHtml(constShortText(clearAnswer.answer || directionText, 240))}</dd></div>
        <div><dt>basis</dt><dd>${escHtml(constShortText(clearAnswer.why, 220))}</dd></div>
        <div><dt>caveat</dt><dd>${escHtml(clearAnswer.caveat)}</dd></div>
      </dl>
    </section>
    <section class="ac-inspector-section is-edge-proof">
      <h4>source trail</h4>
      <dl class="ac-bet-list ac-edge-meta">
        <div><dt>source</dt><dd>${escHtml(source.label)}</dd></div>
        <div><dt>basis</dt><dd>${escHtml(source.note)}</dd></div>
        ${canonical.normalized ? `<div><dt>source strength</dt><dd>${escHtml(confidenceLabel)}</dd></div>` : ""}
        ${canonical.updated_at ? `<div><dt>updated</dt><dd>${escHtml(canonical.updated_at)}</dd></div>` : ""}
      </dl>
    </section>
    <section class="ac-inspector-section is-people">
      <h4>who to talk to</h4>
      <div class="ac-person-columns">
        <div><span>${escHtml(from.name || from.record_id)}</span>${fromPeople.length ? fromPeople.map(constPersonChipHtml).join("") : `<p class="ac-inspector-empty">no attached person.</p>`}</div>
        <div><span>${escHtml(to.name || to.record_id)}</span>${toPeople.length ? toPeople.map(constPersonChipHtml).join("") : `<p class="ac-inspector-empty">no attached person.</p>`}</div>
      </div>
    </section>
    ${constInspectorDetailsHtml("source evidence", evidenceBody, Boolean(canonical.normalized && canonical.evidence?.length))}
    ${transcriptCues}
    ${constInspectorDetailsHtml("team context and needs", contextBody)}`;
}

function constellationInspectorDefaultHtml(ctx) {
  const breakdown = constRelationshipBreakdown(ctx?.edges || []);
  const lensSummary = constLensSummaryHtml(ctx);
  const queueTitle = ctx?.lens === "relies" ? "reliance lines" : (ctx?.lens === "works" ? "collaboration lines" : (ctx?.lens === "substrate" ? "shared-substrate lines" : "relationship lines"));
  if (ctx?.scope === "people") return constPeopleDefaultHtml(ctx);
  if (ctx?.mode === "journey") {
    const journeyTeams = (ctx?.teams || []).filter(t => teamKind(t) !== "person");
    const journeyPoints = journeyTeams.filter(journeyAssessed).length;
    const profileContext = Math.max(0, journeyTeams.length - journeyPoints);
    return `
      <div class="ac-inspector-hero is-confidence">
        <div class="ac-inspector-kicker">PMF evidence coverage</div>
        <h3>${escHtml(String(journeyPoints))}/${escHtml(String(journeyTeams.length))} explicit journey reads</h3>
        <p>Use this as a coverage view, not a cohort-wide maturity ranking. Profile-context dots mean missing PMF assessment data.</p>
      </div>
      <section class="ac-inspector-section is-journey-summary">
        <h4>visible layers</h4>
        <div class="ac-view-chips">
          <span>journey points<em>${escHtml(String(journeyPoints))}</em></span>
          <span>profile context<em>${escHtml(String(profileContext))}</em></span>
        </div>
      </section>`;
  }
  if (ctx?.mode === "ring" && !ctx?.interest?.active) {
    return `
      ${constMapReadoutHeroHtml(ctx, "circle readout")}
      ${constCorridorReadoutHtml(ctx)}
      <section class="ac-inspector-section is-rel-queue">
        <h4>who should talk next</h4>
        ${constRelationshipQueueHtml(ctx, { max: 3, compact: true })}
      </section>
      ${constDataCoverageHtml(ctx)}`;
  }
  if (ctx?.mode === "stack") {
    return `
      ${constStackReadoutHtml(ctx)}
      ${constStackSummaryHtml(ctx)}`;
  }
  if (ctx?.interest?.active) {
    return `
      ${constInterestSummaryHtml(ctx)}
      ${lensSummary}
      <section class="ac-inspector-section is-rel-queue">
        <h4>${escHtml(queueTitle)}</h4>
        ${constRelationshipQueueHtml(ctx, { max: 4, compact: true })}
      </section>`;
  }
  if ((ctx?.mode === "map" || ctx?.mode === "ring") && !ctx?.interest?.active) {
    return `
      ${constMapReadoutHeroHtml(ctx)}
      ${constCorridorReadoutHtml(ctx)}
      <section class="ac-inspector-section is-rel-queue">
        <h4>who should talk next</h4>
        ${constRelationshipQueueHtml(ctx, { max: 4, compact: true })}
      </section>
      ${constDataCoverageHtml(ctx)}`;
  }
  return `
    ${lensSummary}
    <section class="ac-inspector-section is-rel-queue">
      <h4>lines to inspect</h4>
      ${constRelationshipQueueHtml(ctx, { max: 4, compact: true })}
      <p class="ac-rel-queue-more">line source: ${escHtml(String(breakdown.typed))} records · ${escHtml(String(breakdown.missing))} profile mentions</p>
    </section>`;
}

function constellationInspectorHeaderHtml(selection, ctx) {
  if (!selection && !ctx?.interest?.active) return "";
  let kicker = "overview";
  let title = "select a line, team, or ecosystem";
  let titleHtml = "";
  if (selection?.type === "team") {
    const team = ctx?.teamById?.get(selection.rid);
    kicker = "selected team";
    title = team?.name || selection.rid || "team";
    titleHtml = team?.record_id
      ? `<button type="button" class="ac-inspector-title-link" data-const-open-record="${escAttr(team.record_id)}">${escHtml(title)}</button>`
      : escHtml(title);
  } else if (selection?.type === "person") {
    const person = ctx?.personById?.get(selection.rid);
    kicker = "selected person";
    title = constPersonDisplayName(person) || selection.rid || "person";
    titleHtml = person?.record_id
      ? `<button type="button" class="ac-inspector-title-link" data-const-open-record="${escAttr(person.record_id)}">${escHtml(title)}</button>`
      : escHtml(title);
  } else if (selection?.type === "edge") {
    const from = ctx?.teamById?.get(selection.from)?.name || selection.from || "source";
    const to = ctx?.teamById?.get(selection.to)?.name || selection.to || "target";
    kicker = "selected line";
    title = `${from} → ${to}`;
  } else if (ctx?.interest?.active) {
    kicker = "ecosystem focus";
    title = constClusterLabel(ctx.interest.cluster);
  }
  if (!titleHtml) titleHtml = escHtml(title);
  return `
    <div class="ac-inspector-status">
      <span>${escHtml(kicker)}</span>
      <strong>${titleHtml}</strong>
    </div>
    ${selection ? `<button type="button" class="ac-inspector-clear" data-const-clear-selection aria-label="Clear selected constellation item">×</button>` : ""}`;
}

function constellationInspectorLeadHtml(ctx, selection = null) {
  if (ctx?.mode === "map" && !selection && ctx?.interest?.active && ctx?.distributionWells?.length) {
    return constMapDistributionHtml(ctx.distributionWells, new Map(), ctx?.interest?.id || "all");
  }
  return "";
}

function constellationInspectorShell(ctx, selection = state.constSelection) {
  const header = constellationInspectorHeaderHtml(selection, ctx);
  return `
    <aside class="ac-inspector" aria-label="constellation context">
      ${header ? `<div class="ac-inspector-head">${header}</div>` : ""}
      <div class="ac-inspector-body">${constellationInspectorLeadHtml(ctx, selection)}${constellationInspectorHtml(selection, ctx)}</div>
    </aside>`;
}

function constellationInspectorHtml(selection, ctx) {
  if (selection?.type === "team") return constTeamInspectorHtml(ctx?.teamById?.get(selection.rid), ctx);
  if (selection?.type === "person") return constPersonInspectorHtml(ctx?.personById?.get(selection.rid), ctx);
  if (selection?.type === "edge") return constEdgeInspectorHtml(selection, ctx);
  return constellationInspectorDefaultHtml(ctx);
}

function renderJourney() {
  const cohort = activeConstellationCohort();
  const all = cohort.teams || [];
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
  const W = 1120, H = 560;
  // Plot area inset: leave room for axis labels (left = evidence, bottom = stage).
  const PAD_L = 178, PAD_R = 30, PAD_T = 30, PAD_B = 106;
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
  const stageAxisLines = [
    ["side", "project"],
    ["1", "idea"],
    ["2", "problem", "discovery"],
    ["3", "problem-", "solution fit"],
    ["4", "product", "validation"],
    ["5", "scaling", "traction"],
    ["6", "emerging", "pmf"],
    ["7", "strong", "pmf"],
    ["8", "scale", "fit"],
  ];
  const xLabels = JOURNEY_STAGE_LABELS.map((lbl, stage) => {
    const x = xForStage(stage);
    const cls = stage === 0 ? "ac-jaxis-x ac-jaxis-x-side" : "ac-jaxis-x";
    const lines = stageAxisLines[stage] || [String(stage), lbl];
    const tspans = lines.map((line, i) => {
      const numCls = stage > 0 && i === 0 ? ` class="ac-jaxis-num"` : "";
      const dy = i === 0 ? "0" : "11";
      return `<tspan${numCls} x="${x.toFixed(1)}" dy="${dy}">${escHtml(line)}</tspan>`;
    }).join("");
    return `<text class="${cls}" x="${x.toFixed(1)}" y="${(PAD_T + plotH + 18).toFixed(1)}" text-anchor="middle">${tspans}</text>`;
  }).join("");
  const evidenceAxisLines = [
    [],
    ["vibes / thesis"],
    ["interviews"],
    ["pilots / LOIs", "design partners"],
    ["usage / revenue", "retention"],
    ["repeatable pull"],
  ];
  const yLabels = JOURNEY_EVIDENCE_LABELS.slice(1).map((lbl, i) => {
    const ev = i + 1;
    const y = yForEvidence(ev);
    const lines = evidenceAxisLines[ev] || [lbl];
    const baseY = y + 3 - (lines.length - 1) * 5;
    const tspans = lines.map((line, lineIdx) => {
      const prefix = lineIdx === 0 ? `<tspan class="ac-jaxis-num">${ev}</tspan> ` : "";
      const dy = lineIdx === 0 ? "0" : "10";
      return `<tspan x="${(PAD_L - 14).toFixed(1)}" dy="${dy}">${prefix}${escHtml(line)}</tspan>`;
    }).join("");
    return `<text class="ac-jaxis-y" x="${(PAD_L - 14).toFixed(1)}" y="${baseY.toFixed(1)}" text-anchor="end">${tspans}</text>`;
  }).join("");
  const axisTitleX = `<text class="ac-jaxis-title" x="${(PAD_L + plotW / 2).toFixed(1)}" y="${(H - 16).toFixed(1)}" text-anchor="middle">stage →</text>`;
  const axisTitleY = `<text class="ac-jaxis-title" transform="translate(18,${(PAD_T + plotH / 2).toFixed(1)}) rotate(-90)" text-anchor="middle">evidence quality →</text>`;
  // #226 journey-assessed set — declaration dropped during the mega-merge; restored.
  const assessedTeams = teams.filter(t => journeyAssessed(t));
  const assessedShown = assessedTeams.length;
  const cellBuckets = new Map();
  for (const t of teams) {
    const j = journeyFor(t);
    const key = `${j.stage}:${j.evidence_quality}`;
    if (!cellBuckets.has(key)) cellBuckets.set(key, []);
    cellBuckets.get(key).push(t);
  }
  for (const bucket of cellBuckets.values()) {
    bucket.sort((a, b) => constText(a.name || a.record_id).localeCompare(constText(b.name || b.record_id)));
  }

  // ── dots: one per visible team/project. Explicit journey reads use
  // bottleneck color + upside size; default/profile records stay quieter but
  // remain individually selectable.
  const dots = teams.map((t) => {
    const j = journeyFor(t);
    const bucket = cellBuckets.get(`${j.stage}:${j.evidence_quality}`) || [t];
    const n = bucket.length;
    const idx = Math.max(0, bucket.findIndex(item => item.record_id === t.record_id));
    let jx = journeyJitter(t.record_id, "x") * (colW * 0.18);
    let jy = journeyJitter(t.record_id, "y") * (rowH * 0.18);
    if (n > 1) {
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      jx = (cols <= 1 ? 0 : ((col / (cols - 1)) - 0.5) * (colW * 0.66)) + journeyJitter(t.record_id, "x") * 2;
      jy = (rows <= 1 ? 0 : ((row / (rows - 1)) - 0.5) * (rowH * 0.56)) + journeyJitter(t.record_id, "y") * 2;
    }
    const cx = xForStage(j.stage) + jx;
    const cy = yForEvidence(j.evidence_quality) + jy;
    const assessed = journeyAssessed(t);
    const r = assessed ? 4 + j.market_upside * 1.8 : 4.8; // upside 1..5 -> r 5.8..13
    const famIdx = journeyFamilyIdx(j.primary_bottleneck);
    const isProject = teamKind(t) === "project";
    const labelClass = assessed && assessedShown <= 6 ? " is-labeled" : "";
    const contextClass = assessed ? "" : " is-profile-context";
    const dotClass = assessed ? `ac-jdot ac-jfam-${famIdx}` : "ac-jdot ac-jprofile-dot";
    const title = assessed
      ? `${t.name || t.record_id}: ${JOURNEY_STAGE_LABELS[j.stage] || "journey"} / ${JOURNEY_EVIDENCE_LABELS[j.evidence_quality] || "evidence"}`
      : `${t.name || t.record_id}: profile context; no explicit journey read yet`;
    return `<g class="ac-jnode${isProject ? " is-project" : ""}${contextClass}${labelClass}" data-record-id="${escHtml(t.record_id)}" role="button" tabindex="0" aria-label="${escAttr(`inspect ${t.name || t.record_id} journey`)}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})">
        <title>${escHtml(title)}</title>
        <circle class="ac-jhit" r="${Math.max(18, r + 9).toFixed(1)}"/>
        <circle class="${dotClass}" r="${r.toFixed(1)}"/>
        <text class="ac-jnode-label" y="${(-r - 8).toFixed(1)}" text-anchor="middle">${escHtml(t.name)}</text>
      </g>`;
  }).join("");

  // ── bottleneck legend — grouped into 4 color families (the dot palette),
  // each family's members still individually clickable to isolate that one. ──
  const legend = JOURNEY_BOTTLENECK_FAMILIES.map((fam, fi) => `
    <div class="acl-jfamily">
      <span class="acl-jfam-head"><span class="acl-jswatch ac-jfam-${fi}"></span>${escHtml(fam.label)}</span>
      ${fam.members.map(b =>
        `<button type="button" class="acl-jbtn ${jf.bottleneck === b ? "is-active" : ""} ${jf.bottleneck && jf.bottleneck !== b ? "is-dim" : ""}" data-jbottleneck="${escAttr(b)}">${escHtml(b)}</button>`
      ).join("")}
    </div>`).join("");

  // ── filter bar — toggle teams / projects / side projects ──
  const fbtn = (key, label) => `<button type="button" class="ajf-toggle ${jf[key] ? "is-on" : ""}" data-jfilter="${key}">${label}</button>`;
  const filterBar = `
    <div class="alch-journey-filters">
      <span class="ajf-label">include</span>
      ${fbtn("teams", "teams")}
      ${fbtn("projects", "projects")}
      ${fbtn("side", "side projects")}
    </div>`;

  state.canvas.innerHTML = `
    <div class="alch-constellation">
      <nav class="alch-const-modes" role="tablist" aria-label="constellation view">
        <button class="alch-const-mode-btn" data-const-mode="clusters" aria-selected="false" type="button">
          <span class="acm-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="1"/><path d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/><path d="M15.7 15.7c4.52-4.54 6.54-9.87 4.5-11.9-2.03-2.04-7.36-.02-11.9 4.5-4.52 4.54-6.54 9.87-4.5 11.9 2.03 2.04 7.36.02 11.9-4.5Z"/></svg></span><span class="acm-label">clusters</span>
          <span class="acm-hint">shared cluster membership</span>
        </button>
        <button class="alch-const-mode-btn" data-const-mode="dependencies" aria-selected="false" type="button">
          <span class="acm-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.3 10a.7.7 0 0 1-.626-1.079L11.4 3a.7.7 0 0 1 1.198-.043L16.3 8.9a.7.7 0 0 1-.572 1.1Z"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/></svg></span><span class="acm-label">dependencies</span>
          <span class="acm-hint">team-asserted edges</span>
        </button>
        <button class="alch-const-mode-btn" data-const-mode="journey" aria-selected="true" type="button">
          <span class="acm-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.106 5.553a2 2 0 0 0 1.788 0l3.659-1.83A1 1 0 0 1 21 4.619v12.764a1 1 0 0 1-.553.894l-4.553 2.277a2 2 0 0 1-1.788 0l-4.212-2.106a2 2 0 0 0-1.788 0l-3.659 1.83A1 1 0 0 1 3 19.381V6.618a1 1 0 0 1 .553-.894l4.553-2.277a2 2 0 0 1 1.788 0z"/><path d="M15 5.764v15"/><path d="M9 3.236v15"/></svg></span><span class="acm-label">journey</span>
          <span class="acm-hint">pmf maturity spectrum</span>
        </button>
      </nav>
      ${filterBar}
      <div class="alch-const-workbench is-single">
        <div class="alch-const-main">
          ${constJourneyReadoutHtml(teams, all)}
          <div class="alch-constellation-legend">${legend}</div>
          <div class="alch-constellation-stage alch-journey-stage">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
              ${gridLines.join("")}
              ${xLabels}
              ${yLabels}
              ${axisTitleX}
              ${axisTitleY}
              ${dots}
            </svg>
            <div class="ac-tip" hidden></div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderProductStack() {
  const teams = state.cohort.teams || [];
  const clusters = state.cohort.clusters || [];
  const teamById = new Map(teams.filter(t => t?.record_id).map(t => [t.record_id, t]));
  const edges = constellationDependencyEdges(teams, teamById, state.cohort?.dependencies || [])
    .filter(e => teamById.has(e.from) && teamById.has(e.to));
  const baseCtx = {
    ...constellationInspectorContext(teams, edges, state.cohort?.people || []),
    clusters,
    mode: "stack",
    lens: "all",
    interest: constInterestContext(teams, clusters, edges, state.constInterest),
  };
  const stackModel = constProductStackModel(teams, baseCtx);
  const inspectorCtx = { ...baseCtx, stackModel };
  const legend = CONST_DOMAIN_KEYS
    .map(k => `<span class="acl-item"><span class="acl-dot acl-dot-${k}"></span>${escHtml(CONST_DOMAIN_LABEL[k])}</span>`)
    .join("");
  state.canvas.innerHTML = `
    <div class="alch-constellation" data-constellation-view="stack">
      <div class="alch-const-topbar">${constellationNav("stack")}</div>
      <div class="alch-const-workbench is-single">
        <div class="alch-const-main">
          ${constStackReadoutHtml(inspectorCtx)}
          <div class="alch-constellation-legend">${legend}</div>
          <div class="alch-constellation-stage ac-stack-stage" data-view="stack" data-lens="all" tabindex="0" aria-label="constellation product layer directory">
            ${constProductStackHtml(stackModel)}
            <div class="ac-tip" hidden></div>
          </div>
        </div>
      </div>
    </div>
  `;
  markConstellationSelection(state.constSelection);
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
const CONST_DOMAIN_COLORS = {
  tee: "#C0492E",
  ai: "#D9913D",
  crypto: "#9A5BA6",
  "app-ux": "#3F9B8E",
  other: "#8a7d75",
};
function constDomainClass(d) {
  const k = String(d || "other").toLowerCase();
  if (k === "bd-gtm") return "app-ux";
  return CONST_DOMAIN_KEYS.includes(k) ? k : "other";
}
// Node color is ALWAYS domain — one coding across every lens, so a team never
// changes color when you switch lenses. Cluster identity is carried by the
// WELL (position + label), never by node color. This is why
// there is no per-cluster color palette here.

function constArcPoint(cx, cy, r, angle) {
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

function constArcPath(cx, cy, r, startAngle, endAngle) {
  const start = constArcPoint(cx, cy, r, startAngle);
  const end = constArcPoint(cx, cy, r, endAngle);
  const large = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
  return `M ${start.x.toFixed(1)} ${start.y.toFixed(1)} A ${r.toFixed(1)} ${r.toFixed(1)} 0 ${large} 1 ${end.x.toFixed(1)} ${end.y.toFixed(1)}`;
}

// Lay wells out on an adaptive grid (favoring more columns on the wide
// canvas) so they never overlap regardless of cluster count, then place
// each well's teams: keystone (highest in-degree) at the centre, the rest
// on a ring inside the well. Wells are equal circles; size is not allowed to
// imply project importance because the source model does not provide that.
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
    const wellR = Math.max(58, Math.min(cellW, cellH) * 0.42);
    const nodeLabelGuardY = cy - wellR + Math.min(48, wellR * 0.42);
    wells.push({ id: w.id, label: w.label, members: w.members, cx, cy, r: wellR });
    const ordered = w.members.slice().sort((a, b) => (model.indegree.get(b) || 0) - (model.indegree.get(a) || 0));
    const ringN = Math.max(1, ordered.length - 1);
    ordered.forEach((rid, k) => {
      const team = model.byRecordId.get(rid);
      const deg = model.indegree.get(rid) || 0;
      const r = 6 + Math.min(deg, 8) * 1.5;
      let angle = null;
      let x = cx, y = cy + (ordered.length > 1 ? -wellR * 0.08 : 0);
      if (k > 0) {
        const a = -Math.PI / 2 + ((k - 1) / ringN) * Math.PI * 2;
        angle = a;
        const spread = ringN > 5 ? (k % 2 === 0 ? 0.72 : 0.56) : (ringN >= 3 ? 0.74 : 0.56);
        x = cl(cx + Math.cos(a) * wellR * spread, r + 4, W - r - 4);
        y = cl(cy + Math.sin(a) * wellR * spread, r + 12, H - r - 12);
      }
      if (ordered.length > 1 && y - r < nodeLabelGuardY) {
        y = Math.min(cy + wellR - r - 12, nodeLabelGuardY + r);
      }
      pos.set(rid, { team, x, y, r, deg, angle, wellId: w.id, wellSize: ordered.length, rank: k });
    });
  });
  return { wells, ringSegments: [], pos };
}

function placeConstellationRing(model, W, H) {
  const CX = W / 2;
  const CY = H / 2;
  const ringR = Math.min(W, H) * 0.40;
  const labelR = ringR + 46;
  const ordered = [];
  for (const well of model.wellsDef) {
    const members = well.members
      .slice()
      .sort((a, b) => String(model.byRecordId.get(a)?.name || a).localeCompare(String(model.byRecordId.get(b)?.name || b)));
    for (const rid of members) ordered.push({ rid, well });
  }
  const n = Math.max(1, ordered.length);
  const pos = new Map();
  ordered.forEach(({ rid, well }, i) => {
    const team = model.byRecordId.get(rid);
    if (!team) return;
    const deg = model.indegree.get(rid) || 0;
    const r = 6 + Math.min(deg, 8) * 1.5;
    const angle = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const point = constArcPoint(CX, CY, ringR, angle);
    pos.set(rid, { team, x: point.x, y: point.y, r, deg, angle, wellId: well.id, wellSize: well.members.length });
  });
  let cursor = 0;
  const ringSegments = model.wellsDef.map((well) => {
    const count = well.members.length;
    const start = -Math.PI / 2 + (cursor / n) * Math.PI * 2;
    const end = -Math.PI / 2 + ((cursor + count) / n) * Math.PI * 2;
    cursor += count;
    const mid = (start + end) / 2;
    const label = constArcPoint(CX, CY, labelR, mid);
    return {
      id: well.id,
      label: well.label,
      members: well.members,
      cx: label.x,
      cy: label.y,
      start,
      end,
      mid,
      path: constArcPath(CX, CY, ringR + 24, start + 0.012, end - 0.012),
    };
  });
  return { wells: [], ringSegments, pos, ringCenter: { x: CX, y: CY } };
}

// Lightweight hover label. The fixed inspector is the evidence surface; hover
// only identifies the mark and tells the user why the circle size changed.
function constNodeTipHTML(team, deg, outBy, inBy, clusterLabels, sourceStats = {}) {
  const dom = CONST_DOMAIN_LABEL[constDomainClass(team.domain)] || "other";
  const outboundLinks = outBy?.get(team.record_id) || [];
  const inboundLinks = inBy?.get(team.record_id) || [];
  const row = (k, v) => `<div class="ajt-row"><span class="ajt-k">${k}</span><span class="ajt-v">${v}</span></div>`;
  let html = `<div class="ajt-name">${escHtml(team.name || team.record_id)}</div>`;
  html += row("domain", escHtml(dom));
  const cls = clusterLabels && clusterLabels.length ? clusterLabels : null;
  if (cls) html += row("clusters", cls.map(escHtml).join(" · "));
  html += row("lines", `${escHtml(String(outboundLinks.length))} out · ${escHtml(String(inboundLinks.length))} in`);
  html += row("source", `${escHtml(String(sourceStats.typed || 0))} records · ${escHtml(String(sourceStats.profile || 0))} mentions`);
  html += row("size", `${escHtml(String(deg))} incoming declared line${deg === 1 ? "" : "s"}`);
  html += row("action", "click to pin evidence");
  return html;
}

function constPersonTipHTML(person, model, ctx) {
  const team = ctx?.teamById?.get(person?.team);
  const secondary = (Array.isArray(person?.secondary_teams) ? person.secondary_teams : [])
    .map(id => ctx?.teamById?.get(id)?.name || id)
    .filter(Boolean);
  const goto = constList(person?.go_to_them_for).slice(0, 2).join(" · ");
  const linkCount = (model?.edges || []).filter(edge => edge.a === person?.record_id || edge.b === person?.record_id || edge.person === person?.record_id).length;
  const row = (k, v) => `<div class="ajt-row"><span class="ajt-k">${k}</span><span class="ajt-v">${v}</span></div>`;
  let html = `<div class="ajt-name">${escHtml(constPersonDisplayName(person))}</div>`;
  html += row("role", escHtml(constPersonRoleLabel(person)));
  html += row("project", escHtml(team?.name || person?.team || "not attached"));
  if (secondary.length) html += row("also", escHtml(secondary.slice(0, 2).join(" · ")));
  if (goto) html += row("go to for", escHtml(goto));
  html += row("links", `${escHtml(String(linkCount))} visible people link${linkCount === 1 ? "" : "s"}`);
  html += row("source", "person profile");
  html += row("action", "click to pin person");
  return html;
}

function renderConstellationPeople(teams, people, clusters, edges) {
  const W = 1120, H = 620;
  const model = constPeopleNetworkModel(people, teams, W, H);
  const inspectorCtx = {
    ...constellationInspectorContext(teams, edges, people),
    clusters,
    mode: "map",
    scope: "people",
    peopleModel: model,
    distributionWells: [],
    lens: "all",
    interest: { active: false },
  };
  const groupMarkup = model.groups.map((group, idx) => {
    const domain = constDomainClass(group.team?.domain || group.people?.[0]?.domain);
    const label = group.label || "people";
    const count = group.people?.length || 0;
    const accent = constWellAccentStyle(constWellAccentTokens(group.id, idx));
    const actionAttrs = group.team?.record_id
      ? `data-const-team="${escAttr(group.team.record_id)}" role="button" tabindex="0" aria-label="${escAttr(`inspect ${label}`)}"`
      : `aria-hidden="true"`;
    return `
      <g class="ac-person-well ac-person-well-domain-${escAttr(domain)}${group.kind === "unattached" ? " is-unattached" : ""}" data-people-group="${escAttr(group.id)}" style="${escAttr(accent)}" ${actionAttrs}>
        <circle class="ac-person-well-shape" cx="${group.cx.toFixed(1)}" cy="${group.cy.toFixed(1)}" r="${group.r.toFixed(1)}"/>
        <text class="ac-person-well-label" x="${group.cx.toFixed(1)}" y="${Math.max(14, group.cy - group.r - 12).toFixed(1)}">${escHtml(label)}</text>
        <text class="ac-person-well-count" x="${group.cx.toFixed(1)}" y="${(group.cy + group.r + 16).toFixed(1)}">${escHtml(String(count))} people</text>
      </g>`;
  }).join("");
  const edgeMarkup = model.edges.map(edge => {
    const dx = edge.x2 - edge.x1;
    const dy = edge.y2 - edge.y1;
    const dist = Math.hypot(dx, dy) || 1;
    const bend = Math.min(34, Math.max(8, dist * 0.08));
    const qx = (edge.x1 + edge.x2) / 2 - (dy / dist) * bend;
    const qy = (edge.y1 + edge.y2) / 2 + (dx / dist) * bend;
    const d = `M ${edge.x1.toFixed(1)} ${edge.y1.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${edge.x2.toFixed(1)} ${edge.y2.toFixed(1)}`;
    return `<path class="ac-person-link is-${escAttr(dependencySafeToken(edge.kind))}" data-person-a="${escAttr(edge.a)}" data-person-b="${escAttr(edge.b)}" data-link-kind="${escAttr(edge.kind)}" aria-hidden="true" d="${escAttr(d)}"/>`;
  }).join("");
  const peopleMarkup = [...model.personPositions.values()].map(pos => {
    const person = pos.person;
    const domain = constDomainClass(person.domain || inspectorCtx.teamById.get(person.team)?.domain);
    const roleClass = dependencySafeToken(person.role_class || "unknown");
    const name = constPersonDisplayName(person);
    const secondaryTeams = Array.isArray(person.secondary_teams) ? person.secondary_teams.join(" ") : "";
    return `
      <g class="ac-person-node ac-person-domain-${escAttr(domain)} ac-person-role-${escAttr(roleClass)}" data-person-id="${escAttr(person.record_id)}" data-person-team="${escAttr(person.team || "")}" data-person-secondary-teams="${escAttr(secondaryTeams)}" role="button" tabindex="0" aria-label="${escAttr(`inspect ${name}`)}" transform="translate(${pos.x.toFixed(1)},${pos.y.toFixed(1)})">
        <circle class="ac-person-hit" r="15"/>
        <circle class="ac-person-dot" r="${roleClass === "coordinator" ? "7.4" : "6.4"}"/>
        <text class="ac-person-initial" y="2.6" text-anchor="middle">${escHtml(constPersonInitials(person))}</text>
      </g>`;
  }).join("");
  const legend = `
    <div class="acl-line-key">
      <strong>People links</strong>
      <span class="acl-line-key-row is-typed"><i></i><b>same project</b></span>
      <span class="acl-line-key-row is-profile"><i></i><b>profile overlap</b></span>
      <span class="acl-line-key-row is-shared"><i></i><b>shared context</b></span>
    </div>
    <div class="acl-line-note">Circles are primary project groups. Lines are inferred from person profiles and should be treated as conversation leads.</div>`;
  state.canvas.innerHTML = `
    <div class="alch-constellation" data-constellation-view="map" data-constellation-scope="people">
      <div class="alch-const-topbar">${constellationNav("map")}</div>
      <div class="ac-map-control-stack is-people-scope">
        ${constellationNetworkScopeRow("people", { projects: teams.length, people: people.length })}
      </div>
      <div class="alch-const-workbench">
        <div class="alch-const-main">
          <div class="alch-constellation-legend is-line-confidence">${legend}</div>
          <div class="alch-constellation-stage ac-people-stage" data-view="people" data-lens="people" tabindex="0" aria-label="people connected to projects">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
              <g class="ac-person-wells">${groupMarkup}</g>
              <g class="ac-person-links">${edgeMarkup}</g>
              <g class="ac-people-nodes">${peopleMarkup}</g>
            </svg>
            <div class="ac-tip" hidden></div>
          </div>
        </div>
        ${constellationInspectorShell(inspectorCtx)}
      </div>
    </div>`;
  markConstellationSelection(state.constSelection);
}

function constellationModeNavHtml(active) {
  return `
    <nav class="alch-const-modes" role="tablist" aria-label="constellation view">
      <button class="alch-const-mode-btn" data-const-mode="clusters" aria-selected="${active === "clusters"}" type="button">
        <span class="acm-glyph" aria-hidden="true">◑</span><span class="acm-label">clusters</span>
        <span class="acm-hint">shared cluster membership</span>
      </button>
      <button class="alch-const-mode-btn" data-const-mode="dependencies" aria-selected="${active === "dependencies"}" type="button">
        <span class="acm-glyph" aria-hidden="true">↬</span><span class="acm-label">dependencies</span>
        <span class="acm-hint">team-asserted edges</span>
      </button>
      <button class="alch-const-mode-btn" data-const-mode="journey" aria-selected="${active === "journey"}" type="button">
        <span class="acm-glyph" aria-hidden="true">⌁</span><span class="acm-label">journey</span>
        <span class="acm-hint">pmf maturity spectrum</span>
      </button>
      <button class="alch-const-mode-btn" data-const-mode="collab" aria-selected="${active === "collab"}" type="button">
        <span class="acm-glyph" aria-hidden="true">⇄</span><span class="acm-label">collab board</span>
        <span class="acm-hint">matrix · intros · convergence</span>
      </button>
    </nav>
  `;
}

function timelineSnapshotDate(snapshot) {
  const iso = snapshot?.as_of || snapshot?.committed_at;
  const d = iso ? new Date(iso) : null;
  if (!d || !Number.isFinite(d.getTime())) return "date unknown";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function snapshotEventCount(snapshot) {
  const id = snapshot?.id;
  if (!id || !Array.isArray(state.cohortTimeline?.events)) return 0;
  return state.cohortTimeline.events.filter((event) => event?.snapshot_id === id).length;
}

function timelineEventProvenance(event) {
  const kind = String(event?.source_kind || event?.source_id || "").toLowerCase();
  if (kind.includes("transcript")) return { className: "is-inferred", label: "inferred · transcript", source: "transcripts" };
  if (kind.includes("router")) return { className: "is-inferred", label: "inferred · router", source: "router" };
  if (!kind || kind.includes("git") || kind.includes("cohort")) return { className: "is-self", label: "self-declared", source: "cohort-data" };
  return { className: "is-unclassified", label: "unclassified", source: kind };
}

function teamNameMap(surface) {
  return new Map((surface?.teams || []).filter(t => t?.record_id).map(t => [t.record_id, t.name || t.record_id]));
}

function dependencyEdgeMap(surface) {
  const names = teamNameMap(surface);
  const out = new Map();
  for (const team of (surface?.teams || [])) {
    if (!team?.record_id) continue;
    for (const dep of (Array.isArray(team.dependencies) ? team.dependencies : [])) {
      if (!dep || dep === team.record_id || !names.has(dep)) continue;
      const key = `${team.record_id}>${dep}`;
      out.set(key, {
        key,
        kind: "dependency",
        from: team.record_id,
        to: dep,
        fromName: names.get(team.record_id) || team.record_id,
        toName: names.get(dep) || dep,
        directed: true,
        provenance: { className: "is-self", label: "self-declared", source: "cohort-data" },
      });
    }
  }
  return out;
}

function clusterEdgeMap(surface) {
  const names = teamNameMap(surface);
  const out = new Map();
  for (const cluster of (surface?.clusters || [])) {
    const present = (Array.isArray(cluster?.teams) ? cluster.teams : []).filter(id => names.has(id));
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const a = present[i], b = present[j];
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (out.has(key)) continue;
        out.set(key, {
          key,
          kind: "cluster",
          from: a,
          to: b,
          fromName: names.get(a) || a,
          toName: names.get(b) || b,
          cluster: cluster.record_id || cluster.name || "cluster",
          clusterLabel: cluster.label || cluster.name || "cluster",
          directed: false,
          provenance: { className: "is-self", label: "self-declared cluster", source: "cohort-data" },
        });
      }
    }
  }
  return out;
}

function addedEdges(beforeMap, afterMap) {
  return [...afterMap.entries()]
    .filter(([key]) => !beforeMap.has(key))
    .map(([, edge]) => edge);
}

function selectedTimelineEvents() {
  const active = activeConstellationSnapshot();
  const id = active?.id;
  if (!id || !Array.isArray(state.cohortTimeline?.events)) return [];
  return state.cohortTimeline.events.filter(event => event?.snapshot_id === id);
}

function inferredTimelineEvents(events) {
  return (events || [])
    .filter((event) => timelineEventProvenance(event).className === "is-inferred")
    .slice(0, 24);
}

function constellationSnapshotDelta() {
  const active = activeConstellationSnapshot();
  const previous = previousConstellationSnapshot();
  const currentSurface = active?.surface || state.cohort || {};
  const previousSurface = previous?.surface || { teams: [], people: [], clusters: [] };
  const dependencyAdded = addedEdges(dependencyEdgeMap(previousSurface), dependencyEdgeMap(currentSurface));
  const clusterAdded = addedEdges(clusterEdgeMap(previousSurface), clusterEdgeMap(currentSurface));
  const events = selectedTimelineEvents();
  return {
    active,
    previous,
    currentSurface,
    dependencyAdded,
    clusterAdded,
    inferredEvents: inferredTimelineEvents(events),
    events,
  };
}

function constellationDeltaCount(delta = constellationSnapshotDelta()) {
  return (delta.dependencyAdded?.length || 0) + (delta.clusterAdded?.length || 0) + (delta.inferredEvents?.length || 0);
}

function constellationEdgePath(edge, pos, extraClass = "") {
  const a = pos.get(edge.from), b = pos.get(edge.to);
  if (!a || !b) return "";
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.hypot(dx, dy) || 1;
  const ux = dx / dist, uy = dy / dist;
  const sx = a.x + ux * (a.r + 2), sy = a.y + uy * (a.r + 2);
  const ex = b.x - ux * (b.r + (edge.directed ? 7 : 3)), ey = b.y - uy * (b.r + (edge.directed ? 7 : 3));
  const bend = 12 + Math.min(48, dist * 0.12);
  const qx = (sx + ex) / 2 - uy * bend, qy = (sy + ey) / 2 + ux * bend;
  const cls = edge.directed
    ? `ac-edge ac-edge-dependency ${extraClass}`.trim()
    : `ac-edge ac-edge-${edge.cluster || "x"} ${extraClass}`.trim();
  const marker = edge.directed ? ` marker-end="url(#ac-arrow)"` : "";
  return `<path class="${cls}" data-a="${escHtml(edge.from)}" data-b="${escHtml(edge.to)}" d="M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}"${marker}/>`;
}

function renderConstellationTimelineControls({ compact = false, allowDelta = false } = {}) {
  const snapshots = constellationSnapshots();
  if (!snapshots.length) {
    const status = state.cohortTimelineLoading
      ? "timeline loading"
      : state.cohortTimelineError
        ? "timeline unavailable"
        : "timeline pending";
    const detail = state.cohortTimelineError || "using current cohort surface";
    return `
      <div class="ac-timeline ${compact ? "is-compact " : ""}is-disabled" data-ac-timeline>
        <div class="ac-timeline-head">
          <span class="ac-timeline-label">${escHtml(status)}</span>
          <span class="ac-timeline-meta">${escHtml(detail)}</span>
        </div>
      </div>`;
  }

  const idx = ensureConstellationTimelineIdx();
  const active = snapshots[idx] || snapshots[snapshots.length - 1];
  const counts = active?.counts || {};
  const changeCount = snapshotEventCount(active);
  const label = active?.label || active?.id || "snapshot";
  const date = timelineSnapshotDate(active);
  const commit = active?.source_commit_short ? ` · ${active.source_commit_short}` : "";
  const delta = allowDelta ? constellationSnapshotDelta() : null;
  const deltaCount = delta ? constellationDeltaCount(delta) : 0;
  const ticks = snapshots.map((snapshot, i) => {
    const selected = i === idx;
    const tickLabel = snapshot.label || snapshot.id;
    return `
      <button class="ac-timeline-tick${selected ? " is-active" : ""}" data-const-timeline-idx="${i}" type="button" aria-current="${selected ? "true" : "false"}" title="${escAttr(tickLabel)} · ${escAttr(timelineSnapshotDate(snapshot))}">
        <span class="act-dot" aria-hidden="true"></span>
        <span class="act-label">${escHtml(tickLabel)}</span>
      </button>`;
  }).join("");

  return `
    <div class="ac-timeline${compact ? " is-compact" : ""}" data-ac-timeline>
      <div class="ac-timeline-head">
        <span class="ac-timeline-label">${escHtml(label)}</span>
        <span class="ac-timeline-meta">
          ${escHtml(date + commit)} · ${Number(counts.teams) || 0} teams · ${Number(counts.people) || 0} people · ${changeCount} ${changeCount === 1 ? "change" : "changes"}
        </span>
      </div>
      <input class="ac-timeline-range" data-const-timeline-range type="range" min="0" max="${Math.max(0, snapshots.length - 1)}" value="${idx}" step="1" aria-label="cohort timeline snapshot">
      <div class="ac-timeline-ticks" style="--ac-timeline-count:${snapshots.length}">
        ${ticks}
      </div>
      ${allowDelta ? `
        <div class="ac-timeline-actions">
          <button class="ac-timeline-delta-toggle" data-const-delta-toggle type="button" aria-pressed="${state.constellationShowDelta ? "true" : "false"}">
            <span>show changes</span><strong>${deltaCount}</strong>
          </button>
          <span class="ac-timeline-boundary">off by default · self-declared unless marked inferred</span>
        </div>` : ""}
    </div>`;
}

function setConstellationTimelineIdx(rawIdx) {
  const snapshots = constellationSnapshots();
  if (!snapshots.length) return;
  const next = Math.round(Number(rawIdx));
  if (!Number.isFinite(next)) return;
  const idx = Math.max(0, Math.min(snapshots.length - 1, next));
  state.constellationTimelineIdx = idx;
  try { localStorage.setItem(CONSTELLATION_TIMELINE_LS_KEY, String(idx)); } catch {}

  if (state.detailRecordId && state.detailReturnMode === "constellation") {
    render();
    return;
  }
  if (state.mode === "constellation") {
    renderConstellation();
    wireConstellationHover();
    if (state.constellationDrawerRecordId) openDrawer(state.constellationDrawerRecordId);
  }
}

function wireConstellationTimelineControls(root = state.canvas) {
  if (!root) return;
  const range = root.querySelector("[data-const-timeline-range]");
  if (range) {
    range.addEventListener("input", () => {
      const snapshots = constellationSnapshots();
      if (!snapshots.length) return;
      const next = Math.round(Number(range.value));
      if (!Number.isFinite(next)) return;
      const idx = Math.max(0, Math.min(snapshots.length - 1, next));
      state.constellationTimelineIdx = idx;
      try { localStorage.setItem(CONSTELLATION_TIMELINE_LS_KEY, String(idx)); } catch {}
    });
    range.addEventListener("change", () => setConstellationTimelineIdx(range.value));
  }
  for (const tick of root.querySelectorAll("[data-const-timeline-idx]")) {
    tick.addEventListener("click", () => setConstellationTimelineIdx(tick.dataset.constTimelineIdx));
  }
  for (const btn of root.querySelectorAll("[data-const-delta-toggle]")) {
    btn.addEventListener("click", () => {
      state.constellationShowDelta = !state.constellationShowDelta;
      render();
    });
  }
}

function renderConstellationDeltaLedger(delta) {
  if (!state.constellationShowDelta || !delta) return "";
  const currentLabel = delta.active?.label || delta.active?.id || "current snapshot";
  const previousLabel = delta.previous?.label || delta.previous?.id || "empty baseline";
  const edgeRow = (edge) => {
    const arrow = edge.directed ? "->" : "<->";
    const title = `${edge.fromName} ${arrow} ${edge.toName}`;
    const kind = edge.directed ? "new dependency" : "new cluster connection";
    const detail = edge.directed
      ? `present in ${currentLabel}; absent from ${previousLabel}`
      : `${edge.clusterLabel || "cluster"} membership creates this pair`;
    return `
      <article class="ac-delta-card ${edge.provenance?.className || "is-self"}">
        <div class="ac-delta-card-head">
          <span class="ac-delta-badge ${edge.provenance?.className || "is-self"}">${escHtml(edge.provenance?.label || "self-declared")}</span>
          <span>${escHtml(kind)}</span>
        </div>
        <div class="ac-delta-card-title">${escHtml(title)}</div>
        <div class="ac-delta-card-meta">${escHtml(detail)} · source: ${escHtml(edge.provenance?.source || "cohort-data")}</div>
      </article>`;
  };
  const eventRow = (event) => {
    const provenance = timelineEventProvenance(event);
    const recordName = event?.record_name || event?.record_id || "record";
    const summary = event?.summary || event?.subject || `${event?.action || "updated"} ${recordName}`;
    return `
      <article class="ac-delta-card ${provenance.className}">
        <div class="ac-delta-card-head">
          <span class="ac-delta-badge ${provenance.className}">${escHtml(provenance.label)}</span>
          <span>${escHtml(event?.record_type || event?.collection || "context")}</span>
        </div>
        <div class="ac-delta-card-title">${escHtml(recordName)}</div>
        <div class="ac-delta-card-meta">${escHtml(summary)} · source: ${escHtml(event?.source_id || provenance.source)}</div>
      </article>`;
  };
  const rows = [
    ...(delta.dependencyAdded || []).map(edgeRow),
    ...(delta.clusterAdded || []).map(edgeRow),
    ...(delta.inferredEvents || []).map(eventRow),
  ];
  const empty = rows.length ? "" : `
    <div class="ac-delta-empty">
      no new dependency, cluster, transcript, or router-derived evidence between ${escHtml(previousLabel)} and ${escHtml(currentLabel)}.
    </div>`;
  return `
    <section class="ac-delta-ledger" aria-label="timeline connection changes">
      <header class="ac-delta-head">
        <h3>changes since previous snapshot</h3>
        <span>${escHtml(previousLabel)} -> ${escHtml(currentLabel)}</span>
      </header>
      <div class="ac-delta-grid">
        ${rows.join("")}
        ${empty}
      </div>
    </section>`;
}

function renderConstellation() {
  const teams = state.cohort.teams || [];
  const people = state.cohort.people || [];
  const clusters = state.cohort.clusters || [];
  const mode = state.constellationMode === "wells" ? "map" : (state.constellationMode || "map");

  // Journey sub-view renders a PMF scatterplot instead of the map.
  // Collab Board is a peer Constellation sub-view (#216).
  if (mode === "collab") { renderCollab(); return; }
  if (mode === "journey") { renderJourney(); return; }
  if (mode === "stack") { renderProductStack(); return; }

  const lens = constNormalizeConstellationLens(state.constellationLens);
  state.constellationLens = lens;
  const viewMode = mode === "ring" ? "ring" : "map";
  const networkScope = viewMode === "map" ? constNormalizeNetworkScope(state.constellationScope) : "projects";
  const activeLens = viewMode === "ring" ? "all" : lens;
  const W = 980, H = 540;
  const model = constellationModel(teams, clusters, state.cohort?.dependencies || []);
  const layout = viewMode === "ring" ? placeConstellationRing(model, W, H) : placeConstellation(model, W, H);
  const { wells, ringSegments, pos, ringCenter } = layout;
  const edges = model.edges.filter(e => pos.has(e.from) && pos.has(e.to));
  if (networkScope === "people") {
    renderConstellationPeople(teams, people, clusters, edges);
    return;
  }
  const interestCtx = constInterestContext(teams, clusters, edges, state.constInterest);
  const coverage = constConstellationCoverage(teams, edges);
  const relationshipBreakdown = constRelationshipBreakdown(edges);
  const inspectorCtx = { ...constellationInspectorContext(teams, edges, state.cohort?.people || []), clusters, distributionWells: model.wellsDef, lens: activeLens, mode: viewMode, scope: "projects", interest: interestCtx };
  const bridgeRanks = viewMode === "ring"
    ? new Map(constBridgeTeamRows(inspectorCtx, 5).map((row, idx) => [row.team.record_id, { row, rank: idx + 1 }]))
    : new Map();
  const accentSource = viewMode === "ring" ? ringSegments : wells;
  const wellAccentById = new Map(accentSource.map((w, idx) => [w.id, constWellAccentTokens(w.id, idx)]));
  const activeWellAccent = interestCtx.active ? wellAccentById.get(interestCtx.id) : null;

  // Cluster well backdrops (soft dashed ellipse + label) behind everything.
  // The WELL carries cluster identity (position + label). We do NOT recolor
  // nodes by cluster: node color is
  // always domain, so a team never changes color when you switch lenses.
  // Long labels are truncated at rest with the full text in an SVG <title>.
  const wellMarkup = wells.map((w, idx) => {
    const isFocused = interestCtx.active && w.id === interestCtx.id;
    const interestClass = interestCtx.active
      ? (isFocused ? " is-interest-well" : (interestCtx.relatedClusterIds.has(w.id) ? " is-interest-related-well" : ""))
      : "";
    const densityClass = (w.members?.length || 0) > 3 ? " is-dense-well" : "";
    const teamCount = w.members?.length || 0;
    const aria = `${isFocused ? "Clear" : "Focus"} ${w.label || w.id} ecosystem, ${teamCount} team${teamCount === 1 ? "" : "s"}`;
    const strokeWeight = (0.88 + Math.min(teamCount, 6) * 0.12).toFixed(2);
    const accentStyle = `${constWellAccentStyle(wellAccentById.get(w.id) || constWellAccentTokens(w.id, idx))}; --well-stroke-width:${strokeWeight}`;
    return `
    <g class="ac-well${interestClass}${densityClass}" data-well="${escAttr(w.id)}" style="${escAttr(accentStyle)}" role="button" tabindex="0" aria-pressed="${isFocused ? "true" : "false"}" aria-label="${escAttr(aria)}">
      <title>${escHtml(aria)}</title>
      <circle class="ac-well-shape" cx="${w.cx.toFixed(1)}" cy="${w.cy.toFixed(1)}" r="${w.r.toFixed(1)}"/>
      ${constWellLabelSvg(w, Math.max(18, w.cy - w.r - 18))}
    </g>`;
  }).join("");
  const ringMarkup = (ringSegments || []).map((seg, idx) => {
    const isFocused = interestCtx.active && seg.id === interestCtx.id;
    const interestClass = interestCtx.active
      ? (isFocused ? " is-interest-well" : (interestCtx.relatedClusterIds.has(seg.id) ? " is-interest-related-well" : ""))
      : "";
    const aria = `${isFocused ? "Clear" : "Focus"} ${seg.label || seg.id} ecosystem arc`;
    const accentStyle = constWellAccentStyle(wellAccentById.get(seg.id) || constWellAccentTokens(seg.id, idx));
    return `
      <g class="ac-ring-world ac-well${interestClass}" data-well="${escAttr(seg.id)}" style="${escAttr(accentStyle)}" role="button" tabindex="0" aria-pressed="${isFocused ? "true" : "false"}" aria-label="${escAttr(aria)}">
        <title>${escHtml(aria)}</title>
        <path class="ac-ring-segment" d="${escAttr(seg.path)}"/>
        ${constWellLabelSvg(seg, seg.cy, "ac-ring-label")}
      </g>`;
  }).join("");

  // Edges are ONLY the self-asserted relationship arrows now — the single
  // directed, actionable signal. (Cluster membership lives in the wells.)
  // Nodes touching the active relationship question stay legible; unrelated
  // nodes fade in relation-specific lenses.
  const typedConnected = new Set();
  const lensConnected = new Set();
  const profileLinkConnected = new Set();
  const profileLinkDegree = new Map();
  const typedRecordDegree = new Map();
  edges.forEach(e => {
    if (constLensMatchesEdge(e, activeLens)) {
      lensConnected.add(e.from);
      lensConnected.add(e.to);
    }
    const targetSet = e.normalized ? typedConnected : profileLinkConnected;
    targetSet.add(e.from);
    targetSet.add(e.to);
    if (e.normalized) {
      typedRecordDegree.set(e.from, (typedRecordDegree.get(e.from) || 0) + 1);
      typedRecordDegree.set(e.to, (typedRecordDegree.get(e.to) || 0) + 1);
    } else {
      profileLinkDegree.set(e.from, (profileLinkDegree.get(e.from) || 0) + 1);
      profileLinkDegree.set(e.to, (profileLinkDegree.get(e.to) || 0) + 1);
    }
  });
  const unclusteredIds = new Set(model.wellsDef.find(w => w.id === "_other")?.members || []);
  const edgeDrawList = edges.slice().sort((a, b) =>
    Number(Boolean(a.normalized)) - Number(Boolean(b.normalized))
    || String(a.from || "").localeCompare(String(b.from || ""))
    || String(a.to || "").localeCompare(String(b.to || "")));
  const edgeMarkup = edgeDrawList.map(e => {
    const a = pos.get(e.from), b = pos.get(e.to);
    if (!a || !b) return "";
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const ux = dx / dist, uy = dy / dist;
    const sx = a.x + ux * (a.r + 2), sy = a.y + uy * (a.r + 2);
    const ex = b.x - ux * (b.r + 7), ey = b.y - uy * (b.r + 7);
    const bend = 12 + Math.min(48, dist * 0.12);
    let qx;
    let qy;
    if (ringCenter) {
      const mx = (sx + ex) / 2;
      const my = (sy + ey) / 2;
      const seed = Math.abs(hashStr(`${e.from}:${e.to}:${e.id || e.relation || ""}`));
      const spread = ((seed % 11) - 5) * 9;
      qx = mx + (ringCenter.x - mx) * 0.10 - uy * spread;
      qy = my + (ringCenter.y - my) * 0.10 + ux * spread;
    } else {
      qx = (sx + ex) / 2 - uy * bend;
      qy = (sy + ey) / 2 + ux * bend;
    }
    const meaning = constRelationshipMeaning(e);
    const lensMatchClass = constLensMatchesEdge(e, activeLens) ? " is-lens-match" : " is-lens-miss";
    const interestClass = interestCtx.active
      ? (constInterestOwnsEdge(e, interestCtx) ? " is-interest-edge" : (constInterestTouchesEdge(e, interestCtx) ? " is-interest-adjacent-edge" : " is-interest-outside"))
      : "";
    const cls = `ac-edge ac-edge-dependency ac-edge-meaning-${dependencySafeToken(meaning.key)} ac-edge-source-${e.normalized ? "record" : "legacy"} ac-edge-status-${dependencySafeToken(e.status)}${e.normalized ? " is-source-backed" : " is-profile-link"}${lensMatchClass}${interestClass}`;
    const aria = `${model.byRecordId.get(e.from)?.name || e.from} ${meaning.label}: ${e.relation_label || "links to"} ${model.byRecordId.get(e.to)?.name || e.to}`;
    const d = `M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${qx.toFixed(1)} ${qy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`;
    return `<path class="${cls}" data-a="${escAttr(e.from)}" data-b="${escAttr(e.to)}" data-dep-id="${escAttr(e.id || "")}" aria-hidden="true" d="${escAttr(d)}" marker-end="url(#ac-arrow)"/>`
      + `<path class="ac-edge-hit" data-a="${escAttr(e.from)}" data-b="${escAttr(e.to)}" data-dep-id="${escAttr(e.id || "")}" role="button" tabindex="0" aria-label="${escAttr(aria)}" d="${escAttr(d)}"/>`;
  }).join("");

  // Draw small→large so keystones sit on top of the pile. Node color is always
  // domain (one coding across every lens). Under the relationships lens, nodes
  // with no edge are flagged is-orphan (CSS fades them).
  const nodeMarkup = [...pos.values()].sort((p, q) => p.r - q.r).map(({ team, x, y, r, angle, wellId, wellSize, rank }) => {
    const orphan = (activeLens !== "all" && !lensConnected.has(team.record_id)) ? " is-orphan" : "";
    const interestClass = interestCtx.active
      ? (interestCtx.coreIds.has(team.record_id) ? " is-interest-core" : (interestCtx.neighborIds.has(team.record_id) ? " is-interest-neighbor" : " is-interest-outside"))
      : "";
    const densityClass = viewMode === "map" && wellSize > 1 ? " is-dense-well" : "";
    const keystoneClass = viewMode === "map" && rank === 0 ? " is-keystone-label" : "";
    const sourceClass = `${typedConnected.has(team.record_id) ? " is-source-backed" : ""}${profileLinkConnected.has(team.record_id) ? " is-profile-link" : ""}${unclusteredIds.has(team.record_id) ? " is-unclustered" : ""}${journeyAssessed(team) ? "" : " is-journey-missing"}`;
    const gapCount = profileLinkDegree.get(team.record_id) || 0;
    const typedCount = typedRecordDegree.get(team.record_id) || 0;
    const typedRing = typedCount
      ? `<circle class="ac-node-record-ring" r="${(r + 2.5 + Math.min(typedCount, 6) * 0.35).toFixed(1)}"><title>${escHtml(`${typedCount} relationship record${typedCount === 1 ? "" : "s"}`)}</title></circle>`
      : "";
    const bridgeRank = bridgeRanks.get(team.record_id);
    const nodeAccentStyle = interestCtx.active && (interestCtx.coreIds.has(team.record_id) || interestCtx.neighborIds.has(team.record_id))
      ? constWellAccentStyle(activeWellAccent)
      : "";
    const radialLabel = (viewMode === "ring" || (viewMode === "map" && wellSize > 2 && rank > 0)) && typeof angle === "number";
    const labelAnchor = radialLabel
      ? (Math.cos(angle) > 0.25 ? "start" : (Math.cos(angle) < -0.25 ? "end" : "middle"))
      : "middle";
    const labelGap = viewMode === "map" ? 17 : 13;
    const labelX = radialLabel
      ? (Math.cos(angle) > 0.25 ? r + 6 : (Math.cos(angle) < -0.25 ? -r - 6 : 0))
      : 0;
    const labelY = radialLabel
      ? (viewMode === "map" ? (Math.abs(Math.sin(angle)) > 0.25 ? r + labelGap : 3) : (Math.sin(angle) < -0.25 ? -r - 8 : (Math.sin(angle) > 0.25 ? r + labelGap : 3)))
      : r + labelGap;
    const labelLines = constNodeLabelLines(team, viewMode);
    const fullLabel = constText(team.name || team.record_id);
    return `
    <g class="ac-node-group ac-node-domain-${constDomainClass(team.domain)}${orphan}${sourceClass}${interestClass}${densityClass}${keystoneClass}${bridgeRank ? " is-bridge-ranked" : ""}" data-record-id="${escHtml(team.record_id)}" data-profile-link-count="${gapCount}" style="${escAttr(nodeAccentStyle)}" role="button" tabindex="0" aria-label="${escAttr(`inspect ${team.name || team.record_id}`)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle class="ac-node-hit" r="${Math.max(18, r + 10).toFixed(1)}"/>
      ${typedRing}
      <circle class="ac-node-shape ${team.is_mentor ? "ac-node-mentor" : ""}" r="${r.toFixed(1)}"/>
      ${constNodeLabelSvg(labelLines, labelX, labelY, labelAnchor, fullLabel)}
    </g>`;
  }).join("");

  // Legend is the SAME in every lens — color = domain always. Cluster identity
  // is read from the labeled wells, not the legend, so nothing swaps.
  const legend = `
    <div class="acl-line-key">
      <strong>Line source</strong>
      <span class="acl-line-key-row is-typed"><i></i><b>relationship record</b></span>
      <span class="acl-line-key-row is-profile"><i></i><b>profile mention</b></span>
    </div>
    <div class="acl-line-note">Solid = a relationship record with type, status, evidence, or next action. Dotted = a project profile mention that needs confirmation.</div>`;

  state.canvas.innerHTML = `
    <div class="alch-constellation" data-constellation-view="${escAttr(viewMode)}">
      <div class="alch-const-topbar">${constellationNav(viewMode)}</div>
      ${viewMode === "map" || viewMode === "ring" ? `
        <div class="ac-map-control-stack">
          ${viewMode === "map" ? constellationNetworkScopeRow("projects", { projects: teams.length, people: people.length }) : ""}
          ${constellationMapLayoutRow(viewMode)}
          ${viewMode === "map" ? `
            ${constellationLensRow(lens, { edges: coverage.edges, meaningMissing: coverage.meaningMissing, ...relationshipBreakdown })}
          ` : ""}
        </div>` : ""}
      <div class="alch-const-workbench">
        <div class="alch-const-main">
          <div class="alch-constellation-legend">${legend}</div>
          <div class="alch-constellation-stage" data-view="${escAttr(viewMode)}" data-lens="${activeLens}" data-interest="${escAttr(interestCtx.id)}" data-interest-active="${interestCtx.active ? "true" : "false"}" tabindex="0" aria-label="${escAttr(viewMode === "ring" ? "constellation bridge ring graph" : "constellation relationship graph")}">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
              <defs>
                <marker id="ac-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z"/>
                </marker>
              </defs>
              <g class="ac-wells">${viewMode === "ring" ? ringMarkup : wellMarkup}</g>
              <g class="ac-edges">${edgeMarkup}</g>
              <g class="ac-nodes">${nodeMarkup}</g>
            </svg>
            <div class="ac-tip" hidden></div>
          </div>
        </div>
        ${constellationInspectorShell(inspectorCtx)}
      </div>
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
  wireConstellationModeNav();
  const stage = state.canvas.querySelector(".alch-constellation-stage");
  if (!state.constellationEscapeBound) {
    state.constellationEscapeBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !state.constSelection || state.mode !== "constellation") return;
      const editing = e.target?.closest?.("input, textarea, select, [contenteditable='true']");
      if (editing) return;
      if (!state.canvas?.querySelector(".alch-constellation")) return;
      e.preventDefault();
      setConstellationInspector(null, constellationCurrentInspectorContext());
    });
  }
  if (stage) {
    // ONE styled floating tooltip serves both the map and the journey scatter
    // (was a fixed hover-line on the map + a separate floating tip on journey).
    const tip = stage.querySelector(".ac-tip");
    const teams = state.cohort?.teams || [];
    const clusters = state.cohort?.clusters || [];
    const teamById = new Map(teams.map(t => [t.record_id, t]));
    const edges = constellationDependencyEdges(teams, undefined, state.cohort?.dependencies || []).filter(e => teamById.has(e.from) && teamById.has(e.to));
    const model = constellationModel(teams, clusters, state.cohort?.dependencies || []);
    const rawMode = state.constellationMode === "wells" ? "map" : state.constellationMode;
    const viewMode = rawMode === "ring" || rawMode === "journey" || rawMode === "stack" ? rawMode : "map";
    const activeLens = viewMode === "ring" || viewMode === "stack" ? "all" : constNormalizeConstellationLens(state.constellationLens);
    const scope = viewMode === "map" ? constNormalizeNetworkScope(state.constellationScope) : "projects";
    const baseInspectorCtx = { ...constellationInspectorContext(teams, edges, state.cohort?.people || []), clusters, distributionWells: model.wellsDef, lens: activeLens, mode: viewMode, scope, interest: constInterestContext(teams, clusters, edges, state.constInterest) };
    const peopleModel = scope === "people" ? constPeopleNetworkModel(state.cohort?.people || [], teams, 1120, 620) : null;
    const inspectorCtx = viewMode === "stack"
      ? { ...baseInspectorCtx, stackModel: constProductStackModel(teams, baseInspectorCtx) }
      : (peopleModel ? { ...baseInspectorCtx, peopleModel } : baseInspectorCtx);
    const indeg = constellationIndegree(teams, state.cohort?.dependencies || []);
    const sourceStatsByRid = new Map();
    for (const edge of edges) {
      for (const rid of [edge.from, edge.to]) {
        if (!teamById.has(rid)) continue;
        const cur = sourceStatsByRid.get(rid) || { typed: 0, profile: 0 };
        if (edge.normalized) cur.typed++;
        else cur.profile++;
        sourceStatsByRid.set(rid, cur);
      }
    }
    // rid → all cluster labels it belongs to (not just the primary well).
    const clusterLabelsByRid = new Map();
    for (const cl of clusters) {
      const label = cl.label || cl.name || "cluster";
      for (const rid of (cl.teams || [])) {
        if (!teamById.has(rid)) continue;
        if (!clusterLabelsByRid.has(rid)) clusterLabelsByRid.set(rid, []);
        clusterLabelsByRid.get(rid).push(label);
      }
    }
    markConstellationSelection(state.constSelection);
    const setInterestFocus = (targetId) => {
      const next = targetId && targetId === state.constInterest ? "all" : (targetId || "all");
      state.constInterest = next;
      state.constSelection = null;
      try { localStorage.setItem(CONST_INTEREST_LS_KEY, next); } catch {}
      render();
    };
    // Cluster wells are the ecosystem control. Clicking the visual circle now
    // changes the graph read; the old text-chip row was redundant.
    for (const well of stage.querySelectorAll(".ac-well[data-well]")) {
      const wellId = well.getAttribute("data-well") || "all";
      const showWellTip = (e) => {
        const focus = constInterestContext(teams, clusters, edges, wellId);
        if (!tip || !focus.active) return;
        const directEdges = edges.filter(edge => constInterestOwnsEdge(edge, focus));
        tip.innerHTML = `
          <div class="ajt-name">${escHtml(constClusterLabel(focus.cluster))}</div>
          <div class="ajt-row"><span class="ajt-k">teams</span><span class="ajt-v">${escHtml(String(focus.coreTeams.length))} core · ${escHtml(String(focus.neighborTeams.length))} adjacent</span></div>
          <div class="ajt-row"><span class="ajt-k">lines</span><span class="ajt-v">${escHtml(String(directEdges.length))} direct relationship line${directEdges.length === 1 ? "" : "s"}</span></div>
          <div class="ajt-row"><span class="ajt-k">action</span><span class="ajt-v">${wellId === state.constInterest ? "click to show whole map" : "click to focus this ecosystem"}</span></div>`;
        tip.hidden = false;
        if (e && typeof e.clientX === "number") positionConstTip(stage, tip, e);
      };
      well.addEventListener("mouseenter", showWellTip);
      well.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      well.addEventListener("mouseleave", () => { if (tip) tip.hidden = true; });
      well.addEventListener("click", (e) => {
        e.preventDefault();
        setInterestFocus(wellId);
      });
      well.addEventListener("focus", () => showWellTip(null));
      well.addEventListener("blur", () => { if (tip) tip.hidden = true; });
      well.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setInterestFocus(wellId);
      });
    }
    // Map nodes: hover lights the touching edges + shows the provenance tip.
    for (const g of stage.querySelectorAll(".ac-node-group")) {
      const rid = g.dataset.recordId;
      g.addEventListener("mouseenter", (e) => {
        setConstellationHover(stage, rid, true);
        const t = teamById.get(rid);
        if (tip && t) {
          tip.innerHTML = constNodeTipHTML(t, indeg.get(rid) || 0, inspectorCtx.outBy, inspectorCtx.inBy, clusterLabelsByRid.get(rid), sourceStatsByRid.get(rid));
          tip.hidden = false;
          positionConstTip(stage, tip, e);
        }
      });
      g.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      g.addEventListener("mouseleave", () => {
        setConstellationHover(stage, rid, false);
        if (tip) tip.hidden = true;
      });
      g.addEventListener("click", (e) => {
        e.preventDefault();
        setConstellationInspector({ type: "team", rid }, inspectorCtx);
      });
      g.addEventListener("focus", () => {
        setConstellationHover(stage, rid, true);
      });
      g.addEventListener("blur", () => setConstellationHover(stage, rid, false));
      g.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setConstellationInspector({ type: "team", rid }, inspectorCtx);
      });
    }
    for (const item of stage.querySelectorAll(".ac-stack-team[data-const-team]")) {
      const rid = item.getAttribute("data-const-team");
      item.addEventListener("mouseenter", (e) => {
        const t = teamById.get(rid);
        if (tip && t) {
          const item = constStackItemForTeam(inspectorCtx, rid);
          const role = item?.role || constMarketRoleForTeam(t);
          const evidence = item?.evidence || constEvidenceModeForTeam(t, inspectorCtx);
          const evidenceRead = evidence.key === "profile"
            ? evidence.label
            : `${evidence.label} · ${String(evidence.value)}/5`;
          const secondary = role.secondary;
          tip.innerHTML = `
            <div class="ajt-name">${escHtml(t.name || t.record_id)}</div>
            <div class="ajt-row"><span class="ajt-k">role</span><span class="ajt-v">${escHtml(role.label)}</span></div>
            ${secondary ? `<div class="ajt-row"><span class="ajt-k">also</span><span class="ajt-v">${escHtml(secondary.label)}</span></div>` : ""}
            <div class="ajt-row"><span class="ajt-k">proof</span><span class="ajt-v">${escHtml(evidenceRead)}</span></div>
            <div class="ajt-row"><span class="ajt-k">source</span><span class="ajt-v">${escHtml(role.reason)}</span></div>`;
          tip.hidden = false;
          positionConstTip(stage, tip, e);
        }
      });
      item.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      item.addEventListener("mouseleave", () => { if (tip) tip.hidden = true; });
      item.addEventListener("click", (e) => {
        e.preventDefault();
        if (rid) openDrawer(rid);
      });
      item.addEventListener("focus", () => {
        const t = teamById.get(rid);
        if (tip && t) {
          const item = constStackItemForTeam(inspectorCtx, rid);
          const role = item?.role || constMarketRoleForTeam(t);
          const evidence = item?.evidence || constEvidenceModeForTeam(t, inspectorCtx);
          const evidenceRead = evidence.key === "profile"
            ? evidence.label
            : `${evidence.label} · ${String(evidence.value)}/5`;
          tip.innerHTML = `<div class="ajt-name">${escHtml(t.name || t.record_id)}</div><div class="ajt-row"><span class="ajt-k">role</span><span class="ajt-v">${escHtml(role.label)}</span></div>${role.secondary ? `<div class="ajt-row"><span class="ajt-k">also</span><span class="ajt-v">${escHtml(role.secondary.label)}</span></div>` : ""}<div class="ajt-row"><span class="ajt-k">proof</span><span class="ajt-v">${escHtml(evidenceRead)}</span></div>`;
          tip.hidden = false;
        }
      });
      item.addEventListener("blur", () => { if (tip) tip.hidden = true; });
      item.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (rid) openDrawer(rid);
      });
    }
    // Dependency paths: hover identifies the line; click pins the full evidence
    // in the fixed inspector.
    for (const edgeEl of stage.querySelectorAll(".ac-edge[data-a][data-b], .ac-edge-hit[data-a][data-b]")) {
      const from = edgeEl.dataset.a;
      const to = edgeEl.dataset.b;
      const edge = inspectorCtx.edgeByPair.get(dependencyPairKey(from, to)) || { from, to };
      const selectEdge = (e) => {
        const meaning = constRelationshipMeaning(edge);
        setConstellationEdgeHover(stage, from, to, true);
        if (tip && teamById.has(from) && teamById.has(to)) {
          const status = constRelationshipStatus(edge);
          const source = constRelationshipSource(edge);
          const confidence = edge.normalized ? "relationship record" : "profile mention";
          tip.innerHTML = `<div class="ajt-name">${escHtml(teamById.get(from).name || from)} → ${escHtml(teamById.get(to).name || to)}</div><div class="ajt-row"><span class="ajt-k">line source</span><span class="ajt-v">${escHtml(confidence)}</span></div><div class="ajt-row"><span class="ajt-k">line</span><span class="ajt-v">${escHtml(meaning.label)} · ${escHtml(status.label)}</span></div><div class="ajt-row"><span class="ajt-k">source</span><span class="ajt-v">${escHtml(source.label)}</span></div><div class="ajt-row"><span class="ajt-k">action</span><span class="ajt-v">click for evidence and next action</span></div>`;
          if (typeof e.clientX === "number") {
            tip.hidden = false;
            positionConstTip(stage, tip, e);
          }
        }
      };
      edgeEl.addEventListener("mouseenter", selectEdge);
      edgeEl.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      edgeEl.addEventListener("mouseleave", () => {
        setConstellationEdgeHover(stage, from, to, false);
        if (tip) tip.hidden = true;
      });
      edgeEl.addEventListener("focus", selectEdge);
      edgeEl.addEventListener("blur", () => setConstellationEdgeHover(stage, from, to, false));
      edgeEl.addEventListener("click", (e) => {
        e.preventDefault();
        setConstellationInspector({ type: "edge", from, to }, inspectorCtx);
      });
      edgeEl.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        setConstellationInspector({ type: "edge", from, to }, inspectorCtx);
      });
    }
    // Journey scatterplot nodes: same tip element, journey content.
    for (const node of stage.querySelectorAll(".ac-jnode")) {
      const rid = node.dataset.recordId;
      node.addEventListener("mouseenter", (e) => {
        showJourneyTip(stage, tip, teamById.get(rid));
        positionConstTip(stage, tip, e);
      });
      node.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      node.addEventListener("mouseleave", () => { if (tip) tip.hidden = true; });
      node.addEventListener("click", (e) => {
        e.preventDefault();
        if (rid) openDrawer(rid);
      });
      node.addEventListener("focus", () => {
        showJourneyTip(stage, tip, teamById.get(rid));
      });
      node.addEventListener("blur", () => { if (tip) tip.hidden = true; });
      node.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (rid) openDrawer(rid);
      });
    }
    for (const node of stage.querySelectorAll(".ac-person-node[data-person-id]")) {
      const rid = node.getAttribute("data-person-id");
      const person = inspectorCtx.personById?.get(rid);
      node.addEventListener("mouseenter", (e) => {
        setConstellationPersonHover(stage, rid, true);
        if (tip && person) {
          tip.innerHTML = constPersonTipHTML(person, inspectorCtx.peopleModel, inspectorCtx);
          tip.hidden = false;
          positionConstTip(stage, tip, e);
        }
      });
      node.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      node.addEventListener("mouseleave", () => {
        setConstellationPersonHover(stage, rid, false);
        if (tip) tip.hidden = true;
      });
      node.addEventListener("click", (e) => {
        e.preventDefault();
        if (rid) setConstellationInspector({ type: "person", rid }, inspectorCtx);
      });
      node.addEventListener("focus", () => {
        setConstellationPersonHover(stage, rid, true);
        if (tip && person) {
          tip.innerHTML = constPersonTipHTML(person, inspectorCtx.peopleModel, inspectorCtx);
          tip.hidden = false;
        }
      });
      node.addEventListener("blur", () => {
        setConstellationPersonHover(stage, rid, false);
        if (tip) tip.hidden = true;
      });
      node.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (rid) setConstellationInspector({ type: "person", rid }, inspectorCtx);
      });
    }
    for (const anchor of stage.querySelectorAll(".ac-project-anchor[data-const-team]")) {
      const rid = anchor.getAttribute("data-const-team");
      anchor.addEventListener("mouseenter", (e) => {
        setConstellationPersonProjectHover(stage, rid, true);
        const t = teamById.get(rid);
        if (tip && t) {
          const linked = inspectorCtx.peopleModel?.edges?.filter(edge => edge.team === rid && edge.kind === "primary").length || 0;
          tip.innerHTML = `<div class="ajt-name">${escHtml(t.name || t.record_id)}</div><div class="ajt-row"><span class="ajt-k">people</span><span class="ajt-v">${escHtml(String(linked))} primary project member${linked === 1 ? "" : "s"}</span></div><div class="ajt-row"><span class="ajt-k">source</span><span class="ajt-v">person.team fields</span></div><div class="ajt-row"><span class="ajt-k">action</span><span class="ajt-v">click to inspect project</span></div>`;
          tip.hidden = false;
          positionConstTip(stage, tip, e);
        }
      });
      anchor.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      anchor.addEventListener("mouseleave", () => {
        setConstellationPersonProjectHover(stage, rid, false);
        if (tip) tip.hidden = true;
      });
      anchor.addEventListener("click", (e) => {
        e.preventDefault();
        if (rid) setConstellationInspector({ type: "team", rid }, inspectorCtx);
      });
      anchor.addEventListener("focus", () => setConstellationPersonProjectHover(stage, rid, true));
      anchor.addEventListener("blur", () => setConstellationPersonProjectHover(stage, rid, false));
      anchor.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (rid) setConstellationInspector({ type: "team", rid }, inspectorCtx);
      });
    }
    for (const group of stage.querySelectorAll(".ac-person-well[data-const-team]")) {
      const rid = group.getAttribute("data-const-team");
      const t = teamById.get(rid);
      group.addEventListener("mouseenter", (e) => {
        setConstellationPersonProjectHover(stage, rid, true);
        if (tip && t) {
          const linked = stage.querySelectorAll(`.ac-person-node[data-person-team="${CSS.escape(rid)}"]`).length;
          tip.innerHTML = `<div class="ajt-name">${escHtml(t.name || t.record_id)}</div><div class="ajt-row"><span class="ajt-k">people</span><span class="ajt-v">${escHtml(String(linked))} primary member${linked === 1 ? "" : "s"}</span></div><div class="ajt-row"><span class="ajt-k">action</span><span class="ajt-v">click to inspect project</span></div>`;
          tip.hidden = false;
          positionConstTip(stage, tip, e);
        }
      });
      group.addEventListener("mousemove", (e) => positionConstTip(stage, tip, e));
      group.addEventListener("mouseleave", () => {
        setConstellationPersonProjectHover(stage, rid, false);
        if (tip) tip.hidden = true;
      });
      group.addEventListener("click", (e) => {
        e.preventDefault();
        if (rid) setConstellationInspector({ type: "team", rid }, inspectorCtx);
      });
      group.addEventListener("focus", () => setConstellationPersonProjectHover(stage, rid, true));
      group.addEventListener("blur", () => setConstellationPersonProjectHover(stage, rid, false));
      group.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (rid) setConstellationInspector({ type: "team", rid }, inspectorCtx);
      });
    }
  }
  // Layout toggle: cluster-grouped wells ↔ single ring (the original view).
  for (const btn of state.canvas.querySelectorAll(".ac-layout-btn[data-const-layout]")) {
    btn.addEventListener("click", () => {
      const next = constNormalizeNetworkScope(btn.dataset.constNetworkScope);
      if (next === state.constellationScope) return;
      state.constellationScope = next;
      state.constSelection = null;
      if (state.constellationMode === "ring" && next === "people") state.constellationMode = "map";
      try {
        localStorage.setItem(CONST_SCOPE_LS_KEY, next);
        localStorage.setItem(CONST_MODE_LS_KEY, state.constellationMode);
      } catch {}
      render();
    });
  }
  // Map layout: same question, alternate geometry. Persisted with view mode.
  for (const btn of state.canvas.querySelectorAll(".ac-map-layout-btn[data-const-map-layout]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.constMapLayout === "ring" ? "ring" : "map";
      if (next === state.constellationMode) return;
      state.constellationMode = next;
      state.constSelection = null;
      try { localStorage.setItem(CONST_MODE_LS_KEY, next); } catch {}
      render();
    });
  }
  // Map lens: re-weights the same map by line type. Persisted.
  for (const btn of state.canvas.querySelectorAll(".ac-lens-btn[data-const-lens]")) {
    btn.addEventListener("click", () => {
      const next = constNormalizeConstellationLens(btn.dataset.constLens);
      if (next === state.constellationLens) return;
      state.constellationLens = next;
      try { localStorage.setItem(CONST_LENS_LS_KEY, next); } catch {}
      render();
    });
  }
  for (const target of state.canvas.querySelectorAll(".ac-distribution-card [data-const-interest]")) {
    const selectDistributionInterest = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = target.getAttribute("data-const-interest") || "all";
      state.constInterest = next;
      state.constSelection = null;
      try { localStorage.setItem(CONST_INTEREST_LS_KEY, next); } catch {}
      render();
    };
    target.addEventListener("click", selectDistributionInterest);
    target.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      selectDistributionInterest(e);
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
  const inspector = state.canvas.querySelector(".ac-inspector");
  if (inspector) {
    wireExternalLinks(inspector);
    inspector.addEventListener("click", (e) => {
      const clearTarget = e.target.closest("[data-const-clear-selection]");
      if (clearTarget) {
        setConstellationInspector(null, constellationCurrentInspectorContext());
        return;
      }
      const openTarget = e.target.closest("[data-const-open-record]");
      if (openTarget) {
        const rid = openTarget.getAttribute("data-const-open-record");
        if (rid && constellationCurrentInspectorContext().personById?.has(rid)) openDetail(rid);
        else if (rid) openDrawer(rid);
        return;
      }
      const personTarget = e.target.closest("[data-const-person]");
      if (personTarget) {
        const rid = personTarget.getAttribute("data-const-person");
        if (rid) openDetail(rid);
        return;
      }
      const interestTarget = e.target.closest("[data-const-interest]");
      if (interestTarget) {
        const next = interestTarget.getAttribute("data-const-interest") || "all";
        state.constInterest = next;
        state.constSelection = null;
        try { localStorage.setItem(CONST_INTEREST_LS_KEY, next); } catch {}
        render();
        return;
      }
      const edgeTarget = e.target.closest("[data-const-edge-from][data-const-edge-to]");
      if (edgeTarget) {
        const from = edgeTarget.getAttribute("data-const-edge-from");
        const to = edgeTarget.getAttribute("data-const-edge-to");
        if (from && to) {
          setConstellationInspector({ type: "edge", from, to }, constellationCurrentInspectorContext());
        }
        return;
      }
      const target = e.target.closest("[data-const-team]");
      if (!target) return;
      const rid = target.getAttribute("data-const-team");
      if (rid) {
        setConstellationInspector({ type: "team", rid }, constellationCurrentInspectorContext());
      }
    });
  }
}

function setConstellationInspector(selection, ctx) {
  state.constSelection = selection || null;
  const head = state.canvas?.querySelector(".ac-inspector-head");
  if (head) head.innerHTML = constellationInspectorHeaderHtml(state.constSelection, ctx);
  const body = state.canvas?.querySelector(".ac-inspector-body");
  if (body) body.innerHTML = constellationInspectorLeadHtml(ctx, state.constSelection) + constellationInspectorHtml(state.constSelection, ctx);
  if (head) wireExternalLinks(head);
  if (body) wireExternalLinks(body);
  markConstellationSelection(state.constSelection);
}

function stepConstellationTeamSelection(delta, fromTarget) {
  const ctx = constellationCurrentInspectorContext();
  const order = constellationTeamNavOrder(ctx);
  if (!order.length) return;
  const targetRid = fromTarget?.closest?.("[data-const-team], [data-record-id]")?.getAttribute?.("data-const-team")
    || fromTarget?.closest?.("[data-const-team], [data-record-id]")?.getAttribute?.("data-record-id")
    || "";
  const currentRid = state.constSelection?.type === "team"
    ? state.constSelection.rid
    : (state.constSelection?.type === "edge" ? state.constSelection.to : targetRid);
  const foundIdx = order.findIndex(team => team.record_id === currentRid);
  const currentIdx = foundIdx >= 0 ? foundIdx : (delta > 0 ? -1 : 0);
  const nextIdx = (currentIdx + delta + order.length) % order.length;
  const next = order[nextIdx];
  if (!next?.record_id) return;
  setConstellationInspector({ type: "team", rid: next.record_id }, ctx);
  const node = state.canvas?.querySelector(`.ac-node-group[data-record-id="${CSS.escape(next.record_id)}"], .ac-jnode[data-record-id="${CSS.escape(next.record_id)}"], .ac-stack-team[data-const-team="${CSS.escape(next.record_id)}"]`);
  try { node?.focus?.({ preventScroll: true }); } catch { node?.focus?.(); }
}

function markConstellationSelection(selection) {
  const root = state.canvas?.querySelector(".alch-constellation");
  if (!root) return;
  const stage = root.querySelector(".alch-constellation-stage");
  if (stage) stage.removeAttribute("data-selection-active");
  root.querySelectorAll(
    ".is-selected, .is-selected-team-row, .is-selection-core, .is-selection-neighbor, .is-selection-outside, .is-selection-edge, .is-selection-adjacent-edge"
  ).forEach(el => el.classList.remove(
    "is-selected",
    "is-selected-team-row",
    "is-selection-core",
    "is-selection-neighbor",
    "is-selection-outside",
    "is-selection-edge",
    "is-selection-adjacent-edge"
  ));
  if (!selection) return;
  if (stage) stage.setAttribute("data-selection-active", "true");
  const nodeEls = [...root.querySelectorAll(".ac-node-group[data-record-id], .ac-person-node[data-person-id], .ac-project-anchor[data-const-team], .ac-person-well[data-const-team], .ac-jnode[data-record-id], .ac-stack-team[data-const-team]")];
  const edgeEls = [...root.querySelectorAll(".ac-edge[data-a][data-b], .ac-person-link[data-person][data-team]")];
  const classifyNode = (recordId, coreIds, neighborIds) => {
    const id = String(recordId || "");
    if (coreIds.has(id)) return "is-selection-core";
    if (neighborIds.has(id)) return "is-selection-neighbor";
    return "is-selection-outside";
  };
  if (selection?.type === "team") {
    const coreIds = new Set([selection.rid]);
    const neighborIds = new Set();
    edgeEls.forEach(edge => {
      if (edge.classList.contains("ac-person-link")) {
        const personId = edge.getAttribute("data-person");
        const teamId = edge.getAttribute("data-team");
        const personA = edge.getAttribute("data-person-a");
        const personB = edge.getAttribute("data-person-b");
        const aTeam = personA ? root.querySelector(`.ac-person-node[data-person-id="${CSS.escape(personA)}"]`)?.getAttribute("data-person-team") : "";
        const bTeam = personB ? root.querySelector(`.ac-person-node[data-person-id="${CSS.escape(personB)}"]`)?.getAttribute("data-person-team") : "";
        if (teamId === selection.rid || aTeam === selection.rid || bTeam === selection.rid) {
          edge.classList.add("is-selection-edge");
          if (personId) neighborIds.add(personId);
          if (personA) neighborIds.add(personA);
          if (personB) neighborIds.add(personB);
        } else {
          edge.classList.add("is-selection-outside");
        }
        return;
      }
      const a = edge.dataset.a;
      const b = edge.dataset.b;
      if (a === selection.rid || b === selection.rid) {
        edge.classList.add("is-selection-edge");
        neighborIds.add(a === selection.rid ? b : a);
      } else {
        edge.classList.add("is-selection-outside");
      }
    });
    nodeEls.forEach(node => {
      const recordId = node.dataset.recordId || node.getAttribute("data-const-team") || node.getAttribute("data-person-id");
      const cls = classifyNode(recordId, coreIds, neighborIds);
      node.classList.add(cls);
      if (recordId === selection.rid) node.classList.add("is-selected");
    });
    root.querySelectorAll(`[data-const-team="${CSS.escape(selection.rid)}"]`).forEach(el => el.classList.add("is-selected-team-row"));
  } else if (selection?.type === "person") {
    const coreIds = new Set([selection.rid]);
    const neighborIds = new Set();
    const selectedPersonNode = root.querySelector(`.ac-person-node[data-person-id="${CSS.escape(selection.rid)}"]`);
    const selectedTeamId = selectedPersonNode?.getAttribute("data-person-team");
    if (selectedTeamId) neighborIds.add(selectedTeamId);
    edgeEls.forEach(edge => {
      if (edge.classList.contains("ac-person-link")) {
        const personId = edge.getAttribute("data-person");
        const teamId = edge.getAttribute("data-team");
        const personA = edge.getAttribute("data-person-a");
        const personB = edge.getAttribute("data-person-b");
        if (personId === selection.rid || personA === selection.rid || personB === selection.rid) {
          edge.classList.add("is-selection-edge");
          if (teamId) neighborIds.add(teamId);
          if (personA && personA !== selection.rid) neighborIds.add(personA);
          if (personB && personB !== selection.rid) neighborIds.add(personB);
        } else {
          edge.classList.add("is-selection-outside");
        }
        return;
      }
      edge.classList.add("is-selection-outside");
    });
    nodeEls.forEach(node => {
      const recordId = node.dataset.recordId || node.getAttribute("data-const-team") || node.getAttribute("data-person-id");
      const cls = classifyNode(recordId, coreIds, neighborIds);
      node.classList.add(cls);
      if (recordId === selection.rid) node.classList.add("is-selected");
    });
  } else if (selection?.type === "edge") {
    const coreIds = new Set([selection.from, selection.to]);
    const neighborIds = new Set();
    edgeEls.forEach(edge => {
      const a = edge.dataset.a;
      const b = edge.dataset.b;
      const exact = a === selection.from && b === selection.to;
      const touches = coreIds.has(a) || coreIds.has(b);
      if (exact) {
        edge.classList.add("is-selected", "is-selection-edge");
      } else if (touches) {
        edge.classList.add("is-selection-adjacent-edge");
        if (!coreIds.has(a)) neighborIds.add(a);
        if (!coreIds.has(b)) neighborIds.add(b);
      } else {
        edge.classList.add("is-selection-outside");
      }
    });
    nodeEls.forEach(node => {
      const recordId = node.dataset.recordId || node.getAttribute("data-const-team") || node.getAttribute("data-person-id");
      const cls = classifyNode(recordId, coreIds, neighborIds);
      node.classList.add(cls);
      if (coreIds.has(recordId)) node.classList.add("is-selected");
    });
  }
}

function setConstellationEdgeHover(stage, from, to, on) {
  if (!stage) return;
  if (!on) {
    stage.removeAttribute("data-hover-active");
    stage.querySelectorAll(".ac-edge.is-hot, .ac-edge.is-far").forEach(e => e.classList.remove("is-hot", "is-far"));
    stage.querySelectorAll(".ac-node-group.is-related, .ac-node-group.is-far").forEach(e => e.classList.remove("is-related", "is-far"));
    return;
  }
  stage.setAttribute("data-hover-active", "true");
  stage.querySelectorAll(".ac-edge.is-hot, .ac-edge.is-far").forEach(e => e.classList.remove("is-hot", "is-far"));
  stage.querySelectorAll(".ac-node-group.is-related, .ac-node-group.is-far").forEach(e => e.classList.remove("is-related", "is-far"));
  stage.querySelectorAll(`.ac-edge[data-a="${CSS.escape(from)}"][data-b="${CSS.escape(to)}"]`).forEach(e => e.classList.add("is-hot"));
  stage.querySelectorAll(`.ac-node-group[data-record-id="${CSS.escape(from)}"], .ac-node-group[data-record-id="${CSS.escape(to)}"]`).forEach(g => g.classList.add("is-related"));
}

function wireConstellationModeNav() {
  const modes = new Set(["clusters", "dependencies", "journey", "collab"]);
  for (const btn of state.canvas.querySelectorAll(".alch-const-mode-btn[data-const-mode]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.constMode;
      if (!modes.has(next)) return;
      if (state.mode === "constellation" && next === state.constellationMode) return;
      if (state.mode === "collab" && next === "collab") return;
      state.mode = "constellation";
      state.constellationMode = next;
      try { localStorage.setItem(ALCHEMY_LS_KEY, next === "collab" ? "collab" : "constellation"); } catch {}
      syncRailSelection();
      render();
    });
  }
}
function setConstellationHover(stage, recordId, on) {
  if (!on) {
    stage.removeAttribute("data-hover-active");
    stage.querySelectorAll(".ac-edge.is-hot, .ac-edge.is-far").forEach(e => e.classList.remove("is-hot", "is-far"));
    stage.querySelectorAll(".ac-node-group.is-related, .ac-node-group.is-far").forEach(e => e.classList.remove("is-related", "is-far"));
    return;
  }
  stage.setAttribute("data-hover-active", "true");
  const edgeEls = [...stage.querySelectorAll(".ac-edge")];
  const related = new Set();
  edgeEls.forEach(e => {
    const a = e.dataset.a, b = e.dataset.b;
    const direct = a === recordId || b === recordId;
    e.classList.toggle("is-hot", direct);
    e.classList.remove("is-far");
    if (direct) {
      if (a && a !== recordId) related.add(a);
      if (b && b !== recordId) related.add(b);
    }
  });
  stage.querySelectorAll(".ac-node-group").forEach(g => {
    const rid = g.dataset.recordId;
    g.classList.toggle("is-related", related.has(rid));
    g.classList.remove("is-far");
  });
}
function setConstellationPersonHover(stage, personId, on) {
  if (!stage) return;
  if (!on) {
    stage.removeAttribute("data-hover-active");
    stage.querySelectorAll(".ac-person-link.is-hot").forEach(e => e.classList.remove("is-hot"));
    stage.querySelectorAll(".ac-person-node.is-related, .ac-project-anchor.is-related, .ac-person-well.is-related").forEach(e => e.classList.remove("is-related"));
    return;
  }
  stage.setAttribute("data-hover-active", "true");
  const teams = new Set();
  const people = new Set([personId]);
  stage.querySelectorAll(".ac-person-link").forEach(edge => {
    const personA = edge.getAttribute("data-person-a");
    const personB = edge.getAttribute("data-person-b");
    const direct = edge.getAttribute("data-person") === personId || personA === personId || personB === personId;
    edge.classList.toggle("is-hot", direct);
    if (direct) teams.add(edge.getAttribute("data-team"));
    if (direct && personA) people.add(personA);
    if (direct && personB) people.add(personB);
  });
  stage.querySelectorAll(".ac-person-node").forEach(node => {
    const related = people.has(node.getAttribute("data-person-id"));
    node.classList.toggle("is-related", related);
    if (related && node.getAttribute("data-person-team")) teams.add(node.getAttribute("data-person-team"));
  });
  stage.querySelectorAll(".ac-project-anchor[data-const-team]").forEach(anchor => {
    anchor.classList.toggle("is-related", teams.has(anchor.getAttribute("data-const-team")));
  });
  stage.querySelectorAll(".ac-person-well[data-const-team]").forEach(group => {
    group.classList.toggle("is-related", teams.has(group.getAttribute("data-const-team")));
  });
}
function setConstellationPersonProjectHover(stage, teamId, on) {
  if (!stage) return;
  if (!on) {
    stage.removeAttribute("data-hover-active");
    stage.querySelectorAll(".ac-person-link.is-hot").forEach(e => e.classList.remove("is-hot"));
    stage.querySelectorAll(".ac-person-node.is-related, .ac-project-anchor.is-related, .ac-person-well.is-related").forEach(e => e.classList.remove("is-related"));
    return;
  }
  stage.setAttribute("data-hover-active", "true");
  const people = new Set();
  stage.querySelectorAll(".ac-person-link").forEach(edge => {
    const personA = edge.getAttribute("data-person-a");
    const personB = edge.getAttribute("data-person-b");
    const aTeam = personA ? stage.querySelector(`.ac-person-node[data-person-id="${CSS.escape(personA)}"]`)?.getAttribute("data-person-team") : "";
    const bTeam = personB ? stage.querySelector(`.ac-person-node[data-person-id="${CSS.escape(personB)}"]`)?.getAttribute("data-person-team") : "";
    const direct = edge.getAttribute("data-team") === teamId || aTeam === teamId || bTeam === teamId;
    edge.classList.toggle("is-hot", direct);
    if (direct) people.add(edge.getAttribute("data-person"));
    if (direct && personA) people.add(personA);
    if (direct && personB) people.add(personB);
  });
  stage.querySelectorAll(".ac-project-anchor[data-const-team]").forEach(anchor => {
    anchor.classList.toggle("is-related", anchor.getAttribute("data-const-team") === teamId);
  });
  stage.querySelectorAll(".ac-person-well[data-const-team]").forEach(group => {
    group.classList.toggle("is-related", group.getAttribute("data-const-team") === teamId);
  });
  stage.querySelectorAll(".ac-person-node").forEach(node => {
    const primary = node.getAttribute("data-person-team") === teamId;
    const secondary = (node.getAttribute("data-person-secondary-teams") || "").split(/\s+/).includes(teamId);
    node.classList.toggle("is-related", primary || secondary || people.has(node.getAttribute("data-person-id")));
  });
}

// Journey tooltip: name + stage/evidence labels + bottleneck + next
// milestone. Reads journey with defaults applied so it never crashes on a
// record that has no `journey` object.
function showJourneyTip(stage, tip, rec) {
  if (!tip || !rec) return;
  const j = journeyFor(rec);
  const assessed = journeyAssessed(rec);
  const stageLbl = JOURNEY_STAGE_LABELS[j.stage] || "—";
  const evLbl = JOURNEY_EVIDENCE_LABELS[j.evidence_quality] || "—";
  const milestone = j.next_milestone
    ? `<div class="ajt-row"><span class="ajt-k">next</span><span class="ajt-v">${escHtml(j.next_milestone)}</span></div>`
    : "";
  tip.innerHTML = `
    <div class="ajt-name">${escHtml(rec.name || rec.record_id)}</div>
    <div class="ajt-row"><span class="ajt-k">source</span><span class="ajt-v">${escHtml(assessed ? "explicit PMF read" : "missing journey data")}</span></div>
    <div class="ajt-row"><span class="ajt-k">stage</span><span class="ajt-v">${j.stage} · ${escHtml(stageLbl)}</span></div>
    <div class="ajt-row"><span class="ajt-k">evidence</span><span class="ajt-v">${j.evidence_quality} · ${escHtml(evLbl)}</span></div>
    <div class="ajt-row"><span class="ajt-k">bottleneck</span><span class="ajt-v">${escHtml(j.primary_bottleneck)}</span></div>
    ${milestone}
  `;
  tip.hidden = false;
}
function positionConstTip(stage, tip, e) {
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
            <span class="alch-edit-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg></span><span>edit my availability</span>
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

  // save-png: export the visible week as a mobile-optimized portrait PNG.
  const weekPngBtn = state.canvas.querySelector("[data-cal-png]");
  if (weekPngBtn) {
    weekPngBtn.addEventListener("click", () => {
      try { exportCalendarWeekPng({ data: cal.data, weekIdx: cal.weekIdx }); }
      catch (e) { console.warn("[calendar] png export failed", e); }
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
          <span class="alch-edit-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg></span>
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
  const authorSlug = myPerson?.record_id || "your-slug";
  return { people, me, askIdentity, myPerson, myHandle, authorSlug };
}

// ─── cohort collaboration board (ported from the dossier Connections) ─
// Standing seek↔offer matchmaking across teams, fed ENTIRELY from public
// self-asserted cohort-surface fields (dependencies / seeking / offering /
// skill_areas / pair_with). The dossier's private 'strength' + OSINT
// 'shared_papers' scores are NOT used — affinity is recomputed from shared
// skill_areas (+ self-declared pair_with), and intros from public
// seeking↔offering term overlap, shown as chips so every match is legible.
const COLLAB_INTAKE_DRAFT_LS_KEY = "srwk:collab_intake_draft_v1";
const COLLAB_LENSES = new Set(["all", "deps", "needs"]);
const COLLAB_TEAM_FILTERS = new Set(["all", "needs", "offers"]);
const COLLAB_SORTS = new Set(["cluster", "intro", "dependency"]);

function normalizeCollabControls() {
  if (!COLLAB_LENSES.has(state.collabLens)) state.collabLens = "all";
  if (!COLLAB_TEAM_FILTERS.has(state.collabTeamFilter)) state.collabTeamFilter = "all";
  if (!COLLAB_SORTS.has(state.collabSort)) state.collabSort = "cluster";
  if (state.collabTeamFilter !== "all" && state.collabLens !== "all") state.collabLens = "all";
}

function collabPairData(R, C, dep, so, af) {
  return {
    fromRid: R.rid,
    toRid: C.rid,
    fromName: R.team.name,
    toName: C.team.name,
    fromCluster: R.clusterLabel,
    toCluster: C.clusterLabel,
    dep: !!dep,
    seek: so ? {
      seeking: so.seeking,
      offering: so.offering,
      shared: so.shared || [],
      score: so.score || 0,
    } : null,
    affinity: af ? {
      shared: af.shared || [],
      endorsed: !!af.endorsed,
      score: af.score || 0,
    } : null,
  };
}

function collabPairFromIds(fromRid, toRid, m = collabCurrentModel()) {
  if (!fromRid || !toRid || fromRid === toRid) return null;
  const byRid = new Map((m?.ordered || []).map(o => [o.rid, o]));
  const R = byRid.get(fromRid);
  const C = byRid.get(toRid);
  if (!R || !C) return null;
  const dep = m.depByPair?.get(dependencyPairKey(R.rid, C.rid)) || m.deps?.has(dependencyPairKey(R.rid, C.rid));
  const so = m.soByPair.get(dependencyPairKey(R.rid, C.rid));
  const af = m.aff.get(collabAffKey(R.rid, C.rid));
  if (!dep && !so && !af) return null;
  return collabPairData(R, C, dep, so, af);
}

function collabVisibleOrder(m, filter = "all", sort = "cluster") {
  const teamHas = (o) => {
    if (filter === "needs") return collabHasText(o.team.seeking);
    if (filter === "offers") return collabHasText(o.team.offering);
    return true;
  };
  const kMap = new Map((m.keystones || []).map(k => [k.rid, k]));
  const intro = new Map();
  for (const s of m.seekOffer || []) {
    const add = (rid, score) => {
      const cur = intro.get(rid) || { count: 0, score: 0 };
      cur.count += 1;
      cur.score += score || 0;
      intro.set(rid, cur);
    };
    add(s.seeker, s.score);
    add(s.offerer, s.score);
  }
  const clusterCmp = (a, b) =>
    (a.clusterRank ?? 99) - (b.clusterRank ?? 99)
    || (m.indegree.get(b.rid) || 0) - (m.indegree.get(a.rid) || 0)
    || String(a.team.name || a.rid).localeCompare(String(b.team.name || b.rid));
  const depPressure = (o) => {
    const k = kMap.get(o.rid);
    return ((k?.inbound?.length || 0) * 2) + (k?.outbound?.length || 0);
  };
  const introPotential = (o) => intro.get(o.rid)?.score || 0;
  const out = (m.ordered || []).filter(teamHas);
  if (sort === "intro") {
    return out.sort((a, b) =>
      introPotential(b) - introPotential(a)
      || (intro.get(b.rid)?.count || 0) - (intro.get(a.rid)?.count || 0)
      || clusterCmp(a, b));
  }
  if (sort === "dependency") {
    return out.sort((a, b) =>
      depPressure(b) - depPressure(a)
      || (kMap.get(b.rid)?.inbound?.length || 0) - (kMap.get(a.rid)?.inbound?.length || 0)
      || clusterCmp(a, b));
  }
  return out.sort(clusterCmp);
}

function collabPeopleForTeam(rid) {
  return (state.cohort?.people || []).filter(p =>
    p.team === rid || (Array.isArray(p.secondary_teams) && p.secondary_teams.includes(rid))
  );
}

function collabCurrentModel() {
  const teams = (state.cohort?.teams || []).filter(t => t && t.record_id);
  return buildCollabModel(teams, state.cohort?.clusters || [], state.cohort?.dependencies || []);
}

function collabTeamByRecordId(rid, m = collabCurrentModel()) {
  return m?.byRecordId?.get(String(rid || "")) || null;
}

function collabTeamLinkItems(team) {
  const L = team?.links || {};
  const links = [];
  const seen = new Set();
  const add = (label, href, display = label) => {
    if (!href) return;
    const key = `${label}:${href}`;
    if (seen.has(key)) return;
    seen.add(key);
    links.push({ label, href, display });
  };
  const displayUrl = (v) => String(v || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (L.github) add("github", normalizeLinkHref("github", L.github), String(L.github).replace(/^https?:\/\/github\.com\//, ""));
  if (L.x) {
    const handle = String(L.x).replace(/^@/, "").replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//, "");
    add("x", normalizeLinkHref("x", handle), `@${handle}`);
  }
  if (L.website) add("website", normalizeLinkHref("website", L.website), displayUrl(L.website));
  if (L.repo) {
    const repo = String(L.repo).trim();
    const href = GH_REPO_RE.test(repo) ? `https://github.com/${repo}` : normalizeLinkHref("website", repo);
    add("repo", href, displayUrl(repo).replace(/^github\.com\//, ""));
  }
  if (L.demo) add("demo", normalizeLinkHref("demo", L.demo), displayUrl(L.demo));
  if (L.deck) add("deck", normalizeLinkHref("deck", L.deck), displayUrl(L.deck));
  if (L.slides) add("slides", normalizeLinkHref("slides", L.slides), displayUrl(L.slides));
  return links;
}

function collabTeamLinksSectionHtml(team) {
  const items = collabTeamLinkItems(team);
  if (!items.length) return "";
  return collabInspectorSection("links", `<div class="cb-link-row-inline">${items.map(item => `
    <a class="cb-link-inline" href="${escAttr(item.href)}" data-external title="${escAttr(item.display)}">${escHtml(item.label)}</a>
  `).join("")}</div>`, "is-links");
}

function collabTeamMini(team, role = "") {
  if (!team) return "";
  return `<button type="button" class="cb-inspector-team" data-collab-cohort-open="${escAttr(team.record_id)}" title="open ${escAttr(team.name || team.record_id)} profile">
    <span>${escHtml(team.name || team.record_id)}</span>
    ${role ? `<small>${escHtml(role)}</small>` : ""}
  </button>`;
}

function collabRouteRows(items) {
  const rows = (items || [])
    .filter(item => item && item.team)
    .map(item => `<button type="button" class="cb-route-row" data-collab-cohort-open="${escAttr(item.team.record_id)}" title="open ${escAttr(item.team.name || item.team.record_id)} profile">
      <span>
        <strong>${escHtml(item.team.name || item.team.record_id)}</strong>
        ${item.note ? `<small>${escHtml(item.note)}</small>` : ""}
      </span>
      ${item.badge ? `<em>${escHtml(item.badge)}</em>` : ""}
    </button>`)
    .join("");
  return rows ? `<div class="cb-route-list">${rows}</div>` : "";
}

function collabMembersHtml(rid) {
  const people = collabPeopleForTeam(rid);
  if (!people.length) return `<p class="cb-inspector-empty">no member records linked yet.</p>`;
  return `<div class="cb-inspector-members">${people.slice(0, 6).map(p => `
    <button type="button" class="cb-inspector-person" data-person="${escAttr(p.record_id)}" title="open ${escAttr(p.name || p.record_id)}">
      <span>${escHtml(p.name || p.record_id)}</span>
      ${p.role ? `<small>${escHtml(p.role)}</small>` : ""}
    </button>
  `).join("")}${people.length > 6 ? `<span class="cb-inspector-more">+${people.length - 6} more</span>` : ""}</div>`;
}

function collabTextList(values, empty = "not declared", max = 4) {
  const arr = (Array.isArray(values) ? values : [values]).map(v => String(v || "").trim()).filter(Boolean);
  if (!arr.length) return `<p class="cb-inspector-empty">${escHtml(empty)}</p>`;
  return `<ul class="cb-inspector-list">${arr.slice(0, max).map(v => `<li>${escHtml(v)}</li>`).join("")}${arr.length > max ? `<li class="is-more">+${arr.length - max} more</li>` : ""}</ul>`;
}

function collabInspectorSection(title, body, className = "") {
  return `<section class="cb-inspector-section${className ? ` ${escAttr(className)}` : ""}"><h4>${escHtml(title)}</h4>${body}</section>`;
}

function collabSignalHtml(team) {
  return collabInspectorSection("needs / offers", `
    <div class="cb-signal-grid">
      <div class="cb-signal-card">
        <span>seeking</span>
        ${collabTextList(team.seeking, "nothing declared", 3)}
      </div>
      <div class="cb-signal-card">
        <span>offering</span>
        ${collabTextList(team.offering, "nothing declared", 3)}
      </div>
    </div>
  `, "is-signal");
}

function collabNetworkHtml(groups) {
  const html = groups
    .filter(group => group && group.body)
    .map(group => `<details class="cb-network-group">
      <summary><span>${escHtml(group.label)}</span>${Number.isFinite(group.count) ? `<em>${group.count}</em>` : ""}</summary>
      <div class="cb-network-body">${group.body}</div>
    </details>`)
    .join("");
  return html ? collabInspectorSection("routes", `<div class="cb-network-grid">${html}</div>`, "is-network") : "";
}

function collabTeamMetaInlineHtml(team, memberCount) {
  const rows = [
    memberCount ? ["team", `${memberCount} ${memberCount === 1 ? "person" : "people"}`] : null,
    team.geo ? ["geo", team.geo] : null,
  ].filter(Boolean);
  if (!rows.length) return "";
  return `<div class="cb-team-meta-row">${rows.map(([label, value]) => `<span><em>${escHtml(label)}</em>${escHtml(value)}</span>`).join("")}</div>`;
}

function collabTeamRouteRailHtml({ outbound, inbound, getsHelpFrom, givesHelpTo }) {
  const needs = outbound.length + getsHelpFrom.length;
  const helps = inbound.length + givesHelpTo.length;
  return `<div class="cb-team-route-rail">
    <span>route balance</span>
    <p><strong>${needs}</strong> needs support · <strong>${helps}</strong> can support</p>
  </div>`;
}

function collabLegendHtml() {
  return `
    <div class="cb-legend" aria-label="collab board legend">
      <span tabindex="0" data-desc="This row team relies on the column team to do its work."><i class="cb-legend-mark dep"></i><b>dependency</b></span>
      <span tabindex="0" data-desc="The row team is seeking something the column team has offered."><i class="cb-legend-mark so"></i><b>seek / offer</b></span>
      <span tabindex="0" data-desc="How strong a seek/offer match is."><i class="cb-legend-mark so-scale"></i><b>match strength</b></span>
      <span tabindex="0" data-desc="A team many others depend on."><i class="cb-legend-mark key"></i><b>keystone</b></span>
    </div>`;
}

function collabInspectorPills(items) {
  const html = items
    .filter(item => item && item.label && item.value !== null && item.value !== undefined && item.value !== "")
    .map(item => `<span class="cb-inspector-pill"><strong>${escHtml(String(item.value))}</strong>${escHtml(item.label)}</span>`)
    .join("");
  return html ? `<div class="cb-inspector-pills">${html}</div>` : "";
}

function collabInspectorDefaultHtml(m) {
  const top = (m.keystones || []).slice(0, 3).map(k => collabTeamMini(k.team, `${k.inbound.length} inbound`)).join("");
  return `
    <div class="cb-inspector-hero">
      <div class="cb-inspector-identity">
        <div class="cb-inspector-kicker">collab context</div>
        <h4 class="cb-inspector-title">select a signal</h4>
        <p class="cb-inspector-copy">Click a row, column, cluster band, or cell to inspect who is involved, why the connection exists, and where to route next.</p>
      </div>
    </div>
    ${collabInspectorPills([
      { value: m.seekOffer.length, label: "seek/offers" },
      { value: m.deps.size, label: "dependencies" },
    ])}
    ${top ? collabInspectorSection("keystones", `<div class="cb-inspector-stack">${top}</div>`) : ""}
  `;
}

function collabJourneyCompactHtml(team) {
  const j = journeyFor(team);
  if (!j || j.stage <= 0) return "";
  const segs = [];
  for (let s = 1; s <= 8; s++) {
    const on = s <= j.stage ? " is-on" : "";
    const cur = s === j.stage ? " is-cur" : "";
    segs.push(`<i class="${on}${cur}" title="${escAttr(`${s} · ${JOURNEY_STAGE_LABELS[s] || ""}`)}"></i>`);
  }
  const dots = (val) => Array.from({ length: 5 }).map((_, i) => `<i class="${i < val ? "is-on" : ""}"></i>`).join("");
  return collabInspectorSection("pmf · journey", `
    <div class="cb-journey-mini">
      <div class="cb-journey-head"><strong>${escHtml(JOURNEY_STAGE_LABELS[j.stage] || "—")}</strong><span>stage ${j.stage} / 8</span></div>
      <div class="cb-journey-track">${segs.join("")}</div>
      <div class="cb-journey-meters">
        <span>evidence <em>${dots(j.evidence_quality)}</em></span>
        <span>upside <em>${dots(j.market_upside)}</em></span>
      </div>
    </div>
  `, "is-journey");
}

function collabCredentialsHtml(team) {
  const papers = Array.isArray(team.paper_basis) ? team.paper_basis : (team.paper_basis ? [team.paper_basis] : []);
  if (!papers.length) return "";
  return collabInspectorSection("credentials", `<ul class="cb-inspector-list">${papers.slice(0, 3).map(p => `<li>${escHtml(p)}</li>`).join("")}</ul>`, "is-cred");
}

function collabTeamInspectorHtml(rid, m = collabCurrentModel()) {
  const team = collabTeamByRecordId(rid, m);
  if (!team) return collabInspectorDefaultHtml(m);
  const row = m.ordered.find(o => o.rid === rid);
  const inbound = ((m.keystones || []).find(k => k.rid === rid)?.inbound || []).map(id => collabTeamByRecordId(id, m)).filter(Boolean);
  const outbound = ((m.keystones || []).find(k => k.rid === rid)?.outbound || []).map(id => collabTeamByRecordId(id, m)).filter(Boolean);
  const getsHelpFrom = m.seekOffer.filter(s => s.seeker === rid).slice(0, 3);
  const givesHelpTo = m.seekOffer.filter(s => s.offerer === rid).slice(0, 3);
  const meta = row?.clusterLabel || domainLabel(team.domain) || "team";
  const people = collabPeopleForTeam(rid);
  const memberCount = people.length || Number(team.members_count) || 0;

  return `
    <div class="cb-team-detail">
      <div class="cb-inspector-hero is-link is-team" data-collab-cohort-open="${escAttr(rid)}" role="link" tabindex="0" title="open ${escAttr(team.name || rid)} profile">
        <div class="cb-inspector-identity">
          <div class="cb-inspector-kicker">${escHtml(meta || "team")}</div>
          <h4 class="cb-inspector-title">${escHtml(team.name || rid)}</h4>
          ${team.focus ? `<p class="cb-inspector-copy">${escHtml(team.focus)}</p>` : ""}
          ${collabTeamMetaInlineHtml(team, memberCount)}
        </div>
      </div>
      ${collabTeamRouteRailHtml({ outbound, inbound, getsHelpFrom, givesHelpTo })}
      ${collabJourneyCompactHtml(team)}
      ${collabSignalHtml(team)}
      ${collabNetworkHtml([
        outbound.length ? { label: "depends on", count: outbound.length, body: collabRouteRows(outbound.slice(0, 4).map(t => ({ team: t, note: "declared dependency", badge: "needs" }))) } : null,
        inbound.length ? { label: "needed by", count: inbound.length, body: collabRouteRows(inbound.slice(0, 4).map(t => ({ team: t, note: "depends on this team", badge: "needed" }))) } : null,
        getsHelpFrom.length ? { label: "gets help from", count: getsHelpFrom.length, body: collabRouteRows(getsHelpFrom.map(s => ({ team: collabTeamByRecordId(s.offerer, m), note: s.shared.slice(0, 2).join(" · ") || "declared offer match", badge: "offers" }))) } : null,
        givesHelpTo.length ? { label: "gives help to", count: givesHelpTo.length, body: collabRouteRows(givesHelpTo.map(s => ({ team: collabTeamByRecordId(s.seeker, m), note: s.shared.slice(0, 2).join(" · ") || "declared ask match", badge: "seeks" }))) } : null,
      ])}
      ${collabInspectorSection("who to talk to", collabMembersHtml(rid), "is-members")}
      ${collabCredentialsHtml(team)}
      ${collabTeamLinksSectionHtml(team)}
    </div>
  `;
}

function collabConnRow(label, bodyHtml, sourceNote) {
  return `<div class="cb-evidence-row" title="${escAttr(sourceNote)}"><span>${escHtml(label)}</span><p>${bodyHtml}</p></div>`;
}

function collabPairTeamCard(team, name, role, signal) {
  const signalHtml = signal && signal.text
    ? `<span class="cb-pair-team-signal"><em>${escHtml(signal.label)}</em>${escHtml(signal.text)}</span>`
    : "";
  if (!team) {
    return `<div class="cb-pair-team is-empty"><span class="cb-pair-team-role">${escHtml(role)}</span><span class="cb-pair-team-name">${escHtml(name)}</span>${signalHtml}</div>`;
  }
  const meta = [domainLabel(team.domain), team.geo].filter(Boolean).join(" · ");
  return `<button type="button" class="cb-pair-team" data-collab-cohort-open="${escAttr(team.record_id)}" title="open ${escAttr(name)} profile">
    <span class="cb-pair-team-role">${escHtml(role)}</span>
    <span class="cb-pair-team-name">${escHtml(name)}</span>
    ${meta ? `<span class="cb-pair-team-meta">${escHtml(meta)}</span>` : ""}
    ${team.focus ? `<span class="cb-pair-team-focus">${escHtml(team.focus)}</span>` : ""}
    ${signalHtml}
  </button>`;
}

function collabRouteRead(pair, leftName, rightName) {
  const shared = [...new Set([...(pair?.seek?.shared || []), ...(pair?.affinity?.shared || [])])].slice(0, 3);
  const sharedText = shared.length ? ` around ${shared.join(", ")}` : "";
  if (pair?.dep && pair?.seek) {
    return { label: "unblock route", source: "Declared dependency plus seek/offer overlap.", body: `${leftName} already depends on ${rightName}; the matching offer makes this an unblock conversation${sharedText}.` };
  }
  if (pair?.seek) {
    return { label: "intro route", source: "Declared seeking matched against declared offering and skill areas.", body: `${leftName} is seeking something ${rightName} can provide${sharedText}; route this as a targeted intro.` };
  }
  if (pair?.dep) {
    return { label: "dependency route", source: "Declared dependency only.", body: `${leftName} depends on ${rightName}; route this as an unblock check before it becomes a hidden bottleneck.` };
  }
  if (pair?.affinity) {
    return { label: "shared-skill context", source: "Shared public skill areas.", body: `No explicit ask is declared yet, but both teams share collaboration surface${sharedText}.` };
  }
  return null;
}

function collabPairInspectorHtml(pair, m = collabCurrentModel()) {
  const left = collabTeamByRecordId(pair?.fromRid, m);
  const right = collabTeamByRecordId(pair?.toRid, m);
  const leftName = pair?.fromName || left?.name || "team A";
  const rightName = pair?.toName || right?.name || "team B";
  const sharedTerms = [...new Set([...(pair?.seek?.shared || []), ...(pair?.affinity?.shared || [])])].slice(0, 8);
  const directional = !!(pair?.dep || pair?.seek);
  const leftSignal = pair?.seek ? { label: "seeking", text: pair.seek.seeking || "not specified" } : null;
  const rightSignal = pair?.seek ? { label: "offering", text: pair.seek.offering || "not specified" } : null;
  const routeRead = collabRouteRead(pair, leftName, rightName);
  const rows = [];
  if (routeRead) rows.push(collabConnRow(routeRead.label, escHtml(routeRead.body), routeRead.source));
  if (pair?.dep) rows.push(collabConnRow("dependency", `${escHtml(leftName)} depends on ${escHtml(rightName)}.`, `From ${leftName}'s declared dependencies.`));
  if (pair?.affinity) {
    const body = sharedTerms.length
      ? `<div class="cb-inspector-chips">${sharedTerms.map(c => `<span class="cb-chip">${escHtml(c)}</span>`).join("")}</div>`
      : (pair.affinity.endorsed ? "Both teams named this as a pairing." : "Both list overlapping skill areas.");
    rows.push(collabConnRow("shared skills", body, "Skill areas both teams list publicly."));
  }
  return `
    <div class="cb-inspector-hero is-pair">
      <div class="cb-inspector-identity">
        <h4 class="cb-inspector-title">${escHtml(leftName)} ${directional ? "&rarr;" : "&harr;"} ${escHtml(rightName)}</h4>
      </div>
    </div>
    <section class="cb-inspector-section">
      <div class="cb-pair-teams">
        ${collabPairTeamCard(left, leftName, directional ? "needs help" : "shared focus", leftSignal)}
        <span class="cb-pair-arrow" aria-hidden="true">${directional ? "&rarr;" : "&harr;"}</span>
        ${collabPairTeamCard(right, rightName, directional ? "can help" : "shared focus", rightSignal)}
      </div>
    </section>
    ${rows.length ? `<section class="cb-inspector-section"><div class="cb-evidence-list">${rows.join("")}</div></section>` : ""}
  `;
}

function collabClusterSignalList(group, field) {
  const rows = group
    .map(o => ({ team: o.team, values: (Array.isArray(o.team?.[field]) ? o.team[field] : [o.team?.[field]]).map(v => String(v || "").trim()).filter(Boolean) }))
    .filter(o => o.values.length)
    .slice(0, 4);
  if (!rows.length) return `<p class="cb-inspector-empty">not declared</p>`;
  return `<div class="cb-cluster-signal-list">${rows.map(o => `
    <button type="button" class="cb-cluster-signal" data-collab-cohort-open="${escAttr(o.team.record_id)}">
      <span>${escHtml(o.team.name || o.team.record_id)}</span>
      <p>${escHtml(o.values[0])}</p>
    </button>
  `).join("")}</div>`;
}

function collabClusterSignalsHtml(group) {
  return collabInspectorSection("cluster signals", `
    <div class="cb-signal-grid cb-signal-grid-vertical">
      <div class="cb-signal-card">
        <span>needs</span>
        ${collabClusterSignalList(group, "seeking")}
      </div>
      <div class="cb-signal-card">
        <span>offers</span>
        ${collabClusterSignalList(group, "offering")}
      </div>
    </div>
  `, "is-signal");
}

function collabClusterInspectorHtml(clusterId, m = collabCurrentModel()) {
  const group = m.ordered.filter(o => o.clusterId === clusterId);
  if (!group.length) return collabInspectorDefaultHtml(m);
  const label = group[0].clusterLabel;
  const groupIds = new Set(group.map(o => o.rid));
  const teams = group.slice(0, 8).map(o => collabTeamMini(o.team, `${(o.team.skill_areas || []).slice(0, 2).join(" · ") || domainLabel(o.team.domain)}`)).join("");
  const needCount = group.filter(o => collabHasText(o.team.seeking)).length;
  const offerCount = group.filter(o => collabHasText(o.team.offering)).length;
  const deps = [...m.deps].filter(edge => group.some(o => edge.startsWith(o.rid + ">") || edge.endsWith(">" + o.rid))).length;
  const intros = m.seekOffer
    .filter(s => groupIds.has(s.seeker) || groupIds.has(s.offerer))
    .slice(0, 3)
    .map(s => `<div class="cb-evidence-row">
      <span>${groupIds.has(s.seeker) ? "needs route" : "can help"}</span>
      <p><strong>${escHtml(s.seekerName)}</strong> to <strong>${escHtml(s.offererName)}</strong><br/>${escHtml((s.shared || []).slice(0, 3).join(" · ") || "declared seek/offer overlap")}</p>
    </div>`)
    .join("");
  return `
    <div class="cb-inspector-hero">
      <div class="cb-inspector-identity">
        <div class="cb-inspector-kicker">cluster</div>
        <h4 class="cb-inspector-title">${escHtml(label)}</h4>
        <p class="cb-inspector-copy">A working group inferred from public focus, skills, needs, and offers.</p>
      </div>
    </div>
    ${collabInspectorPills([
      { value: group.length, label: "teams" },
      { value: needCount, label: "with needs" },
      { value: offerCount, label: "with offers" },
      { value: deps, label: "edges" },
    ])}
    ${collabInspectorSection("teams", `<div class="cb-inspector-stack">${teams}</div>`)}
    ${collabClusterSignalsHtml(group)}
    ${intros ? collabInspectorSection("top routes", `<div class="cb-evidence-list">${intros}</div>`, "is-evidence") : ""}
  `;
}

function collabSameSelection(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (a.type === "team") return a.rid === b.rid;
  if (a.type === "cluster") return a.id === b.id;
  if (a.type === "pair") return a.fromRid === b.fromRid && a.toRid === b.toRid;
  return false;
}

function collabSelectionVisible(selection, ordered, m) {
  if (!selection || !selection.type) return null;
  const visible = new Set((ordered || []).map(o => o.rid));
  if (selection.type === "team") {
    const rid = String(selection.rid || "");
    return visible.has(rid) ? { type: "team", rid } : null;
  }
  if (selection.type === "cluster") {
    const id = String(selection.id || "");
    return ordered.some(o => o.clusterId === id) ? { type: "cluster", id } : null;
  }
  if (selection.type === "pair") {
    const fromRid = String(selection.fromRid || "");
    const toRid = String(selection.toRid || "");
    if (!visible.has(fromRid) || !visible.has(toRid)) return null;
    const pair = collabPairFromIds(fromRid, toRid, m);
    if (!pair) return null;
    const lens = COLLAB_LENSES.has(state.collabLens) ? state.collabLens : "all";
    if (lens === "deps" && !pair.dep) return null;
    if (lens === "needs" && !pair.seek) return null;
    return { type: "pair", fromRid, toRid };
  }
  return null;
}

function collabCurrentVisibleOrder(m = collabCurrentModel()) {
  normalizeCollabControls();
  return collabVisibleOrder(m, state.collabTeamFilter || "all", state.collabSort || "cluster");
}

function collabInspectorHtmlForSelection(selection, m = collabCurrentModel()) {
  if (!selection) return collabInspectorDefaultHtml(m);
  if (selection.type === "team") return collabTeamInspectorHtml(selection.rid, m);
  if (selection.type === "cluster") return collabClusterInspectorHtml(selection.id, m);
  if (selection.type === "pair") {
    const pair = collabPairFromIds(selection.fromRid, selection.toRid, m);
    return pair ? collabPairInspectorHtml(pair, m) : collabInspectorDefaultHtml(m);
  }
  return collabInspectorDefaultHtml(m);
}

function collabIntakeDraft() {
  try {
    const raw = localStorage.getItem(COLLAB_INTAKE_DRAFT_LS_KEY);
    return raw ? JSON.parse(raw) || {} : {};
  } catch {
    return {};
  }
}

function saveCollabIntakeDraft(values) {
  try { localStorage.setItem(COLLAB_INTAKE_DRAFT_LS_KEY, JSON.stringify(values || {})); } catch {}
}

function clearCollabIntakeDraft() {
  try { localStorage.removeItem(COLLAB_INTAKE_DRAFT_LS_KEY); } catch {}
}

function collabIntakeList(raw) {
  return String(raw || "")
    .split(/\n|;/)
    .map(s => s.trim().replace(/^[-*]\s*/, ""))
    .filter(Boolean);
}

function collabIntakeDateValue(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function collabIntakeControl(form, name) {
  return form?.elements?.namedItem?.(name) || form?.querySelector?.(`[name="${cssAttr(name)}"]`) || null;
}

function collabIntakeFormValues(form) {
  return {
    teamRid: String(collabIntakeControl(form, "team")?.value || "").trim(),
    teamOther: String(collabIntakeControl(form, "team_other")?.value || "").trim(),
    seeking: String(collabIntakeControl(form, "seeking")?.value || "").trim(),
    offering: String(collabIntakeControl(form, "offering")?.value || "").trim(),
    timing: collabIntakeDateValue(collabIntakeControl(form, "timing")?.value || ""),
    contact: String(collabIntakeControl(form, "contact")?.value || "").trim(),
  };
}

function collabIntakeMarkdown(fields, { authorSlug, todayIso, team }) {
  const teamLabel = team?.name || fields.teamOther || fields.teamRid || "unlisted team";
  const teamLine = team
    ? `${teamLabel} (${team.record_id})`
    : `${teamLabel}${fields.teamRid ? ` (${fields.teamRid})` : ""}`;
  const recordId = `${authorSlug}-${todayIso}-collab-${hashStr([teamLine, fields.seeking, fields.offering].join("|")).toString(36).replace("-", "").slice(0, 5)}`;
  const topic = `collab board update - ${teamLabel}`;
  const skillsBlock = "skill_areas: []";
  return {
    recordId,
    markdown: `---
record_id: ${recordId}
record_type: ask
schema_version: 1
posted_at: ${todayIso}
author: ${quoteYaml(authorSlug)}
verb: ${quoteYaml("update collab board")}
topic: ${yamlScalar(topic, 2)}
${skillsBlock}
status: open
---
## Collab board update

team: ${teamLine}
timing: ${fields.timing || "not specified"}

### seeking
${fields.seeking || "not specified"}

### offering
${fields.offering || "not specified"}

### routing / contact
${fields.contact || "not specified"}
`,
  };
}

function openCollabIntakeModal() {
  const existing = document.querySelector("[data-collab-intake-modal]");
  if (existing) {
    existing.querySelector("[name='seeking'], [name='team']")?.focus?.();
    return;
  }
  const m = collabCurrentModel();
  const teams = (m.ordered || [])
    .map(o => o.team)
    .filter(t => t && t.record_id)
    .slice()
    .sort((a, b) => String(a.name || a.record_id).localeCompare(String(b.name || b.record_id)));
  const draft = collabIntakeDraft();
  const selectedRid = draft.teamRid || (state.collabSelection?.type === "team" ? state.collabSelection.rid : "");
  const teamOptions = [
    `<option value=""${selectedRid ? "" : " selected"}>select company / project</option>`,
    ...teams.map(team => `<option value="${escAttr(team.record_id)}"${team.record_id === selectedRid ? " selected" : ""}>${escHtml(team.name || team.record_id)}</option>`),
  ].join("");
  const overlay = document.createElement("div");
  overlay.className = "cb-intake-backdrop";
  overlay.dataset.collabIntakeModal = "1";
  overlay.innerHTML = `
    <form class="cb-intake-modal" data-collab-intake-form autocomplete="off">
      <header class="cb-intake-head">
        <div>
          <p class="cb-intake-kicker">collab board intake</p>
          <h3 class="cb-intake-title">add seek / offer</h3>
        </div>
        <button class="cb-intake-close" type="button" data-collab-intake-close aria-label="close">×</button>
      </header>
      <div class="cb-intake-grid">
        <label class="cb-intake-field">
          <span>which company?</span>
          <select name="team" class="cb-intake-input">${teamOptions}</select>
        </label>
        <label class="cb-intake-field">
          <span>if not listed</span>
          <input name="team_other" class="cb-intake-input" value="${escAttr(draft.teamOther || "")}" placeholder="company / project name" />
        </label>
        <label class="cb-intake-field is-wide">
          <span>what are you seeking?</span>
          <textarea name="seeking" rows="3" class="cb-intake-input" placeholder="customer intros, TEE review, design partner, infra unblock...">${escHtml(draft.seeking || "")}</textarea>
        </label>
        <label class="cb-intake-field is-wide">
          <span>what can you offer?</span>
          <textarea name="offering" rows="3" class="cb-intake-input" placeholder="audit time, dataset access, wallet UX feedback, dstack deployment help...">${escHtml(draft.offering || "")}</textarea>
        </label>
        <label class="cb-intake-field cb-intake-date-field">
          <span>target date</span>
          <input type="date" name="timing" class="cb-intake-input cb-intake-date-input" value="${escAttr(collabIntakeDateValue(draft.timing))}" />
        </label>
        <label class="cb-intake-field is-wide">
          <span>routing / contact</span>
          <input name="contact" class="cb-intake-input" value="${escAttr(draft.contact || "")}" placeholder="@handle, matrix room, or who should make the intro" />
        </label>
      </div>
      <footer class="cb-intake-foot">
        <button class="cb-intake-submit" type="submit">submit update</button>
        <button class="cb-intake-secondary" type="button" data-collab-intake-clear>clear draft</button>
        <p class="cb-intake-note">reviewable board update</p>
      </footer>
      <div class="cb-intake-result" data-collab-intake-result hidden></div>
    </form>
  `;
  const close = () => {
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector("[data-collab-intake-close]")?.addEventListener("click", close);
  const form = overlay.querySelector("[data-collab-intake-form]");
  form?.addEventListener("input", () => saveCollabIntakeDraft(collabIntakeFormValues(form)));
  form?.addEventListener("change", () => saveCollabIntakeDraft(collabIntakeFormValues(form)));
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitCollabIntake(form);
  });
  overlay.querySelector("[data-collab-intake-clear]")?.addEventListener("click", () => {
    clearCollabIntakeDraft();
    close();
    openCollabIntakeModal();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  requestAnimationFrame(() => collabIntakeControl(form, "team")?.focus?.());
}

async function submitCollabIntake(form) {
  const result = form?.querySelector("[data-collab-intake-result]");
  if (!form || !result) return;
  const fields = collabIntakeFormValues(form);
  const team = fields.teamRid ? collabTeamByRecordId(fields.teamRid) : null;
  const teamLabel = team?.name || fields.teamOther || fields.teamRid;
  if (!teamLabel) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<span class="alch-onb-inline-tag">missing</span> choose a company or type one in.`;
    return;
  }
  if (!fields.seeking && !fields.offering) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<span class="alch-onb-inline-tag">missing</span> add a seek or an offer.`;
    return;
  }
  saveCollabIntakeDraft(fields);
  const { authorSlug } = currentAskContext();
  const todayIso = new Date().toISOString().slice(0, 10);
  const { recordId, markdown } = collabIntakeMarkdown(fields, { authorSlug, todayIso, team });
  const filename = `cohort-data/asks/${recordId}.md`;
  result.hidden = false;
  result.dataset.kind = "info";
  result.innerHTML = `<span class="alch-onb-inline-tag">preparing</span> building collab-board update...`;
  const launched = await launchPRFlow({ kind: "new", path: filename, value: markdown });
  if (!launched.ok) {
    result.dataset.kind = "error";
    result.innerHTML = `
      <p class="alch-onb-inline-line"><span class="alch-onb-inline-tag">fork first</span> create your fork, then click submit again. this draft is saved locally.</p>
      <details class="alch-asks-compose-preview">
        <summary>preview update</summary>
        <pre class="alch-onb-inline-patch">${escHtml(markdown)}</pre>
      </details>
    `;
    return;
  }
  result.dataset.kind = "success";
  result.innerHTML = `
    <p class="alch-onb-inline-line"><span class="alch-onb-inline-tag">github ready</span> review the prefilled update, commit the new file, then open the PR.</p>
    <details class="alch-asks-compose-preview" open>
      <summary>preview update</summary>
      <pre class="alch-onb-inline-patch">${escHtml(markdown)}</pre>
    </details>
    <div class="alch-onb-inline-row">
      <a class="alch-onb-inline-link" href="${escAttr(launched.url)}" data-external>open github editor</a>
    </div>
  `;
  wireExternalLinks(result);
}

function cssAttr(value) {
  const raw = String(value || "");
  if (globalThis.CSS && typeof CSS.escape === "function") return CSS.escape(raw);
  return raw.replace(/["\\]/g, "\\$&");
}

function syncCollabSelectionDom() {
  const root = state.canvas?.querySelector(".alch-collab");
  if (!root) return;
  root.querySelectorAll(".is-selected").forEach(n => n.classList.remove("is-selected"));
  const selection = state.collabSelection;
  if (!selection) return;
  if (selection.type === "team") {
    root.querySelectorAll(`.cb-grid [data-collab-open="${cssAttr(selection.rid)}"]`).forEach(n => n.classList.add("is-selected"));
  } else if (selection.type === "cluster") {
    root.querySelectorAll(`[data-collab-cluster="${cssAttr(selection.id)}"]`).forEach(n => n.classList.add("is-selected"));
  } else if (selection.type === "pair") {
    root.querySelectorAll(`[data-collab-pair-from="${cssAttr(selection.fromRid)}"][data-collab-pair-to="${cssAttr(selection.toRid)}"]`).forEach(n => n.classList.add("is-selected"));
  }
}

function setCollabInspectorHtml(html) {
  const panel = state.canvas.querySelector("[data-collab-inspector]");
  if (!panel) return;
  panel.innerHTML = html;
  wireCollabCohortLinks(panel);
  wirePersonLinks(panel);
  wireExternalLinks(panel);
}

function setCollabSelection(selection) {
  const m = collabCurrentModel();
  const visibleSelection = collabSelectionVisible(selection, collabCurrentVisibleOrder(m), m);
  state.collabSelection = visibleSelection;
  syncCollabSelectionDom();
  setCollabInspectorHtml(collabInspectorHtmlForSelection(visibleSelection, m));
}

function clearCollabSelection() {
  state.collabSelection = null;
  syncCollabSelectionDom();
  setCollabInspectorHtml(collabInspectorDefaultHtml(collabCurrentModel()));
}

function previewCollabInspector(selection) {
  if (state.collabSelection) return;
  const m = collabCurrentModel();
  const visibleSelection = collabSelectionVisible(selection, collabCurrentVisibleOrder(m), m);
  setCollabInspectorHtml(collabInspectorHtmlForSelection(visibleSelection, m));
}

function collabCell(R, C, ri, ci, m, lens = "all", detail = false, selected = null) {
  if (R.rid === C.rid) return `<div class="cb-cell cb-diag" data-row="${ri}" data-col="${ci}" aria-hidden="true"></div>`;
  const dep = m.depByPair?.get(dependencyPairKey(R.rid, C.rid));
  const so = m.soByPair.get(dependencyPairKey(R.rid, C.rid));
  if (!dep && !so) return `<div class="cb-cell" data-row="${ri}" data-col="${ci}"></div>`;

  let cls = "cb-cell";
  if (so) cls += " has-so s" + Math.min(4, Math.ceil(so.score));
  if (dep) cls += " has-dep";

  const lines = [];
  if (dep) lines.push(`depends on ${C.team.name}`);
  if (so) lines.push(`seeks -> ${C.team.name} offers: ${so.shared.slice(0, 3).join(", ") || "match"}`);
  const title = `${R.team.name} -> ${C.team.name}\n${lines.join("\n")}`;

  const active = lens === "all" || (lens === "deps" && dep) || (lens === "needs" && so);
  if (!active) cls += " is-muted";
  if (detail && collabSameSelection(selected, { type: "pair", fromRid: R.rid, toRid: C.rid })) cls += " is-selected";

  const actionAttr = detail
    ? (active ? `data-collab-pair-from="${escAttr(R.rid)}" data-collab-pair-to="${escAttr(C.rid)}"` : `disabled aria-disabled="true"`)
    : `data-collab-open="${escAttr(C.rid)}"`;
  return `<button type="button" class="${cls}" data-row="${ri}" data-col="${ci}" ${actionAttr} title="${escAttr(title)}"><span class="cb-mark" aria-hidden="true"></span></button>`;
}

function collabGroupBand(ordered, colN, selected = null) {
  const segs = [];
  for (const o of ordered) {
    const last = segs[segs.length - 1];
    if (last && last.id === o.clusterId) last.span += 1;
    else segs.push({ id: o.clusterId, label: o.clusterLabel, span: 1 });
  }
  const cells = segs.map((s) => `
    <button type="button" class="cb-band-seg${collabSameSelection(selected, { type: "cluster", id: s.id }) ? " is-selected" : ""}" data-collab-cluster="${escAttr(s.id)}" style="grid-column: span ${s.span};" title="${escAttr(`${s.label} · ${s.span} teams · click for context`)}">
      <span>${escHtml(s.label)}</span>
    </button>
  `).join("");
  return `<div class="cb-row cb-bandrow" style="${colN}"><div class="cb-band-corner" aria-hidden="true"></div>${cells}</div>`;
}

function renderCollab() {
  const teams = (state.cohort?.teams || []).filter(t => t && t.record_id);
  const clusters = state.cohort?.clusters || [];
  if (!teams.length) {
    state.canvas.innerHTML = `
      <div class="alch-collab">
        ${constellationModeNavHtml("collab")}
        <header class="alch-cb-head"><h2 class="alch-cb-title">collaboration board</h2></header>
        <p class="alch-callout">no team data yet.</p>
      </div>`;
    return;
  }
  const m = buildCollabModel(teams, clusters, state.cohort?.dependencies || []);
  normalizeCollabControls();
  const teamFilter = state.collabTeamFilter || "all";
  const sort = state.collabSort || "cluster";
  const ordered = collabVisibleOrder(m, teamFilter, sort);
  const N = ordered.length;
  const totalN = m.ordered.length;
  const lens = state.collabLens || "all";
  const selected = collabSelectionVisible(state.collabSelection, ordered, m);
  if (state.collabSelection && !selected) state.collabSelection = null;
  const colN = `--cb-cols:${N}`;
  const byId = new Map(m.ordered.map(o => [o.rid, o.team]));
  const openAttrs = (rid) => `data-collab-open="${escAttr(rid)}" role="button" tabindex="0"`;
  const lensButton = (key, label, count) => `
    <button class="cb-lens" type="button" data-collab-lens="${escAttr(key)}" aria-pressed="${teamFilter === "all" && lens === key ? "true" : "false"}">
      <span>${escHtml(label)}</span><strong>${escHtml(String(count))}</strong>
    </button>`;
  const sortOption =(key, label) => `<option value="${escAttr(key)}" ${sort === key ? "selected" : ""}>${escHtml(label)}</option>`;
  const controlBar = `
    <div class="cb-controls">
      <div class="cb-lenses" role="group" aria-label="collaboration board lens and filters">
        ${lensButton("all", "all signals", m.deps.size + m.seekOffer.length)}
        ${lensButton("deps", "dependencies", m.deps.size)}
        ${lensButton("needs", "seek / offer", m.seekOffer.length)}
      </div>
      <div class="cb-control-actions">
        <button class="cb-intake-open" type="button" data-collab-intake-open>
          <span class="cb-intake-open-mark" aria-hidden="true">+</span>
          <span>add seek / offer</span>
        </button>
        <label class="cb-sort-control">
          <span>sort by</span>
          <select data-collab-sort aria-label="sort collab board rows">
            ${sortOption("cluster", "cluster")}
            ${sortOption("intro", "intro potential")}
            ${sortOption("dependency", "dependency pressure")}
          </select>
        </label>
      </div>
    </div>`;

  // The standalone keystones section was removed: it rendered as a lone
  // left-aligned panel (empty right half) and duplicated the keystones already
  // shown in the matrix's default "select a signal" inspector.

  // Teams with no declared matrix signal (no dependency, no seek/offer) render
  // as an all-empty row/column that reads as "broken". Dim those headers so the
  // populated teams lead and the empty ones quietly recede (no reorder, so the
  // cluster bands stay contiguous).
  const matrixActive = new Set();
  for (const e of m.deps) { const i = e.indexOf(">"); matrixActive.add(e.slice(0, i)); matrixActive.add(e.slice(i + 1)); }
  for (const s of m.seekOffer) { matrixActive.add(s.seeker); matrixActive.add(s.offerer); }
  const quietCls = (rid) => (!matrixActive.has(rid) ? " is-quiet" : "");

  // header row (offerers across the top)
  let headCells = `<div class="cb-corner" aria-hidden="true">needs ↓ · provides →</div>`;
  ordered.forEach((o, ci) => {
    const deg = m.indegree.get(o.rid) || 0;
    const selectedCls = collabSameSelection(selected, { type: "team", rid: o.rid }) ? " is-selected" : "";
    headCells += `<button type="button" class="cb-colhead${deg >= 5 ? " is-key" : ""}${selectedCls}${quietCls(o.rid)}" data-col="${ci}" data-collab-open="${escAttr(o.rid)}" title="${escAttr(o.team.name + " — " + deg + " inbound relationships")}"><span>${escHtml(o.team.name)}</span></button>`;
  });
  let rows = `<div class="cb-row cb-headrow" style="${colN}">${headCells}</div>`;
  if (sort === "cluster") rows += collabGroupBand(ordered, colN, selected);
  ordered.forEach((R, ri) => {
    const selectedCls = collabSameSelection(selected, { type: "team", rid: R.rid }) ? " is-selected" : "";
    let line = `<button type="button" class="cb-rowhead${selectedCls}${quietCls(R.rid)}" data-row="${ri}" data-collab-open="${escAttr(R.rid)}" title="${escAttr(R.team.name + " · " + R.clusterLabel)}"><span class="cb-rowhead-name">${escHtml(R.team.name)}</span><span class="cb-rowhead-grp">${escHtml(R.clusterLabel)}</span></button>`;
    ordered.forEach((C, ci) => { line += collabCell(R, C, ri, ci, m, lens, true, selected); });
    rows += `<div class="cb-row" style="${colN}">${line}</div>`;
  });
  const inspectorHtml = selected ? collabInspectorHtmlForSelection(selected, m) : collabInspectorDefaultHtml(m);
  const inspector = `<aside class="cb-inspector" data-collab-inspector aria-live="polite">${inspectorHtml}</aside>`;
  const matrixBody = `<div class="cb-grid-wrap" tabindex="0"><div class="cb-grid" data-lens="${escAttr(lens)}">${rows}</div></div><div class="cb-matrix-side"><div class="cb-matrix-key">${collabLegendHtml()}</div>${inspector}</div>`;
  const matrix = `
    <section class="alch-cb-section cb-matrix-section">
      <div class="alch-cb-sechead"><h3>Adjacency matrix</h3>
        <div class="cb-legend">
          <span><i class="cb-sw dep"></i>declared link</span>
          <span><i class="cb-sw so"></i>seeks → offers</span>
          <span><i class="cb-sw aff"></i>shared skill area</span>
          <span><i class="cb-sw key"></i>keystone column</span>
        </div>
      </div>
      <div class="cb-scroll">${matrixBody}</div>
      <p class="cb-hint">hover a name to preview · click a cell or team for detail</p>
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
    return `<article class="cb-intro" data-collab-cohort-open="${escAttr(s.offerer)}" role="link" tabindex="0" title="${escAttr(`open ${s.offererName || s.offerer} profile`)}">
      <div class="cb-intro-flow">
        <div class="cb-intro-side"><span class="cb-intro-role">needs</span><span class="cb-intro-team">${escHtml(s.seekerName)}</span>${s.seeking ? `<span class="cb-intro-text">${escHtml(s.seeking)}</span>` : ""}</div>
        <div class="cb-intro-arrow" aria-hidden="true">→</div>
        <div class="cb-intro-side"><span class="cb-intro-role">provides</span><span class="cb-intro-team">${escHtml(s.offererName)}</span>${s.offering ? `<span class="cb-intro-text">${escHtml(s.offering)}</span>` : ""}</div>
      </div>${chips ? `<div class="cb-intro-chips">${chips}</div>` : ""}
    </article>`;
  }).join("");
  const introSection = `
    <section class="alch-cb-section">
      <div class="alch-cb-sechead"><h3>Intros to make</h3><span class="cb-sub">strongest seek ↔ offer overlaps — the conversations to schedule</span></div>
      <div class="cb-intro-grid">${introCards || '<p class="cb-empty">no overlaps found.</p>'}</div>
    </section>`;

  // underused offers — declared help with the lowest routed demand
  const underused = (m.underusedOffers || []).slice(0, 12);
  const underusedCards = underused.map(item => {
    const chips = item.skills.slice(0, 5).map(c => `<span class="cb-chip">${escHtml(c)}</span>`).join("");
    const matchLabel = item.matchCount === 1 ? "1 matched ask" : `${item.matchCount} matched asks`;
    const teamMeta = [domainLabel(item.team?.domain), item.team?.geo].filter(Boolean).join(" · ");
    return `<article class="cb-intro cb-underused-offer" data-collab-cohort-open="${escAttr(item.rid)}" role="link" tabindex="0" title="${escAttr(`open ${item.teamName} profile`)}">
      <div class="cb-intro-flow cb-underused-flow">
        <div class="cb-intro-side">
          <span class="cb-intro-role">available offer</span>
          <span class="cb-intro-team">${escHtml(item.teamName)}</span>
          ${teamMeta ? `<span class="cb-intro-meta">${escHtml(teamMeta)}</span>` : ""}
          ${item.offering ? `<span class="cb-intro-text">${escHtml(item.offering)}</span>` : ""}
        </div>
        <span class="cb-underused-count">${escHtml(matchLabel)}</span>
      </div>${chips ? `<div class="cb-intro-chips">${chips}</div>` : ""}
    </article>`;
  }).join("");
  const underusedSection = `
    <section class="alch-cb-section">
      <div class="alch-cb-sechead"><h3>Underused offers</h3><span class="cb-sub">declared help with the lowest matched demand — useful supply to route better</span></div>
      <div class="cb-intro-grid">${underusedCards || '<p class="cb-empty">no underused offers found.</p>'}</div>
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
      <div class="alch-cb-sechead"><h3>Convergence</h3><span class="cb-sub">skill areas shared by 3+ teams — where the cohort concentrates</span></div>
      <div class="cb-cv-list">${convRows || '<p class="cb-empty">no shared areas.</p>'}</div>
    </section>`;

  state.canvas.innerHTML = `
    <div class="alch-collab">
      ${constellationModeNavHtml("collab")}
      <header class="alch-cb-head">
        <h2 class="alch-cb-title">collaboration board</h2>
        <p class="alch-cb-sub">who is explicitly linked, who can unblock whom, where the cohort over-concentrates — all from teams' own declared relationships, seeking, offering &amp; skill areas.</p>
        <div class="alch-cb-stats">
          <span><strong>${m.deps.size}</strong> relationships</span>
          <span><strong>${m.seekOffer.length}</strong> seek ↔ offer overlaps</span>
          <span><strong>${m.aff.size}</strong> shared affinities</span>
          <span><strong>${m.convergence.length}</strong> convergence areas</span>
        </div>
      </header>
      ${matrix}
      ${introSection}
      ${underusedSection}
      ${convSection}
      <p class="alch-callout"><strong>collaboration board · v0.1</strong><br/>Self-asserted only — affinities are shared <code>skill_areas</code>, intros are <code>seeking</code>↔<code>offering</code> term overlaps. No inferred or private scoring.</p>
    </div>`;
}

function wireCollabCohortLinks(root) {
  if (!root) return;
  for (const el of root.querySelectorAll("[data-collab-cohort-open]")) {
    if (el.dataset.collabCohortWired === "1") continue;
    el.dataset.collabCohortWired = "1";
    const activate = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const rid = el.getAttribute("data-collab-cohort-open");
      if (!rid) return;
      const cohortIndex = buildCohortIndex(state.cohort);
      if (cohortIndex.teamById.has(rid) || cohortIndex.personById.has(rid)) {
        openDetail(rid);
        return;
      }
      try { window.api?.openExternal?.(cohortRecordUrl(rid)); } catch {}
    };
    el.addEventListener("click", activate);
    if (el.tagName !== "BUTTON" && el.tagName !== "A") {
      if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
      if (!el.hasAttribute("role")) el.setAttribute("role", "link");
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") activate(event);
      });
    }
  }
}

function wireCollab() {
  const collabRoot = state.canvas.querySelector(".alch-collab");
  wireCollabCohortLinks(state.canvas);
  for (const btn of state.canvas.querySelectorAll("[data-collab-intake-open]")) {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      try {
        openCollabIntakeModal();
      } catch (error) {
        console.error("[collab-intake] failed to open:", error);
        setCollabInspectorHtml(`
          <div class="cb-inspector-hero">
            <div class="cb-inspector-identity">
              <div class="cb-inspector-kicker">collab intake</div>
              <h4 class="cb-inspector-title">intake failed</h4>
              <p class="cb-inspector-copy">${escHtml(error?.message || String(error))}</p>
            </div>
          </div>
        `);
      }
    });
  }
  for (const btn of state.canvas.querySelectorAll("[data-collab-lens]")) {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-collab-lens") || "all";
      if (next === state.collabLens && state.collabTeamFilter === "all") return;
      state.collabLens = next;
      state.collabTeamFilter = "all";
      render({ instant: true });
    });
  }
  for (const btn of state.canvas.querySelectorAll("[data-collab-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-collab-filter") || "all";
      state.collabTeamFilter = state.collabTeamFilter === next ? "all" : next;
      state.collabLens = "all";
      render({ instant: true });
    });
  }
  for (const sel of state.canvas.querySelectorAll("[data-collab-sort]")) {
    sel.addEventListener("change", () => {
      const next = sel.value || "cluster";
      if (next === state.collabSort) return;
      state.collabSort = next;
      render({ instant: true });
    });
  }
  for (const el of state.canvas.querySelectorAll("[data-collab-pair-from][data-collab-pair-to]")) {
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      const next = {
        type: "pair",
        fromRid: el.getAttribute("data-collab-pair-from") || "",
        toRid: el.getAttribute("data-collab-pair-to") || "",
      };
      if (collabSameSelection(state.collabSelection, next)) clearCollabSelection();
      else setCollabSelection(next);
    });
  }
  for (const el of state.canvas.querySelectorAll("[data-collab-cluster]")) {
    el.addEventListener("mouseenter", () => {
      previewCollabInspector({ type: "cluster", id: el.getAttribute("data-collab-cluster") || "" });
    });
    el.addEventListener("mouseleave", () => {
      if (!state.collabSelection) setCollabInspectorHtml(collabInspectorDefaultHtml(collabCurrentModel()));
    });
    el.addEventListener("focus", () => {
      previewCollabInspector({ type: "cluster", id: el.getAttribute("data-collab-cluster") || "" });
    });
    el.addEventListener("blur", () => {
      if (!state.collabSelection) setCollabInspectorHtml(collabInspectorDefaultHtml(collabCurrentModel()));
    });
    el.addEventListener("click", (event) => {
      event.stopPropagation();
      const next = { type: "cluster", id: el.getAttribute("data-collab-cluster") || "" };
      if (collabSameSelection(state.collabSelection, next)) clearCollabSelection();
      else setCollabSelection(next);
    });
  }
  // Hover a row/column header → preview that team's full (curated) inspector in
  // the side panel, so company details are readable without clicking in. Reuses
  // the team inspector; reverts to default on leave when nothing is pinned.
  for (const el of state.canvas.querySelectorAll(".cb-colhead, .cb-rowhead")) {
    const rid = el.getAttribute("data-collab-open");
    if (!rid) continue;
    el.addEventListener("mouseenter", () => previewCollabInspector({ type: "team", rid }));
    el.addEventListener("mouseleave", () => {
      if (!state.collabSelection) setCollabInspectorHtml(collabInspectorDefaultHtml(collabCurrentModel()));
    });
  }
  for (const el of state.canvas.querySelectorAll("[data-collab-open]")) {
    const activate = (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      const rid = el.getAttribute("data-collab-open");
      if (!rid) return;
      if (collabRoot) {
        const next = { type: "team", rid };
        if (collabSameSelection(state.collabSelection, next)) clearCollabSelection();
        else setCollabSelection(next);
      } else {
        openDrawer(rid);
      }
    };
    el.addEventListener("click", activate);
    if (el.tagName !== "BUTTON" && el.tagName !== "A") {
      if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
      if (!el.hasAttribute("role")) el.setAttribute("role", "button");
      el.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") activate(event);
      });
    }
  }
  const grid = state.canvas.querySelector(".cb-grid");
  if (!grid) return;
  let activeRow = null;
  let activeCol = null;
  const clearHL = () => {
    if (activeRow == null && activeCol == null) return;
    grid.querySelectorAll(".is-hl-row, .is-hl-col").forEach(e => e.classList.remove("is-hl-row", "is-hl-col"));
    activeRow = null;
    activeCol = null;
  };
  const setHL = (r, c) => {
    r = r == null ? null : String(r);
    c = c == null ? null : String(c);
    if (r === activeRow && c === activeCol) return;
    clearHL();
    activeRow = r;
    activeCol = c;
    if (r != null) grid.querySelectorAll(`[data-row="${cssAttr(r)}"]`).forEach(e => e.classList.add("is-hl-row"));
    if (c != null) grid.querySelectorAll(`[data-col="${cssAttr(c)}"]`).forEach(e => e.classList.add("is-hl-col"));
  };
  const highlightFromTarget = (target) => {
    const t = target?.closest?.("[data-row], [data-col]");
    if (!t || !grid.contains(t)) return;
    const r = t.getAttribute("data-row"), c = t.getAttribute("data-col");
    setHL(r, c);
  };
  grid.addEventListener("pointerover", (e) => {
    highlightFromTarget(e.target);
  });
  grid.addEventListener("focusin", (e) => {
    highlightFromTarget(e.target);
  });
  grid.addEventListener("focus", (e) => {
    highlightFromTarget(e.target);
  }, true);
  grid.addEventListener("focusout", (e) => {
    if (!grid.contains(e.relatedTarget)) clearHL();
  });
  grid.addEventListener("mouseleave", () => {
    if (!grid.contains(document.activeElement)) clearHL();
  });
  if (grid.contains(document.activeElement)) highlightFromTarget(document.activeElement);
  collabRoot?.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.collabSelection) return;
    event.preventDefault();
    clearCollabSelection();
  });
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
    const verbVars = askVerbVars(verbGlyph);
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
          <span class="alch-asks-verb${verbVars ? " has-verb-color" : ""}"${verbVars ? ` style="${verbVars}"` : ""} title="${escAttr(verb)}" aria-label="${escAttr(verbLabel)}">${askVerbIconSvg(verbGlyph) || escHtml(verbGlyph)}</span>
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
  const askVerbPills = ASK_VERB_OPTIONS.map((v, i) => {
    const glyph = Array.from(v)[0] || "";
    const label = Array.from(v).slice(1).join("").trim() || v;
    const icon = askVerbIconSvg(glyph);
    const vars = askVerbVars(glyph);
    return `
    <button class="alch-asks-verb-pill${vars ? " has-verb-color" : ""}"${vars ? ` style="${vars}"` : ""} type="button" data-asks-verb="${escAttr(v)}" aria-pressed="${i === 0 ? "true" : "false"}">
      ${icon ? `<span class="alch-asks-verb-pill-icon" aria-hidden="true">${icon}</span>` : ""}<span class="alch-asks-verb-pill-label">${escHtml(label)}</span>
    </button>`;
  }).join("");
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
            <span class="alch-asks-compose-author">${
              authorSlug === "your-slug"
                ? "claim your cohort profile before posting"
                : `posting as <strong>${escHtml(authorSlug)}</strong>${myHandle && authorSlug !== myHandle ? ` · @${escHtml(myHandle)}` : ""}`
            }</span>
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

  if (authorSlug === "your-slug") {
    result.hidden = false;
    result.innerHTML = `<p class="alch-onb-inline-line alch-onb-inline-err">claim your cohort profile before posting an ask.</p>`;
    return;
  }

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
author: ${quoteYaml(authorSlug)}
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
    ? "skill_areas:\n" + skills.map(s => `  - ${quoteYaml(s)}`).join("\n")
    : "skill_areas: []";
}

function contextAuthorSlug() {
  const people = state.cohort?.people || [];
  const me = state.profile?.user || {};
  const askIdentity = { identity: getIdentity(), profileUser: me, people };
  const myPerson = resolveAskIdentityPerson(askIdentity);
  return myPerson?.record_id || "your-slug";
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
        <div class="alch-cv-detail-actions">
          <button class="alch-cv-md-action" type="button" data-cv-copy-article="${escAttr(selected.id)}" title="copy ${escAttr(selectedMdFile)}">
            <span class="alch-cv-md-action-label">copy .md</span>
            <span class="alch-cv-md-action-file">${escHtml(selectedMdFile)}</span>
          </button>
          <button class="alch-cv-md-action" type="button" data-cv-promote="ask" data-cv-source-id="${escAttr(selected.id)}" title="open an ask PR for this article">
            <span class="alch-cv-md-action-label">ask PR</span>
          </button>
          <button class="alch-cv-md-action" type="button" data-cv-promote="program" data-cv-source-id="${escAttr(selected.id)}" title="open a program PR for this article">
            <span class="alch-cv-md-action-label">program PR</span>
          </button>
        </div>
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
  if (author === "your-slug") {
    return { error: "claim your cohort profile before promoting this article as an ask." };
  }
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
author: ${quoteYaml(author)}
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
      if (draft.error) {
        if (result) {
          result.hidden = false;
          result.innerHTML = `<p class="alch-onb-inline-line alch-onb-inline-err">${escHtml(draft.error)}</p>`;
        }
        return;
      }
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
// ─── #203 cohort-intel detail helpers — dropped during mega-merge (-X ours); restored ───
function detailItems(value) {
  if (Array.isArray(value)) return value.map(v => String(v || "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function detailList(items, opts = {}) {
  const vals = detailItems(items);
  if (!vals.length) return "";
  const cls = opts.compact ? " alch-detail-list-compact" : "";
  return `<ul class="alch-detail-list${cls}">${vals.map(v => `<li>${escHtml(v)}</li>`).join("")}</ul>`;
}

function detailChips(items, opts = {}) {
  const vals = detailItems(items);
  if (!vals.length) return "";
  const cls = opts.muted ? " alch-detail-chips-muted" : "";
  return `<div class="alch-detail-chips${cls}">${vals.map(v => `<span class="alch-detail-chip">${escHtml(v)}</span>`).join("")}</div>`;
}

function detailRows(rows) {
  return rows
    .filter(r => r && r.value)
    .map(r => `<div class="alch-detail-row"><span class="adr-k">${escHtml(r.key)}</span><span class="adr-v">${r.value}</span></div>`)
    .join("");
}

function renderDetailSection(title, rows, aux = "") {
  const body = detailRows(rows);
  if (!body) return "";
  return `
    <section class="alch-detail-section">
      <h3 class="alch-detail-h">${escHtml(title)}${aux ? ` <span class="alch-profile-h-aux">${escHtml(aux)}</span>` : ""}</h3>
      ${body}
    </section>
  `;
}

function renderDependencyLinks(ids) {
  const vals = detailItems(ids);
  if (!vals.length) return "";
  const teamsById = new Map((state.cohort?.teams || []).map(t => [t.record_id, t]));
  return `<ul class="alch-detail-list alch-detail-list-compact">${vals.map(id => {
    const t = teamsById.get(id);
    const label = t ? (t.name || t.record_id) : id;
    const role = t ? teamKind(t) : "record";
    return `<li><button type="button" class="alch-detail-inline-link" data-person="${escAttr(id)}">${escHtml(label)}</button> <span class="adl-role">${escHtml(role)}</span></li>`;
  }).join("")}</ul>`;
}

function renderDetail(recordId) {
  const cohortIndex = buildCohortIndex(activeDetailCohort());
  const team = cohortIndex.teamById.get(recordId);
  if (team) return renderTeamDetail(team);
  const person = cohortIndex.personById.get(recordId);
  if (person) return renderPersonDetail(person);
  if (state.detailReturnMode === "constellation") return renderTimelineMissingDetail(recordId);
  // Record vanished (e.g. cohort republished, slug changed). Bail out
  // back to the grid rather than showing an empty page.
  closeDetail();
}

function renderTimelineMissingDetail(recordId) {
  const snapshot = activeConstellationSnapshot();
  const label = snapshot?.label || "selected snapshot";
  state.canvas.innerHTML = `
    <header class="alch-detail-bar">
      <button class="alch-detail-back" type="button" id="alch-detail-back" aria-label="back to constellation">
        <span aria-hidden="true">←</span>
        <span>back</span>
      </button>
      <div class="alch-detail-bar-tag">
        <span>${escHtml(String(recordId || "").toUpperCase())}</span>
        <span class="ct-sep">·</span>
        <span>${escHtml(label)}</span>
      </div>
    </header>
    ${renderConstellationTimelineControls({ compact: true })}
    <p class="alch-callout"><strong>not declared at this snapshot</strong><br/>This record is absent from the public cohort surface for ${escHtml(label)}.</p>
  `;
  state.canvas.querySelector("#alch-detail-back")?.addEventListener("click", closeDetail);
}

function renderTeamDetail(team) {
  const cohortIndex = buildCohortIndex(activeDetailCohort());
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
    ${state.detailReturnMode === "constellation" ? renderConstellationTimelineControls({ compact: true }) : ""}

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
        <div class="alch-detail-shape">${s ? `<canvas data-shape-fam="${s.fam}" data-shape-kind="${escAttr(teamKind(team))}" data-shape-scale="1.3" data-shape-seed="${escAttr(team.record_id)}"></canvas>` : ""}</div>
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
          ${team.now ? `<div class="alch-detail-row"><span class="adr-k">now</span><span class="adr-v alch-detail-now">${escHtml(team.now)}</span></div>` : ""}
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
              ${team.paper_basis ? `<span class="plate-trophy trophy-notable"><span class="ptr-mark">◆</span><span class="ptr-body"><span class="ptr-grade">notable</span><span class="ptr-name">${escHtml(constText(team.paper_basis))}</span></span></span>` : ""}
            </div>
          </section>
        ` : ""}

        ${renderDetailSection("coordination", [
          { key: "depends on", value: renderDependencyLinks(team.dependencies) },
          { key: "seeking", value: detailList(team.seeking) },
          { key: "offering", value: detailList(team.offering) },
        ])}

        ${renderDetailSection("capability", [
          { key: "skills", value: detailChips(team.skill_areas) },
          { key: "shipped", value: detailList(team.prior_shipping) },
          { key: "success", value: detailChips(team.success_dimensions, { muted: true }) },
        ])}

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
  const cohortIndex = buildCohortIndex(activeDetailCohort());
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
    ${state.detailReturnMode === "constellation" ? renderConstellationTimelineControls({ compact: true }) : ""}

    <section class="alch-detail-hero">
      <div class="alch-detail-shape"><canvas data-shape-fam="${fam}" data-shape-kind="person" data-shape-scale="1.3" data-shape-seed="${escAttr(recordId)}"></canvas></div>
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

      ${renderDetailSection("current work", [
        { key: "now", value: person.now ? `<span class="alch-detail-now">${escHtml(person.now)}</span>` : "" },
        { key: "skills", value: detailChips(person.skill_areas || person.skills) },
      ])}

      ${renderDetailSection("collaboration", [
        { key: "ask about", value: detailList(person.go_to_them_for || person.offering) },
        { key: "best in", value: detailList(person.best_contexts) },
        { key: "seeking", value: detailList(person.seeking) },
        { key: "style", value: person.working_style ? escHtml(person.working_style) : "" },
      ])}

      ${renderDetailSection("throughlines", [
        { key: "themes", value: detailList(person.recurring_themes) },
        { key: "prior work", value: detailList(person.prior_work) },
      ])}

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
  const cohort = state.mode === "constellation" ? activeConstellationCohort() : state.cohort;
  const cohortIndex = buildCohortIndex(cohort);
  const team = cohortIndex.teamById.get(recordId);
  if (!team) {
    if (state.mode === "constellation") closeDrawer();
    return;
  }
  if (state.mode === "constellation") state.constellationDrawerRecordId = String(recordId);

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
  if (state.mode === "constellation") {
    const snap = activeConstellationSnapshot();
    if (snap?.label) tagBits.push(`<span>·</span>`, `<span>${escHtml(snap.label)}</span>`);
  }

  // Editorial section header — italic-serif title + terse lowercase sub-label,
  // matching the collab board's .alch-cb-sechead.
  const sechead = (title, sub) =>
    `<div class="alch-drawer-sechead"><h4>${escHtml(title)}</h4>${sub ? `<span class="dr-sub">${escHtml(sub)}</span>` : ""}</div>`;

  // Roster — primary contributors (person.team) + anyone who lists this team in
  // secondary_teams. Rendered as gold-accent person chips (people read
  // differently from teams/clusters — the collab shape-grammar).
  const roster = (state.cohort.people || []).filter(p =>
    p.team === team.record_id || (Array.isArray(p.secondary_teams) && p.secondary_teams.includes(team.record_id)));
  const crewChips = roster.map(p => {
    const role = p.role || (p.team === team.record_id ? "" : "contributor");
    return `<span class="alch-drawer-person"><span class="dp-name">${escHtml(p.name || p.record_id)}</span>${role ? `<span class="dp-role">${escHtml(role)}</span>` : ""}</span>`;
  }).join("");
  const successChips = constSuccessDimensions(team).map(d => `<span class="alch-drawer-success">${escHtml(d)}</span>`).join("");
  const opRows = [
    ["now", team.now],
    ["this week", team.weekly_goals],
    ["graduation", team.graduation_target],
    ["milestones", team.monthly_milestones],
  ].filter(([, v]) => constText(v)).map(([k, v]) =>
    `<div class="alch-drawer-row"><span class="dr-k">${escHtml(k)}</span><span class="dr-v">${escHtml(constText(v))}</span></div>`
  ).join("");

  body.innerHTML = `
    <div class="alch-drawer-tag">${tagBits.join("")}</div>
    <div class="alch-drawer-name">${escHtml(team.name)}</div>
    <div class="alch-drawer-shape">${s ? shapeSvgByFam(s.fam, hashStr(team.record_id)) : ""}</div>
    <div class="alch-drawer-rule"></div>
    <section class="alch-drawer-section">
      ${sechead("about", "focus · size · geo")}
      <div class="alch-drawer-row"><span class="dr-k">focus</span><span class="dr-v">${escHtml(team.focus || "—")}</span></div>
      <div class="alch-drawer-row"><span class="dr-k">team</span><span class="dr-v">${m} ${m === 1 ? "person" : "people"}</span></div>
      <div class="alch-drawer-row"><span class="dr-k">geo</span><span class="dr-v">${escHtml(team.geo || "—")}</span></div>
      ${team.traction ? `<div class="alch-drawer-row"><span class="dr-k">traction</span><span class="dr-v">${escHtml(team.traction)}</span></div>` : ""}
    </section>
    ${crewChips ? `
      <section class="alch-drawer-section">
        ${sechead("crew", "who to talk to")}
        <div class="alch-drawer-people">${crewChips}</div>
      </section>
    ` : ""}
    ${successChips || opRows ? `
      <section class="alch-drawer-section">
        ${sechead("operating model", "success vector · current proof")}
        ${successChips ? `<div class="alch-drawer-successes">${successChips}</div>` : ""}
        ${opRows}
      </section>
    ` : ""}
    <section class="alch-drawer-section">
      ${sechead("pmf · journey", "where they are on the arc")}
      ${journeyDetailSection(team)}
    </section>
    ${team.paper_basis || team.hackathon_note ? `
      <section class="alch-drawer-section">
        ${sechead("credentials", "papers · hackathons")}
        ${team.paper_basis  ? `<div class="alch-drawer-row"><span class="dr-k">paper</span><span class="dr-v">${escHtml(constText(team.paper_basis))}</span></div>`  : ""}
        ${team.hackathon_note ? `<div class="alch-drawer-row"><span class="dr-k">hackathon</span><span class="dr-v"><span style="color:var(--alchemy-oxide-bright)">★</span> ${escHtml(team.hackathon_note)}</span></div>` : ""}
      </section>
    ` : ""}
    <section class="alch-drawer-section">
      ${sechead("links", "")}
      ${linksRow}
    </section>
    ${memberClusters.length ? `
      <section class="alch-drawer-section">
        ${sechead("clusters", "why they sit in these wells")}
        <div class="alch-drawer-clusters alch-drawer-cluster-cards">
          ${memberClusters.map(cl => `
            <span class="alch-drawer-cluster"><span>${escHtml(cl.label || cl.name || cl.record_id)}</span>${cl.description ? `<em>${escHtml(cl.description)}</em>` : ""}</span>
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
  state.constellationDrawerRecordId = null;
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
    const gh = normalizeGithubAccount(p?.links?.github || p?.github || p?.gh_handle);
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
          <span class="alch-theme-toggle-icon" aria-hidden="true">${themeNow === "light"
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v1"/><path d="M12 20v1"/><path d="M3 12h1"/><path d="M20 12h1"/><path d="m18.364 5.636-.707.707"/><path d="m6.343 17.657-.707.707"/><path d="m5.636 5.636.707.707"/><path d="m17.657 17.657.707.707"/></svg>`}</span>
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
  const account = normalizeGithubAccount(profile?.user?.github);
  const src = (account || profile?.user?.name || "").toString();
  return src.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
// Slug for an in-flight ADD form. Prefers values from the form itself
// over the long-lived "me" prefs so the path preview updates live and
// the submitted record_id matches the visible NAME / GITHUB fields.
// Person uses github > name; team/project just use name.
function draftSlug(p) {
  const d = p?.editDraft || {};
  const isPerson = p?.editKind === "person";
  const account = isPerson ? normalizeGithubAccount(d?.links?.github || p?.user?.github) : null;
  const src = isPerson
    ? (account || d?.name || p?.user?.name || "")
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
      toggleTheme();
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
  const githubAccount = normalizeGithubAccount(links.github);
  const lp = [];
  if (githubAccount || links.github) lp.push(`  github: ${quoteYaml(githubAccount || links.github)}`);
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
