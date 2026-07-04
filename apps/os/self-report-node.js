// self-report-node.js — main-process side of the permission-gated self-report.
//
// Local, consent-gated operations. The renderer drives consent; nothing here
// runs unless the member opts in.
//   • scanLocalSessions: discover recent Claude/Codex session files, build a
//     scrubbed digest with the daybook redactor, and add two context blocks:
//     agent memory from ~/.claude/projects/*/memory/ plus the member's own
//     recent Router posts. Raw session bodies are read only to build the digest
//     and never leave this process.
//   • runSynthesis: pipe the digest to the member's local AI CLI, using the same
//     resolver as cohort chat, and return stdout for the renderer to parse into
//     a whitelisted profile delta.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { digestFromRawFiles, claudeDirToPath } = require("./daybook/transcripts");
const { redact } = require("./daybook/redact");
const scopeMod = require("./daybook/scope");
const routerFeed = require("./daybook/router");

// Resolve the member's own local AI CLI the same way the Router/daybook does:
// by command name on PATH, with overrides for non-standard installs.
// First match wins: explicit chatCmd → COHORT_CHAT_CMD/COHORT_LLM_CMD env → auto-
// detect on PATH (claude → codex). The target is a coding agent that can follow
// the prompt's strict JSON instruction directly. No API key either way.
const DETECT = [
  { bin: "claude", args: ["-p"] },
  // Live test: codex refuses outside a git repo (the app's cwd) without
  // --skip-git-repo-check; --sandbox read-only keeps the synth from writing
  // anything (it may still read gh/git); `-` reads the prompt from stdin.
  { bin: "codex", args: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"] },
  // ollama intentionally omitted — the cohort runs Claude Code / Codex, and small
  // local models ignore the strict-JSON delta schema the self-report relies on.
];
function onPath(bin) {
  const probe = process.platform === "win32" ? "where" : "which";
  try {
    const r = spawnSync(probe, [bin], { encoding: "utf8" });
    return r.status === 0 && String(r.stdout || "").trim().length > 0;
  } catch { return false; }
}
function splitCommand(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || ""))) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
function resolveCommand(configuredCmd) {
  const explicit = (configuredCmd && configuredCmd.trim())
    || (process.env.COHORT_CHAT_CMD && process.env.COHORT_CHAT_CMD.trim())
    || (process.env.COHORT_LLM_CMD && process.env.COHORT_LLM_CMD.trim());
  if (explicit) { const argv = splitCommand(explicit); if (argv.length) return argv; }
  for (const d of DETECT) if (onPath(d.bin)) return [d.bin, ...d.args];
  return null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_FILES = 40; // most-recent N session files folded into the digest
const MAX_FILE_BYTES = 512 * 1024; // cap per-file read (digest is re-capped to 40k by the daybook)

function recentClaudeFiles(sinceMs) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const fp = path.join(dir, name);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.mtimeMs >= sinceMs) out.push({ source: "claude", name, path: fp, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

function recentCodexFiles(sinceMs) {
  const root = path.join(os.homedir(), ".codex", "sessions");
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".jsonl")) {
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.mtimeMs >= sinceMs) out.push({ source: "codex", name: e.name, path: p, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root);
  return out;
}

function readCapped(fp) {
  try {
    const buf = fs.readFileSync(fp);
    return buf.length > MAX_FILE_BYTES
      ? buf.slice(buf.length - MAX_FILE_BYTES).toString("utf8")
      : buf.toString("utf8");
  } catch { return ""; }
}

// ── Agent memory (the distilled notes the member's agent keeps per project) ──
// ~/.claude/projects/<encoded-cwd>/memory/*.md — one fact per file plus a
// MEMORY.md index. This is already-distilled "what I'm working on" signal,
// written by the member's own agent on this machine, so it is much higher
// signal-per-byte than raw session logs. It uses the same Teleport Router
// read-scope as daybook transcript reads, and every byte passes through the
// same redactor before it can enter a digest.

const MAX_MEMORY_FILES = 24;          // newest-first across all projects
const MAX_MEMORY_FILES_PER_PROJECT = 6;
const MAX_MEMORY_FILE_CHARS = 1200;   // per note, after one-lining (the lead carries the fact)
const MAX_MEMORY_SECTION_CHARS = 8000; // keep the section a fraction of the 40k session digest

function discoverMemoryFiles(sinceMs) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const out = [];
  let dirs;
  try { dirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const memDir = path.join(root, d.name, "memory");
    let names;
    try { names = fs.readdirSync(memDir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const fp = path.join(memDir, name);
      let st; try { st = fs.statSync(fp); } catch { continue; }
      if (st.isDirectory && st.isDirectory()) continue;
      if (st.mtimeMs < sinceMs) continue;
      out.push({
        fullPath: claudeDirToPath(d.name), // scope key — same derivation the daybook uses
        project: decodeClaudeProject(d.name),
        name,
        path: fp,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return out;
}

// Split a memory file into { description, body }: the frontmatter's description
// line (when present) plus everything after the closing fence. Tolerant — a file
// without frontmatter comes back whole as `body`.
function stripFrontmatter(raw) {
  const text = String(raw || "");
  if (!text.startsWith("---")) return { description: "", body: text };
  const close = text.indexOf("\n---", 3);
  if (close < 0) return { description: "", body: text };
  const head = text.slice(0, close);
  const m = head.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const bodyStart = text.indexOf("\n", close + 1);
  return {
    description: m ? m[1].trim() : "",
    body: bodyStart >= 0 ? text.slice(bodyStart + 1) : "",
  };
}

// PURE section builder (exported for tests): files = [{ project, name, content,
// mtimeMs }] → { text, fileCount, projectCount }. Every emitted string passes
// through redact() with the caller's rules (I1). Within a project the MEMORY.md
// index leads (it is the one-line map), then newest first.
function buildAgentMemorySection(files, rules) {
  const list = Array.isArray(files) ? files.filter((f) => f && f.content) : [];
  if (!list.length) return { text: "", fileCount: 0, projectCount: 0 };

  const byProject = new Map();
  for (const f of [...list].sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0))) {
    const key = f.project || "unknown project";
    if (!byProject.has(key)) byProject.set(key, []);
    const group = byProject.get(key);
    if (group.length >= MAX_MEMORY_FILES_PER_PROJECT) continue;
    group.push(f);
  }

  const lines = [
    "## Agent memory (distilled notes your agent kept while you worked)",
    "Durable per-project facts, written by your own local agent — trust these over raw log noise.",
    "",
  ];
  let fileCount = 0;
  for (const [project, group] of byProject) {
    if (fileCount >= MAX_MEMORY_FILES) break;
    group.sort((a, b) => {
      const ai = /^MEMORY\.md$/i.test(a.name) ? 0 : 1;
      const bi = /^MEMORY\.md$/i.test(b.name) ? 0 : 1;
      return ai - bi || (b.mtimeMs || 0) - (a.mtimeMs || 0);
    });
    const pr = redact(project, rules, { source: `${project} · memory` });
    lines.push(`### ${pr.masked}`);
    for (const f of group) {
      if (fileCount >= MAX_MEMORY_FILES) break;
      const { description, body } = stripFrontmatter(f.content);
      const oneLine = [description, body].filter(Boolean).join(" — ")
        .replace(/\s+/g, " ").trim().slice(0, MAX_MEMORY_FILE_CHARS);
      if (!oneLine) continue;
      const rr = redact(oneLine, rules, { source: `${pr.masked} · memory/${f.name}` });
      lines.push(`- ${f.name.replace(/\.md$/, "")}: ${rr.masked}`);
      fileCount++;
      if (lines.join("\n").length > MAX_MEMORY_SECTION_CHARS) break;
    }
    lines.push("");
    if (lines.join("\n").length > MAX_MEMORY_SECTION_CHARS) break;
  }
  if (!fileCount) return { text: "", fileCount: 0, projectCount: 0 };
  let text = lines.join("\n").trimEnd();
  if (text.length > MAX_MEMORY_SECTION_CHARS) text = text.slice(0, MAX_MEMORY_SECTION_CHARS) + "\n…(truncated)";
  return { text, fileCount, projectCount: byProject.size };
}

// Discover → scope-gate → read → build. Synchronous fs work; kept separate from
// the session scan so it can be reused (and tested) on its own.
function scanAgentMemory({ sinceMs } = {}) {
  const found = discoverMemoryFiles(typeof sinceMs === "number" ? sinceMs : 0);
  if (!found.length) return { text: "", fileCount: 0, projectCount: 0 };

  // The Teleport Router read-scope (deny-by-default, keyed on the same decoded
  // path the daybook keys on; default scope auto-includes repos active ≤30d).
  const scope = scopeMod.loadScope();
  const activity = {};
  const paths = [];
  for (const f of found) {
    if (!activity[f.fullPath]) paths.push(f.fullPath);
    if (f.mtimeMs > (activity[f.fullPath] || 0)) activity[f.fullPath] = f.mtimeMs;
  }
  const { allow } = scopeMod.buildAllowSet(paths, scope, activity);
  const allowed = found.filter((f) => allow.has(f.fullPath));
  if (!allowed.length) return { text: "", fileCount: 0, projectCount: 0 };

  const files = allowed
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_MEMORY_FILES * 2) // discovery cap; the builder re-caps per project/total
    .map((f) => ({ project: f.project, name: f.name, content: readCapped(f.path), mtimeMs: f.mtimeMs }));
  return buildAgentMemorySection(files, scopeMod.loadRules());
}

// ── "Already shared" overlap guard ───────────────────────────────────────────
// The vendored Teleport Router daybook posts daily working updates to the
// cohort Router feed. Fold the member's own recent posts in as "already shared"
// context so a self-report draft does not repeat what that path already sent.
// This is read-only, uses the member's own ~/.routerrc, and is best-effort:
// offline mode or a missing key simply omits the section.

const MAX_SHARED_POSTS = 8;
const MAX_SHARED_LINE_CHARS = 220;
const ROUTER_FEED_TIMEOUT_MS = 3500;

// PURE section builder (exported for tests): entries = [{ date, content }].
function buildAlreadySharedSection(entries) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && e.content) : [];
  if (!list.length) return "";
  const lines = [
    "## Already shared with the cohort (your recent Router posts)",
    "These updates were already shared. Report only what is new or changed since.",
    "",
  ];
  for (const e of list.slice(0, MAX_SHARED_POSTS)) {
    // First meaningful line; skip the "Router digest · <date>" title line the
    // daybook prepends (mirrors daybook/router.js post()).
    const first = String(e.content).split("\n").map((l) => l.trim()).filter(Boolean)
      .find((l) => !/^router digest/i.test(l)) || "";
    if (!first) continue;
    const capped = first.length > MAX_SHARED_LINE_CHARS ? first.slice(0, MAX_SHARED_LINE_CHARS - 1) + "…" : first;
    lines.push(`- [${e.date || "recent"}] ${capped}`);
  }
  return lines.length > 3 ? lines.join("\n") : "";
}

