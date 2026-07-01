// easel-ndi.js — NDI sender for the "easel" app (main process).
//
// Optionally wraps @stagetimerio/grandiose, an N-API binding for the NDI SDK.
// The release build does not bundle it; when absent, the UI shows "NDI
// unavailable" and the rest of the app keeps running.
//
// Flow: the renderer captures a screen/window via desktopCapturer, draws each
// frame to a canvas, and ships the RGBA pixel buffer here over IPC; we hand it
// to the NDI sender as a video frame. macOS-focused for now (the projector
// path we need tonight); the binding also supports win/linux x64/arm64.
//
// Frame pacing is latest-wins: if a frame arrives while the previous send is
// still in flight we drop it, so a slow consumer can never back up the queue.

let grandiose = null;
let loadError = null;
let sender = null;
let busy = false;
let frameCount = 0;
let currentName = "";

function load() {
  if (grandiose) return grandiose;
  if (loadError) throw loadError;
  try {
    grandiose = require("@stagetimerio/grandiose");
    return grandiose;
  } catch (e) {
    loadError = e;
    console.error("[easel-ndi] failed to load @stagetimerio/grandiose:", e.message);
    throw e;
  }
}

// Whether the native NDI binding is usable on this machine (so the renderer
// can show a clear "NDI unavailable" state instead of a dead button).
function isAvailable() {
  try { load(); return true; } catch { return false; }
}

async function start(name) {
  await stop();
  const g = load();
  currentName = (name && String(name).trim()) || "Easel";
  sender = await g.send({ name: currentName });
  frameCount = 0;
  const published = (() => { try { return sender.sourcename(); } catch { return currentName; } })();
  console.log("[easel-ndi] sender live:", published);
  return { ok: true, name: published };
}

async function sendFrame({ width, height, data } = {}) {
  // Drop silently if not live or mid-send (latest-wins) or malformed.
  if (!sender || busy || !width || !height || !data) return false;
  busy = true;
  try {
    const g = load();
    // `data` arrives as a Uint8ClampedArray over IPC; Buffer.from copies it.
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await sender.video({
      xres: width,
      yres: height,
      frameRateN: 30000,
      frameRateD: 1001,
      fourCC: g.FOURCC_RGBA,
      pictureAspectRatio: width / height,
      frameFormatType: g.FORMAT_TYPE_PROGRESSIVE,
      lineStrideBytes: width * 4,
      data: buf,
    });
    frameCount++;
    return true;
  } catch (e) {
    console.error("[easel-ndi] sendFrame:", e.message);
    return false;
  } finally {
    busy = false;
  }
}

function stats() {
  if (!sender) return { live: false, name: "", connections: 0, frames: 0 };
  let connections = 0;
  try { connections = sender.connections(); } catch {}
  return { live: true, name: currentName, connections, frames: frameCount };
}

async function stop() {
  if (sender) {
    try { await sender.destroy(); } catch {}
    sender = null;
  }
  busy = false;
  frameCount = 0;
  return true;
}

// ─── NDI receive side ────────────────────────────────────────────────
// Same native binding, opposite direction: discover sources on the LAN and
// pull video frames from one of them. The receiver pump runs here in main
// and pushes each frame to the renderer via the onFrame callback (wired to
// webContents.send in main.js).

let _rxReceiver = null;
let _rxAlive = false;
let _rxFrameCount = 0;
let _rxOnFrame = null;
let _rxOnAudio = null;
let _rxCurrentSourceName = "";

// Per-source low-bandwidth thumbnail receivers (independent of the main
// viewer receiver). Map<sourceName, { receiver, alive, onFrame }>.
const _thumbs = new Map();

