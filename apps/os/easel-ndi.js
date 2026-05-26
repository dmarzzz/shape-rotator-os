// easel-ndi.js — NDI sender for the "easel" app (main process).
//
// Wraps @stagetimerio/grandiose, an N-API binding for the NDI SDK. N-API is
// ABI-stable, so the prebuilt/source-built .node loads under Electron with no
// electron-rebuild (verified against Electron 33 + NDI runtime 6.x).
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

module.exports = { isAvailable, start, sendFrame, stats, stop };
