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

const { spawnSync } = require("node:child_process");
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

// Run a gh subcommand (short, bounded). `runner` is injectable for tests.
function runGh(args, runner) {
  if (typeof runner === "function") return runner("gh", args);
  const r = spawnSync("gh", args, { encoding: "utf8", windowsHide: true, shell: WIN, timeout: 15000 });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

// { installed, authed } — so the renderer only PREFERS the private path when it'll
// actually work, and otherwise falls back to the public fetch.
function ghStatus({ runner } = {}) {
  const v = runGh(["--version"], runner);
  if (v.error || v.status !== 0) return { installed: false, authed: false };
  const a = runGh(["auth", "status"], runner);
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
// Returns { ok, events, login } | { ok:false, reason }.
function scanPrivateGithub({ maxEvents = 100, runner } = {}) {
  const status = ghStatus({ runner });
  if (!status.installed) return { ok: false, reason: "gh_not_installed" };
  if (!status.authed) return { ok: false, reason: "gh_not_authed" };
  const who = runGh(["api", "user", "--jq", ".login"], runner);
  const login = (who.error || who.status !== 0) ? "" : String(who.stdout || "").trim();
  if (!login) return { ok: false, reason: "gh_no_login" };
  const per = Math.min(100, Math.max(1, Number(maxEvents) || 100));
  const r = runGh(["api", `users/${encodeURIComponent(login)}/events?per_page=${per}`, "-H", "Accept: application/vnd.github+json"], runner);
  if (r.error || r.status !== 0) return { ok: false, reason: "gh_api_failed", detail: String(r.stderr || "").slice(0, 300) };
  return { ok: true, login, events: parseGhEvents(r.stdout) };
}

module.exports = { scanPrivateGithub, ghStatus, parseGhEvents };
