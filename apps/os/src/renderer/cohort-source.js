// cohort-source.js — the SOLE entry point for cohort data into the
// Shape Rotator OS. Per docs/SHAPE-ROTATOR-OS-SPEC.md §4.5.
//
// Phase 5 (current): reads cohort-data/*.md DIRECTLY from GitHub `main`
// and builds the surface object in-browser. Mirrors what
// scripts/build-bundles.js does in Node — same parse, same whitelist,
// same shape. The advantage: a PR that adds a cohort-data/asks/foo.md
// (or any record) propagates on the next refresh tick without anyone
// running `npm run build:cohort`. The bundled cohort-surface.json file
// stays around as a pure offline fallback.
//
// Phase 4 (retired): used to fetch the baked apps/os/src/cohort-
// surface.json from main, which required a build step on every merge.
//
// Phase 2 sync (new): when the bundled swf-node is reachable, we layer
// its /sync/manifest records on top of the cohort-data/*.md baseline.
// Sync records WIN (they're the live LWW view; cohort-data/*.md is the
// seed). Refresh tick switches from 5 minutes (github-only) to 30 seconds
// when sync is live so a profile edit on a peer machine shows up within
// one sync cycle instead of within five minutes.
//
// A lightweight polling refresh keeps long-running sessions fresh:
// every REFRESH_MS we re-fetch and, if anything changed, notify
// subscribers so the views can re-render.

import yaml from "js-yaml";
import { getManifest, getRecord } from "./sync-client.js";

const GH_REPO     = "dmarzzz/shape-rotator-os";
const GH_BRANCH   = "main";
const GH_RAW_BASE = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}`;
const GH_TREE_API = `https://api.github.com/repos/${GH_REPO}/git/trees/${GH_BRANCH}?recursive=1`;
const REFRESH_MS  = 5 * 60 * 1000;
// When swf-node is reachable, refresh faster — the spec §4.6 default
// sync poll interval is 30s, so matching it keeps the renderer's view
// at most one tick behind the daemon's view.
const SYNC_REFRESH_MS = 30 * 1000;

// Cohort-data directory → record_type → output list key. Mirrors
// scripts/build-bundles.js so the in-browser build matches the bundled
// fixture's shape exactly. Program pages are special-cased below.
const RECORD_DIRS = [
  { prefix: "cohort-data/teams/",    record_type: "team",    list_key: "teams" },
  { prefix: "cohort-data/people/",   record_type: "person",  list_key: "people" },
  { prefix: "cohort-data/clusters/", record_type: "cluster", list_key: "clusters" },
  { prefix: "cohort-data/events/",   record_type: "event",   list_key: "events" },
  { prefix: "cohort-data/asks/",     record_type: "ask",     list_key: "asks" },
];
const PROGRAM_PREFIX = "cohort-data/program/";

let _cache = null;            // grouped by record_type
let _refreshTimer = null;
const _subscribers = new Set();

function emptyShape() {
  return { teams: [], people: [], clusters: [], program: [], events: [], asks: [], cohort_vocab: {} };
}

function normalize(data) {
  return {
    teams:        Array.isArray(data?.teams)    ? data.teams    : [],
    people:       Array.isArray(data?.people)   ? data.people   : [],
    clusters:     Array.isArray(data?.clusters) ? data.clusters : [],
    program:      Array.isArray(data?.program)  ? data.program  : [],
    events:       Array.isArray(data?.events)   ? data.events   : [],
    asks:         Array.isArray(data?.asks)     ? data.asks     : [],
    cohort_vocab: (data?.cohort_vocab && typeof data.cohort_vocab === "object") ? data.cohort_vocab : {},
  };
}

