// cohort-chat-node.js
//
// Supervises the operator's OWN local AI CLI (Claude Code / Codex) as
// a one-shot subprocess for the in-app "chat with the cohort" panel. Mirrors
// swarm-node.js's spawn-and-stream shape, with two differences:
//   * it runs whatever local agent the member ALREADY has installed and
//     authenticated — NO API key, nothing leaves the box except whatever that
//     agent itself does. The renderer's CSP can't reach api.anthropic.com, so
//     routing through a local CLI is also how a cloud model would be reached.
//   * the full grounded prompt (cohort context + history + question) is built in
//     the renderer and PIPED to the CLI's stdin; tokens stream back on stdout.
//
// CLI resolution (first match wins):
//   1. an explicit configured command (chatCmd) — e.g. `claude -p`, `codex exec`.
//   2. the COHORT_CHAT_CMD / COHORT_LLM_CMD env override.
//   3. auto-detect on PATH: claude -> codex.
// The prompt always arrives on stdin, so the configured command should be the
// agent's NON-interactive / print form.

const { spawn, spawnSync } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

// Packaged Electron apps inherit a MINIMAL PATH that often omits where the
// member's `claude` / `codex` CLI actually lives, so `where claude` finds nothing
// even when it IS installed. Augment the process PATH once (idempotent) with the
// usual install dirs — mirrors the Router/daybook ensureClaudeOnPath(), and adds
// the WINDOWS spots Router's macOS-oriented list omits (npm-global → claude.cmd,
// the native installer's ~/.local/bin, winget shims). Done module-wide so both
// detectAvailable() and start() benefit.
(function ensureLocalAiOnPath() {
  const home = os.homedir();
  const extra = [
    path.join(home, ".local", "bin"),       // native installer (claude.ai/install)
    path.join(home, ".bun", "bin"),
    path.join(home, ".npm-global", "bin"),
  ];
  if (process.platform === "win32") {
    if (process.env.APPDATA) extra.push(path.join(process.env.APPDATA, "npm"));            // npm i -g → claude.cmd
    if (process.env.LOCALAPPDATA) extra.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
  } else {
    extra.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  const parts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  let changed = false;
  for (const p of extra) { if (p && !parts.includes(p)) { parts.push(p); changed = true; } }
  if (changed) process.env.PATH = parts.join(path.delimiter);
})();

// Auto-detect order: the capable coding agents the cohort actually runs.
// ollama is intentionally NOT here — almost no member has it, and small local
// models ignore the action/JSON schema the agentic flow depends on (see
// docs/your-mirror-receive-and-chat.md). It's still recognized as a LOCAL backend
// by the privacy gate below if someone hand-configures `ollama run …` as their
// chat command, but the app never auto-picks or suggests it.
const DETECT = [
  // claude -p BUFFERS by default (one chunk at the end — a long dead wait); the
  // stream-json flags emit incremental text deltas so the answer types out live
  // (cohort-chat-stream.mjs parses them). --verbose is required for -p stream-json.
  { bin: "claude", args: () => ["-p", "--output-format", "stream-json", "--include-partial-messages", "--verbose"] },
  { bin: "codex", args: () => ["exec"] },
];

// ── data-sensitivity gate + credential hygiene (harvested from the Hermes
// "Ask Cohort" PR #417) ──────────────────────────────────────────────────────
// claude/codex are REMOTE: they ship the prompt to a hosted model, even on the
// member's own subscription — still off-device. So only PUBLIC grounding may
// reach them; anything private/transcript-derived must stay on a LOCAL model
// (ollama). The cohort chat grounds on the PUBLIC surface, so its dataMode is
// "public" today — this gate keeps that property structural if private
// grounding is ever added, rather than a promise.
const DATA_MODES = ["public", "private_distilled", "raw_local"];
const BACKEND_LOCALITY = { claude: "remote", codex: "remote", ollama: "local" };

// Map a resolved argv to a known backend by its binary basename; unknown custom
// commands are treated as remote (the safest assumption for the gate).
function backendForArgv(argv) {
  const bin = String((argv && argv[0]) || "")
    .replace(/\\/g, "/").split("/").pop()
    .toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, "");
  return BACKEND_LOCALITY[bin] ? bin : "custom";
}

