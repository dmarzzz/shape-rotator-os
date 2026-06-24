#!/usr/bin/env node
// Privacy / secret commit boundary for the PUBLIC Shape Rotator OS repo.
//
// This is the single source of truth that the pre-commit hook, the pre-push
// hook, and CI all call. It refuses to let private engine-layer material —
// the transcript vault, the selection/applicant archive, organizer notes,
// raw transcripts, OAuth/service-role secrets — enter version control, even
// if a file was force-added (`git add -f`) or written outside `.private/`.
//
// Layers it backs up (defense in depth):
//   .gitignore  ->  pre-commit hook  ->  pre-push hook  ->  CI (un-bypassable)
//
// Modes:
//   --staged          check files staged for commit (pre-commit). DEFAULT.
//   --range A..B      check files changed in a git range (pre-push / CI PR).
//   --all             check every tracked file (CI safety net / audit).
//   --files a b c     check explicit paths (testing / ad hoc).
//   --json            machine-readable output.
//
// Exit code 0 = clean, 1 = boundary violation (blocks the commit/push/merge).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  }
})();

// ---------------------------------------------------------------------------
// 1) PATH RULES — files whose location alone means "never commit". Hard block.
//    These are reliable and have zero false positives.
// ---------------------------------------------------------------------------
// NOTE: paths are normalized to lowercase + forward-slashes before these run
// (see evaluatePath), so all rules are case- and separator-insensitive — this
// matters on Windows/macOS/OneDrive where DO_NOT_PUBLISH/ === do_not_publish/.
export const PRIVATE_PATH_RULES = [
  { label: "local Claude workspace/config", test: (p) => /(^|\/)\.claude(\/|$)/.test(p) },
  { label: "private vault dir (.private)", test: (p) => /(^|\/)\.private(\/|$)/.test(p) },
  { label: "env secret file", test: (p) => /(^|\/)\.env(\.|$)/.test(p) && !/\.(example|sample|template)$/.test(p) },
  { label: "raw transcript sources", test: (p) => /(^|\/)transcript-sources(\/|$)/.test(p) },
  { label: "raw transcripts copy", test: (p) => /(^|\/)raw[_-]transcripts(\/|$)/.test(p) },
  { label: "bundled raw transcript script", test: (p) => /(^|\/)apps\/os\/src\/content\/context\/raw-scripts\//.test(p) && !p.endsWith("/wdydlw standup recap june 8 2026.txt") },
  { label: "session readouts", test: (p) => /(^|\/)cohort-data\/session-readouts\//.test(p) },
  { label: "do_not_publish vault copy", test: (p) => /(^|\/)do[_-]not[_-]publish(\/|$)/.test(p) },
  { label: "selection / applicant archive", test: (p) => /(^|\/)selection[_-]archive(\/|$)/.test(p) },
  { label: "transcript evidence / distillations tree", test: (p) => /artifacts\/transcript-(evidence|distillations)\//.test(p) },
  { label: "caption / subtitle file", test: (p) => /\.(srt|vtt|sbv|ass|ttml)$/.test(p) },
  { label: "private key / credential material", test: (p) => /\.(pem|p12|pfx|key|keystore)$/.test(p) || /service[-_]account.*\.json$/.test(p) || /(^|\/)credentials?\.json$/.test(p) },
];

// ---------------------------------------------------------------------------
// 2) SECRET CONTENT RULES — high-specificity tokens. Hard block on any file.
//    Patterns are written so this file does not match itself.
// ---------------------------------------------------------------------------
export const SECRET_CONTENT_RULES = [
  { label: "Google OAuth refresh token", pattern: /1\/\/0[A-Za-z0-9_-]{20,}/ },
  { label: "Google OAuth client secret", pattern: /GOCSPX-[A-Za-z0-9_-]{20,}/ },
  { label: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/ },
  { label: "OpenAI API key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/ },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9-]{20,}/ },
  // Length is a RANGE, not an exact {36}: gho_/ghs/ghu/ghr_ server/OAuth tokens
  // vary in length and GitHub has said token lengths may grow. A trailing \b
  // also never fires between two word chars, so it silently let longer tokens
  // through — dropped here. 30+ alphanumerics after the prefix stays specific.
  { label: "GitHub token", pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { label: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { label: "Stripe live secret key", pattern: /\bsk_live_[A-Za-z0-9]{20,}/ },
  { label: "AWS access key id", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "PEM private key block", pattern: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  // Engine-stamped sentinel: any file the engine marks private must never commit.
  { label: "private-content sentinel", pattern: /SHAPE[-_]ROTATOR[-_]PRIVATE[-_]DO[-_]NOT[-_]COMMIT/ },
];

// ---------------------------------------------------------------------------
// 3) RAW PRIVATE CONTENT — verbatim transcript / vault dialogue pasted into a
//    tracked file. Heuristic: many diarization / caption lines. Conservative
//    threshold to avoid flagging normal prose or code.
// ---------------------------------------------------------------------------
// Raw transcripts/captions are TIMESTAMP-anchored. We require seconds
// (HH:MM:SS) or a timestamp+speaker turn or an SRT arrow, so structured
// "Key: value" lines (YAML, JS, markdown, schedules like "9:00") never trip it.
const TIMESTAMP_LINE = /^\s*[\[(]?\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?[\])]?(?:\s|$)/;          // 00:12:34 / [00:12:34]
const TS_SPEAKER_LINE = /^\s*[\[(]?\d{1,2}:\d{2}(?::\d{2})?[\])]?\s+[A-Z][\w .'’-]{0,28}:\s/; // 00:12 Speaker:
const SRT_ARROW_LINE = /\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}/;          // SRT cue
const RAW_TRANSCRIPT_MIN_LINES = 6;
// Person-name speaker turns (no timestamps) — catches plain "Andrew: …" exports.
// The label must look like a person name (1-3 Initial-cap words), so structured
// bullets ("On the site:", config "GOOGLE_ID:") and prose do not qualify.
const NAME_LABEL = /^[A-Z][a-z]+(?:\s[A-Z][a-z]+){0,2}$/;
const SPEAKER_TURN = /^\s*([A-Za-z][\w .'’-]{0,28}):\s+\S.{14,}$/;

// Files exempt from CONTENT scanning only (they legitimately contain the
// pattern strings or describe the boundary). PATH rules still apply to all.
const CONTENT_SCAN_EXEMPT = new Set([
  "scripts/check-commit-privacy-boundary.mjs",
  "scripts/check-commit-privacy-boundary.test.mjs",
  "scripts/surface-leak-scan.mjs",
  "scripts/lib/surface-leak-patterns.mjs",
  "docs/INFORMATION_RULES.md",
  ".privacy-guard-allowlist",
]);

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|mp4|mov|mp3|wav|woff2?|ttf|otf|eot|node|wasm|exe|dll|dylib|so|bin|lock)$/i;
const PUBLIC_SURFACE_FILES = new Set([
  "apps/os/src/cohort-surface.json",
  "apps/os/src/cohort-timeline.json",
  "apps/web/cohort-surface.json",
]);
const ALLOWLIST_PATH = ".privacy-guard-allowlist";

function gitLines(args) {
  try {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function stagedContent(relPath) {
  try {
    return execFileSync("git", ["show", `:${relPath}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function stagedIndexEntries(paths = []) {
  const args = ["ls-files", "-s"];
  if (paths.length) args.push("--", ...paths);
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const entries = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line) continue;
    const m = /^(\d{6})\s+([0-9a-f]+)\s+(\d)\t(.+)$/.exec(line);
    if (!m || m[3] !== "0") continue;
    entries.push({ mode: m[1], oid: m[2], path: m[4] });
  }
  return entries;
}

function stagedContentMap(paths = []) {
  const entries = stagedIndexEntries(paths).filter((entry) => entry.mode !== "120000");
  const map = new Map();
  if (!entries.length) return map;

  try {
    const input = entries.map((entry) => `${entry.oid}\n`).join("");
    const out = execFileSync("git", ["cat-file", "--batch"], {
      cwd: ROOT,
      input,
      maxBuffer: 256 * 1024 * 1024,
    });

    let offset = 0;
    for (const entry of entries) {
      const nl = out.indexOf(10, offset);
      if (nl < 0) break;
      const header = out.subarray(offset, nl).toString("utf8");
      offset = nl + 1;
      const m = /^[0-9a-f]+\s+\S+\s+(\d+)$/.exec(header);
      if (!m) break;
      const size = Number(m[1]);
      map.set(entry.path, out.subarray(offset, offset + size));
      offset += size;
      if (out[offset] === 10) offset += 1;
    }
  } catch {
    // Some Windows Git builds fail `cat-file --batch` under hook/stdin
    // conditions. Fall back to the slower but portable staged blob reader.
    for (const entry of entries) {
      const buf = stagedContent(entry.path);
      if (buf) map.set(entry.path, buf);
    }
  }
  return map;
}

function worktreeContent(relPath) {
  const abs = path.join(ROOT, relPath);
  try { return fs.readFileSync(abs); } catch { return null; }
}

function isTrackedFile(relPath) {
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", relPath], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function stagedStatus(relPath) {
  try {
    return execFileSync("git", ["diff", "--cached", "--name-status", "--", relPath], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function parseAllowlistText(text = "") {
  const set = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith("#")) set.add(t);
  }
  return set;
}

export function loadAllowlist({ mode = "staged", headRev = "HEAD", readers = {} } = {}) {
  const readStaged = readers.stagedContent || stagedContent;
  const readRev = readers.revContent || revContent;
  const readWorktree = readers.worktreeContent || worktreeContent;
  const isTracked = readers.isTrackedFile || isTrackedFile;
  const getStagedStatus = readers.stagedStatus || stagedStatus;

  let raw = null;
  if (mode === "staged") {
    const status = getStagedStatus(ALLOWLIST_PATH);
    if (/^D\b/m.test(status)) return new Set();
    raw = readStaged(ALLOWLIST_PATH);
    if (!raw && !status) raw = readRev("HEAD", ALLOWLIST_PATH);
  } else if (mode === "range") {
    raw = readRev(headRev, ALLOWLIST_PATH);
  } else if (isTracked(ALLOWLIST_PATH)) {
    raw = readWorktree(ALLOWLIST_PATH);
  }
  return parseAllowlistText(raw ? raw.toString("utf8") : "");
}

function isProbablyBinary(buf) {
  if (!buf) return true;
  const slice = buf.subarray(0, 8000);
  for (const byte of slice) if (byte === 0) return true;
  return false;
}

function countRawTranscriptLines(text) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (TIMESTAMP_LINE.test(line) || TS_SPEAKER_LINE.test(line) || SRT_ARROW_LINE.test(line)) count += 1;
  }
  return count;
}

// Decode JWT payloads and flag ONLY service-role/admin tokens, so the public
// Supabase anon key (role: anon) never trips the gate but the secret key does.
const JWT_RE = /eyJ[A-Za-z0-9_-]{6,}\.(eyJ[A-Za-z0-9_-]{6,})\.[A-Za-z0-9_-]{6,}/g;
function hasPrivilegedJwt(text) {
  JWT_RE.lastIndex = 0;
  let m;
  while ((m = JWT_RE.exec(text))) {
    let payload = "";
    try { payload = Buffer.from(m[1], "base64url").toString("utf8"); } catch { /* skip */ }
    if (/"role"\s*:\s*"(?:service_role|admin)"|service_role/.test(payload)) return true;
  }
  return false;
}

function looksLikeDialogue(text) {
  const byLabel = new Map();
  let turns = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = SPEAKER_TURN.exec(line);
    if (!m) continue;
    const label = m[1].trim();
    if (!NAME_LABEL.test(label)) continue;
    turns += 1;
    byLabel.set(label, (byLabel.get(label) || 0) + 1);
  }
  const labels = byLabel.size;
  // Dialogue cadence: many turns, a small set of recurring named speakers.
  return turns >= 12 && labels >= 2 && labels <= 8 && turns / labels >= 2.5;
}

function isEmptyPrivateScalar(value) {
  const v = String(value || "").trim().toLowerCase();
  return !v || v === "null" || v === "~" || v === "\"\"" || v === "''";
}

function profileLineFinding(relPath, text, field, label, indent = "") {
  const prefix = `${indent}${field}:`;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.startsWith(prefix)) continue;
    if (!isEmptyPrivateScalar(line.slice(prefix.length))) {
      return { file: relPath, kind: "pii", label, line: index + 1 };
    }
  }
  return null;
}

function evaluatePublicPii(relPath, text) {
  const findings = [];
  const norm = String(relPath).replace(/\\/g, "/");
  if (/^cohort-data\/people\/[^/]+\.md$/i.test(norm)) {
    for (const finding of [
      profileLineFinding(relPath, text, "email", "public person email field"),
      profileLineFinding(relPath, text, "dietary_restrictions", "public person dietary restriction field"),
      profileLineFinding(relPath, text, "telegram", "private person contact link", "  "),
      profileLineFinding(relPath, text, "signal", "private person contact link", "  "),
      profileLineFinding(relPath, text, "whatsapp", "private person contact link", "  "),
      profileLineFinding(relPath, text, "phone", "private person contact link", "  "),
    ]) {
      if (finding) findings.push(finding);
    }
  }
  if (PUBLIC_SURFACE_FILES.has(norm)) {
    const surfaceRules = [
      { label: "Git author email field", pattern: /"author_email"\s*:\s*"[^"]+"/i },
      { label: "person dietary restriction field", pattern: /"dietary_restrictions"\s*:\s*(?:"[^"]+"|[0-9tfa][^,}\]\r\n]*)/i },
      { label: "private person contact link", pattern: /"(?:email|telegram|signal|whatsapp|phone)"\s*:\s*"[^"]+"/i },
    ];
    for (const rule of surfaceRules) {
      const m = rule.pattern.exec(text);
      if (m) findings.push({ file: relPath, kind: "pii", label: rule.label, line: text.slice(0, m.index).split(/\n/).length });
    }
  }
  return findings;
}

export function evaluatePath(relPath) {
  const findings = [];
  // Normalize: forward slashes + lowercase so the deny-list is separator- and
  // case-insensitive (Windows/macOS/OneDrive collapse DO_NOT_PUBLISH/ === do_not_publish/).
  const norm = String(relPath).replace(/\\/g, "/").toLowerCase();
  for (const rule of PRIVATE_PATH_RULES) {
    if (rule.test(norm)) findings.push({ file: relPath, kind: "path", label: rule.label });
  }
  return findings;
}

export function evaluateContent(relPath, buf, { allowlist = new Set() } = {}) {
  const findings = [];
  if (CONTENT_SCAN_EXEMPT.has(relPath) || allowlist.has(relPath)) return findings;
  if (BINARY_EXT.test(relPath) || isProbablyBinary(buf)) return findings;
  const text = buf.toString("utf8");
  for (const rule of SECRET_CONTENT_RULES) {
    const m = rule.pattern.exec(text);
    if (m) findings.push({ file: relPath, kind: "secret", label: rule.label, line: text.slice(0, m.index).split(/\n/).length });
  }
  if (hasPrivilegedJwt(text)) findings.push({ file: relPath, kind: "secret", label: "service-role/admin JWT" });
  const rawLines = countRawTranscriptLines(text);
  if (rawLines >= RAW_TRANSCRIPT_MIN_LINES) {
    findings.push({ file: relPath, kind: "raw-transcript", label: `looks like a verbatim transcript (${rawLines} timestamp/caption lines)` });
  } else if (looksLikeDialogue(text)) {
    findings.push({ file: relPath, kind: "raw-transcript", label: "looks like a verbatim transcript (recurring named-speaker dialogue)" });
  }
  findings.push(...evaluatePublicPii(relPath, text));
  return findings;
}

// Strict git: throws on failure so the guard FAILS CLOSED (reports a violation)
// rather than silently reporting "clean" when git is unavailable or errors.
function gitLinesStrict(args) {
  const out = execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function revContent(rev, relPath) {
  try {
    return execFileSync("git", ["show", `${rev}:${relPath}`], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function rangeHead(range) {
  return String(range || "").split(/\.\.\.?/).pop() || "HEAD";
}

function collectFiles(mode, args) {
  if (mode === "files") return args;
  if (mode === "all") return gitLinesStrict(["ls-files"]);
  if (mode === "range") return gitLinesStrict(["diff", "--name-only", "--diff-filter=ACMR", args[0]]);
  return gitLinesStrict(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
}

// Map of staged/committed symlinks (path -> target string). A symlink blob's
// content IS its target path, so a link pointing into the vault would slip a
// content scan; we apply PATH rules to the resolved target instead.
function symlinkTargets(mode, args) {
  const map = new Map();
  const rev = mode === "staged" ? null : (mode === "range" ? rangeHead(args[0]) : "HEAD");
  let raw = [];
  try {
    raw = mode === "staged"
      ? gitLinesStrict(["ls-files", "-s"])
      : gitLinesStrict(["ls-tree", "-r", rev || "HEAD"]);
  } catch { return map; }
  for (const line of raw) {
    // "120000 <sha> <stage>\t<path>" (ls-files) or "120000 blob <sha>\t<path>" (ls-tree)
    const m = /^120000[ \t]\S+(?:[ \t]\S+)?\t(.+)$/.exec(line);
    if (!m) continue;
    const p = m[1];
    const target = mode === "staged" ? (stagedContent(p)?.toString("utf8").trim()) : (revContent(rev, p)?.toString("utf8").trim());
    if (target) map.set(p, target);
  }
  return map;
}

function readFor(mode, relPath, ctx = {}) {
  if (mode === "staged") return ctx.stagedBlobs?.get(relPath) ?? stagedContent(relPath) ?? worktreeContent(relPath);
  if (mode === "range") return revContent(ctx.headRev, relPath) ?? worktreeContent(relPath);
  return worktreeContent(relPath); // all / files
}

export function runGuard({ mode = "staged", args = [] } = {}) {
  const files = collectFiles(mode, args);
  const headRev = mode === "range" ? rangeHead(args[0]) : "HEAD";
  const allowlist = loadAllowlist({ mode, headRev });
  const symlinks = mode === "files" ? new Map() : symlinkTargets(mode, args);
  const stagedBlobs = mode === "staged" ? stagedContentMap(files) : null;
  const findings = [];
  for (const relPath of files) {
    // PATH rules ALWAYS apply — the allowlist can only silence content findings,
    // never let a file under a private path into the repo.
    findings.push(...evaluatePath(relPath));
    // A symlink into a private path (or escaping the repo) is a violation.
    if (symlinks.has(relPath)) {
      const target = symlinks.get(relPath);
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relPath.replace(/\\/g, "/")), target.replace(/\\/g, "/")));
      if (path.isAbsolute(target) || resolved.startsWith("..")) {
        findings.push({ file: relPath, kind: "symlink", label: `symlink escapes the repo -> ${target}` });
      } else {
        for (const f of evaluatePath(resolved)) findings.push({ ...f, kind: "symlink", label: `symlink into private path -> ${target}` });
      }
    }
    if (allowlist.has(relPath)) continue; // allowlist skips CONTENT scanning only
    const buf = readFor(mode, relPath, { headRev, stagedBlobs });
    if (buf) findings.push(...evaluateContent(relPath, buf, { allowlist }));
  }
  return { mode, scanned: files.length, findings };
}

function main(argv = process.argv.slice(2)) {
  let mode = "staged";
  let args = [];
  if (argv.includes("--all")) mode = "all";
  else if (argv.includes("--range")) { mode = "range"; args = [argv[argv.indexOf("--range") + 1]]; }
  else if (argv.includes("--files")) { mode = "files"; args = argv.slice(argv.indexOf("--files") + 1); }
  else if (argv.includes("--staged")) mode = "staged";
  const asJson = argv.includes("--json");

  let result;
  try {
    result = runGuard({ mode, args });
  } catch (error) {
    // FAIL CLOSED: if we cannot determine what is being committed, block.
    console.error(`\n⛔  privacy guard could not run — failing closed: ${error?.message || error}\n`);
    return 1;
  }
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.findings.length) {
    console.error("\n⛔  PRIVACY BOUNDARY VIOLATION — refusing to let private data into the public repo.\n");
    for (const f of result.findings) {
      console.error(`  [${f.kind}] ${f.file}${f.line ? `:${f.line}` : ""}  — ${f.label}`);
    }
    console.error(`\n  ${result.findings.length} finding(s) across ${result.scanned} file(s) (mode: ${result.mode}).`);
    console.error("\n  Private engine-layer material (transcript vault, selection/applicant archive,");
    console.error("  organizer notes, raw transcripts, secrets) must stay in cohort-data/.private/ or");
    console.error("  the Drive vault — never in this public repo.");
    console.error("\n  If this is a TRUE false positive, add the exact path to .privacy-guard-allowlist");
    console.error("  with a one-line reason. Do NOT bypass with --no-verify.\n");
  } else {
    console.log(`privacy boundary clean: ${result.scanned} file(s) checked (mode: ${result.mode}).`);
  }
  return result.findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