async function fetchAlreadyShared({ days = 14, limit = MAX_SHARED_POSTS, timeoutMs = ROUTER_FEED_TIMEOUT_MS } = {}) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); });
  let feed = null;
  try { feed = await Promise.race([routerFeed.cohortFeed({ days, limit: 100 }), timeout]); }
  catch { feed = null; }
  finally { clearTimeout(timer); }
  if (!feed || !feed.ok || !Array.isArray(feed.entries)) return [];
  return feed.entries
    .filter((e) => e && e.mine && e.content)
    .slice(0, Math.max(1, Math.min(MAX_SHARED_POSTS, Number(limit) || MAX_SHARED_POSTS)))
    .map((e) => ({ date: e.date || "", content: String(e.content) }));
}

// Scan the member's recent local AI work into ONE scrubbed digest with three
// blocks: raw-session digest (the daybook redactor runs inside
// digestFromRawFiles), agent memory (scope-gated + redacted), and the member's
// own recent Router posts (the do-not-repeat overlap guard). Returns { ok,
// digest, fileCount, projectCount, memoryFileCount, memoryProjectCount,
// alreadySharedCount }. Empty digest (not an error) when there's nothing to read.
async function scanLocalSessions({ days = 14, includeMemory = true, includeRouterFeed = true } = {}) {
  const window = Math.max(1, Math.min(60, Number(days) || 14));
  const sinceMs = Date.now() - window * DAY_MS;
  const found = [...recentClaudeFiles(sinceMs), ...recentCodexFiles(sinceMs)]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES);
  let sessionDigest = "";
  let projectCount = 0;
  if (found.length) {
    const files = found.map((f) => ({ source: f.source, name: f.name, content: readCapped(f.path) }));
    const result = digestFromRawFiles(files, `the last ${window} days`);
    sessionDigest = result && result.digest ? result.digest : "";
    projectCount = (result && result.projectCount) || 0;
  }

  let memory = { text: "", fileCount: 0, projectCount: 0 };
  if (includeMemory) { try { memory = scanAgentMemory({ sinceMs }); } catch { /* best-effort */ } }

  let shared = [];
  if (includeRouterFeed) { try { shared = await fetchAlreadyShared({}); } catch { /* offline / no key */ } }
  const sharedText = buildAlreadySharedSection(shared);

  return {
    ok: true,
    digest: [sessionDigest, memory.text, sharedText].filter(Boolean).join("\n\n"),
    fileCount: found.length,
    projectCount,
    memoryFileCount: memory.fileCount,
    memoryProjectCount: memory.projectCount,
    alreadySharedCount: shared.length,
  };
}

