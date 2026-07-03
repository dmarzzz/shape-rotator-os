// gh-node.js
//
// Reads the member's OWN GitHub activity via their existing `gh` CLI login — the
// connection that's ALREADY on their machine. The app stores no token: it borrows
// the member's authenticated `gh` session at call time, exactly as the chat borrows
// their `claude`/`codex` login. Authenticated as themselves, `users/{login}/events`
// includes PRIVATE repos, so the member's private work becomes legible.
//
// This module returns the RAW events to the renderer, which scrubs them with the
// SAME pure summarizer as the public path (gh-self-report.mjs summarizeEvents) — so
// only a digest (commit-message lines + counts, never diffs/file contents/secrets)
// ever reaches a model, and the renderer scopes it to the focused project's repos
// before anything is shown or sent. Raw events never leave the box (in-process IPC).

const { spawn } = require("node:child_process");
const os = require("node:os");
const path = require("node:path");

// gh installs to dirs the packaged-Electron PATH often omits — augment once.
(function ensureGhOnPath() {
  const home = os.homedir();
  const extra = [];
  if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) extra.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"));
    if (process.env.ProgramFiles) extra.push(path.join(process.env.ProgramFiles, "GitHub CLI"));
  } else {
    extra.push("/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin"));
  }
  const parts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  let changed = false;
  for (const p of extra) { if (p && !parts.includes(p)) { parts.push(p); changed = true; } }
  if (changed) process.env.PATH = parts.join(path.delimiter);
})();

const WIN = process.platform === "win32";
const GH_TIMEOUT_MS = 15000;

// Run a gh subcommand (short, bounded) WITHOUT blocking the event loop — this
// runs in the Electron MAIN process, where the old spawnSync froze the whole
// app for up to 15s per call whenever `gh api` was slow. Resolves (never
// rejects) with the same { status, stdout, stderr, error } shape spawnSync
// produced. `runner` is injectable for tests (sync or async).
function runGh(args, runner) {
  if (typeof runner === "function") return Promise.resolve(runner("gh", args));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("gh", args, { windowsHide: true, shell: WIN });
    } catch (error) {
      resolve({ status: null, stdout: "", stderr: "", error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      settle({ status: null, stdout, stderr, error: new Error(`gh timed out after ${GH_TIMEOUT_MS}ms`) });
    }, GH_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => settle({ status: null, stdout, stderr, error }));
    child.on("close", (status) => settle({ status, stdout, stderr }));
  });
}

// { installed, authed } — so the renderer only PREFERS the private path when it'll
// actually work, and otherwise falls back to the public fetch.
async function ghStatus({ runner } = {}) {
  const v = await runGh(["--version"], runner);
  if (v.error || v.status !== 0) return { installed: false, authed: false };
  const a = await runGh(["auth", "status"], runner);
  return { installed: true, authed: !a.error && a.status === 0 };
}

// Pure: gh api stdout (a JSON array) → events[]. Tolerates empty/non-JSON.
function parseGhEvents(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return [];
  try { const j = JSON.parse(s); return Array.isArray(j) ? j : []; }
  catch { return []; }
}

// Fetch the member's authenticated events (PUBLIC + PRIVATE, as themselves).
// Resolves { ok, events, login } | { ok:false, reason }. Async end-to-end —
// the ipcMain.handle("fg:gh:scan-private") caller awaits promises natively.
async function scanPrivateGithub({ maxEvents = 100, runner } = {}) {
  const status = await ghStatus({ runner });
  if (!status.installed) return { ok: false, reason: "gh_not_installed" };
  if (!status.authed) return { ok: false, reason: "gh_not_authed" };
  const who = await runGh(["api", "user", "--jq", ".login"], runner);
  const login = (who.error || who.status !== 0) ? "" : String(who.stdout || "").trim();
  if (!login) return { ok: false, reason: "gh_no_login" };
  const per = Math.min(100, Math.max(1, Number(maxEvents) || 100));
  const r = await runGh(["api", `users/${encodeURIComponent(login)}/events?per_page=${per}`, "-H", "Accept: application/vnd.github+json"], runner);
  if (r.error || r.status !== 0) return { ok: false, reason: "gh_api_failed", detail: String(r.stderr || "").slice(0, 300) };
  return { ok: true, login, events: parseGhEvents(r.stdout) };
}

module.exports = { scanPrivateGithub, ghStatus, parseGhEvents };
