// tina-agent.js — the "brain" backend: run a prompt through the user's OWN
// local agent CLI (codex or claude), auto-detected. Mirrors swarm-node.js:
// spawn a subprocess, stream stdout back, allow cancellation.
//
// ── PRIVACY CONTRACT (retrieval-only) ────────────────────────────────────────
// This module reads NOTHING from and writes NOTHING to Supabase, GitHub, or any
// network endpoint of ours. It only:
//   1. receives a fully-assembled prompt (the renderer grounds it in local,
//      cohort-public data — see src/hermes/app.js buildPrompt),
//   2. pipes it to a CLI the user already runs on their OWN subscription, and
//   3. returns the CLI's stdout.
// No API key is stored here. The conversation is not persisted. The grounding
// data the renderer feeds in is the same cohort-public surface the app already
// ships. That is the whole "nothing is sent back to Supabase, only retrieval"
// guarantee, enforced by construction (there is no Supabase/network client in
// this file).
//
// Two backends, both riding the user's existing subscription (no key to paste):
//   codex  — `codex exec` (OpenAI Codex CLI, ChatGPT Plus/Pro)
//   claude — `claude -p`  (Claude Code CLI, Claude subscription)
// Ollama is a third backend, but it runs over loopback HTTP, so the hermes
// renderer talks to it directly — local-model inference never comes through here.
//
// The prompt is always fed via STDIN, never the command line, so there is no
// shell-injection surface even though we spawn with shell:true (needed on
// Windows to resolve the npm-global `.cmd` shims). The commands below are fixed
// constant STRINGS — nothing user-supplied is ever concatenated into them.

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Latest/most-capable Claude model (see CLAUDE.md: default to the latest). The
// codex backend uses whatever model the user's Codex config selects.
const CLAUDE_MODEL = "claude-opus-4-8";

// Double-quote a path for the shell. Only ever called with our own os.tmpdir()
// file paths (alphanumeric names) — never user input — so this is for spaces in
// the temp dir, not an injection defense.
function shArg(p) { return `"${String(p).replace(/"/g, '\\"')}"`; }

// Per-backend command + how to read the answer. The prompt always arrives via
// stdin (no injection surface); only constants/our-own-temp-paths are ever
// concatenated into these strings.
//   claude → `-p` prints the answer as clean text on stdout (we stream it).
//   codex  → a full coding agent: stdout is session logs + errors, so we make it
//            write ONLY its final message to a temp file (`-o`) and read that;
//            read-only sandbox + no color codes keep it non-interactive + clean.
const BACKENDS = {
  codex: {
    label: "Codex",
    versionCmd: "codex --version",
    output: "file",
    buildRun: (answerFile) =>
      `codex exec --sandbox read-only --color never --skip-git-repo-check -o ${shArg(answerFile)} -`,
  },
  claude: {
    label: "Claude",
    versionCmd: "claude --version",
    output: "stdout",
    buildRun: () => `claude -p --model ${CLAUDE_MODEL} --output-format text`,
  },
};

// A run can't outlive this — a misconfigured/unauthed CLI must fail, not hang.
// Generous because codex (gpt-class + reasoning) can legitimately take a while.
const DEFAULT_TIMEOUT_MS = 180000;

// ── data-sensitivity policy gate (lifted from NTFO's chat_runtime.py) ────────
// codex and claude are REMOTE: they ship the prompt to a hosted model, even on
// the user's own subscription — still off-device. So only PUBLIC grounding may
// reach them. Anything private/transcript-derived must stay on a LOCAL model
// (Ollama, which the renderer drives directly). This makes "nothing private
// leaves the device" structural, not a promise.
const DATA_MODES = ["public", "private_distilled", "raw_local"];
const BACKEND_LOCALITY = { codex: "remote", claude: "remote" }; // ollama = local (renderer-direct)

// Returns { ok:true } when `backend` may receive `dataMode` grounding, else
// { ok:false, error }. Unknown modes are treated as the safest (non-public).
function assertBackendAllowed(dataMode, backend) {
  const mode = DATA_MODES.includes(dataMode) ? dataMode : "raw_local";
  const locality = BACKEND_LOCALITY[backend] || "remote";
  if (mode !== "public" && locality === "remote") {
    return {
      ok: false,
      error: `policy: ${mode} data must not be sent to the remote ${backend} backend — use a local model (Ollama)`,
    };
  }
  return { ok: true };
}