// Decode a Claude project dir name (an encoded cwd, separators → '-') into a short
// readable label, e.g. "C--Users-micha-…-Shape-OS" → "Shape OS".
function decodeClaudeProject(dirName) {
  const segs = String(dirName || "").split("-").filter(Boolean);
  return segs.length ? segs.slice(-2).join(" ") : "";
}

// List the member's recent local AI sessions as TIMELINE METADATA only — a
// title/project + a timestamp per session file. It NEVER reads a single byte of
// session BODY (unlike scanLocalSessions, which scrubs content into a digest): a
// timeline placement needs only when-and-roughly-what, so nothing sensitive is
// read. Stays on-device; the renderer mounts it in the member's private
// timeline lane (buildSessionsLane, tier:'local'). Always resolves.
async function listLocalSessions({ days = 30, max = 200 } = {}) {
  const window = Math.max(1, Math.min(120, Number(days) || 30));
  const sinceMs = Date.now() - window * DAY_MS;
  let found = [];
  try { found = [...recentClaudeFiles(sinceMs), ...recentCodexFiles(sinceMs)]; } catch { found = []; }
  const sessions = found.map((f) => {
    const project = f.source === "claude" ? decodeClaudeProject(path.basename(path.dirname(f.path))) : "";
    return {
      source: f.source,
      id: String(f.name || "").replace(/\.jsonl$/, ""),
      title: project || (f.source === "codex" ? "codex session" : "session"),
      project,
      ms: f.mtimeMs,
    };
  }).sort((a, b) => b.ms - a.ms).slice(0, Math.max(1, Math.min(1000, Number(max) || 200)));
  return { ok: true, sessions, count: sessions.length };
}

