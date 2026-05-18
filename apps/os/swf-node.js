// swf-node.js
//
// Spawn + supervise the bundled `swf-node` binary that ships inside
// the Electron .app's Resources/. Today the OS app talks to a swf-node
// daemon over http://127.0.0.1:7777 and expected the user to be
// running it externally — this module makes the app spawn its own.
//
// State machine
//   idle         — not started yet
//   starting     — spawn() called, no exit signal yet
//   running      — child is alive (first stdout/stderr line OR
//                  300ms grace window passed without an exit)
//   crashed      — exited unexpectedly 3 times in a row
//   unsupported  — win32 OR binary is missing on disk OR explicitly
//                  disabled via SWF_NODE_DISABLE=1
//
// Lifecycle
//   start(BrowserWindow|null)  — call on app.whenReady
//   stop()                     — call on app.before-quit; resolves
//                                when the child has exited
//   getStatus()                — returns the current state string
//
// CLI notes (from dmarzzz/searxng-wth-frnds/docs/CONFIG.md)
//   - swf-node has NO port/data-dir CLI flags; everything is env vars:
//       SWF_BIND, SWF_PORT, SWF_FULL, SWF_CONFIG_DIR, SWF_KNOWLEDGE_DIR,
//       SWF_STATE_DIR
//   - We launch with SWF_FULL=1 so the renderer's /graph, /events,
//     /metrics/* + /admin/* routes are live (main.js's env:get handler
//     already points at http://127.0.0.1:7777 for this aggregator
//     surface).
//   - All three data-dirs are pinned under app.getPath("userData")/
//     swf-node-data/ so an uninstall wipes them with the rest of
//     userData and so we don't collide with a user's own ~/.config/swf
//     install on the same machine.

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const LOG_MAX_BYTES = 5 * 1024 * 1024;   // ~5MB before rotation
const RESTART_LIMIT = 3;                  // unexpected exits before we give up
const RESTART_BACKOFF_MS = 2000;
const SIGTERM_GRACE_MS = 3000;            // wait this long before SIGKILL on quit
const PORT = 7777;                        // the renderer's hardcoded default

let _proc = null;
let _state = "idle";
let _binaryPath = null;
let _dataDir = null;
let _logPath = null;
let _logStream = null;
let _logBytes = 0;
let _restartCount = 0;
let _expectQuit = false;
let _quitResolve = null;
let _broadcaster = null;       // (state) => void

function setState(next) {
  if (_state === next) return;
  const prev = _state;
  _state = next;
  process.stderr.write(`[swf-node] state: ${prev} → ${next}\n`);
  if (_broadcaster) {
    try { _broadcaster(next); } catch {}
  }
}

function rotateLogIfNeeded() {
  if (!_logPath) return;
  try {
    const st = fs.statSync(_logPath);
    if (st.size >= LOG_MAX_BYTES) {
      const rotated = `${_logPath}.1`;
      try { fs.unlinkSync(rotated); } catch {}
      fs.renameSync(_logPath, rotated);
      _logBytes = 0;
    }
  } catch {
    // file doesn't exist yet — that's fine
  }
}

function openLogStream() {
  rotateLogIfNeeded();
  try { _logStream = fs.createWriteStream(_logPath, { flags: "a" }); }
  catch (e) {
    process.stderr.write(`[swf-node] couldn't open log ${_logPath}: ${e.message}\n`);
    _logStream = null;
  }
}

function closeLogStream() {
  if (_logStream) {
    try { _logStream.end(); } catch {}
    _logStream = null;
  }
}

function appendLog(stream, chunk) {
  if (!_logStream) return;
  const line = `[${new Date().toISOString()}] [${stream}] ${chunk}`;
  try {
    _logStream.write(line);
    _logBytes += Buffer.byteLength(line);
    if (_logBytes >= LOG_MAX_BYTES) {
      closeLogStream();
      rotateLogIfNeeded();
      openLogStream();
    }
  } catch {}
}