// Returns { ok:true } when `backend` may receive `dataMode` grounding, else
// { ok:false, error }. Unknown modes are treated as the safest (non-public);
// unknown backends as remote.
function assertBackendAllowed(dataMode, backend) {
  const mode = DATA_MODES.includes(dataMode) ? dataMode : "raw_local";
  const locality = BACKEND_LOCALITY[backend] || "remote";
  if (mode !== "public" && locality === "remote") {
    return { ok: false, error: `policy: ${mode} grounding must not be sent to the remote ${backend} backend — use a local model (ollama)` };
  }
  return { ok: true };
}

// Provider credentials NEVER ride our process into the member's CLI: it must use
// THEIR interactive login / subscription, never a key inherited from us. Strip
// them from every spawn unless the member deliberately opts in.
const PROVIDER_CREDENTIAL_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY", "OPENAI_API_KEY_PATH",
];
// Claude Code refuses to launch nested inside another Claude Code session
// (it checks CLAUDECODE) — which happens when THIS app was itself started from
// within one, e.g. a dev `npm run os:dev` from a Claude Code terminal. The
// member's local `claude -p` is a one-shot, not a nested interactive session, so
// clear the session markers and let it run. Always stripped; real users launch
// the app outside Claude Code, so it's a no-op for them.
const NESTED_SESSION_ENV = ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"];
function spawnEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const k of NESTED_SESSION_ENV) delete env[k];
  if (process.env.COHORT_CHAT_USE_ENV_KEYS !== "1") {
    for (const k of PROVIDER_CREDENTIAL_ENV) delete env[k];
  }
  return env;
}

function onPath(bin) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(probe, [bin], { encoding: "utf8" });
    return r.status === 0 && String(r.stdout || "").trim().length > 0;
  } catch {
    return false;
  }
}

// Minimal shell-like splitter: respects single/double quotes, no expansion.
function splitCommand(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || ""))) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// The agents we can see on PATH right now (for the settings UI + readiness).
function detectAvailable() {
  return DETECT.filter((d) => onPath(d.bin)).map((d) => d.bin);
}

// Resolve the argv to run. `configuredCmd` is the saved chatCmd string.
function resolveCommand(configuredCmd) {
  const explicit = (configuredCmd && configuredCmd.trim())
    || (process.env.COHORT_CHAT_CMD && process.env.COHORT_CHAT_CMD.trim())
    || (process.env.COHORT_LLM_CMD && process.env.COHORT_LLM_CMD.trim());
  if (explicit) {
    const argv = splitCommand(explicit);
    if (argv.length) return argv;
  }
  for (const d of DETECT) if (onPath(d.bin)) return [d.bin, ...d.args()];
  return null;
}

let _current = null; // { child, requestId }
const _statusListeners = new Set();
const _outputListeners = new Set();

function emitStatus(s) { for (const cb of _statusListeners) { try { cb(s); } catch {} } }
function emitOutput(o) { for (const cb of _outputListeners) { try { cb(o); } catch {} } }
function onStatus(cb) { _statusListeners.add(cb); return () => _statusListeners.delete(cb); }
function onOutput(cb) { _outputListeners.add(cb); return () => _outputListeners.delete(cb); }

function isRunning() {
  return _current != null && _current.child && !_current.child.killed && _current.child.exitCode === null;
}

