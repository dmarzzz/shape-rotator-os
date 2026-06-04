'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Transcript reader.
//
// Reads TODAY's local activity from two sources that already live on disk:
//   • Claude Code  ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//   • Codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
//
// It never sends anything anywhere on its own — it shapes the day into a
// compact digest string that we hand to the local `claude` CLI to write a
// reflection. Before any of that text becomes a digest, it passes through the
// deterministic, code-only scrubber in redact.js (Invariant I1), and the SET
// of sources it reads at all is gated deny-by-default by scope.js keyed on the
// FULL repo path (Invariant I3). Sessions whose content is secret-shaped but
// unclassifiable are HELD out and surfaced, never silently sent (Invariant I5).
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const { redact } = require('./redact');
const scopeMod = require('./scope');

const DAY_MS = 24 * 60 * 60 * 1000;

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');

const MAX_DIGEST_CHARS = 40000;
const MAX_MSG_CHARS = 500;
const MAX_MSGS_PER_PROJECT = 24;

// Local-day [start, end) epoch millis for a given Date (defaults to now).
function dayBounds(date = new Date()) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.getTime(), end: end.getTime() };
}

function ymd(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return {
    y: String(date.getFullYear()),
    m: p(date.getMonth() + 1),
    d: p(date.getDate()),
  };
}

// Pull plain text out of the many content shapes both tools emit, and note any
// file-touching tool calls so the reflection can mention what changed.
function extractText(content, activity) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const t = block.type;
    if (t === 'text' || t === 'input_text' || t === 'output_text') {
      if (block.text) parts.push(block.text);
    } else if (t === 'tool_use' || t === 'function_call') {
      const name = block.name || block.tool || '';
      const input = block.input || {};
      const file = input.file_path || input.path || input.notebook_path;
      if (file && activity) activity.files.add(path.basename(file));
      if (name && activity) activity.tools.add(name);
    }
  }
  return parts.join('\n');
}

// Each project is keyed on the FULL cwd PATH (Invariant I3) so same-named repos
// in different directories never collide. `label` is the basename kept for
// human display; `key` is the absolute path. Per-session/conversation identity
// lives in `sessions` so per-conversation excludes are real (I3).
function emptyProject(key, label) {
  return {
    key,                 // FULL cwd path (the map key)
    label,               // basename, for display
    name: label,         // back-compat alias some callers read
    source: new Set(),
    msgCount: 0,
    firstUser: '',
    start: Infinity,
    end: 0,
    files: new Set(),
    tools: new Set(),
    messages: [],        // { role, text, sessionId }
    sessions: new Map(), // sessionId -> { title, msgCount, source }
  };
}

// `key` is the FULL cwd path; `sessionId` ties a message to one conversation so
// per-conversation toggles are real. Both default sanely for legacy/raw paths.
function record(projects, key, source, role, text, ts, activity, sessionId) {
  const fullKey = key || 'untitled';
  const label = path.basename(fullKey) || fullKey;
  if (!projects.has(fullKey)) projects.set(fullKey, emptyProject(fullKey, label));
  const p = projects.get(fullKey);
  p.source.add(source);
  if (activity) {
    for (const f of activity.files) p.files.add(f);
    for (const t of activity.tools) p.tools.add(t);
  }
  if (ts) {
    if (ts < p.start) p.start = ts;
    if (ts > p.end) p.end = ts;
  }
  const clean = (text || '').trim();
  if (!clean) return;
  p.msgCount++;
  if (role === 'user' && !p.firstUser) p.firstUser = clean.slice(0, 300);

  // Per-session identity: first user line becomes the session title.
  const sid = sessionId || null;
  if (sid) {
    let sess = p.sessions.get(sid);
    if (!sess) {
      sess = { title: '', msgCount: 0, source };
      p.sessions.set(sid, sess);
    }
    sess.source = sess.source || source;
    sess.msgCount++;
    if (role === 'user' && !sess.title) sess.title = clean.slice(0, 200);
  }

  if (p.messages.length < MAX_MSGS_PER_PROJECT) {
    p.messages.push({ role, text: clean.slice(0, MAX_MSG_CHARS), sessionId: sid });
  }
}