function resolveBinary(app) {
  if (process.platform === "win32") return { ok: false, reason: "win32" };

  if (app.isPackaged) {
    const p = path.join(process.resourcesPath, "swf-node", "swf-node");
    if (!fs.existsSync(p)) return { ok: false, reason: "missing", path: p };
    return { ok: true, path: p };
  }

  // Dev mode — only spawn when explicitly opted in. The user may be
  // running their own swf-node externally, and racing it on :7777 is
  // worse than just leaving the env:get handler pointing at the
  // existing daemon.
  const devPath = process.env.SWF_NODE_BIN;
  if (!devPath) return { ok: false, reason: "dev_no_env" };
  if (!fs.existsSync(devPath)) return { ok: false, reason: "missing", path: devPath };
  return { ok: true, path: devPath };
}

function spawnChild() {
  setState("starting");
  _expectQuit = false;

  const env = {
    ...process.env,
    SWF_BIND: "127.0.0.1",
    SWF_PORT: String(PORT),
    SWF_FULL: "1",                            // aggregator mode → /graph, /events, /metrics/*
    SWF_NO_MDNS: process.env.SWF_NO_MDNS || "", // user can flip this; default off (mDNS on)
    SWF_CONFIG_DIR: path.join(_dataDir, "config"),
    SWF_KNOWLEDGE_DIR: path.join(_dataDir, "world_knowledge"),
    SWF_STATE_DIR: path.join(_dataDir, "state"),
  };

  // Make sure the data dirs exist before the child tries to write into
  // them — swf-node creates `world_knowledge` lazily but expects
  // `SWF_CONFIG_DIR` and `SWF_STATE_DIR` to be writable.
  for (const k of ["SWF_CONFIG_DIR", "SWF_KNOWLEDGE_DIR", "SWF_STATE_DIR"]) {
    try { fs.mkdirSync(env[k], { recursive: true }); } catch {}
  }

  process.stderr.write(`[swf-node] spawning ${_binaryPath} (cwd=${_dataDir}, port=${PORT})\n`);
  process.stderr.write(`[swf-node]   data: ${_dataDir}\n`);
  process.stderr.write(`[swf-node]   log:  ${_logPath}\n`);

  let child;
  try {
    child = spawn(_binaryPath, [], {
      cwd: _dataDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // detached:false so SIGTERM to electron propagates if our
      // explicit-quit path misses the child somehow.
      detached: false,
    });
  } catch (e) {
    process.stderr.write(`[swf-node] spawn threw: ${e.message}\n`);
    handleUnexpectedExit(/*code*/ null, /*signal*/ null, /*spawnError*/ e);
    return;
  }

  _proc = child;

  // The PyInstaller-built single-file binary takes ~200ms to extract;
  // we use a grace timer rather than waiting for a specific log line
  // so the supervisor doesn't gate on log format. If we hit "running"
  // and the child stays alive past the timer, reset restart counter.
  const runningTimer = setTimeout(() => {
    if (_proc === child && _state === "starting") {
      setState("running");
      // Reset the restart counter on a "successful" boot. A child that
      // dies after the grace window still counts toward the next 3.
      _restartCount = 0;
    }
  }, 300);

  child.stdout.on("data", (buf) => {
    if (_state === "starting") {
      clearTimeout(runningTimer);
      setState("running");
      _restartCount = 0;
    }
    appendLog("stdout", buf.toString("utf8"));
  });
  child.stderr.on("data", (buf) => {
    if (_state === "starting") {
      clearTimeout(runningTimer);
      setState("running");
      _restartCount = 0;
    }
    appendLog("stderr", buf.toString("utf8"));
  });

  child.on("error", (err) => {
    process.stderr.write(`[swf-node] child error: ${err.message}\n`);
    appendLog("error", `${err.stack || err.message}\n`);
  });

  child.on("exit", (code, signal) => {
    clearTimeout(runningTimer);
    appendLog("exit", `code=${code} signal=${signal}\n`);
    process.stderr.write(`[swf-node] exited code=${code} signal=${signal}\n`);
    if (_proc === child) _proc = null;
    if (_expectQuit) {
      // We asked for this; resolve any pending stop() promise.
      setState("idle");
      if (_quitResolve) { const r = _quitResolve; _quitResolve = null; r(); }
      return;
    }
    handleUnexpectedExit(code, signal, null);
  });
}

