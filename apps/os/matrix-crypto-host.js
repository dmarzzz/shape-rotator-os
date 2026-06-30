// matrix-crypto-host.js — main-process supervisor for the E2EE crypto engine.
//
// The Olm/Megolm work (matrix-crypto.js, native @matrix-org/matrix-sdk-crypto-
// nodejs) is the one part of the Matrix client that can HARD-crash: a Rust panic
// in the native module aborts its PROCESS (SIGABRT), which JS cannot catch.
// Running it inline in the main process would take the whole app down (membrane,
// atlas, calendar — everything). So we fork it into a utilityProcess child: a
// panic there kills only the child, the main app survives, and we degrade to
// exactly the pre-E2EE behaviour (encrypted rooms stay locked) — never worse
// than shipping no crypto at all.
//
// This module exposes the SAME async surface matrix.js used to call directly on
// matrix-crypto.js (init / isReady / onSyncChanges / decryptEvent /
// encryptForRoom / close), so matrix.js only changes its require() target.
//
// HTTP stays in the main process: the child has no access to Electron's
// net.fetch (the cohort homeserver's TEE cert chain needs Chromium's network
// stack). The child asks us to run each request via the http() callback that
// matrix.js handed to init(); we marshal request → response over the port.
//
// We do NOT auto-respawn after a crash. The known native panic recurs on the
// same input, so respawning would just crash-loop; instead one crash degrades
// crypto for the rest of the session (relaunch to retry), and plain channels
// keep working untouched.

const path = require("node:path");
const { utilityProcess } = require("electron");

function warn(msg) { try { process.stderr.write(`[matrix-crypto-host:warn] ${msg}\n`); } catch {} }

let child = null;
let ready = false;          // true once the child reports a successful init
let httpFn = null;          // matrix.js's authed net.fetch bridge, kept in main
let seq = 0;
const pending = new Map();  // cmd id → { resolve, reject }

// Only init is time-bounded: it's awaited OUTSIDE the sync loop (matrix.js
// ensureCrypto), so a dropped/stuck init would hang the whole sync loop — worse
// than degrading. On timeout we tear down and let matrix.js fall back to
// "encrypted rooms stay locked". Per-sync calls aren't bounded: a dead child
// surfaces via the exit handler, and a slow one is legitimately working.
const INIT_TIMEOUT_MS = 30000;

function rejectAllPending(err) {
  for (const { reject } of pending.values()) { try { reject(err); } catch {} }
  pending.clear();
}

function withTimeout(promise, ms, msg) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

// Messages FROM the child: replies to our commands, and HTTP requests the
// OlmMachine wants run (it owns no network — we run them here and reply).
async function onChildMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.kind === "cmd-reply") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error || "crypto error"));
    return;
  }
  if (msg.kind === "http") {
    if (!httpFn) return;   // closed mid-flight — don't issue another authed request
    let reply;
    try {
      const r = await httpFn(msg.method, msg.path, msg.body);
      reply = { kind: "http-reply", id: msg.id, status: r.status, body: r.body };
    } catch (e) {
      reply = { kind: "http-reply", id: msg.id, error: (e && e.message) || String(e) };
    }
    try { if (child) child.postMessage(reply); } catch {}
  }
}

function spawnChild() {
  const script = path.join(__dirname, "matrix-crypto-proc.js");
  const proc = utilityProcess.fork(script);
  proc.on("message", onChildMessage);
  proc.on("exit", (code) => {
    if (child !== proc) return;            // a newer child superseded this one
    ready = false;
    child = null;
    rejectAllPending(new Error("crypto process exited"));
    if (code !== 0) warn(`crypto process exited unexpectedly (code ${code}) — encrypted rooms stay locked until relaunch`);
  });
  return proc;
}

function sendCmd(name, args) {
  return new Promise((resolve, reject) => {
    if (!child) { reject(new Error("crypto process not running")); return; }
    const id = `c${++seq}`;
    pending.set(id, { resolve, reject });
    try { child.postMessage({ kind: "cmd", id, name, args }); }
    catch (e) { pending.delete(id); reject(e); }
  });
}

// Mirror matrix-crypto.js's surface. Failure here is non-fatal: matrix.js's
// ensureCrypto() catches and degrades to "encrypted rooms stay locked".
async function init({ userId, deviceId, storePath, passphrase, http }) {
  httpFn = http;
  if (!child) child = spawnChild();   // fork() throw → caught by matrix.js → degrade
  try {
    await withTimeout(sendCmd("init", { userId, deviceId, storePath, passphrase }), INIT_TIMEOUT_MS, "crypto init timed out");
    ready = true;
    return true;
  } catch (e) {
    close();   // tear the child down so init failure never leaks an idle child or hangs a retry
    throw e;   // matrix.js ensureCrypto catches → degrade to "encrypted rooms stay locked"
  }
}

function isReady() { return ready && !!child; }

async function onSyncChanges(payload) {
  if (!isReady()) return;
  return sendCmd("onSyncChanges", payload || {});
}

async function decryptEvent(rawEvent, roomId) {
  if (!isReady()) throw new Error("crypto not ready");
  return sendCmd("decryptEvent", { rawEvent, roomId });
}

async function encryptForRoom(params) {
  if (!isReady()) throw new Error("crypto not ready");
  return sendCmd("encryptForRoom", params);
}

// Synchronous teardown (matrix.js calls it from saveSession/clearSession). Kill
// the child outright; the SQLite crypto store is transactional and reopens
// cleanly next launch. Clearing `child` first makes the exit handler treat this
// as an intentional close, not a crash.
function close() {
  ready = false;
  httpFn = null;
  const c = child; child = null;
  rejectAllPending(new Error("crypto closed"));
  if (c) { try { c.kill(); } catch {} }
}

module.exports = { init, isReady, onSyncChanges, decryptEvent, encryptForRoom, close };