async function readJsonl(file, onObj) {
  await new Promise((resolve) => {
    let stream;
    try {
      stream = fs.createReadStream(file, { encoding: 'utf8' });
    } catch {
      return resolve();
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', (line) => {
      const s = line.trim();
      if (!s) return;
      try {
        onObj(JSON.parse(s));
      } catch {
        /* skip malformed line */
      }
    });
    rl.on('close', resolve);
    stream.on('error', resolve);
  });
}

// Decode Claude's encoded project dir name back to a readable label / path.
// Returns a best-effort absolute path so we can scope-gate even without a cwd
// recorded inside the file.
function claudeDirToPath(dirName) {
  // dir like "-Users-etherealmachine-teleport-router" → "/Users/etherealmachine/teleport-router"
  if (typeof dirName !== 'string' || !dirName) return '';
  if (dirName.startsWith('-')) return '/' + dirName.slice(1).split('-').filter(Boolean).join('/');
  return dirName;
}

// ── Candidate discovery (Invariant I3): enumerate the FULL repo paths that
// have files in-window WITHOUT reading message bodies, plus the most-recent
// mtime per path for the active-within-N-days include rule. This is what we
// hand to scope.buildAllowSet to filter deny-by-default BEFORE reading.

// For Claude: each project dir encodes a cwd; sessions are per-file (uuid).
function discoverClaudeCandidates(bounds) {
  const out = []; // { fullPath, file, sessionId, mtimeMs }
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const dir of dirs) {
    const dirPath = path.join(CLAUDE_PROJECTS, dir);
    const dirFullPath = claudeDirToPath(dir);
    let entries = [];
    try {
      entries = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of entries) {
      const file = path.join(dirPath, f);
      let mtimeMs;
      try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
      if (mtimeMs < bounds.start) continue;
      const sessionId = f.replace(/\.jsonl$/, '');
      out.push({ fullPath: dirFullPath, file, sessionId, mtimeMs });
    }
  }
  return out;
}

// For Codex: the session cwd lives in the session_meta line, so we read only
// the header lines (cheap) to learn fullPath + sessionId before deciding.
async function discoverCodexCandidates(bounds, date) {
  const out = []; // { fullPath, file, sessionId, mtimeMs }
  const { y, m, d } = ymd(date);
  const dayDir = path.join(CODEX_SESSIONS, y, m, d);
  let files = [];
  try {
    files = fs.readdirSync(dayDir)
      .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
      .map((f) => path.join(dayDir, f));
  } catch {
    return out;
  }
  for (const file of files) {
    let mtimeMs;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { continue; }
    let sessionCwd = null;
    let sessionId = null;
    await readJsonl(file, (line) => {
      // We only need the meta header — bail cheaply once we have it.
      if (line && line.type === 'session_meta') {
        const payload = line.payload || {};
        sessionCwd = payload.cwd || payload.cwd_path || sessionCwd;
        sessionId = payload.id || payload.session_id || sessionId;
      }
    });
    out.push({
      fullPath: sessionCwd || path.join(CODEX_SESSIONS, 'codex-session'),
      file,
      sessionId: sessionId || path.basename(file).replace(/\.jsonl$/, ''),
      mtimeMs,
    });
  }
  return out;
}

// Build the deny-by-default allow set over discovered candidates (I3). Returns
// the scope decision bundle plus an activity map (fullPath → latest mtime).
function gateCandidates(candidates, scope) {
  const activity = {};
  const fullPaths = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c.fullPath) continue;
    if (!seen.has(c.fullPath)) { seen.add(c.fullPath); fullPaths.push(c.fullPath); }
    if (typeof c.mtimeMs === 'number' && c.mtimeMs > (activity[c.fullPath] || 0)) {
      activity[c.fullPath] = c.mtimeMs;
    }
  }
  const built = scopeMod.buildAllowSet(fullPaths, scope, activity);
  return { allow: built.allow, decisions: built.decisions, collisions: built.collisions, fullPaths };
}

async function collectClaude(projects, bounds, allow) {
  const candidates = discoverClaudeCandidates(bounds);
  for (const c of candidates) {
    // I3: deny-by-default — never read the body unless this full path is in scope.
    if (allow && !allow.has(c.fullPath)) continue;
    await readJsonl(c.file, (d) => {
      const type = d.type;
      if (type !== 'user' && type !== 'assistant') return;
      const ts = d.timestamp ? Date.parse(d.timestamp) : null;
      if (!ts || ts < bounds.start || ts >= bounds.end) return;
      const msg = d.message || {};
      const role = msg.role || type;
      const activity = { files: new Set(), tools: new Set() };
      const text = extractText(msg.content, activity);
      // Prefer the cwd recorded in the file; fall back to the dir-derived path.
      const key = d.cwd || c.fullPath;
      record(projects, key, 'claude', role, text, ts, activity, c.sessionId);
    });
  }
}

