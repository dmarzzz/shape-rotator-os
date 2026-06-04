/* easel.js — the "easel" app: project a screen or window over NDI.
 *
 * Pick a capture source → "go live" → we draw each captured frame to a canvas
 * at the source's native resolution (capped by the quality toggle: 1080p / 720p)
 * and ship the RGBA pixels to the main process (apps/os/easel-ndi.js),
 * which broadcasts them as an NDI source on the LAN. Any NDI receiver — the
 * projector tonight, OBS, easel itself — can then pull the stream.
 *
 * macOS for now: screen capture needs Screen Recording permission granted to
 * the app in System Settings → Privacy & Security.
 *
 * Lifecycle mirrors atlas.js: mount(stage) / setActive(bool) / notifyDataChanged().
 */

import { getIdentity } from "./identity.js";
import { getCohortSurface } from "./cohort-source.js";

const FPS = 30;
// Output resolution adapts to the captured source, capped by the chosen
// quality (even dimensions, downscale-only). "high" = up to 1080p (crisp on a
// projector), "fast" = up to 720p (lighter IPC if 1080p janks).
const QUALITY_CAP = { high: { w: 1920, h: 1080 }, fast: { w: 1280, h: 720 } };
const PREFS_KEY = "srwk:easel:prefs";
// macOS deep-link straight to the Screen Recording permission pane.
const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
function loadEaselPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; } }
function saveEaselPrefs(p) { try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {} }

let _stage = null;
let _publishedName = "";
let _active = false;
let _live = false;
let _ndiAvailable = true;
let _sources = [];
let _selectedId = null;
let _stream = null;
let _video = null;
let _canvas = null;
let _ctx = null;
let _pumpTimer = null;
let _statsTimer = null;
let _quality = "high";
let _outW = 1280;
let _outH = 720;

// "Watching the LAN" — receive side.
let _watchCanvas = null;
let _watchCtx = null;
let _watchOverlay = null;
let _watchSources = [];
let _watchSelected = null;     // name of the source we're currently receiving
let _watchFrameUnsub = null;   // detach function from window.api.easel.onRxFrame
let _watchFrames = 0;
let _watchStartMs = 0;
let _liveStartMs = 0;
let _infoTick = null;          // 1s ticker that updates the viewer's duration
let _watchRefreshTimer = null; // background poll of findNdi while easel is active
let _thumbFrameUnsub = null;   // detach for onThumbFrame
let _thumbsRunning = new Set();// sourceNames with an active thumb receiver
// Audio playback
let _audioCtx = null;
let _audioGain = null;
let _audioMuted = (() => { try { return localStorage.getItem("easel:audio-muted") !== "0"; } catch { return true; } })();
let _audioNext = 0;
let _audioUnsub = null;

// ─── identity + duration helpers ──────────────────────────────────────
// First letter (or • fallback) — used in the avatar circle.
function initialOf(name) {
  const m = String(name || "").trim().match(/[A-Za-z0-9]/);
  return m ? m[0].toUpperCase() : "•";
}
// mm:ss / h:mm:ss for the live-duration ticker.
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
// Strip the daemon's "HOSTNAME.LAN (foo)" prefix to the friendly inner name.
function shortName(full) {
  const m = String(full || "").match(/\(([^)]+)\)\s*$/);
  return m ? m[1] : String(full || "");
}
// Resolve an NDI source to a cohort person. Broadcasters typically name
// their stream as their handle / display_name, so the inner-paren publish
// name matches a person record. Returns the person or null.
function matchPersonForNdi(ndiName, people) {
  const inner = shortName(ndiName).toLowerCase().trim();
  if (!inner || !Array.isArray(people)) return null;
  // Exact match on handle / display_name / record_id first.
  for (const p of people) {
    const h = String(p.handle || p.gh_handle || (p.links && p.links.github) || "").toLowerCase();
    const d = String(p.display_name || p.name || "").toLowerCase();
    const r = String(p.record_id || "").toLowerCase();
    if (inner === h || inner === d || inner === r) return p;
  }
  // Fall back to a loose match on display_name (handles "Daniel Marz" → "dmarz", etc.).
  for (const p of people) {
    const d = String(p.display_name || p.name || "").toLowerCase().replace(/\s+/g, "");
    if (d && (inner.includes(d) || d.includes(inner.replace(/\s+/g, "")))) return p;
  }
  return null;
}

// Output dims = source size scaled down to fit the quality cap, aspect kept,
// rounded to even (some NDI receivers dislike odd dimensions).
function computeOutputDims() {
  const cap = QUALITY_CAP[_quality] || QUALITY_CAP.high;
  const vw = _video && _video.videoWidth ? _video.videoWidth : cap.w;
  const vh = _video && _video.videoHeight ? _video.videoHeight : cap.h;
  const scale = Math.min(1, cap.w / vw, cap.h / vh);
  return { w: Math.max(2, Math.round(vw * scale / 2) * 2), h: Math.max(2, Math.round(vh * scale / 2) * 2) };
}
function applyOutputDims() {
  const d = computeOutputDims();
  _outW = d.w; _outH = d.h;
  if (_canvas) { _canvas.width = _outW; _canvas.height = _outH; }
}

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export async function mount(stage) {
  if (!stage) return;
  // Idempotent: re-entering the view must not rebuild (and clobber a live
  // broadcast). applyActiveTab can call mount repeatedly.
  if (_stage === stage && stage.querySelector(".easel-app")) return;
  _stage = stage;
  _ndiAvailable = await safe(() => window.api.easel.available(), false);
  renderShell();
  if (_ndiAvailable) await loadSources();
}

