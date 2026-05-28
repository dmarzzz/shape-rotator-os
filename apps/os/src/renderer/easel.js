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
    <div class="easel-app">
      <header class="easel-head">
        <p class="easel-eyebrow">apps · projection</p>
        <h1 class="easel-title">easel</h1>
        <p class="easel-sub">broadcast a screen or window over <strong>NDI</strong> to the projector. pick a source, name it, go live — any NDI receiver on the LAN can pull it.</p>
      </header>
      ${_ndiAvailable ? "" : `<div class="easel-banner easel-banner-warn">NDI runtime not available on this machine — the native sender failed to load. (Install NDI Tools, then reopen easel.)</div>`}
      <div class="easel-body">
        <section class="easel-sources" data-easel-sources></section>
        <section class="easel-stagebox">
          <canvas class="easel-canvas" width="1280" height="720" data-easel-canvas></canvas>
          <div class="easel-overlay" data-easel-overlay>select a source to preview</div>
        </section>
      </div>
      <footer class="easel-controls">
        <label class="easel-namefield">
          <span>NDI name</span>
          <input type="text" data-easel-name value="${defaultName}" maxlength="48" spellcheck="false" />
        </label>
        <div class="easel-quality" role="group" aria-label="output quality">
          <button class="easel-q-btn" type="button" data-quality="high" aria-selected="${_quality === "high"}">1080p</button>
          <button class="easel-q-btn" type="button" data-quality="fast" aria-selected="${_quality === "fast"}">720p</button>
        </div>
        <button class="easel-go" type="button" data-easel-go disabled>go live</button>
        <div class="easel-status" data-easel-status></div>
      </footer>
      <p class="easel-recv-hint">to project: on the receiver — NDI Studio Monitor, OBS, Resolume, or easel — pick your source from the NDI list. "0 watching" just means no one's pulling it yet.</p>
      <div class="easel-err" data-easel-err hidden></div>

      ${_ndiAvailable ? `
      <section class="easel-watch">
        <header class="easel-watch-head">
          <span class="easel-watch-eyebrow">watching the LAN</span>
          <span class="easel-watch-status" data-watch-status>—</span>
          <button class="easel-watch-refresh" type="button" data-watch-refresh aria-label="refresh sources">↻ refresh</button>
        </header>
        <ul class="easel-watch-list" data-watch-list role="list">
          <li class="easel-watch-loading">looking for NDI sources on the LAN…</li>
        </ul>
        <div class="easel-watch-viewer">
          <canvas class="easel-watch-canvas" data-watch-canvas width="640" height="360"></canvas>
          <div class="easel-watch-overlay" data-watch-overlay>pick a stream above to watch</div>
        </div>
      </section>` : ""}
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
  }

  refreshStatus(null);
}

async function loadWatchSources() {
  const list = _stage.querySelector("[data-watch-list]");
  const statusEl = _stage.querySelector("[data-watch-status]");
  if (!list) return;
  list.innerHTML = `<li class="easel-watch-loading">scanning…</li>`;
  if (statusEl) statusEl.textContent = "scanning…";
  const sources = await safe(() => window.api.easel.findNdi({ timeoutMs: 3000 }), []);
  _watchSources = Array.isArray(sources) ? sources : [];
  if (statusEl) statusEl.textContent = `${_watchSources.length} found`;
  if (!_watchSources.length) {
    list.innerHTML = `<li class="easel-watch-empty">no NDI sources on the LAN yet — when a cohort peer goes live, they'll show up here.</li>`;
    return;
  }
  list.innerHTML = _watchSources.map((s) => {
    const sel = _watchSelected === s.name ? " is-watching" : "";
    return `<li><button type="button" class="easel-watch-src${sel}" data-watch-src="${esc(s.name)}">
      <span class="ews-glyph" aria-hidden="true">${_watchSelected === s.name ? "▶" : "○"}</span>
      <span class="ews-name">${esc(s.name)}</span>
    </button></li>`;
  }).join("");
  list.querySelectorAll("[data-watch-src]").forEach((btn) => {
    btn.addEventListener("click", () => watchSelect(btn.getAttribute("data-watch-src")));
  });
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
  // Re-render the list to mark the selected source.
  await loadWatchSources();
}

async function watchStop() {
  if (_watchFrameUnsub) { try { _watchFrameUnsub(); } catch {} _watchFrameUnsub = null; }
  await safe(() => window.api.easel.rxStop());
  _watchSelected = null;
  _watchFrames = 0;
  if (_watchCtx && _watchCanvas) _watchCtx.clearRect(0, 0, _watchCanvas.width, _watchCanvas.height);
  if (_watchOverlay) { _watchOverlay.textContent = "pick a stream above to watch"; _watchOverlay.hidden = false; }
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
  if (ov) { ov.textContent = src ? `ready · ${src.name}` : "select a source to preview"; ov.hidden = false; }
  // Show the chosen source's thumbnail as a static preview until live.
  if (src && src.thumbnail && _ctx) {
    const img = new Image();
    img.onload = () => { if (!_live) drawContain(img, img.naturalWidth, img.naturalHeight); };
    img.src = src.thumbnail;
  }
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
  saveEaselPrefs({ ...loadEaselPrefs(), name, sourceId: _selectedId });
  const ov = _stage.querySelector("[data-easel-overlay]");
  if (ov) ov.hidden = true;
  syncGoButton();
  pump();
  _statsTimer = setInterval(refreshStats, 1000);
  refreshStats();
}

async function stopLive() {
  _live = false;
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