// In-browser equivalent of scripts/build-bundles.js: enumerate the
// cohort-data/ tree, fetch each markdown record, parse its frontmatter,
// apply the schema whitelist, return the surface object.
async function loadFromGithub() {
  const treeRes = await fetch(`${GH_TREE_API}&ts=${Date.now()}`, { cache: "no-store" });
  if (!treeRes.ok) throw new Error(`github tree fetch failed: HTTP ${treeRes.status}`);
  const tree = await treeRes.json();
  if (tree.truncated) {
    console.warn("[cohort-source] tree response truncated — cohort-data may have grown past the API page size");
  }
  const paths = (tree.tree || []).map(e => e.path);

  const schemaText = await fetchRaw("cohort-data/schema.yml");
  const schema = yaml.load(schemaText);
  if (!schema || schema.schema_version !== 1) {
    throw new Error("unsupported schema_version in cohort-data/schema.yml");
  }

  const out = { schema_version: 1 };

  await Promise.all(RECORD_DIRS.map(async (spec) => {
    const files = paths.filter(p => p.startsWith(spec.prefix) && p.endsWith(".md"));
    const whitelist = schema[spec.list_key]?.surface_fields || [];
    const records = await Promise.all(files.map(p => loadRecord(p, spec.record_type, whitelist)));
    out[spec.list_key] = records.filter(Boolean);
  }));

  // Program pages get the markdown body included alongside frontmatter
  // so the renderer can display the long-form copy offline.
  const progFiles = paths.filter(p => p.startsWith(PROGRAM_PREFIX) && p.endsWith(".md"));
  const progWhitelist = schema.program?.surface_fields || [];
  const progRecords = await Promise.all(progFiles.map(p => loadProgramRecord(p, progWhitelist)));
  out.program = progRecords.filter(Boolean).sort((a, b) => {
    const ao = Number.isFinite(a.order) ? a.order : 1e9;
    const bo = Number.isFinite(b.order) ? b.order : 1e9;
    if (ao !== bo) return ao - bo;
    return String(a.record_id).localeCompare(String(b.record_id));
  });

  out.cohort_vocab = schema.cohort_vocab || {};
  return normalize(out);
}