// ── cross-platform PATH + process control ────────────────────────────────────
// macOS: a packaged app launched from Finder/Dock inherits a STRIPPED PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — NOT the login-shell PATH where Homebrew,
// npm-global, nvm, and ~/.local/bin live. So `codex`/`claude` are invisible to a
// GUI launch even though they work in Terminal. We rebuild a usable PATH from
// (a) common install dirs and (b) the login shell's own $PATH. Windows GUI apps
// inherit the user PATH fine, so this is mostly a no-op there. Computed once.
// Common install dirs a GUI launch might miss, by platform.
function baseExtraDirs() {
  const home = os.homedir();
  if (process.platform === "darwin" || process.platform === "linux") {
    return [
      "/opt/homebrew/bin", "/usr/local/bin",
      `${home}/.local/bin`, `${home}/.npm-global/bin`,
      `${home}/.bun/bin`, `${home}/.deno/bin`, `${home}/.codex/bin`,
      "/usr/bin", "/bin",
    ];
  }
  if (process.platform === "win32") {
    const d = [];
    if (process.env.APPDATA) d.push(`${process.env.APPDATA}\\npm`);               // npm-global codex.cmd / claude.cmd
    if (process.env.LOCALAPPDATA) d.push(`${process.env.LOCALAPPDATA}\\Microsoft\\WindowsApps`);
    return d;
  }
  return [];
}

// Login-shell PATH (POSIX) — covers nvm / custom npm prefixes the static dirs
// miss. Resolved ASYNCHRONOUSLY (never blocks the main process) and cached; on
// completion it busts _pathCache so the next augmentedPath() folds it in. No-op
// on Windows, where GUI apps already inherit the user PATH.
let _loginPathDirs = [];
let _loginPathPromise = null;
function warmLoginPath() {
  if (_loginPathPromise) return _loginPathPromise;
  if (process.platform === "win32") { _loginPathPromise = Promise.resolve(); return _loginPathPromise; }
  _loginPathPromise = new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = () => { if (settled) return; settled = true; _pathCache = null; resolve(); };
    let child;
    try {
      child = spawn(process.env.SHELL || "/bin/zsh", ["-lic", 'printf %s "$PATH"'], { stdio: ["ignore", "pipe", "ignore"] });
    } catch { return finish(); }
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(); }, 2500);
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); finish(); });
    child.on("exit", () => { clearTimeout(timer); _loginPathDirs = out.trim().split(":").filter(Boolean); finish(); });
  });
  return _loginPathPromise;
}

let _pathCache = null;
function augmentedPath() {
  if (_pathCache) return _pathCache;
  const sep = process.platform === "win32" ? ";" : ":";
  const parts = [];
  const add = (p) => { if (p && !parts.includes(p)) parts.push(p); };
  for (const d of baseExtraDirs()) add(d);
  for (const d of _loginPathDirs) add(d);
  for (const d of String(process.env.PATH || "").split(sep)) add(d); // keep everything inherited
  _pathCache = parts.join(sep);
  return _pathCache;
}

// env for every spawn: inherit everything (HOME/USERPROFILE so ~/.codex and
// ~/.claude creds resolve) but with the repaired PATH.
function spawnEnv() {
  return { ...process.env, PATH: augmentedPath() };
}

// Kill the whole process tree. With shell:true, Windows `cmd /c` spawns the CLI
// as a CHILD of the shell, so killing the shell pid orphans the real process —
// `taskkill /T` takes the tree. On POSIX `sh -c <one cmd>` usually exec-replaces
// into the CLI, so a direct signal reaches it.
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === "win32") {
    try { spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  } else {
    try { child.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 2000);
  }
}

// Warm the login-shell PATH at module load so it's ready (cached) by the time
// the user opens the brain. Fire-and-forget; never blocks startup.
warmLoginPath();

let _current = null; // { child, requestId } — single-flight, like a chat turn

function isRunning() {
  return _current != null && _current.child && _current.child.exitCode === null && !_current.child.killed;
}

// Probe one CLI for availability + version. Resolves { available, version? };
// never throws. A short timeout keeps a hung binary from blocking detection.
function probe(cmd, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "ignore"], env: spawnEnv() });
    } catch {
      return done({ available: false });
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} done({ available: false }); }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); done({ available: false }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      done(code === 0
        ? { available: true, version: (out.trim().split(/\r?\n/)[0] || "").trim() }
        : { available: false });
    });
  });
}

// Detect every CLI backend in parallel. Returns
// { codex: {label, available, version?}, claude: {...} }.
async function detectBackends() {
  await warmLoginPath(); // ensure the repaired PATH is complete before probing (mac GUI launches)
  const entries = await Promise.all(
    Object.entries(BACKENDS).map(async ([key, cfg]) => {
      const r = await probe(cfg.versionCmd);
      return [key, { label: cfg.label, ...r }];
    }),
  );
  return Object.fromEntries(entries);
}

