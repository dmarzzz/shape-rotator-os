// self-report-node.js — main-process side of the permission-gated self-report.
//
// Two one-shot, LOCAL operations (the renderer drives consent — nothing here runs
// unless the member opted in):
//   • scanLocalSessions: discover the member's recent Claude/Codex session files
//     (the same on-disk sources the daybook reads) and fold them into a SCRUBBED
//     digest via the daybook's proven redactor (digestFromRawFiles). Raw bodies
//     are read only to build the digest and never leave this process.
//   • runSynthesis: pipe a prompt to the member's OWN local AI CLI (reusing the
//     cohort-chat resolver — no API key) and return its stdout for the renderer
//     to parse into a whitelisted profile delta.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { digestFromRawFiles } = require("./daybook/transcripts");
const { resolveCommand } = require("./cohort-chat-node");

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

// Scan the member's recent local AI sessions into a SCRUBBED digest (the daybook
// redactor runs inside digestFromRawFiles). Returns { ok, digest, fileCount,
// projectCount }. Empty (not an error) when there's nothing recent to read.
async function scanLocalSessions({ days = 14 } = {}) {
  const window = Math.max(1, Math.min(60, Number(days) || 14));
  const sinceMs = Date.now() - window * DAY_MS;
  const found = [...recentClaudeFiles(sinceMs), ...recentCodexFiles(sinceMs)]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES);
  if (!found.length) return { ok: true, digest: "", fileCount: 0, projectCount: 0 };
  const files = found.map((f) => ({ source: f.source, name: f.name, content: readCapped(f.path) }));
  const result = digestFromRawFiles(files, `the last ${window} days`);
  return {
    ok: true,
    digest: result && result.digest ? result.digest : "",
    fileCount: files.length,
    projectCount: (result && result.projectCount) || 0,
  };
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
      child = spawn(argv[0], argv.slice(1), {
        env: { ...process.env, CI: process.env.CI || "1", NO_COLOR: "1", PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) { return resolve({ ok: false, reason: "spawn_failed", detail: e.message }); }
    let out = "", err = "";
    const timer = setTimeout(() => { try { child.kill("SIGTERM"); } catch {} }, timeoutMs);
    child.stdout.on("data", (b) => { out += b.toString("utf8"); });
    child.stderr.on("data", (b) => { err += b.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, reason: "spawn_error", detail: e.message }); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 || out.trim().length > 0, stdout: out, stderr: err, exitCode: code });
    });
    try { child.stdin.write(String(prompt)); child.stdin.end(); } catch {}
  });
}

module.exports = { scanLocalSessions, runSynthesis };