export function setActive(on) {
  _active = !!on;
  // Intentionally DO NOT stop the broadcast when leaving the easel view. A
  // projection is meant to keep running while you use the rest of the OS (or
  // switch to another app) — tearing it down on navigate-away was killing the
  // NDI stream the moment you clicked elsewhere. The capture pump + NDI sender
  // stay live until you explicitly stop or quit; returning re-attaches to the
  // still-running stream (mount() is idempotent, so the live preview persists).
  if (_active) {
    // Background-poll the LAN every 9s so new streams appear without a click.
    if (!_watchRefreshTimer && _ndiAvailable) {
      _watchRefreshTimer = setInterval(() => loadWatchSources().catch(() => {}), 9000);
    }
  } else {
    if (_watchRefreshTimer) { clearInterval(_watchRefreshTimer); _watchRefreshTimer = null; }
    // Tear down per-card thumb receivers when easel isn't visible — they
    // burn LAN bandwidth + native resources otherwise. Card list re-renders
    // (and starts thumbs again) when the user returns.
    if (window.api && window.api.easel && window.api.easel.thumbStopAll) {
      window.api.easel.thumbStopAll().catch(() => {});
    }
    _thumbsRunning.clear();
  }
}

export function notifyDataChanged() { /* nothing data-driven here */ }

async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }

function renderShell() {
  // Prefill the NDI name from a saved value or the claimed identity, so each
  // person's source is distinguishable on the network (not a wall of "Easel").
  const prefs = loadEaselPrefs();
  const id = getIdentity();
  const defaultName = esc(prefs.name || (id && id.display_name) || "Easel");
  _quality = prefs.quality === "fast" ? "fast" : "high";
  _stage.innerHTML = `
    <div class="easel-app easel-app--twocol">
      <header class="easel-head easel-head--compact">
        <div class="easel-head-text">
          <p class="easel-eyebrow">apps · projection</p>
          <h1 class="easel-title">easel</h1>
          <p class="easel-sub">broadcast over <strong>NDI</strong> + watch other cohort streams on the LAN.</p>
        </div>
      </header>
      ${_ndiAvailable ? "" : `<div class="easel-banner easel-banner-warn">NDI runtime not available — the native sender failed to load. (Install NDI Tools, then reopen easel.)</div>`}

      <div class="easel-grid">
        <aside class="easel-side">
          <section class="easel-panel">
            <header class="easel-panel-head">
              <span class="easel-panel-eyebrow">broadcast</span>
              <span class="easel-status" data-easel-status></span>
            </header>
            <div class="easel-sources" data-easel-sources></div>
            <label class="easel-namefield">
              <span>NDI name</span>
              <input type="text" data-easel-name value="${defaultName}" maxlength="48" spellcheck="false" />
            </label>
            <div class="easel-control-row">
              <div class="easel-quality" role="group" aria-label="output quality">
                <button class="easel-q-btn" type="button" data-quality="high" aria-selected="${_quality === "high"}">1080p</button>
                <button class="easel-q-btn" type="button" data-quality="fast" aria-selected="${_quality === "fast"}">720p</button>
              </div>
              <button class="easel-go" type="button" data-easel-go disabled>go live</button>
            </div>
            <div class="easel-err" data-easel-err hidden></div>
          </section>

          ${_ndiAvailable ? `
          <section class="easel-panel">
            <header class="easel-panel-head">
              <span class="easel-panel-eyebrow">watching the LAN</span>
              <span class="easel-watch-status" data-watch-status>—</span>
              <button class="easel-watch-refresh" type="button" data-watch-refresh aria-label="refresh">↻</button>
            </header>
            <ul class="easel-watch-list" data-watch-list role="list">
              <li class="easel-watch-loading">scanning…</li>
            </ul>
          </section>` : ""}
        </aside>

        <main class="easel-viewer" data-viewer-mode="empty">
          <div class="easel-viewer-tabs" role="tablist">
            <button class="easel-viewer-tab is-active" type="button" data-viewer-tab="preview" role="tab">preview</button>
            ${_ndiAvailable ? `<button class="easel-viewer-tab" type="button" data-viewer-tab="watch" role="tab">watching</button>` : ""}
            <span class="easel-viewer-meta" data-viewer-meta></span>
          </div>
          <div class="easel-viewer-stage">
            <canvas class="easel-canvas" width="1280" height="720" data-easel-canvas></canvas>
            ${_ndiAvailable ? `<canvas class="easel-watch-canvas" width="640" height="360" data-watch-canvas></canvas>` : ""}
            <div class="easel-viewer-overlay" data-easel-overlay>pick a screen below to preview, then go live</div>
            ${_ndiAvailable ? `<div class="easel-viewer-overlay" data-watch-overlay hidden>pick a stream from the LAN list to watch</div>` : ""}
          </div>
          <footer class="easel-viewer-info" data-viewer-info hidden>
            <span class="evi-avatar" data-evi-avatar>•</span>
            <div class="evi-text">
              <div class="evi-title-row">
                <span class="evi-title" data-evi-title>—</span>
                <span class="evi-live" data-evi-live hidden><span class="evi-live-dot"></span>LIVE</span>
              </div>
              <div class="evi-meta-row">
                <span class="evi-kind" data-evi-kind></span>
                <span class="evi-sep">·</span>
                <span class="evi-duration" data-evi-duration>00:00</span>
              </div>
            </div>
            <button class="evi-mute" type="button" data-evi-mute aria-label="toggle audio">
              <svg class="evi-mute-glyph" data-evi-mute-on viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                <path d="M5 9v6h4l5 4V5L9 9H5zm11.5 3c0-1.77-1-3.29-2.5-4.03v8.05c1.5-.73 2.5-2.25 2.5-4.02z"/>
              </svg>
              <svg class="evi-mute-glyph" data-evi-mute-off viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" hidden>
                <path d="M16.5 12c0-1.77-1-3.29-2.5-4.03v2.21l2.45 2.45c.03-.21.05-.42.05-.63zM5 9v6h4l5 4V5L9 9H5zM3.27 2L2 3.27 6.73 8H5v8h4l5 5v-5.73L18.73 18c-.55.45-1.16.81-1.83 1.05V21c1.39-.31 2.63-.97 3.69-1.84L21.73 21 23 19.73 3.27 2z"/>
              </svg>
            </button>
          </footer>
        </main>
      </div>
    </div>`;

  _canvas = _stage.querySelector("[data-easel-canvas]");
  _ctx = _canvas.getContext("2d", { willReadFrequently: true });
  _video = document.createElement("video");
  _video.muted = true; _video.playsInline = true;

  _stage.querySelector("[data-easel-go]").addEventListener("click", () => (_live ? stopLive() : goLive()));
  _stage.querySelectorAll(".easel-q-btn").forEach((b) => b.addEventListener("click", () => setQuality(b.getAttribute("data-quality"))));

  // Wire the "watching the LAN" surface (present only when NDI is available).
  _watchCanvas = _stage.querySelector("[data-watch-canvas]");
  _watchCtx = _watchCanvas ? _watchCanvas.getContext("2d") : null;
  _watchOverlay = _stage.querySelector("[data-watch-overlay]");
  if (_watchCanvas) {
    _stage.querySelector("[data-watch-refresh]").addEventListener("click", () => loadWatchSources());
    loadWatchSources();
    // Persistent listener: per-card thumbnail frames stream in tagged with
    // sourceName so we can route each to the right card's canvas.
    if (!_thumbFrameUnsub) _thumbFrameUnsub = window.api.easel.onThumbFrame((frame) => onThumbFrame(frame));
    // Persistent listener: audio frames flow whenever we're receiving.
    if (!_audioUnsub) _audioUnsub = window.api.easel.onRxAudio((frame) => onRxAudio(frame));
  }

  // Viewer mode tabs — preview (your broadcast) vs watching (a LAN stream).
  _stage.querySelectorAll("[data-viewer-tab]").forEach((btn) => {
    btn.addEventListener("click", () => setViewerMode(btn.getAttribute("data-viewer-tab"), { user: true }));
  });

  // Mute toggle in the viewer info bar.
  const muteBtn = _stage.querySelector("[data-evi-mute]");
  if (muteBtn) {
    muteBtn.addEventListener("click", toggleAudioMute);
    syncMuteUi();
  }

  refreshStatus(null);
}