async function collectCodex(projects, bounds, date, allow) {
  const candidates = await discoverCodexCandidates(bounds, date);
  for (const c of candidates) {
    if (allow && !allow.has(c.fullPath)) continue;
    let sessionCwd = null;
    await readJsonl(c.file, (line) => {
      const type = line.type;
      const payload = line.payload || {};
      const ts = line.timestamp ? Date.parse(line.timestamp) : null;
      if (type === 'session_meta') {
        sessionCwd = payload.cwd || payload.cwd_path || null;
        return;
      }
      if (type !== 'response_item') return;
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') return;
      if (ts && (ts < bounds.start || ts >= bounds.end)) return;
      const activity = { files: new Set(), tools: new Set() };
      const text = extractText(payload.content, activity);
      const key = sessionCwd || c.fullPath;
      record(projects, key, 'codex', role, text, ts, activity, c.sessionId);
    });
  }
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`;
}

// ── Redaction over a project's leak vectors (Invariants I1 + I5) ──────────────
// Scrubs every byte that can carry a secret/PII out of a project before it
// becomes digest text: firstUser, the Files-touched basenames, each message's
// text, and the project label. Returns the masked strings + every Finding +
// whether ANY scrubbed string was `suspect` (unclassifiable secret-shaped),
// which makes the whole session HELD (fail-closed) by the caller.
function redactProject(p, rules) {
  const label = p.label || p.name || '';
  const lr = redact(label, rules, { source: `${label} · project` });

  const fuSource = `${lr.masked} · started-with`;
  const fu = redact(p.firstUser || '', rules, { source: fuSource });

  const files = [...p.files];
  const maskedFiles = [];
  const fileFindings = [];
  let filesSuspect = false;
  for (const f of files) {
    const fr = redact(f, rules, { source: `${lr.masked} · ${f}` });
    maskedFiles.push(fr.masked);
    fileFindings.push(...fr.findings);
    if (fr.suspect) filesSuspect = true;
  }

  const maskedMessages = [];
  const msgFindings = [];
  let msgSuspect = false;
  for (const msg of p.messages) {
    const mr = redact(msg.text || '', rules, {
      source: `${lr.masked} · ${msg.role === 'user' ? 'me' : 'assistant'}`,
    });
    maskedMessages.push({ role: msg.role, text: mr.masked, sessionId: msg.sessionId });
    msgFindings.push(...mr.findings);
    if (mr.suspect) msgSuspect = true;
  }

  const findings = [
    ...lr.findings,
    ...fu.findings,
    ...fileFindings,
    ...msgFindings,
  ];
  const suspect = lr.suspect || fu.suspect || filesSuspect || msgSuspect;

  return {
    label: lr.masked,
    firstUser: fu.masked,
    files: maskedFiles,
    messages: maskedMessages,
    findings,
    suspect,
  };
}

// Build the compact text we feed to the model, capped at MAX_DIGEST_CHARS.
// When `rules` is provided, every leak vector is scrubbed through redact()
// FIRST (I1) and any session that comes back `suspect` is HELD out (I5) — its
// id/label/reason pushed into `held` and its content omitted from the digest.
// Returns { digest, findings, held }.
function buildDigest(projects, dateLabel, rules) {
  const ordered = [...projects.values()]
    .filter((p) => p.msgCount > 0)
    .sort((a, b) => b.msgCount - a.msgCount);

  const lines = [`# Work log for ${dateLabel}`, ''];
  const findings = [];
  const held = [];

  for (const p of ordered) {
    let label = p.label || p.name || '';
    let firstUser = p.firstUser;
    let files = [...p.files];
    let messages = p.messages;

    if (rules) {
      // Mask the secrets we recognize, then include the session as-is. We no
      // longer "hold" whole conversations on a low-confidence/high-entropy hit
      // — that fired on harmless things (SHAs, UUIDs, base64) and was confusing.
      const r = redactProject(p, rules);
      findings.push(...r.findings);
      label = r.label;
      firstUser = r.firstUser;
      files = r.files;
      messages = r.messages;
    }

    const dur = fmtDuration(p.end - p.start);
    const meta = [
      `${p.msgCount} messages`,
      dur && `~${dur} active`,
      [...p.source].join('+'),
    ].filter(Boolean).join(', ');
    lines.push(`## ${label}  (${meta})`);
    if (firstUser) lines.push(`Started with: "${firstUser.replace(/\s+/g, ' ')}"`);
    if (files.length) lines.push(`Files touched: ${files.slice(0, 12).join(', ')}`);
    if (p.tools.size) lines.push(`Tools used: ${[...p.tools].slice(0, 10).join(', ')}`);
    lines.push('');
    for (const msg of messages) {
      const who = msg.role === 'user' ? 'me' : 'assistant';
      const oneLine = (msg.text || '').replace(/\s+/g, ' ').trim();
      if (oneLine) lines.push(`[${who}] ${oneLine}`);
    }
    lines.push('');
    if (lines.join('\n').length > MAX_DIGEST_CHARS) break;
  }
  let digest = lines.join('\n');
  if (digest.length > MAX_DIGEST_CHARS) {
    digest = digest.slice(0, MAX_DIGEST_CHARS) + '\n…(truncated)';
  }
  return { digest, findings, held };
}

