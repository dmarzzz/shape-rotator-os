/* easel.js — the "easel" app: project a screen or window over NDI.
 *
 * Pick a capture source → "go live" → we draw each captured frame to a 720p
 * canvas and ship the RGBA pixels to the main process (apps/os/easel-ndi.js),
 * which broadcasts them as an NDI source on the LAN. Any NDI receiver — the
 * projector tonight, OBS, easel itself — can then pull the stream.
 *
 * macOS for now: screen capture needs Screen Recording permission granted to
 * the app in System Settings → Privacy & Security.
 *
 * Lifecycle mirrors atlas.js: mount(stage) / setActive(bool) / notifyDataChanged().
 */

import { getIdentity } from "./identity.js";

const TARGET_W = 1280;
const TARGET_H = 720;
const FPS = 30;
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
  // Leaving the view while broadcasting → stop cleanly (don't keep capturing
  // the screen in the background).
  if (!_active && _live) stopLive();
}

export function notifyDataChanged() { /* nothing data-driven here */ }

async function safe(fn, fallback) { try { return await fn(); } catch { return fallback; } }

function renderShell() {
  // Prefill the NDI name from a saved value or the claimed identity, so each
  // person's source is distinguishable on the network (not a wall of "Easel").
  const prefs = loadEaselPrefs();
  const id = getIdentity();
  const defaultName = esc(prefs.name || (id && id.display_name) || "Easel");
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
          <canvas class="easel-canvas" width="${TARGET_W}" height="${TARGET_H}" data-easel-canvas></canvas>
          <div class="easel-overlay" data-easel-overlay>select a source to preview</div>
        </section>
      </div>
      <footer class="easel-controls">
        <label class="easel-namefield">
          <span>NDI name</span>
          <input type="text" data-easel-name value="${defaultName}" maxlength="48" spellcheck="false" />
        </label>
        <button class="easel-go" type="button" data-easel-go disabled>go live</button>
        <div class="easel-status" data-easel-status></div>
      </footer>
      <p class="easel-recv-hint">to project: on the receiver — NDI Studio Monitor, OBS, Resolume, or easel — pick your source from the NDI list. "0 watching" just means no one's pulling it yet.</p>
      <div class="easel-err" data-easel-err hidden></div>
    </div>`;

  _canvas = _stage.querySelector("[data-easel-canvas]");
  _ctx = _canvas.getContext("2d", { willReadFrequently: true });
  _video = document.createElement("video");
  _video.muted = true; _video.playsInline = true;

  _stage.querySelector("[data-easel-go]").addEventListener("click", () => (_live ? stopLive() : goLive()));
  refreshStatus(null);
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

function drawContain(source, sw, sh) {
  _ctx.fillStyle = "#0c0b10";
  _ctx.fillRect(0, 0, TARGET_W, TARGET_H);
  if (!sw || !sh) return;
  const scale = Math.min(TARGET_W / sw, TARGET_H / sh);
  const dw = sw * scale, dh = sh * scale;
  _ctx.drawImage(source, (TARGET_W - dw) / 2, (TARGET_H - dh) / 2, dw, dh);
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
  if (_video.videoWidth) drawContain(_video, _video.videoWidth, _video.videoHeight);
  let img = null;
  try { img = _ctx.getImageData(0, 0, TARGET_W, TARGET_H); } catch { /* shouldn't taint on local capture */ }
  if (img) await safe(() => window.api.easel.frame({ width: TARGET_W, height: TARGET_H, data: img.data }));
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
