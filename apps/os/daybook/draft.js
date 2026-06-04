'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Draft spine + on-disk daily cache.
//
// buildDraft() is the ONE pipeline that turns "what did you do since your last
// post" into a finished, scrubbed cohort draft: read sessions → fold in linked
// SSH machines → read the cohort feed → write the reflection via `claude -p`.
// It is the same code path whether it runs:
//   - on the interactive open (cold path, streamed),
//   - silently in the background to refresh a stale cache, or
//   - on the daily schedule while the app is closed (the daemon).
//
// The finished record is cached to ~/.router-daybook/drafts/<localDate>.json
// (+ latest.json), so reopening the app paints instantly instead of waiting
// ~20-50s for the model again. A cheap, model-free fingerprint (newest session
// mtime + file count over the last 7 days) lets the caller decide whether the
// cache is still fresh WITHOUT touching the model.
//
// This module imports NO electron — it runs under bare Node too, so the same
// buildDraft can later back a headless launchd precompute job.
// ─────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

const { collectSinceLastPost } = require('./transcripts');
const { generate } = require('./reflect');
const scopeMod = require('./scope');
const { fetchFeed, lastOwnPostMs, loadConfig, DEFAULT_SERVER } = require('./router');
const learning = require('./preferences');
const link = require('./link');

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS = path.join(HOME, '.codex', 'sessions');
const DRAFTS_DIR = path.join(HOME, '.router-daybook', 'drafts');
const DAY_MS = 24 * 60 * 60 * 1000;
const CACHE_VERSION = 1;

function p2(n) { return String(n).padStart(2, '0'); }

// Local calendar date "YYYY-MM-DD" — the cache is keyed and validated by this so
// a draft is never shown across a day boundary.
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

// The user's FIRST name (third-person voice). DAYBOOK_NAME or ~/.routerrc.name;
// first token only; falls back to "James". (Mirrors the former main.js helper so
// buildDraft can run without the Electron main process.)
function firstNameOf(s) { return String(s || '').trim().split(/\s+/)[0] || ''; }
function resolveName() {
  let raw = process.env.DAYBOOK_NAME || '';
  if (!raw) {
    try { raw = JSON.parse(fs.readFileSync(path.join(HOME, '.routerrc'), 'utf8')).name || ''; }
    catch { /* ignore */ }
  }
  return firstNameOf(raw) || 'James';
}

// ── cheap, model-free freshness fingerprint ───────────────────────────────
// Newest session-file mtime + count over the last 7 days (a superset of the
// draft's actual window — scope-blind on purpose). Pure fs.statSync, no body
// reads, no model. If this is unchanged since the cache was built, no new work
// happened and the cached draft can be served without regenerating.
function draftFingerprint() {
  const now = Date.now();
  const start = now - 7 * DAY_MS;
  let maxMtimeMs = 0;
  let fileCount = 0;
  const note = (mt) => { if (mt >= start) { fileCount++; if (mt > maxMtimeMs) maxMtimeMs = mt; } };

  // Claude: each project dir holds session .jsonl files.
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const dp = path.join(CLAUDE_PROJECTS, dir.name);
      let entries;
      try { entries = fs.readdirSync(dp); } catch { continue; }
      for (const f of entries) {
        if (!f.endsWith('.jsonl')) continue;
        try { note(fs.statSync(path.join(dp, f)).mtimeMs); } catch { /* skip */ }
      }
    }
  } catch { /* no claude dir */ }

  // Codex: rollout files live under Y/M/D — scan the last 8 day dirs.
  try {
    for (let i = 0; i <= 7; i++) {
      const d = new Date(now - i * DAY_MS);
      const dayDir = path.join(CODEX_SESSIONS, String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate()));
      let files;
      try { files = fs.readdirSync(dayDir); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('rollout-') || !f.endsWith('.jsonl')) continue;
        try { note(fs.statSync(path.join(dayDir, f)).mtimeMs); } catch { /* skip */ }
      }
    }
  } catch { /* no codex dir */ }

  return { maxMtimeMs, fileCount };
}

// True when the cached draft is still trustworthy without regenerating: same
// calendar day, no new local work since it was built, and no SSH peers (their
// activity is network, invisible to the local fingerprint, so always refresh).
function draftIsFresh(record) {
  try {
    if (!record || !record.fingerprint) return false;
    if (record.localDate !== localDateStr()) return false;
    if (Array.isArray(record.peers) && record.peers.some((p) => p && p.projectCount > 0)) return false;
    const fp = draftFingerprint();
    return fp.fileCount === record.fingerprint.fileCount && fp.maxMtimeMs === record.fingerprint.maxMtimeMs;
  } catch { return false; }
}