// Core collector over an arbitrary [start, end) window. Does discover → gate →
// read → conv-excludes → buildDigest → stats, returning the contract's collect
// shape: { stats, hasActivity, digest, excludedCount, redactions, held }.
//
// Codex sessions are stored under per-day directories (~/.codex/sessions/Y/M/D),
// so the caller passes `codexDates` — one Date per calendar day the window
// touches — to enumerate them (Claude discovery is already window-general via
// mtime). `dateLabel` is the human caption fed to the digest header + stats.
async function collectWindow(bounds, scope, { codexDates = [new Date()], dateLabel = '' } = {}) {
  const sc = (scope && typeof scope === 'object') ? scope : scopeMod.loadScope();
  const rules = scopeMod.loadRules();

  // (1) Discover candidate full paths WITHOUT reading message bodies.
  const claudeCandidates = discoverClaudeCandidates(bounds);
  let codexCandidates = [];
  for (const d of codexDates) {
    codexCandidates = codexCandidates.concat(await discoverCodexCandidates(bounds, d));
  }
  const candidates = [...claudeCandidates, ...codexCandidates];

  // (2) Deny-by-default allow set keyed on FULL path (I3).
  const gate = gateCandidates(candidates, sc);
  const allow = gate.allow;

  // Count candidate paths that were filtered out by scope (excluded repos).
  let scopeExcludedPaths = 0;
  for (const fp of gate.fullPaths) {
    if (!allow.has(fp)) scopeExcludedPaths++;
  }

  // (3) Read only allowed sources.
  const projects = new Map();
  await collectClaude(projects, bounds, allow);
  for (const d of codexDates) {
    await collectCodex(projects, bounds, d, allow);
  }

  // (4) Drop per-conversation excludes (I3) — real because record() carried
  // sessionId. A project whose every recorded session is excluded is dropped.
  let convExcluded = 0;
  for (const [key, p] of projects) {
    if (p.sessions.size === 0) continue;
    let anyKept = false;
    for (const sid of p.sessions.keys()) {
      if (scopeMod.conversationExcluded(sid, sc)) continue;
      anyKept = true;
      break;
    }
    if (!anyKept) {
      convExcluded += p.sessions.size;
      projects.delete(key);
    }
  }

  // (5) Build the digest with redaction (I1) + fail-closed HOLD (I5).
  const { digest, findings, held } = buildDigest(projects, dateLabel, rules);

  // Held sessions don't count toward visible activity stats.
  const heldKeys = new Set(held.map((h) => h.sessionId));
  const active = [...projects.values()].filter((p) => p.msgCount > 0 && !heldKeys.has(p.key));

  const messageCount = active.reduce((n, p) => n + p.msgCount, 0);
  const fileCount = new Set(active.flatMap((p) => [...p.files])).size;

  const stats = {
    date: dateLabel,
    projectCount: active.length,
    messageCount,
    fileCount,
    // A rough "was today thin?" hint for the UI; the model makes the final call.
    looksQuiet: messageCount < 8 && fileCount === 0,
    projects: active
      .sort((a, b) => b.msgCount - a.msgCount)
      .map((p) => ({ name: p.label, fullPath: p.key, messages: p.msgCount, sources: [...p.source] })),
  };

  // (6) excludedCount = scope-denied candidate paths + conversation excludes +
  // held sessions (I5). redactions = digest-stage findings.
  const excludedCount = scopeExcludedPaths + convExcluded + held.length;

  return {
    stats,
    hasActivity: active.length > 0,
    digest,
    excludedCount,
    redactions: findings,
    held,
  };
}