// ─── audio playback (Web Audio) ───────────────────────────────────────
function initAudio() {
  if (_audioCtx) return;
  try {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    _audioGain = _audioCtx.createGain();
    _audioGain.gain.value = _audioMuted ? 0 : 1;
    _audioGain.connect(_audioCtx.destination);
    _audioNext = 0;
  } catch (e) {
    console.warn("[easel] audio init failed:", e.message);
  }
}
function onRxAudio(frame) {
  if (_audioMuted) return;            // skip work entirely when muted
  if (!frame || !frame.data) return;
  if (!_audioCtx) initAudio();
  if (!_audioCtx || !_audioGain) return;
  const { sampleRate, channels, samples, data } = frame;
  if (!sampleRate || !channels || !samples) return;
  // grandiose's default audio format is FLOAT_32_SEPARATE: channel-strided
  // float32 with channel 0's `samples` floats first, then channel 1, etc.
  const f32 = new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
  let buf;
  try { buf = _audioCtx.createBuffer(channels, samples, sampleRate); }
  catch { return; }
  for (let ch = 0; ch < channels; ch++) {
    buf.copyToChannel(f32.subarray(ch * samples, (ch + 1) * samples), ch);
  }
  const now = _audioCtx.currentTime;
  // Small cushion ahead of currentTime, then chain. If we've drifted way
  // behind real-time (paused tab, GC pause, etc.) snap forward to drop the
  // backlog instead of building latency.
  let startAt = Math.max(now + 0.03, _audioNext);
  if (startAt - now > 0.5) startAt = now + 0.05;
  const node = _audioCtx.createBufferSource();
  node.buffer = buf;
  node.connect(_audioGain);
  node.start(startAt);
  _audioNext = startAt + samples / sampleRate;
}
function toggleAudioMute() {
  _audioMuted = !_audioMuted;
  try { localStorage.setItem("easel:audio-muted", _audioMuted ? "1" : "0"); } catch {}
  if (_audioCtx && _audioGain) _audioGain.gain.value = _audioMuted ? 0 : 1;
  if (!_audioMuted && _audioCtx && _audioCtx.state === "suspended") {
    _audioCtx.resume().catch(() => {});
  }
  // Reset the schedule clock so we don't try to catch up on the backlog.
  if (_audioCtx) _audioNext = _audioCtx.currentTime + 0.05;
  syncMuteUi();
}
function syncMuteUi() {
  const onG = _stage && _stage.querySelector("[data-evi-mute-on]");
  const offG = _stage && _stage.querySelector("[data-evi-mute-off]");
  if (onG)  onG.hidden  = _audioMuted;
  if (offG) offG.hidden = !_audioMuted;
}

