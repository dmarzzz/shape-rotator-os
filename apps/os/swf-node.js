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
//   - swf-node configures everything via env vars (CLI flags exist as
//     aliases — see _serve() in src/swf/peer_server.py — but we pass
//     env vars for clarity):
//       SWF_BIND, SWF_PORT, SWF_NO_MDNS, SWF_FULL,
//       SWF_CONFIG_DIR, SWF_KNOWLEDGE_DIR, SWF_STATE_DIR
//   - We launch with SWF_FULL=1 so the renderer's /graph, /events,
//     /metrics/* + /admin/* routes are live (main.js's env:get handler
//     already points at http://127.0.0.1:7777 for this aggregator
//     surface).
//   - We bind on 0.0.0.0 (all interfaces) so LAN cohort peers can
//     reach this node inbound. mDNS is left ON (default) so each
//     node advertises itself and discovers peers via Bonjour/Avahi.
//     This is the whole point of bundling swf-node: cohort LAN peer
//     discovery. A loopback-only mode would defeat that.
//   - All three data-dirs are pinned under app.getPath("userData")/
//     swf-node-data/ so an uninstall wipes them with the rest of
//     userData and so we don't collide with a user's own ~/.config/swf
//     install on the same machine.

const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

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
let _agentToken = null;        // generated once per launch, persisted to disk under _dataDir/agent_token
let _agentTokenPath = null;
let _cohortKeysPath = null;    // userData/swf-node-data/cohort-keys.json (after bootstrap)

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

// Resolve (or generate-and-persist) the agent bearer token used by the
// renderer to call swf-node's agent-gated routes (POST /sync/local_record
// today; potentially /web_search and friends later). Since we bind on
// 0.0.0.0 (LAN-reachable), swf-node requires SWF_AGENT_TOKEN to be set
// — without one it refuses to start. We generate a strong random token
// on first launch + persist it under the swf-node data dir so:
//   - swf-node and the Electron renderer agree on the same value across
//     restarts of either side.
//   - a `cat ~/.../swf-node-data/agent_token` lets a human invoke the
//     local routes from a terminal if they need to.
// Phase 2 A's spec (§7.4 / §9.5) doesn't pin a canonical token-file
// location; we put it next to the other swf-node data so swf-node
// could in theory read it directly at SWF_STATE_DIR/../agent_token if
// it ever wanted to discover it without an env var.
// Bootstrap cohort-keys.json under userData/swf-node-data/ on first
// launch. swf-node uses the file to authorize per-handle writes (spec
// §8.2) — without it, /sync/local_record returns 503 no_cohort_keys.
// We ship an initial empty file at build-resources/cohort-keys.json,
// copy it into userData on first launch, and pin SWF_COHORT_KEYS_FILE
// at that path. With SWF_TRUST_LAN_PEERS=1 set, the file can stay empty
// and sync still works LAN-wide; the file exists primarily so the
// `_candidate_paths()` chain in swf-node finds a parseable JSON shape
// (vs. the empty/missing path that triggers `no_cohort_keys`).
//
// If the bundled seed file is missing (dev mode), we still write a
// minimal `{"version":1,"members":[]}` so the daemon starts cleanly.
function ensureCohortKeys(app) {
  _cohortKeysPath = path.join(_dataDir, "cohort-keys.json");
  if (fs.existsSync(_cohortKeysPath)) return;

  let seed = null;
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "cohort-keys.json");
    try { seed = fs.readFileSync(bundled, "utf8"); }
    catch { /* bundled seed missing — fall through to default */ }
  }
  if (!seed) {
    seed = JSON.stringify({ version: 1, members: [] }, null, 2) + "\n";
  }
  try {
    fs.mkdirSync(path.dirname(_cohortKeysPath), { recursive: true });
    fs.writeFileSync(_cohortKeysPath, seed, { mode: 0o644 });
    process.stderr.write(`[swf-node] seeded cohort-keys at ${_cohortKeysPath}\n`);
  } catch (e) {
    process.stderr.write(`[swf-node] couldn't seed cohort-keys: ${e.message}\n`);
  }
}