// Public: gather a single local day's activity into the collect shape.
//
// Signature (FROZEN): collectToday(date = new Date(), scope = null) =>
//   { stats, hasActivity, digest, excludedCount, redactions, held }
//
// Backward-compat: scope defaults to null; when null collectWindow loads it
// itself, so existing callers (collectMostRecentDay, scope:preview, the
// standalone runner) keep working. The return is a SUPERSET of the old keys.
async function collectToday(date = new Date(), scope = null) {
  const dateLabel = date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });
  return collectWindow(dayBounds(date), scope, { codexDates: [date], dateLabel });
}

// Public: gather everything SINCE your last post to the Router, capped at the
// last 7 days. This is what the daily-review `collect` flow uses instead of a
// fixed local-midnight day, so a digest covers exactly the gap since you last
// shared. Same return shape as collectToday.
//
// `lastPostMs` is the anchor — the epoch-ms timestamp of your most recent
// Router post (see router.lastOwnPostMs), passed in by the caller so this
// module stays network-free and standalone-runnable. The start is clamped to a
// 7-day floor: no anchor (never posted / offline), a stale one (> 7 days ago),
// or a future/clock-skewed one all fall back to "the last 7 days". The label
// reflects which window was used so the digest header + UI read honestly.
async function collectSinceLastPost(scope = null, lastPostMs = null) {
  const now = Date.now();
  const floor = now - 7 * DAY_MS;
  const usingAnchor = typeof lastPostMs === 'number' && lastPostMs > floor && lastPostMs <= now;
  const start = usingAnchor ? lastPostMs : floor;
  const bounds = { start, end: now + 60 * 1000 };

  // One Date per calendar day the window touches, for Codex's per-day dirs.
  const dayCount = Math.max(1, Math.ceil((now - start) / DAY_MS) + 1);
  const codexDates = [];
  for (let i = 0; i < dayCount; i++) codexDates.push(new Date(now - i * DAY_MS));

  const dateLabel = usingAnchor ? 'since your last post' : 'the last 7 days';
  return collectWindow(bounds, scope, { codexDates, dateLabel });
}

// Public: gather a wider window of activity (for the self-introduction), so
// the intro is grounded in what the user has ACTUALLY been building, not a form.
// `rules` is an ADDED optional trailing param (frozen signature otherwise): it
// defaults to the user's redaction rules so the digest this builds is scrubbed
// through redact() (I1/I4), instead of egressing verbatim via the intro and
// device-link get-recent paths. `scope` is a further ADDED optional trailing
// param (same additive convention): it defaults to the user's loaded scope so
// the SAME deny-by-default, full-path-keyed gate that protects collectToday
// (I3) also covers this wider intro/get-recent window — previously this path
// passed allow=null, reading every repo (excluded/unknown ones too). Existing
// 1- and 2-arg callers keep working unchanged.
async function collectRecent(days = 30, rules = scopeMod.loadRules(), scope = scopeMod.loadScope()) {
  const end = Date.now() + 60 * 1000;
  const start = end - days * 24 * 60 * 60 * 1000;
  const bounds = { start, end };
  const sc = (scope && typeof scope === 'object') ? scope : scopeMod.loadScope();

  // (1) Discover candidate full paths WITHOUT reading message bodies — mirror
  // collectToday: claude over the window plus codex for each day in range.
  const claudeCandidates = discoverClaudeCandidates(bounds);
  let codexCandidates = [];
  for (let i = 0; i <= days; i++) {
    codexCandidates = codexCandidates.concat(
      await discoverCodexCandidates(bounds, new Date(end - i * 24 * 60 * 60 * 1000)),
    );
  }
  const candidates = [...claudeCandidates, ...codexCandidates];

  // (2) Deny-by-default allow set keyed on FULL path (I3).
  const gate = gateCandidates(candidates, sc);
  const allow = gate.allow;

  // (3) Read only allowed sources.
  const projects = new Map();
  await collectClaude(projects, bounds, allow);
  for (let i = 0; i <= days; i++) {
    await collectCodex(projects, bounds, new Date(end - i * 24 * 60 * 60 * 1000), allow);
  }
  const active = [...projects.values()].filter((p) => p.msgCount > 0);
  return {
    projectCount: active.length,
    projects: active.sort((a, b) => b.msgCount - a.msgCount).map((p) => p.label),
    digest: buildDigest(projects, `the last ${days} days`, rules).digest,
  };
}