// ─── live thumbnails ──────────────────────────────────────────────────
// Frames arrive tagged with sourceName; route to the matching card canvas.
function onThumbFrame(frame) {
  if (!frame || !frame.data || !frame.sourceName || !_stage) return;
  const cvs = _stage.querySelector(`[data-ews-thumb="${cssEscape(frame.sourceName)}"]`);
  if (!cvs) return;
  const { width, height, lineStride, data } = frame;
  if (!width || !height) return;
  // Source frames are usually full-res; the canvas is 160×90 — drawImage
  // an offscreen ImageBitmap or putImageData scaled. Simpler + fast enough:
  // build an ImageData at native size in a temp canvas, then drawImage to
  // downsample. createImageBitmap also works and avoids the alpha-fix loop.
  const expected = width * 4;
  let buf;
  if (lineStride === expected) {
    buf = new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4);
  } else {
    buf = new Uint8ClampedArray(width * height * 4);
    const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (let y = 0; y < height; y++) buf.set(src.subarray(y * lineStride, y * lineStride + expected), y * expected);
  }
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  const imgData = new ImageData(buf, width, height);
  // Offscreen canvas → draw to card canvas (downscale via drawImage).
  const off = (onThumbFrame._off ||= document.createElement("canvas"));
  if (off.width !== width || off.height !== height) { off.width = width; off.height = height; }
  off.getContext("2d").putImageData(imgData, 0, 0);
  const ctx = cvs.getContext("2d");
  ctx.drawImage(off, 0, 0, cvs.width, cvs.height);
  cvs.classList.add("has-frame");
}
function cssEscape(s) {
  // Minimal CSS attribute-selector escape — source names contain `(`, `)`,
  // `.`, spaces. CSS.escape() exists on modern browsers but we'll be safe.
  return (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(s) : String(s).replace(/(["'\\\n])/g, "\\$1");
}

// Drive what the right-pane viewer shows. Modes:
//   empty   — neither side has content yet
//   preview — your broadcast preview canvas
//   watch   — a LAN stream's receive canvas
// Auto-switches on selectSource / watchSelect; manual tab clicks pass {user:true}.
function setViewerMode(mode, { user = false } = {}) {
  if (mode !== "preview" && mode !== "watch" && mode !== "empty") return;
  const viewer = _stage && _stage.querySelector(".easel-viewer");
  if (!viewer) return;
  // If the user explicitly clicks a tab whose side has no content, fall back
  // to the empty state for that tab (we still flip the tab so they see it).
  viewer.dataset.viewerMode = mode;
  for (const t of _stage.querySelectorAll("[data-viewer-tab]")) {
    t.classList.toggle("is-active", t.getAttribute("data-viewer-tab") === mode);
  }
  const meta = _stage.querySelector("[data-viewer-meta]");
  if (meta) {
    meta.textContent = mode === "watch" && _watchSelected
      ? `watching · ${_watchSelected}`
      : mode === "preview" && _live
        ? `live · ${_publishedName || ""}`
        : "";
  }
  void user; // marker kept for future hooks
  syncViewerInfo();
}

async function loadWatchSources() {
  const list = _stage.querySelector("[data-watch-list]");
  const statusEl = _stage.querySelector("[data-watch-status]");
  if (!list) return;
  list.innerHTML = `<li class="easel-watch-loading">scanning…</li>`;
  if (statusEl) statusEl.textContent = "scanning…";
  const [sources, cohort] = await Promise.all([
    safe(() => window.api.easel.findNdi({ timeoutMs: 3000 }), []),
    safe(() => getCohortSurface(), null),
  ]);
  _watchSources = Array.isArray(sources) ? sources : [];
  const people = (cohort && cohort.people) || [];
  // Resolve each NDI source to a cohort person; show ONLY cohort matches
  // (the user explicitly only wants to see their friends streaming, not
  // arbitrary NDI signals on the LAN like NDI Test Pattern).
  const matched = _watchSources
    .map((s) => ({ source: s, person: matchPersonForNdi(s.name, people) }))
    .filter((m) => m.person);
  // NDI's same-process self-discovery is unreliable, so synthesize a YOU
  // card locally whenever we're live — that way you always see yourself in
  // the cohort feed the moment you go live (Twitch sidebar behavior).
  const id = getIdentity();
  const selfPerson = (id && people.find((p) => p.record_id === id.record_id)) || null;
  if (_live && selfPerson) {
    // De-dup if NDI did happen to return a source matching ourselves.
    const dupIdx = matched.findIndex((m) => m.person.record_id === selfPerson.record_id);
    if (dupIdx >= 0) matched.splice(dupIdx, 1);
    matched.unshift({
      source: { name: _publishedName || "you", urlAddress: "" },
      person: selfPerson,
      isSelf: true,
    });
  }
  const unknownCount = _watchSources.length - (matched.filter((m) => !m.isSelf).length);
  if (statusEl) statusEl.textContent = `${matched.length} live`;
  if (!matched.length) {
    list.innerHTML = `<li class="easel-watch-empty">no cohort streams on the LAN right now${
      unknownCount ? ` — ${unknownCount} other NDI source${unknownCount === 1 ? "" : "s"} not matched to a member` : ""
    }.</li>`;
    return;
  }
  const viewerMode = _stage.querySelector(".easel-viewer")?.dataset.viewerMode;
  list.innerHTML = matched.map(({ source, person, isSelf }) => {
    const active = isSelf ? (viewerMode === "preview") : (_watchSelected === source.name);
    const sig = person.signature_color || "var(--membrane-ember, #ff7a3d)";
    const name = person.display_name || person.name || shortName(source.name);
    const handle = person.handle || person.gh_handle || (person.links && person.links.github) || "";
    const sub = isSelf ? "your broadcast" : (person.role || (handle ? `@${handle}` : person.team || shortName(source.name)));
    return `<li><button type="button" class="ews-card${active ? " is-watching" : ""}${isSelf ? " is-self" : ""}"
                     data-watch-src="${esc(source.name)}"
                     data-watch-self="${isSelf ? "1" : "0"}"
                     style="--ews-sig:${esc(sig)}">
      <span class="ews-thumb">
        ${!isSelf ? `<canvas class="ews-thumb-canvas" data-ews-thumb="${esc(source.name)}" width="160" height="90"></canvas>` : ""}
        <span class="ews-avatar">${esc(initialOf(name))}</span>
        <span class="ews-live"><span class="ews-live-dot"></span>LIVE</span>
        ${isSelf ? `<span class="ews-you" aria-label="you">YOU</span>` : ""}
        ${active && !isSelf ? `<span class="ews-watching" aria-label="now watching">▶</span>` : ""}
      </span>
      <span class="ews-meta">
        <span class="ews-name">${esc(name)}</span>
        <span class="ews-sub">${esc(sub)}</span>
      </span>
    </button></li>`;
  }).join("");
  list.querySelectorAll("[data-watch-src]").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.watchSelf === "1") {
        // Clicking your own card flips the viewer to PREVIEW — you can't
        // receive your own NDI stream over loopback, but the preview canvas
        // shows what you're broadcasting.
        setViewerMode("preview");
      } else {
        watchSelect(btn.getAttribute("data-watch-src"));
      }
    });
  });

  // Reconcile per-card thumbnail receivers — start one for every non-self
  // card now visible; stop any whose source dropped off the list.
  const wantThumbs = new Set(
    matched.filter((m) => !m.isSelf).map((m) => m.source.name)
  );
  for (const existing of _thumbsRunning) {
    if (!wantThumbs.has(existing)) {
      window.api.easel.thumbStop(existing).catch(() => {});
      _thumbsRunning.delete(existing);
    }
  }
  for (const name of wantThumbs) {
    if (_thumbsRunning.has(name)) continue;
    _thumbsRunning.add(name);
    window.api.easel.thumbStart(name).then((r) => {
      if (!r || r.ok === false) _thumbsRunning.delete(name);
    }).catch(() => _thumbsRunning.delete(name));
  }
}