function resolveAgentToken() {
  if (_agentToken) return _agentToken;
  // Honor an explicit env override (developer running their own daemon
  // with a known token).
  if (process.env.SWF_AGENT_TOKEN && process.env.SWF_AGENT_TOKEN.length >= 16) {
    _agentToken = process.env.SWF_AGENT_TOKEN;
    return _agentToken;
  }
  _agentTokenPath = path.join(_dataDir, "agent_token");
  try {
    const onDisk = fs.readFileSync(_agentTokenPath, "utf8").trim();
    if (onDisk && onDisk.length >= 16) {
      _agentToken = onDisk;
      return _agentToken;
    }
  } catch {
    // missing or unreadable — fall through to generation
  }
  // 32 random bytes → ~43 char base64url string. Plenty of entropy for
  // a loopback bearer that an attacker would have to read off the disk
  // to use.
  _agentToken = crypto.randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(path.dirname(_agentTokenPath), { recursive: true });
    fs.writeFileSync(_agentTokenPath, _agentToken + "\n", { mode: 0o600 });
  } catch (e) {
    process.stderr.write(`[swf-node] failed to persist agent token to ${_agentTokenPath}: ${e.message}\n`);
  }
  return _agentToken;
}

function spawnChild() {
  setState("starting");
  _expectQuit = false;

  const env = {
    ...process.env,
    // Bind on all interfaces so cohort LAN peers can reach this node
    // inbound. The renderer still hits http://127.0.0.1:<PORT> for
    // local aggregator surface; binding to 0.0.0.0 keeps that working
    // *and* makes the daemon reachable from the LAN.
    SWF_BIND: "0.0.0.0",
    SWF_PORT: String(PORT),
    SWF_FULL: "1",                            // aggregator mode → /graph, /events, /metrics/*
    // Leave mDNS ON (default). swf-node auto-enables advertising on
    // non-loopback binds; we don't pass SWF_NO_MDNS at all so the
    // cohort discovery path is live out of the box.
    SWF_CONFIG_DIR: path.join(_dataDir, "config"),
    SWF_KNOWLEDGE_DIR: path.join(_dataDir, "world_knowledge"),
    SWF_STATE_DIR: path.join(_dataDir, "state"),
    // Pin the cohort-keys file location to userData/swf-node-data/
    // (bootstrapped from the bundled empty seed by ensureCohortKeys).
    SWF_COHORT_KEYS_FILE: _cohortKeysPath,
    // LAN-trust mode (swf-node v0.11.0+): the cohort lives on a single
    // WiFi LAN today, so any signed envelope from any mDNS-discovered
    // peer is acceptable. This bypasses cohort-keys gating + single-
    // writer-pinning so a fresh install on a second laptop can sync
    // with the first laptop without manual key exchange. See
    // searxng-wth-frnds docs/SYNC.md §11.
    SWF_TRUST_LAN_PEERS: "1",
    // Non-loopback bind ⇒ swf-node demands a bearer token for agent
    // routes (incl. POST /sync/local_record per spec §7.4). Generate
    // once + persist; renderer reads via fg:swf-agent-token IPC.
    SWF_AGENT_TOKEN: resolveAgentToken(),
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
  ensureCohortKeys(app);
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

// Renderer-facing accessor for the agent bearer (via IPC `fg:swf-agent-token`).
// Returns null when swf-node hasn't been started yet (e.g. dev mode with an
// external daemon and SWF_AGENT_TOKEN unset) — sync-client.js treats that
// the same as "swf-node unavailable" and falls back to the github PR path.
function getAgentToken() {
  return _agentToken;
}

module.exports = { start, stop, getStatus, getAgentToken };