// Discover NDI sources on the LAN. Returns [{ name, urlAddress }]. Wrapped
// in a soft timeout so a quiet LAN doesn't hang the renderer.
async function find({ timeoutMs = 2500 } = {}) {
  try {
    const g = load();
    // Native find appears to be a one-shot snapshot of the current mDNS
    // cache rather than a blocking wait — so first call after launch is
    // often empty. Poll a few times within timeoutMs so the cache has time
    // to populate as Bonjour resolves.
    const start = Date.now();
    const seen = new Map();
    let pollCount = 0;
    while (Date.now() - start < timeoutMs) {
      pollCount += 1;
      let batch = [];
      try {
        batch = await Promise.resolve(g.find({ showLocalSources: true, wait: 800 }));
      } catch (e) {
        console.error("[easel-ndi] find poll:", e.message);
      }
      if (Array.isArray(batch)) {
        for (const s of batch) {
          const name = s && s.name;
          if (!name || seen.has(name)) continue;
          seen.set(name, { name, urlAddress: s.urlAddress || "" });
        }
      }
      if (Date.now() - start >= timeoutMs) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const out = [...seen.values()];
    console.log(`[easel-ndi] find: ${out.length} sources after ${pollCount} polls (${Date.now()-start}ms)`);
    return out;
  } catch (e) {
    console.error("[easel-ndi] find:", e.message);
    return [];
  }
}

async function recvStart({ sourceName, onFrame, onAudio } = {}) {
  await recvStop();
  if (!sourceName) return { ok: false, error: "no source name" };
  const g = load();
  // Refind to resolve the source's urlAddress (the receiver needs the full
  // source object). The list is cheap to rebuild.
  const sources = await find({ timeoutMs: 2500 });
  const source = sources.find((s) => s.name === sourceName);
  if (!source) return { ok: false, error: "source not on LAN" };
  try {
    _rxReceiver = await g.receive({
      source,
      colorFormat: g.COLOR_FORMAT_RGBX_RGBA,
      bandwidth: g.BANDWIDTH_HIGHEST,
      allowVideoFields: false,
    });
  } catch (e) {
    return { ok: false, error: "receiver init failed: " + e.message };
  }
  _rxOnFrame = typeof onFrame === "function" ? onFrame : null;
  _rxOnAudio = typeof onAudio === "function" ? onAudio : null;
  _rxAlive = true;
  _rxFrameCount = 0;
  _rxCurrentSourceName = sourceName;
  pumpRecv().catch((e) => console.error("[easel-ndi] recv pump:", e.message));
  pumpRecvAudio().catch((e) => console.error("[easel-ndi] recv-audio pump:", e.message));
  return { ok: true, name: sourceName };
}

// Audio pump runs in parallel with the video pump — grandiose's receiver
// exposes separate .video()/.audio() methods, so we just drive both loops.
async function pumpRecvAudio() {
  while (_rxAlive && _rxReceiver) {
    let frame = null;
    try { frame = await _rxReceiver.audio(1000); } catch { /* timeout / transient */ }
    if (!_rxAlive) break;
    if (frame && frame.data && frame.sampleRate > 0 && frame.noSamples > 0) {
      if (_rxOnAudio) {
        try {
          _rxOnAudio({
            sampleRate: frame.sampleRate,
            channels: frame.noChannels,
            samples: frame.noSamples,
            data: frame.data,
          });
        } catch {}
      }
    }
  }
}

async function pumpRecv() {
  while (_rxAlive && _rxReceiver) {
    let frame = null;
    try {
      // 1s soft timeout so recvStop() can wind the loop down quickly without
      // a permanently-blocked native call.
      frame = await _rxReceiver.video(1000);
    } catch { /* timeout / transient — keep looping */ }
    if (!_rxAlive) break;
    if (frame && frame.data && frame.xres > 0 && frame.yres > 0) {
      _rxFrameCount += 1;
      if (_rxOnFrame) {
        try {
          _rxOnFrame({
            width: frame.xres,
            height: frame.yres,
            lineStride: frame.lineStrideBytes || frame.xres * 4,
            data: frame.data,
          });
        } catch {}
      }
    }
  }
}

async function recvStop() {
  _rxAlive = false;
  _rxOnFrame = null;
  _rxOnAudio = null;
  if (_rxReceiver) {
    try { await _rxReceiver.destroy(); } catch {}
    _rxReceiver = null;
  }
  _rxCurrentSourceName = "";
  return true;
}

// ─── per-source thumbnail receivers ──────────────────────────────────
// Each card in the LAN feed gets a tiny, low-bandwidth receiver so the
// thumbnail shows actual live preview frames at ~3fps (Twitch parity).
// Runs independently of the main viewer receiver — even if you're
// watching source A in the viewer, the thumb for A keeps updating.
async function thumbStart({ sourceName, onFrame } = {}) {
  if (!sourceName) return { ok: false, error: "no source name" };
  if (_thumbs.has(sourceName)) {
    // Already running — just rebind the callback to the current renderer.
    _thumbs.get(sourceName).onFrame = typeof onFrame === "function" ? onFrame : null;
    return { ok: true, already: true };
  }
  const g = load();
  const sources = await find({ timeoutMs: 2000 });
  const source = sources.find((s) => s.name === sourceName);
  if (!source) return { ok: false, error: "source not on LAN" };
  let receiver;
  try {
    receiver = await g.receive({
      source,
      colorFormat: g.COLOR_FORMAT_RGBX_RGBA,
      bandwidth: g.BANDWIDTH_LOWEST,   // tiny preview is enough for the thumb
      allowVideoFields: false,
    });
  } catch (e) {
    return { ok: false, error: "thumb receiver failed: " + e.message };
  }
  const state = { receiver, alive: true, onFrame: typeof onFrame === "function" ? onFrame : null };
  _thumbs.set(sourceName, state);
  pumpThumb(sourceName).catch((e) => console.error("[easel-ndi] thumb pump:", e.message));
  return { ok: true };
}

async function pumpThumb(sourceName) {
  let lastSentAt = 0;
  while (true) {
    const s = _thumbs.get(sourceName);
    if (!s || !s.alive) break;
    let frame = null;
    try { frame = await s.receiver.video(1000); } catch { /* transient */ }
    const s2 = _thumbs.get(sourceName);
    if (!s2 || !s2.alive) break;
    if (!frame || !frame.data || !frame.xres || !frame.yres) continue;
    // Throttle emission to ~3fps regardless of source rate.
    const now = Date.now();
    if (now - lastSentAt < 320) continue;
    lastSentAt = now;
    if (s2.onFrame) {
      try {
        s2.onFrame({
          sourceName,
          width: frame.xres,
          height: frame.yres,
          lineStride: frame.lineStrideBytes || frame.xres * 4,
          data: frame.data,
        });
      } catch {}
    }
  }
}

async function thumbStop(sourceName) {
  if (!sourceName) return true;
  const s = _thumbs.get(sourceName);
  if (!s) return true;
  s.alive = false;
  s.onFrame = null;
  try { await s.receiver.destroy(); } catch {}
  _thumbs.delete(sourceName);
  return true;
}

async function thumbStopAll() {
  const names = [..._thumbs.keys()];
  for (const n of names) {
    const s = _thumbs.get(n);
    if (s) { s.alive = false; s.onFrame = null; try { await s.receiver.destroy(); } catch {} }
    _thumbs.delete(n);
  }
  return true;
}

function recvStats() {
  return {
    active: !!_rxReceiver,
    sourceName: _rxCurrentSourceName,
    frames: _rxFrameCount,
  };
}

module.exports = {
  isAvailable, start, sendFrame, stats, stop,
  find, recvStart, recvStop, recvStats,
  thumbStart, thumbStop, thumbStopAll,
};