// Update the viewer's info bar (avatar + title + LIVE + duration) to match
// the current mode. Called from setViewerMode, on go/stop, and by the 1s tick.
// Uses cohort identity (signature_color + display_name) when the source maps
// to a known peer, so the player chrome reads as a member, not a hue-hash.
async function syncViewerInfo() {
  const info = _stage && _stage.querySelector("[data-viewer-info]");
  if (!info) return;
  const mode = _stage.querySelector(".easel-viewer")?.dataset.viewerMode;
  const avatarEl = _stage.querySelector("[data-evi-avatar]");
  const titleEl = _stage.querySelector("[data-evi-title]");
  const kindEl = _stage.querySelector("[data-evi-kind]");
  const liveEl = _stage.querySelector("[data-evi-live]");
  const durEl = _stage.querySelector("[data-evi-duration]");
  let name = "", kind = "", liveNow = false, startMs = 0, person = null;
  // Cohort lookup — async but only fires when we actually need it (mode active).
  const cohort = (mode === "preview" || mode === "watch") ? await safe(() => getCohortSurface(), null) : null;
  const people = (cohort && cohort.people) || [];
  if (mode === "preview" && (_live || _selectedId)) {
    const id = getIdentity();
    person = people.find((p) => id && p.record_id === id.record_id) || null;
    name = person ? (person.display_name || person.name) : (_live ? (shortName(_publishedName) || "Easel") : (_sources.find(s => s.id === _selectedId)?.name || "preview"));
    kind = "your broadcast";
    liveNow = _live;
    startMs = _liveStartMs;
  } else if (mode === "watch" && _watchSelected) {
    person = matchPersonForNdi(_watchSelected, people);
    name = person ? (person.display_name || person.name) : shortName(_watchSelected);
    kind = "LAN · NDI";
    liveNow = true;
    startMs = _watchStartMs;
  } else {
    info.hidden = true;
    if (_infoTick) { clearInterval(_infoTick); _infoTick = null; }
    return;
  }
  info.hidden = false;
  const sig = (person && person.signature_color) || "var(--membrane-ember, #ff7a3d)";
  if (avatarEl) {
    avatarEl.textContent = initialOf(name);
    avatarEl.style.setProperty("--ews-sig", sig);
  }
  if (titleEl) titleEl.textContent = name;
  if (kindEl) kindEl.textContent = kind;
  if (liveEl) liveEl.hidden = !liveNow;
  if (durEl) durEl.textContent = liveNow && startMs ? fmtDuration(Date.now() - startMs) : "—";
  // Keep the duration ticking while a stream is live.
  if (liveNow && !_infoTick) {
    _infoTick = setInterval(syncViewerInfo, 1000);
  } else if (!liveNow && _infoTick) {
    clearInterval(_infoTick); _infoTick = null;
  }
}

async function watchSelect(sourceName) {
  if (!sourceName) return;
  // Toggle off if clicking the active source.
  if (_watchSelected === sourceName) { await watchStop(); return; }
  // Tear down any previous stream first.
  await watchStop();
  _watchSelected = sourceName;
  if (_watchOverlay) { _watchOverlay.textContent = `connecting to ${sourceName}…`; _watchOverlay.hidden = false; }
  // Attach the frame listener BEFORE asking main to start, so we don't drop
  // the first frame.
  _watchFrameUnsub = window.api.easel.onRxFrame((frame) => onRxFrame(frame));
  const res = await safe(() => window.api.easel.rxStart(sourceName), { ok: false, error: "rx failed" });
  if (!res || res.ok === false) {
    if (_watchOverlay) { _watchOverlay.textContent = (res && res.error) || "couldn't open that stream"; _watchOverlay.hidden = false; }
    if (_watchFrameUnsub) { _watchFrameUnsub(); _watchFrameUnsub = null; }
    _watchSelected = null;
    await loadWatchSources();    // re-render to clear selection
    return;
  }
  _watchFrames = 0;
  _watchStartMs = Date.now();
  // Re-render the list to mark the selected source.
  await loadWatchSources();
  setViewerMode("watch");
}

async function watchStop() {
  if (_watchFrameUnsub) { try { _watchFrameUnsub(); } catch {} _watchFrameUnsub = null; }
  await safe(() => window.api.easel.rxStop());
  _watchSelected = null;
  _watchFrames = 0;
  if (_watchCtx && _watchCanvas) _watchCtx.clearRect(0, 0, _watchCanvas.width, _watchCanvas.height);
  if (_watchOverlay) { _watchOverlay.textContent = "pick a stream from the LAN list to watch"; _watchOverlay.hidden = false; }
  // Fall back to the broadcast preview if there is one, else go empty.
  setViewerMode((_selectedId || _live) ? "preview" : "empty");
}