// `?ts=` busts both the HTTP cache and any CDN/Electron caching so we
// always see the latest commit on `main`.
async function fetchRaw(repoPath) {
  const r = await fetch(`${GH_RAW_BASE}/${repoPath}?ts=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`raw fetch ${repoPath}: HTTP ${r.status}`);
  return r.text();
}

function parseMarkdown(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: null, body: text };
  try { return { frontmatter: yaml.load(m[1]), body: m[2] }; }
  catch { return { frontmatter: null, body: text }; }
}

function pickSurface(obj, whitelist) {
  const out = {};
  for (const k of whitelist) {
    if (Object.prototype.hasOwnProperty.call(obj || {}, k)) out[k] = obj[k];
  }
  return out;
}

async function loadRecord(repoPath, expectedType, whitelist) {
  try {
    const text = await fetchRaw(repoPath);
    const { frontmatter } = parseMarkdown(text);
    if (!frontmatter) return null;
    if (frontmatter.record_type !== expectedType) return null;
    if (!frontmatter.record_id) return null;
    return pickSurface(frontmatter, whitelist);
  } catch (e) {
    console.warn(`[cohort-source] skip ${repoPath}:`, e?.message || e);
    return null;
  }
}

async function loadProgramRecord(repoPath, whitelist) {
  try {
    const text = await fetchRaw(repoPath);
    const { frontmatter, body } = parseMarkdown(text);
    if (!frontmatter) return null;
    if (frontmatter.record_type !== "program_page") return null;
    if (!frontmatter.record_id) return null;
    const s = pickSurface(frontmatter, whitelist);
    s.body_md = (body || "").trim();
    return s;
  } catch (e) {
    console.warn(`[cohort-source] skip program ${repoPath}:`, e?.message || e);
    return null;
  }
}

async function loadFromFixture() {
  const url = new URL("../cohort-surface.json", import.meta.url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`cohort-surface fixture failed: HTTP ${r.status}`);
  return normalize(await r.json());
}

// ─── swf-node overlay ────────────────────────────────────────────────
//
// When the local swf-node is reachable, fetch its /sync/manifest and
// pull each record's newest envelope. The envelope's `content` is the
// LWW view of that record's surface fields; we merge it OVER the
// cohort-data/*.md baseline (sync wins) keyed by record_id.
//
// Phase 2 ships one envelope kind: `person`. As future kinds (team,
// project, etc.) come online they slot in here on their list_key.
// `kind: "person"` from the manifest lands in `out.people`; on an
// unknown kind we just skip the envelope and log once.
const SYNC_KIND_TO_LIST_KEY = {
  person: "people",
  // place: "events",  team: "teams",  cluster: "clusters" — TBD Phase 3+
};

async function loadSyncOverlay() {
  const m = await getManifest();
  if (!m.ok) return null;
  const records = m.manifest?.records || {};
  const ids = Object.keys(records);
  if (ids.length === 0) return { kind: "empty", byList: {} };
  // Pull the newest envelope for each record. Sequential rather than
  // Promise.all so we don't slam a freshly-booted swf-node with 50
  // simultaneous requests — the daemon is single-threaded SQLite.
  const byList = {};
  for (const recordId of ids) {
    const meta = records[recordId];
    const listKey = SYNC_KIND_TO_LIST_KEY[meta?.kind];
    if (!listKey) continue;     // unknown kind → ignore (spec §4.4 step would warn)
    const r = await getRecord(recordId);
    if (!r.ok || !r.envelopes?.length) continue;
    const env = r.envelopes[0];
    const content = env?.content;
    if (!content || typeof content !== "object") continue;
    // Ensure record_id + record_type stamps survive merge so downstream
    // code (cards, identity matching) keeps working. The envelope's
    // record_id is canonical; the content might not echo it.
    const merged = {
      ...content,
      record_id: recordId,
      record_type: content.record_type || meta.kind,
    };
    (byList[listKey] = byList[listKey] || []).push(merged);
  }
  return { kind: "ok", byList };
}

// Merge sync records onto a baseline-grouped surface object. Records
// matched by record_id are REPLACED by the sync version; un-matched sync
// records are appended (so a cohort member who joined post-cohort-data
// shows up immediately). Records present in baseline but not in sync
// are left untouched — sync is additive over the cohort-data/*.md seed.
function mergeSyncOverBaseline(baseline, overlay) {
  if (!overlay || !overlay.byList) return baseline;
  const out = { ...baseline };
  for (const [listKey, syncRecs] of Object.entries(overlay.byList)) {
    const base = Array.isArray(out[listKey]) ? out[listKey] : [];
    const byId = new Map();
    for (const r of base) {
      if (r && r.record_id) byId.set(r.record_id, r);
    }
    for (const r of syncRecs) {
      if (!r.record_id) continue;
      byId.set(r.record_id, r);   // sync wins
    }
    out[listKey] = Array.from(byId.values());
  }
  return out;
}

// Cheap change signature: counts + sorted record_ids per bucket. Used
// by the refresh loop to skip re-render when GitHub returned identical
// data (the usual case between merges).
function signatureOf(grouped) {
  const sig = (arr) => arr.map(r => r.record_id).sort().join("|");
  // Program-page edits are full-body markdown swaps, not record_id churn —
  // hash a coarse fingerprint of (id + body length) so a content-only change
  // still trips the refresh notifier.
  const progSig = (arr) => arr.map(r => `${r.record_id}:${(r.body_md || "").length}`).sort().join("|");
  // Asks churn fast (5-day expiry) — include status in the signature so the
  // wall re-renders on claim/close.
  const askSig = (arr) => arr.map(r => `${r.record_id}:${r.status || "open"}`).sort().join("|");
  // Events are updated by date/title edits — include both in the signature
  // so a date-shift on an existing record_id trips the refresh.
  const eventSig = (arr) => arr.map(r => `${r.record_id}:${r.date || ""}:${r.range_start || ""}:${r.range_end || ""}:${r.title || ""}`).sort().join("|");
  return `${grouped.teams.length}:${sig(grouped.teams)}#${grouped.people.length}:${sig(grouped.people)}#${grouped.clusters.length}:${sig(grouped.clusters)}#${grouped.program.length}:${progSig(grouped.program)}#${grouped.events.length}:${eventSig(grouped.events)}#${grouped.asks.length}:${askSig(grouped.asks)}`;
}

// Dev preview override. Setting `localStorage.setItem("srfg:cohort_source", "local")`
// in DevTools then reloading forces the app to read the bundled fixture
// (apps/os/src/cohort-surface.json) instead of GitHub main.
// Use this to preview a cohort-data PR locally before it merges. Clear with
// `localStorage.removeItem("srfg:cohort_source")` + reload to return to main.
function devPreferLocal() {
  try { return localStorage.getItem("srfg:cohort_source") === "local"; } catch { return false; }
}

/**
 * Returns latest cohort.surface records grouped by type. Tries
 * GitHub `main` first; falls back to the bundled fixture on any
 * error so the app stays usable offline. Honors the localStorage
 * `srfg:cohort_source` dev override.
 *
 * Phase 2 sync: when the bundled swf-node is reachable, its
 * /sync/manifest records are merged OVER the github/fixture baseline.
 * The merged result is what callers see. The `_source` field reads
 * `github+sync`, `fixture+sync`, or just the underlying source when
 * sync is unreachable.
 */
export async function getCohortSurface() {
  if (_cache) return _cache;
  if (devPreferLocal()) {
    try {
      _cache = await loadFromFixture();
      _cache._source = "fixture-forced";
      _cache._sig = signatureOf(_cache);
      console.log("[cohort-source] DEV override active — reading bundled fixture. Clear with localStorage.removeItem('srfg:cohort_source') + reload.");
      // Still try the sync overlay even when pinning the local fixture —
      // the cohort-data/*.md seed plus the local user's last edit gives
      // the most truthful preview of "what the cohort would see."
      _cache = await applySyncOverlayCached(_cache);
      scheduleRefresh();
      return _cache;
    } catch (e) {
      console.warn("[cohort-source] forced fixture unreadable; falling through to github:", e?.message || e);
    }
  }
  try {
    _cache = await loadFromGithub();
    _cache._source = "github";
    _cache._sig = signatureOf(_cache);
  } catch (e) {
    console.warn("[cohort-source] github unreachable; falling back to fixture:", e?.message || e);
    _cache = await loadFromFixture();
    _cache._source = "fixture";
    _cache._sig = signatureOf(_cache);
  }
  _cache = await applySyncOverlayCached(_cache);
  scheduleRefresh();
  return _cache;
}

// Apply the swf-node overlay to a baseline cache. Stamps `_source` so
// the UI can show "live · syncing" vs "baseline only." If sync is
// unreachable, returns the baseline untouched (the github PR fallback
// keeps the app usable).
async function applySyncOverlayCached(baseline) {
  let overlay = null;
  try { overlay = await loadSyncOverlay(); }
  catch (e) { overlay = null; }
  if (!overlay) {
    baseline._syncAvailable = false;
    return baseline;
  }
  const merged = mergeSyncOverBaseline(baseline, overlay);
  merged._source = `${baseline._source || "baseline"}+sync`;
  merged._sig = signatureOf(merged);
  merged._syncAvailable = true;
  return merged;
}

// External helper for components that need to know "is the live sync
// view active?" — the alchemy profile editor reads this to decide
// whether to route a submit through swf-node or fall back to github PR.
export function isSyncAvailable() {
  return !!_cache?._syncAvailable;
}

function scheduleRefresh() {
  if (_refreshTimer) return;
  // Use the faster cadence when sync is live so a peer's profile edit
  // shows up within one sync tick instead of waiting on the github poll.
  // The fallback is still gh-only when swf-node is unreachable.
  const interval = _cache?._syncAvailable ? SYNC_REFRESH_MS : REFRESH_MS;
  _refreshTimer = setInterval(refreshTick, interval);
}

async function refreshTick() {
  // Dev override pins the fixture — skip the github fetch entirely so
  // a 5-min refresh doesn't silently overwrite what we built locally.
  // Still run the sync overlay so live edits surface in the pinned
  // fixture preview.
  let baseline = _cache;
  if (!devPreferLocal()) {
    try { baseline = await loadFromGithub(); baseline._source = "github"; }
    catch {
      // Transient network blip — keep using the existing baseline so the
      // overlay still applies to it.
      baseline = _cache;
    }
  }
  const merged = await applySyncOverlayCached(baseline);
  const sig = signatureOf(merged);
  if (sig === _cache?._sig && merged._syncAvailable === _cache?._syncAvailable) return;
  _cache = { ...merged, _sig: sig };
  // If sync availability flipped, restart the timer at the right cadence
  // so we converge faster (or stop hammering swf-node when it goes away).
  if ((!!_cache._syncAvailable) !== (!!_cache._previousSyncAvailable)) {
    _cache._previousSyncAvailable = !!_cache._syncAvailable;
    if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
    scheduleRefresh();
  }
  for (const cb of _subscribers) {
    try { cb({ type: "refresh" }); } catch {}
  }
}

/**
 * Subscribers fire when a polled refresh detects a changed cohort on
 * GitHub. The callback receives a generic `{ type: "refresh" }` —
 * consumers should re-fetch via getCohortSurface() and re-render.
 */
export function subscribeToCohortChanges(cb) {
  if (typeof cb !== "function") return () => {};
  _subscribers.add(cb);
  return () => _subscribers.delete(cb);
}

// Internal — for tests / dev tools to force-refresh the cache.
export function _resetCohortSource() {
  _cache = null;
  _subscribers.clear();
  if (_refreshTimer) { clearInterval(_refreshTimer); _refreshTimer = null; }
}
