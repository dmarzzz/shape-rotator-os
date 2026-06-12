// BOOT — wires lens + shape + dimension + materialization into a running viz.
//
// What this does:
//  - Fetches /graph from the community server
//  - Builds 3d-force-graph with sprite-per-node rendering
//  - Subscribes to /events SSE for live materialization
//  - Listens to lens/shape dropdown changes → re-applies dimensions + relayouts
//  - Heavy damping; idle camera drift

import * as THREE from "three";
import { UnrealBloomPass } from "../vendor/three-extras/postprocessing/UnrealBloomPass.js";

import { applyStoredTheme } from "./theme.js";
// Apply the persisted light/dark choice at module load — before any
// alchemy surface paints — so launches never flash the wrong palette.
applyStoredTheme();

import { LENSES, LENS_LIST } from "./lenses.js";
import { SHAPES, SHAPE_LIST, easeOutQuart } from "./shapes.js";
import { applyAllDimensions, applyDimensions } from "./dimensions.js";
import { DAMP, dampPosition } from "./damping.js";
import { materialize } from "./materialize.js";
import { syncLabels, fadeLabelsByDistance } from "./labels.js";
import { stableHue } from "./colors.js";
import {
  toast,
  mountConnectionIndicator,
  setConnectionState,
  noteConnectionEvent,
  registerCommands,
  registerKeyboardShortcuts,
  openCommandPalette,
  openKeyboardOverlay,
  wireGlobalKeyboard,
  toggleManualReducedMotion,
  isReducedMotion,
} from "./ux.js";
import {
  tickNumber,
  morphActiveTab,
  mountTabIndicator,
  updateTabIndicator,
  revealOnce,
  magnetize,
  rotorMarkup,
} from "./motion.js";
import {
  mountLaunchOverlay,
  mountTitlebarMark,
  mountPaletteMark,
  replayLaunch,
} from "./signature.js";
// graph2 + cosmos archived 2026-05-09 — see _archive/experimental/.
// Kept as no-op stubs so existing call sites (all wrapped in try/catch
// already) continue to compile without ceremony.
const Graph2 = { mount() {}, setActive() {}, notifyDataChanged() {}, pulseNode() {} };
const Cosmos = { mount() {}, setActive() {}, notifyDataChanged() {}, pulseNode() {} };
import * as Atlas from "./atlas.js";
import * as Easel from "./easel.js";
import * as Alchemy from "./alchemy.js";
import * as Tabs from "./tabs.js";
import * as Find from "./find.js";
import { mountQuickDial } from "./quickdial.js";
import { getManifest, getSyncLog, getNodeLog, getHealth } from "./sync-client.js";
import { subscribeToCohortChanges, subscribeToSyncState } from "./cohort-source.js";

// Small Notion-style sync chip pinned to the bottom-left. Subscribes
// to cohort-source's sync lifecycle and fades in while a background
// refresh is in flight, fades out a beat after it resolves. Replaces
// the launch splash for warm boots (when there's already a hot LS
// snapshot, the splash would just be artificial latency).
function mountSyncChip() {
  if (document.getElementById("srfg-sync-chip")) return;
  const chip = document.createElement("div");
  chip.id = "srfg-sync-chip";
  chip.className = "srfg-sync-chip";
  chip.setAttribute("aria-live", "polite");
  chip.innerHTML = `
    <span class="srfg-sync-spinner" aria-hidden="true"></span>
    <span class="srfg-sync-label">syncing cohort</span>
  `;
  document.body.appendChild(chip);

  // Debounce show: avoid flashing the chip for syncs that resolve in
  // <250ms (LS-hit + fresh-enough cache → fast refresh).
  // Linger on idle: keep visible for 600ms after resolution so the
  // user can see that "yes, that's done" rather than blinking out.
  let showTimer = null;
  let hideTimer = null;
  subscribeToSyncState((state) => {
    if (state === "syncing") {
      clearTimeout(hideTimer); hideTimer = null;
      if (chip.dataset.state === "visible") return;
      showTimer = setTimeout(() => {
        chip.dataset.state = "visible";
      }, 250);
    } else {
      clearTimeout(showTimer); showTimer = null;
      if (chip.dataset.state !== "visible") return;
      hideTimer = setTimeout(() => {
        chip.dataset.state = "hidden";
      }, 600);
    }
  });
}

// Same-shape as setInterval, but skips invocations while the document is
// hidden (tab in the background, window minimized, app fully occluded).
// Electron throttles rAF in those states but doesn't suspend setInterval,
// so without this every long-lived poller burns CPU + fires network calls
// while the user can't see the result. Use everywhere a callback's work
// is purely UI-refresh or background-sync that the user only needs when
// they're actually looking. Returns the interval id so callers can clear
// it the usual way.
function setIntervalVisible(fn, ms) {
  return setInterval(() => {
    if (document.hidden) return;
    try { fn(); } catch (e) { console.error("[setIntervalVisible]", e); }
  }, ms);
}

function requestFrameOrTimeout(fn, timeoutMs = 80) {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  try { requestAnimationFrame(run); } catch {}
  setTimeout(run, timeoutMs);
}

// Shorthand: animate a numeric DOM cell to `n`. We wrap tickNumber so the
// dozens of "el.textContent = …" call sites flip to the animated path
// without ceremony. Pass `fmt` for non-trivial formatters (bytes, %).
function tick(elOrId, n, fmt) {
  const el = (typeof elOrId === "string") ? document.getElementById(elOrId) : elOrId;
  if (!el) return;
  tickNumber(el, n, { format: fmt || ((v) => String(Math.round(v))) });
}

const srwk = {
  G: null,
  scene: null,
  serverUrl: "http://127.0.0.1:7777",  // swf-node default; main.js overrides via env:get
  graph: null,
  nodes: [],
  edges: [],
  peers: new Map(),
  nodeMap: new Map(),
  spriteTex: null, haloTex: null,
  startTime: performance.now(),
  bounds: { radius: 600 },
  lens: LENSES.contributor,       // peer-territory view — most legible default
  shape: SHAPES.cluster,
  shapeTransition: null,         // {start, duration, source: Map, target: Map}
  groupCentroids: new Map(),
  driftBase: { x: 0, y: 0, z: 0 },
  lastUserT: 0,
  lastEventId: 0,                // for SSE replay on reconnect
  eventSource: null,
  clusters: [],                  // server-computed cluster labels
  labelMap: new Map(),           // key → THREE.Sprite
  liveSeen: new Map(),           // pubkey → ms-timestamp of last contribution event
};

const LIVE_WINDOW_MS = 90000;

function refreshLiveCount() {
  const now = performance.now();
  let live = 0;
  for (const [, t] of state_liveSeen()) {
    if (now - t < LIVE_WINDOW_MS) live++;
  }
  tick("live-count", live);
}
function state_liveSeen() { return srwk.liveSeen; }
setIntervalVisible(() => refreshLiveCount(), 5000);

// ─── app-update chip (electron-updater + GitHub Releases) ────────────
// Wires the version chip in the top-right of the tab bar. On boot, paints
// `v0.x.y` (or `v0.x.y · dev` in dev). Click opens an inline panel
// anchored under the chip — see updatePanel(). The `data-update="available"`
// hook is still stamped on the chip when a newer version is known, so
// the existing CSS treatment (cyan tint in the cosmic theme, ink-1 in
// the editorial theme) keeps working.
async function wireAppUpdateChip() {
  const chip = document.getElementById("fg-version-chip");
  if (!chip) return;
  let info = null;
  try { info = await window.api?.getAppInfo?.(); } catch {}
  if (info) {
    chip.textContent = `v${info.version}${info.isPackaged ? "" : "·dev"}`;
    chip.title = info.isPackaged
      ? `v${info.version} · click for updates`
      : `v${info.version} · dev mode (auto-update disabled)`;
    chip.dataset.current = info.version;
    // Cache the capability flag so the update panel can branch
    // between seamless (Windows / AppImage) and manual-download
    // (macOS / .deb) without re-asking main on every render.
    if (info.canAutoUpdate) chip.dataset.canAutoUpdate = "1";
    else delete chip.dataset.canAutoUpdate;
  } else {
    chip.textContent = "v?";
  }
  chip.addEventListener("click", () => onVersionClick());
}

// ── inline update icon — replaces the old update popup ──────────────
// A small icon slot sits to the right of the version stamp
// (#fg-update-icon). It is empty until something happens:
//   ""         → empty resting state (a reserved gap, no glyph)
//   checking   → spinner, while we ask main for a newer build
//   ok         → checkmark confirmation ("you're on the latest"); auto-clears
//   available  → download icon — a newer build exists; click to fetch it
// Clicking the version stamp runs a check; clicking the download icon
// fetches/applies the update for the user's platform. No popup, no text.
const UPDATE_ICON_SVG = {
  // Genuinely-animated loaders built from self-animating SVG (SMIL — part
  // of the SVG standard, no library / license needed). The motion lives in
  // the <animate>/<animateTransform> tags, so these run on their own with
  // no CSS animation.
  //
  // "checking" — a twinkling constellation: three large 4-point stars pop
  // in and out in a staggered sequence (scale + opacity), reads as
  // shimmering. Stars are sized + spread to fill the canvas. The whole
  // group also fades in once over 0.5s when the icon first appears.
  checking: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><g opacity="0"><animate attributeName="opacity" values="0;1" dur="0.5s" begin="0s" fill="freeze"/><g transform="translate(7,7)"><path d="M0,-5 L1.4,-1.4 L5,0 L1.4,1.4 L0,5 L-1.4,1.4 L-5,0 L-1.4,-1.4 Z"><animateTransform attributeName="transform" type="scale" values="0.15;1;0.15" dur="1.5s" begin="0s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.15;1;0.15" dur="1.5s" begin="0s" repeatCount="indefinite"/></path></g><g transform="translate(17.5,9)"><path d="M0,-4.2 L1.2,-1.2 L4.2,0 L1.2,1.2 L0,4.2 L-1.2,1.2 L-4.2,0 L-1.2,-1.2 Z"><animateTransform attributeName="transform" type="scale" values="0.15;1;0.15" dur="1.5s" begin="0.5s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.15;1;0.15" dur="1.5s" begin="0.5s" repeatCount="indefinite"/></path></g><g transform="translate(11.5,17)"><path d="M0,-4.6 L1.3,-1.3 L4.6,0 L1.3,1.3 L0,4.6 L-1.3,1.3 L-4.6,0 L-1.3,-1.3 Z"><animateTransform attributeName="transform" type="scale" values="0.15;1;0.15" dur="1.5s" begin="1s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.15;1;0.15" dur="1.5s" begin="1s" repeatCount="indefinite"/></path></g></g></svg>`,
  ok:        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  available: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/></svg>`,
  // Lucide "globe-off" — shown when we can't reach the update server / get
  // info about the latest release.
  offline:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.114 4.462A14.5 14.5 0 0 1 12 2a10 10 0 0 1 9.313 13.643"/><path d="M15.557 15.556A14.5 14.5 0 0 1 12 22 10 10 0 0 1 4.929 4.929"/><path d="M15.892 10.234A14.5 14.5 0 0 0 12 2a10 10 0 0 0-3.643.687"/><path d="M17.656 12H22"/><path d="M19.071 19.071A10 10 0 0 1 12 22 14.5 14.5 0 0 1 8.44 8.45"/><path d="M2 12h10"/><path d="m2 2 20 20"/></svg>`,
};
const UPDATE_ICON_TITLE = {
  checking:  "checking for updates…",
  ok:        "you're on the latest build",
  available: "update available — click to download",
  offline:   "couldn't reach the update server",
};
let _okIconClearTimer = null;

// Paint the icon slot. Passing "" (or an unknown state) returns it to the
// empty resting state — the element stays in the layout (reserved width)
// so the version number doesn't shift as the glyph comes and goes.
function setUpdateIcon(state) {
  const icon = document.getElementById("fg-update-icon");
  if (!icon) return;
  if (_okIconClearTimer) { clearTimeout(_okIconClearTimer); _okIconClearTimer = null; }
  icon.classList.remove("fading");   // cancel any in-progress fade-out
  const svg = UPDATE_ICON_SVG[state];
  icon.dataset.state = svg ? state : "";
  icon.innerHTML = svg || "";
  if (svg) icon.title = UPDATE_ICON_TITLE[state] || "";
  else icon.removeAttribute("title");
  // The "up to date" checkmark is a transient confirmation: hold it for 3s,
  // then fade it out over 1s (the .fading class drives the CSS transition),
  // then return to the empty resting state.
  if (state === "ok") {
    _okIconClearTimer = setTimeout(() => {
      icon.classList.add("fading");
      _okIconClearTimer = setTimeout(() => setUpdateIcon(""), 1000);
    }, 3000);
  }
}

// Live download readout. While an update downloads, electron-updater (or the
// manual mac/.deb path) emits "download-progress" → "fg:update-progress"; we
// paint a progress ring with the running % beside it, replacing the "checking"
// spinner. The ring DOM is built once on entry, then only the arc offset + the
// number update per event — no DOM churn at ~20 events/sec, and the arc eases
// between values via a CSS transition on stroke-dashoffset. p = { percent,
// bytesPerSecond, transferred, total } — any field may be absent (the manual
// path omits bytesPerSecond).
const _RING_C = 56.549;   // circumference of an r=9 circle (2·π·9)
function setDownloadProgress(p) {
  const icon = document.getElementById("fg-update-icon");
  if (!icon) return;
  if (_okIconClearTimer) { clearTimeout(_okIconClearTimer); _okIconClearTimer = null; }
  icon.classList.remove("fading");
  const pct = Math.max(0, Math.min(100, Math.round(p?.percent || 0)));
  if (icon.dataset.state !== "downloading") {
    icon.dataset.state = "downloading";
    icon.innerHTML =
      `<svg class="fg-ring" viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
        `<circle class="fg-ring-track" cx="12" cy="12" r="9"/>` +
        `<circle class="fg-ring-arc" cx="12" cy="12" r="9" stroke-linecap="round"` +
          ` stroke-dasharray="${_RING_C}" stroke-dashoffset="${_RING_C}"` +
          ` transform="rotate(-90 12 12)"/>` +
      `</svg><span class="fg-update-pct">0%</span>`;
  }
  const arc = icon.querySelector(".fg-ring-arc");
  const txt = icon.querySelector(".fg-update-pct");
  if (arc) arc.setAttribute("stroke-dashoffset", String(_RING_C * (1 - pct / 100)));
  if (txt) txt.textContent = `${pct}%`;
  // Exact size + speed live in the tooltip so the slot stays a clean readout.
  const mb = (b) => (b / 1048576).toFixed(0);
  const size  = p?.total ? ` · ${mb(p.transferred || 0)}/${mb(p.total)} MB` : "";
  const speed = p?.bytesPerSecond ? ` · ${mb(p.bytesPerSecond)} MB/s` : "";
  icon.title = `downloading update… ${pct}%${size}${speed}`;
}

// Persistent post-download state — unlike "ok" (a transient checkmark) this
// stays put until the user finishes, because finishing needs an action that
// differs by platform:
//   restart (win / AppImage / signed-mac — canAutoUpdate) — electron-updater
//           staged the installer. Click = install silently + relaunch now; it
//           also auto-installs on the next quit, so there's never a file step.
//   manual  (unsigned-mac / .deb)                          — the installer was
//           downloaded to ~/Downloads and opened. Click = open it again.
let _updateReady = null;   // { mode, path } while a staged update is waiting
function setUpdateReady(mode, ctx) {
  const icon = document.getElementById("fg-update-icon");
  if (!icon) return;
  if (_okIconClearTimer) { clearTimeout(_okIconClearTimer); _okIconClearTimer = null; }
  icon.classList.remove("fading");
  _updateReady = { mode, path: ctx?.path || null };
  icon.dataset.state = "ready";
  const glyph = mode === "restart"
    ? `<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>` // rotate-cw
    : `<path d="M20 6 9 17l-5-5"/>`;                                                          // check
  // Icon-only (matches the rest of the update indicator) — the action label
  // lives in the tooltip below, not next to the glyph.
  icon.innerHTML =
    `<svg class="fg-ready-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor"` +
      ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph}</svg>`;
  icon.title = mode === "restart"
    ? "update downloaded — click to install & relaunch now (or it installs automatically next time you quit)"
    : "installer downloaded to your Downloads — click to open & finish";
}

// Ask main whether a newer build exists, driving the icon slot. Shared by
// the manual click (showSpinner → spinner + checkmark feedback) and the
// silent boot/refresh check (no spinner → only lights up on an actual hit).
async function checkForUpdate({ showSpinner } = {}) {
  const chip = document.getElementById("fg-version-chip");
  if (showSpinner) setUpdateIcon("checking");
  try {
    const r = await window.api?.checkAppUpdate?.();
    if (chip && r?.current) chip.dataset.current = r.current;
    // Couldn't get info about the latest release (no response, or a failure
    // that isn't the deliberate dev-mode disable) → globe-off.
    if (!r || (!r.ok && r.reason !== "dev_mode")) {
      if (chip) chip.removeAttribute("data-update");
      if (showSpinner) setUpdateIcon("offline");
      return;
    }
    if (r.ok && r.available) {
      announceUpdateAvailable(r.latest);
    } else {
      if (chip) chip.removeAttribute("data-update");
      // Up to date (or dev mode) — show the confirmation checkmark only when
      // the user actively asked.
      if (showSpinner) setUpdateIcon("ok");
    }
  } catch {
    // Network / updater threw — can't reach the release info; show globe-off
    // on a manual check, stay silent (empty) on the boot check.
    if (chip) chip.removeAttribute("data-update");
    if (showSpinner) setUpdateIcon("offline");
  }
}

// A newer build is known to exist (silent boot check, manual click, or a
// push from main's periodic 2h check). Stamp the chip, light the download
// icon, and show the update banner — the bottom-left icon alone proved too
// subtle (users weren't updating), so the banner is the loud signal. It
// sits in the left side panel directly above the profile/version footer
// row (same width — see .fg-update-banner in styles.css). Clicking it
// runs the same action as clicking the icon: download/install for this
// platform. It cannot be dismissed — it stays until the user updates.
function announceUpdateAvailable(latest) {
  const chip = document.getElementById("fg-version-chip");
  const icon = document.getElementById("fg-update-icon");
  if (chip) {
    chip.dataset.update = "available";
    chip.dataset.latest = latest || "";
    chip.title = `update available · v${latest} (you have v${chip.dataset.current || "?"})`;
  }
  // Don't clobber an in-flight download or a staged installer waiting on
  // the user — those states already represent this release.
  const st = icon?.dataset.state;
  if (st === "downloading" || st === "ready") return;
  setUpdateIcon("available");
  showUpdateBanner();
}

// Build the banner once and park it above the footer row. The action area
// is a real <button> (keyboard focusable). Deliberately no dismiss
// affordance — the only way to clear it is to update; it leaves when the
// click kicks off the download (the icon's progress ring takes over).
function showUpdateBanner() {
  if (document.getElementById("fg-update-banner")) return;
  const banner = document.createElement("div");
  banner.id = "fg-update-banner";
  banner.className = "fg-update-banner";
  banner.innerHTML =
    `<button class="fg-update-banner-action" type="button" title="click to download the update">` +
      `<span class="fg-update-banner-dot" aria-hidden="true"></span>update available!</button>`;
  banner.querySelector(".fg-update-banner-action").addEventListener("click", () => {
    banner.remove();
    onUpdateIconClick();
  });
  document.body.appendChild(banner);
}

// Version stamp clicked. If we already know an update is waiting, go
// straight to the download; otherwise run a check with visible feedback.
function onVersionClick() {
  const icon = document.getElementById("fg-update-icon");
  // A known update (waiting to download, or downloaded & waiting to finish) →
  // run the icon's action; otherwise re-check with visible feedback.
  const st = icon?.dataset.state;
  if (st === "available" || st === "ready") { onUpdateIconClick(); return; }
  checkForUpdate({ showSpinner: true });
}

// Icon slot clicked. Download icon → fetch/apply the update for this
// platform; anything else behaves like a version-stamp click (re-check).
async function onUpdateIconClick() {
  const icon = document.getElementById("fg-update-icon");
  const chip = document.getElementById("fg-version-chip");
  const state = icon?.dataset.state;
  // A staged update is waiting — a click finishes it (platform-specific):
  // restart now, or re-open the downloaded installer.
  if (state === "ready" && _updateReady) {
    try {
      if (_updateReady.mode === "restart") await window.api?.applyUpdateAndRestart?.();
      else await window.api?.openDownloadedInstaller?.(_updateReady.path);
    } catch {}
    return;
  }
  if (state === "downloading") return;                                  // mid-download: ignore clicks
  if (state !== "available") { checkForUpdate({ showSpinner: true }); return; }
  setUpdateIcon("checking");
  // Subscribe to the live download-progress stream so the ring fills (spinner →
  // 0% → … → 100% → "update ready") instead of a frozen spinner for the ~275 MB
  // pull. unsub() detaches the listener in finally so repeated downloads don't
  // stack handlers. Both paths below stream it — main.js forwards
  // "fg:update-progress" for electron-updater AND the manual mac/.deb download.
  let unsub = null;
  try {
    unsub = window.api?.onUpdateProgress?.((p) => setDownloadProgress(p)) || null;
    if (chip?.dataset.canAutoUpdate === "1") {
      // Windows / AppImage / signed-mac: electron-updater stages the installer;
      // it applies on quit. Land on the persistent "update ready" state.
      const dl = await window.api?.applyAppUpdate?.();
      if (dl?.ok) setUpdateReady("restart");
      else setUpdateIcon("available");
    } else {
      // unsigned-mac / .deb: download to ~/Downloads and open/reveal it; the
      // user runs the installer. Land on the persistent "open installer" state.
      const res = await window.api?.downloadAndRevealUpdate?.();
      if (res?.ok) setUpdateReady("manual", { path: res.path });
      else setUpdateIcon("available");
    }
  } catch {
    setUpdateIcon("available");
  } finally {
    if (unsub) { try { unsub(); } catch {} }
  }
}


async function boot() {
  const env = await (window.api?.env?.() ?? Promise.resolve({}));
  if (env?.serverUrl) srwk.serverUrl = env.serverUrl;

  srwk.spriteTex = makeSpriteTex();
  srwk.haloTex = makeHaloTex();

  // populate dropdowns
  const lensSel = document.getElementById("lens-select");
  for (const l of LENS_LIST) {
    const opt = document.createElement("option");
    opt.value = l.id; opt.textContent = l.label; lensSel.appendChild(opt);
  }
  const shapeSel = document.getElementById("shape-select");
  for (const s of SHAPE_LIST) {
    const opt = document.createElement("option");
    opt.value = s.id; opt.textContent = s.label; shapeSel.appendChild(opt);
  }
  lensSel.value = srwk.lens.id;
  shapeSel.value = srwk.shape.id;
  lensSel.addEventListener("change", () => switchLens(LENSES[lensSel.value]));
  shapeSel.addEventListener("change", () => switchShape(SHAPES[shapeSel.value]));

  // Signature first-launch animation — the rotor glyph assembles from
  // four scattered dots and the SHAPE ROTATOR wordmark resolves. Lives
  // in signature.js. Skippable on Esc / Enter / pointerdown / Space.
  //
  // Warm boot: an onboarded user with a hot localStorage snapshot has
  // everything ready synchronously — no point holding them behind the
  // splash for the 360ms+380ms-fade floor. We pass { instant: true }
  // which returns a no-op handle, and the bottom "syncing cohort"
  // chip (mounted below) communicates background refresh state
  // instead. First launch (or LS evicted) still gets the full splash.
  let _onboarded = false, _hasSnapshot = false;
  try { _onboarded = localStorage.getItem("srwk:onboarded") === "1"; } catch {}
  try { _hasSnapshot = !!localStorage.getItem("srfg:cohort_surface_v1"); } catch {}
  const warmBoot = _onboarded && _hasSnapshot;
  const launch = mountLaunchOverlay({ progressive: true, instant: warmBoot });
  launch.setStatus("warming the cache", 0.08);
  window.__srfgLaunch = launch;
  setTimeout(() => {
    if (window.__srfgLaunch) {
      try { window.__srfgLaunch.skip(); } catch {}
      window.__srfgLaunch = null;
    }
  }, 8000);
  mountTitlebarMark();
  mountPaletteMark();
  launch.setStatus("loading cohort data", 0.25);
  // Hand the control object off to whoever drives boot completion below.
  // We dismiss the overlay once alchemy has mounted + first render is in
  // flight — that's the first moment the user can do something useful.
  window.__srfgLaunch = launch;
  // Safety net: never block the user behind the splash longer than 8s,
  // even if the alchemy mount path doesn't fire ready() for any reason.
  setTimeout(() => {
    if (window.__srfgLaunch) {
      try { window.__srfgLaunch.skip(); } catch {}
      window.__srfgLaunch = null;
    }
  }, 8000);

  // mount global UX scaffolding before everything else so any boot-time
  // toast / status update lands in the right surface
  mountConnectionIndicator({ serverUrl: srwk.serverUrl });
  setConnectionState({ state: "connecting", serverUrl: srwk.serverUrl });
  mountSyncChip();
  mountQuickDial();
  wireGlobalKeyboard();
  registerVisualizerShortcutsAndCommands();

  // Identity pill in the top-right of the tab bar + first-launch
  // onboarding modal. Pill is mounted immediately (paints as
  // "claim profile" until cohort loads); modal fires once cohort
  // bundles are available so there's actually something to pick from.
  try {
    const { mountIdentityPill, maybeShowOnboarding } = await import("./identity.js");
    mountIdentityPill(document.getElementById("tab-bar"));
    // Defer onboarding past the boot crunch so it lands on a settled UI.
    setTimeout(() => { maybeShowOnboarding(); }, 1200);
  } catch (e) {
    console.warn("[boot] identity module failed to load:", e?.message || e);
  }

  // App version + auto-update chip (electron-updater + GitHub Releases).
  // Paints "v0.x" in the top-right; click checks for an update and walks
  // the user through download → install. No-op in dev (the IPC handler
  // returns reason: "dev_mode").
  wireAppUpdateChip();

  // Park the profile link + version stamp together in a footer row that
  // overlays the bottom of the left side panel (profile on the left,
  // version right-aligned to the panel edge). Mounted at body level and
  // sized to the panel in CSS — keeping it OUT of #sidebar avoids that
  // element's backdrop-filter clipping the fixed strip.
  try {
    const pill = document.getElementById("identity-pill");
    const ver  = document.getElementById("fg-version-chip");
    if (pill && ver && !document.getElementById("fg-footer-row")) {
      const row = document.createElement("div");
      row.id = "fg-footer-row";
      row.className = "fg-footer-row";
      document.body.appendChild(row);
      row.appendChild(pill);

      // Update status icon — empty at rest; shows a spinner while checking,
      // a checkmark when up to date, or a download glyph when an update is
      // available (see setUpdateIcon). Same Lucide line set as the side
      // panel's page icons. Click → check / download.
      const updIcon = document.createElement("button");
      updIcon.id = "fg-update-icon";
      updIcon.className = "fg-update-icon";
      updIcon.type = "button";
      updIcon.dataset.state = "";   // empty resting state (collapsed)
      updIcon.setAttribute("aria-label", "update status");
      updIcon.addEventListener("click", () => onUpdateIconClick());

      // Group the version + icon, right-aligned to the panel edge. The icon
      // sits to the RIGHT of the version in a permanently reserved slot (it
      // keeps its width even when empty), so the version's position is fixed
      // and never shifts when the icon's glyph appears.
      const cluster = document.createElement("div");
      cluster.className = "fg-footer-vcluster";
      cluster.appendChild(ver);
      cluster.appendChild(updIcon);
      row.appendChild(cluster);
    }
  } catch (e) {
    console.warn("[boot] footer row assembly failed:", e?.message || e);
  }

  // Main re-checks for releases every 2h and pushes hits here, so a
  // session left open for days still gets the indicator + toast without
  // anyone clicking the version stamp.
  try { window.api?.onUpdateAvailable?.((info) => announceUpdateAvailable(info?.version || null)); } catch {}

  // Check for a newer build automatically on launch / refresh (previously
  // this only ran when the version stamp was clicked). Silent — it only
  // lights up the download icon if something's actually available.
  checkForUpdate({ showSpinner: false });

  // Wire tabs + search-overlay FIRST so the UI is navigable even if the
  // swf-node graph fetch fails. Previously a `Failed to fetch` from
  // loadGraph would halt boot before wireTabs ran, leaving the user
  // stuck on whatever data-active-tab the HTML defaults to with no way
  // to switch. Atlas + alchemy don't actually need the graph data to
  // mount; they read from their own sources.
  wireSearchTab();
  const atlasSearchToggle = document.getElementById("atlas-search-toggle");
  if (atlasSearchToggle) atlasSearchToggle.addEventListener("click", () => openAtlasSearch());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.dataset.atlasSearch === "open") {
      const inp = document.getElementById("search-input");
      if (document.activeElement === inp) {
        e.preventDefault();
        closeAtlasSearch();
      }
    }
  });
  wireMetricsTab();
  wireTabs();
  Tabs.init();
  Find.init();
  wireAppsGrid();
  initNavHistory();
  wireAtlasOfflinePanel();

  setStatus("composing graph…");
  // Track whether the initial /graph fetch actually worked. We can't
  // use `srwk.graph` truthiness as the discriminator because the catch
  // block below sets it to an empty placeholder so downstream callers
  // (buildSim, Atlas.notifyDataChanged, ...) don't NPE on undefined.
  // Conflating "placeholder due to error" with "real empty response"
  // was the bug behind the "INDREX EMPTY · no pages yet" card showing
  // up when the actual state was "swf-node unreachable".
  let daemonReachableAtBoot = false;
  try {
    await loadGraph();
    daemonReachableAtBoot = true;
  } catch (e) {
    // swf-node not running, network problem, etc. Don't kill the UI —
    // surface the state and continue. startConnectionProbe + the SSE
    // subscriber will retry; tabs that don't need the graph keep
    // working in the meantime.
    console.warn("[boot] loadGraph failed; continuing without graph data:", e?.message || e);
    setStatus("offline · swf-node unreachable", true);
    setConnectionState({ state: "disconnected", serverUrl: srwk.serverUrl });
    // Provide enough state for downstream wiring not to NPE.
    srwk.graph = { nodes: [], edges: [], clusters: [], peers: [] };
    srwk.nodes = [];
    srwk.edges = [];
    srwk.clusters = [];
    showAtlasOffline();
  }
  // Clear the "composing graph…" only on success; if the catch fired
  // above, that status message is the one we want to keep visible.
  if (daemonReachableAtBoot && srwk.nodes && srwk.nodes.length > 0) {
    setStatus("");
    hideAtlasOffline();
    hideAtlasEmpty();
  } else if (daemonReachableAtBoot && srwk.graph && (!srwk.nodes || srwk.nodes.length === 0)) {
    // Daemon reachable (we got a real /graph response) but the indrex
    // has zero indexed pages. Fresh-install case. Show a friendly empty
    // panel instead of leaving the black 3D scene + "composing graph…"
    // status stuck. Panel auto-clears once a single node lands via the
    // reconcile poll. Critically gated on `daemonReachableAtBoot` so
    // an offline boot does NOT trip this branch.
    setStatus("");
    hideAtlasOffline();
    showAtlasEmpty();
  }
  // else: catch fired (offline); offline panel stays shown, empty stays hidden.
  try { buildSim(); } catch (e) { console.warn("[boot] buildSim failed:", e); }
  try { subscribeEvents(); } catch (e) { console.warn("[boot] subscribeEvents failed:", e); }
  wirePeersPanel();
  wireEventsPanel();
  wireTrafficPanel();
  wireTicketsPanel();
  wireReceiptsPanel();
  wireRouterPanel();
  // The legacy wireTicketsPanel/wireReceiptsPanel/wireRouterPanel calls
  // above seed their bodies with spec-v0.3 empty-state copy ("no epoch
  // yet" etc.). Immediately overwrite those with the unified Network-tab
  // copy so the first paint reads as Phase-2 sync, not abandoned spec
  // v0.3. The body IDs are intentionally retained; only the content is
  // repurposed (see comments in index.html and renderNetRouterStatus).
  try { renderNetRouterStatus(); } catch {}
  try { renderNetSearchPanel(); } catch {}
  try { renderNetRecordsPanel(); } catch {}
  wireAnonBadge();
  wireTimeline();
  wireLiveGraph();
  wireSearch();
  wireSourceFilter();
  startGraphReconcile();
  startConnectionProbe();

  // idle drift — only if buildSim succeeded and srwk.G exists.
  const mark = () => { srwk.lastUserT = performance.now(); };
  try {
    const ctrls = srwk.G?.controls?.();
    if (ctrls?.addEventListener) {
      ctrls.addEventListener("start", mark);
      ctrls.addEventListener("change", mark);
    }
  } catch {}
  const graphEl = document.getElementById("graph");
  if (graphEl) graphEl.addEventListener("wheel", mark, { passive: true });

  // animation loop
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    advanceShapeTransition(dt);
    ambientCameraDrift(dt);
    if (srwk.G) {
      // _fadeLabels is the search-aware wrapper installed at module
      // scope; fall back to the plain fadeLabelsByDistance if for any
      // reason the wrapper isn't yet defined (e.g. early boot).
      const fade = srwk._fadeLabels || fadeLabelsByDistance;
      fade(srwk.G.camera(), srwk.labelMap);
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

async function loadGraph() {
  const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
  if (!r.ok) throw new Error(`graph fetch failed: ${r.status}`);
  srwk.graph = await r.json();
  srwk.nodes = srwk.graph.nodes;
  srwk.edges = srwk.graph.edges;
  srwk.clusters = srwk.graph.clusters || [];
  for (const n of srwk.nodes) srwk.nodeMap.set(n.id, n);
  for (const p of srwk.graph.peers || []) srwk.peers.set(p.pubkey, p);
  // mark-count is a compound string; not amenable to animated-counter.
  document.getElementById("mark-count").textContent =
    `${srwk.nodes.length}n · ${srwk.edges.length}e`;
  tick("node-count", srwk.nodes.length);
  tick("edge-count", srwk.edges.length);
  tick("peer-count", srwk.peers.size);
  pushConnPeers();
  applyAllDimensions(srwk.nodes, srwk.lens);
  if (typeof renderPeersPanel === "function") renderPeersPanel();
}

function buildSim() {
  const container = document.getElementById("graph");
  const G = ForceGraph3D({ controlType: "orbit" })(container)
    .backgroundColor("rgba(10,6,18,1)")
    .showNavInfo(false)
    .nodeId("id")
    .nodeThreeObject((n) => buildNodeObject(srwk.nodeMap.get(n.id) || n))
    .nodeThreeObjectExtend(false)
    .linkSource("source").linkTarget("target")
    .linkColor((l) => _linkColor(l))
    .linkOpacity(0.45)
    .linkWidth((l) => _linkWidth(l))
    .linkCurvature(0.18)                  // gentle bezier — organic, not wire
    .linkCurveRotation(() => Math.random() * Math.PI * 2)
    .linkDirectionalParticles((l) => _linkParticles(l))
    .linkDirectionalParticleSpeed((l) => Math.min(0.012, 0.003 + (l.weight || 1) * 0.0015))
    .linkDirectionalParticleWidth((l) => _linkParticleWidth(l))
    .linkDirectionalParticleColor((l) => _linkParticleColor(l))
    .enableNodeDrag(false)
    .nodeLabel((n) => `<div class="node-tooltip">
        <div class="t-title">${escHtml((n.title || n.id).slice(0, 80))}</div>
        <div class="t-host">${escHtml(n.host || "")}</div>
      </div>`)
    .onNodeClick((n) => onNodeClick(n))
    .d3AlphaDecay(DAMP.alphaDecay)
    .d3VelocityDecay(DAMP.velocityDecay)
    .cooldownTicks(DAMP.cooldownTicks || 600)
    .graphData({ nodes: srwk.nodes, links: srwk.edges });

  applyForcesForLens(G, srwk.lens);
  srwk.G = G;
  srwk.scene = G.scene();

  // ACES filmic tone mapping is the canonical recipe for HDR + bloom
  // scenes. Without it, additive sprite stacks clamp to white in the
  // sRGB OutputPass. With it, values >1 compress gracefully toward white
  // instead of saturating.
  const renderer = G.renderer();
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;

  // Bloom amplifies bright pixels; we let it do the glowing rather than
  // multiplying per-sprite intensity. Strength + radius produce the diffuse
  // bleed; threshold lets only halo cores through.
  // strength 0.18 + threshold 0.82 — bloom is barely perceptible, just
  // a faint sheen on the brightest cores. Glow accumulation in dense
  // territories was visually obliterating the underlying structure.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(container.clientWidth, container.clientHeight),
    0.18, 0.75, 0.82,
  );
  G.postProcessingComposer().addPass(bloom);

  // Volumetric fog — distant nodes recede into haze, gives 3D depth cue
  srwk.scene.fog = new THREE.FogExp2(0x05031a, 0.00038);

  // Ambient dust-mote field. ~3000 particles in a large volume, slow drift.
  // Independent of the data graph — pure atmosphere, sets the "deep space"
  // feel and makes the camera drift legible.
  buildAtmosphere(srwk.scene);

  G.width(container.clientWidth).height(container.clientHeight);
  bloom.setSize(container.clientWidth, container.clientHeight);

  let _densityTick = 0;
  G.onEngineTick(() => {
    // Density is expensive (O(n²)); only refresh every 4th tick.
    _densityTick = (_densityTick + 1) % 4;
    if (_densityTick === 0) updateLocalDensity();
    updateGroupCentroids();
    syncLabels({
      scene: srwk.scene,
      clusterDefs: srwk.clusters,
      labelMap: srwk.labelMap,
      groupCentroids: srwk.groupCentroids,
    });
  });

  // The new shell-radial layout spans ~3600 units across; fit camera once
  // the sim has had time to settle into its territories.
  setTimeout(() => {
    if (srwk.G && typeof srwk.G.zoomToFit === "function") {
      srwk.G.zoomToFit(1600, 80);
    }
  }, 1500);
  setTimeout(() => {
    if (srwk.G && typeof srwk.G.zoomToFit === "function") {
      srwk.G.zoomToFit(1800, 100);
    }
  }, 4500);
}

// ─── edge styling helpers ────────────────────────────────────────────────
// A "bridging" edge is one whose source and target have different
// primary_contributor. Those are the visible threads of cross-peer
// shared knowledge — render brighter, wider, more particles.

function _bridging(l) {
  const s = typeof l.source === "object" ? l.source : srwk.nodeMap.get(l.source);
  const t = typeof l.target === "object" ? l.target : srwk.nodeMap.get(l.target);
  if (!s || !t) return false;
  return s.primary_contributor && t.primary_contributor &&
         s.primary_contributor !== t.primary_contributor;
}
function _linkColor(l) {
  if (_bridging(l)) return "rgba(255, 240, 220, 0.85)";  // warm white for bridges
  return "rgba(180, 200, 255, 0.28)";
}
function _linkWidth(l) {
  const w = l.weight || 1;
  return _bridging(l) ? 1.6 + Math.min(2.4, w * 0.4)
                      : 0.6 + Math.min(1.2, w * 0.2);
}
function _linkParticles(l) {
  const w = l.weight || 1;
  if (_bridging(l)) return Math.min(5, 2 + Math.floor(w / 2));
  return w >= 2 ? 2 : 1;
}
function _linkParticleWidth(l) {
  return _bridging(l) ? 2.4 : 1.2;
}
function _linkParticleColor(l) {
  if (_bridging(l)) return "#FFFFFF";
  return "rgba(180, 220, 255, 0.85)";
}

function applyForcesForLens(G, lens) {
  // Tuned charge: modest, with distanceMax so charge doesn't push every
  // node away from every other node across the whole volume. This lets
  // peer territories actually settle near their anchors instead of all
  // three pushing each other into corners.
  G.d3Force("link")
    .distance((e) => 35 + (1 / Math.sqrt(Math.max(1, e.weight || 1))) * 22)
    .strength((e) => Math.min(0.7, 0.25 + (e.weight || 1) * 0.1));
  const charge = G.d3Force("charge");
  // Mid-range charge (-110) + capped distance so it provides local
  // separation but doesn't fight macro/micro pulls at long range.
  charge.strength((n) => -110 - Math.sqrt(n.degree || 0) * 6);
  if (typeof charge.distanceMax === "function") charge.distanceMax(140);
  if (typeof charge.distanceMax === "function") charge.distanceMax(800);
  if (typeof charge.theta === "function")       charge.theta(0.9);

  // Collide: octree-based hard floor preventing nodes from occupying
  // the same coordinate. This is what stops "all-150-in-bucket stack
  // at the anchor point" — radial pull wants stack, collide forbids it.
  let collide = G.d3Force("collide");
  if (!collide) {
    // 3d-force-graph delegates to d3-force-3d which exposes forceCollide
    // via the forceCollide import. Construct it lazily here.
    collide = _forceCollide3d((n) => Math.max(8, ((n._dims?.size) || 30) * 0.5));
    G.d3Force("collide", collide);
  }
  if (typeof collide.radius === "function") {
    // Larger collide radius forces nodes to spread out more — this is
    // what makes a territory READ as a constellation rather than a tight
    // blob. Each node "owns" a region of size×0.85.
    collide.radius((n) => Math.max(8, ((n._dims?.size) || 18) * 0.75))
           .strength?.(0.95)
           .iterations?.(2);
  }

  // Macro pull — soft point-attraction (gravity well per peer territory).
  // forceCollide stops nodes from stacking at the same coordinate, so
  // we don't need shell-radial. Net effect: each peer's nodes form a
  // solid blob around its vertex with internal sub-cluster structure
  // from the link force.
  computeHierarchicalAnchors(srwk.nodes, lens);
  // kMacro = 0.04 — strong enough that 3 peer territories stay visibly
  // separate (otherwise charge dominates and the whole graph merges into
  // one nebula). Supernova at high macro pull is prevented by forceCollide
  // + density-aware halo fade in the renderer, so we can afford the bump.
  const kMacro = 0.04;
  // macroPull = soft tug toward the peer's territory; microPull =
  // stronger tug toward each sub-cluster's anchor so sub-clusters
  // form visible pockets inside the territory rather than blending.
  G.d3Force("macroPull", (alpha) => {
    const k = kMacro * alpha * 1.5;
    for (const n of srwk.nodes) {
      if (n._macroX == null) continue;
      n.vx = (n.vx || 0) + (n._macroX - n.x) * k;
      n.vy = (n.vy || 0) + (n._macroY - n.y) * k;
      n.vz = (n.vz || 0) + (n._macroZ - n.z) * k;
    }
  });
  // microPull is 8× macroPull and grows quadratically with distance from
  // the sub-cluster anchor — so a node that drifts twice as far gets
  // pulled back four times as hard. This is what actually makes
  // sub-clusters cluster instead of just biasing position.
  G.d3Force("microPull", (alpha) => {
    const k = kMacro * alpha * 8.0;
    for (const n of srwk.nodes) {
      if (n._microX == null) continue;
      const dx = n._microX - n.x, dy = n._microY - n.y, dz = n._microZ - n.z;
      const d = Math.sqrt(dx*dx + dy*dy + dz*dz) || 1;
      const pull = Math.min(1.0, d / 80);  // ramps up over 80 units
      n.vx = (n.vx || 0) + dx * k * pull;
      n.vy = (n.vy || 0) + dy * k * pull;
      n.vz = (n.vz || 0) + dz * k * pull;
    }
  });
  // Note: micro radial pull is intentionally REMOVED. Sub-clustering by
  // host/topic emerges from edge structure + charge + collide, not from
  // a second point-spring. If the data has same-host nodes that aren't
  // edge-linked, they'll still cluster locally via charge interactions
  // within their peer's shell.
}

// Tiny inline forceCollide for 3D — d3-force ships only 2D forceCollide
// and I don't want to pull in d3-force-3d as a separate import. This is
// a simplified Barnes-Hut-free O(N²) version. For 500 nodes that's fine
// (~250k pairs/tick at low alpha).
function _forceCollide3d(radiusFn) {
  let nodes = [];
  let radius = radiusFn || (() => 10);
  let strength = 0.9;
  let iterations = 2;
  function force(alpha) {
    const n = nodes.length;
    for (let iter = 0; iter < iterations; iter++) {
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const ra = radius(a);
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          const rb = radius(b);
          const minD = ra + rb;
          let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
          let d2 = dx*dx + dy*dy + dz*dz;
          if (d2 >= minD * minD || d2 === 0) continue;
          const d = Math.sqrt(d2) || 0.001;
          const overlap = (minD - d) * strength * alpha * 0.5;
          dx = (dx / d) * overlap;
          dy = (dy / d) * overlap;
          dz = (dz / d) * overlap;
          a.vx = (a.vx || 0) - dx; a.vy = (a.vy || 0) - dy; a.vz = (a.vz || 0) - dz;
          b.vx = (b.vx || 0) + dx; b.vy = (b.vy || 0) + dy; b.vz = (b.vz || 0) + dz;
        }
      }
    }
  }
  force.initialize = (ns) => { nodes = ns; };
  force.radius = (fn) => { if (fn === undefined) return radius; radius = typeof fn === "function" ? fn : (() => fn); return force; };
  force.strength = (s) => { if (s === undefined) return strength; strength = s; return force; };
  force.iterations = (i) => { if (i === undefined) return iterations; iterations = i; return force; };
  return force;
}

// Polyhedron vertices: tetrahedron for ≤4 macro groups, octahedron for ≤6,
// cube for ≤8, dodecahedron for ≤12, icosahedron for ≤20. For >20 we fall
// back to a Fibonacci sphere (still better than nothing). Vertices are
// returned at unit radius; caller scales.
function _polyhedronVertices(n) {
  if (n <= 4) {
    // tetrahedron
    return [
      [ 1,  1,  1], [ 1, -1, -1], [-1,  1, -1], [-1, -1,  1],
    ].slice(0, Math.max(2, n)).map(v => {
      const r = Math.hypot(v[0], v[1], v[2]);
      return [v[0]/r, v[1]/r, v[2]/r];
    });
  }
  if (n <= 6) {
    return [
      [1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1],
    ].slice(0, n);
  }
  if (n <= 8) {
    const s = 1/Math.sqrt(3);
    return [
      [s,s,s], [s,s,-s], [s,-s,s], [s,-s,-s],
      [-s,s,s], [-s,s,-s], [-s,-s,s], [-s,-s,-s],
    ].slice(0, n);
  }
  // 9..20: dodecahedron vertices (20 of them)
  if (n <= 20) {
    const phi = (1 + Math.sqrt(5)) / 2;
    const a = 1, b = 1/phi, c = phi;
    const verts = [
      [a,a,a],[a,a,-a],[a,-a,a],[a,-a,-a],
      [-a,a,a],[-a,a,-a],[-a,-a,a],[-a,-a,-a],
      [0,b,c],[0,b,-c],[0,-b,c],[0,-b,-c],
      [b,c,0],[b,-c,0],[-b,c,0],[-b,-c,0],
      [c,0,b],[c,0,-b],[-c,0,b],[-c,0,-b],
    ];
    return verts.slice(0, n).map(v => {
      const r = Math.hypot(v[0], v[1], v[2]);
      return [v[0]/r, v[1]/r, v[2]/r];
    });
  }
  // >20: Fibonacci sphere fallback
  const out = [];
  const phi2 = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / Math.max(1, n - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const t = phi2 * i;
    out.push([Math.cos(t) * r, y, Math.sin(t) * r]);
  }
  return out;
}

// Pick a micro grouping that won't collapse to "1 group per peer".
// If the lens groups by primary_contributor (same as macro), fall back
// to topic→host so sub-clusters actually exist visually within each
// peer territory.
function _microKeyFor(lens, n) {
  const k = lens.groupBy ? lens.groupBy(n) : null;
  if (lens.id !== "contributor") return k || "(none)";
  return n.topic || n.host || "(none)";
}

function computeHierarchicalAnchors(nodes, lens) {
  // 1) Group by macro = primary_contributor.
  const macroBuckets = new Map();
  for (const n of nodes) {
    const m = n.primary_contributor || "(orphan)";
    if (!macroBuckets.has(m)) macroBuckets.set(m, []);
    macroBuckets.get(m).push(n);
  }
  const macroKeys = [...macroBuckets.keys()];
  const Mn = Math.max(1, macroKeys.length);

  // Macro anchors at polyhedron vertices, scaled into a real volume
  // (not a thin shell). Spacing scales with √N — tighter for few peers,
  // wider for many.
  const macroR = 620 + Math.sqrt(Mn) * 100;
  const verts = _polyhedronVertices(Mn);
  const macroAnchor = new Map();
  macroKeys.forEach((mk, i) => {
    const v = verts[i] || [0, 0, 0];
    macroAnchor.set(mk, { x: v[0] * macroR, y: v[1] * macroR, z: v[2] * macroR });
  });

  // 2) Within each macro bucket, group by micro = lens.groupBy.
  // Place micro anchors on a local sphere around the macro anchor.
  // Sphere radius scales with √N per peer so big peers (e.g. 400 nodes)
  // get a proportionally larger territory and don't pack-saturate the
  // bloom. Without this, alice's 400 nodes pile into the same volume as
  // bob's 30 and the cumulative bloom blows out to white.
  for (const [mk, ns] of macroBuckets) {
    const anchor = macroAnchor.get(mk);
    const microR = Math.max(macroR * 0.32, 70 + Math.sqrt(ns.length) * 22);
    const microGroups = new Map();
    for (const n of ns) {
      const k = _microKeyFor(lens, n);
      n._microKey = k;
      if (!microGroups.has(k)) microGroups.set(k, []);
      microGroups.get(k).push(n);
    }
    const microKeys = [...microGroups.keys()];
    const Mi = Math.max(1, microKeys.length);
    const phi = Math.PI * (3 - Math.sqrt(5));
    microKeys.forEach((mik, i) => {
      const y = Mi === 1 ? 0 : (1 - (i / (Mi - 1)) * 2);
      const r = Math.sqrt(1 - y * y);
      const theta = phi * i;
      // Vary radial depth per micro-group so anchors fill the volume
      // (cube-root distribution = uniform fill of the ball). Without
      // this, all anchors sit on the shell and big peers bloom-flood
      // their hollow center.
      const depth = Mi === 1 ? 0 : Math.cbrt(0.15 + 0.85 * (i / (Mi - 1)));
      const rr = microR * depth;
      const mx = anchor.x + Math.cos(theta) * r * rr;
      const my = anchor.y + y * rr;
      const mz = anchor.z + Math.sin(theta) * r * rr;
      for (const n of microGroups.get(mik)) {
        n._macroX = anchor.x; n._macroY = anchor.y; n._macroZ = anchor.z;
        n._microX = mx;       n._microY = my;       n._microZ = mz;
      }
    });
  }
}

// Cache of CanvasTextures keyed by sorted "color1,color2,..." string.
// Multi-contributor sprites get a procedurally-painted radial gradient
// where each contributor occupies an equal angular slice. Single-contributor
// nodes still use the global solid spriteTex.
const _gradientTexCache = new Map();
function getGradientTex(colors) {
  // colors: array of "#RRGGBB" strings, sorted for cache stability
  const key = colors.join(",");
  if (_gradientTexCache.has(key)) return _gradientTexCache.get(key);
  const SIZE = 256;
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  ctx.clearRect(0, 0, SIZE, SIZE);
  // n equal angular wedges, each tinted by one contributor's color, with
  // a soft radial falloff. Wedges blend at the center via additive blending
  // when the sprite is rendered.
  const cx = SIZE / 2, cy = SIZE / 2;
  const r = SIZE / 2;
  const n = colors.length;
  const sweep = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + i * sweep;
    const a1 = a0 + sweep;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0,    `${colors[i]}EE`);
    grad.addColorStop(0.10, `${colors[i]}88`);
    grad.addColorStop(0.20, `${colors[i]}22`);
    grad.addColorStop(0.30, `${colors[i]}00`);
    grad.addColorStop(1,    `${colors[i]}00`);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  _gradientTexCache.set(key, tex);
  return tex;
}

// Stable hash → small float in [-0.5, 0.5]. Used to derive a per-cluster
// hue offset within a peer's color, so sub-clusters share a family but
// look distinct up close.
function _hashUnit(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return ((h % 10000) / 10000) - 0.5;
}

function buildNodeObject(n) {
  const d = n._dims || applyDimensions(n, srwk.lens);
  const baseColor = new THREE.Color(d.color || "#888");
  // Per-cluster hue offset: ±0.045 (≈ ±16°) and ±5% lightness around the
  // peer's signature color. Same peer reads as one color from far away;
  // sub-clusters separate visually as you zoom in.
  const microKey = n._microKey || "";
  const macroKey = n.primary_contributor || "";
  const seed = `${macroKey}::${microKey}`;
  // ±0.10 hue (≈ ±36°), ±0.18 lightness, ±0.20 saturation: each
  // sub-cluster within a peer reads as a distinct shade — coral vs
  // rose vs salmon under the "pink" umbrella, not a single uniform pink.
  const hueDelta   = _hashUnit(seed) * 0.20;
  const lightDelta = _hashUnit(seed + "L") * 0.36;
  const satDelta   = _hashUnit(seed + "S") * 0.40;
  const hsl = { h: 0, s: 0, l: 0 };
  baseColor.getHSL(hsl);
  baseColor.setHSL(
    (hsl.h + hueDelta + 1) % 1,
    Math.max(0.30, Math.min(1.0, hsl.s + satDelta)),
    Math.max(0.30, Math.min(0.85, hsl.l + lightDelta)),
  );
  const baseSize = d.size || 30;

  // Resolve every contributor's signature_color so we can paint the
  // sprite multi-tone if the page has more than one contributor.
  const contribColors = (n.contributors || [])
    .map((pk) => srwk.peers.get(pk)?.signature_color || stableHue(pk))
    .filter(Boolean);
  const uniqueColors = [...new Set(contribColors)].sort();
  const isMulti = uniqueColors.length >= 2;

  // Core texture: solid for single-contributor, multi-slice for shared.
  const coreTex = isMulti ? getGradientTex(uniqueColors) : srwk.spriteTex;
  // When gradient texture is used, the material color is white (the
  // gradient brings its own color); otherwise we tint by baseColor.
  const coreMatColor = isMulti ? new THREE.Color("#FFFFFF") : baseColor.clone();

  // Core uses NormalBlending — does NOT accumulate when sprites overlap.
  // 100 stacked cores still equal one core. This is what kills the
  // "white sun" pathology. Halos stay additive for the bioluminescent
  // glow effect; only the inner core is non-accumulating.
  const coreMat = new THREE.SpriteMaterial({
    map: coreTex, color: coreMatColor,
    transparent: true, depthWrite: false,
    blending: THREE.NormalBlending, fog: false,
  });
  const haloMat = new THREE.SpriteMaterial({
    map: srwk.haloTex, color: baseColor.clone(),
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });
  // Third "atmospheric" halo: very large, very dim, gives every node a
  // diffuse field around it. Bioluminescent jellyfish vibe.
  const atmosMat = new THREE.SpriteMaterial({
    map: srwk.haloTex, color: baseColor.clone(),
    transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  });

  const sizeMultiplier = isMulti ? 1.15 + 0.06 * (uniqueColors.length - 2) : 1.0;
  const coreSize = baseSize * sizeMultiplier;
  const haloSize = baseSize * 3.6 * sizeMultiplier;
  const atmosSize = baseSize * 2.8 * sizeMultiplier;

  const core = new THREE.Sprite(coreMat); core.scale.set(coreSize, coreSize, 1);
  const halo = new THREE.Sprite(haloMat); halo.scale.set(haloSize, haloSize, 1);
  const atmos = new THREE.Sprite(atmosMat); atmos.scale.set(atmosSize, atmosSize, 1);

  const group = new THREE.Group();
  group.add(atmos);
  group.add(halo);
  group.add(core);
  // Per-node breathing period randomized 3-7s (sets ω = 2π/period).
  // Desynced breathing reads as a coral reef; synced reads as a screensaver.
  // Slight skew: more popular nodes breathe a bit faster.
  const period = 3.5 + Math.random() * 3.5;
  const degBoost = Math.min(1.4, 1.0 - Math.sqrt(n.degree || 0) * 0.05);
  const breathOmega = (2 * Math.PI / period) * (1 / Math.max(0.7, degBoost));
  group.userData = {
    n, baseColor, baseSize: coreSize,
    coreMat, haloMat, atmosMat, core, halo, atmos,
    isMulti,
    contribCount: uniqueColors.length,
    phase: Math.random() * Math.PI * 2,
    breathOmega,
  };
  group.onBeforeRender = () => updateNodeRender(group);

  n.__obj = group;
  return group;
}

function updateNodeRender(group) {
  const ud = group.userData;
  const t = (performance.now() - srwk.startTime) / 1000;
  // Per-node ω from period (3-7s); halos breathe slower for organic feel.
  const w = ud.breathOmega || 1.0;
  const breath = 0.84 + 0.16 * Math.sin(t * w + ud.phase);
  const haloBreath = 0.80 + 0.20 * Math.sin(t * w * 0.6 + ud.phase * 0.7);
  const atmosBreath = 0.74 + 0.26 * Math.sin(t * w * 0.35 + ud.phase * 1.3);
  const dims = ud.n._dims || {};
  const glow = (dims.glow || 0);
  // Aggressive density fade. With 30+ neighbors within 90 units, halo
  // drops to ~9% of its lonely value so densest pixels don't accumulate
  // to bloom-threshold-saturation.
  const density = (ud.n._density || 0);
  // Glow is now a faint accent, not the dominant visual. Cores carry
  // the structure; halos just add a touch of warmth at low density and
  // disappear entirely at high density.
  const densityFade = 1.0 / (1.0 + 1.2 * density);
  const haloKill    = density > 6 ? 0 : 1;
  const atmosKill   = density > 3 ? 0 : 1;
  const coreDensityFade = 1.0 / (1.0 + 0.18 * density);
  let coreI  = Math.min(0.80, 0.45 + glow * 0.30) * coreDensityFade;
  let haloI  = Math.min(0.12, 0.06 + glow * 0.06) * densityFade * haloKill;
  let atmosI = Math.min(0.025, 0.012 + glow * 0.012) * densityFade * densityFade * atmosKill;

  // Activity pulse: nodes that arrived in the last 60s get a subtle
  // halo intensity boost decaying with τ=30s, so they read as "freshly
  // ingested" without shouting. Stops contributing entirely past 60s.
  const ingestedAt = ud.n._recentlyIngestedAt;
  if (ingestedAt) {
    const ageMs = Date.now() - ingestedAt;
    if (ageMs < 60000) {
      const boost = 1 + 0.4 * Math.exp(-ageMs / 30000);
      haloI  *= boost;
      atmosI *= boost;
    }
  }

  // Search treatment: sprite-level opacity. We never rebuild the graph,
  // so the sim and breathing keep running undisturbed.
  const search = srwk.search;
  let coreScaleMul = 1.0;
  let haloScaleMul = 1.0;
  let atmosScaleMul = 1.0;
  let coreOpacity = 1.0, haloOpacity = 1.0, atmosOpacity = 1.0;
  if (search && search.active) {
    const matches = search.matchSet;
    const isMatch = matches && matches.has(ud.n.id);
    if (!isMatch) {
      coreOpacity = 0.15;
      haloOpacity = 0;
      atmosOpacity = 0;
    } else {
      // Match boost: scale halo up so the white outline halo reads as a
      // ring around the core. We apply via the existing halo sprite,
      // not a new layer, to keep memory flat.
      haloScaleMul = 1.55;
      haloI = Math.max(haloI, 0.32);
    }
  }

  // Peer-territory pulse: triggered by clicks in the peers panel. Lerps
  // a 1.5× halo scale boost in/out over ~2s using the existing breath
  // machinery so it doesn't fight per-node breathing.
  const pulse = srwk.peerPulse;
  if (pulse && pulse.contributor && ud.n.primary_contributor === pulse.contributor) {
    const elapsed = (performance.now() - pulse.start) / pulse.duration;
    if (elapsed < 1) {
      // 0..0.25 ramp up, 0.25..0.6 hold, 0.6..1 lerp out
      let amt;
      if (elapsed < 0.25) amt = elapsed / 0.25;
      else if (elapsed < 0.6) amt = 1;
      else amt = Math.max(0, 1 - (elapsed - 0.6) / 0.4);
      haloScaleMul *= 1 + 0.5 * amt;
      atmosScaleMul *= 1 + 0.5 * amt;
      haloI = Math.max(haloI, 0.20 * amt);
    }
  }

  ud.core.scale.set(ud.baseSize * breath * coreScaleMul, ud.baseSize * breath * coreScaleMul, 1);
  ud.halo.scale.set(ud.baseSize * 1.8 * haloBreath * haloScaleMul, ud.baseSize * 1.8 * haloBreath * haloScaleMul, 1);
  ud.atmos.scale.set(ud.baseSize * 1.4 * atmosBreath * atmosScaleMul, ud.baseSize * 1.4 * atmosBreath * atmosScaleMul, 1);

  ud.coreMat.opacity = coreOpacity;
  ud.haloMat.opacity = haloOpacity;
  ud.atmosMat.opacity = atmosOpacity;

  if (ud.isMulti) {
    const v = Math.min(1.0, 0.55 + 0.18 * coreI);
    ud.coreMat.color.setRGB(v, v, v);
  } else {
    ud.coreMat.color.setRGB(ud.baseColor.r * coreI, ud.baseColor.g * coreI, ud.baseColor.b * coreI);
  }
  ud.haloMat.color.setRGB(ud.baseColor.r * haloI, ud.baseColor.g * haloI, ud.baseColor.b * haloI);
  ud.atmosMat.color.setRGB(ud.baseColor.r * atmosI, ud.baseColor.g * atmosI, ud.baseColor.b * atmosI);
}

// Density map: per-node count of neighbors within DENSITY_RADIUS.
// Recomputed each engine tick, used by updateNodeRender to fade halos
// in dense regions so they don't sum to white.
const DENSITY_RADIUS = 90;
const DENSITY_RADIUS_SQ = DENSITY_RADIUS * DENSITY_RADIUS;
function updateLocalDensity() {
  const ns = srwk.nodes;
  for (const n of ns) n._density = 0;
  // O(n²) is fine for ~500 nodes (< 250k pairs/tick).
  for (let i = 0; i < ns.length; i++) {
    const a = ns[i];
    if (a.x == null) continue;
    for (let j = i + 1; j < ns.length; j++) {
      const b = ns[j];
      if (b.x == null) continue;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      const d2 = dx*dx + dy*dy + dz*dz;
      if (d2 < DENSITY_RADIUS_SQ) {
        a._density++; b._density++;
      }
    }
  }
}

function updateGroupCentroids() {
  const counts = new Map();
  const sums = new Map();
  for (const n of srwk.nodes) {
    if (n.x == null) continue;
    const k = srwk.lens.groupBy(n);
    if (!sums.has(k)) { sums.set(k, { x: 0, y: 0, z: 0 }); counts.set(k, 0); }
    const s = sums.get(k);
    s.x += n.x; s.y += n.y; s.z += n.z;
    counts.set(k, counts.get(k) + 1);
  }
  srwk.groupCentroids.clear();
  for (const [k, s] of sums) {
    const c = counts.get(k);
    srwk.groupCentroids.set(k, { x: s.x / c, y: s.y / c, z: s.z / c });
  }
}

// ─── lens / shape switching ───────────────────────────────────────────────

async function switchLens(newLens) {
  if (!newLens || newLens === srwk.lens) return;
  srwk.lens = newLens;
  setStatus("re-grouping…");
  try {
    // re-fetch so server-side recomputes any per-lens fields and we get
    // any pages that arrived since the last snapshot
    const r = await fetch(`${srwk.serverUrl}/graph?lens=${newLens.id}`);
    if (r.ok) {
      const fresh = await r.json();
      mergeFreshGraph(fresh);
    }
  } catch (e) {
    console.warn("[lens] graph refetch failed:", e);
  }
  applyAllDimensions(srwk.nodes, srwk.lens);
  for (const n of srwk.nodes) {
    if (!n.__obj) continue;
    const d = n._dims;
    const ud = n.__obj.userData;
    if (d.color)  ud.baseColor = new THREE.Color(d.color);
    if (d.accent) ud.accent    = new THREE.Color(d.accent);
    if (d.size)   ud.baseSize  = d.size;
  }
  applyForcesForLens(srwk.G, srwk.lens);
  // unpin anything pinned by a previous shape transition
  for (const n of srwk.nodes) { n.fx = n.fy = n.fz = undefined; }
  if (srwk.G && typeof srwk.G.d3ReheatSimulation === "function") srwk.G.d3ReheatSimulation();
  setStatus("");
}

function mergeFreshGraph(fresh) {
  for (const p of fresh.peers || []) srwk.peers.set(p.pubkey, p);
  for (const n of fresh.nodes) {
    if (srwk.nodeMap.has(n.id)) continue;
    srwk.nodeMap.set(n.id, n);
    srwk.nodes.push(n);
  }
  srwk.edges = fresh.edges;
  srwk.clusters = fresh.clusters || [];
  if (srwk.G) {
    srwk.G.graphData({ nodes: srwk.nodes, links: srwk.edges });
  }
  tick("node-count", srwk.nodes.length);
  tick("edge-count", srwk.edges.length);
  document.getElementById("mark-count").textContent =
    `${srwk.nodes.length}n · ${srwk.edges.length}e`;
  tick("peer-count", srwk.peers.size);
  pushConnPeers();
  if (typeof renderPeersPanel === "function") renderPeersPanel();
  // The cartography tab bakes its own buffer geometry from srwk.nodes/edges;
  // give it a debounced poke so it reconciles without rebuilding every tick.
  try { Graph2.notifyDataChanged(); } catch {}
  try { Cosmos.notifyDataChanged(); } catch {}
  try { Atlas.notifyDataChanged(); } catch {}
}

function switchShape(newShape) {
  if (!newShape || newShape === srwk.shape) return;
  const oldId = srwk.shape.id;
  srwk.shape = newShape;
  if (newShape.id === "cluster") {
    // resume sim from current positions
    srwk.shapeTransition = null;
    if (typeof srwk.G.d3ReheatSimulation === "function") srwk.G.d3ReheatSimulation();
    return;
  }
  // pause sim by raising velocity decay temporarily (or just set alpha to 0)
  // and lerp positions to target layout
  const target = newShape.layout(srwk.nodes, srwk.lens, srwk.bounds);
  if (!target) return;
  const source = new Map();
  for (const n of srwk.nodes) source.set(n.id, { x: n.x || 0, y: n.y || 0, z: n.z || 0 });
  srwk.shapeTransition = { start: performance.now(), duration: 1800, source, target };
}

function advanceShapeTransition(dt) {
  if (!srwk.shapeTransition) return;
  const { start, duration, source, target } = srwk.shapeTransition;
  const t = (performance.now() - start) / duration;
  const e = easeOutQuart(Math.min(1, t));
  for (const n of srwk.nodes) {
    const a = source.get(n.id), b = target.get(n.id);
    if (!a || !b) continue;
    n.x = a.x + (b.x - a.x) * e;
    n.y = a.y + (b.y - a.y) * e;
    n.z = a.z + (b.z - a.z) * e;
    if (n.__obj) n.__obj.position.set(n.x, n.y, n.z);
    // pin in sim
    n.fx = n.x; n.fy = n.y; n.fz = n.z;
  }
  if (t >= 1) {
    // freeze positions; sim is paused for non-cluster shapes
    srwk.shapeTransition = null;
  }
}

// ─── camera drift ─────────────────────────────────────────────────────────

function ambientCameraDrift(dt) {
  if (performance.now() - srwk.lastUserT < 2200) return;
  const ctrls = srwk.G?.controls();
  if (!ctrls?.target) return;
  const t = (performance.now() - srwk.startTime) / 1000;
  // 4× amplitude vs the original — the camera should noticeably drift
  // around the volume, not just shimmy. Period unchanged so the motion
  // stays slow and meditative.
  const A = 24, B = 16, C = 20;
  // Bias the drift toward whichever territory had the most recent
  // contribution, so the camera eddies near "where the action is."
  const bias = srwk.recentTerritory || { x: 0, y: 0, z: 0 };
  const bx = bias.x * 0.15, by = bias.y * 0.15, bz = bias.z * 0.15;
  const tx = srwk.driftBase.x + bx + A * Math.sin(t * 0.07);
  const ty = srwk.driftBase.y + by + B * Math.sin(t * 0.05 + 1.1);
  const tz = srwk.driftBase.z + bz + C * Math.sin(t * 0.03 + 2.3);
  const k = Math.min(1, dt * 0.5);
  ctrls.target.x += (tx - ctrls.target.x) * k;
  ctrls.target.y += (ty - ctrls.target.y) * k;
  ctrls.target.z += (tz - ctrls.target.z) * k;
  ctrls.update?.();
}

// ─── SSE event subscription ───────────────────────────────────────────────

function subscribeEvents() {
  // EventSource auto-reconnects on its own; we just feed it `since=` so the
  // server replays any events emitted while we were disconnected.
  if (srwk.eventSource) try { srwk.eventSource.close(); } catch {}
  const url = `${srwk.serverUrl}/events?since=${srwk.lastEventId}`;
  const es = new EventSource(url);
  srwk.eventSource = es;

  const trackId = (ev) => {
    const id = parseInt(ev.lastEventId || "0", 10);
    if (Number.isFinite(id) && id > srwk.lastEventId) srwk.lastEventId = id;
  };

  es.addEventListener("contribution_merged", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    const peer = srwk.peers.get(data.contributor) || {
      pubkey: data.contributor, nickname: data.nickname,
      signature_color: data.signature_color || stableHue(data.contributor),
      signature_freq: 440,
    };
    srwk.peers.set(peer.pubkey, peer);
    srwk.liveSeen.set(peer.pubkey, performance.now());
    refreshLiveCount();
    // bias camera drift toward whichever territory just got fresh activity
    const sample = (data.pages || []).map(p => srwk.nodeMap.get(p.url)).find(n => n && n._macroX != null);
    if (sample) srwk.recentTerritory = { x: sample._macroX, y: sample._macroY, z: sample._macroZ };
    handleContributionMerged(data, peer);
    const ev2 = { kind: "contribution_merged", payload: data, ts: Date.now() };
    appendEvent(ev2);
    pushTimelineTick(ev2);
    try { livegraphPushFromEvent(ev2); } catch (e) { console.warn("[livegraph]", e); }
  });
  es.addEventListener("contribution_arrived", trackId);
  es.addEventListener("contribution_rejected", trackId);
  es.addEventListener("page_visited", (ev) => {
    trackId(ev);
    try {
      const data = JSON.parse(ev.data);
      appendEvent({ kind: "page_visited", payload: data, ts: Date.now() });
    } catch { /* page_visited may have minimal/empty payload */ }
  });
  es.addEventListener("peer_trust_changed", trackId);
  es.addEventListener("peer_joined", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    srwk.liveSeen.set(data.contributor, performance.now());
    refreshLiveCount();
    // Seed the peer map so the peers panel can show this peer immediately,
    // even before the next /graph snapshot rolls them in.
    if (!srwk.peers.has(data.contributor)) {
      srwk.peers.set(data.contributor, {
        pubkey: data.contributor,
        nickname: data.nickname || `peer-${(data.contributor || "").slice(0, 8)}`,
        signature_color: data.signature_color || stableHue(data.contributor),
        page_count: 0,
      });
      tick("peer-count", srwk.peers.size);
      pushConnPeers();
      if (typeof renderPeersPanel === "function") renderPeersPanel();
    }
    // attribution toast for the new peer
    const el = document.getElementById("incoming-toast");
    if (!el) return;
    const color = stableHue(data.contributor);
    el.querySelector(".t-dot").style.background = color;
    el.querySelector(".t-dot").style.boxShadow = `0 0 12px 2px ${color}`;
    el.querySelector(".t-body").innerHTML =
      `<strong>${escHtml(data.nickname || "anon")}</strong> joined the hive`;
    el.hidden = false;
    el.classList.remove("fade");
    setTimeout(() => el.classList.add("fade"), 4200);
    setTimeout(() => { el.hidden = true; el.classList.remove("fade"); }, 6500);
    appendEvent({ kind: "peer_joined", payload: data, ts: Date.now() });
  });

  es.addEventListener("peer_left", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    srwk.liveSeen.delete(data.contributor);
    refreshLiveCount();
    if (typeof renderPeersPanel === "function") renderPeersPanel();
  });
  es.addEventListener("peer_back", (ev) => {
    trackId(ev);
    const data = JSON.parse(ev.data);
    srwk.liveSeen.set(data.contributor, performance.now());
    refreshLiveCount();
    if (typeof renderPeersPanel === "function") renderPeersPanel();
  });

  // ─── traffic events (slice + mdns + zeroconf) ──────────────────────────
  // Server-side agent emits these as separate SSE event names. Each
  // handler is defensive: payload shapes may shift before the SPEC
  // settles, so we never assume any one field exists.
  const TRAFFIC_KINDS = [
    "slice_scraped", "slice_scrape_error", "slice_skipped_self",
    "slice_replay_dropped", "slice_size_rejected",
    "mdns_discovered", "mdns_evicted", "zeroconf_revived",
    // SPEC v0.3 LAN_FRIEND_DCNET event family — see DC-NET CONTRACT comment
    // below for payload shapes. Server emits nothing today; UI is dormant
    // until the protocol ships.
    "dcnet_round_started", "dcnet_round_complete",
    "ticket_issued", "ticket_redeemed",
    "receipt_submitted", "anonymity_set_changed", "epoch_rotated",
    "web_search_completed",
  ];
  for (const kind of TRAFFIC_KINDS) {
    es.addEventListener(kind, (ev) => {
      trackId(ev);
      let data = {};
      try { data = JSON.parse(ev.data || "{}"); } catch {}
      const evt = { kind, payload: data, ts: Date.now() };
      // Track liveness for any peer-bound event so the live counter and
      // timeline lanes light up immediately. `data.peer` may be a struct
      // (slice_scraped) so we go through pickPeerPubkey, which always
      // returns a string.
      const pubkey = pickPeerPubkey(data);
      if (pubkey) {
        srwk.liveSeen.set(pubkey, performance.now());
      }
      // Dispatch DC-net family events into the dedicated panels in
      // addition to the unified traffic feed. Each handler is a no-op
      // until at least one event of the corresponding kind arrives.
      try {
        if (kind === "anonymity_set_changed") onAnonymitySetChanged(data);
        else if (kind === "dcnet_round_started") onDcnetRoundStarted(data);
        else if (kind === "dcnet_round_complete") onDcnetRoundComplete(data);
        else if (kind === "ticket_issued") onTicketIssued(data);
        else if (kind === "ticket_redeemed") onTicketRedeemed(data);
        else if (kind === "receipt_submitted") onReceiptSubmitted(data);
        else if (kind === "epoch_rotated") onEpochRotated(data);
        else if (kind === "web_search_completed") onWebSearchCompleted(data);
      } catch (e) { console.warn("[dcnet handler]", kind, e); }
      appendTrafficEvent(evt);
      pushTimelineTick(evt);
      // Live propagation graph — receives the same event stream and
      // animates a pulse along the appropriate peer↔self edge. Fully
      // self-contained module; no-op when the canvas is hidden.
      try { livegraphPushFromEvent(evt); } catch (e) { console.warn("[livegraph]", e); }
      // First traffic event after boot reveals the timeline so users
      // see the wire activity without hunting for the ◢ toggle.
      maybeAutoShowTimeline();
    });
  }

  es.onerror = () => {
    setStatus("event stream reconnecting…", true);
    setConnectionState({ state: "reconnecting", detail: "SSE error — retrying…" });
    setTimeout(() => {
      if (es.readyState === EventSource.CLOSED) subscribeEvents();
    }, 1500);
  };
  es.onopen = async () => {
    setStatus("");
    setConnectionState({ state: "connected", detail: "" });
    if (!srwk._connectedToastShown) {
      srwk._connectedToastShown = true;
    } else {
      toast({ kind: "success", title: "reconnected", message: "event stream is live again" });
    }
    // Self-heal: refetch the graph so any nodes we missed during the
    // disconnect (e.g. server restart) reappear. Cheap; only runs on (re)open.
    try {
      const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
      if (r.ok) mergeFreshGraph(await r.json());
    } catch (e) { /* swallow; next event will trigger another try */ }
  };
  // Note any incoming SSE message as a connection liveness signal. Wrapped
  // in a generic listener so all event kinds bump the timestamp.
  es.addEventListener("message", () => noteConnectionEvent());
  for (const k of ["contribution_merged", "peer_joined", "peer_left", "peer_back", "page_visited"]) {
    es.addEventListener(k, () => noteConnectionEvent());
  }
}

// Build the connection-popover peers payload from srwk.peers and push it
// into setConnectionState. Called wherever the peer count changes — keeps
// the "PEERS" row in the conn popover in sync with reality.
//
// The payload is intentionally honest: when the only "peer" is the local
// swf-node (self), we say so explicitly ("1 (self only)") instead of
// implying a peer-network when there isn't one.
function pushConnPeers() {
  const peers = [...srwk.peers.values()].filter((p) => p && p.pubkey);
  const total = peers.length;
  const others = peers
    .filter((p) => p.pubkey !== srwk.selfPubkey)
    .map((p) => p.nickname || `peer-${(p.pubkey || "").slice(0, 6)}`);
  const selfOnly = total <= 1 && others.length === 0;
  setConnectionState({ peers: { total, selfOnly, others } });
}

// Periodic /health probe so the connection popover surfaces current RTT
// even when no SSE event has fired recently. Runs every 5s, super cheap.
function startConnectionProbe() {
  async function probe() {
    const t0 = performance.now();
    try {
      const r = await fetch(`${srwk.serverUrl}/health`, { cache: "no-store" });
      const rttMs = performance.now() - t0;
      if (r.ok) setConnectionState({ rttMs });
      else setConnectionState({ state: "down", detail: `HTTP ${r.status}` });
    } catch (e) {
      setConnectionState({ state: "down", detail: e?.message || "fetch failed" });
    }
  }
  probe();
  setIntervalVisible(probe, 5000);
}

// Threshold above which we skip the per-page materialize() animation
// (BufferGeometry + ShaderMaterial + RAF loop per page) and fall back
// to a bulk /graph refetch + merge. Cinematic juice is reserved for
// genuine drips ("alice contributed 3 papers"); a 930-page first
// scrape from a fresh peer goes through the efficient path. The
// server now caps contribution_merged at 64 pages/event so this
// fallback rarely fires under normal operation — it's a safety net
// for older servers, mis-chunked events, or future regressions.
const BIG_BURST_THRESHOLD = 64;

async function handleContributionMerged(data, peer) {
  const pages = data.pages || [];
  const newPages = pages.filter((p) => !srwk.nodeMap.has(p.url));
  if (newPages.length > BIG_BURST_THRESHOLD) {
    // Skip per-page animation. Refetch the snapshot and merge — the
    // graph picks up everything the server-side _apply just persisted,
    // including pages we couldn't have known about from this event
    // alone (e.g. backfilled hosts/topics).
    try {
      const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
      if (r.ok) mergeFreshGraph(await r.json());
    } catch (e) { console.warn("[contribution_merged] bulk refetch failed:", e); }
    return;
  }
  for (const p of newPages) {
    const node = {
      id: p.url, title: p.title, host: p.host || "", topic: p.topic || "background",
      primary_contributor: peer.pubkey, contributors: [peer.pubkey],
      degree: 0, fetched_at: new Date().toISOString(), last_visited: null,
    };
    applyDimensions(node, srwk.lens);
    materialize({ scene: srwk.scene, srwk, page: node, peer, addPageToGraph });
  }
}

function addPageToGraph(node) {
  if (srwk.nodeMap.has(node.id)) return;
  srwk.nodeMap.set(node.id, node);
  srwk.nodes.push(node);
  // add to graph data
  const data = srwk.G.graphData();
  data.nodes.push(node);
  srwk.G.graphData(data);
  tick("node-count", srwk.nodes.length);
  document.getElementById("mark-count").textContent =
    `${srwk.nodes.length}n · ${srwk.edges.length}e`;
  // pulse the cartography view: pick an edge incident on this node and
  // ride a runner-head along it. Also schedules a debounced rebuild so the
  // new node enters the streamline mesh.
  try {
    Graph2.pulseNode(node.id);
    Graph2.notifyDataChanged();
  } catch {}
  try {
    Cosmos.pulseNode(node.id);
    Cosmos.notifyDataChanged();
  } catch {}
  try {
    Atlas.pulseNode(node.id);
    Atlas.notifyDataChanged();
  } catch {}
  // Defensive: the empty / offline cards are owned by boot's first-load
  // logic but every path that grows node count needs to clear them
  // (SSE arrival, peer pull, materialize, reconcile). Otherwise a fresh
  // install that first sees data via SSE rather than the initial /graph
  // leaves the "no pages yet" card stuck behind real data.
  try { hideAtlasOffline(); } catch {}
  try { hideAtlasEmpty(); } catch {}
}

// ─── periodic /graph reconcile ────────────────────────────────────────────
// SSE event payloads can drift from /graph truth: a contribution_merged
// event might list pages that the server's view-builder later filters out
// (orphan pruning, lens-aware row sets, etc.), so a renderer that only adds
// nodes via SSE accumulates ghosts. Refetch /graph on a slow interval to
// reconcile. materialize() still drives the cinematic per-page animation;
// this just nudges in-memory state back toward server truth.
const RECONCILE_INTERVAL_MS = 30000;

function startGraphReconcile() {
  setIntervalVisible(reconcileGraph, RECONCILE_INTERVAL_MS);
  // Kick once early so we don't sit empty for a full interval after a
  // cold-start fetch failure or a swf-node restart.
  setTimeout(() => { reconcileGraph(); }, 1500);
  setTimeout(() => { reconcileGraph(); }, 5000);
}

async function reconcileGraph() {
  try {
    const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
    if (!r.ok) return;
    const fresh = await r.json();
    // Drop ghosts: nodes in our local set that aren't in the server's
    // current view. Re-attribute mismatches: if the server now says a
    // page belongs to a different primary_contributor, update locally so
    // the panel and visuals match.
    const truthIds = new Set();
    const truthByUrl = new Map();
    for (const n of fresh.nodes) {
      truthIds.add(n.id);
      truthByUrl.set(n.id, n);
    }
    let removed = 0;
    for (let i = srwk.nodes.length - 1; i >= 0; i--) {
      const n = srwk.nodes[i];
      if (!truthIds.has(n.id)) {
        srwk.nodes.splice(i, 1);
        srwk.nodeMap.delete(n.id);
        removed++;
      } else {
        const t = truthByUrl.get(n.id);
        if (t.primary_contributor && n.primary_contributor !== t.primary_contributor) {
          n.primary_contributor = t.primary_contributor;
        }
        if (Array.isArray(t.contributors)) n.contributors = t.contributors;
      }
    }
    // Add any pages we missed.
    let added = 0;
    for (const n of fresh.nodes) {
      if (!srwk.nodeMap.has(n.id)) {
        srwk.nodeMap.set(n.id, n);
        srwk.nodes.push(n);
        added++;
      }
    }
    srwk.edges = fresh.edges;
    srwk.clusters = fresh.clusters || [];
    for (const p of fresh.peers || []) srwk.peers.set(p.pubkey, p);
    if (srwk.G) srwk.G.graphData({ nodes: srwk.nodes, links: srwk.edges });
    tick("node-count", srwk.nodes.length);
    tick("edge-count", srwk.edges.length);
    document.getElementById("mark-count").textContent =
      `${srwk.nodes.length}n · ${srwk.edges.length}e`;
    tick("peer-count", srwk.peers.size);
    pushConnPeers();
    if (typeof renderPeersPanel === "function") renderPeersPanel();
    if (added || removed) {
      console.log(`[reconcile] +${added} -${removed} → ${srwk.nodes.length}n`);
    }
    // Whenever reconcile changes the corpus, poke the atlas (and any
    // other live renderers) so they re-cluster against the new node set.
    // Without this, atlas could miss results the SSE stream didn't
    // already materialize via the per-page path — e.g. when boot's
    // initial loadGraph failed and recovery happens entirely here.
    if (added || removed) {
      try { Atlas.notifyDataChanged(); } catch {}
      try { Graph2.notifyDataChanged(); } catch {}
      try { Cosmos.notifyDataChanged(); } catch {}
      // Recovered from cold-start failure: clear the "offline" status.
      // Same path also clears the "indrex empty" panel if a first page
      // just landed (fresh install pulling its first page from a peer).
      if (srwk.nodes.length > 0) {
        setStatus("");
        setConnectionState({ state: "connected", serverUrl: srwk.serverUrl });
        hideAtlasOffline();
        hideAtlasEmpty();
      }
    }
  } catch (e) {
    /* swallow; next tick will retry */
  }
}

// ─── atlas offline panel ─────────────────────────────────────────────
// Visible when swf-node is unreachable. Provides a "command to give
// agent" button that copies a self-explanatory debug prompt — paste
// into Claude / ChatGPT / Cursor and they get full context.
function wireAtlasOfflinePanel() {
  const panel = document.getElementById("atlas-offline");
  if (!panel) return;
  const urlEl  = document.getElementById("ao-server-url");
  const copyBtn = document.getElementById("ao-copy-prompt");
  const retryBtn = document.getElementById("ao-retry");
  if (urlEl) urlEl.textContent = srwk.serverUrl;
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const prompt = buildOfflineAgentPrompt();
      let ok = false;
      try { await navigator.clipboard.writeText(prompt); ok = true; } catch {}
      if (!ok) {
        try {
          const ta = document.createElement("textarea");
          ta.value = prompt; ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          ok = true;
        } catch {}
      }
      if (ok) {
        const prev = copyBtn.querySelector(".ao-btn-label").textContent;
        copyBtn.dataset.state = "copied";
        copyBtn.querySelector(".ao-btn-label").textContent = "copied — paste to your agent";
        setTimeout(() => {
          delete copyBtn.dataset.state;
          copyBtn.querySelector(".ao-btn-label").textContent = prev;
        }, 1800);
      }
    });
  }
  if (retryBtn) {
    retryBtn.addEventListener("click", async () => {
      const prev = retryBtn.querySelector(".ao-btn-label").textContent;
      retryBtn.querySelector(".ao-btn-label").textContent = "retrying…";
      retryBtn.disabled = true;
      try { await reconcileGraph(); } catch {}
      retryBtn.disabled = false;
      retryBtn.querySelector(".ao-btn-label").textContent = prev;
    });
  }
}
function showAtlasOffline() {
  const panel = document.getElementById("atlas-offline");
  if (panel) panel.hidden = false;
  // Update the URL in case it differs from the default.
  const urlEl = document.getElementById("ao-server-url");
  if (urlEl) urlEl.textContent = srwk.serverUrl;
}
function hideAtlasOffline() {
  const panel = document.getElementById("atlas-offline");
  if (panel) panel.hidden = true;
}
// Fresh-install case: daemon reachable but no indexed pages yet. The
// reconcile poll calls hideAtlasEmpty as soon as it sees any node show
// up in the graph; until then we show the friendly empty card.
function showAtlasEmpty() {
  const panel = document.getElementById("atlas-empty");
  if (panel) panel.hidden = false;
}
function hideAtlasEmpty() {
  const panel = document.getElementById("atlas-empty");
  if (panel) panel.hidden = true;
}
function buildOfflineAgentPrompt() {
  const url = srwk.serverUrl;
  return [
    `Hey — I got this message from inside the Shape Rotator OS Shape Rotator OS:`,
    ``,
    `> The swf-node daemon isn't reachable at ${url}. The Shape Rotator OS is read-only —`,
    `> all my indexed pages live in swf-node's local SQLite. Without the daemon`,
    `> running, the atlas / network / metrics tabs can't show anything.`,
    ``,
    `Architecture: swf-node is a LAN-first peer search daemon (the searxng-wth-frnds`,
    `repo). The Electron app I'm using is just a viewer that polls swf-node's HTTP`,
    `endpoints (/graph, /events, /web_search). When swf-node is down, the viewer has`,
    `nothing to render.`,
    ``,
    `Help me get swf-node running. Likely path:`,
    `1. Check if it's installed:    \`which swf-node\`  or  \`pipx list | grep swf\``,
    `2. If installed, start it:      \`swf-node\`        (defaults to ${url})`,
    `3. If not installed, install it from the searxng-wth-frnds repo`,
    `   (check the repo's README for the exact install command — pipx, pip, or source).`,
    `4. Verify it's up:              \`curl -s ${url}/graph?lens=contributor | head\``,
    ``,
    `Field-guide source + bug reports: github.com/dmarzzz/shape-rotator-os.`,
    `Once the daemon responds, Shape Rotator OS auto-recovers within ~5s — no reload`,
    `needed.`,
  ].join("\n");
}

// ─── peers panel ──────────────────────────────────────────────────────────
// Click the peer count → reveal a panel listing each peer: signature
// dot, nickname, truncated pubkey + copy button, page count, last-seen.
// `srwk.peers` is already populated from /graph and kept fresh by the
// SSE peer_joined / peer_back / peer_left handlers; the panel just
// re-renders on toggle and on those same events.

function wirePeersPanel() {
  const btn = document.getElementById("peer-count-btn");
  const panel = document.getElementById("peers-panel");
  const close = document.getElementById("peers-panel-close");
  if (!btn || !panel || !close) return;
  const open = () => {
    btn.setAttribute("aria-expanded", "true");
    panel.hidden = false;
    renderPeersPanel();
    // Refresh /sync/manifest opportunistically when the panel opens so
    // the activity footer reflects current state, not a 10s-stale cache.
    refreshManifestCache().then((changed) => { if (changed) renderPeersPanel(); });
  };
  const hide = () => {
    btn.setAttribute("aria-expanded", "false");
    panel.hidden = true;
  };
  btn.addEventListener("click", () => panel.hidden ? open() : hide());
  close.addEventListener("click", hide);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) hide();
  });
  // Fetch our own well-known once and cache for the session. We need
  // `pubkey` to mark "you" in the list and `name` / `fingerprint` to
  // populate the local-node header. The endpoint is unauthenticated and
  // lives on the same origin.
  refreshWellKnownCache().then(() => {
    renderPeersPanel();
    // Live graph layout depends on selfPubkey; refresh it now so the
    // self node is correctly excluded from the perimeter once known.
    if (typeof recomputeLayout === "function") {
      try { recomputeLayout(); } catch {}
    }
  });
  // Prime the manifest cache so the sync-activity footer has data on
  // first open. Best-effort — failure is fine; we render "unreachable".
  refreshManifestCache().finally(() => {
    // Network-tab panels (records count + peer record-counts) read
    // srwk._manifest directly — repaint once the first manifest lands.
    try { renderNetRouterStatus(); } catch {}
    try { renderNetRecordsPanel(); } catch {}
    if (document.body.dataset.activeTab === "network") {
      try { renderNetPeersList(); } catch {}
    }
  });
  // Refresh every 10s so live/stale tags + sync activity stay accurate
  // even when the panel is open and idle. Also covers the network-tab
  // panels — cheap to repaint, and the manifest counts the user sees
  // there should be no more than 10s stale.
  setIntervalVisible(() => {
    if (!panel.hidden) {
      refreshManifestCache().finally(() => renderPeersPanel());
    } else if (document.body.dataset.activeTab === "network") {
      refreshManifestCache().finally(() => {
        try { renderNetRouterStatus(); } catch {}
        try { renderNetRecordsPanel(); } catch {}
        try { renderNetPeersList(); } catch {}
      });
    }
  }, 10000);
  // Re-render when the cohort layer reports a change (covers manifest
  // refreshes that happen via cohort-source's own poll loop).
  try {
    subscribeToCohortChanges(() => {
      if (!panel.hidden) renderPeersPanel();
      if (document.body.dataset.activeTab === "network") {
        try { renderNetRouterStatus(); } catch {}
        try { renderNetRecordsPanel(); } catch {}
        try { renderNetPeersList(); } catch {}
      }
    });
  } catch {}
  // Kick off the /sync/log poll. Cheap (a single GET against loopback,
  // 100-event cap), runs every 3s for the lifetime of the renderer so
  // the sync-confidence indicator stays current even when the panel
  // is closed. Stops automatically if the endpoint 404s (older
  // swf-node bundles ship without it).
  startSyncLogPoll();
}

// ─── sync-log poll ───────────────────────────────────────────────────────
// Live event feed from the local swf-node's /sync/log endpoint. Drives:
//   • the sync-confidence header (green/amber/red dot + "Xs ago")
//   • per-peer heartbeat pulses (manifest_fetched → ring around swatch)
//   • per-peer staleness fade (no manifest_fetched in 90s → 50% opacity)
//   • the activity-log section at the bottom of the panel
// All state lives at module scope so renderPeersPanel can read it without
// threading a state object through every helper. The poll is a 3s
// setInterval — cheap, single GET against loopback, capped to 100 events
// per response.

let _lastSyncLogSeq = 0;
let _activityLog = [];                          // newest-first, capped at 50
const ACTIVITY_LOG_MAX = 50;
const _peerLastSeenByPubkey = new Map();        // pubkey → ts_ms of last sync-flavored heartbeat
const _peerVersionByPubkey  = new Map();        // pubkey → swf-node version string (from mDNS TXT)
// Local versions — swf-node from GET /health, electron from window.api.getAppInfo().
// Populated lazily by ensureSelfVersions() the first time the peers panel
// renders; renderPeersPanel() is re-fired once they resolve so the section
// repaints with concrete numbers instead of "—".
let _selfSwfVersion = null;
let _selfElectronVersion = null;
let _selfVersionsFetchedAt = 0;
async function ensureSelfVersions() {
  // Cache for 60s so we don't re-hit /health on every peers-panel open.
  if (_selfVersionsFetchedAt && Date.now() - _selfVersionsFetchedAt < 60000) return;
  _selfVersionsFetchedAt = Date.now();
  let changed = false;
  try {
    const h = await getHealth();
    const v = h.ok ? (h.body?.version || null) : null;
    if (v && v !== _selfSwfVersion) { _selfSwfVersion = v; changed = true; }
  } catch {}
  try {
    const info = await (window.api?.getAppInfo?.() ?? null);
    const v = info?.version || null;
    if (v && v !== _selfElectronVersion) { _selfElectronVersion = v; changed = true; }
  } catch {}
  if (changed && typeof renderPeersPanel === "function") {
    try { renderPeersPanel(); } catch {}
  }
}
// Pull `v=...` out of a swf-node mDNS TXT-record summary string like:
//   "node=mac-foo port=7777 proto=searxng-wth-frnds/v0.3 v=0.0.0+unknown"
// Returns the bare version string or null. Defensive: TXT records aren't
// part of swf-node's stable contract, so a missing/unparseable v= just
// resolves to null and the renderer shows "—".
function parsePeerVersionFromTxt(txt) {
  if (!txt || typeof txt !== "string") return null;
  const m = txt.match(/(?:^|\s)v=([^\s]+)/);
  return m ? m[1] : null;
}
let _lastTickTsMs = 0;
let _lastNodeLogActivityMs = 0;                 // wall-clock of latest non-tick event
let _syncLogUnavailable = false;                // /sync/log fallback path 404'd too
let _syncLogTimer = null;
// /node/log lives in swf-node v0.12.0+. When the endpoint 404s we fall back
// to /sync/log and tag every event as category="sync"; the SEARCH / HEALTH /
// MDNS / INGEST chips simply stay empty in that mode.
let _nodeLogAvailable = null;                   // null = not yet probed; true/false = known
// Per-peer reachability tracking, populated from peer_unreachable /
// peer_reachable events. Used by the LIVE NETWORK viz + peer cards.
const _peerReachable = new Map();               // pubkey → boolean (true = reachable)
// Bag of recent search-completed events for the SEARCH panel.
const _recentSearches = [];                     // newest-first, capped at 12
const RECENT_SEARCH_MAX = 12;

function startSyncLogPoll() {
  if (_syncLogTimer) return;
  // Fire one immediate poll so the panel has data on first open without
  // a 3s gap; then keep the interval going.
  pollNodeLog();
  _syncLogTimer = setInterval(pollNodeLog, 3000);
}

// Unified poller: tries /node/log first (v0.12.0+), falls back to
// /sync/log on 404 and tags every event as category="sync". The
// fallback path keeps the slide-out peers-panel's sync-confidence
// header working against pre-0.12 daemons.
async function pollNodeLog() {
  if (_syncLogUnavailable) return;
  try {
    let log = null;
    let usedFallback = false;
    if (_nodeLogAvailable !== false) {
      const res = await getNodeLog({ sinceSeq: _lastSyncLogSeq, limit: 100 });
      if (res.ok) {
        _nodeLogAvailable = true;
        log = res.log || {};
      } else if (res.status === 404 || res.reason === "not_found") {
        // Older swf-node: latch and try /sync/log on this tick.
        _nodeLogAvailable = false;
      } else {
        // transient — skip this tick
        return;
      }
    }
    if (!log) {
      usedFallback = true;
      const res = await getSyncLog({ sinceSeq: _lastSyncLogSeq, limit: 100 });
      if (!res.ok) {
        if (res.status === 404 || res.reason === "not_found") {
          _syncLogUnavailable = true;
          if (_syncLogTimer) { clearInterval(_syncLogTimer); _syncLogTimer = null; }
          const panel = document.getElementById("peers-panel");
          if (panel && !panel.hidden) renderPeersPanel();
        }
        return;
      }
      log = res.log || {};
    }
    if (typeof log.tail_seq === "number") _lastSyncLogSeq = log.tail_seq;
    const events = Array.isArray(log.events) ? log.events : [];
    for (const evt of events) {
      // Stamp legacy /sync/log payloads with category="sync" so downstream
      // filtering treats them as part of the sync stream.
      if (usedFallback && !evt.category) evt.category = "sync";
      processNodeLogEvent(evt);
    }
    if (_activityLog.length > ACTIVITY_LOG_MAX) {
      _activityLog.length = ACTIVITY_LOG_MAX;
    }
    if (events.length > 0) {
      // Anything network-tab-bound: refresh the cards + router status.
      if (document.body.dataset.activeTab === "network") {
        try { renderNetPeersList(); } catch {}
      }
      try { renderNetSearchPanel(); } catch {}
      try { renderNetRecordsPanel(); } catch {}
    }
    // The SYNC status line carries a "last activity Xs ago" stamp that
    // wants to tick up every 3s regardless of whether new events
    // arrived. Cheap; just rewrites a single line of text.
    try { renderNetRouterStatus(); } catch {}
    const panel = document.getElementById("peers-panel");
    if (panel && !panel.hidden) renderPeersPanel();
  } catch {
    // Network blip — the next tick will retry. We don't escalate
    // because the UI degrades gracefully (dot drifts amber → red).
  }
}

// Backwards-compatible alias. Older call sites may still reference
// pollSyncLog by name; route them through the unified poller.
const pollSyncLog = pollNodeLog;

// Apply one /node/log event to the shared state, fire the appropriate
// pulses, and push it into the Network-tab TRAFFIC feed.
function processNodeLogEvent(evt) {
  _activityLog.unshift(evt);
  const cat = evt.category || "sync";
  // Track per-peer heartbeats for sync/mdns/health.
  if (evt.peer_pubkey && (cat === "sync" || cat === "mdns" || cat === "health")) {
    _peerLastSeenByPubkey.set(evt.peer_pubkey, evt.ts_ms);
    if (evt.kind !== "peer_unreachable" && evt.kind !== "mdns_peer_disappeared") {
      firePulse(evt.peer_pubkey);
    }
  }
  // Health: maintain a reachability map.
  if (evt.kind === "peer_unreachable" && evt.peer_pubkey) {
    _peerReachable.set(evt.peer_pubkey, false);
  } else if (evt.kind === "peer_reachable" && evt.peer_pubkey) {
    _peerReachable.set(evt.peer_pubkey, true);
  } else if (evt.kind === "mdns_peer_disappeared" && evt.peer_pubkey) {
    _peerReachable.set(evt.peer_pubkey, false);
  } else if (evt.kind === "mdns_peer_appeared" && evt.peer_pubkey) {
    _peerReachable.set(evt.peer_pubkey, true);
    // mDNS TXT records carry the peer's swf-node version as `v=X.Y.Z`.
    // Cache for the peers panel + the diagnostics dump.
    const v = parsePeerVersionFromTxt(evt.txt_record_summary);
    if (v) _peerVersionByPubkey.set(evt.peer_pubkey, v);
  }
  if (evt.kind === "tick") {
    _lastTickTsMs = evt.ts_ms;
    if ((evt.pulled || 0) + (evt.applied || 0) > 0) {
      firePulse("self");
    }
  } else if (evt.ts_ms && evt.ts_ms > _lastNodeLogActivityMs) {
    _lastNodeLogActivityMs = evt.ts_ms;
  }
  // Search: remember a small ring for the SEARCH panel.
  if (evt.kind === "web_search_completed") {
    _recentSearches.unshift(evt);
    if (_recentSearches.length > RECENT_SEARCH_MAX) _recentSearches.length = RECENT_SEARCH_MAX;
  }
  // Push into the unified Network-tab TRAFFIC feed. buildTrafficRow uses
  // {kind, payload, ts} shape; node-log events are flat (no `payload`
  // nesting) — pass the whole event as payload so the per-kind renderers
  // can pull the fields they need.
  try {
    appendTrafficEvent({ kind: evt.kind, payload: evt, ts: evt.ts_ms, _category: cat });
  } catch {}
  // Live network viz reacts to a subset of kinds.
  try { livegraphPushFromNodeLog(evt); } catch (e) { /* swallow; cosmetic */ }
}

// Add the .pulsing class to the matching peer row (or the local-node
// row when target === "self") for 1.5s. The CSS keyframe drives a
// subtle ring scale 1.0→2.0, opacity 0.6→0 on a pseudo-element around
// the .p-dot swatch. Multiple rapid events for the same target just
// reset the timer so the pulse stays visible.
const _pulseTimers = new Map();   // pubkey | "self" → timeout id
function firePulse(target) {
  const panel = document.getElementById("peers-panel");
  if (!panel) return;
  let row = null;
  if (target === "self") {
    row = panel.querySelector(".peers-self-row");
  } else {
    row = panel.querySelector(`.peer-row[data-pubkey="${cssEscape(target)}"]`);
  }
  if (!row) return;
  row.classList.add("pulsing");
  const prev = _pulseTimers.get(target);
  if (prev) clearTimeout(prev);
  const t = setTimeout(() => {
    row.classList.remove("pulsing");
    _pulseTimers.delete(target);
  }, 1500);
  _pulseTimers.set(target, t);
}

// Lightweight CSS.escape shim. Pubkeys are hex (already safe), but
// belt-and-braces this in case a future kind emits a key with a colon
// or hyphen the selector parser dislikes.
function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

// Cache the /.well-known/indrex response for the session. Cheap to
// fetch but stable across the lifetime of one swf-node instance.
async function refreshWellKnownCache() {
  try {
    const r = await fetch(`${srwk.serverUrl}/.well-known/indrex`, { cache: "no-store" });
    if (!r.ok) {
      srwk._wellKnown = null;
      srwk._wellKnownReachable = false;
      return null;
    }
    const d = await r.json();
    srwk._wellKnown = d || null;
    srwk._wellKnownReachable = true;
    if (d?.pubkey) srwk.selfPubkey = d.pubkey;
    return d;
  } catch {
    srwk._wellKnown = null;
    srwk._wellKnownReachable = false;
    return null;
  }
}

// Cache the latest /sync/manifest result + fetch timestamp so the
// sync-activity section in the peers panel can render record count,
// newest wall_ts, and "last fetch Xs ago" without re-querying on
// every renderPeersPanel() call. Returns true when the manifest_hash
// changed (so the caller can decide whether to re-render).
async function refreshManifestCache() {
  const before = srwk._manifest?.manifest?.manifest_hash || null;
  const res = await getManifest();
  if (res.ok) {
    srwk._manifest = {
      manifest: res.manifest,
      fetchedAt: Date.now(),
      reachable: true,
    };
  } else {
    srwk._manifest = {
      manifest: null,
      fetchedAt: Date.now(),
      reachable: false,
      reason: res.reason || "unreachable",
    };
  }
  const after = srwk._manifest.manifest?.manifest_hash || null;
  return before !== after;
}

function renderPeersPanel() {
  // Render the network-tab peers list whenever the popup peers list
  // refreshes — same data, two surfaces.
  if (typeof renderNetPeersList === "function") renderNetPeersList();
  // Issue #43 PR D: source-filter chip bar shares the peers map.
  // Rebuild chips on every peers refresh so newly-discovered peers
  // pick up a chip without a page reload.
  if (typeof renderSourceFilterChips === "function") {
    try { renderSourceFilterChips(); } catch {}
  }
  // The live propagation graph is also keyed off the peers map; recompute
  // its layout so newly-discovered peers slot into the perimeter. Cheap.
  if (typeof recomputeLayout === "function") {
    try { recomputeLayout(); } catch {}
  }
  const list = document.getElementById("peers-panel-list");
  if (!list) return;
  list.innerHTML = "";

  // ─── sync confidence header (very top) ───────────────────────────────
  // A single quiet line above local-node: green/amber/red dot + age of
  // the most recent sync activity. Driven by the /sync/log poll when
  // the endpoint exists; falls back to /sync/manifest's fetchedAt
  // timestamp on older swf-node bundles.
  list.appendChild(buildSyncConfidenceHeader());

  // ─── local-node section ──────────────────────────────────────────────
  // Sits above the peer list as a distinct row that shows the operator
  // their own identity: short fingerprint, mDNS instance name, the LAN
  // bind the renderer reaches the daemon at, and trust_level. This is
  // the "who am I on the wire" affordance — small but important.
  list.appendChild(buildLocalNodeSection());

  // ─── discovered peers section ────────────────────────────────────────
  const peersHead = document.createElement("div");
  peersHead.className = "peers-section-head";
  peersHead.textContent = "discovered";
  list.appendChild(peersHead);

  const peers = [...srwk.peers.values()].filter((p) => p && p.pubkey && p.pubkey !== srwk.selfPubkey);
  if (peers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "peers-empty";
    empty.textContent = "no peers yet — the network is quiet.";
    list.appendChild(empty);
  } else {
    // Derive page count from the live node set so it tracks materialize()
    // additions, not just the last /graph snapshot's stale value.
    const liveCounts = new Map();
    for (const n of srwk.nodes) {
      const pk = n.primary_contributor;
      if (!pk) continue;
      liveCounts.set(pk, (liveCounts.get(pk) || 0) + 1);
    }
    // Sort by live page count desc, then by nickname. Self was filtered
    // out above (it lives in the local-node section now).
    peers.sort((a, b) => {
      const ap = liveCounts.get(a.pubkey) ?? a.page_count ?? 0;
      const bp = liveCounts.get(b.pubkey) ?? b.page_count ?? 0;
      if (ap !== bp) return bp - ap;
      return (a.nickname || "").localeCompare(b.nickname || "");
    });
    const now = performance.now();
    for (const p of peers) {
      list.appendChild(buildPeerRow(p, now, liveCounts));
    }
  }

  // ─── sync activity section ───────────────────────────────────────────
  list.appendChild(buildSyncActivitySection());

  // ─── activity log (bottom) ───────────────────────────────────────────
  // Scrollable feed of individual sync events from /sync/log. Hidden
  // entirely if the endpoint is unavailable on the bundled swf-node
  // (older bundles); the sync-confidence header above still renders.
  if (!_syncLogUnavailable) {
    list.appendChild(buildActivityLogSection());
  }
}

// Render the operator's own node as a distinct row at the top of the
// panel. Information shown:
//   • short fingerprint (8 hex chars from /.well-known/indrex)
//   • mDNS instance name (well-known `name`)
//   • LAN bind URL (srwk.serverUrl)
//   • trust_level label (sourced from the self entry in srwk.peers if
//     present, else "self")
// If well-known isn't reachable yet we render a placeholder so the
// row is never empty (avoids a layout pop when the fetch resolves).
function buildLocalNodeSection() {
  // Fire the local-version probe lazily on first render. Cached at module
  // scope for 60s; re-fires renderPeersPanel() once values land so the
  // chip below repaints from "—" to concrete versions.
  ensureSelfVersions();

  const wrap = document.createElement("div");
  wrap.className = "peers-self";

  const head = document.createElement("div");
  head.className = "peers-section-head";
  head.textContent = "local node";
  wrap.appendChild(head);

  const row = document.createElement("div");
  row.className = "peers-self-row";

  const wk = srwk._wellKnown;
  const selfPeer = srwk.selfPubkey ? srwk.peers.get(srwk.selfPubkey) : null;
  const color = selfPeer?.signature_color || (srwk.selfPubkey ? stableHue(srwk.selfPubkey) : "rgba(220,232,255,0.42)");

  const dot = document.createElement("span");
  dot.className = "p-dot";
  dot.style.background = color;
  dot.style.boxShadow = `0 0 10px 1px ${color}`;

  const mid = document.createElement("div");
  mid.className = "p-mid";

  const nameLine = document.createElement("span");
  nameLine.className = "p-nick is-self";
  nameLine.textContent = wk?.name || selfPeer?.nickname || "this node";

  const idLine = document.createElement("span");
  idLine.className = "p-pubkey";
  const fp = wk?.fingerprint
    ? wk.fingerprint.slice(0, 8)
    : (srwk.selfPubkey ? srwk.selfPubkey.slice(0, 8) : "—");
  idLine.textContent = `fp ${fp}`;
  idLine.title = wk?.fingerprint || srwk.selfPubkey || "";

  mid.append(nameLine, idLine);

  const meta = document.createElement("div");
  meta.className = "p-meta";
  const addr = document.createElement("span");
  addr.className = "p-self-addr";
  addr.textContent = formatLanBind(srwk.serverUrl);
  addr.title = srwk.serverUrl || "";
  const trust = document.createElement("span");
  trust.className = "p-self-trust";
  trust.textContent = (selfPeer?.trust_level || "self").toLowerCase();
  // Local version chip — swf-node (from /health) + electron (from
  // window.api.getAppInfo()). Both are local lookups, so unlike the
  // peer rows we can show both. Hyphen until ensureSelfVersions
  // resolves; renderPeersPanel re-fires when it does.
  const ver = document.createElement("span");
  ver.className = "p-version";
  const swf = _selfSwfVersion || "—";
  const ele = _selfElectronVersion || "—";
  ver.textContent = `swf ${swf} · el ${ele}`;
  ver.title = `swf-node ${swf} (this node, from /health) · electron app ${ele} (from main process)`;
  meta.append(addr, trust, ver);

  row.append(dot, mid, meta);
  wrap.appendChild(row);

  // Surface reachability of the well-known endpoint inline. If the
  // bundled daemon is down we show a small note so the user knows the
  // panel is reading stale state — and what the fallback path is.
  if (srwk._wellKnownReachable === false) {
    const note = document.createElement("div");
    note.className = "peers-self-note";
    note.textContent = "swf-node unreachable — edits fall back to the github-PR path.";
    wrap.appendChild(note);
  }
  return wrap;
}

// Render the small sync-activity footer: total records held locally,
// the newest record's wall_ts (relative), and a "last fetch Xs ago"
// proxy for the sync-loop tick (the renderer doesn't sit inside that
// loop, but the fetch-age is a faithful stand-in).
function buildSyncActivitySection() {
  const wrap = document.createElement("div");
  wrap.className = "peers-sync";

  const head = document.createElement("div");
  head.className = "peers-section-head";
  head.textContent = "sync activity";
  wrap.appendChild(head);

  const m = srwk._manifest;
  if (!m || m.reachable === false) {
    const row = document.createElement("div");
    row.className = "peers-sync-empty";
    row.textContent = m && m.reason ? `manifest ${m.reason}` : "manifest unreachable";
    wrap.appendChild(row);
    return wrap;
  }
  const records = m.manifest?.records || {};
  const ids = Object.keys(records);
  let newestTs = 0;
  for (const id of ids) {
    const ts = records[id]?.latest_wall_ts_ms;
    if (typeof ts === "number" && ts > newestTs) newestTs = ts;
  }

  const grid = document.createElement("div");
  grid.className = "peers-sync-grid";

  grid.appendChild(buildSyncCell("records", String(ids.length)));
  const nowMs = Date.now();
  grid.appendChild(buildSyncCell(
    "latest",
    newestTs > 0 ? formatPeerLastSeen((nowMs - newestTs) / 1000) : "—",
  ));
  grid.appendChild(buildSyncCell(
    "last fetch",
    m.fetchedAt ? formatPeerLastSeen((nowMs - m.fetchedAt) / 1000) : "—",
  ));
  wrap.appendChild(grid);
  return wrap;
}

function buildSyncCell(label, value) {
  const cell = document.createElement("div");
  cell.className = "peers-sync-cell";
  const k = document.createElement("span");
  k.className = "peers-sync-k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "peers-sync-v";
  v.textContent = value;
  cell.append(k, v);
  return cell;
}

// ─── sync confidence header ────────────────────────────────────────────
// A single quiet line above the local-node section. Three states:
//
//   • green  · "in sync · 12s ago"        — last tick < 60s
//   • amber  · "drifting · 1m 30s ago"    — last tick 60s–180s
//   • red    · "no peers reached"         — no tick or > 180s
//
// When /sync/log is unavailable (older swf-node), we fall back to the
// /sync/manifest fetchedAt timestamp — manifest cache age is a faithful
// proxy for "the daemon was alive that recently".
function buildSyncConfidenceHeader() {
  const wrap = document.createElement("div");
  wrap.className = "peers-sync-confidence";

  const dot = document.createElement("span");
  dot.className = "psc-dot";
  const label = document.createElement("span");
  label.className = "psc-label";
  const age = document.createElement("span");
  age.className = "psc-age";

  let lastActivityMs = 0;
  if (!_syncLogUnavailable) {
    lastActivityMs = _lastTickTsMs;
    // Latest manifest_fetched or peer_reachable in the rolling window
    // also counts as activity (a tick fires every 30s but the daemon
    // can be quiet between ticks if nothing changed).
    for (const ts of _peerLastSeenByPubkey.values()) {
      if (ts > lastActivityMs) lastActivityMs = ts;
    }
  } else {
    // Fallback path — manifest cache age.
    const m = srwk._manifest;
    if (m && m.reachable !== false && m.fetchedAt) {
      lastActivityMs = m.fetchedAt;
    }
  }

  const now = Date.now();
  const ageSec = lastActivityMs > 0 ? (now - lastActivityMs) / 1000 : Infinity;

  let state, text;
  if (!isFinite(ageSec)) {
    state = "down";
    text = "no peers reached";
  } else if (ageSec < 60) {
    state = "live";
    text = "in sync";
  } else if (ageSec < 180) {
    state = "drift";
    text = "drifting";
  } else {
    state = "down";
    text = "no peers reached";
  }

  wrap.dataset.state = state;
  label.textContent = text;
  age.textContent = isFinite(ageSec) ? `· ${formatPeerLastSeen(ageSec)}` : "";

  wrap.append(dot, label, age);
  return wrap;
}

// ─── activity log ──────────────────────────────────────────────────────
// Scrollable feed of /sync/log events. Newest at top, capped viewport
// of ~5 rows visible at once (scroll for more). Pure information
// density — relative time, glyph, concise text — no emoji, no color
// noise beyond the existing ink ramp.
function buildActivityLogSection() {
  const wrap = document.createElement("div");
  wrap.className = "peers-activity";

  const head = document.createElement("div");
  head.className = "peers-section-head";
  head.textContent = "activity log";
  wrap.appendChild(head);

  if (_activityLog.length === 0) {
    const empty = document.createElement("div");
    empty.className = "peers-activity-empty";
    empty.textContent = "no activity yet — sync ticks every 30s";
    wrap.appendChild(empty);
    return wrap;
  }

  const list = document.createElement("div");
  list.className = "peers-activity-list";
  const nowMs = Date.now();
  for (const evt of _activityLog) {
    list.appendChild(buildActivityRow(evt, nowMs));
  }
  wrap.appendChild(list);
  return wrap;
}

function buildActivityRow(evt, nowMs) {
  const row = document.createElement("div");
  row.className = "peers-activity-row";
  row.dataset.kind = evt.kind || "";

  const ts = document.createElement("span");
  ts.className = "pa-ts";
  const ageSec = (nowMs - (evt.ts_ms || nowMs)) / 1000;
  ts.textContent = formatActivityAge(ageSec);

  const glyph = document.createElement("span");
  glyph.className = "pa-glyph";
  glyph.textContent = activityGlyph(evt.kind);

  const text = document.createElement("span");
  text.className = "pa-text";
  text.textContent = activityText(evt);

  row.append(ts, glyph, text);
  return row;
}

// Compact relative-time formatter for the activity log — 5ch slot so
// the rows align as a monospace ledger.
function formatActivityAge(secsAgo) {
  if (!isFinite(secsAgo) || secsAgo < 0) return "  —  ";
  if (secsAgo < 1) return " now ";
  if (secsAgo < 60) return `${Math.round(secsAgo)}s`.padStart(4, " ") + " ";
  if (secsAgo < 3600) return `${Math.round(secsAgo / 60)}m`.padStart(4, " ") + " ";
  if (secsAgo < 86400) return `${Math.round(secsAgo / 3600)}h`.padStart(4, " ") + " ";
  return `${Math.round(secsAgo / 86400)}d`.padStart(4, " ") + " ";
}

// Glyph vocabulary — simple Unicode shapes from the existing design
// palette. No emoji. Each glyph is one column wide; the .pa-glyph
// span pads to 2ch so the text column lines up.
function activityGlyph(kind) {
  switch (kind) {
    case "pulled":           return "◐";
    case "manifest_fetched": return "●";
    case "tick":             return "◌";
    case "applied_local":    return "▶";
    case "peer_unreachable": return "✕";
    case "peer_reachable":   return "●";
    default:                 return "·";
  }
}

// Concise per-row text. Peer names + record ids get truncated to 16
// chars + ellipsis. Falls back to a short pubkey prefix when no name
// is supplied.
function activityText(evt) {
  const peer = evt.peer_name
    ? truncId(evt.peer_name)
    : (evt.peer_pubkey ? evt.peer_pubkey.slice(0, 8) : "peer");
  const rid = evt.record_id ? truncId(evt.record_id) : "";
  switch (evt.kind) {
    case "pulled":
      return rid ? `pulled  ${rid} from ${peer}` : `pulled from ${peer}`;
    case "manifest_fetched": {
      const n = typeof evt.record_count === "number" ? evt.record_count : null;
      return n !== null
        ? `manifest from ${peer} (${n} record${n === 1 ? "" : "s"})`
        : `manifest from ${peer}`;
    }
    case "tick": {
      const v = evt.visited || 0;
      const p = evt.pulled || 0;
      const a = evt.applied || 0;
      const parts = [`visited ${v}`];
      if (p) parts.push(`${p} pulled`);
      else parts.push(`0 pulled`);
      if (a) parts.push(`${a} applied`);
      return `tick · ${parts.join(" · ")}`;
    }
    case "applied_local":
      return rid ? `applied_local · ${rid}` : `applied_local`;
    case "peer_unreachable": {
      const r = evt.reason ? ` (${evt.reason})` : "";
      return `${peer} unreachable${r}`;
    }
    case "peer_reachable":
      return `${peer} back`;
    default:
      return evt.kind || "event";
  }
}

function truncId(s) {
  if (typeof s !== "string") return "";
  return s.length > 16 ? `${s.slice(0, 16)}…` : s;
}

// Network-tab traffic-row truncation. Spec asks for 18 chars on names +
// a similar trim on record_ids; keep them separate so the contract is
// explicit at every call site.
function truncPeerName(s) {
  if (typeof s !== "string" || !s) return "—";
  return s.length > 18 ? `${s.slice(0, 18)}…` : s;
}
function truncRecordId(s) {
  if (typeof s !== "string" || !s) return "—";
  return s.length > 18 ? `${s.slice(0, 18)}…` : s;
}
function formatBytesShort(n) {
  if (typeof n !== "number" || !isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n}b`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}kb`;
  return `${(n / (1024 * 1024)).toFixed(2)}mb`;
}

// Render `http://127.0.0.1:7777` as `127.0.0.1:7777` — the protocol
// is noise in this surface and the host:port is the load-bearing bit.
function formatLanBind(url) {
  if (!url || typeof url !== "string") return "—";
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}`;
  } catch {
    return url.replace(/^https?:\/\//i, "");
  }
}

function buildPeerRow(p, now, liveCounts) {
  const row = document.createElement("div");
  row.className = "peer-row";
  row.dataset.pubkey = p.pubkey || "";
  // Stale if /sync/log is live AND we haven't seen a manifest_fetched
  // for this peer in 90s. The .stale class fades the swatch to 50%
  // opacity per design — a visual nudge, not a hard "disconnected"
  // signal (the daemon side decides reachability). When /sync/log
  // isn't available we don't mark stale (no signal to base it on).
  if (!_syncLogUnavailable && p.pubkey) {
    const lastSeen = _peerLastSeenByPubkey.get(p.pubkey);
    if (!lastSeen || (Date.now() - lastSeen) > 90000) {
      row.classList.add("stale");
    }
  }
  row.tabIndex = 0;
  row.addEventListener("click", (e) => {
    // Don't fly when the user clicked the copy button — that's a
    // utility action, not a navigation intent.
    if (e.target.closest(".p-copy")) return;
    selectPeerRow(row, p);
  });
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectPeerRow(row, p);
    }
  });
  const color = p.signature_color || stableHue(p.pubkey);
  const dot = document.createElement("span");
  dot.className = "p-dot";
  dot.style.background = color;
  dot.style.boxShadow = `0 0 10px 1px ${color}`;
  const mid = document.createElement("div");
  mid.className = "p-mid";
  const nick = document.createElement("span");
  nick.className = "p-nick";
  if (p.pubkey === srwk.selfPubkey) nick.classList.add("is-self");
  nick.textContent = p.nickname || `peer-${(p.pubkey || "").slice(0, 8)}`;
  const pkRow = document.createElement("span");
  pkRow.className = "p-pubkey";
  const pkText = document.createElement("span");
  const pk = p.pubkey || "";
  pkText.textContent = pk ? `${pk.slice(0, 12)}…${pk.slice(-6)}` : "—";
  pkText.title = pk;
  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "p-copy";
  copyBtn.textContent = "copy";
  copyBtn.title = "copy full pubkey";
  copyBtn.addEventListener("click", () => {
    if (!pk) return;
    navigator.clipboard?.writeText(pk).then(() => {
      copyBtn.textContent = "copied";
      copyBtn.classList.add("copied");
      setTimeout(() => {
        copyBtn.textContent = "copy";
        copyBtn.classList.remove("copied");
      }, 1400);
    }).catch(() => {});
  });
  pkRow.append(pkText, copyBtn);
  mid.append(nick, pkRow);
  const meta = document.createElement("div");
  meta.className = "p-meta";
  const pages = document.createElement("span");
  pages.className = "p-pages";
  const livePc = liveCounts ? liveCounts.get(p.pubkey) : undefined;
  pages.textContent = `${(livePc ?? p.page_count ?? 0)}p`;
  const liveTs = srwk.liveSeen.get(p.pubkey);
  const live = document.createElement("span");
  if (liveTs && now - liveTs < LIVE_WINDOW_MS) {
    live.className = "p-live";
    live.textContent = "live";
  } else {
    live.className = "p-stale";
    live.textContent = "idle";
  }
  // swf-node version from the peer's mDNS TXT record (cached by
  // processNodeLogEvent on each mdns_peer_appeared). The Electron-app
  // version isn't advertised on the wire — peers would need to opt in
  // by passing it to swf-node so it could be included in the TXT — so
  // we surface only swf-node here for now.
  const peerVer = _peerVersionByPubkey.get(p.pubkey);
  const ver = document.createElement("span");
  ver.className = "p-version";
  ver.textContent = peerVer ? `swf ${peerVer}` : "swf —";
  ver.title = peerVer
    ? `swf-node ${peerVer} (from mDNS TXT). electron version isn't on the wire yet.`
    : "peer's swf-node version not seen yet — waiting on an mDNS announcement";
  meta.append(pages, live, ver);
  row.append(dot, mid, meta);
  return row;
}

// ─── events panel ─────────────────────────────────────────────────────────
// Realtime activity log on the left sidebar. Subscribes to the same SSE
// stream as the rest of the UI; the SSE handlers above call appendEvent()
// for kinds we render. Design constraints:
//   • cap at MAX_ROWS rendered DOM rows (older rows are evicted)
//   • batch DOM writes via rAF when events come faster than ~30/sec
//   • collapsed-by-default, persisted in localStorage
//   • header "events · N" counter pulses briefly when new events arrive
//   • peer signature_color sourced from srwk.peers, with a stableHue
//     fallback so we render before the peer is fully known.

const EVENTS_LS_KEY = "srwk:events:collapsed";
const EVENTS_MAX_ROWS = 50;
const EVENTS_AGED_AFTER = 15;       // rows past this index get the "aged" tint
const eventsState = {
  pending: [],                      // queued events awaiting the next rAF flush
  flushScheduled: false,
  total: 0,                         // monotonic count for the header
  pulseTimer: null,
  collapsed: true,
};

function wireEventsPanel() {
  const panel = document.getElementById("events-panel");
  const head = document.getElementById("events-panel-head");
  const list = document.getElementById("events-panel-list");
  if (!panel || !head || !list) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(EVENTS_LS_KEY);
    if (v === "false") collapsed = false;
  } catch { /* localStorage may be unavailable */ }
  const apply = () => {
    eventsState.collapsed = collapsed;
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  if (!list.firstChild) {
    const empty = document.createElement("div");
    empty.className = "events-empty";
    empty.id = "events-empty";
    empty.textContent = "nothing on the wire.";
    list.appendChild(empty);
  }
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(EVENTS_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
}

function appendEvent(evt) {
  eventsState.pending.push(evt);
  // Hard ceiling on the queue itself in case we get a flood the rAF can't drain.
  if (eventsState.pending.length > EVENTS_MAX_ROWS * 4) {
    eventsState.pending.splice(0, eventsState.pending.length - EVENTS_MAX_ROWS * 4);
  }
  if (!eventsState.flushScheduled) {
    eventsState.flushScheduled = true;
    requestAnimationFrame(flushEvents);
  }
}

function flushEvents() {
  eventsState.flushScheduled = false;
  const batch = eventsState.pending;
  eventsState.pending = [];
  if (!batch.length) return;
  const list = document.getElementById("events-panel-list");
  if (!list) return;
  const empty = document.getElementById("events-empty");
  if (empty) empty.remove();
  // Insert newest-first. We preserve incoming order within the batch by
  // walking it forward but each row prepends — net effect: newest at top.
  for (const evt of batch) {
    const row = buildEventRow(evt);
    if (!row) continue;
    list.insertBefore(row, list.firstChild);
    // Trigger the enter transition on the next frame.
    requestAnimationFrame(() => row.classList.remove("enter"));
  }
  // Trim to MAX_ROWS, evicting from the bottom.
  while (list.childElementCount > EVENTS_MAX_ROWS) {
    list.removeChild(list.lastElementChild);
  }
  // Re-tag aged rows. Cheap: walks at most MAX_ROWS nodes.
  const rows = list.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("aged", i >= EVENTS_AGED_AFTER);
  }
  // Header counter + pulse.
  eventsState.total += batch.length;
  const counter = document.getElementById("events-panel-count");
  if (counter) {
    counter.textContent = String(eventsState.total);
    counter.classList.add("pulse");
    if (eventsState.pulseTimer) clearTimeout(eventsState.pulseTimer);
    eventsState.pulseTimer = setTimeout(() => counter.classList.remove("pulse"), 480);
  }
}

function buildEventRow(evt) {
  const row = document.createElement("div");
  row.className = `events-row enter kind-${evt.kind}`;
  const dot = document.createElement("span");
  dot.className = "e-dot";
  const body = document.createElement("span");
  body.className = "e-body";
  const ts = formatEventTs(evt.ts);
  const p = evt.payload || {};
  const pubkey = p.contributor || "";
  const peer = srwk.peers.get(pubkey);
  const color = peer?.signature_color || (pubkey ? stableHue(pubkey) : "rgba(220,232,255,0.42)");
  dot.style.background = color;
  dot.style.boxShadow = `0 0 6px ${color}`;
  const nick = peer?.nickname || p.nickname || (pubkey ? `peer-${pubkey.slice(0, 6)}` : "—");

  if (evt.kind === "contribution_merged") {
    const pages = Array.isArray(p.pages) ? p.pages : [];
    const pc = p.page_count ?? pages.length;
    const sr = p.result_count ?? 0;
    const titles = pages
      .map((pg) => pg && (pg.title || pg.host || pg.url))
      .filter(Boolean)
      .slice(0, 3)
      .map((t) => String(t).length > 32 ? String(t).slice(0, 32) + "…" : String(t));
    const tail = titles.length ? `  ·  ${titles.join(", ")}` : "";
    body.innerHTML =
      `<span class="e-ts">${escHtml(ts)}</span>` +
      `<span class="e-actor">${escHtml(nick)}</span> → ` +
      `<span class="e-meta">+${pc}p +${sr}sr</span>` +
      `<span class="e-tail">${escHtml(tail)}</span>`;
  } else if (evt.kind === "peer_joined") {
    const trust = p.trust_level || "untrusted";
    body.innerHTML =
      `<span class="e-ts">${escHtml(ts)}</span>` +
      `<span class="e-actor">${escHtml(nick)}</span> joined  ·  ` +
      `<span class="e-meta">trust=${escHtml(trust)}</span>`;
  } else if (evt.kind === "page_visited") {
    const target = p.url || p.host || "";
    const short = String(target).replace(/^https?:\/\//, "").slice(0, 48);
    body.innerHTML =
      `<span class="e-ts">${escHtml(ts)}</span>` +
      `<span class="e-actor">${escHtml(nick)}</span> clicked  ` +
      `<span class="e-tail">${escHtml(short || "—")}</span>`;
  } else {
    return null;
  }
  row.append(dot, body);
  row.dataset.eventKind = evt.kind;
  row.tabIndex = 0;
  row.addEventListener("click", () => selectEventRow(row, evt));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectEventRow(row, evt);
    }
  });
  return row;
}

function selectEventRow(row, evt) {
  const list = document.getElementById("events-panel-list");
  // Click-the-selected-row-again toggles off.
  if (row.classList.contains("selected")) {
    row.classList.remove("selected");
    clearDetail();
    return;
  }
  if (list) {
    for (const sib of list.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  row.classList.add("selected");
  renderEventDetail(evt);
}

function clearDetail() {
  const el = document.getElementById("detail");
  if (!el) return;
  el.innerHTML = "";
  const list = document.getElementById("events-panel-list");
  if (list) {
    for (const sib of list.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
}

// Esc closes whatever's in the detail pane.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const el = document.getElementById("detail");
    if (el && el.innerHTML.trim()) clearDetail();
  }
});

function _wireCloseButton(el) {
  el.querySelector(".ed-close")?.addEventListener("click", () => clearDetail());
}

function renderEventDetail(evt) {
  const el = document.getElementById("detail");
  if (!el) return;
  const p = evt.payload || {};
  const pubkey = p.contributor || "";
  const peer = srwk.peers.get(pubkey);
  const color = peer?.signature_color || (pubkey ? stableHue(pubkey) : "#7D8AAB");
  const nick = peer?.nickname || p.nickname || (pubkey ? `peer-${pubkey.slice(0, 8)}` : "—");
  const ts = new Date(evt.ts).toLocaleString();
  const pkShort = pubkey ? `${pubkey.slice(0, 14)}…${pubkey.slice(-6)}` : "—";

  if (evt.kind === "contribution_merged") {
    const pages = Array.isArray(p.pages) ? p.pages : [];
    const pc = p.page_count ?? pages.length;
    const sr = p.result_count ?? 0;
    const pageRows = pages.length
      ? pages.map((pg) => {
          const url = pg?.url || "";
          const title = (pg?.title || url).slice(0, 120);
          const host = pg?.host || "";
          return `<li class="ed-page">
            <a href="#" class="ed-page-link" data-url="${escHtml(url)}" title="${escHtml(url)}">${escHtml(title)}</a>
            <span class="ed-page-host">${escHtml(host)}</span>
          </li>`;
        }).join("")
      : '<li class="ed-empty">no pages — search-results-only slice</li>';
    el.innerHTML = `
      <button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>
      <div class="d-title">${escHtml(nick)} merged a slice</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span>
        <span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">pubkey</span><span class="v" title="${escHtml(pubkey)}"><code style="font-size:10px">${escHtml(pkShort)}</code></span>
        <span class="k">pages</span><span class="v">+${pc}</span>
        <span class="k">results</span><span class="v">+${sr}</span>
      </div>
      <div class="ed-section-title">pages in slice</div>
      <ul class="ed-page-list">${pageRows}</ul>
    `;
    el.querySelectorAll(".ed-page-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const url = a.dataset.url;
        if (!url) return;
        if (window.api?.openExternal) window.api.openExternal(url);
        else window.open(url, "_blank");
      });
    });
    _wireCloseButton(el);
  } else if (evt.kind === "peer_joined") {
    const trust = p.trust_level || "untrusted";
    const freq = peer?.signature_freq;
    el.innerHTML = `
      <button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>
      <div class="d-title">${escHtml(nick)} joined</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span>
        <span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">pubkey</span><span class="v" title="${escHtml(pubkey)}"><code style="font-size:10px">${escHtml(pkShort)}</code></span>
        <span class="k">trust</span><span class="v">${escHtml(trust)}</span>
        <span class="k">color</span><span class="v"><code style="color:${color}">${escHtml(color)}</code></span>
        ${freq ? `<span class="k">tone</span><span class="v">${freq.toFixed(1)} Hz</span>` : ""}
      </div>
    `;
    _wireCloseButton(el);
  } else if (evt.kind === "page_visited") {
    const url = p.url || "";
    const host = p.host || (() => { try { return new URL(url).host; } catch { return ""; } })();
    el.innerHTML = `
      <button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>
      <div class="d-title">${escHtml(nick)} clicked</div>
      <div class="d-host">${escHtml(host)}</div>
      <div class="d-actions">
        <button class="d-btn primary" data-act="open">open ↗</button>
        <button class="d-btn" data-act="copy-url">copy url</button>
      </div>
      <div class="d-grid">
        <span class="k">when</span><span class="v">${escHtml(ts)}</span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
      </div>
    `;
    el.querySelector('[data-act="open"]')?.addEventListener("click", () => {
      if (window.api?.openExternal) window.api.openExternal(url);
      else window.open(url, "_blank");
    });
    el.querySelector('[data-act="copy-url"]')?.addEventListener("click", () => {
      navigator.clipboard?.writeText(url).catch(() => {});
    });
    _wireCloseButton(el);
  }
}

function formatEventTs(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

// "10s ago", "2m ago", "yesterday" — terse, lowercase, are.na-flavored.
function formatPeerLastSeen(secsAgo) {
  if (!isFinite(secsAgo) || secsAgo < 0) return "—";
  if (secsAgo < 5) return "just now";
  if (secsAgo < 60) return `${Math.round(secsAgo)}s ago`;
  if (secsAgo < 3600) return `${Math.round(secsAgo / 60)}m ago`;
  if (secsAgo < 86400) return `${Math.round(secsAgo / 3600)}h ago`;
  if (secsAgo < 86400 * 2) return "yesterday";
  return `${Math.round(secsAgo / 86400)}d ago`;
}

// ─── interaction ──────────────────────────────────────────────────────────

function onNodeClick(n) {
  n.last_visited = new Date().toISOString();
  applyDimensions(n, srwk.lens);
  renderDetailPanel(n);
  if (n.x != null && srwk.G) {
    const d = 90;
    const len = Math.hypot(n.x, n.y, n.z) || 1;
    const r = 1 + d / len;
    srwk.G.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 1100);
  }
}

function renderDetailPanel(n) {
  const el = document.getElementById("detail");
  if (!el) return;
  const cid = n.content_cid || null;
  const visited = n.last_visited ? new Date(n.last_visited).toLocaleString() : "—";

  // Resolve every contributor and build a multi-dot row.
  const contribIds = (n.contributors && n.contributors.length)
    ? n.contributors
    : (n.primary_contributor ? [n.primary_contributor] : []);
  const contribsHtml = contribIds.length
    ? contribIds.map((pk) => {
        const p = srwk.peers.get(pk);
        const color = p?.signature_color || stableHue(pk);
        const label = p?.nickname || pk.slice(0, 10);
        const isPrimary = pk === n.primary_contributor;
        return `<span class="d-contrib${isPrimary ? " primary" : ""}" title="${escHtml(label)}${isPrimary ? " · first to contribute" : ""}">
          <span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>
          ${escHtml(label)}
        </span>`;
      }).join("")
    : '<span class="v">—</span>';
  const overlapBadge = contribIds.length >= 2
    ? `<div class="d-overlap">↔ shared by ${contribIds.length} peers</div>`
    : "";

  // Issue #43 PR D: "scraped from" row. When the page came from a
  // peer pull, show who and color it with their signature_color.
  // Self-fetched rows get a neutral cyan dot + "self" label. The
  // server emits is_self / source_pubkey / source_label per node.
  let scrapedHtml = "";
  if (n.is_self === true) {
    scrapedHtml = `<div class="d-scraped is-self">
      <span class="sc-dot" style="background:#5AE6E6;color:#5AE6E6"></span>
      <span>self</span>
    </div>`;
  } else if (n.source_pubkey) {
    const peer = srwk.peers?.get(n.source_pubkey);
    const color = peer?.signature_color || stableHue(n.source_pubkey);
    const label = n.source_label || peer?.nickname ||
                  n.source_pubkey.slice(0, 12);
    const scrapedAt = n.scraped_at
      ? new Date(n.scraped_at).toLocaleString() : "";
    scrapedHtml = `<div class="d-scraped" title="${escHtml(scrapedAt || n.source_pubkey)}">
      <span class="sc-dot" style="background:${color};color:${color}"></span>
      <span>scraped from ${escHtml(label)}</span>
    </div>`;
  }

  el.innerHTML = `
    <div class="d-title" title="${escHtml(n.title || n.id)}">${escHtml((n.title || n.id).slice(0, 160))}</div>
    <div class="d-host">${escHtml(n.host || "")}</div>
    ${scrapedHtml}
    <div class="d-actions">
      <button class="d-btn primary" data-act="open">open ↗</button>
      <button class="d-btn" data-act="copy-url">copy url</button>
      ${cid ? `<button class="d-btn" data-act="copy-cid">copy cid</button>` : ""}
    </div>
    <div class="d-grid">
      <span class="k">topic</span><span class="v">${escHtml(n.topic || "—")}</span>
      <span class="k">degree</span><span class="v">${n.degree || 0}</span>
      <span class="k">contrib</span>
      <span class="v d-contrib-list">${contribsHtml}</span>
      <span class="k">last seen</span><span class="v">${escHtml(visited)}</span>
    </div>
    ${overlapBadge}
    ${cid ? `<div class="d-cid"><span class="k">cid</span><code class="v" title="${cid}">${cid.slice(0, 14)}…${cid.slice(-6)}</code></div>` : ""}
  `;
  el.querySelector('[data-act="open"]')?.addEventListener("click", () => {
    if (window.api?.openExternal) window.api.openExternal(n.id);
    else window.open(n.id, "_blank");
  });
  el.querySelector('[data-act="copy-url"]')?.addEventListener("click", () => {
    navigator.clipboard?.writeText(n.id).catch(() => {});
  });
  el.querySelector('[data-act="copy-cid"]')?.addEventListener("click", () => {
    if (cid) navigator.clipboard?.writeText(cid).catch(() => {});
  });
}

// ─── procedural textures ──────────────────────────────────────────────────

function makeSpriteTex() {
  // Hard core + soft falloff. The opaque inner disc is what the eye locks
  // onto on a large display — without it, bloom looks like fog. This is
  // the Pixar/teamLab/Refik recipe: a 1-2px solid white pixel at the
  // center, with a Gaussian-soft falloff around it.
  const SIZE = 256;
  const c = document.createElement("canvas"); c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  // Tight pinpoint core. The previous version had a wide soft falloff
  // (alpha 0.18 at 30% radius) which meant overlapping cores in dense
  // regions blended into a soft glow. Now: hard 8% disc + extremely
  // narrow falloff that drops to zero by 22% radius, so 400 packed
  // sprites read as 400 distinct dots instead of one cyan blob.
  const g = ctx.createRadialGradient(SIZE/2, SIZE/2, 0, SIZE/2, SIZE/2, SIZE/2);
  g.addColorStop(0,    "rgba(255,255,255,0.85)");
  g.addColorStop(0.08, "rgba(255,255,255,0.55)");
  g.addColorStop(0.18, "rgba(255,255,255,0.10)");
  g.addColorStop(0.28, "rgba(255,255,255,0.00)");
  g.addColorStop(1,    "rgba(255,255,255,0.00)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = "rgba(255,255,255,1.0)";
  ctx.beginPath();
  ctx.arc(SIZE/2, SIZE/2, SIZE * 0.08, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
function makeHaloTex() {
  const SIZE = 512;
  const c = document.createElement("canvas"); c.width = c.height = SIZE;
  const ctx = c.getContext("2d");
  const g = ctx.createRadialGradient(SIZE/2, SIZE/2, 0, SIZE/2, SIZE/2, SIZE/2);
  g.addColorStop(0,    "rgba(255,255,255,0.32)");
  g.addColorStop(0.15, "rgba(255,255,255,0.18)");
  g.addColorStop(0.40, "rgba(255,255,255,0.06)");
  g.addColorStop(0.75, "rgba(255,255,255,0.02)");
  g.addColorStop(1,    "rgba(255,255,255,0.00)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, SIZE, SIZE);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ─── atmospheric dust-mote field ──────────────────────────────────────────
// 3000 particles in a large volume around the graph. Slow rotation. The
// motes are very dim and very small individually; together they produce
// the perception of "this knowledge sits inside a larger deep-space field"
// rather than "this graph floats in a flat indigo void."

function buildAtmosphere(scene) {
  const N = 3000;
  const RADIUS = 4500;
  const positions = new Float32Array(N * 3);
  const phases    = new Float32Array(N);
  const sizes     = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // sample inside a sphere (cube-root for uniform volume distribution)
    const u = Math.random();
    const r = RADIUS * Math.cbrt(u);
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    positions[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    phases[i] = Math.random() * Math.PI * 2;
    sizes[i]  = 0.6 + Math.random() * 1.6;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
  geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uTime:       { value: 0 },
      uPixelRatio: { value: window.devicePixelRatio || 1 },
    },
    vertexShader: `
      attribute float aPhase;
      attribute float aSize;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vTwinkle;
      void main() {
        vTwinkle = 0.55 + 0.45 * sin(uTime * 0.4 + aPhase);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * uPixelRatio * (220.0 / max(0.001, -mv.z));
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying float vTwinkle;
      void main() {
        vec2 p = gl_PointCoord * 2.0 - 1.0;
        float r = dot(p, p);
        if (r > 1.0) discard;
        float core = exp(-r * 5.0);
        vec3 col = vec3(0.42, 0.55, 0.95) * core * vTwinkle;
        gl_FragColor = vec4(col, core * vTwinkle * 0.42);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -10;
  scene.add(pts);
  srwk.atmosphere = { points: pts, mat };
  // animate via requestAnimationFrame so it drifts even when sim is paused
  const t0 = performance.now();
  let _atmoArmed = false;
  function tick() {
    // Don't schedule when the document is hidden — keeps the GPU + main
    // thread idle when SROS is in the background. Re-armed on
    // visibilitychange below.
    if (document.hidden) { _atmoArmed = false; return; }
    const t = (performance.now() - t0) / 1000;
    mat.uniforms.uTime.value = t;
    pts.rotation.y = t * 0.012;
    pts.rotation.x = Math.sin(t * 0.005) * 0.05;
    requestAnimationFrame(tick);
  }
  _atmoArmed = true;
  requestAnimationFrame(tick);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !_atmoArmed) {
      _atmoArmed = true;
      requestAnimationFrame(tick);
    }
  });
}

// ─── tiny helpers ─────────────────────────────────────────────────────────

function escHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Coerce a (possibly object) SSE field into something a detail row can safely
// render. Without this, anywhere we did `escHtml(p.foo)` would emit
// `[object Object]` when the server changed a field from a string to a
// structured block (e.g. `peer` on slice_scraped). Behaviour:
//   primitives     → String(v) (or em-dash for null/undefined)
//   arrays/objects → JSON.stringify (compact form, used as inline tooltip
//                    text or for the generic dump path)
function formatValue(v) {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Pull a "pubkey-ish" identifier from the heterogeneous peer-id fields the
// server emits. `slice_scraped` carries a `peer` object; `contribution_merged`
// carries `contributor` (string); `peer_joined` carries `contributor` too;
// `mdns_*` events have neither. Always returns a string (possibly empty).
function pickPeerPubkey(p) {
  if (!p) return "";
  // /node/log v0.12.0 events carry the pubkey on `peer_pubkey`. Check
  // it first so peer_unreachable / manifest_fetched / mdns_* events
  // resolve to a real peer (otherwise pickPeerNickname falls through
  // to the literal string "system" and the e-meta renders garbage).
  if (typeof p.peer_pubkey === "string" && p.peer_pubkey) return p.peer_pubkey;
  if (typeof p.contributor === "string" && p.contributor) return p.contributor;
  if (p.peer && typeof p.peer === "object" && typeof p.peer.pubkey === "string") return p.peer.pubkey;
  if (typeof p.peer === "string") return p.peer;
  if (typeof p.pubkey === "string") return p.pubkey;
  if (p.peer && typeof p.peer === "object" && typeof p.peer.contributor === "string") return p.peer.contributor;
  return "";
}

// Pull a human-friendly nickname from heterogeneous payloads. Falls through
// to the peers map by pubkey, then to a short-pubkey label.
function pickPeerNickname(p, pubkey, peer) {
  if (peer?.nickname) return peer.nickname;
  if (p?.nickname) return p.nickname;
  if (p?.peer && typeof p.peer === "object" && typeof p.peer.nickname === "string") return p.peer.nickname;
  if (pubkey) return `peer-${String(pubkey).slice(0, 8)}`;
  return "system";
}

// Pull a signature_color when the server piggybacked one onto the event.
function pickPeerColor(p) {
  if (p?.peer && typeof p.peer === "object" && typeof p.peer.signature_color === "string") {
    return p.peer.signature_color;
  }
  if (typeof p?.signature_color === "string") return p.signature_color;
  return "";
}
function setStatus(text, error = false) {
  const el = document.getElementById("status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("error", !!error);
  el.style.opacity = text ? "1" : "0";
}

// ─── traffic panel (separate from events panel) ──────────────────────────
// Subscribes to the same SSE stream but renders only the protocol/network
// kinds (slice_*, mdns_*, zeroconf_*). Filter chips at the top scope the
// visible rows. Click a row → render the kind-specific detail in the
// shared .detail pane (same pattern as the events panel).

const TRAFFIC_LS_KEY = "srwk:traffic:collapsed";
const TRAFFIC_MAX_ROWS = 50;
const TRAFFIC_AGED_AFTER = 15;
const trafficState = {
  pending: [],
  flushScheduled: false,
  total: 0,
  pulseTimer: null,
  collapsed: true,
  filter: "all",
};

// Map kind → filter category. v0.12.0+ node-log events carry an explicit
// `category` field; the table below is the fallback for SSE events that
// don't and for filter-chip semantics (chip "all"/"sync"/"mdns"/... maps
// straight to this category column). Order in the index.html chip bar:
//   ALL · SYNC · MDNS · HEALTH · INGEST · SEARCH · ERROR
const TRAFFIC_KIND_GROUP = {
  // sync — Phase 2 record sync over /sync/*.
  manifest_fetched: "sync",
  pulled: "sync",
  applied_local: "sync",
  tick: "sync",
  // mdns — peer discovery.
  mdns_peer_appeared: "mdns",
  mdns_peer_disappeared: "mdns",
  mdns_discovered: "mdns",
  mdns_evicted: "mdns",
  zeroconf_revived: "mdns",
  // health — reachability probes.
  peer_unreachable: "health",
  peer_reachable: "health",
  // ingest — non-sync record / page ingest.
  scraper_pulled: "ingest",
  bundle_pulled: "ingest",
  contribution_merged: "ingest",
  slice_scraped: "ingest",
  // error — anything that should always show on the ERROR chip.
  scraper_error: "error",
  slice_scrape_error: "error",
  slice_size_rejected: "error",
  // search — local + remote query traffic.
  web_search_started: "search",
  web_search_completed: "search",
  // vestigial (SPEC v0.3 DC-net family) — keep so the rows still render
  // if a future daemon emits them, but they don't get a dedicated chip
  // anymore. Bucketed under sync so they at least surface somewhere.
  dcnet_round_started: "sync",
  dcnet_round_complete: "sync",
  anonymity_set_changed: "sync",
  ticket_issued: "sync",
  ticket_redeemed: "sync",
  receipt_submitted: "sync",
  epoch_rotated: "sync",
  slice_skipped_self: "ingest",
  slice_replay_dropped: "ingest",
};
function trafficGroupFor(kind) { return TRAFFIC_KIND_GROUP[kind] || "ingest"; }
function trafficIsError(kind) {
  return kind === "scraper_error"
      || kind === "slice_scrape_error"
      || kind === "slice_size_rejected";
}

// Color for the leading dot per kind. Reuses the existing palette tokens
// (--neon-cyan + the hex stops already in this file) so we don't expand
// the swatch vocabulary.
const TRAFFIC_DOT = {
  // sync — neon cyan family
  manifest_fetched: "#5AF0FF",
  pulled: "#5AF0FF",
  applied_local: "#7CFFAA",
  tick: "rgba(220,232,255,0.42)",
  // mdns — green
  mdns_peer_appeared: "#7CFFAA",
  mdns_peer_disappeared: "#FFA960",
  mdns_discovered: "#7CFFAA",
  mdns_evicted: "#FFA960",
  zeroconf_revived: "#C798FF",
  // health
  peer_unreachable: "#FF7BD0",
  peer_reachable: "#7CFFAA",
  // ingest
  scraper_pulled: null, // peer color
  bundle_pulled: null,  // peer color
  contribution_merged: null,
  slice_scraped: null,
  // search
  web_search_started: "#C798FF",
  web_search_completed: "#FF4FE6",
  // error
  scraper_error: "#FF7BD0",
  slice_scrape_error: "#FF7BD0",
  slice_size_rejected: "#FF7BD0",
  // vestigial
  slice_skipped_self: "rgba(220,232,255,0.42)",
  slice_replay_dropped: "#FFD16A",
  dcnet_round_started: "#C798FF",
  dcnet_round_complete: "#C798FF",
  anonymity_set_changed: "#5AF0FF",
  ticket_issued: "#FFD16A",
  ticket_redeemed: "#FFD16A",
  receipt_submitted: "#7CFFAA",
  epoch_rotated: "#FF4FE6",
};

function wireTrafficPanel() {
  const panel = document.getElementById("traffic-panel");
  const head = document.getElementById("traffic-panel-head");
  const list = document.getElementById("traffic-panel-list");
  const bar = document.getElementById("traffic-filter-bar");
  if (!panel || !head || !list || !bar) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(TRAFFIC_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    trafficState.collapsed = collapsed;
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  if (!list.firstChild) {
    const empty = document.createElement("div");
    empty.className = "events-empty";
    empty.id = "traffic-empty";
    empty.textContent = "the wire is quiet.";
    list.appendChild(empty);
  }
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(TRAFFIC_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".traffic-chip");
    if (!btn) return;
    const f = btn.dataset.filter || "all";
    trafficState.filter = f;
    for (const c of bar.querySelectorAll(".traffic-chip")) {
      c.classList.toggle("selected", c.dataset.filter === f);
    }
    applyTrafficFilter();
  });
}

function applyTrafficFilter() {
  const list = document.getElementById("traffic-panel-list");
  if (!list) return;
  const f = trafficState.filter;
  for (const row of list.children) {
    if (!row.dataset || !row.dataset.eventKind) continue;
    const kind = row.dataset.eventKind;
    // Prefer the explicit category from /node/log payloads when present;
    // fall back to the kind→group lookup for SSE events that don't ship a
    // category field.
    const cat = row.dataset.eventCategory || trafficGroupFor(kind);
    let show = false;
    if (f === "all") show = true;
    else if (f === "error") show = trafficIsError(kind) || cat === "error";
    else show = cat === f;
    row.style.display = show ? "" : "none";
  }
}

function appendTrafficEvent(evt) {
  trafficState.pending.push(evt);
  if (trafficState.pending.length > TRAFFIC_MAX_ROWS * 4) {
    trafficState.pending.splice(0, trafficState.pending.length - TRAFFIC_MAX_ROWS * 4);
  }
  if (!trafficState.flushScheduled) {
    trafficState.flushScheduled = true;
    requestAnimationFrame(flushTrafficEvents);
  }
}

function flushTrafficEvents() {
  trafficState.flushScheduled = false;
  const batch = trafficState.pending;
  trafficState.pending = [];
  if (!batch.length) return;
  const list = document.getElementById("traffic-panel-list");
  if (!list) return;
  const empty = document.getElementById("traffic-empty");
  if (empty) empty.remove();
  for (const evt of batch) {
    const row = buildTrafficRow(evt);
    if (!row) continue;
    list.insertBefore(row, list.firstChild);
    requestAnimationFrame(() => row.classList.remove("enter"));
  }
  while (list.childElementCount > TRAFFIC_MAX_ROWS) {
    list.removeChild(list.lastElementChild);
  }
  const rows = list.children;
  for (let i = 0; i < rows.length; i++) {
    rows[i].classList.toggle("aged", i >= TRAFFIC_AGED_AFTER);
  }
  trafficState.total += batch.length;
  const counter = document.getElementById("traffic-panel-count");
  if (counter) {
    counter.textContent = String(trafficState.total);
    counter.classList.add("pulse");
    if (trafficState.pulseTimer) clearTimeout(trafficState.pulseTimer);
    trafficState.pulseTimer = setTimeout(() => counter.classList.remove("pulse"), 480);
  }
  applyTrafficFilter();
}

function buildTrafficRow(evt) {
  const row = document.createElement("div");
  row.className = `events-row enter kind-${evt.kind}`;
  const dot = document.createElement("span");
  dot.className = "e-dot";
  const body = document.createElement("span");
  body.className = "e-body";
  const ts = formatEventTs(evt.ts);
  const p = evt.payload || {};
  // SSE event payload shapes vary: `slice_scraped` ships a `peer` OBJECT
  // (pubkey/nickname/signature_color), while `contribution_merged` ships a
  // flat `contributor` string. pickPeerPubkey collapses both into a string.
  const pubkey = pickPeerPubkey(p);
  const peer = pubkey ? srwk.peers.get(pubkey) : null;
  let dotColor = TRAFFIC_DOT[evt.kind];
  if (dotColor === null || dotColor === undefined) {
    dotColor = peer?.signature_color
      || pickPeerColor(p)
      || (pubkey ? stableHue(pubkey) : "rgba(220,232,255,0.42)");
  }
  dot.style.background = dotColor;
  dot.style.boxShadow = `0 0 6px ${dotColor}`;
  const nick = pickPeerNickname(p, pubkey, peer);

  let summaryHtml = "";
  let bar = null;
  if (evt.kind === "slice_scraped") {
    const np = p.pages_added ?? p.page_count ?? 0;
    const sr = p.results_added ?? p.result_count ?? 0;
    const took = p.took_ms ?? p.duration_ms ?? 0;
    summaryHtml =
      `<span class="e-meta">+${np}p +${sr}sr</span>` +
      ` · <span class="e-tail">${took}ms</span> · ` +
      `<span class="e-actor">${escHtml(nick)}</span>`;
    bar = document.createElement("span");
    bar.className = "e-bar";
    // log scale: 500ms full width = 60px
    const px = Math.max(4, Math.min(60, Math.log10(Math.max(1, took)) / Math.log10(500) * 60));
    bar.style.width = `${px}px`;
  } else if (evt.kind === "slice_scrape_error") {
    const errType = p.error_type || p.kind || "error";
    const consec = p.consecutive_errors ?? p.errors ?? 1;
    summaryHtml =
      `<span class="e-meta">${escHtml(errType)}</span> · ` +
      `<span class="e-actor">${escHtml(nick)}</span> · ` +
      `<span class="e-tail">err #${consec}</span>`;
  } else if (evt.kind === "slice_skipped_self") {
    const url = p.url || p.peer_url || "";
    summaryHtml =
      `<span class="e-meta">self-loop</span> · ` +
      `<span class="e-tail">${escHtml(String(url).slice(0, 56))}</span>`;
  } else if (evt.kind === "slice_replay_dropped") {
    const root = p.slice_root || p.slice_root_prefix || "";
    const prefix = String(root).slice(0, 12);
    const merged = p.existing_merged_at ? Date.parse(p.existing_merged_at) : null;
    const ageMs = merged ? Math.max(0, Date.now() - merged) : null;
    const ageStr = ageMs == null ? "" : `${Math.round(ageMs / 60000)}m ago`;
    summaryHtml =
      `<span class="e-meta">replay</span> · ` +
      `<span class="e-tail">${escHtml(prefix)}${ageStr ? ` · merged ${escHtml(ageStr)}` : ""}</span>`;
  } else if (evt.kind === "slice_size_rejected") {
    // Server emits pages_count + cap_hit (not page_count / cap); accept
    // both spellings so older payloads still render.
    const pages = p.pages_count ?? p.page_count ?? p.pages ?? "?";
    const cap = p.cap_hit ?? p.cap ?? p.limit ?? "—";
    summaryHtml =
      `<span class="e-meta">size cap</span> · ` +
      `<span class="e-tail">${escHtml(String(pages))} pages · ${escHtml(String(cap))}</span>`;
  } else if (evt.kind === "mdns_discovered") {
    const name = p.name || p.nickname || "—";
    const url = p.url || p.endpoint || "";
    summaryHtml =
      `<span class="e-meta">+ ${escHtml(name)}</span> · ` +
      `<span class="e-tail">${escHtml(String(url).replace(/^https?:\/\//, "").slice(0, 36))}</span>`;
  } else if (evt.kind === "mdns_evicted") {
    const name = p.name || p.nickname || "—";
    const errs = p.consecutive_errors ?? p.errors ?? 0;
    summaryHtml =
      `<span class="e-meta">− ${escHtml(name)}</span> · ` +
      `<span class="e-tail">after ${errs} err${errs === 1 ? "" : "s"}</span>`;
  } else if (evt.kind === "zeroconf_revived") {
    const silent = p.silent_for_secs ?? p.silent_secs ?? 0;
    summaryHtml =
      `<span class="e-meta">rebuilt</span> · ` +
      `<span class="e-tail">after ${escHtml(String(silent))}s silent</span>`;
  } else if (evt.kind === "dcnet_round_started") {
    const setSize = p.anonymity_set_size ?? "?";
    const min = p.min_set_met === false ? " ⚠" : "";
    summaryHtml =
      `<span class="e-meta">round ▶ ${escHtml(String(setSize))}${escHtml(min)}</span> · ` +
      `<span class="e-tail">${escHtml(String(p.qid || "").slice(0, 12))}</span>`;
  } else if (evt.kind === "dcnet_round_complete") {
    const took = p.took_ms ?? 0;
    const status = p.status || "ok";
    summaryHtml =
      `<span class="e-meta">round ${escHtml(status)} ${escHtml(String(took))}ms</span> · ` +
      `<span class="e-tail">${escHtml(String(p.responder_count ?? 0))} responders</span>`;
  } else if (evt.kind === "ticket_issued") {
    summaryHtml =
      `<span class="e-meta">+${escHtml(String(p.count ?? 0))} ${escHtml(formatValue(p.family || "tickets"))}</span> · ` +
      `<span class="e-tail">epoch ${escHtml(formatValue(p.epoch_id || "?"))}</span>`;
  } else if (evt.kind === "ticket_redeemed") {
    const ok = p.accepted === false ? "rejected" : "redeemed";
    // formatValue collapses a structured `scope` ({circle_id,qhash}) into
    // a JSON snippet instead of "[object Object]".
    summaryHtml =
      `<span class="e-meta">${escHtml(formatValue(p.family || "ticket"))} ${escHtml(ok)}</span> · ` +
      `<span class="e-tail">scope=${escHtml(formatValue(p.scope ?? "—"))}</span>`;
  } else if (evt.kind === "receipt_submitted") {
    summaryHtml =
      `<span class="e-meta">${escHtml(formatValue(p.receipt_class || "receipt"))}</span> · ` +
      `<span class="e-tail">${escHtml(formatValue(p.delivery || "—"))} · ${escHtml(formatValue(p.provider_pubkey_short || "—"))}</span>`;
  } else if (evt.kind === "anonymity_set_changed") {
    const met = p.met === true;
    summaryHtml =
      `<span class="e-meta">circle ${escHtml(String(p.active_peer_count ?? "?"))}/${escHtml(String(p.min_anonymity_set ?? "?"))} ${met ? "✓" : "⚠"}</span>`;
  } else if (evt.kind === "epoch_rotated") {
    summaryHtml =
      `<span class="e-meta">epoch ▶ ${escHtml(String(p.new_epoch_id || "?"))}</span> · ` +
      `<span class="e-tail">q=${escHtml(String(p.query_quota ?? 0))} r=${escHtml(String(p.receipt_quota ?? 0))}</span>`;
  } else if (evt.kind === "web_search_completed") {
    // /node/log shape: {hit_count, duration_ms, query_hash}. SSE shape:
    // {delivery_path, attempts[]}. Render whichever fields are present so
    // both wires read meaningfully.
    if (p.hit_count != null || p.duration_ms != null) {
      const hits = p.hit_count ?? 0;
      const took = p.duration_ms ?? 0;
      const qh = p.query_hash ? `${String(p.query_hash).slice(0, 10)}…` : "";
      summaryHtml =
        `<span class="e-meta">${hits} hit${hits === 1 ? "" : "s"}</span> · ` +
        `<span class="e-tail">${took}ms${qh ? ` · ${escHtml(qh)}` : ""}</span>`;
    } else {
      const dp = p.delivery_path || "—";
      const att = Array.isArray(p.attempts) ? p.attempts.length : 0;
      summaryHtml =
        `<span class="e-meta">${escHtml(dp)}</span> · ` +
        `<span class="e-tail">${escHtml(String(att))} attempt${att === 1 ? "" : "s"}</span>`;
    }
  // ─── /node/log v0.12.0 event kinds ──────────────────────────────────
  } else if (evt.kind === "manifest_fetched") {
    const n = p.record_count != null ? String(p.record_count) : "?";
    const peerName = truncPeerName(p.peer_name || nick);
    summaryHtml =
      `<span class="e-meta">manifest from ${escHtml(peerName)}</span> · ` +
      `<span class="e-tail">${escHtml(n)} record${n === "1" ? "" : "s"}</span>`;
  } else if (evt.kind === "pulled") {
    const peerName = truncPeerName(p.peer_name || nick);
    const rid = truncRecordId(p.record_id || "");
    summaryHtml =
      `<span class="e-meta">pulled ${escHtml(rid)}</span> · ` +
      `<span class="e-tail">from ${escHtml(peerName)}</span>`;
  } else if (evt.kind === "applied_local") {
    const rid = truncRecordId(p.record_id || "");
    summaryHtml =
      `<span class="e-meta">applied_local</span> · ` +
      `<span class="e-tail">${escHtml(rid)}</span>`;
  } else if (evt.kind === "tick") {
    const v = p.visited || 0;
    const pl = p.pulled || 0;
    const ap = p.applied || 0;
    const took = p.duration_ms != null ? `${p.duration_ms}ms` : "";
    summaryHtml =
      `<span class="e-meta">sync tick</span> · ` +
      `<span class="e-tail">visited ${v} · ${pl} pulled · ${ap} applied${took ? ` · ${escHtml(took)}` : ""}</span>`;
  } else if (evt.kind === "peer_unreachable") {
    const peerName = truncPeerName(p.peer_name || nick);
    const reason = p.reason ? String(p.reason).slice(0, 24) : "—";
    summaryHtml =
      `<span class="e-meta">${escHtml(peerName)} unreachable</span> · ` +
      `<span class="e-tail">${escHtml(reason)}</span>`;
  } else if (evt.kind === "peer_reachable") {
    const peerName = truncPeerName(p.peer_name || nick);
    summaryHtml =
      `<span class="e-meta">${escHtml(peerName)} back</span>`;
  } else if (evt.kind === "mdns_peer_appeared") {
    const peerName = truncPeerName(p.peer_name || nick);
    const url = String(p.peer_url || "").replace(/^https?:\/\//, "").slice(0, 36);
    summaryHtml =
      `<span class="e-meta">${escHtml(peerName)} discovered</span> · ` +
      `<span class="e-tail">${escHtml(url)}</span>`;
  } else if (evt.kind === "mdns_peer_disappeared") {
    const peerName = truncPeerName(p.peer_name || nick);
    summaryHtml =
      `<span class="e-meta">${escHtml(peerName)} left</span>`;
  } else if (evt.kind === "scraper_pulled") {
    const count = p.count != null ? p.count : "?";
    const kindPulled = p.kind_pulled || "records";
    const peerName = truncPeerName(p.peer_name || nick);
    summaryHtml =
      `<span class="e-meta">scraper · ${escHtml(String(count))} ${escHtml(kindPulled)}</span> · ` +
      `<span class="e-tail">from ${escHtml(peerName)}</span>`;
  } else if (evt.kind === "bundle_pulled") {
    const count = p.bundle_count != null ? p.bundle_count : "?";
    const bytes = p.bytes != null ? formatBytesShort(p.bytes) : "—";
    const peerName = truncPeerName(p.peer_name || nick);
    summaryHtml =
      `<span class="e-meta">bundle · ${escHtml(String(count))}</span> · ` +
      `<span class="e-tail">from ${escHtml(peerName)} · ${escHtml(bytes)}</span>`;
  } else if (evt.kind === "scraper_error") {
    const peerName = truncPeerName(p.peer_name || nick);
    const err = String(p.error || "error").slice(0, 36);
    summaryHtml =
      `<span class="e-meta">scraper error</span> · ` +
      `<span class="e-tail">${escHtml(peerName)} · ${escHtml(err)}</span>`;
  } else if (evt.kind === "web_search_started") {
    const qh = p.query_hash ? `${String(p.query_hash).slice(0, 10)}…` : "";
    summaryHtml =
      `<span class="e-meta">search started</span>${qh ? ` · <span class="e-tail">${escHtml(qh)}</span>` : ""}`;
  } else {
    summaryHtml =
      `<span class="e-meta">${escHtml(evt.kind)}</span>`;
  }

  body.innerHTML = `<span class="e-ts">${escHtml(ts)}</span>` + summaryHtml;
  row.append(dot, body);
  if (bar) row.append(bar);
  row.dataset.eventKind = evt.kind;
  // /node/log emits an explicit category; SSE events fall back to the
  // kind→group lookup table. applyTrafficFilter reads this attribute.
  const explicitCategory = evt._category
    || (evt.payload && typeof evt.payload === "object" ? evt.payload.category : null);
  if (explicitCategory) row.dataset.eventCategory = explicitCategory;
  row.tabIndex = 0;
  row.addEventListener("click", () => selectTrafficRow(row, evt));
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      selectTrafficRow(row, evt);
    }
  });
  return row;
}

function selectTrafficRow(row, evt) {
  const list = document.getElementById("traffic-panel-list");
  if (row.classList.contains("selected")) {
    row.classList.remove("selected");
    clearDetail();
    return;
  }
  if (list) {
    for (const sib of list.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  // Also clear selection in the events panel since they share the detail pane.
  const eList = document.getElementById("events-panel-list");
  if (eList) {
    for (const sib of eList.querySelectorAll(".events-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  row.classList.add("selected");
  renderTrafficDetail(evt);
}

function renderTrafficDetail(evt) {
  const el = document.getElementById("detail");
  if (!el) return;
  const p = evt.payload || {};
  // Use the same field-shape resolver as buildTrafficRow so the detail
  // panel never inherits a stringified `[object Object]` for `peer`.
  const pubkey = pickPeerPubkey(p);
  const peer = pubkey ? srwk.peers.get(pubkey) : null;
  const color = peer?.signature_color
    || pickPeerColor(p)
    || (pubkey ? stableHue(pubkey) : "#7D8AAB");
  const nick = pickPeerNickname(p, pubkey, peer);
  const ts = new Date(evt.ts).toLocaleString();
  const pkShort = pubkey ? `${String(pubkey).slice(0, 14)}…${String(pubkey).slice(-6)}` : "—";
  const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;

  // Per-kind layouts; everything else falls through to the generic dump.
  if (evt.kind === "slice_scraped") {
    const url = p.url || "";
    const np = p.pages_added ?? p.page_count ?? 0;
    const sr = p.results_added ?? p.result_count ?? 0;
    const took = p.took_ms ?? p.duration_ms ?? 0;
    const pageMax = p.page_max ?? p.page_max_cursor ?? "—";
    const srMax = p.sr_max ?? p.sr_max_cursor ?? "—";
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">slice scraped</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span><span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">pubkey</span><span class="v" title="${escHtml(pubkey)}"><code style="font-size:10px">${escHtml(pkShort)}</code></span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
        <span class="k">pages</span><span class="v">+${np}</span>
        <span class="k">results</span><span class="v">+${sr}</span>
        <span class="k">duration</span><span class="v">${took}ms</span>
        <span class="k">page max</span><span class="v"><code style="font-size:10px">${escHtml(String(pageMax))}</code></span>
        <span class="k">sr max</span><span class="v"><code style="font-size:10px">${escHtml(String(srMax))}</code></span>
      </div>
    `;
  } else if (evt.kind === "slice_scrape_error") {
    const url = p.url || "";
    const errType = p.error_type || p.kind || "error";
    // Server emits error_msg; older debug code emitted error/message. Accept
    // all three so a payload-shape change doesn't blank the detail row.
    const msg = p.error_msg || p.error || p.message || p.msg || "";
    const consec = p.consecutive_errors ?? p.errors ?? 1;
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">scrape error</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span><span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">type</span><span class="v">${escHtml(errType)}</span>
        <span class="k">consec</span><span class="v">#${escHtml(String(consec))}</span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
        ${msg ? `<span class="k">msg</span><span class="v" style="word-break:break-word">${escHtml(msg)}</span>` : ""}
      </div>
    `;
  } else if (evt.kind === "slice_replay_dropped") {
    const root = p.slice_root || p.slice_root_prefix || "—";
    const merged = p.existing_merged_at;
    const mergedFmt = merged ? new Date(merged).toLocaleString() : "—";
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">replay dropped</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">peer</span><span class="v"><span class="d-dot" style="background:${color};box-shadow:0 0 8px ${color}"></span>${escHtml(nick)}</span>
        <span class="k">slice root</span><span class="v" style="word-break:break-all"><code style="font-size:10px">${escHtml(root)}</code></span>
        <span class="k">merged</span><span class="v">${escHtml(mergedFmt)}</span>
      </div>
      <div class="ed-section-title">why</div>
      <div class="ed-empty">slice already merged earlier; replay suppressed to avoid double-counting.</div>
    `;
  } else if (evt.kind === "mdns_discovered" || evt.kind === "mdns_evicted") {
    const name = p.name || p.nickname || "—";
    const url = p.url || p.endpoint || "—";
    const errs = p.errors ?? p.consecutive_errors ?? 0;
    const verb = evt.kind === "mdns_discovered" ? "discovered" : "evicted";
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">mdns ${escHtml(verb)}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">name</span><span class="v">${escHtml(name)}</span>
        <span class="k">url</span><span class="v" style="word-break:break-all">${escHtml(url)}</span>
        ${evt.kind === "mdns_evicted" ? `<span class="k">errors</span><span class="v">${errs}</span>` : ""}
      </div>
    `;
  } else if (evt.kind === "zeroconf_revived") {
    const silent = p.silent_for_secs ?? p.silent_secs ?? 0;
    const wiped = p.peers_wiped ?? p.wiped ?? 0;
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">zeroconf revived</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">silent</span><span class="v">${escHtml(String(silent))}s</span>
        <span class="k">wiped</span><span class="v">${escHtml(String(wiped))} peer${wiped === 1 ? "" : "s"}</span>
      </div>
    `;
  } else if (evt.kind === "dcnet_round_started" || evt.kind === "dcnet_round_complete") {
    el.innerHTML = `${closeBtn}` + renderDcnetRoundDetail(evt);
  } else if (evt.kind === "web_search_completed") {
    el.innerHTML = `${closeBtn}` + renderWebSearchDetail(p, ts);
  } else if (evt.kind === "ticket_issued" || evt.kind === "ticket_redeemed") {
    // Wrap every potentially-non-string field in formatValue so a
    // structured `scope` (e.g. {circle, qid}) renders as JSON instead of
    // the literal "[object Object]" we used to emit.
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">${escHtml(evt.kind === "ticket_issued" ? "tickets issued" : "ticket redeemed")}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <div class="d-grid">
        <span class="k">family</span><span class="v">${escHtml(formatValue(p.family))}</span>
        <span class="k">epoch</span><span class="v">${escHtml(formatValue(p.epoch_id))}</span>
        ${p.count != null ? `<span class="k">count</span><span class="v">${escHtml(formatValue(p.count))}</span>` : ""}
        ${p.qid ? `<span class="k">qid</span><span class="v"><code>${escHtml(String(formatValue(p.qid)).slice(0, 24))}</code></span>` : ""}
        ${p.scope != null ? `<span class="k">scope</span><span class="v">${escHtml(formatValue(p.scope))}</span>` : ""}
        ${p.accepted != null ? `<span class="k">accepted</span><span class="v">${p.accepted ? "yes" : "no"}</span>` : ""}
        ${p.issuer_key_id_short ? `<span class="k">issuer</span><span class="v"><code>${escHtml(formatValue(p.issuer_key_id_short))}</code></span>` : ""}
      </div>
    `;
  } else if (evt.kind === "receipt_submitted") {
    el.innerHTML = `${closeBtn}` + renderReceiptDetail(p, ts);
  } else if (evt.kind === "anonymity_set_changed" || evt.kind === "epoch_rotated") {
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">${escHtml(evt.kind.replace(/_/g, " "))}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <pre class="ed-empty" style="white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:10.5px;color:var(--light-3)">${escHtml((() => { try { return JSON.stringify(p, null, 2); } catch { return String(p); } })())}</pre>
    `;
  } else {
    // Generic payload dump
    let dump = "";
    try { dump = JSON.stringify(p, null, 2); } catch { dump = String(p); }
    el.innerHTML = `
      ${closeBtn}
      <div class="d-title">${escHtml(evt.kind)}</div>
      <div class="d-host">${escHtml(ts)}</div>
      <pre class="ed-empty" style="white-space:pre-wrap;word-break:break-word;font-family:var(--font-mono);font-size:10.5px;color:var(--light-3)">${escHtml(dump)}</pre>
    `;
  }
  _wireCloseButton(el);
}

// ─── DC-net-aware UI ──────────────────────────────────────────────────────
//
// SPEC v0.3 LAN_FRIEND_DCNET event-kind contract (consumed from /events SSE).
// `swf-node` does not emit any of these today; every panel below shows its
// empty state until the protocol ships. When events DO arrive, the matching
// state machine takes over the panel rendering. Documenting verbatim so a
// future grep on "dcnet_round_started" finds the consumer.
//
//   dcnet_round_started      {circle_id, epoch_id, round_id, qid, query_hmac,
//                              anonymity_set_size, min_set_met, ts}
//   dcnet_round_complete     {round_id, status (ok|timeout|malformed|insufficient_set),
//                              responder_count, took_ms, results_count}
//   ticket_issued            {family (QUERY_TICKET_V1|RECEIPT_TICKET_V1),
//                              epoch_id, count, issuer_key_id_short}
//   ticket_redeemed          {family, epoch_id, qid, scope, accepted}
//   receipt_submitted        {provider_pubkey_short, receipt_class,
//                              delivery (local_only|direct_provider|
//                                        receipt_board|dcnet_receipt_round),
//                              epoch_id}
//   anonymity_set_changed    {circle_id, active_peer_count, min_anonymity_set, met}
//   epoch_rotated            {circle_id, old_epoch_id, new_epoch_id,
//                              query_quota, receipt_quota}
//   web_search_completed     full SearchResponse (SPEC §11): {qid, query_hmac,
//                              delivery_path, attempts[], privacy_level,
//                              privacy_downgrade?, confirmation_required?,
//                              anonymous_ticket?, active_circle?, ...}
//
// Partial payloads are tolerated everywhere; missing fields → "—".

const ROUTER_LS_KEY = "srwk:router:collapsed";
const TICKETS_LS_KEY = "srwk:tickets:collapsed";
const RECEIPTS_LS_KEY = "srwk:receipts:collapsed";

// Cross-panel state. Each Map is keyed in the obvious way; trimming is light
// because real-world emission rates are low (rounds happen on user query).
const dcnetState = {
  rounds: new Map(),                // round_id → {started, completed, qid, ...}
  responderTicks: new Map(),        // round_id → array of timestamps (currently unused; filled if responder events appear)
  lastSet: null,                    // most recent anonymity_set_changed payload
  lastSetTs: 0,
  lastEpoch: null,                  // most recent epoch_rotated payload
};
const ticketsState = {
  // Track tallies via issued count − redeemed count, scoped to current epoch.
  byFamily: { QUERY_TICKET_V1: { issued: 0, redeemed: 0, quota: 0 },
              RECEIPT_TICKET_V1: { issued: 0, redeemed: 0, quota: 0 } },
  recent: [],                       // ring of last ~30 events for sub-list
  selected: null,                   // family currently expanded into detail pane
};
const receiptsState = {
  byProvider: new Map(),            // pubkey_short → {classes:Map, total, lastTs}
  total: 0,
};
const routerState = {
  recent: [],                       // ring of last 50 web_search_completed
  selected: null,
};

// Stable color palette for receipt providers based on hashed pubkey.
function _providerHue(pkShort) {
  if (!pkShort) return "rgba(220, 232, 255, 0.55)";
  const peer = [...srwk.peers.values()].find(p =>
    typeof p.pubkey === "string" && p.pubkey.startsWith(pkShort));
  return peer?.signature_color || stableHue(pkShort);
}

// ─── anonymity-set indicator ──────────────────────────────────────────────
function wireAnonBadge() {
  const badge = document.getElementById("anon-badge");
  const popover = document.getElementById("anon-popover");
  if (!badge || !popover) return;
  const open = () => {
    badge.setAttribute("aria-expanded", "true");
    popover.hidden = false;
    renderAnonPopover();
  };
  const close = () => {
    badge.setAttribute("aria-expanded", "false");
    popover.hidden = true;
  };
  badge.addEventListener("click", () => popover.hidden ? open() : close());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !popover.hidden) close();
  });
  // Light /health poll to seed the popover with active_circle data when no
  // SSE event has arrived yet. Skipped if we already received a fresh
  // anonymity_set_changed.
  setIntervalVisible(async () => {
    if (Date.now() - dcnetState.lastSetTs < 30000) return;
    try {
      const r = await fetch(`${srwk.serverUrl}/health`);
      if (!r.ok) return;
      const h = await r.json();
      if (h && h.active_circle) {
        // The shape is best-effort; degrade gracefully.
        const ac = h.active_circle;
        if (ac.active_peer_count != null && ac.min_anonymity_set != null) {
          onAnonymitySetChanged({
            circle_id: ac.circle_id,
            active_peer_count: ac.active_peer_count,
            min_anonymity_set: ac.min_anonymity_set,
            met: ac.met ?? (ac.active_peer_count >= ac.min_anonymity_set),
            _from_health: true,
          });
        }
      }
    } catch { /* swallow */ }
  }, 15000);
}

function onAnonymitySetChanged(p) {
  dcnetState.lastSet = p;
  dcnetState.lastSetTs = Date.now();
  renderAnonBadge();
  // Re-render popover live if it's open.
  const pop = document.getElementById("anon-popover");
  if (pop && !pop.hidden) renderAnonPopover();
}

function renderAnonBadge() {
  // Mirror the same state into the prominent network-tab header.
  if (typeof renderNetAnonHeader === "function") renderNetAnonHeader();
  const badge = document.getElementById("anon-badge");
  if (!badge) return;
  const valEl = badge.querySelector(".ab-value");
  const markEl = badge.querySelector(".ab-mark");
  const p = dcnetState.lastSet;
  if (!p || (p.active_peer_count == null && p.min_anonymity_set == null)) {
    badge.dataset.state = "idle";
    if (valEl) valEl.textContent = "idle";
    if (markEl) markEl.textContent = "";
    badge.title = "no DC-net round in flight";
    return;
  }
  const a = p.active_peer_count ?? 0;
  const m = p.min_anonymity_set ?? 0;
  const met = (p.met === true) || (a >= m && m > 0);
  badge.dataset.state = met ? "met" : "unmet";
  if (valEl) valEl.textContent = `${a}/${m}`;
  if (markEl) markEl.textContent = met ? "✓" : "⚠";
  badge.title = met
    ? `LAN_FRIEND_DCNET active · ${a} peers in circle (min ${m})`
    : `LAN_FRIEND_DCNET cannot be reported until min anonymity set is reached (${a}/${m})`;
}

function renderAnonPopover() {
  const pop = document.getElementById("anon-popover");
  if (!pop) return;
  const p = dcnetState.lastSet || {};
  const ep = dcnetState.lastEpoch || {};
  const tk = (k) => p[k] != null ? escHtml(String(p[k])) : "—";
  const epoch = ep.new_epoch_id || ep.epoch_id || p.epoch_id || "—";
  const transport = p.transport_kind || "lan_friend_dcnet_round";
  const claim = p.requester_anonymity_claim || "anonymous_within_lan_circle_query_visible";
  const roster = p.member_roster_commitment || p.roster_commitment;
  const rosterShort = roster ? `${String(roster).slice(0, 14)}…` : "—";
  const a = p.active_peer_count, m = p.min_anonymity_set;
  const met = (p.met === true) || (a != null && m != null && a >= m && m > 0);
  pop.innerHTML = `
    <div class="ap-title">active circle</div>
    <div class="ap-grid">
      <span class="k">circle</span><span class="v">${tk("circle_id")}</span>
      <span class="k">epoch</span><span class="v">${escHtml(String(epoch))}</span>
      <span class="k">members</span><span class="v">${a ?? "—"}/${m ?? "—"} ${met ? "✓" : "⚠"}</span>
      <span class="k">roster</span><span class="v"><code>${escHtml(rosterShort)}</code></span>
      <span class="k">transport</span><span class="v">${escHtml(transport)}</span>
      <span class="k">claim</span><span class="v">${escHtml(claim)}</span>
    </div>
    ${met ? "" : `<div class="ap-warn">LAN_FRIEND_DCNET cannot be reported until min anonymity set is reached.</div>`}
  `;
}

// ─── DC-net round tracking (consumed by traffic-row clicks) ──────────────
function onDcnetRoundStarted(p) {
  if (!p || !p.round_id) return;
  dcnetState.rounds.set(p.round_id, {
    started_at: Date.now(),
    completed_at: null,
    qid: p.qid, query_hmac: p.query_hmac, epoch_id: p.epoch_id,
    circle_id: p.circle_id,
    anonymity_set_size: p.anonymity_set_size,
    min_set_met: p.min_set_met,
    status: null, took_ms: null,
    responder_count: null, results_count: null,
    responder_ticks: [],
  });
  // Trim
  if (dcnetState.rounds.size > 100) {
    const firstKey = dcnetState.rounds.keys().next().value;
    if (firstKey) dcnetState.rounds.delete(firstKey);
  }
}

function onDcnetRoundComplete(p) {
  if (!p || !p.round_id) return;
  const r = dcnetState.rounds.get(p.round_id);
  if (!r) {
    // Round_complete arrived without a started — still record what we know.
    dcnetState.rounds.set(p.round_id, {
      started_at: null,
      completed_at: Date.now(),
      status: p.status,
      took_ms: p.took_ms,
      responder_count: p.responder_count,
      results_count: p.results_count,
      responder_ticks: [],
    });
    return;
  }
  r.completed_at = Date.now();
  r.status = p.status;
  r.took_ms = p.took_ms;
  r.responder_count = p.responder_count;
  r.results_count = p.results_count;
  // Synthesize responder ticks if server didn't emit per-responder events:
  // distribute responder_count evenly across [started_at, completed_at].
  if (r.responder_ticks.length === 0 && r.responder_count && r.took_ms) {
    const n = Math.max(0, Math.min(50, r.responder_count));
    for (let i = 0; i < n; i++) {
      r.responder_ticks.push((i + 1) / (n + 1) * r.took_ms);
    }
  }
}

function renderDcnetRoundDetail(evt) {
  const p = evt.payload || {};
  const roundId = p.round_id;
  const r = roundId ? dcnetState.rounds.get(roundId) : null;
  const ts = new Date(evt.ts).toLocaleString();
  const merged = r || {};
  const took = merged.took_ms ?? p.took_ms ?? 0;
  const responders = merged.responder_count ?? p.responder_count ?? 0;
  const results = merged.results_count ?? p.results_count ?? 0;
  const set = merged.anonymity_set_size ?? p.anonymity_set_size ?? "—";
  const status = merged.status ?? p.status ?? (evt.kind === "dcnet_round_started" ? "in flight" : "—");
  const epoch = merged.epoch_id ?? p.epoch_id ?? "—";
  const qid = merged.qid ?? p.qid ?? "—";
  const qh = merged.query_hmac ?? p.query_hmac ?? "";
  const qhShort = qh ? `${String(qh).slice(0, 12)}…` : "—";

  // Mini-timeline marks: started at 0%, broadcast ~5%, responders distributed,
  // decoded ~95%, complete 100%. All as % of usable width.
  const marks = [];
  marks.push({ pct: 0, label: "started", cls: "" });
  marks.push({ pct: 5, label: "broadcast", cls: "" });
  if (Array.isArray(merged.responder_ticks) && took > 0) {
    for (const t of merged.responder_ticks) {
      const pct = Math.max(6, Math.min(94, (t / Math.max(1, took)) * 100));
      marks.push({ pct, label: "", cls: "responder" });
    }
  }
  marks.push({ pct: 95, label: "decoded", cls: "" });
  marks.push({ pct: 100, label: "complete", cls: "complete" });

  const miniHtml = `
    <div class="dcnet-mini">
      <div class="dcnet-mini-track"></div>
      ${marks.map(m => {
        const labelHtml = m.label ? `<div class="dcnet-mini-label" style="left:${m.pct}%">${escHtml(m.label)}</div>` : "";
        return `${labelHtml}<div class="dcnet-mini-mark ${m.cls}" style="left:${m.pct}%"></div>`;
      }).join("")}
      <div class="dcnet-mini-foot" style="left:100%">${escHtml(String(took))}ms</div>
    </div>
  `;

  // Ticket-redeem confirmation if a ticket_redeemed event matched this qid.
  const matchedTicket = ticketsState.recent.find(e =>
    e.kind === "ticket_redeemed" && e.payload && e.payload.qid === qid);
  const ticketHtml = matchedTicket
    ? `<div class="d-overlap" style="color:var(--neon-cyan);background:rgba(90,240,255,0.05);box-shadow:inset 0 0 0 1px rgba(90,240,255,0.30)">ticket redeemed · ${escHtml(matchedTicket.payload.family || "—")} · ${matchedTicket.payload.accepted === false ? "rejected" : "accepted"}</div>`
    : "";

  return `
    <div class="d-title">DC-net round</div>
    <div class="d-host">${escHtml(ts)} · status=${escHtml(String(status))}</div>
    ${miniHtml}
    <div class="d-grid">
      <span class="k">round</span><span class="v"><code>${escHtml(String(roundId || "—").slice(0, 24))}</code></span>
      <span class="k">qid</span><span class="v"><code>${escHtml(String(qid).slice(0, 24))}</code></span>
      <span class="k">query</span><span class="v"><code>${escHtml(qhShort)}</code></span>
      <span class="k">epoch</span><span class="v">${escHtml(String(epoch))}</span>
      <span class="k">set size</span><span class="v">${escHtml(String(set))}</span>
      <span class="k">responders</span><span class="v">${escHtml(String(responders))}</span>
      <span class="k">results</span><span class="v">${escHtml(String(results))}</span>
      <span class="k">duration</span><span class="v">${escHtml(String(took))}ms</span>
    </div>
    ${ticketHtml}
  `;
}

// ─── tickets state ────────────────────────────────────────────────────────
function _ticketsBucket(family) {
  const fam = family || "QUERY_TICKET_V1";
  if (!ticketsState.byFamily[fam]) {
    ticketsState.byFamily[fam] = { issued: 0, redeemed: 0, quota: 0 };
  }
  return ticketsState.byFamily[fam];
}

function onTicketIssued(p) {
  const fam = p.family || "QUERY_TICKET_V1";
  const b = _ticketsBucket(fam);
  b.issued += Number(p.count || 0);
  b.issuer = p.issuer_key_id_short || b.issuer;
  b.lastIssuedAt = Date.now();
  ticketsState.recent.unshift({ kind: "ticket_issued", payload: p, ts: Date.now() });
  if (ticketsState.recent.length > 30) ticketsState.recent.pop();
  renderTicketsPanel();
}

function onTicketRedeemed(p) {
  const fam = p.family || "QUERY_TICKET_V1";
  const b = _ticketsBucket(fam);
  if (p.accepted !== false) b.redeemed += 1;
  ticketsState.recent.unshift({ kind: "ticket_redeemed", payload: p, ts: Date.now() });
  if (ticketsState.recent.length > 30) ticketsState.recent.pop();
  renderTicketsPanel();
}

function onEpochRotated(p) {
  dcnetState.lastEpoch = p;
  // Reset tallies on rotation; SPEC §27 has tickets scoped to epoch.
  for (const f in ticketsState.byFamily) {
    ticketsState.byFamily[f].issued = 0;
    ticketsState.byFamily[f].redeemed = 0;
  }
  if (p.query_quota != null) _ticketsBucket("QUERY_TICKET_V1").quota = p.query_quota;
  if (p.receipt_quota != null) _ticketsBucket("RECEIPT_TICKET_V1").quota = p.receipt_quota;
  // Reset receipts tally too — they're per-epoch.
  receiptsState.byProvider.clear();
  receiptsState.total = 0;
  renderTicketsPanel();
  renderReceiptsPanel();
  renderAnonPopover();
}

function wireTicketsPanel() {
  const panel = document.getElementById("tickets-panel");
  const head = document.getElementById("tickets-panel-head");
  const body = document.getElementById("tickets-panel-body");
  if (!panel || !head || !body) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(TICKETS_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(TICKETS_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  renderTicketsPanel();
}

function renderTicketsPanel() {
  // v0.1.32: the #tickets-panel slot has been repurposed as the SEARCH
  // summary surface (web_search_completed events). The legacy spec-v0.3
  // ticket-bookkeeping path stays wired so a future dev daemon emitting
  // DC-net events doesn't crash, but its visible output is suppressed —
  // renderNetSearchPanel owns the body now. Comment retained as the
  // record of why this function is a near-no-op.
  if (typeof renderNetSearchPanel === "function") {
    try { renderNetSearchPanel(); } catch {}
  }
  return;
  // eslint-disable-next-line no-unreachable
  const body = document.getElementById("tickets-panel-body");
  const epochTag = document.getElementById("tickets-panel-epoch");
  if (!body) return;
  const ep = dcnetState.lastEpoch;
  const epochId = ep?.new_epoch_id || ep?.epoch_id;
  if (epochTag) epochTag.textContent = epochId ? `e${String(epochId).slice(0, 8)}` : "—";
  const q = ticketsState.byFamily.QUERY_TICKET_V1 || { issued: 0, redeemed: 0, quota: 0 };
  const r = ticketsState.byFamily.RECEIPT_TICKET_V1 || { issued: 0, redeemed: 0, quota: 0 };
  const anyData = (q.issued + q.redeemed + r.issued + r.redeemed) > 0 || ticketsState.recent.length > 0;
  if (!anyData && !epochId) {
    body.innerHTML = `<div class="tk-empty">no epoch yet. dc-net has not woken up.</div>`;
    return;
  }
  const buildBar = (b) => {
    const avail = Math.max(0, (b.quota || 0) - b.redeemed);
    const used = b.quota ? Math.min(100, Math.round((b.redeemed / b.quota) * 100)) : 0;
    return { avail, used, quota: b.quota || 0 };
  };
  const qb = buildBar(q);
  const rb = buildBar(r);
  body.innerHTML = `
    <div class="tk-stat" data-family="QUERY_TICKET_V1">
      <div class="tk-stat-head"><span>query tickets</span><span class="tk-stat-val">${qb.avail} / ${qb.quota || "—"}</span></div>
      <div class="tk-bar"><div class="tk-bar-fill" style="width:${qb.used}%"></div></div>
    </div>
    <div class="tk-stat" data-family="RECEIPT_TICKET_V1">
      <div class="tk-stat-head"><span>receipt tickets</span><span class="tk-stat-val">${rb.avail} / ${rb.quota || "—"}</span></div>
      <div class="tk-bar"><div class="tk-bar-fill" style="width:${rb.used}%"></div></div>
    </div>
    <div class="tk-list">
      ${ticketsState.recent.length === 0
        ? `<div class="tk-empty">no ticket events yet</div>`
        : ticketsState.recent.slice(0, 10).map(e => {
            const ts = formatEventTs(e.ts);
            const fam = e.payload?.family || "—";
            const cls = e.kind === "ticket_redeemed" ? "kind-ticket_redeemed" : "kind-ticket_issued";
            const act = e.kind === "ticket_redeemed"
              ? (e.payload?.accepted === false ? "rejected" : "redeemed 1")
              : `+${e.payload?.count ?? 0}`;
            return `<div class="tk-row ${cls}"><span class="tk-row-ts">${escHtml(ts)}</span><span class="tk-row-fam">${escHtml(fam)}</span><span class="tk-row-act">${escHtml(act)}</span></div>`;
          }).join("")
      }
    </div>
  `;
  body.querySelectorAll(".tk-stat").forEach(el => {
    el.addEventListener("click", () => {
      const fam = el.dataset.family;
      ticketsState.selected = fam;
      body.querySelectorAll(".tk-stat").forEach(s => s.classList.toggle("selected", s === el));
      renderTicketDetail(fam);
    });
  });
}

function renderTicketDetail(family) {
  const el = document.getElementById("detail");
  if (!el) return;
  const b = ticketsState.byFamily[family] || {};
  const ep = dcnetState.lastEpoch || {};
  const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;
  const lastIssued = b.lastIssuedAt ? new Date(b.lastIssuedAt).toLocaleString() : "—";
  el.innerHTML = `
    ${closeBtn}
    <div class="d-title">${escHtml(family)}</div>
    <div class="d-host">epoch ${escHtml(String(ep.new_epoch_id || ep.epoch_id || "—"))}</div>
    <div class="d-grid">
      <span class="k">issued</span><span class="v">${b.issued ?? 0}</span>
      <span class="k">redeemed</span><span class="v">${b.redeemed ?? 0}</span>
      <span class="k">quota</span><span class="v">${b.quota ?? "—"}</span>
      <span class="k">issuer</span><span class="v"><code>${escHtml(b.issuer || "—")}</code></span>
      <span class="k">last issuance</span><span class="v">${escHtml(lastIssued)}</span>
      <span class="k">retention</span><span class="v">epoch-scoped (rotates with epoch_rotated)</span>
    </div>
  `;
  _wireCloseButton(el);
}

// ─── receipts state ───────────────────────────────────────────────────────
function onReceiptSubmitted(p) {
  const pk = p.provider_pubkey_short || "unknown";
  let bucket = receiptsState.byProvider.get(pk);
  if (!bucket) {
    bucket = { classes: new Map(), total: 0, lastTs: 0, deliveries: new Map(), lastClass: null, lastDelivery: null, lastEpoch: null };
    receiptsState.byProvider.set(pk, bucket);
  }
  bucket.total += 1;
  bucket.lastTs = Date.now();
  const cls = p.receipt_class || "unspecified";
  bucket.classes.set(cls, (bucket.classes.get(cls) || 0) + 1);
  bucket.lastClass = cls;
  if (p.delivery) {
    bucket.deliveries.set(p.delivery, (bucket.deliveries.get(p.delivery) || 0) + 1);
    bucket.lastDelivery = p.delivery;
  }
  bucket.lastEpoch = p.epoch_id ?? bucket.lastEpoch;
  receiptsState.total += 1;
  renderReceiptsPanel();
}

function wireReceiptsPanel() {
  const panel = document.getElementById("receipts-panel");
  const head = document.getElementById("receipts-panel-head");
  const body = document.getElementById("receipts-panel-body");
  if (!panel || !head || !body) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(RECEIPTS_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(RECEIPTS_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  renderReceiptsPanel();
}

function renderReceiptsPanel() {
  // v0.1.32: #receipts-panel is now the RECORDS summary surface, driven
  // by /sync/manifest. Legacy receipt-bookkeeping path stays present
  // (and accumulates receiptsState for any future dev-injected event)
  // but its visible output is suppressed — renderNetRecordsPanel owns
  // the body.
  if (typeof renderNetRecordsPanel === "function") {
    try { renderNetRecordsPanel(); } catch {}
  }
  return;
  // eslint-disable-next-line no-unreachable
  const body = document.getElementById("receipts-panel-body");
  const counter = document.getElementById("receipts-panel-count");
  if (!body) return;
  if (counter) counter.textContent = String(receiptsState.total);
  if (receiptsState.byProvider.size === 0) {
    body.innerHTML = `<div class="tk-empty">no receipts yet. they appear when peers serve receipt-eligible results.</div>`;
    return;
  }
  const rows = [...receiptsState.byProvider.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 20)
    .map(([pk, b]) => {
      const color = _providerHue(pk);
      const classBreakdown = [...b.classes.entries()]
        .map(([c, n]) => `${c}=${n}`).join(" · ");
      const score = b.total; // bounded reputation hint
      return `<div class="rc-row" data-pk="${escHtml(pk)}">
        <span class="rc-dot" style="background:${color};box-shadow:0 0 6px ${color}"></span>
        <div class="rc-mid">
          <span class="rc-pk"><code>${escHtml(pk)}</code></span>
          <span class="rc-classes">${escHtml(classBreakdown || "—")}</span>
        </div>
        <span class="rc-score">${score}</span>
      </div>`;
    });
  body.innerHTML = `
    <div class="rc-totals">epoch total: <span class="rc-total-val">${receiptsState.total}</span> receipt${receiptsState.total === 1 ? "" : "s"}</div>
    ${rows.join("")}
  `;
  body.querySelectorAll(".rc-row").forEach(el => {
    el.addEventListener("click", () => {
      const pk = el.dataset.pk;
      body.querySelectorAll(".rc-row").forEach(r => r.classList.toggle("selected", r === el));
      renderProviderDetail(pk);
    });
  });
}

function renderProviderDetail(pk) {
  const el = document.getElementById("detail");
  if (!el) return;
  const b = receiptsState.byProvider.get(pk);
  if (!b) return;
  const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;
  const lastTs = b.lastTs ? new Date(b.lastTs).toLocaleString() : "—";
  const peer = [...srwk.peers.values()].find(p =>
    typeof p.pubkey === "string" && p.pubkey.startsWith(pk));
  const fullPk = peer?.pubkey || pk;
  const classes = [...b.classes.entries()].map(([c, n]) => `${c}=${n}`).join(", ");
  el.innerHTML = `
    ${closeBtn}
    <div class="d-title">provider · ${escHtml(pk)}</div>
    <div class="d-host">${escHtml(lastTs)}</div>
    <div class="d-grid">
      <span class="k">pubkey</span><span class="v"><code style="font-size:10px">${escHtml(fullPk)}</code></span>
      <span class="k">total</span><span class="v">${b.total}</span>
      <span class="k">classes</span><span class="v">${escHtml(classes || "—")}</span>
      <span class="k">last delivery</span><span class="v">${escHtml(b.lastDelivery || "—")}</span>
      <span class="k">last epoch</span><span class="v">${escHtml(String(b.lastEpoch ?? "—"))}</span>
      <span class="k">last accepted</span><span class="v">${escHtml(lastTs)}</span>
      <span class="k">service proof</span><span class="v"><code>—</code></span>
    </div>
    <div class="ap-warn" style="margin-top:12px">anonymous receipts are bounded reputation hints, not proof of correctness</div>
  `;
  _wireCloseButton(el);
}

function renderReceiptDetail(p, ts) {
  // formatValue guards every field — receipts have grown new optional
  // structured sub-blocks (verification, policy) that used to render as
  // "[object Object]" before this hardening.
  return `
    <div class="d-title">receipt submitted</div>
    <div class="d-host">${escHtml(ts)}</div>
    <div class="d-grid">
      <span class="k">provider</span><span class="v"><code>${escHtml(formatValue(p.provider_pubkey_short))}</code></span>
      <span class="k">class</span><span class="v">${escHtml(formatValue(p.receipt_class))}</span>
      <span class="k">delivery</span><span class="v">${escHtml(formatValue(p.delivery))}</span>
      <span class="k">epoch</span><span class="v">${escHtml(formatValue(p.epoch_id))}</span>
      ${p.verification != null ? `<span class="k">verification</span><span class="v"><pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:10.5px;margin:0">${escHtml(JSON.stringify(p.verification, null, 2))}</pre></span>` : ""}
      ${p.policy != null ? `<span class="k">policy</span><span class="v"><pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:10.5px;margin:0">${escHtml(JSON.stringify(p.policy, null, 2))}</pre></span>` : ""}
    </div>
    <div class="ap-warn" style="margin-top:12px">anonymous receipts are bounded reputation hints, not proof of correctness</div>
  `;
}

// ─── router panel (replaces v0.3 stub) ───────────────────────────────────
function onWebSearchCompleted(p) {
  routerState.recent.unshift({ payload: p, ts: Date.now() });
  if (routerState.recent.length > 50) routerState.recent.pop();
  renderRouterPanel();
}

function wireRouterPanel() {
  const panel = document.getElementById("router-panel");
  const head = document.getElementById("router-panel-head");
  const body = document.getElementById("router-panel-body");
  if (!panel || !head || !body) return;
  let collapsed = true;
  try {
    const v = localStorage.getItem(ROUTER_LS_KEY);
    if (v === "false") collapsed = false;
  } catch {}
  const apply = () => {
    panel.dataset.collapsed = collapsed ? "true" : "false";
    head.setAttribute("aria-expanded", collapsed ? "false" : "true");
  };
  apply();
  head.addEventListener("click", () => {
    collapsed = !collapsed;
    try { localStorage.setItem(ROUTER_LS_KEY, collapsed ? "true" : "false"); } catch {}
    apply();
  });
  renderRouterPanel();
}

function renderRouterPanel() {
  // v0.1.32: #router-panel is now the SYNC summary line, driven by
  // /node/log + /sync/manifest. renderNetRouterStatus owns the body;
  // the legacy router-flow inspector path is suppressed.
  if (typeof renderNetRouterStatus === "function") {
    try { renderNetRouterStatus(); } catch {}
  }
  return;
  // eslint-disable-next-line no-unreachable
  const body = document.getElementById("router-panel-body");
  const counter = document.getElementById("router-panel-count");
  if (!body) return;
  if (counter) counter.textContent = routerState.recent.length ? String(routerState.recent.length) : "v0.3";
  if (routerState.recent.length === 0) {
    body.innerHTML = `<div class="router-empty">the router is quiet. it will speak once SPEC v0.3 ships.</div>`;
    return;
  }
  body.innerHTML = routerState.recent.slice(0, 12).map((e, idx) => {
    const p = e.payload || {};
    const ts = formatEventTs(e.ts);
    const dp = p.delivery_path || "—";
    const pl = p.privacy_level || "none";
    const att = Array.isArray(p.attempts) ? p.attempts : [];
    const dots = att.slice(0, 6).map(a => {
      const ok = a?.outcome === "delivered" || a?.outcome === "ok" || a?.delivered;
      const fail = a?.outcome === "error" || a?.outcome === "failed" || a?.outcome === "policy_denied";
      const cls = ok ? "ok" : fail ? "fail" : "skip";
      return `<span class="rr-dot ${cls}" title="${escHtml(a?.path_kind || a?.kind || "")}"></span>`;
    }).join("");
    const qh = p.query_hmac ? `${String(p.query_hmac).slice(0, 10)}…` : (p.qid ? `${String(p.qid).slice(0, 10)}…` : "—");
    return `<div class="router-row" data-idx="${idx}">
      <span class="rr-ts">${escHtml(ts)}</span>
      <span class="rr-dots">${dots}</span>
      <span class="rr-q"><code>${escHtml(qh)}</code> · ${escHtml(dp)}</span>
      <span class="rr-badge" data-pl="${escHtml(pl)}">${escHtml(pl.replace(/_/g, " "))}</span>
    </div>`;
  }).join("");
  body.querySelectorAll(".router-row").forEach(el => {
    el.addEventListener("click", () => {
      const idx = parseInt(el.dataset.idx, 10);
      const e = routerState.recent[idx];
      if (!e) return;
      body.querySelectorAll(".router-row").forEach(r => r.classList.toggle("selected", r === el));
      const eldetail = document.getElementById("detail");
      if (eldetail) {
        const closeBtn = `<button class="ed-close" type="button" aria-label="close" title="close (Esc)">✕</button>`;
        const ts = new Date(e.ts).toLocaleString();
        eldetail.innerHTML = `${closeBtn}` + renderWebSearchDetail(e.payload, ts);
        _wireCloseButton(eldetail);
      }
    });
  });
}

function renderWebSearchDetail(p, ts) {
  if (!p) p = {};
  const dp = p.delivery_path || "—";
  const pl = p.privacy_level || "none";
  const att = Array.isArray(p.attempts) ? p.attempts : [];
  // Render the attempt chain as a vertical flow. If no attempts, render a
  // synthetic one-step chain (just the delivery_path) so the structure
  // shows even on partial payloads.
  const steps = att.length ? att : [{ path_kind: dp, outcome: "delivered" }];
  const stepHtml = steps.map((a, i) => {
    const name = a?.path_kind || a?.kind || `step ${i + 1}`;
    const out = a?.outcome || (i === steps.length - 1 ? "delivered" : "skip");
    const ok = out === "delivered" || out === "ok";
    const fail = out === "error" || out === "failed" || out === "policy_denied" || out === "rejected";
    const cls = (ok ? "ok " : fail ? "fail " : "skip ") + (name === dp && i === steps.length - 1 ? "delivered" : "");
    const dur = a?.took_ms ?? a?.duration_ms;
    // `reason` and `error` may arrive as objects (e.g. {code, message}); pass
    // them through formatValue so a structured field never produces literal
    // "[object Object]" text in the chain.
    const reason = formatValue(a?.reason || a?.error || "");
    return `<li class="flow-step ${cls}">
      <span class="fs-icon"></span>
      <span><span class="fs-name">${escHtml(formatValue(name))}</span>${reason && reason !== "—" ? `<br><span class="fs-meta">${escHtml(reason)}</span>` : ""}</span>
      <span class="fs-meta">${dur != null ? `${escHtml(String(dur))}ms` : escHtml(formatValue(out))}</span>
    </li>`;
  }).join("");

  const qh = p.query_hmac ? `${String(p.query_hmac).slice(0, 16)}…` : "—";
  const qid = p.qid ? `${String(p.qid).slice(0, 16)}…` : "—";
  const downgrade = p.privacy_downgrade
    ? `<div class="flow-warn">privacy_downgrade=true · this query was reported with a less-private path than originally claimed</div>`
    : "";
  const confirm = p.confirmation_required
    ? `<div class="flow-confirm">confirmation_required · awaiting user approval before egress (${escHtml(formatValue(p.confirmation_reason || "policy gate"))})</div>`
    : "";
  const ticket = p.anonymous_ticket
    ? `<div class="ed-section-title">anonymous ticket</div>
       <div class="d-grid">
         <span class="k">family</span><span class="v">${escHtml(p.anonymous_ticket.family || "—")}</span>
         <span class="k">epoch</span><span class="v">${escHtml(String(p.anonymous_ticket.epoch_id || "—"))}</span>
         <span class="k">scope</span><span class="v">${escHtml(p.anonymous_ticket.scope || "—")}</span>
       </div>` : "";
  const circle = p.active_circle
    ? `<div class="ed-section-title">active circle</div>
       <div class="d-grid">
         <span class="k">circle</span><span class="v"><code>${escHtml(String(p.active_circle.circle_id || "—"))}</code></span>
         <span class="k">members</span><span class="v">${escHtml(String(p.active_circle.active_peer_count ?? "—"))}/${escHtml(String(p.active_circle.min_anonymity_set ?? "—"))}</span>
         <span class="k">transport</span><span class="v">${escHtml(p.active_circle.transport_kind || "—")}</span>
       </div>` : "";

  return `
    <div class="d-title">web_search_completed</div>
    <div class="d-host">${escHtml(ts)} · ${escHtml(dp)}</div>
    ${downgrade}${confirm}
    <div class="d-grid">
      <span class="k">qid</span><span class="v"><code>${escHtml(qid)}</code></span>
      <span class="k">query</span><span class="v"><code>${escHtml(qh)}</code></span>
      <span class="k">privacy</span><span class="v"><span class="rr-badge" data-pl="${escHtml(pl)}">${escHtml(pl.replace(/_/g, " "))}</span></span>
      <span class="k">delivery</span><span class="v">${escHtml(dp)}</span>
    </div>
    <div class="ed-section-title">attempt chain</div>
    <ul class="flow-chain">${stepHtml}</ul>
    ${ticket}${circle}
  `;
}

// ─── wire-style timeline (bottom of graph) ────────────────────────────────
// Per-peer swimlanes spanning the last 60s of traffic. Each event = a tick
// mark, x-positioned by age (newest on right), y-positioned by lane.
// Ring-buffered to ~500 ticks across all lanes.

const TIMELINE_LS_KEY = "srwk:timeline:visible";
const TIMELINE_WINDOW_MS = 60000;
const TIMELINE_MAX_TICKS = 500;
const SYSTEM_LANE_KEY = "__system__";

const timelineState = {
  visible: true,
  buffer: [],            // ring of {ts, kind, pubkey, payload, color, took}
  rafScheduled: false,
  hoveredEvent: null,
};

function wireTimeline() {
  const strip = document.getElementById("timeline-strip");
  const toggle = document.getElementById("timeline-toggle");
  if (!strip || !toggle) return;
  let visible = true;
  try {
    const v = localStorage.getItem(TIMELINE_LS_KEY);
    if (v === "false") visible = false;
  } catch {}
  const apply = () => {
    timelineState.visible = visible;
    strip.setAttribute("aria-hidden", visible ? "false" : "true");
    toggle.setAttribute("aria-pressed", visible ? "true" : "false");
  };
  apply();
  toggle.addEventListener("click", () => {
    visible = !visible;
    try { localStorage.setItem(TIMELINE_LS_KEY, visible ? "true" : "false"); } catch {}
    apply();
    if (visible) scheduleTimelineRender();
  });
  // Render on every animation frame so ticks march left smoothly.
  function tick() {
    if (timelineState.visible) renderTimeline();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function pushTimelineTick(evt) {
  const p = evt.payload || {};
  // `slice_scraped` carries `peer` as an object; pickPeerPubkey + pickPeerColor
  // unify all event shapes so the timeline lane key is always a string and
  // never the literal text "[object Object]".
  const pubkey = pickPeerPubkey(p);
  const peer = pubkey ? srwk.peers.get(pubkey) : null;
  let color;
  if (TRAFFIC_DOT[evt.kind] && evt.kind !== "slice_scraped" && evt.kind !== "contribution_merged") {
    color = TRAFFIC_DOT[evt.kind];
  } else if (peer?.signature_color) {
    color = peer.signature_color;
  } else if (pickPeerColor(p)) {
    color = pickPeerColor(p);
  } else if (pubkey) {
    color = stableHue(pubkey);
  } else {
    color = "rgba(220, 232, 255, 0.55)";
  }
  const took = (evt.kind === "slice_scraped")
    ? (p.took_ms ?? p.duration_ms ?? 0)
    : 0;
  timelineState.buffer.push({
    ts: evt.ts || Date.now(),
    kind: evt.kind,
    pubkey: pubkey || SYSTEM_LANE_KEY,
    payload: p,
    color,
    took,
    evt,
  });
  if (timelineState.buffer.length > TIMELINE_MAX_TICKS) {
    timelineState.buffer.splice(0, timelineState.buffer.length - TIMELINE_MAX_TICKS);
  }
  scheduleTimelineRender();
}

function scheduleTimelineRender() {
  if (timelineState.rafScheduled) return;
  timelineState.rafScheduled = true;
  requestAnimationFrame(() => {
    timelineState.rafScheduled = false;
    if (timelineState.visible) renderTimeline();
  });
}

function renderTimeline() {
  const lanesEl = document.getElementById("timeline-lanes");
  const strip = document.getElementById("timeline-strip");
  if (!lanesEl || !strip) return;
  const now = Date.now();
  const cutoff = now - TIMELINE_WINDOW_MS;
  // Drop expired ticks from the ring buffer.
  while (timelineState.buffer.length && timelineState.buffer[0].ts < cutoff) {
    timelineState.buffer.shift();
  }
  // Compute active lanes (peers with at least one tick in window, +
  // a system lane if any system event is present).
  const laneSet = new Map();      // key → label
  let hasSystem = false;
  for (const t of timelineState.buffer) {
    if (t.pubkey === SYSTEM_LANE_KEY) { hasSystem = true; continue; }
    if (!laneSet.has(t.pubkey)) {
      const peer = srwk.peers.get(t.pubkey);
      const label = peer?.nickname || `peer-${String(t.pubkey).slice(0, 6)}`;
      laneSet.set(t.pubkey, label);
    }
  }
  const peerLanes = [...laneSet.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  if (hasSystem) peerLanes.push([SYSTEM_LANE_KEY, "system"]);
  const laneCount = Math.max(1, peerLanes.length);
  const stripH = strip.clientHeight || 80;
  const stripW = strip.clientWidth || 800;
  const padTop = 6, padBot = 6;
  const usable = stripH - padTop - padBot;
  const laneStep = usable / laneCount;
  // Fast clear; with ≤500 nodes this is cheap.
  lanesEl.innerHTML = "";
  // Lane labels + rules
  peerLanes.forEach(([key, label], i) => {
    const y = padTop + laneStep * (i + 0.5);
    const ruler = document.createElement("div");
    ruler.className = "timeline-lane-rule";
    ruler.style.top = `${padTop + laneStep * (i + 1)}px`;
    if (i < peerLanes.length - 1) lanesEl.appendChild(ruler);
    const labelEl = document.createElement("div");
    labelEl.className = "timeline-lane-label";
    labelEl.textContent = label;
    labelEl.style.top = `${y}px`;
    lanesEl.appendChild(labelEl);
  });
  // Map peer key → lane index for tick placement.
  const laneIndex = new Map();
  peerLanes.forEach(([key], i) => laneIndex.set(key, i));
  const labelGutter = 96;
  const usableW = Math.max(40, stripW - labelGutter - 8);
  for (const t of timelineState.buffer) {
    const lane = laneIndex.get(t.pubkey);
    if (lane == null) continue;
    const ageFrac = (now - t.ts) / TIMELINE_WINDOW_MS;  // 0 = now, 1 = oldest
    const x = labelGutter + usableW * (1 - ageFrac);
    const y = padTop + laneStep * (lane + 0.5);
    const tick = document.createElement("div");
    tick.className = `timeline-tick kind-${t.kind}`;
    tick.style.left = `${x}px`;
    tick.style.top = `${y}px`;
    tick.style.background = t.color;
    tick.style.boxShadow = `0 0 8px ${t.color}`;
    // Width: log-scaled by took_ms for slice_scraped (4-22px); fixed 4 otherwise.
    let w = 4;
    if (t.kind === "slice_scraped" && t.took > 0) {
      w = Math.max(4, Math.min(22, 4 + Math.log10(t.took) * 7));
    } else if (t.kind === "contribution_merged") {
      w = 5;
    }
    tick.style.width = `${w}px`;
    // Fade ticks as they march toward the left edge.
    tick.style.opacity = `${(1 - ageFrac * 0.85).toFixed(3)}`;
    tick.dataset.ts = String(t.ts);
    tick.addEventListener("mouseenter", (e) => showTimelineTooltip(t, e.target));
    tick.addEventListener("mouseleave", hideTimelineTooltip);
    tick.addEventListener("click", () => {
      hideTimelineTooltip();
      // Surface the event in the .detail pane via the same pathway as a
      // traffic-row click. This treats traffic + ingest events uniformly.
      if (t.kind === "contribution_merged") {
        // Reuse the events-panel detail renderer.
        renderEventDetail(t.evt);
        // Clear traffic selection if any.
        for (const sib of document.querySelectorAll("#traffic-panel-list .events-row.selected")) {
          sib.classList.remove("selected");
        }
      } else {
        renderTrafficDetail(t.evt);
      }
    });
    lanesEl.appendChild(tick);
  }
}

function showTimelineTooltip(tick, el) {
  const tip = document.getElementById("timeline-tooltip");
  if (!tip) return;
  const peer = srwk.peers.get(tick.pubkey);
  const nick = peer?.nickname || (tick.pubkey === SYSTEM_LANE_KEY ? "system" : `peer-${String(tick.pubkey).slice(0, 6)}`);
  const ts = formatEventTs(tick.ts);
  tip.innerHTML =
    `<span class="tt-kind">${escHtml(tick.kind)}</span> ` +
    `· <span class="tt-peer">${escHtml(nick)}</span>` +
    `<span class="tt-ts">${escHtml(ts)}</span>`;
  tip.hidden = false;
  // Position above the tick.
  const stripRect = document.getElementById("timeline-strip").getBoundingClientRect();
  const tickRect = el.getBoundingClientRect();
  const xRel = tickRect.left + tickRect.width / 2 - stripRect.left;
  tip.style.left = `${Math.round(xRel)}px`;
}

function hideTimelineTooltip() {
  const tip = document.getElementById("timeline-tooltip");
  if (!tip) return;
  tip.hidden = true;
}

// ─── live propagation mini-graph (Network tab) ───────────────────────────
// Self-contained 2D canvas force-graph showing peers as nodes and animating
// pulses along edges as SSE events flow in. Self node sits in the center,
// peers arrange in a circle around it. This is intentionally vanilla canvas
// — the 3d-force-graph bundle is heavy enough that pulling in another
// graph lib for a 280px panel is bad ROI.
//
// State:
//   livegraphState.pulses    — FIFO queue, capped at LIVEGRAPH_MAX_PULSES
//   livegraphState.mode      — "live" | "replay" — replay reads
//                              trafficState ring + timelineState.buffer and
//                              re-emits edges over LIVEGRAPH_REPLAY_MS.
//   livegraphState.layout    — Map<pubkey, {x, y, ang}>
//
// Dispatch is glued in via a one-line call from the SSE traffic handler in
// subscribeEvents (see `livegraphPushFromEvent`), so adding a new event
// kind to the propagation graph is a single switch-case here.

const LIVEGRAPH_MAX_PULSES = 50;
const LIVEGRAPH_PULSE_DURATION = 850;     // ms — feels alive but not laggy
const LIVEGRAPH_REPLAY_MS = 10000;        // 60s of traffic → 10s replay
const LIVEGRAPH_REPLAY_WINDOW = 60000;    // how far back to replay

const LIVEGRAPH_PULSE_KIND = {
  // dir: "in" → peer→self · "out" → self→peer · "ext" → self→external
  slice_scraped:        { color: "#5CFFAB", dir: "in"  }, // soft green
  contribution_merged:  { color: "#9DFFD8", dir: "in"  }, // bright green
  ingest_arrived:       { color: "#9DFFD8", dir: "in"  },
  ingest_merged:        { color: "#9DFFD8", dir: "in"  },
  slice_scrape_error:   { color: "#FF7BD0", dir: "in"  }, // red/pink
  web_search_completed: { color: "#FFB35C", dir: "out" }, // orange
  web_search_requested: { color: "#FFB35C", dir: "out" },
  page_visited:         { color: "#FFE26B", dir: "out" }, // amber
};

const livegraphState = {
  canvas: null,
  ctx: null,
  tooltip: null,
  empty: null,
  pulses: [],                         // {fromKey,toKey,color,start,duration,ext?,opaqueAt?}
  layout: new Map(),                  // pubkey → {x,y,ang} (logical coords)
  selfPing: 0,                        // performance.now() of last self ping
  peerPings: new Map(),               // pubkey → performance.now() (mdns_discovered)
  // Per-peer reachability from /node/log health events. true / false /
  // undefined. drawLiveGraph fades unreachable dots to 40% alpha.
  peerReachable: new Map(),
  mode: "live",
  rafId: 0,
  visible: false,                     // canvas in active tab
  hoveredKey: null,
  replayTokens: [],                   // [{atMs, fn}] — pending replay enqueues
  replayStartedAt: 0,
};

// /node/log → live network viz. Subset of kinds drive subtle pulses:
//   manifest_fetched → bright self/peer ping (peer's dot enlarges briefly)
//   pulled           → thin line peer→self with the peer's color
//   peer_unreachable → fade the peer's dot to 40% opacity
//   peer_reachable   → restore opacity
function livegraphPushFromNodeLog(evt) {
  if (!evt || !evt.kind) return;
  const pubkey = evt.peer_pubkey;
  switch (evt.kind) {
    case "manifest_fetched":
      if (pubkey) {
        livegraphState.peerPings.set(pubkey, performance.now());
        livegraphState.selfPing = performance.now();
      }
      break;
    case "pulled":
      if (pubkey) {
        const color = srwk.peers.get(pubkey)?.signature_color || stableHue(pubkey);
        livegraphState.pulses.push({
          fromKey: pubkey,
          toKey: "__self__",
          color,
          start: performance.now(),
          duration: 1000,
          kind: "pulled",
        });
        if (livegraphState.pulses.length > LIVEGRAPH_MAX_PULSES) {
          livegraphState.pulses.splice(0, livegraphState.pulses.length - LIVEGRAPH_MAX_PULSES);
        }
        livegraphState.selfPing = performance.now();
      }
      break;
    case "peer_unreachable":
    case "mdns_peer_disappeared":
      if (pubkey) livegraphState.peerReachable.set(pubkey, false);
      break;
    case "peer_reachable":
    case "mdns_peer_appeared":
      if (pubkey) {
        livegraphState.peerReachable.set(pubkey, true);
        livegraphState.peerPings.set(pubkey, performance.now());
      }
      recomputeLayout();
      break;
    default:
      // ignore everything else; the SSE path covers slice/dcnet kinds.
      break;
  }
}

function wireLiveGraph() {
  const canvas = document.getElementById("livegraph-canvas");
  if (!canvas) return;
  livegraphState.canvas = canvas;
  livegraphState.ctx = canvas.getContext("2d");
  livegraphState.tooltip = document.getElementById("livegraph-tooltip");
  livegraphState.empty = document.getElementById("livegraph-empty");
  // Mode toggle
  const head = document.querySelector("#livegraph-panel .livegraph-mode");
  if (head) {
    head.addEventListener("click", (e) => {
      const btn = e.target.closest(".livegraph-mode-btn");
      if (!btn) return;
      const m = btn.dataset.mode;
      if (m !== "live" && m !== "replay") return;
      setLiveGraphMode(m);
    });
  }
  // Hover for tooltip — translate canvas coords back to nearest peer.
  canvas.addEventListener("mousemove", onLiveGraphMove);
  canvas.addEventListener("mouseleave", () => {
    livegraphState.hoveredKey = null;
    if (livegraphState.tooltip) livegraphState.tooltip.hidden = true;
  });
  // Resize observer keeps the canvas backing store in sync with CSS size.
  const ro = new ResizeObserver(() => resizeLiveGraph());
  ro.observe(canvas.parentElement || canvas);
  resizeLiveGraph();
  // Steady tick — runs always (cheap when no pulses); the visibility-aware
  // skip is built into the draw fn.
  const loop = () => {
    drawLiveGraph(performance.now());
    livegraphState.rafId = requestAnimationFrame(loop);
  };
  livegraphState.rafId = requestAnimationFrame(loop);
}

function resizeLiveGraph() {
  const c = livegraphState.canvas;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = Math.max(1, Math.round(rect.width * dpr));
  c.height = Math.max(1, Math.round(rect.height * dpr));
  livegraphState.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  recomputeLayout();
}

function setLiveGraphMode(mode) {
  livegraphState.mode = mode;
  const head = document.querySelector("#livegraph-panel .livegraph-mode");
  if (head) {
    for (const b of head.querySelectorAll(".livegraph-mode-btn")) {
      b.classList.toggle("selected", b.dataset.mode === mode);
    }
  }
  if (mode === "replay") startLiveGraphReplay();
}

function recomputeLayout() {
  const c = livegraphState.canvas;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  const cx = w / 2, cy = h / 2;
  const r = Math.max(40, Math.min(cx, cy) - 36);
  const peers = [...srwk.peers.values()].filter(p => p.pubkey);
  // Self always at the center; ranking other peers by stable hash → angle
  // makes the arrangement feel deterministic even as peers come and go.
  livegraphState.layout.clear();
  livegraphState.layout.set("__self__", { x: cx, y: cy, ang: 0, isSelf: true });
  const others = peers.filter(p => p.pubkey !== srwk.selfPubkey);
  const n = Math.max(1, others.length);
  others.forEach((p, i) => {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    livegraphState.layout.set(p.pubkey, {
      x: cx + Math.cos(ang) * r,
      y: cy + Math.sin(ang) * r,
      ang,
    });
  });
}

function livegraphPushFromEvent(evt) {
  const kind = evt?.kind;
  if (!kind) return;
  // ingest_* alias for any ingest-named event we don't know about specifically
  const cfg = LIVEGRAPH_PULSE_KIND[kind] || (kind.startsWith("ingest_") ? LIVEGRAPH_PULSE_KIND.ingest_arrived : null);
  if (!cfg) {
    // mdns_discovered → enlarge the peer node briefly. No pulse.
    if (kind === "mdns_discovered" || kind === "peer_joined") {
      const p = evt.payload || {};
      const pubkey = pickPeerPubkey(p);
      if (pubkey) livegraphState.peerPings.set(pubkey, performance.now());
      // Recompute layout in case this is a brand new peer
      recomputeLayout();
    }
    return;
  }
  const p = evt.payload || {};
  const pubkey = pickPeerPubkey(p);
  let fromKey, toKey, ext = false;
  if (cfg.dir === "in") {
    fromKey = pubkey || null;
    toKey = "__self__";
  } else if (cfg.dir === "out") {
    fromKey = "__self__";
    toKey = pubkey || null;
    if (!toKey) ext = true;
  } else {
    fromKey = "__self__"; toKey = pubkey || null;
  }
  if (!fromKey || (!toKey && !ext)) return;
  const pulse = {
    fromKey, toKey, ext,
    color: cfg.color,
    start: performance.now(),
    duration: LIVEGRAPH_PULSE_DURATION,
    kind,
  };
  livegraphState.pulses.push(pulse);
  // FIFO drop oldest if we exceed the cap — keeps frame budget bounded
  // when ingest bursts produce dozens of events per second.
  if (livegraphState.pulses.length > LIVEGRAPH_MAX_PULSES) {
    livegraphState.pulses.splice(0, livegraphState.pulses.length - LIVEGRAPH_MAX_PULSES);
  }
  if (cfg.dir === "in") livegraphState.selfPing = performance.now();
  if (cfg.dir === "out" && pubkey) livegraphState.peerPings.set(pubkey, performance.now());
}

function startLiveGraphReplay() {
  // Walk the timeline ring buffer + traffic ring; clear current pulses;
  // re-enqueue them spread across LIVEGRAPH_REPLAY_MS. The animation loop
  // doesn't care about wall-clock — it just consumes pulses as they're
  // pushed.
  const now = Date.now();
  const cutoff = now - LIVEGRAPH_REPLAY_WINDOW;
  const buffer = (timelineState && Array.isArray(timelineState.buffer)) ? timelineState.buffer : [];
  const events = buffer.filter(t => t && t.ts >= cutoff && t.evt).map(t => t.evt);
  livegraphState.pulses = [];
  livegraphState.replayStartedAt = performance.now();
  if (events.length === 0) return;
  const span = Math.max(0, (events[events.length - 1].ts || now) - (events[0].ts || cutoff)) || 1;
  const replayStart = performance.now();
  events.forEach((evt) => {
    const frac = ((evt.ts || cutoff) - (events[0].ts || cutoff)) / span;
    const at = replayStart + frac * LIVEGRAPH_REPLAY_MS;
    setTimeout(() => {
      if (livegraphState.mode !== "replay") return;
      livegraphPushFromEvent(evt);
    }, Math.max(0, at - performance.now()));
  });
}

function onLiveGraphMove(e) {
  const c = livegraphState.canvas;
  if (!c) return;
  const rect = c.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  let bestKey = null, bestDist = 18 * 18; // 18px hit radius
  for (const [key, pos] of livegraphState.layout) {
    if (key === "__self__") continue;
    const dx = pos.x - x, dy = pos.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestDist) { bestDist = d; bestKey = key; }
  }
  // Self has a slightly bigger hit area
  const selfPos = livegraphState.layout.get("__self__");
  if (selfPos) {
    const dx = selfPos.x - x, dy = selfPos.y - y;
    if (dx * dx + dy * dy < 22 * 22) bestKey = "__self__";
  }
  livegraphState.hoveredKey = bestKey;
  const tip = livegraphState.tooltip;
  if (!tip) return;
  if (!bestKey) { tip.hidden = true; return; }
  if (bestKey === "__self__") {
    tip.hidden = false;
    tip.textContent = `self · ${(srwk.selfPubkey || "—").slice(0, 14)}…`;
  } else {
    const peer = srwk.peers.get(bestKey);
    const nick = peer?.nickname || `peer-${bestKey.slice(0, 8)}`;
    const pkShort = `${bestKey.slice(0, 14)}…${bestKey.slice(-6)}`;
    tip.hidden = false;
    tip.textContent = `${nick} · ${pkShort}`;
  }
}

function drawLiveGraph(now) {
  const ctx = livegraphState.ctx;
  const c = livegraphState.canvas;
  if (!ctx || !c) return;
  // Cheap visibility skip — when canvas is offscreen (graph tab) we still
  // tick but skip the draw. The pulses still age and expire so the queue
  // stays bounded.
  const rect = c.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    // Still age pulses
    livegraphState.pulses = livegraphState.pulses.filter(p => now - p.start < p.duration);
    return;
  }
  if (!livegraphState.layout.size || livegraphState.layout.size === 1) {
    recomputeLayout();
  }
  const w = rect.width, h = rect.height;
  ctx.clearRect(0, 0, w, h);

  // Empty state: 0 peers besides self
  const peerCount = livegraphState.layout.size - 1;
  if (livegraphState.empty) {
    livegraphState.empty.style.display = peerCount === 0 ? "" : "none";
  }

  // Faint connecting lines (peer ↔ self)
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(180, 200, 255, 0.10)";
  const selfPos = livegraphState.layout.get("__self__");
  if (selfPos) {
    for (const [key, pos] of livegraphState.layout) {
      if (key === "__self__") continue;
      ctx.beginPath();
      ctx.moveTo(selfPos.x, selfPos.y);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    }
  }

  // Pulses: drop expired, draw the rest as moving discs along the edge.
  const livePulses = [];
  for (const pul of livegraphState.pulses) {
    const t = (now - pul.start) / pul.duration;
    if (t >= 1) continue;
    livePulses.push(pul);
    const fromPos = livegraphState.layout.get(pul.fromKey);
    let toPos = livegraphState.layout.get(pul.toKey);
    if (!fromPos) continue;
    if (!toPos && pul.ext) {
      // External destination — synthesize a point off the canvas edge along
      // a fixed direction so self→external pulses still read.
      toPos = { x: w - 12, y: 12 };
    }
    if (!toPos) continue;
    const x = fromPos.x + (toPos.x - fromPos.x) * t;
    const y = fromPos.y + (toPos.y - fromPos.y) * t;
    // Trail: short faded segment behind the head
    ctx.strokeStyle = pul.color;
    ctx.lineWidth = 2.5;
    ctx.globalAlpha = 0.55 * (1 - t);
    ctx.beginPath();
    const trailT = Math.max(0, t - 0.18);
    ctx.moveTo(fromPos.x + (toPos.x - fromPos.x) * trailT, fromPos.y + (toPos.y - fromPos.y) * trailT);
    ctx.lineTo(x, y);
    ctx.stroke();
    // Head dot
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = pul.color;
    ctx.shadowColor = pul.color;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }
  livegraphState.pulses = livePulses;

  // Peer nodes
  for (const [key, pos] of livegraphState.layout) {
    const isSelf = key === "__self__";
    let baseR = isSelf ? 9 : 6;
    let color;
    let offline = false;
    if (isSelf) {
      color = "#FFFFFF";
      // Briefly brighten self when an "in" pulse just arrived
      const pingDt = now - livegraphState.selfPing;
      if (pingDt < 600) baseR += 3 * (1 - pingDt / 600);
    } else {
      const peer = srwk.peers.get(key);
      color = peer?.signature_color || stableHue(key);
      const pingTs = livegraphState.peerPings.get(key);
      if (pingTs && now - pingTs < 800) {
        const f = 1 - (now - pingTs) / 800;
        baseR += 3 * f;
      }
      // Online vs offline (same predicate as the peer list). Offline peers
      // stay on the ring but render as a dim hollow node — present, dark.
      offline = !netPeerStatus(key).online;
    }
    // Hover halo
    if (livegraphState.hoveredKey === key) baseR += 1.5;
    // Outer glow ring on self
    if (isSelf) {
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, baseR + 6, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }
    if (offline) {
      // Hollow, glowless ring — visually distinct from the solid live dots.
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = "rgba(150, 152, 160, 0.85)";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, baseR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1.0;
    } else {
      ctx.fillStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = isSelf ? 14 : 10;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, baseR, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // Counter (non-canvas) — gentle update; the only DOM write per frame
  const counter = document.getElementById("livegraph-count");
  if (counter) {
    const txt = String(peerCount);
    if (counter.textContent !== txt) counter.textContent = txt;
  }
}

// ─── peer-row selection (camera fly + territory pulse) ──────────────────
// Clicking a peer row in the peers panel flies the camera to that peer's
// territory and pulses their nodes' halos for ~2s. Reuses the same
// camera-fly API as onNodeClick so the motion feels uniform.

function _peerCentroid(pubkey) {
  // Prefer the macro anchor (every node has _macroX/Y/Z assigned at
  // computeHierarchicalAnchors). Fall back to live position centroid if
  // anchors aren't yet computed (e.g. first frame).
  let ax = 0, ay = 0, az = 0, n = 0;
  let hasAnchor = false;
  for (const node of srwk.nodes) {
    if (node.primary_contributor !== pubkey) continue;
    if (node._macroX != null) {
      // All nodes for this peer share the same macro anchor; one
      // sample is enough.
      return { x: node._macroX, y: node._macroY, z: node._macroZ, hasAnchor: true };
    }
    if (node.x == null) continue;
    ax += node.x; ay += node.y; az += node.z; n++;
  }
  if (n === 0) return null;
  return { x: ax / n, y: ay / n, z: az / n, hasAnchor };
}

function selectPeerRow(row, peer) {
  const list = document.getElementById("peers-panel-list");
  if (list) {
    for (const sib of list.querySelectorAll(".peer-row.selected")) {
      sib.classList.remove("selected");
    }
  }
  row.classList.add("selected");
  flyToPeerTerritory(peer.pubkey);
}

function flyToPeerTerritory(pubkey) {
  if (!pubkey || !srwk.G) return;
  const c = _peerCentroid(pubkey);
  if (!c) return;
  // Place the camera slightly outside the centroid, looking at it. Same
  // recipe used in onNodeClick.
  const len = Math.hypot(c.x, c.y, c.z) || 1;
  const offset = 320;
  const r = 1 + offset / len;
  srwk.G.cameraPosition(
    { x: c.x * r, y: c.y * r, z: c.z * r },
    { x: c.x, y: c.y, z: c.z },
    1100,
  );
  // Trigger a 2s territory pulse for this peer's nodes; updateNodeRender
  // reads srwk.peerPulse each frame and lerps halo scale up/down.
  srwk.peerPulse = {
    contributor: pubkey,
    start: performance.now(),
    duration: 2000,
  };
}

// ─── search wiring ────────────────────────────────────────────────────────
// Substring filter against title + host + url. Match → keep color, halo
// boost; non-match → opacity drop. Edges + cluster labels dim too. Cmd/Ctrl-F
// focuses; Esc clears. Counter chip shows "N/total" and cycles matches.

const SEARCH_DEBOUNCE_MS = 150;

function wireSearch() {
  const input = document.getElementById("search");
  const counter = document.getElementById("search-counter");
  if (!input) return;
  srwk.search = {
    active: false,
    query: "",
    matchSet: new Set(),
    matchOrder: [],     // ordered list of matching node ids
    cycleIdx: -1,
    debounceTimer: null,
  };
  const apply = () => applySearch(input.value);
  input.addEventListener("input", () => {
    if (srwk.search.debounceTimer) clearTimeout(srwk.search.debounceTimer);
    srwk.search.debounceTimer = setTimeout(apply, SEARCH_DEBOUNCE_MS);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      applySearch("");
      input.blur();
    }
    if (e.key === "Enter" && srwk.search.active && srwk.search.matchOrder.length) {
      e.preventDefault();
      cycleToNextMatch();
    }
  });
  if (counter) {
    counter.addEventListener("click", () => {
      if (!srwk.search.matchOrder.length) return;
      cycleToNextMatch();
    });
  }
  // Global keyboard: Cmd/Ctrl+F focuses. Don't fight when user is in
  // another editable element (we have only the search input today, but
  // future editable surfaces should still take focus precedence).
  document.addEventListener("keydown", (e) => {
    const isModF = (e.metaKey || e.ctrlKey) && (e.key === "f" || e.key === "F");
    if (!isModF) return;
    e.preventDefault();
    input.focus();
    input.select();
  });
  // Esc anywhere on the page clears search if the input has a value.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (srwk.search.active) {
      input.value = "";
      applySearch("");
    }
  });
}

function applySearch(rawQuery) {
  const q = (rawQuery || "").trim().toLowerCase();
  const counter = document.getElementById("search-counter");
  if (!q) {
    srwk.search.active = false;
    srwk.search.query = "";
    srwk.search.matchSet = new Set();
    srwk.search.matchOrder = [];
    srwk.search.cycleIdx = -1;
    if (counter) counter.hidden = true;
    applyEdgeAndLabelDimming();
    return;
  }
  const matches = new Set();
  const order = [];
  for (const n of srwk.nodes) {
    const hay = `${n.title || ""} ${n.host || ""} ${n.id || ""}`.toLowerCase();
    if (hay.includes(q)) {
      matches.add(n.id);
      order.push(n.id);
    }
  }
  srwk.search.active = true;
  srwk.search.query = q;
  srwk.search.matchSet = matches;
  srwk.search.matchOrder = order;
  srwk.search.cycleIdx = -1;
  if (counter) {
    counter.hidden = false;
    counter.textContent = `${order.length} / ${srwk.nodes.length}`;
    counter.classList.toggle("zero", order.length === 0);
  }
  applyEdgeAndLabelDimming();
}

function applyEdgeAndLabelDimming() {
  const G = srwk.G;
  const search = srwk.search;
  // Re-install the search-aware link color callback. 3d-force-graph
  // re-evaluates per-link colors when an accessor is set, so this is
  // how we get edges to refresh. searchAwareLinkColor returns the
  // unmodified base when search is inactive.
  if (G && typeof G.linkColor === "function") {
    G.linkColor((l) => searchAwareLinkColor(l));
  }
  // Labels: dim non-match cluster labels. We compare the cluster's
  // groupKey to whether any matched node belongs to that group.
  const labelMap = srwk.labelMap;
  if (labelMap) {
    let matchGroups = null;
    if (search.active) {
      matchGroups = new Set();
      for (const n of srwk.nodes) {
        if (!search.matchSet.has(n.id)) continue;
        const k = srwk.lens.groupBy(n);
        if (k) matchGroups.add(k);
      }
    }
    for (const [key, sprite] of labelMap) {
      // labels.js fadeLabelsByDistance overrides opacity each frame, so
      // we encode the search dim factor into a userData multiplier and
      // wrap the fade logic. Simpler: just stash a flag, applied below
      // via a frame hook injected in boot's tick.
      sprite.userData._searchDim = matchGroups ? !matchGroups.has(key) : false;
    }
  }
}

function searchAwareLinkColor(l) {
  const base = _linkColor(l);
  const search = srwk.search;
  const sourceFilter = srwk.sourceFilter;
  const searchActive = search && search.active;
  const sourceActive = sourceFilter && sourceFilter.mode !== "all";
  if (!searchActive && !sourceActive) return base;
  const sId = typeof l.source === "object" ? l.source.id : l.source;
  const tId = typeof l.target === "object" ? l.target.id : l.target;
  // A link is "kept" iff its endpoints satisfy BOTH active filters.
  // (When only one filter is active, the other contributes "true" by
  // default — see sourceFilterMatches.)
  const keepBySearch = !searchActive
    || search.matchSet.has(sId) || search.matchSet.has(tId);
  const keepBySource = !sourceActive
    || sourceFilterMatches(sId) || sourceFilterMatches(tId);
  if (keepBySearch && keepBySource) return base;
  if (base.startsWith("rgba(")) return base.replace(/,\s*[0-9.]+\)$/, ", 0.04)");
  if (base.startsWith("rgb("))  return base.replace(/^rgb\(/, "rgba(").replace(/\)$/, ", 0.04)");
  return base;
}

// ─── Issue #43 PR D: source filter (All / Mine / per-peer) ──────────
//
// Source filter is parallel to the search filter: a node passes only
// when BOTH filters keep it. Default state is `mode: "all"` (no-op).
// `mode: "mine"` keeps nodes where `is_self === true` (or, on legacy
// graphs without is_self, where source_pubkey === selfPubkey).
// `mode: "<pubkey>"` keeps nodes from that peer.

function ensureSourceFilterState() {
  if (srwk.sourceFilter) return srwk.sourceFilter;
  srwk.sourceFilter = { mode: "all" };
  return srwk.sourceFilter;
}

function sourceFilterMatches(idOrNode) {
  const sf = srwk.sourceFilter;
  if (!sf || sf.mode === "all") return true;
  const n = (typeof idOrNode === "string")
    ? srwk.nodeMap?.get(idOrNode)
    : idOrNode;
  if (!n) return false;
  if (sf.mode === "mine") {
    if (typeof n.is_self === "boolean") return n.is_self;
    return n.source_pubkey === srwk.selfPubkey ||
           n.primary_contributor === srwk.selfPubkey;
  }
  // mode is a pubkey — match either source_pubkey or primary_contributor.
  return n.source_pubkey === sf.mode || n.primary_contributor === sf.mode;
}

function wireSourceFilter() {
  ensureSourceFilterState();
  const bar = document.getElementById("source-filter-bar");
  if (!bar) return;
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".source-chip");
    if (!btn) return;
    const mode = btn.dataset.source || "all";
    setSourceFilter(mode);
  });
  // Render per-peer chips whenever the peers map changes. Cheap; we
  // call this on the same triggers that drive renderPeersPanel.
  renderSourceFilterChips();
}

function renderSourceFilterChips() {
  const bar = document.getElementById("source-filter-bar");
  if (!bar) return;
  // Drop existing per-peer chips (those past the static "all" + "mine").
  const fixed = bar.querySelectorAll(
    '.source-chip[data-source="all"], .source-chip[data-source="mine"]'
  );
  bar.innerHTML = "";
  fixed.forEach((b) => bar.appendChild(b));
  const peers = (srwk.peers && [...srwk.peers.values()]) || [];
  if (!peers.length) return;
  // Per-peer page counts from the live node set so chips don't show
  // peers with zero pages we've ingested yet.
  const counts = new Map();
  for (const n of (srwk.nodes || [])) {
    const pk = n.source_pubkey || n.primary_contributor;
    if (!pk) continue;
    counts.set(pk, (counts.get(pk) || 0) + 1);
  }
  // Sort: page count desc, then nickname.
  peers.sort((a, b) => {
    if (a.pubkey === srwk.selfPubkey) return -1;  // hide via filter below
    if (b.pubkey === srwk.selfPubkey) return 1;
    const ac = counts.get(a.pubkey) || 0;
    const bc = counts.get(b.pubkey) || 0;
    if (ac !== bc) return bc - ac;
    return (a.nickname || "").localeCompare(b.nickname || "");
  });
  for (const p of peers) {
    if (p.pubkey === srwk.selfPubkey) continue;  // "mine" covers self
    if (!counts.get(p.pubkey)) continue;          // skip empty peers
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "source-chip";
    btn.dataset.source = p.pubkey;
    btn.title = `${p.nickname || p.pubkey.slice(0, 12)}: ${counts.get(p.pubkey)} pages`;
    const dot = document.createElement("span");
    dot.className = "sc-dot";
    dot.style.color = p.signature_color || stableHue(p.pubkey);
    dot.style.background = p.signature_color || stableHue(p.pubkey);
    btn.appendChild(dot);
    btn.appendChild(document.createTextNode(
      (p.nickname || p.pubkey.slice(0, 8)).slice(0, 12)
    ));
    if (srwk.sourceFilter && srwk.sourceFilter.mode === p.pubkey) {
      btn.classList.add("selected");
    }
    bar.appendChild(btn);
  }
}

function setSourceFilter(mode) {
  ensureSourceFilterState();
  srwk.sourceFilter.mode = mode;
  // Reflect selection in the UI.
  const bar = document.getElementById("source-filter-bar");
  if (bar) {
    bar.querySelectorAll(".source-chip").forEach((b) => {
      b.classList.toggle("selected", b.dataset.source === mode);
    });
  }
  // Re-run the dimming pass so non-matching nodes/edges fade out.
  applyEdgeAndLabelDimming();
}

function cycleToNextMatch() {
  const order = srwk.search.matchOrder;
  if (!order.length || !srwk.G) return;
  srwk.search.cycleIdx = (srwk.search.cycleIdx + 1) % order.length;
  const id = order[srwk.search.cycleIdx];
  const n = srwk.nodeMap.get(id);
  if (!n || n.x == null) return;
  const len = Math.hypot(n.x, n.y, n.z) || 1;
  const r = 1 + 90 / len;
  srwk.G.cameraPosition({ x: n.x * r, y: n.y * r, z: n.z * r }, n, 900);
  const counter = document.getElementById("search-counter");
  if (counter) {
    counter.textContent = `${srwk.search.cycleIdx + 1} / ${order.length}`;
  }
}

// Hook into the per-frame label fade pass: if a label was tagged
// _searchDim, multiply its computed opacity by 0.18. Keeps labels.js
// blissfully unaware of search.
const _labelFadeOrig = fadeLabelsByDistance;
function fadeLabelsWithSearch(camera, labelMap) {
  _labelFadeOrig(camera, labelMap);
  if (!srwk.search || !srwk.search.active) return;
  for (const sprite of labelMap.values()) {
    if (sprite.userData?._searchDim) {
      sprite.material.opacity *= 0.18;
    }
  }
}
// Replace the global handle used by tick() to point at our wrapped fn.
// (boot's tick imports fadeLabelsByDistance directly, so we install a
// shim by overriding srwk's tick path: re-bind at the call site.)
srwk._fadeLabels = fadeLabelsWithSearch;

// ─── timeline auto-show on first traffic event ───────────────────────────
// First traffic SSE event after boot auto-shows the timeline, but only
// if the user has never explicitly toggled it (LS key absent). Also
// fades a one-time toast above the toggle so people know what just
// appeared.

const TIMELINE_TOAST_KEY = "srwk:timeline:autoshown";

function maybeAutoShowTimeline() {
  if (srwk._timelineAutoShown) return;
  srwk._timelineAutoShown = true;
  let pref = null;
  try { pref = localStorage.getItem(TIMELINE_LS_KEY); } catch {}
  // Already explicitly set (true or false) → respect it. Only auto-show
  // when the user has never expressed a preference.
  if (pref === "true" || pref === "false") return;
  const strip = document.getElementById("timeline-strip");
  const toggle = document.getElementById("timeline-toggle");
  if (!strip || !toggle) return;
  timelineState.visible = true;
  strip.setAttribute("aria-hidden", "false");
  toggle.setAttribute("aria-pressed", "true");
  try { localStorage.setItem(TIMELINE_LS_KEY, "true"); } catch {}
  showTimelineAutoToast();
}

function showTimelineAutoToast() {
  const toast = document.getElementById("timeline-toast");
  if (!toast) return;
  toast.innerHTML = `<span class="tt-dot"></span>live LAN traffic<span class="tt-arrow"></span>`;
  toast.hidden = false;
  toast.classList.remove("fade");
  setTimeout(() => toast.classList.add("fade"), 4000);
  setTimeout(() => { toast.hidden = true; toast.classList.remove("fade"); }, 4800);
}

// ─── tab bar (atlas | alchemy | network | metrics) ─────────
// ATLAS is the primary tab — the production wall map of the corpus, with
// the network search input embedded in it (search is no longer its own
// top-level tab as of 2026-05-09). The three legacy renderers (graph /
// cartography / cosmos) and the EXPERIMENTAL tab were archived; see
// _archive/experimental/.
const TAB_LS_KEY = "srwk:active_tab";
const NET_SUB_LS_KEY = "srwk:network_sub";
const TOP_TABS = new Set(["alchemy", "apps", "network", "links"]);
const NET_SUBS = new Set(["network", "metrics"]);
const APPS_LS_KEY = "srwk:apps_view";
const APPS_VIEWS = new Set(["atlas", "easel"]);  // grid is the absence of one of these
// router (daybook) is NOT an apps-stage view — it opens as its own pop-out
// window. The apps card / command palette / onboarding deep-link all route here.
const openRouter = () => { try { window.api?.daybook?.openWindow?.(); } catch {} };
// Legacy values older builds wrote to localStorage. Quietly migrate.
function migrateLegacyTab(t) {
  // Top-level atlas tab was folded into the apps grid (2026-05-18). Land
  // the user back on apps→atlas so the muscle memory works.
  if (t === "atlas" || t === "search" || t === "graph" || t === "cartography" || t === "cosmos" || t === "experimental") {
    try { localStorage.setItem(APPS_LS_KEY, "atlas"); } catch {}
    return "apps";
  }
  // Metrics moved into the network tab as a sub-view (2026-05-09).
  if (t === "metrics") {
    try { localStorage.setItem(NET_SUB_LS_KEY, "metrics"); } catch {}
    return "network";
  }
  return null;
}

function wireTabs() {
  const bar = document.getElementById("tab-bar");
  if (!bar) return;
  let initial = "alchemy";
  try {
    const v = localStorage.getItem(TAB_LS_KEY);
    if (v && TOP_TABS.has(v)) {
      initial = v;
    } else if (v) {
      const mig = migrateLegacyTab(v);
      if (mig) {
        initial = mig;
        try { localStorage.setItem(TAB_LS_KEY, mig); } catch {}
      }
    }
  } catch {}
  // Restore the network sub-tab choice so a reload returns to the
  // last sub-view (network or metrics) the user was on.
  try {
    const sub = localStorage.getItem(NET_SUB_LS_KEY);
    if (sub && NET_SUBS.has(sub)) document.body.dataset.netSub = sub;
  } catch {}
  // Restore the apps sub-view (atlas or grid) so reload lands the user
  // back where they were inside the apps tab.
  try {
    const av = localStorage.getItem(APPS_LS_KEY);
    if (av && APPS_VIEWS.has(av)) document.body.dataset.appsView = av;
  } catch {}
  applyActiveTab(initial);
  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".tab-btn");
    if (!btn) return;
    const t = btn.dataset.tab;
    if (!TOP_TABS.has(t)) return;
    if (t === "alchemy" && document.body.dataset.activeTab === "alchemy") {
      if (Alchemy.toggleMembraneMenuFromTopTab()) return;
    }
    // Clicking the apps tab while already inside an app sub-view (atlas/easel)
    // bounces back to the apps grid — a reliable escape when a sub-app is a dead
    // end (e.g. atlas with swf-node down). The tab bar sits outside the sub-app
    // stage, so this works even if the sub-app itself is unresponsive.
    if (t === "apps" && document.body.dataset.activeTab === "apps" && document.body.dataset.appsView) {
      delete document.body.dataset.appsView;
      try { localStorage.removeItem(APPS_LS_KEY); } catch {}
      Alchemy.closeMembraneMenu();
      applyActiveTab("apps");
      return;
    }
    Alchemy.closeMembraneMenu();
    morphActiveTab(t, () => applyActiveTab(t));
    try { localStorage.setItem(TAB_LS_KEY, t); } catch {}
  });

  // Primary-nav (left side panel) — top-level category buttons switch the
  // active tab, same semantics as the (now retired) top tab-bar. The
  // operating-system sub-pages are handled separately below.
  const primaryNav = document.getElementById("primary-nav");
  if (primaryNav) {
    primaryNav.addEventListener("click", (e) => {
      const btn = e.target.closest(".nav-cat[data-tab]");
      if (!btn) return;
      const t = btn.dataset.tab;
      if (!TOP_TABS.has(t)) return;
      if (t === "apps" && document.body.dataset.activeTab === "apps" && document.body.dataset.appsView) {
        delete document.body.dataset.appsView;
        try { localStorage.removeItem(APPS_LS_KEY); } catch {}
        Alchemy.closeMembraneMenu();
        applyActiveTab("apps");
        return;
      }
      Alchemy.closeMembraneMenu();
      morphActiveTab(t, () => applyActiveTab(t));
      try { localStorage.setItem(TAB_LS_KEY, t); } catch {}
    });

    // Operating-system sub-pages (the rail) live in the persistent nav, so
    // they can be clicked from any tab. The per-button mode switch + render
    // is wired inside alchemy.js once mounted; here we only ensure the
    // operating-system tab is the visible one. If alchemy hasn't mounted
    // yet (e.g. the app launched on another tab), persist the requested
    // mode first so the lazy mount lands on the right page.
    const ALCHEMY_MODE_LS_KEY = "srwk:alchemy_mode"; // mirrors alchemy.js
    primaryNav.addEventListener("click", (e) => {
      const railBtn = e.target.closest(".alchemy-rail-btn[data-alch-mode]");
      if (!railBtn) return;
      if (document.body.dataset.activeTab !== "alchemy") {
        const mode = railBtn.dataset.alchMode;
        if (mode) {
          try { Alchemy.applyLocation({ mode, instant: true }); } catch {}
          try { localStorage.setItem(ALCHEMY_MODE_LS_KEY, mode); } catch {}
        }
        morphActiveTab("alchemy", () => applyActiveTab("alchemy"));
        try { localStorage.setItem(TAB_LS_KEY, "alchemy"); } catch {}
      }
    });
  }

  // Network sub-tab nav (network / metrics). Switches in-place — no
  // morph, since both sub-views share the same grid cell anyway.
  const subBar = document.getElementById("network-subtabs");
  if (subBar) {
    subBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".net-subtab");
      if (!btn) return;
      const sub = btn.dataset.netSub;
      if (!NET_SUBS.has(sub)) return;
      setNetworkSub(sub);
    });
  }

  for (const btn of bar.querySelectorAll(".tab-btn")) {
    magnetize(btn, { strength: 4, dampen: 0.35 });
  }
  mountTabIndicator();
}

// Apps tab landing — wires the grid's app cards (data-app-key) and the
// "← apps" back-bar that ships inside each app sub-view. Set/clear
// body[data-apps-view] so the visibility CSS does the rest.
function wireAppsGrid() {
  document.addEventListener("click", (e) => {
    const card = e.target.closest("[data-app-key]");
    if (card) {
      const key = card.dataset.appKey;
      // router opens as a pop-out window, not an apps-stage sub-view.
      if (key === "daybook") { openRouter(); return; }
      if (!APPS_VIEWS.has(key)) return;
      document.body.dataset.appsView = key;
      try { localStorage.setItem(APPS_LS_KEY, key); } catch {}
      // Re-apply so the active tab's mount logic runs (Atlas.mount etc).
      applyActiveTab("apps");
      return;
    }
    const back = e.target.closest("[data-apps-back]");
    if (back) {
      delete document.body.dataset.appsView;
      try { localStorage.removeItem(APPS_LS_KEY); } catch {}
      applyActiveTab("apps");
      return;
    }
  });
}

// Flip the network sub-view + repaint sub-tab aria-selected state +
// persist + activate the metrics module if appropriate. Safe to call
// regardless of which top-level tab is active.
function setNetworkSub(sub) {
  if (!NET_SUBS.has(sub)) sub = "network";
  document.body.dataset.netSub = sub;
  try { localStorage.setItem(NET_SUB_LS_KEY, sub); } catch {}
  for (const b of document.querySelectorAll("#network-subtabs .net-subtab")) {
    b.setAttribute("aria-selected", b.dataset.netSub === sub ? "true" : "false");
  }
  // Toggle the metrics module's polling on/off so it doesn't churn
  // when hidden.
  if (document.body.dataset.activeTab === "network") {
    if (sub === "metrics" && typeof onMetricsTabActivated === "function") {
      onMetricsTabActivated();
    } else if (typeof onMetricsTabDeactivated === "function") {
      onMetricsTabDeactivated();
    }
    if (sub === "network") {
      requestFrameOrTimeout(() => {
        if (typeof resizeLiveGraph === "function") {
          try { resizeLiveGraph(); } catch {}
        }
      });
    }
  }
}

// ─── mouse back/forward history ───────────────────────────────────────────
// The app is a single-page surface, so the browser's own back/forward stack
// is empty and the mouse's 4th/5th buttons do nothing. We give them a real
// history by snapshotting the user's "location" — the active top tab plus its
// sub-state (apps sub-view, network sub-tab, alchemy rail/detail mode) — and
// walking that stack on the back/forward buttons, just like a browser.
//
// We learn about navigation by *observing* the DOM attributes the existing
// nav code already writes (data-active-tab / data-apps-view / data-net-sub /
// data-alch-mode-current / data-alch-program-page), rather than hooking each
// nav call site. That keeps this self-contained: any code path that moves the
// user gets recorded.
const NAV_ALCH_LS_KEY = "srwk:alchemy_mode"; // mirrors alchemy.js ALCHEMY_LS_KEY
const NAV_CONST_MODE_LS_KEY = "srwk:const_mode"; // mirrors alchemy.js CONST_MODE_LS_KEY
const navHist = { stack: [], index: -1, last: null, restoring: false };

function navSnapshot() {
  const b = document.body;
  const tab = TOP_TABS.has(b.dataset.activeTab) ? b.dataset.activeTab : "alchemy";
  const snap = {
    tab,
    appsView: tab === "apps" ? (b.dataset.appsView || "") : "",
    netSub: tab === "network" ? (b.dataset.netSub || "network") : "network",
    alchMode: "",
    constMode: "",
    ctxView: "",
    programPage: "",
    recordId: "",
  };
  if (tab === "alchemy") {
    const alch = document.getElementById("alchemy-view");
    let loc = null;
    try { loc = Alchemy.getLocation?.(); } catch {}
    let alchMode = loc?.mode || alch?.dataset.alchModeCurrent || "";
    if (!alchMode) {
      try { alchMode = localStorage.getItem(NAV_ALCH_LS_KEY) || "membrane"; } catch { alchMode = "membrane"; }
    }
    let constMode = loc?.constellationMode || alch?.dataset.constModeCurrent || "";
    if (!constMode) {
      try { constMode = localStorage.getItem(NAV_CONST_MODE_LS_KEY) || ""; } catch { constMode = ""; }
    }
    let ctxView = loc?.contextView || alch?.dataset.contextView || "";
    if (alchMode === "collab") {
      alchMode = "constellation";
      constMode = "collab";
    }
    if (alchMode === "pulse") {
      alchMode = "shapes";
      constMode = "";
    }
    if (alchMode === "intel") {
      alchMode = "context";
      ctxView = "signals";
    }
    if (alchMode !== "constellation") constMode = "";
    if (alchMode !== "context") ctxView = "";
    snap.alchMode = alchMode || "membrane";
    snap.constMode = constMode || "";
    snap.ctxView = ctxView || "";
    snap.programPage = snap.alchMode === "program" && loc?.programPage
      ? String(loc.programPage)
      : (snap.alchMode === "program" && alch?.dataset.alchProgramPage ? String(alch.dataset.alchProgramPage) : "");
    snap.recordId = loc?.recordId ? String(loc.recordId) : (alch?.dataset.alchDetail || "");
  }
  return snap;
}

function navSameLoc(a, b) {
  return !!a && !!b && a.tab === b.tab && a.appsView === b.appsView
    && a.netSub === b.netSub && a.alchMode === b.alchMode
    && a.constMode === b.constMode
    && (a.ctxView || "") === (b.ctxView || "")
    && a.programPage === b.programPage && a.recordId === b.recordId;
}

// Replay a snapshot through the same entry points the UI uses, so mounts /
// persistence / aria state all stay consistent. Guarded by `restoring` so the
// MutationObserver doesn't record our own replay as a new history entry.
function navApplyLocation(snap) {
  navHist.restoring = true;
  snap = snap || {};
  const tab = TOP_TABS.has(snap.tab) ? snap.tab : "alchemy";
  if (snap.tab === "apps") {
    if (snap.appsView) {
      document.body.dataset.appsView = snap.appsView;
      try { localStorage.setItem(APPS_LS_KEY, snap.appsView); } catch {}
    } else {
      delete document.body.dataset.appsView;
      try { localStorage.removeItem(APPS_LS_KEY); } catch {}
    }
  }
  if (tab === "network") {
    const netSub = NET_SUBS.has(snap.netSub) ? snap.netSub : "network";
    document.body.dataset.netSub = netSub;
    try { localStorage.setItem(NET_SUB_LS_KEY, netSub); } catch {}
  }
  if (tab === "alchemy") {
    const mode = snap.alchMode === "collab" ? "constellation"
      : (snap.alchMode === "pulse" ? "shapes"
      : (snap.alchMode === "intel" ? "context" : (snap.alchMode || "membrane")));
    const loc = {
      mode,
      recordId: snap.recordId || null,
      instant: true,
    };
    if (mode === "constellation" && snap.constMode) loc.constellationMode = snap.constMode;
    if (mode === "context" && snap.ctxView) loc.contextView = snap.ctxView;
    if (mode === "program" && snap.programPage) loc.programPage = snap.programPage;
    try { Alchemy.applyLocation(loc); } catch {}
  }
  // applyActiveTab runs the per-tab mount logic; call it for same-tab sub-view
  // changes (e.g. apps grid ⇄ atlas) too, since only the sub-state differs.
  if (document.body.dataset.activeTab !== tab) {
    morphActiveTab(tab, () => applyActiveTab(tab));
    try { localStorage.setItem(TAB_LS_KEY, tab); } catch {}
  } else {
    applyActiveTab(tab);
  }
  if (tab === "network") setNetworkSub(NET_SUBS.has(snap.netSub) ? snap.netSub : "network");
  navHist.last = navSnapshot();
  // All observed attributes are written synchronously above, so the observer's
  // microtask sees restoring=true. Clear in the following microtask so an
  // immediate user navigation after Back/Forward is still recorded.
  queueMicrotask(() => { navHist.restoring = false; });
}

function navRecord() {
  const snap = navSnapshot();
  if (navSameLoc(snap, navHist.last)) return;
  navHist.stack = navHist.stack.slice(0, navHist.index + 1); // drop forward entries
  navHist.stack.push(snap);
  navHist.index = navHist.stack.length - 1;
  navHist.last = snap;
}

function navGoBack() {
  if (navHist.index <= 0) return;
  navHist.index -= 1;
  navApplyLocation(navHist.stack[navHist.index]);
}
function navGoForward() {
  if (navHist.index >= navHist.stack.length - 1) return;
  navHist.index += 1;
  navApplyLocation(navHist.stack[navHist.index]);
}

function initNavHistory() {
  navHist.last = navSnapshot();
  navHist.stack = [navHist.last];
  navHist.index = 0;
  const obs = new MutationObserver(() => { if (!navHist.restoring) navRecord(); });
  obs.observe(document.body, {
    attributes: true,
    attributeFilter: ["data-active-tab", "data-apps-view", "data-net-sub"],
  });
  const alch = document.getElementById("alchemy-view");
  if (alch) obs.observe(alch, { attributes: true, attributeFilter: ["data-alch-mode-current", "data-const-mode-current", "data-context-view", "data-alch-program-page", "data-alch-detail"] });

  // Mouse buttons: 3 = back, 4 = forward (Chromium's X1/X2 mapping). Capture
  // phase + preventDefault so we win over any inner handler and suppress the
  // (empty) default browser navigation.
  const onAux = (e) => {
    if (e.button === 3) { e.preventDefault(); e.stopPropagation(); navGoBack(); }
    else if (e.button === 4) { e.preventDefault(); e.stopPropagation(); navGoForward(); }
  };
  window.addEventListener("mouseup", onAux, true);
  window.addEventListener("mousedown", (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);
  window.addEventListener("auxclick", (e) => { if (e.button === 3 || e.button === 4) e.preventDefault(); }, true);
  window.addEventListener("keydown", (e) => {
    const t = e.target;
    const tag = t?.tagName?.toUpperCase?.();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    const back = e.key === "BrowserBack"
      || (e.altKey && !e.ctrlKey && !e.metaKey && e.key === "ArrowLeft")
      || (e.metaKey && !e.ctrlKey && e.key === "[");
    const forward = e.key === "BrowserForward"
      || (e.altKey && !e.ctrlKey && !e.metaKey && e.key === "ArrowRight")
      || (e.metaKey && !e.ctrlKey && e.key === "]");
    if (!back && !forward) return;
    e.preventDefault();
    e.stopPropagation();
    if (back) navGoBack();
    else navGoForward();
  }, true);
}

// Register the visualizer's app-specific keyboard shortcuts and command-
// palette entries. Called from boot() before subscribeEvents so the palette
// and `?` overlay are immediately functional.
function registerVisualizerShortcutsAndCommands() {
  const focusGraphSearch = () => {
    // No-op since graph2 was archived; left as a stub so any external
    // callers continue to compile.
  };
  // Search is now a panel inside atlas (toggled via openAtlasSearch in
  // boot init). Cmd+/ from anywhere lands on atlas + opens the panel.
  const focusSearchTabInput = () => {
    if (document.body.dataset.activeTab !== "apps" || document.body.dataset.appsView !== "atlas") {
      document.body.dataset.appsView = "atlas";
      try { localStorage.setItem(APPS_LS_KEY, "atlas"); } catch {}
      morphActiveTab("apps", () => applyActiveTab("apps"));
      try { localStorage.setItem(TAB_LS_KEY, "apps"); } catch {}
    }
    setTimeout(() => {
      try { openAtlasSearch(); } catch {}
      const inp = document.getElementById("search-input");
      if (inp) { inp.focus(); inp.select?.(); }
    }, 80);
  };
  const goTab = (t) => {
    if (!TOP_TABS.has(t)) return;
    morphActiveTab(t, () => applyActiveTab(t));
    try { localStorage.setItem(TAB_LS_KEY, t); } catch {}
  };
  // Jump straight into an apps-tab sub-app (atlas | easel | daybook) in one
  // step — used by the command palette + cross-module deep-links (e.g. the
  // alchemy onboarding "interview" step opens daybook via window.__srwkOpenApp).
  const openApp = (key) => {
    // router is a pop-out window, not an apps-stage view.
    if (key === "daybook") { openRouter(); return; }
    if (!APPS_VIEWS.has(key)) return;
    document.body.dataset.appsView = key;
    try { localStorage.setItem(APPS_LS_KEY, key); } catch {}
    morphActiveTab("apps", () => applyActiveTab("apps"));
    try { localStorage.setItem(TAB_LS_KEY, "apps"); } catch {}
  };
  // Expose for cross-module navigation (identity.js routes the user
  // into the profile editor after they claim a record).
  window.__srwkGoTab = goTab;
  window.__srwkOpenApp = openApp;
  window.__srwkSetNetSub = setNetworkSub;  // used by the tab system (tabs.js)

  registerKeyboardShortcuts([
    {
      title: "Navigation",
      items: [
        { keys: ["⌘", "K"],         label: "Open command palette" },
        { keys: ["?"],              label: "Show this overlay" },
        { keys: ["A"],              label: "Open Atlas app" },
        { keys: ["Y"],              label: "Go to Alchemy tab" },
        { keys: ["N"],              label: "Go to Network tab" },
        { keys: ["M"],              label: "Go to Metrics tab" },
        { keys: ["Esc"],            label: "Close popover / clear search" },
      ],
    },
    {
      title: "Search",
      items: [
        { keys: ["/"],              label: "Open the network search panel inside Atlas" },
        { keys: ["⌘", "F"],         label: "Focus the atlas filter input" },
        { keys: ["Enter"],          label: "Run search / cycle to next match" },
      ],
    },
    {
      title: "Atlas",
      items: [
        { keys: ["Drag"],           label: "Pan the map" },
        { keys: ["Scroll"],         label: "Zoom toward cursor" },
        { keys: ["Click"],          label: "Open page in browser" },
        { keys: ["Hover"],          label: "Show town panel" },
        { keys: ["⌘", "0"],          label: "Reset view" },
        { keys: ["T"],              label: "Toggle time-lapse" },
      ],
    },
    {
      title: "System",
      items: [
        { keys: ["⌘", "K"],         label: "Open command palette" },
        { keys: ["⌘", "R"],         label: "Reload window" },
      ],
    },
  ]);

  registerCommands([
    { id: "go.atlas", group: "Go to", label: "Go to Atlas", keys: ["A"], hint: "the wall map",
      keywords: ["app","atlas","map","cartography","wall","paper","continent","photo"], run: () => openApp("atlas") },
    { id: "go.network", group: "Go to", label: "Go to Network", keys: ["N"], hint: "peers + traffic",
      keywords: ["tab","network","peers","traffic"], run: () => goTab("network") },
    { id: "go.search",  group: "Go to", label: "Open Search (inside Atlas)",  keys: ["/"], hint: "router + web",
      keywords: ["tab","search","find","query","atlas"], run: focusSearchTabInput },
    { id: "go.metrics", group: "Go to", label: "Go to Metrics", keys: ["M"], hint: "swf-node telemetry · network/metrics sub-tab",
      keywords: ["tab","metrics","charts","stats","network"],
      run: () => { goTab("network"); setNetworkSub("metrics"); } },
    { id: "go.alchemy", group: "Go to", label: "Go to Alchemy", keys: ["Y"],
      hint: "cohort sandbox",
      keywords: ["tab","alchemy","cohort","teams","specimens","constellation","activity","progress"],
      run: () => goTab("alchemy") },
    { id: "go.daybook", group: "Go to", label: "Go to Router",
      hint: "your daily cohort update",
      keywords: ["app","router","daybook","digest","update","post","cohort","daily","reflect","intro","interview"],
      run: () => openApp("daybook") },
    { id: "atlas.timelapse", group: "Atlas", label: "Atlas: toggle time-lapse",
      keys: ["T"], hint: "cinematic replay of the last N days",
      keywords: ["atlas","timelapse","time-lapse","replay","scrub","cinematic","T"],
      run: () => {
        if (document.body.dataset.activeTab !== "apps" || document.body.dataset.appsView !== "atlas") openApp("atlas");
        // dispatch a 'T' keydown after a frame so the atlas module's
        // own listener catches it. simpler than crossing the boundary.
        setTimeout(() => {
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "t" }));
        }, 250);
      } },
    { id: "atlas.reset", group: "Atlas", label: "Atlas: reset view",
      keys: ["⌘","0"],
      keywords: ["atlas","reset","home","view","viewport","zoom"],
      run: () => {
        if (document.body.dataset.activeTab !== "apps" || document.body.dataset.appsView !== "atlas") openApp("atlas");
        setTimeout(() => {
          if (window.__srwk_atlas) window.__srwk_atlas.reset();
        }, 250);
      } },
    { id: "search.focus.tab",   group: "Search", label: "Focus Search input",
      keywords: ["search","input","focus"], run: focusSearchTabInput },
    { id: "search.focus.graph", group: "Search", label: "Focus Graph filter (search nodes)",
      hint: "filter by title/host", keys: ["⌘","F"], keywords: ["filter","find"], run: focusGraphSearch },
    { id: "ui.shortcuts", group: "Help", label: "Show keyboard shortcuts",
      keys: ["?"], keywords: ["help","keys","shortcuts"],
      run: () => openKeyboardOverlay() },
    { id: "ui.toggle-motion", group: "Display",
      label: () => isReducedMotion() ? "Enable motion" : "Reduce motion",
      hint: "toggle animations",
      keywords: ["motion","reduce","accessibility","a11y","animate"],
      run: () => {
        const on = toggleManualReducedMotion();
        toast({ kind: "info", message: on ? "motion reduced" : "motion enabled" });
      } },
    { id: "ui.toggle-density", group: "Display", label: () => (document.documentElement.dataset.density === "compact" ? "Comfortable density" : "Compact density"),
      keywords: ["density","compact","comfortable","layout"],
      run: () => {
        const cur = document.documentElement.dataset.density === "compact" ? "comfortable" : "compact";
        document.documentElement.dataset.density = cur;
        try { localStorage.setItem("srwk:density", cur); } catch {}
        toast({ kind: "info", message: `${cur} density` });
      } },
    { id: "events.clear", group: "Events", label: "Clear events log",
      keywords: ["events","clear","reset","log"],
      run: () => {
        const list = document.getElementById("events-panel-list");
        if (list) list.innerHTML = `<div class="events-empty">no events yet. quiet.</div>`;
        const c = document.getElementById("events-panel-count");
        if (c) c.textContent = "0";
        toast({ kind: "success", message: "events cleared" });
      } },
    { id: "conn.restart", group: "Connection", label: "Restart event stream",
      hint: "reconnect SSE", keywords: ["sse","reconnect","restart","stream"],
      run: () => {
        try { srwk.eventSource?.close?.(); } catch {}
        subscribeEvents();
        toast({ kind: "info", message: "reconnecting to event stream…" });
      } },
    { id: "ui.replay-launch", group: "Display", label: "Replay launch sequence",
      hint: "the rotor glyph and wordmark, again",
      keywords: ["launch","intro","wordmark","rotor","animation","welcome","onboarding"],
      run: () => replayLaunch() },
    { id: "metrics.zoom-rss", group: "Metrics", label: "Expand memory chart",
      keywords: ["chart","zoom","expand","memory","rss"],
      run: () => openChartZoomModal("rss-mem") },
    { id: "metrics.zoom-search-latency", group: "Metrics", label: "Expand search latency chart",
      keywords: ["chart","zoom","expand","search","latency"],
      run: () => openChartZoomModal("search-latency") },
    { id: "conn.reload-graph", group: "Connection", label: "Reload graph from server",
      keywords: ["graph","reload","refresh","reconcile"],
      run: async () => {
        try {
          const r = await fetch(`${srwk.serverUrl}/graph?lens=${srwk.lens.id}`);
          if (r.ok) {
            mergeFreshGraph(await r.json());
            toast({ kind: "success", message: "graph reconciled" });
          } else {
            toast({ kind: "error", message: `reload failed: HTTP ${r.status}` });
          }
        } catch (e) {
          toast({ kind: "error", message: `reload failed: ${e?.message || e}` });
        }
      } },
  ]);

  // Register single-letter tab shortcuts with input-blocking guard.
  // Top-level: A opens the Atlas app; Y / N / M switch OS/network views.
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    const tag = e.target?.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.target?.isContentEditable) return;
    const k = e.key.toLowerCase();
    if (k === "a") { openApp("atlas"); }
    else if (k === "n") { goTab("network"); setNetworkSub("network"); }
    else if (k === "m") { goTab("network"); setNetworkSub("metrics"); }
    else if (k === "y") { goTab("alchemy"); }
    else if (k === "/") {
      // '/' opens the network search panel inside Atlas.
      e.preventDefault();
      focusSearchTabInput();
    }
    // 's' is intentionally not bound to "search tab" here because in the
    // network tab a peer-row carries its own keybinds; the cmd palette
    // entry "Go to Search" covers it.
  });

  // Ensure compact density persists across reloads
  try {
    const d = localStorage.getItem("srwk:density");
    if (d === "compact") document.documentElement.dataset.density = "compact";
  } catch {}
}

function applyActiveTab(tab) {
  if (!TOP_TABS.has(tab)) tab = "alchemy";
  if (tab !== "alchemy") Alchemy.closeMembraneMenu();
  document.body.dataset.activeTab = tab;
  for (const btn of document.querySelectorAll("#tab-bar .tab-btn, #primary-nav .nav-cat")) {
    btn.setAttribute("aria-selected", btn.dataset.tab === tab ? "true" : "false");
  }
  // Stale: experimental tab archived 2026-05-09. Variables retained as
  // false so any leftover branches below are no-ops without further edits.
  const expActive = false;
  const expMode   = null;

  // Move the shared #detail element into the right host so the existing
  // detail renderers (renderEventDetail, renderTrafficDetail, render-
  // Receipt/Ticket/Provider/RouterDetail) need no awareness of tabs. The
  // host keeps an .net-detail-empty placeholder as a sibling; CSS only
  // shows it when #detail has no children (`#detail:empty + ...`).
  const detail = document.getElementById("detail");
  if (detail) {
    if (tab === "network") {
      const host = document.getElementById("net-detail-host");
      if (host && detail.parentElement !== host) {
        host.innerHTML = "";
        host.appendChild(detail);
        const empty = document.createElement("div");
        empty.className = "net-detail-empty";
        empty.id = "net-detail-empty";
        empty.textContent = "pick a row to inspect.";  // already terse + lowercase. keep.
        host.appendChild(empty);
      }
    } else {
      const sidebar = document.getElementById("sidebar");
      const events = document.getElementById("events-panel");
      if (sidebar && detail.parentElement !== sidebar) {
        if (events && events.parentElement === sidebar) {
          events.insertAdjacentElement("afterend", detail);
        } else {
          sidebar.appendChild(detail);
        }
        // Restore the placeholder in the network host so it reads as
        // "click a row to inspect" when the user revisits the tab.
        const host = document.getElementById("net-detail-host");
        if (host && !host.querySelector("#net-detail-empty")) {
          host.innerHTML = "";
          const empty = document.createElement("div");
          empty.className = "net-detail-empty";
          empty.id = "net-detail-empty";
          empty.textContent = "pick a row to inspect.";  // already terse + lowercase. keep.
          host.appendChild(empty);
        }
      }
    }
  }
  if (tab === "network") {
    renderNetPeersList();
    renderNetAnonHeader();
    // Unified Network-tab panels (driven by /node/log + /sync/manifest).
    // Safe to call before the first poll lands — they all render their
    // own empty states.
    try { renderNetRouterStatus(); } catch {}
    try { renderNetSearchPanel(); } catch {}
    try { renderNetRecordsPanel(); } catch {}
    // Default sub-tab when entering network is "network" — but if the
    // user previously switched to metrics, restore that. setNetworkSub
    // also handles activating / deactivating the metrics polling.
    const sub = document.body.dataset.netSub;
    setNetworkSub(NET_SUBS.has(sub) ? sub : "network");
  } else {
    // Leaving the network tab — make sure metrics polling is off.
    if (typeof onMetricsTabDeactivated === "function") onMetricsTabDeactivated();
  }
  // Whenever we leave the apps tab (or leave the atlas sub-view inside
  // it), close the inline search panel.
  const inAtlasSubview = (tab === "apps" && document.body.dataset.appsView === "atlas");
  if (!inAtlasSubview) closeAtlasSearch();

  // Apps tab — landing is the grid; user picks an app (Atlas today) which
  // sets body[data-apps-view] and reveals the inner view. Atlas mount /
  // pause logic mirrors what used to live under its own top tab.
  if (tab === "apps" && inAtlasSubview) {
    requestFrameOrTimeout(() => {
      const stage = document.getElementById("atlas-stage");
      if (!stage) return;
      try {
        Atlas.mount(stage);
        Atlas.setActive(true);
        requestFrameOrTimeout(() => Atlas.notifyDataChanged());
      } catch (e) {
        console.error("[atlas] mount failed:", e);
      }
    });
  } else {
    try { Atlas.setActive(false); } catch {}
  }

  // easel app — screen/window → NDI projection. Same lazy-mount pattern;
  // setActive(false) on leave so we stop capturing + broadcasting.
  const inEaselSubview = (tab === "apps" && document.body.dataset.appsView === "easel");
  if (inEaselSubview) {
    requestFrameOrTimeout(() => {
      const stage = document.getElementById("easel-stage");
      if (!stage) return;
      try {
        Easel.mount(stage);
        Easel.setActive(true);
      } catch (e) {
        console.error("[easel] mount failed:", e);
      }
    });
  } else {
    try { Easel.setActive(false); } catch {}
  }
  // router (daybook) is a pop-out window, not an apps-stage view — no mount
  // branch here; the apps card / command / onboarding open it via openRouter().

  // Alchemy tab — cohort sandbox. Same lazy-mount pattern as atlas.
  if (tab === "alchemy") {
    requestFrameOrTimeout(() => {
      const stage = document.getElementById("alchemy-view");
      if (!stage) return;
      try {
        // First mount of the alchemy tab is what the progressive launch
        // overlay (boot.js: mountLaunchOverlay) is waiting on. Advance
        // the status bar before mount, then call ready() once the first
        // data-driven render has been kicked off so the splash dismisses
        // on a real handoff rather than a guess.
        const launch = window.__srfgLaunch;
        if (launch?.setStatus) launch.setStatus("mounting cohort view", 0.80);
        Alchemy.mount(stage);
        Alchemy.setActive(true);
        requestFrameOrTimeout(() => {
          Alchemy.notifyDataChanged();
          if (launch?.ready) {
            launch.setStatus("ready", 1.0);
            launch.ready();
            window.__srfgLaunch = null;
          }
        });
      } catch (e) {
        console.error("[alchemy] mount failed:", e);
        try { window.__srfgLaunch?.skip(); window.__srfgLaunch = null; } catch {}
      }
    });
  } else {
    try { Alchemy.setActive(false); } catch {}
  }
}

// ─── search tab ──────────────────────────────────────────────────────────
const SEARCH_LS_KEY = "srwk:search";
const SEARCH_RECENT_LS_KEY = "srwk:search:recent";
const SEARCH_RECENT_MAX = 10;
const SEARCH_EXAMPLES = [
  "papers on rotational symmetry",
  "how do hash collisions work?",
  "ed25519 vs schnorr signatures",
  "shoegaze albums 1991",
  "DC-net anonymity protocol",
];
const searchState = {
  q: "",
  policy: "default",
  topK: 10,
  confirmEgress: false,
  inFlight: null,
  lastResponse: null,
  lastQuery: "",
  startedAt: 0,
  selectedIdx: -1,
  recents: [],
};
const SEARCH_POLICIES = new Set(["default", "private_circle", "local_only"]);
function normalizeSearchPolicy(policy) {
  return SEARCH_POLICIES.has(policy) ? policy : "default";
}

function loadRecentSearches() {
  try {
    const raw = localStorage.getItem(SEARCH_RECENT_LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(s => typeof s === "string").slice(0, SEARCH_RECENT_MAX) : [];
  } catch { return []; }
}
function saveRecentSearches() {
  try { localStorage.setItem(SEARCH_RECENT_LS_KEY, JSON.stringify(searchState.recents)); } catch {}
}
function pushRecentSearch(q) {
  if (!q) return;
  const trimmed = q.trim();
  if (!trimmed) return;
  searchState.recents = [trimmed, ...searchState.recents.filter(s => s !== trimmed)].slice(0, SEARCH_RECENT_MAX);
  saveRecentSearches();
  renderRecentChips();
}
function renderRecentChips() {
  const wrap = document.getElementById("search-recents");
  if (!wrap) return;
  if (!searchState.recents.length) { wrap.innerHTML = ""; wrap.hidden = true; return; }
  wrap.hidden = false;
  const chips = searchState.recents.map(q => {
    const safe = escHtml(q);
    return `<button class="search-recent-chip" type="button" data-q="${safe}" title="re-run: ${safe}">${safe}</button>`;
  }).join("");
  wrap.innerHTML = `<span class="search-recents-label">recent</span>${chips}<button class="search-recent-chip search-recent-chip-clear" type="button" data-clear="1" title="clear recent queries">clear</button>`;
  for (const btn of wrap.querySelectorAll(".search-recent-chip")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.clear) {
        searchState.recents = [];
        saveRecentSearches();
        renderRecentChips();
        return;
      }
      const inp = document.getElementById("search-input");
      if (inp) inp.value = btn.dataset.q;
      runSearch(btn.dataset.q);
    });
  }
}

// Search now lives as an inline panel inside Atlas (was its own tab pre
// 2026-05-09). Open/close toggle the body attribute `data-atlas-search`
// — CSS pins #search-view as a positioned overlay above the atlas
// canvas while it's "open", and hides it otherwise.
function openAtlasSearch() {
  document.body.dataset.atlasSearch = "open";
  requestAnimationFrame(() => {
    const inp = document.getElementById("search-input");
    if (inp) { inp.focus(); inp.select?.(); }
  });
}
function closeAtlasSearch() {
  if (document.body.dataset.atlasSearch === "open") {
    delete document.body.dataset.atlasSearch;
  }
}

function wireSearchTab() {
  const form = document.getElementById("search-form");
  const input = document.getElementById("search-input");
  const policy = document.getElementById("search-policy");
  const topk = document.getElementById("search-topk");
  const confirm = document.getElementById("search-confirm-egress");
  if (!form || !input) return;
  // Close the search panel on Esc when it has focus.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeAtlasSearch();
    }
  });
  try {
    const saved = JSON.parse(localStorage.getItem(SEARCH_LS_KEY) || "null");
    if (saved && typeof saved === "object") {
      if (typeof saved.policy === "string") searchState.policy = normalizeSearchPolicy(saved.policy);
      if (typeof saved.topK === "number") searchState.topK = saved.topK;
      if (typeof saved.confirmEgress === "boolean") searchState.confirmEgress = saved.confirmEgress;
    }
  } catch {}
  searchState.policy = normalizeSearchPolicy(searchState.policy);
  if (policy) policy.value = searchState.policy;
  if (topk) topk.value = String(searchState.topK);
  if (confirm) confirm.checked = !!searchState.confirmEgress;

  // Mount the recent-queries strip + initial render of empty-state with examples.
  searchState.recents = loadRecentSearches();
  installSearchRecentStrip();
  installSearchEmptyExamples();
  // Keyboard navigation through results
  installSearchResultsKbdNav(input);

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = (input.value || "").trim();
    if (!q) return;
    runSearch(q);
  });
  // Magnetic hover on the GO button — same calibration as the tabs.
  const submitBtn = document.getElementById("search-submit");
  if (submitBtn) magnetize(submitBtn, { strength: 6, dampen: 0.4 });
  if (policy) policy.addEventListener("change", () => {
    searchState.policy = normalizeSearchPolicy(policy.value);
    policy.value = searchState.policy;
    persistSearchPrefs();
  });
  if (topk) topk.addEventListener("change", () => {
    const n = parseInt(topk.value, 10);
    searchState.topK = Number.isFinite(n) ? n : 10;
    persistSearchPrefs();
  });
  if (confirm) confirm.addEventListener("change", () => {
    searchState.confirmEgress = !!confirm.checked;
    persistSearchPrefs();
  });
  // ASK MY AGENT button — legacy "copy prompt to clipboard" behavior is
  // superseded by the swarm panel (see `setupSwarmPanel` at end of file,
  // which attaches its own click handler that opens an actual agent run).
  // The prompt helper is exposed on window so the swarm panel can still
  // reuse the framing if we ever want a "copy prompt" fallback inside it.
  try { window.__buildAskAgentPrompt = buildAskAgentPrompt; } catch {}
  if (searchState.lastResponse) {
    input.value = searchState.lastQuery;
    renderSearchMeta(searchState.lastResponse);
    renderSearchResults(searchState.lastResponse);
  }
}

function buildAskAgentPrompt(q) {
  const url = `${srwk.serverUrl}/web_search`;
  const body = {
    q: q || "<paste your query here>",
    policy: searchState.policy,
    top_k: searchState.topK,
    confirm_public_egress: !!searchState.confirmEgress,
  };
  const policyLine = searchState.confirmEgress
    ? "User has authorized public web egress for this query."
    : "User has NOT authorized public web egress; egress will be refused if the policy requires confirmation.";
  return [
    `You are an agent helping me search my local swf-node (Self-sovereign LAN-first peer search) instance.`,
    ``,
    `Make this HTTP request and summarize the results for me:`,
    ``,
    `  POST ${url}`,
    `  Content-Type: application/json`,
    ``,
    `  ${JSON.stringify(body, null, 2).replace(/\n/g, "\n  ")}`,
    ``,
    `Notes:`,
    `- ${policyLine}`,
    `- Response is SPEC v0.3: top-level fields include status, delivery_path, origin_paths, privacy_level, network_used_this_request, public_egress_used_this_request, attempts[], results[], fallbacks_tried, debug.`,
    `- Each item in results[] has at least: title, url, snippet, host, provider_pubkey (when from a peer), origin_path.`,
    `- If status is "confirmation_required", report that back to me — don't retry with confirm_public_egress=true on your own.`,
    `- The endpoint is on my loopback (${url.replace(/\/web_search$/, "")}); it is not reachable from the public internet, so curl/fetch from your sandbox may fail. If you can't reach it, just print the curl I should run.`,
    ``,
    `Then give me a concise digest: top results (title + host + 1-line why-relevant), and the route that delivered them (delivery_path).`,
  ].join("\n");
}

function installSearchRecentStrip() {
  // Always-visible chip strip under the controls (similar to Raycast/Linear
  // command-bar history). The strip hides itself when there are no recents
  // — the empty-state has its own example queries to start from.
  const form = document.getElementById("search-form");
  if (!form) return;
  let strip = document.getElementById("search-recents");
  if (!strip) {
    strip = document.createElement("div");
    strip.id = "search-recents";
    strip.className = "search-recents";
    strip.hidden = true;
    form.appendChild(strip);
  }
  renderRecentChips();
}

function installSearchEmptyExamples() {
  // Mutate the initial empty-state to include example-query buttons. Only
  // applies the first time before any search has run; renderSearchResults
  // already produces its own no-results empty.
  const list = document.getElementById("search-results");
  if (!list) return;
  const empty = list.querySelector(".search-empty");
  if (!empty) return;
  if (empty.dataset.examplesMounted === "1") return;
  empty.dataset.examplesMounted = "1";
  const examples = document.createElement("div");
  examples.className = "search-empty-examples";
  for (const ex of SEARCH_EXAMPLES) {
    const btn = document.createElement("button");
    btn.className = "search-empty-example";
    btn.type = "button";
    btn.textContent = ex;
    btn.addEventListener("click", () => {
      const inp = document.getElementById("search-input");
      if (inp) inp.value = ex;
      runSearch(ex);
    });
    examples.appendChild(btn);
  }
  empty.appendChild(examples);
}

function installSearchResultsKbdNav(input) {
  // Arrow up/down moves visual selection; Enter opens; Cmd-Enter opens in
  // background (currently no concept of "background tab" in Electron, so we
  // just open in default external browser without focusing the visualizer).
  const moveSelection = (dir) => {
    const list = document.getElementById("search-results");
    if (!list) return;
    const rows = list.querySelectorAll(".search-result");
    if (!rows.length) return;
    let next = searchState.selectedIdx + dir;
    if (next < 0) next = rows.length - 1;
    if (next >= rows.length) next = 0;
    searchState.selectedIdx = next;
    rows.forEach((r, i) => r.classList.toggle("kbd-selected", i === next));
    rows[next].scrollIntoView({ block: "nearest" });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveSelection(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveSelection(-1); }
    else if (e.key === "Enter") {
      const list = document.getElementById("search-results");
      const rows = list?.querySelectorAll(".search-result");
      if (rows?.length && searchState.selectedIdx >= 0) {
        e.preventDefault();
        const a = rows[searchState.selectedIdx]?.querySelector(".search-result-title");
        if (a) {
          if (e.metaKey || e.ctrlKey) {
            // Cmd-Enter: open without focusing the new window (best-effort)
            const url = a.dataset.url;
            if (url) {
              if (window.api?.openExternal) window.api.openExternal(url);
              else window.open(url, "_blank", "noopener");
            }
          } else {
            a.click();
          }
        }
      }
    }
  });
}

function persistSearchPrefs() {
  try {
    localStorage.setItem(SEARCH_LS_KEY, JSON.stringify({
      policy: searchState.policy,
      topK: searchState.topK,
      confirmEgress: searchState.confirmEgress,
    }));
  } catch {}
}

async function runSearch(q) {
  if (searchState.inFlight) {
    try { searchState.inFlight.abort(); } catch {}
    searchState.inFlight = null;
  }
  const ctrl = new AbortController();
  searchState.inFlight = ctrl;
  searchState.q = q;
  searchState.lastQuery = q;
  searchState.startedAt = performance.now();
  searchState.selectedIdx = -1;
  setSearchStatus("loading", `searching for ${q}.`);
  hideSearchMeta();
  clearSearchResults();
  showSearchSkeletons();
  pushRecentSearch(q);
  appendEvent({
    kind: "web_search_requested",
    payload: { q, policy: searchState.policy, top_k: searchState.topK },
    ts: Date.now(),
  });
  // The live propagation graph wants this too — represents an outbound
  // search from self before the swf-node /web_search round-trips.
  try {
    livegraphPushFromEvent({
      kind: "web_search_requested",
      payload: { q },
      ts: Date.now(),
    });
  } catch {}
  let resp;
  try {
    const r = await fetch(`${srwk.serverUrl}/web_search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        q,
        policy: searchState.policy,
        top_k: searchState.topK,
        confirm_public_egress: searchState.confirmEgress,
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(`HTTP ${r.status}: ${text || r.statusText}`);
    }
    resp = await r.json();
  } catch (err) {
    if (ctrl.signal.aborted) return;
    setSearchStatus("error", `search failed. ${err && err.message ? err.message : String(err)}`);
    searchState.inFlight = null;
    return;
  }
  if (ctrl.signal.aborted) return;
  searchState.inFlight = null;
  searchState.lastResponse = resp;
  const elapsed = Math.max(0, performance.now() - searchState.startedAt);
  resp.__client_latency_ms = Math.round(elapsed);
  appendEvent({ kind: "web_search_completed", payload: resp, ts: Date.now() });
  if (typeof onWebSearchCompleted === "function") {
    try { onWebSearchCompleted(resp); } catch {}
  }
  if (resp.status && resp.status !== "ok" && resp.status !== "partial") {
    const reason = resp.fallback_reason || resp.status;
    setSearchStatus("info", `status: ${resp.status}${reason && reason !== resp.status ? ` · ${reason}` : ""}`);
  } else {
    hideSearchStatus();
  }
  renderSearchMeta(resp);
  renderSearchResults(resp);
}

function setSearchStatus(kind, msg) {
  const el = document.getElementById("search-status");
  if (!el) return;
  el.hidden = false;
  el.dataset.kind = kind;
  // Replace the generic spinner with the visualizer's rotor mark — the same
  // glyph that lives next to the wordmark. Loading is a moment to be
  // identity-aware, not generic.
  el.innerHTML = kind === "loading"
    ? `${rotorMarkup({ size: 14, ariaLabel: "searching" })}<span class="ss-msg">${escHtml(msg)}</span>`
    : escHtml(msg);
}
function hideSearchStatus() {
  const el = document.getElementById("search-status");
  if (el) { el.hidden = true; el.removeAttribute("data-kind"); el.textContent = ""; }
}

function hideSearchMeta() {
  const el = document.getElementById("search-meta");
  if (el) el.hidden = true;
}
function renderSearchMeta(resp) {
  const el = document.getElementById("search-meta");
  if (!el) return;
  el.hidden = false;
  const dp = resp.delivery_path || "—";
  const pl = resp.privacy_level || "none";
  const dpEl = document.getElementById("search-meta-delivery");
  if (dpEl) { dpEl.textContent = dp; dpEl.dataset.dp = dp; }
  const plEl = document.getElementById("search-meta-privacy");
  if (plEl) { plEl.textContent = pl.replace(/_/g, " "); plEl.dataset.pl = pl; }
  const netEl = document.getElementById("search-meta-network");
  if (netEl) {
    const v = !!resp.network_used_this_request;
    netEl.textContent = v ? "yes" : "no";
    netEl.dataset.bool = v ? "true" : "false";
  }
  const egEl = document.getElementById("search-meta-egress");
  if (egEl) {
    const v = !!resp.public_egress_used_this_request;
    egEl.textContent = v ? "yes" : "no";
    egEl.dataset.bool = v ? "true" : "false";
  }
  const latEl = document.getElementById("search-meta-latency");
  if (latEl) {
    const serverMs = (typeof resp.completed_ms === "number" && typeof resp.created_ms === "number")
      ? Math.max(0, resp.completed_ms - resp.created_ms) : null;
    const ms = serverMs ?? resp.__client_latency_ms ?? null;
    latEl.textContent = ms != null ? `${ms} ms` : "—";
    // Wrap in a hover popover that shows the per-stage breakdown the
    // server includes (route + per-attempt timing). Only built once per
    // search; subsequent calls just refresh contents.
    let wrap = latEl.parentElement?.classList?.contains("search-meta-latency-wrap")
      ? latEl.parentElement : null;
    if (!wrap) {
      wrap = document.createElement("span");
      wrap.className = "search-meta-latency-wrap";
      latEl.parentElement?.insertBefore(wrap, latEl);
      wrap.appendChild(latEl);
      const pop = document.createElement("div");
      pop.className = "search-latency-popover";
      pop.id = "search-latency-popover";
      wrap.appendChild(pop);
    }
    const pop = wrap.querySelector(".search-latency-popover");
    if (pop) {
      const rows = [];
      rows.push({ k: "client total", v: resp.__client_latency_ms != null ? `${resp.__client_latency_ms} ms` : "—" });
      if (serverMs != null) rows.push({ k: "server total", v: `${serverMs} ms` });
      // Look for an attempts/timings array on the response. swf-node may
      // expose it as resp.attempts (preferred), resp.route, resp.timings
      // — we render whichever is present.
      const attempts = Array.isArray(resp.attempts) ? resp.attempts
                     : Array.isArray(resp.route) ? resp.route
                     : Array.isArray(resp.timings) ? resp.timings : [];
      for (const a of attempts) {
        const k = a.path || a.origin || a.name || "stage";
        const v = (a.duration_ms != null ? `${Math.round(a.duration_ms)} ms` : null)
               ?? (a.took_ms != null ? `${Math.round(a.took_ms)} ms` : null)
               ?? (a.elapsed_ms != null ? `${Math.round(a.elapsed_ms)} ms` : null)
               ?? (a.status ? String(a.status) : "—");
        rows.push({ k, v });
      }
      if (typeof resp.completed_ms === "number") rows.push({ k: "completed", v: new Date(resp.completed_ms).toLocaleTimeString() });
      pop.innerHTML = rows.map(r => `<div class="slp-row"><span class="k">${escHtml(r.k)}</span><span class="v">${escHtml(String(r.v))}</span></div>`).join("");
    }
  }
  const cEl = document.getElementById("search-meta-count");
  if (cEl) cEl.textContent = String((resp.results || []).length);
}

function clearSearchResults() {
  const list = document.getElementById("search-results");
  if (!list) return;
  list.innerHTML = "";
}

function showSearchSkeletons() {
  const list = document.getElementById("search-results");
  if (!list) return;
  list.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "search-skeleton-list";
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("div");
    s.className = "search-skeleton";
    s.innerHTML = `
      <div class="search-skeleton-line short"></div>
      <div class="search-skeleton-line host"></div>
      <div class="search-skeleton-line snippet"></div>
      <div class="search-skeleton-line snippet-2"></div>
    `;
    wrap.appendChild(s);
  }
  list.appendChild(wrap);
}

function highlightHits(text, query) {
  if (!query || !text) return escHtml(text || "");
  // Tokenize on whitespace, ignore tokens shorter than 2 chars to avoid
  // wrapping every single char.
  const toks = query.split(/\s+/).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).filter(t => t.length >= 2);
  if (!toks.length) return escHtml(text);
  const re = new RegExp(`(${toks.join("|")})`, "ig");
  // Escape THEN apply <mark>; safe because the match capture is back into
  // the already-escaped string (we replace on the unescaped, then escape
  // each chunk to avoid breaking the highlight pattern).
  const parts = text.split(re);
  return parts.map(part => {
    if (re.test(part)) {
      // Reset lastIndex for global regex: needed because re.test modifies it.
      re.lastIndex = 0;
      return `<mark class="hit">${escHtml(part)}</mark>`;
    }
    return escHtml(part);
  }).join("");
}

function renderSearchResults(resp) {
  const list = document.getElementById("search-results");
  if (!list) return;
  list.innerHTML = "";
  searchState.selectedIdx = -1;
  const results = Array.isArray(resp.results) ? resp.results : [];
  if (results.length === 0) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    const reason = resp.fallback_reason || (resp.status === "no_results" ? "no_results" : "");
    // Pull diagnostic detail from the per-attempt log so the user sees
    // *why* each route failed instead of a generic "nothing came back".
    const attempts = Array.isArray(resp.attempts) ? resp.attempts : [];
    const indrexAttempt = attempts.find(a => a.path === "LOCAL_INDREX");
    const egressAttempt = attempts.find(a => a.path === "SELF_PUBLIC_EGRESS");

    // Three actionable cases, ordered by how reversible they are:
    //   (a) public egress wasn't confirmed → flip checkbox + retry
    //   (b) searxng (local egress proxy) is unreachable → tell the user
    //       the daemon needs a searxng instance running
    //   (c) local index returned weak matches that didn't pass the
    //       sufficiency gate → show count so the user knows the search
    //       *did* hit something, just not strongly enough
    const needsConfirm = resp.status === "confirmation_required"
      || /public_egress_requires_confirmation/i.test(reason);
    const searxngDown = egressAttempt?.reason === "searxng_unreachable";
    const indrexWeak  = indrexAttempt?.reason?.startsWith("insufficient")
      && indrexAttempt.results_count > 0;

    let title, sub, ctaHtml = "";
    if (needsConfirm) {
      title = "public egress is off.";
      sub = `your local index didn't have a strong-enough match for <em>${escHtml(searchState.q || "this query")}</em>.
             flip the toggle below to also search the public web (via swf-node's egress proxy), then retry.`;
      ctaHtml = `<button id="search-empty-enable-egress" class="search-empty-cta" type="button">enable public egress + retry</button>`;
    } else if (searxngDown) {
      title = "public web search unreachable.";
      sub = `swf-node tried public egress but its searxng instance didn't answer.
             ${indrexWeak ? `your local index had ${indrexAttempt.results_count} weak matches but none passed the sufficiency gate.` : ""}
             check that searxng is running on the swf-node host, then retry.`;
    } else if (indrexWeak) {
      title = "weak local matches only.";
      sub = `local index found ${indrexAttempt.results_count} candidates but none scored high enough to surface.
             enable public egress for a wider net, or refine your query.`;
      ctaHtml = `<button id="search-empty-enable-egress" class="search-empty-cta" type="button">enable public egress + retry</button>`;
    } else {
      title = "nothing came back.";
      sub = reason ? `reason: ${escHtml(reason)}` : "the router exhausted every path it was allowed to take.";
    }
    empty.innerHTML = `
      <div class="search-empty-glyph" aria-hidden="true">
        <svg viewBox="0 0 64 64" width="56" height="56" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="32" cy="32" r="22"/>
          <path d="M16 16l32 32"/>
        </svg>
      </div>
      <div class="search-empty-title">${escHtml(title)}</div>
      <div class="search-empty-sub">${sub}</div>
      ${ctaHtml}
      <div class="search-empty-sub" style="opacity:0.7;margin-top:8px;">or try one of these:</div>
    `;
    const examples = document.createElement("div");
    examples.className = "search-empty-examples";
    for (const ex of SEARCH_EXAMPLES) {
      const btn = document.createElement("button");
      btn.className = "search-empty-example";
      btn.type = "button";
      btn.textContent = ex;
      btn.addEventListener("click", () => {
        const inp = document.getElementById("search-input");
        if (inp) inp.value = ex;
        runSearch(ex);
      });
      examples.appendChild(btn);
    }
    empty.appendChild(examples);
    list.appendChild(empty);
    // Wire the egress CTA — flip the toggle and re-run the same query.
    const egressCta = empty.querySelector("#search-empty-enable-egress");
    if (egressCta) {
      egressCta.addEventListener("click", () => {
        const cb = document.getElementById("search-confirm-egress");
        if (cb) cb.checked = true;
        searchState.confirmEgress = true;
        try { localStorage.setItem(SEARCH_LS_KEY, JSON.stringify({ policy: searchState.policy, topK: searchState.topK, confirmEgress: true })); } catch {}
        if (searchState.q) runSearch(searchState.q);
      });
    }
    return;
  }
  for (const r of results) {
    list.appendChild(buildSearchResultRow(r, searchState.q));
  }
}

function buildSearchResultRow(r, query) {
  const row = document.createElement("div");
  row.className = "search-result";
  row.setAttribute("role", "listitem");
  const url = r.canonical_url || r.url || r.display_url || "";
  const display = r.display_url || hostFromUrl(url) || url;
  const title = r.title || display || "untitled";
  const snippet = r.snippet || "";
  const origin = r.origin_path || r.delivery_path || "";
  const score = (typeof r.score === "number") ? r.score.toFixed(3) : "";
  const provider = (r.provider && (r.provider.provider_label || r.provider.provider_pubkey)) || r.source || "";
  // Hit-highlight title + snippet against the active query
  const titleHtml = highlightHits(title, query || "");
  const snippetHtml = snippet ? highlightHits(snippet, query || "") : "";
  // are.na block layout:
  //   ┌─────────────────────────────────────────────┬──────────┐
  //   │ HOST                                        │ ORIGIN   │
  //   │ Title (display weight)                      │ score    │
  //   │ snippet body voice…                         │ provider │
  //   │ foot                                        │          │
  //   └─────────────────────────────────────────────┴──────────┘
  // The right column is a margin note — origin tag + score + provider,
  // right-aligned, mono caption type. Stays out of the way of the body.
  const provShort = String(provider).slice(0, 24);
  row.innerHTML = `
    <div class="search-result-head">
      <a class="search-result-title" data-url="${escHtml(url)}" href="#">${titleHtml}</a>
      <span class="search-result-host">${escHtml(display)}</span>
    </div>
    ${snippetHtml ? `<div class="search-result-snippet">${snippetHtml}</div>` : ""}
    <div class="search-result-foot"></div>
    <aside class="search-result-margin" aria-label="result metadata">
      ${origin ? `<span class="search-result-origin" data-op="${escHtml(origin)}">${escHtml(origin)}</span>` : ""}
      ${score ? `<span class="search-result-score">score ${escHtml(score)}</span>` : ""}
      ${provider ? `<span class="search-result-provider">${escHtml(provShort)}</span>` : ""}
    </aside>
  `;
  const a = row.querySelector(".search-result-title");
  if (a) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (!url) return;
      if (window.api && typeof window.api.openExternal === "function") {
        window.api.openExternal(url);
      } else {
        window.open(url, "_blank", "noopener");
      }
    });
  }
  // Mouse hover sets the kbd selection too so arrow-keys + mouse stay in sync.
  row.addEventListener("mouseenter", () => {
    const list = document.getElementById("search-results");
    const rows = list?.querySelectorAll(".search-result");
    if (!rows) return;
    rows.forEach((r2, i) => {
      if (r2 === row) {
        searchState.selectedIdx = i;
        r2.classList.add("kbd-selected");
      } else {
        r2.classList.remove("kbd-selected");
      }
    });
  });
  return row;
}

function hostFromUrl(u) {
  if (!u) return "";
  try { return new URL(u).host; } catch { return ""; }
}

// ─── network-tab peers list ──────────────────────────────────────────────
// Promotes the sidebar peers panel to a full column on the network tab.
// Kept in lockstep with the same data the popup peers panel reads from
// (srwk.peers + srwk.nodes + srwk.liveSeen), so SSE updates render here
// too via the existing renderPeersPanel call sites.

// Liveness/reachability for a peer, by pubkey. Shared by the peer-list
// cards, the active/offline partition, and the livegraph node styling so
// "online vs offline" reads the same everywhere:
//   live  — self, or sync/SSE activity in the last 60s
//   stale — activity 60–180s ago
//   idle  — no activity for 180s+
//   down  — a health probe marked the peer unreachable
// online = live | stale (recent activity); offline = idle | down.
// swf-node identifies a peer in /graph by its bare base64url pubkey, but
// /sync/manifest attributes each record with an `ed25519:<hex>` author —
// the SAME key in a different encoding. Canonicalize both to lowercase hex
// so per-peer record counts actually attribute (they were uniformly 0).
function canonPubkey(pk) {
  if (!pk) return "";
  let s = String(pk);
  const colon = s.indexOf(":");
  if (colon >= 0) s = s.slice(colon + 1);                  // strip "ed25519:" etc.
  if (/^[0-9a-f]{64}$/i.test(s)) return s.toLowerCase();   // already hex
  try {                                                    // base64url → hex
    const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    let hex = "";
    for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    return hex;
  } catch {
    return s.toLowerCase();
  }
}

function netPeerStatus(pubkey) {
  const isSelf = pubkey === srwk.selfPubkey;
  const syncTs = _peerLastSeenByPubkey.get(pubkey);
  const sseLiveTs = srwk.liveSeen.get(pubkey);
  const lastMs = Math.max(syncTs || 0, sseLiveTs || 0);
  const ageMs = lastMs ? (Date.now() - lastMs) : Infinity;
  const reachable = _peerReachable.get(pubkey);
  let statusClass, statusText;
  if (isSelf) { statusClass = "is-live"; statusText = "live"; }
  else if (reachable === false) { statusClass = "is-down"; statusText = "down"; }
  else if (ageMs < 60_000) { statusClass = "is-live"; statusText = "live"; }
  else if (ageMs < 180_000) { statusClass = "is-stale"; statusText = "stale"; }
  else { statusClass = "is-idle"; statusText = "idle"; }
  const online = statusClass === "is-live" || statusClass === "is-stale";
  return { statusClass, statusText, online, lastMs, ageMs, isSelf };
}

function renderNetPeersList() {
  const list = document.getElementById("net-peers-list");
  const counter = document.getElementById("net-peers-count");
  if (!list) return;
  // Preserve the offline dropdown's open state across re-renders (this runs
  // on every SSE tick — without this, an opened dropdown would snap shut).
  const wasOpen = !!list.querySelector(".net-peers-offline[open]");
  const peers = [...srwk.peers.values()];
  if (counter) counter.textContent = String(peers.length);
  list.innerHTML = "";
  if (peers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "net-peers-empty";
    empty.textContent = "no peers yet — the network is quiet.";
    list.appendChild(empty);
    return;
  }
  const liveCounts = new Map();
  for (const n of srwk.nodes) {
    const pk = n.primary_contributor;
    if (!pk) continue;
    liveCounts.set(pk, (liveCounts.get(pk) || 0) + 1);
  }
  const pageCount = (p) => liveCounts.get(p.pubkey) ?? p.page_count ?? 0;

  // Records per author from /sync/manifest, keyed by CANONICAL (hex) pubkey
  // so the manifest's `ed25519:<hex>` author matches the peer's base64url
  // pubkey. Computed once here instead of per-card. null ⇒ no manifest yet
  // (cards fall back to legacy page_count).
  const manifestRecords = srwk._manifest?.manifest?.records;
  let recordCounts = null;
  if (manifestRecords && typeof manifestRecords === "object") {
    recordCounts = new Map();
    for (const r of Object.values(manifestRecords)) {
      if (!r || !r.author_pubkey) continue;
      const c = canonPubkey(r.author_pubkey);
      recordCounts.set(c, (recordCounts.get(c) || 0) + 1);
    }
  }

  // Partition: active (online) peers render up top; offline fold away below.
  const active = [], offline = [];
  for (const p of peers) {
    const st = netPeerStatus(p.pubkey);
    (st.online ? active : offline).push({ p, st });
  }
  // Active: self first, then live before stale, then by page count, then name.
  const activeRank = (st) => st.isSelf ? 0 : st.statusClass === "is-live" ? 1 : 2;
  active.sort((a, b) =>
    activeRank(a.st) - activeRank(b.st)
    || pageCount(b.p) - pageCount(a.p)
    || (a.p.nickname || "").localeCompare(b.p.nickname || ""));
  // Offline: most-recently-seen first, then page count, then name.
  offline.sort((a, b) =>
    (b.st.lastMs || 0) - (a.st.lastMs || 0)
    || pageCount(b.p) - pageCount(a.p)
    || (a.p.nickname || "").localeCompare(b.p.nickname || ""));

  const now = performance.now();
  for (const { p } of active) list.appendChild(buildNetPeerCard(p, now, liveCounts, recordCounts));
  if (active.length === 0) {
    const note = document.createElement("div");
    note.className = "net-peers-empty";
    note.textContent = "no active peers right now.";
    list.appendChild(note);
  }
  if (offline.length) {
    const det = document.createElement("details");
    det.className = "net-peers-offline";
    det.open = wasOpen;
    const sum = document.createElement("summary");
    sum.className = "net-peers-offline-summary";
    sum.innerHTML =
      `<span class="npo-caret" aria-hidden="true">▸</span>` +
      `<span class="npo-label">offline</span>` +
      `<span class="npo-count">${offline.length}</span>`;
    det.appendChild(sum);
    const wrap = document.createElement("div");
    wrap.className = "net-peers-offline-list";
    for (const { p } of offline) wrap.appendChild(buildNetPeerCard(p, now, liveCounts, recordCounts));
    det.appendChild(wrap);
    list.appendChild(det);
  }
}

function buildNetPeerCard(p, now, liveCounts, recordCounts) {
  // Block-style are.na unit. Updated for Phase 2 sync: counts records (from
  // /sync/manifest, when available) and derives the live/stale/idle tag
  // from /node/log heartbeats rather than the legacy SSE liveSeen ring.
  const card = document.createElement("article");
  card.className = "net-peer-card";
  card.dataset.pubkey = p.pubkey || "";
  card.tabIndex = 0;
  card.addEventListener("click", () => {
    for (const sib of document.querySelectorAll(".net-peer-card.selected")) {
      sib.classList.remove("selected");
    }
    card.classList.add("selected");
    flyToPeerTerritory(p.pubkey);
  });
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      card.click();
    }
  });
  const color = p.signature_color || stableHue(p.pubkey);
  card.style.setProperty("--peer-color", color);

  const head = document.createElement("header");
  head.className = "npc-head";
  const nick = document.createElement("span");
  nick.className = "npc-nick";
  if (p.pubkey === srwk.selfPubkey) nick.classList.add("is-self");
  nick.textContent = p.nickname || `peer-${(p.pubkey || "").slice(0, 8)}`;
  head.appendChild(nick);

  // Status (live / stale / idle / down) + last-seen come from the shared
  // netPeerStatus() so the card, the active/offline split, and the livegraph
  // all agree on who's online.
  const { statusClass, statusText, lastMs } = netPeerStatus(p.pubkey);
  const liveTag = document.createElement("span");
  liveTag.className = `npc-live-tag ${statusClass}`;
  liveTag.textContent = statusText;
  head.appendChild(liveTag);

  const pkRow = document.createElement("div");
  pkRow.className = "npc-pk";
  const pk = p.pubkey || "";
  pkRow.textContent = pk ? `${pk.slice(0, 10)}…${pk.slice(-6)}` : "—";
  pkRow.title = pk;

  const foot = document.createElement("footer");
  foot.className = "npc-foot";
  // Phase 2: /sync/manifest is authoritative — recordCounts (computed once
  // in renderNetPeersList, keyed by canonical hex pubkey) attributes records
  // to their author. If the manifest hasn't been seen yet, fall back to the
  // legacy page_count.
  let unitLabel = "pages";
  let count;
  if (recordCounts) {
    count = recordCounts.get(canonPubkey(p.pubkey)) || 0;
    unitLabel = "records";
  } else {
    const livePc = liveCounts ? liveCounts.get(p.pubkey) : undefined;
    count = livePc ?? p.page_count ?? 0;
  }
  const pages = document.createElement("span");
  pages.className = "npc-pages";
  pages.innerHTML = `<span class="npc-num">${count}</span> <span class="npc-unit">${unitLabel}</span>`;

  // The margin-note: last-seen, right-aligned in a tight column. Uses the
  // newer sync timestamp when available; falls back to the SSE one for
  // pre-Phase-2 peers.
  const last = document.createElement("span");
  last.className = "npc-last";
  if (lastMs) {
    last.textContent = formatPeerLastSeen((Date.now() - lastMs) / 1000);
  } else if (p.last_seen) {
    last.textContent = formatPeerLastSeen((Date.now() / 1000) - p.last_seen);
  } else {
    last.textContent = "—";
  }
  foot.append(pages, last);

  card.append(head, pkRow, foot);
  return card;
}

// ─── network-tab unified panels ───────────────────────────────────────────
// Three panels in the right column + the center-bottom router slot are
// driven by /node/log + /sync/manifest. They replace the spec-v0.3
// router/tickets/receipts stubs that never lit up against Phase 2 sync.
//
// Panel IDs in index.html keep their legacy names (router-panel,
// tickets-panel, receipts-panel) to avoid touching every wireTicketsPanel
// / renderTicketsPanel / etc. call site; what they DISPLAY is repurposed.
//
// Render cadence: once on tab open + after every pollNodeLog tick that
// brings in new events. Cheap (DOM writes only when content changes).

// "SYNC · v1 · 3 peers reachable · 7 records · last activity 4s ago"
function renderNetRouterStatus() {
  const body = document.getElementById("router-panel-body");
  const counter = document.getElementById("router-panel-count");
  if (!body) return;
  // Peers reachable: count of known peers where _peerReachable !== false.
  // Treat "no reading yet" as reachable (peers we've never failed to
  // reach are assumed up; the first failed probe will flip them).
  let reachable = 0;
  for (const [pubkey] of srwk.peers) {
    if (pubkey === srwk.selfPubkey) continue;
    if (_peerReachable.get(pubkey) !== false) reachable += 1;
  }
  // Records: count of unique record_ids in /sync/manifest.
  const recs = srwk._manifest?.manifest?.records;
  const recordCount = recs && typeof recs === "object" ? Object.keys(recs).length : 0;
  // Last activity: pick whichever is newer (tick or event).
  const lastMs = Math.max(_lastTickTsMs || 0, _lastNodeLogActivityMs || 0);
  const ageStr = lastMs > 0
    ? formatPeerLastSeen((Date.now() - lastMs) / 1000)
    : "—";
  const downgraded = _nodeLogAvailable === false;
  if (counter) counter.textContent = downgraded ? "legacy" : "v1";
  body.innerHTML =
    `<div class="net-router-status">` +
      `<span class="nrs-key">SYNC</span>` +
      `<span class="nrs-sep">·</span>` +
      `<span class="nrs-val">${reachable} peer${reachable === 1 ? "" : "s"} reachable</span>` +
      `<span class="nrs-sep">·</span>` +
      `<span class="nrs-val">${recordCount} record${recordCount === 1 ? "" : "s"}</span>` +
      `<span class="nrs-sep">·</span>` +
      `<span class="nrs-val">last activity ${escHtml(ageStr)}</span>` +
    `</div>` +
    (downgraded
      ? `<div class="net-router-note">running against older daemon — only sync events visible</div>`
      : "");
}

// "SEARCH" — last few web_search_completed rows (query-hash · hits · ms).
function renderNetSearchPanel() {
  const body = document.getElementById("tickets-panel-body");
  const counter = document.getElementById("tickets-panel-epoch");
  if (!body) return;
  if (counter) counter.textContent = String(_recentSearches.length);
  if (_recentSearches.length === 0) {
    body.innerHTML = `<div class="tk-empty">no search activity yet.</div>`;
    return;
  }
  const rows = _recentSearches.slice(0, 5).map(evt => {
    const ts = formatEventTs(evt.ts_ms || Date.now());
    const qh = evt.query_hash ? `${String(evt.query_hash).slice(0, 10)}…` : "—";
    const hits = evt.hit_count != null ? evt.hit_count : "?";
    const took = evt.duration_ms != null ? `${evt.duration_ms}ms` : "—";
    return `<div class="net-search-row">` +
      `<span class="nsr-ts">${escHtml(ts)}</span>` +
      `<span class="nsr-qh"><code>${escHtml(qh)}</code></span>` +
      `<span class="nsr-hits">${escHtml(String(hits))} hit${hits === 1 ? "" : "s"}</span>` +
      `<span class="nsr-took">${escHtml(took)}</span>` +
    `</div>`;
  }).join("");
  body.innerHTML = rows;
}

// "RECORDS" — record count + latest author wall-clock age.
function renderNetRecordsPanel() {
  const body = document.getElementById("receipts-panel-body");
  const counter = document.getElementById("receipts-panel-count");
  if (!body) return;
  const recs = srwk._manifest?.manifest?.records;
  if (!recs || typeof recs !== "object" || Object.keys(recs).length === 0) {
    if (counter) counter.textContent = "0";
    body.innerHTML = `<div class="tk-empty">no records yet — waiting for the first sync.</div>`;
    return;
  }
  const ids = Object.keys(recs);
  if (counter) counter.textContent = String(ids.length);
  // Find newest by latest_wall_ts_ms.
  let newest = null;
  let newestTs = 0;
  for (const id of ids) {
    const r = recs[id];
    if (!r) continue;
    const t = r.latest_wall_ts_ms || 0;
    if (t > newestTs) { newestTs = t; newest = { id, r }; }
  }
  let latestLine = "";
  if (newest) {
    const ageStr = newestTs > 0
      ? formatPeerLastSeen((Date.now() - newestTs) / 1000)
      : "—";
    // Resolve author → nickname when we know that peer; otherwise short pk.
    const author = newest.r?.author_pubkey || "";
    const peer = author ? srwk.peers.get(author) : null;
    const who = peer?.nickname || (author ? `${author.slice(0, 10)}…` : "—");
    latestLine = `<div class="net-records-latest">latest: ${escHtml(who)} · ${escHtml(ageStr)}</div>`;
  }
  body.innerHTML =
    `<div class="net-records-count">${ids.length} record${ids.length === 1 ? "" : "s"} local</div>` +
    latestLine;
}

// ─── network-tab anonymity header ─────────────────────────────────────────
// Mirrors the same dcnetState the corner badge reads. Kept in sync via a
// shim around onAnonymitySetChanged + renderAnonBadge, plus a manual call
// when the network tab is activated.
function renderNetAnonHeader() {
  const el = document.getElementById("net-anon-header");
  if (!el) return;
  const valEl = el.querySelector(".nah-value");
  const metaEl = el.querySelector(".nah-meta");
  const p = dcnetState.lastSet;
  if (!p || (p.active_peer_count == null && p.min_anonymity_set == null)) {
    el.dataset.state = "idle";
    if (valEl) valEl.textContent = "idle";
    if (metaEl) metaEl.textContent = "no dc-net round in flight.";
    el.title = "no DC-net round in flight";
    return;
  }
  const a = p.active_peer_count ?? 0;
  const m = p.min_anonymity_set ?? 0;
  const met = (p.met === true) || (a >= m && m > 0);
  el.dataset.state = met ? "met" : "unmet";
  if (valEl) valEl.textContent = `${a}/${m} ${met ? "✓" : "⚠"}`;
  const transport = p.transport_kind || "lan_friend_dcnet_round";
  const ep = dcnetState.lastEpoch || {};
  const epoch = ep.new_epoch_id || ep.epoch_id || p.epoch_id || "—";
  if (metaEl) {
    metaEl.textContent = met
      ? `${transport} · epoch ${String(epoch).slice(0, 12)}`
      : `min anonymity-set not yet reached (${a}/${m})`;
  }
  el.title = met
    ? `LAN_FRIEND_DCNET active · ${a} peers in circle (min ${m})`
    : `LAN_FRIEND_DCNET cannot be reported until min anonymity set is reached (${a}/${m})`;
}

// ─── metrics tab ──────────────────────────────────────────────────────────
// Polls swf-node's self-contained /metrics/{snapshot,series} endpoints and
// renders a small dashboard. SVG sparklines (no Chart.js dep). No grafana,
// no prometheus — the time-series database is sqlite on the swf-node side.
//
// Polling cadence: 15s while the metrics tab is visible; suspended when
// the tab is hidden (visibilitychange + tab change).

const METRICS_RANGE_LS_KEY = "srwk:metrics:range";
const METRICS_POLL_MS = 15_000;

const RANGES = {
  "15m": { ms: 15 * 60_000,        defaultStep: 30_000 },
  "1h":  { ms: 60 * 60_000,        defaultStep: 60_000 },
  "6h":  { ms: 6 * 3600_000,       defaultStep: 5 * 60_000 },
  "24h": { ms: 24 * 3600_000,      defaultStep: 15 * 60_000 },
};

// Per-chart name lists. Each chart fetches up to two named series so it
// can plot p50 + p95 (or count-vs-rate) together; the line/area renderer
// handles 1-or-2 series uniformly.
//
// `unit` and `valueFmt` feed the hover tooltip / per-chart value label.
// `subtitle` is a one-line human description used in the chart card head.
const CHARTS = {
  "search-latency":    { names: ["web_search.duration_ms_p50", "web_search.duration_ms_p95"],
                         unit: "ms",   subtitle: "/web_search round-trip", valueFmt: (n) => `${Math.round(n)} ms` },
  "search-throughput": { names: ["web_search.total"], rate: true,
                         unit: "qpm",  subtitle: "queries / minute (per-tick)", valueFmt: (n) => `${n.toFixed(1)} qpm` },
  "scrape-latency":    { names: ["slice_scrape.duration_ms_p50", "slice_scrape.duration_ms_p95"],
                         unit: "ms",   subtitle: "fetch + parse per slice", valueFmt: (n) => `${Math.round(n)} ms` },
  "peers-active":      { names: ["peers.count_active"],
                         unit: "peers", subtitle: "last seen <5 min", valueFmt: (n) => `${Math.round(n)}` },
  "pages-total":       { names: ["pages.count_total"],
                         unit: "pages", subtitle: "graph size",       valueFmt: (n) => `${Math.round(n)}` },
  "rss-mem":           { names: ["process.rss_bytes"], leakWatch: true,
                         unit: "bytes", subtitle: "resident set size", valueFmt: (n) => formatBytes(n) },
  "cpu-percent":       { names: ["process.cpu_percent"],
                         unit: "%",    subtitle: "process CPU",       valueFmt: (n) => `${n.toFixed(1)}%` },
};

const metricsState = {
  range: "1h",
  pollTimer: 0,
  inFlight: null,
  lastSeriesByChart: new Map(),
  lastSnapshot: null,
  active: false,
};

function wireMetricsTab() {
  // Restore range preference
  try {
    const r = localStorage.getItem(METRICS_RANGE_LS_KEY);
    if (r && RANGES[r]) metricsState.range = r;
  } catch {}
  const rangeBar = document.getElementById("metrics-range");
  if (rangeBar) {
    for (const b of rangeBar.querySelectorAll(".metrics-range-btn")) {
      b.classList.toggle("selected", b.dataset.range === metricsState.range);
    }
    rangeBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".metrics-range-btn");
      if (!btn) return;
      const r = btn.dataset.range;
      if (!RANGES[r]) return;
      metricsState.range = r;
      try { localStorage.setItem(METRICS_RANGE_LS_KEY, r); } catch {}
      for (const b of rangeBar.querySelectorAll(".metrics-range-btn")) {
        b.classList.toggle("selected", b.dataset.range === r);
      }
      runMetricsRefresh();
    });
  }
  const refresh = document.getElementById("metrics-refresh");
  if (refresh) refresh.addEventListener("click", () => runMetricsRefresh());

  // Re-evaluate polling when the page becomes hidden
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMetricsPoll();
    else if (metricsState.active) startMetricsPoll();
  });

  // Inject subtitle + unit into each chart card head (one-time, post-DOM).
  // The HTML scaffold from index.html already gives us .mc-head; we extend
  // it with a subtitle row that PR4 introduces.
  for (const [chartId, cfg] of Object.entries(CHARTS)) {
    const card = document.querySelector(`.metrics-chart[data-chart="${chartId}"]`);
    if (!card) continue;
    let head = card.querySelector(".mc-head");
    if (head && !head.dataset.subtitled) {
      head.dataset.subtitled = "1";
      const sub = document.createElement("div");
      sub.className = "mc-subtitle";
      sub.textContent = cfg.subtitle || "";
      head.appendChild(sub);
    }
    // Ensure each chart SVG has a click-to-zoom affordance + hover overlay
    if (!card.dataset.zoomWired) {
      card.dataset.zoomWired = "1";
      const zoomBtn = document.createElement("button");
      zoomBtn.className = "mc-zoom";
      zoomBtn.type = "button";
      zoomBtn.title = "expand chart";
      zoomBtn.setAttribute("aria-label", "expand chart");
      zoomBtn.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5l-5 5"/><path d="M6.5 13.5h-4v-4"/><path d="M2.5 13.5l5-5"/></svg>`;
      zoomBtn.addEventListener("click", () => openChartZoomModal(chartId));
      card.appendChild(zoomBtn);
    }
  }
  // Single delegated mousemove + mouseleave per metrics view, dispatched
  // to whichever chart is under the pointer. Cheaper than wiring N x 7
  // chart listeners.
  const mView = document.getElementById("metrics-view");
  if (mView && !mView.dataset.hoverWired) {
    mView.dataset.hoverWired = "1";
    mView.addEventListener("mousemove", onMetricsHover, true);
    mView.addEventListener("mouseleave", () => clearMetricsHover(), true);
  }
}

function onMetricsTabActivated() {
  metricsState.active = true;
  runMetricsRefresh();
  startMetricsPoll();
}

function onMetricsTabDeactivated() {
  metricsState.active = false;
  stopMetricsPoll();
}

function startMetricsPoll() {
  stopMetricsPoll();
  metricsState.pollTimer = setInterval(() => {
    if (document.hidden || !metricsState.active) return;
    runMetricsRefresh();
  }, METRICS_POLL_MS);
}

function stopMetricsPoll() {
  if (metricsState.pollTimer) {
    clearInterval(metricsState.pollTimer);
    metricsState.pollTimer = 0;
  }
}

async function runMetricsRefresh() {
  const status = document.getElementById("metrics-status");
  if (status) status.textContent = "loading.";
  try {
    await Promise.all([fetchMetricsSnapshot(), fetchMetricsCharts()]);
    if (status) status.textContent = `last update ${formatEventTs(Date.now())}`;
  } catch (e) {
    if (status) status.textContent = `error: ${e?.message || String(e)}`;
  }
}

async function fetchMetricsSnapshot() {
  const r = await fetch(`${srwk.serverUrl}/metrics/snapshot`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  metricsState.lastSnapshot = data;
  renderMetricsSnapshot(data);
}

function renderMetricsSnapshot(data) {
  const v = data?.values || {};
  // Animated numeric updates (Stripe-press style) — tickNumber tweens
  // from the previously-rendered value to the new one in 280ms ease-out,
  // then snaps. Tabular figures (set on .ms-value via the .num utility)
  // keep glyph widths fixed during the tween.
  const setStat = (name, fmt) => {
    const el = document.querySelector(`[data-stat="${name}"]`);
    if (!el) return;
    if (v[name] == null) {
      el.textContent = "—";
      return;
    }
    tickNumber(el, v[name], { format: fmt });
  };
  setStat("peers.count_active", (n) => String(Math.round(n)));
  const sub = document.querySelector('[data-stat-sub="peers.count_known"]');
  if (sub && v["peers.count_known"] != null) sub.textContent = `of ${Math.round(v["peers.count_known"])}`;
  setStat("pages.count_total", (n) => String(Math.round(n)));
  setStat("contributions.count_total", (n) => String(Math.round(n)));
  setStat("events.lag_secs", (n) => `${Math.round(n)}s`);
  setStat("process.rss_bytes", formatBytes);
  setStat("process.cpu_percent", (n) => `${(n).toFixed(1)}%`);

  const empty = document.getElementById("metrics-empty");
  if (empty) {
    const hasAny = Object.keys(v).length > 0;
    empty.hidden = hasAny;
  }
}

function formatBytes(n) {
  if (n == null) return "—";
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function fetchMetricsCharts() {
  const range = RANGES[metricsState.range];
  if (!range) return;
  const until = Date.now();
  const from = until - range.ms;
  // Aggregate every chart's series names into a single /metrics/series call
  // so we don't fan out N requests per refresh. Server-side bucketing
  // keeps the response small.
  const allNames = [];
  for (const cfg of Object.values(CHARTS)) {
    for (const n of cfg.names) if (!allNames.includes(n)) allNames.push(n);
  }
  const url = `${srwk.serverUrl}/metrics/series?names=${encodeURIComponent(allNames.join(","))}&from=${from}&until=${until}&step=${range.defaultStep}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  // Index series by name
  const byName = new Map();
  for (const row of data.series || []) {
    let arr = byName.get(row.name);
    if (!arr) { arr = []; byName.set(row.name, arr); }
    arr.push(row);
  }
  for (const arr of byName.values()) arr.sort((a, b) => a.ts_ms - b.ts_ms);
  // Render each chart
  for (const [chartId, cfg] of Object.entries(CHARTS)) {
    const card = document.querySelector(`.metrics-chart[data-chart="${chartId}"]`);
    if (!card) continue;
    const svg = card.querySelector(".mc-svg");
    if (!svg) continue;
    const seriesArr = cfg.names.map((n) => byName.get(n) || []);
    let pointsArr;
    if (cfg.rate) {
      // Convert cumulative count → per-minute rate (delta / dt_min)
      pointsArr = seriesArr.map((rows) => toRatePoints(rows, range.defaultStep));
    } else {
      pointsArr = seriesArr.map((rows) => rows.map((r) => ({ x: r.ts_ms, y: r.value })));
    }
    drawSparkline(svg, pointsArr, { from, until, leakWatch: cfg.leakWatch, leakLabelEl: card.querySelector(".mc-leak") });
    // First-paint reveal: clip-path slides left-to-right over 600ms ease-
    // out. revealOnce() is idempotent (data-revealed flag) — re-renders
    // on subsequent refreshes don't re-animate.
    revealOnce(svg, { duration: 620 });
  }
}

function toRatePoints(rows, step_ms) {
  // The metrics collector resets web_search.total per tick; so the value
  // is essentially the per-tick count. Convert to per-minute by scaling
  // by (60_000 / step_ms). When the tick interval is 10s and step is 60s
  // the avg over a bucket is ~the per-10s count; multiplying by 6 makes
  // it per-minute. Good enough for a sparkline.
  const scale = 60_000 / Math.max(1, step_ms);
  return rows.map((r) => ({ x: r.ts_ms, y: r.value * scale }));
}

// Light-weight SVG sparkline. Accepts up to N point-arrays — primary draws
// solid, the rest dashed (used for p95 overlay). All in 280×140 viewBox to
// match the CSS. PR4 adds: anomaly dots, geometry record on the SVG dataset
// for the delegated hover handler, viewBox-aware crosshair group.
function drawSparkline(svg, pointsArr, opts = {}) {
  const W = 280, H = 140, padL = 28, padR = 6, padT = 8, padB = 14;
  // Compute global x/y range
  const xMin = opts.from ?? Math.min(...pointsArr.flat().map(p => p.x));
  const xMax = opts.until ?? Math.max(...pointsArr.flat().map(p => p.x));
  let yMin = Infinity, yMax = -Infinity;
  let totalPts = 0;
  for (const arr of pointsArr) {
    for (const p of arr) {
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
      totalPts++;
    }
  }
  if (totalPts === 0) {
    svg.innerHTML = `<text class="mc-empty" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">no data yet.</text>`;
    delete svg.dataset.geom;
    return;
  }
  // Pad y range a bit; force a non-zero range so flat lines still draw
  if (yMin === yMax) { yMin -= 1; yMax += 1; }
  const yPad = (yMax - yMin) * 0.08;
  yMin -= yPad; yMax += yPad;
  if (yMin < 0 && pointsArr[0]?.[0]?.y >= 0) yMin = 0;

  const sx = (x) => padL + (W - padL - padR) * (xMax > xMin ? (x - xMin) / (xMax - xMin) : 0.5);
  const sy = (y) => padT + (H - padT - padB) * (1 - (y - yMin) / Math.max(1e-9, yMax - yMin));

  const lines = [];
  pointsArr.forEach((arr, i) => {
    if (!arr.length) return;
    const cls = i === 0 ? "mc-line" : "mc-line-p95";
    const d = arr.map((p, j) => `${j === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
    lines.push(`<path class="${cls}" d="${d}" />`);
  });
  // Filled area under the primary line
  let area = "";
  if (pointsArr[0]?.length) {
    const arr = pointsArr[0];
    const dStart = `M${sx(arr[0].x).toFixed(1)},${sy(yMin).toFixed(1)}`;
    const dLine = arr.map((p) => `L${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
    const dEnd = ` L${sx(arr[arr.length - 1].x).toFixed(1)},${sy(yMin).toFixed(1)} Z`;
    area = `<path class="mc-area" d="${dStart} ${dLine}${dEnd}" />`;
  }
  // Anomaly callouts — flag points >2σ from the rolling mean of the primary
  // series. (Strict 3σ rarely fires on a 60-tick sparkline.) Skip for
  // counters that only ever go up — pages_total, contributions_total —
  // because their slope is informative but every point IS the new max.
  let anomalies = "";
  let anomalyList = [];
  if (pointsArr[0]?.length > 6 && !opts.suppressAnomaly) {
    const arr = pointsArr[0];
    const n = arr.length;
    let sum = 0, sumSq = 0;
    for (const p of arr) { sum += p.y; sumSq += p.y * p.y; }
    const mean = sum / n;
    const variance = Math.max(0, sumSq / n - mean * mean);
    const std = Math.sqrt(variance);
    // Don't bother flagging when the spread is genuinely uniform.
    if (std > 0 && std / Math.max(1e-9, Math.abs(mean) + 1) > 0.05) {
      const dots = [];
      for (let i = 0; i < n; i++) {
        const p = arr[i];
        const z = (p.y - mean) / std;
        if (Math.abs(z) >= 2) {
          dots.push(`<circle class="mc-anom" cx="${sx(p.x).toFixed(1)}" cy="${sy(p.y).toFixed(1)}" r="2.6"/>`);
          anomalyList.push({ x: p.x, y: p.y, z });
        }
      }
      anomalies = dots.join("");
    }
  }
  // Y-axis labels
  const fmt = (y) => {
    if (Math.abs(y) >= 1024 * 1024) return `${(y / (1024 * 1024)).toFixed(0)}M`;
    if (Math.abs(y) >= 1024) return `${(y / 1024).toFixed(0)}K`;
    if (Math.abs(y) < 1) return y.toFixed(2);
    if (Math.abs(y) < 10) return y.toFixed(1);
    return Math.round(y).toString();
  };
  const yLabels = [
    `<text x="${padL - 4}" y="${(sy(yMax) + 4).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${fmt(yMax)}</text>`,
    `<text x="${padL - 4}" y="${(sy(yMin) + 1).toFixed(1)}" text-anchor="end" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${fmt(yMin)}</text>`,
  ];
  // X-axis labels (start + end)
  const tFmt = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const xLabels = [
    `<text x="${padL}" y="${H - 2}" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${tFmt(xMin)}</text>`,
    `<text x="${W - padR}" y="${H - 2}" text-anchor="end" font-family="monospace" font-size="9" fill="rgba(220,232,255,0.55)">${tFmt(xMax)}</text>`,
  ];

  // Leak watch — linear regression slope (bytes/ms) on the primary series.
  if (opts.leakWatch && opts.leakLabelEl && pointsArr[0]?.length > 4) {
    const arr = pointsArr[0];
    const n = arr.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    for (const p of arr) { sumX += p.x; sumY += p.y; sumXY += p.x * p.y; sumXX += p.x * p.x; }
    const denom = n * sumXX - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    // Convert slope (bytes/ms) → bytes/hour for legibility
    const bytesPerHour = slope * 3600_000;
    const isLeak = bytesPerHour > 1024 * 1024 * 5;  // > 5 MB/hr = warn
    opts.leakLabelEl.dataset.state = isLeak ? "warn" : "ok";
    const sign = bytesPerHour >= 0 ? "+" : "−";
    opts.leakLabelEl.textContent = `${sign}${formatBytes(Math.abs(bytesPerHour))}/hr`;
  }

  // Crosshair group — initially hidden; revealed by onMetricsHover.
  const cross = `
    <g class="mc-cross" style="display:none">
      <line class="mc-cross-v" y1="${padT}" y2="${H - padB}" />
      <circle class="mc-cross-dot-1" r="3" />
      <circle class="mc-cross-dot-2" r="2.6" />
    </g>
  `;
  svg.innerHTML = area + lines.join("") + anomalies + yLabels.join("") + xLabels.join("") + cross;
  // Stash everything the hover handler needs onto the SVG element.
  svg._geom = {
    W, H, padL, padR, padT, padB,
    xMin, xMax, yMin, yMax,
    series: pointsArr,
    anomalies: anomalyList,
    sx, sy,
  };
}

// ─── metrics chart hover crosshair + tooltip ─────────────────────────────
// Single delegated handler walks up to the .metrics-chart card under the
// pointer, snaps to the nearest x-bucket on the primary series, and
// renders a floating tooltip with value + ts + delta-from-mean + a hot
// "ANOMALY" pill if the point is one of the >2σ outliers we already
// flagged in drawSparkline.

let metricsTooltipEl = null;

function ensureMetricsTooltip() {
  if (metricsTooltipEl && document.body.contains(metricsTooltipEl)) return metricsTooltipEl;
  metricsTooltipEl = document.createElement("div");
  metricsTooltipEl.className = "mc-tooltip";
  metricsTooltipEl.hidden = true;
  document.body.appendChild(metricsTooltipEl);
  return metricsTooltipEl;
}

function clearMetricsHover() {
  if (!metricsTooltipEl) return;
  metricsTooltipEl.hidden = true;
  for (const svg of document.querySelectorAll(".metrics-chart .mc-svg")) {
    const g = svg.querySelector(".mc-cross");
    if (g) g.style.display = "none";
  }
}

function onMetricsHover(e) {
  const card = e.target.closest(".metrics-chart");
  if (!card) { clearMetricsHover(); return; }
  const svg = card.querySelector(".mc-svg");
  if (!svg || !svg._geom) { clearMetricsHover(); return; }
  const geom = svg._geom;
  // Convert pointer position to SVG viewBox coords. SVG viewBox is 280×140;
  // we use getBoundingClientRect for the actual rendered size.
  const rect = svg.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / Math.max(1, rect.width);
  const yRatio = (e.clientY - rect.top) / Math.max(1, rect.height);
  const xViewBox = xRatio * geom.W;
  if (xViewBox < geom.padL || xViewBox > geom.W - geom.padR) { clearMetricsHover(); return; }
  // Reverse-map pixel→time
  const t = geom.xMin + (xViewBox - geom.padL) / (geom.W - geom.padL - geom.padR) * (geom.xMax - geom.xMin);
  // Find the closest point on the primary series
  const primary = geom.series[0] || [];
  if (!primary.length) { clearMetricsHover(); return; }
  let nearest = primary[0], ndt = Infinity;
  for (const p of primary) {
    const d = Math.abs(p.x - t);
    if (d < ndt) { ndt = d; nearest = p; }
  }
  // Optional secondary series — pick closest by x
  const secondary = geom.series[1] || [];
  let near2 = null;
  if (secondary.length) {
    let n2dt = Infinity;
    for (const p of secondary) {
      const d = Math.abs(p.x - nearest.x);
      if (d < n2dt) { n2dt = d; near2 = p; }
    }
  }
  // Compute mean of primary series for delta callout
  let sum = 0;
  for (const p of primary) sum += p.y;
  const mean = sum / primary.length;
  const delta = nearest.y - mean;
  const isAnomaly = (geom.anomalies || []).some(a => a.x === nearest.x);

  // Draw crosshair on the SVG
  const g = svg.querySelector(".mc-cross");
  if (g) {
    g.style.display = "";
    const cx = geom.sx(nearest.x);
    const cy1 = geom.sy(nearest.y);
    const v = g.querySelector(".mc-cross-v");
    if (v) { v.setAttribute("x1", cx); v.setAttribute("x2", cx); }
    const dot1 = g.querySelector(".mc-cross-dot-1");
    if (dot1) { dot1.setAttribute("cx", cx); dot1.setAttribute("cy", cy1); }
    const dot2 = g.querySelector(".mc-cross-dot-2");
    if (dot2) {
      if (near2) {
        dot2.setAttribute("cx", cx);
        dot2.setAttribute("cy", geom.sy(near2.y));
        dot2.style.display = "";
      } else {
        dot2.style.display = "none";
      }
    }
  }

  // Position the floating tooltip near the pointer (clamp to viewport)
  const tip = ensureMetricsTooltip();
  const chartId = card.dataset.chart;
  const cfg = CHARTS[chartId] || {};
  const fmt = cfg.valueFmt || ((n) => n.toString());
  const ts = new Date(nearest.x);
  const tsStr = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
  const deltaStr = (delta >= 0 ? "+" : "−") + fmt(Math.abs(delta));
  const deltaCls = Math.abs(delta) > Math.abs(mean) * 0.30 ? "mc-tt-delta-warn" : "mc-tt-delta";
  tip.innerHTML = `
    <div class="mc-tt-row mc-tt-title">${escHtml(cfg.subtitle || chartId || "")}</div>
    <div class="mc-tt-row mc-tt-value">${escHtml(fmt(nearest.y))}</div>
    ${near2 != null ? `<div class="mc-tt-row mc-tt-row-2"><span class="mc-tt-k">p95</span><span class="mc-tt-v">${escHtml(fmt(near2.y))}</span></div>` : ""}
    <div class="mc-tt-row"><span class="mc-tt-k">ts</span><span class="mc-tt-v">${tsStr}</span></div>
    <div class="mc-tt-row"><span class="mc-tt-k">δ from mean</span><span class="mc-tt-v ${deltaCls}">${escHtml(deltaStr)}</span></div>
    ${isAnomaly ? `<div class="ux-pill" data-kind="warn" style="margin-top:4px;">anomaly · ≥2σ</div>` : ""}
  `;
  tip.hidden = false;
  // Position
  const tipRect = tip.getBoundingClientRect();
  let tx = e.clientX + 14;
  let ty = e.clientY + 14;
  if (tx + tipRect.width > window.innerWidth - 8) tx = e.clientX - tipRect.width - 14;
  if (ty + tipRect.height > window.innerHeight - 8) ty = e.clientY - tipRect.height - 14;
  tip.style.left = `${Math.max(8, tx)}px`;
  tip.style.top = `${Math.max(8, ty)}px`;
}

// ── click-to-zoom modal — same chart at 2× size, no shared state ──
function openChartZoomModal(chartId) {
  const cfg = CHARTS[chartId];
  if (!cfg) return;
  const sourceCard = document.querySelector(`.metrics-chart[data-chart="${chartId}"]`);
  if (!sourceCard) return;
  const titleEl = sourceCard.querySelector(".mc-title");
  const title = titleEl?.textContent || chartId;
  const subtitle = cfg.subtitle || "";

  const backdrop = document.createElement("div");
  backdrop.className = "ux-modal-backdrop mc-zoom-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.innerHTML = `
    <div class="ux-modal mc-zoom-modal" role="document">
      <header class="mc-zoom-head">
        <div>
          <div class="mc-zoom-title">${escHtml(title)}</div>
          <div class="mc-zoom-subtitle">${escHtml(subtitle)}</div>
        </div>
        <button class="ux-modal-close mc-zoom-close" type="button" aria-label="close">&times;</button>
      </header>
      <div class="mc-zoom-body">
        <svg class="mc-zoom-svg" viewBox="0 0 280 140" preserveAspectRatio="none"></svg>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  requestAnimationFrame(() => backdrop.classList.add("entered"));
  const close = () => {
    backdrop.classList.add("leaving");
    const cleanup = () => backdrop.remove();
    if (isReducedMotion()) cleanup();
    else backdrop.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 400);
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  backdrop.querySelector(".mc-zoom-close").addEventListener("click", close);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);

  // Replicate the most-recent series payload onto the modal SVG.
  const sourceSvg = sourceCard.querySelector(".mc-svg");
  const geom = sourceSvg?._geom;
  const modalSvg = backdrop.querySelector(".mc-zoom-svg");
  if (geom && modalSvg) {
    drawSparkline(modalSvg, geom.series, {
      from: geom.xMin, until: geom.xMax,
      leakWatch: cfg.leakWatch, leakLabelEl: null,
    });
    // Wire the same hover handler scoped to the modal SVG so the crosshair
    // still works at 2x size. We attach to the parent so geometry uses the
    // modal's bounding rect.
    const onMove = (e) => {
      const ev = new MouseEvent("mousemove", { clientX: e.clientX, clientY: e.clientY });
      // Fake a target so the existing handler picks the modal's chart card
      Object.defineProperty(ev, "target", { value: modalSvg, writable: false });
      // We don't have a card for the modal SVG; emulate inline:
      onMetricsHoverModal(modalSvg, e);
    };
    modalSvg.addEventListener("mousemove", onMove);
    modalSvg.addEventListener("mouseleave", () => clearMetricsHover());
  }
}

function onMetricsHoverModal(svg, e) {
  // Lighter-weight version — same reverse mapping but uses CHARTS lookup
  // by the chart-id stored on the modal title to pick the unit fmt.
  if (!svg._geom) return;
  // Synthesize an event that the regular delegated handler can use.
  const fakeCard = document.createElement("div");
  fakeCard.className = "metrics-chart";
  // Find the chart id by walking up to the modal head's title text (best-
  // effort; keeps the tooltip generic when the title doesn't match).
  fakeCard.dataset.chart = "";
  // Easier: call the same internal logic by dispatching mousemove on the
  // svg with a synthetic pseudo-card. To avoid plumbing, just invoke
  // onMetricsHover with a fake target.
  const origTarget = e.target;
  Object.defineProperty(e, "target", { value: svg, configurable: true, get: () => svg });
  // Manually find the closest .metrics-chart ancestor — won't exist for
  // the modal, so we wrap minimally:
  const tmp = document.createElement("div");
  tmp.className = "metrics-chart";
  tmp.dataset.chart = svg.dataset.chartId || "";
  tmp.appendChild(svg.cloneNode(false));  // placeholder so .closest works
  // Simpler: just call onMetricsHover with closest ancestor real card or
  // synthesize. For now, call the handler with the real svg and let the
  // closest-up chain miss → it would clearMetricsHover. So instead inline
  // a small clone:
  const card = svg.closest(".mc-zoom-modal");
  if (!card) return;
  const geom = svg._geom;
  const rect = svg.getBoundingClientRect();
  const xRatio = (e.clientX - rect.left) / Math.max(1, rect.width);
  const xViewBox = xRatio * geom.W;
  if (xViewBox < geom.padL || xViewBox > geom.W - geom.padR) { clearMetricsHover(); return; }
  const t = geom.xMin + (xViewBox - geom.padL) / (geom.W - geom.padL - geom.padR) * (geom.xMax - geom.xMin);
  const primary = geom.series[0] || [];
  if (!primary.length) { clearMetricsHover(); return; }
  let nearest = primary[0], ndt = Infinity;
  for (const p of primary) { const d = Math.abs(p.x - t); if (d < ndt) { ndt = d; nearest = p; } }
  const tip = ensureMetricsTooltip();
  let sum = 0; for (const p of primary) sum += p.y; const mean = sum / primary.length;
  const delta = nearest.y - mean;
  const ts = new Date(nearest.x);
  const tsStr = `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}:${String(ts.getSeconds()).padStart(2, "0")}`;
  const fmt = (n) => Math.abs(n) >= 1024 ? `${Math.round(n)}` : `${n.toFixed(1)}`;
  tip.innerHTML = `
    <div class="mc-tt-row mc-tt-value">${escHtml(fmt(nearest.y))}</div>
    <div class="mc-tt-row"><span class="mc-tt-k">ts</span><span class="mc-tt-v">${tsStr}</span></div>
    <div class="mc-tt-row"><span class="mc-tt-k">δ from mean</span><span class="mc-tt-v">${(delta >= 0 ? "+" : "−") + escHtml(fmt(Math.abs(delta)))}</span></div>
  `;
  tip.hidden = false;
  const tipRect = tip.getBoundingClientRect();
  let tx = e.clientX + 14, ty = e.clientY + 14;
  if (tx + tipRect.width > window.innerWidth - 8) tx = e.clientX - tipRect.width - 14;
  if (ty + tipRect.height > window.innerHeight - 8) ty = e.clientY - tipRect.height - 14;
  tip.style.left = `${Math.max(8, tx)}px`;
  tip.style.top = `${Math.max(8, ty)}px`;
  // Restore target to be safe (no-op for cloned event)
  Object.defineProperty(e, "target", { value: origTarget, configurable: true });
  // Crosshair on modal svg
  const g = svg.querySelector(".mc-cross");
  if (g) {
    g.style.display = "";
    const cx = geom.sx(nearest.x);
    const cy1 = geom.sy(nearest.y);
    const v = g.querySelector(".mc-cross-v"); if (v) { v.setAttribute("x1", cx); v.setAttribute("x2", cx); }
    const dot1 = g.querySelector(".mc-cross-dot-1"); if (dot1) { dot1.setAttribute("cx", cx); dot1.setAttribute("cy", cy1); }
  }
}

window.srwk = srwk;  // expose for devtools
window.__srwk_zoom = openChartZoomModal;  // dev: __srwk_zoom("rss-mem")
// Debug hook so the live-graph state can be inspected from devtools without
// fishing it out of the module closure. Cheap; one reference.
window.__srwk_livegraph = (function() { return livegraphState; })();

// Dev-only: synthetic event injector for visualizing DC-net family without
// a live server. Call from devtools console:
//   __srwk_inject_event("dcnet_round_started", {round_id:"r1", qid:"q-deadbeef", anonymity_set_size:5, min_set_met:true})
// Routed through the same path as a real SSE event so every panel updates.
window.__srwk_inject_event = (kind, payload = {}) => {
  const evt = { kind, payload, ts: Date.now() };
  try {
    if (kind === "anonymity_set_changed") onAnonymitySetChanged(payload);
    else if (kind === "dcnet_round_started") onDcnetRoundStarted(payload);
    else if (kind === "dcnet_round_complete") onDcnetRoundComplete(payload);
    else if (kind === "ticket_issued") onTicketIssued(payload);
    else if (kind === "ticket_redeemed") onTicketRedeemed(payload);
    else if (kind === "receipt_submitted") onReceiptSubmitted(payload);
    else if (kind === "epoch_rotated") onEpochRotated(payload);
    else if (kind === "web_search_completed") onWebSearchCompleted(payload);
  } catch (e) { console.warn("[inject]", e); }
  appendTrafficEvent(evt);
  pushTimelineTick(evt);
  try { livegraphPushFromEvent(evt); } catch (e) { console.warn("[livegraph inject]", e); }
};

boot().then(() => {
  // Renderer-ready sentinel for --smoke-test: boot() resolving means the
  // module graph evaluated (the v0.2.14 failure point) and initial init
  // ran without throwing. Harmless no-op in normal launches.
  try { window.api?.signalReady?.(); } catch {}
}).catch((e) => {
  console.error("[boot]", e);
  setStatus("boot failed: " + e.message, true);
});

// ─── NETWORK · GLANCE VIEW renderers (v0.2.12) ───────────────────────
//
// The new default view of the network tab — cohort at a glance.
// Reads from the same `srwk` state as the existing tab, so SSE updates
// are picked up automatically. Existing tab is preserved as `Debug` mode.
//
// Mode toggle persists in localStorage. Periodic refresh on a 5s timer
// (independent of the existing 10s peer-list refresh) so glance stays
// live without re-architecting the existing render call sites.

(function setupGlanceView() {
  const LS_KEY = "sros.net-view-mode";

  // Search-event ring buffer for the rhythm sparkline. We attach our own
  // listener to the SSE EventSource (srwk.eventSource) on first refresh
  // — no mutation of the existing appendEvent pipeline, no risk of
  // breaking the existing renderer.
  const searchHistory = []; // {ts: epoch_ms}
  const SEARCH_HISTORY_MAX = 500;
  let _searchListenerAttached = false;

  function recordSearch(tsMs) {
    searchHistory.push({ ts: tsMs });
    if (searchHistory.length > SEARCH_HISTORY_MAX) searchHistory.shift();
  }

  function maybeAttachSearchListener() {
    if (_searchListenerAttached) return;
    const es = (typeof srwk !== "undefined") && srwk && srwk.eventSource;
    if (!es || !es.addEventListener) return;
    const handler = () => recordSearch(Date.now());
    try {
      es.addEventListener("web_search_completed", handler);
      es.addEventListener("web_search_started", handler);
      _searchListenerAttached = true;
    } catch {}
  }

  // ─── helpers ─────────────────────────────────────────────────────

  function peerStateFor(p, nowMs) {
    // Self is always live by definition — the local node, talking to
    // itself, doesn't send itself SSE events, so liveSeen has no entry.
    // Without this guard the headline read "you're the only one here"
    // even when you were actively driving searches, and the live count
    // showed 0 in a tab whose whole job is to display "who's online".
    if (p.pubkey && p.pubkey === srwk.selfPubkey) return "live";
    // LIVE: SSE activity in last 60s OR successful_pulls advanced very recently.
    // RECENT: any activity in last 6h.
    // OFFLINE: nothing in 6h+.
    const lastSeen = srwk.liveSeen && srwk.liveSeen.get(p.pubkey);
    const ageMs = lastSeen != null ? (performance.now() - lastSeen) : Infinity;
    if (ageMs < 60_000) return "live";
    if (ageMs < 6 * 3600_000) return "recent";
    // Fall back to peer's last_seen_at wall-clock if set
    if (p.last_seen_at) {
      try {
        const wallAge = Date.now() - Date.parse(p.last_seen_at);
        if (wallAge < 60_000) return "live";
        if (wallAge < 6 * 3600_000) return "recent";
      } catch {}
    }
    return "offline";
  }

  const GLANCE_HUES = [
    "var(--gpeer-sage)", "var(--gpeer-ochre)", "var(--gpeer-azure)",
    "var(--gpeer-plum)", "var(--gpeer-teal)",  "var(--gpeer-amber)",
    "var(--gpeer-violet)", "var(--gpeer-moss)", "var(--gpeer-rose)",
  ];
  function peerHue(pubkey, idx) {
    if (pubkey === srwk.selfPubkey) return "var(--gpeer-self)";
    // Deterministic — based on pubkey hash so colors are stable across reloads
    if (!pubkey) return GLANCE_HUES[idx % GLANCE_HUES.length];
    let h = 0;
    for (let i = 0; i < pubkey.length; i++) h = (h * 31 + pubkey.charCodeAt(i)) | 0;
    return GLANCE_HUES[Math.abs(h) % GLANCE_HUES.length];
  }

  function fmtRelative(deltaMs) {
    if (deltaMs == null || !isFinite(deltaMs)) return "—";
    const s = Math.floor(deltaMs / 1000);
    if (s < 5)        return "just now";
    if (s < 60)       return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)       return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24)       return `${h}h`;
    const d = Math.floor(h / 24);
    return `${d}d`;
  }

  function lastSeenMs(p) {
    const sse = srwk.liveSeen && srwk.liveSeen.get(p.pubkey);
    if (sse != null) return performance.now() - sse;
    if (p.last_seen_at) {
      try { return Date.now() - Date.parse(p.last_seen_at); } catch {}
    }
    return null;
  }

  function pageCountFor(pubkey) {
    if (!srwk.nodes) return 0;
    let n = 0;
    for (const node of srwk.nodes) {
      if (node.primary_contributor === pubkey) n++;
    }
    return n;
  }

  // ─── sub-renderers ───────────────────────────────────────────────

  function renderGlanceHero() {
    const peers = [...(srwk.peers ? srwk.peers.values() : [])];
    const now = performance.now();
    const live = peers.filter(p => peerStateFor(p, now) === "live").length;
    const total = peers.length;

    const stateEl = document.getElementById("glance-state-line");
    if (stateEl) stateEl.textContent = `${live} live · ${total} reachable`;

    const prefixEl = document.getElementById("glance-headline-prefix");
    const emphEl = document.getElementById("glance-headline-emphasis");
    if (prefixEl && emphEl) {
      if (live <= 1) {
        prefixEl.textContent = "You're the only one";
        emphEl.textContent = "here right now.";
      } else if (live === 2) {
        prefixEl.textContent = "Two of us are";
        emphEl.textContent = "here right now.";
      } else {
        const names = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
        const word = live <= 10 ? names[live] : String(live);
        prefixEl.textContent = `${word} of us are`;
        emphEl.textContent = "here right now.";
      }
    }
  }

  function renderGlanceNumbers() {
    const peers = [...(srwk.peers ? srwk.peers.values() : [])];
    const now = performance.now();
    const live = peers.filter(p => peerStateFor(p, now) === "live").length;
    const recent = peers.filter(p => peerStateFor(p, now) === "recent").length;
    const total = peers.length;

    let shared = 0, pulled = 0;
    if (srwk.nodes) {
      for (const n of srwk.nodes) {
        if (!n.primary_contributor) continue;
        if (n.primary_contributor === srwk.selfPubkey) shared++;
        else pulled++;
      }
    }

    const c = document.getElementById("glance-num-cohort"); if (c) c.textContent = String(total);
    const csub = document.getElementById("glance-cohort-sub");
    if (csub) csub.textContent = `peers known · ${live} live now · ${live + recent} active today`;

    const s = document.getElementById("glance-num-shared"); if (s) s.textContent = String(shared);
    const p = document.getElementById("glance-num-pulled"); if (p) p.textContent = String(pulled);

    // Queries today: count search events in last 24h from our ring buffer
    const dayAgo = Date.now() - 24 * 3600_000;
    const todayQueries = searchHistory.filter(e => e.ts > dayAgo).length;
    const totalHits = todayQueries; // TODO v0.2.13: also surface hit_count from events
    const q = document.getElementById("glance-num-queries"); if (q) q.textContent = String(todayQueries);
    const qf = document.getElementById("glance-num-queries-frac");
    if (qf) qf.textContent = totalHits > 0 ? ` · ${totalHits} hits` : "";
  }

  function renderGlanceRing() {
    const peersList = [...(srwk.peers ? srwk.peers.values() : [])];
    // Exclude self from the ring — self sits at center
    const peers = peersList.filter(p => p.pubkey !== srwk.selfPubkey);

    const raysG = document.getElementById("glance-rays");
    const peersG = document.getElementById("glance-peers");
    if (!raysG || !peersG) return;
    raysG.innerHTML = "";
    peersG.innerHTML = "";

    const total = Math.max(1, peers.length);
    const now = performance.now();

    // Position peers around the ring deterministically (by pubkey hash)
    const positions = peers.map((p, i) => {
      let h = 0;
      const k = p.pubkey || String(i);
      for (let j = 0; j < k.length; j++) h = (h * 31 + k.charCodeAt(j)) | 0;
      const a = (Math.abs(h) % 1000) / 1000 * Math.PI * 2 - Math.PI / 2;
      return { p, a, x: Math.cos(a) * 95, y: Math.sin(a) * 95, idx: i };
    });

    // First pass: rays
    for (const { p, x, y, idx } of positions) {
      const state = peerStateFor(p, now);
      const color = state === "offline" ? null : peerHue(p.pubkey, idx);
      const r = document.createElementNS("http://www.w3.org/2000/svg", "line");
      r.setAttribute("class", "ray " + state);
      r.setAttribute("x1", 0); r.setAttribute("y1", 0);
      r.setAttribute("x2", x * 0.92); r.setAttribute("y2", y * 0.92);
      if (color) r.setAttribute("stroke", color);
      r.setAttribute("opacity", state === "live" ? 0.55 : state === "recent" ? 0.28 : 0.18);
      raysG.appendChild(r);
    }

    // Chord lines between live peers — "we're all connected right now"
    const live = positions.filter(({ p }) => peerStateFor(p, now) === "live");
    for (let i = 0; i < live.length; i++) {
      for (let j = i + 1; j < live.length; j++) {
        const a = live[i], b = live[j];
        const chord = document.createElementNS("http://www.w3.org/2000/svg", "path");
        const mx = (a.x + b.x) * 0.3, my = (a.y + b.y) * 0.3;
        chord.setAttribute("d", `M ${a.x * 0.9} ${a.y * 0.9} Q ${mx} ${my} ${b.x * 0.9} ${b.y * 0.9}`);
        chord.setAttribute("fill", "none");
        chord.setAttribute("stroke", "var(--goxide-soft)");
        chord.setAttribute("stroke-width", "0.6");
        chord.setAttribute("opacity", "0.35");
        raysG.appendChild(chord);
      }
    }

    // Second pass: halo + dot for each peer
    let liveN = 0, recentN = 0, offN = 0;
    for (const { p, x, y, idx } of positions) {
      const state = peerStateFor(p, now);
      const color = state === "offline" ? null : peerHue(p.pubkey, idx);
      if (state === "live" && color) {
        liveN++;
        const halo = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        halo.setAttribute("class", "peer-halo");
        halo.setAttribute("cx", x); halo.setAttribute("cy", y);
        halo.setAttribute("r", 7);
        halo.setAttribute("fill", color);
        halo.setAttribute("opacity", "0.25");
        peersG.appendChild(halo);
      } else if (state === "recent") recentN++;
      else offN++;

      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("class", "peer-dot " + state);
      c.setAttribute("cx", x); c.setAttribute("cy", y);
      c.setAttribute("r", state === "live" ? 4 : state === "recent" ? 3 : 2.4);
      if (color) c.setAttribute("fill", color);
      peersG.appendChild(c);
    }

    const legL = document.getElementById("glance-legend-live");
    const legR = document.getElementById("glance-legend-recent");
    const legO = document.getElementById("glance-legend-offline");
    if (legL) legL.textContent = String(liveN);
    if (legR) legR.textContent = String(recentN);
    if (legO) legO.textContent = String(offN);

    // self host label
    const hostEl = document.getElementById("glance-self-host");
    if (hostEl) {
      const selfPeer = srwk.peers && srwk.peers.get(srwk.selfPubkey);
      const host = (selfPeer && selfPeer.nickname) || "self";
      hostEl.textContent = host;
    }
  }

  function renderGlancePeerList() {
    const list = document.getElementById("glance-peer-list");
    if (!list) return;
    const peers = [...(srwk.peers ? srwk.peers.values() : [])];
    const now = performance.now();

    // Sort: self first, then live, then recent, then by last-seen-age
    peers.sort((a, b) => {
      if (a.pubkey === srwk.selfPubkey) return -1;
      if (b.pubkey === srwk.selfPubkey) return 1;
      const order = { live: 0, recent: 1, offline: 2 };
      const sa = order[peerStateFor(a, now)] ?? 3;
      const sb = order[peerStateFor(b, now)] ?? 3;
      if (sa !== sb) return sa - sb;
      const la = lastSeenMs(a) ?? Infinity;
      const lb = lastSeenMs(b) ?? Infinity;
      return la - lb;
    });

    list.innerHTML = "";
    const liveOrRecent = peers.filter(p => peerStateFor(p, now) !== "offline");
    const visible = liveOrRecent.slice(0, 6); // show top 6 by default
    for (let idx = 0; idx < visible.length; idx++) {
      const p = visible[idx];
      const state = peerStateFor(p, now);
      const isSelf = p.pubkey === srwk.selfPubkey;
      const color = peerHue(p.pubkey, idx);

      const card = document.createElement("div");
      card.className = "glance-peer-card";
      card.style.color = color;

      const dot = document.createElement("span");
      dot.className = "glance-peer-pdot " + state;
      dot.style.background = state === "offline" ? "transparent" : color;
      card.appendChild(dot);

      const name = document.createElement("span");
      name.className = "glance-peer-name" + (isSelf ? " is-self" : "");
      name.textContent = isSelf ? "you" : (p.nickname || `peer-${(p.pubkey || "").slice(0, 8)}`);
      card.appendChild(name);

      const pages = document.createElement("span");
      pages.className = "glance-peer-pages";
      pages.textContent = `${pageCountFor(p.pubkey) || 0}p`;
      card.appendChild(pages);

      const when = document.createElement("span");
      when.className = "glance-peer-when";
      when.textContent = isSelf ? "live" : fmtRelative(lastSeenMs(p));
      card.appendChild(when);

      const what = document.createElement("span");
      what.className = "glance-peer-what";
      what.textContent = isSelf
        ? "indexing locally · sharing to the cohort"
        : (state === "live" ? "live · responding to pulls"
           : state === "recent" ? "connected · last contact " + fmtRelative(lastSeenMs(p))
           : "offline");
      card.appendChild(what);

      list.appendChild(card);
    }

    // counts for header + show-more
    const liveCount = peers.filter(p => peerStateFor(p, now) === "live").length;
    const recentCount = peers.filter(p => peerStateFor(p, now) === "recent").length;
    const offCount = peers.filter(p => peerStateFor(p, now) === "offline").length;
    const numEl = document.getElementById("glance-peer-strip-num");
    if (numEl) numEl.textContent = `${liveCount} / ${peers.length}`;
    const moreN = document.getElementById("glance-show-more-n");
    const moreI = document.getElementById("glance-show-more-i");
    if (moreN) moreN.textContent = String(recentCount);
    if (moreI) moreI.textContent = String(offCount);
  }

  function renderGlanceTopics() {
    // v0.2.12 stub: group pages by URL host, surface top 10 buckets.
    // TODO v0.2.13: replace with daemon-side topic classification.
    const flow = document.getElementById("glance-topics-flow");
    const meta = document.getElementById("glance-topics-meta");
    if (!flow) return;

    const byHost = new Map();
    if (srwk.nodes) {
      for (const n of srwk.nodes) {
        const host = (n.host || "").replace(/^www\./, "");
        if (!host) continue;
        if (!byHost.has(host)) byHost.set(host, { count: 0, contrib: n.primary_contributor });
        byHost.get(host).count++;
      }
    }
    const buckets = [...byHost.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 12);

    flow.innerHTML = "";
    const totalPages = srwk.nodes ? srwk.nodes.length : 0;
    if (meta) meta.textContent = `across ${totalPages} pages · last 7d`;

    if (buckets.length === 0) {
      const empty = document.createElement("span");
      empty.className = "glance-topic size-1";
      empty.textContent = "no pages yet — index a few searches to populate this";
      flow.appendChild(empty);
      return;
    }

    for (const [host, data] of buckets) {
      const t = document.createElement("span");
      // size by relative count (1-4 scale)
      const maxN = buckets[0][1].count;
      const ratio = data.count / maxN;
      const size = ratio > 0.66 ? 4 : ratio > 0.4 ? 3 : ratio > 0.2 ? 2 : 1;
      t.className = `glance-topic size-${size}`;
      const peerObj = srwk.peers && srwk.peers.get(data.contrib);
      if (peerObj) {
        const idx = [...srwk.peers.keys()].indexOf(data.contrib);
        t.style.borderColor = peerHue(data.contrib, idx);
        t.style.color = peerHue(data.contrib, idx);
      }
      t.innerHTML = `${host} <span class="ct">${data.count}</span>`;
      flow.appendChild(t);
    }
  }

  function renderGlanceReach() {
    // v0.2.12 stub: surface peer cursors from /sync/manifest as a proxy
    // for "how stale each peer's view of my bundle is."
    // TODO v0.2.13: real daemon-side access-log for "who pulled what when".
    const wrap = document.getElementById("glance-reach");
    const meta = document.getElementById("glance-reach-meta");
    if (!wrap) return;

    const peers = [...(srwk.peers ? srwk.peers.values() : [])]
      .filter(p => p.pubkey !== srwk.selfPubkey);
    const now = performance.now();
    const visible = peers
      .filter(p => peerStateFor(p, now) !== "offline")
      .slice(0, 5);

    wrap.innerHTML = "";
    if (meta) meta.textContent = `latest bundle · ${visible.length} peers visible`;

    if (visible.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "var(--gpaper-faint)";
      empty.style.fontSize = "12px";
      empty.textContent = "no peers reachable right now — waiting for cohort to come online.";
      wrap.appendChild(empty);
      return;
    }

    for (let i = 0; i < visible.length; i++) {
      const p = visible[i];
      const color = peerHue(p.pubkey, i);
      const ageMs = lastSeenMs(p);
      // Reach approximation: live = 100%, recent decays by age
      const pct = ageMs == null ? 0
        : ageMs < 60_000 ? 100
        : ageMs < 600_000 ? 80
        : ageMs < 3600_000 ? 60
        : 30;

      const bar = document.createElement("div");
      bar.className = "glance-reach-bar";
      bar.style.color = color;
      bar.innerHTML = `
        <div class="nm"><span class="sw" style="background: ${color}"></span>${p.nickname || `peer-${(p.pubkey || "").slice(0,8)}`}</div>
        <div class="track"><div class="fill" style="width: ${pct}%"></div></div>
        <div class="pct">${pct}%</div>
      `;
      wrap.appendChild(bar);
    }
  }

  function renderGlanceRhythm() {
    const rh = document.getElementById("glance-rhythm");
    const summary = document.getElementById("glance-rhythm-summary");
    if (!rh) return;

    // 24 buckets, one per hour. Counted from searchHistory ring buffer.
    const now = Date.now();
    const data = new Array(24).fill(0);
    for (const e of searchHistory) {
      const ageMs = now - e.ts;
      if (ageMs < 0 || ageMs >= 24 * 3600_000) continue;
      const bucket = 23 - Math.floor(ageMs / 3600_000);
      if (bucket >= 0 && bucket < 24) data[bucket]++;
    }
    const peak = Math.max(1, ...data);
    const nowHour = 23;
    const peakHour = data.indexOf(peak);

    rh.innerHTML = "";
    data.forEach((v, i) => {
      const bar = document.createElement("div");
      bar.className = "glance-rhythm-bar" + (i === nowHour ? " now" : i === peakHour && v > 0 ? " peak" : "");
      bar.style.height = (Math.max(2, (v / peak) * 100)) + "%";
      bar.title = `${24 - i}h ago — ${v} ${v === 1 ? "query" : "queries"}`;
      rh.appendChild(bar);
    });

    if (summary) {
      const totalToday = data.reduce((a, b) => a + b, 0);
      if (totalToday === 0) {
        summary.textContent = "Quiet day so far — no queries yet.";
      } else {
        const peakAgo = 24 - peakHour;
        summary.innerHTML = `${totalToday} ${totalToday === 1 ? "query" : "queries"} today · peak ${peakAgo}h ago (<strong style="color: var(--gpaper)">${peak}</strong> ${peak === 1 ? "query" : "queries"} that hour).`;
      }
    }
  }

  function renderGlanceTicker() {
    const line = document.getElementById("glance-ticker-line");
    const when = document.getElementById("glance-ticker-when");
    if (!line) return;

    // Find the most recent contribution_merged event in the renderer's
    // appendEvent ring. We don't have direct access to it as a global,
    // so peek at srwk.recentEvents if present, otherwise fall back to a
    // calm static line.
    const ring = (srwk && srwk.recentEvents) || [];
    let mostRecent = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].kind === "contribution_merged" || ring[i].kind === "page_added") {
        mostRecent = ring[i];
        break;
      }
    }
    if (mostRecent) {
      const p = mostRecent.payload || {};
      const page = (p.pages && p.pages[0]) || p;
      const contrib = p.contributor || p.source_pubkey;
      const isSelf = contrib === srwk.selfPubkey;
      const peerObj = contrib && srwk.peers ? srwk.peers.get(contrib) : null;
      const who = isSelf ? "you" : (peerObj && peerObj.nickname) || "a peer";
      const title = page.title || page.url || "a new page";
      line.innerHTML = `${who} ${isSelf ? "indexed" : "shared"} <em>${escapeHtmlSafe(title.slice(0, 80))}</em>${title.length > 80 ? "…" : ""}`;
      if (when) when.textContent = fmtRelative(Date.now() - (mostRecent.ts || Date.now()));
    } else {
      line.textContent = "awaiting cohort activity…";
      if (when) when.textContent = "—";
    }
  }

  function escapeHtmlSafe(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  function renderGlanceHealth() {
    const d = document.getElementById("glance-health-daemon");
    if (d) d.textContent = "v0.13.4 · :7777";

    const cursor = (srwk._manifest && srwk._manifest.cursor != null)
      ? `@${srwk._manifest.cursor}` : "@—";
    const cEl = document.getElementById("glance-health-cursor");
    if (cEl) cEl.textContent = cursor;

    // Find most recent contribution_merged from self
    const ring = (srwk && srwk.recentEvents) || [];
    let lastPub = null;
    for (let i = ring.length - 1; i >= 0; i--) {
      if (ring[i].kind === "contribution_merged" &&
          ring[i].payload && ring[i].payload.contributor === srwk.selfPubkey) {
        lastPub = ring[i];
        break;
      }
    }
    const pubEl = document.getElementById("glance-health-publish");
    if (pubEl) pubEl.textContent = lastPub ? fmtRelative(Date.now() - lastPub.ts) : "—";

    // latency p50 — use existing connection probe rtt if available
    const latEl = document.getElementById("glance-health-lat");
    if (latEl && srwk._lastRttMs != null) {
      latEl.textContent = `${Math.round(srwk._lastRttMs)}ms`;
    }

    // errors 1h — count peer_unreachable / scraper_error events
    const errEl = document.getElementById("glance-health-err");
    if (errEl) {
      const hourAgo = Date.now() - 3600_000;
      const errs = ring.filter(e => e.ts > hourAgo &&
        (e.kind === "peer_unreachable" || e.kind === "scraper_error")).length;
      errEl.textContent = errs > 0 ? `${errs} · check log` : "0";
    }
  }

  function renderGlanceAll() {
    if (document.body.dataset.netViewMode !== "glance") return;
    if (document.body.dataset.activeTab !== "network") return;
    maybeAttachSearchListener();
    try { renderGlanceHero(); } catch (e) { console.warn("[glance hero]", e); }
    try { renderGlanceNumbers(); } catch (e) { console.warn("[glance numbers]", e); }
    try { renderGlanceRing(); } catch (e) { console.warn("[glance ring]", e); }
    try { renderGlancePeerList(); } catch (e) { console.warn("[glance peers]", e); }
    try { renderGlanceTopics(); } catch (e) { console.warn("[glance topics]", e); }
    try { renderGlanceReach(); } catch (e) { console.warn("[glance reach]", e); }
    try { renderGlanceRhythm(); } catch (e) { console.warn("[glance rhythm]", e); }
    try { renderGlanceTicker(); } catch (e) { console.warn("[glance ticker]", e); }
    try { renderGlanceHealth(); } catch (e) { console.warn("[glance health]", e); }
  }

  // ─── mode toggle init ────────────────────────────────────────────

  function initModeToggle() {
    const stored = (() => {
      try { return localStorage.getItem(LS_KEY); } catch { return null; }
    })();
    // Force "debug" (the existing 3-column tab with the live peer ring
    // as the centerpiece). The "glance" composition got pushed back on
    // — too much hero copy, peer activity demoted to the corner,
    // headline went "you're the only one here" because self wasn't
    // being counted as live. Keep glance code in place for later
    // iteration but ship debug as the only visible mode so the network
    // tab still has the peer-diagram-in-the-middle that makes the
    // cohort feel alive.
    //
    // We ignore `stored` here because: (a) the toggle UI is hidden in
    // this build so users can't change it; (b) anyone who clicked the
    // toggle in a prior session has "glance" saved in localStorage and
    // would otherwise be stuck on the broken view. Anyone debugging
    // glance can still flip it via `window.__forceGlance()` (defined
    // below) or by editing localStorage manually before reload.
    const mode = "debug";
    if (stored && stored !== mode) {
      try { localStorage.setItem(LS_KEY, mode); } catch {}
    }
    window.__forceGlance = function () {
      try { localStorage.setItem(LS_KEY, "glance"); } catch {}
      document.body.dataset.netViewMode = "glance";
      if (typeof renderGlanceAll === "function") renderGlanceAll();
    };
    document.body.dataset.netViewMode = mode;

    const btns = document.querySelectorAll(".net-mode-btn");
    btns.forEach(b => {
      const isOn = b.dataset.mode === mode;
      b.classList.toggle("is-active", isOn);
      b.setAttribute("aria-pressed", isOn ? "true" : "false");
      b.addEventListener("click", () => {
        const newMode = b.dataset.mode;
        document.body.dataset.netViewMode = newMode;
        try { localStorage.setItem(LS_KEY, newMode); } catch {}
        btns.forEach(bb => {
          const on = bb.dataset.mode === newMode;
          bb.classList.toggle("is-active", on);
          bb.setAttribute("aria-pressed", on ? "true" : "false");
        });
        if (newMode === "glance") renderGlanceAll();
      });
    });
  }

  // Wait for DOM, then init + start periodic refresh.
  function bootstrap() {
    initModeToggle();
    renderGlanceAll();
    setIntervalVisible(renderGlanceAll, 5000);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();

// ─── Atlas help tooltip (v0.2.13) ───────────────────────────────────
// A small "(?)" in the corner of the cohort atlas. Click toggles a
// folded-handbill explainer with: how the clustering works (countries
// = peers, towns = pages), and what the underlying stack is
// (searxng-wth-frnds — P2P meta search engine forked from SearXNG).
(function setupAtlasHelp() {
  function init() {
    const btn = document.getElementById("atlas-help-toggle");
    const panel = document.getElementById("atlas-help-panel");
    if (!btn || !panel) return;
    const closeBtn = panel.querySelector(".ahp-close");

    function open() {
      panel.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      // dismiss on outside click + Esc — installed lazily
      setTimeout(() => {
        document.addEventListener("mousedown", onOutside, true);
        document.addEventListener("keydown", onKey, true);
      }, 0);
    }
    function close() {
      panel.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
    }
    function toggle() {
      if (panel.hidden) open(); else close();
    }
    function onOutside(e) {
      if (panel.hidden) return;
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      close();
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); }
    }

    btn.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
    if (closeBtn) closeBtn.addEventListener("click", close);

    // Auto-close when the view leaves Atlas, so the panel doesn't linger.
    const obs = new MutationObserver(() => {
      const inAtlas = document.body.dataset.activeTab === "apps" && document.body.dataset.appsView === "atlas";
      if (!inAtlas && !panel.hidden) close();
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ["data-active-tab", "data-apps-view"] });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

// ─── Swarm panel wiring (v0.2.13) ────────────────────────────────────
// Opens on ASK MY AGENT click (overrides the legacy copy-prompt
// behaviour). Renders a streaming trace of the research-agent
// subprocess. Settings sub-modal handles Anthropic API key (encrypted
// via main-process safeStorage) + Ollama base URL config. All IPC
// shape is in apps/os/preload.js (window.api.swarm*).

(function setupSwarmPanel() {
  function $(id) { return document.getElementById(id); }

  function init() {
    const panel        = $("swarm-panel");
    const askBtn       = $("search-ask-agent");
    if (!panel || !askBtn) return;

    const form         = $("swarm-form");
    const queryEl      = $("swarm-query");
    const modelEl      = $("swarm-model");
    const parallelEl   = $("swarm-parallel");
    const startBtn     = $("swarm-start-btn");
    const stopBtn      = $("swarm-stop-btn");
    const statusDot    = $("swarm-status-dot");
    const statusLine   = $("swarm-status-line");
    const traceEl      = $("swarm-trace");
    const traceEmpty   = $("swarm-trace-empty");
    const preMsg       = $("swarm-pre-message");
    const settingsBtn  = $("swarm-settings-btn");
    const settingsEl   = $("swarm-settings");
    const settingsClose= $("swarm-settings-close");
    const keyInput     = $("swarm-anthropic-key");
    const baseInput    = $("swarm-ollama-base");
    const saveBtn      = $("swarm-settings-save");
    const settingsStat = $("swarm-settings-status");

    let _currentRequestId = null;
    let _outputDispose = null;
    let _statusDispose = null;

    function open() {
      panel.hidden = false;
      panel.setAttribute("aria-hidden", "false");
      // pre-fill query from the search box if it has content
      try {
        const searchInput = document.getElementById("search-input");
        if (searchInput && searchInput.value && !queryEl.value) {
          queryEl.value = searchInput.value;
        }
      } catch {}
      setTimeout(() => queryEl.focus(), 60);
      window.addEventListener("keydown", onKey, true);
      // Pull saved config + agent install state. If research-agent isn't
      // on disk, surface that immediately so the start button doesn't
      // just silently fail.
      refreshAgentReadiness();
    }
    function close() {
      panel.hidden = true;
      panel.setAttribute("aria-hidden", "true");
      window.removeEventListener("keydown", onKey, true);
      // closing while running keeps the subprocess alive in the background
      // — open the panel again and you'll pick up the stream. Hit stop to
      // actually cancel.
    }
    function onKey(e) {
      if (e.key === "Escape") {
        if (!settingsEl.hidden) { closeSettings(); return; }
        close();
      }
    }

    function openSettings() {
      settingsEl.hidden = false;
      settingsEl.setAttribute("aria-hidden", "false");
      settingsStat.textContent = "";
      settingsStat.className = "swarm-settings-status";
      // refresh values from main
      window.api.getSwarmConfig().then((cfg) => {
        keyInput.value = "";
        keyInput.placeholder = cfg.hasApiKey
          ? "sk-ant-… (saved · type new key to replace)"
          : "sk-ant-…  (stored encrypted in your keychain)";
        baseInput.value = cfg.lmApiBase || "";
        if (!cfg.safeStorageAvailable) {
          settingsStat.textContent = "warning · safeStorage not available; key would be stored plaintext";
          settingsStat.className = "swarm-settings-status is-error";
        }
      }).catch(() => {});
      setTimeout(() => keyInput.focus(), 60);
    }
    function closeSettings() {
      settingsEl.hidden = true;
      settingsEl.setAttribute("aria-hidden", "true");
    }

    async function refreshAgentReadiness() {
      try {
        const cfg = await window.api.getSwarmConfig();
        // Pre-select the saved model
        if (cfg.lmModel) {
          const opt = [...modelEl.options].find(o => o.value === cfg.lmModel);
          if (opt) modelEl.value = cfg.lmModel;
        }
        if (!cfg.agent.binFound) {
          startBtn.disabled = true;
          setPreMsg(`research-agent binary not found. Install at ~/research-swarm (git clone dmarzzz/research-swarm; uv sync) or set RESEARCH_AGENT_BIN. The swarm needs the Python CLI to run.`, "error");
          return;
        }
        startBtn.disabled = false;
        // If anthropic selected but no key, surface that
        if (modelEl.value.startsWith("anthropic/") && !cfg.hasApiKey) {
          setPreMsg("Anthropic model selected but no API key configured. Click the ⚙ icon to add one.", "info");
        } else {
          setPreMsg("");
        }
      } catch (e) {
        setPreMsg(`config check failed: ${e.message}`, "error");
      }
    }

    function setStatus(state, line) {
      statusDot.dataset.state = state;
      statusLine.textContent = line;
    }
    function setPreMsg(msg, kind) {
      preMsg.textContent = msg || "";
      preMsg.className = "swarm-pre-message" + (kind ? ` is-${kind}` : "");
    }
    function clearTrace() {
      traceEl.innerHTML = "";
      const e = document.createElement("div");
      e.className = "swarm-trace-empty";
      e.id = "swarm-trace-empty";
      e.textContent = "starting swarm…";
      traceEl.appendChild(e);
    }
    function appendTraceLine(stream, text) {
      // remove the empty placeholder on first real line
      const empty = traceEl.querySelector("#swarm-trace-empty");
      if (empty) empty.remove();
      const line = document.createElement("span");
      line.className = "swarm-trace-line" + (stream === "stderr" ? " is-stderr" : "");
      line.textContent = text;
      traceEl.appendChild(line);
      traceEl.appendChild(document.createTextNode("\n"));
      // auto-scroll to bottom unless user has scrolled up
      const nearBottom = (traceEl.scrollHeight - traceEl.scrollTop - traceEl.clientHeight) < 80;
      if (nearBottom) traceEl.scrollTop = traceEl.scrollHeight;
    }
    function appendDivider() {
      const div = document.createElement("div");
      div.className = "swarm-trace-line is-divider";
      traceEl.appendChild(div);
    }

    async function startRun(e) {
      if (e) e.preventDefault();
      const q = (queryEl.value || "").trim();
      if (!q) { setPreMsg("type a question first.", "info"); return; }
      setPreMsg("");

      // Tear down any previous stream listeners
      if (_outputDispose) { _outputDispose(); _outputDispose = null; }
      if (_statusDispose) { _statusDispose(); _statusDispose = null; }
      clearTrace();
      setStatus("running", "spawning…");
      startBtn.hidden = true;
      stopBtn.hidden = false;

      const requestId = `req_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
      _currentRequestId = requestId;

      // Persist the model selection so next launch defaults to it
      try { await window.api.setSwarmConfig({ lmModel: modelEl.value }); } catch {}

      // Subscribe to output BEFORE start (avoid missing the first lines)
      _outputDispose = window.api.onSwarmOutput((p) => {
        if (p.requestId !== _currentRequestId) return;
        appendTraceLine(p.stream, p.line);
      });
      _statusDispose = window.api.onSwarmStatus((s) => {
        if (s.state === "running") {
          setStatus("running", `running · ${s.requestId.slice(0, 16)}`);
        } else if (s.state === "idle") {
          // Final exit
          if (s.exitCode === 0) {
            setStatus("done", `done · ${Math.round((s.durationMs || 0) / 1000)}s`);
          } else if (s.signal === "SIGTERM" || s.signal === "SIGKILL") {
            setStatus("idle", `cancelled · ${s.signal}`);
          } else {
            setStatus("error", `exited code=${s.exitCode}`);
          }
          startBtn.hidden = false;
          stopBtn.hidden = true;
          appendDivider();
        }
      });

      try {
        const res = await window.api.swarmStart({
          requestId,
          query: q,
          lmModel: modelEl.value,
          parallel: !!parallelEl.checked,
          workers: 3,
        });
        if (!res || !res.ok) {
          setStatus("error", `failed · ${res?.reason || "unknown"}`);
          setPreMsg(`start failed: ${res?.detail || res?.reason || "unknown"}`, "error");
          startBtn.hidden = false;
          stopBtn.hidden = true;
        }
      } catch (err) {
        setStatus("error", `failed · ${err.message}`);
        setPreMsg(`start threw: ${err.message}`, "error");
        startBtn.hidden = false;
        stopBtn.hidden = true;
      }
    }

    async function stopRun() {
      try { await window.api.swarmStop(); } catch (e) { /* ignore */ }
    }

    // ── Wire events ────────────────────────────────────────────────
    askBtn.removeEventListener("click", askBtn.__legacyHandler || (() => {}));
    askBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    });

    // close (backdrop + X buttons)
    panel.querySelectorAll("[data-swarm-close]").forEach(el => {
      el.addEventListener("click", close);
    });

    form.addEventListener("submit", startRun);
    stopBtn.addEventListener("click", stopRun);

    settingsBtn.addEventListener("click", openSettings);
    settingsClose.addEventListener("click", closeSettings);
    saveBtn.addEventListener("click", async () => {
      const opts = { lmApiBase: baseInput.value.trim() };
      const keyVal = keyInput.value.trim();
      if (keyVal) opts.lmApiKey = keyVal; // only persist if changed
      try {
        const res = await window.api.setSwarmConfig(opts);
        if (res && res.ok) {
          settingsStat.textContent = "saved.";
          settingsStat.className = "swarm-settings-status is-saved";
          keyInput.value = "";
          setTimeout(closeSettings, 700);
          refreshAgentReadiness();
        } else {
          settingsStat.textContent = "save failed";
          settingsStat.className = "swarm-settings-status is-error";
        }
      } catch (e) {
        settingsStat.textContent = `save failed: ${e.message}`;
        settingsStat.className = "swarm-settings-status is-error";
      }
    });

    modelEl.addEventListener("change", () => {
      // re-check anthropic-key-required prompt
      refreshAgentReadiness();
    });

    // Re-bind ⌘/Ctrl+Shift+A to ALSO open the panel (legacy did clipboard)
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "a" || e.key === "A")) {
        const sv = document.getElementById("search-view");
        if (sv && !sv.hidden) {
          e.preventDefault();
          open();
        }
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