function onRxFrame(frame) {
  if (!_watchCtx || !frame || !frame.data) return;
  const { width, height, lineStride, data } = frame;
  if (!width || !height) return;
  if (_watchCanvas.width !== width || _watchCanvas.height !== height) {
    _watchCanvas.width = width;
    _watchCanvas.height = height;
  }
  const expected = width * 4;
  let buf;
  if (lineStride === expected) {
    // Tight RGBA — view directly without copy.
    buf = new Uint8ClampedArray(data.buffer, data.byteOffset, width * height * 4);
  } else {
    // Padded stride — copy row-by-row into a tight buffer for ImageData.
    buf = new Uint8ClampedArray(width * height * 4);
    const src = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    for (let y = 0; y < height; y++) {
      buf.set(src.subarray(y * lineStride, y * lineStride + expected), y * expected);
    }
  }
  // RGBX (no-alpha source) leaves the 4th byte undefined → force opaque so
  // putImageData renders rather than blending to transparent.
  for (let i = 3; i < buf.length; i += 4) buf[i] = 255;
  _watchCtx.putImageData(new ImageData(buf, width, height), 0, 0);
  _watchFrames += 1;
  if (_watchOverlay && !_watchOverlay.hidden) _watchOverlay.hidden = true;
  // Lightweight status update — every ~30 frames so we don't thrash the DOM.
  if ((_watchFrames % 30) === 0) {
    const statusEl = _stage && _stage.querySelector("[data-watch-status]");
    if (statusEl) statusEl.textContent = `${_watchSelected || ""} · ${_watchFrames}f`;
  }
}

function setQuality(q) {
  if (q !== "high" && q !== "fast") return;
  _quality = q;
  saveEaselPrefs({ ...loadEaselPrefs(), quality: q });
  _stage.querySelectorAll(".easel-q-btn").forEach((b) => b.setAttribute("aria-selected", String(b.getAttribute("data-quality") === q)));
  if (_live) applyOutputDims(); // re-size the live stream on the fly
}

async function loadSources() {
  const grid = _stage.querySelector("[data-easel-sources]");
  if (!grid) return;
  grid.innerHTML = `<p class="easel-loading">finding screens & windows…</p>`;
  _sources = await safe(() => window.api.easel.listSources(), []);
  if (!_sources.length) {
    grid.innerHTML = `<p class="easel-loading">no capture sources found (Screen Recording permission may be needed).</p>`;
    return;
  }
  // Screens first, then windows.
  _sources.sort((a, b) => (a.type === b.type ? 0 : a.type === "screen" ? -1 : 1));
  grid.innerHTML = _sources.map((s) => `
    <button class="easel-src${s.id === _selectedId ? " is-sel" : ""}" type="button" data-src-id="${esc(s.id)}" title="${esc(s.name)}">
      ${s.thumbnail ? `<img class="easel-src-thumb" src="${esc(s.thumbnail)}" alt="" />` : `<span class="easel-src-thumb easel-src-thumb-blank"></span>`}
      <span class="easel-src-meta"><span class="easel-src-kind">${esc(s.type)}</span><span class="easel-src-name">${esc(s.name)}</span></span>
    </button>`).join("");
  grid.querySelectorAll("[data-src-id]").forEach((btn) => {
    btn.addEventListener("click", () => selectSource(btn.getAttribute("data-src-id")));
  });
  // Restore the last-used source, else default to the primary screen so
  // going live is one click.
  const prefs = loadEaselPrefs();
  const restore = (prefs.sourceId && _sources.some((s) => s.id === prefs.sourceId))
    ? prefs.sourceId
    : (_sources.find((s) => s.type === "screen") || _sources[0]).id;
  if (restore) selectSource(restore);
}

function selectSource(id) {
  if (_live) return; // can't switch mid-broadcast; stop first
  _selectedId = id;
  _stage.querySelectorAll(".easel-src").forEach((b) => b.classList.toggle("is-sel", b.getAttribute("data-src-id") === id));
  const go = _stage.querySelector("[data-easel-go]");
  if (go) go.disabled = !_ndiAvailable || !id;
  const ov = _stage.querySelector("[data-easel-overlay]");
  const src = _sources.find((s) => s.id === id);
  if (ov) { ov.textContent = src ? `ready · ${src.name} — hit go live to broadcast` : "select a source to preview"; ov.hidden = false; }
  // Show the chosen source's thumbnail as a static preview until live.
  if (src && src.thumbnail && _ctx) {
    const img = new Image();
    img.onload = () => { if (!_live) drawContain(img, img.naturalWidth, img.naturalHeight); };
    img.src = src.thumbnail;
  }
  setViewerMode("preview");
}

// Preview only (pre-live): letterbox a thumbnail into the current canvas.
function drawContain(source, sw, sh) {
  const W = _canvas.width, H = _canvas.height;
  _ctx.fillStyle = "#0c0b10";
  _ctx.fillRect(0, 0, W, H);
  if (!sw || !sh) return;
  const scale = Math.min(W / sw, H / sh);
  const dw = sw * scale, dh = sh * scale;
  _ctx.drawImage(source, (W - dw) / 2, (H - dh) / 2, dw, dh);
}