// Run a fully-assembled prompt through the chosen backend.
//   onData(chunk)  — streams partial stdout for live rendering (best-effort;
//                    text-mode claude may flush once at the end).
// Resolves { ok:true, text } or { ok:false, error, text? }. One run at a time.
let _idSeq = 0;
function tmpAnswerFile() {
  _idSeq += 1;
  return path.join(os.tmpdir(), `tina-answer-${process.pid}-${_idSeq}.txt`);
}

// Turn a noisy CLI failure (session logs, JSON error frames, stack traces) into
// one short human line. Prefers a JSON {"message": "..."} field, then the last
// error-ish line, then the last line.
function conciseError(text, fallback) {
  const lines = String(text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /"message"\s*:\s*"([^"]+)"/.exec(lines[i]);
    if (m) return m[1].slice(0, 220);
  }
  const errish = [...lines].reverse().find(l => /\b(error|fatal|unsupported|unauthor|not ?found|denied|invalid|missing|ENOENT)\b/i.test(l));
  return ((errish || lines[lines.length - 1] || fallback || "failed")).slice(0, 220);
}

async function runTina({ backend, prompt, dataMode = "public", requestId, onData, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = BACKENDS[backend];
  if (!cfg) return { ok: false, error: `unknown backend: ${backend}` };
  if (!prompt || !String(prompt).trim()) return { ok: false, error: "empty prompt" };
  // Privacy gate FIRST — never spawn (and never let a prompt out) for a
  // disallowed data-mode/backend pair.
  const gate = assertBackendAllowed(dataMode, backend);
  if (!gate.ok) return gate;
  if (isRunning()) return { ok: false, error: "a brain request is already running" };
  await warmLoginPath(); // ensure the repaired PATH is complete before spawning (cached after first run)

  const answerFile = cfg.output === "file" ? tmpAnswerFile() : null;
  const cmd = cfg.buildRun(answerFile);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, { shell: true, stdio: ["pipe", "pipe", "pipe"], env: spawnEnv() });
    } catch (e) {
      if (answerFile) { try { fs.unlinkSync(answerFile); } catch {} }
      return resolve({ ok: false, error: `spawn failed: ${e.message}` });
    }
    _current = { child, requestId };
    let out = "";
    let err = "";
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (answerFile) { try { fs.unlinkSync(answerFile); } catch {} }
      if (_current && _current.child === child) _current = null;
      resolve(res);
    };

    // Hard ceiling — a hung/unauthed CLI fails cleanly instead of blocking forever.
    const timer = setTimeout(() => {
      killTree(child);
      finish({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)}s — is ${backend} signed in and configured?` });
    }, timeoutMs);

    child.stdout.on("data", (b) => {
      const s = b.toString("utf8");
      out += s;
      // Stream only for stdout-answer backends; file-answer backends (codex) emit
      // agent logs on stdout that are NOT the answer — never show those.
      if (cfg.output === "stdout") { try { onData && onData(s); } catch {} }
    });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });
    child.on("error", (e) => finish({ ok: false, error: e.message }));
    child.on("exit", (code, signal) => {
      let answer = "";
      if (cfg.output === "file") { try { answer = fs.readFileSync(answerFile, "utf8").trim(); } catch {} }
      else { answer = out.trim(); }
      if (signal) return finish({ ok: false, error: "stopped", text: answer });
      if (code === 0 && answer) return finish({ ok: true, text: answer });
      // Non-zero exit, or zero-but-empty (e.g. codex errored before writing): give
      // a short, actionable reason pulled from stderr/stdout.
      finish({ ok: false, error: conciseError(err || out, `${backend} exited with code ${code}`), text: answer });
    });

    // Feed the prompt via stdin (no shell-injection surface) and close it.
    try {
      child.stdin.write(String(prompt));
      child.stdin.end();
    } catch (e) {
      killTree(child);
      finish({ ok: false, error: `stdin write failed: ${e.message}` });
    }
  });
}

// Cancel the in-flight run (the chat "stop" button). SIGTERM, then SIGKILL.
function stop() {
  if (!isRunning()) return { ok: false, reason: "not_running" };
  try { killTree(_current.child); } catch (e) { return { ok: false, reason: "kill_failed", detail: e.message }; }
  return { ok: true };
}

module.exports = { detectBackends, runTina, stop, isRunning, assertBackendAllowed, DATA_MODES, BACKENDS, CLAUDE_MODEL };