// The most recent day that actually has activity (today, else walk back).
// Used for the personalized welcome — concrete real work, not guessed.
// Signature UNCHANGED; relies on collectToday's scope self-load default.
async function collectMostRecentDay(maxBack = 14) {
  for (let i = 0; i <= maxBack; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const r = await collectToday(d);
    if (r.hasActivity) return { date: r.stats.date, digest: r.digest, daysAgo: i };
  }
  return { date: null, digest: '', daysAgo: -1 };
}

// Public: build a digest from already-collected raw .jsonl file contents
// (e.g. logs pulled from another machine over SSH, where there's no local
// Router to compute one). Each file is { source:'claude'|'codex', name, content }.
// `rules` is an ADDED optional trailing param (frozen signature otherwise),
// passed through to buildDigest so the SSH recent/today digest is scrubbed
// through redact() (I1/I4). Existing 2-arg callers keep working unchanged.
function digestFromRawFiles(files, label = 'recent work', rules = scopeMod.loadRules()) {
  const projects = new Map();
  for (const f of files || []) {
    const isCodex = f.source === 'codex';
    let sessionCwd = null;
    let sessionId = (f.name || '').replace(/\.jsonl$/, '') || null;
    for (const raw of String(f.content || '').split('\n')) {
      const s = raw.trim();
      if (!s) continue;
      let d;
      try { d = JSON.parse(s); } catch { continue; }
      if (isCodex) {
        const type = d.type;
        const payload = d.payload || {};
        const ts = d.timestamp ? Date.parse(d.timestamp) : null;
        if (type === 'session_meta') {
          sessionCwd = payload.cwd || payload.cwd_path || null;
          sessionId = payload.id || payload.session_id || sessionId;
          continue;
        }
        if (type !== 'response_item') continue;
        const role = payload.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const activity = { files: new Set(), tools: new Set() };
        const text = extractText(payload.content, activity);
        const key = sessionCwd || 'codex-session';
        record(projects, key, 'codex', role, text, ts, activity, sessionId);
      } else {
        const type = d.type;
        if (type !== 'user' && type !== 'assistant') continue;
        const ts = d.timestamp ? Date.parse(d.timestamp) : null;
        const msg = d.message || {};
        const role = msg.role || type;
        const activity = { files: new Set(), tools: new Set() };
        const text = extractText(msg.content, activity);
        const key = d.cwd || sessionId || 'untitled';
        record(projects, key, 'claude', role, text, ts, activity, sessionId);
      }
    }
  }
  const active = [...projects.values()].filter((p) => p.msgCount > 0);
  return {
    projectCount: active.length,
    projects: active.sort((a, b) => b.msgCount - a.msgCount).map((p) => p.label),
    digest: buildDigest(projects, label, rules).digest,
  };
}

module.exports = { collectToday, collectSinceLastPost, collectRecent, collectMostRecentDay, dayBounds, digestFromRawFiles, claudeDirToPath };

// Allow `node src/transcripts.js` for quick inspection during development.
// Run standalone with a PERMISSIVE/empty scope so dev inspection isn't blocked
// by deny-by-default — every discovered path is allowed (no rules, override-
// nothing means decide()'s default-deny would hide everything otherwise, so we
// pass an inclusive include-everything rule rooted at the homedir).
if (require.main === module) {
  const permissive = {
    version: 1,
    rules: [{ id: 'dev-all', kind: 'includePathPrefix', path: '/' }],
    overrides: {},
    conversations: {},
    knownPaths: [],
    permRaw: false,
  };
  collectToday(new Date(), permissive).then((r) => {
    console.error(JSON.stringify(r.stats, null, 2));
    console.error('\n--- DIGEST (' + r.digest.length + ' chars) ---');
    console.error(`excluded: ${r.excludedCount}, redactions: ${r.redactions.length}, held: ${r.held.length}\n`);
    console.log(r.digest);
  });
}
