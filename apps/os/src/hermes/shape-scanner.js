// shape-scanner.js — build + self-update the OS user's "shape": what they work
// on, derived from their PUBLIC GitHub and their LOCAL Codex session history.
//
// ── PRIVACY TIERS (the brain's policy gate in engine.js consumes these) ───
//   github → PUBLIC  (public repos / profile / languages) — any backend.
//   codex  → PRIVATE_DISTILLED  (project names + session counts + timeline from
//            ~/.codex session METADATA only) — local model, or a remote backend
//            only with explicit opt-in.
// The Codex scan reads ONLY each rollout's first line (session_meta: cwd +
// timestamp). It NEVER reads message/prompt/code content. Raw work never enters
// the profile. Self-updating: each scan refreshes the persisted profile and
// appends a compact entry to its scan history (trajectory over time).
//
// Runs in the Electron MAIN process; pure Node (no electron import) so it stays
// unit-testable. The caller passes dataDir (app.getPath("userData")).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const SCHEMA = "shape_rotator_self_shape_v0.1";
const PROFILE_FILE = "shape-profile.json";

// ── gh env: same macOS GUI-PATH problem as the brain CLIs (a Finder/Dock launch
// can't see /opt/homebrew/bin etc.). We add the common dirs; gh almost always
// lives in one of them. (Lighter than engine.js's login-shell query — gh is
// rarely in an exotic prefix, and this stays synchronous + simple.)
function ghEnv() {
  const home = os.homedir();
  const sep = process.platform === "win32" ? ";" : ":";
  const extra = process.platform === "win32"
    ? [process.env.APPDATA ? `${process.env.APPDATA}\\npm` : "", "C:\\Program Files\\GitHub CLI"]
    : ["/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, "/usr/bin", "/bin"];
  const parts = [];
  for (const d of [...extra, ...String(process.env.PATH || "").split(sep)]) {
    if (d && !parts.includes(d)) parts.push(d);
  }
  return { ...process.env, PATH: parts.join(sep) };
}

// Run `gh <args>` and parse JSON stdout. Resolves null on any failure (gh
// missing, not authed, non-zero exit, bad JSON) — the caller falls back.
function ghJson(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try { child = spawn(`gh ${args}`, { shell: true, env: ghEnv(), stdio: ["ignore", "pipe", "ignore"] }); }
    catch { return resolve(null); }
    const t = setTimeout(() => { try { child.kill(); } catch {} resolve(null); }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("exit", (code) => { clearTimeout(t); if (code !== 0) return resolve(null); try { resolve(JSON.parse(out)); } catch { resolve(null); } });
  });
}

// A valid GitHub handle: 1-39 chars, alphanumerics or single hyphens, no
// leading hyphen. Anything else is rejected BEFORE it can be interpolated into
// a gh command — the one place non-constant text reaches a shell:true spawn.
const GH_HANDLE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
function validGithubHandle(s) { return typeof s === "string" && GH_HANDLE_RE.test(s); }

// ── GitHub (PUBLIC) ──────────────────────────────────────────────────────────
async function scanGithubShape({ user } = {}) {
  // Only honor a caller-supplied handle if it passes strict validation; an
  // invalid value is dropped so we fall back to the authed `gh api user`.
  let login = validGithubHandle(user) ? user : null;
  const me = await ghJson("api user"); // authed user (if gh is logged in)
  if (!login && me && me.login) login = me.login;

  // Fallback: anonymous public REST API when gh is unavailable but we know who.
  if (!me && login) {
    const pub = await fetchPublicGithub(login);
    if (pub) return pub;
  }
  if (!login) return { ok: false, reason: "no_github_user" };

  const profile = me && me.login === login ? me : (await ghJson(`api users/${login}`)) || {};
  // --visibility public is load-bearing: an authed `gh repo list` otherwise
  // includes PRIVATE repos, whose names must not reach a remote backend as
  // "public" grounding.
  const repos = (await ghJson(`repo list ${login} --source --visibility public --limit 40 --json name,primaryLanguage,description,pushedAt,stargazerCount`)) || [];
  return { ok: true, source: "gh", ...aggregateGithub(login, profile, repos) };
}

async function fetchPublicGithub(login) {
  try {
    const headers = { "user-agent": "shape-rotator-os", accept: "application/vnd.github+json" };
    const [pRes, rRes] = await Promise.all([
      fetch(`https://api.github.com/users/${login}`, { headers }),
      fetch(`https://api.github.com/users/${login}/repos?sort=pushed&per_page=40`, { headers }),
    ]);
    if (!pRes.ok) return null;
    const profile = await pRes.json();
    const reposRaw = rRes.ok ? await rRes.json() : [];
    const repos = (Array.isArray(reposRaw) ? reposRaw : []).map((r) => ({
      name: r.name,
      primaryLanguage: r.language ? { name: r.language } : null,
      description: r.description,
      pushedAt: r.pushed_at,
      stargazerCount: r.stargazers_count,
    }));
    return { ok: true, source: "public_api", ...aggregateGithub(login, profile, repos) };
  } catch { return null; }
}

