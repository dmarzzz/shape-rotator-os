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
// Public API matches the other lazily-mounted renderer modules:
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
  cohortRosterForTeam, cohortRosterSummary, compactCohortLinkItems,
  buildCalendarRows, drawCalendar,
  loadCalendar as loadCalendarData,
  currentWeekIdx as calendarCurrentWeekIdx,
  parseWeekRow as calendarParseWeekRow,
} from "@shape-rotator/shape-ui";
import {
  aggregateSkillAreas, buildCohortIndex, buildCollabModel, collabAffKey, collabHasText,
  dependencyPairKey, dependencySafeToken,
  constellationDependencyEdges, constellationIndegree, constellationModel, teamKind, teamsOfKind,
  packBubbles, packSiblings, enclose, CLUSTER_TO_THEME, THEME_LABELS,
} from "./cohort-relations.js";
import {
  contextRawScriptById as findContextRawScriptById,
  contextSourceById as findContextSourceById,
} from "./context-vault-model.js";
import {
  contextArticleSourceById as findMergedContextArticleSourceById,
  mergeContextArticleSources,
} from "./context-articles.mjs";
import { getCohortSurface, subscribeToCohortChanges, isSyncAvailable } from "./cohort-source.js";
import { unreadCounts, markModeSeen, fingerprintItems, unreadCountForFingerprints, markFingerprintsSeen } from "./whats-new.js";
import { getCohortTimeline } from "./cohort-timeline.js";
import { getStandingWeekly } from "./cohort-standing-weekly.js";
import { putLocalRecord, getRecord, getHealth, getManifest, getNodeLog } from "./sync-client.js";
import { toast } from "./ux.js";
import { getTheme, toggleTheme } from "./theme.js";
import { getIdentity, setIdentity, hasSkippedIdentityOnboarding, mountResealInline } from "./identity.js";
import {
  askAgeLabel, askIsCurrent, askIsOpen, askStatus, askTopic, asksWithStatus,
  isAskMine, normalizeAskIdentity, resolveAskAuthor, resolveAskIdentityPerson,
  askVerbVars, askVerbIconSvg,
} from "./asks.js";
import { createLazyModule } from "./lazy-module.js";
import { loadStylesheetOnce } from "./stylesheet-loader.js";

const ALCHEMY_LS_KEY  = "srwk:alchemy_mode";
const CONTEXT_VIEW_LS_KEY = "srwk:context_view"; // context page view: "articles" | "raw" | "signals" | "data"
const CONST_MODE_LS_KEY = "srwk:const_mode";  // constellation sub-view: "map" | "ring" | "journey" | "stack" | "targets" | "shipped" | "collab"
const CONST_SCOPE_LS_KEY = "srwk:const_scope"; // network scope: "projects" | "people"
const CONST_LENS_LS_KEY = "srwk:const_lens";  // map lens: "all" | "relies" | "works" | "substrate"
const CONST_TIER_LS_KEY = "srwk:const_tier";  // pinned line-source tier: "all" | "record" | "mention"
const CONST_PEOPLE_LINK_LS_KEY = "srwk:const_people_link"; // pinned people-map link family: "all" | "same-team" | "profile" | "shared-context"
const CONST_INTEREST_LS_KEY = "srwk:const_interest"; // source-backed ecosystem view: cluster record_id | "all"
const CONST_GRANULARITY_LS_KEY = "srwk:const_granularity"; // bubble map grain: "themes" | "clusters" | "skills"
const PROFILE_LS_KEY  = "srwk:profile_v1";
const EVENTS_LS_KEY   = "srwk:cohort_events_v1";
const DETAIL_LS_KEY   = "srwk:alchemy_detail_v1";
const PROGRAM_PAGE_LS_KEY = "srwk:program_page";
const COLLAB_INTAKE_DRAFT_LS_KEY = "srwk:collab_intake_draft_v1";
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
// `collab` is a Constellation sub-view, not a standalone OS mode. Legacy
// saved locations that still say "collab" are normalized on restore.
const ALCHEMY_MODES   = ["membrane", "shapes", "constellation", "calendar", "profile", "onboarding", "program", "asks", "context"];
const MEMBRANE_INTRO_LS_KEY = "srwk:membrane_seen_v1";
const membraneLazy = createLazyModule(() =>
  Promise.all([
    loadStylesheetOnce("renderer/membrane/membrane.css"),
    import("./membrane/index.js"),
  ]).then(([, module]) => module));
const intelLazy = createLazyModule(() =>
  Promise.all([
    loadStylesheetOnce("renderer/intel/intel.css"),
    import("./intel/intel.js"),
  ]).then(([, module]) => module));
const calendarLazy = createLazyModule(() =>
  Promise.all([
    loadStylesheetOnce("vendor/shape-ui/cohort-calendar-week.css"),
    loadStylesheetOnce("renderer/calendar.css"),
    import("./calendar.js"),
  ]).then(([, , module]) => module));
const calendarSupabaseLazy = createLazyModule(() => import("./calendar-supabase.mjs"));
const githubUserLazy = createLazyModule(() => import("./gh-user.js"));
const githubForkLazy = createLazyModule(() => import("./gh-fork.js"));
let intelMetaCache = null;

function warmLazySurface(label, lazy) {
  return lazy.load().catch((error) => {
    console.warn(`[alchemy:${label}] warmup failed:`, error?.message || error);
    return null;
  });
}

export function warmMode(mode) {
  const normalized = mode === "intel" ? "context"
    : mode === "calendar2" ? "calendar"
    : mode === "pulse" ? "shapes"
    : mode === "collab" ? "constellation"
    : mode;
  if (normalized === "membrane") return warmLazySurface("membrane", membraneLazy);
  if (normalized === "calendar") return warmLazySurface("calendar", calendarLazy);
  if (normalized === "context") return warmLazySurface("context", intelLazy);
  return Promise.resolve(null);
}

const WEEKS_TOTAL = 10;
function currentProgramWeek() {
  try { return Math.max(1, Math.min(WEEKS_TOTAL, calendarCurrentWeekIdx() + 1)); }
  catch { return 1; }
}

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
  goalStandingFilter: "all",       // "all" | "behind" | "onplan" | "ahead" — standing legend/filter
  goalMomentumFilter: "all",       // "all" | "rising" | "slipping" | "flat" — momentum legend/filter on the goal views
  standingProjection: "trajectory", // "trajectory" | "targets" — standing view projection (targets folded in 2026-06)
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
  standingWeekly: null,         // per-week PMF stage/standing (Supabase team_standing_weekly → cohort-standing-weekly.json); drives the goal-view timeline + momentum
  constellationTimelineIdx: null,  // selected snapshot index within cohortTimeline.snapshots
  constellationShowDelta: false,
  profile: null,       // local-only: { user, editor state, ... }
  programPage: null,   // active program-handbook page slug (overview | success | rules | schedule)
  atlasFocus: null,    // active tag in the atlas view (null = whole-graph mode)
  onboardingJustToggled: null,  // step key that was just marked/unmarked done; consumed by wireOnboarding to scroll-into-view the next step
  openAskComposer: false, // one-shot landing state when membrane sends someone to post
  constellationMode: "map",   // top-level constellation view: "map" | "ring" | "journey" | "stack" | "targets" | "shipped" | "collab"
  constellationScope: "projects", // network entity layer: projects/teams vs people-to-project membership
  constellationLens: "all",   // map line lens: "all" | "relies" | "works" | "substrate" — changes which relationship claim is foregrounded
  constPeopleLinkFilter: "all", // people-map legend/filter: "all" | "same-team" | "profile" | "shared-context"
  constInterest: "all",       // map ecosystem focus: "all" or a cluster record_id from cohort-data/clusters
  constellationGranularity: "clusters", // bubble map grain: "themes" | "clusters" | "skills"
  constSelection: null,       // persistent constellation inspector selection: { type:"team"|"person", rid } | { type:"edge", from, to }
  renderSeq: 0,               // monotonic render guard; stale delayed swaps must not overwrite the latest view
  calendar: {                     // calendar tab state — see renderCalendar()
    weekIdx: null,                // 0..9; resolved on first render via calendarCurrentWeekIdx()
    view: "cal",                  // "cal" (timeline grid) | "presence" (availability gantt)
    data: null,                   // raw Phala JSON — live response or bundled snapshot
    source: null,                 // "live" | "bundled" | null (no data yet)
    loading: false,               // true while the async live fetch is in flight
    initialMount: true,           // first render? drives scroll-to-now
    detach: null,                 // teardown returned by attachCalendarPageBehavior
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
  viewScrollFrame: 0,
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
    state.constellationMode = constNormalizeConstellationMode(localStorage.getItem(CONST_MODE_LS_KEY));
    state.constellationScope = constNormalizeNetworkScope(localStorage.getItem(CONST_SCOPE_LS_KEY));
    state.constellationLens = constNormalizeConstellationLens(localStorage.getItem(CONST_LENS_LS_KEY));
    state.constEdgeTier = constNormalizeEdgeTier(localStorage.getItem(CONST_TIER_LS_KEY));
    state.constPeopleLinkFilter = constNormalizePeopleLinkFilter(localStorage.getItem(CONST_PEOPLE_LINK_LS_KEY));
    state.constellationGranularity = constNormalizeGranularity(localStorage.getItem(CONST_GRANULARITY_LS_KEY));
    const savedInterest = localStorage.getItem(CONST_INTEREST_LS_KEY);
    if (savedInterest) state.constInterest = savedInterest;
    const savedProgramPage = localStorage.getItem(PROGRAM_PAGE_LS_KEY);
    if (savedProgramPage) state.programPage = savedProgramPage;
    if (saved === "collab") {
      state.mode = "constellation";
      state.constellationMode = "collab";
      localStorage.setItem(ALCHEMY_LS_KEY, "constellation");
      localStorage.setItem(CONST_MODE_LS_KEY, "collab");
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
    if (saved === "pulse")     { state.mode = "shapes"; localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); }
    // calendar2 graduated to THE calendar (2026-06); old saved modes land there.
    if (saved === "calendar2") { state.mode = "calendar"; localStorage.setItem(ALCHEMY_LS_KEY, "calendar"); }
    // Context page view (articles | raw | signals | data) survives reloads.
    state.contextVault.mode = contextNormalizeView(localStorage.getItem(CONTEXT_VIEW_LS_KEY) || state.contextVault.mode);
    // intel folded into the context page (2026-06): old intel users land on
    // the context page's intel view.
    if (saved === "intel") {
      state.mode = "context";
      state.contextVault.mode = "signals";
      localStorage.setItem(ALCHEMY_LS_KEY, "context");
      localStorage.setItem(CONTEXT_VIEW_LS_KEY, "signals");
    }
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
      if (d?.returnMode === "collab") {
        state.detailReturnMode = "constellation";
        state.constellationMode = "collab";
        localStorage.setItem(CONST_MODE_LS_KEY, "collab");
        if (state.detailRecordId) {
          localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({ recordId: state.detailRecordId, returnMode: "constellation" }));
        }
      } else if (d?.returnMode === "pulse") {
        state.detailReturnMode = "shapes";
        if (state.detailRecordId) {
          localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({ recordId: state.detailRecordId, returnMode: "shapes" }));
        }
      } else if (d?.returnMode === "intel") {
        state.detailReturnMode = "context";
        if (state.detailRecordId) {
          localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({ recordId: state.detailRecordId, returnMode: "context" }));
        }
      } else if (d?.returnMode && ALCHEMY_MODES.includes(d.returnMode)) {
        state.detailReturnMode = d.returnMode;
      }
    }
  } catch {}
  loadProfile();
  loadEventsCache();
  if (state.container) {
    state.container.dataset.alchModeCurrent = state.mode;
    if (state.mode === "constellation") {
      state.container.dataset.constModeCurrent = constNormalizeConstellationMode(state.constellationMode);
    } else {
      delete state.container.dataset.constModeCurrent;
    }
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
      const next = ALCHEMY_MODES.includes(btn.dataset.alchMode) ? btn.dataset.alchMode : null;
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
  // Plain ←/→ step through the current page's view tabs (program handbook
  // pages, cohort views, calendar/presence, context views). Modifier'd
  // arrows are left alone — alt+←/→ is history nav (boot.js) — and so are
  // typing contexts. Clicking the neighbour button reuses each page's own
  // tab wiring, so this needs no per-page state.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target;
    const tag = t?.tagName?.toUpperCase?.();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    // An open sentence-bar filter menu owns the arrows: its options are
    // <button role="option"> (not caught by the tag check above), so without
    // this guard ←/→ would tear down the menu and cycle the view mid-select.
    if (t?.closest?.('[role="option"],[role="listbox"],.ac-sent-menu,[aria-haspopup="listbox"]')) return;
    if (document.querySelector(".ac-sent-menu:not([hidden])")) return;
    if (document.body.dataset.activeTab !== "alchemy") return;
    if (!state.canvas) return;
    // On the calendar timeline, ←/→ scrub weeks — that's the page's dominant
    // affordance (big prev/next arrows), which was otherwise keyboard-dead
    // while the global cycler stole the keys to toggle cal<->presence. The
    // presence gantt has no week scrubber, so it falls through to tab cycling.
    if (state.mode === "calendar" && state.calendar?.view === "cal") {
      const navBtn = state.canvas.querySelector(`[data-c2-nav="${e.key === "ArrowRight" ? "next" : "prev"}"]`);
      e.preventDefault();
      if (navBtn && !navBtn.disabled) navBtn.click();
      return;
    }
    const strip = state.canvas.querySelector(".alch-page-views, .alch-prog-tabs");
    if (!strip) return;
    const btns = [...strip.querySelectorAll(".alch-page-view-btn, .alch-prog-tab")].filter(b => !b.disabled);
    if (btns.length < 2) return;
    const cur = btns.findIndex(b => b.getAttribute("aria-selected") === "true");
    if (cur < 0) return;
    const next = (cur + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length;
    e.preventDefault();
    btns[next].click();
  });
  window.addEventListener("resize", () => {
    if (state.viewScrollFrame) cancelAnimationFrame(state.viewScrollFrame);
    state.viewScrollFrame = requestAnimationFrame(() => {
      state.viewScrollFrame = 0;
      scrollActivePageViewIntoView();
    });
  });
  syncRailSelection();
  startContextAutoRefresh();
  setTimeout(() => { warmMode(state.mode).catch(() => {}); }, 0);
  loadCohort().then(render).catch(err => {
    console.error("[alchemy] cohort load failed:", err);
    state.canvas.innerHTML = `<p class="alch-callout"><strong>cohort data unavailable</strong><br/>${escHtml(err.message || String(err))}</p>`;
  });
  loadCohortTimeline().then(() => {
    if (state.mounted && (state.mode === "constellation" || state.mode === "shapes" || state.detailReturnMode === "constellation")) render();
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
// reads back the current one. A "location" inside the OS tab is the rail
// mode plus optional sub-mode/page/detail state.
export function getLocation() {
  let mode = state.mode === "collab" ? "constellation" : state.mode;
  if (mode === "intel") mode = "context";
  const loc = { mode, recordId: state.detailRecordId || null };
  if (mode === "constellation") loc.constellationMode = constNormalizeConstellationMode(state.constellationMode);
  if (mode === "program" && state.programPage) loc.programPage = state.programPage;
  if (mode === "context") loc.contextView = contextNormalizeView(state.contextVault.mode);
  return loc;
}

// Apply a location: set the mode (and optionally open a record detail),
// persist it the same way the in-app handlers do, then repaint. Safe to
// call before mount — it primes localStorage so the lazy mount lands here.
export function applyLocation(loc = {}) {
  const legacyCollab = loc.mode === "collab";
  const legacyPulse = loc.mode === "pulse";
  const legacyIntel = loc.mode === "intel";
  const mode = legacyCollab ? "constellation"
    : (legacyPulse ? "shapes"
    : (legacyIntel ? "context"
    : (ALCHEMY_MODES.includes(loc.mode) ? loc.mode : state.mode)));
  if (mode === "program" && loc.programPage) {
    state.programPage = String(loc.programPage);
    try { localStorage.setItem(PROGRAM_PAGE_LS_KEY, state.programPage); } catch {}
  }
  if (legacyCollab || mode === "constellation") {
    state.constellationMode = legacyCollab ? "collab" : constNormalizeConstellationMode(loc.constellationMode || "map");
    try { localStorage.setItem(CONST_MODE_LS_KEY, state.constellationMode); } catch {}
  }
  if (legacyIntel || (mode === "context" && loc.contextView)) {
    state.contextVault.mode = legacyIntel ? "signals" : contextNormalizeView(loc.contextView);
    try { localStorage.setItem(CONTEXT_VIEW_LS_KEY, state.contextVault.mode); } catch {}
  }
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

// Navigation-only sibling of __srwkOpenProfile — opens the profile page
// WITHOUT touching the editor state, so it shows exactly what the old
// rail "profile" entry showed. Used by the bottom-left identity pill
// (the rail entry was removed 2026-06; the pill is the only way in).
window.__srwkGoProfilePage = function openProfilePage() {
  if (!state.profile) loadProfile();
  state.detailRecordId = null;
  state.detailReturnMode = null;
  try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
  state.mode = "profile";
  try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
  if (typeof window.__srwkGoTab === "function") {
    window.__srwkGoTab("alchemy");
  }
  if (state.mounted) {
    syncRailSelection();
    render();
  }
};

async function loadCohort() {
  state.cohort = await getCohortSurface();
  // What's-new: repaint the rail's unread (color-only) state against the
  // fresh surface — covers both the initial load and refresh ticks that
  // land while the user is elsewhere.
  updateRailUnread();
  // Enrich person records from GitHub: name / geo / website / x are
  // filled in (when empty) from api.github.com/users/<handle>. Cached
  // 24h in localStorage so this is one API call per person per day
  // per device. Triggers a re-render whenever a record gets new data
  // so the first-render placeholders update as fetches complete.
  if (state.cohort?.people) {
    const people = state.cohort.people;
    githubUserLazy.load()
      .then((module) => {
        module.enrichPeople(people, {
          onUpdate: () => {
            // Debounce: gather a few enrichments before re-rendering so a
            // cold-cache cohort doesn't trigger 50 paints in a row.
            clearTimeout(state._ghEnrichRenderTimer);
            state._ghEnrichRenderTimer = setTimeout(() => {
              if (state.mounted && state.active) render();
            }, 350);
          },
        });
      })
      .catch((error) => {
        console.warn("[alchemy] github enrichment failed to load:", error?.message || error);
      });
  }
}

async function loadCohortTimeline() {
  if (state.cohortTimeline || state.cohortTimelineLoading) return;
  state.cohortTimelineLoading = true;
  try {
    state.cohortTimeline = await getCohortTimeline();
    try { state.standingWeekly = await getStandingWeekly(); } catch (e) { state.standingWeekly = null; }
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
  const snapshots = constellationSnapshots();
  const idx = ensureConstellationTimelineIdx();
  // At the newest snapshot, prefer the live surface: the bundled timeline
  // artifact can lag records merged after it was generated.
  if (idx == null || idx >= snapshots.length - 1) return state.cohort;
  return snapshots[idx]?.surface || state.cohort;
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

// What's-new: a mode whose cohort content changed since the user last
// viewed it gets a numbered circle in the rail gutter left of its icon
// (the count of new/changed records). The badge is absolutely
// positioned, so the icon and label never move; it clears once the
// page is viewed.
//
// DISABLED for now (2026-06-11) — flip to true to re-enable the badges.
// While off, no badge ever renders, but the seen-baseline bookkeeping
// (markModeSeen / markFingerprintsSeen) keeps running silently so
// re-enabling won't flood the rail with stale "new" counts.
const WHATS_NEW_ENABLED = false;

function updateRailUnread() {
  if (!state.rail || !state.cohort) return;
  if (!WHATS_NEW_ENABLED) {
    // Strip anything a previous session may have painted.
    for (const btn of state.rail.querySelectorAll(".alchemy-rail-btn")) {
      btn.classList.remove("ar-unread");
      btn.querySelector(".ar-unread-badge")?.remove();
    }
    return;
  }
  const counts = unreadCounts(state.cohort);
  const ctxCount = unreadCountForFingerprints("context", contextVaultFingerprints());
  if (ctxCount > 0) counts.context = ctxCount;
  const calCount = unreadCountForFingerprints("calendar-grid", calendarFingerprints());
  if (calCount > 0) counts.calendar = calCount;
  for (const btn of state.rail.querySelectorAll(".alchemy-rail-btn")) {
    const n = counts[btn.dataset.alchMode] || 0;
    btn.classList.toggle("ar-unread", n > 0);
    let badge = btn.querySelector(".ar-unread-badge");
    if (n > 0) {
      if (!badge) {
        badge = document.createElement("span");
        badge.className = "ar-unread-badge";
        badge.setAttribute("aria-hidden", "true");
        btn.appendChild(badge);
      }
      badge.textContent = n > 9 ? "9+" : String(n);
    } else if (badge) {
      badge.remove();
    }
  }
}

function syncRailSelection() {
  if (!state.rail) return;
  // Constellation views live inside the cohort page now (2026-06), so the
  // "shapes" rail entry lights up for both internal modes. Same for intel,
  // which lives inside the context page.
  let activeMode = state.mode === "collab" ? "constellation" : state.mode;
  if (activeMode === "constellation") activeMode = "shapes";
  if (activeMode === "intel") activeMode = "context";
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
    if (state.mode === "constellation") {
      state.container.dataset.constModeCurrent = constNormalizeConstellationMode(state.constellationMode);
    } else {
      delete state.container.dataset.constModeCurrent;
    }
    if (state.mode === "context") {
      state.container.dataset.contextView = contextNormalizeView(state.contextVault.mode);
    } else {
      delete state.container.dataset.contextView;
    }
    // Mirror the open record-detail id so the tab system can observe
    // navigation changes via a MutationObserver (no event plumbing).
    state.container.dataset.alchDetail = state.detailRecordId || "";
    if (state.mode !== "program") delete state.container.dataset.alchProgramPage;
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
  // Always instant — no cross-fade. Page switches should feel immediate
  // (browser-like) instead of a "reload". Also required while hidden:
  // Chromium throttles timers in background Electron windows, and
  // navigation must not leave state/detail URLs ahead of the painted DOM.
  canvas.classList.remove("is-leaving", "is-entering");
  renderModeContent();
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
      if (state.mode === "constellation") {
        if (constNormalizeConstellationMode(state.constellationMode) === "collab") {
          wireConstellationModeNav();
          wireCollab();
        }
        else wireConstellationHover();
      }
      if (state.mode === "calendar") wireCalendar();
      if (state.mode === "onboarding") wireOnboarding();
      if (state.mode === "program") wireProgram();
      if (state.mode === "asks") wireAsks();
      if (state.mode === "context") wireContextVault();
    }
    // Mount shape shaders LAST — every <canvas data-shape-fam> emitted by the
    // renderers above gets one WebGL2 context here.
    mountAllShapes();
    requestAnimationFrame(scrollActivePageViewIntoView);
    // What's-new: painting a mode while the OS tab is in front counts as
    // reading it — settle its unread color. Guarded so a background data
    // refresh (subscription re-render while the user is on another tab or
    // the window is hidden) never marks content seen the user hasn't seen.
    if (state.active && !document.hidden) {
      // Map sub-views onto their rail entry (same mapping as
      // syncRailSelection): any cohort view marks the cohort page seen,
      // intel marks context — the badge tracks "did I look at the PAGE",
      // not which sub-view happened to be active.
      let seenMode = state.mode === "collab" ? "constellation" : state.mode;
      if (seenMode === "constellation") seenMode = "shapes";
      if (seenMode === "intel") seenMode = "context";
      markModeSeen(seenMode, state.cohort);
      if (seenMode === "context") markFingerprintsSeen("context", contextVaultFingerprints());
      if (seenMode === "calendar") markFingerprintsSeen("calendar-grid", calendarFingerprints());
    }
    updateRailUnread();
  } catch (err) {
    console.error(`[alchemy] render failed for ${renderLabel}:`, err);
    canvas.innerHTML = `<p class="alch-callout"><strong>${escHtml(renderLabel)} failed to render</strong><br/>${escHtml(err?.message || String(err))}</p>`;
  }
}

function scrollActivePageViewIntoView() {
  const strip = state.canvas?.querySelector(".alch-page-views");
  const active = strip?.querySelector('.alch-page-view-btn[aria-selected="true"]');
  if (!strip || !active || strip.scrollWidth <= strip.clientWidth) return;
  const stripRect = strip.getBoundingClientRect();
  const activeRect = active.getBoundingClientRect();
  const pad = 12;
  if (activeRect.left >= stripRect.left + pad && activeRect.right <= stripRect.right - pad) return;
  strip.scrollLeft = active.offsetLeft - Math.max(0, (strip.clientWidth - active.offsetWidth) / 2);
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
  const membraneModule = membraneLazy.peek();
  if (!membraneModule) {
    const membraneModuleError = membraneLazy.error();
    if (membraneModuleError) {
      state.canvas.innerHTML = `<p class="alch-callout"><strong>membrane failed to load: ${escHtml(membraneModuleError?.message || String(membraneModuleError))}</strong></p>`;
      return;
    }
    state.canvas.innerHTML = `<p class="alch-callout"><strong>loading membrane...</strong></p>`;
    membraneLazy.load()
      .then(() => {
        if (!state.mounted || state.mode !== "membrane" || state.detailRecordId) return;
        render({ instant: true });
      })
      .catch((error) => {
        console.warn("[alchemy] membrane load failed:", error?.message || error);
        if (state.mounted && state.mode === "membrane" && !state.detailRecordId) {
          renderMembrane();
        }
      });
    return;
  }
  state.membraneController = membraneModule.mountMembrane(state.canvas);
  state.membraneController.setData(computeMembraneData());
}

// Today's timed events from the Phala calendar GRID (cohort.calendar.tabs).
// Extract every timed line from a grid cell block. A block can hold a header
// line plus several timed lines (e.g. "Mon-Tue: TEE Technical\n…\n15:30–16:00
// tea on roof\n17:00 retro") — reading only the FIRST line dropped today's tea
// (line 3) and Friday's retro (line 2) from the agenda entirely. Emit one
// {time,title} per line that leads with a clock time.
function parseTimedGridLines(block) {
  const out = [];
  for (const raw of String(block).split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let time = "", rest = "";
    const range = line.match(/^(\d{1,2}:\d{2})\s*[-–—:]\s*(\d{1,2}:\d{2})(.*)$/);
    if (range) { time = `${range[1]}–${range[2]}`; rest = range[3]; }
    else {
      const single = line.match(/^(\d{1,2}:\d{2})(.*)$/);
      if (!single) continue;           // line doesn't lead with a clock time → not an event line
      time = single[1]; rest = single[2];
    }
    rest = rest.replace(/^[\s.·:–—-]+/, "").trim();
    if (!rest) continue;
    out.push({ time, title: rest });
  }
  return out;
}

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
      for (const ev of parseTimedGridLines(block)) out.push({ time: ev.time, title: ev.title, sub: "" });
    }
    return out;
  } catch { return []; }
}

// Timed grid events for the NEXT `days` days (not today) — the look-ahead
// that keeps the agenda from reading empty on a quiet today. Same parsing as
// todayGridEvents, generalized to iterate the current + following week rows
// and keep only future days within the window. Matches days by LOCAL Y/M/D
// (the grid cells are UTC-midnight) exactly like todayGridEvents.
function upcomingGridEvents(cal, days = 28) {
  try {
    if (!cal || !cal.tabs) return [];
    const tabName = cal.tabs["May 18 Start"] ? "May 18 Start" : Object.keys(cal.tabs)[0];
    const rows = cal.tabs[tabName] || [];
    const baseWk = calendarCurrentWeekIdx();
    const DAY = 24 * 60 * 60 * 1000;
    const n = new Date();
    const todayStart = new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime();
    const horizon = todayStart + days * DAY;
    const out = [];
    for (let wk = baseWk; wk <= baseWk + 4; wk++) {
      const weekRow = rows[2 + wk];
      if (!weekRow) continue;
      let week;
      try { week = calendarParseWeekRow(weekRow, wk); } catch { continue; }
      for (const d of (week.days || [])) {
        const dd = new Date(d.dayMs); // grid cell at UTC midnight
        const localStart = new Date(dd.getUTCFullYear(), dd.getUTCMonth(), dd.getUTCDate()).getTime();
        if (localStart <= todayStart || localStart >= horizon) continue;
        const dayOffset = Math.round((localStart - todayStart) / DAY);
        const ld = new Date(localStart);
        const date = `${ld.getFullYear()}-${String(ld.getMonth() + 1).padStart(2, "0")}-${String(ld.getDate()).padStart(2, "0")}`;
        for (const block of (d.blocks || [])) {
          for (const ev of parseTimedGridLines(block)) out.push({ date, dayOffset, time: ev.time, title: ev.title, sub: "", source: "grid" });
        }
      }
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
// "What's new" feed — a recency-sorted stream of cohort activity for the
// membrane's left edge. Pulls dated signals from sources already in the
// surface and expands them to commit/session granularity so the feed reads
// full, not sparse. Each item is {date, kind, label, meta, nav} where nav
// describes the OS location to open in a new tab when clicked. New signal
// sources slot in here as they land.
function buildWhatsNewFeed(c) {
  const out = [];

  // GitHub releases — surfaced from the bundled `github_releases` items (built
  // by scripts/build-bundles.js from the github-releases artifacts). Mirrors
  // buildWhatsNew(): real published releases, not commit subjects. Normally
  // c.whats_new is present and preferred (see computeMembraneData), so this
  // fallback only runs when the bundled feed is missing.
  for (const it of (Array.isArray(c?.github_releases) ? c.github_releases : [])) {
    const date = String(it?.date || '').slice(0, 10);
    const label = String(it?.label || '').trim();
    if (!date || !label) continue;
    out.push({ date, kind: 'release', label, meta: it.meta || '', nav: it.nav || { mode: 'shapes' } });
  }

  // Weekly commit activity — one digest item per project per week, mirroring
  // buildWhatsNew(). Reads the bundled team_timeline "github progress" entries
  // (one per project-week) rather than re-deriving from artifacts.
  const teamNameById = new Map(
    (Array.isArray(c?.teams) ? c.teams : []).map((t) => [String(t.record_id || ''), t.name || t.record_id])
  );
  const tt = (c && c.team_timeline) || {};
  for (const teamId of Object.keys(tt)) {
    const project = teamNameById.get(teamId) || teamId;
    for (const it of (Array.isArray(tt[teamId]) ? tt[teamId] : [])) {
      if (it.type !== 'github progress') continue;
      const date = String(it.date || '').slice(0, 10);
      if (!date) continue;
      const m = String(it.title || '').match(/:\s*(\d+)\s+commits?/i);
      const label = m ? `${m[1]} commit${m[1] === '1' ? '' : 's'}` : 'new commits';
      out.push({ date, kind: 'commit', label, meta: project, nav: { mode: 'shapes', recordId: teamId } });
    }
  }

  // Transcripts are intentionally not emitted — the renderer hides them, so
  // they would only burn feed slots. Mirrors buildWhatsNew(); re-add once the
  // readout → context deep-link lands.

  // Freshly-posted asks.
  for (const a of (Array.isArray(c?.asks) ? c.asks : [])) {
    const date = String(a.posted_at || '').slice(0, 10);
    if (!date) continue;
    out.push({
      date, kind: 'ask',
      label: a.topic || a.verb || 'ask',
      meta: `${a.verb || 'ask'} · ask`,
      nav: { mode: 'asks' },
    });
  }

  // Program events added to the calendar.
  for (const e of (Array.isArray(c?.events) ? c.events : [])) {
    const date = String(e.date || e.range_start || e.starts_at || '').slice(0, 10);
    if (!date) continue;
    out.push({
      date, kind: 'event',
      label: e.title || e.name || 'program event',
      meta: e.subtitle ? `${e.subtitle} · event` : 'event',
      nav: { mode: 'calendar' },
    });
  }

  out.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  return out.slice(0, 200); // high backstop — full program log, mirrors FEED_MAX
}

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
  // Spans (daily tea, office hours) carry no start clock of their own — the
  // time, if any, lives only in the human subtitle ("14:00 · the only prepared
  // daily ritual"). Lift a valid leading HH:MM so the membrane incoming-watch
  // can give the ritual a proximity ping; "" when there's no parseable clock.
  const spanClock = (e) => {
    const m = String(e?.subtitle || '').match(/(\d{1,2}):(\d{2})/) || String(e?.title || '').match(/(\d{1,2}):(\d{2})/);
    if (!m) return '';
    return (+m[1] < 24 && +m[2] < 60) ? `${m[1]}:${m[2]}` : '';
  };
  const spanItems = spans
    .filter((u) => u.startMs < tomorrowMs && u.endMs >= todayStartMs)
    .map((u) => ({
      time: spanClock(u.e),
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

  // UPCOMING agenda — the next several days of events, so the widget rolls
  // forward and never reads empty on a quiet today (Apple "Up Next" model).
  // Same two sources as today (grid cells + cohort spans), generalized to a
  // ~4-week window. Deduped by title across the whole window (so recurring
  // spans like "daily tea" surface once at their soonest day, keeping
  // variety), and we skip anything already shown in today. Day-ordered, then
  // untimed-first within a day; capped so it can't overflow the column.
  const UP_WINDOW_DAYS = 28;
  const UP_MAX = 10;
  const upByDay = new Map();
  const pushUp = (off, item) => { if (!upByDay.has(off)) upByDay.set(off, []); upByDay.get(off).push(item); };
  for (const g of upcomingGridEvents(c.calendar, UP_WINDOW_DAYS)) pushUp(g.dayOffset, g);
  for (let off = 1; off <= UP_WINDOW_DAYS; off++) {
    const ds = todayStartMs + off * DAY_MS;
    const de = ds + DAY_MS;
    for (const u of spans) {
      if (u.startMs < de && u.endMs >= ds) {
        const ld = new Date(ds);
        pushUp(off, {
          date: `${ld.getFullYear()}-${String(ld.getMonth() + 1).padStart(2, '0')}-${String(ld.getDate()).padStart(2, '0')}`,
          dayOffset: off,
          time: spanClock(u.e),
          title: u.e.title || u.e.name || 'untitled',
          sub: u.e.subtitle || '',
          ongoing: (u.endMs - u.startMs) > 12 * 60 * 60 * 1000,
          source: 'events',
        });
      }
    }
  }
  const seenUp = new Set(eventsToday.map((it) => (it.title || '').toLowerCase().trim()));
  const eventsUpcoming = [];
  for (const off of [...upByDay.keys()].sort((a, b) => a - b)) {
    if (eventsUpcoming.length >= UP_MAX) break;
    const dayItems = upByDay.get(off).sort((a, b) =>
      (a.time ? 1 : 0) - (b.time ? 1 : 0) || String(a.time).localeCompare(String(b.time)));
    for (const it of dayItems) {
      const k = (it.title || '').toLowerCase().trim();
      if (!k || seenUp.has(k)) continue;
      seenUp.add(k);
      eventsUpcoming.push(it);
      if (eventsUpcoming.length >= UP_MAX) break;
    }
  }

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
      onboardingSkipped: hasSkippedIdentityOnboarding(),
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
      eventsUpcoming,
    },
    asks: {
      openAskCount: String(openAsks),
      myAskCount: String(myAsks),
      asksList: asks,
      peopleList: people,
      askIdentity,
    },
    // Roster passed through so the membrane's incoming-watch can greet
    // arrivals / returns (a people diff — the calendar grid has no attendees).
    people,
    // Prefer the build-time feed bundled in the surface (full, stable);
    // fall back to the live builder if it's somehow absent.
    feed: (Array.isArray(c.whats_new) && c.whats_new.length) ? c.whats_new : buildWhatsNewFeed(c),
  };
}

// Bridge from membrane panels → alchemy rail navigation. Lets the panel
// "open network →" / "open calendar →" buttons jump into the legacy mode.
// Public hook used by membrane/index.js.
window.__srwkAlchemyJump = function alchemyJumpFromMembrane(mode, opts) {
  if (mode === "collab") {
    clearDetailForNavigation();
    state.mode = "constellation";
    state.constellationMode = "collab";
    try {
      localStorage.setItem(ALCHEMY_LS_KEY, "constellation");
      localStorage.setItem(CONST_MODE_LS_KEY, "collab");
    } catch {}
    syncRailSelection();
    render();
    return;
  }
  // intel lives inside the context page now — jump to its view there.
  if (mode === "intel") { mode = "context"; opts = { ...(opts || {}), contextView: opts?.contextView || "signals" }; }
  if (!ALCHEMY_MODES.includes(mode)) return;
  clearDetailForNavigation();
  state.mode = mode;
  if (mode === "context" && opts && opts.contextView) {
    state.contextVault.mode = contextNormalizeView(opts.contextView);
    try { localStorage.setItem(CONTEXT_VIEW_LS_KEY, state.contextVault.mode); } catch {}
  }
  // Optional: land on a calendar sub-view ("cal" grid | "presence" gantt).
  // Used by the dossier explore rows ("calendar" / "availability").
  if (mode === "calendar" && opts && opts.calendarView) {
    state.calendar.view = opts.calendarView === "presence" ? "presence" : "cal";
  }
  // Optional one-shot focus for the presence gantt: a dossier's
  // "availability" jump names the person (or team) it came from; the
  // gantt scrolls there and rings the row(s). Consumed on first paint.
  if (mode === "calendar" && opts && (opts.presencePeople || opts.presenceTeam)) {
    state.calendar.presenceFocus = {
      people: Array.isArray(opts.presencePeople) ? opts.presencePeople : [],
      team: opts.presenceTeam || null,
      at: Date.now(),       // focus expires — see applyPresenceFocus
      applied: false,       // scroll only on the first application
    };
  }
  // Optional: land on a specific constellation sub-view (clusters /
  // dependencies / journey / collab). Used by the cohort panel's view cards.
  if (mode === "constellation" && opts && opts.constellationMode) {
    const m = constNormalizeConstellationMode(opts.constellationMode);
    if (m === "circle" || m === "ring") {
      state.constellationMode = "ring";
    } else {
      state.constellationMode = m;   // "journey" | "map" | "ring" | "stack" | "collab"
    }
    if (["clusters", "wells", "dependencies", "source"].includes(String(opts.constellationMode || "").toLowerCase())) {
      state.constellationLens = constNormalizeConstellationLens(opts.constellationMode);
    }
    try {
      localStorage.setItem(CONST_MODE_LS_KEY, state.constellationMode);
      localStorage.setItem(CONST_LENS_LS_KEY, state.constellationLens);
    } catch {}
  }
  if (mode === "asks" && opts && opts.openComposer) {
    state.openAskComposer = true;
  }
  try { localStorage.setItem(ALCHEMY_LS_KEY, state.mode); } catch {}
  syncRailSelection();
  render();
};

// Jump straight to a specific record's detail page in the legacy view.
// Used by the self panel's "connections" list — clicking a peer opens
// their profile in the cohort surface (shapes mode with detail page).
window.__srwkAlchemyShowRecord = function showRecordFromMembrane(recordId, returnMode = 'shapes') {
  if (!recordId) return;
  openDetail(recordId, returnMode);
};

// Display id "SHAPE-NN" from the team's index in the array.
function displayId(idx) {
  return String(idx + 1).padStart(2, "0");
}

// ─── legend ──────────────────────────────────────────────────────────
function renderLegend() {
  const teams = state.cohort.teams;
  const weekNow = currentProgramWeek();
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
      <p class="alch-legend-sub">Six shapes. Every team enters in one and rotates through others over the program. Count is at week ${weekNow}.</p>
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
  { id: "cohort",   label: "cohort teams",  hint: "formally invited cohort teams", match: (t) => (t.membership || "visiting") === "cohort" },
  { id: "visiting", label: "visiting",      hint: "guests and friends of the program", match: (t) => (t.membership || "visiting") !== "cohort" },
  { id: "all",      label: "all",           hint: "every team and project", match: () => true },
];
const PERSON_ROLE_CHIPS = [
  { id: "cohort-member",    label: "cohort members",    hint: "people on cohort teams", match: (p) => (p.role_class || "visiting-scholar") === "cohort-member" },
  { id: "visiting-scholar", label: "visiting scholars", hint: "independent visiting scholars", match: (p) => (p.role_class || "visiting-scholar") === "visiting-scholar" },
  { id: "coordinator",      label: "coordinators",      hint: "program coordinators", match: (p) => (p.role_class || "visiting-scholar") === "coordinator" },
  { id: "all",              label: "all",               hint: "everyone in the directory", match: () => true },
];

// (The generated read-clause sub-lines were removed — views are "filter +
// visual" only; momentum insight lives in the chart.)

function renderShapes() {
  // Timeline-aware: "as of [week]" rewinds the roster to that snapshot's surface
  // (Total = today's live cohort). Same machinery the constellation views use.
  const cohort = activeConstellationCohort();
  const allTeams  = cohort.teams  || [];
  const allPeople = cohort.people || [];
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
  // Sentence bar — "listing teams & projects · cohort teams 32". The kind token
  // carries NO count (the full-pool counts live in its menu); only the membership
  // token shows a count, because that one equals the cards on screen. Both are
  // stateful tokens whose menus carry each bucket's count + a one-line meaning.
  const kindUnit = constSentenceUnit({
    menu: "dir-kind",
    ariaMenu: "directory kind",
    token: constSentenceToken({
      menu: "dir-kind",
      label: filter === "people" ? "individuals" : "teams & projects",
      count: null,
      aria: `kind: ${filter === "people" ? "individuals" : "teams & projects"} — change what is listed`,
    }),
    options: [
      constSentenceOption({ attr: "data-shapes-filter", value: "works", selected: filter !== "people", label: "teams & projects", note: "every team and project, side projects included", count: nWorks }),
      constSentenceOption({ attr: "data-shapes-filter", value: "people", selected: filter === "people", label: "individuals", note: "everyone on and around the teams", count: nPeople }),
    ].join(""),
  });
  const memberUnit = constSentenceUnit({
    menu: "dir-membership",
    ariaMenu: "membership filter",
    token: constSentenceToken({
      menu: "dir-membership",
      label: activeChip.label,
      count: counts.get(activeChip.id) || 0,
      aria: `membership: ${activeChip.label} — change which records show`,
    }),
    options: chipSet.map(chip => constSentenceOption({
      attr: "data-membership-filter", value: chip.id, selected: chip.id === activeChip.id,
      label: chip.label, note: chip.hint, count: counts.get(chip.id) || 0,
      empty: (counts.get(chip.id) || 0) === 0,
    })).join(""),
  });
  const chips = `
    <div class="alch-view-controls" data-shape-occluder>
      ${constTimelineDropdownHtml()}
      <div class="ac-sentence" role="group" aria-label="directory filters">
        <span class="ac-sent-word">listing</span>
        ${kindUnit}
        <span class="ac-sent-word">·</span>
        ${memberUnit}
      </div>
      <button id="dossier-export-png" class="alch-shapes-chip" type="button" title="render the full cohort roster as a PNG (ignores the filters above)">export full roster (png)</button>
    </div>
  `;
  const cardCtx = { people: cohort.people || [], teams: cohort.teams || [] };
  const cards = records.map((r, idx) => {
    if (r._kind === "person") return personCardHtml(r, idx, cardCtx);
    return teamCardHtml(r, idx, cardCtx);
  }).join("");
  const emptyMsg = `no ${escHtml(activeChip.label)} yet.`;
  const grid = records.length
    ? `<div class="alch-specimens">${cards}</div>`
    : `<p class="alch-pf-pick">${emptyMsg}</p>`;
  state.canvas.innerHTML = `
    <div class="alch-cohort-page" data-cohort-view="directory">
      ${cohortPageHead("directory")}
      ${chips}
      ${grid}
    </div>
  `;
  // Sentence tokens (kind + membership) open their menus.
  wireConstSentenceTokens();
  // Wire the kind options. Switching kind resets the membership
  // selection to the new kind's default (cohort / cohort-member).
  for (const btn of state.canvas.querySelectorAll("[data-shapes-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.shapesFilter;
      if (next === state.shapesKindFilter) { closeConstSentenceMenus(); return; }
      state.shapesKindFilter = next;
      const nextChipSet = next === "people" ? PERSON_ROLE_CHIPS : TEAM_MEMBERSHIP_CHIPS;
      state.shapesMembershipFilter = nextChipSet[0].id;
      renderShapes();
      wireShapeCardClicks();   // renderShapes() rebinds chips, not card→openDetail; re-wire after filter switch
    });
  }
  // Wire the membership options.
  for (const btn of state.canvas.querySelectorAll("[data-membership-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.membershipFilter;
      if (next === state.shapesMembershipFilter) { closeConstSentenceMenus(); return; }
      state.shapesMembershipFilter = next;
      renderShapes();
      wireShapeCardClicks();   // re-wire cards after membership-filter switch (see note above)
    });
  }
  // Wire the dossier export button.
  const dossierBtn = document.getElementById("dossier-export-png");
  if (dossierBtn) dossierBtn.addEventListener("click", exportDossier);
  // Wire the cohort view nav (directory ↔ constellation views). Wired here
  // rather than in renderModeContent because renderShapes re-renders itself
  // on filter-chip clicks and the nav must survive those repaints.
  wireConstellationModeNav();
}

// teamCardHtml / personCardHtml live in @shape-rotator/shape-ui now.
// The Electron renderer keeps the same call sites — see imports above.

// ─── pulse ───────────────────────────────────────────────────────────
function renderPulse() {
  const teams = state.cohort.teams;
  const weekNow = currentProgramWeek();
  const weekHeaders = Array.from({ length: WEEKS_TOTAL }, (_, i) =>
    `<span>w${String(i + 1).padStart(2, "0")}</span>`).join("");
  const rows = teams.map((t, idx) => {
    const bars = Array.from({ length: WEEKS_TOTAL }, (_, i) => {
      const week = i + 1;
      const v = pulseValue(t.record_id || displayId(idx), week);
      const future = week > weekNow;
      const isNow = week === weekNow;
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
    Per-team weekly activity. Bars are seeded-random for now — wire real signals (commits, posts, peer-search hits) by replacing <code>pulseValue()</code>. The cyan bar marks the current cohort week (w${String(weekNow).padStart(2, "0")}).</p>
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

// At-rest name labels for the journey scatter. Every dot that can carry its
// name without colliding with a neighbour's label (or covering another dot)
// gets one — assessed and larger reads place first, the rest keep their
// hover/focus label. Candidates per dot: above, below, right, left.
// Widths are estimated (8px mono uppercase + 0.12em tracking ≈ 5.9px/char);
// the dark stroke halo on .ac-jnode-label absorbs the estimate's slack.
function journeyPlaceLabels(nodes, { W, padT, plotH }) {
  const CHAR_W = 5.9, LBL_H = 9, GAP = 2;
  const out = new Map();
  const blockers = nodes.map(nd => ({ x1: nd.cx - nd.r, x2: nd.cx + nd.r, y1: nd.cy - nd.r, y2: nd.cy + nd.r }));
  const overlaps = (a, b) => !(a.x1 > b.x2 + GAP || a.x2 < b.x1 - GAP || a.y1 > b.y2 + GAP || a.y2 < b.y1 - GAP);
  const order = nodes.slice().sort((a, b) =>
    ((b.assessed ? 1 : 0) - (a.assessed ? 1 : 0))
    || (b.r - a.r)
    || constText(a.t.name || a.t.record_id).localeCompare(constText(b.t.name || b.t.record_id)));
  for (const nd of order) {
    const name = constText(nd.t.name || nd.t.record_id);
    if (!name) continue;
    const w = name.length * CHAR_W + 2;
    const candidates = [
      { x: 0, y: -nd.r - 8, anchor: "middle", x1: nd.cx - w / 2, x2: nd.cx + w / 2, y1: nd.cy - nd.r - 8 - LBL_H, y2: nd.cy - nd.r - 8 },
      { x: 0, y: nd.r + 13, anchor: "middle", x1: nd.cx - w / 2, x2: nd.cx + w / 2, y1: nd.cy + nd.r + 13 - LBL_H, y2: nd.cy + nd.r + 13 },
      { x: nd.r + 6, y: 3, anchor: "start", x1: nd.cx + nd.r + 6, x2: nd.cx + nd.r + 6 + w, y1: nd.cy + 3 - LBL_H, y2: nd.cy + 3 },
      { x: -nd.r - 6, y: 3, anchor: "end", x1: nd.cx - nd.r - 6 - w, x2: nd.cx - nd.r - 6, y1: nd.cy + 3 - LBL_H, y2: nd.cy + 3 },
    ];
    for (const c of candidates) {
      if (c.x1 < 4 || c.x2 > W - 4 || c.y1 < padT - 16 || c.y2 > padT + plotH + 4) continue;
      if (blockers.some(rect => overlaps(rect, c))) continue;
      out.set(nd.t.record_id, { x: c.x, y: c.y, anchor: c.anchor });
      blockers.push(c);
      break;
    }
  }
  return out;
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
// Top-level constellation questions:
// map = what world is this in and what does this line claim?
//   map layouts: wells = ecosystem placement; ring = who bridges worlds.
// journey = where is the product-market-fit journey?
// stack = where does the project enter the product/market stack?
// targets = what stage gap still has to close?
// shipped = what did teams say / do / ship, per engine-generated cards?
// collab = who can unblock whom?
// The cohort page's views. "directory" is the roster grid (shapes mode);
// the rest are the constellation perspectives on the same records. One
// page, five ways of understanding the cohort.
const CONST_VIEWS = [
  { mode: "directory", glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>', label: "directory", hint: "teams, projects, people" },
  { mode: "map",     glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" x2="15.42" y1="13.51" y2="17.49"/><line x1="15.41" x2="8.59" y1="6.51" y2="10.49"/></svg>', label: "relationship map", hint: "declared links by ecosystem" },
  { mode: "journey", glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>', label: "pmf evidence", hint: "market-fit signal coverage" },
  { mode: "stack",   glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>', label: "standing", hint: "status + gap to target" },
  // "targets" folded into "standing" as a projection toggle (2026-06): same
  // goal model, same chips — it was a second tab for one dataset. The gap view
  // is now the "gap to target" toggle inside standing. Mode kept valid in
  // constNormalizeConstellationMode so old deep-links still resolve.
  { mode: "shipped", glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>', label: "say / did / shipped", hint: "intent vs public proof" },
  { mode: "collab",  glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/></svg>', label: "collab board", hint: "asks, offers, dependencies" },
];
function constNormalizeConstellationMode(raw) {
  const mode = String(raw || "").toLowerCase();
  // The node-link "ring"/"map" layouts are retired in favour of the nested
  // bubble map; old saved state and deep-links resolve to the relationship map.
  if (mode === "circle" || mode === "ring" || mode === "wells" || mode === "clusters" || mode === "dependencies" || mode === "source") return "map";
  if (mode === "journey" || mode === "stack" || mode === "targets" || mode === "shipped" || mode === "collab") return mode;
  return "map";
}
function constellationNav(active) {
  const activeTop = active === "directory"
    ? "directory"
    : (constNormalizeConstellationMode(active) === "ring" ? "map" : constNormalizeConstellationMode(active));
  return `
    <nav class="alch-page-views" role="tablist" aria-label="cohort view">
      ${CONST_VIEWS.map(v => `
        <button class="alch-page-view-btn" data-const-mode="${v.mode}" role="tab" aria-selected="${activeTop === v.mode}" tabindex="${activeTop === v.mode ? "0" : "-1"}" aria-label="${escAttr(`${v.label}: ${v.hint}`)}" title="${escAttr(v.hint)}" type="button">
          <span class="apv-glyph" aria-hidden="true">${v.glyph}</span><span class="apv-label">${v.label}</span>
        </button>`).join("")}
    </nav>`;
}

// Shared page header — same structure on the cohort and context pages so
// the OS's two "understanding" surfaces read as one design. `side` is
// optional per-view meta or actions (kept to one quiet element at rest).
function pageHeadHtml({ kicker, title, dek, side = "", nav = "" }) {
  // Strip-style header: the rail names the page and — by house rule — each
  // view's description lives WITH its filter (the sentence bar IS the heading),
  // not as a separate stacked dek line. So kicker/title/dek are accepted for
  // call-site compatibility but intentionally not rendered; only per-view side
  // actions + the view nav show. (A separate dek line was tried and pulled: it
  // added ~3 lines of vertical chrome and duplicated the filter sentence.)
  void kicker; void title; void dek;
  return `
    <div class="alch-page-headgroup">
      ${side ? `<div class="alch-page-intro"><div class="alch-page-head-side">${side}</div></div>` : ""}
      ${nav}
    </div>`;
}

function cohortPageHead(view, { side = "" } = {}) {
  // No dek/title: by house rule each view's description lives WITH its filter
  // (the sentence bar IS the heading); pageHeadHtml renders only side + nav.
  return pageHeadHtml({ side, nav: constellationNav(view) });
}

// Cross-view selection cue. state.constSelection survives view switches by
// design (select a team on the map, see where it sits on pmf evidence) —
// but a selection you can't see is a trap, so every constellation view
// renders the same chip: who is selected, one click to clear. The chip is
// also the discoverable sibling of the Escape shortcut.
function constSelectionChipHtml() {
  const sel = state.constSelection;
  if (!sel) return "";
  const cohort = activeConstellationCohort();
  let name;
  if (sel.type === "edge") {
    // An edge pinned on the map is otherwise invisible (and unclearable) on
    // the journey/stack views that show no inspector — exactly the trap this
    // chip exists to prevent. Resolve both endpoints to a "from → to" label.
    const teams = cohort?.teams || [];
    const fromName = teams.find(t => t.record_id === sel.from)?.name || sel.from || "source";
    const toName = teams.find(t => t.record_id === sel.to)?.name || sel.to || "target";
    name = `${fromName} → ${toName}`;
  } else if (sel.type === "team" || sel.type === "person") {
    const rec = sel.type === "person"
      ? (cohort?.people || []).find(p => p.record_id === sel.rid)
      : (cohort?.teams || []).find(t => t.record_id === sel.rid);
    name = rec?.name || sel.rid;
  } else {
    return "";
  }
  return `
    <button type="button" class="ac-selection-chip" data-const-clear-selection aria-label="${escAttr(`clear selection: ${name}`)}">
      <span>selected</span><strong>${escHtml(name)}</strong><i aria-hidden="true">×</i>
    </button>`;
}

// "As of [Total ▾]" timeline selector — shown on every cohort view. Total =
// today's overall (live) surface; the rest rewind the WHOLE cohort to a weekly
// snapshot via the existing snapshot machinery (activeConstellationCohort).
// Built on the sentence-token chrome so it reads as one control with the rest.
// Today only relationships vary across the bundled snapshots; real per-week
// journey/standing data is meant to be populated from Supabase — when it is,
// the goal views animate week-to-week with no further wiring.
function constTimelineDropdownHtml() {
  const snapshots = constellationSnapshots();
  const last = snapshots.length - 1;
  const idx = snapshots.length ? ensureConstellationTimelineIdx() : null;
  const isTotal = idx == null || idx >= last;
  const curLabel = isTotal ? "Total" : (snapshots[idx]?.label || snapshots[idx]?.id || "week");
  const opt = (value, label, note, selected) => `
        <button type="button" class="ac-sent-opt" data-const-timeline="${escAttr(String(value))}" role="option" aria-selected="${selected ? "true" : "false"}">
          <span class="ac-sent-opt-main"><b>${escHtml(label)}</b>${note ? `<small>${escHtml(note)}</small>` : ""}</span>
        </button>`;
  let options = opt(snapshots.length ? last : "total", "Total", "today’s overall view", isTotal);
  for (let i = 0; i < last; i++) {
    options += opt(i, snapshots[i].label || snapshots[i].id, timelineSnapshotDate(snapshots[i]), !isTotal && idx === i);
  }
  const clock = '<svg class="ac-tl-glyph" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
  return `
    <span class="ac-timeline-ctl">
      <span class="ac-sent-word">as of</span>
      <span class="ac-sent-unit ac-timeline-unit">
        <button type="button" class="ac-sent-tok ac-timeline-tok${isTotal ? "" : " is-rewound"}" data-sent-menu="timeline" aria-haspopup="listbox" aria-expanded="false" aria-label="${escAttr(`viewing ${curLabel} — rewind the cohort to a week`)}">
          ${clock}<span>${escHtml(curLabel)}</span><i class="ac-sent-chev" aria-hidden="true"></i>
        </button>
        <div class="ac-sent-menu" data-sent-menu-for="timeline" role="listbox" aria-label="cohort timeline" hidden>${options}</div>
      </span>
    </span>`;
}

const CONST_MAP_LAYOUTS = [
  { mode: "map", label: "ecosystems", hint: "grouped into the ecosystem each builds on" },
  { mode: "ring", label: "ring", hint: "all relationship lines" },
];
const CONST_NETWORK_SCOPES = [
  { scope: "projects", label: "projects", hint: "team / project relationships (this map)" },
  { scope: "people", label: "people", hint: "switch to the person-to-person network" },
];
function constNormalizeNetworkScope(raw) {
  return String(raw || "").toLowerCase() === "people" ? "people" : "projects";
}
// Bubble-map grain: fewer↔more circles. Replaces the old map/ring layout
// toggle in the sentence bar — same control slot, different question.
const CONST_GRANULARITIES = [
  { key: "themes", label: "themes", hint: "a few big spaces (high level)" },
  { key: "clusters", label: "clusters", hint: "ecosystem groupings (default)" },
  { key: "skills", label: "skills", hint: "many fine spaces (low level)" },
];
function constNormalizeGranularity(raw) {
  const g = String(raw || "").toLowerCase();
  return (g === "themes" || g === "clusters" || g === "skills") ? g : "clusters";
}
function constNormalizeEdgeTier(raw) {
  const tier = String(raw || "").toLowerCase();
  return tier === "record" || tier === "mention" ? tier : "all";
}
const CONST_PEOPLE_LINK_FILTERS = [
  {
    key: "same-team",
    label: "same project",
    note: "same primary project group",
    kinds: ["same-team"],
    swatch: "is-people-same",
  },
  {
    key: "profile",
    label: "profile overlap",
    note: "secondary project or pair_with fields",
    kinds: ["secondary-overlap", "pair-with"],
    swatch: "is-people-profile",
  },
  {
    key: "shared-context",
    label: "shared context",
    note: "shared declared skills, themes, or work context",
    kinds: ["shared-context"],
    swatch: "is-people-shared",
  },
];
const CONST_PEOPLE_LINK_KEYS = CONST_PEOPLE_LINK_FILTERS.map(spec => spec.key);
function constNormalizePeopleLinkFilter(raw) {
  const key = String(raw || "").toLowerCase();
  return CONST_PEOPLE_LINK_KEYS.includes(key) ? key : "all";
}
function constPeopleLinkSpec(key) {
  return CONST_PEOPLE_LINK_FILTERS.find(spec => spec.key === key) || null;
}
function constPeopleLinkFamily(kind) {
  const k = String(kind || "");
  if (k === "same-team") return "same-team";
  if (k === "secondary-overlap" || k === "pair-with") return "profile";
  if (k === "shared-context") return "shared-context";
  return "all";
}
function constPeopleLinkCounts(edges = []) {
  const counts = Object.fromEntries(CONST_PEOPLE_LINK_FILTERS.map(spec => [spec.key, 0]));
  for (const edge of Array.isArray(edges) ? edges : []) {
    const family = constPeopleLinkFamily(edge?.kind);
    if (family !== "all" && Object.prototype.hasOwnProperty.call(counts, family)) counts[family]++;
  }
  counts.total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return counts;
}

// ── Sentence bar ─────────────────────────────────────────────────────
// The view controls read as one sentence — "showing projects as wells ·
// lined by all 76 · backed by 9 on record + 67 unconfirmed" — so the bar
// IS the claim the map below is making. Each swappable word is a stateful
// token (label = trigger = current value) whose listbox carries every
// option's consequence (hint + live count), surfacing the copy that used
// to hide in aria-labels. The two evidence chips absorb the old LINE
// SOURCE legend: hover previews that tier (CSS :has, as before), click
// pins it (data-edge-tier on the stage). Options reuse the same
// data-const-* attributes the old segmented buttons carried, so the
// wireConstellationHover state handlers are unchanged.
function constSentenceToken({ menu, label, count, aria }) {
  return `
    <button type="button" class="ac-sent-tok" data-sent-menu="${escAttr(menu)}" aria-haspopup="listbox" aria-expanded="false" aria-label="${escAttr(aria)}">
      <span>${escHtml(label)}</span>${count == null ? "" : `<em>${escHtml(String(count))}</em>`}<i class="ac-sent-chev" aria-hidden="true"></i>
    </button>`;
}
function constSentenceOption({ attr, value, selected, label, note, count, empty }) {
  return `
    <button type="button" class="ac-sent-opt${empty ? " is-empty" : ""}" ${attr}="${escAttr(value)}" role="option" aria-selected="${selected ? "true" : "false"}">
      <span class="ac-sent-opt-main"><b>${escHtml(label)}</b>${note ? `<small>${escHtml(note)}</small>` : ""}</span>
      ${count == null ? "" : `<em>${escHtml(String(count))}</em>`}
    </button>`;
}
function constSentenceUnit({ menu, token, ariaMenu, options }) {
  return `
    <span class="ac-sent-unit">
      ${token}
      <div class="ac-sent-menu" data-sent-menu-for="${escAttr(menu)}" role="listbox" aria-label="${escAttr(ariaMenu)}" hidden>${options}</div>
    </span>`;
}
function constellationSentenceBar({ view = "bubble", scope = "projects", granularity = "clusters", lens = "all", metrics = {}, tier = "all", peopleLinkFilter = "all" } = {}) {
  void view; void lens; void metrics; void tier;
  const activeScope = constNormalizeNetworkScope(scope);
  const scopeUnit = constSentenceUnit({
    menu: "scope",
    ariaMenu: "graph entity layer",
    token: constSentenceToken({ menu: "scope", label: activeScope, aria: `graph: ${activeScope} — change entity layer` }),
    options: CONST_NETWORK_SCOPES.map(v => constSentenceOption({
      attr: "data-const-network-scope", value: v.scope, selected: v.scope === activeScope,
      label: v.label, note: v.hint,
    })).join(""),
  });
  // People network uses the same consolidated key-as-filter pattern as the
  // project map. These chips are not decoration: hover previews the link
  // family, click pins it, and the counts say what the filter will isolate.
  if (activeScope === "people") {
    const activePeopleLink = constNormalizePeopleLinkFilter(peopleLinkFilter);
    const linkCounts = metrics.peopleLinkCounts || constPeopleLinkCounts([]);
    const linkChip = (spec) => {
      const count = Number(linkCounts[spec.key]) || 0;
      const pressed = activePeopleLink === spec.key;
      return `
        <button type="button" class="ac-sent-evi is-people-link ${spec.swatch}" data-legend-link="${escAttr(spec.key)}" data-people-link-toggle="${escAttr(spec.key)}" aria-pressed="${pressed ? "true" : "false"}" aria-label="${escAttr(`${spec.label}: ${count} ${spec.note}${pressed ? " — pinned; click to show all people links" : " — hover previews, click isolates"}`)}">
          <i aria-hidden="true"></i><em>${escHtml(String(count))}</em><span class="ac-sent-evi-label">${escHtml(spec.label)}</span>
        </button>`;
    };
    return `
      <div class="ac-sentence" role="group" aria-label="people map filters">
        <span class="ac-sent-word">showing</span>
        ${scopeUnit}
        <span class="ac-sent-word">· linked by</span>
        ${CONST_PEOPLE_LINK_FILTERS.map(linkChip).join("")}
      </div>`;
  }
  const activeGran = constNormalizeGranularity(granularity);
  const granSpec = CONST_GRANULARITIES.find(g => g.key === activeGran) || CONST_GRANULARITIES[1];
  const granUnit = constSentenceUnit({
    menu: "granularity",
    ariaMenu: "bubble map granularity",
    token: constSentenceToken({ menu: "granularity", label: granSpec.label, aria: `grouped by ${granSpec.label} — change how many spaces` }),
    options: CONST_GRANULARITIES.map(g => constSentenceOption({
      attr: "data-const-granularity", value: g.key, selected: g.key === activeGran,
      label: g.label, note: g.hint,
    })).join(""),
  });
  // The bubble map has no edges, so the old line lens + record/mention tier
  // chips are gone; the only verb is grain, and a quiet legend names what the
  // visual channels mean (size / shade / colour).
  return `
    <div class="ac-sentence" role="group" aria-label="bubble map controls">
      <span class="ac-sent-word">showing</span>
      ${scopeUnit}
      <span class="ac-sent-word">grouped by</span>
      ${granUnit}
      <span class="ac-sent-legend">size <b>maturity</b> · shade <b>depended-on</b> · ${[["tee", "tee"], ["ai", "ai"], ["crypto", "crypto"], ["app-ux", "ux"]].map(([k, lbl]) => `<i class="ac-dom-sw" style="background:${EGO_DOMAIN_FILL[k]}" aria-hidden="true"></i>${lbl}`).join(" ")}</span>
    </div>`;
}
// Multi-select include chip (journey's teams/projects/side toggles): the
// oxide state dot carries on/off — the same vocabulary the old ajf-toggle
// used — so three chips at rest don't read as three raised thumbs.
function constSentenceIncludeChip({ attr, value, on, label, count, aria }) {
  return `
    <button type="button" class="ac-sent-evi is-include" ${attr}="${escAttr(value)}" aria-pressed="${on ? "true" : "false"}" aria-label="${escAttr(aria)}">
      <i class="ac-sent-dot" aria-hidden="true"></i><em>${escHtml(String(count))}</em>&nbsp;${escHtml(label)}
    </button>`;
}
function closeConstSentenceMenus() {
  for (const menu of document.querySelectorAll(".ac-sent-menu:not([hidden])")) menu.hidden = true;
  for (const tok of document.querySelectorAll('.ac-sent-tok[aria-expanded="true"]')) tok.setAttribute("aria-expanded", "false");
}
// Token open/close for every sentence bar. Each cohort view re-renders its
// own controls, so this is called from wireConstellationHover (map/ring/
// journey/stack/people), wireCollab, and renderShapes.
function wireConstSentenceTokens() {
  for (const tok of state.canvas.querySelectorAll(".ac-sent-tok[data-sent-menu]")) {
    tok.addEventListener("click", () => {
      const menu = tok.closest(".ac-sent-unit")?.querySelector(".ac-sent-menu");
      if (!menu) return;
      const wasOpen = !menu.hidden;
      closeConstSentenceMenus();
      if (wasOpen) return;
      menu.hidden = false;
      tok.setAttribute("aria-expanded", "true");
      menu.querySelector('[role="option"][aria-selected="true"]')?.focus();
    });
  }
  // Timeline dropdown options ("Total" + each weekly snapshot). The menu
  // open/close is handled by the loop above (shared chrome); selecting an
  // option rewinds the whole cohort surface via setConstellationTimelineIdx.
  for (const opt of state.canvas.querySelectorAll("[data-const-timeline]")) {
    opt.addEventListener("click", () => {
      closeConstSentenceMenus();
      setConstellationTimelineIdx(opt.dataset.constTimeline);
    });
  }
  wireConstSentenceDismiss();
}
let constSentenceDismissBound = false;
function wireConstSentenceDismiss() {
  if (constSentenceDismissBound) return;
  constSentenceDismissBound = true;
  document.addEventListener("pointerdown", (e) => {
    if (e.target instanceof Element && e.target.closest(".ac-sent-unit")) return;
    closeConstSentenceMenus();
  });
  // Close on focus-leave: tabbing past the last option moves focus out of
  // the unit while the absolutely-positioned listbox would otherwise stay
  // open over the content (and aria-expanded stuck true). Keep open only
  // while focus stays inside the OPEN menu's own unit (token <-> options);
  // moving to a different unit or off the bar closes it.
  document.addEventListener("focusout", (e) => {
    const openMenu = document.querySelector(".ac-sent-menu:not([hidden])");
    if (!openMenu) return;
    const unit = openMenu.closest(".ac-sent-unit");
    const next = e.relatedTarget;
    if (next instanceof Element && unit && unit.contains(next)) return;
    closeConstSentenceMenus();
  });
  // Capture phase so closing an open menu wins over the bubble-phase
  // Escape shortcut that clears the constellation selection.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const open = document.querySelector(".ac-sent-menu:not([hidden])");
    if (!open) return;
    const tok = open.closest(".ac-sent-unit")?.querySelector(".ac-sent-tok");
    closeConstSentenceMenus();
    tok?.focus();
    e.preventDefault();
    e.stopPropagation();
  }, true);
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
  // private-vault citations reference raw transcripts held outside the
  // public repo — provenance label only, never a public link.
  if (/^private-vault:/i.test(raw)) return "";
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
  // Don't leak the raw vault id ("private-vault:shape-rotator-…-2026-05-22")
  // into the panel — show a clean provenance label with just the date.
  let label = source;
  if (/^private-vault:/i.test(source)) {
    const date = (source.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    label = date ? `private transcript · ${date}` : "private transcript";
  }
  return href
    ? `<a class="ac-source-link" href="${escAttr(href)}" data-external>${escHtml(label)}</a>`
    : `<small>${escHtml(label)}</small>`;
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
    : `<p class="ac-inspector-empty">no shared skill areas declared by the core teams.</p>`;
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
      <div class="ac-view-summary">
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
          <span>shared skill areas</span>
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
  const assessed = list.filter(journeyAssessed).length;
  return { teams: list.length, edges: edgeList.length, assessed };
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
  const cohort = activeConstellationCohort();
  const teams = cohort?.teams || [];
  const people = cohort?.people || [];
  const clusters = cohort?.clusters || [];
  const teamById = new Map(teams.filter(t => t?.record_id).map(t => [t.record_id, t]));
  const edges = constellationDependencyEdges(teams, teamById, cohort?.dependencies || [])
    .filter(e => teamById.has(e.from) && teamById.has(e.to));
  const model = constellationModel(teams, clusters, cohort?.dependencies || []);
  const ctx = constellationInspectorContext(teams, edges, people);
  const rawMode = constNormalizeConstellationMode(state.constellationMode);
  const baseMode = rawMode === "collab" ? "map" : rawMode;
  const scope = baseMode === "map" ? constNormalizeNetworkScope(state.constellationScope) : "projects";
  // Match renderConstellation: projects map → "bubble" so the live (partial-
  // update) inspector keeps the positional sidebar after hover/refocus.
  const mode = (baseMode === "map" && scope === "projects") ? "bubble" : baseMode;
  const base = { ...ctx, clusters, mode, scope, distributionWells: model.wellsDef, lens: mode === "ring" ? "all" : constNormalizeConstellationLens(state.constellationLens), interest: constInterestContext(teams, clusters, edges, state.constInterest) };
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
  // No keyword hits, no domain boost, no proof/market signal: the source data
  // does not place this team anywhere. Don't fold it into substrate (the
  // lowest-index column) as if it had a real placement — surface it as unplaced.
  if (!primary.score) {
    return {
      key: "unplaced",
      label: "no stack signal yet",
      score: 0,
      secondary: null,
      reason: "profile only — no product-stack signal in declared text",
      unplaced: true,
    };
  }
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
  // No layer-count chip row here: the stack columns below already label
  // every product layer with its count (ac-stack-layer-head), and the
  // sentence bar carries the domain breakdown. The headline names the
  // largest layer; the columns are the breakdown.
  return `
    <section class="ac-main-readout is-stack-readout" aria-label="product stack readout">
      <div class="ac-inspector-kicker">generated stack read</div>
      <h3>${escHtml(title)}</h3>
      <p>${escHtml(body)}</p>
    </section>`;
}


function constStackSelectedReadoutHtml(ctx) {
  const sel = state.constSelection;
  if (sel?.type !== "team") return "";
  const team = ctx?.teamById?.get?.(sel.rid)
    || (activeConstellationCohort()?.teams || []).find(t => t.record_id === sel.rid);
  if (!team) return "";
  const item = constStackItemForTeam(ctx, sel.rid);
  const role = item?.role || constMarketRoleForTeam(team);
  const evidence = item?.evidence || constEvidenceModeForTeam(team, ctx);
  const evidenceRead = evidence.key === "profile"
    ? evidence.label
    : `${evidence.label} · ${String(evidence.value)}/5`;
  return `
    <section class="ac-main-readout is-stack-readout is-selected-readout" aria-label="selected team stack read">
      <div class="ac-inspector-kicker">selected · stack read</div>
      <h3><button type="button" class="ac-inspector-name-link" data-const-open-record="${escAttr(team.record_id)}">${escHtml(team.name || team.record_id)}</button></h3>
      ${role.reason ? `<p>${escHtml(constShortText(role.reason, 150))}</p>` : ""}
      <div class="ac-view-chips">
        <span>layer<em>${escHtml(role.label)}</em></span>
        ${role.secondary ? `<span>also<em>${escHtml(role.secondary.label)}</em></span>` : ""}
        <span>proof<em>${escHtml(evidenceRead)}</em></span>
      </div>
      <p class="ac-readout-hint">click the entry again for the full record · click the name for the directory card</p>
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
  // The readout answers for the SAME claim the map is showing: corridors are
  // scored only over lines the active lens keeps (control-as-claim).
  const lens = constNormalizeConstellationLens(ctx?.lens || "all");
  const rows = new Map();
  for (const edge of (ctx?.edges || [])) {
    if (!constLensMatchesEdge(edge, lens)) continue;
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
  const lens = constNormalizeConstellationLens(ctx?.lens || "all");
  const lensSpec = CONST_LENSES.find(l => l.lens === lens) || CONST_LENSES[0];
  const scoped = lens !== "all";
  // Counts mirror the corridors: both speak for the lens-filtered map, never
  // for lines the user has currently filtered away.
  const lensEdges = (ctx?.edges || []).filter(edge => constLensMatchesEdge(edge, lens));
  const breakdown = constRelationshipBreakdown(lensEdges);
  const corridors = constTopCorridors(ctx, 3);
  const top = corridors[0] || null;
  const title = top
    ? `${top.a.label} to ${top.b.label}`
    : (scoped ? `No ${lensSpec.label} corridors yet` : "Start with the bright lines");
  // The title already names the corridor — the body carries only what the
  // title can't (why it headlines + its evidence mix), never the name again.
  const body = top
    ? `${scoped ? `The strongest ${lensSpec.label} corridor — ${lensSpec.meaning}.` : "The strongest current cross-world corridor from the source bundle."} ${constLineBasisText(top.typed, top.profile)} · ${top.teams.size} teams touched.`
    : (scoped
      ? `No cross-world ${lensSpec.label} lines (${lensSpec.meaning}) connect ecosystems yet. Set lines to all to read every declared corridor.`
      : "No cross-world corridor is strong enough to headline yet; inspect the relationship rows first.");
  // The solid-vs-dotted contract is taught by the sentence bar's evidence chips
  // ("backed by N confirmed + M unconfirmed") and the body's line-basis text, so
  // the readout no longer re-states it — one home for the encoding, not four.
  const caveat = "";
  return { title, body, caveat, top, corridors, breakdown, lens, lensSpec, scoped };
}

function constMapReadoutHeroHtml(ctx, kicker = "generated readout") {
  const read = constMapReadout(ctx);
  const kickerText = read.scoped ? `${kicker} · ${read.lensSpec.label} lines` : kicker;
  // The hero owns corridor #1 outright — claim, evidence mix, AND its inspect
  // action — so the corridor list below starts at #2 instead of restating it.
  const topEdge = read.top?.topEdge;
  return `
    <div class="ac-inspector-hero is-generated-readout">
      <div class="ac-inspector-kicker">${escHtml(kickerText)}</div>
      <h3>${escHtml(read.title)}</h3>
      <p>${escHtml(read.body)}</p>
      ${topEdge ? `
      <div class="ac-inspector-pills">
        <button type="button" class="ac-hero-corridor" data-const-edge-from="${escAttr(topEdge.from)}" data-const-edge-to="${escAttr(topEdge.to)}">inspect corridor →</button>
      </div>` : ""}
      ${read.caveat ? `<p class="ac-rel-queue-more">${escHtml(read.caveat)}</p>` : ""}
    </div>`;
}

function constCorridorReadoutHtml(ctx) {
  // Corridor #1 lives in the hero above (claim + inspect action); this
  // section lists what comes next, so the panel never says a thing twice.
  // It's the panel's only connection list now, so it runs a little deeper.
  const corridors = constTopCorridors(ctx, 6).slice(1);
  const lens = constNormalizeConstellationLens(ctx?.lens || "all");
  const lensSpec = CONST_LENSES.find(l => l.lens === lens) || CONST_LENSES[0];
  const scoped = lens !== "all";
  if (!corridors.length) return "";
  return `
    <section class="ac-inspector-section ac-action-card is-corridor-readout">
      <h4>next corridors${scoped ? ` · ${escHtml(lensSpec.label)} lines` : ""}</h4>
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
  const coverage = constConstellationCoverage(ctx?.teams || [], ctx?.edges || []);
  const missingOwner = (ctx?.edges || []).filter(edge => edge?.normalized && !constText(edge.owner)).length;
  const missingJourney = Math.max(0, coverage.teams - coverage.assessed);
  // Record/mention counts live in the sentence bar's evidence chips now;
  // this section keeps only the coverage gaps shown nowhere else.
  return `
    <section class="ac-inspector-section is-data-coverage">
      <h4>coverage gaps</h4>
      <div class="ac-view-chips">
        <span>missing journey<em>${escHtml(String(missingJourney))}</em></span>
        ${missingOwner ? `<span>missing owner<em>${escHtml(String(missingOwner))}</em></span>` : ""}
      </div>
      <p class="ac-rel-queue-more">Fill these in to turn a lead into a source-backed line — a record needs evidence, an owner, and a next action.</p>
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
  // Name BOTH sides of the match concretely (need + offer) rather than the
  // vague "may offer related help" hedge — and leave detail empty so the
  // action card doesn't reprint the seeking text it already shows.
  if (aNeedsB.length) {
    const seeking = constShortText(aSeeking[0] || "listed help", 80);
    const offering = constShortText(bOffering[0] || "related work", 80);
    return {
      score: aNeedsB.length,
      direction: `${a?.name || a?.record_id} needs ${seeking}; ${b?.name || b?.record_id} offers ${offering}.`,
      detail: "",
    };
  }
  if (bNeedsA.length) {
    const seeking = constShortText(bSeeking[0] || "listed help", 80);
    const offering = constShortText(aOffering[0] || "related work", 80);
    return {
      score: bNeedsA.length,
      direction: `${b?.name || b?.record_id} needs ${seeking}; ${a?.name || a?.record_id} offers ${offering}.`,
      detail: "",
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
          <div class="ac-rel-row is-pair" role="group" aria-label="${escAttr(constPersonDisplayName(row.a) + " and " + constPersonDisplayName(row.b) + " — " + kindLabel(row.edge.kind))}">
            <span class="ac-rel-row-copy">
              <span class="ac-rel-row-top"><strong><button type="button" class="ac-inspector-name-link" data-const-open-record="${escAttr(row.a.record_id)}" aria-label="${escAttr("Open " + constPersonDisplayName(row.a))}">${escHtml(constPersonDisplayName(row.a))}</button> ↔ <button type="button" class="ac-inspector-name-link" data-const-open-record="${escAttr(row.b.record_id)}" aria-label="${escAttr("Open " + constPersonDisplayName(row.b))}">${escHtml(constPersonDisplayName(row.b))}</button></strong><em>${escHtml(kindLabel(row.edge.kind))}</em></span>
              <span class="ac-rel-row-summary">${escHtml(constShortText(row.edge.reason, 130))}</span>
            </span>
          </div>`).join("") : `<p class="ac-inspector-empty">No person-to-person links can be inferred yet.</p>`}
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

// "Where it sits" — the positional read the bubble-map inspector LEADS with:
// maturity, how many teams depend on it, domain, and the spaces it occupies
// (with how crowded each is). The map answers WHERE a team sits in the cohort;
// collab actions (intros, asks/offers, relationship lines) live on the Collab
// board, so the map inspector drops them rather than re-doing that work.
function constTeamPositionHtml(team, ctx) {
  const j = journeyFor(team);
  const stage = Number.isFinite(j?.stage) ? j.stage : null;
  const matWord = stage == null ? "" : (stage <= 2 ? "early" : (stage <= 4 ? "maturing" : "proven"));
  const indeg = (ctx?.inBy?.get(team.record_id) || []).length;
  const domain = CONST_DOMAIN_LABEL[constDomainClass(team.domain)] || "other";
  const spaces = (ctx?.clusters || []).filter(c => Array.isArray(c.teams) && c.teams.includes(team.record_id));
  const rows = [
    ["maturity", stage == null ? "—" : `stage ${stage}${matWord ? ` · ${matWord}` : ""}`],
    ["depended on", `${indeg} team${indeg === 1 ? "" : "s"}`],
    ["domain", domain],
  ];
  const spaceChips = spaces
    .map(c => `<span class="ac-pos-space">${escHtml(c.label || c.name || c.record_id)}<em>${(c.teams || []).length}</em></span>`)
    .join("");
  return `
    <section class="ac-inspector-section ac-position">
      <h4>where it sits</h4>
      <dl class="ac-pos-list">
        ${rows.map(([k, v]) => `<div><dt>${escHtml(k)}</dt><dd>${escHtml(v)}</dd></div>`).join("")}
      </dl>
      ${spaceChips ? `<div class="ac-pos-spaces"><span class="ac-pos-k">spaces</span>${spaceChips}</div>` : `<p class="ac-inspector-empty">Not in a shared space yet.</p>`}
    </section>`;
}

function constTeamInspectorHtml(team, ctx) {
  if (!team) return constellationInspectorDefaultHtml(ctx);
  const isBubble = ctx?.mode === "bubble";
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
  // Only surface evidence rows that actually have content — a "source proof"
  // section of three "none listed" lines is noise that reads as low quality.
  const sourceProofParts = [
    constList(team.traction).length ? constMiniListHtml("traction", team.traction, "", 1) : "",
    constList(team.prior_shipping).length ? constMiniListHtml("shipping", team.prior_shipping, "", 3) : "",
    constList(team.paper_basis).length ? constMiniListHtml("research", team.paper_basis, "", 3) : "",
  ].filter(Boolean);
  const sourceProof = sourceProofParts.join("");
  const transcriptCues = constTranscriptCueListHtml(constTranscriptCuesForTeam(team), "source cues");
  const marketFitBody = assessed
    ? journeyDetailSection(team)
    : `<p class="ac-inspector-note">No explicit PMF journey read yet. Use the relationship and profile evidence above first.</p>`;
  const marketFitSection = ctx?.mode === "stack" ? "" : constInspectorDetailsHtml("PMF evidence", marketFitBody);
  const sourceProofDetails = (ctx?.mode === "stack" || !sourceProof) ? "" : constInspectorDetailsHtml("source proof", sourceProof);
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
      <h3><button type="button" class="ac-inspector-name-link" data-const-open-record="${escAttr(team.record_id)}">${escHtml(team.name || team.record_id)}</button></h3>
      <p>${escHtml(constShortText(currentRole, 150) || "No current focus in profile.")}</p>
      <div class="ac-inspector-pills">
        <span>${escHtml(CONST_DOMAIN_LABEL[constDomainClass(team.domain)] || "other")}</span>
        ${success.map(s => `<span>${escHtml(s)}</span>`).join("")}
      </div>
    </div>
    ${isBubble ? constTeamPositionHtml(team, ctx) : ""}
    <section class="ac-inspector-section ac-overlap-lead">${constEgocentricOverlapSvg(team, ctx)}</section>
    ${constStackPlacementHtml(team, ctx)}
    ${isBubble ? "" : constTeamActionCardHtml(team, ctx)}
    ${constTeamPeopleHtml(team, ctx)}
    ${isBubble ? "" : relationshipDetails}
    ${currentBetSection}
    ${marketFitSection}
    ${transcriptCues}
    ${sourceProofDetails}
    ${isBubble ? `<p class="ac-inspector-note ac-collab-pointer">Intros, asks &amp; offers live on the Collab board.</p>` : ""}`;
}

const EGO_DOMAIN_FILL = { tee: "#C0492E", ai: "#D9913D", crypto: "#9A5BA6", "app-ux": "#3F9B8E", other: "#8a7d75" };
function constEgoNodeFill(team) { return EGO_DOMAIN_FILL[constDomainClass(team?.domain)] || EGO_DOMAIN_FILL.other; }

// Per-company overlap: the selected team centered, every space (cluster) it
// belongs to drawn as an overlapping circle, with co-members placed by how many
// of its spaces they share — the teams in the overlaps (ringed) are its closest
// collaboration-or-collision candidates. This is the multi-membership truth the
// global bubble map must flatten to a single home; here it is restored, scoped
// to one company so a Venn is legible.
function constEgocentricOverlapSvg(team, ctx) {
  const clusters = Array.isArray(ctx?.clusters) ? ctx.clusters : [];
  const rid = team?.record_id;
  const spaces = clusters
    .filter(c => Array.isArray(c.teams) && c.teams.includes(rid))
    .map(c => ({ label: c.label || c.name || c.record_id, members: c.teams.filter(id => id !== rid) }));
  const N = spaces.length;
  if (!N) return `<p class="ac-inspector-note">Not in a shared space yet — overlap appears once ${escHtml(team?.name || "this team")} joins a cluster.</p>`;
  const W = 360, H = 300, CX = 180, CY = 150, D = 54, R = 78;
  const u = spaces.map((_, i) => { const a = (-90 + i * 360 / N) * Math.PI / 180; return [Math.cos(a), Math.sin(a)]; });
  let circles = "";
  for (let i = 0; i < N; i++) {
    const cx = CX + u[i][0] * D, cy = CY + u[i][1] * D;
    const lx = CX + u[i][0] * (D + R + 6), ly = CY + u[i][1] * (D + R + 6);
    const anchor = u[i][0] > 0.3 ? "start" : (u[i][0] < -0.3 ? "end" : "middle");
    circles += `<circle class="ac-ego-space" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${R}"/>`
      + `<text class="ac-ego-space-label" x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${anchor}">${escHtml(constShortText(spaces[i].label, 22))}</text>`;
  }
  const share = new Map();
  spaces.forEach((sp, i) => sp.members.forEach(m => { (share.get(m) || share.set(m, []).get(m)).push(i); }));
  const singlesByPetal = new Map(); const multi = [];
  for (const [m, arr] of share) { if (arr.length === 1) (singlesByPetal.get(arr[0]) || singlesByPetal.set(arr[0], []).get(arr[0])).push(m); else multi.push(m); }
  const dot = (m, x, y, ringed) => {
    const t = ctx?.teamById?.get(m); const nm = t?.name || m;
    const shared = (share.get(m) || []).map(i => spaces[i].label).join(", ");
    return `<g class="ac-ego-node${ringed ? " is-multi" : ""}" data-ego-refocus="${escAttr(m)}" role="button" tabindex="0" aria-label="${escAttr(`focus ${nm}`)}">`
      + (ringed ? `<circle class="ac-ego-ring" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="9.5"/>` : "")
      + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="${constEgoNodeFill(t)}"/>`
      + `<title>${escHtml(`${nm} — shares: ${shared}`)}</title></g>`;
  };
  let nodes = "";
  for (let i = 0; i < N; i++) {
    const all = singlesByPetal.get(i) || []; const list = all.slice(0, 8); const extra = all.length - list.length;
    const a0 = -90 + i * 360 / N;
    list.forEach((m, k) => {
      const spread = Math.min(46, 13 * Math.max(0, list.length - 1));
      const a = (list.length > 1 ? a0 - spread / 2 + spread * k / (list.length - 1) : a0) * Math.PI / 180;
      const rr = D + R * 0.5;
      nodes += dot(m, CX + Math.cos(a) * rr, CY + Math.sin(a) * rr, false);
    });
    if (extra > 0) { const a = a0 * Math.PI / 180, rr = D + R * 0.82; nodes += `<text class="ac-ego-more" x="${(CX + Math.cos(a) * rr).toFixed(1)}" y="${(CY + Math.sin(a) * rr).toFixed(1)}" text-anchor="middle">+${extra}</text>`; }
  }
  multi.forEach((m, k) => {
    let dx = 0, dy = 0; (share.get(m) || []).forEach(i => { dx += u[i][0]; dy += u[i][1]; });
    const len = Math.hypot(dx, dy) || 1; const jr = (k % 2 ? 1 : -1) * 7;
    nodes += dot(m, CX + dx / len * (D * 0.42) + jr, CY + dy / len * (D * 0.42) + (k % 3 - 1) * 8, true);
  });
  const focal = `<g class="ac-ego-focal"><circle class="ac-ego-focal-ring" cx="${CX}" cy="${CY}" r="13"/><circle cx="${CX}" cy="${CY}" r="9" fill="${constEgoNodeFill(team)}"/><text class="ac-ego-focal-label" x="${CX}" y="${CY + 27}" text-anchor="middle">${escHtml(constShortText(team.name || rid, 18))}</text></g>`;
  return `<svg class="ac-ego-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escAttr(`${team.name || rid} overlap across ${N} spaces`)}">${circles}${nodes}${focal}</svg>`
    + `<p class="ac-ego-caption">In ${N} space${N === 1 ? "" : "s"}. ${multi.length} team${multi.length === 1 ? " shares" : "s share"} more than one — its closest collaboration-or-collision candidate${multi.length === 1 ? "" : "s"}.${multi.length ? " Click a co-member to recenter." : ""}</p>`;
}

// Compact hover preview for the side inspector (replaces the floating tooltip
// in the bubble map — one info surface, not two). Identity at a glance; the
// full intersection view is one click away.
function constTeamPreviewHtml(team, ctx) {
  const rid = team.record_id;
  const clusters = Array.isArray(ctx?.clusters) ? ctx.clusters : [];
  const spaces = clusters.filter(c => Array.isArray(c.teams) && c.teams.includes(rid)).map(c => c.label || c.name || c.record_id);
  const dependedOn = (ctx?.inBy?.get(rid) || []).length;
  const stage = team?.journey?.stage;
  const focus = constShortText(team.focus || team.now || "", 130);
  return `
    <div class="ac-inspector-hero is-preview" data-const-team="${escAttr(rid)}">
      <div class="ac-inspector-kicker">hovering — click to pin its intersections</div>
      <h3><button type="button" class="ac-inspector-name-link" data-const-open-record="${escAttr(rid)}">${escHtml(team.name || rid)}</button></h3>
      <div class="ac-inspector-pills">
        <span>${escHtml(CONST_DOMAIN_LABEL[constDomainClass(team.domain)] || "other")}</span>
        ${Number.isFinite(stage) ? `<span>maturity ${escHtml(String(stage))}</span>` : ""}
        <span>${dependedOn} depend on it</span>
      </div>
      ${focus ? `<p>${escHtml(focus)}</p>` : ""}
    </div>
    <div class="ac-preview-spaces">
      <span class="ac-preview-k">in ${spaces.length} space${spaces.length === 1 ? "" : "s"}</span>
      ${spaces.map(s => `<span class="ac-preview-space">${escHtml(constShortText(s, 30))}</span>`).join("")}
    </div>`;
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
  // The kicker already states provenance ("profile mention" / "relationship
  // record"); drop any pill that just restates it (and any duplicate pills) so
  // an unconfirmed edge doesn't print "profile mention" three times.
  const edgeKicker = canonical.normalized ? "relationship record" : "profile mention";
  const edgePills = [meaning.label, status.label, confidenceLabel]
    .map(constText).filter(Boolean)
    .filter(p => !p.toLowerCase().includes(edgeKicker.toLowerCase()))
    .filter((p, i, arr) => arr.findIndex(x => x.toLowerCase() === p.toLowerCase()) === i);
  return `
    <div class="ac-inspector-hero is-edge${canonical.normalized ? " is-source-backed" : " is-profile-link"}">
      <div class="ac-inspector-kicker">${edgeKicker}</div>
      <h3>${escHtml(from.name || from.record_id)} → ${escHtml(to.name || to.record_id)}</h3>
      <p>${escHtml(constShortText(clearAnswer.answer || oneLine, 220))}</p>
      ${edgePills.length ? `<div class="ac-inspector-pills">${edgePills.map(p => `<span>${escHtml(p)}</span>`).join("")}</div>` : ""}
    </div>
    <section class="ac-inspector-section ac-action-card is-line-action">
      <h4>next action</h4>
      <p>${escHtml(constShortText(clearAnswer.next || actionText, 220))}</p>
    </section>
    <section class="ac-inspector-section is-edge-meaning">
      <h4>why this matters</h4>
      <dl class="ac-bet-list">
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
    ${(canonical.normalized && canonical.evidence?.length) ? constInspectorDetailsHtml("source evidence", evidenceBody, true) : ""}
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
      ${constMapReadoutHeroHtml(ctx, "ring readout")}
      ${constCorridorReadoutHtml(ctx)}
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
    // ONE connection story: the hero owns the strongest corridor (claim +
    // inspect), the list continues it (#2+). The old "who should talk next"
    // relationship queue restated the same top pairs by a different scorer —
    // dropped here; it still serves the focused (ecosystem) + fallback panels.
    return `
      ${constMapReadoutHeroHtml(ctx)}
      ${constCorridorReadoutHtml(ctx)}
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
  // The team/person/edge hero (in the body below) already prints the name (or
  // "from → to") as its own heading, so the header would duplicate it in a
  // second type system. Carry the title in the header only for ecosystem-focus,
  // whose is-confidence hero has no name heading. See cohort-click-audit.
  const heroCarriesName = selection?.type === "team" || selection?.type === "person" || selection?.type === "edge";
  return `
    <div class="ac-inspector-status">
      <span>${escHtml(kicker)}</span>
      ${heroCarriesName ? "" : `<strong>${titleHtml}</strong>`}
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
  // Only reserve the off-track "side project" column (stage 0) when some record
  // actually sits there. With none, the column + divider + include-toggle are
  // hidden and the populated stages reclaim that ~11% of plot width.
  const sideEligible = all.some((t) => teamKind(t) !== "person" && journeyFor(t).stage === 0);
  if (!sideEligible) jf.side = true; // toggle is hidden; don't let stale state hide anything
  const teams = all.filter((t) => {
    const j = journeyFor(t);
    const isProject = teamKind(t) === "project";
    if (isProject && !jf.projects) return false;
    if (!isProject && !jf.teams) return false;
    if (j.stage === 0 && !jf.side) return false;
    return true;
  });
  // Bottleneck isolation DIMS non-matching dots (below) rather than removing
  // them — a positional scatter loses its meaning if you drop the field it
  // plots against.
  const bnFocus = jf.bottleneck || null;
  const minStage = sideEligible ? 0 : 1;
  const W = 1120, H = 560;
  // Plot area inset: leave room for axis labels (left = evidence, bottom = stage).
  const PAD_L = 178, PAD_R = 30, PAD_T = 30, PAD_B = 106;
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  // X = stage. Column 0 is "side project" — OFF the main maturity track,
  // set apart by a divider — then stages 1..8 (idea → scale fit). 9 columns.
  // Y = evidence_quality (1..5, higher = up).
  const STAGE_COUNT = JOURNEY_STAGE_LABELS.length; // 9 (0..8)
  const spanStages = STAGE_COUNT - minStage;       // visible columns: 9, or 8 with no side track
  const colW = plotW / spanStages;
  const rowH = plotH / 5;
  const xForStage = (stage) => PAD_L + (stage - minStage + 0.5) * colW;
  const yForEvidence = (ev) => PAD_T + plotH - (ev - 0.5) * rowH;

  // ── grid + axis labels ──
  const gridLines = [];
  for (let i = 0; i <= spanStages; i++) {
    const x = PAD_L + i * colW;
    gridLines.push(`<line class="ac-jgrid" x1="${x.toFixed(1)}" y1="${PAD_T}" x2="${x.toFixed(1)}" y2="${(PAD_T + plotH).toFixed(1)}"/>`);
  }
  for (let i = 0; i <= 5; i++) {
    const y = PAD_T + i * rowH;
    gridLines.push(`<line class="ac-jgrid" x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${(PAD_L + plotW).toFixed(1)}" y2="${y.toFixed(1)}"/>`);
  }
  // Divider between the off-track side-project column (0) and idea (1) — only
  // drawn when the side column is shown.
  if (minStage === 0) {
    const dividerX = PAD_L + colW;
    gridLines.push(`<line class="ac-jdivider" x1="${dividerX.toFixed(1)}" y1="${(PAD_T - 6).toFixed(1)}" x2="${dividerX.toFixed(1)}" y2="${(PAD_T + plotH + 6).toFixed(1)}"/>`);
  }
  const stageAxisLines = [
    ["side", "project"],
    ["1", "idea"],
    ["2", "problem", "discovery"],
    ["3", "problem-", "solution fit"],
    ["4", "mvp / product", "validation"],
    ["5", "early", "traction"],
    ["6", "emerging", "pmf"],
    ["7", "strong", "pmf"],
    ["8", "scale", "fit"],
  ];
  const xLabels = JOURNEY_STAGE_LABELS.map((lbl, stage) => {
    if (stage < minStage) return "";
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
  const nodes = teams.map((t) => {
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
    const assessed = journeyAssessed(t);
    const r = assessed ? 4 + j.market_upside * 1.8 : 4.8; // upside 1..5 -> r 5.8..13
    return { t, j, assessed, r, cx: xForStage(j.stage) + jx, cy: yForEvidence(j.evidence_quality) + jy };
  });
  const labelPos = journeyPlaceLabels(nodes, { W, padT: PAD_T, plotH });
  const dots = nodes.map(({ t, j, assessed, r, cx, cy }) => {
    const famIdx = journeyFamilyIdx(j.primary_bottleneck);
    const isProject = teamKind(t) === "project";
    const label = labelPos.get(t.record_id) || null;
    const labelClass = label ? " is-labeled" : "";
    const contextClass = assessed ? "" : " is-profile-context";
    const bnClass = bnFocus ? (j.primary_bottleneck === bnFocus ? " is-bn-match" : " is-bn-dim") : "";
    const dotClass = assessed ? `ac-jdot ac-jfam-${famIdx}` : "ac-jdot ac-jprofile-dot";
    const title = assessed
      ? `${t.name || t.record_id}: ${JOURNEY_STAGE_LABELS[j.stage] || "journey"} / ${JOURNEY_EVIDENCE_LABELS[j.evidence_quality] || "evidence"}`
      : `${t.name || t.record_id}: profile context; no explicit journey read yet`;
    const labelX = label ? label.x : 0;
    const labelY = label ? label.y : -r - 8;
    const labelAnchor = label ? label.anchor : "middle";
    return `<g class="ac-jnode${isProject ? " is-project" : ""}${contextClass}${labelClass}${bnClass}" data-record-id="${escHtml(t.record_id)}" role="button" tabindex="0" aria-label="${escAttr(title)}" transform="translate(${cx.toFixed(1)},${cy.toFixed(1)})">
        <circle class="ac-jhit" r="${Math.max(18, r + 9).toFixed(1)}"/>
        <circle class="${dotClass}" r="${r.toFixed(1)}"/>
        <text class="ac-jnode-label" x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="${labelAnchor}">${escHtml(t.name)}</text>
      </g>`;
  }).join("");

  // ── bottleneck legend — grouped into 4 color families (the dot palette),
  // each family's members still individually clickable to isolate that one.
  // Led by the encoding key: without it nothing on the view says what color
  // or size MEAN, and both encodings are otherwise hover-only knowledge. ──
  const bottleneckCounts = new Map(JOURNEY_BOTTLENECKS.map((b) => [b, 0]));
  for (const t of teams) {
    if (!journeyAssessed(t)) continue;
    const b = journeyFor(t).primary_bottleneck;
    if (bottleneckCounts.has(b)) bottleneckCounts.set(b, bottleneckCounts.get(b) + 1);
  }
  // A dashed/ghost dot means "no explicit PMF read yet" (profile-context only,
  // seeded at the idea·vibes default). It was a whole class of marks the legend
  // never explained — every faded dot is a placeholder, not a real placement.
  const ghostSwatch = `<svg width="11" height="11" viewBox="0 0 11 11" aria-hidden="true" style="vertical-align:-1px"><circle cx="5.5" cy="5.5" r="3.6" fill="rgba(241,236,231,0.24)" stroke="rgba(214,189,134,0.58)" stroke-width="1" stroke-dasharray="2 2"/></svg>`;
  const legendKey = `<span class="acl-jkey">color = primary bottleneck · size = market upside<span class="acl-jsize" aria-hidden="true"><i class="sm"></i><i class="lg"></i></span></span><span class="acl-jkey acl-jghost-key">${ghostSwatch}&nbsp;dashed = profile only, no PMF read yet</span>`;
  const legend = legendKey + JOURNEY_BOTTLENECK_FAMILIES.map((fam, fi) => `
    <div class="acl-jfamily">
      <span class="acl-jfam-head"><span class="acl-jswatch ac-jfam-${fi}"></span>${escHtml(fam.label)}</span>
      ${fam.members.map((b) => {
        const count = bottleneckCounts.get(b) || 0;
        return `<button type="button" class="acl-jbtn ${jf.bottleneck === b ? "is-active" : ""} ${jf.bottleneck && jf.bottleneck !== b ? "is-dim" : ""}" data-jbottleneck="${escAttr(b)}" data-legend-bottleneck="${escAttr(b)}" aria-pressed="${jf.bottleneck === b ? "true" : "false"}" aria-label="${escAttr(`${b}: ${count} plotted records${jf.bottleneck === b ? " — click to clear" : " — click to isolate"}`)}">${escHtml(b)}<em>${escHtml(String(count))}</em></button>`;
      }).join("")}
    </div>`).join("");

  // ── sentence bar — "plotting teams + projects + side projects" ──
  // Counts come from the UNFILTERED set so a toggled-off chip still says
  // what it would bring back. An active bottleneck isolation (set from the
  // legend below) surfaces here as a clearable chip — the legend's
  // is-active highlight alone left the filter state invisible at the top.
  const kindCount = {
    teams: all.filter(t => teamKind(t) !== "project").length,
    projects: all.filter(t => teamKind(t) === "project").length,
    side: all.filter(t => journeyFor(t).stage === 0).length,
  };
  const includeChip = (key, label) => constSentenceIncludeChip({
    attr: "data-jfilter", value: key, on: !!jf[key], label, count: kindCount[key],
    aria: `${label}, ${kindCount[key]} on the chart — click to ${jf[key] ? "hide" : "include"}`,
  });
  const bottleneckChip = jf.bottleneck ? `
    <span class="ac-sent-word">· stuck on</span>
    <button type="button" class="ac-sent-evi is-clearable" data-jbottleneck="${escAttr(jf.bottleneck)}" aria-label="${escAttr(`clear bottleneck filter: ${jf.bottleneck}`)}">
      ${escHtml(jf.bottleneck)}<i class="ac-sent-x" aria-hidden="true">×</i>
    </button>` : "";
  // Honesty fact: how many plotted records have an EXPLICIT pmf read vs. sit at
  // the seeded default — otherwise the bottom-left default cluster reads as real.
  const assessedCount = teams.filter(journeyAssessed).length;
  const filterBar = `
    <div class="ac-sentence" role="group" aria-label="pmf evidence filters">
      <span class="ac-sent-word">PMF read for</span>
      ${includeChip("teams", "teams")}
      <span class="ac-sent-word">+</span>
      ${includeChip("projects", "projects")}
      ${sideEligible ? `<span class="ac-sent-word">+</span>${includeChip("side", "side projects")}` : ""}
      <span class="ac-sent-word">·</span>
      <strong class="ac-sent-fact">${assessedCount}/${teams.length}</strong>
      <span class="ac-sent-word">with an explicit read</span>
      ${bottleneckChip}
    </div>`;

  state.canvas.innerHTML = `
    <div class="alch-cohort-page" data-cohort-view="journey">
    ${cohortPageHead("journey")}
    <div class="alch-view-controls" data-shape-occluder>${constTimelineDropdownHtml()}${filterBar}${constSelectionChipHtml()}</div>
    <div class="alch-constellation" data-constellation-view="journey">
      <div class="alch-const-workbench is-single">
        <div class="alch-const-main">
          <div class="alch-constellation-legend is-journey-legend lg-track">${legend}</div>
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
    </div>
  `;
  markConstellationSelection(state.constSelection);
}

// ─── product layer slot · team standing vs their OWN plan (v0.1) ─────
// PMF says how mature a team is on a shared maturity curve. This answers
// the orthogonal, self-referenced question PMF can't: how is each team
// doing against the goals IT set? Every team is graded against itself, so
// it cannot collapse back onto PMF. v0.1 reads standing from self-reported
// confidence and shows each team's own next goal; the real week-over-week
// momentum (recovering / slipping) lights up once transcripts feed the loop.
// Standing colour follows the global semantic convention: red = behind /
// needs attention, green = on or ahead of plan (down/up). The two healthy
// states stay green-family but split warm-olive (on plan) vs cool-teal
// (ahead) so they read apart at a glance; the legend keys all three.
// 'behind' is a cool CRIMSON (H~353), deliberately pulled off the warm
// oxide/TEE/nav red family (H~10) that co-renders in the same viewport —
// so the danger dot never reads as the brand accent or the active-tab mark.
const CONST_GOAL_STANDING = {
  behind: { label: "behind plan", color: "#c83a48" },
  onplan: { label: "on plan", color: "#7fa05a" },
  ahead: { label: "ahead", color: "#4f9d8f" },
};
const CONST_GOAL_STANDING_KEYS = Object.keys(CONST_GOAL_STANDING);
function constNormalizeGoalStandingFilter(raw) {
  const key = String(raw || "").toLowerCase();
  return CONST_GOAL_STANDING_KEYS.includes(key) ? key : "all";
}
const GOAL_MOMENTUM_KEYS = ["rising", "slipping", "flat"];
function constNormalizeGoalMomentumFilter(raw) {
  const key = String(raw || "").toLowerCase();
  return GOAL_MOMENTUM_KEYS.includes(key) ? key : "all";
}
// ── per-week standing (Supabase-backed) ──────────────────────────────────
// state.standingWeekly carries each team's PMF stage + confidence per program
// week (source of truth: Supabase team_standing_weekly → cohort-standing-weekly
// .json). The goal views read the week the timeline dropdown points at, so the
// "as of [week]" control moves them, and the trajectory is REAL movement — which
// unlocks momentum (who's climbing vs slipping), the goal views' core insight.
function standingWeeklyTeam(rid) { return state.standingWeekly?.byTeam?.[rid] || null; }
function standingWeeklyWeeks() { return Array.isArray(state.standingWeekly?.weeks) ? state.standingWeekly.weeks : []; }
// The program_week the timeline currently points at (Total / latest = max week).
function activeStandingWeek() {
  const weeks = standingWeeklyWeeks();
  if (!weeks.length) return null;
  const maxWk = weeks[weeks.length - 1].program_week;
  const snaps = constellationSnapshots();
  if (!snaps.length) return maxWk;
  const idx = ensureConstellationTimelineIdx();
  if (idx == null || idx >= snaps.length - 1) return maxWk;
  return Math.max(weeks[0].program_week, Math.min(maxWk, idx));
}
// Week objects from the start through the active week — the visible window.
function standingVisibleWeeks() {
  const weeks = standingWeeklyWeeks();
  const active = activeStandingWeek();
  if (!weeks.length || active == null) return [];
  return weeks.filter(w => w.program_week <= active);
}
function standingWeekLabel(week) {
  return (standingWeeklyWeeks().find(w => w.program_week === week)?.label) || "Latest";
}
// {stage, confidence} for a team at a program_week — falls back to live journey.
function teamWeekRead(team, week) {
  const e = week != null ? standingWeeklyTeam(team?.record_id)?.weeks?.[week] : null;
  if (e) return { stage: e.stage, confidence: e.confidence };
  const j = journeyFor(team);
  return { stage: j.stage, confidence: j.confidence };
}
// Real per-week stage series for a team over the given week objects.
function teamStageSeries(team, weekList) {
  const t = standingWeeklyTeam(team?.record_id);
  const fallback = journeyFor(team).stage;
  return weekList.map(w => { const e = t?.weeks?.[w.program_week]; return e ? e.stage : fallback; });
}
// Momentum over the visible window = stage(last) − stage(first). null if <2 pts.
function teamMomentum(team) {
  const wk = standingVisibleWeeks();
  if (wk.length < 2) return null;
  const s = teamStageSeries(team, wk);
  return Math.round((s[s.length - 1] - s[0]) * 10) / 10;
}
function momentumKind(d) { return d == null ? "flat" : (d > 0 ? "rising" : (d < 0 ? "slipping" : "flat")); }
const MOMENTUM = {
  rising:   { color: "#4f9d8f", glyph: "▲", word: "climbing" },
  slipping: { color: "#c83a48", glyph: "▼", word: "slipping" },
  flat:     { color: "#9a9488", glyph: "→", word: "steady" },
};
function momentumDeltaLabel(d) { return d == null ? "" : (d > 0 ? `+${d}` : `${d}`); }

function constTeamStanding(team) {
  // Classify by the confidence the team declared AT THE ACTIVE WEEK (per-week
  // data from Supabase). Falls back to the raw live confidence — never the
  // "Low" default — so an unrated team is "no read yet", not falsely "behind".
  const wk = activeStandingWeek();
  const e = wk != null ? standingWeeklyTeam(team?.record_id)?.weeks?.[wk] : null;
  const raw = e ? e.confidence
    : (team && typeof team.journey === "object" && team.journey) ? team.journey.confidence : undefined;
  const c = constText(raw).toLowerCase();
  if (c === "low") return "behind";
  if (c === "high") return "ahead";
  if (c === "medium") return "onplan";
  return null;
}
function constTeamGoalText(team) {
  const j = journeyFor(team);
  return constText(j.next_milestone) || constText(team?.weekly_goals)
    || constText(team?.graduation_target) || constText(team?.monthly_milestones) || "";
}
function constGoalPlanModel(teams = []) {
  const active = activeStandingWeek();
  const rows = (Array.isArray(teams) ? teams : [])
    .filter(team => team?.record_id && teamKind(team) !== "person")
    .map(team => {
      const read = teamWeekRead(team, active);
      const momentum = teamMomentum(team);
      const aim = constStandingTarget(team, read.stage);
      return {
        team,
        standing: constTeamStanding(team),
        stage: read.stage,
        confidence: read.confidence,
        momentum,
        momentumKind: momentumKind(momentum),
        target: aim.value,
        targetDeclared: aim.declared,
        goalText: constTeamGoalText(team),
        domain: constDomainClass(team?.domain),
      };
    });
  const order = { behind: 0, onplan: 1, ahead: 2 };
  const byName = (a, b) => String(a.team.name || a.team.record_id).localeCompare(String(b.team.name || b.team.record_id));
  const tracked = rows.filter(r => r.standing).sort((a, b) => order[a.standing] - order[b.standing] || byName(a, b));
  const untracked = rows.filter(r => !r.standing).sort(byName);
  const counts = { behind: 0, onplan: 0, ahead: 0 };
  for (const r of tracked) counts[r.standing] += 1;
  // Momentum summary — the insight the per-week data unlocks: who's climbing,
  // who's slipping, where the cohort median sits, the fastest mover to celebrate
  // and the steepest slip to watch.
  const mom = { rising: 0, slipping: 0, flat: 0 };
  for (const r of tracked) mom[r.momentumKind] += 1;
  const med = (arr) => arr.length ? arr[Math.floor((arr.length - 1) / 2)] : null;
  const medianStage = med(tracked.map(r => r.stage).sort((a, b) => a - b));
  const movers = tracked.filter(r => r.momentum != null);
  const topMover = movers.slice().sort((a, b) => b.momentum - a.momentum)[0] || null;
  const topSlip = movers.filter(r => r.momentum < 0).sort((a, b) => a.momentum - b.momentum)[0] || null;
  // Needs-attention queue — slipping teams (declining) plus behind-and-stalled
  // (low confidence, no climb). The intervention list a coordinator acts on.
  const atRisk = tracked
    .filter(r => r.momentumKind === "slipping" || (r.standing === "behind" && r.momentumKind === "flat" && r.momentum != null))
    .sort((a, b) => (a.momentum ?? 0) - (b.momentum ?? 0));
  // Cohort trend — this week's median stage vs the previous visible week's.
  const vis = standingVisibleWeeks();
  const prevPw = vis.length >= 2 ? vis[vis.length - 2].program_week : null;
  const medianPrev = prevPw != null ? med(tracked.map(r => teamWeekRead(r.team, prevPw).stage).sort((a, b) => a - b)) : null;
  const trend = (medianStage != null && medianPrev != null) ? Math.round((medianStage - medianPrev) * 10) / 10 : null;
  const summary = { counts, mom, medianStage, trend, topMover, topSlip, atRisk, week: active, weekLabel: standingWeekLabel(active), hasWeekly: standingWeeklyWeeks().length > 0 };
  // teamRows keep the stack hover tooltip (constStackItemForTeam) consistent.
  const teamRows = rows.map(r => ({
    team: r.team,
    role: {
      key: r.standing || "untracked",
      label: r.standing ? CONST_GOAL_STANDING[r.standing].label : "no standing read yet",
      secondary: r.momentum != null && r.momentum !== 0 ? `${MOMENTUM[r.momentumKind].glyph} ${momentumDeltaLabel(r.momentum)} over ${standingVisibleWeeks().length - 1}w` : null,
      reason: r.goalText ? `goal: ${r.goalText}` : "no goal declared yet",
    },
    evidence: { key: "profile", label: r.standing ? `stage ${r.stage}/8 · ${r.confidence || "—"}` : "no journey read", value: 0 },
  }));
  return { rows, tracked, untracked, counts, teamRows, summary };
}

// Cohort momentum insight — a compact, visual summary (climbing / slipping /
// steady, median stage, fastest mover, steepest slip) shown above both goal
// views. NOT the removed generated read-clause: it's a genuinely additive,
// at-a-glance read the chart alone can't give, and it changes as you scrub weeks.
function constGoalInsightHtml(summary, momentumFilter = "all") {
  if (!summary || !summary.counts) return "";
  const mf = constNormalizeGoalMomentumFilter(momentumFilter);
  // Momentum chips double as filters — click to isolate climbers / slippers /
  // steady (click again to clear). Orthogonal to the standing chips in the bar.
  const chip = (kind, n) => `<button type="button" class="ac-gi-chip is-${kind}${mf === kind ? " is-active" : ""}" data-momentum-filter="${kind}" aria-pressed="${mf === kind ? "true" : "false"}" aria-label="${escAttr(`${n} ${MOMENTUM[kind].word}${mf === kind ? " — filtered; click to clear" : " — click to isolate"}`)}"><i aria-hidden="true">${MOMENTUM[kind].glyph}</i><em>${n}</em>${MOMENTUM[kind].word}</button>`;
  const trendStr = summary.trend != null && summary.trend !== 0
    ? ` <span class="ac-gi-trend is-${summary.trend > 0 ? "rising" : "slipping"}">${summary.trend > 0 ? MOMENTUM.rising.glyph : MOMENTUM.slipping.glyph}${momentumDeltaLabel(summary.trend)} this week</span>` : "";
  const median = summary.medianStage != null ? `<span class="ac-gi-stat">median stage <b>${summary.medianStage}</b><small>/8</small>${trendStr}</span>` : "";
  const mover = summary.topMover && summary.topMover.momentum > 0
    ? `<button type="button" class="ac-gi-call is-rising" data-const-team="${escAttr(summary.topMover.team.record_id)}">fastest <b>${escHtml(summary.topMover.team.name || summary.topMover.team.record_id)}</b> ${MOMENTUM.rising.glyph}${momentumDeltaLabel(summary.topMover.momentum)}</button>` : "";
  const risk = (summary.atRisk || []).slice(0, 3);
  const more = (summary.atRisk || []).length - risk.length;
  const attention = risk.length
    ? `<span class="ac-gi-attention" role="group" aria-label="needs attention"><i aria-hidden="true">⚠</i>needs attention ${risk.map(r => `<button type="button" class="ac-gi-team" data-const-team="${escAttr(r.team.record_id)}" aria-label="${escAttr(`open ${r.team.name || r.team.record_id}`)}">${escHtml(r.team.name || r.team.record_id)}</button>`).join("")}${more > 0 ? `<span class="ac-gi-more">+${more}</span>` : ""}</span>` : "";
  return `
    <div class="ac-gi" role="group" aria-label="cohort momentum summary">
      ${chip("rising", summary.mom.rising)}${chip("slipping", summary.mom.slipping)}${chip("flat", summary.mom.flat)}
      ${median}${mover}${attention}
      <span class="ac-gi-src" title="per-week PMF reads, sourced from Supabase team_standing_weekly">via Supabase · ${escHtml(summary.weekLabel)}</span>
    </div>`;
}

// Visible weeks for the trajectory x-axis — the real program-week snapshots from
// the Supabase-backed standing data, up through the week the timeline points at.
// No seeding: stages come straight from the per-week reads.
function constStandingWeeks() {
  const vis = standingVisibleWeeks();
  if (vis.length) return vis;
  return [{ program_week: currentProgramWeek(), label: "now" }];
}

// Real per-week stage series for a team across the visible week objects.
function constStandingTrajectory(team, weeks) {
  return teamStageSeries(team, weeks);
}

// Standing = trajectory toward graduation. Each tracked team is a line rising
// (over recent weeks) toward the graduation target (PMF stage 8); the aim is
// the shared dashed line at the top, "how they're against it" is the gap below
// it. Lines are dashed + faint at rest (signalling "illustrative until momentum
// is wired") and solidify on hover; the standing filter dims off-standing teams.
function constGoalPlanHtml(model, standingFilter = "all", momentumFilter = "all") {
  const tracked = model?.tracked || [];
  const untracked = model?.untracked || [];
  const activeFilter = constNormalizeGoalStandingFilter(standingFilter);
  const momFilter = constNormalizeGoalMomentumFilter(momentumFilter);
  if (!tracked.length && !untracked.length) return `<p class="ac-stack-empty">no teams to track yet.</p>`;

  const summary = model?.summary || null;
  const weeks = constStandingWeeks();
  const n = weeks.length;
  const maxWk = weeks[n - 1].program_week;
  const W = 920, H = 440, PAD_L = 48, PAD_R = 134, PAD_T = 22, PAD_B = 34;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const xFor = (i) => PAD_L + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yFor = (st) => PAD_T + (1 - Math.max(0, Math.min(8, st)) / 8) * plotH;

  const grid = [0, 2, 4, 6, 8].map(st => `
      <line class="ac-traj-grid${st === 8 ? " is-goal" : ""}" x1="${PAD_L}" y1="${yFor(st).toFixed(1)}" x2="${(W - PAD_R).toFixed(1)}" y2="${yFor(st).toFixed(1)}"/>
      <text class="ac-traj-ylab" x="${PAD_L - 8}" y="${(yFor(st) + 3).toFixed(1)}" text-anchor="end">${st}</text>`).join("");
  const goalLab = `<text class="ac-traj-goal-lab" x="${(W - PAD_R + 7).toFixed(1)}" y="${(yFor(8) + 3).toFixed(1)}">graduation</text>`;
  const wkShort = (w) => w.program_week === maxWk ? "now" : (w.program_week === 0 ? "start" : `w${w.program_week}`);
  const xlabs = weeks.map((w, i) => `<text class="ac-traj-xlab" x="${xFor(i).toFixed(1)}" y="${H - 12}" text-anchor="middle">${escHtml(wkShort(w))}</text>`).join("");

  const moverId = summary?.topMover?.team?.record_id;
  const slipId = summary?.topSlip?.team?.record_id;
  const lines = tracked.map(r => {
    const color = CONST_GOAL_STANDING[r.standing].color;
    const pts = constStandingTrajectory(r.team, weeks);
    const poly = pts.map((st, i) => `${xFor(i).toFixed(1)},${yFor(st).toFixed(1)}`).join(" ");
    const endX = xFor(n - 1), endY = yFor(pts[n - 1]);
    const dim = ((activeFilter !== "all" && activeFilter !== r.standing) || (momFilter !== "all" && momFilter !== r.momentumKind)) ? " is-dim" : "";
    const emphasis = r.team.record_id === moverId ? " is-mover" : (r.team.record_id === slipId ? " is-slip" : "");
    const mk = MOMENTUM[r.momentumKind];
    const name = r.team.name || r.team.record_id;
    const delta = momentumDeltaLabel(r.momentum);
    const showDelta = r.momentum != null && r.momentum !== 0;
    return `
      <g class="ac-traj-team is-${escAttr(r.standing)}${dim}${emphasis}" data-const-team="${escAttr(r.team.record_id)}" style="--team-color:${color}" tabindex="0" role="button" aria-label="${escAttr(`${name}: stage ${pts[n - 1]} of 8${r.momentum != null ? `, ${mk.word}${showDelta ? " " + delta : ""} over ${n - 1} week${n - 1 === 1 ? "" : "s"}` : ""}`)}">
        <title>${escHtml(name)} — stage ${escHtml(String(pts[n - 1]))}/8 · ${escHtml(mk.word)}${showDelta ? " " + escHtml(delta) : ""}</title>
        <polyline class="ac-traj-hit" points="${poly}"/>
        <polyline class="ac-traj-line" points="${poly}"/>
        <text class="ac-traj-mom" x="${(endX + 7).toFixed(1)}" y="${(endY + 3.5).toFixed(1)}">${mk.glyph}</text>
        <text class="ac-traj-endlab" x="${(W - PAD_R + 18).toFixed(1)}" y="${(endY + 3).toFixed(1)}">${escHtml(constShortText(name, 13))}</text>
      </g>`;
  }).join("");

  const untrackedHtml = untracked.length ? `
      <div class="ac-gp-untracked">
        <span class="ac-gp-untracked-head">${untracked.length} team${untracked.length === 1 ? "" : "s"} with no standing read yet</span>
        <div class="ac-gp-untracked-list">
          ${untracked.map(r => `<button type="button" class="ac-stack-team ac-gp-chip" data-const-team="${escAttr(r.team.record_id)}" aria-label="${escAttr((r.team.name || r.team.record_id) + ": no standing read yet")}">${escHtml(r.team.name || r.team.record_id)}</button>`).join("")}
        </div>
      </div>` : "";

  return `
    <div class="ac-stack-view is-trajectory" data-standing-filter="${escAttr(activeFilter)}">
      ${constGoalInsightHtml(summary, momFilter)}
      <div class="ac-traj-chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Team PMF-stage trajectories over recent weeks toward graduation at stage 8, coloured by standing with momentum markers">
          ${grid}${goalLab}${xlabs}
          ${lines}
        </svg>
      </div>
      ${untrackedHtml}
      <p class="ac-gp-note">Each line = a team's PMF stage week over week · colour = standing. Hover a line to read a team.</p>
    </div>`;
}

// Target stage for the "targets" view — the team's aim, with provenance.
// Prefers a REAL declared target (Supabase team_standing_weekly.target_stage,
// surfaced via the standing-weekly artifact) and reports it as declared:true.
// When no target is set there (target_stage NULL → the team hasn't declared
// one) it falls back to a stable derived aim 1–3 stages ahead of current and
// reports declared:false, so the view renders it as an estimate rather than
// passing a guess off as a real goal. Returns { value, declared }.
function constStandingTarget(team, current) {
  const t = standingWeeklyTeam(team?.record_id);
  if (t && Number.isFinite(t.target_stage)) {
    return { value: Math.max(current, Math.min(8, t.target_stage)), declared: true };
  }
  const head = 1 + Math.round(2 * ((journeyJitter(team.record_id, "target") + 1) / 2));
  return { value: Math.max(current, Math.min(8, current + head)), declared: false };
}

// Targets view (option B): current stage (●) vs each team's target (▽) on a
// shared 0→8 axis; the bar is the gap left to close. Sorted by largest gap so
// who-has-furthest-to-go leads. Standing filter dims off-standing rows. Snapshot
// counterpart to the standing trajectory (which shows movement over time).
function constGoalTargetsHtml(model, standingFilter = "all", momentumFilter = "all") {
  const tracked = model?.tracked || [];
  const untracked = model?.untracked || [];
  const activeFilter = constNormalizeGoalStandingFilter(standingFilter);
  const momFilter = constNormalizeGoalMomentumFilter(momentumFilter);
  if (!tracked.length && !untracked.length) return `<p class="ac-stack-empty">no teams to track yet.</p>`;
  const summary = model?.summary || null;
  const pct = (st) => Math.round(Math.max(0, Math.min(8, st)) / 8 * 1000) / 10;
  const rows = tracked.map(r => ({ r, cur: r.stage, tgt: r.target, declared: r.targetDeclared, gap: Math.max(0, r.target - r.stage) }))
    .sort((a, b) => b.gap - a.gap || String(a.r.team.name || "").localeCompare(String(b.r.team.name || "")));
  // Tick names match the canonical JOURNEY_STAGE_LABELS (stage 4 = mvp, 6 =
  // emerging pmf) anchored to their stage number, so the axis reads on the same
  // 0–8 scale as the "cur → tgt" values and never contradicts the PMF view.
  const ticks = [{ v: 0, l: "0" }, { v: 4, l: "mvp · 4" }, { v: 6, l: "pmf · 6" }, { v: 8, l: "grad · 8" }];
  const axis = `<div class="ac-tgt-axis"><span></span><div class="ac-tgt-ticks">${ticks.map(t => `<span class="ac-tgt-tick" style="left:${pct(t.v)}%">${t.l}</span>`).join("")}</div><span></span></div>`;
  const rowHtml = rows.map(({ r, cur, tgt, gap, declared }) => {
    const color = CONST_GOAL_STANDING[r.standing].color;
    // Momentum still dims rows (the insight strip's momentum chips filter here),
    // but momentum is the trajectory view's job — this view stays on the gap.
    const dim = ((activeFilter !== "all" && activeFilter !== r.standing) || (momFilter !== "all" && momFilter !== r.momentumKind)) ? " is-dim" : "";
    // Provenance: a real declared aim (Supabase) renders authoritative; a derived
    // backup renders as an estimate (hollow ▽, dashed gap, "est" tag) so the view
    // never passes a placeholder off as a real goal.
    const tcls = declared ? " is-declared" : " is-derived";
    const name = r.team.name || r.team.record_id;
    const gapL = pct(cur), gapW = Math.round((pct(tgt) - pct(cur)) * 10) / 10;
    return `<button type="button" class="ac-stack-team ac-tgt-row is-${escAttr(r.standing)}${dim}${tcls}" data-const-team="${escAttr(r.team.record_id)}" style="--team-color:${color}" aria-label="${escAttr(`${name}: stage ${cur} of 8, ${declared ? "target" : "estimated target"} ${tgt}, gap ${gap}`)}">
      <span class="ac-tgt-name">${escHtml(name)}</span>
      <span class="ac-tgt-track">
        <span class="ac-tgt-base"></span>
        ${gapW > 0 ? `<span class="ac-tgt-gap" style="left:${gapL}%;width:${gapW}%"></span>` : ""}
        <span class="ac-tgt-cur" style="left:${pct(cur)}%" aria-hidden="true"></span>
        <span class="ac-tgt-target" style="left:${pct(tgt)}%" aria-hidden="true">▽</span>
      </span>
      <span class="ac-tgt-val">${cur}<span class="ac-tgt-tval"> → ${tgt}${declared ? "" : `<i>est</i>`}</span></span>
    </button>`;
  }).join("");
  const untrackedHtml = untracked.length ? `
      <div class="ac-gp-untracked">
        <span class="ac-gp-untracked-head">${untracked.length} team${untracked.length === 1 ? "" : "s"} with no standing read yet</span>
        <div class="ac-gp-untracked-list">
          ${untracked.map(r => `<button type="button" class="ac-stack-team ac-gp-chip" data-const-team="${escAttr(r.team.record_id)}" aria-label="${escAttr((r.team.name || r.team.record_id) + ": no standing read yet")}">${escHtml(r.team.name || r.team.record_id)}</button>`).join("")}
        </div>
      </div>` : "";
  return `
    <div class="ac-stack-view is-targets" data-standing-filter="${escAttr(activeFilter)}">
      ${constGoalInsightHtml(summary, momFilter)}
      ${axis}
      <div class="ac-tgt-rows">${rowHtml}</div>
      ${untrackedHtml}
      <p class="ac-gp-note">● current stage · ▽ target (faded = estimated) · bar = gap to close. Hover a row to read a team.</p>
    </div>`;
}

const COHORT_INSIGHT_READ_MODELS = {
  say_did_shipped: "say_did_shipped",
  latent_overlap: "latent_overlaps",
};

function cohortInsightsModel() {
  const active = activeConstellationCohort?.() || state.cohort || {};
  return active?.cohort_insights || state.cohort?.cohort_insights || {};
}

function insightArray(value) {
  if (Array.isArray(value)) return value.map(constText).filter(Boolean);
  return constList(value);
}

function cohortInsightCards(kind) {
  const insights = cohortInsightsModel();
  const readKey = COHORT_INSIGHT_READ_MODELS[kind] || kind;
  const readModelCards = insights?.read_models?.[readKey];
  const cards = Array.isArray(readModelCards) && readModelCards.length
    ? readModelCards
    : (Array.isArray(insights?.cards) ? insights.cards.filter(card => card?.kind === kind) : []);
  return cards.filter(card => card && (!kind || card.kind === kind));
}

function cohortInsightSubjectMap(kind) {
  const out = new Map();
  for (const card of cohortInsightCards(kind)) {
    const ids = Array.isArray(card.subject_ids) ? card.subject_ids : [];
    const key = ids[0] ? String(ids[0]) : "";
    if (key && !out.has(key)) out.set(key, card);
  }
  return out;
}

function insightContent(card) {
  return card?.content_json && typeof card.content_json === "object" ? card.content_json : {};
}

function insightReviewLabel(card) {
  const approval = constText(card?.approval_state).replace(/[_-]+/g, " ");
  const review = constText(card?.review_status).replace(/[_-]+/g, " ");
  if (approval === "approved") return "approved";
  if (approval === "rejected") return "rejected";
  if (approval === "not reviewed" || review === "generated") return "needs review";
  return approval || review || "needs review";
}

function insightConfidenceLabel(card) {
  const confidence = constText(card?.confidence).replace(/[_-]+/g, " ");
  return confidence ? `${confidence} confidence` : "confidence unknown";
}

function sdsObserved(card) {
  const content = insightContent(card);
  return content.observed_status === "public_signal_observed" || card?.evidence_level === "observed_public_metadata";
}

function sdsNumber(content, key) {
  const value = Number(content?.[key]);
  return Number.isFinite(value) ? value : 0;
}

// Consolidated cards nest the numeric proof under public_activity; fall back to the
// card root so any un-regenerated card still reads its counts.
function sdsActivity(card) {
  const content = insightContent(card);
  return content.public_activity && typeof content.public_activity === "object" ? content.public_activity : content;
}

function sdsEvidenceParts(card) {
  const content = sdsActivity(card);
  const releases = sdsNumber(content, "release_count");
  const commits = sdsNumber(content, "useful_commit_count");
  const artifacts = sdsNumber(content, "progress_artifact_count");
  const latest = constText(content.latest_week_start);
  const primary = releases
    ? `${releases} release${releases === 1 ? "" : "s"}`
    : (commits
      ? `${commits} useful commit${commits === 1 ? "" : "s"}`
      : (artifacts ? `${artifacts} progress artifact${artifacts === 1 ? "" : "s"}` : "no public trace yet"));
  const detail = [];
  if (releases && commits) detail.push(`${commits} useful commit${commits === 1 ? "" : "s"}`);
  if ((releases || commits) && artifacts) detail.push(`${artifacts} progress artifact${artifacts === 1 ? "" : "s"}`);
  if (latest) detail.push(`latest ${latest}`);
  return {
    status: sdsObserved(card) ? "public signal" : "declared only",
    primary,
    detail: detail.join(" · "),
    review: `${insightConfidenceLabel(card)} · ${insightReviewLabel(card)}`,
  };
}

function renderSayDidShipped() {
  const cohort = activeConstellationCohort();
  const teams = (cohort.teams || []).filter(t => t && t.record_id && teamKind(t) !== "person");
  const cardByTeam = cohortInsightSubjectMap("say_did_shipped");
  const rows = teams
    .map(team => ({ team, card: cardByTeam.get(team.record_id) || null }))
    .filter(row => row.card)
    .sort((a, b) => {
      const ac = sdsActivity(a.card);
      const bc = sdsActivity(b.card);
      return Number(sdsObserved(b.card)) - Number(sdsObserved(a.card))
        || sdsNumber(bc, "release_count") - sdsNumber(ac, "release_count")
        || sdsNumber(bc, "useful_commit_count") - sdsNumber(ac, "useful_commit_count")
        || String(a.team.name || a.team.record_id).localeCompare(String(b.team.name || b.team.record_id));
    });
  const observed = rows.filter(row => sdsObserved(row.card)).length;
  const releases = rows.reduce((sum, row) => sum + sdsNumber(sdsActivity(row.card), "release_count"), 0);
  const commits = rows.reduce((sum, row) => sum + sdsNumber(sdsActivity(row.card), "useful_commit_count"), 0);
  const cardCount = `${rows.length} card${rows.length === 1 ? "" : "s"}`;
  const buildSummary = releases
    ? `${releases} release${releases === 1 ? "" : "s"}`
    : (commits ? `${commits} useful commit${commits === 1 ? "" : "s"}` : "no build traces");
  const sentenceBar = `
    <div class="ac-sentence" role="group" aria-label="say did shipped summary">
      <strong class="ac-sent-fact">${escHtml(cardCount)}</strong>
      <span class="ac-sent-word">· public cohort + repo metadata</span>
      <span class="ac-sent-word">·</span>
      <strong class="ac-sent-fact">${escHtml(`${observed}/${rows.length || teams.length}`)}</strong>
      <span class="ac-sent-word">with build signal · ${escHtml(buildSummary)}</span>
    </div>`;
  // One card per team: a scannable identity lead (what it is / who it serves, with a
  // domain-colored accent) over the say -> did -> shipped proof strip. Observed build
  // signal reads visually (domain accent + numeric chips); declared-only teams stay
  // muted. Replaces the old 5-column prose table that forced a 1120px horizontal scroll.
  const rowHtml = rows.map(({ team, card }) => {
    const content = insightContent(card);
    const act = sdsActivity(card);
    const isObserved = sdsObserved(card);
    const observedClass = isObserved ? " is-observed" : " is-declared";
    const domainKey = constDomainClass(team.domain);
    const domain = domainLabel(team.domain) || team.domain || "team";
    const whatIs = constShortText(content.what_it_is || "", 150);
    const icp = constShortText(content.who_it_serves || "", 120);
    const proof = sdsEvidenceParts(card);
    const relCount = sdsNumber(act, "release_count");
    const commitCount = sdsNumber(act, "useful_commit_count");
    const chips = [
      relCount ? `<span class="ac-sds-chip"><strong>${relCount}</strong> rel</span>` : "",
      commitCount ? `<span class="ac-sds-chip"><strong>${commitCount}</strong> commits</span>` : "",
    ].filter(Boolean).join("");
    return `
      <button type="button" class="ac-sds-card${observedClass}" data-domain="${escAttr(domainKey)}" data-const-open-record="${escAttr(team.record_id)}" title="${escAttr(`open ${team.name || team.record_id}`)}">
        <span class="ac-sds-identity">
          <strong class="ac-sds-name">${escHtml(team.name || team.record_id)}</strong>
          <span class="ac-sds-domain"><i style="background:${escAttr(CONST_DOMAIN_COLORS[domainKey] || CONST_DOMAIN_COLORS.other)}"></i>${escHtml(domain)}</span>
          ${whatIs ? `<span class="ac-sds-whatis">${escHtml(whatIs)}</span>` : ""}
          ${icp ? `<span class="ac-sds-icp">serves ${escHtml(icp)}</span>` : ""}
        </span>
        <span class="ac-sds-proof-strip">
          <span class="ac-sds-cell">
            <b>say</b><span>${escHtml(constShortText(content.say || team.now || team.focus || "not declared", 150))}</span>
          </span>
          <span class="ac-sds-cell${observedClass}">
            <b>did</b><span>${escHtml(constShortText(content.did || "not observed", 150))}</span>
          </span>
          <span class="ac-sds-cell${observedClass}">
            <b>shipped</b><span>${escHtml(constShortText(content.shipped || "not observed", 130))}</span>
            ${chips ? `<span class="ac-sds-chips">${chips}</span>` : ""}
          </span>
        </span>
        <span class="ac-sds-foot">
          <span class="ac-sds-state">${escHtml(proof.status)}</span>
          <span class="ac-sds-review">${escHtml(proof.review)}</span>
        </span>
      </button>`;
  }).join("");
  const empty = rows.length ? "" : `
    <p class="ac-stack-empty">no say / did / shipped cards yet. Run <code>npm run build:cohort-insights</code>.</p>`;
  state.canvas.innerHTML = `
    <div class="alch-cohort-page" data-cohort-view="shipped">
      ${cohortPageHead("shipped")}
      <div class="alch-view-controls" data-shape-occluder>${sentenceBar}</div>
      <div class="alch-constellation" data-constellation-view="shipped">
        <div class="alch-const-workbench is-single">
          <div class="alch-const-main">
            <div class="alch-constellation-stage ac-sds-stage" data-view="shipped" tabindex="0" aria-label="say did shipped cards">
              <div class="ac-sds-grid">
                ${rowHtml}
                ${empty}
              </div>
              <div class="ac-tip" hidden></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function renderProductStack() {
  const cohort = activeConstellationCohort();
  const teams = cohort.teams || [];
  const goalModel = constGoalPlanModel(state.cohort?.teams || teams);
  const standingFilter = constNormalizeGoalStandingFilter(state.goalStandingFilter);
  const momentumFilter = constNormalizeGoalMomentumFilter(state.goalMomentumFilter);
  const standingChip = (key) => {
    const spec = CONST_GOAL_STANDING[key];
    const count = goalModel.counts[key] || 0;
    return `<button type="button" class="ac-sent-evi is-standing is-standing-${escAttr(key)}" data-standing-filter="${escAttr(key)}" aria-pressed="${standingFilter === key ? "true" : "false"}" aria-label="${escAttr(`${spec.label}: ${count} teams${standingFilter === key ? " — click to clear" : " — click to isolate"}`)}">
      <i class="ac-sent-dot" aria-hidden="true"></i><em>${escHtml(String(count))}</em>&nbsp;${escHtml(spec.label)}
    </button>`;
  };
  // Sentence bar frames the view and carries the legend/filter chips, matching
  // the relationship map's "encoding key is the control" pattern.
  const sentenceBar = `
    <div class="ac-sentence" role="group" aria-label="team standing summary">
      <span class="ac-sent-word">tracking</span>
      <strong class="ac-sent-fact">${goalModel.tracked.length} teams</strong>
      <span class="ac-sent-word">toward graduation</span>
      <span class="ac-sent-word">· by standing</span>
      ${CONST_GOAL_STANDING_KEYS.map(standingChip).join("")}
    </div>`;
  const selectionChip = constSelectionChipHtml();
  // targets folded in: ONE view, two projections of the same goal model —
  // "trajectory" (movement over weeks toward graduation) and "gap to target"
  // (current stage → target). A segmented toggle switches between them so the
  // gap framing keeps its home without a redundant top-level tab.
  const projection = state.standingProjection === "targets" ? "targets" : "trajectory";
  const projToggle = `
    <div class="ac-proj-toggle" role="group" aria-label="standing projection">
      <button type="button" class="ac-proj-btn" data-standing-projection="trajectory" aria-pressed="${projection === "trajectory" ? "true" : "false"}">trajectory</button>
      <button type="button" class="ac-proj-btn" data-standing-projection="targets" aria-pressed="${projection === "targets" ? "true" : "false"}">gap to target</button>
    </div>`;
  const bodyHtml = projection === "targets"
    ? constGoalTargetsHtml(goalModel, standingFilter, momentumFilter)
    : constGoalPlanHtml(goalModel, standingFilter, momentumFilter);
  state.canvas.innerHTML = `
    <div class="alch-cohort-page" data-cohort-view="stack">
    ${cohortPageHead("stack")}
    <div class="alch-view-controls" data-shape-occluder>${constTimelineDropdownHtml()}${sentenceBar}${projToggle}${selectionChip}</div>
    <div class="alch-constellation" data-constellation-view="stack">
      <div class="alch-const-workbench is-single">
        <div class="alch-const-main">
          <div class="alch-constellation-stage ac-stack-stage" data-view="stack" data-projection="${escAttr(projection)}" data-lens="all" tabindex="0" aria-label="team standing — ${projection === "targets" ? "gap to target" : "trajectory toward graduation"}">
            ${bodyHtml}
            <div class="ac-tip" hidden></div>
          </div>
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
// on a ring inside the well. Well radius scales modestly with MEMBERSHIP
// (sqrt-bounded occupancy) — singleton wells stop spending a grid cell of
// dead space on one dot, and dense wells gain node/label breathing room.
// Size still must not imply project importance (the source model does not
// provide that); member count is already encoded in the well stroke weight,
// so radius tracking the same honest quantity adds no new claim.
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
    const maxWellR = Math.min(cellW, cellH) * 0.46;
    const occupancy = Math.sqrt(Math.min(w.members.length || 1, 8) / 8);
    const wellR = Math.max(46, maxWellR * (0.55 + 0.45 * occupancy));
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
  html += row("action", "click to inspect");
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
  html += row("action", "click to inspect");
  return html;
}


function renderConstellationPeople(teams, people, clusters, edges) {
  const W = 1120, H = 620;
  const model = constPeopleNetworkModel(people, teams, W, H);
  const peopleLinkFilter = constNormalizePeopleLinkFilter(state.constPeopleLinkFilter);
  const peopleLinkCounts = constPeopleLinkCounts(model.edges);
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
  state.canvas.innerHTML = `
    <div class="alch-cohort-page" data-cohort-view="map">
      ${cohortPageHead("map")}
      <div class="alch-view-controls" data-shape-occluder>
        ${constTimelineDropdownHtml()}
        ${constellationSentenceBar({ scope: "people", metrics: { total: peopleLinkCounts.total, peopleLinkCounts }, peopleLinkFilter })}
        ${constSelectionChipHtml()}
      </div>
      <div class="alch-constellation" data-constellation-view="map" data-constellation-scope="people">
        <div class="alch-const-workbench">
          <div class="alch-const-main">
            <div class="alch-constellation-stage ac-people-stage" data-view="people" data-lens="people" data-people-link-filter="${escAttr(peopleLinkFilter)}" tabindex="0" aria-label="people connected to projects">
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
      </div>
    </div>`;
  markConstellationSelection(state.constSelection);
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
    return;
  }
  // Directory (shapes) and any other timeline-aware view re-render generically.
  render();
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


// One nested container ring (theme / cluster / skill bucket) for the bubble
// map. Reuses the well accent tokens so it flips for light mode. A redundant
// single-member container is skipped — its team bubble already reads as the
// space, so an extra ring around one node is just noise.
function constBubbleContainerSvg(c, accentStyle) {
  if (!c || c.redundant) return "";
  // Level-aware label gate: theme rings are large; cluster/skill rings smaller.
  // A 9px label only earns its place when the ring can hold it without crowding
  // the bubbles inside (the old flat r>30 dropped labels into tiny circles).
  const showLabel = c.level === "theme" ? c.r > 90 : c.r > 44;
  const labelY = (c.cy - c.r + 14).toFixed(1);
  const count = Array.isArray(c.members) ? c.members.length : 0;
  const aria = `focus ${c.label || c.id}${c.level === "cluster" ? " ecosystem" : ` ${c.level}`}, ${count} team${count === 1 ? "" : "s"}`;
  return `
    <g class="ac-bubble-container" data-level="${escAttr(c.level)}" data-container="${escAttr(c.id)}" data-members="${escAttr((c.members || []).join(" "))}" role="button" tabindex="0" aria-label="${escAttr(aria)}" style="${escAttr(accentStyle)}">
      <circle class="ac-bubble-container-shape" cx="${c.cx.toFixed(1)}" cy="${c.cy.toFixed(1)}" r="${c.r.toFixed(1)}"/>
      ${showLabel ? `<text class="ac-bubble-container-label" x="${c.cx.toFixed(1)}" y="${labelY}" text-anchor="middle">${escHtml(c.label || "")}</text>` : ""}
    </g>`;
}

function renderConstellation() {
  const cohort = activeConstellationCohort();
  const teams = cohort.teams || [];
  const people = cohort.people || [];
  const clusters = cohort.clusters || [];
  const mode = constNormalizeConstellationMode(state.constellationMode);

  // Journey sub-view renders a PMF scatterplot instead of the map.
  // Collab Board is a peer Constellation sub-view (#216).
  if (mode === "collab") { renderCollab(); return; }
  if (mode === "journey") { renderJourney(); return; }
  if (mode === "stack") { renderProductStack(); return; }
  // Legacy "targets" mode (old deep-links / saved state) → standing with the
  // gap-to-target projection preselected. Migrate the mode to "stack" so the
  // projection toggle sticks afterward (otherwise every re-render would force
  // it back to targets). The tab is gone; the toggle owns it.
  if (mode === "targets") {
    state.constellationMode = "stack";
    state.standingProjection = "targets";
    renderProductStack();
    return;
  }
  if (mode === "shipped") { renderSayDidShipped(); return; }

  const edgeTier = constNormalizeEdgeTier(state.constEdgeTier);
  const networkScope = constNormalizeNetworkScope(state.constellationScope);
  // Squarer viewBox than the old node-link map: the packed cohort is a circle,
  // so a near-square frame fills the stage instead of pillarboxing a wide one.
  const W = 620, H = 600;
  const model = constellationModel(teams, clusters, cohort?.dependencies || []);
  // People scope keeps the existing person-to-person network (deferred work).
  if (networkScope === "people") {
    renderConstellationPeople(teams, people, clusters, model.edges);
    return;
  }
  // Relationship map = nested bubble map. Containment (theme → cluster/skill →
  // team) replaces the node-link layout: size = maturity, shade = depended-on,
  // colour = domain. The old map/ring layouts are retired (ring → map above).
  const viewMode = "bubble";
  const granularity = constNormalizeGranularity(state.constellationGranularity);
  state.constellationGranularity = granularity;
  const activeLens = "all";
  const stageOf = (team) => team?.journey?.stage;
  const { pos, containers } = packBubbles(model, granularity, { stageOf, W, H });
  const wells = []; const ringSegments = []; const ringCenter = null;
  // Edges aren't drawn in the bubble map, but the inspector still reads them
  // (who relies on whom) and the per-company overlap is built from them.
  const edges = model.edges.filter(e => pos.has(e.from) && pos.has(e.to));
  const interestCtx = constInterestContext(teams, clusters, edges, state.constInterest);
  const coverage = constConstellationCoverage(teams, edges);
  const relationshipBreakdown = constRelationshipBreakdown(edges);
  const inspectorCtx = { ...constellationInspectorContext(teams, edges, cohort?.people || []), clusters, distributionWells: model.wellsDef, lens: activeLens, mode: viewMode, scope: "projects", interest: interestCtx };
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
    return `<path class="${cls}" data-a="${escAttr(e.from)}" data-b="${escAttr(e.to)}" data-dep-id="${escAttr(e.id || "")}" aria-hidden="true" d="${escAttr(d)}" marker-end="url(#${e.normalized ? "ac-arrow" : "ac-arrow-soft"})"/>`
      + `<path class="ac-edge-hit" data-a="${escAttr(e.from)}" data-b="${escAttr(e.to)}" data-dep-id="${escAttr(e.id || "")}" role="button" tabindex="0" aria-label="${escAttr(aria)}" d="${escAttr(d)}"/>`;
  }).join("");

  // Draw small→large so keystones sit on top of the pile. Node color is always
  // domain (one coding across every lens). Under the relationships lens, nodes
  // with no edge are flagged is-orphan (CSS fades them).
  const nodeMarkup = [...pos.values()].sort((p, q) => p.r - q.r).map(({ team, x, y, r, angle, wellId, wellSize, rank, shade }) => {
    const isBubble = viewMode === "bubble";
    // Shade = how many teams depend on this one. Opacity alone reads poorly on
    // black, so influence drives a bright domain-coloured RIM (stroke weight)
    // as well — keystones like TeeSQL/Contexto pop as the load-bearing teams
    // they are. fill-opacity, never element opacity (that would fade the rim +
    // label and fight the hover/selection rules).
    const shadeV = Number.isFinite(shade) ? shade : 0.4;
    const shadeStyle = isBubble ? `fill-opacity:${(0.58 + 0.42 * shadeV).toFixed(2)};stroke-width:${(0.8 + 2.4 * shadeV).toFixed(2)}` : "";
    // View-transition name so each team bubble morphs to its new home when the
    // granularity changes (same team persists across grains by record_id).
    const vtName = isBubble ? `;view-transition-name:ac-vt-${dependencySafeToken(team.record_id)}` : "";
    const orphan = (activeLens !== "all" && !lensConnected.has(team.record_id)) ? " is-orphan" : "";
    const interestClass = interestCtx.active
      ? (interestCtx.coreIds.has(team.record_id) ? " is-interest-core" : (interestCtx.neighborIds.has(team.record_id) ? " is-interest-neighbor" : " is-interest-outside"))
      : "";
    const densityClass = viewMode === "map" && wellSize > 1 ? " is-dense-well" : "";
    const keystoneClass = ((viewMode === "map" || viewMode === "bubble") && rank === 0) ? " is-keystone-label" : "";
    const secondaryClass = viewMode === "map" && wellSize > 1 && rank > 0 ? " is-secondary-label" : "";
    const sourceClass = `${typedConnected.has(team.record_id) ? " is-source-backed" : ""}${profileLinkConnected.has(team.record_id) ? " is-profile-link" : ""}${unclusteredIds.has(team.record_id) ? " is-unclustered" : ""}${journeyAssessed(team) ? "" : " is-journey-missing"}`;
    const gapCount = profileLinkDegree.get(team.record_id) || 0;
    const typedCount = typedRecordDegree.get(team.record_id) || 0;
    // Confirmed-record halo: fixed offset so it reads as one clean ring, with
    // stroke WEIGHT carrying the record count (a 0.35px-per-record radius ramp
    // was indistinguishable between 1 and 6 records). Exact count stays in the
    // title + inspector.
    const typedRing = (!isBubble && typedCount)
      ? `<circle class="ac-node-record-ring" r="${(r + 3.2).toFixed(1)}" style="stroke-width:${(0.8 + Math.min(typedCount, 5) * 0.3).toFixed(2)}"><title>${escHtml(`${typedCount} relationship record${typedCount === 1 ? "" : "s"}`)}</title></circle>`
      : "";
    const bridgeRank = bridgeRanks.get(team.record_id);
    const nodeAccentStyle = interestCtx.active && (interestCtx.coreIds.has(team.record_id) || interestCtx.neighborIds.has(team.record_id))
      ? constWellAccentStyle(activeWellAccent)
      : "";
    const radialLabel = (viewMode === "ring" || (viewMode === "map" && wellSize > 1 && rank > 0)) && typeof angle === "number";
    const labelAnchor = radialLabel
      ? (Math.cos(angle) > 0.25 ? "start" : (Math.cos(angle) < -0.25 ? "end" : "middle"))
      : "middle";
    const labelGap = viewMode === "map" ? 17 : 13;
    // Dense wells: alternate the radial label distance by rank so neighboring
    // secondary labels land on two radii instead of one collision ring.
    // (Same mechanism as freddmannen's tree — staggers east/west labels too,
    // unlike a baseline-gap stagger, and keeps the two renderers cherry-pickable.)
    const labelOut = viewMode === "map" && wellSize >= 5 && rank > 0 && rank % 2 === 0 ? 13 : 6;
    const labelX = radialLabel
      ? (Math.cos(angle) > 0.25 ? r + labelOut : (Math.cos(angle) < -0.25 ? -r - labelOut : 0))
      : 0;
    const labelY = radialLabel
      ? (Math.sin(angle) < -0.25 ? -r - 8 - (labelOut - 6) : (Math.sin(angle) > 0.25 ? r + labelGap + (labelOut - 6) : 3))
      : r + labelGap;
    // Bubble map: only the ANCHOR (keystone, rank 0 = largest in its space)
    // keeps a resting label; every other team is hover-only (data-small-bubble
    // + CSS fade). 26 resting names collide into an unreadable pile (text is
    // wider than the gaps between bubbles, and CSS zoom scales the overlap too),
    // so the at-rest map reads as: space labels = where things are, one anchor
    // name per space, and any team's name on hover (sidebar + in-place).
    const labelLines = constNodeLabelLines(team, viewMode);
    const smallBubble = isBubble && rank !== 0;
    const fullLabel = constText(team.name || team.record_id);
    return `
    <g class="ac-node-group ac-node-domain-${constDomainClass(team.domain)}${orphan}${sourceClass}${interestClass}${densityClass}${keystoneClass}${secondaryClass}${bridgeRank ? " is-bridge-ranked" : ""}"${smallBubble ? ' data-small-bubble="true"' : ""} data-record-id="${escHtml(team.record_id)}" data-profile-link-count="${gapCount}" style="${escAttr(nodeAccentStyle + vtName)}" role="button" tabindex="0" aria-label="${escAttr(`inspect ${team.name || team.record_id}`)}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle class="ac-node-hit" r="${Math.max(18, r + 10).toFixed(1)}"/>
      ${typedRing}
      <circle class="ac-node-shape ${team.is_mentor ? "ac-node-mentor" : ""}" r="${r.toFixed(1)}" style="${escAttr(shadeStyle)}"/>
      ${constNodeLabelSvg(labelLines, labelX, labelY, labelAnchor, fullLabel)}
    </g>`;
  }).join("");

  // The old LINE SOURCE legend lives inside the sentence bar now — its
  // two rows became the "backed by" evidence chips (same data-legend-edge
  // hover-isolate contract, plus click-to-pin via data-edge-tier on the
  // stage). Node color stays domain in every lens; cluster identity is
  // read from the labeled wells, so no legend swaps with the lens.
  const containerMarkup = containers.map((c, idx) =>
    constBubbleContainerSvg(c, constWellAccentStyle(constWellAccentTokens(c.id, idx)))
  ).join("");
  state.canvas.innerHTML = `
    <div class="alch-cohort-page" data-cohort-view="${escAttr(viewMode)}">
    ${cohortPageHead(viewMode)}
      <div class="alch-view-controls" data-shape-occluder>
        ${constTimelineDropdownHtml()}
        ${constellationSentenceBar({ view: viewMode, scope: "projects", granularity })}
        ${constSelectionChipHtml()}
      </div>
    <div class="alch-constellation" data-constellation-view="${escAttr(viewMode)}">
      <div class="alch-const-workbench">
        <div class="alch-const-main">
          <div class="alch-constellation-stage" data-view="${escAttr(viewMode)}" data-lens="${activeLens}" data-edge-tier="${escAttr(edgeTier)}" data-interest="${escAttr(interestCtx.id)}" data-interest-active="${interestCtx.active ? "true" : "false"}" tabindex="0" aria-label="${escAttr(viewMode === "ring" ? "constellation bridge ring graph" : "constellation relationship graph")}">
            <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
              <defs>
                <marker id="ac-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z"/>
                </marker>
                <marker id="ac-arrow-soft" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse">
                  <path d="M0,0 L10,5 L0,10 z"/>
                </marker>
              </defs>
              <g class="ac-wells">${containerMarkup}</g>
              <g class="ac-edges"></g>
              <g class="ac-nodes">${nodeMarkup}</g>
            </svg>
            <div class="ac-tip" hidden></div>
          </div>
        </div>
        ${constellationInspectorShell(inspectorCtx)}
      </div>
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
export async function launchPRFlow({ kind, path, value }) {
  let res;
  try {
    const githubFork = await githubForkLazy.load();
    res = await githubFork.resolvePRForCurrentUser({ kind, path, value });
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
    githubForkLazy.load()
      .then((module) => module.clearForkCache(handle))
      .catch((error) => console.warn("[pr-launcher] clear fork cache failed:", error?.message || error));
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
  const isNestedControl = (e, card) => {
    const target = e?.target;
    return target instanceof Element
      && target !== card
      && !!target.closest("a, button, input, select, textarea, [data-no-card-click]");
  };
  for (const card of cards) {
    card.addEventListener("click", (e) => {
      if (isNestedControl(e, card)) return;
      openDetail(card.dataset.recordId);
    });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        if (isNestedControl(e, card) || e.target !== card) return;
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

function normalizeDetailReturnMode(mode) {
  if (mode === "collab") return "constellation";
  if (mode === "pulse") return "shapes";
  if (mode === "intel") return "context";
  return ALCHEMY_MODES.includes(mode) ? mode : "shapes";
}

function clearDetailForNavigation() {
  state.detailRecordId = null;
  state.detailReturnMode = null;
  try { localStorage.removeItem(DETAIL_LS_KEY); } catch {}
}

function directoryMembershipForRecord(record, kind) {
  const chips = kind === "person" ? PERSON_ROLE_CHIPS : TEAM_MEMBERSHIP_CHIPS;
  const directId = kind === "person"
    ? (record?.role_class || "visiting-scholar")
    : (record?.membership || "visiting");
  const direct = chips.find(chip => chip.id === directId && chip.match(record));
  if (direct) return direct.id;
  const match = chips.find(chip => chip.id !== "all" && chip.match(record));
  return match ? match.id : "all";
}

function focusDirectoryRecord(recordId) {
  const focus = () => {
    let card = null;
    try {
      card = state.canvas?.querySelector(`.alch-card[data-record-id="${cssAttr(recordId)}"]`) || null;
    } catch {}
    if (!card) return;
    try { card.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" }); } catch {}
    try { card.focus({ preventScroll: true }); }
    catch {
      try { card.focus(); } catch {}
    }
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
  else setTimeout(focus, 0);
}

function openDirectoryRecord(recordId) {
  if (!recordId) return false;
  const id = String(recordId);
  const cohortIndex = buildCohortIndex(state.cohort);
  const team = cohortIndex.teamById.get(id);
  const person = cohortIndex.personById.get(id);
  if (!team && !person) return false;
  const kind = person ? "person" : "team";
  const record = person || team;
  clearDetailForNavigation();
  state.mode = "shapes";
  state.shapesKindFilter = kind === "person" ? "people" : "works";
  state.shapesMembershipFilter = directoryMembershipForRecord(record, kind);
  try { localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); } catch {}
  syncRailSelection();
  render();
  focusDirectoryRecord(id);
  return true;
}

function openDetail(recordId, returnMode = state.mode || "shapes") {
  if (!recordId) return;
  const mode = normalizeDetailReturnMode(returnMode);
  state.mode = mode;
  state.detailRecordId = String(recordId);
  // Remember where to land on back. Constellation sub-views keep their
  // own state in state.constellationMode, so restoring "constellation"
  // returns to map/journey/stack/collab rather than the generic cohort grid.
  state.detailReturnMode = mode;
  try {
    localStorage.setItem(ALCHEMY_LS_KEY, mode);
    localStorage.setItem(DETAIL_LS_KEY, JSON.stringify({
      recordId: state.detailRecordId,
      returnMode: state.detailReturnMode,
    }));
  } catch {}
  const update = () => {
    render();
    // Scroll the canvas to the top so the hero is in view.
    try { state.canvas?.scrollTo({ top: 0, behavior: "auto" }); } catch {}
  };
  // Sigil continuity: tag the clicked card's canvas so the same-document
  // view transition morphs it into the dossier hero (the rail canvas
  // carries the matching view-transition-name statically in styles.css).
  // Forward direction only — back to the grid stays instant.
  let cardCanvas = null;
  try {
    cardCanvas = state.canvas?.querySelector(
      `.alch-card[data-record-id="${CSS.escape(state.detailRecordId)}"] canvas`
    ) || null;
  } catch {}
  const reduceMotion = typeof matchMedia === "function"
    && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (cardCanvas && !reduceMotion && typeof document.startViewTransition === "function") {
    cardCanvas.style.viewTransitionName = "sr-sigil";
    document.startViewTransition(update);
  } else {
    update();
  }
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

// Click the bare canvas background — the gutter / empty space around the
// dossier, i.e. anything outside the box — to pop back to the directory.
// A cheap escape hatch on top of the back button + breadcrumb. Bound once:
// state.canvas survives innerHTML swaps, so a per-render bind would stack.
// Guarded so it only fires while a detail is open and only for clicks that
// land on the canvas ITSELF — never the dossier, the nav strip, or any
// interactive child (those are deeper targets, so e.target !== canvas).
function wireDetailDismiss() {
  if (state.detailDismissBound) return;
  state.detailDismissBound = true;
  state.canvas.addEventListener("click", (e) => {
    if (!state.detailRecordId) return;
    if (e.target !== state.canvas) return;
    closeDetail();
  });
}

// ─── constellation hover ─────────────────────────────────────────────
function wireConstellationHover() {
  wireConstellationModeNav();
  const stage = state.canvas.querySelector(".alch-constellation-stage");
  // Selection chip + readout name-links live OUTSIDE the inspector (which
  // has its own delegated handler), so the canvas owns them. Bound once —
  // state.canvas survives innerHTML swaps, so per-render binds would pile up.
  if (!state.constellationCanvasActionsBound) {
    state.constellationCanvasActionsBound = true;
    state.canvas.addEventListener("click", (e) => {
      if (state.mode !== "constellation" || state.detailRecordId) return;
      if (e.target.closest(".ac-inspector")) return;
      const clearTarget = e.target.closest("[data-const-clear-selection]");
      if (clearTarget) {
        state.constSelection = null;
        render();
        return;
      }
      const openTarget = e.target.closest("[data-const-open-record]");
      if (openTarget) {
        const rid = openTarget.getAttribute("data-const-open-record");
        if (rid) openDirectoryRecord(rid) || openDetail(rid);
      }
    });
  }
  if (!state.constellationEscapeBound) {
    state.constellationEscapeBound = true;
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape" || !state.constSelection || state.mode !== "constellation") return;
      const editing = e.target?.closest?.("input, textarea, select, [contenteditable='true']");
      if (editing) return;
      if (!state.canvas?.querySelector(".alch-constellation")) return;
      e.preventDefault();
      // journey/stack drive their selected-readout from the markup, not a live
      // .ac-inspector panel — setConstellationInspector can't reach it, so clear
      // selection and re-render. Map/ring/people have the panel and update live.
      if (!state.canvas.querySelector(".ac-inspector")) {
        state.constSelection = null;
        render();
        return;
      }
      setConstellationInspector(null, constellationCurrentInspectorContext());
    });
  }
  if (stage) {
    // ONE styled floating tooltip serves both the map and the journey scatter
    // (was a fixed hover-line on the map + a separate floating tip on journey).
    const tip = stage.querySelector(".ac-tip");
    const cohort = activeConstellationCohort();
    const teams = cohort?.teams || [];
    const clusters = cohort?.clusters || [];
    const teamById = new Map(teams.map(t => [t.record_id, t]));
    const edges = constellationDependencyEdges(teams, undefined, cohort?.dependencies || []).filter(e => teamById.has(e.from) && teamById.has(e.to));
    const model = constellationModel(teams, clusters, cohort?.dependencies || []);
    const rawMode = constNormalizeConstellationMode(state.constellationMode);
    const baseMode = rawMode === "collab" ? "map" : rawMode;
    const scope = baseMode === "map" ? constNormalizeNetworkScope(state.constellationScope) : "projects";
    // The projects relationship map renders as the bubble map; its inspector
    // ctx.mode must be "bubble" so the sidebar shows the positional read, not
    // the collab action card (people scope keeps the node-link people network).
    const viewMode = (baseMode === "map" && scope === "projects") ? "bubble" : baseMode;
    const activeLens = viewMode === "ring" || viewMode === "stack" ? "all" : constNormalizeConstellationLens(state.constellationLens);
    const baseInspectorCtx = { ...constellationInspectorContext(teams, edges, cohort?.people || []), clusters, distributionWells: model.wellsDef, lens: activeLens, mode: viewMode, scope, interest: constInterestContext(teams, clusters, edges, state.constInterest) };
    const peopleModel = scope === "people" ? constPeopleNetworkModel(cohort?.people || [], teams, 1120, 620) : null;
    const inspectorCtx = viewMode === "stack"
      ? { ...baseInspectorCtx, stackModel: constProductStackModel(teams, baseInspectorCtx) }
      : (peopleModel ? { ...baseInspectorCtx, peopleModel } : baseInspectorCtx);
    const indeg = constellationIndegree(teams, cohort?.dependencies || []);
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
    // Two-click grammar, shared by every entity mark on every cohort view:
    // first click selects (the view's sidebar/readout answers in this
    // view's terms); clicking the SAME entity again commits to its full
    // record page. Views without a live inspector panel (journey, stack)
    // re-render so their readout picks the selection up.
    const selectOrOpen = (type, rid) => {
      if (!rid) return;
      if (state.constSelection?.type === type && state.constSelection.rid === rid) {
        openDetail(rid);
        return;
      }
      if (state.canvas?.querySelector(".ac-inspector")) {
        setConstellationInspector({ type, rid }, inspectorCtx);
      } else {
        state.constSelection = { type, rid };
        render();
      }
    };
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
    // Bubble map: hover UPDATES THE SIDE INSPECTOR (one info surface, not a
    // separate floating tip), focuses/dims the hovered bubble, and click pins
    // the team — whose inspector leads with its intersection (Venn) view. The
    // legacy map/ring path still uses the provenance tooltip.
    const isBubble = stage.getAttribute("data-view") === "bubble";
    let lastPreviewRid = null;
    const previewInspector = (rid) => {
      if (rid === lastPreviewRid) return; // de-thrash re-entering the same bubble
      const body = state.canvas?.querySelector(".ac-inspector-body");
      const t = teamById.get(rid);
      if (!body || !t) return;
      const pinnedRid = state.constSelection?.type === "team" ? state.constSelection.rid : null;
      // Hovering the pinned team: just drop any strip — its dossier is already up.
      if (pinnedRid === rid) { body.querySelector(".ac-hover-strip")?.remove(); lastPreviewRid = rid; return; }
      lastPreviewRid = rid;
      if (pinnedRid) {
        // A team is pinned: don't clobber its dossier — float a compact preview
        // strip on top, leaving the pinned intersection view intact below.
        let strip = body.querySelector(".ac-hover-strip");
        if (!strip) { strip = document.createElement("div"); strip.className = "ac-hover-strip"; body.prepend(strip); }
        strip.innerHTML = constTeamPreviewHtml(t, inspectorCtx);
      } else {
        body.innerHTML = constTeamPreviewHtml(t, inspectorCtx);
      }
    };
    const restoreInspector = () => {
      lastPreviewRid = null;
      const body = state.canvas?.querySelector(".ac-inspector-body");
      if (!body) return;
      body.querySelector(".ac-hover-strip")?.remove();
      if (state.constSelection) return; // pinned dossier stays put
      body.innerHTML = constellationInspectorLeadHtml(inspectorCtx, state.constSelection) + constellationInspectorHtml(state.constSelection, inspectorCtx);
      wireExternalLinks(body);
    };
    // Click/Enter a container ring to focus its space: its member bubbles stay
    // lit while the rest of the cohort dims. Works at EVERY grain (theme /
    // cluster / skill) via the descendant-member set; re-trigger clears.
    const clearContainerFocus = () => {
      stage.removeAttribute("data-container-focus");
      stage.querySelectorAll(".ac-node-group.is-container-core").forEach(n => n.classList.remove("is-container-core"));
    };
    const focusContainer = (el) => {
      const cid = el.getAttribute("data-container");
      if (stage.getAttribute("data-container-focus") === cid) { clearContainerFocus(); return; }
      const members = new Set((el.getAttribute("data-members") || "").split(" ").filter(Boolean));
      stage.setAttribute("data-container-focus", cid);
      stage.querySelectorAll(".ac-node-group").forEach(n => n.classList.toggle("is-container-core", members.has(n.dataset.recordId)));
    };
    if (isBubble) {
      for (const c of stage.querySelectorAll(".ac-bubble-container[data-container]")) {
        c.addEventListener("click", (e) => { e.preventDefault(); focusContainer(c); });
        c.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); focusContainer(c); });
      }
    }
    for (const g of stage.querySelectorAll(".ac-node-group")) {
      const rid = g.dataset.recordId;
      g.addEventListener("mouseenter", (e) => {
        setConstellationHover(stage, rid, true);
        if (isBubble) { previewInspector(rid); return; }
        const t = teamById.get(rid);
        if (tip && t) {
          tip.innerHTML = constNodeTipHTML(t, indeg.get(rid) || 0, inspectorCtx.outBy, inspectorCtx.inBy, clusterLabelsByRid.get(rid), sourceStatsByRid.get(rid));
          tip.hidden = false;
          positionConstTip(stage, tip, e);
        }
      });
      g.addEventListener("mousemove", (e) => { if (!isBubble) positionConstTip(stage, tip, e); });
      g.addEventListener("mouseleave", () => {
        setConstellationHover(stage, rid, false);
        if (isBubble) { restoreInspector(); return; }
        if (tip) tip.hidden = true;
      });
      g.addEventListener("click", (e) => {
        e.preventDefault();
        if (isBubble) clearContainerFocus();
        selectOrOpen("team", rid);
      });
      g.addEventListener("focus", () => {
        setConstellationHover(stage, rid, true);
        if (isBubble) previewInspector(rid);
      });
      g.addEventListener("blur", () => { setConstellationHover(stage, rid, false); if (isBubble) restoreInspector(); });
      g.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        if (isBubble) clearContainerFocus();
        selectOrOpen("team", rid);
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
        selectOrOpen("team", rid);
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
        selectOrOpen("team", rid);
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
        selectOrOpen("team", rid);
      });
      node.addEventListener("focus", () => {
        showJourneyTip(stage, tip, teamById.get(rid));
      });
      node.addEventListener("blur", () => { if (tip) tip.hidden = true; });
      node.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        selectOrOpen("team", rid);
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
        selectOrOpen("person", rid);
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
        selectOrOpen("person", rid);
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
        selectOrOpen("team", rid);
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
        selectOrOpen("team", rid);
      });
      group.addEventListener("focus", () => setConstellationPersonProjectHover(stage, rid, true));
      group.addEventListener("blur", () => setConstellationPersonProjectHover(stage, rid, false));
      group.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        selectOrOpen("team", rid);
      });
    }
  }
  // Graph scope: project network ↔ people network (sentence-menu option).
  for (const btn of state.canvas.querySelectorAll("[data-const-network-scope]")) {
    btn.addEventListener("click", () => {
      const next = constNormalizeNetworkScope(btn.dataset.constNetworkScope);
      if (next === state.constellationScope) { closeConstSentenceMenus(); return; }
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
  // Bubble granularity: themes / clusters / skills — fewer↔more circles. Took
  // over the old map/ring layout slot (those layouts are retired).
  for (const btn of state.canvas.querySelectorAll("[data-const-granularity]")) {
    btn.addEventListener("click", () => {
      const next = constNormalizeGranularity(btn.dataset.constGranularity);
      if (next === state.constellationGranularity) { closeConstSentenceMenus(); return; }
      state.constellationGranularity = next;
      state.constSelection = null;
      try { localStorage.setItem(CONST_GRANULARITY_LS_KEY, next); } catch {}
      // Morph bubbles between grains via View Transitions (named per team), so
      // the cohort reshapes instead of hard-cutting. Falls back to a plain
      // render where unsupported or when reduced motion is requested.
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      if (document.startViewTransition && !reduce) document.startViewTransition(() => render());
      else render();
    });
  }
  // Map lens: re-weights the same map by line type. Persisted.
  for (const btn of state.canvas.querySelectorAll("[data-const-lens]")) {
    btn.addEventListener("click", () => {
      const next = constNormalizeConstellationLens(btn.dataset.constLens);
      if (next === state.constellationLens) { closeConstSentenceMenus(); return; }
      state.constellationLens = next;
      try { localStorage.setItem(CONST_LENS_LS_KEY, next); } catch {}
      render();
    });
  }
  // Sentence tokens open their option listbox; selections re-render the
  // view, which rebuilds the bar closed.
  wireConstSentenceTokens();
  // Evidence chips: hover previews a line tier (CSS :has), click pins it.
  for (const chip of state.canvas.querySelectorAll("[data-edge-tier-toggle]")) {
    chip.addEventListener("click", () => {
      const tier = constNormalizeEdgeTier(chip.dataset.edgeTierToggle);
      state.constEdgeTier = state.constEdgeTier === tier ? "all" : tier;
      try { localStorage.setItem(CONST_TIER_LS_KEY, state.constEdgeTier); } catch {}
      render();
    });
  }
  // People-map link chips: hover previews a link family, click pins it.
  for (const chip of state.canvas.querySelectorAll("[data-people-link-toggle]")) {
    chip.addEventListener("click", () => {
      const next = constNormalizePeopleLinkFilter(chip.dataset.peopleLinkToggle);
      state.constPeopleLinkFilter = state.constPeopleLinkFilter === next ? "all" : next;
      try { localStorage.setItem(CONST_PEOPLE_LINK_LS_KEY, state.constPeopleLinkFilter); } catch {}
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
  // Journey filters: toggle teams / projects / side projects (sentence chips).
  const jf = state.journeyFilters;
  for (const btn of state.canvas.querySelectorAll("[data-jfilter]")) {
    btn.addEventListener("click", () => {
      const key = btn.dataset.jfilter;
      if (jf && key in jf) { jf[key] = !jf[key]; render(); }
    });
  }
  // Journey bottleneck: legend buttons isolate one bottleneck (click again
  // to clear); the sentence's "stuck on" chip carries the same attribute,
  // so clicking it re-toggles — i.e. clears — the active one.
  for (const btn of state.canvas.querySelectorAll("[data-jbottleneck]")) {
    btn.addEventListener("click", () => {
      if (!jf) return;
      const b = btn.dataset.jbottleneck;
      jf.bottleneck = jf.bottleneck === b ? null : b;
      render();
    });
  }
  for (const btn of state.canvas.querySelectorAll("[data-standing-filter]")) {
    btn.addEventListener("click", () => {
      const next = constNormalizeGoalStandingFilter(btn.dataset.standingFilter);
      state.goalStandingFilter = state.goalStandingFilter === next ? "all" : next;
      render();
    });
  }
  // Standing projection toggle (trajectory ⇄ gap to target) — the folded-in
  // "targets" view, now a lens within standing.
  for (const btn of state.canvas.querySelectorAll("[data-standing-projection]")) {
    btn.addEventListener("click", () => {
      const next = btn.dataset.standingProjection === "targets" ? "targets" : "trajectory";
      if (state.standingProjection === next) return;
      state.standingProjection = next;
      render();
    });
  }
  // Momentum chips in the insight strip filter by movement (climbing/slipping/
  // steady) — orthogonal to the standing filter; both dim together.
  for (const btn of state.canvas.querySelectorAll("[data-momentum-filter]")) {
    btn.addEventListener("click", () => {
      const next = constNormalizeGoalMomentumFilter(btn.dataset.momentumFilter);
      state.goalMomentumFilter = state.goalMomentumFilter === next ? "all" : next;
      render();
    });
  }
  const inspector = state.canvas.querySelector(".ac-inspector");
  if (inspector) {
    wireExternalLinks(inspector);
    // Keyboard parity for the per-company overlap co-members (Enter/Space
    // recenters, matching the click delegation below).
    inspector.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const egoTarget = e.target.closest("[data-ego-refocus]");
      if (!egoTarget) return;
      e.preventDefault();
      const rid = egoTarget.getAttribute("data-ego-refocus");
      if (rid) setConstellationInspector({ type: "team", rid }, constellationCurrentInspectorContext());
    });
    inspector.addEventListener("click", (e) => {
      const clearTarget = e.target.closest("[data-const-clear-selection]");
      if (clearTarget) {
        setConstellationInspector(null, constellationCurrentInspectorContext());
        return;
      }
      // Per-company overlap: clicking a co-member recenters the overlap on it
      // (partial inspector update; the bubble map canvas is untouched).
      const egoTarget = e.target.closest("[data-ego-refocus]");
      if (egoTarget) {
        const rid = egoTarget.getAttribute("data-ego-refocus");
        if (rid) setConstellationInspector({ type: "team", rid }, constellationCurrentInspectorContext());
        return;
      }
      const openTarget = e.target.closest("[data-const-open-record]");
      if (openTarget) {
        // Name links return to the roster card; graph marks still keep the
        // two-click grammar that opens the full dossier.
        const rid = openTarget.getAttribute("data-const-open-record");
        if (rid) openDirectoryRecord(rid) || openDetail(rid, "constellation");
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
  // Keep the controls-row selection chip in sync without a full re-render
  // (it's the cross-view cue + the discoverable clear).
  const controls = state.canvas?.querySelector(".alch-view-controls");
  if (controls) {
    controls.querySelector(".ac-selection-chip")?.remove();
    const chipHtml = constSelectionChipHtml();
    if (chipHtml) controls.insertAdjacentHTML("beforeend", chipHtml);
  }
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
  // A selection the current view can't show must not dim the view: when no
  // mark classified as core (the selected record is filtered out, lives in
  // the other scope, or this view doesn't plot it), dimming everything
  // reads as a broken page. Drop the dim; the selection chip in the view
  // controls stays as the cross-view cue.
  if (stage && !root.querySelector(".is-selection-core")) {
    stage.removeAttribute("data-selection-active");
    root.querySelectorAll(".is-selection-outside").forEach(el => el.classList.remove("is-selection-outside"));
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
  for (const btn of state.canvas.querySelectorAll(".alch-page-view-btn[data-const-mode]")) {
    btn.addEventListener("click", () => {
      // "directory" is the roster grid — internally the shapes mode. The
      // other views are constellation sub-views. Same page, one nav.
      if (btn.dataset.constMode === "directory") {
        if (state.mode === "shapes") return;
        state.mode = "shapes";
        try { localStorage.setItem(ALCHEMY_LS_KEY, "shapes"); } catch {}
        syncRailSelection();
        render();
        return;
      }
      const next = constNormalizeConstellationMode(btn.dataset.constMode);
      const current = constNormalizeConstellationMode(state.constellationMode);
      if (state.mode === "constellation" && next === current) return;
      state.mode = "constellation";
      state.constellationMode = next;
      try {
        localStorage.setItem(CONST_MODE_LS_KEY, next);
        localStorage.setItem(ALCHEMY_LS_KEY, "constellation");
      } catch {}
      syncRailSelection();
      render();
    });
  }
  // Roving-tabindex tablist keyboard contract: arrows/Home/End move focus
  // between tabs (manual activation — Enter/Space fires the native click above
  // to switch the view), matching the role="tablist" the markup promises.
  const tabs = [...state.canvas.querySelectorAll(".alch-page-view-btn[data-const-mode]")];
  for (const btn of tabs) {
    btn.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(btn);
      let j = -1;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") j = (i + 1) % tabs.length;
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = tabs.length - 1;
      else return;
      e.preventDefault();
      tabs[j].focus();
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
const CAL_DAY_W      = 22;        // pixel width per day column — MUST match drawCalendar's column width in cohort-calendar.js (the painter lays out columns at its own 22px; sizing the canvas any tighter clips the right edge). The container scrolls horizontally by design (see note above).
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

// ─── calendar — one-view timeline ─────────────────────────────────────
// Days as columns left→right, vertical hour axis, time-positioned event
// blocks (renderer lives in calendar.js), with presence (availability
// gantt) as a second tab. Graduated from its "calendar2" trial 2026-06;
// the legacy day/week/presence page (cohort-calendar-week.js renderWeekView)
// was retired with it.

// Live calendar source order: prefer the Supabase grid published by the
// calendar-sync workflow (fresh within the hour, no git/Vercel round-trip),
// then fall back to the os-web calendar.json fetch + bundled snapshot. Returns
// the same { data, source } shape loadCalendarData does so the call sites are
// unchanged; a Supabase hit reports "live" so the offline banner
// (source === "bundled") stays hidden.
async function loadLiveCalendar({ bundled } = {}) {
  try {
    const { fetchPublicCalendarGrid } = await calendarSupabaseLazy.load();
    const { grid } = await fetchPublicCalendarGrid({ storage: globalThis.localStorage });
    if (grid && grid.tabs) return { data: grid, source: "live" };
  } catch {
    // fall through to the HTTP + bundle path
  }
  return loadCalendarData({ bundled });
}

function seedCalendarData() {
  const cal = state.calendar;
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
  loadLiveCalendar({ bundled }).then(res => {
    cal.data = res.data || cal.data;
    cal.source = res.source || cal.source;
    cal.loading = false;
    if (state.mode === "calendar") refreshCalendarView();
  }).catch(() => { cal.loading = false; });
}

function renderCalendarLoadState(error = null) {
  if (!state.canvas) return;
  const message = error
    ? `calendar failed to load: ${escHtml(error?.message || String(error))}`
    : "loading calendar...";
  state.canvas.innerHTML = `<p class="alch-callout"><strong>${message}</strong></p>`;
}

function ensureCalendarSurfaceLoaded() {
  const loadError = calendarLazy.error();
  if (loadError) {
    renderCalendarLoadState(loadError);
    return;
  }

  renderCalendarLoadState();
  calendarLazy.load()
    .then(() => {
      if (!state.mounted || state.mode !== "calendar" || state.detailRecordId) return;
      render({ instant: true });
    })
    .catch((error) => {
      console.warn("[alchemy] calendar surface failed to load:", error?.message || error);
      if (state.mounted && state.mode === "calendar" && !state.detailRecordId) {
        renderCalendarLoadState(error);
      }
    });
}

function paintCalendarView({ wire = false } = {}) {
  seedCalendarData();
  const calendarModule = calendarLazy.peek();
  if (!calendarModule) {
    ensureCalendarSurfaceLoaded();
    return;
  }
  const cal = state.calendar;
  if (cal.weekIdx == null) cal.weekIdx = calendarCurrentWeekIdx();
  // Tear down the previous now-line ticker before swapping markup so
  // intervals don't stack across repaints.
  if (cal.detach) { cal.detach(); cal.detach = null; }
  const presence = cal.view === "presence";
  state.canvas.innerHTML = calendarModule.renderCalendarPage({
    data: cal.data,
    calendarGoogleEvents: state.cohort?.calendar_google_events || {},
    weekIdx: cal.weekIdx,
    source: cal.source,
    view: cal.view,
    presenceHtml: presence ? renderCalAvailability() : "",
  });
  if (presence) {
    mountAvailabilityCanvas();
    applyPresenceFocus();
  } else {
    cal.detach = calendarModule.attachCalendarPageBehavior(state.canvas, { scrollToNow: cal.initialMount });
    cal.initialMount = false;
  }
  if (wire) wireCalendar();
}

function refreshCalendarView() {
  if (state.mode !== "calendar" || !state.canvas) {
    render();
    return;
  }
  paintCalendarView({ wire: true });
  // Live calendar data just painted in while the user is on the page —
  // that counts as seen (mirrors the what's-new stamp in render()).
  if (state.active && !document.hidden) {
    markFingerprintsSeen("calendar-grid", calendarFingerprints());
    updateRailUnread();
  }
}

function renderCalendar() {
  paintCalendarView({ wire: false });
}

// Wire interactions: view tabs, week nav + scrubber, retry, the presence
// extras, and the event-detail modal (delegated to calendar.js's model
// registry).
function wireCalendar() {
  const cal = state.calendar;

  // calendar / presence view tabs (shared .alch-page-views nav)
  for (const tab of state.canvas.querySelectorAll("[data-c2-view]")) {
    tab.addEventListener("click", () => {
      const next = tab.dataset.c2View;
      if (!next || next === cal.view) return;
      cal.view = next;
      refreshCalendarView();
    });
  }

  // presence-view extras — gantt export + the "edit my availability" jump.
  if (cal.view === "presence") {
    const pngBtn = state.canvas.querySelector("#cal-export-png");
    if (pngBtn) pngBtn.addEventListener("click", () => exportCalendar("png"));
    const pdfBtn = state.canvas.querySelector("#cal-export-pdf");
    if (pdfBtn) pdfBtn.addEventListener("click", () => exportCalendar("pdf"));
    const editAvail = state.canvas.querySelector(".cal-avail-edit[data-cal-go-profile]");
    if (editAvail) editAvail.addEventListener("click", () => {
      state.mode = "profile";
      try { localStorage.setItem(ALCHEMY_LS_KEY, "profile"); } catch {}
      syncRailSelection();
      render();
    });
  }

  for (const btn of state.canvas.querySelectorAll("[data-c2-nav]")) {
    btn.addEventListener("click", () => {
      const dir = btn.dataset.c2Nav;
      if (dir === "prev" && cal.weekIdx > 0) cal.weekIdx -= 1;
      else if (dir === "next" && cal.weekIdx < WEEKS_TOTAL - 1) cal.weekIdx += 1;
      else return;
      refreshCalendarView();
    });
  }

  for (const dot of state.canvas.querySelectorAll(".c2-scrub-dot[data-c2-week]")) {
    dot.addEventListener("click", () => {
      const i = Number(dot.dataset.c2Week);
      if (Number.isFinite(i) && i !== cal.weekIdx) {
        cal.weekIdx = i;
        refreshCalendarView();
      }
    });
  }

  for (const card of state.canvas.querySelectorAll("[data-c2-ev]")) {
    card.addEventListener("click", (event) => {
      calendarLazy.peek()?.openCalendarEvent?.(card.dataset.c2Ev, { anchor: event.currentTarget });
    });
  }

  for (const btn of state.canvas.querySelectorAll("[data-c2-retry]")) {
    btn.addEventListener("click", () => {
      cal.loading = true;
      const bundled = state.cohort?.calendar || null;
      loadLiveCalendar({ bundled }).then(res => {
        cal.data = res.data || cal.data;
        cal.source = res.source || cal.source;
        cal.loading = false;
        if (state.mode === "calendar") refreshCalendarView();
      }).catch(() => { cal.loading = false; });
    });
  }

  // External links (source footer).
  wireExternalLinks(state.canvas);
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

  return `
    <div class="cal-avail-wrap">
      <header class="cal-avail-head">
        <div>
          <div class="cal-avail-legend" aria-label="chart legend">
            <span class="cav-key"><i class="cav-sw cav-sw-present" aria-hidden="true"></i>present</span>
            <span class="cav-key"><i class="cav-sw cav-sw-absent" aria-hidden="true"></i>absence</span>
          </div>
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
          <!-- Freeze panes: sticky copies of the main canvas's edge regions
               (names column / date header), pinned by the compositor — no
               JS on the scroll path. The negative bottom margins collapse
               each sticky strip's flow space so the main canvas still
               starts at (0,0). See mountGanttFreezePanes. -->
          <div class="cal-gantt-wrap" style="width:${w}px; height:${h}px;">
            <canvas id="cal-canvas-corner" class="cal-gantt-corner" aria-hidden="true" style="margin-bottom:-${CAL_HEADER_H}px;"></canvas>
            <canvas id="cal-canvas-top" class="cal-gantt-top" aria-hidden="true" style="margin-bottom:-${CAL_HEADER_H}px;"></canvas>
            <canvas id="cal-canvas-left" class="cal-gantt-left" aria-hidden="true" style="margin-bottom:-${h}px;"></canvas>
            <canvas id="cal-canvas" width="${w}" height="${h}" style="width:${w}px; height:${h}px;" data-cal-w="${w}" data-cal-h="${h}" data-cal-numdays="${numDays}"></canvas>
          </div>
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
  mountGanttFreezePanes(cnv, w, h, dpr);
}

// Focus marker for the presence gantt. A dossier's "availability" jump
// lands here with cal.presenceFocus naming the person (or team) the
// visitor came from: scroll the row(s) into view and ring them. The rows
// are canvas-drawn, so the ring is a positioned DOM overlay computed from
// the same row geometry the painter uses. The focus outlives repaints
// (the async calendar load repaints right after the jump and wipes the
// overlay) but expires after a short window, and only scrolls once.
function applyPresenceFocus() {
  const cal = state.calendar;
  const focus = cal.presenceFocus;
  if (!focus) return;
  if (Date.now() - (focus.at || 0) > 15000) {
    cal.presenceFocus = null;
    return;
  }
  const wrap = state.canvas.querySelector(".cal-gantt-wrap");
  if (!wrap) return;
  const personIds = new Set(focus.people || []);
  const teamId = focus.team || null;
  let y = CAL_HEADER_H;
  const segments = [];
  for (const row of buildCalendarRows(state.cohort || {})) {
    const rowH = row.type === "team" ? CAL_TEAM_H : CAL_ROW_H;
    const hit = teamId
      ? row.team?.record_id === teamId
      : (row.type === "person" && personIds.has(row.person?.record_id));
    if (hit) {
      const last = segments[segments.length - 1];
      // Contiguous hits (a team block) merge into one ring.
      if (last && Math.abs(last.y + last.h - y) < 0.5) last.h += rowH;
      else segments.push({ y, h: rowH });
    }
    y += rowH;
  }
  if (!segments.length) {
    cal.presenceFocus = null;
    return;
  }
  for (const seg of segments) {
    const mark = document.createElement("div");
    mark.className = "cal-focus-row";
    mark.style.top = `${seg.y}px`;
    mark.style.height = `${seg.h}px`;
    wrap.appendChild(mark);
  }
  if (!focus.applied) {
    focus.applied = true;
    wrap.querySelector(".cal-focus-row")?.scrollIntoView({ block: "center", inline: "nearest" });
  }
}

// Freeze panes for the gantt. The whole chart is one canvas, so CSS sticky
// can't pin parts of it directly — instead the name column (left), the
// date header (top), and their corner are pixel-copies of the main
// canvas's edge regions on their own sticky canvases. The compositor pins
// them (flicker-free; no JS on the scroll path); the only scroll listener
// just toggles the cosmetic edge shadows. Copies are veiled slightly
// toward the page background so the frozen panes read quieter than the
// live grid moving beneath them.
function mountGanttFreezePanes(mainCnv, w, h, dpr) {
  const scroller = mainCnv.closest(".cal-scroll");
  const wrap      = mainCnv.closest(".cal-gantt-wrap");
  const leftCnv   = document.getElementById("cal-canvas-left");
  const topCnv    = document.getElementById("cal-canvas-top");
  const cornerCnv = document.getElementById("cal-canvas-corner");
  if (!scroller || !wrap || !leftCnv || !topCnv || !cornerCnv) return;

  // Everything in the gantt is transparent so the page's radial gradient
  // shows through and the table blends into the page: the main canvas is
  // cleared, .cal-scroll is transparent (styles.css), and the pinned freeze
  // panes (name column / date header) are left transparent here too — they
  // just carry the copied names/dates over the page gradient.
  // Trade-off (chosen deliberately): with no opaque pane backdrop, rows
  // scrolled beneath the pinned name column / date header are faintly visible
  // through them while you scroll the wide chart.
  const copyRegion = (cnv, cssW, cssH) => {
    cnv.width  = Math.round(cssW * dpr);
    cnv.height = Math.round(cssH * dpr);
    cnv.style.width  = cssW + "px";
    cnv.style.height = cssH + "px";
    const c = cnv.getContext("2d");
    c.drawImage(mainCnv, 0, 0, cnv.width, cnv.height, 0, 0, cnv.width, cnv.height);
  };
  copyRegion(leftCnv, CAL_LEFT_W, h);
  copyRegion(topCnv, w, CAL_HEADER_H);
  copyRegion(cornerCnv, CAL_LEFT_W, CAL_HEADER_H);

  const syncShadows = () => {
    wrap.classList.toggle("is-scrolled-x", scroller.scrollLeft > 0);
    wrap.classList.toggle("is-scrolled-y", scroller.scrollTop > 0);
  };
  scroller.addEventListener("scroll", syncShadows, { passive: true });
  syncShadows();
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

// One completion control per step, pinned to the right edge of the action
// row so "do it" (left) and "mark done" (right) read as opposite outcomes.
// Three honest states, each whose resting style encodes what a click does:
//   • auto-detected → passive gold chip ("detected"). The cohort surface
//     already knows this is done (e.g. profile fields synced), so there is
//     nothing to toggle — the override map is force-ON only and can't
//     un-detect a real signal. Not a button.
//   • manually done → solid gold pill, aria-pressed, click to undo.
//   • todo         → outlined neutral pill, click to mark done.
// The left-edge data-state spine remains the single PASSIVE completion
// signal; this is the single completion AFFORDANCE — no third encoding.
function onbCompleteControl(s) {
  const key = escAttr(s.key);
  if (s.autoComplete) {
    return `<span class="alch-onb-complete alch-onb-complete-auto" role="status"
                  title="detected from your synced cohort profile">
        <span class="alch-onb-complete-mark" aria-hidden="true"></span>detected
      </span>`;
  }
  if (s.overridden) {
    return `<button class="alch-onb-complete alch-onb-complete-on" type="button"
                    data-onb-toggle="${key}" aria-pressed="true"
                    title="marked done on this machine — click to undo">
        <span class="alch-onb-complete-mark" aria-hidden="true"></span>marked done
      </button>`;
  }
  return `<button class="alch-onb-complete" type="button"
                  data-onb-toggle="${key}" aria-pressed="false"
                  title="stored in localStorage on this machine">
      <span class="alch-onb-complete-mark" aria-hidden="true"></span>mark done
    </button>`;
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
  //   5. join matrix (human)  link to docs/MATRIX.md
  //   6. interview            local Router pop-out app
  //   B1. hermes              optional second agent, not shipped in this build
  //   B2. bot on matrix       /matrix-bot-setup skill + manual Matrix signup
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
      ask: `the cohort chats in matrix. the doc covers the <code>mtrx.shaperotator.xyz</code> homeserver, invite-code flow, Element room join, and who to DM if your code is missing or broken.`,
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
      ask: `Hermes is an autonomous second agent concept for background research and scheduled summaries. it is <em>not shipped in this build</em>; treat this as optional until a later build includes a working setup path.`,
      autoComplete: false,
      missingState: "info",
      bonus: true,
      action: { kind: "hermes-instructions", label: "show hermes status" },
    },
    {
      key: "agent-on-matrix",
      title: "add your bot to the matrix server",
      ask: `register your local agent as a bot in the cohort room so it can post + read on your behalf. use the <code>mtrx.shaperotator.xyz</code> signup code you receive after human Matrix promotion; the field-kit <code>/matrix-bot-setup</code> skill is a wrapper stub, so use the manual path when needed.`,
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
            ${onbCompleteControl(s)}
          </div>
        </div>
      </li>
    `;
  }).join("");

  // Overall progress — a single derived number stated in the dek and shown
  // as a thin gold rule. Core steps only (bonus rows never inflate the
  // denominator), matching the 01..06 / B1.. numbering split.
  const coreTotal  = steps.filter(s => !s.bonus).length;
  const bonusTotal = steps.filter(s =>  s.bonus).length;
  const doneCore   = steps.filter(s => !s.bonus && s.state === "complete").length;
  const corePct    = coreTotal ? Math.round((doneCore / coreTotal) * 100) : 0;

  state.canvas.innerHTML = `
    <header class="alch-onb-head">
      <h1 class="alch-onb-title">first week</h1>
      <p class="alch-onb-sub">${coreTotal} core${bonusTotal ? ` · ${bonusTotal} optional` : ""} — <strong>${doneCore} of ${coreTotal} done</strong></p>
      <div class="alch-onb-progress" role="progressbar"
           aria-valuemin="0" aria-valuemax="${coreTotal}" aria-valuenow="${doneCore}"
           aria-label="core onboarding progress">
        <span class="alch-onb-progress-fill" style="width:${corePct}%"></span>
      </div>
    </header>
    <ol class="alch-onb-steps">${stepHtml}</ol>
    <p class="alch-callout"><strong>onboarding · v0.5</strong><br/>
    progress is saved on this machine. steps marked <em>detected</em> read from your synced cohort profile, so they stay done across devices once your profile syncs.</p>
  `;
}

// ─── onboarding action modals ───────────────────────────────────────
// Step 03/04/05 actions don't route inside the app — they show a small
// modal with instructions or external links. Most current step buttons open
// docs directly; keep these fallbacks truthful in case the actions are wired
// back to in-app modals later.

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
  showOnboardingModal({
    title: "join the cohort matrix server",
    body: `
      <p class="alch-onb-modal-line">the cohort talks on matrix. you'll do this once, from your browser.</p>
      <ol class="alch-onb-modal-steps">
        <li>open <code>https://mtrx.shaperotator.xyz/join?code=YOUR_CODE</code> with the invite code you received on admission.</li>
        <li>Element opens on <code>#shape-rotator:mtrx.shaperotator.xyz</code>. Click <strong>Request to join</strong> and paste the code as the reason.</li>
        <li>complete the approver bot's short haiku captcha in the 1:1 vetting room.</li>
        <li>save the 10-use signup code the bot DMs you after promotion; that code onboards your agents.</li>
      </ol>
      <p class="alch-onb-modal-aux">recommended clients: <a href="https://element.io/download" data-external>element</a> (desktop) or <a href="https://app.element.io" data-external>element web</a>. if your code is missing or broken, DM <code>@socrates1024:matrix.org</code>.</p>
    `,
  });
}

function showBotMatrixInstructions() {
  showOnboardingModal({
    title: "have your agent join matrix",
    body: `
      <p class="alch-onb-modal-line">register your local agent as a bot in the cohort room so it can post research summaries, ship updates, etc. on your behalf.</p>
      <p class="alch-onb-modal-line"><strong>option A — claude code skill</strong> (recommended):</p>
      <pre class="alch-onb-modal-pre">/matrix-bot-setup</pre>
      <p class="alch-onb-modal-aux">if the slash command isn't recognized, install the skill first: <code>rotate install-skills</code> (after cloning <a href="https://github.com/dmarzzz/shape-rotator-field-kit" data-external>shape-rotator-field-kit</a>). the skill is still a wrapper stub; use the manual path when it does not cover your runtime yet.</p>
      <p class="alch-onb-modal-line"><strong>option B — manual</strong>:</p>
      <ol class="alch-onb-modal-steps">
        <li>use the 10-use signup code DMed to you after human promotion.</li>
        <li>open <code>https://mtrx.shaperotator.xyz/signup?code=YOUR_SIGNUP_CODE</code> and create an <code>@your-bot:mtrx.shaperotator.xyz</code> identity.</li>
        <li>wire those credentials into your agent; use <a href="https://github.com/mautrix/python" data-external>mautrix-python</a> if you need practical E2EE support.</li>
      </ol>
      <p class="alch-onb-modal-aux">see <a href="https://github.com/dmarzzz/shape-rotator-os/blob/main/docs/MATRIX.md" data-external>docs/MATRIX.md</a> for the current operational notes.</p>
    `,
  });
}

function showInterviewQuizLinks() {
  showOnboardingModal({
    title: "interview status",
    body: `
      <p class="alch-onb-modal-line">the cohort interview is no longer an external form. it runs in the local Router pop-out and drafts an intro for you to review before anything posts.</p>
      <ul class="alch-onb-modal-steps">
        <li><strong>open router</strong> from this onboarding row or the Apps grid.</li>
        <li><strong>answer the intro questions</strong>; Router saves the interview transcript locally and stages the generated intro.</li>
        <li><strong>review before posting</strong>; no separate quiz URL is configured in this build.</li>
      </ul>
      <p class="alch-onb-modal-aux">if Router cannot open, use the Apps → Router card and check the local Router connection screen.</p>
    `,
  });
}

function showHermesInstructions() {
  showOnboardingModal({
    title: "hermes agent setup",
    body: `
      <p class="alch-onb-modal-line">Hermes is not available in this build. The earlier Ollama-based proof of concept is held out of the shipped onboarding path.</p>
      <p class="alch-onb-modal-aux">This bonus step can wait until a later build exposes a working Hermes setup path.</p>
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
  for (const btn of state.canvas.querySelectorAll("[data-onb-toggle]")) {
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
  if (current) {
    state.programPage = current.record_id;
    try { localStorage.setItem(PROGRAM_PAGE_LS_KEY, current.record_id); } catch {}
    if (state.container) state.container.dataset.alchProgramPage = current.record_id;
  } else if (state.container) {
    delete state.container.dataset.alchProgramPage;
  }
  return current;
}

// Per-page tab icons — same stroke style as the rail and view navs.
// Keyed by record_id; unknown pages get the generic document icon.
const PROGRAM_TAB_ICONS = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>',
  rules: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/></svg>',
  schedule: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>',
  success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
};
const PROGRAM_TAB_ICON_FALLBACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/></svg>';

function renderProgramTabs(pages, current) {
  return pages.map(p => `
    <button class="alch-prog-tab" type="button"
            data-program-page="${escAttr(p.record_id)}"
            aria-selected="${p.record_id === current.record_id}">
      <span class="alch-prog-tab-icon" aria-hidden="true">${PROGRAM_TAB_ICONS[p.record_id] || PROGRAM_TAB_ICON_FALLBACK}</span>
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
  try { localStorage.setItem(PROGRAM_PAGE_LS_KEY, state.programPage); } catch {}
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

export function currentAskContext() {
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
function collabTeamCompleteness(team) {
  const missing = [];
  if (!collabHasText(team.skill_areas)) missing.push("skill areas");
  if (!collabHasText(team.seeking)) missing.push("seeking");
  if (!collabHasText(team.offering)) missing.push("offering");
  if (!collabHasText(team.dependencies) && !collabHasText(team.pair_with)) missing.push("links");
  return missing;
}

const COLLAB_LENSES = new Set(["all", "deps", "needs"]);
const COLLAB_TEAM_FILTERS = new Set(["all", "needs", "offers"]);
const COLLAB_SORTS = new Set(["cluster", "intro", "dependency"]);

function normalizeCollabControls() {
  if (!COLLAB_LENSES.has(state.collabLens)) state.collabLens = "all";
  if (!COLLAB_TEAM_FILTERS.has(state.collabTeamFilter)) state.collabTeamFilter = "all";
  if (!COLLAB_SORTS.has(state.collabSort)) state.collabSort = "cluster";
  // Lenses answer "which signal should I inspect"; filters answer "which
  // teams should exist in this board." Keeping both active creates ambiguous
  // state and mismatched selected UI, so the team filter owns the board.
  if (state.collabTeamFilter !== "all" && state.collabLens !== "all") {
    state.collabLens = "all";
  }
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
  const dep = m.deps.has(R.rid + ">" + C.rid);
  const so = m.soByPair.get(R.rid + ">" + C.rid);
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
  const kMap = new Map(m.keystones.map(k => [k.rid, k]));
  const intro = new Map();
  for (const s of m.seekOffer) {
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
  // Collapse the default board to teams that actually carry a matrix signal —
  // a dependency (either direction) or a matched seek/offer. A 26×26 grid whose
  // densest layer fills ~12% of cells reads as empty; a team with no signal is
  // an all-blank row + column. Render and wiring share this function, so the
  // dropped indices stay consistent everywhere. Explicit scope filters
  // (seeking / offering) still show every team that DECLARED that field —
  // matched or not — so those token counts stay honest.
  const signalled = new Set();
  for (const key of m.deps) { const gt = key.indexOf(">"); signalled.add(key.slice(0, gt)); signalled.add(key.slice(gt + 1)); }
  for (const s of m.seekOffer) { signalled.add(s.seeker); signalled.add(s.offerer); }
  const out = m.ordered.filter(o => teamHas(o) && (filter !== "all" || signalled.has(o.rid)));
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
  return cohortRosterForTeam(state.cohort?.people || [], rid);
}

function collabCurrentModel() {
  const teams = (state.cohort?.teams || []).filter(t => t && t.record_id);
  return buildCollabModel(teams, state.cohort?.clusters || [], state.cohort?.dependencies || [], state.cohort?.cohort_vocab?.skill_areas || []);
}

function collabTeamByRecordId(rid, m = collabCurrentModel()) {
  return m?.byRecordId?.get(String(rid || "")) || null;
}

function collabTeamLinksSectionHtml(team) {
  const items = collabTeamLinkItems(team);
  if (!items.length) return "";
  // Compact inline hyperlinks (label only, side by side) — the URL is the
  // destination, not information worth a row each.
  return collabInspectorSection("links", `<div class="cb-link-row-inline">${items.map(item => `
    <a class="cb-link-inline" href="${escAttr(item.href)}" data-external title="${escAttr(item.display)}">${escHtml(item.label)}</a>
  `).join("")}</div>`, "is-links");
}

function collabTeamLinkItems(team) {
  return compactCohortLinkItems(team);
}

function collabTeamMark(team, className = "cb-inspector-mark") {
  const s = team ? shapeForTeam(team) : null;
  return `<span class="${escAttr(className)}${s ? "" : " is-empty"}" aria-hidden="true">${s ? shapeSvgByFam(s.fam, hashStr(team.record_id || team.name || "_")) : ""}</span>`;
}

function collabPersonMark(person, className = "cb-inspector-person-mark") {
  const rid = person?.record_id || person?.name || "_";
  const fam = Math.abs(hashStr(rid)) % 6;
  return `<i class="${escAttr(className)}" aria-hidden="true">${shapeSvgByFam(fam, hashStr(rid))}</i>`;
}

function collabInspectorPills(items) {
  const html = items
    .filter(item => item && item.label && item.value !== null && item.value !== undefined && item.value !== "")
    .map(item => `<span class="cb-inspector-pill"><strong>${escHtml(String(item.value))}</strong>${escHtml(item.label)}</span>`)
    .join("");
  return html ? `<div class="cb-inspector-pills">${html}</div>` : "";
}

function collabTeamMini(team, role = "") {
  if (!team) return "";
  return `<button type="button" class="cb-inspector-team" data-collab-cohort-open="${escAttr(team.record_id)}" title="show ${escAttr(team.name || team.record_id)} in directory">
    <span>${escHtml(team.name || team.record_id)}</span>
    ${role ? `<small>${escHtml(role)}</small>` : ""}
  </button>`;
}

function collabRouteRows(items) {
  const rows = (items || [])
    .filter(item => item && item.team)
    .map(item => `<button type="button" class="cb-route-row" data-collab-cohort-open="${escAttr(item.team.record_id)}" title="show ${escAttr(item.team.name || item.team.record_id)} in directory">
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

function collabTeamMetaInlineHtml(team, people = []) {
  const roster = cohortRosterSummary({
    kind: teamKind(team),
    roster: people,
    declaredCount: team?.members_count,
    maxNames: 2,
  });
  const rosterValue = roster.hasNames && roster.count <= 2
    ? roster.visible.map(person => person.name || person.record_id).join(" · ")
    : roster.fallback;
  const rows = [
    roster.count ? [roster.label, rosterValue] : null,
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

function collabLegendHtml(lens = "all") {
  // data-legend-cell drives hover-isolation on the matrix (CSS :has):
  // touching a key entry surfaces exactly the cells it describes.
  const lensKey = COLLAB_LENSES.has(lens) ? lens : "all";
  const filterEntry = ({ cell, lens: nextLens, mark, label, desc }) => `
      <button type="button" data-legend-cell="${escAttr(cell)}" data-collab-lens="${escAttr(nextLens)}" data-collab-legend-lens="${escAttr(nextLens)}" data-desc="${escAttr(desc)}" aria-pressed="${lensKey === nextLens ? "true" : "false"}" aria-label="${escAttr(`${label}: ${lensKey === nextLens ? "active filter; click to show all signals" : "click to filter"}`)}"><i class="cb-legend-mark ${escAttr(mark)}"></i><b>${escHtml(label)}</b></button>`;
  const keyEntry = ({ cell, mark, label, desc }) => `
      <span tabindex="0" data-legend-cell="${escAttr(cell)}" data-desc="${escAttr(desc)}"><i class="cb-legend-mark ${escAttr(mark)}"></i><b>${escHtml(label)}</b></span>`;
  return `
    <div class="cb-legend" aria-label="collab board legend">
      ${filterEntry({ cell: "dep", lens: "deps", mark: "dep", label: "dependency", desc: "This row team relies on the column team to do its work. Read it as: row needs column." })}
      ${filterEntry({ cell: "so", lens: "needs", mark: "so", label: "seek / offer", desc: "The row team is seeking something the column team has offered. Read it as: row seeks → column provides. A concrete match to introduce." })}
      ${keyEntry({ cell: "scale", mark: "so-scale", label: "match strength", desc: "How strong a seek/offer match is, shown by the cell's teal depth: paler = fewer shared terms, darker = more overlap." })}
      ${keyEntry({ cell: "key", mark: "key", label: "most depended-on", desc: "A team many others depend on; its column is densely filled." })}
    </div>`;
}

function collabLatentOverlapCards() {
  return cohortInsightCards("latent_overlap")
    .slice()
    .sort((a, b) =>
      sdsNumber(insightContent(b), "score") - sdsNumber(insightContent(a), "score")
      || String(a.title || "").localeCompare(String(b.title || "")));
}

function latentReadableList(values, cap = 3) {
  const list = [...new Set(insightArray(values).map(constText).filter(Boolean))];
  if (list.length <= cap) return list.join(", ");
  return `${list.slice(0, cap).join(", ")}, +${list.length - cap} more`;
}

function latentOverlapSummary(content, card) {
  const clauses = [];
  const skills = latentReadableList(content.shared_skill_areas, 3);
  const domain = constText(content.shared_domain);
  const dependencyTargets = latentReadableList(content.shared_dependency_targets, 2);
  const publicTerms = latentReadableList(content.shared_public_terms, 3);
  if (skills) clauses.push(`shared skills: ${skills}`);
  if (domain) clauses.push(`same domain: ${domain}`);
  if (dependencyTargets) clauses.push(`dependency target: ${dependencyTargets}`);
  if (!clauses.length && publicTerms) clauses.push(`public terms: ${publicTerms}`);
  if (clauses.length) return clauses.map(clause => clause.replace(/^./, c => c.toUpperCase())).join(". ") + ".";
  const fallback = constShortText(card?.summary || card?.claim_text || "", 160)
    .replace(/^No direct dependency record exists;\s*/i, "")
    .replace(/^the engine found\s*/i, "");
  return fallback || "Public overlap prompt; verify before routing.";
}

function latentActionText(action) {
  const text = constText(action);
  const key = text.toLowerCase();
  if (key === "verify overlap with the teams") return "verify with teams";
  if (key === "stage an intro if both sides want it") return "stage intro if wanted";
  if (key === "create a dependency record if the overlap is real") return "record dependency if real";
  if (key === "dismiss as false positive") return "dismiss false positive";
  return text;
}

function latentReviewLine(card) {
  return `${insightConfidenceLabel(card)} · ${insightReviewLabel(card)}`;
}

function collabLatentOverlapSectionHtml() {
  const cards = collabLatentOverlapCards().slice(0, 12);
  const teams = new Map((state.cohort?.teams || []).filter(t => t?.record_id).map(t => [t.record_id, t]));
  const cardHtml = cards.map((card) => {
    const ids = Array.isArray(card.subject_ids) ? card.subject_ids.map(String) : [];
    const a = teams.get(ids[0]);
    const b = teams.get(ids[1]);
    const aName = a?.name || ids[0] || "team A";
    const bName = b?.name || ids[1] || "team B";
    const content = insightContent(card);
    const clusters = content.clusters && typeof content.clusters === "object" ? content.clusters : {};
    const aMeta = [clusters[ids[0]]?.label, a ? domainLabel(a.domain) : "", a?.geo].filter(Boolean).join(" · ");
    const bMeta = [clusters[ids[1]]?.label, b ? domainLabel(b.domain) : "", b?.geo].filter(Boolean).join(" · ");
    const chips = [
      ...insightArray(content.shared_skill_areas),
      content.shared_domain,
      ...insightArray(content.shared_dependency_targets),
    ].map(constText).filter(Boolean);
    const uniqueChips = [...new Set(chips)].slice(0, 6);
    const publicTerms = latentReadableList(content.shared_public_terms, 3);
    const reasons = publicTerms ? [`Public terms: ${publicTerms}`] : [];
    const actions = insightArray(content.suggested_actions).map(latentActionText).slice(0, 3);
    const score = sdsNumber(content, "score");
    const dependencyLine = content.existing_dependency
      ? "recorded dependency exists; cross-check before routing."
      : "not recorded as a dependency.";
    return `
      <article class="cb-intro cb-latent-overlap">
        <div class="cb-latent-top">
          <span class="cb-intro-role">prompt</span>
          <span class="cb-underused-count">score ${escHtml(String(score))}</span>
        </div>
        <div class="cb-intro-flow">
          <button type="button" class="cb-latent-team cb-intro-side" data-collab-cohort-open="${escAttr(ids[0] || "")}" title="${escAttr(`show ${aName} in directory`)}">
            <span class="cb-intro-team">${escHtml(aName)}</span>
            ${aMeta ? `<span class="cb-intro-meta">${escHtml(aMeta)}</span>` : ""}
          </button>
          <div class="cb-intro-arrow" aria-hidden="true">&harr;</div>
          <button type="button" class="cb-latent-team cb-intro-side" data-collab-cohort-open="${escAttr(ids[1] || "")}" title="${escAttr(`show ${bName} in directory`)}">
            <span class="cb-intro-team">${escHtml(bName)}</span>
            ${bMeta ? `<span class="cb-intro-meta">${escHtml(bMeta)}</span>` : ""}
          </button>
        </div>
        <p class="cb-latent-summary">${escHtml(latentOverlapSummary(content, card))}</p>
        <p class="cb-latent-context">${escHtml(dependencyLine)}</p>
        ${uniqueChips.length ? `<div class="cb-intro-chips">${uniqueChips.map(c => `<span class="cb-chip">${escHtml(c)}</span>`).join("")}</div>` : ""}
        ${reasons.length ? `<div class="cb-latent-reasons"><b>public trace</b>${reasons.map(r => `<span>${escHtml(r)}</span>`).join("")}</div>` : ""}
        <div class="cb-latent-actions">
          <span class="cb-latent-review">${escHtml(latentReviewLine(card))}</span>
          ${actions.map(action => `<span>${escHtml(action)}</span>`).join("")}
        </div>
      </article>`;
  }).join("");
  return `
    <section class="alch-cb-section" data-cb-section="latent">
      <div class="alch-cb-sechead"><h3>Latent overlaps</h3><span class="cb-sub">public overlap prompts; verify before routing</span></div>
      <div class="cb-intro-grid">${cardHtml || '<p class="cb-empty">no overlap prompts.</p>'}</div>
    </section>`;
}

function collabInspectorDefaultHtml(m) {
  const top = m.keystones.slice(0, 3).map(k => collabTeamMini(k.team, `${k.inbound.length} inbound`)).join("");
  // At-rest readout, not a bare empty-state: lead with the board's strongest
  // finding (the top intro) and trail the below-fold sections — the matrix
  // fills the whole first viewport, so without this the intros / offers /
  // convergence sections are invisible until someone happens to scroll.
  const introByPair = new Map();
  for (const s of m.seekOffer) {
    const k = collabAffKey(s.seeker, s.offerer);
    if (!introByPair.has(k) || s.score > introByPair.get(k).score) introByPair.set(k, s);
  }
  const intros = [...introByPair.values()].sort((a, b) => b.score - a.score);
  const best = intros[0] || null;
  // Counts mirror the page sections exactly (both cap at 12 cards).
  const introCount = Math.min(intros.length, 12);
  const latentCount = Math.min(collabLatentOverlapCards().length, 12);
  const underusedCount = Math.min((m.underusedOffers || []).length, 12);
  const convergenceCount = (m.convergence || []).length;
  const trailerLinks = [
    introCount ? { id: "intros", label: `${introCount} intro${introCount === 1 ? "" : "s"} to make` } : null,
    latentCount ? { id: "latent", label: `${latentCount} overlap prompt${latentCount === 1 ? "" : "s"}` } : null,
    underusedCount ? { id: "offers", label: `${underusedCount} unmatched offer${underusedCount === 1 ? "" : "s"}` } : null,
    convergenceCount ? { id: "convergence", label: `${convergenceCount} shared focus area${convergenceCount === 1 ? "" : "s"}` } : null,
  ].filter(Boolean);
  const hero = best
    ? `
        <div class="cb-inspector-kicker">collab context · top intro</div>
        <h4 class="cb-inspector-title">${escHtml(best.seekerName || best.seeker)} → ${escHtml(best.offererName || best.offerer)}</h4>
        <p class="cb-inspector-copy">${escHtml(`${best.seekerName || best.seeker} is seeking what ${best.offererName || best.offerer} offers${best.shared?.length ? ` — ${best.shared.slice(0, 3).join(" · ")}` : ""}. Click any row, column, band, or cell to inspect a signal.`)}</p>`
    : `
        <div class="cb-inspector-kicker">collab context</div>
        <h4 class="cb-inspector-title">select a signal</h4>
        <p class="cb-inspector-copy">Click a row, column, cluster band, or cell to inspect who is involved, why the connection exists, and what to do next.</p>`;
  return `
    <div class="cb-inspector-hero">
      <div class="cb-inspector-identity">${hero}
      </div>
    </div>
    ${collabInspectorPills([
      { value: m.seekOffer.length, label: "seek/offers" },
      { value: m.deps.size, label: "dependencies" },
    ])}
    ${trailerLinks.length ? collabInspectorSection("below on this board", `
      <div class="cb-board-trailer">
        ${trailerLinks.map(l => `<button type="button" class="cb-trailer-link" data-collab-scroll="${escAttr(l.id)}"><span>${escHtml(l.label)}</span><i aria-hidden="true">↓</i></button>`).join("")}
      </div>`, "is-trailer") : ""}
    ${top ? collabInspectorSection("keystones", `<div class="cb-inspector-stack">${top}</div>`) : ""}
  `;
}

function collabTeamInspectorHtml(rid, m = collabCurrentModel()) {
  const team = collabTeamByRecordId(rid, m);
  if (!team) return collabInspectorDefaultHtml(m);
  const row = m.ordered.find(o => o.rid === rid);
  const inbound = (m.keystones.find(k => k.rid === rid)?.inbound || []).map(id => collabTeamByRecordId(id, m)).filter(Boolean);
  const outbound = (m.keystones.find(k => k.rid === rid)?.outbound || []).map(id => collabTeamByRecordId(id, m)).filter(Boolean);
  const getsHelpFromAll = m.seekOffer.filter(s => s.seeker === rid); // teams that offer what this team seeks
  const givesHelpToAll = m.seekOffer.filter(s => s.offerer === rid); // teams seeking what this team offers
  const getsHelpFrom = getsHelpFromAll.slice(0, 3);
  const givesHelpTo = givesHelpToAll.slice(0, 3);
  const meta = row?.clusterLabel || domainLabel(team.domain) || "team";

  const people = collabPeopleForTeam(rid);
  const showPeopleSection = people.length > 2 || people.some(person => person?.role);

  return `
    <div class="cb-team-detail">
      <div class="cb-inspector-hero is-link is-team" data-collab-cohort-open="${escAttr(rid)}" role="link" tabindex="0" title="show ${escAttr(team.name || rid)} in directory">
        <div class="cb-inspector-identity">
          <div class="cb-inspector-kicker">${escHtml(meta || "team")}</div>
          <h4 class="cb-inspector-title">${escHtml(team.name || rid)}</h4>
          ${team.focus ? `<p class="cb-inspector-copy">${escHtml(team.focus)}</p>` : ""}
          ${collabTeamMetaInlineHtml(team, people)}
        </div>
      </div>
      ${collabTeamRouteRailHtml({ outbound, inbound, getsHelpFrom: getsHelpFromAll, givesHelpTo: givesHelpToAll })}
      ${collabJourneyCompactHtml(team)}
      ${collabSignalHtml(team)}
      ${collabNetworkHtml([
        outbound.length ? { label: "depends on", count: outbound.length, body: collabRouteRows(outbound.slice(0, 4).map(t => ({ team: t, note: "declared dependency", badge: "needs" }))) } : null,
        inbound.length ? { label: "needed by", count: inbound.length, body: collabRouteRows(inbound.slice(0, 4).map(t => ({ team: t, note: "depends on this team", badge: "needed" }))) } : null,
        getsHelpFrom.length ? { label: "gets help from", count: getsHelpFrom.length, body: collabRouteRows(getsHelpFrom.map(s => ({ team: collabTeamByRecordId(s.offerer, m), note: s.shared.slice(0, 2).join(" · ") || "declared offer match", badge: "offers" }))) } : null,
        givesHelpTo.length ? { label: "gives help to", count: givesHelpTo.length, body: collabRouteRows(givesHelpTo.map(s => ({ team: collabTeamByRecordId(s.seeker, m), note: s.shared.slice(0, 2).join(" · ") || "declared ask match", badge: "seeks" }))) } : null,
      ])}
      ${showPeopleSection ? collabInspectorSection("who to talk to", collabMembersHtml(rid), "is-members") : ""}
      ${collabCredentialsHtml(team)}
      ${collabTeamLinksSectionHtml(team)}
    </div>
  `;
}

// Compact PMF journey — the 8-stage track + evidence/upside dots, smaller than
// the full cohort-profile version (no long meter labels).
function collabJourneyCompactHtml(team) {
  // journeyFor() returns stage-1 defaults for teams with no journey block, so a
  // `stage <= 0` guard never fires — gate on a real self-entered read instead,
  // matching the scatter, so we don't show fabricated "stage 1/8" data.
  if (!journeyAssessed(team)) return "";
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

// Credentials — public proof basis (papers the work builds on).
function collabCredentialsHtml(team) {
  const papers = Array.isArray(team.paper_basis) ? team.paper_basis : (team.paper_basis ? [team.paper_basis] : []);
  if (!papers.length) return "";
  return collabInspectorSection("credentials", `<ul class="cb-inspector-list">${papers.slice(0, 3).map(p => `<li>${escHtml(p)}</li>`).join("")}</ul>`, "is-cred");
}

// One connection row: plain label (glance) + plain-English substance (glance)
// + hover title telling you which profile field it came from (hover layer).
function collabConnRow(label, bodyHtml, sourceNote) {
  return `<div class="cb-evidence-row" title="${escAttr(sourceNote)}"><span>${escHtml(label)}</span><p>${bodyHtml}</p></div>`;
}

// A team shown by name + cluster/geo + its own focus line (the "fresh team
// description"). The whole card returns that team to the directory.
function collabPairTeamCard(team, name, role, signal) {
  const signalHtml = signal && signal.text
    ? `<span class="cb-pair-team-signal"><em>${escHtml(signal.label)}</em>${escHtml(signal.text)}</span>`
    : "";
  if (!team) {
    return `<div class="cb-pair-team is-empty"><span class="cb-pair-team-role">${escHtml(role)}</span><span class="cb-pair-team-name">${escHtml(name)}</span>${signalHtml}</div>`;
  }
  const meta = [domainLabel(team.domain), team.geo].filter(Boolean).join(" · ");
  return `<button type="button" class="cb-pair-team" data-collab-cohort-open="${escAttr(team.record_id)}" title="show ${escAttr(name)} in directory">
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
    return {
      label: "unblock route",
      source: "Declared dependency plus seek/offer overlap.",
      body: `${leftName} already depends on ${rightName}; the matching offer makes this an unblock conversation${sharedText}.`,
    };
  }
  if (pair?.seek) {
    return {
      label: "intro route",
      source: "Declared seeking matched against declared offering and skill areas.",
      body: `${leftName} is seeking something ${rightName} can provide${sharedText}; route this as a targeted intro.`,
    };
  }
  if (pair?.dep) {
    return {
      label: "dependency route",
      source: "Declared dependency only.",
      body: `${leftName} depends on ${rightName}; route this as an unblock check before it becomes a hidden bottleneck.`,
    };
  }
  if (pair?.affinity) {
    return {
      label: "shared-skill context",
      source: "Shared public skill areas.",
      body: `No explicit ask is declared yet, but both teams share collaboration surface${sharedText}.`,
    };
  }
  return null;
}

function collabPairInspectorHtml(pair, m = collabCurrentModel()) {
  const left = collabTeamByRecordId(pair?.fromRid, m);
  const right = collabTeamByRecordId(pair?.toRid, m);
  const leftName = pair?.fromName || left?.name || "team A";
  const rightName = pair?.toName || right?.name || "team B";
  const sharedTerms = [...new Set([
    ...(pair?.seek?.shared || []),
    ...(pair?.affinity?.shared || []),
  ])].slice(0, 8);

  // A dependency / seek-offer is directional (left → right); affinity alone is
  // not (left ↔ right) — drives the arrow + role labels below.
  const directional = !!(pair?.dep || pair?.seek);

  // Seek/offer lives inside the two team columns — left = what it needs,
  // right = what it gives. The column role already says who seeks vs offers,
  // so no verb label is repeated.
  const leftSignal = pair?.seek ? { label: "seeking", text: pair.seek.seeking || "not specified" } : null;
  const rightSignal = pair?.seek ? { label: "offering", text: pair.seek.offering || "not specified" } : null;
  const routeRead = collabRouteRead(pair, leftName, rightName);

  // Mutual / directional signals that don't map to a single column stay as rows.
  const rows = [];
  if (routeRead) {
    rows.push(collabConnRow(routeRead.label, escHtml(routeRead.body), routeRead.source));
  }
  if (pair?.dep) {
    rows.push(collabConnRow("dependency",
      `${escHtml(leftName)} depends on ${escHtml(rightName)}.`,
      `From ${leftName}'s declared dependencies.`));
  }
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
      ${collabTeamMark(o.team, "cb-inspector-mini-shape")}
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
  const groupTeams = group.map(o => o.team).filter(Boolean);
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
      <div class="cb-inspector-constellation">${groupTeams.slice(0, 5).map(team => collabTeamMark(team, "cb-inspector-mini-mark")).join("")}</div>
      <div class="cb-inspector-identity">
        <div class="cb-inspector-kicker">cluster</div>
        <h4 class="cb-inspector-title">${escHtml(label)}</h4>
        <p class="cb-inspector-copy">A working group inferred from public focus, skills, needs, and offers. Selecting it previews context without changing the board layout.</p>
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

function collabIntakeTags(raw) {
  return String(raw || "")
    .split(",")
    .map(s => collabIntakeNormalizeTag(s))
    .filter(Boolean);
}

function collabIntakeNormalizeTag(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._/-]/g, "")
    .replace(/^-+|-+$/g, "");
}

function collabIntakeDateValue(value) {
  const raw = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

function collabIntakeUniqueTags(values) {
  return (values || [])
    .map(tag => collabIntakeNormalizeTag(tag))
    .filter(Boolean)
    .filter((tag, idx, arr) => arr.indexOf(tag) === idx);
}

function collabIntakeDraftList(value) {
  return Array.isArray(value)
    ? value.map(v => String(v || "").trim()).filter(Boolean)
    : collabIntakeList(value);
}

function collabIntakeIntent(value) {
  return value === "offer" || value === "both" ? value : "seek";
}

function collabIntakeNeedsSeek(intent) {
  return intent === "seek" || intent === "both";
}

function collabIntakeNeedsOffer(intent) {
  return intent === "offer" || intent === "both";
}

function collabIntakeIntentLabel(intent) {
  if (intent === "offer") return "offer";
  if (intent === "both") return "seek + offer";
  return "seek";
}

function collabIntakeHash(...values) {
  const input = values.map(v => String(v || "")).join("|");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(36).slice(0, 5);
}

function collabIntakeYamlList(key, items) {
  const values = (items || []).map(s => String(s || "").trim()).filter(Boolean);
  if (!values.length) return "";
  return `${key}:\n${values.map(s => `  - ${quoteYaml(s)}`).join("\n")}`;
}

function collabIntakeControl(form, name) {
  return form?.elements?.namedItem?.(name) || form?.querySelector?.(`[name="${cssAttr(name)}"]`) || null;
}

function collabIntakeFormValues(form) {
  const teamRid = String(collabIntakeControl(form, "team")?.value || "").trim();
  const intent = collabIntakeIntent(form.querySelector("[name='intent']:checked")?.value || form.dataset.intent);
  return {
    intent,
    teamRid,
    teamOther: String(collabIntakeControl(form, "team_other")?.value || "").trim(),
    seeking: String(collabIntakeControl(form, "seeking")?.value || "").trim(),
    offering: String(collabIntakeControl(form, "offering")?.value || "").trim(),
    blockers: Array.from(form.querySelectorAll("[name='blockers']:checked")).map(el => String(el.value || "").trim()).filter(Boolean),
    tags: String(collabIntakeControl(form, "tags")?.value || "").trim(),
    timing: collabIntakeDateValue(collabIntakeControl(form, "timing")?.value || ""),
    contact: String(collabIntakeControl(form, "contact")?.value || "").trim(),
  };
}

function collabIntakeSuggestedYaml(fields) {
  const parts = [
    collabIntakeNeedsSeek(fields.intent) ? collabIntakeYamlList("seeking", collabIntakeList(fields.seeking)) : "",
    collabIntakeNeedsOffer(fields.intent) ? collabIntakeYamlList("offering", collabIntakeList(fields.offering)) : "",
    collabIntakeNeedsSeek(fields.intent) ? collabIntakeYamlList("dependencies", collabIntakeDraftList(fields.blockers)) : "",
    collabIntakeYamlList("skill_areas", collabIntakeTags(fields.tags)),
  ].filter(Boolean);
  return parts.join("\n");
}

function collabIntakeTeamName(rid, m = collabCurrentModel()) {
  const team = collabTeamByRecordId(rid, m);
  return team?.name || rid;
}

function collabIntakeMarkdown(fields, { authorSlug, todayIso, team }) {
  const intent = collabIntakeIntent(fields.intent);
  const teamLabel = team?.name || fields.teamOther || fields.teamRid || "unlisted team";
  const teamLine = team
    ? `${teamLabel} (${team.record_id})`
    : `${teamLabel}${fields.teamRid ? ` (${fields.teamRid})` : ""}`;
  const blockers = collabIntakeDraftList(fields.blockers);
  const blockerLine = blockers.length
    ? blockers.map(rid => `${collabIntakeTeamName(rid)} (${rid})`).join("\n")
    : "not specified";
  const tags = collabIntakeTags(fields.tags);
  const tagsBlock = tags.length
    ? "skill_areas:\n" + tags.map(s => `  - ${quoteYaml(s)}`).join("\n")
    : "skill_areas: []";
  const suggested = collabIntakeSuggestedYaml(fields) || "# no structured fields supplied";
  const recordId = `${authorSlug}-${todayIso}-collab-${collabIntakeHash(intent, teamLine, fields.seeking, fields.offering, blockers.join(","))}`;
  const topic = `collab board ${collabIntakeIntentLabel(intent)} - ${teamLabel}`;
  return {
    recordId,
    markdown: `---
record_id: ${recordId}
record_type: ask
schema_version: 1
posted_at: ${todayIso}
author: ${quoteYaml(authorSlug)}
verb: ${quoteYaml(`update collab board: ${collabIntakeIntentLabel(intent)}`)}
topic: ${yamlScalar(topic, 2)}
${tagsBlock}
status: open
---
## Collab board update

team: ${teamLine}
intent: ${collabIntakeIntentLabel(intent)}
timing: ${fields.timing || "not specified"}

### seeking
${collabIntakeNeedsSeek(intent) ? (fields.seeking || "not specified") : "not included"}

### offering
${collabIntakeNeedsOffer(intent) ? (fields.offering || "not specified") : "not included"}

### selected dependencies / blockers
${collabIntakeNeedsSeek(intent) ? blockerLine : "not included"}

### routing / contact
${fields.contact || "not specified"}

### suggested team-record fields
\`\`\`yaml
${suggested}
\`\`\`
`,
  };
}

function syncCollabIntakeIntent(form) {
  if (!form) return;
  const intent = collabIntakeIntent(form.querySelector("[name='intent']:checked")?.value || form.dataset.intent);
  form.dataset.intent = intent;
  const label = collabIntakeIntentLabel(intent);
  const title = form.querySelector("[data-collab-intake-title]");
  const submit = form.querySelector("[data-collab-intake-submit]");
  if (title) title.textContent = `add ${label}`;
  if (submit) submit.textContent = `submit ${label}`;
}

function syncCollabIntakeTeamLocks(form) {
  if (!form) return;
  const teamRid = String(collabIntakeControl(form, "team")?.value || "").trim();
  for (const input of form.querySelectorAll("[name='blockers']")) {
    const isSelf = !!teamRid && input.value === teamRid;
    input.disabled = isSelf;
    if (isSelf) input.checked = false;
    const option = input.closest(".cb-intake-team-option");
    if (option) option.classList.toggle("is-disabled", isSelf);
  }
}

function syncCollabIntakeBlockers(form) {
  if (!form) return;
  const selectedCount = form.querySelectorAll("[name='blockers']:checked").length;
  const count = form.querySelector("[data-collab-blocker-count]");
  if (count) count.textContent = `${selectedCount} selected`;
}

function collabIntakeTeamTags(team) {
  return collabIntakeUniqueTags(Array.isArray(team?.skill_areas) ? team.skill_areas : []);
}

function collabIntakeTagButtonsHtml(tags) {
  return (tags || [])
    .map(tag => `<button class="cb-intake-tag" type="button" data-collab-intake-tag="${escAttr(tag)}">${escHtml(tag)}</button>`)
    .join("");
}

function collabIntakeTagOptionsForForm(form, m = collabCurrentModel()) {
  if (!form) return [];
  const team = collabTeamByRecordId(String(collabIntakeControl(form, "team")?.value || "").trim(), m);
  return collabIntakeUniqueTags([
    ...collabIntakeTags(collabIntakeControl(form, "tags")?.value || ""),
    ...collabIntakeTeamTags(team),
    ...(m.convergence || []).slice(0, 12).map(c => c.skill),
  ]).slice(0, 16);
}

function syncCollabIntakeTagDefaults(form) {
  if (!form) return;
  const input = collabIntakeControl(form, "tags");
  if (!input || input.dataset.userEdited === "true") return;
  const team = collabTeamByRecordId(String(collabIntakeControl(form, "team")?.value || "").trim());
  input.value = collabIntakeTeamTags(team).slice(0, 5).join(", ");
}

function syncCollabIntakeTagChoices(form) {
  if (!form) return;
  const root = form.querySelector("[data-collab-intake-tags]");
  if (!root) return;
  root.innerHTML = collabIntakeTagButtonsHtml(collabIntakeTagOptionsForForm(form));
  syncCollabIntakeTagButtons(form);
}

function syncCollabIntakeTagButtons(form) {
  if (!form) return;
  const current = new Set(collabIntakeTags(collabIntakeControl(form, "tags")?.value || ""));
  for (const btn of form.querySelectorAll("[data-collab-intake-tag]")) {
    btn.setAttribute("aria-pressed", current.has(String(btn.dataset.collabIntakeTag || "").toLowerCase()) ? "true" : "false");
  }
}

function toggleCollabIntakeTag(form, tag) {
  if (!form || !tag) return;
  const input = collabIntakeControl(form, "tags");
  if (!input) return;
  const tags = collabIntakeTags(input.value);
  const normalized = collabIntakeNormalizeTag(tag);
  if (!normalized) return;
  const exists = tags.includes(normalized);
  const next = exists ? tags.filter(t => t !== normalized) : [...tags, normalized];
  input.value = next.join(", ");
  input.dataset.userEdited = "true";
  syncCollabIntakeTagChoices(form);
  saveCollabIntakeDraft(collabIntakeFormValues(form));
}

function addCollabIntakeTag(form, tag) {
  if (!form) return false;
  const input = collabIntakeControl(form, "tags");
  const normalized = collabIntakeNormalizeTag(tag);
  if (!input || !normalized) return false;
  const tags = collabIntakeTags(input.value);
  if (!tags.includes(normalized)) tags.push(normalized);
  input.value = tags.join(", ");
  input.dataset.userEdited = "true";
  syncCollabIntakeTagChoices(form);
  saveCollabIntakeDraft(collabIntakeFormValues(form));
  return true;
}

function setCollabIntakeCustomTagOpen(form, open) {
  if (!form) return;
  const panel = form.querySelector("[data-collab-intake-custom-tag]");
  const input = form.querySelector("[data-collab-intake-tag-input]");
  const btn = form.querySelector("[data-collab-intake-tag-add]");
  if (!panel || !input || !btn) return;
  panel.hidden = !open;
  btn.classList.toggle("is-open", !!open);
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) {
    requestAnimationFrame(() => input.focus?.());
  } else {
    input.value = "";
  }
}

function commitCollabIntakeCustomTag(form) {
  const input = form?.querySelector("[data-collab-intake-tag-input]");
  if (!input) return;
  const added = addCollabIntakeTag(form, input.value);
  if (added) setCollabIntakeCustomTagOpen(form, false);
  else input.focus?.();
}

function openCollabIntakeModal() {
  const existing = document.querySelector("[data-collab-intake-modal]");
  if (existing) {
    const existingForm = existing.querySelector("[data-collab-intake-form]");
    if (existingForm) existingForm.scrollTop = 0;
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
  const intent = collabIntakeIntent(draft.intent);
  const selectedRid = draft.teamRid || (state.collabSelection?.type === "team" ? state.collabSelection.rid : "");
  const selectedTeam = selectedRid ? collabTeamByRecordId(selectedRid, m) : null;
  const draftTags = collabIntakeTags(draft.tags);
  const selectedTags = draftTags.length ? draftTags : collabIntakeTeamTags(selectedTeam).slice(0, 5);
  const defaultTags = selectedTags.join(", ");
  const selectedBlockers = new Set(collabIntakeDraftList(draft.blockers));
  const teamOptions = [
    `<option value=""${selectedRid ? "" : " selected"}>select company / project</option>`,
    ...teams.map(team => `<option value="${escAttr(team.record_id)}"${team.record_id === selectedRid ? " selected" : ""}>${escHtml(team.name || team.record_id)}</option>`),
  ].join("");
  const blockerOptions = teams.map(team => `
    <label class="cb-intake-team-option" data-collab-blocker-option="${escAttr(team.record_id)}">
      <input type="checkbox" name="blockers" value="${escAttr(team.record_id)}"${selectedBlockers.has(team.record_id) ? " checked" : ""} />
      <span class="cb-intake-team-check" aria-hidden="true"></span>
      <span class="cb-intake-team-name">${escHtml(team.name || team.record_id)}</span>
    </label>
  `).join("");
  const quickTags = collabIntakeUniqueTags([
    ...selectedTags,
    ...collabIntakeTeamTags(selectedTeam),
    ...(m.convergence || []).slice(0, 10).map(c => c.skill),
  ]).slice(0, 16);
  const tagButtons = collabIntakeTagButtonsHtml(quickTags);
  const overlay = document.createElement("div");
  overlay.className = "cb-intake-backdrop";
  overlay.dataset.collabIntakeModal = "1";
  overlay.innerHTML = `
    <form class="cb-intake-modal" data-collab-intake-form data-intent="${escAttr(intent)}" autocomplete="off">
      <header class="cb-intake-head">
        <div>
          <p class="cb-intake-kicker">collab board intake</p>
          <h3 class="cb-intake-title" data-collab-intake-title>add ${escHtml(collabIntakeIntentLabel(intent))}</h3>
        </div>
        <button class="cb-intake-close" type="button" data-collab-intake-close aria-label="close">×</button>
      </header>
      <div class="cb-intake-grid">
        <fieldset class="cb-intake-field cb-intake-intent is-wide">
          <legend>what are you adding?</legend>
          <div class="cb-intake-intent-options" role="radiogroup" aria-label="collab update type">
            <label class="cb-intake-intent-option">
              <input type="radio" name="intent" value="seek"${intent === "seek" ? " checked" : ""} />
              <span>seeking</span>
            </label>
            <label class="cb-intake-intent-option">
              <input type="radio" name="intent" value="offer"${intent === "offer" ? " checked" : ""} />
              <span>offering</span>
            </label>
            <label class="cb-intake-intent-option">
              <input type="radio" name="intent" value="both"${intent === "both" ? " checked" : ""} />
              <span>both</span>
            </label>
          </div>
        </fieldset>
        <label class="cb-intake-field">
          <span>which company?</span>
          <select name="team" class="cb-intake-input">${teamOptions}</select>
        </label>
        <label class="cb-intake-field">
          <span>if not listed</span>
          <input name="team_other" class="cb-intake-input" value="${escAttr(draft.teamOther || "")}" placeholder="company / project name" />
        </label>
        <label class="cb-intake-field is-wide" data-collab-intake-section="seeking">
          <span>what are you seeking?</span>
          <textarea name="seeking" rows="3" class="cb-intake-input" placeholder="customer intros, TEE review, design partner, infra unblock...">${escHtml(draft.seeking || "")}</textarea>
        </label>
        <label class="cb-intake-field is-wide" data-collab-intake-section="offering">
          <span>what can you offer?</span>
          <textarea name="offering" rows="3" class="cb-intake-input" placeholder="audit time, dataset access, wallet UX feedback, dstack deployment help...">${escHtml(draft.offering || "")}</textarea>
        </label>
        <fieldset class="cb-intake-field cb-intake-blocker-picker is-wide" data-collab-intake-section="blockers">
          <div class="cb-intake-blocker-head">
            <legend>blocking teams</legend>
            <span class="cb-intake-blocker-count" data-collab-blocker-count>0 selected</span>
          </div>
          <div class="cb-intake-team-list" data-collab-blocker-list aria-label="existing teams">
            ${blockerOptions}
          </div>
        </fieldset>
        <fieldset class="cb-intake-field cb-intake-tag-picker is-wide">
          <legend>matching tags</legend>
          <input type="hidden" name="tags" value="${escAttr(defaultTags)}" data-user-edited="${draftTags.length ? "true" : "false"}" />
          <div class="cb-intake-tag-row">
            <button class="cb-intake-tag-add" type="button" data-collab-intake-tag-add aria-label="create custom tag" aria-expanded="false">+</button>
            <div class="cb-intake-tags" data-collab-intake-tags aria-label="matching tags">${tagButtons}</div>
          </div>
          <div class="cb-intake-custom-tag" data-collab-intake-custom-tag hidden>
            <input class="cb-intake-input cb-intake-custom-tag-input" data-collab-intake-tag-input maxlength="40" placeholder="custom tag" />
            <button class="cb-intake-mini-action" type="button" data-collab-intake-tag-save>add tag</button>
            <button class="cb-intake-mini-icon" type="button" data-collab-intake-tag-cancel aria-label="cancel custom tag">×</button>
          </div>
        </fieldset>
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
        <button class="cb-intake-submit" type="submit" data-collab-intake-submit>submit ${escHtml(collabIntakeIntentLabel(intent))}</button>
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
  const syncAndSave = () => {
    syncCollabIntakeIntent(form);
    syncCollabIntakeTeamLocks(form);
    syncCollabIntakeBlockers(form);
    syncCollabIntakeTagDefaults(form);
    syncCollabIntakeTagChoices(form);
    saveCollabIntakeDraft(collabIntakeFormValues(form));
  };
  form?.addEventListener("input", (event) => {
    if (event.target?.matches?.("[data-collab-intake-tag-input]")) return;
    syncAndSave();
  });
  form?.addEventListener("change", syncAndSave);
  form?.addEventListener("click", (event) => {
    const btn = event.target?.closest?.("[data-collab-intake-tag]");
    if (btn && form.contains(btn)) {
      event.preventDefault();
      toggleCollabIntakeTag(form, btn.dataset.collabIntakeTag || "");
      return;
    }
    const addBtn = event.target?.closest?.("[data-collab-intake-tag-add]");
    if (addBtn && form.contains(addBtn)) {
      event.preventDefault();
      setCollabIntakeCustomTagOpen(form, true);
      return;
    }
    const saveBtn = event.target?.closest?.("[data-collab-intake-tag-save]");
    if (saveBtn && form.contains(saveBtn)) {
      event.preventDefault();
      commitCollabIntakeCustomTag(form);
      return;
    }
    const cancelBtn = event.target?.closest?.("[data-collab-intake-tag-cancel]");
    if (cancelBtn && form.contains(cancelBtn)) {
      event.preventDefault();
      setCollabIntakeCustomTagOpen(form, false);
    }
  });
  form?.addEventListener("keydown", (event) => {
    if (!event.target?.matches?.("[data-collab-intake-tag-input]")) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitCollabIntakeCustomTag(form);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setCollabIntakeCustomTagOpen(form, false);
    }
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    submitCollabIntake(form);
  });
  overlay.querySelector("[data-collab-intake-clear]")?.addEventListener("click", () => {
    clearCollabIntakeDraft();
    if (form) {
      for (const el of form.querySelectorAll("input, textarea, select")) {
        if (el.type === "radio") el.checked = el.value === "seek";
        else if (el.type === "checkbox") el.checked = false;
        else {
          el.value = "";
          if (el.name === "tags") el.dataset.userEdited = "false";
        }
      }
      syncCollabIntakeIntent(form);
      syncCollabIntakeTeamLocks(form);
      syncCollabIntakeBlockers(form);
      syncCollabIntakeTagDefaults(form);
      syncCollabIntakeTagChoices(form);
    }
    const result = form?.querySelector("[data-collab-intake-result]");
    if (result) result.hidden = true;
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);
  syncCollabIntakeIntent(form);
  syncCollabIntakeTeamLocks(form);
  syncCollabIntakeBlockers(form);
  syncCollabIntakeTagChoices(form);
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
  if (collabIntakeNeedsSeek(fields.intent) && !fields.seeking) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<span class="alch-onb-inline-tag">missing</span> add what this company is seeking.`;
    return;
  }
  if (collabIntakeNeedsOffer(fields.intent) && !fields.offering) {
    result.hidden = false;
    result.dataset.kind = "error";
    result.innerHTML = `<span class="alch-onb-inline-tag">missing</span> add what this company can offer.`;
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

// Default-inspector trailer links scroll to their below-fold board section
// (intros / underused offers / convergence) — the visible local delta is the
// section arriving at the top of the viewport.
function wireCollabTrailerLinks(root) {
  if (!root) return;
  for (const btn of root.querySelectorAll("[data-collab-scroll]")) {
    if (btn.dataset.collabScrollWired === "1") continue;
    btn.dataset.collabScrollWired = "1";
    btn.addEventListener("click", () => {
      const section = state.canvas?.querySelector(`[data-cb-section="${cssAttr(btn.dataset.collabScroll)}"]`);
      if (!section) return;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      section.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    });
  }
}

function setCollabInspectorHtml(html) {
  const panel = state.canvas.querySelector("[data-collab-inspector]");
  if (!panel) return;
  panel.innerHTML = html;
  wireCollabCohortLinks(panel);
  wireCollabTrailerLinks(panel);
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

// Visual strength order: which signal claims the loudest channel (cell fill +
// center glyph) when a cell carries several. Centralized so it can become a
// user preference later. dep = hardest (declared blocker) > seek/offer
// (opportunity) > affinity (shared vocab).
const COLLAB_SIGNAL_ORDER = ["dep", "so", "aff"];

function collabCell(R, C, ri, ci, m, lens = "all", detail = false, selected = null) {
  if (R.rid === C.rid) return `<div class="cb-cell cb-diag" data-row="${ri}" data-col="${ci}" aria-hidden="true"></div>`;
  // Shared-skills/affinity is intentionally NOT a matrix signal: in this
  // thematically homogeneous cohort it fires on ~58% of pairs and just redraws
  // the cluster bands (empirically a purple wall even at a ≥2 threshold). It
  // lives in the pair inspector + Convergence instead. The matrix shows only
  // the two directed, discriminating signals: dependency and seek/offer.
  const dep = m.deps.has(R.rid + ">" + C.rid);
  const so = m.soByPair.get(R.rid + ">" + C.rid);
  if (!dep && !so) return `<div class="cb-cell" data-row="${ri}" data-col="${ci}"></div>`;

  let cls = "cb-cell";
  if (so) cls += " has-so s" + Math.min(4, Math.ceil(so.score));
  if (dep) cls += " has-dep";

  // Tooltip lists every signal on the cell (strongest first).
  const lines = [];
  if (dep) lines.push(`▲ depends on ${C.team.name}`);
  if (so) lines.push(`seeks → ${C.team.name} offers: ${so.shared.slice(0, 3).join(", ") || "match"}`);
  const title = `${R.team.name} → ${C.team.name}\n${lines.join("\n")}`;

  const active = lens === "all" || (lens === "deps" && dep) || (lens === "needs" && so);
  if (!active) cls += " is-muted";
  if (detail && collabSameSelection(selected, { type: "pair", fromRid: R.rid, toRid: C.rid })) cls += " is-selected";

  const actionAttr = detail
    ? (active ? `data-collab-pair-from="${escAttr(R.rid)}" data-collab-pair-to="${escAttr(C.rid)}"` : `disabled aria-disabled="true"`)
    : `data-collab-open="${escAttr(C.rid)}"`;
  // Single mark; the strongest signal's CSS styles its shape (triangle = dep,
  // diamond = seek/offer). Under an active lens the shape is forced to that
  // lens's signal so the filtered view is internally consistent.
  return `<button type="button" class="${cls}" data-row="${ri}" data-col="${ci}" ${actionAttr} aria-label="${escAttr(`${R.team.name} → ${C.team.name}: ${lines.join("; ")}`)}" title="${escAttr(title)}"><span class="cb-mark" aria-hidden="true"></span></button>`;
}

function collabGroupBand(ordered, colN, selected = null) {
  const segs = [];
  for (const o of ordered) {
    const last = segs[segs.length - 1];
    if (last && last.id === o.clusterId) last.span += 1;
    else segs.push({ id: o.clusterId, label: o.clusterLabel, span: 1 });
  }
  const cells = segs.map((s) => `
    <button type="button" class="cb-band-seg${collabSameSelection(selected, { type: "cluster", id: s.id }) ? " is-selected" : ""}" data-collab-cluster="${escAttr(s.id)}" style="grid-column: span ${s.span};" title="${escAttr(s.label + " · " + s.span + " teams · click for context")}">
      <span>${escHtml(s.label)}</span>
    </button>
  `).join("");
  return `<div class="cb-row cb-bandrow" style="${colN}"><div class="cb-band-corner" aria-hidden="true"></div>${cells}</div>`;
}


function renderCollab() {
  const teams = (state.cohort?.teams || []).filter(t => t && t.record_id);
  const clusters = state.cohort?.clusters || [];
  if (!teams.length) {
    state.canvas.innerHTML = `<div class="alch-cohort-page" data-cohort-view="collab">${cohortPageHead("collab")}<p class="alch-callout">no team data yet.</p></div>`;
    return;
  }
  const m = buildCollabModel(teams, clusters, state.cohort?.dependencies || [], state.cohort?.cohort_vocab?.skill_areas || []);
  normalizeCollabControls();
  const teamFilter = state.collabTeamFilter || "all";
  const sort = state.collabSort || "cluster";
  const ordered = collabVisibleOrder(m, teamFilter, sort);
  const N = ordered.length;
  const totalN = m.ordered.length;
  // The default board now hides teams with no matrix signal (see
  // collabVisibleOrder). boardAllN = how many remain on the "all teams" board;
  // hiddenN = how many were dropped, owned honestly in a note under the grid.
  const boardAllN = collabVisibleOrder(m, "all", sort).length;
  const hiddenN = Math.max(0, totalN - boardAllN);
  const lens = state.collabLens || "all";
  const selected = collabSelectionVisible(state.collabSelection, ordered, m);
  if (state.collabSelection && !selected) state.collabSelection = null;
  const colN = `--cb-cols:${N}`;
  const byId = new Map(m.ordered.map(o => [o.rid, o.team]));
  const openAttrs = (rid) => `data-collab-open="${escAttr(rid)}" role="button" tabindex="0"`;
  // Sentence bar — "showing all signals 232 · among all teams · sorted by
  // cluster". Lens, team-scope, and sort are stateful tokens whose menus carry
  // each option's consequence + count. Lens and team-scope are mutually
  // exclusive (normalizeCollabControls): picking a team scope clears the lens
  // to "all signals", so "the team filter owns the board".
  const lensMeta = [
    { key: "all", label: "all signals", note: "every dependency and seek / offer", count: m.deps.size + m.seekOffer.length },
    { key: "deps", label: "dependencies", note: "one team needs another to ship", count: m.deps.size },
    { key: "needs", label: "seek / offer", note: "asks matched to offers", count: m.seekOffer.length },
  ];
  const sortMeta = [
    { key: "cluster", label: "cluster", note: "rows grouped by ecosystem cluster" },
    { key: "intro", label: "best matches first", note: "strongest seek ↔ offer matches first" },
    { key: "dependency", label: "dependency pressure", note: "most-depended-on teams first" },
  ];
  const activeLensMeta = lensMeta.find(l => l.key === lens) || lensMeta[0];
  const activeSortMeta = sortMeta.find(s => s.key === sort) || sortMeta[0];
  const lensUnit = constSentenceUnit({
    menu: "cb-lens",
    ariaMenu: "collab board lens",
    token: constSentenceToken({ menu: "cb-lens", label: activeLensMeta.label, count: activeLensMeta.count, aria: `signals: ${activeLensMeta.label}, ${activeLensMeta.count} — change board lens` }),
    options: lensMeta.map(l => constSentenceOption({
      attr: "data-collab-lens", value: l.key, selected: teamFilter === "all" && lens === l.key,
      label: l.label, note: l.note, count: l.count, empty: l.count === 0,
    })).join(""),
  });
  const sortUnit = constSentenceUnit({
    menu: "cb-sort",
    ariaMenu: "collab board row order",
    token: constSentenceToken({ menu: "cb-sort", label: activeSortMeta.label, aria: `sorted by ${activeSortMeta.label} — change row order` }),
    options: sortMeta.map(s => constSentenceOption({
      attr: "data-collab-sort-option", value: s.key, selected: sort === s.key,
      label: s.label, note: s.note,
    })).join(""),
  });
  // Team scope — narrow the board to teams that have declared a seek / an offer
  // (team-level dossier fields). A stateful token (sibling to lens / sort), so
  // the scope is reachable and self-describing at rest, and clearable by
  // re-picking "all teams".
  const teamsSeeking = m.ordered.filter(o => collabHasText(o.team.seeking)).length;
  const teamsOffering = m.ordered.filter(o => collabHasText(o.team.offering)).length;
  const teamMeta = [
    { key: "all",    label: "all teams",      note: "every team with a signal on the board", count: boardAllN },
    { key: "needs",  label: "teams seeking",  note: "have a declared seek",     count: teamsSeeking },
    { key: "offers", label: "teams offering", note: "have a declared offer",    count: teamsOffering },
  ];
  const activeTeamMeta = teamMeta.find(t => t.key === teamFilter) || teamMeta[0];
  const teamUnit = constSentenceUnit({
    menu: "cb-team",
    ariaMenu: "collab board team scope",
    token: constSentenceToken({ menu: "cb-team", label: activeTeamMeta.label, count: teamFilter === "all" ? null : activeTeamMeta.count, aria: `${activeTeamMeta.label} — filter which teams appear` }),
    options: teamMeta.map(t => constSentenceOption({
      attr: "data-collab-filter", value: t.key, selected: teamFilter === t.key,
      label: t.label, note: t.note, count: t.count, empty: t.count === 0,
    })).join(""),
  });
  const controlBar = `
    <div class="cb-controls">
      ${constTimelineDropdownHtml()}
      <div class="ac-sentence" role="group" aria-label="collab board controls">
        <span class="ac-sent-word">showing</span>
        ${lensUnit}
        <span class="ac-sent-word">· among</span>
        ${teamUnit}
        <span class="ac-sent-word">· sorted by</span>
        ${sortUnit}
      </div>
      <div class="cb-control-actions">
        <button class="cb-intake-open" type="button" data-collab-intake-open>
          <span class="cb-intake-open-mark" aria-hidden="true">+</span>
          <span>add seek / offer</span>
        </button>
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
    headCells += `<button type="button" class="cb-colhead${deg >= 5 ? " is-key" : ""}${selectedCls}${quietCls(o.rid)}" data-col="${ci}" data-collab-open="${escAttr(o.rid)}" title="${escAttr(o.team.name + " — " + deg + " teams depend on it")}"><span>${escHtml(o.team.name)}</span></button>`;
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
  const matrixBody = `<div class="cb-grid-wrap" tabindex="0"><div class="cb-grid" data-lens="${escAttr(lens)}">${rows}</div></div><div class="cb-matrix-side lg-track"><div class="cb-matrix-key">${collabLegendHtml(lens)}</div>${inspector}</div>`;
  const matrixNote = hiddenN
    ? `<p class="cb-hint cb-grid-hidden">${hiddenN} team${hiddenN === 1 ? "" : "s"} with no declared signal yet — find them in the directory.</p>`
    : "";
  const matrix = `
    <section class="alch-cb-section cb-matrix-section" data-cb-section="grid" aria-label="dependency and seek/offer grid">
      <div class="alch-cb-sechead"><h3>Who needs whom</h3><span class="cb-sub">rows need, columns provide</span></div>
      <div class="cb-scroll">${matrixBody}</div>
      ${matrixNote}
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
    return `<article class="cb-intro" data-collab-cohort-open="${escAttr(s.offerer)}" role="link" tabindex="0" title="${escAttr(`show ${s.offererName || s.offerer} in directory`)}">
      <div class="cb-intro-flow">
        <div class="cb-intro-side"><span class="cb-intro-role">needs</span><span class="cb-intro-team">${escHtml(s.seekerName)}</span>${s.seeking ? `<span class="cb-intro-text">${escHtml(s.seeking)}</span>` : ""}</div>
        <div class="cb-intro-arrow" aria-hidden="true">→</div>
        <div class="cb-intro-side"><span class="cb-intro-role">provides</span><span class="cb-intro-team">${escHtml(s.offererName)}</span>${s.offering ? `<span class="cb-intro-text">${escHtml(s.offering)}</span>` : ""}</div>
      </div>${chips ? `<div class="cb-intro-chips">${chips}</div>` : ""}
    </article>`;
  }).join("");
  const introSection = `
    <section class="alch-cb-section" data-cb-section="intros">
      <div class="alch-cb-sechead"><h3>Intros to make</h3><span class="cb-sub">seek ↔ offer overlaps</span></div>
      <div class="cb-intro-grid">${introCards || '<p class="cb-empty">no overlaps found.</p>'}</div>
    </section>`;
  const latentSection = collabLatentOverlapSectionHtml();

  // underused offers — declared help with the lowest routed demand
  const underused = (m.underusedOffers || []).slice(0, 12);
  const underusedCards = underused.map(item => {
    const chips = item.skills.slice(0, 5).map(c => `<span class="cb-chip">${escHtml(c)}</span>`).join("");
    const matchLabel = item.matchCount === 1 ? "1 matched ask" : `${item.matchCount} matched asks`;
    const teamMeta = [domainLabel(item.team?.domain), item.team?.geo].filter(Boolean).join(" · ");
    return `<article class="cb-intro cb-underused-offer" data-collab-cohort-open="${escAttr(item.rid)}" role="link" tabindex="0" title="${escAttr(`show ${item.teamName} in directory`)}">
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
    <section class="alch-cb-section" data-cb-section="offers">
      <div class="alch-cb-sechead"><h3>Unmatched offers</h3><span class="cb-sub">no team matched yet</span></div>
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
    <section class="alch-cb-section" data-cb-section="convergence">
      <div class="alch-cb-sechead"><h3>Shared focus areas</h3><span class="cb-sub">shared by 3+ teams</span></div>
      <div class="cb-cv-list">${convRows || '<p class="cb-empty">no shared areas.</p>'}</div>
    </section>`;

  state.canvas.innerHTML = `
    <div class="alch-cohort-page" data-cohort-view="collab">
    ${cohortPageHead("collab")}
    <div class="alch-view-controls" data-shape-occluder>${controlBar}</div>
    <div class="alch-collab">
      ${matrix}
      ${introSection}
      ${latentSection}
      <div class="cb-cohort-shape">
        ${convSection}
        ${underusedSection}
      </div>
      <p class="alch-callout">Matrix, intros, and offers are self-declared by teams. Latent overlaps are public prompts to verify before routing; no private scoring is shown.</p>
    </div>
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
      if (openDirectoryRecord(rid)) return;
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
  wireConstellationModeNav();
  wireCollabCohortLinks(state.canvas);
  wireCollabTrailerLinks(state.canvas);
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
  wireConstSentenceTokens();
  for (const btn of state.canvas.querySelectorAll("[data-collab-lens]")) {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-collab-lens") || "all";
      if (next === state.collabLens && state.collabTeamFilter === "all") {
        if (btn.hasAttribute("data-collab-legend-lens") && next !== "all") {
          state.collabLens = "all";
          closeConstSentenceMenus();
          render({ instant: true });
          return;
        }
        closeConstSentenceMenus();
        return;
      }
      state.collabLens = next;
      state.collabTeamFilter = "all";
      render({ instant: true });
    });
  }
  for (const btn of state.canvas.querySelectorAll("[data-collab-filter]")) {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-collab-filter") || "all";
      // Set semantics (the menu has an explicit "all teams" option) — re-picking
      // the current scope is a no-op that just closes the menu. Picking a scope
      // clears the lens so the two stay mutually exclusive.
      if (next === state.collabTeamFilter) { closeConstSentenceMenus(); return; }
      state.collabTeamFilter = next;
      state.collabLens = "all";
      render({ instant: true });
    });
  }
  for (const btn of state.canvas.querySelectorAll("[data-collab-sort-option]")) {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-collab-sort-option") || "cluster";
      if (next === state.collabSort) { closeConstSentenceMenus(); return; }
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
        // Same two-click grammar as the other cohort views: first click
        // selects into the collab inspector, the second click on the same
        // record commits to its full page. (Deselect via inspector/Escape.)
        if (collabSameSelection(state.collabSelection, next)) openDetail(rid, "constellation");
        else setCollabSelection(next);
      } else {
        openDetail(rid, "constellation");
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

// ── context vault auto-refresh ──────────────────────────────────────
// The article index rebuilds itself — shortly after boot and every few
// minutes after that — so new vault content flows into the OS without
// anyone pressing a button. Changes surface through the what's-new rail
// state; if the user is already on the context page the fresh index
// just paints in.
const CONTEXT_SCAN_INTERVAL_MS = 5 * 60 * 1000;
let contextScanTimer = null;

function contextVaultFingerprints() {
  const m = state.contextVault?.manifest;
  return fingerprintItems([...contextArticleSources(m), ...((m?.raw_scripts) || [])]);
}

// What's-new channel for the calendar. The calendar page renders the
// phala calendar grid (cal.data / surface.calendar) — NOT surface.events,
// whose anchor overlay is dropped in renderCalendarHtml — so its unread
// count must fingerprint the grid the user actually sees: one entry per
// non-empty cell, keyed by tab + position. Stored under "calendar-grid"
// (fresh key, so existing baselines from the old events-based channel
// prime silently instead of flooding the badge).
function calendarFingerprints() {
  const data = state.calendar?.data || state.cohort?.calendar || null;
  const tabs = data?.tabs;
  if (!tabs || typeof tabs !== "object") return [];
  const items = [];
  for (const [tab, rows] of Object.entries(tabs)) {
    (Array.isArray(rows) ? rows : []).forEach((row, ri) => {
      (Array.isArray(row) ? row : []).forEach((cell, ci) => {
        const text = String(cell ?? "").trim();
        if (text) items.push({ id: `${tab}:r${ri}c${ci}`, text });
      });
    });
  }
  return fingerprintItems(items);
}

async function autoRefreshContextVault() {
  if (!contextVaultAvailable()) return;
  const cv = state.contextVault;
  if (cv.loading || cv.scanInFlight) return;
  cv.scanInFlight = true;
  try {
    const res = await window.api.scanContextVault();
    if (res?.ok && res.manifest) {
      const beforeFp = contextVaultFingerprints().join("|");
      cv.manifest = res.manifest;
      cv.roots = res.roots || res.manifest?.roots || [];
      cv.loaded = true;
      cv.error = "";
      if (!cv.selectedId && res.manifest?.sources?.length) {
        cv.selectedId = res.manifest.sources[0].id;
      }
      if (contextVaultFingerprints().join("|") !== beforeFp) {
        resolvePendingContextRawScript();
        // On the context page right now → the fresh index paints in and
        // counts as seen (renderModeContent stamps it). Anywhere else →
        // the rail lights up instead.
        if (state.mounted && state.mode === "context" && !state.detailRecordId && state.active && !document.hidden) {
          render();
        } else {
          updateRailUnread();
        }
      }
    }
  } catch { /* transient scan failure — the stored manifest keeps serving; next tick retries */ }
  finally { cv.scanInFlight = false; }
}

function startContextAutoRefresh() {
  if (contextScanTimer) return;
  setTimeout(autoRefreshContextVault, 5000);
  contextScanTimer = setInterval(autoRefreshContextVault, CONTEXT_SCAN_INTERVAL_MS);
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

// The context page's views. Articles + transcripts come from the local
// vault; signals + data are the bundled intel module (folded in 2026-06).
function contextNormalizeView(raw) {
  const v = String(raw || "").toLowerCase();
  if (v === "transcripts") return "raw";
  if (v === "intel") return "signals";
  if (v === "cards") return "evidence";
  return (v === "articles" || v === "raw" || v === "signals" || v === "data" || v === "evidence") ? v : "articles";
}

const CONTEXT_VIEWS = [
  { view: "articles", glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>', label: "articles", hint: "reader-facing drafts from the vault" },
  { view: "raw",      glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="21" x2="3" y1="6" y2="6"/><line x1="15" x2="3" y1="12" y2="12"/><line x1="17" x2="3" y1="18" y2="18"/></svg>', label: "transcripts", hint: "raw source transcripts with review metadata" },
  { view: "signals",  glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/></svg>', label: "signals", hint: "vault-backed reads on cohort moves" },
  { view: "data",     glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/></svg>', label: "data", hint: "sanitized entity graph behind the signals" },
  { view: "evidence", glyph: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77 4 4 0 0 1 6.74 0 4 4 0 0 1 4.78 4.78 4 4 0 0 1 0 6.74 4 4 0 0 1-4.77 4.78 4 4 0 0 1-6.75 0 4 4 0 0 1-4.78-4.77 4 4 0 0 1 0-6.76Z"/><path d="m9 12 2 2 4-4"/></svg>', label: "evidence", hint: "distilled evidence cards, live from Supabase" },
];

function contextViewNav(active, counts = {}) {
  return `
    <nav class="alch-page-views" role="tablist" aria-label="context view">
      ${CONTEXT_VIEWS.map(v => {
        const n = counts[v.view];
        return `
        <button class="alch-page-view-btn" data-cv-mode="${v.view}" role="tab" aria-selected="${active === v.view}" aria-label="${escAttr(`${v.label}: ${v.hint}`)}" title="${escAttr(v.hint)}" type="button">
          <span class="apv-glyph" aria-hidden="true">${v.glyph}</span><span class="apv-label">${v.label}</span>${Number.isFinite(n) ? `<span class="apv-count">${n}</span>` : ""}
        </button>`;
      }).join("")}
    </nav>`;
}

function setContextVaultMode(mode) {
  const nextMode = contextNormalizeView(mode);
  if (state.contextVault.mode === nextMode) return;
  state.contextVault.mode = nextMode;
  try { localStorage.setItem(CONTEXT_VIEW_LS_KEY, nextMode); } catch {}
  // Mirror onto the container so the tab system captures the view switch
  // (this repaint path skips the full render()).
  if (state.container && state.mode === "context") state.container.dataset.contextView = nextMode;
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
  return findMergedContextArticleSourceById(
    state.contextVault.manifest?.sources || [],
    state.cohort?.cohort_articles || [],
    id,
  ) || findContextSourceById(state.contextVault.manifest, id);
}

function contextRawScriptById(id) {
  return findContextRawScriptById(state.contextVault.manifest, id);
}

function contextArticleSources(manifest = state.contextVault.manifest) {
  return mergeContextArticleSources(
    manifest?.sources || [],
    state.cohort?.cohort_articles || [],
  );
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

function contextEvidenceDate(value) {
  if (!value) return "";
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch { return ""; }
}

function contextEvidenceCardHtml(card) {
  const type = String(card.claim_type || "insight");
  const title = String(card.title || "").trim();
  const claim = String(card.claim_text || "").trim();
  const summary = String(card.summary || "").trim();
  const evidence = String(card.evidence_level || "").trim();
  const scope = String(card.attribution_scope || "").trim();
  const confNum = Number(card.confidence);
  const conf = Number.isFinite(confNum) ? `${Math.round(confNum * 100)}%` : "";
  const topic = String(card.content_json?.topic_label || "").trim();
  const when = contextEvidenceDate(card.created_at);
  const chips = [evidence, scope].filter(Boolean)
    .map(c => `<span class="alch-ev-chip">${escHtml(c.replace(/_/g, " "))}</span>`).join("");
  const prov = [topic, "distilled", "T3 public", when].filter(Boolean).map(escHtml).join(" · ");
  return `
    <article class="alch-ev-card" data-claim-type="${escAttr(type)}">
      <header class="alch-ev-head">
        <span class="alch-ev-type">${escHtml(type.replace(/_/g, " "))}</span>
        ${conf ? `<span class="alch-ev-conf" title="confidence">${escHtml(conf)}</span>` : ""}
      </header>
      ${title ? `<h3 class="alch-ev-title">${escHtml(title)}</h3>` : ""}
      ${claim ? `<p class="alch-ev-claim">${escHtml(claim)}</p>` : ""}
      ${summary && summary !== claim ? `<p class="alch-ev-summary">${escHtml(summary)}</p>` : ""}
      <footer class="alch-ev-meta">
        ${chips}
        <span class="alch-ev-prov">${prov}</span>
      </footer>
    </article>
  `;
}

const EVIDENCE_TIER_LS_KEY = "srfg:evidence_tier";

// Detail tier for the Context > evidence view.
//   T2 (default) = the richer, NAMED cohort session readouts (from the committed
//     bundle's session_insights — no login required).
//   T3 = the person-anonymized cards read live from Supabase (the public tier).
// Default T2; flip to T3 instantly (via the in-view toggle or this localStorage
// key) if named detail ever needs pulling back. No login is involved either way.
function contextEvidenceTier() {
  try {
    return String(localStorage.getItem(EVIDENCE_TIER_LS_KEY) || "").toUpperCase() === "T3" ? "T3" : "T2";
  } catch { return "T2"; }
}
function setContextEvidenceTier(tier) {
  const next = tier === "T3" ? "T3" : "T2";
  try { localStorage.setItem(EVIDENCE_TIER_LS_KEY, next); } catch {}
  if (state.mode === "context") { renderContextVault(); wireContextVault(); }
}

function evidenceTierToggleHtml(tier) {
  const opt = (t, label, hint) =>
    `<button class="alch-ev-tier-btn${tier === t ? " is-on" : ""}" data-ev-tier="${t}" type="button" aria-pressed="${tier === t}" title="${escAttr(hint)}">${label}</button>`;
  return `<div class="alch-ev-tier" role="group" aria-label="evidence detail tier">
    ${opt("T2", "named", "cohort tier — named teams, people, and the full session summary")}
    ${opt("T3", "generalized", "public tier — person-anonymized, no named teams or people")}
  </div>`;
}

// A named cohort session readout (T2) — the summary-section format: thesis hook,
// the 60-second summary, product insights, themes, and the named teams/people.
function contextSessionSummaryHtml(s) {
  const title = String(s.title || "").trim();
  const thesis = String(s.thesis || "").trim();
  const summary = String(s.summary || s.one_liner || "").trim();
  const date = contextEvidenceDate(s.date);
  const kind = String(s.kind || "").trim();
  const themes = Array.isArray(s.themes) ? s.themes : [];
  const insights = Array.isArray(s.insights) ? s.insights : [];
  const who = [...(Array.isArray(s.teams) ? s.teams : []), ...(Array.isArray(s.people) ? s.people : [])]
    .map((t) => String(t).replace(/-/g, " ").trim()).filter(Boolean);
  const meta = [kind, date].filter(Boolean).map(escHtml).join(" · ");
  const themeChips = themes.slice(0, 6).map((t) => `<span class="alch-ev-chip">${escHtml(String(t))}</span>`).join("");
  return `
    <article class="alch-ev-sum">
      ${meta ? `<div class="alch-ev-type">${meta}</div>` : ""}
      ${title ? `<h3 class="alch-ev-sum-title">${escHtml(title)}</h3>` : ""}
      ${thesis ? `<p class="alch-ev-sum-thesis">${escHtml(thesis)}</p>` : ""}
      ${summary ? `<p class="alch-ev-sum-body">${escHtml(summary)}</p>` : ""}
      ${insights.length ? `<ul class="alch-ev-sum-list">${insights.slice(0, 10).map((i) => `<li>${escHtml(String(i))}</li>`).join("")}</ul>` : ""}
      ${themeChips ? `<div class="alch-ev-meta">${themeChips}</div>` : ""}
      ${who.length ? `<div class="alch-ev-sum-who">${who.slice(0, 10).map((w) => `<span class="alch-ev-chip alch-ev-who-chip">${escHtml(w)}</span>`).join("")}</div>` : ""}
    </article>
  `;
}

function renderContextEvidence(tier, cards, insights) {
  const toggle = evidenceTierToggleHtml(tier);
  if (tier === "T2") {
    const body = insights.length
      ? `<p class="alch-ev-lede">${insights.length} cohort session readout${insights.length === 1 ? "" : "s"} — named, with the 60-second summary, themes, and product insights. Switch to <em>generalized</em> for the person-anonymized public view.</p>
         <div class="alch-ev-grid alch-ev-sum-grid">${insights.map(contextSessionSummaryHtml).join("")}</div>`
      : `<p class="alch-cv-muted alch-ev-empty">No cohort session readouts yet. Distill sessions into readouts to populate the named tier.</p>`;
    return `${toggle}${body}`;
  }
  const body = cards.length
    ? `<p class="alch-ev-lede">${cards.length} distilled evidence card${cards.length === 1 ? "" : "s"}, read live from Supabase — person-anonymized, team-attributed, published.</p>
       <div class="alch-ev-grid">${cards.map(contextEvidenceCardHtml).join("")}</div>`
    : `<p class="alch-cv-muted alch-ev-empty">No distilled evidence cards yet. These load live from Supabase once cohort sessions are distilled, reviewed, and published.</p>`;
  return `${toggle}${body}`;
}

function contextIntelHooks() {
  return {
    onPanelChange: (panel) => {
      const next = panel === "data" ? "data" : "signals";
      if (state.contextVault.mode !== next) setContextVaultMode(next);
    },
  };
}

function contextIntelMeta() {
  const intelModule = intelLazy.peek();
  if (!intelModule) return intelMetaCache || {};
  intelMetaCache = intelModule.intelSnapshotMeta?.() || {};
  return intelMetaCache;
}

function renderContextIntel(view) {
  const host = state.canvas?.querySelector(".alch-cv-intel");
  if (!host) return;
  const intelModule = intelLazy.peek();
  if (intelModule) {
    intelMetaCache = intelModule.intelSnapshotMeta?.() || intelMetaCache;
    intelModule.renderIntelEmbedded?.(host, view);
    return;
  }

  const loadError = intelLazy.error();
  if (loadError) {
    host.innerHTML = `<p class="alch-callout"><strong>context signals failed to load: ${escHtml(loadError?.message || String(loadError))}</strong></p>`;
    return;
  }

  host.innerHTML = `<p class="alch-callout"><strong>loading context signals...</strong></p>`;
  intelLazy.load()
    .then((module) => {
      intelMetaCache = module.intelSnapshotMeta?.() || intelMetaCache;
      if (!state.mounted || state.mode !== "context" || state.detailRecordId) return;
      const activeView = contextNormalizeView(state.contextVault.mode);
      if (activeView !== "signals" && activeView !== "data") return;
      renderContextVault();
      wireContextVault();
    })
    .catch((error) => {
      console.warn("[alchemy] context signals failed to load:", error?.message || error);
      if (state.mounted && state.mode === "context" && !state.detailRecordId) {
        renderContextIntel(view);
      }
    });
}

function wireContextIntel(host) {
  const intelModule = intelLazy.peek();
  if (!host || !intelModule) return;
  intelModule.wireIntelEmbedded?.(host, contextIntelHooks());
}

function renderContextVault() {
  const cv = state.contextVault;
  const view = contextNormalizeView(cv.mode);
  cv.mode = view;
  if ((view === "articles" || view === "raw") && !cv.loaded && !cv.loading) {
    // Fire after the current render stack so the loading state can paint.
    setTimeout(() => loadContextVault({ scan: false }), 0);
  }
  const manifest = cv.manifest || null;
  const sources = contextArticleSources(manifest);
  const rawScripts = manifest?.raw_scripts || [];
  const intelMeta = contextIntelMeta();
  const nav = contextViewNav(view, {
    articles: cv.loaded ? sources.length : undefined,
    raw: cv.loaded ? rawScripts.length : undefined,
    signals: intelMeta.signals,
    data: intelMeta.entities,
    evidence: (contextEvidenceTier() === "T2"
      ? (state.cohort?.session_insights || []).length
      : (state.cohort?.transcript_evidence_cards || []).length) || undefined,
  });

  // Evidence view — distilled transcript cards read live from Supabase
  // (cohort-source.js overlays them onto the surface). Full-width under the
  // shared page header, same as the intel views.
  if (view === "evidence") {
    const tier = contextEvidenceTier();
    const cards = Array.isArray(state.cohort?.transcript_evidence_cards) ? state.cohort.transcript_evidence_cards : [];
    const insights = Array.isArray(state.cohort?.session_insights) ? state.cohort.session_insights : [];
    state.canvas.innerHTML = `
      <section class="alch-cv">
        ${pageHeadHtml({ nav })}
        ${renderContextEvidence(tier, cards, insights)}
      </section>
    `;
    return;
  }

  // Intel views — the embedded signals/data module renders below the same
  // page header the vault views use.
  if (view === "signals" || view === "data") {
    state.canvas.innerHTML = `
      <section class="alch-cv">
        ${pageHeadHtml({ nav })}
        <div class="alch-cv-intel"></div>
      </section>
    `;
    renderContextIntel(view);
    return;
  }

  const mode = view === "raw" ? "raw" : "articles";
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
      ${pageHeadHtml({ nav })}
      ${cv.message ? `<p class="alch-cv-message">${escHtml(cv.message)}</p>` : ""}
      ${cv.error ? `<p class="alch-cv-error">${escHtml(cv.error)}</p>` : ""}
      <div class="alch-cv-layout">
        <aside class="alch-cv-sidebar">
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
  for (const btn of state.canvas.querySelectorAll("[data-cv-mode]")) {
    btn.addEventListener("click", () => setContextVaultMode(btn.dataset.cvMode));
  }
  for (const btn of state.canvas.querySelectorAll("[data-ev-tier]")) {
    btn.addEventListener("click", () => setContextEvidenceTier(btn.dataset.evTier));
  }
  for (const btn of state.canvas.querySelectorAll("[data-cv-source]")) {
    btn.addEventListener("click", () => selectContextSource(btn.dataset.cvSource));
  }
  for (const btn of state.canvas.querySelectorAll("[data-cv-raw-source]")) {
    btn.addEventListener("click", () => selectContextRawScript(btn.dataset.cvRawSource));
  }
  // Embedded intel (signals/data views) wires its own internals; the page
  // nav stays in sync when an intel cross-link jumps data → signals.
  const intelHost = state.canvas.querySelector(".alch-cv-intel");
  if (intelHost) {
    wireContextIntel(intelHost);
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
    li.addEventListener("click", () => openDirectoryRecord(li.dataset.atlasGoTeam));
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

  // Group primary and secondary contributors so each card owns the roster.
  const peopleByTeam = new Map(cohortIndex.peopleByTeam);
  // Sort each team's roster: lead first, then alpha.
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
  ctx.font = `italic 44px "Space Grotesk", "Inter", system-ui, sans-serif`;
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
  ctx.font = `italic 26px "Space Grotesk", "Inter", system-ui, sans-serif`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.96;
  ctx.fillText(team.name || "—", textX, glyphY + 26);

  // ── Focus (italic, smaller) ────────────────────────────────────────
  if (team.focus) {
    ctx.font = `italic 13.5px "Space Grotesk", "Inter", system-ui, sans-serif`;
    ctx.globalAlpha = 0.78;
    wrapText(ctx, team.focus, textX, glyphY + 50, w - (textX - x) - 20, 18, 3);
  }
  ctx.globalAlpha = 1;

  // ── Meta strip (GEO · roster) at bottom-left ──────────────────────
  const colGeoX        = x + 20;
  const colMembersX    = x + 220;
  const colGeoW        = (colMembersX - colGeoX) - 10;
  const colMembersW    = (x + w - 20) - colMembersX;
  const roster = cohortRosterSummary({
    kind: teamKind(team),
    roster: members,
    declaredCount: team.members_count,
    maxNames: 4,
  });
  const rosterText = roster.hasNames
    ? `${roster.visible.map(m => m.name || m.record_id).join("  ·  ")}${roster.overflow ? `  · +${roster.overflow}` : ""}`
    : roster.fallback;

  ctx.font = `500 9.5px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillStyle = CAL_INK_1;
  ctx.globalAlpha = 0.42;
  ctx.fillText("GEO",          colGeoX,     y + h - 70);
  ctx.fillText(roster.label.toUpperCase(), colMembersX, y + h - 70);
  ctx.globalAlpha = 0.88;
  ctx.font = `500 12px "JetBrains Mono", ui-monospace, monospace`;
  ctx.fillText(truncateText(ctx, team.geo || "—", colGeoW), colGeoX, y + h - 52);
  ctx.fillText(truncateText(ctx, rosterText, colMembersW), colMembersX, y + h - 52);
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
  // The live canvas is transparent on screen (it lets the page gradient show
  // through). Exporting it directly would yield a see-through PNG/PDF, so
  // flatten it onto the page's base background colour first.
  const flattenCanvas = () => {
    const out = document.createElement("canvas");
    out.width = cnv.width;
    out.height = cnv.height;
    const octx = out.getContext("2d");
    octx.fillStyle = (getComputedStyle(document.body).backgroundColor || "").trim() || "#1A1719";
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(cnv, 0, 0);
    return out.toDataURL("image/png");
  };
  if (format === "png") {
    // Snapshot the canvas as PNG. Routed through Electron IPC so we get
    // a native save dialog instead of a browser blob download.
    const dataUrl = flattenCanvas();
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
    const dataUrl = flattenCanvas();
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

function detailInlineMarkdown(text) {
  const raw = String(text || "");
  const parts = [];
  let cursor = 0;
  const tokenRe = /`([^`\n]+)`|\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+|\/[^)\s]*|#[^)\s]*)\)/g;
  for (const match of raw.matchAll(tokenRe)) {
    parts.push(escHtml(raw.slice(cursor, match.index)));
    if (match[1] != null) {
      parts.push(`<code>${escHtml(match[1])}</code>`);
    } else {
      const label = match[2];
      const href = match[3];
      const isExternal = /^https?:\/\//i.test(href) || /^mailto:/i.test(href);
      parts.push(`<a href="${escAttr(href)}"${isExternal ? " data-external" : ""}>${escHtml(label)}</a>`);
    }
    cursor = match.index + match[0].length;
  }
  parts.push(escHtml(raw.slice(cursor)));
  return parts.join("");
}

function detailProse(md) {
  const raw = String(md || "").trim();
  if (!raw) return "";
  const blocks = raw.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  if (!blocks.length) return "";
  return `
    <div class="alch-detail-prose">
      ${blocks.map(block => {
        const lines = block.split(/\n/).map(line => line.trim()).filter(Boolean);
        const isList = lines.length > 1 && lines.every(line => /^[-*]\s+/.test(line));
        if (isList) {
          return `<ul>${lines.map(line => `<li>${detailInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
        }
        return `<p>${detailInlineMarkdown(lines.join(" "))}</p>`;
      }).join("")}
    </div>
  `;
}

function renderDetailProseSection(title, body, aux = "", extraClass = "") {
  const html = String(body || "").trim();
  if (!html) return "";
  return `
    <section class="alch-detail-section ${extraClass}">
      <h3 class="alch-detail-h">${escHtml(title)}${aux ? ` <span class="alch-profile-h-aux">${escHtml(aux)}</span>` : ""}</h3>
      ${html}
    </section>
  `;
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

function detailHtmlParts(parts) {
  return (Array.isArray(parts) ? parts : [parts])
    .map(part => String(part || ""))
    .filter(part => part.trim())
    .join("");
}

function detailLabelize(value) {
  return String(value || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function renderDisclosureSection(title, body, open = false, preview = "", extraClass = "") {
  const cleaned = detailHtmlParts(body);
  if (!cleaned.trim()) return "";
  const previewHtml = preview
    ? `<span class="alch-section-preview"><span aria-hidden="true">/</span> ${escHtml(preview)}</span>`
    : "";
  return `
    <details class="alch-detail-section alch-detail-disclosure ${extraClass}" ${open ? "open" : ""}>
      <summary>
        <span class="alch-section-label"><span>${escHtml(title)}</span>${previewHtml}</span>
        <span class="alch-section-mark" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></span>
      </summary>
      <div class="alch-section-body">${cleaned}</div>
    </details>
  `;
}

// Flat section — same visual language as the disclosure (hairline + small
// label) but the content is simply VISIBLE. The dossier reads top to
// bottom like a document; only the long tail (timeline) stays collapsible.
function renderFlatSection(title, body, extraClass = "") {
  const cleaned = detailHtmlParts(body);
  if (!cleaned.trim()) return "";
  return `
    <section class="alch-detail-section alch-detail-flat ${extraClass}">
      <div class="alch-flat-label">${escHtml(title)}</div>
      <div class="alch-section-body">${cleaned}</div>
    </section>
  `;
}

function detailQuickRow(label, items, extraClass = "") {
  const html = (items || []).filter(Boolean).join("");
  if (!html) return "";
  return `
    <div class="alch-quick-row ${extraClass}">
      <span class="alch-quick-k">${escHtml(label)}</span>
      <span class="alch-quick-v">${html}</span>
    </div>
  `;
}

function detailQuickText(label, value) {
  const values = detailItems(value);
  if (!values.length) return "";
  return `<span class="alch-quick-text">${label ? `<span>${escHtml(label)}</span>` : ""}${escHtml(values.join(" · "))}</span>`;
}

function detailPill(label, value) {
  if (value == null || String(value).trim() === "") return "";
  return `<span class="alch-quick-pill"><span>${escHtml(label)}</span>${escHtml(value)}</span>`;
}

// Most recent timeline entry whose title/detail shares a substantive word
// with the chip text — the hover layer's "where has this actually shown
// up" provenance. Only event/transcript/calendar entries count: profile,
// team, onboarding, and availability entries restate the record itself,
// so matching them would be circular. Empty when nothing matches (no
// dead hover affordances).
const DETAIL_EVIDENCE_TYPES = new Set(["event", "transcript", "calendar"]);
// Filler that appears on both sides of almost every record — matching on
// these words produces noise, not provenance.
const DETAIL_EVIDENCE_STOPWORDS = new Set(["context", "cohort", "project", "projects", "issues", "notes", "weekly"]);
// Generated phrasing in timeline entries; never evidence of a topic.
const DETAIL_EVIDENCE_BOILERPLATE = /\b(mentioned in transcript|team context in transcript|held privately)\b/gi;

// Clause around the first matched word — evidence must show the matched
// region, not the field's (often junk) opening ("Tue May 19:").
function detailMatchSnippet(text, words, max = 56) {
  const s = String(text || "").replace(DETAIL_EVIDENCE_BOILERPLATE, " ").replace(/\s+/g, " ").trim();
  const lower = s.toLowerCase();
  let idx = -1;
  for (const w of words) {
    // Word-start boundary always; short words also need a word END so
    // "defi" can't claim "defining" (longer words keep prefix matching —
    // "agent" → "agentic", "market" → "markets").
    const pattern = new RegExp(`(?<![a-z0-9])${w}${w.length <= 4 ? "(?![a-z0-9])" : ""}`);
    const m = pattern.exec(lower);
    if (m && (idx < 0 || m.index < idx)) idx = m.index;
  }
  if (idx < 0) return "";
  let start = Math.max(0, idx - 18);
  while (start > 0 && /\S/.test(s[start - 1])) start--;
  const clause = s.slice(start);
  const clipped = clause.length > max ? `${clause.slice(0, max - 1).trimEnd()}…` : clause;
  return (start > 0 ? "…" : "") + clipped;
}

function detailEvidenceFor(text, timelineItems) {
  const words = String(text || "").toLowerCase().split(/[^a-z0-9]+/)
    .filter(w => w.length > 3 && !DETAIL_EVIDENCE_STOPWORDS.has(w));
  if (!words.length) return "";
  const dated = (Array.isArray(timelineItems) ? timelineItems : [])
    .filter(item => DETAIL_EVIDENCE_TYPES.has(String(item?.type || "").toLowerCase()))
    .sort((a, b) => String(b?.date || "").localeCompare(String(a?.date || "")));
  for (const item of dated) {
    const snippet = detailMatchSnippet(item?.title, words) || detailMatchSnippet(item?.detail, words);
    if (snippet) {
      return item.date ? `${detailTimelineDate(item.date)} — ${snippet}` : snippet;
    }
  }
  return "";
}

// Ask-me-about chip with an optional hover/focus evidence layer (the
// matched timeline entry). Falls back to the plain chip when no evidence
// matches — nothing should look layered that isn't.
function detailQuickChip(value, evidence) {
  if (!String(value || "").trim()) return "";
  if (!evidence) return detailQuickText("", value);
  return `<span class="alch-quick-text alch-evidence-chip" tabindex="0" data-evidence="${escAttr(evidence)}" aria-label="${escAttr(`${value} — evidence: ${evidence}`)}">${escHtml(value)}</span>`;
}

function detailLinkForKey(links, key) {
  const value = links?.[key];
  if (!value || !String(value).trim()) return "";
  return normalizeLinkHref(key, value);
}

// ── Explore toolbar (2026-06) ───────────────────────────────────────
// The dossier's jump + external links, lifted out of the old mid-page
// "explore" quick row into an icon toolbar that sits in the ledger head
// — the first actions you see when the read opens. Icon-only
// (shape-grammar: square buttons, never words inside), each carrying an
// accessible label + native tooltip. "source" (edit-on-github) lives here
// as the last icon — the explore bar now owns the source-edit intent that
// the old detail-bar pill used to carry (the bar is now a nav-only strip).
// Mirror of EXPLORE_ICONS in apps/web/scripts/cohort.js — keep in sync.
const EXPLORE_ICONS = {
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/></svg>',
  availability: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6.5h8"/><path d="M9 12h10"/><path d="M5 17.5h6"/></svg>',
  github: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.57 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.36-1.34-1.73-1.34-1.73-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.22 1.84 1.22 1.07 1.8 2.81 1.28 3.5.98.11-.76.42-1.28.76-1.58-2.67-.3-5.47-1.31-5.47-5.84 0-1.29.47-2.34 1.24-3.17-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.21a11.6 11.6 0 0 1 3.01-.4c1.02 0 2.05.13 3.01.4 2.29-1.53 3.3-1.21 3.3-1.21.66 1.65.24 2.87.12 3.17.77.83 1.24 1.88 1.24 3.17 0 4.54-2.81 5.53-5.49 5.83.43.37.81 1.1.81 2.22 0 1.6-.01 2.89-.01 3.28 0 .32.21.69.83.57C20.56 21.88 24 17.48 24 12.29 24 5.78 18.63.5 12 .5z"/></svg>',
  repo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 1.153h3.682l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932zm-1.292 19.482h2.04L6.486 3.24H4.298z"/></svg>',
  website: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
  demo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>',
  deck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 3h20"/><path d="M21 3v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3"/><path d="m7 21 5-5 5 5"/></svg>',
  linkedin: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0z"/></svg>',
  // "source" = edit-on-github. A pencil glyph, deliberately distinct from the
  // github mark above so the two never read as one repeated link in the row.
  source: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
};

// In-OS jump (calendar / availability) — jumps to an alchemy page via
// __srwkAlchemyJump (wired by wireDetailJumps) instead of leaving the app.
function exploreJump(iconKey, label, mode, opts = null) {
  const optsAttr = opts ? ` data-jump-opts="${escAttr(JSON.stringify(opts))}"` : "";
  return `<button type="button" class="alch-explore-btn" data-jump="${escAttr(mode)}"${optsAttr} aria-label="${escAttr(label)}" title="${escAttr(label)}">${EXPLORE_ICONS[iconKey] || ""}</button>`;
}

// External destination — an empty href drops the button so a record only
// shows the links it actually declares.
function exploreLink(iconKey, label, href) {
  if (!href) return "";
  return `<a class="alch-explore-btn" href="${escAttr(href)}" data-external aria-label="${escAttr(label)}" title="${escAttr(label)}">${EXPLORE_ICONS[iconKey] || ""}</a>`;
}

function renderExploreBar(items) {
  // Dedupe by destination: records often set links.github === links.repo
  // (same repo URL), which rendered as two icons to the same place. Keep the
  // first occurrence (github, the canonical mark); drop later links that
  // resolve to an identical href. Jump buttons (no href) are always kept.
  const seenHrefs = new Set();
  const html = (items || []).filter(Boolean).filter((item) => {
    const m = /href="([^"]+)"/.exec(item);
    if (!m) return true;
    if (seenHrefs.has(m[1])) return false;
    seenHrefs.add(m[1]);
    return true;
  }).join("");
  return html ? `<div class="alch-explore-bar" role="group" aria-label="explore">${html}</div>` : "";
}

function detailRecordToken(record, fallbackLabel = "") {
  if (!record?.record_id) return "";
  return `
    <button type="button" class="alch-quick-link alch-record-token" data-directory-record="${escAttr(record.record_id)}">
      <span>${escHtml(fallbackLabel || record.name || record.record_id)}</span>
    </button>
  `;
}

function detailTeamToken(team) {
  if (!team?.record_id) return "";
  // No team shape glyph on the user profile — just the team name.
  return `
    <button type="button" class="alch-quick-link alch-team-token" data-directory-record="${escAttr(team.record_id)}">
      <span>${escHtml(team.name || team.record_id)}</span>
    </button>
  `;
}

// Collapsed-section previews carry CONTENT, not schema: the summary line
// should replace uncertainty ("what's in here?") with the actual signal.
// Truncate to one readable clause; empty in → empty out so callers can
// fall back to a schema hint when a record hasn't declared the field.
function previewSnippet(value, max = 64) {
  const first = Array.isArray(value)
    ? value.find(v => v != null && String(v).trim())
    : value;
  const s = String(first || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

function detailTimelinePreview(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter(Boolean);
  // Lead with the most recent entry — "what happened last" is the signal;
  // the old type-label list ("event, onboarding, profile") restated schema.
  const dated = rows
    .filter(item => item?.date)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const latest = dated[0] || rows[rows.length - 1];
  if (latest) {
    const title = previewSnippet(latest.title || detailTimelineType(latest.type), 48);
    if (title) {
      return latest.date ? `${detailTimelineDate(latest.date)} — ${title}` : title;
    }
  }
  const labels = [...new Set(rows
    .map(item => detailLabelize(item?.type || item?.source || ""))
    .filter(Boolean))]
    .slice(0, 3);
  return labels.join(", ");
}

function compactSentenceList(value, limit = 2) {
  const values = detailItems(value)
    .map(item => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, limit);
  if (!values.length) return "";
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function sentenceText(value) {
  const s = String(value || "").replace(/\s+/g, " ").trim();
  return s && /[.!?]$/.test(s) ? s : (s ? `${s}.` : "");
}

function renderPersonProofRead(person) {
  const prior = compactSentenceList(person?.prior_work, 2);
  const signature = person?.making_signature && typeof person.making_signature === "object"
    ? person.making_signature
    : null;
  const builtDomain = compactSentenceList(signature?.built_domain, 3);
  const sentences = [];
  if (prior) {
    sentences.push(`Public proof points include ${prior}.`);
  }
  if (signature?.note || builtDomain || signature?.shape) {
    const parts = [];
    if (builtDomain) parts.push(`${builtDomain} work`);
    if (signature?.shape) parts.push(`${signature.shape} making pattern`);
    const read = parts.length
      ? `The making signature points to ${parts.join(" with a ")}`
      : "The making signature is present";
    sentences.push(signature?.note ? `${read}: ${sentenceText(signature.note)}` : `${read}.`);
  }
  return detailProse(sentences.join("\n\n"));
}

// The team's positioning as prose (first-mock lesson: lead the dossier
// with a read, not labeled rows): problem → what they're building → who
// for. The lifted fields leave the assessment disclosure so no fact has
// two owners on the page.
function teamPositioningProse(journey) {
  const clause = (value) => String(value || "").replace(/\s+/g, " ").trim().replace(/\.\s*$/, "");
  // Lowercase a leading sentence-case word so the clause splices mid-
  // sentence; leave acronyms ("TEE…") alone.
  const splice = (value) => /^[A-Z][a-z]/.test(value) ? value[0].toLowerCase() + value.slice(1) : value;
  const problem = sentenceText(journey.problem);
  const solution = clause(journey.solution);
  const icp = clause(journey.icp);
  const sentences = [];
  if (problem) sentences.push(problem);
  if (solution) sentences.push(`Building ${splice(solution)}.`);
  if (icp) sentences.push(`For ${splice(icp)}.`);
  return detailProse(sentences.join(" "));
}

function detailTimelineItems(recordKind, recordId) {
  const key = recordKind === "person" ? "person_timeline" : "team_timeline";
  const sources = [activeDetailCohort(), state.cohort].filter(Boolean);
  for (const source of sources) {
    const items = source?.[key]?.[recordId];
    if (Array.isArray(items)) return items;
  }
  return [];
}

function detailTimelineDate(raw) {
  const s = String(raw || "").trim();
  if (!s) return "current";
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : new Date(s);
  if (!Number.isFinite(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).toLowerCase();
}

function detailTimelineType(raw) {
  return String(raw || "profile")
    .replace(/[-_]+/g, " ")
    .trim()
    .toLowerCase();
}

function detailLongDate(raw) {
  if (!raw) return "—";
  const d = raw instanceof Date
    ? raw
    : (isoToDate(raw) || new Date(raw));
  if (!Number.isFinite(d.getTime())) return String(raw);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function detailDateRange(start, end) {
  return `${escHtml(detailLongDate(start))} → ${escHtml(detailLongDate(end))}`;
}

function renderTimelineItems(items = []) {
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return "";
  return `
    <ol class="alch-timeline-list">
      ${rows.map(item => {
          const href = String(item?.href || "").trim();
          const title = String(item?.title || item?.type || "timeline item").trim();
          const isExternal = /^https?:\/\//i.test(href);
          const titleHtml = href && isExternal
            ? `<a href="${escAttr(href)}" data-external>${escHtml(title)}</a>`
            : `<span>${escHtml(title)}</span>`;
          return `
            <li class="alch-timeline-item">
              <time class="ati-date">${escHtml(item?.date ? detailTimelineDate(item.date) : "undated")}</time>
              <div class="ati-body">
                <div class="ati-head">
                  <span class="ati-title">${titleHtml}</span>
                  ${item?.type ? `<span class="ati-type">${escHtml(detailTimelineType(item.type))}</span>` : ""}
                </div>
                ${item?.detail ? `<p>${escHtml(item.detail)}</p>` : ""}
                ${item?.source ? `<span class="ati-source">${escHtml(item.source)}</span>` : ""}
              </div>
            </li>
          `;
        }).join("")}
    </ol>
  `;
}

function renderRecordTimeline(recordKind, recordId) {
  const items = detailTimelineItems(recordKind, recordId);
  if (!items.length) return "";
  return renderDisclosureSection(
    `timeline · ${items.length}`,
    renderTimelineItems(items),
    false,
    detailTimelinePreview(items),
    "alch-detail-timeline"
  );
}

function detailJourneySummary(rec) {
  const j = journeyFor(rec);
  return {
    ...j,
    stageLabel: JOURNEY_STAGE_LABELS[j.stage] || "",
    evidenceLabel: JOURNEY_EVIDENCE_LABELS[j.evidence_quality] || "",
    upsideLabel: JOURNEY_UPSIDE_LABELS[j.market_upside] || "",
  };
}

function detailMemberRows(people, kind) {
  const rows = (people || []).map(person => `
    <li class="alch-rail-member">
      <button type="button" data-person="${escAttr(person.record_id)}">${escHtml(person.name || person.record_id)}</button>${person.role ? ` <em>(${escHtml(person.role)})</em>` : ""}
    </li>
  `).join("");
  if (!rows) return "";
  // Stack the label over the roster (.alch-rail-row-block): the "contributors"
  // label is wider than the rail's fixed label column, so side-by-side it
  // overlaps the first name. Its own row keeps them clear. The roster is an
  // indented bullet list.
  return `<div class="alch-rail-row-block"><span>${kind === "project" ? "contributors" : "team"}</span><ul class="alch-rail-members">${rows}</ul></div>`;
}

function renderPersonRail(person, team, fam) {
  const dates = (person.dates_start || person.dates_end) ? detailDateRange(person.dates_start, person.dates_end) : "";
  return `
    <aside class="alch-detail-rail">
      <div class="alch-detail-shape"><canvas data-shape-fam="${escAttr(fam)}" data-shape-kind="person" data-shape-scale="1.18" data-shape-draggable="1" data-shape-seed="${escAttr(person.record_id)}"></canvas></div>
      <div class="alch-rail-read">
        <span class="alch-rail-kicker">individual</span>
        <h2 class="alch-detail-name">${escHtml(person.name || person.record_id)}</h2>
        ${person.role ? `<p class="alch-detail-focus">${escHtml(person.role)}</p>` : ""}
        <div class="alch-rail-list">
          <div><span>status</span>${escHtml(detailLabelize(person.role_class || "person"))}</div>
          ${team ? `<div><span>team</span>${detailTeamToken(team)}</div>` : ""}
          ${person.geo ? `<div><span>geo</span>${escHtml(person.geo)}</div>` : ""}
          ${person.domain ? `<div><span>domain</span>${escHtml(domainLabel(person.domain))}</div>` : ""}
          ${dates ? `<div><span>window</span>${dates}</div>` : ""}
        </div>
      </div>
    </aside>
  `;
}

function renderTeamRail(team, teamPeople, fam, kind) {
  return `
    <aside class="alch-detail-rail">
      <div class="alch-detail-shape"><canvas data-shape-fam="${escAttr(fam)}" data-shape-kind="${escAttr(kind)}" data-shape-scale="1.18" data-shape-draggable="1" data-shape-seed="${escAttr(team.record_id)}"></canvas></div>
      <div class="alch-rail-read">
        <h2 class="alch-detail-name">${escHtml(team.name || team.record_id)}</h2>
        ${team.focus ? `<p class="alch-detail-focus">${escHtml(team.focus)}</p>` : ""}
        <div class="alch-rail-list">
          ${team.domain ? `<div><span>domain</span>${escHtml(domainLabel(team.domain))}</div>` : ""}
          ${team.geo ? `<div><span>geo</span>${escHtml(team.geo)}</div>` : ""}
          ${detailMemberRows(teamPeople, kind)}
          ${team.membership ? `<div><span>status</span>${escHtml(detailLabelize(team.membership))}</div>` : ""}
        </div>
      </div>
    </aside>
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
    return `<li><button type="button" class="alch-detail-inline-link" data-directory-record="${escAttr(id)}">${escHtml(label)}</button> <span class="adl-role">${escHtml(role)}</span></li>`;
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
  wireConstellationTimelineControls(state.canvas);
}

function renderTeamDetail(team) {
  const cohortIndex = buildCohortIndex(activeDetailCohort());
  const recordId = team.record_id;
  const s = shapeForTeam(team);
  const kind = teamKind(team);
  const fam = s ? s.fam : Math.abs(hashStr(recordId || "_")) % 6;
  const memberClusters = cohortIndex.clustersByTeam.get(recordId) || [];
  const teamPeople = cohortIndex.peopleByTeam.get(recordId) || [];
  const editUrl = buildEditPRUrl({ recordType: "team", recordId });
  const links = team.links || {};
  const journey = detailJourneySummary(team);
  // Stage / evidence / upside / bottleneck / next milestone live in the
  // always-visible "trajectory" quick row; icp / problem / solution live
  // in the "about / positioning" prose up top. This disclosure keeps the
  // program's assessment and the declared plan.
  const assessmentRows = [
    { key: "company type", value: journey.company_type ? escHtml(journey.company_type) : "" },
    { key: "confidence", value: journey.confidence ? escHtml(journey.confidence) : "" },
    { key: "evidence notes", value: journey.evidence_notes ? escHtml(journey.evidence_notes) : "" },
    { key: "this week", value: detailList(team.weekly_goals) },
    { key: "milestones", value: detailList(team.monthly_milestones) },
    { key: "graduation", value: team.graduation_target ? escHtml(team.graduation_target) : "" },
  ];
  const evidenceRows = [
    { key: "traction", value: team.traction ? escHtml(team.traction) : "" },
    { key: "paper basis", value: team.paper_basis ? escHtml(team.paper_basis) : "" },
    { key: "prior shipping", value: detailList(team.prior_shipping) },
    { key: "hackathon note", value: team.hackathon_note ? escHtml(team.hackathon_note) : "" },
    { key: "skills", value: detailChips(team.skill_areas) },
    { key: "success", value: detailChips(team.success_dimensions, { muted: true }) },
  ];
  const coordinationRows = [
    { key: "depends on", value: renderDependencyLinks(team.dependencies) },
    { key: "seeking", value: detailList(team.seeking) },
    { key: "offering", value: detailList(team.offering) },
  ];
  const nextMove = detailQuickRow("next move", [
    detailQuickText("", team.now || journey.next_milestone),
  ]);
  // (needs / provides quick rows retired — the flat "coordination" block
  // below now shows the full seeking/offering lists in the same frame;
  // truncated copies above them were duplicate owners.)
  const guild = detailQuickRow("guild", memberClusters.map(cl => detailQuickText("", cl.label || cl.name || cl.record_id)));
  const trajectory = detailQuickRow("trajectory", [
    detailPill("stage", `${journey.stage} ${journey.stageLabel}`),
    detailPill("evidence", `${journey.evidence_quality}/5${journey.evidenceLabel ? ` ${journey.evidenceLabel}` : ""}`),
    detailPill("upside", `${journey.market_upside}/5`),
    detailPill("bottleneck", journey.primary_bottleneck),
    detailQuickText("next", journey.next_milestone),
  ]);
  const exploreBar = renderExploreBar([
    exploreJump("calendar", "Calendar", "calendar", { calendarView: "cal" }),
    exploreJump("availability", "Availability", "calendar", { calendarView: "presence", presenceTeam: recordId }),
    // One repo link only — the GitHub mark, falling back to links.repo when
    // github isn't set. The separate git-branch "repo" icon is retired: for
    // projects it just duplicated the repo destination.
    exploreLink("github", "GitHub", detailLinkForKey(links, "github") || detailLinkForKey(links, "repo")),
    exploreLink("x", "X", detailLinkForKey(links, "x")),
    exploreLink("website", "Website", detailLinkForKey(links, "website")),
    exploreLink("demo", "Demo", detailLinkForKey(links, "demo")),
    exploreLink("deck", "Deck", detailLinkForKey(links, "deck")),
    exploreLink("source", "Edit on GitHub", editUrl),
  ]);
  const readSection = renderFlatSection("about / positioning", teamPositioningProse(journey), "alch-detail-priority");
  const assessmentPreview = [
    journey.company_type,
    journey.confidence ? `${journey.confidence} confidence` : "",
  ].filter(Boolean).join(" · ") || previewSnippet(journey.evidence_notes);
  const evidencePreview = previewSnippet(team.traction || team.paper_basis);
  const seekingFirst = detailItems(team.seeking)[0];
  const dependsFirst = detailItems(team.dependencies)[0];
  const coordinationPreview = seekingFirst
    ? `seeking ${previewSnippet(seekingFirst, 52)}`
    : (dependsFirst ? `depends on ${previewSnippet(dependsFirst, 44)}` : previewSnippet(team.offering));

  state.canvas.innerHTML = `
    <header class="alch-detail-bar alch-trailbar">
      <button class="alch-trail-back" type="button" id="alch-detail-back" aria-label="${state.detailReturnMode === "constellation" ? "back to constellation" : "back to cohort grid"}">
        <span class="atb-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></span>
        <span class="atb-word">back</span>
      </button>
      <nav class="alch-trail-path" aria-label="location">
        <button type="button" class="atb-root" aria-label="${state.detailReturnMode === "constellation" ? "back to constellation" : "back to cohort directory"}">${state.detailReturnMode === "constellation" ? "constellation" : "cohort"}</button>
        <span class="atb-sep" aria-hidden="true">/</span>
        <span class="atb-here" aria-current="page">${escHtml(team.record_id.toLowerCase())}</span>
        ${team.is_mentor ? `<span class="atb-sep" aria-hidden="true">·</span><span class="atb-kind">mentor</span>` : ""}
      </nav>
    </header>
    ${state.detailReturnMode === "constellation" ? renderConstellationTimelineControls({ compact: true }) : ""}

    <article class="alch-detail-dossier alch-detail-dossier-team">
      ${renderTeamRail(team, teamPeople, fam, kind)}
      <section class="alch-detail-ledger">
        <div class="alch-ledger-head">
          ${exploreBar}
        </div>
        ${readSection ? `<div class="alch-section-stack alch-priority-stack">${readSection}</div>` : ""}
        <div class="alch-detail-quick alch-team-quick">${nextMove}${guild}${trajectory}</div>
        <div class="alch-section-stack">
          ${renderDisclosureSection("assessment / plan", detailRows(assessmentRows), false, assessmentPreview)}
          ${renderDisclosureSection("evidence", detailRows(evidenceRows), false, evidencePreview)}
          ${renderDisclosureSection("coordination", detailRows(coordinationRows), false, coordinationPreview)}
          ${renderRecordTimeline("team", recordId)}
        </div>
      </section>
    </article>
  `;

  state.canvas.querySelector("#alch-detail-back")?.addEventListener("click", closeDetail);
  state.canvas.querySelector(".atb-root")?.addEventListener("click", closeDetail);
  wireDetailDismiss();
  wirePersonLinks(state.canvas);
  wireExternalLinks(state.canvas);
  wireDetailJumps(state.canvas);
  if (state.detailReturnMode === "constellation") wireConstellationTimelineControls(state.canvas);
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
  const editUrl = buildEditPRUrl({ recordType: "person", recordId });
  const links = person.links || {};
  const timelineItems = detailTimelineItems("person", recordId);
  const absences = Array.isArray(person.absences) ? person.absences : [];
  const bioSection = renderFlatSection("about / bio", detailProse(person.bio_md), "alch-detail-priority");
  // Quick band = the one-frame read (first-mock lesson): what they're
  // doing now, how to engage, what to route to them, and where their work
  // sits — everything else is opt-in below.
  const nowRow = detailQuickRow("now", [detailQuickText("", person.now)]);
  const exploreBar = renderExploreBar([
    exploreJump("calendar", "Calendar", "calendar", { calendarView: "cal" }),
    exploreJump("availability", "Availability", "calendar", { calendarView: "presence", presencePeople: [recordId] }),
    exploreLink("github", "GitHub", detailLinkForKey(links, "github")),
    exploreLink("x", "X", detailLinkForKey(links, "x")),
    exploreLink("website", "Website", detailLinkForKey(links, "website")),
    exploreLink("linkedin", "LinkedIn", detailLinkForKey(links, "linkedin")),
    exploreLink("source", "Edit on GitHub", editUrl),
  ]);
  const askMeAbout = detailQuickRow(
    "ask me about",
    detailItems(person.go_to_them_for).slice(0, 4)
      .map(value => detailQuickChip(value, detailEvidenceFor(value, timelineItems)))
  );
  const themes = detailQuickRow(
    "themes",
    detailItems(person.recurring_themes).slice(0, 4).map(value => detailQuickText("", value))
  );
  // Team context rides in the read: the rail token answers "which team",
  // this row answers "what that team is building" without a click — the
  // focus pill is the new information.
  const teamContext = team ? detailQuickRow("team context", [
    detailTeamToken(team),
    team.focus ? detailPill("focus", team.focus) : "",
  ]) : "";
  const workingRows = [
    { key: "weekly intention", value: person.weekly_intention ? escHtml(person.weekly_intention) : "" },
    { key: "skills", value: detailChips(person.skill_areas || person.skills) },
    { key: "comm style", value: person.comm_style ? escHtml(person.comm_style) : "" },
    { key: "availability", value: person.availability_pref ? escHtml(person.availability_pref) : "" },
    { key: "working style", value: person.working_style ? escHtml(person.working_style) : "" },
    { key: "best contexts", value: detailList(person.best_contexts) },
    { key: "contributes", value: detailList(person.contribute_interests) },
    { key: "seeking", value: detailList(person.seeking) },
    { key: "offering", value: detailList(person.offering) },
  ];
  const routeRows = [
    {
      key: "also contributes",
      value: secondary.map(t => `<button type="button" class="alch-detail-inline-link" data-directory-record="${escAttr(t.record_id)}">${escHtml(t.name || t.record_id)}</button>`).join(" "),
    },
    {
      key: "absences",
      value: absences.map(a => `${detailDateRange(a.start, a.end)}${a.note ? ` <span style="opacity:0.55">(${escHtml(a.note)})</span>` : ""}`).join("<br/>"),
    },
    { key: "dietary", value: person.dietary_restrictions ? escHtml(person.dietary_restrictions) : "" },
  ];
  // Collapsed-section previews carry the strongest fact behind each fold.
  const workingPreview = previewSnippet(
    person.working_style || person.comm_style || person.weekly_intention || person.best_contexts
  );
  const proofPreview = previewSnippet(person.prior_work || person?.making_signature?.note);
  const todayIso = new Date().toISOString().slice(0, 10);
  const upcomingAbsence = absences.find(a => String(a.end || a.start || "") >= todayIso);
  const routesPreview = upcomingAbsence
    ? `away ${detailLongDate(upcomingAbsence.start)} → ${detailLongDate(upcomingAbsence.end)}`
    : (secondary.length ? `also contributes: ${previewSnippet(secondary[0].name || secondary[0].record_id, 40)}` : "");

  state.canvas.innerHTML = `
    <header class="alch-detail-bar alch-trailbar">
      <button class="alch-trail-back" type="button" id="alch-detail-back" aria-label="${state.detailReturnMode === "constellation" ? "back to constellation" : "back to cohort grid"}">
        <span class="atb-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg></span>
        <span class="atb-word">back</span>
      </button>
      <nav class="alch-trail-path" aria-label="location">
        <button type="button" class="atb-root" aria-label="${state.detailReturnMode === "constellation" ? "back to constellation" : "back to cohort directory"}">${state.detailReturnMode === "constellation" ? "constellation" : "cohort"}</button>
        <span class="atb-sep" aria-hidden="true">/</span>
        <span class="atb-here" aria-current="page">${escHtml(recordId.toLowerCase())}</span>
      </nav>
    </header>
    ${state.detailReturnMode === "constellation" ? renderConstellationTimelineControls({ compact: true }) : ""}

    <article class="alch-detail-dossier alch-detail-dossier-person">
      ${renderPersonRail(person, team, fam)}
      <section class="alch-detail-ledger">
        <div class="alch-ledger-head">
          <span class="alch-detail-h">individual read</span>
          ${exploreBar}
        </div>
        ${bioSection ? `<div class="alch-section-stack alch-priority-stack">${bioSection}</div>` : ""}
        <div class="alch-detail-quick">${nowRow}${askMeAbout}${themes}${teamContext}</div>
        <div class="alch-section-stack">
          ${renderDisclosureSection("working with", detailRows(workingRows), false, workingPreview)}
          ${renderDisclosureSection("proof / prior work", renderPersonProofRead(person), false, proofPreview)}
          ${renderDisclosureSection("routes / asks", detailRows(routeRows), false, routesPreview)}
          ${renderRecordTimeline("person", recordId)}
        </div>
      </section>
    </article>
  `;

  state.canvas.querySelector("#alch-detail-back")?.addEventListener("click", closeDetail);
  state.canvas.querySelector(".atb-root")?.addEventListener("click", closeDetail);
  wireDetailDismiss();
  wirePersonLinks(state.canvas);
  wireExternalLinks(state.canvas);
  wireDetailJumps(state.canvas);
  if (state.detailReturnMode === "constellation") wireConstellationTimelineControls(state.canvas);
}

function wireDetailJumps(root) {
  for (const el of root.querySelectorAll("[data-jump]")) {
    el.addEventListener("click", () => {
      let opts;
      try { opts = el.dataset.jumpOpts ? JSON.parse(el.dataset.jumpOpts) : undefined; } catch {}
      window.__srwkAlchemyJump?.(el.dataset.jump, opts);
    });
  }
}

function wirePersonLinks(root) {
  // Member chips use data-person and still open the person's dossier.
  // Team/company reference chips use data-directory-record so they return
  // to the roster card instead of chaining through the old detail page.
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
  const directoryHandler = (e) => {
    const id = (e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.directoryRecord) || "";
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    if (!openDirectoryRecord(id)) openDetail(id);
  };
  for (const el of root.querySelectorAll("[data-directory-record]")) {
    el.addEventListener("click", directoryHandler);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") directoryHandler(e);
    });
  }
}

function renderDetailLinks(L) {
  const items = compactCohortLinkItems({ links: L || {} });
  if (!items.length) return `<div class="alch-detail-row"><span class="adr-k">links</span><span class="adr-v" style="opacity:0.55">— not yet submitted</span></div>`;
  return `<div class="alch-detail-row"><span class="adr-k">links</span><span class="adr-v">${items.map(item =>
    `<a href="${escAttr(item.href)}" data-external title="${escAttr(item.display)}">${escHtml(item.label)}</a>`
  ).join('<span class="acm-sep">·</span>')}</span></div>`;
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
  // Profile-page default: with nothing picked yet, the editor opens on
  // YOUR record (the seal) — "edit a record" is "edit my record" until
  // you pick something else. Identity kinds map 1:1 onto editor kinds.
  if (p.editMode === "edit" && !p.editTargetId) {
    const me = getIdentity();
    if (me && (me.kind === "person" || me.kind === "team" || me.kind === "project")) {
      p.editKind = me.kind;
      p.editTargetId = me.record_id;
    }
  }
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
    <!-- Theme toggle keeps the old intro strip's top-right slot (the row is
         right-aligned) — no dedicated header row pushing the seal section
         down. -->
    <div class="alch-page-intro">
      <button
        id="alch-theme-toggle"
        class="alch-theme-toggle"
        type="button"
        role="switch"
        aria-checked="${themeNow === "dark"}"
        data-theme-now="${themeNow}"
        title="switch to ${themeNext} mode"
        aria-label="switch to ${themeNext} mode"
      >
        <span class="att-track" aria-hidden="true">
          <span class="att-ico att-sun"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 3v1"/><path d="M12 20v1"/><path d="M3 12h1"/><path d="M20 12h1"/><path d="m18.364 5.636-.707.707"/><path d="m6.343 17.657-.707.707"/><path d="m5.636 5.636.707.707"/><path d="m17.657 17.657.707.707"/></svg></span>
          <span class="att-ico att-moon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/></svg></span>
          <span class="att-thumb"></span>
        </span>
      </button>
    </div>

    <!-- your seal — identity summary + re-seal disclosure (merged from
         the identity-pill popup 2026-06); filled by mountResealInline as
         another .alch-profile-section. Sits FIRST: a profile page leads
         with who you are; the record editor follows. -->
    <section id="alch-reseal-host" aria-label="your seal"></section>

    ${forkBannerHtml}

    <section class="alch-profile-section">
      <h3 class="alch-profile-h">${p.editMode === "add" ? "add a record" : "edit a record"}</h3>
      <div class="alch-pf-tabsrow">
        <nav class="alch-pf-modetabs" role="tablist" aria-label="add or edit">
          <button class="alch-pf-modetab" data-edit-mode="add"  type="button" aria-selected="${p.editMode === "add"}">add</button>
          <button class="alch-pf-modetab" data-edit-mode="edit" type="button" aria-selected="${p.editMode === "edit"}">edit</button>
        </nav>
        <nav class="alch-pf-subtabs" role="tablist" aria-label="record kind">
          <button class="alch-pf-subtab" data-edit-kind="team"    type="button" aria-selected="${p.editKind === "team"}">team</button>
          <button class="alch-pf-subtab" data-edit-kind="project" type="button" aria-selected="${p.editKind === "project"}">project</button>
          <button class="alch-pf-subtab" data-edit-kind="person"  type="button" aria-selected="${p.editKind === "person"}">person</button>
        </nav>
      </div>
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

// "this is me" — shown beside the editor's record picker whenever the
// loaded record is NOT the current seal. Claiming/switching identity
// happens here, against the record you're already looking at, instead
// of through a second picker in the seal section. Rendered inline in
// the picker row (not its own line) so its presence never shifts the
// form rows below.
function sealClaimHtml(p) {
  if (p.editMode !== "edit" || !p.editTargetId) return "";
  const me = getIdentity();
  if (me && me.kind === p.editKind && me.record_id === p.editTargetId) return "";
  const pool = (p.editKind === "person")
    ? (state.cohort?.people || [])
    : teamsOfKind(state.cohort?.teams || [], p.editKind);
  const rec = pool.find(r => r.record_id === p.editTargetId);
  const nm = rec?.name || p.editTargetId;
  const label = me ? `re-seal as ${nm}` : `this is me — seal as ${nm}`;
  return `
    <button id="alch-pf-claim-btn" class="alch-seal-btn alch-pf-claim" type="button"
            title="set your seal on this device to ${escAttr(nm)} (${escAttr(p.editKind)} · ${escAttr(p.editTargetId)})">
      ${escHtml(label)}
    </button>
  `;
}

// The picker label reads "person" for people, "which team/project" for
// the rest — shared so the ADD-mode ghost row matches EDIT exactly.
function targetRowLabel(kind) {
  return kind === "person" ? "person" : `which ${kind}`;
}

function renderEditorBody(p, teams, people) {
  const fields = (p.editKind === "person") ? PERSON_EDITABLE_FIELDS : teamFieldsFor(p.editKind);

  // ADD mode: blank form, no record-picker — but the picker ROW still
  // renders (disabled, "— new <kind> —") so the form rows sit at the
  // same vertical position in both modes instead of jumping on toggle.
  if (p.editMode === "add") {
    const formHtml = p.editDraft
      ? renderEditorForm(fields, p.editDraft, { teams })
      : `<p class="alch-pf-pick">loading…</p>`;
    return `
      <div class="alch-pf-target">
        <label><span>${escHtml(targetRowLabel(p.editKind))}</span>
          <select class="alch-pf-target-select" disabled aria-disabled="true">
            <option>— new ${escHtml(p.editKind)} —</option>
          </select>
        </label>
      </div>
      ${formHtml}
      ${p.editDraft ? renderSubmitBlock(p) : ""}
    `;
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
        ${sealClaimHtml(p)}
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
      ${sealClaimHtml(p)}
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
  // Seal summary card at the top of the page (async — paints once the
  // cohort surface resolves; wires its own controls). Carry over the two
  // signals the retired membrane self-panel used to surface: the edges /
  // connections count and the generated "system read" paragraph. "Your seal"
  // is their only home now.
  let sealExtras = {};
  try {
    const ms = computeMembraneData().self || {};
    sealExtras = { edgeCount: ms.edgeCount, connections: ms.connections, read: ms.read };
  } catch {}
  mountResealInline(state.canvas.querySelector("#alch-reseal-host"), sealExtras);

  // "this is me" — seal as the record currently loaded in the editor.
  // Re-render so the seal card and this button both reflect the claim.
  const claimBtn = state.canvas.querySelector("#alch-pf-claim-btn");
  if (claimBtn) {
    claimBtn.addEventListener("click", () => {
      const p = state.profile;
      if (!p?.editTargetId) return;
      const pool = (p.editKind === "person")
        ? (state.cohort?.people || [])
        : teamsOfKind(state.cohort?.teams || [], p.editKind);
      const rec = pool.find(r => r.record_id === p.editTargetId);
      setIdentity({ kind: p.editKind, record_id: p.editTargetId, display_name: rec?.name || p.editTargetId });
      renderProfile();
      wireProfileForm();
    });
  }

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
export function quoteYaml(s) {
  return `"${String(s ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Emit a YAML scalar — quoted on a single line for short strings, or as a
// literal block (`|`) for anything containing a newline. `indent` is the
// number of spaces a continuation line should sit at (the key's column
// + 2). Used for textarea-backed fields like weekly_goals, monthly_milestones,
// and the personal-API fields where multiline content matters.
export function yamlScalar(value, indent = 2) {
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