// ── cache read/write (atomic via tmp + rename) ────────────────────────────
function latestPath() { return path.join(DRAFTS_DIR, 'latest.json'); }
function datedPath(localDate) { return path.join(DRAFTS_DIR, `${localDate}.json`); }

function writeDraftCache(record) {
  try {
    fs.mkdirSync(DRAFTS_DIR, { recursive: true });
    const body = JSON.stringify(record);
    for (const dest of [datedPath(record.localDate), latestPath()]) {
      const tmp = dest + '.tmp';
      fs.writeFileSync(tmp, body);
      fs.renameSync(tmp, dest);
    }
  } catch { /* a cache miss just means we regenerate — never fatal */ }
}

function readDraftCache() {
  try { return JSON.parse(fs.readFileSync(latestPath(), 'utf8')); }
  catch { return null; }
}

// ── the spine ─────────────────────────────────────────────────────────────
// buildDraft({ reason, onChunk }) → record (also written to the cache).
//   reason  — 'open' | 'refresh' | 'scheduled' | 'manual' (provenance only)
//   onChunk — optional streaming callback forwarded to reflect.generate
async function buildDraft({ reason = 'open', onChunk } = {}) {
  const scope = scopeMod.loadScope();
  const name = resolveName();

  // Anchor the window to the last Router post (network; falls back to 7 days).
  let anchorMs = null;
  try { anchorMs = await lastOwnPostMs(); } catch { /* offline → fallback */ }
  const collected = await collectSinceLastPost(scope, anchorMs);

  let server = DEFAULT_SERVER;
  let configError = null;
  try { server = loadConfig().server; } catch (e) { configError = e.message; }

  // Fold in any saved SSH machines' work (parallel; unreachable peers skipped).
  let digest = collected.digest;
  let hasActivity = collected.hasActivity;
  let projectCount = collected.stats.projectCount;
  const peerResults = await Promise.all(link.listPeers().map((p) => link.collectPeerToday(p.target)));
  const peers = [];
  for (const r of peerResults) {
    if (r.ok && r.projectCount > 0) {
      digest += `\n\n=== ALSO ON ${r.target} (linked over SSH) ===\n${r.digest}`;
      hasActivity = true;
      projectCount += r.projectCount;
      peers.push({ target: r.target, projectCount: r.projectCount, projects: r.projects, truncated: r.truncated });
    } else if (r.ok) {
      peers.push({ target: r.target, projectCount: 0 });
    } else {
      peers.push({ target: r.target, error: r.error });
    }
  }
  const stats = { ...collected.stats, projectCount };

  const base = {
    version: CACHE_VERSION,
    reason,
    builtAt: Date.now(),
    localDate: localDateStr(),
    anchorMs,
    fingerprint: draftFingerprint(),
    stats,
    peers,
    excludedCount: collected.excludedCount,
    hasActivity,
    name,
    server,
    configError,
  };

  // Quiet day: cache the stats so the empty/quiet screen still opens instantly,
  // but there's no draft to write.
  if (!hasActivity) {
    const record = { ...base, result: null, sessionInputs: null };
    writeDraftCache(record);
    return record;
  }

  // Read the cohort feed for collaboration matching (non-fatal on failure).
  let feedEntries = [];
  let feedError = null;
  let myHandle = null;
  try {
    const feed = await fetchFeed({ days: 14, limit: 60 });
    if (feed.ok) { feedEntries = feed.entries; myHandle = feed.myHandle; }
    else feedError = feed.error;
  } catch (e) {
    feedError = e.message;
  }

  // Apply only ALREADY-distilled standing preferences. Pattern DERIVATION used
  // to run here (a second, serial `claude -p` on the critical path); it now runs
  // off the interactive path after a post (main.js), so the draft never waits on it.
  const learned = learning.learned();

  // The inputs a follow-up revise/refine needs — the caller stores these as the
  // module `session` so in-place revision works after an instant cache paint.
  const sessionInputs = {
    digest,
    name,
    dateLabel: stats.date,
    feedEntries,
    myHandle,
    standingPreferences: learned.text,
  };

  const gen = await generate(digest, { ...sessionInputs, onChunk });
  const result = { ...gen, feedCount: feedEntries.length, feedError, myHandle, learned: learned.patterns };

  const record = { ...base, result, sessionInputs };
  writeDraftCache(record);
  return record;
}

module.exports = {
  buildDraft,
  readDraftCache,
  writeDraftCache,
  draftFingerprint,
  draftIsFresh,
  localDateStr,
  resolveName,
  DRAFTS_DIR,
};