// Run the member's own local CLI on a prompt (one-shot; collect stdout). Reuses
// the cohort-chat resolver so it inherits the no-API-key guarantee and the saved
// command override. Always resolves (never throws).
function runSynthesis({ prompt, chatCmd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    if (!prompt || !String(prompt).trim()) return resolve({ ok: false, reason: "empty_prompt" });
    const argv = resolveCommand(chatCmd);
    if (!argv) return resolve({ ok: false, reason: "no_local_ai_cli" });
    let child;
    try {
      // Router lesson (reflect.js subscriptionEnv): strip ANTHROPIC_API_KEY so the
      // local claude bills the member's own subscription, never an API key they
      // happen to have set in their environment.
      const env = { ...process.env, CI: process.env.CI || "1", NO_COLOR: "1", PYTHONUNBUFFERED: "1" };
      delete env.ANTHROPIC_API_KEY;
      // Windows: `claude`/`codex` are .cmd/.ps1 npm shims, not bare .exe on PATH — a
      // no-shell spawn ENOENTs. Run through the shell there (one command string to
      // avoid Node's DEP0190); the prompt rides on stdin, so args carry no untrusted
      // data. Mirrors the cohort-chat-node fix.
      if (process.platform === "win32") {
        const q = (s) => (/[\s"]/.test(s) ? `"${String(s).replace(/"/g, '""')}"` : String(s));
        child = spawn(argv.map(q).join(" "), [], { env, stdio: ["pipe", "pipe", "pipe"], shell: true, windowsHide: true });
      } else {
        child = spawn(argv[0], argv.slice(1), { env, stdio: ["pipe", "pipe", "pipe"] });
      }
    } catch (e) { return resolve({ ok: false, reason: "spawn_failed", detail: e.message }); }
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM doesn't reliably kill a child's subtree on Windows (codex/ollama
      // spawn helpers), so tree-kill there; SIGTERM elsewhere.
      try {
        if (process.platform === "win32" && child.pid) {
          spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        } else {
          child.kill("SIGTERM");
        }
      } catch {}
    }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: "spawn_error", detail: e.message }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      // A killed/partial run must NOT claim success — the renderer would surface a
      // confusing parse error instead of "timed out / no output". Require a clean
      // exit or at least a JSON-looking object in stdout.
      if (timedOut) return resolve({ ok: false, reason: "timeout", stdout: out, stderr: err, exitCode: code });
      const ok = code === 0 || out.includes("{");
      resolve({ ok, reason: ok ? undefined : "no_output", stdout: out, stderr: err, exitCode: code });
    });
    try { child.stdin.write(String(prompt)); child.stdin.end(); } catch {}
  });
}

module.exports = {
  scanLocalSessions, listLocalSessions, runSynthesis, resolveCommand, splitCommand,
  scanAgentMemory, buildAgentMemorySection, buildAlreadySharedSection, fetchAlreadyShared,
};