async function goLive() {
  if (!_selectedId) return;
  hideError();
  const name = (_stage.querySelector("[data-easel-name]").value || "Easel").trim() || "Easel";
  const res = await safe(() => window.api.easel.start({ name }), { ok: false, error: "sender failed to start" });
  if (!res || res.ok === false) { showError(res && res.error ? res.error : "couldn't start the NDI sender."); return; }
  _publishedName = (res && res.name) || name; // the name receivers actually see (hostname-prefixed)

  try {
    _stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: _selectedId,
        maxWidth: 1920, maxHeight: 1080, maxFrameRate: FPS,
      } },
    });
  } catch (e) {
    await safe(() => window.api.easel.stop());
    showError("screen capture was blocked. Grant Screen Recording permission to the app, then fully quit & reopen easel. (" + e.message + ")", true);
    return;
  }

  _video.srcObject = _stream;
  await _video.play().catch(() => {});
  // If the user stops sharing via the OS, tear down cleanly.
  const track = _stream.getVideoTracks()[0];
  if (track) track.addEventListener("ended", () => stopLive());

  // Size the output to the source's native resolution (capped by quality) so
  // the projection is crisp, instead of a fixed 720p downscale.
  if (!_video.videoWidth) {
    await new Promise((r) => { _video.addEventListener("loadedmetadata", r, { once: true }); setTimeout(r, 1500); });
  }
  applyOutputDims();

  _live = true;
  _liveStartMs = Date.now();
  saveEaselPrefs({ ...loadEaselPrefs(), name, sourceId: _selectedId });
  const ov = _stage.querySelector("[data-easel-overlay]");
  if (ov) ov.hidden = true;
  syncGoButton();
  pump();
  _statsTimer = setInterval(refreshStats, 1000);
  refreshStats();
  syncViewerInfo();
  // Surface ourselves in the LAN feed now that we're live.
  loadWatchSources();
}

async function stopLive() {
  _live = false;
  _liveStartMs = 0;
  // Drop the YOU card from the LAN feed.
  loadWatchSources();
  if (_pumpTimer) { clearTimeout(_pumpTimer); _pumpTimer = null; }
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null; }
  if (_stream) { _stream.getTracks().forEach((t) => t.stop()); _stream = null; }
  if (_video) _video.srcObject = null;
  await safe(() => window.api.easel.stop());
  const ov = _stage.querySelector("[data-easel-overlay]");
  if (ov) { ov.hidden = false; ov.textContent = "stopped"; }
  syncGoButton();
  refreshStatus(null);
}

async function pump() {
  if (!_live || !_ctx || !_video) return;
  const t0 = performance.now();
  // Canvas matches the source aspect, so draw the full frame (no letterbox).
  if (_video.videoWidth) _ctx.drawImage(_video, 0, 0, _outW, _outH);
  let img = null;
  try { img = _ctx.getImageData(0, 0, _outW, _outH); } catch { /* shouldn't taint on local capture */ }
  if (img) await safe(() => window.api.easel.frame({ width: _outW, height: _outH, data: img.data }));
  if (!_live) return;
  const elapsed = performance.now() - t0;
  _pumpTimer = setTimeout(pump, Math.max(0, 1000 / FPS - elapsed));
}

async function refreshStats() {
  const s = await safe(() => window.api.easel.stats(), null);
  refreshStatus(s);
}

function refreshStatus(s) {
  const el = _stage && _stage.querySelector("[data-easel-status]");
  if (!el) return;
  if (!s || !s.live) {
    el.innerHTML = `<span class="easel-dot easel-dot-off"></span><span>idle</span>`;
    return;
  }
  const conns = s.connections || 0;
  el.innerHTML =
    `<span class="easel-dot easel-dot-on"></span>` +
    `<span class="easel-live-tag">LIVE</span>` +
    `<span class="easel-stat-name">${esc(_publishedName || s.name)}</span>` +
    `<span class="easel-stat-sep">·</span>` +
    `<span class="easel-watching">${conns} watching</span>` +
    `<span class="easel-stat-sep">·</span>` +
    `<span class="easel-stat-frames">${s.frames} frames</span>`;
}

function syncGoButton() {
  const go = _stage.querySelector("[data-easel-go]");
  if (!go) return;
  go.textContent = _live ? "stop" : "go live";
  go.classList.toggle("is-live", _live);
  go.disabled = !_ndiAvailable || (!_live && !_selectedId);
  // Lock source switching + name while live.
  _stage.querySelectorAll(".easel-src").forEach((b) => (b.disabled = _live));
  const nameI = _stage.querySelector("[data-easel-name]");
  if (nameI) nameI.disabled = _live;
}

function showError(msg, withSettings) {
  const el = _stage.querySelector("[data-easel-err]");
  if (!el) return;
  el.innerHTML = `<span>${esc(msg)}</span>` +
    (withSettings ? ` <button type="button" class="easel-err-btn" data-easel-open-settings>open Screen Recording settings</button>` : "");
  el.hidden = false;
  const b = el.querySelector("[data-easel-open-settings]");
  if (b) b.addEventListener("click", () => { try { window.api.openExternal(SCREEN_RECORDING_SETTINGS); } catch {} });
}
function hideError() {
  const el = _stage.querySelector("[data-easel-err]");
  if (el) el.hidden = true;
}
