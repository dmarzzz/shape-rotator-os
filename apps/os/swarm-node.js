// swarm-node.js
//
// Supervises the `research-agent` Python subprocess (dmarzzz/research-swarm).
// Mirrors swf-node.js's pattern: spawn() on demand, stream stdout/stderr
// as IPC events into the renderer, allow cancellation.
//
// Unlike swf-node (long-running daemon), research-agent is invoke-and-stream:
// one process per query. The renderer kicks one off with fg:swarm:start
// {query, model, ...}, gets a stream of fg:swarm:output events back, and
// the process exits with fg:swarm:done when the agent finishes (or errors,
// or is cancelled).
//
// Config is passed via env vars (LM_MODEL, LM_API_KEY, LM_API_BASE) — same
// shape the research-agent CLI already understands. We pull the Anthropic
// key from safeStorage at spawn time so it never lives in plain config.

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// Resolve the research-agent binary. In dev mode we point at the user's
// local research-swarm clone; production would need to bundle a Python
// venv (deferred — see TODO at bottom of file).
function resolveAgentBinary() {
  const override = process.env.RESEARCH_AGENT_BIN;
  if (override && fs.existsSync(override)) return override;
  const candidates = [
    `${os.homedir()}/research-swarm/.venv/bin/research-agent`,
    `${os.homedir()}/shape-rotator-field-kit/research-swarm/.venv/bin/research-agent`,
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let _current = null;        // { child, requestId }
const _statusListeners = new Set();
const _outputListeners = new Set();

function emitStatus(status) {
  for (const cb of _statusListeners) {
    try { cb(status); } catch {}
  }
}
function emitOutput(line) {
  for (const cb of _outputListeners) {
    try { cb(line); } catch {}
  }
}

function onStatus(cb) { _statusListeners.add(cb); return () => _statusListeners.delete(cb); }
function onOutput(cb) { _outputListeners.add(cb); return () => _outputListeners.delete(cb); }

function isRunning() {
  return _current != null && _current.child && !_current.child.killed && _current.child.exitCode === null;
}

function start({ requestId, query, lmModel, lmApiKey, lmApiBase, parallel, workers }) {
  if (isRunning()) {
    return { ok: false, reason: "swarm_already_running" };
  }
  const bin = resolveAgentBinary();
  if (!bin) {
    return { ok: false, reason: "research_agent_not_found",
             detail: "Set RESEARCH_AGENT_BIN env var or install research-swarm at ~/research-swarm" };
  }
  if (!query || !String(query).trim()) {
    return { ok: false, reason: "empty_query" };
  }

  // Build env. Pass-through HOME/PATH; everything else clean. The agent
  // reads .env from its CWD too, so we set CWD to the agent's repo root
  // when possible — it picks up SearXNG URL, GitHub tokens, etc. from
  // there if the user has configured them.
  const agentRepo = path.dirname(path.dirname(path.dirname(bin)));  // .../research-swarm
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: process.env.LANG || "en_US.UTF-8",
    PYTHONUNBUFFERED: "1",  // critical: line-by-line streaming, not buffered
    ...(lmModel ? { LM_MODEL: lmModel } : {}),
    ...(lmApiKey ? { LM_API_KEY: lmApiKey } : {}),
    ...(lmApiBase ? { LM_API_BASE: lmApiBase } : {}),
  };
  // back-compat: if user picked anthropic and we have a key, also set
  // ANTHROPIC_API_KEY since the CLI's .env shorthand uses it.
  if (lmApiKey && (lmModel || "").startsWith("anthropic/")) {
    env.ANTHROPIC_API_KEY = lmApiKey;
  }

  const args = [];
  if (parallel) args.push("--parallel");
  if (typeof workers === "number" && workers > 0) args.push("--workers", String(workers));
  args.push(String(query));

  process.stderr.write(`[swarm] spawning ${bin} ${args.join(" ")} (model=${lmModel || "default"})\n`);

  let child;
  try {
    child = spawn(bin, args, {
      cwd: agentRepo,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
  } catch (e) {
    return { ok: false, reason: "spawn_failed", detail: e.message };
  }

  _current = { child, requestId, startedAt: Date.now() };
  emitStatus({ state: "running", requestId, startedAt: _current.startedAt });

  const flushLine = (stream) => (buf) => {
    const s = buf.toString("utf8");
    for (const line of s.split(/\r?\n/)) {
      if (line.length === 0) continue;
      emitOutput({ requestId, stream, line });
    }
  };
  child.stdout.on("data", flushLine("stdout"));
  child.stderr.on("data", flushLine("stderr"));

  child.on("error", (err) => {
    process.stderr.write(`[swarm] child error: ${err.message}\n`);
    emitOutput({ requestId, stream: "stderr", line: `[swarm] child error: ${err.message}` });
  });
  child.on("exit", (code, signal) => {
    process.stderr.write(`[swarm] exited code=${code} signal=${signal}\n`);
    const wasOurs = _current && _current.child === child;
    const startedAt = wasOurs ? _current.startedAt : Date.now();
    if (wasOurs) _current = null;
    emitStatus({
      state: "idle",
      requestId,
      exitCode: code,
      signal,
      durationMs: Date.now() - startedAt,
    });
  });
  return { ok: true, requestId };
}

function stop() {
  if (!isRunning()) return { ok: false, reason: "not_running" };
  try { _current.child.kill("SIGTERM"); }
  catch (e) { return { ok: false, reason: "kill_failed", detail: e.message }; }
  // give it 2s then SIGKILL if still alive
  const child = _current.child;
  setTimeout(() => {
    if (child && !child.killed && child.exitCode === null) {
      try { child.kill("SIGKILL"); } catch {}
    }
  }, 2000);
  return { ok: true };
}

function getStatus() {
  if (!isRunning()) return { state: "idle" };
  return {
    state: "running",
    requestId: _current.requestId,
    startedAt: _current.startedAt,
    durationMs: Date.now() - _current.startedAt,
  };
}

function getAgentInfo() {
  const bin = resolveAgentBinary();
  return {
    binFound: bin != null,
    binPath: bin,
    // TODO (v0.2.14): bundle a Python venv + research-agent so non-dev
    // installs can run swarm mode out of the box. For now production
    // builds will show "swarm not installed" in the panel until the
    // user clones research-swarm locally.
  };
}

module.exports = { start, stop, getStatus, getAgentInfo, onStatus, onOutput };