function aggregateGithub(login, profile, repos) {
  const langs = {};
  for (const r of repos) { const l = r.primaryLanguage && r.primaryLanguage.name; if (l) langs[l] = (langs[l] || 0) + 1; }
  const recent = repos.slice()
    .sort((a, b) => String(b.pushedAt || "").localeCompare(String(a.pushedAt || "")))
    .slice(0, 12)
    .map((r) => ({ name: r.name, lang: (r.primaryLanguage && r.primaryLanguage.name) || null, pushed: String(r.pushedAt || "").slice(0, 10), desc: r.description || "", stars: r.stargazerCount || 0 }));
  return {
    login,
    name: profile.name || null,
    bio: profile.bio || null,
    company: profile.company || null,
    public_repos: profile.public_repos != null ? profile.public_repos : (Array.isArray(repos) ? repos.length : 0),
    languages: Object.entries(langs).sort((a, b) => b[1] - a[1]).map(([lang, count]) => ({ lang, repos: count })),
    recent_repos: recent,
  };
}

// ── Codex (PRIVATE_DISTILLED — session metadata only) ────────────────────────
function readFirstLine(file, maxBytes = 65536) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    const s = buf.slice(0, n).toString("utf8");
    const nl = s.indexOf("\n");
    return nl >= 0 ? s.slice(0, nl) : s;
  } finally { fs.closeSync(fd); }
}

function walkRollouts(dir, out, cap) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= cap) return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkRollouts(p, out, cap);
    else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
  }
}

function scanCodexShape({ home = os.homedir(), cap = 4000 } = {}) {
  const root = path.join(home, ".codex");
  if (!fs.existsSync(root)) return { ok: false, reason: "no_codex_dir" };
  const files = [];
  for (const sub of ["archived_sessions", "sessions"]) walkRollouts(path.join(root, sub), files, cap);
  if (!files.length) return { ok: true, total_sessions: 0, project_count: 0, top_projects: [], date_range: { first: null, last: null }, activity_by_month: {} };

  const byProject = {};
  const byMonth = {};
  let total = 0, first = null, last = null;
  for (const f of files) {
    let meta;
    try { meta = JSON.parse(readFirstLine(f)); } catch { continue; }
    if (!meta || meta.type !== "session_meta") continue;
    const p = meta.payload || {};
    const project = p.cwd ? path.basename(String(p.cwd)) : "(unknown)";
    const ts = p.timestamp || meta.timestamp || null;
    total += 1;
    const rec = byProject[project] || (byProject[project] = { project, sessions: 0, first: null, last: null });
    rec.sessions += 1;
    if (ts) {
      if (!rec.first || ts < rec.first) rec.first = ts;
      if (!rec.last || ts > rec.last) rec.last = ts;
      if (!first || ts < first) first = ts;
      if (!last || ts > last) last = ts;
      const month = String(ts).slice(0, 7); // YYYY-MM
      byMonth[month] = (byMonth[month] || 0) + 1;
    }
  }
  const projects = Object.values(byProject).sort((a, b) => b.sessions - a.sessions);
  return {
    ok: true,
    total_sessions: total,
    project_count: projects.length,
    date_range: { first: first ? first.slice(0, 10) : null, last: last ? last.slice(0, 10) : null },
    top_projects: projects.slice(0, 15).map((r) => ({ project: r.project, sessions: r.sessions, first: (r.first || "").slice(0, 10), last: (r.last || "").slice(0, 10) })),
    activity_by_month: byMonth,
  };
}

// ── build + persist + self-update ────────────────────────────────────────────
function profilePath(dataDir) { return path.join(dataDir, PROFILE_FILE); }

function getShape(dataDir) {
  try { return JSON.parse(fs.readFileSync(profilePath(dataDir), "utf8")); } catch { return null; }
}

// Merge an LLM-synthesized shape_rotator_mapping into the persisted profile. The
// synthesis is a LOCAL artifact (never committed/sent); when it was produced
// from the private Codex tier the renderer marks tier accordingly.
function saveSynthesis(dataDir, synthesis, now = new Date().toISOString()) {
  if (!dataDir) return null;
  const shape = getShape(dataDir);
  if (!shape) return null;
  shape.synthesis = { ...(synthesis && typeof synthesis === "object" ? synthesis : {}), synthesized_at: now };
  try { fs.writeFileSync(profilePath(dataDir), JSON.stringify(shape, null, 2)); } catch {}
  return shape;
}

async function buildShape({ user, dataDir, home = os.homedir(), now = new Date().toISOString() } = {}) {
  const github = await scanGithubShape({ user });
  const codex = scanCodexShape({ home });

  const prior = dataDir ? getShape(dataDir) : null;
  const history = Array.isArray(prior && prior.scan_history) ? prior.scan_history.slice(-19) : [];
  history.push({
    scanned_at: now,
    github_repos: github.ok ? (github.public_repos || (github.recent_repos || []).length) : 0,
    codex_sessions: codex.ok ? codex.total_sessions : 0,
    codex_projects: codex.ok ? codex.project_count : 0,
  });

  const shape = { schema: SCHEMA, scanned_at: now, github, codex, scan_history: history };
  if (dataDir) {
    try { fs.mkdirSync(dataDir, { recursive: true }); fs.writeFileSync(profilePath(dataDir), JSON.stringify(shape, null, 2)); } catch {}
  }
  return shape;
}

// NOTE: prompt-grounding text is formatted in the renderer (app.js
// buildShapeGrounding), which owns the public-vs-private inclusion decision as
// UI state and already holds the scanned shape object. There is intentionally
// no grounding formatter here — duplicating it across the process boundary is
// the drift hazard this consolidation removed.

module.exports = { buildShape, getShape, saveSynthesis, scanGithubShape, scanCodexShape, validGithubHandle, SCHEMA, PROFILE_FILE };