// Spawn the local CLI for one chat turn. `prompt` is the full grounded prompt
// (built in the renderer); it is written to the child's stdin. stdout streams
// back as fg:cohort-chat:output {requestId, stream, chunk}; completion as a
// status event.
function start({ requestId, prompt, chatCmd, dataMode = "public" }) {
  if (isRunning()) return { ok: false, reason: "chat_already_running" };
  if (!prompt || !String(prompt).trim()) return { ok: false, reason: "empty_prompt" };
  const argv = resolveCommand(chatCmd);
  if (!argv) {
    return {
      ok: false,
      reason: "no_local_ai_cli",
      detail: "No local AI CLI found. Install Claude Code (`claude`) or Codex (`codex`) and make sure it's on PATH — or set the command in chat settings.",
    };
  }

  // Privacy gate: never ship non-public grounding to a remote backend.
  const gate = assertBackendAllowed(dataMode, backendForArgv(argv));
  if (!gate.ok) return { ok: false, reason: "policy_blocked", detail: gate.error };

  // Provider keys stripped (their subscription, never ours); stay quiet/non-interactive.
  const env = spawnEnv({
    PYTHONUNBUFFERED: "1",
    // Ask agents that honour it to stay non-interactive / quiet.
    CI: process.env.CI || "1",
    NO_COLOR: "1",
  });

  // Windows: `claude` / `codex` are usually .cmd / .ps1 npm shims, NOT a bare .exe
  // on PATH, so a no-shell spawn ENOENTs. Run through the shell there so PATHEXT
  // resolves the shim — passing ONE command string (not a shell+args array, which
  // trips Node's DEP0190). The prompt arrives on stdin, so args carry no untrusted
  // data; only the static flags + the member's own configured command are joined.
  const onWin = process.platform === "win32";
  const winQuote = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
  let child;
  try {
    child = onWin
      ? spawn(argv.map(winQuote).join(" "), [], { env, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true })
      : spawn(argv[0], argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    return { ok: false, reason: "spawn_failed", detail: e.message };
  }

  _current = { child, requestId, startedAt: Date.now(), timer: null };
  emitStatus({ state: "running", requestId, startedAt: _current.startedAt, cmd: argv });

  // Watchdog: if the CLI emits no stdout for IDLE_TIMEOUT_MS it's effectively
  // hung (auth prompt swallowed, model still pulling, network stall) — SIGTERM it
  // so the panel never sits in "thinking…" forever. Reset on every stdout chunk;
  // a cold local model load (tens of seconds before the first token) is fine.
  const IDLE_TIMEOUT_MS = Number(process.env.COHORT_CHAT_IDLE_TIMEOUT_MS) || 90000;
  let timedOut = false;
  function armWatchdog() {
    if (!_current || _current.child !== child) return;
    clearTimeout(_current.timer);
    _current.timer = setTimeout(() => { timedOut = true; try { child.kill("SIGTERM"); } catch {} }, IDLE_TIMEOUT_MS);
  }
  armWatchdog();

  // Stream raw chunks (not line-buffered) so partial tokens render live.
  child.stdout.on("data", (buf) => { armWatchdog(); emitOutput({ requestId, stream: "stdout", chunk: buf.toString("utf8") }); });
  child.stderr.on("data", (buf) => emitOutput({ requestId, stream: "stderr", chunk: buf.toString("utf8") }));

  // Settle to idle exactly once — whether the child exits cleanly OR errors before
  // it ever starts. A spawn 'error' (e.g. ENOENT) fires WITHOUT a following 'exit',
  // so without this an errored spawn would leave the panel stuck in "thinking…".
  let settled = false;
  const startedAt = _current.startedAt;
  function settle(extra) {
    if (settled) return;
    settled = true;
    if (_current && _current.child === child) { clearTimeout(_current.timer); _current = null; }
    emitStatus({ state: "idle", requestId, durationMs: Date.now() - startedAt, ...extra });
  }
  child.on("error", (err) => {
    emitOutput({ requestId, stream: "stderr", chunk: `[cohort-chat] ${err.message}\n` });
    settle({ exitCode: null, error: err.message });
  });
  child.on("exit", (code, signal) => {
    settle({ exitCode: code, signal, reason: timedOut ? "timeout" : undefined });
  });

  // The child can close stdin before our write lands (it exited early, refused to
  // start, crashed, …). On a pipe that surfaces ASYNCHRONOUSLY as an 'error'
  // (EPIPE) on the stream — NOT a throw — so the try/catch below can't catch it,
  // and with no listener it becomes an uncaught exception that crashes the whole
  // main process. The child 'error'/'exit' handlers above already report the
  // failure to the user, so swallow the stream error here.
  child.stdin.on("error", () => {});
  try { child.stdin.write(String(prompt)); child.stdin.end(); } catch {}
  return { ok: true, requestId, cmd: argv };
}

function stop() {
  if (!isRunning()) return { ok: false, reason: "not_running" };
  const child = _current.child;
  try { child.kill("SIGTERM"); } catch (e) { return { ok: false, reason: "kill_failed", detail: e.message }; }
  setTimeout(() => {
    if (child && !child.killed && child.exitCode === null) { try { child.kill("SIGKILL"); } catch {} }
  }, 2000);
  return { ok: true };
}

function getStatus() {
  if (!isRunning()) return { state: "idle" };
  return { state: "running", requestId: _current.requestId, startedAt: _current.startedAt, durationMs: Date.now() - _current.startedAt };
}

// What the settings panel shows: which CLI WOULD run, and what's detected.
function getInfo(configuredCmd) {
  const resolved = resolveCommand(configuredCmd);
  return {
    resolved: resolved ? resolved.join(" ") : null,
    available: detectAvailable(),
    ready: !!resolved,
  };
}

module.exports = { start, stop, getStatus, getInfo, resolveCommand, splitCommand, detectAvailable, onStatus, onOutput, assertBackendAllowed, backendForArgv, spawnEnv, DATA_MODES };