function handleUnexpectedExit(code, signal, spawnError) {
  _restartCount += 1;
  if (_restartCount >= RESTART_LIMIT) {
    process.stderr.write(`[swf-node] giving up after ${_restartCount} unexpected exits (last: code=${code} signal=${signal})\n`);
    setState("crashed");
    closeLogStream();
    return;
  }
  process.stderr.write(`[swf-node] unexpected exit (${_restartCount}/${RESTART_LIMIT}) — restarting in ${RESTART_BACKOFF_MS}ms\n`);
  setTimeout(() => {
    if (_expectQuit) return;
    spawnChild();
  }, RESTART_BACKOFF_MS);
}

/**
 * Start the supervised swf-node binary.
 *
 * @param {Electron.App} app
 * @param {(state: string) => void} broadcaster - called whenever state changes
 */
function start(app, broadcaster) {
  if (_state !== "idle") {
    process.stderr.write(`[swf-node] start() called in state=${_state} — ignoring\n`);
    return;
  }
  _broadcaster = broadcaster || null;

  if (process.env.SWF_NODE_DISABLE === "1") {
    process.stderr.write("[swf-node] SWF_NODE_DISABLE=1 — skipping spawn\n");
    setState("unsupported");
    return;
  }

  const resolved = resolveBinary(app);
  if (!resolved.ok) {
    if (resolved.reason === "win32") {
      process.stderr.write("[swf-node] win32 — swf-node bundle is unsupported on this platform; renderer will see http://127.0.0.1:7777 as down\n");
      setState("unsupported");
      return;
    }
    if (resolved.reason === "dev_no_env") {
      process.stderr.write("[swf-node] dev mode and SWF_NODE_BIN unset — assuming an external swf-node is running on :7777\n");
      setState("unsupported");
      return;
    }
    if (resolved.reason === "missing") {
      process.stderr.write(`[swf-node] binary missing at ${resolved.path} — skipping spawn\n`);
      setState("unsupported");
      return;
    }
  }

  _binaryPath = resolved.path;
  _dataDir = path.join(app.getPath("userData"), "swf-node-data");
  _logPath = path.join(app.getPath("userData"), "swf-node.log");

  try { fs.mkdirSync(_dataDir, { recursive: true }); } catch {}
  openLogStream();

  _restartCount = 0;
  spawnChild();
}

/**
 * Stop the supervised binary. Resolves when the child has exited,
 * or after SIGTERM_GRACE_MS + a SIGKILL fallback. Safe to call when
 * not running.
 */
function stop() {
  return new Promise((resolve) => {
    _expectQuit = true;
    const child = _proc;
    if (!child) {
      if (_state !== "crashed" && _state !== "unsupported") setState("idle");
      closeLogStream();
      return resolve();
    }
    _quitResolve = () => { closeLogStream(); resolve(); };

    try { child.kill("SIGTERM"); } catch (e) {
      process.stderr.write(`[swf-node] SIGTERM failed: ${e.message}\n`);
    }

    setTimeout(() => {
      if (_proc === child) {
        process.stderr.write("[swf-node] SIGTERM grace window expired — SIGKILL\n");
        try { child.kill("SIGKILL"); } catch {}
      }
    }, SIGTERM_GRACE_MS);
  });
}

function getStatus() {
  return _state;
}

module.exports = { start, stop, getStatus };
